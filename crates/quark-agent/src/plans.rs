//! 批量改动计划（plans）：内存计划仓库与授权绑定核心。
//!
//! 与 qck plans.js 语义一致（规格 §5）：
//! - 计划只存内存，进程退出即失效（跨重启恢复需与网盘状态重新对齐，刻意不实现）。
//! - content_hash = sha256(canonical_json({type, rootFid, rules, entries}))；
//!   内容相同 → 哈希相同（用户可复现授权）；任一变化 → 新哈希。
//! - assertExecutable 八步校验：revision 与 content_hash 必须同时提供、
//!   二次内容哈希防 entries 被就地改写（对抗性审查实测过的 P0 绕过路径）。

use crate::policy::{canonical_json, sha256_hex, AgentError, AgentToolError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const DEFAULT_TTL_MS: i64 = 30 * 60 * 1000;
pub const MAX_ENTRIES: usize = 2000;
pub const MAX_PLANS: usize = 50;
pub const ACTIONS: [&str; 4] = ["move", "rename", "mkdir", "copy"];

#[derive(Debug, Clone, PartialEq)]
pub struct PlanEntry {
    pub index: usize,
    pub action: String,
    pub fid: String,
    pub name: String,
    pub from_fid: String,
    pub to_fid: String,
    pub to_name: String,
    pub to_dir_name: String,
    pub reason: String,
    pub conflict: bool,
    pub conflict_with: String,
    pub skip: bool,
    pub skip_reason: String,
}

impl PlanEntry {
    /// 归一化：未知 action → move（执行器只会 move，不因拼错动作误删）；
    /// 非字符串字段一律置 ''（数字/对象不得拼进真实写操作）。
    pub fn normalize(index: usize, raw: &Value) -> Self {
        let s = |v: &Value| -> String {
            v.as_str().map(|x| x.to_string()).unwrap_or_default()
        };
        let action = raw.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let action = if ACTIONS.contains(&action) { action.to_string() } else { "move".to_string() };
        Self {
            index,
            action,
            fid: s(raw.get("fid").unwrap_or(&Value::Null)),
            name: s(raw.get("name").unwrap_or(&Value::Null)),
            from_fid: s(raw.get("fromFid").unwrap_or(&Value::Null)),
            to_fid: s(raw.get("toFid").unwrap_or(&Value::Null)),
            to_name: s(raw.get("toName").unwrap_or(&Value::Null)),
            to_dir_name: s(raw.get("toDirName").unwrap_or(&Value::Null)),
            reason: s(raw.get("reason").unwrap_or(&Value::Null)),
            conflict: raw.get("conflict").and_then(|v| v.as_bool()).unwrap_or(false),
            conflict_with: s(raw.get("conflictWith").unwrap_or(&Value::Null)),
            skip: raw.get("skip").and_then(|v| v.as_bool()).unwrap_or(false),
            skip_reason: s(raw.get("skipReason").unwrap_or(&Value::Null)),
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "index": self.index, "action": self.action, "fid": self.fid, "name": self.name,
            "fromFid": self.from_fid, "toFid": self.to_fid, "toName": self.to_name,
            "toDirName": self.to_dir_name, "reason": self.reason,
            "conflict": self.conflict, "conflictWith": self.conflict_with,
            "skip": self.skip, "skipReason": self.skip_reason,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub plan_id: String,
    pub revision: u64,
    pub kind: String,
    pub root_fid: String,
    pub rules: Value,
    pub notes: String,
    pub entries: Vec<PlanEntry>,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: String, // pending | executing | executed | expired
    pub summary: Value,
    pub hash: String,
    pub executed_at: Option<i64>,
    pub result: Option<Value>,
}

impl Plan {
    fn compute_hash(kind: &str, root_fid: &str, rules: &Value, entries: Vec<PlanEntry>) -> String {
        let payload = json!({
            "type": kind,
            "rootFid": root_fid,
            "rules": rules,
            "entries": entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
        });
        sha256_hex(&canonical_json(&payload))
    }

    fn summarize(entries: &[PlanEntry]) -> Value {
        let mut movable = 0usize;
        let mut rename = 0usize;
        let mut mkdir = 0usize;
        let mut copy = 0usize;
        let mut conflicts = 0usize;
        let mut skipped = 0usize;
        for e in entries {
            if e.skip {
                skipped += 1;
                continue;
            }
            match e.action.as_str() {
                "move" => movable += 1,
                "rename" => rename += 1,
                "mkdir" => mkdir += 1,
                "copy" => copy += 1,
                _ => {}
            }
            if e.conflict {
                conflicts += 1;
            }
        }
        json!({
            "total": entries.len(), "movable": movable, "rename": rename,
            "mkdir": mkdir, "copy": copy, "conflicts": conflicts, "skipped": skipped,
        })
    }

    fn snapshot(&self) -> Value {
        let mut out = json!({
            "plan_id": self.plan_id,
            "revision": self.revision,
            "content_hash": self.hash,
            "type": self.kind,
            "root_fid": self.root_fid,
            "notes": self.notes,
            "status": self.status,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "summary": self.summary,
            "entries": self.entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
        });
        if let Some(r) = &self.result {
            out["result"] = r.clone();
        }
        out
    }
}

struct PlanStoreInner {
    map: HashMap<String, Plan>,
    counter: u64,
}

/// 计划仓库（进程内单例；并发由 Mutex 保护）。
pub struct PlanStore {
    inner: Mutex<PlanStoreInner>,
    ttl_ms: i64,
}

impl PlanStore {
    pub fn new() -> Self {
        Self { inner: Mutex::new(PlanStoreInner { map: HashMap::new(), counter: 0 }), ttl_ms: DEFAULT_TTL_MS }
    }

    pub fn with_ttl(ttl_ms: i64) -> Self {
        Self { inner: Mutex::new(PlanStoreInner { map: HashMap::new(), counter: 0 }), ttl_ms }
    }

    fn now() -> i64 {
        crate::journal::now_ms()
    }

    /// 创建计划：条目校验、先 prune 再查硬上限（失败不入库）。
    pub fn create(
        &self,
        kind: &str,
        root_fid: &str,
        rules: &Value,
        entries_raw: &[Value],
        notes: &str,
    ) -> Result<Value, AgentToolError> {
        if entries_raw.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "计划为空：没有匹配到任何需要改动的条目"));
        }
        if entries_raw.len() > MAX_ENTRIES {
            return Err(AgentToolError::new(AgentError::Limit, format!("计划条目数 {} 超过上限 {MAX_ENTRIES}", entries_raw.len()))
                .with_hint("请缩小授权目录范围或分批生成计划"));
        }
        let entries: Vec<PlanEntry> = entries_raw
            .iter()
            .enumerate()
            .map(|(i, e)| PlanEntry::normalize(i, e))
            .collect();
        let created_at = Self::now();
        let expires_at = if self.ttl_ms > 0 { created_at + self.ttl_ms } else { created_at };
        let plan_id = {
            let mut inner = self.inner.lock().unwrap();
            inner.counter += 1;
            format!("plan_{}_{}", created_at, inner.counter)
        };
        let hash = Plan::compute_hash(kind, root_fid, rules, entries.clone());
        let summary = Plan::summarize(&entries);
        let plan = Plan {
            plan_id,
            revision: 1,
            kind: kind.to_string(),
            root_fid: root_fid.to_string(),
            rules: rules.clone(),
            notes: notes.to_string(),
            entries,
            created_at,
            expires_at,
            status: "pending".into(),
            summary,
            hash,
            executed_at: None,
            result: None,
        };
        let mut inner = self.inner.lock().unwrap();
        // 先 prune 再检查硬上限（用 >=：否则达到上限后永远腾不出位置）。
        let ids: Vec<String> = inner.map.keys().cloned().collect();
        for id in ids {
            if let Some(p) = inner.map.get(&id) {
                if p.status == "pending" && p.expires_at <= created_at {
                    if let Some(p) = inner.map.get_mut(&id) {
                        p.status = "expired".into();
                    }
                }
            }
        }
        while inner.map.len() >= MAX_PLANS {
            let victim = inner
                .map
                .values()
                .filter(|p| p.status != "pending" && p.status != "executing")
                .min_by_key(|p| p.created_at)
                .map(|p| p.plan_id.clone());
            match victim {
                Some(id) => {
                    inner.map.remove(&id);
                }
                None => break,
            }
        }
        if inner.map.len() >= MAX_PLANS {
            return Err(AgentToolError::new(AgentError::Limit, "同时存在的计划过多")
                .with_hint("请先执行或等待已有计划过期"));
        }
        let snap = plan.snapshot();
        inner.map.insert(plan.plan_id.clone(), plan);
        Ok(snap)
    }

    /// 读取计划快照；读时 lazy 把过期 pending 标 expired。
    pub fn get(&self, plan_id: &str) -> Result<Value, AgentToolError> {
        let mut inner = self.inner.lock().unwrap();
        let now = Self::now();
        let plan = inner
            .map
            .get_mut(plan_id)
            .ok_or_else(|| AgentToolError::new(AgentError::NotFound, "未找到该计划").with_hint("请重新生成计划"))?;
        if plan.status == "pending" && plan.expires_at <= now {
            plan.status = "expired".into();
        }
        Ok(plan.snapshot())
    }

    /// 授权绑定核心：八步校验全部通过才返回内部计划引用的副本（调用方不得改写 entries）。
    pub fn assert_executable(
        &self,
        plan_id: &str,
        revision: Option<u64>,
        content_hash: Option<&str>,
    ) -> Result<Plan, AgentToolError> {
        let mut inner = self.inner.lock().unwrap();
        let now = Self::now();
        let plan = inner
            .map
            .get_mut(plan_id)
            .ok_or_else(|| AgentToolError::new(AgentError::NotFound, "未找到该计划").with_hint("请重新生成计划"))?;
        if plan.status == "pending" && plan.expires_at <= now {
            plan.status = "expired".into();
        }
        match plan.status.as_str() {
            "expired" => {
                return Err(AgentToolError::new(AgentError::PlanStale, "计划已过期，请重新生成"));
            }
            "executed" => {
                return Err(AgentToolError::new(AgentError::Conflict, "该计划已经执行过，不能重复执行")
                    .with_hint("如需再次改动，请重新生成计划"));
            }
            "executing" => {
                return Err(AgentToolError::new(AgentError::Conflict, "该计划正在执行中"));
            }
            _ => {}
        }
        // revision 与 contentHash 必须同时提供：inputSchema.required 不产生运行时约束，
        // "给了才校验"曾经放行"只传 plan_id 就能执行"（对抗性审查实测 P0）。
        let (rev, hash) = match (revision, content_hash) {
            (Some(r), Some(h)) if !h.is_empty() => (r, h),
            _ => {
                return Err(AgentToolError::new(AgentError::PlanStale, "缺少计划授权参数")
                    .with_hint("请先用 get_plan 读取计划，再把 revision 与 content_hash 一起回传"));
            }
        };
        if rev != plan.revision {
            return Err(AgentToolError::new(
                AgentError::PlanStale,
                format!("计划版本不匹配（当前 {}）", plan.revision),
            ));
        }
        if hash != plan.hash {
            return Err(AgentToolError::new(AgentError::PlanStale, "计划内容已变化，授权不再有效"));
        }
        // 二次校验内容哈希：防 entries 在创建后被就地改写（内存篡改/追加条目的经典绕过）。
        let recomputed = Plan::compute_hash(&plan.kind, &plan.root_fid, &plan.rules, plan.entries.clone());
        if recomputed != plan.hash {
            return Err(AgentToolError::new(AgentError::PlanStale, "计划内容与授权时不一致"));
        }
        Ok(plan.clone())
    }

    pub fn mark_executing(&self, plan_id: &str) -> Result<(), AgentToolError> {
        let mut inner = self.inner.lock().unwrap();
        let plan = inner
            .map
            .get_mut(plan_id)
            .ok_or_else(|| AgentToolError::new(AgentError::NotFound, "未找到该计划"))?;
        if plan.status!="pending" || plan.expires_at<=Self::now(){return Err(AgentToolError::new(AgentError::Conflict,"计划已被认领、已结束或过期，不能重复执行"));}
        plan.status = "executing".into();
        Ok(())
    }

    pub fn mark_executed(&self, plan_id: &str, results: &Value, summary: &Value) -> Result<Value, AgentToolError> {
        let mut inner = self.inner.lock().unwrap();
        let plan = inner
            .map
            .get_mut(plan_id)
            .ok_or_else(|| AgentToolError::new(AgentError::NotFound, "未找到该计划"))?;
        plan.status = "executed".into();
        plan.executed_at = Some(Self::now());
        plan.result = Some(json!({ "executed_at": plan.executed_at, "summary": summary, "results": results }));
        Ok(plan.snapshot())
    }

    /// 账号切换/退出时清空全部内存计划。
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.map.clear();
    }

    /// 最近计划列表（createdAt 降序）。
    pub fn list(&self, limit: usize) -> Vec<Value> {
        let limit = limit.clamp(1, 100);
        let inner = self.inner.lock().unwrap();
        let mut plans: Vec<&Plan> = inner.map.values().collect();
        plans.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        plans.iter().take(limit).map(|p| p.snapshot()).collect()
    }
}

impl Default for PlanStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(fid: &str, name: &str, from: &str, to_dir: &str) -> Value {
        serde_json::json!({"fid": fid, "name": name, "fromFid": from, "toDirName": to_dir, "reason": "按扩展名"})
    }

    #[test]
    fn create_requires_entries_and_caps_at_limit() {
        let store = PlanStore::new();
        let err = store.create("organize", "r", &json!({}), &[], "").unwrap_err();
        assert_eq!(err.code, AgentError::InvalidArg);
        // 2001 条超上限
        let many: Vec<Value> = (0..(MAX_ENTRIES + 1)).map(|i| entry(&format!("f{i}"), "a", "r", "图片")).collect();
        let err2 = store.create("organize", "r", &json!({}), &many, "").unwrap_err();
        assert_eq!(err2.code, AgentError::Limit);
    }

    #[test]
    fn same_content_same_hash_and_executable_binding() {
        let store = PlanStore::new();
        let entries = vec![entry("f1", "a.jpg", "r", "图片"), entry("f2", "b.jpg", "r", "图片")];
        let s1 = store.create("organize", "r", &json!({"by": "ext"}), &entries, "").unwrap();
        let s2 = store.create("organize", "r", &json!({"by": "ext"}), &entries, "").unwrap();
        assert_eq!(s1["content_hash"], s2["content_hash"]);
        // 修改内容 → 不同哈希
        let mut entries2 = entries.clone();
        entries2[0]["name"] = json!("renamed.jpg");
        let s3 = store.create("organize", "r", &json!({"by": "ext"}), &entries2, "").unwrap();
        assert_ne!(s1["content_hash"], s3["content_hash"]);
        // 缺授权参数 → 拒绝
        let id = s1["plan_id"].as_str().unwrap();
        let err = store.assert_executable(id, None, None).unwrap_err();
        assert_eq!(err.code, AgentError::PlanStale);
        // 只给 revision → 拒绝（历史上"给了才校验"的 P0）
        let err2 = store.assert_executable(id, Some(1), None).unwrap_err();
        assert_eq!(err2.code, AgentError::PlanStale);
        // 错哈希 → 拒绝
        let err3 = store.assert_executable(id, Some(1), Some("deadbeef")).unwrap_err();
        assert_eq!(err3.code, AgentError::PlanStale);
        // 正确 → 通过并进入 executing
        let h = s1["content_hash"].as_str().unwrap();
        store.assert_executable(id, Some(1), Some(h)).unwrap();
        store.mark_executing(id).unwrap();
        // executing 期间重复执行 → CONFLICT
        let err4 = store.assert_executable(id, Some(1), Some(h)).unwrap_err();
        assert_eq!(err4.code, AgentError::Conflict);
        // 执行完成后再执行 → CONFLICT
        store.mark_executed(id, &json!([]), &json!({"total": 0})).unwrap();
        let err5 = store.assert_executable(id, Some(1), Some(h)).unwrap_err();
        assert_eq!(err5.code, AgentError::Conflict);
    }

    #[test]
    fn prune_allows_new_plans_when_finished_exist_and_blocks_when_all_pending() {
        let store = PlanStore::new();
        // 全是 pending：达到 50 上限后拒绝
        for i in 0..MAX_PLANS {
            store.create("organize", "r", &json!({}), &[entry(&format!("f{i}"), "a", "r", "图片")], "")
                .unwrap_or_else(|e| panic!("create {i}: {e}"));
        }
        let err = store
            .create("organize", "r", &json!({}), &[entry("fx", "a", "r", "图片")], "")
            .unwrap_err();
        assert_eq!(err.code, AgentError::Limit);
        // 执行掉一个 → 腾出位置
        let list = store.list(100);
        let id = list[list.len() - 1]["plan_id"].as_str().unwrap().to_string();
        let h = list[list.len() - 1]["content_hash"].as_str().unwrap().to_string();
        store.assert_executable(&id, Some(1), Some(&h)).unwrap();
        store.mark_executed(&id, &json!([]), &json!({})).unwrap();
        assert!(store.create("organize", "r", &json!({}), &[entry("fy", "a", "r", "图片")], "").is_ok());
    }

    #[test]
    fn ttl_zero_expires_immediately() {
        let store = PlanStore::with_ttl(0);
        let s = store.create("organize", "r", &json!({}), &[entry("f", "a", "r", "图片")], "").unwrap();
        let id = s["plan_id"].as_str().unwrap();
        let err = store.get(id).unwrap();
        assert_eq!(err["status"], "expired");
        let e2 = store.assert_executable(id, Some(1), Some(s["content_hash"].as_str().unwrap())).unwrap_err();
        assert_eq!(e2.code, AgentError::PlanStale);
    }
    #[test]
    fn concurrent_execution_claim_has_exactly_one_winner() {
        let store=std::sync::Arc::new(PlanStore::new());
        let snap=store.create("organize","root",&json!({}),&[json!({"fid":"f","name":"file","action":"move","toFid":"d"})],"").unwrap();
        let id=snap["plan_id"].as_str().unwrap().to_string();
        let barrier=std::sync::Arc::new(std::sync::Barrier::new(16));
        let workers:Vec<_>=(0..16).map(|_|{let store=store.clone();let id=id.clone();let barrier=barrier.clone();std::thread::spawn(move||{barrier.wait();store.mark_executing(&id).is_ok()})}).collect();
        assert_eq!(workers.into_iter().map(|w|w.join().unwrap()).filter(|won|*won).count(),1);
    }

    #[test]
    fn executing_plans_are_never_evicted_when_store_is_full() {
        let store = PlanStore::new();
        let first = store
            .create("organize", "r", &json!({}), &[entry("f0", "a", "r", "图片")], "")
            .unwrap();
        let first_id = first["plan_id"].as_str().unwrap().to_string();
        store.mark_executing(&first_id).unwrap();
        for i in 1..MAX_PLANS {
            store
                .create("organize", "r", &json!({}), &[entry(&format!("f{i}"), "a", "r", "图片")], "")
                .unwrap();
        }
        let err = store
            .create("organize", "r", &json!({}), &[entry("fx", "a", "r", "图片")], "")
            .unwrap_err();
        assert_eq!(err.code, AgentError::Limit);
        assert_eq!(store.get(&first_id).unwrap()["status"], "executing");
        store.clear();
        assert!(store.list(10).is_empty());
    }
}
