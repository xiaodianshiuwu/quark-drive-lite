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
    Warning {
        rel_path: String,
        message: String,
    },
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
                let s = p.to_str()?;
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
    if name
        .chars()
        .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Some("Windows 文件名含不支持的字符");
    }
    let upper = name.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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
    scan_controlled(cfg, tx, &std::sync::atomic::AtomicBool::new(false))
}

/// A streaming depth-first iterator holds at most 128 open directory iterators and one batch.
/// It never sorts/materializes a directory. Receiver closure and cancellation stop enumeration.
pub fn scan_controlled(
    cfg: &ScanConfig,
    tx: mpsc::Sender<Vec<ScanItem>>,
    stop: &std::sync::atomic::AtomicBool,
) -> std::io::Result<ScanStats> {
    use std::sync::atomic::Ordering;
    let root = std::fs::symlink_metadata(&cfg.root_dir)?;
    if !root.is_dir() || is_reparse(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "根目录不可达或为链接/重解析点",
        ));
    }
    let mut stack = vec![std::fs::read_dir(&cfg.root_dir)?];
    let mut stats = ScanStats::default();
    let mut batch = vec![ScanItem::Dir(String::new())];
    let batch_size = cfg.batch_size.clamp(1, 5000);
    loop {
        if stop.load(Ordering::Acquire) || tx.is_closed() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "扫描已停止",
            ));
        }
        let Some(iter) = stack.last_mut() else { break };
        let entry = match iter.next() {
            None => {
                stack.pop();
                continue;
            }
            Some(Err(e)) => {
                batch.push(ScanItem::Warning {
                    rel_path: String::new(),
                    message: format!("目录项不可读：{e}"),
                });
                stats.warnings += 1;
                if batch.len() >= batch_size {
                    send_batch(&tx, &mut batch, &mut stats, batch_size)?;
                }
                continue;
            }
            Some(Ok(e)) => e,
        };
        let path = entry.path();
        let rel = path
            .strip_prefix(&cfg.root_dir)
            .ok()
            .and_then(normalize_rel);
        let Some(rel) = rel else {
            batch.push(ScanItem::Warning {
                rel_path: String::new(),
                message: "无法无损表示相对路径，已排除".into(),
            });
            stats.warnings += 1;
            if batch.len() >= batch_size {
                send_batch(&tx, &mut batch, &mut stats, batch_size)?;
            }
            continue;
        };
        match std::fs::symlink_metadata(&path) {
            Err(e) => {
                batch.push(ScanItem::Warning {
                    rel_path: rel,
                    message: format!("元数据不可读：{e}"),
                });
                stats.warnings += 1;
            }
            Ok(meta) => {
                if path.as_os_str().to_string_lossy().encode_utf16().count() > 248 {
                    batch.push(ScanItem::Warning {
                        rel_path: rel.clone(),
                        message: "Windows长路径：恢复前需启用长路径支持并在Windows真机核验".into(),
                    });
                    stats.warnings += 1;
                }
                let name = entry.file_name();
                if let Some(risk) = name.to_str().and_then(windows_name_risk) {
                    batch.push(ScanItem::Warning {
                        rel_path: rel.clone(),
                        message: risk.into(),
                    });
                    stats.warnings += 1;
                }
                if is_reparse(&meta) || meta.file_type().is_symlink() {
                    batch.push(ScanItem::Warning {
                        rel_path: rel,
                        message: "链接/重解析点已排除，未跟随".into(),
                    });
                    stats.warnings += 1;
                } else if meta.is_dir() {
                    batch.push(ScanItem::Dir(rel.clone()));
                    stats.dirs += 1;
                    if stack.len() >= 128 {
                        batch.push(ScanItem::Warning {
                            rel_path: rel,
                            message: "超过128层目录深度限制，未继续扫描".into(),
                        });
                        stats.warnings += 1;
                    } else {
                        match std::fs::read_dir(&path) {
                            Ok(iter) => stack.push(iter),
                            Err(e) => {
                                batch.push(ScanItem::Warning {
                                    rel_path: rel,
                                    message: format!("目录不可读：{e}"),
                                });
                                stats.warnings += 1;
                            }
                        }
                    }
                } else if meta.is_file() {
                    stats.files += 1;
                    stats.total_bytes += meta.len();
                    batch.push(ScanItem::File(Task {
                        account: cfg.account.clone(),
                        root_dir: cfg.root_dir.to_string_lossy().into(),
                        target_fid: cfg.target_fid.clone(),
                        rel_path: rel,
                        local_path: path
                            .to_str()
                            .ok_or_else(|| {
                                std::io::Error::new(std::io::ErrorKind::InvalidData, "路径非UTF-8")
                            })?
                            .into(),
                        size: meta.len(),
                        mtime_ms: mtime_ms(&meta),
                        state: crate::state::TaskState::Discovered,
                        remote_fid: None,
                        attempts: 0,
                        last_error: None,
                        chunk_progress: None,
                        updated_at_ms: 0,
                    }));
                } else {
                    batch.push(ScanItem::Warning {
                        rel_path: rel,
                        message: "非普通文件，已排除".into(),
                    });
                    stats.warnings += 1;
                }
            }
        }
        if batch.len() >= batch_size {
            send_batch(&tx, &mut batch, &mut stats, batch_size)?;
        }
    }
    send_batch(&tx, &mut batch, &mut stats, batch_size)?;
    Ok(stats)
}

pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn send_batch(
    tx: &mpsc::Sender<Vec<ScanItem>>,
    batch: &mut Vec<ScanItem>,
    stats: &mut ScanStats,
    batch_size: usize,
) -> std::io::Result<()> {
    while !batch.is_empty() {
        let rest = if batch.len() > batch_size {
            batch.split_off(batch_size)
        } else {
            Vec::new()
        };
        tx.blocking_send(std::mem::replace(batch, rest))
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::Interrupted, "扫描接收端已关闭")
            })?;
        stats.batches += 1;
    }
    Ok(())
}

pub(crate) fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
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
        assert_eq!(
            windows_name_risk("content.txt"),
            None,
            "CON 是整段匹配不是子串"
        );
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
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(async move {
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
                                    if rel_path.contains("locked") || message.contains("不可读")
                                    {
                                        saw_locked_warning = true;
                                    }
                                }
                            }
                        }
                    }
                    let st = handle.await.unwrap().unwrap();
                    assert_eq!(warnings, st.warnings as usize);
                    assert_eq!(files, st.files as usize);
                    assert_eq!(dirs, st.dirs as usize + 1, "消费端含根 Dir(\"\")");
                    (st, saw_cjk, saw_locked_warning)
                })
        };
        let (st, saw_cjk, saw_locked) = stats;
        assert_eq!(st.files, 9, "7 + sub1/d.txt + 中文文件");
        assert!(
            st.dirs >= 3,
            "sub1、sub1/deep、locked（locked 内部行为平台相关）: {}",
            st.dirs
        );
        assert!(st.batches >= 3, "batch_size=3 应多批");
        assert!(saw_cjk, "CJK/空格/emoji 名应原样保留");
        #[cfg(unix)]
        assert!(saw_locked, "不可读目录应产生 warning 而非中断");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                root.join("locked"),
                std::fs::Permissions::from_mode(0o755),
            );
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
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }
}
