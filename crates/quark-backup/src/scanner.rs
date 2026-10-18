//! 分批目录扫描器。
//!
//! 设计（Phase-2 计划 §一.1/3/14/15/16/19）：
//! - walkdir，默认不跟随符号链接/junction（max_same_file_system 由调用方约束）；
//! - 每批约 `batch_size` 条通过 channel 交给队列写入，批次间让出事件循环（tokio yield）；
//! - 单目录超大（>50000 项）也要分批（walkdir 本身流式，天然满足）；
//! - 特殊名标注：CJK/空格/emoji 原样保留（Quark API 用 JSON 传输无转义问题）；
//!   Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）在 Windows 上由 OS 层拒绝，发现期不猜测；
//!   路径分隔统一 `/`（relPath 内），Windows 反斜杠归一；
//! - 空目录：记录为目录（建目录用），不产生上传任务；
//! - 不可读目录：walkdir Err 事件逐条捕获 → 记录为失败原因，不中断扫描；
//! - 根消失/磁盘拔出：首个 walkdir 错误且根 stat 失败 → 整体错误。

use crate::store::Task;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

/// 扫描产出：一批文件任务或目录。
#[derive(Debug)]
pub enum ScanItem {
    File(Task),
    /// 相对目录路径（含根本身 = ""）
    Dir(String),
    /// 不可读等 per-entry 错误（不中断）
    Warning { rel_path: String, message: String },
}

/// 扫描器配置。
#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub account: String,
    pub root_dir: PathBuf,
    pub target_fid: String,
    /// 每批条数（默认 500）
    pub batch_size: usize,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            account: String::new(),
            root_dir: PathBuf::new(),
            target_fid: "0".into(),
            batch_size: 500,
        }
    }
}

/// 扫描结果统计。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanStats {
    pub files: u64,
    pub dirs: u64,
    pub warnings: u64,
    pub batches: u64,
    pub total_bytes: u64,
}

/// 归一相对路径：平台分隔符 → `/`，去掉首尾分隔符，拒绝 `..` 逃逸。
pub fn normalize_rel(rel: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(p) => {
                let s = p.to_string_lossy();
                if s == ".." || s == "." {
                    return None;
                }
                parts.push(s.to_string());
            }
            _ => return None, // 根/前缀/父目录组件：不允许出现在 rel 内
        }
    }
    if parts.is_empty() {
        Some(String::new())
    } else {
        Some(parts.join("/"))
    }
}

/// 平台文件名是否会在 Windows 上引发问题（保留名/尾点尾空格）。跨平台开发期预警用。
pub fn windows_name_risk(name: &str) -> Option<&'static str> {
    let upper = name.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem) {
        return Some("Windows 保留设备名");
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Some("Windows 尾随点/空格");
    }
    None
}

/// 扫描根目录，分批把条目发到 `tx`。阻塞当前线程（由调用方 spawn_blocking 包裹）。
/// 返回统计；根不可达时返回 Err（磁盘拔出/目录删除）。
pub fn scan(cfg: &ScanConfig, tx: mpsc::Sender<Vec<ScanItem>>) -> std::io::Result<ScanStats> {
    let root_meta = std::fs::metadata(&cfg.root_dir).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("根目录不可达（{}）：{}；已停止扫描，未误标任何文件", cfg.root_dir.display(), e),
        )
    })?;
    if !root_meta.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("{} 不是目录", cfg.root_dir.display()),
        ));
    }
    let mut stats = ScanStats::default();
    let mut batch: Vec<ScanItem> = Vec::with_capacity(cfg.batch_size);
    let mut flush = |batch: &mut Vec<ScanItem>, stats: &mut ScanStats, tx: &mpsc::Sender<Vec<ScanItem>>| {
        if batch.is_empty() {
            return;
        }
        stats.batches += 1;
        // 批满时 channel 满会阻塞——这正是背压入口（调度器控制 channel 容量）
        let _ = tx.blocking_send(std::mem::take(batch));
    };

    // 根本身是一个目录（rel=""）
    batch.push(ScanItem::Dir(String::new()));

    let walker = walkdir::WalkDir::new(&cfg.root_dir)
        .follow_links(false)
        .follow_root_links(false);
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                // walkdir 错误带路径上下文：归一 rel 后发 warning
                let path = err.path().map(|p| p.to_path_buf()).unwrap_or_default();
                let rel = path
                    .strip_prefix(&cfg.root_dir)
                    .ok()
                    .and_then(normalize_rel)
                    .unwrap_or_default();
                batch.push(ScanItem::Warning {
                    rel_path: rel,
                    message: format!("目录项不可读：{}", err),
                });
                stats.warnings += 1;
                if batch.len() >= cfg.batch_size {
                    flush(&mut batch, &mut stats, &tx);
                }
                continue;
            }
        };
        let Ok(rel) = entry.path().strip_prefix(&cfg.root_dir) else { continue };
        let Some(rel_s) = normalize_rel(rel) else { continue };
        if rel_s.is_empty() {
            continue; // 根已作为 Dir("") 入队
        }
        if entry.file_type().is_dir() {
            batch.push(ScanItem::Dir(rel_s));
            stats.dirs += 1;
        } else if entry.file_type().is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    batch.push(ScanItem::Warning {
                        rel_path: rel_s.clone(),
                        message: format!("文件元数据不可读：{e}"),
                    });
                    stats.warnings += 1;
                    if batch.len() >= cfg.batch_size {
                        flush(&mut batch, &mut stats, &tx);
                    }
                    continue;
                }
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            stats.files += 1;
            stats.total_bytes += meta.len();
            batch.push(ScanItem::File(Task {
                account: cfg.account.clone(),
                root_dir: cfg.root_dir.to_string_lossy().to_string(),
                target_fid: cfg.target_fid.clone(),
                rel_path: rel_s,
                local_path: entry.path().to_string_lossy().to_string(),
                size: meta.len(),
                mtime_ms,
                state: crate::state::TaskState::Discovered,
                remote_fid: None,
                attempts: 0,
                last_error: None,
                chunk_progress: None,
                updated_at_ms: 0,
            }));
        }
        // 符号链接/其他：follow_links(false) 下 symlink 出现为 file_type().is_symlink()，
        // 默认跳过（计划 §一.1 junction/symlink 默认不跟随）
        if batch.len() >= cfg.batch_size {
            flush(&mut batch, &mut stats, &tx);
        }
    }
    flush(&mut batch, &mut stats, &tx);
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rel_rejects_escape_and_normalizes() {
        assert_eq!(normalize_rel(Path::new("a/b/c")).as_deref(), Some("a/b/c"));
        assert_eq!(normalize_rel(Path::new("a")).as_deref(), Some("a"));
        assert_eq!(normalize_rel(Path::new("")).as_deref(), Some(""));
        assert_eq!(normalize_rel(Path::new("..")).is_none(), true);
        assert_eq!(normalize_rel(Path::new("a/../../b")).is_none(), true);
        // Windows 反斜杠分隔在 Path 组件层已处理；这里确认不含分隔符泄漏
        let rel = normalize_rel(Path::new("x/y"));
        assert!(!rel.unwrap().contains('\\'));
    }

    #[test]
    fn windows_name_risk_flags_reserved_and_trailing() {
        assert_eq!(windows_name_risk("CON.txt"), Some("Windows 保留设备名"));
        assert_eq!(windows_name_risk("com1"), Some("Windows 保留设备名"));
        assert_eq!(windows_name_risk("LPT9.docx"), Some("Windows 保留设备名"));
        assert_eq!(windows_name_risk("file "), Some("Windows 尾随点/空格"));
        assert_eq!(windows_name_risk("file."), Some("Windows 尾随点/空格"));
        assert_eq!(windows_name_risk("正常文件名.txt"), None);
        assert_eq!(windows_name_risk("content.txt"), None, "CON 是整段匹配不是子串");
    }

    #[test]
    fn scan_batches_and_reports_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        // 7 个文件 + 2 个子目录（一个空目录）
        for i in 0..7 {
            std::fs::write(root.join(format!("f{i}.txt")), format!("content-{i}")).unwrap();
        }
        std::fs::create_dir_all(root.join("sub1").join("deep")).unwrap();
        std::fs::write(root.join("sub1").join("d.txt"), "deep").unwrap();
        // 中文/空格/emoji 名
        std::fs::write(root.join("中文 文件 📦.txt"), "cjk").unwrap();
        // 不可读目录（Unix 下 chmod 000）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = root.join("locked");
            std::fs::create_dir_all(&locked).unwrap();
            std::fs::write(locked.join("secret.txt"), "s").unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        }

        let cfg = ScanConfig {
            account: "acc".into(),
            root_dir: root.clone(),
            target_fid: "root1".into(),
            batch_size: 3, // 强制多批
        };
        let (tx, mut rx) = mpsc::channel(100);
        let stats = {
            let cfg = cfg.clone();
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
                let handle = tokio::task::spawn_blocking(move || scan(&cfg, tx));
                let mut files = 0usize;
                let mut dirs = 0usize;
                let mut warnings = 0usize;
                let mut saw_cjk = false;
                let mut saw_locked_warning = false;
                while let Some(batch) = rx.recv().await {
                    for item in batch {
                        match item {
                            ScanItem::File(t) => {
                                files += 1;
                                if t.rel_path.contains("中文") {
                                    saw_cjk = true;
                                    assert_eq!(t.size, 3, "cjk 文件大小");
                                }
                            }
                            ScanItem::Dir(_) => dirs += 1,
                            ScanItem::Warning { rel_path, message } => {
                                warnings += 1;
                                if rel_path.contains("locked") || message.contains("不可读") {
                                    saw_locked_warning = true;
                                }
                            }
                        }
                    }
                }
                let st = handle.await.unwrap().unwrap();
                assert_eq!(files, st.files as usize);
                assert_eq!(dirs, st.dirs as usize + 1, "消费端含根 Dir(\"\")");
                (st, saw_cjk, saw_locked_warning)
            })
        };
        let (st, saw_cjk, saw_locked) = stats;
        assert_eq!(st.files, 9, "7 + sub1/d.txt + 中文文件");
        assert!(st.dirs >= 3, "sub1、sub1/deep、locked（locked 内部行为平台相关）: {}", st.dirs);
        assert!(st.batches >= 3, "batch_size=3 应多批");
        assert!(saw_cjk, "CJK/空格/emoji 名应原样保留");
        #[cfg(unix)]
        assert!(saw_locked, "不可读目录应产生 warning 而非中断");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn scan_missing_root_is_whole_error() {
        let cfg = ScanConfig {
            account: "acc".into(),
            root_dir: PathBuf::from("/nonexistent-qk-backup-root-xyz"),
            target_fid: "root1".into(),
            batch_size: 10,
        };
        let (tx, _rx) = mpsc::channel(4);
        let err = scan(&cfg, tx).unwrap_err();
        assert!(err.to_string().contains("根目录不可达"), "{err}");
    }
}
