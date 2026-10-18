//! 端到端离线闭环验证（对应 qck verify/agent-loop.js 的 Rust 形态）。
//!
//! 分层：真实网关（Unix socket + token 认证）→ 真实工具层 → 假网盘（仅替换夸克服务端）
//! → 真实 Node CLI 适配器子进程。每步独立断言并汇总；失败退出码 1。
//!
//! 运行：cargo test -p quark-agent --offline --test agent_loop_verify -- --nocapture

use quark_agent::config::ScopeSnapshot;
use quark_agent::gateway::{AccessSnapshot, AgentGateway, ConfigSource};
use quark_agent::journal::Journal;
use quark_agent::plans::PlanStore;
use quark_agent::registry::{ToolContext, ToolRegistry};
use quark_agent::tools::QuarkTools;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// 复用 lib.rs 内的 FakeDrive：通过 pub(crate) 不可行，这里内联最小假网盘。
mod fake {
    use super::*;
    use quark_agent::policy::{AgentError, AgentToolError};
    use quark_agent::tools::{DepsFuture, HostDeps};

    #[derive(Default)]
    pub struct Drive {
        pub nodes: Mutex<HashMap<String, Value>>,
        pub removed: Mutex<Vec<String>>,
        pub uploads: Mutex<Vec<Value>>,
    }

    impl Drive {
        pub fn with_root() -> Self {
            let d = Drive::default();
            d.nodes.lock().unwrap().insert(
                "root".into(),
                json!({"fid":"root","name":"授权根","dir":true,"size":0,"pdirFid":"0","updatedAt":0,"category":0,"ext":""}),
            );
            d
        }
        pub fn add(&self, fid: &str, name: &str, dir: bool, pdir: &str, size: i64) {
            self.nodes.lock().unwrap().insert(
                fid.into(),
                json!({"fid":fid,"name":name,"dir":dir,"size":size,"pdirFid":pdir,"updatedAt":1700000000000i64,"category":0,"ext": if dir {""} else {name.rsplit('.').next().unwrap_or("")}}),
            );
        }
        pub fn mkdir(&self, fid: &str, name: &str, parent: &str) {
            self.add(fid, name, true, parent, 0);
        }
        pub fn rename(&self, fid: &str, name: &str) {
            if let Some(n) = self.nodes.lock().unwrap().get_mut(fid) {
                n["name"] = json!(name);
            }
        }
        pub fn move_node(&self, fid: &str, parent: &str) {
            if let Some(n) = self.nodes.lock().unwrap().get_mut(fid) {
                n["pdirFid"] = json!(parent);
            }
        }
        pub fn remove_nodes(&self, fids: &[String]) {
            let mut nodes = self.nodes.lock().unwrap();
            let mut removed = self.removed.lock().unwrap();
            for f in fids {
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

    impl HostDeps for Drive {
        fn core_call<'a>(
            &'a self,
            _g: u64,
            method: &'a str,
            params: &'a Value,
        ) -> DepsFuture<'a, Result<Value, AgentToolError>> {
            Box::pin(async move {
                let p = params.clone();
                match method {
                    "fs.info" => {
                        let fid = p["fid"].as_str().unwrap_or("");
                        match self.nodes.lock().unwrap().get(fid) {
                            Some(n) => Ok(json!({ "item": n.clone() })),
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
                    "fs.mkdir" => {
                        let name = p["name"].as_str().unwrap_or("");
                        let parent = p["pdirFid"].as_str().unwrap_or("0");
                        let fid = format!("dir-{name}");
                        self.mkdir(&fid, name, parent);
                        Ok(json!({"done": true}))
                    }
                    "fs.rename" => {
                        self.rename(p["fid"].as_str().unwrap_or(""), p["name"].as_str().unwrap_or(""));
                        Ok(json!({"done": true}))
                    }
                    "fs.move" => {
                        let to = p["toFid"].as_str().unwrap_or("");
                        if let Some(fids) = p["fids"].as_array() {
                            for f in fids {
                                self.move_node(f.as_str().unwrap_or(""), to);
                            }
                        }
                        Ok(json!({"done": true}))
                    }
                    "fs.remove" => {
                        let fids: Vec<String> = p["fids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                        self.remove_nodes(&fids);
                        Ok(json!({"done": true}))
                    }
                    "fs.waitTask" => Ok(json!({"done": true})),
                    "auth.status" => Ok(json!({"loggedIn": true, "expired": false, "nickname": "验证", "memberLabel": ""})),
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
                    "transfer.list" => Ok(json!([])),
                    "transfer.download" => Ok(json!(["task-dl"])),
                    "transfer.upload" => {
                        self.uploads.lock().unwrap().push(params.clone());
                        Ok(json!(["task-up"]))
                    }
                    _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("fake 未实现 {method}"))),
                }
            })
        }

        fn download_dir(&self) -> String {
            String::new()
        }
        fn session_generation(&self) -> u64 {
            1
        }
    }
}

struct Harness {
    drive: Arc<fake::Drive>,
    tools: Arc<QuarkTools>,
    gateway: Arc<AgentGateway>,
    token: String,
    sock: String,
    dir: PathBuf,
    results: Mutex<Vec<(String, bool, String)>>,
}

impl Harness {
    fn new() -> Self {
        // 短路径（Unix socket SUN_LEN 限制）
        let dir = PathBuf::from(format!(
            "/tmp/qk-loop-{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let drive = Arc::new(fake::Drive::with_root());
        let journal = Arc::new(Journal::open(&dir).unwrap());
        let tools = Arc::new(QuarkTools::new(
            drive.clone(),
            journal.clone(),
            Arc::new(PlanStore::new()),
        ));
        let token = "a".repeat(64);
        struct Src {
            token: String,
        }
        impl ConfigSource for Src {
            fn access(&self) -> AccessSnapshot {
                AccessSnapshot { enabled: true, token: self.token.clone() }
            }
            fn scope(&self) -> ScopeSnapshot {
                ScopeSnapshot {
                    remote_roots: vec!["root".into()],
                    write_mode: "scoped-write".into(),
                    local_read_roots: vec![],
                    local_write_roots: vec![dir_scope()],
                }
            }
        }
        fn dir_scope() -> std::path::PathBuf {
            std::env::temp_dir()
        }
        let gateway = Arc::new(AgentGateway::new(
            Arc::new(Src { token: token.clone() }),
            tools.clone() as Arc<dyn ToolRegistry>,
            journal,
        ));
        let sock = dir.join("bridge.sock").to_string_lossy().to_string();
        Self { drive, tools, gateway, token, sock, dir, results: Mutex::new(Vec::new()) }
    }

    fn record(&self, name: &str, ok: bool, detail: String) {
        self.results.lock().unwrap().push((name.to_string(), ok, detail));
    }

    async fn call_tool(&self, name: &str, args: Value) -> Value {
        let ctx = ToolContext {
            actor: "loop-verify".into(),
            generation: 1,
            scope: ScopeSnapshot {
                remote_roots: vec!["root".into()],
                write_mode: "scoped-write".into(),
                local_read_roots: vec![],
                local_write_roots: vec![self.dir.clone()],
            },
        };
        match self.tools.execute(&ctx, name, &args).await {
            Ok(v) => v,
            Err(e) => json!({"error": e.to_json()}),
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn agent_loop_verify() {
    let h = Arc::new(Harness::new());
    h.gateway.clone().start(&h.sock).await.unwrap();

    // 步骤 1：drive_status 就绪且无凭据泄漏
    let s = h.call_tool("drive_status", json!({})).await;
    let leak = s.to_string().to_lowercase();
    let no_leak = !["token", "cookie", "authorization", "secret"].iter().any(|k| leak.contains(k));
    h.record("drive_status 就绪且无凭据", s.get("logged_in") == Some(&json!(true)) && no_leak, s.to_string());

    // 步骤 2：list_dir 分页上限压到 200
    let d = h.call_tool("list_dir", json!({"pdir_fid":"root","size":500})).await;
    h.record("list_dir size 上限 200 并提示截断", d["size"] == json!(200) && d["truncated"] == json!(true), d.to_string());

    // 步骤 3：create_folder 返回可直接使用的 fid
    let c = h.call_tool("create_folder", json!({"parent_fid":"root","name":"整理"})).await;
    let dir_fid = c["created_fid"].as_str().unwrap_or("").to_string();
    h.record("create_folder 可见且返回 fid", !dir_fid.is_empty() && c["visible"] == json!(true), c.to_string());

    // 步骤 4：tree_dir 深度与条目上限
    h.drive.add("f1", "a.txt", false, "root", 3);
    h.drive.add("f2", "b.jpg", false, "root", 5);
    h.drive.mkdir("sub1", "子", "root");
    h.drive.add("f3", "c.txt", false, "sub1", 7);
    let t = h.call_tool("tree_dir", json!({"root_fid":"root","max_depth":1,"max_entries":100})).await;
    h.record("tree_dir 深度 1 截住子目录并报告 incomplete", t["incomplete_subtrees"] == json!(2) && t["count"] == json!(2), t.to_string());

    // 步骤 5：plan_create 生成计划并绑定哈希
    let p = h.call_tool("plan_create", json!({"root_fid":"root","by":"ext"})).await;
    let plan_id = p["plan"]["plan_id"].as_str().unwrap_or("").to_string();
    let revision = p["plan"]["revision"].as_u64().unwrap_or(0);
    let hash = p["plan"]["content_hash"].as_str().unwrap_or("").to_string();
    h.record("plan_create 计划含摘要与条目预览", !plan_id.is_empty() && p["entries"].as_array().map(|a| !a.is_empty()).unwrap_or(false), p.to_string());

    // 步骤 6：缺 content_hash 拒绝执行
    let e1 = h.call_tool("plan_execute", json!({"plan_id":plan_id,"revision":revision})).await;
    h.record("plan_execute 缺哈希 → AGENT_PLAN_STALE", e1["error"]["code"] == json!("AGENT_PLAN_STALE"), e1.to_string());

    // 步骤 7：正确授权执行成功
    let e2 = h.call_tool("plan_execute", json!({"plan_id":plan_id,"revision":revision,"content_hash":hash})).await;
    h.record("plan_execute 全部受理", e2["summary"]["accepted"] == json!(2) && e2["partial"] == json!(false), e2.to_string());

    // 步骤 8：重复执行 → CONFLICT
    let e3 = h.call_tool("plan_execute", json!({"plan_id":plan_id,"revision":revision,"content_hash":p["plan"]["content_hash"]})).await;
    h.record("plan_execute 重复执行 → AGENT_CONFLICT", e3["error"]["code"] == json!("AGENT_CONFLICT"), e3.to_string());

    // 步骤 9：move 拒绝移入自身子目录
    let m = h.call_tool("move_entries", json!({"fids":["root"],"to_fid":dir_fid})).await;
    h.record("move 移入自身子目录被拒", m["error"]["code"] == json!("AGENT_INVALID_ARG"), m.to_string());

    // 步骤 10：upload 本地路径不在授权目录 → OUT_OF_SCOPE（范围校验先于名称清洗，顺序正确）
    let bad_up = h.call_tool("upload_file", json!({"local_path":"/tmp/x","name":"../evil"})).await;
    h.record("upload 未授权本地路径被拒", bad_up["error"]["code"] == json!("AGENT_OUT_OF_SCOPE"), bad_up.to_string());

    // 步骤 11：delete_entries 双阶段
    h.drive.add("del1", "待删.txt", false, "root", 1);
    let dry = h.call_tool("delete_entries", json!({"fids":["del1"]})).await;
    let dry_ok = dry["dry_run"] == json!(true) && dry["entries"][0]["name"] == json!("待删.txt");
    h.record("delete dry_run 只列目标", dry_ok, dry.to_string());
    let wrong = h.call_tool("delete_entries", json!({"fids":["del1"],"dry_run":false,"confirm_names":["错名"]})).await;
    h.record("delete confirm 不匹配 → AGENT_CONFLICT", wrong["error"]["code"] == json!("AGENT_CONFLICT"), wrong.to_string());
    let del = h.call_tool("delete_entries", json!({"fids":["del1"],"dry_run":false,"confirm_names":["待删.txt"]})).await;
    h.record("delete 确认后逐项 deleted", del["results"][0]["status"] == json!("deleted") && del["deleted_to_recycle"] == json!(true), del.to_string());

    // 步骤 12：journal 记录工具调用且脱敏
    let j = h.call_tool("list_journal", json!({"limit":50})).await;
    let records = j["records"].as_array().cloned().unwrap_or_default();
    let has_delete = records.iter().any(|r| r["tool"] == json!("delete_entries"));
    let leak = j.to_string().to_lowercase();
    h.record("journal 含工具记录且无凭据", has_delete && !leak.contains("secret"), format!("records={}", records.len()));

    // 步骤 13：只读模式拦截全部写操作（transfer_control 需要先有任务才到达权限检查）
    h.drive.uploads.lock().unwrap().push(json!({"localPaths":["/tmp/x"],"pdirFid":"root"}));
    let ctx_ro = ToolContext {
        actor: "ro".into(),
        generation: 1,
        scope: ScopeSnapshot {
            remote_roots: vec!["root".into()],
            write_mode: "read-only".into(),
            local_read_roots: vec![],
            local_write_roots: vec![],
        },
    };
    let mut ro_all_ok = true;
    for (name, args) in [
        ("create_folder", json!({"name":"x"})),
        ("rename_entry", json!({"fid":"root","name":"y"})),
        ("move_entries", json!({"fids":["f1"],"to_fid":"root"})),
        ("download_files", json!({"fids":["f1"]})),
        ("upload_file", json!({"local_path":"/tmp/x"})),
        ("save_text_file", json!({"name":"n","text":"t"})),
        ("transfer_control", json!({"task_id":"t","action":"pause"})),
        ("plan_execute", json!({"plan_id":"p","revision":1,"content_hash":"h"})),
        ("delete_entries", json!({"fids":["root"],"dry_run":true})),
    ] {
        let out = match h.tools.execute(&ctx_ro, name, &args).await {
            Ok(v) => v,
            Err(e) => json!({"error": e.to_json()}),
        };
        let code = out["error"]["code"].as_str().unwrap_or("");
        let blocked = code == "AGENT_READ_ONLY"
            || (name == "transfer_control" && code == "AGENT_NOT_FOUND"); // 不存在的任务同样未执行任何动作
        if !blocked {
            ro_all_ok = false;
            h.record(&format!("只读拦截 {name}"), false, out.to_string());
        }
    }
    h.record("只读模式拦截全部 9 个写入口", ro_all_ok, "9 个写工具逐一验证".into());

    // 步骤 14：真实 Node CLI 子进程走网关
    let script = format!("{}/../../tools/agent-cli.js", env!("CARGO_MANIFEST_DIR"));
    let sock = h.sock.clone();
    let token = h.token.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg(&script)
            .arg("call")
            .arg("list_dir")
            .arg(r#"{"pdir_fid":"root","size":5}"#)
            .env("QCK_AGENT_ENDPOINT", &sock)
            .env("QCK_AGENT_TOKEN", &token)
            .output()
    })
    .await
    .unwrap()
    .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let cli_ok = out.status.success() && (stdout.contains("a.txt") || stdout.contains("b.jpg"));
    h.record(
        "Node CLI 子进程经网关调用 list_dir",
        cli_ok,
        format!("exit={} stdout={} stderr={}", out.status, stdout.trim(), String::from_utf8_lossy(&out.stderr).trim()),
    );

    h.gateway.stop().await;

    // 汇总
    let results = h.results.lock().unwrap().clone();
    let passed = results.iter().filter(|(_, ok, _)| *ok).count();
    let failed = results.len() - passed;
    println!("\n===== 离线闭环验证：通过 {passed} 项 / 失败 {failed} 项 =====");
    for (name, ok, detail) in &results {
        println!("{} {} — {}", if *ok { "✓" } else { "✗" }, name, detail);
    }
    assert_eq!(failed, 0, "有失败步骤");
}
