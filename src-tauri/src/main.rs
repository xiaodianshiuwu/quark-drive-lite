#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use quark_agent::host::ToolHost;
use quark_agent::runtime::AgentRuntime;
use quark_core::{
    hub::{HubClient, HubConfig},
    Core, Error, Result,
};
use quark_transfer::TransferManager;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

#[cfg(target_os = "linux")]
mod linux_desktop;

#[derive(Clone)]
struct State {
    core: Core,
    transfers: TransferManager,
    /// Agent 子系统（工具层 + 网关 + 内置对话）。
    agent: Arc<AgentRuntime>,
    /// 可选作者服务器客户端（默认关闭，未开启时零外传）。
    hub: HubClient,
    /// L2 前端签名热更新状态与看门狗确认标记。
    hot_ui_confirmed: Arc<AtomicBool>,
    hot_ui_active: Arc<AtomicBool>,
    login: Arc<AtomicBool>,
    logging_out: Arc<AtomicBool>,
    login_generation: Arc<AtomicU64>,
    account_control: Arc<tokio::sync::Mutex<()>>,
    _profile_lock: Arc<std::fs::File>,
}

const HOT_UI_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost https://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

fn hot_ui_entry_url() -> tauri::Url {
    #[cfg(target_os = "windows")]
    let raw = "http://qdl-ui.localhost/index.html";
    #[cfg(not(target_os = "windows"))]
    let raw = "qdl-ui://localhost/index.html";
    tauri::Url::parse(raw).expect("valid hot-ui url")
}

fn builtin_ui_entry_url() -> tauri::Url {
    #[cfg(target_os = "windows")]
    let raw = "http://tauri.localhost/index.html";
    #[cfg(not(target_os = "windows"))]
    let raw = "tauri://localhost/index.html";
    tauri::Url::parse(raw).expect("valid builtin url")
}

fn arm_hot_ui_watchdog(
    window: tauri::WebviewWindow,
    profile: PathBuf,
    confirmed: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    hub: HubClient,
) {
    confirmed.store(false, Ordering::SeqCst);
    active.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        if active.load(Ordering::SeqCst) && !confirmed.load(Ordering::SeqCst) {
            quark_core::hot_ui::rollback(&profile, env!("CARGO_PKG_VERSION"), true);
            active.store(false, Ordering::SeqCst);
            hub.record_event(
                "warn",
                "hot_ui",
                Some("HOT_UI_ROLLBACK"),
                "hot UI boot watchdog timed out; rolled back to built-in UI",
            );
            let _ = window.navigate(builtin_ui_entry_url());
        }
    });
}

fn shell_error(e: impl std::fmt::Display) -> Error {
    Error::new("SYSTEM", e.to_string())
}

fn trusted(window: &tauri::WebviewWindow) -> bool {
    window.label() == "main"
        && window.url().is_ok_and(|u| {
            u.scheme() == "tauri"
                || u.scheme() == "qdl-ui"
                || ((u.scheme() == "http" || u.scheme() == "https")
                    && matches!(u.host_str(), Some("tauri.localhost" | "qdl-ui.localhost")))
        })
}

#[tauri::command]
async fn qk_call(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    method: String,
    params: Value,
) -> Result<Value> {
    if !trusted(&window) {
        return Err(Error::new("FORBIDDEN", "只允许应用主界面调用"));
    }
    let started = std::time::Instant::now();
    let result = qk_call_inner(&window, &app, &state, &method, params).await;
    let dur_ms = started.elapsed().as_millis() as u64;
    match &result {
        Err(err) if err.code != "ABORTED" && err.code != "OPT_IN_REQUIRED" => {
            let level = if method == "auth.login" && err.code == "TIMEOUT" {
                "warn"
            } else {
                "error"
            };
            let mut meta_obj = serde_json::Map::new();
            meta_obj.insert("method".into(), json!(method));
            if let Some(ref k) = err.io_kind {
                meta_obj.insert("ioKind".into(), json!(k));
            }
            if let Some(eno) = err.os_errno {
                meta_obj.insert("osErrno".into(), json!(eno));
            }
            state.hub.record_event_rich(
                level,
                method.split('.').next().unwrap_or("ipc"),
                Some(&err.code),
                &format!("{} failed ({})", method, err.code),
                err.http_status,
                err.biz_code,
                Some(dur_ms),
                Some(Value::Object(meta_obj)),
            );
        }
        Ok(_)
            if dur_ms >= 3000
                && !method.starts_with("dialog.")
                && !matches!(
                    method.as_str(),
                    "auth.login"
                        | "hub.downloadUpdate"
                        | "hub.installUpdate"
                        | "chat.send"
                        | "fs.taskStatus"
                        | "archive.unarchive"
                ) =>
        {
            state.hub.record_event_rich(
                "warn",
                "slow_api",
                Some("SLOW_CALL"),
                &format!("{} slow ({}ms)", method, dur_ms),
                None,
                None,
                Some(dur_ms),
                Some(json!({ "method": method })),
            );
        }
        _ => {}
    }
    result
}

async fn qk_call_inner(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
    state: &tauri::State<'_, State>,
    method: &str,
    params: Value,
) -> Result<Value> {
    if method == "app.quit" {
        app.exit(0);
        return Ok(Value::Null);
    }
    if method == "app.info" {
        return Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "runtime": "Tauri 2 + Rust",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        }));
    }
    if method == "auth.login" {
        let res = login(app.clone(), state.inner().clone()).await;
        if res.is_ok() {
            state.transfers.notify_change();
        }
        return res;
    }
    if (state.login.load(Ordering::SeqCst) || state.logging_out.load(Ordering::SeqCst))
        && matches!(
            method,
            "transfer.upload"
                | "transfer.download"
                | "transfer.resume"
                | "transfer.retry"
                | "transfer.resumeAll"
                | "transfer.retryFailed"
        )
    {
        return Err(Error::new("CONFLICT", "账号状态切换中，请稍后再启动传输"));
    }
    if method.starts_with("dialog.") {
        return dialog(app, window, method, params).await;
    }
    if method.starts_with("hub.") {
        let ver = env!("CARGO_PKG_VERSION");
        return match method {
            "hub.config" => Ok(state.hub.config_info(ver)),
            "hub.setOptIn" => {
                let opt_in = params["optIn"].as_bool().unwrap_or(false);
                state.hub.set_opt_in(opt_in, ver)
            }
            "hub.checkUpdate" => state.hub.check_update(ver).await,
            "hub.downloadUpdate" => {
                let asset_key = params["assetKey"].as_str();
                let local_dir = params["localDir"].as_str();
                let ev_handle = app.clone();
                state
                    .hub
                    .download_update(ver, asset_key, local_dir, move |prog| {
                        let _ = ev_handle.emit_to("main", "qk:update-progress", prog);
                    })
                    .await
            }
            "hub.installUpdate" => install_verified_update(app, state, params).await,
            "hub.openReleasePage" => {
                open::that(quark_core::hub::GITHUB_RELEASES_URL).map_err(shell_error)?;
                Ok(json!({ "ok": true, "url": quark_core::hub::GITHUB_RELEASES_URL }))
            }
            "hub.runtimeStatus" => Ok(state.hub.runtime_status(ver)),
            "hub.applyUiHotfix" => state.hub.apply_ui_hotfix(ver).await,
            "hub.reloadUi" => {
                let profile = state.core.profile_dir();
                if let Some(active_ver) = quark_core::hot_ui::prepare_boot(&profile, ver) {
                    arm_hot_ui_watchdog(
                        window.clone(),
                        profile,
                        state.hot_ui_confirmed.clone(),
                        state.hot_ui_active.clone(),
                        state.hub.clone(),
                    );
                    window.navigate(hot_ui_entry_url()).map_err(shell_error)?;
                    Ok(json!({ "ok": true, "mode": "hot-ui", "version": active_ver }))
                } else {
                    state.hot_ui_active.store(false, Ordering::SeqCst);
                    window
                        .navigate(builtin_ui_entry_url())
                        .map_err(shell_error)?;
                    Ok(json!({ "ok": true, "mode": "builtin", "version": ver }))
                }
            }
            "hub.uiReady" => {
                state.hot_ui_confirmed.store(true, Ordering::SeqCst);
                let st = quark_core::hot_ui::mark_boot_ready(&state.core.profile_dir(), ver);
                Ok(json!({
                    "ok": true,
                    "activeVersion": st.active_version,
                    "tuning": state.core.tuning().to_value()
                }))
            }
            "hub.rollbackUi" => {
                let blacklist = params["blacklist"].as_bool().unwrap_or(false);
                quark_core::hot_ui::rollback(&state.core.profile_dir(), ver, blacklist);
                state.hot_ui_active.store(false, Ordering::SeqCst);
                window
                    .navigate(builtin_ui_entry_url())
                    .map_err(shell_error)?;
                Ok(json!({ "ok": true, "rolledBack": true }))
            }
            "hub.sendTelemetry" => state.hub.send_telemetry(ver, params).await,
            "hub.flushTelemetry" => state.hub.flush_transfer_telemetry(ver).await,
            "hub.submitFeedback" => state.hub.submit_feedback(ver, params).await,
            "hub.listFeedback" => state.hub.list_feedback().await,
            "hub.replyFeedback" => state.hub.reply_feedback(params).await,
            "hub.logPreview" => Ok(json!({ "logs": state.hub.log_preview() })),
            "hub.recordEvent" => {
                state.hub.record_event_rich(
                    params["level"].as_str().unwrap_or("info"),
                    params["category"].as_str().unwrap_or("ui"),
                    params["code"].as_str(),
                    params["msg"].as_str().unwrap_or(""),
                    params["httpStatus"].as_u64().and_then(|n| u16::try_from(n).ok()),
                    params["bizCode"].as_i64(),
                    params["durationMs"].as_u64(),
                    params.get("meta").cloned(),
                );
                Ok(json!({ "ok": true }))
            }
            _ => Err(Error::new("INVALID_ARG", "未知服务接口")),
        };
    }
    if method == "transfer.openItem" {
        let id = params["id"].as_str().unwrap_or_default();
        let task = state.transfers.task_status(id)?;
        let local_path = task["localPath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let local_dir = task["localDir"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let path = match (local_path, local_dir) {
            (Some(p), _) if p.exists() => p,
            (_, Some(d)) if d.exists() => d,
            (Some(p), _) => p,
            (None, Some(d)) => d,
            (None, None) => return Err(Error::new("NOT_FOUND", "本地路径不存在")),
        };
        return open_local(path, true).await;
    }
    struct LogoutGuard(Arc<AtomicBool>);
    impl Drop for LogoutGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let (_account_guard, _logout_guard) = if method == "auth.logout" {
        state.logging_out.store(true, Ordering::SeqCst);
        let guard = LogoutGuard(state.logging_out.clone());
        state.login_generation.fetch_add(1, Ordering::SeqCst);
        (Some(state.account_control.lock().await), Some(guard))
    } else {
        (None, None)
    };
    if method == "auth.logout" {
        if let Some(login) = app.get_webview_window("login") {
            let _ = login.clear_all_browsing_data();
            let _ = login.close();
        }
        state.transfers.pause_all().await?;
    }
    let ai_beta_patched = method == "settings.set" && params.get("aiBetaEnabled").is_some();
    let result = if method.starts_with("agent.") || method.starts_with("chat.") {
        // 事件回调：对话过程中的工具进度实时推送到界面（事件不含凭据）。
        let event_handle = app.clone();
        let event: quark_agent::chat::EventCallback = Arc::new(move |ev: Value| {
            let _ = event_handle.emit_to("main", "qk:chat-event", ev);
        });
        state
            .agent
            .handle(method, params, Some(event))
            .await
            .map_err(|e| {
                // ① code：raw_code（白名单上游语义，如 NEED_LOGIN）优先——
                //    保证下方 NEED_LOGIN → qk:auth-changed 重新登录链路对 agent/chat 失败同样生效；
                //    其余用 AGENT_ 前缀稳定码。② core::Error 无 hint 字段：操作提示并入 message
                //    （渲染层展示 message），避免「只读模式不能写」这类可操作指引丢失。
                let code_out = e.raw_code.clone().unwrap_or_else(|| e.code.as_str().to_string());
                let mut message = e.message.clone();
                if let Some(h) = &e.hint {
                    message.push_str("（提示：");
                    message.push_str(h);
                    message.push('）');
                }
                if let Some(u) = &e.upstream_message {
                    message.push_str(&format!("（上游：{u}）"));
                }
                Error::new(code_out, message)
            })
    } else if method.starts_with("transfer.") {
        state.transfers.call(method, params).await
    } else {
        state.core.call(method, params).await
    };
    if method == "auth.logout" && result.is_ok() {
        // 必须在 state.core.call("auth.logout") 递增 session_generation 之后再清空 Agent 内存态，
        // 消除在途 chat.send() 在登出窗口内回写旧账号消息的竞态。
        state.agent.reset_for_account_change();
        state.transfers.notify_change();
    }
    if method == "settings.set" {
        if let Ok(ref saved) = result {
            state.transfers.notify_scheduler();
            if ai_beta_patched {
                if saved.get("aiBetaEnabled").and_then(|v| v.as_bool()) == Some(true) {
                    state.agent.boot().await;
                } else {
                    state.agent.suspend_gateway().await;
                }
            }
        }
    }
    if method.starts_with("auth.")
        || result
            .as_ref()
            .err()
            .is_some_and(|e| e.code == "NEED_LOGIN")
    {
        if let Ok(auth) = state.core.call("auth.status", Value::Null).await {
            let _ = app.emit_to("main", "qk:auth-changed", auth);
        }
    }
    result
}

async fn login(app: tauri::AppHandle, state: State) -> Result<Value> {
    if state.login.swap(true, Ordering::SeqCst) {
        return Err(Error::new("CONFLICT", "登录窗口已打开"));
    }
    struct Reset(Arc<AtomicBool>);
    impl Drop for Reset {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset(state.login.clone());
    state.transfers.pause_all().await?;
    let generation = state.login_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "login",
        tauri::WebviewUrl::External("https://pan.quark.cn/".parse().unwrap()),
    )
    .title("登录夸克网盘 · 扫码后自动返回")
    .inner_size(1000., 760.)
    .incognito(true)
    .on_navigation(|url| {
        url.scheme() == "https"
            && url.host_str().is_some_and(|h| {
                h == "quark.cn" || h.ends_with(".quark.cn") || h == "uc.cn" || h.ends_with(".uc.cn")
            })
    })
    .build()
    .map_err(shell_error)?;
    let is_current_login = || {
        app.get_webview_window("login").is_some()
            && state.login_generation.load(Ordering::SeqCst) == generation
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let result=async {
        let mut last=String::new();
        while tokio::time::Instant::now()<deadline {
            if !is_current_login() { return Err(Error::new("ABORTED", "登录已取消")); }
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if !is_current_login() { return Err(Error::new("ABORTED", "登录已取消")); }
            let w = window.clone();
            // Cookie APIs may block on WebView2; never call them on the UI thread.
            let cookies = tauri::async_runtime::spawn_blocking(move || w.cookies())
                .await
                .map_err(shell_error)?;
            if !is_current_login() { return Err(Error::new("ABORTED", "登录已取消")); }
            let cookies = cookies.map_err(shell_error)?;
            let items:Vec<Value>=cookies.iter().filter(|c|{
                let d=c.domain().unwrap_or("").trim_start_matches('.').to_ascii_lowercase();
                d=="quark.cn"||d.ends_with(".quark.cn")
            }).map(|c|json!({"name":c.name(),"value":c.value(),"domain":c.domain(),"path":c.path().unwrap_or("/"),"httpOnly":c.http_only().unwrap_or(false),"secure":c.secure().unwrap_or(false),"expires":c.expires_datetime().map(|t|t.unix_timestamp())})).collect();
            let header=Core::cookies_for_api(Value::Array(items.clone()))?;
            if header.is_empty()||header==last {continue;}
            let Ok(mut cookie_hdr) = tauri::http::HeaderValue::from_str(&header) else {
                continue;
            };
            cookie_hdr.set_sensitive(true);
            let response=state.core.http_client().get("https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc")
                .query(&[("uc_param_str",quark_core::UC_PARAMS),("device_model","pc")])
                .header("cookie",cookie_hdr).header("referer","https://pan.quark.cn/").header("origin","https://pan.quark.cn")
                .timeout(Duration::from_secs(20)).send().await;
            if let Ok(response)=response {
                if response.status().as_u16()==401 {last=header.clone();}
                if response.status().is_success() {
                if let Ok(envelope)=response.json::<Value>().await {
                    let biz_code = envelope["code"].as_i64().or_else(|| envelope["code"].as_str().and_then(|s| s.parse().ok()));
                    if biz_code == Some(31001) {
                        last = header.clone();
                        continue;
                    }
                    if biz_code == Some(0) {
                    let _account_guard=state.account_control.lock().await;
                    if app.get_webview_window("login").is_none() || state.login_generation.load(Ordering::SeqCst)!=generation {return Err(Error::new("ABORTED","登录已取消"));}
                    state.transfers.pause_all().await?;
                    state.core.replace_cookies(Value::Array(items))?;
                    state.agent.reset_for_account_change();
                    let verify_res = state.core.call("auth.verify",Value::Null).await;
                    if verify_res.is_err() {
                        if let Ok(auth) = state.core.call("auth.status", Value::Null).await {
                            let _ = app.emit_to("main", "qk:auth-changed", &auth);
                        }
                        verify_res?;
                    }
                    let _=state.core.call("auth.getUserInfo",Value::Null).await;
                    let auth=state.core.call("auth.status",Value::Null).await?;
                    if state.login_generation.load(Ordering::SeqCst)!=generation {return Err(Error::new("ABORTED","登录已取消"));}
                    let _=app.emit_to("main","qk:auth-changed",&auth);
                    #[cfg(debug_assertions)]
                    if let Some(path)=std::env::var_os("QK_AUTH_REPORT") {
                        let _=std::fs::write(path,serde_json::to_vec(&json!({"loggedIn":auth["loggedIn"],"identified":state.core.account_key().is_some()})).unwrap_or_default());
                    }
                    return Ok(auth);
                }}
            }}
        }
        Err(Error::new("TIMEOUT","登录超时，请重新扫码"))
    }.await;
    let _ = window.clear_all_browsing_data();
    let _ = window.close();
    result
}

#[cfg(any(target_os = "windows", test))]
fn windows_explorer_select_arg(path: &std::path::Path) -> Result<String> {
    let raw_cow = path.to_string_lossy();
    let normalized = if let Some(rest) = raw_cow.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw_cow.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw_cow.into_owned()
    };
    let raw = normalized.as_str();
    if raw.is_empty()
        || raw.contains('"')
        || raw.contains('\0')
        || raw.contains('\r')
        || raw.contains('\n')
    {
        return Err(Error::new(
            "INVALID_ARG",
            "路径包含非法字符，无法在资源管理器中定位",
        ));
    }
    // 剥离非根路径的尾随反斜杠/斜杠，避免 `...\"` 触发 Windows CommandLineToArgvW 引号转义。
    let trimmed = raw.trim_end_matches(['\\', '/']);
    let bytes = trimmed.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // 盘符根（如 C:\）不含空格/逗号，直接不加引号传 /select,C:\ 避免尾部裸 \" 转义。
        return Ok(format!("/select,{trimmed}\\"));
    }
    if trimmed.is_empty() {
        return Err(Error::new(
            "INVALID_ARG",
            "路径无效，无法在资源管理器中定位",
        ));
    }
    Ok(format!("/select,\"{trimmed}\""))
}

#[cfg(any(target_os = "windows", test))]
fn windows_explorer_exit_ok(code: Option<i32>) -> bool {
    // Windows explorer.exe 委派给已运行外壳进程时正常返回退出码 1。
    matches!(code, Some(0) | Some(1))
}

async fn stage_verified_update(
    update: &quark_core::hub::VerifiedUpdate,
    parent: &std::path::Path,
) -> Result<(tempfile::TempDir, PathBuf)> {
    let staging = tempfile::Builder::new()
        .prefix("qdl-update-")
        .tempdir_in(parent)
        .map_err(|e| Error::new("IO", format!("无法创建安装暂存目录：{e}")))?;
    let filename = update
        .path()
        .file_name()
        .ok_or_else(|| Error::new("FORBIDDEN", "更新包缺少有效文件名"))?;
    let staged_path = staging.path().join(filename);
    let output = std::fs::File::create_new(&staged_path)
        .map_err(|e| Error::new("IO", format!("无法创建安装暂存文件：{e}")))?;
    update.copy_verified_to(output).await?;
    Ok((staging, staged_path))
}

#[cfg(target_os = "windows")]
fn prune_windows_update_stages(profile: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(profile) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("qdl-update-")
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age >= Duration::from_secs(7 * 24 * 3600));
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

async fn install_verified_update(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, State>,
    params: Value,
) -> Result<Value> {
    let requested_path = params["path"].as_str().filter(|path| !path.is_empty());
    let update = state.hub.verified_update_for_install(requested_path)?;
    let filename = update
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    if filename.ends_with(".exe") {
        let profile = state.core.profile_dir();
        prune_windows_update_stages(&profile);
        let (staging, staged_path) = stage_verified_update(&update, &profile).await?;
        let mut cmd = std::process::Command::new(staged_path);
        cmd.current_dir(staging.path());
        if params["silent"].as_bool() == Some(true) {
            cmd.arg("/S");
        }
        cmd.spawn()
            .map_err(|e| Error::new("SYSTEM", format!("无法启动安装程序：{e}")))?;
        let _ = staging.keep();
        let exit_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(450)).await;
            exit_handle.exit(0);
        });
        return Ok(json!({
            "ok": true,
            "mode": "installer_launched",
            "restarting": true,
            "message": "已启动安装程序并正在退出当前版本，请按提示完成升级"
        }));
    }

    #[cfg(target_os = "macos")]
    if filename.ends_with(".zip") {
        let app_bundle = std::env::current_exe().ok().and_then(|exe| {
            exe.ancestors()
                .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
                .map(PathBuf::from)
        });
        if let Some(app_bundle) = app_bundle {
            if let Some(parent) = app_bundle.parent() {
                match stage_verified_update(&update, parent).await {
                    Ok((staging, staged_path)) => {
                        let script = r#"
pid="$1"
zip_path="$2"
stage="$3"
app_dest="$4"
keep_stage=0
trap 'if [ "$keep_stage" = 0 ]; then /bin/rm -rf "$stage"; fi' 0
for i in $(/usr/bin/seq 1 40); do
  kill -0 "$pid" 2>/dev/null || break
  /bin/sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then exit 1; fi
unpacked="$stage/unpacked"
/bin/mkdir "$unpacked" || exit 1
/usr/bin/ditto -x -k "$zip_path" "$unpacked" || exit 1
src_app=$(/usr/bin/find "$unpacked" -maxdepth 2 -name "*.app" -type d -print -quit)
if [ -z "$src_app" ] || ! /usr/bin/codesign --verify --deep --strict "$src_app" >/dev/null 2>&1; then
  exit 1
fi
previous="$stage/previous.app"
/bin/mv "$app_dest" "$previous" || exit 1
if /bin/mv "$src_app" "$app_dest"; then
  /usr/bin/open -a "$app_dest"
else
  if ! /bin/mv "$previous" "$app_dest"; then
    keep_stage=1
    echo "Previous installation preserved in $previous" >&2
  fi
  exit 1
fi
"#;
                        std::process::Command::new("/bin/sh")
                            .arg("-c")
                            .arg(script)
                            .arg("qdl-updater")
                            .arg(std::process::id().to_string())
                            .arg(staged_path)
                            .arg(staging.path())
                            .arg(app_bundle)
                            .spawn()
                            .map_err(|e| {
                                Error::new("SYSTEM", format!("无法启动应用原位升级：{e}"))
                            })?;
                        let _ = staging.keep();
                        let exit_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(350)).await;
                            exit_handle.exit(0);
                        });
                        return Ok(json!({
                            "ok": true,
                            "mode": "inplace_swap",
                            "restarting": true,
                            "message": "正在自动替换应用并重启至新版本…"
                        }));
                    }
                    Err(error) if error.code != "IO" => return Err(error),
                    Err(_) => {}
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    if filename.ends_with(".appimage") {
        if let Some(target) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
            if let Some(parent) = target.parent() {
                if std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_file()) {
                    match stage_verified_update(&update, parent).await {
                        Ok((_staging, staged_path)) => {
                            use std::os::unix::fs::PermissionsExt;
                            let installed = std::fs::set_permissions(
                                &staged_path,
                                std::fs::Permissions::from_mode(0o755),
                            )
                            .and_then(|_| std::fs::rename(&staged_path, &target));
                            if installed.is_ok() {
                                std::process::Command::new(&target).spawn().map_err(|e| {
                                    Error::new("SYSTEM", format!("无法启动已安装更新：{e}"))
                                })?;
                                let exit_handle = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    tokio::time::sleep(Duration::from_millis(350)).await;
                                    exit_handle.exit(0);
                                });
                                return Ok(json!({
                                    "ok": true,
                                    "mode": "inplace_swap",
                                    "restarting": true,
                                    "message": "已原位更新 AppImage 并正在重启至新版本…"
                                }));
                            }
                        }
                        Err(error) if error.code != "IO" => return Err(error),
                        Err(_) => {}
                    }
                }
            }
        }
    }

    update.verify().await?;
    open_local(update.path().to_path_buf(), true).await?;
    #[cfg(target_os = "windows")]
    let message = "已在资源管理器中定位便携版压缩包，解压覆盖即可完成升级";
    #[cfg(target_os = "macos")]
    let message = "已在 Finder 中定位更新包，解压替换即可升级";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let message = "已在文件管理器中定位更新包，请安装升级";
    Ok(json!({
        "ok": true,
        "mode": "revealed",
        "restarting": false,
        "message": message
    }))
}

async fn open_local(path: PathBuf, reveal: bool) -> Result<Value> {
    if !path.is_absolute() || !path.exists() {
        return Err(Error::new("NOT_FOUND", "请选择存在的本地绝对路径"));
    }
    #[cfg(target_os = "linux")]
    if reveal && linux_desktop::show_item(&path).await.is_ok() {
        return Ok(Value::Null);
    }
    tauri::async_runtime::spawn_blocking(move || {
        if reveal {
            #[cfg(target_os = "macos")]
            {
                let status = std::process::Command::new("open")
                    .arg("-R")
                    .arg(&path)
                    .status()
                    .map_err(shell_error)?;
                if !status.success() {
                    return Err(Error::new(
                        "SYSTEM",
                        format!("无法在访达中定位文件（退出码 {:?}）", status.code()),
                    ));
                }
                return Ok(());
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let arg = windows_explorer_select_arg(&path)?;
                let status = std::process::Command::new("explorer")
                    .raw_arg(&arg)
                    .status()
                    .map_err(shell_error)?;
                if !(status.success() || windows_explorer_exit_ok(status.code())) {
                    return Err(Error::new(
                        "SYSTEM",
                        format!(
                            "无法在资源管理器中定位文件（退出码 {:?}）",
                            status.code()
                        ),
                    ));
                }
                return Ok(());
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let folder = if path.is_dir() {
                    path.as_path()
                } else {
                    path.parent().unwrap_or(&path)
                };
                return open::that(folder).map_err(shell_error);
            }
        }
        open::that(path).map_err(shell_error)
    })
    .await
    .map_err(shell_error)??;
    Ok(Value::Null)
}

async fn dialog(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    method: &str,
    params: Value,
) -> Result<Value> {
    if matches!(method, "dialog.openPath" | "dialog.showInFolder") {
        return open_local(
            PathBuf::from(params["path"].as_str().unwrap_or("")),
            method == "dialog.showInFolder",
        )
        .await;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = window;
        return linux_desktop::dialog(app, method, params).await;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        platform_dialog(window, method, params).await
    }
}

#[cfg(not(target_os = "linux"))]
async fn platform_dialog(
    window: &tauri::WebviewWindow,
    method: &str,
    params: Value,
) -> Result<Value> {
    let mut picker = rfd::AsyncFileDialog::new().set_parent(window);
    if let Some(p) = params["defaultPath"].as_str().filter(|s| !s.is_empty()) {
        picker = picker.set_directory(p);
    }
    match method {
        "dialog.pickFiles" => Ok(json!(picker
            .pick_files()
            .await
            .unwrap_or_default()
            .iter()
            .map(|h| h.path().to_string_lossy().to_string())
            .collect::<Vec<_>>())),
        "dialog.pickDirs" => Ok(json!(picker
            .pick_folders()
            .await
            .unwrap_or_default()
            .iter()
            .map(|h| h.path().to_string_lossy().to_string())
            .collect::<Vec<_>>())),
        "dialog.saveDir" => Ok(json!(picker
            .pick_folder()
            .await
            .map(|h| h.path().to_string_lossy().to_string()))),
        "dialog.confirm" => {
            let result = rfd::AsyncMessageDialog::new()
                .set_parent(window)
                .set_title(params["title"].as_str().unwrap_or("确认操作"))
                .set_description(format!(
                    "{}\n{}",
                    params["message"].as_str().unwrap_or(""),
                    params["detail"].as_str().unwrap_or("")
                ))
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show()
                .await;
            Ok(json!(result == rfd::MessageDialogResult::Ok))
        }
        _ => Err(Error::new("INVALID_ARG", "未知系统操作")),
    }
}

#[tauri::command]
async fn smoke_report(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    report: Value,
) -> Result<()> {
    if !cfg!(debug_assertions) || !trusted(&window) {
        return Err(Error::new("FORBIDDEN", "仅开发验收可用"));
    }
    if let Some(path) = std::env::var_os("QK_SMOKE_REPORT") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&report).map_err(shell_error)?,
        )
        .map_err(shell_error)?;
        if std::env::var_os("QK_SMOKE_EXIT").is_some() {
            app.exit(0);
        }
    }
    Ok(())
}

fn main() {
    let context=tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if std::env::var_os("QK_SMOKE_REPORT").is_some()
            && std::env::var_os("QK_SMOKE_DESKTOP").is_none()
        {
            for window in &mut context.config_mut().app.windows {
                window.visible = false;
                window.focus = false;
            }
        }
        context
    };
    tauri::Builder::default()
        .register_uri_scheme_protocol("qdl-ui", |ctx, request| {
            let profile = ctx
                .app_handle()
                .try_state::<State>()
                .map(|s| s.core.profile_dir());
            if let Some(dir) = profile {
                if let Some((bytes, mime)) =
                    quark_core::hot_ui::read_verified_asset(&dir, request.uri().path())
                {
                    if let Ok(resp) = tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Cache-Control", "no-store")
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Content-Security-Policy", HOT_UI_CSP)
                        .body(bytes)
                    {
                        return resp;
                    }
                }
            }
            tauri::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain; charset=utf-8")
                .body(b"hot-ui asset not found".to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![qk_call, smoke_report])
        .setup(|app| {
            let file_menu = tauri::menu::SubmenuBuilder::new(app, "文件")
                .quit_with_text("退出客户端")
                .build()?;
            #[cfg(target_os = "macos")]
            let app_menu = {
                let edit_menu = tauri::menu::SubmenuBuilder::new(app, "编辑")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                tauri::menu::MenuBuilder::new(app)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .build()?
            };
            #[cfg(not(target_os = "macos"))]
            let app_menu = tauri::menu::MenuBuilder::new(app)
                .item(&file_menu)
                .build()?;
            app.set_menu(app_menu)?;
            let profile = match std::env::var_os("QK_PROFILE_DIR") {
                Some(p) => PathBuf::from(p),
                None => app.path().app_data_dir()?,
            };
            if let Ok(meta) = std::fs::symlink_metadata(&profile) {
                if !meta.file_type().is_dir() {
                    return Err(Box::new(Error::new("STORAGE", "资料目录必须为普通目录")));
                }
            }
            std::fs::create_dir_all(&profile)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&profile, std::fs::Permissions::from_mode(0o700))?;
            }
            let mut opts = std::fs::OpenOptions::new();
            opts.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let profile_lock = opts.open(profile.join("app.lock"))?;
            fs2::FileExt::try_lock_exclusive(&profile_lock)
                .map_err(|_| Error::new("CONFLICT", "此资料目录已有客户端正在运行"))?;
            {
                let crash_profile = profile.clone();
                let prev_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let loc = info
                        .location()
                        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                        .unwrap_or_else(|| "unknown".into());
                    let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
                        (*s).to_string()
                    } else if let Some(s) = info.payload().downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "non-string panic payload".into()
                    };
                    quark_core::hub::record_panic_breadcrumb(&crash_profile, &loc, &msg);
                    prev_hook(info);
                }));
            }
            let core = Core::open(profile.clone())?;
            let transfers = TransferManager::open(core.clone())?;
            let hub = HubClient::new(core.clone(), HubConfig::from_env_or_default())?;
            {
                let hub_obs = hub.clone();
                transfers.set_observer(Arc::new(move |sample| {
                    hub_obs.record_transfer_sample(sample);
                }));
                let hub_flusher = hub.clone();
                tauri::async_runtime::spawn(async move {
                    hub_flusher
                        .run_telemetry_flusher_loop(env!("CARGO_PKG_VERSION"))
                        .await;
                });
            }
            // Agent 子系统：工具宿主 = 真实 Core/TransferManager；generation 供会话绑定。
            let host = ToolHost::new(core.clone(), transfers.clone());
            let generation_core = core.clone();
            let agent = AgentRuntime::new(
                profile.clone(),
                host,
                Arc::new(move || generation_core.session_generation()),
            )
            .map_err(|e| Error::new(e.code.as_str(), e.message))?;
            let state = State {
                core,
                transfers: transfers.clone(),
                agent: agent.clone(),
                hub,
                hot_ui_confirmed: Arc::new(AtomicBool::new(false)),
                hot_ui_active: Arc::new(AtomicBool::new(false)),
                login: Arc::new(AtomicBool::new(false)),
                logging_out: Arc::new(AtomicBool::new(false)),
                login_generation: Arc::new(AtomicU64::new(0)),
                account_control: Arc::new(tokio::sync::Mutex::new(())),
                _profile_lock: Arc::new(profile_lock),
            };
            let main_window = app
                .get_webview_window("main")
                .expect("main window configured");
            let close_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    close_handle.exit(0);
                }
            });
            app.manage(state.clone());
            // L2: activate Ed25519+SHA-256 verified hot-UI bundle if staged & compatible, guarded by 8s watchdog.
            if std::env::var_os("QK_SMOKE_REPORT").is_none() {
                if let Some(hot_ver) =
                    quark_core::hot_ui::prepare_boot(&profile, env!("CARGO_PKG_VERSION"))
                {
                    state.hub.record_event(
                        "info",
                        "hot_ui",
                        Some("HOT_UI_BOOT"),
                        &format!("activating verified UI hotfix {hot_ver}"),
                    );
                    arm_hot_ui_watchdog(
                        main_window.clone(),
                        profile.clone(),
                        state.hot_ui_confirmed.clone(),
                        state.hot_ui_active.clone(),
                        state.hub.clone(),
                    );
                    let _ = main_window.navigate(hot_ui_entry_url());
                }
            }
            {
                let agent_boot = state.agent.clone();
                let ai_beta_on = state
                    .core
                    .settings()
                    .get("aiBetaEnabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if ai_beta_on {
                    tauri::async_runtime::spawn(async move {
                        agent_boot.boot().await;
                    });
                }
            }
            #[cfg(debug_assertions)]
            if std::env::var_os("QK_LOGIN_ON_START").is_some() {
                let login_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Err(e) = login(login_handle.clone(), state).await {
                        let _ = login_handle.emit_to(
                            "main",
                            "qk:toast",
                            json!({"level":"error","message":e.message}),
                        );
                    }
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_rev = transfers.revision();
                let mut last_emit = tokio::time::Instant::now()
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or_else(tokio::time::Instant::now);
                loop {
                    let next_rev = transfers.wait_change(last_rev).await;
                    let elapsed = last_emit.elapsed();
                    if elapsed < Duration::from_millis(150) {
                        tokio::time::sleep(Duration::from_millis(150) - elapsed).await;
                    }
                    last_rev = transfers.revision().max(next_rev);
                    let tasks = transfers.snapshot();
                    let _ = handle.emit_to("main", "qk:transfer-update", &tasks);
                    last_emit = tokio::time::Instant::now();
                }
            });
            #[cfg(debug_assertions)]
            if std::env::var_os("QK_SMOKE_REPORT").is_some() {
                let w = app.get_webview_window("main").unwrap();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    let source = std::env::var("QK_SMOKE_SOURCE").unwrap_or_default();
                    let desktop = std::env::var_os("QK_SMOKE_DESKTOP").is_some();
                    let _ = w.eval(format!(
                        "window.__qkSmokeRoot={}; window.__qkSmokeDesktop={desktop};\n{}",
                        json!(source),
                        include_str!("smoke.js")
                    ));
                });
            }
            Ok(())
        })
        .build(context)
        .expect("Tauri 应用启动失败")
        .run({
            let shutting_down = Arc::new(AtomicBool::new(false));
            let shutdown_done = Arc::new(AtomicBool::new(false));
            move |app, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    // 清理未完成前持续拦截重复退出请求（例如连续 Cmd+Q / 关窗），防止绕过优雅关闭。
                    if !shutdown_done.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        if !shutting_down.swap(true, Ordering::SeqCst) {
                            let handle = app.clone();
                            let manager = app.state::<State>().transfers.clone();
                            let agent = app.state::<State>().agent.clone();
                            let hub = app.state::<State>().hub.clone();
                            let done = shutdown_done.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(8),
                                    manager.pause_all(),
                                )
                                .await;
                                if hub.is_opted_in() && hub.pending_sample_count() > 0 {
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(2),
                                        hub.flush_transfer_telemetry(env!("CARGO_PKG_VERSION")),
                                    )
                                    .await;
                                }
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(2),
                                    agent.gateway.stop(),
                                )
                                .await;
                                done.store(true, Ordering::SeqCst);
                                handle.exit(0);
                            });
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{windows_explorer_exit_ok, windows_explorer_select_arg};
    use std::path::Path;

    #[test]
    fn explorer_select_arg_handles_spaces_commas_trailing_slashes_roots_and_rejects_bad_chars() {
        let with_space_comma = Path::new(r"C:\Users\Alice Smith\Docs,2026\report 1.pdf");
        assert_eq!(
            windows_explorer_select_arg(with_space_comma).unwrap(),
            r#"/select,"C:\Users\Alice Smith\Docs,2026\report 1.pdf""#
        );
        // 尾随反斜杠应被剥离，避免触发 CommandLineToArgvW 引号转义
        assert_eq!(
            windows_explorer_select_arg(Path::new(r"C:\Users\")).unwrap(),
            r#"/select,"C:\Users""#
        );
        assert_eq!(
            windows_explorer_select_arg(Path::new(r"C:\Users\Alice Smith\\\")).unwrap(),
            r#"/select,"C:\Users\Alice Smith""#
        );
        // 盘符根目录不使用尾部裸 \"
        assert_eq!(
            windows_explorer_select_arg(Path::new(r"C:\")).unwrap(),
            r"/select,C:\"
        );
        // 拒绝内嵌引号、换行、回车与 NUL
        for bad in [
            r#"C:\Users\bad"name.txt"#,
            "C:\\Users\\bad\nname.txt",
            "C:\\Users\\bad\rname.txt",
            "C:\\Users\\bad\0name.txt",
        ] {
            assert!(
                windows_explorer_select_arg(Path::new(bad)).is_err(),
                "must reject {bad:?}"
            );
        }
        // Windows explorer.exe 退出码 0 与 1 均视为成功，其余失败
        assert!(windows_explorer_exit_ok(Some(0)));
        assert!(windows_explorer_exit_ok(Some(1)));
        assert!(!windows_explorer_exit_ok(Some(2)));
        assert!(!windows_explorer_exit_ok(None));
    }
}
