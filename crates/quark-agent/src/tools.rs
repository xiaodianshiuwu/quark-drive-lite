//! Agent 工具层宿主依赖与共通机制。
//!
//! 本模块定义工具层对业务能力的抽象（`HostDeps` trait），由 src-tauri 接线时用
//! `quark_core::Core` + `quark_transfer::TransferManager` 实现。这样工具层的范围校验、
//! 序列化、重试与审计可以脱离 Tauri 独立单测（qck 同构设计）。
//!
//! 语义约束（规格 §4.0，全部为 qck 实测沉淀）：
//! - `safe_info` 对 fid="0" 不发请求（真实服务端无 fid=0 对象，14001）；
//! - transient 错误重试（INVALID_ARG/NOT_FOUND/SERVER 或 bizCode 14001/21001）；
//! - recentObjects 只由本进程成功写入填充，仅在 info 失败时按 TTL 兜底；
//! - 未知数值状态不解释为成功。

use crate::config::ScopeSnapshot;
use crate::policy::{
    matches_remote_scope, AgentError, AgentToolError, LocalRoot, ROOT_FID,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_PAGE_SIZE: i64 = 200;
pub const MAX_TREE_DEPTH: i64 = 8;
pub const MAX_TREE_ENTRIES: usize = 2000;
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
pub const DEFAULT_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_SCOPE_WALK: usize = 64;
pub const DEFAULT_WAIT_MS: u64 = 120_000;
pub const MAX_WAIT_MS: u64 = 600_000;
pub const RECENT_TTL_MS: i64 = 3 * 60 * 1000;
pub const RECENT_MAX: usize = 500;

// ---------------------------------------------------------------------------
// 宿主依赖抽象
// ---------------------------------------------------------------------------

/// boxed future 别名（宿主业务调用异步化）。
pub type DepsFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// 工具层对业务能力的最小依赖（由 host 实现）。
pub trait HostDeps: Send + Sync {
    /// 调用 quark-core 的分发（fs.* / auth.* / settings.*）。
    fn core_call<'a>(
        &'a self,
        generation: u64,
        method: &'a str,
        params: &'a Value,
    ) -> DepsFuture<'a, Result<Value, crate::policy::AgentToolError>>;
    /// 调用 quark-transfer 的分发（transfer.*）。
    fn transfer_call<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
    ) -> DepsFuture<'a, Result<Value, crate::policy::AgentToolError>>;
    /// 当前下载目录设置（可为空字符串）。
    fn download_dir(&self) -> String;
    /// 当前登录 generation（用于会话绑定调用）。
    fn session_generation(&self) -> u64;
}

/// 近期对象兜底表：只由本进程成功写入授权范围的操作填充。
#[derive(Debug, Clone)]
struct RecentObject {
    parent_fid: String,
    name: String,
    dir: bool,
    at: i64,
    seq: u64,
}

/// 工具层共享状态（进程内）。
pub struct ToolShared {
    recent: Mutex<HashMap<String, RecentObject>>,
    recent_seq: std::sync::atomic::AtomicU64,
}

impl ToolShared {
    pub fn new() -> Self {
        Self {
            recent: Mutex::new(HashMap::new()),
            recent_seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn remember(&self, fid: &str, parent_fid: &str, name: &str, dir: bool) {
        let mut map = self.recent.lock().unwrap();
        let now = crate::journal::now_ms();
        let seq = self.recent_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // 新增 key 且已满：先清过期，再按插入序淘汰最旧（更新已有 key 不触发淘汰）。
        if !map.contains_key(fid) && map.len() >= RECENT_MAX {
            map.retain(|_, v| now - v.at <= RECENT_TTL_MS);
            while map.len() >= RECENT_MAX {
                let oldest = map
                    .iter()
                    .min_by_key(|(_, v)| v.seq)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => {
                        map.remove(&k);
                    }
                    None => break,
                }
            }
        }
        let seq = match map.get(fid) {
            Some(existing) => existing.seq,
            None => seq,
        };
        map.insert(
            fid.to_string(),
            RecentObject { parent_fid: parent_fid.into(), name: name.into(), dir, at: now, seq },
        );
    }

    fn recall(&self, fid: &str) -> Option<RecentObject> {
        let mut map = self.recent.lock().unwrap();
        let now = crate::journal::now_ms();
        match map.get(fid) {
            Some(v) if now - v.at <= RECENT_TTL_MS => Some(v.clone()),
            Some(_) => {
                map.remove(fid);
                None
            }
            None => None,
        }
    }

    pub fn forget_all(&self) {
        self.recent.lock().unwrap().clear();
    }
}

impl Default for ToolShared {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 输入辅助
// ---------------------------------------------------------------------------

pub fn require_string(v: &Value, label: &str, trim: bool) -> Result<String, AgentToolError> {
    let s = v
        .as_str()
        .ok_or_else(|| AgentToolError::new(AgentError::InvalidArg, format!("{label}必须是字符串")))?;
    let out = if trim { s.trim() } else { s };
    if out.is_empty() {
        return Err(AgentToolError::new(AgentError::InvalidArg, format!("{label}不能为空")));
    }
    Ok(out.to_string())
}

pub fn optional_string(v: &Value, label: &str) -> Result<Option<String>, AgentToolError> {
    if v.is_null() {
        return Ok(None);
    }
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if t.is_empty() {
            return Ok(None);
        }
        return Ok(Some(t.to_string()));
    }
    Err(AgentToolError::new(AgentError::InvalidArg, format!("{label}必须是字符串")))
}

pub fn clamp_int(v: &Value, min: i64, max: i64, fallback: i64) -> i64 {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => fallback as f64,
    };
    if !n.is_finite() {
        return fallback;
    }
    (n.trunc() as i64).clamp(min, max)
}

// ---------------------------------------------------------------------------
// 工具上下文
// ---------------------------------------------------------------------------

/// 工具执行环境：host 依赖 + 共享状态 + 当前授权范围。
pub struct ToolEnv {
    pub deps: Arc<dyn HostDeps>,
    pub shared: Arc<ToolShared>,
    pub scope: ScopeSnapshot,
    pub generation: u64,
    /// 单次工具调用内的 info 缓存（对应 qck opts.cache；不跨调用，避免写入后读到旧条目）。
    pub info_cache: Mutex<HashMap<String, Value>>,
    /// 单次工具调用内的目录列表缓存（同上）。
    pub list_cache: Mutex<HashMap<String, Value>>,
}

impl ToolEnv {
    async fn transfer_call(&self,method:&str,params:&Value)->Result<Value,AgentToolError> {
        let mut bound=if params.is_object(){params.clone()}else{json!({})};
        bound["_expectedSessionGeneration"]=json!(self.generation);
        self.deps.transfer_call(method,&bound).await
    }
    pub fn local_roots(&self) -> Vec<LocalRoot> {
        let mut roots: Vec<LocalRoot> = self
            .scope
            .local_write_roots
            .iter()
            .map(|p| LocalRoot { path: PathBuf::from(p), access: "rw" })
            .collect();
        for p in &self.scope.local_read_roots {
            if !self.scope.local_write_roots.contains(p) {
                roots.push(LocalRoot { path: PathBuf::from(p), access: "r" });
            }
        }
        roots
    }

    pub fn assert_writable(&self, what: &str) -> Result<(), AgentToolError> {
        if self.scope.write_mode != "scoped-write" {
            return Err(AgentToolError::new(
                AgentError::ReadOnly,
                format!("当前为只读模式，不能{what}"),
            )
            .with_hint("请在客户端「设置 → Agent 接入」把写入模式改为「授权目录内可写」"));
        }
        Ok(())
    }

    pub fn assert_deletable(&self) -> Result<(), AgentToolError> {
        self.assert_writable("删除文件")?;
        if !self.scope.allow_delete {
            return Err(AgentToolError::new(
                AgentError::ReadOnly,
                "当前未开启 Agent 删除权限，不能将网盘文件移入回收站",
            )
            .with_hint("如需允许 Agent 删除，请在客户端「设置 → Agent 接入」中开启「允许移入回收站」"));
        }
        Ok(())
    }

    /// 网盘范围校验：fid 命中授权根或其祖先链命中（按当前真实归属，不信任路径名）。
    pub async fn assert_remote_in_scope(&self, fid: &str) -> Result<String, AgentToolError> {
        let id = fid.trim();
        if id.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "fid 不能为空"));
        }
        if self.scope.remote_roots.is_empty() {
            return Err(AgentToolError::new(AgentError::OutOfScope, "尚未授权任何网盘目录")
                .with_hint("请在客户端「设置 → Agent 接入」添加授权目录"));
        }
        if self.scope.remote_roots.iter().any(|r| r == id) {
            return Ok(id.to_string());
        }
        // 向上遍历（带 cache）
        let mut current = id.to_string();
        for _ in 0..MAX_SCOPE_WALK {
            if current == ROOT_FID {
                break;
            }
            let info = self.safe_info(&current).await?;
            if info["_approximate"]==true {
                return Err(AgentToolError::new(AgentError::OutOfScope,"无法从服务端确认当前归属，近似记录不能授予权限").with_hint("请稍后重试，或用官方客户端核对目录归属"));
            }
            let parent = info.get("pdirFid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if parent.is_empty() || parent == current {
                break;
            }
            if self.scope.remote_roots.iter().any(|r| r == &parent) {
                return Ok(id.to_string());
            }
            current = parent;
        }
        Err(AgentToolError::new(AgentError::OutOfScope, "该目录不在授权范围内").with_hint(format!(
            "已授权：{}",
            self.scope.remote_roots.join(", ")
        )))
    }

    /// 多 fid 批量范围校验（共享 cache）。
    pub async fn assert_many_remote_in_scope(&self, fids: &[String]) -> Result<(), AgentToolError> {
        for f in fids {
            self.assert_remote_in_scope(f).await?;
        }
        Ok(())
    }

    /// 带重试与兜底的 file_info（fid="0" 合成；transient 重试；recent 兜底）。
    pub async fn safe_info(&self, fid: &str) -> Result<Value, AgentToolError> {
        if fid == ROOT_FID {
            return Ok(json!({
                "fid": ROOT_FID, "name": "全部文件", "dir": true, "size": 0,
                "updatedAt": 0, "createdAt": 0, "category": 0, "ext": "", "pdirFid": "",
            }));
        }
        if let Some(cached) = self.info_cache.lock().unwrap().get(fid) {
            return Ok(cached.clone());
        }
        let mut last_err: Option<AgentToolError> = None;
        for attempt in 0..3u32 {
            match self
                .deps
                .core_call(self.generation, "fs.info", &json!({ "fid": fid })).await
            {
                Ok(env) => {
                    // quark-core returns a FileItem directly; the historical qck host
                    // wraps it in {item}. Accept both, but never trust another fid.
                    let item=env.get("item").unwrap_or(&env);
                    if item["fid"].as_str()==Some(fid) {
                        self.info_cache.lock().unwrap().insert(fid.to_string(), item.clone());
                        return Ok(item.clone());
                    }
                    // 形状异常按 transient 处理
                    last_err = Some(AgentToolError::new(AgentError::Upstream, "info 响应形状异常"));
                }
                Err(e) => {
                    // 与 qck 一致：INVALID_ARG/NOT_FOUND/SERVER（含 biz 14001/21001）都按
                    // transient 处理——服务端对刚创建/刚删除对象的 info 有收敛窗口，
                    // 14001"Bad Parameter"正是"尚未收敛"。重试耗尽后才走 recent 兜底。
                    // 删除核对不走本函数（直接查 fs.info 判终态），互不影响。
                    let transient = matches!(e.code, AgentError::InvalidArg | AgentError::NotFound | AgentError::Upstream)
                        || e.raw_code
                            .as_deref()
                            .map(|c| c == "INVALID_ARG" || c == "NOT_FOUND" || c == "SERVER")
                            .unwrap_or(false);
                    if !transient {
                        return Err(e);
                    }
                    last_err = Some(e);
                }
            }
            tokio::time::sleep(Duration::from_millis(500 + attempt as u64 * 400)).await;
        }
        // recent 兜底：只信本进程成功写入产生的记录
        if let Some(rec) = self.shared.recall(fid) {
            return Ok(json!({
                "fid": fid, "name": rec.name, "dir": rec.dir, "size": 0,
                "updatedAt": 0, "createdAt": 0, "category": 0, "ext": "",
                "pdirFid": rec.parent_fid, "_approximate": true,
            }));
        }
        Err(last_err.unwrap_or_else(|| AgentToolError::new(AgentError::Upstream, "读取文件信息失败")))
    }

    /// 列目录（带 list cache key）。
    pub async fn list_dir_page(&self, parent: &str, page: i64, size: i64, use_cache: bool) -> Result<Value, AgentToolError> {
        let key = format!("list:{parent}:{page}:{size}");
        if use_cache {
            if let Some(c) = self.list_cache.lock().unwrap().get(&key) {
                return Ok(c.clone());
            }
        }
        let res = self.deps.core_call(
            self.generation,
            "fs.list",
            &json!({ "pdirFid": parent, "page": page, "size": size }),
        ).await?;
        if use_cache {
            self.list_cache.lock().unwrap().insert(key, res.clone());
        }
        Ok(res)
    }

    /// 定位刚创建的子目录或文件（只接受 pdirFid 精确匹配且校验 dir == expect_dir）。
    pub async fn locate_child(
        &self,
        parent: &str,
        name: &str,
        expect_dir: bool,
        tries: i64,
    ) -> Option<Value> {
        let tries = tries.clamp(1, 10);
        for i in 0..tries {
            // 写入后必须新鲜读取：缓存可能仍是不含新条目的旧页
            if let Ok(page) = self.list_dir_page(parent, 1, MAX_PAGE_SIZE, false).await {
                if let Some(list) = page.get("list").and_then(|v| v.as_array()) {
                    for x in list {
                        if x.get("dir").and_then(|v| v.as_bool()).unwrap_or(false) == expect_dir
                            && x.get("name").and_then(|v| v.as_str()) == Some(name)
                        {
                            return Some(x.clone());
                        }
                    }
                }
            }
            if let Ok(page) = self.deps.core_call(
                self.generation,
                "fs.search",
                &json!({ "keyword": name, "page": 1, "size": 50 }),
            ).await {
                if let Some(list) = page.get("list").and_then(|v| v.as_array()) {
                    for x in list {
                        // 只接受 pdirFid === parent 且 dir === expect_dir 精确匹配
                        if x.get("dir").and_then(|v| v.as_bool()).unwrap_or(false) == expect_dir
                            && x.get("name").and_then(|v| v.as_str()) == Some(name)
                            && x.get("pdirFid").and_then(|v| v.as_str()) == Some(parent)
                        {
                            return Some(x.clone());
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(700 * (i as u64 + 1))).await;
        }
        None
    }

    /// 定位刚创建的子目录（只接受 pdirFid 精确匹配；对抗性审查实测过的 P0 约束）。
    pub async fn locate_child_dir(&self, parent: &str, name: &str, tries: i64) -> Option<Value> {
        self.locate_child(parent, name, true, tries).await
    }

    /// 目标目录首页同名冲突检测（best-effort，只核对首页）。
    pub async fn find_name_conflict(
        &self,
        parent: &str,
        name: &str,
        exclude_fid: Option<&str>,
    ) -> Value {
        let page = match self.list_dir_page(parent, 1, MAX_PAGE_SIZE, true).await {
            Ok(p) => p,
            Err(_) => return json!({ "conflict": false, "existing_fid": null, "fully_scanned": false }),
        };
        let list = page.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let complete = page.get("hasMore").and_then(|v| v.as_bool()).map(|b| !b).unwrap_or(true);
        for x in &list {
            let same_name = x.get("name").and_then(|v| v.as_str()) == Some(name);
            let not_self = match exclude_fid {
                Some(e) => x.get("fid").and_then(|v| v.as_str()) != Some(e),
                None => true,
            };
            if same_name && not_self {
                return json!({
                    "conflict": true,
                    "existing_fid": x.get("fid").cloned().unwrap_or(Value::Null),
                    "fully_scanned": complete,
                });
            }
        }
        json!({ "conflict": false, "existing_fid": null, "fully_scanned": complete })
    }

    /// 不能把条目移动到它自己或它的子目录中（沿 pdirFid 向上）。
    pub async fn assert_not_moving_into_itself(&self, fids: &[String], to_fid: &str) -> Result<(), AgentToolError> {
        let src: std::collections::HashSet<&String> = fids.iter().collect();
        let mut current = to_fid.to_string();
        for _ in 0..MAX_SCOPE_WALK {
            if src.contains(&current) {
                return Err(AgentToolError::new(
                    AgentError::InvalidArg,
                    "不能把条目移动到它自己或它的子目录中",
                ));
            }
            if current == ROOT_FID {
                return Ok(());
            }
            let info = self.safe_info(&current).await?;
            let parent = info.get("pdirFid").and_then(|v| v.as_str()).unwrap_or("");
            if parent.is_empty() || parent == current {
                return Ok(());
            }
            current = parent.to_string();
        }
        Ok(())
    }

    /// 等待传输任务到终态（400ms 轮询 transfer.list；遇到会话切换/错误立即中止，绝不死循环）。
    pub async fn wait_for_transfers(&self, ids: &[String], timeout_ms: u64) -> Value {
        if ids.is_empty() {
            return json!({ "done": true, "tasks": [] });
        }
        let timeout = timeout_ms.clamp(0, MAX_WAIT_MS);
        let start = std::time::Instant::now();
        loop {
            match self.transfer_call("transfer.list", &Value::Null).await {
                Ok(tasks) => {
                    let arr = tasks.as_array().cloned().unwrap_or_default();
                    let mut pending: Vec<String> = Vec::new();
                    let mut matched: Vec<Value> = Vec::new();
                    for id in ids {
                        if let Some(t) = arr.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
                            matched.push(t.clone());
                            let st = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
                            if !["done", "error", "canceled"].contains(&st) {
                                pending.push(id.clone());
                            }
                        } else {
                            pending.push(id.clone());
                        }
                    }
                    if pending.is_empty() {
                        return json!({ "done": true, "tasks": matched });
                    }
                    if start.elapsed().as_millis() as u64 >= timeout {
                        return json!({
                            "done": false, "timedOut": true, "tasks": matched, "pendingIds": pending,
                            "note": "等待超时：任务可能仍在后台执行，请稍后用 list_transfers 查询，不要重复提交",
                        });
                    }
                }
                Err(e) => {
                    return json!({
                        "done": false,
                        "aborted": true,
                        "error": e.to_json(),
                        "tasks": [],
                        "pendingIds": ids,
                        "note": format!("等待传输状态中断：{}", e.message),
                    });
                }
            }
            let elapsed = start.elapsed().as_millis() as u64;
            if elapsed >= timeout {
                return json!({
                    "done": false, "timedOut": true, "tasks": [], "pendingIds": ids,
                    "note": "等待超时：任务可能仍在后台执行，请稍后用 list_transfers 查询，不要重复提交",
                });
            }
            let remain = timeout - elapsed;
            tokio::time::sleep(Duration::from_millis(remain.min(400))).await;
        }
    }

    /// 序列化任务（兼容 camelCase 与 snake_case；丢弃上游 raw；eta=-1 表未知）。
    pub fn serialize_task(t: &Value) -> Value {
        let pick = |camel: &str, snake: &str, default: Value| {
            t.get(camel)
                .or_else(|| t.get(snake))
                .cloned()
                .unwrap_or(default)
        };
        json!({
            "id": t.get("id").cloned().unwrap_or(Value::Null),
            "kind": t.get("kind").cloned().unwrap_or(Value::Null),
            "name": t.get("name").cloned().unwrap_or(Value::Null),
            "size": t.get("size").cloned().unwrap_or(json!(0)),
            "transferred": t.get("transferred").cloned().unwrap_or(json!(0)),
            "status": t.get("status").cloned().unwrap_or(Value::Null),
            "error": t.get("error").cloned().unwrap_or(Value::Null),
            "errorCode": pick("errorCode", "error_code", Value::Null),
            "attempts": t.get("attempts").cloned().unwrap_or(json!(0)),
            "createdAt": pick("createdAt", "created_at", json!(0)),
            "updatedAt": pick("updatedAt", "updated_at", json!(0)),
            "fid": t.get("fid").cloned().unwrap_or(Value::Null),
            "pdirFid": pick("pdirFid", "pdir_fid", Value::Null),
            "speed": t.get("speed").cloned().unwrap_or(json!(0)),
            "eta": t.get("eta").cloned().unwrap_or(json!(-1)),
        })
    }

    /// 记录本进程成功写入的对象（范围校验过的 parent 由调用方保证）。
    pub fn remember_object(&self, fid: &str, parent_fid: &str, name: &str, dir: bool) {
        self.shared.remember(fid, parent_fid, name, dir);
    }

    /// 上传完成后的兜底定位（失败静默返回 None）。
    pub async fn remember_uploaded(&self, parent_fid: &str, name: &str) -> Option<Value> {
        if let Some(found) = self.locate_child(parent_fid, name, false, 4).await {
            let fid = found.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !fid.is_empty() {
                self.remember_object(&fid, parent_fid, name, false);
                return Some(found);
            }
        }
        None
    }
}

/// 上游 core::Error → AgentToolError 归一化（透传已知语义）。
pub fn map_core_error(e: &crate::policy::AgentToolError) -> AgentToolError {
    e.clone()
}

/// 把 core_call 的 Result<Value, AgentToolError> 透传（host 已统一映射）。
pub fn upstream_passthrough(code: &str, message: &str, biz: Option<i64>) -> AgentToolError {
    let mut e = AgentToolError::from_upstream(code, message, None);
    if let Some(b) = biz {
        e.upstream_code = Some(json!(b));
    }
    e
}

/// 引用检查（保持 matches_remote_scope 被引用；范围链命中判定在 assert_remote_in_scope 内联实现，
/// 该函数保留供单测直接覆盖）。
pub fn scope_matches(fid: &str, ancestors: &[String], roots: &[String]) -> bool {
    matches_remote_scope(fid, ancestors, roots)
}


// ---------------------------------------------------------------------------
// 工具定义与分发
// ---------------------------------------------------------------------------

use crate::registry::{ToolDef, ToolRegistry, ToolResult};
use crate::journal::Journal;
use crate::plans::PlanStore;
use std::sync::Arc as StdArc;

/// 20 个工具（19 个对齐 qck + delete_entries）。
pub const TOOL_NAMES: [&str; 20] = [
    "drive_status", "list_dir", "search_files", "file_info", "tree_dir",
    "list_transfers", "read_text_file", "list_journal", "get_plan",
    "create_folder", "rename_entry", "move_entries", "copy_entries",
    "download_files", "upload_file", "save_text_file", "transfer_control",
    "plan_create", "plan_execute", "delete_entries",
];

fn schema(props: Value, required: &[&str]) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), json!("object"));
    obj.insert("properties".into(), props);
    obj.insert("additionalProperties".into(), json!(false));
    if !required.is_empty() {
        obj.insert("required".into(), json!(required));
    }
    Value::Object(obj)
}

/// 工具定义（OpenAI tools 参数形状）。
pub fn tool_defs() -> Vec<ToolDef> {
    let mut out = Vec::new();
    let s = |desc: &'static str, params: Value, write: bool, name: &'static str| ToolDef {
        name,
        description: desc,
        parameters: params,
        requires_write: write,
    };
    out.push(s("登录态、容量与 Agent 授权范围概览。", schema(json!({}), &[]), false, "drive_status"));
    out.push(s("分页列出网盘目录内容。", schema(json!({
        "pdir_fid": {"type": "string", "description": "目录 fid，省略用第一个授权根"},
        "page": {"type": "integer", "minimum": 1},
        "size": {"type": "integer", "minimum": 1, "maximum": 200},
        "cat": {"type": "string"}
    }), &[]), false, "list_dir"));
    out.push(s("按名称搜索网盘文件。", schema(json!({
        "keyword": {"type": "string"},
        "page": {"type": "integer", "minimum": 1},
        "size": {"type": "integer", "minimum": 1, "maximum": 200},
        "cat": {"type": "string"},
        "only_in_scope": {"type": "boolean"}
    }), &["keyword"]), false, "search_files"));
    out.push(s("读取单个文件或目录的元数据。", schema(json!({
        "fid": {"type": "string"}
    }), &["fid"]), false, "file_info"));
    out.push(s("递归枚举目录树（盘点用，有上限）。", schema(json!({
        "root_fid": {"type": "string"},
        "max_depth": {"type": "integer", "minimum": 1, "maximum": 8},
        "max_entries": {"type": "integer", "minimum": 1, "maximum": 2000},
        "include_dirs": {"type": "boolean"}
    }), &[]), false, "tree_dir"));
    out.push(s("查询传输队列（含 GUI 发起的任务）。", schema(json!({
        "task_ids": {"type": "array", "items": {"type": "string"}},
        "kind": {"type": "string"},
        "status": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 200}
    }), &[]), false, "list_transfers"));
    out.push(s("读取文本文件正文（下载到本地授权目录后读取）。", schema(json!({
        "fid": {"type": "string"},
        "path": {"type": "string"},
        "max_bytes": {"type": "integer", "minimum": 1, "maximum": 262144},
        "download_if_missing": {"type": "boolean"},
        "timeout_ms": {"type": "integer"}
    }), &[]), false, "read_text_file"));
    out.push(s("查询操作记录（已脱敏）。", schema(json!({
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        "tool": {"type": "string"},
        "since": {"type": "integer"}
    }), &[]), false, "list_journal"));
    out.push(s("读取整理计划全文。", schema(json!({
        "plan_id": {"type": "string"}
    }), &["plan_id"]), false, "get_plan"));
    out.push(s("新建文件夹（需授权目录内可写）。", schema(json!({
        "parent_fid": {"type": "string"},
        "name": {"type": "string"}
    }), &["name"]), true, "create_folder"));
    out.push(s("重命名文件或文件夹（含冲突预检与 dry_run）。", schema(json!({
        "fid": {"type": "string"},
        "name": {"type": "string"},
        "dry_run": {"type": "boolean"}
    }), &["fid", "name"]), true, "rename_entry"));
    out.push(s("移动条目（拒绝移入自身子目录）。", schema(json!({
        "fids": {"type": "array", "items": {"type": "string"}},
        "to_fid": {"type": "string"},
        "allow_conflict": {"type": "boolean"}
    }), &["fids", "to_fid"]), true, "move_entries"));
    out.push(s("复制条目（服务端异步）。", schema(json!({
        "fids": {"type": "array", "items": {"type": "string"}},
        "to_fid": {"type": "string"},
        "allow_conflict": {"type": "boolean"}
    }), &["fids", "to_fid"]), true, "copy_entries"));
    out.push(s("下载网盘文件到本地授权目录。", schema(json!({
        "fids": {"type": "array", "items": {"type": "string"}},
        "local_dir": {"type": "string"},
        "wait": {"type": "boolean"},
        "timeout_ms": {"type": "integer"}
    }), &["fids"]), true, "download_files"));
    out.push(s("上传本地文件到网盘目录。", schema(json!({
        "local_path": {"type": "string"},
        "pdir_fid": {"type": "string"},
        "name": {"type": "string"},
        "wait": {"type": "boolean"},
        "timeout_ms": {"type": "integer"}
    }), &["local_path"]), true, "upload_file"));
    out.push(s("把文本另存为网盘新文件（不覆盖原文件）。", schema(json!({
        "pdir_fid": {"type": "string"},
        "name": {"type": "string"},
        "text": {"type": "string"},
        "verify": {"type": "boolean"},
        "wait": {"type": "boolean"},
        "timeout_ms": {"type": "integer"}
    }), &["name", "text"]), true, "save_text_file"));
    out.push(s("暂停/继续/重试/取消传输任务（四种动作都需写权限）。", schema(json!({
        "task_id": {"type": "string"},
        "action": {"type": "string", "enum": ["pause", "resume", "retry", "cancel"]}
    }), &["task_id", "action"]), true, "transfer_control"));
    out.push(s("生成整理计划（只读扫描，执行需用户确认授权）。", schema(json!({
        "root_fid": {"type": "string"},
        "by": {"type": "string", "enum": ["ext", "category", "modified_month"]},
        "target_parent_fid": {"type": "string"},
        "ext_groups": {"type": "object"},
        "max_depth": {"type": "integer", "minimum": 1, "maximum": 8},
        "max_entries": {"type": "integer", "minimum": 1, "maximum": 2000},
        "include_subdirs": {"type": "boolean"}
    }), &[]), false, "plan_create"));
    out.push(s("执行已确认授权（revision + content_hash）的计划。", schema(json!({
        "plan_id": {"type": "string"},
        "revision": {"type": "integer"},
        "content_hash": {"type": "string"},
        "stop_on_error": {"type": "boolean"}
    }), &["plan_id", "revision", "content_hash"]), true, "plan_execute"));
    out.push(s("把网盘文件/文件夹移入回收站（可恢复）。需先 dry_run 确认目标，再带 confirm_names 执行。", schema(json!({
        "fids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 50},
        "dry_run": {"type": "boolean"},
        "confirm_names": {"type": "array", "items": {"type": "string"}}
    }), &["fids"]), true, "delete_entries"));
    out
}

/// 工具注册表：持有宿主依赖、共享状态、journal 与计划仓库。
pub struct QuarkTools {
    pub deps: StdArc<dyn HostDeps>,
    pub shared: StdArc<ToolShared>,
    pub journal: StdArc<Journal>,
    pub plans: StdArc<PlanStore>,
}

impl QuarkTools {
    pub fn new(
        deps: StdArc<dyn HostDeps>,
        journal: StdArc<Journal>,
        plans: StdArc<PlanStore>,
    ) -> Self {
        Self { deps, shared: StdArc::new(ToolShared::new()), journal, plans }
    }

    fn env(&self, ctx: &crate::registry::ToolContext) -> ToolEnv {
        ToolEnv {
            deps: self.deps.clone(),
            shared: self.shared.clone(),
            scope: ctx.scope.clone(),
            generation: ctx.generation,
            info_cache: Mutex::new(HashMap::new()),
            list_cache: Mutex::new(HashMap::new()),
        }
    }

    /// 执行工具分发（统一审计由入口层 gateway/chat 经 summarize_args 完成，避免重复记账与正文落盘）。
    pub async fn execute(
        &self,
        ctx: &crate::registry::ToolContext,
        name: &str,
        args: &Value,
    ) -> ToolResult {
        let env = self.env(ctx);
        self.dispatch(&env, name, args).await
    }

    async fn dispatch(&self, env: &ToolEnv, name: &str, args: &Value) -> Result<Value, AgentToolError> {
        if !args.is_object() && !args.is_null() {
            return Err(AgentToolError::new(
                AgentError::InvalidArg,
                "工具参数必须是 JSON 对象",
            ));
        }
        let a = |k: &str| -> Value { args.get(k).cloned().unwrap_or(Value::Null) };
        match name {
            "drive_status" => self.tool_drive_status(env).await,
            "list_dir" => self.tool_list_dir(env, args, &a).await,
            "search_files" => self.tool_search_files(env, args, &a).await,
            "file_info" => self.tool_file_info(env, &a).await,
            "tree_dir" => self.tool_tree_dir(env, args, &a).await,
            "list_transfers" => self.tool_list_transfers(env, args, &a).await,
            "read_text_file" => self.tool_read_text_file(env, args, &a).await,
            "list_journal" => self.tool_list_journal(env, args, &a).await,
            "get_plan" => self.tool_get_plan(env, &a).await,
            "create_folder" => self.tool_create_folder(env, &a).await,
            "rename_entry" => self.tool_rename_entry(env, &a).await,
            "move_entries" => self.tool_move_entries(env, args, &a).await,
            "copy_entries" => self.tool_copy_entries(env, args, &a).await,
            "download_files" => self.tool_download_files(env, args, &a).await,
            "upload_file" => self.tool_upload_file(env, args, &a).await,
            "save_text_file" => self.tool_save_text_file(env, args, &a).await,
            "transfer_control" => self.tool_transfer_control(env, &a).await,
            "plan_create" => self.tool_plan_create(env, args, &a).await,
            "plan_execute" => self.tool_plan_execute(env, &a).await,
            "delete_entries" => self.tool_delete_entries(env, args, &a).await,
            _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("未知工具：{name}"))),
        }
    }
}

impl ToolRegistry for QuarkTools {
    fn tools(&self) -> Vec<ToolDef> {
        tool_defs()
    }

    fn call_tool<'a>(
        &'a self,
        ctx: &'a crate::registry::ToolContext,
        name: &'a str,
        args: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ToolResult> + Send + 'a>> {
        Box::pin(async move { self.execute(ctx, name, args).await })
    }
}

impl QuarkTools {
    // ---------------- 只读工具 ----------------

    async fn tool_drive_status(&self, env: &ToolEnv) -> Result<Value, AgentToolError> {
        let status = env.deps.core_call(env.generation, "auth.status", &Value::Null).await?;
        let logged_in = status.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
        let mut quota = json!({"total": -1, "used": -1, "free": -1});
        if logged_in {
            if let Ok(q) = env.deps.core_call(env.generation, "auth.quota", &Value::Null).await {
                quota = json!({
                    "total": q.get("total").cloned().unwrap_or(json!(-1)),
                    "used": q.get("used").cloned().unwrap_or(json!(-1)),
                    "free": q.get("free").cloned().unwrap_or(json!(-1)),
                });
            }
        }
        Ok(json!({
            "logged_in": logged_in,
            "expired": status.get("expired").and_then(|v| v.as_bool()).unwrap_or(false),
            "nickname": status.get("nickname").cloned().unwrap_or(json!("")),
            "member_label": status.get("memberLabel").cloned().unwrap_or(json!("")),
            "quota_bytes": quota,
            "agent": {
                "write_mode": env.scope.write_mode,
                "allow_delete": env.scope.allow_delete,
                "remote_roots": env.scope.remote_roots,
                "local_read_roots": env.scope.local_read_roots.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                "local_write_roots": env.scope.local_write_roots.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            },
            "notes": [
                "容量字段为 -1 表示服务端未返回该数值。",
                "授权范围可在客户端「设置 → Agent 接入」中修改。"
            ]
        }))
    }

    fn first_remote_root(env: &ToolEnv) -> Result<String, AgentToolError> {
        env.scope
            .remote_roots
            .first()
            .cloned()
            .ok_or_else(|| AgentToolError::new(AgentError::OutOfScope, "尚未授权任何网盘目录")
                .with_hint("请在客户端「设置 → Agent 接入」添加授权目录"))
    }

    async fn tool_list_dir(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let parent = optional_string(&a("pdir_fid"), "pdir_fid")?
            .unwrap_or(Self::first_remote_root(env)?);
        let page = clamp_int(&a("page"), 1, 100_000, 1);
        let requested_size = clamp_int(&a("size"), 1, 100_000, 100);
        let size = requested_size.min(MAX_PAGE_SIZE);
        let mut params = json!({ "pdirFid": parent, "page": page, "size": size });
        if let Some(cat) = optional_string(&a("cat"), "cat")? {
            params["cat"] = json!(cat);
        }
        env.assert_remote_in_scope(&parent).await?;
        let res = env.deps.core_call(env.generation, "fs.list", &params).await?;
        let mut out = json!({
            "pdir_fid": parent,
            "list": res.get("list").cloned().unwrap_or(json!([])),
            "total": res.get("total").cloned().unwrap_or(json!(-1)),
            "page": res.get("page").cloned().unwrap_or(json!(page)),
            "size": size,
            "hasMore": res.get("hasMore").cloned().unwrap_or(json!(false)),
            "truncated": requested_size > MAX_PAGE_SIZE,
        });
        if requested_size > MAX_PAGE_SIZE {
            out["truncation_note"] = json!(format!(
                "请求的 size={requested_size} 超过单页上限 {MAX_PAGE_SIZE}，已按 {MAX_PAGE_SIZE} 返回"
            ));
        }
        Ok(out)
    }

    async fn tool_search_files(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        if env.scope.remote_roots.is_empty() {
            return Err(AgentToolError::new(AgentError::OutOfScope, "尚未授权任何网盘目录")
                .with_hint("请在客户端「设置 → Agent 接入」添加授权目录"));
        }
        let keyword = require_string(&a("keyword"), "keyword", true)?;
        let page = clamp_int(&a("page"), 1, 100_000, 1);
        let requested_size = clamp_int(&a("size"), 1, 100_000, 50);
        let size = requested_size.min(MAX_PAGE_SIZE);
        let mut params = json!({ "keyword": keyword, "page": page, "size": size });
        if let Some(cat) = optional_string(&a("cat"), "cat")? {
            params["cat"] = json!(cat);
        }
        let res = env.deps.core_call(env.generation, "fs.search", &params).await?;
        let mut list = res.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        // 强制按授权范围过滤（不允许调用方通过 only_in_scope=false 绕过作用域读取未授权目录文件名）。
        let mut kept = Vec::new();
        for item in list.drain(..) {
            let owner = item
                .get("pdirFid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| item.get("fid").and_then(|v| v.as_str()))
                .unwrap_or("");
            if env.assert_remote_in_scope(owner).await.is_ok() {
                kept.push(item);
            }
        }
        let filtered_count = kept.len();
        Ok(json!({
            "keyword": keyword,
            "list": kept,
            "total": filtered_count,
            "page": res.get("page").cloned().unwrap_or(json!(page)),
            "size": size,
            "hasMore": res.get("hasMore").cloned().unwrap_or(json!(false)),
            "truncated": requested_size > MAX_PAGE_SIZE,
            "scope_filtered": true,
            "note": "已强制按授权范围过滤；仅返回授权目录内的匹配项。",
        }))
    }

    async fn tool_file_info(&self, env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let fid = require_string(&a("fid"), "fid", true)?;
        env.assert_remote_in_scope(&fid).await?;
        let item = env.safe_info(&fid).await?;
        Ok(json!({ "item": item }))
    }

    async fn tool_tree_dir(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let root = optional_string(&a("root_fid"), "root_fid")?
            .unwrap_or(Self::first_remote_root(env)?);
        let max_depth = clamp_int(&a("max_depth"), 1, MAX_TREE_DEPTH, 3);
        let max_entries = clamp_int(&a("max_entries"), 1, MAX_TREE_ENTRIES as i64, 500) as usize;
        let include_dirs = a("include_dirs").as_bool().unwrap_or(false);
        env.assert_remote_in_scope(&root).await?;

        let mut out: Vec<Value> = Vec::new();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut scanned_dirs = 0usize;
        let mut incomplete_dirs = 0usize;
        let mut truncated = false;
        // dir_scan 与结果条目上限独立：1500 个空目录也不能绕过 1508 次列表请求的上限（规格实测）。
        let max_dir_scan = max_entries;
        let mut queue: std::collections::VecDeque<(String, i64, String)> = std::collections::VecDeque::new();
        queue.push_back((root.clone(), 0, String::new()));
        visited.insert(root.clone());
        'outer: while let Some((fid, depth, trail)) = queue.pop_front() {
            if scanned_dirs >= max_dir_scan {
                truncated = true;
                break;
            }
            scanned_dirs += 1;
            let mut page = 1i64;
            loop {
                let res = match env.list_dir_page(&fid, page, MAX_PAGE_SIZE, true).await {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(e);
                    }
                };
                let list = res.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for item in &list {
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let is_dir = item.get("dir").and_then(|v| v.as_bool()).unwrap_or(false);
                    let rel = if trail.is_empty() {
                        name.to_string()
                    } else {
                        format!("{trail}/{name}")
                    };
                    if is_dir {
                        if include_dirs {
                            out.push(json!({
                                "fid": item.get("fid").cloned().unwrap_or(Value::Null),
                                "name": name, "dir": true, "size": 0,
                                "rel_path": rel, "depth": depth + 1,
                            }));
                            if out.len() >= max_entries {
                                truncated = true;
                                break 'outer;
                            }
                        }
                        let child = item.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if depth + 1 < max_depth {
                            if !child.is_empty() && visited.insert(child.clone()) {
                                queue.push_back((child, depth + 1, rel));
                            }
                        } else {
                            // 深度到顶不入队：计数不受 include_dirs 影响（否则子目录被静默丢弃却报告完成）
                            incomplete_dirs += 1;
                        }
                    } else {
                        out.push(json!({
                            "fid": item.get("fid").cloned().unwrap_or(Value::Null),
                            "name": name, "dir": false,
                            "size": item.get("size").cloned().unwrap_or(json!(0)),
                            "rel_path": rel, "depth": depth + 1,
                        }));
                        if out.len() >= max_entries {
                            truncated = true;
                            break 'outer;
                        }
                    }
                }
                let has_more = res.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false);
                if !has_more || page >= 500 {
                    break;
                }
                page += 1;
            }
        }
        Ok(json!({
            "root_fid": root,
            "max_depth": max_depth,
            "max_entries": max_entries,
            "entries": out,
            "count": out.len(),
            "scanned_dirs": scanned_dirs,
            "truncated": truncated,
            "incomplete_subtrees": incomplete_dirs,
            "note": if truncated {
                format!("已达到上限（条目 {max_entries} 或扫描目录 {max_dir_scan}），结果不完整；请缩小目录范围或提高 max_entries 后继续。")
            } else if incomplete_dirs > 0 {
                format!("有 {incomplete_dirs} 个子目录因达到深度上限未展开。")
            } else {
                "枚举完成。".to_string()
            },
        }))
    }

    async fn tool_list_transfers(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let ids: Option<Vec<String>> = a("task_ids").as_array().map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        });
        let kind = optional_string(&a("kind"), "kind")?;
        let status = optional_string(&a("status"), "status")?;
        let tasks = env.transfer_call("transfer.list", &Value::Null).await?;
        let arr = tasks.as_array().cloned().unwrap_or_default();
        let mut filtered: Vec<Value> = Vec::new();
        for t in arr {
            if let Some(want) = &ids {
                if !want.iter().any(|id| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
                    continue;
                }
            }
            if let Some(k) = &kind {
                if t.get("kind").and_then(|v| v.as_str()) != Some(k.as_str()) {
                    continue;
                }
            }
            if let Some(s) = &status {
                if t.get("status").and_then(|v| v.as_str()) != Some(s.as_str()) {
                    continue;
                }
            }
            // 仅展示当前授权范围内的传输任务（携带远端 fid/pdirFid 时强制核对作用域）
            let remote_ref = t
                .get("pdirFid")
                .or_else(|| t.get("pdir_fid"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| t.get("fid").and_then(|v| v.as_str()).filter(|s| !s.is_empty()));
            if let Some(rfid) = remote_ref {
                if env.assert_remote_in_scope(rfid).await.is_err() {
                    continue;
                }
            }
            filtered.push(ToolEnv::serialize_task(&t));
        }
        let total = filtered.len();
        // 对齐 qck：limit 1..200 默认 100，取最近 limit 条；超出如实标记 truncated。
        let limit = clamp_int(&a("limit"), 1, 200, 100) as usize;
        let truncated = total > limit;
        let tasks_out: Vec<Value> = filtered.split_off(total.saturating_sub(limit.min(total)));
        Ok(json!({
            "tasks": tasks_out,
            "count": total.min(limit),
            "total": total,
            "truncated": truncated,
            "note": if truncated {
                format!("共 {total} 条，只返回最近 {limit} 条；请加 task_ids/kind/status 过滤。")
            } else {
                "任务 id 是查询过滤条件，不是入队凭证；入队请用 download_files/upload_file。".to_string()
            },
        }))
    }

    async fn tool_read_text_file(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let fid = optional_string(&a("fid"), "fid")?;
        let explicit_path = optional_string(&a("path"), "path")?;
        let max_bytes = clamp_int(&a("max_bytes"), 1, MAX_TEXT_BYTES as i64, DEFAULT_TEXT_BYTES as i64) as usize;
        let download_if_missing = a("download_if_missing").as_bool().unwrap_or(true);
        let timeout_ms = clamp_int(&a("timeout_ms"), 0, MAX_WAIT_MS as i64, DEFAULT_WAIT_MS as i64) as u64;

        let (path, name, total_bytes_meta) = match (explicit_path, fid) {
            (Some(p), _) => {
                let real = crate::policy::assert_local_path(
                    &p,
                    &env.local_roots(),
                    false,
                    "path",
                )?;
                let name = real.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                (real, name, 0u64)
            }
            (None, Some(f)) => {
                env.assert_remote_in_scope(&f).await?;
                let info = env.safe_info(&f).await?;
                if info.get("dir").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Err(AgentToolError::new(AgentError::InvalidArg, "不能读取文件夹的正文，请指定文件"));
                }
                let name = info.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let total = info.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                // 绝不把不可信云端 info["name"] 直接拼接到工作目录（防路径穿越/任意本地文件读取）：
                // 优先复用传输队列中已完成且通过本地授权范围校验的 localPath。
                let mut verified_path: Option<std::path::PathBuf> = None;
                if let Ok(tasks) = env.transfer_call("transfer.list", &Value::Null).await {
                    if let Some(arr) = tasks.as_array() {
                        let local_roots = env.local_roots();
                        for t in arr.iter().rev() {
                            if t.get("fid").and_then(|v| v.as_str()) == Some(f.as_str())
                                && t.get("kind").and_then(|v| v.as_str()) == Some("download")
                                && t.get("status").and_then(|v| v.as_str()) == Some("done")
                            {
                                if let Some(lp) = t.get("localPath").and_then(|v| v.as_str()) {
                                    if let Ok(real) = crate::policy::assert_local_path(lp, &local_roots, false, "localPath") {
                                        if real.is_file() {
                                            verified_path = Some(real);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                let path = if let Some(existing) = verified_path {
                    existing
                } else {
                    if !download_if_missing {
                        return Err(AgentToolError::new(AgentError::NotFound, "本地尚未下载该文件")
                            .with_hint("请先调用 download_files，或设置 download_if_missing=true"));
                    }
                    // 下载写入用户工作目录并改动传输队列，必须要求写权限，禁止只读模式绕过。
                    env.assert_writable("下载网盘文件到本地工作目录")?;
                    let workdir = Self::resolve_work_dir(env, None)?;
                    let safe_name = Self::safe_download_name(&name, &f);
                    let accepted = env.transfer_call(
                        "transfer.download",
                        &json!({ "fids": [f], "localDir": workdir.to_string_lossy(), "names": [safe_name] }),
                    ).await?;
                    let ids: Vec<String> = accepted.as_array().map(|arr| {
                        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                    }).unwrap_or_default();
                    let waited = env.wait_for_transfers(&ids, timeout_ms).await;
                    if waited.get("aborted").and_then(|v| v.as_bool()) == Some(true) {
                        let err_obj = waited.get("error").unwrap_or(&Value::Null);
                        let code = err_obj.get("code").and_then(|v| v.as_str()).unwrap_or("ABORTED");
                        let msg = err_obj
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("等待下载状态中断");
                        return Err(AgentToolError::from_upstream(code, msg, None));
                    }
                    if waited.get("done").and_then(|v| v.as_bool()) != Some(true) {
                        return Ok(json!({
                            "status": "pending",
                            "task_ids": ids,
                            "note": "下载尚未完成或超时；请用 list_transfers 查询，完成后再读取。",
                            "wait": waited,
                        }));
                    }
                    let tasks = waited.get("tasks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let failed = tasks.is_empty()
                        || tasks.iter().any(|t| t.get("status").and_then(|v| v.as_str()) != Some("done"));
                    if failed {
                        return Err(AgentToolError::new(AgentError::Upstream, "下载失败，无法读取正文")
                            .with_hint("请用 list_transfers 查看错误详情"));
                    }
                    let downloaded = tasks
                        .first()
                        .and_then(|t| t.get("localPath"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AgentToolError::new(AgentError::Upstream, "下载完成但未返回本地路径"))?;
                    crate::policy::assert_local_path(downloaded, &env.local_roots(), false, "localPath")?
                };
                (path, name, total)
            }
            (None, None) => {
                return Err(AgentToolError::new(AgentError::InvalidArg, "必须提供 fid 或 path"));
            }
        };

        let res = read_text_at(&path, max_bytes)?;
        let mut out = res;
        out["name"] = json!(name);
        if total_bytes_meta > 0 {
            out["total_bytes"] = json!(total_bytes_meta.max(out.get("total_bytes").and_then(|v| v.as_u64()).unwrap_or(0)));
        }
        Ok(out)
    }

    async fn tool_list_journal(&self, _env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let limit = clamp_int(&a("limit"), 1, 100, 30) as usize;
        let tool = optional_string(&a("tool"), "tool")?;
        let rows = self.journal.list(limit, tool.as_deref());
        Ok(json!({
            "records": rows,
            "journal_file": self.journal.file().file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        }))
    }

    async fn tool_get_plan(&self, _env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let plan_id = require_string(&a("plan_id"), "plan_id", true)?;
        let plan = self.plans.get(&plan_id)?;
        Ok(json!({ "plan": plan }))
    }

    // ---------------- 写工具 ----------------

    async fn tool_create_folder(&self, env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_writable("新建文件夹")?;
        let parent = optional_string(&a("parent_fid"), "parent_fid")?
            .unwrap_or(Self::first_remote_root(env)?);
        env.assert_remote_in_scope(&parent).await?;
        let name = require_string(&a("name"), "name", false)?;
        let accepted = env.deps.core_call(env.generation,
            "fs.mkdir",
            &json!({ "pdirFid": parent, "name": name }),
        ).await?;
        let created = env.locate_child_dir(&parent, &name, 4).await;
        if let Some(found) = &created {
            let fid = found.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !fid.is_empty() {
                env.remember_object(&fid, &parent, &name, true);
            }
        }
        Ok(json!({
            "parent_fid": parent,
            "name": name,
            "accepted": true,
            "completed": accepted.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
            "task_id": accepted.get("taskId").cloned().unwrap_or(Value::Null),
            "created_fid": created.as_ref().and_then(|c| c.get("fid")).cloned(),
            "visible": created.is_some(),
            "note": if created.is_some() {
                "created_fid 可直接作为上传/移动目标"
            } else {
                "请稍后用 list_dir 复核，不要重复创建。"
            },
        }))
    }

    async fn tool_rename_entry(&self, env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let fid = require_string(&a("fid"), "fid", true)?;
        let name = require_string(&a("name"), "name", false)?;
        env.assert_remote_in_scope(&fid).await?;
        let before = env.safe_info(&fid).await?;
        let parent = before
            .get("pdirFid")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(ROOT_FID);
        let conflict = env.find_name_conflict(parent, &name, Some(&fid)).await;
        if conflict.get("conflict").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(AgentToolError::new(AgentError::Conflict, "目标名称已存在")
                .with_hint("请换一个名称，或先确认同名文件"));
        }
        if a("dry_run").as_bool().unwrap_or(false) {
            return Ok(json!({
                "dry_run": true, "fid": fid,
                "from": before.get("name").cloned(), "to": name, "conflicts": [],
            }));
        }
        env.assert_writable("重命名")?;
        let accepted = env.deps.core_call(env.generation, "fs.rename", &json!({ "fid": fid, "name": name })).await?;
        env.info_cache.lock().unwrap().clear();
        let after = env.safe_info(&fid).await.ok();
        let observed = after.as_ref().and_then(|x| x.get("name").and_then(|v| v.as_str())).map(|s| s.to_string());
        Ok(json!({
            "fid": fid,
            "requested_name": name,
            "before": before.get("name").cloned(),
            "observed_after": observed,
            "verified": observed.as_deref() == Some(name.as_str()),
            "accepted": true,
            "completed": accepted.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
            "task_id": accepted.get("taskId").cloned().unwrap_or(Value::Null),
            "note": if observed.as_deref() == Some(name.as_str()) {
                "已核对一致"
            } else {
                "尚未在读取中观察到新名称；请稍后用 file_info 复核，不要重复提交。"
            },
        }))
    }

    async fn prepare_move_copy(
        &self,
        env: &ToolEnv,
        a: &(dyn Fn(&str) -> Value + Sync),
    ) -> Result<(Vec<String>, String, Vec<Value>, Vec<Value>, bool), AgentToolError> {
        env.assert_writable("移动文件")?;
        let fids: Vec<String> = a("fids")
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if fids.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "fids 不能为空"));
        }
        let to_fid = require_string(&a("to_fid"), "to_fid", true)?;
        env.assert_many_remote_in_scope(&fids).await?;
        env.assert_remote_in_scope(&to_fid).await?;
        env.assert_not_moving_into_itself(&fids, &to_fid).await?;
        let mut already: Vec<Value> = Vec::new();
        let mut conflicts: Vec<Value> = Vec::new();
        for fid in &fids {
            let info = env.safe_info(fid).await?;
            let parent = info.get("pdirFid").and_then(|v| v.as_str()).unwrap_or("");
            if parent == to_fid {
                already.push(json!({"fid": fid, "name": info.get("name").cloned()}));
                continue;
            }
            let name = info.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let c = env.find_name_conflict(&to_fid, name, None).await;
            if c.get("conflict").and_then(|v| v.as_bool()).unwrap_or(false) {
                conflicts.push(json!({
                    "fid": fid, "name": name, "existing_fid": c.get("existing_fid").cloned(),
                }));
            }
        }
        let all_already = already.len() == fids.len();
        Ok((fids, to_fid, already, conflicts, all_already))
    }

    async fn tool_move_entries(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let (fids, to_fid, already, conflicts, all_already) = self.prepare_move_copy(env, a).await?;
        let allow_conflict = a("allow_conflict").as_bool().unwrap_or(false);
        if all_already {
            return Ok(json!({
                "executed": false, "to_fid": to_fid, "already_in_target": already, "conflicts": [],
                "note": "这些条目已经位于目标目录，无需移动。",
            }));
        }
        if !conflicts.is_empty() && !allow_conflict {
            return Ok(json!({
                "executed": false, "to_fid": to_fid, "conflicts": conflicts, "already_in_target": already,
                "note": "目标目录已存在同名项，未提交移动。请先重命名或改用其他目录。",
            }));
        }
        let accepted = env.deps.core_call(env.generation,
            "fs.move",
            &json!({ "fids": fids, "toFid": to_fid }),
        ).await?;
        for fid in &fids {
            env.remember_object(fid, &to_fid, "", false);
        }
        Ok(json!({
            "executed": true, "fids": fids, "to_fid": to_fid, "conflicts": conflicts,
            "accepted": true,
            "completed": accepted.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
            "task_id": accepted.get("taskId").cloned().unwrap_or(Value::Null),
            "note": if accepted.get("taskId").is_some_and(|v| !v.is_null()) {
                "完成情况请另行确认，不要重复提交"
            } else {
                "可用 file_info 复核新的父目录"
            },
        }))
    }

    async fn tool_copy_entries(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let (fids, to_fid, already, conflicts, all_already) = self.prepare_move_copy(env, a).await?;
        let allow_conflict = a("allow_conflict").as_bool().unwrap_or(false);
        if all_already {
            return Ok(json!({
                "executed": false, "to_fid": to_fid, "already_in_target": already, "conflicts": [],
                "note": "这些条目已经位于目标目录。",
            }));
        }
        if !conflicts.is_empty() && !allow_conflict {
            return Ok(json!({
                "executed": false, "to_fid": to_fid, "conflicts": conflicts,
                "note": "目标目录已存在同名项，未提交复制。",
            }));
        }
        let accepted = env.deps.core_call(env.generation,
            "fs.copy",
            &json!({ "fids": fids, "toFid": to_fid }),
        ).await?;
        Ok(json!({
            "executed": true, "fids": fids, "to_fid": to_fid,
            "accepted": true,
            "completed": accepted.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
            "task_id": accepted.get("taskId").cloned().unwrap_or(Value::Null),
            "note": "复制可能异步完成；请稍后用 list_dir 确认结果，不要重复提交。",
        }))
    }

    async fn tool_download_files(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_writable("下载文件")?;
        let fids: Vec<String> = a("fids")
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if fids.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "fids 不能为空"));
        }
        env.assert_many_remote_in_scope(&fids).await?;
        let explicit = optional_string(&a("local_dir"), "local_dir")?;
        let dir = Self::resolve_work_dir(env, explicit.as_deref())?;
        let mut names: Vec<String> = Vec::new();
        for fid in &fids {
            let info = env.safe_info(fid).await?;
            if info.get("dir").and_then(|v| v.as_bool()).unwrap_or(false) {
                return Err(AgentToolError::new(AgentError::InvalidArg, "暂不支持下载整个文件夹，请指定文件"));
            }
            let raw_name = info.get("name").and_then(|v| v.as_str()).unwrap_or("");
            names.push(Self::safe_download_name(raw_name, fid));
        }
        let accepted = env.transfer_call(
            "transfer.download",
            &json!({ "fids": fids, "localDir": dir.to_string_lossy(), "names": names }),
        ).await?;
        let task_ids: Vec<String> = accepted.as_array().map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        }).unwrap_or_default();
        let wait = a("wait").as_bool().unwrap_or(false);
        let mut out = json!({
            "task_ids": task_ids, "local_dir": dir.to_string_lossy(), "fids": fids, "names": names,
            "note": "已入队。请用 list_transfers 查询进度，完成后用 read_text_file 读取。",
        });
        if wait {
            let timeout = clamp_int(&a("timeout_ms"), 0, MAX_WAIT_MS as i64, DEFAULT_WAIT_MS as i64) as u64;
            out["wait"] = env.wait_for_transfers(&task_ids, timeout).await;
        }
        Ok(out)
    }

    fn safe_download_name(raw: &str, fid: &str) -> String {
        let leaf = raw.replace(['/', '\\', '\0'], "_").trim().to_string();
        if leaf.is_empty() || leaf == "." || leaf == ".." {
            format!("file-{fid}")
        } else {
            leaf
        }
    }

    fn resolve_work_dir(env: &ToolEnv, explicit: Option<&str>) -> Result<std::path::PathBuf, AgentToolError> {
        let roots = env.local_roots();
        if let Some(dir) = explicit {
            return crate::policy::assert_local_path(dir, &roots, true, "local_dir");
        }
        // 优先下载目录设置；必须通过严格本地范围校验（qck 曾因只比前缀被符号链接绕过）
        let setting = env.deps.download_dir();
        if !setting.is_empty() {
            if let Ok(real) = crate::policy::assert_local_path(&setting, &roots, true, "下载目录") {
                return Ok(real);
            }
        }
        // 所有分支均须经过 assert_local_path 校验，防止配置中的符号链接或含 .. 的根绕过。
        for root in &env.scope.local_write_roots {
            if let Some(s) = root.to_str() {
                if let Ok(real) = crate::policy::assert_local_path(s, &roots, true, "工作目录") {
                    return Ok(real);
                }
            }
        }
        Err(AgentToolError::new(AgentError::OutOfScope, "尚未授权任何可写的本地目录")
            .with_hint("请在客户端「设置 → Agent 接入」添加可写目录"))
    }

    fn sanitize_upload_name(name: &str) -> Result<(), AgentToolError> {
        let bad = name.contains('/') || name.contains('\\') || name == "." || name == "..";
        if bad {
            return Err(AgentToolError::new(
                AgentError::InvalidArg,
                "name 只能是文件名，不能包含路径分隔符或为 . / ..",
            ));
        }
        Ok(())
    }

    async fn tool_upload_file(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_writable("上传文件")?;
        let local_path = require_string(&a("local_path"), "local_path", true)?;
        let real = crate::policy::assert_local_path(&local_path, &env.local_roots(), false, "local_path")?;
        let meta = std::fs::metadata(&real)
            .map_err(|_| AgentToolError::new(AgentError::NotFound, format!("本地文件不存在：{}", real.display())))?;
        if !meta.is_file() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "local_path 必须是文件"));
        }
        let target = optional_string(&a("pdir_fid"), "pdir_fid")?.unwrap_or(Self::first_remote_root(env)?);
        env.assert_remote_in_scope(&target).await?;
        let base_name = real.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let desired = match optional_string(&a("name"), "name")? {
            Some(n) => n,
            None => base_name.clone(),
        };
        Self::sanitize_upload_name(&desired)?;
        // 改名上传：先在工作目录 agent-out/<stamp>/ 下 staging 副本（0700/0600）
        let mut staged: Option<std::path::PathBuf> = None;
        let upload_path = if desired == base_name {
            real.clone()
        } else {
            let workdir = Self::resolve_work_dir(env, None)?;
            let stamp = format!(
                "{}-{}",
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
                &uuid::Uuid::new_v4().to_string()[..6]
            );
            let dir = workdir.join("agent-out").join(stamp);
            std::fs::create_dir_all(&dir)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法创建临时目录：{e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
            let dst = dir.join(&desired);
            crate::policy::assert_local_path(&dst.to_string_lossy(), &env.local_roots(), true, "staged")?;
            std::fs::copy(&real, &dst)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法创建上传副本：{e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o600));
            }
            staged = Some(dst.clone());
            dst
        };
        let conflict = env.find_name_conflict(&target, &desired, None).await;
        let accepted = env.transfer_call(
            "transfer.upload",
            &json!({ "localPaths": [upload_path.to_string_lossy()], "pdirFid": target }),
        ).await?;
        let task_ids: Vec<String> = accepted.as_array().map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        }).unwrap_or_default();
        let wait = a("wait").as_bool().unwrap_or(false);
        let mut out = json!({
            "task_ids": task_ids, "pdir_fid": target, "name": desired,
            "source_path": real.to_string_lossy(),
            "staged_path": staged.as_ref().map(|p| p.to_string_lossy().to_string()),
            "existing_name_conflict": conflict.get("conflict").cloned().unwrap_or(json!(false)),
            "conflict_detail": if conflict.get("conflict").and_then(|v| v.as_bool()).unwrap_or(false) {
                json!({"existing_fid": conflict.get("existing_fid").cloned(), "fully_scanned": conflict.get("fully_scanned").cloned()})
            } else {
                Value::Null
            },
            "note": "已入队。原文件不会被覆盖。",
        });
        if wait {
            let timeout = clamp_int(&a("timeout_ms"), 0, MAX_WAIT_MS as i64, DEFAULT_WAIT_MS as i64) as u64;
            let waited = env.wait_for_transfers(&task_ids, timeout).await;
            let tasks = waited.get("tasks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let all_done = !tasks.is_empty() && tasks.iter().all(|t| t.get("status").and_then(|v| v.as_str()) == Some("done"));
            if all_done {
                env.remember_uploaded(&target, &desired).await;
            }
            // staged 副本清理（对齐 qck）：全部任务到达**任意终态**（done/error/canceled）
            // 即清理，失败/取消也不能把文件内容副本留在用户授权目录；超时（timedOut，
            // 有 pending 项）时保留副本供排查/续传。
            let reached_terminal = !tasks.is_empty()
                && tasks.iter().all(|t| {
                    matches!(
                        t.get("status").and_then(|v| v.as_str()),
                        Some("done") | Some("error") | Some("canceled")
                    )
                });
            let mut cleaned = false;
            if reached_terminal {
                if let Some(st) = &staged {
                    if let Some(dir) = st.parent() {
                        let ok = dir.parent().and_then(|p| p.file_name()).map(|n| n == "agent-out").unwrap_or(false);
                        if ok {
                            cleaned = std::fs::remove_dir_all(dir).is_ok();
                        }
                    }
                }
                out["staged_path"] = Value::Null;
            }
            out["staged_cleaned"] = json!(cleaned);
            out["wait"] = waited;
        }
        Ok(out)
    }

    async fn tool_save_text_file(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_writable("保存文件")?;
        let name = require_string(&a("name"), "name", false)?;
        Self::sanitize_upload_name(&name)?;
        let text = a("text");
        let text = text
            .as_str()
            .ok_or_else(|| AgentToolError::new(AgentError::InvalidArg, "text 必须是字符串"))?;
        if text.len() > MAX_TEXT_BYTES {
            return Err(AgentToolError::new(
                AgentError::Limit,
                format!("文本超过 {} KiB 上限", MAX_TEXT_BYTES / 1024),
            ));
        }
        let target = optional_string(&a("pdir_fid"), "pdir_fid")?.unwrap_or(Self::first_remote_root(env)?);
        env.assert_remote_in_scope(&target).await?;
        let workdir = Self::resolve_work_dir(env, None)?;
        let stamp = format!(
            "{}-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
            &uuid::Uuid::new_v4().to_string()[..6]
        );
        let dir = workdir.join("agent-out").join(stamp);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法创建临时目录：{e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        // 文件名必须与网盘目标名完全一致（传输层以 basename 作为网盘文件名；用目录去重）
        let local_path = dir.join(&name);
        crate::policy::assert_local_path(&local_path.to_string_lossy(), &env.local_roots(), true, "local_path")?;
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&local_path)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法写入本地文件：{e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&local_path, std::fs::Permissions::from_mode(0o600));
            }
            f.write_all(text.as_bytes())
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法写入本地文件：{e}")))?;
        }
        let local_hash = crate::policy::sha256_hex(text);
        let conflict = env.find_name_conflict(&target, &name, None).await;
        let accepted = env.transfer_call(
            "transfer.upload",
            &json!({ "localPaths": [local_path.to_string_lossy()], "pdirFid": target }),
        ).await?;
        let task_ids: Vec<String> = accepted.as_array().map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        }).unwrap_or_default();
        let mut out = json!({
            "task_ids": task_ids, "pdir_fid": target, "name": name,
            "local_path": local_path.to_string_lossy(), "bytes": text.len(),
            "local_sha256": local_hash,
            "existing_name_conflict": conflict.get("conflict").cloned().unwrap_or(json!(false)),
            "note": "已入队。原文件不会被覆盖。",
        });
        let wait = a("wait").as_bool().unwrap_or(false);
        if !wait {
            return Ok(out);
        }
        let timeout = clamp_int(&a("timeout_ms"), 0, MAX_WAIT_MS as i64, DEFAULT_WAIT_MS as i64) as u64;
        let waited = env.wait_for_transfers(&task_ids, timeout).await;
        let tasks = waited.get("tasks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let all_done = !tasks.is_empty() && tasks.iter().all(|t| t.get("status").and_then(|v| v.as_str()) == Some("done"));
        if !all_done {
            out["wait"] = waited;
            return Ok(out);
        }
        env.remember_uploaded(&target, &name).await;
        // 上传全部完成后清理暂存目录，避免 agent-out 无限堆积敏感文本
        let _ = std::fs::remove_dir_all(&dir);
        out["staged_cleaned"] = json!(true);
        out["wait"] = waited;
        if a("verify").as_bool().unwrap_or(false) {
            out["verification"] = Self::verify_remote_visibility(env, &target, &name, &out["local_sha256"]).await;
        }
        Ok(out)
    }

    async fn verify_remote_visibility(env: &ToolEnv, target: &str, name: &str, local_sha: &Value) -> Value {
        match env.list_dir_page(target, 1, MAX_PAGE_SIZE, false).await {
            Ok(page) => {
                let list = page.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                if let Some(found) = list.iter().find(|x| x.get("name").and_then(|v| v.as_str()) == Some(name)) {
                    json!({
                        "status": "visible",
                        "fid": found.get("fid").cloned(),
                        "size": found.get("size").cloned(),
                        "local_sha256": local_sha,
                        "note": "已确认同名文件可见。大小为服务端元数据，如需证明内容一致，请下载回读后比较哈希。",
                    })
                } else {
                    json!({
                        "status": "unknown",
                        "note": "上传后在目标目录首页未找到同名文件，无法确认结果（可能在其他页）。",
                    })
                }
            }
            Err(e) => json!({
                "status": "unknown",
                "note": format!("回读校验失败：{}", e.message),
            }),
        }
    }

    async fn tool_transfer_control(&self, env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let task_id = require_string(&a("task_id"), "task_id", true)?;
        let action = require_string(&a("action"), "action", true)?;
        // 显式白名单：inputSchema 的 enum 不被执行（项目无 JSON Schema 校验器）；
        // 历史上 action:"clear" 会删掉用户已结束的传输记录（写操作绕过只读检查）。
        let allowed = ["pause", "resume", "retry", "cancel"];
        if !allowed.contains(&action.as_str()) {
            return Err(AgentToolError::new(
                AgentError::InvalidArg,
                format!("action 只能是 pause/resume/retry/cancel，收到 {action}"),
            ));
        }
        let tasks = env.transfer_call("transfer.list", &Value::Null).await?;
        let arr = tasks.as_array().cloned().unwrap_or_default();
        let before = arr
            .iter()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(task_id.as_str()))
            .cloned()
            .ok_or_else(|| AgentToolError::new(AgentError::NotFound, "未找到该传输任务"))?;
        // 四种动作全部要求写权限：cancel 会删临时文件、中断用户自己的上传。
        env.assert_writable("控制传输任务")?;
        let remote_ref = before
            .get("pdirFid")
            .or_else(|| before.get("pdir_fid"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| before.get("fid").and_then(|v| v.as_str()).filter(|s| !s.is_empty()));
        if let Some(rfid) = remote_ref {
            env.assert_remote_in_scope(rfid).await?;
        }
        env.transfer_call(&format!("transfer.{action}"), &json!({ "id": task_id })).await?;
        let after = env
            .transfer_call("transfer.list", &Value::Null).await
            .ok()
            .and_then(|v| {
                v.as_array().cloned().unwrap_or_default().into_iter()
                    .find(|t| t.get("id").and_then(|x| x.as_str()) == Some(task_id.as_str()))
            });
        Ok(json!({
            "task_id": task_id,
            "action": action,
            "status_before": before.get("status").cloned().unwrap_or(Value::Null),
            "task": after.as_ref().map(ToolEnv::serialize_task),
            "note": "状态变更可能异步生效，请用 list_transfers 复核。",
        }))
    }
}

// ---------------------------------------------------------------------------
// 计划工具与删除工具（批量改动 / 删除）
// ---------------------------------------------------------------------------

fn group_of(file: &Value, by: &str, groups: &std::collections::HashMap<String, Vec<String>>) -> String {
    #[allow(unused_variables)]
    let default_groups: [(&str, &[&str]); 7] = [
        ("图片", &["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "svg", "raw"]),
        ("视频", &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "ts", "m4v", "mpg", "mpeg", "rmvb"]),
        ("音频", &["mp3", "flac", "wav", "aac", "m4a", "ogg", "wma", "ape", "opus"]),
        ("文档", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "ods", "odp", "json", "xml", "yml", "yaml"]),
        ("压缩包", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"]),
        ("程序", &["exe", "dmg", "pkg", "apk", "deb", "rpm", "msi", "appimage", "iso"]),
        ("其他", &[]),
    ];
    match by {
        "category" => {
            let cat = file.get("category").and_then(|v| v.as_i64()).unwrap_or(0);
            match cat {
                1 => "视频".into(),
                2 => "图片".into(),
                3 => "文档".into(),
                4 => "音频".into(),
                5 => "压缩包".into(),
                6 => "程序".into(),
                _ => "其他".into(),
            }
        }
        "modified_month" => {
            let updated = file.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
            if updated <= 0 {
                "未知时间".into()
            } else {
                let secs = updated / 1000;
                let dt = time_from_unix(secs);
                format!("{:04}-{:02}", dt.0, dt.1)
            }
        }
        _ => {
            let ext = file.get("ext").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if !ext.is_empty() {
                if let Some(list) = groups.get("__custom")
                    .or_else(|| None)
                {
                    let _ = list;
                }
                for (name, list) in &default_groups_owned(groups) {
                    if list.iter().any(|e| e == &ext) {
                        return name.clone();
                    }
                }
            }
            "其他".into()
        }
    }
}

/// 默认分组 + 用户覆盖（custom 同名覆盖内置）。
fn default_groups_owned(custom: &std::collections::HashMap<String, Vec<String>>) -> Vec<(String, Vec<String>)> {
    let mut map: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    let defaults: [(&str, &[&str]); 6] = [
        ("图片", &["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "svg", "raw"]),
        ("视频", &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "ts", "m4v", "mpg", "mpeg", "rmvb"]),
        ("音频", &["mp3", "flac", "wav", "aac", "m4a", "ogg", "wma", "ape", "opus"]),
        ("文档", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "ods", "odp", "json", "xml", "yml", "yaml"]),
        ("压缩包", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"]),
        ("程序", &["exe", "dmg", "pkg", "apk", "deb", "rpm", "msi", "appimage", "iso"]),
    ];
    for (name, list) in defaults {
        map.insert(name.to_string(), list.iter().map(|s| s.to_string()).collect());
    }
    for (name, list) in custom {
        map.insert(name.clone(), list.clone());
    }
    map.into_iter().collect()
}

/// Unix 秒 → (年, 月)（UTC；仅用于分组命名）。
fn time_from_unix(secs: i64) -> (i64, i64) {
    // 简化公历换算（1970-2100 范围足够）
    let days = secs.div_euclid(86_400);
    let mut year = 1970i64;
    let mut remaining = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let days_in_year = if leap { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for m in month_days {
        if remaining < m {
            break;
        }
        remaining -= m;
        month += 1;
    }
    (year, month)
}

fn parse_ext_groups(v: &Value) -> std::collections::HashMap<String, Vec<String>> {
    let mut out = std::collections::HashMap::new();
    if let Some(obj) = v.as_object() {
        for (name, list) in obj {
            if name.is_empty() || name.chars().count() > 40 {
                continue;
            }
            let ok_name = name.chars().all(|c| c.is_alphanumeric() || " .-_".contains(c) || ('\u{4e00}'..='\u{9fa5}').contains(&c));
            if !ok_name {
                continue;
            }
            if let Some(arr) = list.as_array() {
                let exts: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|x| x.trim_start_matches('.').to_lowercase())
                    .filter(|x| !x.is_empty())
                    .collect();
                if !exts.is_empty() {
                    out.insert(name.clone(), exts);
                }
            }
        }
    }
    out
}

impl QuarkTools {
    async fn tool_plan_create(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        let root_fid = optional_string(&a("root_fid"), "root_fid")?.unwrap_or(Self::first_remote_root(env)?);
        let by = optional_string(&a("by"), "by")?.unwrap_or_else(|| "ext".into());
        if !["ext", "category", "modified_month"].contains(&by.as_str()) {
            return Err(AgentToolError::new(AgentError::InvalidArg, "by 只能是 ext / category / modified_month"));
        }
        let target_parent = optional_string(&a("target_parent_fid"), "target_parent_fid")?
            .unwrap_or_else(|| root_fid.clone());
        let max_depth = clamp_int(&a("max_depth"), 1, MAX_TREE_DEPTH, 1);
        let max_entries = clamp_int(&a("max_entries"), 1, MAX_TREE_ENTRIES as i64, 500) as usize;
        let include_subdirs = a("include_subdirs").as_bool().unwrap_or(false);
        let groups = parse_ext_groups(&a("ext_groups"));
        env.assert_remote_in_scope(&root_fid).await?;
        env.assert_remote_in_scope(&target_parent).await?;

        // BFS 扫描源目录（只收文件，带 fromFid=所在目录）
        let mut files: Vec<Value> = Vec::new();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut queue: std::collections::VecDeque<(String, i64)> = std::collections::VecDeque::new();
        queue.push_back((root_fid.clone(), 0));
        visited.insert(root_fid.clone());
        let mut truncated = false;
        let max_dir_scan = max_entries;
        let mut scanned_dirs = 0usize;
        'outer: while let Some((fid, depth)) = queue.pop_front() {
            if scanned_dirs >= max_dir_scan {
                truncated = true;
                break;
            }
            scanned_dirs += 1;
            let mut page = 1i64;
            loop {
                let res = env.list_dir_page(&fid, page, MAX_PAGE_SIZE, true).await?;
                let list = res.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for item in &list {
                    let is_dir = item.get("dir").and_then(|v| v.as_bool()).unwrap_or(false);
                    if is_dir {
                        if include_subdirs && depth + 1 < max_depth {
                            let child = item.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if !child.is_empty() && visited.insert(child.clone()) {
                                queue.push_back((child, depth + 1));
                            }
                        }
                    } else {
                        let mut f = item.clone();
                        f["fromFid"] = json!(fid);
                        files.push(f);
                        if files.len() >= max_entries {
                            truncated = true;
                            break 'outer;
                        }
                    }
                }
                let has_more = res.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false);
                if !has_more || page >= 500 {
                    break;
                }
                page += 1;
            }
        }

        // 目标父目录下已有子目录（name→fid；翻页上限 50 页）
        let mut existing_dirs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut parent_incomplete = false;
        let mut page = 1i64;
        loop {
            let res = env.list_dir_page(&target_parent, page, MAX_PAGE_SIZE, true).await?;
            let list = res.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            for item in &list {
                if item.get("dir").and_then(|v| v.as_bool()).unwrap_or(false) {
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let f = item.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if !name.is_empty() && !f.is_empty() {
                        existing_dirs.insert(name, f);
                    }
                }
            }
            let has_more = res.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false);
            if !has_more {
                break;
            }
            if page >= 50 {
                parent_incomplete = true;
                break;
            }
            page += 1;
        }

        // 生成条目
        let mut entries: Vec<Value> = Vec::new();
        let mut new_dirs: Vec<String> = Vec::new();
        let mut conflict_checked: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for f in &files {
            let group = group_of(f, &by, &groups);
            if group.is_empty() {
                entries.push(json!({
                    "fid": f.get("fid").cloned(), "name": f.get("name").cloned(),
                    "fromFid": f.get("fromFid").cloned(), "action": "move",
                    "skip": true, "skipReason": "未匹配到任何分组规则",
                }));
                continue;
            }
            let from_fid = f.get("fromFid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let to_fid = existing_dirs.get(&group).cloned().unwrap_or_default();
            if !to_fid.is_empty() && from_fid == to_fid {
                entries.push(json!({
                    "fid": f.get("fid").cloned(), "name": f.get("name").cloned(),
                    "fromFid": f.get("fromFid").cloned(), "action": "move",
                    "skip": true, "skipReason": format!("已位于「{group}」中"),
                }));
                continue;
            }
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mut conflict = false;
            let mut conflict_with: Value = Value::Null;
            if !to_fid.is_empty() {
                let c = conflict_checked
                    .entry(to_fid.clone())
                    .or_insert(Value::Null);
                if c.is_null() {
                    *c = json!({});
                }
                let c2 = env.find_name_conflict(&to_fid, name, None).await;
                conflict = c2.get("conflict").and_then(|v| v.as_bool()).unwrap_or(false);
                conflict_with = c2.get("existing_fid").cloned().unwrap_or(Value::Null);
            }
            if to_fid.is_empty() && !new_dirs.contains(&group) {
                new_dirs.push(group.clone());
            }
            entries.push(json!({
                "fid": f.get("fid").cloned(), "name": f.get("name").cloned(),
                "fromFid": f.get("fromFid").cloned(), "action": "move",
                "toFid": to_fid, "toDirName": group,
                "reason": match by.as_str() {
                    "category" => format!("按分类归入「{group}」"),
                    "modified_month" => format!("按修改月份归入「{group}」"),
                    _ => format!("按扩展名归入「{group}」"),
                },
                "conflict": conflict,
                "conflictWith": if conflict { conflict_with } else { Value::Null },
            }));
        }

        let rules = json!({
            "by": by,
            "target_parent_fid": target_parent,
            "include_subdirs": include_subdirs,
            "max_depth": max_depth,
            "groups": if by == "ext" { groups.keys().cloned().collect::<Vec<_>>() } else { vec![] },
        });
        let notes = if truncated { format!("扫描达到条目上限 {max_entries}，计划不完整") } else { String::new() };
        let plan = self.plans.create("organize", &root_fid, &rules, &entries, &notes)?;
        let entry_preview: Vec<Value> = entries
            .iter()
            .map(|e| {
                json!({
                    "fid": e.get("fid").cloned().unwrap_or(Value::Null),
                    "name": e.get("name").cloned().unwrap_or(Value::Null),
                    "from_fid": e.get("fromFid").cloned().unwrap_or(Value::Null),
                    "to_dir": e.get("toDirName").cloned().unwrap_or(Value::Null),
                    "to_fid": e.get("toFid").cloned().unwrap_or(Value::Null),
                    "action": e.get("action").cloned().unwrap_or(Value::Null),
                    "conflict": e.get("conflict").cloned().unwrap_or(json!(false)),
                    "skip": e.get("skip").cloned().unwrap_or(json!(false)),
                    "reason": e.get("reason").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        Ok(json!({
            "plan": plan,
            "scan": {
                "root_fid": root_fid,
                "target_parent_fid": target_parent,
                "files_found": files.len(),
                "truncated": truncated,
                "target_parent_scan_complete": !parent_incomplete,
                "new_dirs": new_dirs,
            },
            "entries": entry_preview,
            "next_step": "把 plan_id/revision/content_hash 交给用户确认后，再调用 plan_execute 执行；计划内容变化会导致授权失效。",
        }))
    }

    async fn tool_plan_execute(&self, env: &ToolEnv, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_writable("执行计划")?;
        let plan_id = require_string(&a("plan_id"), "plan_id", true)?;
        let revision_raw = a("revision");
        let revision = revision_raw.as_u64();
        let content_hash = optional_string(&a("content_hash"), "content_hash")?;
        let plan = self
            .plans
            .claim_executable(&plan_id, revision, content_hash.as_deref())?;
        struct PlanGuard {
            plans: StdArc<PlanStore>,
            plan_id: String,
            completed: bool,
        }
        impl Drop for PlanGuard {
            fn drop(&mut self) {
                if !self.completed {
                    self.plans.abort_executing(&self.plan_id);
                }
            }
        }
        let mut plan_guard = PlanGuard {
            plans: self.plans.clone(),
            plan_id: plan_id.clone(),
            completed: false,
        };
        let stop_on_error = a("stop_on_error").as_bool().unwrap_or(false);
        let new_dir_parent = plan
            .rules
            .get("target_parent_fid")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&plan.root_fid)
            .to_string();
        let mut new_dir_parent_verified = false;
        let mut created_dirs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut results: Vec<Value> = Vec::new();
        let mut counters = json!({"success":0,"accepted":0,"failed":0,"skipped":0,"unknown":0,"total": plan.entries.len()});
        let mut stopped = false;

        for entry in &plan.entries {
            if stopped {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "skipped", "reason": "因前面的失败而停止"}));
                counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            if entry.skip {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "skipped", "reason": if entry.skip_reason.is_empty() { "规则判定跳过".to_string() } else { entry.skip_reason.clone() }}));
                counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            // 执行前重新核对当前归属（不是计划生成时的 fromFid：条目可能已被移出授权范围）
            let info = match env.safe_info(&entry.fid).await {
                Ok(v) => v,
                Err(e) => {
                    results.push(json!({"index": entry.index, "fid": entry.fid, "status": "unknown", "reason": format!("无法确认条目当前位置：{}", e.message)}));
                    counters["unknown"] = json!(counters["unknown"].as_i64().unwrap_or(0) + 1);
                    continue;
                }
            };
            let current_parent = info
                .get("pdirFid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(ROOT_FID)
                .to_string();
            if env.assert_remote_in_scope(&current_parent).await.is_err() {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "skipped", "reason": "条目已不在授权范围内"}));
                counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            let current_name = info.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if current_name != entry.name {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "unknown", "reason": format!("文件名称已变化（计划中为 {}，当前为 {}）", entry.name, current_name)}));
                counters["unknown"] = json!(counters["unknown"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            // 目标 fid：entry.toFid → createdDirs → 定位/创建目录
            let mut to_fid = entry.to_fid.clone();
            if to_fid.is_empty() && !entry.to_dir_name.is_empty() {
                if let Some(f) = created_dirs.get(&entry.to_dir_name) {
                    to_fid = f.clone();
                } else if let Some(found) = env.locate_child_dir(&new_dir_parent, &entry.to_dir_name, 3).await {
                    if let Some(f) = found.get("fid").and_then(|v| v.as_str()) {
                        to_fid = f.to_string();
                        created_dirs.insert(entry.to_dir_name.clone(), to_fid.clone());
                    }
                } else {
                    if !new_dir_parent_verified {
                        if let Err(e) = env.assert_remote_in_scope(&new_dir_parent).await {
                            results.push(json!({"index": entry.index, "fid": entry.fid, "status": "skipped", "reason": format!("目标父目录不在授权范围内：{}", e.message)}));
                            counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
                            continue;
                        }
                        new_dir_parent_verified = true;
                    }
                    let accepted = env.deps.core_call(env.generation,
                        "fs.mkdir",
                        &json!({ "pdirFid": new_dir_parent, "name": entry.to_dir_name }),
                    ).await;
                    if let Err(e) = accepted {
                        results.push(json!({"index": entry.index, "fid": entry.fid, "status": "failed", "reason": format!("创建目录失败：{}", e.message)}));
                        counters["failed"] = json!(counters["failed"].as_i64().unwrap_or(0) + 1);
                        if stop_on_error {
                            stopped = true;
                        }
                        continue;
                    }
                    match env.locate_child_dir(&new_dir_parent, &entry.to_dir_name, 6).await {
                        Some(found) => {
                            if let Some(f) = found.get("fid").and_then(|v| v.as_str()) {
                                to_fid = f.to_string();
                                created_dirs.insert(entry.to_dir_name.clone(), to_fid.clone());
                            }
                        }
                        None => {
                            results.push(json!({
                                "index": entry.index, "fid": entry.fid, "status": "unknown",
                                "reason": format!("创建目录「{}」后未能确认其 fid；服务端列表可能仍有延迟，请稍后重新生成计划再执行", entry.to_dir_name),
                            }));
                            counters["unknown"] = json!(counters["unknown"].as_i64().unwrap_or(0) + 1);
                            if stop_on_error {
                                stopped = true;
                            }
                            continue;
                        }
                    }
                }
            }
            if to_fid.is_empty() {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "failed", "reason": "无法确定目标目录 fid"}));
                counters["failed"] = json!(counters["failed"].as_i64().unwrap_or(0) + 1);
                if stop_on_error {
                    stopped = true;
                }
                continue;
            }
            if env.assert_remote_in_scope(&to_fid).await.is_err() {
                results.push(json!({"index": entry.index, "fid": entry.fid, "status": "skipped", "reason": "目标目录不在授权范围内"}));
                counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
                continue;
            }
            match env
                .deps
                .core_call(env.generation, "fs.move", &json!({"fids":[entry.fid.clone()], "toFid": to_fid})).await
            {
                Ok(accepted) => {
                    results.push(json!({
                        "index": entry.index, "fid": entry.fid, "status": "accepted",
                        "to_fid": to_fid,
                        "task_id": accepted.get("taskId").cloned().unwrap_or(Value::Null),
                        "note": "服务端已受理；如需确认请用 file_info 核对新的父目录。",
                    }));
                    counters["accepted"] = json!(counters["accepted"].as_i64().unwrap_or(0) + 1);
                }
                Err(e) => {
                    let (status, bucket) = match e.code {
                        AgentError::OutOfScope => ("skipped", "skipped"),
                        _ => ("failed", "failed"),
                    };
                    let code_out = e
                        .raw_code
                        .clone()
                        .unwrap_or_else(|| e.code.as_str().to_string());
                    results.push(json!({"index": entry.index, "fid": entry.fid, "status": status, "reason": e.message, "code": code_out}));
                    counters[bucket] = json!(counters[bucket].as_i64().unwrap_or(0) + 1);
                    if stop_on_error {
                        stopped = true;
                    }
                }
            }
        }

        // 循环外异常兜底在 Rust 中由 per-entry Result 处理；此处保证 summary 与 results 行数一致。
        let processed = results.len();
        if processed < plan.entries.len() {
            for i in processed..plan.entries.len() {
                results.push(json!({"index": i, "fid": "", "status": "skipped", "reason": "执行因异常中断，该条目未被处理"}));
                counters["skipped"] = json!(counters["skipped"].as_i64().unwrap_or(0) + 1);
            }
        }
        let partial = counters["failed"].as_i64().unwrap_or(0) > 0 || counters["unknown"].as_i64().unwrap_or(0) > 0;
        let snapshot = self.plans.mark_executed(&plan_id, &json!(results), &counters)?;
        plan_guard.completed = true;
        Ok(json!({
            "plan_id": plan_id,
            "revision": plan.revision,
            "content_hash": plan.hash,
            "summary": counters,
            "results": results,
            "partial": partial,
            "note": if partial {
                "请按 index 逐条核对，不要整体重试（已受理的条目不需要重新提交）。"
            } else {
                "全部条目已被服务端受理或跳过。"
            },
            "plan": snapshot,
        }))
    }

    async fn tool_delete_entries(&self, env: &ToolEnv, _args: &Value, a: &(dyn Fn(&str) -> Value + Sync)) -> Result<Value, AgentToolError> {
        env.assert_deletable()?;
        let fids: Vec<String> = a("fids")
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if fids.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "fids 不能为空"));
        }
        if fids.len() > 50 {
            return Err(AgentToolError::new(AgentError::Limit, "单次最多删除 50 个条目"));
        }
        env.assert_many_remote_in_scope(&fids).await?;
        // 当前真实状态（名称用于确认；fail-closed）
        let mut current: Vec<(String, String, bool)> = Vec::new();
        for fid in &fids {
            let info = env.safe_info(fid).await?;
            current.push((
                fid.clone(),
                info.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                info.get("dir").and_then(|v| v.as_bool()).unwrap_or(false),
            ));
        }
        let dry_run = a("dry_run").as_bool().unwrap_or(true);
        let planned: Vec<Value> = current
            .iter()
            .map(|(fid, name, dir)| json!({"fid": fid, "name": name, "dir": dir}))
            .collect();
        if dry_run {
            return Ok(json!({
                "dry_run": true,
                "entries": planned,
                "note": "确认目标后请传 dry_run:false 并让 confirm_names 与本列表名称逐一对应；删除会进入网盘回收站（可恢复）。",
            }));
        }
        // 目标确认：confirm_names 必须与当前名称集合完全一致（防止 fid 混淆/过期）
        let confirm: Vec<String> = a("confirm_names")
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let mut expect: Vec<String> = current.iter().map(|(_, n, _)| n.clone()).collect();
        let mut given = confirm.clone();
        expect.sort();
        given.sort();
        if expect != given {
            return Err(AgentToolError::new(
                AgentError::Conflict,
                "confirm_names 与当前目标不一致，未执行删除",
            )
            .with_hint("请先 dry_run 获取最新名称，再把名称逐一确认后重试"));
        }
        let accepted = env.deps.core_call(env.generation, "fs.remove", &json!({ "fids": fids })).await?;
        let task_id = accepted.get("taskId").cloned();
        // 核对对象本身即可确认删除。不要先等待可能长期未知的服务端任务状态，
        // 否则已完成删除也会无意义地阻塞一分钟；task_id 仍保留供排查。
        // 逐项核对是否真的已不可见（NOT_FOUND=已删除；超时仍可见=不确定）。
        // 删除是写操作：核对必须新鲜读取（清掉本次调用内的旧缓存）。
        // 批量轮询：每轮同时查所有未确认 fid，最多 15 轮 × 2s（最坏 30s）——
        // 50 个 fid 若逐个串行最坏 25 分钟，会超出 MCP 适配器 15 分钟超时。
        env.info_cache.lock().unwrap().clear();
        env.list_cache.lock().unwrap().clear();
        let mut pending: Vec<(String, String)> =
            current.iter().map(|(f, n, _)| (f.clone(), n.clone())).collect();
        let mut results: Vec<Value> = Vec::new();
        for _round in 0..15u32 {
            let mut next: Vec<(String, String)> = Vec::new();
            for (fid, name) in &pending {
                // 每次查询都绕过 info 缓存与 recent 兜底（删除后的 NOT_FOUND 不能被重试吞掉）
                match env
                    .deps
                    .core_call(env.generation, "fs.info", &json!({ "fid": fid }))
                    .await
                {
                    Err(e) if is_not_found(&e) => {
                        results.push(json!({"fid": fid, "name": name, "status": "deleted"}));
                    }
                    Err(_) => {
                        // 网络等其他错误：如实 uncertain，不再重试该项
                        results.push(json!({"fid": fid, "name": name, "status": "uncertain"}));
                    }
                    Ok(_) => next.push((fid.clone(), name.clone())),
                }
            }
            pending = next;
            if pending.is_empty() {
                break;
            }
            if _round + 1 < 15 {
                tokio::time::sleep(Duration::from_millis(2000)).await;
            }
        }
        for (fid, name) in &pending {
            results.push(json!({"fid": fid, "name": name, "status": "uncertain"}));
        }
        let all_confirmed=results.iter().all(|r|r["status"]=="deleted");
        Ok(json!({
            "deleted_to_recycle": all_confirmed,
            "accepted": true,
            "task_id": task_id,
            "results": results,
            "note": if all_confirmed {"全部目标已确认删除至回收站（可恢复）。"} else {"删除请求已受理；仅 status=deleted 的目标已确认删除。status=uncertain 的目标请稍后用 list_dir 复核，不能认定已删除。"},
        }))
    }
}

// ---------------------------------------------------------------------------
// 文本读取（严格 UTF-8、NUL 检测、截断边界回退、BOM 去除、哈希）
// ---------------------------------------------------------------------------

/// 判断错误是否为"对象不存在"（仅上游 NOT_FOUND / 本地 NotFound；绝不把 400 INVALID_ARG 当作已删除）。
fn is_not_found(e: &AgentToolError) -> bool {
    e.code == AgentError::NotFound
        || e.raw_code.as_deref() == Some("NOT_FOUND")
        || e.upstream_code
            .as_ref()
            .and_then(|v| v.as_str())
            .map(|c| c == "NOT_FOUND")
            .unwrap_or(false)
}

/// 读取文本文件（对应 qck readTextAt）：
/// - ENOENT → NOT_FOUND；非普通文件 → INVALID_ARG；
/// - 只读 wantBytes 字节（不把大文件读进内存）；
/// - 含 NUL → LIMIT（看起来是二进制，不猜编码）；
/// - 严格 UTF-8 解码，截断切在多字节字符中间时最多回退 3 字节；
/// - 去掉开头 BOM（U+FEFF），bytes 仍如实包含 BOM 字节。
pub fn read_text_at(path: &std::path::Path, max_bytes: usize) -> Result<Value, AgentToolError> {
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AgentToolError::new(AgentError::NotFound, format!("本地文件不存在：{}", path.display()))
        } else {
            AgentToolError::new(AgentError::Internal, format!("无法读取文件元数据：{e}"))
        }
    })?;
    if !meta.is_file() {
        return Err(AgentToolError::new(AgentError::InvalidArg, "只能读取普通文件"));
    }
    let total = meta.len();
    let want = (total as usize).min(max_bytes);
    use std::io::Read;
    let mut buf = vec![0u8; want];
    let mut used = 0usize;
    {
        let mut f = std::fs::File::open(path)
            .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法打开文件：{e}")))?;
        while used < want {
            match f.read(&mut buf[used..]) {
                Ok(0) => break,
                Ok(n) => used += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(AgentToolError::new(AgentError::Internal, format!("读取文件失败：{e}"))),
            }
        }
    }
    buf.truncate(used);
    if buf.contains(&0) {
        return Err(AgentToolError::new(AgentError::Limit, "文件看起来是二进制（包含 NUL 字节），不能用文本工具读取"));
    }
    let truncated = (used as u64) < total;
    let mut end = buf.len();
    let mut text = match std::str::from_utf8(&buf[..end]) {
        Ok(t) => t.to_string(),
        Err(e) => {
            // 只在"截断所致"时回退最多 3 字节到最后一个完整字符边界；否则拒绝
            if truncated && e.valid_up_to() > 0 && end.saturating_sub(e.valid_up_to()) <= 3 {
                end = e.valid_up_to();
                std::str::from_utf8(&buf[..end])
                    .map_err(|_| AgentToolError::new(AgentError::Limit, "文件不是有效的 UTF-8 文本"))?
                    .to_string()
            } else {
                return Err(AgentToolError::new(AgentError::Limit, "文件不是有效的 UTF-8 文本"));
            }
        }
    };
    if text.starts_with('\u{feff}') {
        text = text.trim_start_matches('\u{feff}').to_string();
    }
    let hash = crate::policy::sha256_hex_bytes(&buf[..end]);
    Ok(json!({
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        "text": text,
        "bytes": end,
        "total_bytes": total,
        "truncated": truncated || end < want,
        "encoding": "utf-8",
        "sha256": hash,
        "sha256_of": if truncated { "read_prefix" } else { "whole_file" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_helpers_behave() {
        assert!(require_string(&json!("  "), "label", true).is_err());
        assert_eq!(require_string(&json!(" x "), "label", true).unwrap(), "x");
        assert_eq!(require_string(&json!(" x "), "label", false).unwrap(), " x ");
        assert!(require_string(&json!(5), "label", true).is_err());
        assert_eq!(optional_string(&Value::Null, "l").unwrap(), None);
        assert_eq!(optional_string(&json!("  "), "l").unwrap(), None);
        assert!(optional_string(&json!(3), "l").is_err());
        assert_eq!(clamp_int(&json!(5.9), 1, 10, 3), 5);
        assert_eq!(clamp_int(&json!("abc"), 1, 10, 3), 3);
        assert_eq!(clamp_int(&Value::Null, 1, 10, 3), 3);
        assert_eq!(clamp_int(&json!(99), 1, 10, 3), 10);
    }

    #[test]
    fn recent_objects_ttl_and_capacity() {
        let shared = ToolShared::new();
        for i in 0..(RECENT_MAX + 10) {
            shared.remember(&format!("f{i}"), "p", "n", false);
        }
        assert!(shared.recall("f0").is_none(), "最旧的应被淘汰");
        assert!(shared.recall(&format!("f{}", RECENT_MAX + 9)).is_some());
        // 记录的 parent/name 可回读
        shared.remember("recent-x", "parent-1", "n.txt", false);
        let rec = shared.recall("recent-x").unwrap();
        assert_eq!(rec.parent_fid, "parent-1");
        assert_eq!(rec.name, "n.txt");
    }

    #[test]
    fn read_text_at_handles_encoding_and_truncation() {
        let dir = std::env::temp_dir().join(format!("qk-rt-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        // 正常 UTF-8
        let p1 = dir.join("ok.txt");
        std::fs::write(&p1, "你好 world").unwrap();
        let r = read_text_at(&p1, 256 * 1024).unwrap();
        assert_eq!(r["text"], json!("你好 world"));
        assert_eq!(r["truncated"], json!(false));
        assert_eq!(r["encoding"], json!("utf-8"));
        // BOM 去除但 bytes 如实
        let p2 = dir.join("bom.txt");
        std::fs::write(&p2, "\u{feff}abc".as_bytes()).unwrap();
        let r2 = read_text_at(&p2, 1024).unwrap();
        assert_eq!(r2["text"], json!("abc"));
        // NUL → LIMIT（二进制不猜编码）
        let p3 = dir.join("bin.txt");
        std::fs::write(&p3, [0x61, 0x00, 0x62]).unwrap();
        assert_eq!(read_text_at(&p3, 1024).unwrap_err().code, AgentError::Limit);
        // 截断切在多字节中间 → 回退到字符边界
        let p4 = dir.join("cut.txt");
        std::fs::write(&p4, "你好你好".as_bytes()).unwrap();
        let r4 = read_text_at(&p4, 5).unwrap(); // "你"(3B)+"你"前2B → 回退到 3 字节
        assert_eq!(r4["truncated"], json!(true));
        assert_eq!(r4["text"], json!("你"));
        // 非 UTF-8（无效序列，非截断所致）→ LIMIT
        let p5 = dir.join("bad.txt");
        std::fs::write(&p5, [0xFF, 0xFE, 0xFD]).unwrap();
        assert_eq!(read_text_at(&p5, 1024).unwrap_err().code, AgentError::Limit);
        // 不存在的文件 → NOT_FOUND
        assert_eq!(
            read_text_at(&dir.join("nope.txt"), 100).unwrap_err().code,
            AgentError::NotFound
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_matches_delegates() {
        assert!(scope_matches("a", &[], &["a".into()]));
        assert!(!scope_matches("b", &["c".into()], &["a".into()]));
    }
}

#[cfg(test)]
mod fake_tests {
    use super::*;
    use crate::config::ScopeSnapshot;
    use crate::registry::ToolContext;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// 内存假网盘（只实现工具层用到的 fs/transfer 方法）。
    #[derive(Default)]
    struct FakeDrive {
        nodes: Mutex<HashMap<String, Value>>, // fid -> {fid,name,dir,size,pdirFid,updatedAt,category,ext}
        removed: Mutex<Vec<String>>,
        uploads: Mutex<Vec<Value>>,
        downloads: Mutex<Vec<Value>>,
        download_dir: Mutex<String>,
        transfers: Mutex<Vec<Value>>,
        fail_removed_lookup: std::sync::atomic::AtomicBool,
        transfer_list_error: Mutex<Option<(String, String)>>,
    }

    impl FakeDrive {
        fn with_root() -> Self {
            let d = FakeDrive::default();
            {
                let mut nodes = d.nodes.lock().unwrap();
                nodes.insert(
                    "root".into(),
                    json!({"fid":"root","name":"授权根","dir":true,"size":0,"pdirFid":"0","updatedAt":0,"category":0,"ext":""}),
                );
            }
            d
        }
        fn add(&self, fid: &str, name: &str, dir: bool, pdir: &str, size: i64) {
            self.nodes.lock().unwrap().insert(
                fid.into(),
                json!({"fid":fid,"name":name,"dir":dir,"size":size,"pdirFid":pdir,"updatedAt":1700000000000i64,"category":0,"ext": if dir {""} else {name.rsplit('.').next().unwrap_or("")}}),
            );
        }
        fn mkdir(&self, fid: &str, name: &str, parent: &str) {
            self.add(fid, name, true, parent, 0);
        }
        fn rename(&self, fid: &str, name: &str) {
            if let Some(n) = self.nodes.lock().unwrap().get_mut(fid) {
                n["name"] = json!(name);
            }
        }
        fn move_node(&self, fid: &str, parent: &str) {
            if let Some(n) = self.nodes.lock().unwrap().get_mut(fid) {
                n["pdirFid"] = json!(parent);
            }
        }
        fn remove_nodes(&self, fids: &[String]) {
            let mut nodes = self.nodes.lock().unwrap();
            let mut removed = self.removed.lock().unwrap();
            for f in fids {
                // 目录连同子项一起删除（与网盘语义一致）
                let mut to_remove = vec![f.clone()];
                loop {
                    let mut extra: Vec<String> = Vec::new();
                    for (k, v) in nodes.iter() {
                        if to_remove.contains(&v["pdirFid"].as_str().unwrap_or("").to_string()) {
                            extra.push(k.clone());
                        }
                    }
                    let before = to_remove.len();
                    for e in extra {
                        if !to_remove.contains(&e) {
                            to_remove.push(e);
                        }
                    }
                    if to_remove.len() == before {
                        break;
                    }
                }
                for k in to_remove {
                    nodes.remove(&k);
                    removed.push(k);
                }
            }
        }
    }

    impl HostDeps for FakeDrive {
        fn core_call<'a>(
            &'a self,
            _generation: u64,
            method: &'a str,
            params: &'a Value,
        ) -> DepsFuture<'a, Result<Value, AgentToolError>> {
            Box::pin(async move {
                let p = params.clone();
                match method {
                    "fs.info" => {
                        let fid = p["fid"].as_str().unwrap_or("");
                        match self.nodes.lock().unwrap().get(fid) {
                            Some(n) => Ok(n.clone()),
                            None if self.fail_removed_lookup.load(std::sync::atomic::Ordering::Relaxed) => Err(AgentToolError::from_upstream("NETWORK","暂时无法核对",None)),
                            None => Err(AgentToolError::from_upstream("NOT_FOUND", "未找到该文件", None)),
                        }
                    }
                    "fs.list" => {
                        let parent = p["pdirFid"].as_str().unwrap_or("");
                        let list: Vec<Value> = self
                            .nodes
                            .lock()
                            .unwrap()
                            .values()
                            .filter(|n| n["pdirFid"].as_str() == Some(parent))
                            .cloned()
                            .collect();
                        Ok(json!({"list": list, "total": list.len(), "page":1, "size":200, "hasMore": false}))
                    }
                    "fs.search" => {
                        let kw = p["keyword"].as_str().unwrap_or("").to_lowercase();
                        let list: Vec<Value> = self
                            .nodes
                            .lock()
                            .unwrap()
                            .values()
                            .filter(|n| n["name"].as_str().unwrap_or("").to_lowercase().contains(&kw))
                            .cloned()
                            .collect();
                        Ok(json!({"list": list, "total": list.len(), "page":1, "size":50, "hasMore": false}))
                    }
                    "fs.mkdir" => {
                        let name = p["name"].as_str().unwrap_or("");
                        let parent = p["pdirFid"].as_str().unwrap_or("0");
                        let fid = format!("dir-{name}");
                        self.mkdir(&fid, name, parent);
                        Ok(json!({"done": true}))
                    }
                    "fs.rename" => {
                        let fid = p["fid"].as_str().unwrap_or("");
                        let name = p["name"].as_str().unwrap_or("");
                        self.rename(fid, name);
                        Ok(json!({"done": true}))
                    }
                    "fs.move" => {
                        let to = p["toFid"].as_str().unwrap_or("");
                        if let Some(fids) = p["fids"].as_array() {
                            for f in fids {
                                self.move_node(f.as_str().unwrap_or(""), to);
                            }
                        }
                        Ok(json!({"done": false,"taskId":"async-move"}))
                    }
                    "fs.copy" => Ok(json!({"done": false,"taskId":"async-copy"})),
                    "fs.remove" => {
                        let fids: Vec<String> = p["fids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                        self.remove_nodes(&fids);
                        Ok(json!({"done": false,"taskId":"async-delete"}))
                    }
                    "fs.waitTask" => Ok(json!({"done": true})),
                    "auth.status" => Ok(json!({"loggedIn": true, "expired": false, "nickname": "测试", "memberLabel": ""})),
                    "auth.quota" => Ok(json!({"total": 100, "used": 10, "free": 90})),
                    _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("fake 未实现 {method}"))),
                }
            })
        }

        fn transfer_call<'a>(
            &'a self,
            method: &'a str,
            params: &'a Value,
        ) -> DepsFuture<'a, Result<Value, AgentToolError>> {
            Box::pin(async move {
                match method {
                    "transfer.list" => {
                        if let Some((code, msg)) = self.transfer_list_error.lock().unwrap().clone() {
                            return Err(AgentToolError::from_upstream(&code, msg, None));
                        }
                        Ok(Value::Array(self.transfers.lock().unwrap().clone()))
                    }
                    "transfer.download" => {
                        self.downloads.lock().unwrap().push(params.clone());
                        Ok(json!(["task-dl-1"]))
                    }
                    "transfer.upload" => {
                        self.uploads.lock().unwrap().push(params.clone());
                        Ok(json!(["task-up-1"]))
                    }
                    "transfer.pause" | "transfer.resume" | "transfer.retry" | "transfer.cancel" => Ok(json!({"done": true})),
                    _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("fake 未实现 {method}"))),
                }
            })
        }

        fn download_dir(&self) -> String {
            self.download_dir.lock().unwrap().clone()
        }
        fn session_generation(&self) -> u64 {
            1
        }
    }

    struct Harness {
        deps: std::sync::Arc<FakeDrive>,
        tools: std::sync::Arc<QuarkTools>,
        #[allow(dead_code)]
        dir: std::path::PathBuf,
    }

    fn harness(_scope: ScopeSnapshot) -> Harness {
        // 短路径：Unix socket 路径受 SUN_LEN 限制（macOS temp_dir 本身就很长）。
        let dir = std::path::PathBuf::from(format!(
            "/tmp/qk-tools-{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let deps = std::sync::Arc::new(FakeDrive::with_root());
        let journal = std::sync::Arc::new(crate::journal::Journal::open(&dir).unwrap());
        let plans = std::sync::Arc::new(crate::plans::PlanStore::new());
        let tools = std::sync::Arc::new(QuarkTools::new(deps.clone(), journal, plans));
        Harness { deps, tools, dir }
    }

    fn ctx_with(scope: ScopeSnapshot) -> ToolContext {
        ToolContext { actor: "agent".into(), generation: 1, scope }
    }

    fn scope(roots: &[&str], write: bool, local_write: &[&std::path::Path]) -> ScopeSnapshot {
        ScopeSnapshot {
            remote_roots: roots.iter().map(|s| s.to_string()).collect(),
            write_mode: if write { "scoped-write".into() } else { "read-only".into() },
            allow_delete: false,
            local_read_roots: vec![],
            local_write_roots: local_write.iter().map(|p| p.to_path_buf()).collect(),
        }
    }

    fn scope_deletable(roots: &[&str], local_write: &[&std::path::Path]) -> ScopeSnapshot {
        let mut s = scope(roots, true, local_write);
        s.allow_delete = true;
        s
    }

    async fn run(h: &Harness, ctx: &ToolContext, name: &str, args: Value) -> Value {
        h.tools.execute(ctx, name, &args).await.unwrap_or_else(|e| json!({"error": e.to_json()}))
    }

    #[tokio::test]
    async fn list_dir_requires_scope_and_enforces_page_cap() {
        // 无授权根 → OUT_OF_SCOPE
        let h = harness(scope(&[], true, &[]));
        let ctx = ctx_with(scope(&[], true, &[]));
        let out = run(&h, &ctx, "list_dir", json!({})).await;
        assert_eq!(out["error"]["code"], "AGENT_OUT_OF_SCOPE");
        // 有根 → 列出；size 超 200 被压并提示
        let h2 = harness(scope(&["root"], true, &[]));
        h2.deps.add("file-1", "a.txt", false, "root", 10);
        let ctx2 = ctx_with(scope(&["root"], true, &[]));
        let out2 = run(&h2, &ctx2, "list_dir", json!({"size": 500})).await;
        assert_eq!(out2["size"], 200);
        assert_eq!(out2["truncated"], true);
        assert!(out2["truncation_note"].as_str().unwrap().contains("超过单页上限"));
        assert_eq!(out2["list"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn write_tools_reject_in_read_only_mode() {
        let h = harness(scope(&["root"], false, &[]));
        let ctx = ctx_with(scope(&["root"], false, &[]));
        h.deps.add("f", "node.txt", false, "root", 1);
        h.deps.add("a", "aaa.txt", false, "root", 1);
        for (name, args) in [
            ("create_folder", json!({"name": "x"})),
            ("rename_entry", json!({"fid": "f", "name": "n"})),
            ("move_entries", json!({"fids": ["a"], "to_fid": "root"})),
            ("delete_entries", json!({"fids": ["a"], "dry_run": true})),
        ] {
            let out = run(&h, &ctx, name, args).await;
            assert_eq!(out["error"]["code"], "AGENT_READ_ONLY", "{name}");
        }
    }

    #[tokio::test]
    async fn all_write_tools_rejected_in_read_only_mode() {
        // qck 10.6.4：全部写入口逐一验证只读拦截（不止 4 个）。
        let tmp = std::env::temp_dir();
        let h = harness(scope(&["root"], false, &[&tmp]));
        h.deps.add("f", "node.txt", false, "root", 1);
        h.deps.add("a", "aaa.txt", false, "root", 1);
        h.deps.transfers.lock().unwrap().push(json!({"id":"t1","kind":"download","name":"a","size":1,"transferred":0,"status":"running","attempts":0,"createdAt":0,"updatedAt":0}));
        let src = tmp.join("qk-agent-ro-src.txt");
        std::fs::write(&src, b"x").unwrap();
        let ctx = ctx_with(scope(&["root"], false, &[&tmp]));
        for (name, args) in [
            ("create_folder", json!({"name": "x"})),
            ("rename_entry", json!({"fid": "f", "name": "n"})),
            ("move_entries", json!({"fids": ["a"], "to_fid": "root"})),
            ("copy_entries", json!({"fids": ["a"], "to_fid": "root"})),
            ("download_files", json!({"fids": ["a"]})),
            ("upload_file", json!({"local_path": src.to_string_lossy()})),
            ("save_text_file", json!({"name": "n.txt", "text": "t"})),
            ("transfer_control", json!({"task_id": "t1", "action": "pause"})),
            ("plan_execute", json!({"plan_id": "p", "revision": 1, "content_hash": "h"})),
            ("delete_entries", json!({"fids": ["a"], "dry_run": true})),
        ] {
            let out = run(&h, &ctx, name, args).await;
            assert_eq!(out["error"]["code"], "AGENT_READ_ONLY", "{name} 应被只读拦截: {out}");
        }
        // 假网盘确认没有任何写发生
        assert!(h.deps.uploads.lock().unwrap().is_empty());
        let _ = std::fs::remove_file(&src);
    }

    #[tokio::test]
    async fn delete_requires_dry_run_and_matching_confirm_names() {
        let h = harness(scope_deletable(&["root"], &[]));
        h.deps.add("f1", "报告.txt", false, "root", 3);
        h.deps.add("f2", "图片.jpg", false, "root", 3);
        // 默认 scoped-write 但 allow_delete=false 时，必须拒绝删除！
        let ro_del = run(&h, &ctx_with(scope(&["root"], true, &[])), "delete_entries", json!({"fids": ["f1"]})).await;
        assert_eq!(ro_del["error"]["code"], "AGENT_READ_ONLY");
        let ctx = ctx_with(scope_deletable(&["root"], &[]));
        // dry_run 默认 true → 只列目标，不删除
        let out = run(&h, &ctx, "delete_entries", json!({"fids": ["f1", "f2"]})).await;
        assert_eq!(out["dry_run"], true);
        assert_eq!(out["entries"].as_array().unwrap().len(), 2);
        assert!(h.deps.removed.lock().unwrap().is_empty());
        // 错误名称 → 拒绝
        let bad = run(&h, &ctx, "delete_entries", json!({"fids": ["f1","f2"], "dry_run": false, "confirm_names": ["报告.txt"]})).await;
        assert_eq!(bad["error"]["code"], "AGENT_CONFLICT");
        assert!(h.deps.removed.lock().unwrap().is_empty());
        // 正确名称 → 删除并逐项核对为 deleted
        let ok = run(&h, &ctx, "delete_entries", json!({"fids": ["f1","f2"], "dry_run": false, "confirm_names": ["图片.jpg","报告.txt"]})).await;
        assert_eq!(ok["deleted_to_recycle"], true);
        assert_eq!(ok["accepted"],true,"异步受理不等于 done=false 时未受理");
        let mut statuses: Vec<&str> = ok["results"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap()).collect();
        statuses.sort();
        assert_eq!(statuses, vec!["deleted", "deleted"]);
        let removed = h.deps.removed.lock().unwrap().clone();
        assert!(removed.contains(&"f1".to_string()) && removed.contains(&"f2".to_string()));
    }

    #[tokio::test]
    async fn approximate_recent_metadata_cannot_authorize_a_remote_object() {
        let h=harness(scope(&["root"],true,&[]));
        h.tools.shared.remember("gone","root","old.txt",false);
        let out=run(&h,&ctx_with(scope(&["root"],true,&[])),"file_info",json!({"fid":"gone"})).await;
        assert_eq!(out["error"]["code"],"AGENT_OUT_OF_SCOPE");
    }

    #[tokio::test]
    async fn rename_reads_fresh_metadata_and_async_moves_are_accepted_before_completion() {
        let h=harness(scope(&["root"],true,&[]));let ctx=ctx_with(scope(&["root"],true,&[]));
        h.deps.add("f1","old.txt",false,"root",3);h.deps.mkdir("dest","dest","root");
        let renamed=run(&h,&ctx,"rename_entry",json!({"fid":"f1","name":"new.txt"})).await;
        assert_eq!(renamed["verified"],true);assert_eq!(renamed["observed_after"],"new.txt");
        let moved=run(&h,&ctx,"move_entries",json!({"fids":["f1"],"to_fid":"dest"})).await;
        assert_eq!(moved["accepted"],true);assert_eq!(moved["completed"],false);
        assert_eq!(h.deps.nodes.lock().unwrap()["f1"]["pdirFid"],"dest");
        let copied=run(&h,&ctx,"copy_entries",json!({"fids":["f1"],"to_fid":"root"})).await;
        assert_eq!(copied["accepted"],true);assert_eq!(copied["completed"],false);
    }

    #[tokio::test]
    async fn accepted_delete_with_unavailable_verification_is_not_confirmed_deleted() {
        let h=harness(scope_deletable(&["root"],&[]));
        h.deps.add("f1","报告.txt",false,"root",3);
        h.deps.fail_removed_lookup.store(true,std::sync::atomic::Ordering::Relaxed);
        let out=run(&h,&ctx_with(scope_deletable(&["root"],&[])),"delete_entries",json!({"fids":["f1"],"dry_run":false,"confirm_names":["报告.txt"]})).await;
        assert_eq!(out["accepted"],true);
        assert_eq!(out["deleted_to_recycle"],false);
        assert_eq!(out["results"][0]["status"],"uncertain");
        assert_eq!(h.deps.removed.lock().unwrap().as_slice(),["f1"]);
    }

    #[tokio::test]
    async fn delete_out_of_scope_rejected_and_folder_deletes_children() {
        let h = harness(scope_deletable(&["root"], &[]));
        h.deps.add("outside", "x", false, "0", 1);
        h.deps.mkdir("folder-1", "待删目录", "root");
        h.deps.add("child-1", "child.txt", false, "folder-1", 1);
        let ctx = ctx_with(scope_deletable(&["root"], &[]));
        let bad = run(&h, &ctx, "delete_entries", json!({"fids": ["outside"], "dry_run": false, "confirm_names": ["x"]})).await;
        assert_eq!(bad["error"]["code"], "AGENT_OUT_OF_SCOPE");
        // 目录删除连带子项
        let ok = run(&h, &ctx, "delete_entries", json!({"fids": ["folder-1"], "dry_run": false, "confirm_names": ["待删目录"]})).await;
        assert_eq!(ok["results"][0]["status"], "deleted");
        let removed = h.deps.removed.lock().unwrap().clone();
        assert!(removed.contains(&"folder-1".to_string()));
        assert!(removed.contains(&"child-1".to_string()));
    }

    #[tokio::test]
    async fn move_into_itself_is_rejected() {
        let h = harness(scope(&["root"], true, &[]));
        h.deps.mkdir("dir-a", "A", "root");
        h.deps.mkdir("dir-a-child", "child", "dir-a");
        let ctx = ctx_with(scope(&["root"], true, &[]));
        let out = run(&h, &ctx, "move_entries", json!({"fids": ["dir-a"], "to_fid": "dir-a-child"})).await;
        assert_eq!(out["error"]["code"], "AGENT_INVALID_ARG");
        assert!(out["error"]["message"].as_str().unwrap().contains("子目录"));
        // 移动到自身
        let out2 = run(&h, &ctx, "move_entries", json!({"fids": ["dir-a"], "to_fid": "dir-a"})).await;
        assert_eq!(out2["error"]["code"], "AGENT_INVALID_ARG");
    }

    #[tokio::test]
    async fn transfer_control_rejects_unknown_action_and_requires_write() {
        let h = harness(scope(&["root"], true, &[]));
        h.deps.transfers.lock().unwrap().push(json!({"id":"t1","kind":"download","name":"a","size":1,"transferred":0,"status":"running","attempts":0,"createdAt":0,"updatedAt":0}));
        let ctx = ctx_with(scope(&["root"], true, &[]));
        let bad = run(&h, &ctx, "transfer_control", json!({"task_id":"t1","action":"clear"})).await;
        assert_eq!(bad["error"]["code"], "AGENT_INVALID_ARG");
        let ro_ctx = ctx_with(scope(&["root"], false, &[]));
        let ro = run(&h, &ro_ctx, "transfer_control", json!({"task_id":"t1","action":"pause"})).await;
        assert_eq!(ro["error"]["code"], "AGENT_READ_ONLY");
        let ok = run(&h, &ctx, "transfer_control", json!({"task_id":"t1","action":"pause"})).await;
        assert_eq!(ok["action"], "pause");
        assert_eq!(ok["status_before"], "running");
    }

    #[tokio::test]
    async fn tree_dir_respects_depth_and_entry_limits() {
        let h = harness(scope(&["root"], true, &[]));
        h.deps.add("f-at-root", "a.txt", false, "root", 1);
        h.deps.mkdir("d1", "D1", "root");
        h.deps.add("f-in-d1", "b.txt", false, "d1", 1);
        h.deps.mkdir("d2", "D2", "d1");
        h.deps.add("f-in-d2", "c.txt", false, "d2", 1);
        let ctx = ctx_with(scope(&["root"], true, &[]));
        // 深度 1：只能看到根下文件；子目录因深度上限 incomplete_subtrees+1
        let out = run(&h, &ctx, "tree_dir", json!({"root_fid": "root", "max_depth": 1, "max_entries": 100})).await;
        assert_eq!(out["count"], 1);
        assert_eq!(out["incomplete_subtrees"], 1);
        // 深度 2 + include_dirs：看到 D1 与其中文件；D2 计为未展开
        let out2 = run(&h, &ctx, "tree_dir", json!({"root_fid": "root", "max_depth": 2, "max_entries": 100, "include_dirs": true})).await;
        let rels: Vec<&str> = out2["entries"].as_array().unwrap().iter().map(|e| e["rel_path"].as_str().unwrap()).collect();
        assert!(rels.contains(&"D1"));
        assert!(rels.contains(&"D1/b.txt"));
        assert_eq!(out2["incomplete_subtrees"], 1);
        // 条目上限截断
        let out3 = run(&h, &ctx, "tree_dir", json!({"root_fid": "root", "max_depth": 8, "max_entries": 1})).await;
        assert_eq!(out3["truncated"], true);
    }

    #[tokio::test]
    async fn plan_create_execute_binds_to_content_hash() {
        let h = harness(scope(&["root"], true, &[]));
        h.deps.add("p1", "photo.jpg", false, "root", 3);
        h.deps.add("p2", "doc.pdf", false, "root", 3);
        let ctx = ctx_with(scope(&["root"], true, &[]));
        let out = run(&h, &ctx, "plan_create", json!({"root_fid": "root", "by": "ext"})).await;
        let plan = out["plan"].clone();
        let plan_id = plan["plan_id"].as_str().unwrap().to_string();
        let revision = plan["revision"].as_u64().unwrap();
        let hash = plan["content_hash"].as_str().unwrap().to_string();
        assert_eq!(plan["summary"]["total"], 2);
        // 缺哈希 → PLAN_STALE
        let exec1 = run(&h, &ctx, "plan_execute", json!({"plan_id": plan_id, "revision": revision})).await;
        assert_eq!(exec1["error"]["code"], "AGENT_PLAN_STALE");
        // 正确授权 → 执行成功（move 到「图片」「文档」目录）
        let exec2 = run(&h, &ctx, "plan_execute", json!({"plan_id": plan_id, "revision": revision, "content_hash": hash})).await;
        assert_eq!(exec2["summary"]["accepted"], 2);
        assert_eq!(exec2["partial"], false);
        // 重复执行 → CONFLICT
        let exec3 = run(&h, &ctx, "plan_execute", json!({"plan_id": plan_id, "revision": revision, "content_hash": plan["content_hash"]})).await;
        assert_eq!(exec3["error"]["code"], "AGENT_CONFLICT");
    }

    #[tokio::test]
    async fn upload_name_with_path_separator_rejected_and_staged_copy_used() {
        let tmp = std::env::temp_dir();
        let h = harness(scope(&["root"], true, &[&tmp]));
        let src = std::env::temp_dir().join("qk-agent-src.txt");
        std::fs::write(&src, b"hi").unwrap();
        let ctx = ctx_with(scope(&["root"], true, &[&tmp]));
        let bad = run(&h, &ctx, "upload_file", json!({"local_path": src.to_string_lossy(), "name": "../evil.txt"})).await;
        assert_eq!(bad["error"]["code"], "AGENT_INVALID_ARG");
        // 改名上传 → 使用 staged 副本，原文件不动
        let ok = run(&h, &ctx, "upload_file", json!({"local_path": src.to_string_lossy(), "name": "renamed.txt", "wait": false})).await;
        assert_eq!(ok["name"], "renamed.txt");
        let uploads = h.deps.uploads.lock().unwrap().clone();
        assert_eq!(uploads.len(), 1);
        let uploaded_path = uploads[0]["localPaths"][0].as_str().unwrap();
        assert!(uploaded_path.ends_with("renamed.txt"));
        let _ = std::fs::remove_file(&src);
    }

    #[tokio::test]
    async fn gateway_end_to_end_with_node_cli_adapter() {
        // 真实网关 + 真实工具层 + 假网盘 + 真实 Node CLI 适配器子进程（离线闭环）。
        use crate::gateway::{AccessSnapshot, AgentGateway, ConfigSource};
        let h = harness(scope(&["root"], true, &[]));
        h.deps.add("file-1", "a.txt", false, "root", 10);

        struct Source {
            token: String,
            scope: ScopeSnapshot,
        }
        impl ConfigSource for Source {
            fn access(&self) -> AccessSnapshot {
                AccessSnapshot { enabled: true, token: self.token.clone() }
            }
            fn scope(&self) -> ScopeSnapshot {
                self.scope.clone()
            }
        }
        let token = "a".repeat(64);
        let source = std::sync::Arc::new(Source {
            token: token.clone(),
            scope: scope(&["root"], true, &[]),
        });
        let registry: std::sync::Arc<dyn crate::registry::ToolRegistry> = h.tools.clone();
        let journal = std::sync::Arc::new(crate::journal::Journal::open(&h.dir).unwrap());
        let gateway = std::sync::Arc::new(AgentGateway::new(source, registry, journal));
        #[cfg(unix)] let sock = h.dir.join("bridge.sock");
        #[cfg(windows)] let sock=std::path::PathBuf::from(format!(r"\\.\pipe\qk-cli-test-{}",uuid::Uuid::new_v4()));
        gateway.clone().start(&sock.to_string_lossy()).await.unwrap();

        let script = std::env::var_os("QDL_REPO_ROOT")
            .map(|r| std::path::PathBuf::from(r).join("tools").join("agent-cli.js"))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{}/../../tools/agent-cli.js", env!("CARGO_MANIFEST_DIR")));
        let run_cli = |args: Vec<String>| {
            let sock = sock.to_string_lossy().to_string();
            let token = token.clone();
            let script = script.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    std::process::Command::new("node")
                        .arg(&script)
                        .args(&args)
                        .env("QCK_AGENT_ENDPOINT", &sock)
                        .env("QCK_AGENT_TOKEN", &token)
                        .output()
                })
                .await
                .unwrap()
            }
        };

        // 1) status：真实 CLI 能认证并读到网关状态
        let out = run_cli(vec!["status".into()]).await.unwrap();
        assert!(out.status.success(), "stderr={}", String::from_utf8_lossy(&out.stderr));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("\"toolCount\": 20"), "output={stdout}");

        // 2) tools：20 个工具定义（含新增 delete_entries）
        let out2 = run_cli(vec!["tools".into()]).await.unwrap();
        assert!(out2.status.success());
        let stdout2 = String::from_utf8_lossy(&out2.stdout);
        assert!(stdout2.contains("delete_entries"));

        // 3) call list_dir：真实工具执行走假网盘
        let out3 = run_cli(vec![
            "call".into(),
            "list_dir".into(),
            r#"{"pdir_fid":"root","size":5}"#.into(),
        ])
        .await
        .unwrap();
        assert!(out3.status.success(), "stderr={}", String::from_utf8_lossy(&out3.stderr));
        let stdout3 = String::from_utf8_lossy(&out3.stdout);
        assert!(stdout3.contains("a.txt"), "output={stdout3}");

        // 4) 错误 token 必须被拒
        let bad = tokio::task::spawn_blocking({
            let sock = sock.to_string_lossy().to_string();
            let script = script.clone();
            move || {
                std::process::Command::new("node")
                    .arg(&script)
                    .arg("status")
                    .env("QCK_AGENT_ENDPOINT", &sock)
                    .env("QCK_AGENT_TOKEN", "b".repeat(64))
                    .output()
            }
        })
        .await
        .unwrap()
        .unwrap();
        assert!(!bad.status.success());
        gateway.stop().await;
    }

    #[tokio::test]
    async fn drive_status_contains_no_credentials() {
        let h = harness(scope(&["root"], true, &[]));
        h.deps.transfers.lock().unwrap().push(json!({"id":"t1","kind":"upload","name":"a","size":1,"transferred":0,"status":"done","attempts":0,"createdAt":0,"updatedAt":0}));
        let ctx = ctx_with(scope(&["root"], true, &[]));
        let out = run(&h, &ctx, "drive_status", json!({})).await;
        let text = out.to_string().to_lowercase();
        for bad in ["token", "cookie", "authorization", "secret", "password", "session"] {
            assert!(!text.contains(bad), "drive_status 不应包含 {bad}");
        }
        assert_eq!(out["logged_in"], true);
        assert_eq!(out["quota_bytes"]["total"], 100);
        assert_eq!(out["agent"]["write_mode"], "scoped-write");
        assert_eq!(out["agent"]["allow_delete"], false);
    }

    #[tokio::test]
    async fn read_text_file_blocks_traversal_enforces_read_only_and_uses_verified_local_path() {
        let base = tempfile::tempdir().unwrap();
        let work = base.path().join("work");
        let outside = base.path().join("secret.txt");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(&outside, "HOST_SECRET_FILE").unwrap();

        let h = harness(scope(&["root"], false, &[&work]));
        // 恶意云端文件名试图通过 ../ 穿越到工作目录之外读取宿主敏感文件
        h.deps.add("evil-fid", "../secret.txt", false, "root", 16);

        // 1) 只读模式：绝不能读取 ../secret.txt，也不能触发 transfer.download 绕过只读模式！
        let ro_ctx = ctx_with(scope(&["root"], false, &[&work]));
        let ro_out = run(&h, &ro_ctx, "read_text_file", json!({"fid": "evil-fid"})).await;
        assert_eq!(
            ro_out["error"]["code"], "AGENT_READ_ONLY",
            "只读模式下下载触发必须被拦截: {ro_out}"
        );
        assert!(h.deps.downloads.lock().unwrap().is_empty());

        // 2) 可写模式：download_if_missing=false 绝不能因为 work.join("../secret.txt") 存在就读出宿主文件！
        let rw_ctx = ctx_with(scope(&["root"], true, &[&work]));
        let no_dl = run(
            &h,
            &rw_ctx,
            "read_text_file",
            json!({"fid": "evil-fid", "download_if_missing": false}),
        )
        .await;
        assert_eq!(no_dl["error"]["code"], "AGENT_NOT_FOUND");

        // 3) 若传输返回越界的 localPath，assert_local_path 必须拒绝（AGENT_OUT_OF_SCOPE）
        h.deps.transfers.lock().unwrap().push(json!({
            "id": "task-dl-1",
            "kind": "download",
            "fid": "evil-fid",
            "status": "done",
            "localPath": outside.to_string_lossy(),
        }));
        let escaped = run(&h, &rw_ctx, "read_text_file", json!({"fid": "evil-fid"})).await;
        assert_eq!(escaped["error"]["code"], "AGENT_OUT_OF_SCOPE");
        assert!(!escaped.to_string().contains("HOST_SECRET_FILE"));

        // 4) 传输把文件保存到去重后的实际路径（report (1).txt），read_text_file 必须按实际 localPath 读取
        let actual_file = work.join("report (1).txt");
        std::fs::write(&actual_file, "hello from dedup download").unwrap();
        h.deps.add("good-fid", "report.txt", false, "root", 25);
        h.deps.transfers.lock().unwrap().clear();
        h.deps.transfers.lock().unwrap().push(json!({
            "id": "task-dl-1",
            "kind": "download",
            "fid": "good-fid",
            "status": "done",
            "localPath": actual_file.to_string_lossy(),
        }));
        let ok = run(&h, &rw_ctx, "read_text_file", json!({"fid": "good-fid"})).await;
        assert_eq!(ok["text"], "hello from dedup download");
        assert_eq!(ok["name"], "report.txt");
    }

    #[tokio::test]
    async fn wait_for_transfers_aborts_immediately_on_error_without_deadlock() {
        let h = harness(scope(&["root"], true, &[]));
        *h.deps.transfer_list_error.lock().unwrap() =
            Some(("ABORTED".into(), "账号已切换，会话失效".into()));
        let env = h.tools.env(&ctx_with(scope(&["root"], true, &[])));
        let started = std::time::Instant::now();
        // 给 30 秒超时：若死循环会卡满 30 秒，修复后应立即退出。
        let waited = env.wait_for_transfers(&["t-1".into()], 30_000).await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "出错时必须立即退出，不能等待超时: {:?}",
            started.elapsed()
        );
        assert_eq!(waited["done"], false);
        assert_eq!(waited["aborted"], true);
        assert_eq!(waited["error"]["code"], "ABORTED");
    }

    #[test]
    fn serialize_task_reads_camel_case_and_snake_case_and_is_not_found_rejects_invalid_arg() {
        let camel = ToolEnv::serialize_task(&json!({
            "id": "t1",
            "kind": "upload",
            "name": "a.txt",
            "status": "error",
            "errorCode": "CONFLICT",
            "createdAt": 1001,
            "updatedAt": 1002,
            "pdirFid": "dir-9"
        }));
        assert_eq!(camel["errorCode"], "CONFLICT");
        assert_eq!(camel["createdAt"], 1001);
        assert_eq!(camel["updatedAt"], 1002);
        assert_eq!(camel["pdirFid"], "dir-9");

        let snake = ToolEnv::serialize_task(&json!({
            "id": "t2",
            "error_code": "NETWORK",
            "created_at": 2001,
            "updated_at": 2002,
            "pdir_fid": "dir-8"
        }));
        assert_eq!(snake["errorCode"], "NETWORK");
        assert_eq!(snake["createdAt"], 2001);
        assert_eq!(snake["updatedAt"], 2002);
        assert_eq!(snake["pdirFid"], "dir-8");

        // is_not_found：绝不能把 400 / INVALID_ARG 当成已删除！
        let invalid_local = AgentToolError::new(AgentError::InvalidArg, "参数无效");
        assert!(!is_not_found(&invalid_local));
        let invalid_up = AgentToolError::from_upstream("INVALID_ARG", "Bad Parameter", None);
        assert!(!is_not_found(&invalid_up));
        let not_found = AgentToolError::from_upstream("NOT_FOUND", "不存在", None);
        assert!(is_not_found(&not_found));
    }

    #[tokio::test]
    async fn search_files_requires_remote_roots_and_defaults_to_only_in_scope() {
        let h = harness(scope(&[], false, &[]));
        // 无授权目录 → 拒绝
        let denied = run(&h, &ctx_with(scope(&[], false, &[])), "search_files", json!({"keyword": "doc"})).await;
        assert_eq!(denied["error"]["code"], "AGENT_OUT_OF_SCOPE");

        // 有授权目录：默认 only_in_scope=true，不泄漏未授权目录的同名文件
        h.deps.add("in-1", "doc-inside.txt", false, "root", 10);
        h.deps.add("out-1", "doc-private.txt", false, "0", 10);
        let ok = run(
            &h,
            &ctx_with(scope(&["root"], false, &[])),
            "search_files",
            json!({"keyword": "doc"}),
        )
        .await;
        assert_eq!(ok["scope_filtered"], true);
        let fids: Vec<&str> = ok["list"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|x| x["fid"].as_str())
            .collect();
        assert_eq!(fids, vec!["in-1"]);
    }

    #[tokio::test]
    async fn gateway_and_tools_write_single_redacted_journal_entry_without_body_leak() {
        use crate::gateway::{AccessSnapshot, AgentGateway, ConfigSource};
        let work = tempfile::tempdir().unwrap();
        let h = harness(scope(&["root"], true, &[work.path()]));
        let work_path = work.path().to_path_buf();
        struct Src(PathBuf);
        impl ConfigSource for Src {
            fn access(&self) -> AccessSnapshot {
                AccessSnapshot { enabled: true, token: "a".repeat(64) }
            }
            fn scope(&self) -> ScopeSnapshot {
                ScopeSnapshot {
                    remote_roots: vec!["root".into()],
                    write_mode: "scoped-write".into(),
                    allow_delete: false,
                    local_read_roots: vec![],
                    local_write_roots: vec![self.0.clone()],
                }
            }
        }
        let gateway = AgentGateway::new(
            std::sync::Arc::new(Src(work_path)),
            h.tools.clone() as std::sync::Arc<dyn crate::registry::ToolRegistry>,
            h.tools.journal.clone(),
        );
        let secret_body = "ULTRA_SECRET_NOTE_CONTENT_XYZ";
        gateway
            .call_tool(
                "save_text_file",
                &json!({"pdir_fid": "root", "name": "note.txt", "text": secret_body, "wait": false}),
                "mcp",
            )
            .await
            .unwrap();
        let records = h.tools.journal.list(20, None);
        assert_eq!(records.len(), 1, "不得重复写两条审计记录: {records:?}");
        let dumped = serde_json::to_string(&records).unwrap();
        assert!(!dumped.contains(secret_body), "审计日志绝不能包含正文内容: {dumped}");
        assert_eq!(records[0]["detail"]["args"]["text_bytes"], json!(secret_body.len()));
    }
}
