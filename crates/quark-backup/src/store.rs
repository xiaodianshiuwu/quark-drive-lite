//! SQLite 持久任务库。
//!
//! 设计要点（对应 Phase-2 计划 §一.2/7/9）：
//! - 身份唯一键 (account, root_dir, target_fid, rel_path)：重扫幂等——同键 upsert，
//!   已终态的条目不被覆盖；mtime/size 变化才重新入队。
//! - WAL 模式：断电安全 + 读写并发。
//! - 批量事务写入：10 万+ 条目不能逐条 commit。
//! - 水位统计：pending+uploading+verifying 计数即"队列深度"，供背压判定。

use crate::state::TaskState;
use rusqlite::{params, Connection};
use std::path::Path;

/// 一条备份任务（持久形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub account: String,
    pub root_dir: String,
    pub target_fid: String,
    pub rel_path: String,
    /// 文件在磁盘上的绝对路径（Windows 下可能是 \\?\ 前缀长路径）。
    pub local_path: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub state: TaskState,
    pub remote_fid: Option<String>,
    pub attempts: u32,
    pub last_error: Option<String>,
    /// 分片进度（JSON：{etag:number,...}），续传时回填给 transfer。
    pub chunk_progress: Option<String>,
    pub updated_at_ms: i64,
}

impl Task {
    pub fn identity_key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", self.account, self.root_dir, self.target_fid, self.rel_path)
    }
}

pub struct Store {
    /// rusqlite::Connection 是 !Sync；Mutex 使 Store 可跨线程共享（worker 池并发认领）。
    conn: std::sync::Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tasks (
                account      TEXT NOT NULL,
                root_dir     TEXT NOT NULL,
                target_fid   TEXT NOT NULL,
                rel_path     TEXT NOT NULL,
                local_path   TEXT NOT NULL,
                size         INTEGER NOT NULL,
                mtime_ms     INTEGER NOT NULL,
                state        TEXT NOT NULL,
                remote_fid   TEXT,
                attempts     INTEGER NOT NULL DEFAULT 0,
                last_error   TEXT,
                chunk_progress TEXT,
                updated_at_ms INTEGER NOT NULL,
                claimed_at_ms INTEGER NOT NULL DEFAULT 0,
                claim_seq INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account, root_dir, target_fid, rel_path)
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
            CREATE TABLE IF NOT EXISTS dirs (
                account      TEXT NOT NULL,
                target_fid   TEXT NOT NULL,
                rel_path     TEXT NOT NULL,
                remote_fid   TEXT NOT NULL,
                PRIMARY KEY (account, target_fid, rel_path)
            );
            "#,
        )?;
        Ok(Self { conn: std::sync::Mutex::new(conn) })
    }

    /// 崩溃恢复：应用重启后 uploading/verifying 任务无人认领（claim 只取
    /// discovered/pending），统一降回 pending。状态机守卫允许该迁移；
    /// chunk_progress 保留（分片级续传证据），attempts 不清零（防无限重启风暴）。
    pub fn recover_interrupted(&self, account: &str) -> rusqlite::Result<usize> {
        let conn = self.conn();
        let n = conn.execute(
            r#"UPDATE tasks SET state='pending', updated_at_ms=?2, claim_seq=0
               WHERE account=?1 AND state IN ('uploading','verifying')"#,
            params![account, Self::now()],
        )?;
        Ok(n)
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    /// 批量插入/更新发现结果（单事务）。返回 (新增, 重新入队[mtime/size 变化], 跳过[未变化])。
    pub fn upsert_discovered(&self, tasks: &[Task]) -> rusqlite::Result<(usize, usize, usize)> {
        let now = Self::now();
        let mut added = 0;
        let mut requeued = 0;
        let mut unchanged = 0;
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                r#"SELECT size, mtime_ms, state FROM tasks
                   WHERE account=?1 AND root_dir=?2 AND target_fid=?3 AND rel_path=?4"#,
            )?;
            let mut insert = tx.prepare_cached(
                r#"INSERT INTO tasks (account, root_dir, target_fid, rel_path, local_path,
                    size, mtime_ms, state, updated_at_ms)
                   VALUES (?1,?2,?3,?4,?5,?6,?7,'discovered',?8)"#,
            )?;
            let mut update = tx.prepare_cached(
                r#"UPDATE tasks SET local_path=?5, size=?6, mtime_ms=?7, state='discovered',
                    updated_at_ms=?8, last_error=NULL
                   WHERE account=?1 AND root_dir=?2 AND target_fid=?3 AND rel_path=?4"#,
            )?;
            for t in tasks {
                let existing = stmt
                    .query_row(
                        params![t.account, t.root_dir, t.target_fid, t.rel_path],
                        |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .ok();
                match existing {
                    None => {
                        insert.execute(params![
                            t.account, t.root_dir, t.target_fid, t.rel_path, t.local_path,
                            t.size as i64, t.mtime_ms, now
                        ])?;
                        added += 1;
                    }
                    Some((old_size, old_mtime, old_state)) => {
                        let changed = old_size != t.size as i64 || old_mtime != t.mtime_ms;
                        // 终态且内容未变：不重新入队（重扫幂等）
                        if !changed
                            && TaskState::parse(&old_state).is_some_and(|s| s.is_terminal() || s.is_active())
                        {
                            unchanged += 1;
                        } else if changed || old_state != "discovered" && old_state != "pending" {
                            update.execute(params![
                                t.account, t.root_dir, t.target_fid, t.rel_path, t.local_path,
                                t.size as i64, t.mtime_ms, now
                            ])?;
                            requeued += 1;
                        } else {
                            unchanged += 1;
                        }
                    }
                }
            }
        }
        tx.commit()?;
        Ok((added, requeued, unchanged))
    }

    /// 认领一批可执行任务（discovered 先提升为 pending；pending 按 updated_at 先进先出）。
    /// claim_seq 单调递增防毫秒碰撞：查询按本轮序号精确匹配，并发 worker 不重复认领。
    pub fn claim_batch(&self, account: &str, limit: usize) -> rusqlite::Result<Vec<Task>> {
        let mut out = Vec::new();
        let now = Self::now();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        {
            let seq: i64 = tx.query_row("SELECT COALESCE(MAX(claim_seq),0)+1 FROM tasks", [], |r| r.get(0))?;
            let mut promote = tx.prepare_cached(
                r#"UPDATE tasks SET state='pending', updated_at_ms=?2
                   WHERE rowid IN (
                     SELECT rowid FROM tasks WHERE account=?1 AND state='discovered' LIMIT ?3
                   )"#,
            )?;
            promote.execute(params![account, now, limit as i64])?;
            let mut mark = tx.prepare_cached(
                r#"UPDATE tasks SET claim_seq=?2
                   WHERE rowid IN (
                     SELECT rowid FROM tasks
                     WHERE account=?1 AND state='pending' AND claim_seq=0
                     ORDER BY updated_at_ms, rel_path LIMIT ?3
                   )"#,
            )?;
            mark.execute(params![account, seq, limit as i64])?;
            let mut q = tx.prepare_cached(
                r#"SELECT account, root_dir, target_fid, rel_path, local_path, size, mtime_ms,
                    state, remote_fid, attempts, last_error, chunk_progress, updated_at_ms
                   FROM tasks WHERE account=?1 AND state='pending' AND claim_seq=?2"#,
            )?;
            let rows = q.query_map(params![account, seq], row_to_task)?;
            for r in rows {
                out.push(r?);
            }
        }
        tx.commit()?;
        Ok(out)
    }

    /// 更新状态（带迁移守卫；非法迁移返回 Err）。
    pub fn transition(&self, task: &Task, next: TaskState, error: Option<&str>) -> rusqlite::Result<()> {
        let old = self.state_of(task)?;
        old.can_transition_to(next)
            .map_err(|e| rusqlite::Error::InvalidParameterName(e))?;
        self.conn().execute(
            r#"UPDATE tasks SET state=?5, last_error=?6, attempts=?7, remote_fid=?8,
                chunk_progress=?9, updated_at_ms=?10, claim_seq=0
               WHERE account=?1 AND root_dir=?2 AND target_fid=?3 AND rel_path=?4"#,
            params![
                task.account, task.root_dir, task.target_fid, task.rel_path,
                next.as_str(),
                error,
                task.attempts as i64,
                task.remote_fid,
                task.chunk_progress,
                Self::now(),
            ],
        )?;
        Ok(())
    }

    fn state_of(&self, task: &Task) -> rusqlite::Result<TaskState> {
        let conn = self.conn();
        let s: String = conn.query_row(
            r#"SELECT state FROM tasks WHERE account=?1 AND root_dir=?2 AND target_fid=?3 AND rel_path=?4"#,
            params![task.account, task.root_dir, task.target_fid, task.rel_path],
            |r| r.get(0),
        )?;
        TaskState::parse(&s).ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("未知状态 {s}")))
    }

    /// 各状态计数（水位判定用）。
    pub fn counts(&self, account: &str) -> rusqlite::Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT state, COUNT(*) FROM tasks WHERE account=?1 GROUP BY state",
        )?;
        let rows = stmt.query_map(params![account], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(map)
    }

    /// 队列深度：pending + uploading + verifying（发现不算——扫描还在进行）。
    pub fn queue_depth(&self, account: &str) -> rusqlite::Result<i64> {
        let c = self.counts(account)?;
        Ok(c.get("pending").copied().unwrap_or(0)
            + c.get("uploading").copied().unwrap_or(0)
            + c.get("verifying").copied().unwrap_or(0))
    }

    /// 拉取某状态的全部任务（验证清单用）。
    pub fn all_in_state(&self, account: &str, state: TaskState) -> rusqlite::Result<Vec<Task>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            r#"SELECT account, root_dir, target_fid, rel_path, local_path, size, mtime_ms,
                state, remote_fid, attempts, last_error, chunk_progress, updated_at_ms
               FROM tasks WHERE account=?1 AND state=?2 ORDER BY rel_path"#,
        )?;
        let rows = stmt.query_map(params![account, state.as_str()], row_to_task)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 目录 relPath → remoteFid 映射（幂等建目录用）。
    pub fn put_dir(&self, account: &str, target_fid: &str, rel_path: &str, remote_fid: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            r#"INSERT OR REPLACE INTO dirs (account, target_fid, rel_path, remote_fid) VALUES (?1,?2,?3,?4)"#,
            params![account, target_fid, rel_path, remote_fid],
        )?;
        Ok(())
    }

    pub fn get_dir(&self, account: &str, target_fid: &str, rel_path: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT remote_fid FROM dirs WHERE account=?1 AND target_fid=?2 AND rel_path=?3",
        )?;
        let mut rows = stmt.query_map(params![account, target_fid, rel_path], |r| r.get::<_, String>(0))?;
        match rows.next() {
            Some(Ok(fid)) => Ok(Some(fid)),
            _ => Ok(None),
        }
    }
}

fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        account: r.get(0)?,
        root_dir: r.get(1)?,
        target_fid: r.get(2)?,
        rel_path: r.get(3)?,
        local_path: r.get(4)?,
        size: r.get::<_, i64>(5)?.max(0) as u64,
        mtime_ms: r.get(6)?,
        state: TaskState::parse(&r.get::<_, String>(7)?).unwrap_or(TaskState::Discovered),
        remote_fid: r.get(8)?,
        attempts: r.get::<_, i64>(9)?.max(0) as u32,
        last_error: r.get(10)?,
        chunk_progress: r.get(11)?,
        updated_at_ms: r.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(rel: &str, size: u64, mtime: i64) -> Task {
        Task {
            account: "acc1".into(),
            root_dir: "/data".into(),
            target_fid: "root1".into(),
            rel_path: rel.into(),
            local_path: format!("/data/{rel}"),
            size,
            mtime_ms: mtime,
            state: TaskState::Discovered,
            remote_fid: None,
            attempts: 0,
            last_error: None,
            chunk_progress: None,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn upsert_is_idempotent_and_requeues_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        // 首次插入
        let (a, r, u) = store.upsert_discovered(&[task("a.txt", 10, 100)]).unwrap();
        assert_eq!((a, r, u), (1, 0, 0));
        // 相同内容重扫：unchanged，不重新入队
        let (a, r, u) = store.upsert_discovered(&[task("a.txt", 10, 100)]).unwrap();
        assert_eq!((a, r, u), (0, 0, 1));
        // mtime 变化：重新入队
        let (a, r, u) = store.upsert_discovered(&[task("a.txt", 10, 200)]).unwrap();
        assert_eq!((a, r, u), (0, 1, 0));
        // size 变化：重新入队
        let (a, r, u) = store.upsert_discovered(&[task("a.txt", 20, 200)]).unwrap();
        assert_eq!((a, r, u), (0, 1, 0));
    }

    #[test]
    fn claim_promotes_discovered_and_returns_batch() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        let batch: Vec<Task> = (0..10).map(|i| task(&format!("f{i}.txt"), 1, 1)).collect();
        store.upsert_discovered(&batch).unwrap();
        let claimed = store.claim_batch("acc1", 3).unwrap();
        assert_eq!(claimed.len(), 3);
        assert_eq!(claimed[0].state, TaskState::Pending);
        // 再 claim 拿下一批（10-3-3=4，第三次 claim 拿最后 4 个）
        let claimed2 = store.claim_batch("acc1", 3).unwrap();
        assert_eq!(claimed2.len(), 3);
        assert_ne!(claimed[0].rel_path, claimed2[0].rel_path, "认领过的不会重复返回");
        let claimed3 = store.claim_batch("acc1", 3).unwrap();
        assert_eq!(claimed3.len(), 3, "10-3-3=4 剩余，但单批上限 3");
        let claimed4 = store.claim_batch("acc1", 3).unwrap();
        assert_eq!(claimed4.len(), 1, "最后一个");
        // 全部领完后没有新的
        assert!(store.claim_batch("acc1", 3).unwrap().is_empty());
        // 其他账号不互相干扰
        assert!(store.claim_batch("acc2", 5).unwrap().is_empty());
    }

    #[test]
    fn transition_enforces_guard() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        store.upsert_discovered(&[task("x.txt", 1, 1)]).unwrap();
        let mut t = store.claim_batch("acc1", 1).unwrap().remove(0);
        assert_eq!(t.state, TaskState::Pending);
        // 合法：pending → uploading
        t.attempts = 1;
        store.transition(&t, TaskState::Uploading, None).unwrap();
        // 非法：uploading → discovered
        assert!(store.transition(&t, TaskState::Discovered, None).is_err());
        // 合法：uploading → verifying → success
        store.transition(&t, TaskState::Verifying, None).unwrap();
        store.transition(&t, TaskState::Success, None).unwrap();
        // 成功 → 重跑被拒绝（防覆盖）
        assert!(store.transition(&t, TaskState::Pending, None).is_err());
        // 数据库里的最终状态
        assert_eq!(store.state_of(&t).unwrap(), TaskState::Success);
    }

    #[test]
    fn queue_depth_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        let batch: Vec<Task> = (0..5).map(|i| task(&format!("g{i}.txt"), 1, 1)).collect();
        store.upsert_discovered(&batch).unwrap();
        assert_eq!(store.queue_depth("acc1").unwrap(), 0, "discovered 不计入队列深度");
        store.claim_batch("acc1", 5).unwrap();
        assert_eq!(store.queue_depth("acc1").unwrap(), 5);
    }

    #[test]
    fn recover_interrupted_maps_to_pending_and_keeps_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        store.upsert_discovered(&[task("crash.txt", 1, 1)]).unwrap();
        let mut t = store.claim_batch("acc1", 1).unwrap().remove(0);
        store.transition(&t, TaskState::Uploading, None).unwrap();
        t.chunk_progress = Some(r#"{"etag":3}"#.into());
        store.transition(&t, TaskState::Verifying, None).unwrap();
        // 应用重启：恢复
        let n = store.recover_interrupted("acc1").unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.state_of(&t).unwrap(), TaskState::Pending);
        // 恢复后可被 claim（否则任务永久卡死）
        let again = store.claim_batch("acc1", 1).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].rel_path, "crash.txt");
        // 二次恢复无动作
        assert_eq!(store.recover_interrupted("acc1").unwrap(), 0);
    }

    #[test]
    fn dir_mapping_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        assert_eq!(store.get_dir("acc1", "root1", "图片").unwrap(), None);
        store.put_dir("acc1", "root1", "图片", "fid-abc").unwrap();
        assert_eq!(store.get_dir("acc1", "root1", "图片").unwrap().as_deref(), Some("fid-abc"));
        // 幂等覆盖
        store.put_dir("acc1", "root1", "图片", "fid-xyz").unwrap();
        assert_eq!(store.get_dir("acc1", "root1", "图片").unwrap().as_deref(), Some("fid-xyz"));
    }

    #[test]
    fn identity_key_distinguishes_targets() {
        let a = task("a.txt", 1, 1);
        let mut b = task("a.txt", 1, 1);
        b.target_fid = "root2".into();
        assert_ne!(a.identity_key(), b.identity_key());
        assert_eq!(a.identity_key(), task("a.txt", 999, 42).identity_key(), "同键不同内容仍是同一任务");
    }
}
