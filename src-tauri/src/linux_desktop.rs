use crate::shell_error;
use gtk::prelude::*;
use quark_core::{Error, Result};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

pub async fn show_item(path: &Path) -> Result<()> {
    let uri = tauri::Url::from_file_path(path)
        .map_err(|_| Error::new("INVALID_ARG", "无法生成本地文件地址"))?;
    let call = async {
        let bus = zbus::Connection::session().await.map_err(shell_error)?;
        bus.call_method(
            Some("org.freedesktop.FileManager1"),
            "/org/freedesktop/FileManager1",
            Some("org.freedesktop.FileManager1"),
            "ShowItems",
            &(vec![uri.as_str()], ""),
        )
        .await
        .map_err(shell_error)?;
        Ok::<(), Error>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), call)
        .await
        .map_err(|_| Error::new("TIMEOUT", "文件管理器响应超时"))??;
    Ok(())
}

pub async fn dialog(app: &tauri::AppHandle, method: &str, params: Value) -> Result<Value> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| Error::new("SYSTEM", "主窗口已关闭"))?;
    let method = method.to_string();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = match window.gtk_window() {
                Ok(parent) => show_dialog(&parent, &method, params).await,
                Err(error) => Err(shell_error(error)),
            };
            let _ = send.send(result);
        });
    })
    .map_err(shell_error)?;
    receive.await.map_err(shell_error)?
}

async fn show_dialog(
    parent: &gtk::ApplicationWindow,
    method: &str,
    params: Value,
) -> Result<Value> {
    if method == "dialog.confirm" {
        let message = params["message"].as_str().unwrap_or("");
        let detail = params["detail"].as_str().unwrap_or("");
        let dialog = gtk::MessageDialog::new(
            Some(parent),
            gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
            gtk::MessageType::Question,
            gtk::ButtonsType::None,
            message,
        );
        dialog.set_title(params["title"].as_str().unwrap_or("确认操作"));
        dialog.set_secondary_text(Some(detail));
        dialog.add_button("取消", gtk::ResponseType::Cancel);
        dialog.add_button("确定", gtk::ResponseType::Ok);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let response = dialog.run_future().await;
        dialog.close();
        unsafe { dialog.destroy(); }
        return Ok(json!(response == gtk::ResponseType::Ok));
    }

    let (title, action, multiple) = match method {
        "dialog.pickFiles" => ("选择文件", gtk::FileChooserAction::Open, true),
        "dialog.pickDirs" => ("选择文件夹", gtk::FileChooserAction::SelectFolder, true),
        "dialog.saveDir" => ("选择保存目录", gtk::FileChooserAction::SelectFolder, false),
        _ => return Err(Error::new("INVALID_ARG", "未知系统操作")),
    };
    let picker = gtk::FileChooserNative::new(
        Some(title),
        Some(parent),
        action,
        Some("选择"),
        Some("取消"),
    );
    picker.set_modal(true);
    picker.set_select_multiple(multiple);
    if let Some(path) = params["defaultPath"].as_str().filter(|p| !p.is_empty()) {
        picker.set_current_folder(path);
    }
    let response = picker.run_future().await;
    let paths = if response == gtk::ResponseType::Accept {
        picker.filenames()
    } else {
        Vec::new()
    };
    let paths = paths
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| Error::new("INVALID_ARG", "当前文件路径无法以 UTF-8 表示"))
        })
        .collect::<Result<Vec<_>>>()?;
    if multiple {
        Ok(json!(paths))
    } else {
        Ok(json!(paths.first()))
    }
}
