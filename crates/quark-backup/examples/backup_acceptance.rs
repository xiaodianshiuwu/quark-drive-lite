//! 真实账号受控备份验收：UUID 测试目录内 8 个小文件（含中文/空格名 + 子目录），
//! 全流程：plan → start → 等待完成 → verify → 清理。仅操作本轮创建的对象。
//! 运行：QK_PROFILE_DIR=... cargo run -p quark-backup --example backup_acceptance

use quark_core::Core;
use quark_transfer::TransferManager;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

fn fail(m: impl Into<String>) -> Value {
    json!({"ok": false, "error": m.into()})
}

#[tokio::main]
async fn main() {
    let profile = std::env::var_os("QK_PROFILE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/cn.quarkdrive.lite.tauri")
        });
    std::fs::create_dir_all(&profile).expect("profile");
    let _profile_lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(profile.join("app.lock")).expect("profile lock");
    if fs2::FileExt::try_lock_exclusive(&_profile_lock).is_err(){eprintln!("客户端正在使用此资料目录，请先退出客户端后重试验收");std::process::exit(4);}
    let core = match Core::open(profile) {
        Ok(c) => c,
        Err(e) => { println!("{}", fail(format!("打开资料目录失败：{e}"))); std::process::exit(2); }
    };
    if core.call("auth.status", Value::Null).await.unwrap()["loggedIn"] != json!(true) {
        println!("{}", fail("登录态无效：请先在客户端扫码登录（本程序不做任何写操作）"));
        std::process::exit(3);
    }
    if let Ok(fid)=std::env::var("QK_CLEANUP_TEST_FID") {
        let info=core.call("fs.info",json!({"fid":fid})).await.expect("inspect test directory");
        assert!(info["name"].as_str().is_some_and(|n|n.starts_with("qk-bak-accept-")),"refusing to clean a non-test directory");
        let cleaned=cleanup(&core,&fid).await;println!("{}",json!({"test_cleanup_confirmed":cleaned}));if !cleaned{std::process::exit(1);}return;
    }
    let transfers = TransferManager::open(core.clone()).unwrap();

    // 1) 本地测试树：8 文件（含中文/空格）+ 2 子目录
    let local = std::env::temp_dir().join(format!("qk-bk-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    let root = local.join("备份源");
    std::fs::create_dir_all(root.join("子目录 深层")).unwrap();
    std::fs::create_dir_all(root.join("空目录/深层")).unwrap();
    for i in 0..5 {
        std::fs::write(root.join(format!("文件 {i}.txt")), format!("备份内容-{i}-{}", "x".repeat(100))).unwrap();
    }
    std::fs::write(root.join("子目录 深层").join("中文文档.md"), "# 中文标题\n内容\n".repeat(20)).unwrap();
    std::fs::write(root.join("empty.bin"), "").unwrap();
    std::fs::write(root.join("big.dat"), vec![7u8; 300 * 1024]).unwrap();

    // 2) 云端建测试目录
    let name = format!("qk-bak-accept-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let created = core.call("fs.mkdir", json!({"pdirFid": "0", "name": name})).await.unwrap();
    let _ = created;
    // 等 fid
    let mut target_fid = String::new();
    for _ in 0..20 {
        let page = core.call("fs.list", json!({"pdirFid": "0", "page": 1, "size": 50})).await.unwrap();
        if let Some(items) = page["list"].as_array() {
            for x in items {
                if x["name"] == json!(name) && x["dir"] == json!(true) {
                    target_fid = x["fid"].as_str().unwrap_or("").into();
                }
            }
        }
        if !target_fid.is_empty() { break; }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    if target_fid.is_empty() { println!("{}", fail("云端测试目录创建超时")); std::process::exit(1); }
    println!("target fid: {target_fid}");

    // 3) plan 预览
    let plan = quark_backup::BackupManager::plan(core.clone(), root.to_string_lossy().to_string(), target_fid.clone()).await.unwrap();
    println!("plan: files={} dirs={} bytes={}", plan["files"], plan["dirs"], plan["totalBytes"]);
    assert_eq!(plan["files"], json!(8));

    // 4) start（并发 2）
    let mgr = quark_backup::BackupManager::default();
    let profile_dir = std::env::var_os("QK_PROFILE_DIR").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/cn.quarkdrive.lite.tauri"));
    let st = mgr.start(
        core.clone(),
        transfers,
        "acceptance".into(),
        root.to_string_lossy().to_string(),
        target_fid.clone(),
        profile_dir,
        json!({"uploadConcurrency": 2, "retryBaseMs": 1000, "maxAttempts": 2}),
    ).await.unwrap_or_else(|e| {eprintln!("备份启动失败：{e}");std::process::exit(1)});
    println!("started: {}",json!({"status":st["status"],"scanComplete":st["scanComplete"]}));

    // 5) 轮询到终态（最多 5 分钟）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let s = mgr.status().await;
        let pending = s["pending"].as_i64().unwrap_or(0) + s["uploading"].as_i64().unwrap_or(0) + s["verifying"].as_i64().unwrap_or(0);
        let discovered = s["discovered"].as_i64().unwrap_or(0);
        println!("status: success={} failed={} skipped={} pending={pending} discovered={discovered}", s["success"], s["failed"], s["skipped"]);
        if s["scanComplete"]==true && pending == 0 && discovered == 0 { break; }
        if tokio::time::Instant::now() > deadline {
            println!("{}", fail("备份超时未完成"));
            let _ = mgr.cancel().await;
            std::process::exit(1);
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    // 6) verify
    let report = mgr.verify(1_000_000).await.unwrap(); // 100% 抽样（8 个全验）
    println!("verify: {}", serde_json::to_string(&report).unwrap());
    let ok = report["status"] == json!("verified") && report["sample_ok"] == json!(8);

    // 7) 清理云端测试目录 + 本地
    mgr.cancel().await.unwrap();
    let cleaned=cleanup(&core,&target_fid).await;
    let _ = std::fs::remove_dir_all(&local);

    let summary = json!({
        "ok": ok && cleaned,
        "cleanup_confirmed":cleaned,
        "test_dir": name,
        "files": plan["files"],
        "verify_status": report["status"],
        "note": "仅操作本轮测试对象；是否已从正常目录删除以cleanup_confirmed字段为准。",
    });
    println!("{}", summary);
    if !ok || !cleaned { std::process::exit(1); }
}

async fn cleanup(core:&Core,fid:&str)->bool {
    if core.call("fs.remove",json!({"fids":[fid]})).await.is_err(){return false;}
    for _ in 0..15 {match core.call("fs.info",json!({"fid":fid})).await {Err(e) if e.code=="NOT_FOUND"=>return true,_=>tokio::time::sleep(Duration::from_millis(500)).await}}
    false
}
