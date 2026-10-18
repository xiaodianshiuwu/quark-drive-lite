//! 真实账号受控验收：只操作本轮创建的 UUID 测试目录。
//!
//! 验证链路（全部走 Agent 工具层真实实现 → quark-core/quark-transfer → 真实夸克服务端）：
//! 1. 登录态检查（无效则退出并提示扫码，不做任何写操作）；
//! 2. 在根目录创建唯一测试目录 `qk-agent-accept-<uuid>`；
//! 3. 上传一个本地测试文件（upload_file，含 wait）；
//! 4. list_dir 确认可见；
//! 5. delete_entries：dry_run 列目标 → confirm_names 执行 → 逐项核对（NOT_FOUND=已删除）；
//! 6. 删除测试目录本身；
//! 7. 打印台账（仅测试对象），不触碰任何用户原有文件。
//!
//! 运行：
//!   QK_PROFILE_DIR=<资料目录> cargo run -p quark-agent --example agent_acceptance
//! 未设置 QK_PROFILE_DIR 时使用 macOS 默认资料目录。

use quark_agent::config::ScopeSnapshot;
use quark_agent::host::ToolHost;
use quark_agent::journal::Journal;
use quark_agent::plans::PlanStore;
use quark_agent::registry::ToolContext;
use quark_agent::tools::QuarkTools;
use quark_core::Core;
use quark_transfer::TransferManager;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

fn fail(msg: impl Into<String>) -> Value {
    json!({"ok": false, "error": msg.into()})
}

/// 执行工具并把错误转成 JSON（验收程序需要打印失败原因，而不是 panic）。
async fn call(tools: &QuarkTools, ctx: &ToolContext, name: &str, args: Value) -> Value {
    match tools.execute(ctx, name, &args).await {
        Ok(v) => v,
        Err(e) => json!({"error": e.to_json()}),
    }
}

#[tokio::main]
async fn main() {
    let profile = std::env::var_os("QK_PROFILE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(home).join("Library/Application Support/cn.quarkdrive.lite.tauri")
        });
    println!("profile: {}", profile.display());
    let core = match Core::open(profile.clone()) {
        Ok(c) => c,
        Err(e) => {
            println!("{}", fail(format!("无法打开资料目录：{e}")));
            std::process::exit(2);
        }
    };
    let status = match core.call("auth.status", Value::Null).await {
        Ok(v) => v,
        Err(e) => {
            println!("{}", fail(format!("读取登录态失败：{e}")));
            std::process::exit(2);
        }
    };
    let logged_in = status.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    println!("loggedIn: {logged_in}");
    if !logged_in {
        println!(
            "{}",
            fail("登录态无效或已过期：请在客户端扫码登录后重试（本程序不做任何写操作）")
        );
        std::process::exit(3);
    }
    let transfers = match TransferManager::open(core.clone()) {
        Ok(t) => t,
        Err(e) => {
            println!("{}", fail(format!("无法打开传输队列：{e}")));
            std::process::exit(2);
        }
    };
    let host = ToolHost::new(core.clone(), transfers.clone());

    let dir = std::env::temp_dir().join(format!("qk-accept-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    let _ = std::fs::create_dir_all(&dir);
    let journal = Arc::new(Journal::open(&dir).expect("journal"));
    let plans = Arc::new(PlanStore::new());
    let tools = QuarkTools::new(host.clone(), journal, plans);

    let name = format!("qk-agent-accept-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let ledger = json!({"test_dir": name, "created_fids": [], "steps": []});
    println!("{}", ledger);

    // 1) 创建唯一测试目录
    let root_scope = ScopeSnapshot {
        remote_roots: vec!["0".into()],
        write_mode: "scoped-write".into(),
        local_read_roots: vec![],
        local_write_roots: vec![dir.clone()],
    };
    let ctx = ToolContext { actor: "acceptance".into(), generation: core.session_generation(), scope: root_scope.clone() };
    let created = call(&tools, &ctx, "create_folder", json!({"parent_fid": "0", "name": name})).await;
    println!("create_folder: {}", created);
    let dir_fid = created
        .get("created_fid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if dir_fid.is_empty() {
        println!("{}", fail("未能确认测试目录 fid，停止（未触碰其他对象）"));
        std::process::exit(1);
    }
    println!("测试目录 fid: {dir_fid}");

    // 2) 上传测试文件
    let local = dir.join("accept.txt");
    std::fs::write(&local, b"quark-agent acceptance\n").expect("write local");
    let scope = ScopeSnapshot {
        remote_roots: vec![dir_fid.clone()],
        write_mode: "scoped-write".into(),
        local_read_roots: vec![],
        local_write_roots: vec![dir.clone()],
    };
    let ctx = ToolContext { actor: "acceptance".into(), generation: core.session_generation(), scope };
    let up = call(
        &tools,
        &ctx,
        "upload_file",
        json!({"local_path": local.to_string_lossy(), "pdir_fid": dir_fid, "wait": true, "timeout_ms": 300000}),
    )
    .await;
    println!("upload_file: {}", up);
    let uploaded = up.get("wait").and_then(|w| w.get("tasks")).and_then(|t| t.as_array())
        .map(|a| a.iter().all(|t| t.get("status").and_then(|v| v.as_str()) == Some("done")))
        .unwrap_or(false);
    if !uploaded {
        println!("{}", fail("上传未完成，保留现场供排查"));
        std::process::exit(1);
    }

    // 3) 列表确认
    let listed = call(&tools, &ctx, "list_dir", json!({"pdir_fid": dir_fid, "size": 50})).await;
    let visible = listed
        .get("list")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().any(|f| f.get("name").and_then(|v| v.as_str()) == Some("accept.txt")))
        .unwrap_or(false);
    println!("list_dir visible: {visible}");
    if !visible {
        println!("{}", fail("上传文件未在目录中可见"));
        std::process::exit(1);
    }

    // 4) 删除文件：dry_run → confirm_names → 核对
    let file_fid = listed
        .get("list")
        .and_then(|v| v.as_array())
        .and_then(|a| a.iter().find(|f| f.get("name").and_then(|v| v.as_str()) == Some("accept.txt")))
        .and_then(|f| f.get("fid"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let dry = call(&tools, &ctx, "delete_entries", json!({"fids": [file_fid]})).await;
    println!("delete dry_run: {}", dry);
    let del = call(
        &tools,
        &ctx,
        "delete_entries",
        json!({"fids": [file_fid], "dry_run": false, "confirm_names": ["accept.txt"]}),
    )
    .await;
    println!("delete file: {}", del);
    let file_deleted = del
        .get("results")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().all(|r| r.get("status").and_then(|v| v.as_str()) == Some("deleted")))
        .unwrap_or(false);

    // 5) 删除测试目录（文件夹删除连带子项）
    let del_dir = call(
        &tools,
        &ctx,
        "delete_entries",
        json!({"fids": [dir_fid], "dry_run": false, "confirm_names": [name.clone()]}),
    )
    .await;
    println!("delete dir: {}", del_dir);
    let dir_deleted = del_dir
        .get("results")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().all(|r| r.get("status").and_then(|v| v.as_str()) == Some("deleted")))
        .unwrap_or(false);

    let summary = json!({
        "ok": file_deleted && dir_deleted,
        "test_dir": name,
        "dir_fid": dir_fid,
        "upload_visible": visible,
        "file_deleted": file_deleted,
        "dir_deleted": dir_deleted,
        "deleted_to_recycle": del.get("deleted_to_recycle").cloned().unwrap_or(json!(null)),
        "note": "所有对象均为本轮创建的测试对象；删除进入网盘回收站（可恢复）。",
    });
    println!("{}", summary);
    if std::env::var_os("QK_ACCEPTANCE_LEDGER").is_some() {
        let path = dir.join("ledger.json");
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&summary).unwrap_or_default());
        println!("ledger: {}", path.display());
    }
    if !(file_deleted && dir_deleted) {
        std::process::exit(1);
    }
}
