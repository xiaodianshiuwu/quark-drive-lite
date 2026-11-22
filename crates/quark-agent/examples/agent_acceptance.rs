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

// Optional broad acceptance stays inside the UUID directory and the owned local fixture.
async fn full_acceptance(tools:&QuarkTools,ctx:&ToolContext,root:&str,file:&str,local:&std::path::Path,dir:&std::path::Path)->Result<Vec<String>,String> {
    async fn checked(tools:&QuarkTools,ctx:&ToolContext,name:&str,args:Value)->Result<Value,String>{
        let value=call(tools,ctx,name,args).await;
        if value.get("error").is_some(){Err(format!("{name}: {}",value["error"]))}else{Ok(value)}
    }
    fn need(ok:bool,name:&str)->Result<(),String>{if ok{Ok(())}else{Err(format!("业务结果未达到预期：{name}"))}}
    let mut checks=Vec::new();
    let st=checked(tools,ctx,"drive_status",json!({})).await?;need(st["logged_in"]==true,"drive_status")?;checks.push("drive_status".into());
    let info=checked(tools,ctx,"file_info",json!({"fid":file})).await?;need(info["item"]["name"]=="accept.txt","file_info")?;checks.push("file_info".into());
    let search=checked(tools,ctx,"search_files",json!({"keyword":"accept.txt","only_in_scope":true})).await?;
    need(search["list"].as_array().is_some_and(|a|a.iter().any(|v|v["fid"]==file)),"search_files")?;checks.push("search_files".into());
    let tree=checked(tools,ctx,"tree_dir",json!({"root_fid":root,"max_depth":4})).await?;need(tree["count"].as_u64().unwrap_or(0)>0,"tree_dir")?;checks.push("tree_dir".into());
    let text=checked(tools,ctx,"read_text_file",json!({"path":local})).await?;need(text["text"].as_str().is_some_and(|s|s.contains("quark-agent acceptance")),"read_text_file")?;checks.push("read_text_file".into());
    let saved=checked(tools,ctx,"save_text_file",json!({"name":"extra.txt","text":"agent extra fixture\n","pdir_fid":root,"wait":true,"verify":true,"timeout_ms":300000})).await?;
    need(saved["verification"]["status"]=="visible","save_text_file")?;checks.push("save_text_file".into());
    let extra=saved["verification"]["fid"].as_str().ok_or("extra fid absent")?;
    let renamed=checked(tools,ctx,"rename_entry",json!({"fid":extra,"name":"extra.md"})).await?;need(renamed["accepted"]==true,"rename_entry受理")?;
    let mut renamed_visible=false;for _ in 0..30{let info=checked(tools,ctx,"file_info",json!({"fid":extra})).await?;if info["item"]["name"]=="extra.md"{renamed_visible=true;break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}need(renamed_visible,"rename_entry名称核对")?;checks.push("rename_entry".into());
    let made=checked(tools,ctx,"create_folder",json!({"parent_fid":root,"name":"copy-destination"})).await?;
    let destination=made["created_fid"].as_str().ok_or("destination absent")?;
    let copied=checked(tools,ctx,"copy_entries",json!({"fids":[extra],"to_fid":destination})).await?;need(copied["accepted"]==true && copied["executed"]==true,"copy_entries受理")?;
    let mut copied_fid=String::new();
    for _ in 0..30 {let page=checked(tools,ctx,"list_dir",json!({"pdir_fid":destination})).await?;if let Some(item)=page["list"].as_array().and_then(|a|a.iter().find(|v|v["name"]=="extra.md")){copied_fid=item["fid"].as_str().unwrap_or("").into();break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}
    need(!copied_fid.is_empty(),"copy_entries远端可见")?;checks.push("copy_entries".into());
    let renamed=checked(tools,ctx,"rename_entry",json!({"fid":extra,"name":"moved.md"})).await?;need(renamed["accepted"]==true,"rename before move")?;
    let mut renamed_visible=false;for _ in 0..30{let info=checked(tools,ctx,"file_info",json!({"fid":extra})).await?;if info["item"]["name"]=="moved.md"{renamed_visible=true;break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}need(renamed_visible,"rename before move核对")?;
    let moved=checked(tools,ctx,"move_entries",json!({"fids":[extra],"to_fid":destination})).await?;need(moved["accepted"]==true && moved["executed"]==true,"move_entries受理")?;
    let mut move_visible=false;for _ in 0..30{let info=checked(tools,ctx,"file_info",json!({"fid":extra})).await?;if info["item"]["pdirFid"]==destination{move_visible=true;break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}need(move_visible,"move_entries父目录核对")?;checks.push("move_entries".into());
    let download_dir=dir.join("downloaded");std::fs::create_dir_all(&download_dir).map_err(|e|e.to_string())?;
    let down=checked(tools,ctx,"download_files",json!({"fids":[&copied_fid],"local_dir":download_dir,"wait":false})).await?;
    let id=down["task_ids"][0].as_str().ok_or("download task absent")?;
    checked(tools,ctx,"transfer_control",json!({"task_id":id,"action":"pause"})).await?;
    checked(tools,ctx,"transfer_control",json!({"task_id":id,"action":"resume"})).await?;checks.push("transfer_control".into());
    let mut done=false;for _ in 0..120{let tasks=checked(tools,ctx,"list_transfers",json!({"task_ids":[id]})).await?;if tasks["tasks"].as_array().is_some_and(|a|a.iter().any(|v|v["id"]==id && v["status"]=="done")){done=true;break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}
    need(done,"download_files完成")?;need(std::fs::read(download_dir.join("extra.md")).map_err(|e|e.to_string())?==b"agent extra fixture\n","download_files正文一致")?;checks.extend(["download_files".into(),"list_transfers".into()]);
    let plan=checked(tools,ctx,"plan_create",json!({"root_fid":root,"by":"ext","include_subdirs":true})).await?;
    let plan_id=plan["plan"]["plan_id"].as_str().ok_or("plan id absent")?;checks.push("plan_create".into());
    let details=checked(tools,ctx,"get_plan",json!({"plan_id":plan_id})).await?;need(details["plan"]["plan_id"]==plan_id && details["plan"]["entries"].as_array().is_some_and(|a|!a.is_empty()),"get_plan")?;checks.push("get_plan".into());
    let executed=checked(tools,ctx,"plan_execute",json!({"plan_id":plan_id,"revision":plan["plan"]["revision"],"content_hash":plan["plan"]["content_hash"]})).await?;need(executed["summary"]["accepted"].as_u64().unwrap_or(0)>0 && executed["partial"]==false,"plan_execute")?;checks.push("plan_execute".into());
    for result in executed["results"].as_array().ok_or("plan results absent")? {
        if result["status"]!="accepted"{continue;}
        let mut observed=false;
        for _ in 0..30{let info=checked(tools,ctx,"file_info",json!({"fid":result["fid"]})).await?;if info["item"]["pdirFid"]==result["to_fid"]{observed=true;break;}tokio::time::sleep(std::time::Duration::from_secs(1)).await;}
        need(observed,"plan_execute移动结果核对")?;
    }
    let journal=checked(tools,ctx,"list_journal",json!({"limit":50})).await?;need(journal["records"].as_array().is_some_and(|a|!a.is_empty()),"list_journal")?;checks.push("list_journal".into());
    Ok(checks)
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
    std::fs::create_dir_all(&profile).expect("profile");
    let _profile_lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(profile.join("app.lock")).expect("profile lock");
    if fs2::FileExt::try_lock_exclusive(&_profile_lock).is_err(){eprintln!("客户端正在使用此资料目录，请先退出客户端后重试验收");std::process::exit(4);}
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
        allow_delete: true,
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
        allow_delete: true,
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
    let full=if std::env::var_os("QK_AGENT_FULL").is_some(){Some(full_acceptance(&tools,&ctx,&dir_fid,&file_fid,&local,&dir).await)}else{None};
    if let Some(result)=&full {println!("full_acceptance: {}",match result{Ok(v)=>json!({"ok":true,"checks":v}),Err(e)=>json!({"ok":false,"error":e})});}
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

    let ok=visible && file_deleted && dir_deleted && del["accepted"]==true && del_dir["accepted"]==true && del["deleted_to_recycle"]==true && del_dir["deleted_to_recycle"]==true && full.as_ref().is_none_or(|r|r.is_ok());
    let summary = json!({
        "ok": ok,
        "accepted": del["accepted"],
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
    if !ok {
        std::process::exit(1);
    }
}
