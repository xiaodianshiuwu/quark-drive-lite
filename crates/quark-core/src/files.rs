use crate::{Core, Error, Result};
use serde_json::{json, Value};

pub(crate) fn number(value: &Value, fallback: i64) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| {
            value
                .as_f64()
                .filter(|f| f.is_finite() && *f >= i64::MIN as f64 && *f <= i64::MAX as f64)
                .map(|f| f.round() as i64)
        })
        .or_else(|| {
            value.as_str().and_then(|s| {
                let t = s.trim();
                t.parse::<i64>().ok().or_else(|| {
                    t.parse::<f64>()
                        .ok()
                        .filter(|f| f.is_finite())
                        .map(|f| f.round() as i64)
                })
            })
        })
        .unwrap_or(fallback)
}
fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
        .unwrap_or_default()
}
fn truth(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "on" | "1"
        ),
        _ => false,
    }
}
fn required(value: &Value, label: &str) -> Result<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| Error::new("INVALID_ARG", format!("{label}不能为空")))
}
fn ids(value: &Value) -> Result<Vec<String>> {
    let ids = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            v.as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_owned())
        })
        .collect::<Vec<_>>();
    if ids.is_empty() {
        Err(Error::new("INVALID_ARG", "请先选择要操作的文件"))
    } else {
        Ok(ids)
    }
}
fn list(env: &Value) -> Option<&Vec<Value>> {
    env["data"]["list"]
        .as_array()
        .or_else(|| env["data"].as_array())
        .or_else(|| env["metadata"]["list"].as_array())
        .or_else(|| env["list"].as_array())
}
fn record(env: &Value) -> Option<&Value> {
    let data = &env["data"];
    if let Some(a) = data.as_array() {
        a.first()
    } else if let Some(a) = data["list"].as_array() {
        a.first()
    } else if data.as_object().is_some_and(|o| !o.is_empty()) {
        Some(data)
    } else {
        env["metadata"]["list"].as_array().and_then(|a| a.first())
    }
}
fn task_id(value: &Value) -> String {
    let direct = text(value.get("task_id").unwrap_or(&value["taskId"]));
    if !direct.is_empty() {
        direct
    } else {
        text(&value["task_ids"][0])
    }
}
fn accepted(env: &Value) -> Value {
    let rec = record(env);
    let id = rec
        .map(task_id)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| task_id(env));
    let already_done = rec.is_some_and(|r| {
        let st_num = r["status"]
            .as_i64()
            .or_else(|| r["status"].as_u64().and_then(|u| i64::try_from(u).ok()));
        let st_str = r["status"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        !truth(&r["failed"])
            && st_num != Some(3)
            && r["success"] != false
            && (truth(&r["finish"])
                || truth(&r["done"])
                || st_num == Some(2)
                || st_str == "finish")
    });
    if id.is_empty() {
        json!({"done":true})
    } else if already_done {
        json!({"done":true,"taskId":id})
    } else {
        json!({"done":false,"taskId":id})
    }
}
fn task_entry(value: &Value) -> Result<Value> {
    let status_num = value["status"]
        .as_i64()
        .or_else(|| value["status"].as_u64().and_then(|u| i64::try_from(u).ok()));
    let status = value["status"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // 官方 AsyncTaskStatus 枚举（7.5.0.827 实证）：0=todo, 1=running, 2=finish, 3=fail, 4=pause；
    // 其余未知数值状态一律保持未完成（done=false），绝不冒充成功。
    let finished = truth(&value["finish"])
        || truth(&value["done"])
        || status == "finish"
        || status_num == Some(2);
    // Explicit failure always wins over completion flags.
    if truth(&value["failed"])
        || status_num == Some(3)
        || ["fail", "failed", "failure", "error", "cancelled", "canceled"].contains(&status.as_str())
        || (finished && value["success"] == false)
    {
        return Err(Error::new("TASK_FAILED", "云端文件操作失败，请刷新后重试"));
    }
    Ok(
        json!({"taskId":task_id(value),"status":value.get("status").unwrap_or(&json!(-1)),"done":finished||truth(&value["success"]),"raw":value}),
    )
}
pub(crate) fn file_item(raw: &Value) -> Value {
    let original = raw["file_name"]
        .as_str()
        .or_else(|| raw["name"].as_str())
        .unwrap_or("");
    let decoded = html_escape::decode_html_entities(original);
    let name = if decoded.is_empty() {
        "未命名"
    } else {
        decoded.as_ref()
    };
    let dir = if !raw["dir"].is_null() {
        truth(&raw["dir"])
    } else {
        (!raw["file_type"].is_null() && number(&raw["file_type"], -1) == 0) || raw["file"] == false
    };
    let ext = if dir {
        "".into()
    } else {
        name.rsplit('/')
            .next()
            .and_then(|s| {
                s.rfind('.')
                    .filter(|i| *i > 0 && *i + 1 < s.len())
                    .map(|i| s[i + 1..].to_lowercase())
            })
            .unwrap_or_default()
    };
    let mut item = json!({"fid":text(&raw["fid"]),"name":name,"dir":dir,"size":if dir {0}else{number(&raw["size"],0).max(0)},"updatedAt":number(raw.get("updated_at").unwrap_or(&raw["updatedAt"]),0),"createdAt":number(raw.get("created_at").unwrap_or(&raw["createdAt"]),0),"category":number(&raw["category"],0),"ext":ext,"pdirFid":text(raw.get("pdir_fid").unwrap_or(&raw["pdirFid"]))});
    // 保留已实测确认的丰富详情字段（供右侧详情抽屉展示，缺失时省略以保持向后兼容）
    let format_type = text(raw.get("format_type").unwrap_or(&raw["formatType"]));
    if !format_type.is_empty() {
        item["formatType"] = json!(format_type);
    }
    let obj_cat = text(raw.get("obj_category").unwrap_or(&raw["objCategory"]));
    if !obj_cat.is_empty() {
        item["objCategory"] = json!(obj_cat);
    }
    let operated_at = number(raw.get("operated_at").unwrap_or(&raw["operatedAt"]), 0);
    if operated_at > 0 {
        item["operatedAt"] = json!(operated_at);
    }
    let duration = number(&raw["duration"], 0);
    if duration > 0 {
        item["duration"] = json!(duration);
    }
    if let Some(fps) = raw["fps"].as_f64().filter(|v| v.is_finite() && *v > 0.0) {
        item["fps"] = json!((fps * 100.0).round() / 100.0);
    }
    let include_items = number(raw.get("include_items").unwrap_or(&raw["includeItems"]), -1);
    if dir && include_items >= 0 {
        item["includeItems"] = json!(include_items);
    }
    let source = text(
        raw.get("source_display")
            .filter(|v| !v.is_null() && !text(v).is_empty())
            .or_else(|| raw.get("file_source"))
            .unwrap_or(&Value::Null),
    );
    if !source.is_empty() {
        item["source"] = json!(source);
    }
    let cur_ver = number(&raw["cur_version_or_default"], 0);
    if cur_ver > 0 {
        item["version"] = json!(cur_ver);
    }
    for key in ["full_path", "fullPath"] {
        if let Some(arr) = raw[key].as_array() {
            let parsed = parse_crumbs(&json!({"data": arr}));
            if !parsed.is_empty() {
                item["fullPath"] = json!(parsed);
                break;
            }
        }
    }
    // Preserve confirmed digest fields for the transfer core; the renderer may
    // ignore them. Reject malformed values instead of weakening verification.
    for (key, len) in [("md5", 32), ("sha1", 40)] {
        if let Some(hash) = raw[key]
            .as_str()
            .filter(|s| s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            item[key] = json!(hash.to_ascii_lowercase());
        }
    }
    item
}
fn parse_crumbs(env: &Value) -> Vec<Value> {
    list(env)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let fid = text(v.get("fid").unwrap_or(&v["id"]));
            if fid.is_empty() {
                None
            } else {
                let raw_name = text(v.get("file_name").unwrap_or(&v["name"]));
                let name = html_escape::decode_html_entities(&raw_name).into_owned();
                Some(json!({"fid": fid, "name": name}))
            }
        })
        .collect()
}

fn parse_crumbs_from_info(env: &Value, requested_fid: &str) -> Vec<Value> {
    let Some(rec) = record(env) else {
        return Vec::new();
    };
    for key in ["full_path", "fullPath", "path_list", "pathList"] {
        if let Some(arr) = rec[key].as_array() {
            let parsed = parse_crumbs(&json!({"data": arr}));
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    let item = file_item(rec);
    let fid = text(&item["fid"]);
    let fid = if fid.is_empty() {
        requested_fid.to_owned()
    } else {
        fid
    };
    let name = text(&item["name"]);
    let pdir = text(&item["pdirFid"]);
    if fid.is_empty() || fid == "0" {
        return Vec::new();
    }
    let mut out = vec![json!({"fid": "0", "name": "全部文件"})];
    if !pdir.is_empty() && pdir != "0" && pdir != fid {
        out.push(json!({"fid": pdir, "name": "上级目录"}));
    }
    out.push(json!({"fid": fid, "name": if name.is_empty() { "未命名" } else { name.as_str() }}));
    out
}
fn storage_source_label(key: &str) -> &'static str {
    match key {
        "SAVE_AS_ALL" => "分享转存",
        "UPLOAD" => "手动上传",
        "BACKUP_ALL" => "备份资料",
        "UNARCHIVE" => "云解压文件",
        "AUTO" => "自动保存",
        "SAVE_TO" => "快捷保存",
        "SECRET_SPACE" => "隐私空间",
        "SHARED_ALBUM" => "共享相册",
        "OTHER" => "其他",
        _ => "其他",
    }
}

fn parse_dir_detail(fid: &str, env: &Value) -> Value {
    let data = &env["data"];
    let size = number(
        data.get("include_items_size")
            .or_else(|| data.get("total_size"))
            .or_else(|| data.get("size"))
            .unwrap_or(&Value::Null),
        0,
    )
    .max(0);
    let items = number(
        data.get("include_items")
            .or_else(|| data.get("file_count"))
            .unwrap_or(&Value::Null),
        0,
    )
    .max(0);
    let finished = if data["dir_scan_finish"].is_null() {
        true
    } else {
        truth(&data["dir_scan_finish"])
    };
    json!({
        "fid": fid,
        "size": size,
        "items": items,
        "finished": finished,
    })
}

fn parse_storage_detail(env: &Value) -> Value {
    let mut items: Vec<Value> = env["data"]["storage_data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            let key = text(&entry["src_name"]);
            let size = number(&entry["size"], 0).max(0);
            let count = number(&entry["count"], 0).max(0);
            json!({
                "key": key,
                "label": storage_source_label(&key),
                "size": size,
                "count": count,
            })
        })
        .filter(|v| v["size"].as_i64().unwrap_or(0) > 0 || v["count"].as_i64().unwrap_or(0) > 0)
        .collect();
    items.sort_by(|a, b| {
        b["size"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["size"].as_i64().unwrap_or(0))
    });
    let total: i64 = items.iter().map(|v| v["size"].as_i64().unwrap_or(0)).sum();
    json!({"total": total, "items": items})
}

fn parse_archive_preview(env: &Value, page: i64, size: i64) -> Value {
    let data = &env["data"];
    let finish = truth(&data["finish"]);
    let total_file_count = number(&data["total_file_count"], 0).max(0);
    let tq_gap = number(&env["metadata"]["tq_gap"], 500).clamp(200, 5000);
    let count_meta = number(&env["metadata"]["_count"], -1);
    let size_meta = number(&env["metadata"]["_size"], size).max(1);
    let entries: Vec<Value> = data["file_list"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|raw| {
            let raw_name = text(raw.get("file_name").unwrap_or(&raw["name"]));
            let name = html_escape::decode_html_entities(&raw_name).into_owned();
            let dir = truth(raw.get("is_folder").unwrap_or(&raw["dir"]));
            let path = html_escape::decode_html_entities(&text(&raw["path"])).into_owned();
            let path_no = number(&raw["path_no"], 0);
            let sz = if dir { 0 } else { number(&raw["size"], 0).max(0) };
            let updated_at = number(&raw["updated_at"], 0);
            let ext = if dir {
                String::new()
            } else {
                name.rsplit('/')
                    .next()
                    .and_then(|s| {
                        s.rfind('.')
                            .filter(|i| *i > 0 && *i + 1 < s.len())
                            .map(|i| s[i + 1..].to_lowercase())
                    })
                    .unwrap_or_default()
            };
            json!({
                "name": if name.is_empty() { "未命名".to_owned() } else { name },
                "dir": dir,
                "path": path,
                "pathNo": path_no,
                "size": sz,
                "updatedAt": updated_at,
                "ext": ext,
            })
        })
        .collect();
    let has_more = if count_meta >= 0 {
        count_meta >= size_meta
    } else {
        entries.len() as i64 >= size
    };
    json!({
        "finish": finish,
        "totalFileCount": total_file_count,
        "tqGap": tq_gap,
        "page": page,
        "size": size,
        "hasMore": has_more,
        "list": entries,
    })
}

fn parse_archive_task(env: &Value) -> Result<Value> {
    let raw = record(env)
        .ok_or_else(|| Error::new("NOT_FOUND", "未找到该云解压任务，可能已结束或被清理"))?;
    let status_num = number(&raw["status"], -1);
    let status_str = raw["status"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // 官方 AsyncTaskStatus 枚举（7.5.0.827 实证）：0=todo, 1=running, 2=finish, 3=fail, 4=pause
    let failed = status_num == 3
        || truth(&raw["failed"])
        || matches!(status_str.as_str(), "fail" | "failed" | "failure" | "error");
    if failed {
        return Err(Error::new("TASK_FAILED", "云解压任务失败，请检查密码、空间或文件格式后重试"));
    }
    let done = status_num == 2 || truth(&raw["finish"]) || status_str == "finish";
    let progress_raw = number(&raw["progress"], if done { 1000 } else { 0 }).clamp(0, 1000);
    let pct = if done {
        100.0
    } else {
        ((progress_raw as f64) / 10.0 * 10.0).round() / 10.0
    };
    json_ok(json!({
        "taskId": task_id(raw),
        "status": status_num,
        "done": done,
        "progress": pct,
        "raw": raw,
    }))
}

fn json_ok(v: Value) -> Result<Value> {
    Ok(v)
}

fn parse_recycle_page(env: &Value, page: i64, size: i64) -> Value {
    let entries: Vec<Value> = list(env)
        .into_iter()
        .flatten()
        .map(|raw| {
            let mut base = file_item(raw);
            let record_id = text(&raw["record_id"]);
            let pdir_name = html_escape::decode_html_entities(&text(
                raw.get("pdir_file_name")
                    .or_else(|| raw.get("pdir_name"))
                    .unwrap_or(&Value::Null),
            ))
            .into_owned();
            let deleted_at = number(&raw["move_recycle_at"], 0);
            let expire_at = number(&raw["move_deep_recycle_at"], 0);
            let remain_ms = number(&raw["invisible_remain"], -1);
            base["recordId"] = json!(record_id);
            base["pdirName"] = json!(if pdir_name.is_empty() { "全部文件".to_owned() } else { pdir_name });
            base["deletedAt"] = json!(deleted_at);
            base["expireAt"] = json!(expire_at);
            base["remainMs"] = json!(remain_ms);
            base
        })
        .collect();
    let total = [
        &env["data"]["total"],
        &env["metadata"]["_total"],
        &env["metadata"]["total"],
    ]
    .iter()
    .filter(|v| !v.is_null())
    .map(|v| number(v, -1))
    .find(|n| *n >= 0)
    .unwrap_or(entries.len() as i64);
    let has_more = if total >= 0 {
        page.saturating_mul(size) < total
    } else {
        entries.len() as i64 >= size
    };
    json!({
        "list": entries,
        "total": total,
        "page": page,
        "size": size,
        "hasMore": has_more,
    })
}

fn parse_revisions(env: &Value) -> Value {
    let entries: Vec<Value> = list(env)
        .into_iter()
        .flatten()
        .map(|raw| {
            let raw_name = text(raw.get("file_name").unwrap_or(&raw["name"]));
            let name = html_escape::decode_html_entities(&raw_name).into_owned();
            json!({
                "version": number(raw.get("version").unwrap_or(&raw["revision"]), 0),
                "fid": text(&raw["fid"]),
                "name": name,
                "size": number(&raw["size"], 0).max(0),
                "updatedAt": number(raw.get("updated_at").or_else(|| raw.get("created_at")).unwrap_or(&Value::Null), 0),
                "formatType": text(&raw["format_type"]),
                "current": truth(raw.get("is_current").or_else(|| raw.get("current")).unwrap_or(&Value::Null)),
            })
        })
        .filter(|v| v["version"].as_i64().unwrap_or(0) > 0)
        .collect();
    json!({"list": entries})
}

fn page_result(env: &Value, page: i64, size: i64) -> Value {
    let entries = list(env)
        .into_iter()
        .flatten()
        .map(file_item)
        .collect::<Vec<_>>();
    let total = [
        &env["metadata"]["_total"],
        &env["metadata"]["total"],
        &env["total"],
        &env["data"]["_total"],
    ]
    .iter()
    .filter(|v| !v.is_null())
    .map(|v| number(v, -1))
    .find(|n| *n >= 0)
    .unwrap_or(-1);
    let has_more = if total >= 0 {
        page.saturating_mul(size) < total
    } else {
        entries.len() == size as usize
    };
    json!({"list":entries,"total":total,"page":page,"size":size,"hasMore":has_more})
}
impl Core {
    async fn file_page(&self, generation: u64, params: &Value, search: bool) -> Result<Value> {
        let page = number(&params["page"], 1).max(1);
        let size = number(&params["size"], 50).clamp(1, 1000);
        let mut query = vec![
            ("_page", page.to_string()),
            ("_size", size.to_string()),
            ("_fetch_total", "1".into()),
        ];
        let path = if search {
            query.push(("q", required(&params["keyword"], "搜索关键字")?));
            "/1/clouddrive/file/search"
        } else {
            query.extend([
                (
                    "pdir_fid",
                    params["pdirFid"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("0")
                        .into(),
                ),
                (
                    "_sort",
                    params["sort"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or("file_type:asc,updated_at:desc")
                        .into(),
                ),
                ("fetch_all_file", "1".into()),
                ("fetch_risk_file_name", "1".into()),
            ]);
            "/1/clouddrive/file/sort"
        };
        if !params["cat"].is_null() {
            let cat = text(&params["cat"]);
            if !cat.is_empty() {
                query.push(("cat", cat));
            }
        }
        let env = self.get_in_session(generation, path, &query).await?;
        if list(&env).is_none() {
            return Err(Error::new(
                "SERVER",
                if search {
                    "搜索响应缺少文件列表，暂时无法确认搜索结果"
                } else {
                    "目录响应缺少文件列表，请刷新重试"
                },
            ));
        }
        Ok(page_result(&env, page, size))
    }
    async fn query_single_task(&self, generation: u64, id: &str) -> Result<Option<Value>> {
        let env = self
            .get_in_session(
                generation,
                "/1/clouddrive/task",
                &[("task_id", id.to_owned()), ("retry_index", "0".into())],
            )
            .await?;
        let Some(rec) = record(&env) else {
            return Ok(None);
        };
        let mut entry = task_entry(rec)?;
        if entry["taskId"].as_str().unwrap_or("").is_empty() {
            entry["taskId"] = json!(id);
        }
        Ok(Some(entry))
    }
    async fn task_status(&self, generation: u64, params: &Value) -> Result<Value> {
        let task_ids = ids(&params["taskIds"])?;
        let explicit_op_type = !params["opType"].is_null();
        // 夸克官方客户端对单个/少量异步任务（删除/移动/复制等）优先使用 GET /1/clouddrive/task?task_id=...
        if !explicit_op_type && task_ids.len() <= 5 {
            let mut out = Vec::with_capacity(task_ids.len());
            let mut all_found = true;
            for id in &task_ids {
                match self.query_single_task(generation, id).await {
                    Ok(Some(entry)) => out.push(entry),
                    Ok(None) => {
                        all_found = false;
                        break;
                    }
                    Err(e) if e.code == "NEED_LOGIN" || e.code == "ABORTED" || e.code == "TASK_FAILED" => {
                        return Err(e);
                    }
                    Err(_) => {
                        all_found = false;
                        break;
                    }
                }
            }
            if all_found && !out.is_empty() {
                return Ok(Value::Array(out));
            }
        }
        let env = self
            .post_in_session(
                generation,
                "/1/clouddrive/task/status",
                json!({"task_ids":task_ids,"op_type":number(&params["opType"],1)}),
            )
            .await?;
        if let Some(a) = list(&env) {
            let parsed = a.iter().map(task_entry).collect::<Result<Vec<_>>>()?;
            if !parsed.is_empty() {
                return Ok(Value::Array(parsed));
            }
        } else if let Some(v) =
            record(&env).filter(|r| r.get("task_id").is_some() || r.get("status").is_some())
        {
            return Ok(json!([task_entry(v)?]));
        }
        // 若批量接口返回空列表，再兜底逐个查询 GET /1/clouddrive/task
        if task_ids.len() <= 5 {
            let mut out = Vec::new();
            for id in &task_ids {
                if let Ok(Some(entry)) = self.query_single_task(generation, id).await {
                    out.push(entry);
                }
            }
            if !out.is_empty() {
                return Ok(Value::Array(out));
            }
        }
        Ok(json!([]))
    }
    pub(crate) async fn files_call(&self, method: &str, params: Value) -> Result<Value> {
        let generation = self.session_generation();
        if self.cookie_header().is_empty() || self.call_status()["expired"] == true {
            return Err(Error::new("NEED_LOGIN", "请先登录夸克网盘"));
        }
        match method {
            "fs.list"=>self.file_page(generation,&params,false).await,
            "fs.search"=>self.file_page(generation,&params,true).await,
            "fs.info"=>{
                let fid=required(if params.is_string(){&params}else{&params["fid"]},"文件 fid")?;
                let env=self.get_in_session(generation,"/1/clouddrive/file/info",&[("fid",fid),("_fetch_full_path","1".into()),("need_profile_tags","1".into()),("kkkk","1".into())]).await?;
                record(&env).map(file_item).ok_or_else(||Error::new("NOT_FOUND","未找到该文件，可能已被删除或移动"))
            }
            "fs.crumbs"=>{
                let fid=if params.is_string(){text(&params)}else{text(&params["fid"])};
                let root=json!([{"fid":"0","name":"全部文件"}]);if fid.is_empty()||fid=="0"{return Ok(root);}
                let primary = match self.get_in_session(generation,"/1/clouddrive/file/info/path_list",&[("fid",fid.clone())]).await {
                    Ok(env)=>parse_crumbs(&env),
                    Err(e) if e.code=="NEED_LOGIN"||e.code=="ABORTED"=>return Err(e),
                    Err(_)=>Vec::new(),
                };
                if primary.len() > 1 {
                    return Ok(json!(primary));
                }
                match self.get_in_session(generation,"/1/clouddrive/file/info",&[("fid",fid.clone()),("_fetch_full_path","1".into()),("need_profile_tags","1".into()),("kkkk","1".into())]).await {
                    Ok(env)=>{
                        let fallback = parse_crumbs_from_info(&env, &fid);
                        Ok(if fallback.is_empty(){root}else{json!(fallback)})
                    }
                    Err(e) if e.code=="NEED_LOGIN"||e.code=="ABORTED"=>Err(e),
                    Err(_)=>Ok(if primary.is_empty(){root}else{json!(primary)})
                }
            }
            "fs.mkdir"=>Ok(accepted(&self.post_in_session(generation,"/1/clouddrive/file",json!({"pdir_fid":params["pdirFid"].as_str().filter(|s|!s.is_empty()).unwrap_or("0"),"file_name":required(&params["name"],"文件夹名称")?,"dir_path":"","dir_init_lock":false})).await?)),
            "fs.rename"=>{let name=required(&params["name"],"新名称")?;Ok(accepted(&self.post_in_session(generation,"/1/clouddrive/file/rename",json!({"fid":required(&params["fid"],"文件 fid")?,"file_name":name})).await?))},
            "fs.move"=>Ok(accepted(&self.post_in_session(generation,"/1/clouddrive/file/move",json!({"action_type":1,"to_pdir_fid":required(&params["toFid"],"目标目录 fid")?,"filelist":ids(&params["fids"])? ,"exclude_fids":[]})).await?)),
            "fs.copy"=>Ok(accepted(&self.post_in_session(generation,"/1/clouddrive/file/copy",json!({"action_type":2,"to_pdir_fid":required(&params["toFid"],"目标目录 fid")?,"filelist":ids(&params["fids"])? ,"copy_source":1})).await?)),
            "fs.remove"=>Ok(accepted(&self.post_in_session(generation,"/1/clouddrive/file/delete",json!({"action_type":2,"filelist":ids(&params["fids"])? ,"exclude_fids":[]})).await?)),
            "fs.taskStatus"=>self.task_status(generation,&params).await,
            "fs.queryTask"=>{
                let id=required(if params.is_string(){&params}else{&params["taskId"]},"任务 id")?;
                let env=self.get_in_session(generation,"/1/clouddrive/task",&[("task_id",id)]).await?;
                task_entry(record(&env).ok_or_else(||Error::new("NOT_FOUND","未找到该任务，可能已结束或被清理"))?)
            }
            "fs.waitTask"=>{
                let mut pending=ids(&params["taskIds"])?;let start=std::time::Instant::now();
                let timeout=number(&params["timeout"],180000).max(0) as u64;let interval=number(&params["interval"],1000).clamp(1,10000) as u64;
                loop {
                    let entries=self.task_status(generation,&json!({"taskIds":pending,"opType":number(&params["opType"],1)})).await?;
                    pending.retain(|id|!entries.as_array().unwrap().iter().any(|v|v["taskId"]==id.as_str()&&v["done"]==true));
                    if pending.is_empty(){return Ok(json!({"done":true,"entries":entries,"pending":[],"elapsed":start.elapsed().as_millis() as u64}));}
                    if start.elapsed().as_millis()>=timeout as u128{return Err(Error::new("TASK_FAILED","操作超时，任务可能仍在后台执行，请稍后刷新查看"));}
                    tokio::time::sleep(std::time::Duration::from_millis(interval.min(timeout.saturating_sub(start.elapsed().as_millis() as u64)))).await;
                }
            }
            "fs.dirDetail" => {
                let fid = required(
                    if params.is_string() { &params } else { &params["fid"] },
                    "文件夹 fid",
                )?;
                let env = self
                    .get_in_session(
                        generation,
                        "/1/clouddrive/dir/detail",
                        &[
                            ("fid", fid.clone()),
                            ("fetch_by_path", "0".into()),
                            ("scene", "pc_dir_detail".into()),
                        ],
                    )
                    .await?;
                Ok(parse_dir_detail(&fid, &env))
            }
            "fs.revisions" => {
                let fid = required(
                    if params.is_string() { &params } else { &params["fid"] },
                    "文件 fid",
                )?;
                let size = number(&params["size"], 50).clamp(1, 100);
                let env = self
                    .get_in_session(
                        generation,
                        "/1/clouddrive/file/revision/list",
                        &[
                            ("fid", fid),
                            ("_page", "1".into()),
                            ("_size", size.to_string()),
                        ],
                    )
                    .await?;
                Ok(parse_revisions(&env))
            }
            "fs.revertRevision" => {
                let fid = required(&params["fid"], "文件 fid")?;
                let version = number(&params["version"], -1);
                if version <= 0 {
                    return Err(Error::new("INVALID_ARG", "版本号无效"));
                }
                let _ = self
                    .post_in_session(
                        generation,
                        "/1/clouddrive/file/revision/revert",
                        json!({"fid": fid, "version": version}),
                    )
                    .await?;
                Ok(json!({"ok": true}))
            }
            "fs.storageDetail" => {
                let env = self
                    .get_in_session(generation, "/1/clouddrive/storage/detail", &[])
                    .await?;
                Ok(parse_storage_detail(&env))
            }
            "archive.rightTimes" => {
                let fid = required(
                    if params.is_string() { &params } else { &params["fid"] },
                    "压缩包 fid",
                )?;
                let env = self
                    .get_in_session(
                        generation,
                        "/1/clouddrive/archive/right_times",
                        &[("fid", fid)],
                    )
                    .await?;
                let data = &env["data"];
                Ok(json!({
                    "baseEnough": truth(&data["base_enough"]),
                    "extendLeft": number(&data["extend_left"], 0).max(0),
                }))
            }
            "archive.targetDir" => {
                let fid = required(
                    if params.is_string() { &params } else { &params["fid"] },
                    "压缩包 fid",
                )?;
                let env = self
                    .get_in_session(
                        generation,
                        "/1/clouddrive/archive/target_dir",
                        &[("fid", fid)],
                    )
                    .await?;
                let data = &env["data"];
                let dir_fid = text(&data["dir_fid"]);
                let dir_name = html_escape::decode_html_entities(&text(&data["dir"]["file_name"])).into_owned();
                Ok(json!({
                    "dirFid": if dir_fid.is_empty() { "0".to_owned() } else { dir_fid },
                    "exists": truth(&data["exists"]),
                    "dirName": dir_name,
                }))
            }
            "archive.preview" => {
                let fid = required(&params["fid"], "压缩包 fid")?;
                let path_no = number(
                    params.get("pathNo").or_else(|| params.get("path_no")).unwrap_or(&Value::Null),
                    0,
                )
                .max(0);
                let page = number(&params["page"], 1).max(1);
                let size = number(&params["size"], 50).clamp(1, 200);
                let pwd = params["pwd"].as_str().unwrap_or("");
                let env = self
                    .post_in_session(
                        generation,
                        "/1/clouddrive/archive/preview_tree",
                        json!({
                            "fid": fid,
                            "path_no": path_no,
                            "pwd": pwd,
                            "remember_pwd": false,
                            "_page": page,
                            "_size": size,
                        }),
                    )
                    .await?;
                Ok(parse_archive_preview(&env, page, size))
            }
            "archive.unarchive" => {
                let fid = required(&params["fid"], "压缩包 fid")?;
                let to_fid = params["toFid"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("0");
                let pwd = params["pwd"].as_str().unwrap_or("");
                let curr_path_no = number(
                    params.get("currPathNo").or_else(|| params.get("curr_path_no")).unwrap_or(&Value::Null),
                    0,
                )
                .max(0);
                let path_no_list: Vec<i64> = params["pathNos"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        let n = number(v, -1);
                        if n >= 0 { Some(n) } else { None }
                    })
                    .collect();
                let select_mode = if path_no_list.is_empty() { 0 } else { 2 };
                // 官方 CONFLICT_MODE：1 = DEFAULT（遇重名报错 23008），2 = COVER（覆盖）
                let conflict_mode = if number(&params["conflictMode"], 1) == 2 { 2 } else { 1 };
                let env = self
                    .post_in_session(
                        generation,
                        "/1/clouddrive/archive/unarchive",
                        json!({
                            "fid": fid,
                            "pwd": pwd,
                            "select_mode": select_mode,
                            "path_no_list": path_no_list,
                            "curr_path_no": if select_mode == 2 { curr_path_no } else { 0 },
                            "remember_pwd": false,
                            "suffix_type": 0,
                            "to_pdir_fid": to_fid,
                            "conflict_mode": conflict_mode,
                        }),
                    )
                    .await?;
                Ok(accepted(&env))
            }
            "archive.queryTask" => {
                let id = required(
                    if params.is_string() { &params } else { &params["taskId"] },
                    "云解压任务 id",
                )?;
                let env = self
                    .get_in_session(generation, "/1/clouddrive/task", &[("task_id", id)])
                    .await?;
                parse_archive_task(&env)
            }
            "recycle.list" => {
                let page = number(&params["page"], 1).max(1);
                let size = number(&params["size"], 50).clamp(1, 200);
                let env = self
                    .get_in_session(
                        generation,
                        "/1/clouddrive/file/recycle/list",
                        &[
                            ("_page", page.to_string()),
                            ("_size", size.to_string()),
                            ("fetch_pdir_file_name", "1".into()),
                        ],
                    )
                    .await?;
                Ok(parse_recycle_page(&env, page, size))
            }
            "recycle.recover" => {
                let record_list = ids(&params["recordIds"])?;
                let env = self
                    .post_in_session(
                        generation,
                        "/1/clouddrive/file/recycle/recover",
                        json!({
                            "select_mode": 2,
                            "record_list": record_list,
                        }),
                    )
                    .await?;
                Ok(accepted(&env))
            }
            "recycle.remove" => {
                let clear_all = params["clearAll"] == true;
                let body = if clear_all {
                    json!({"select_mode": 1})
                } else {
                    json!({
                        "select_mode": 2,
                        "record_list": ids(&params["recordIds"])?,
                    })
                };
                let env = self
                    .post_in_session(generation, "/1/clouddrive/file/recycle/remove", body)
                    .await?;
                Ok(accepted(&env))
            }
            "fs.listAll"=>{
                let size=number(&params["pageSize"],100).clamp(1,1000);let max_pages=number(&params["maxPages"],500).clamp(1,10000);
                let mut out=Vec::new();let mut page_params=if params.is_object(){params.clone()}else{json!({})};let mut total=-1;let mut truncated=false;
                for page in 1..=max_pages {page_params["page"]=json!(page);page_params["size"]=json!(size);let p=self.file_page(generation,&page_params,false).await?;let list=p["list"].as_array().unwrap();total=number(&p["total"],-1);out.extend(list.iter().cloned());if list.is_empty()||p["hasMore"]!=true{break;}if page==max_pages{truncated=true;}}
                Ok(json!({"list":out,"total":if total>=0{total}else{out.len() as i64},"page":1,"size":size,"hasMore":truncated,"truncated":truncated}))
            }
            _=>Err(Error::new("INVALID_ARG","未知文件操作"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_directory_primary_field_wins() {
        let item = file_item(
            &json!({"fid":"1","dir":false,"file_type":0,"file_name":"A&amp;B.TXT","size":"99","md5":"00000000000000000000000000000000","sha1":"malformed"}),
        );
        assert_eq!(item["dir"], false);
        assert_eq!(item["name"], "A&B.TXT");
        assert_eq!(item["ext"], "txt");
        assert_eq!(item["size"], 99);
        assert_eq!(item["md5"], "00000000000000000000000000000000");
        assert!(item.get("sha1").is_none());
    }
    #[test]
    fn paging_uses_metadata_and_preserves_unknown() {
        let p = page_result(
            &json!({"data":{"list":[{"fid":"1"}]},"metadata":{"_total":"100"}}),
            1,
            50,
        );
        assert_eq!(p["total"], 100);
        assert_eq!(p["hasMore"], true);
        let p = page_result(&json!({"data":[]}), 1, 50);
        assert_eq!(p["total"], -1);
        assert_eq!(p["hasMore"], false);
    }
    #[test]
    fn numeric_task_status_matches_verified_quark_enum_and_unknown_stays_pending() {
        // 0=todo, 1=running, 4=pause, 99=unknown -> 均不得视作完成
        for pending_status in [0, 1, 4, 99, -1] {
            assert_eq!(
                task_entry(&json!({"task_id":"t","status":pending_status})).unwrap()["done"],
                false,
                "status {pending_status} must stay pending"
            );
        }
        // 2=finish (官方 AsyncTaskStatus 实证) -> done=true
        assert_eq!(
            task_entry(&json!({"task_id":"t","status":2})).unwrap()["done"],
            true
        );
        // 3=fail -> TASK_FAILED
        assert_eq!(
            task_entry(&json!({"task_id":"t","status":3})).unwrap_err().code,
            "TASK_FAILED"
        );
        assert_eq!(
            task_entry(&json!({"task_id":"t","status":"finish"})).unwrap()["done"],
            true
        );
        assert_eq!(
            accepted(&json!({"data":{"task_id":"t"}})),
            json!({"taskId":"t","done":false})
        );
        assert_eq!(
            accepted(&json!({"data":{"task_id":"t","finish":true}})),
            json!({"taskId":"t","done":true})
        );
    }
    #[test]
    fn explicit_task_failure_wins_over_finish_and_success_flags() {
        for raw in [
            json!({"task_id":"t","finish":true,"success":false}),
            json!({"task_id":"t","done":true,"status":"failed"}),
            json!({"task_id":"t","success":true,"failed":true}),
            json!({"task_id":"t","status":2,"success":false}),
            json!({"task_id":"t","status":3,"finish":true}),
        ] {
            assert_eq!(task_entry(&raw).unwrap_err().code, "TASK_FAILED");
        }
        assert_eq!(
            task_entry(&json!({"task_id":"t","status":99,"success":false})).unwrap()["done"],
            false
        );
        assert_eq!(
            task_entry(&json!({"task_id":"t","finish":true,"success":true})).unwrap()["done"],
            true
        );
    }
    #[test]
    fn crumbs_unescapes_html_entities_and_required_trims_rename_name() {
        let env = json!({
            "data": {
                "list": [
                    {"fid": "0", "file_name": "全部文件"},
                    {"fid": "d1", "file_name": "R&amp;D &lt;2026&gt; &quot;Alpha&quot;"}
                ]
            }
        });
        let crumbs = parse_crumbs(&env);
        assert_eq!(crumbs.len(), 2);
        assert_eq!(crumbs[1]["fid"], "d1");
        assert_eq!(crumbs[1]["name"], "R&D <2026> \"Alpha\"");
        assert_eq!(required(&json!("  trimmed.txt  "), "新名称").unwrap(), "trimmed.txt");
    }
    #[test]
    fn crumbs_fallback_reconstructs_full_path_and_parent_from_file_info() {
        let with_full = json!({
            "data": {
                "fid": "d2",
                "file_name": "子目录",
                "pdir_fid": "d1",
                "full_path": [
                    {"fid": "0", "file_name": "全部文件"},
                    {"fid": "d1", "file_name": "父目录"},
                    {"fid": "d2", "file_name": "子目录"}
                ]
            }
        });
        let parsed = parse_crumbs_from_info(&with_full, "d2");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[1]["fid"], "d1");
        assert_eq!(parsed[1]["name"], "父目录");

        let only_pdir = json!({
            "data": {
                "fid": "d2",
                "file_name": "子目录",
                "pdir_fid": "d1"
            }
        });
        let reconstructed = parse_crumbs_from_info(&only_pdir, "d2");
        assert_eq!(reconstructed.len(), 3);
        assert_eq!(reconstructed[0]["fid"], "0");
        assert_eq!(reconstructed[1]["fid"], "d1");
        assert_eq!(reconstructed[2]["fid"], "d2");
        assert_eq!(reconstructed[2]["name"], "子目录");
    }
    #[test]
    fn dir_detail_storage_detail_archive_recycle_and_revisions_parse_accurately() {
        let dd = parse_dir_detail(
            "dir1",
            &json!({"data": {"dir_scan_finish": "true", "include_items": "7", "include_items_size": "190124525"}}),
        );
        assert_eq!(dd["fid"], "dir1");
        assert_eq!(dd["size"], 190124525);
        assert_eq!(dd["items"], 7);
        assert_eq!(dd["finished"], true);

        let sd = parse_storage_detail(&json!({
            "data": {
                "storage_data": [
                    {"src_name": "UPLOAD", "size": 1000, "count": 5},
                    {"src_name": "SAVE_AS_ALL", "size": 5000, "count": 20},
                    {"src_name": "OTHER", "size": 0, "count": 0}
                ]
            }
        }));
        assert_eq!(sd["total"], 6000);
        assert_eq!(sd["items"].as_array().unwrap().len(), 2);
        assert_eq!(sd["items"][0]["label"], "分享转存");
        assert_eq!(sd["items"][1]["label"], "手动上传");

        let ap = parse_archive_preview(
            &json!({
                "data": {
                    "finish": true,
                    "total_file_count": 7,
                    "file_list": [
                        {"file_name": "docs &amp; pdf", "is_folder": true, "path": "/docs &amp; pdf", "path_no": 1, "size": 0, "updated_at": 1791808402770_i64},
                        {"file_name": "readme.txt", "is_folder": false, "path": "/readme.txt", "path_no": 2, "size": 256, "updated_at": 1791808402770_i64}
                    ]
                },
                "metadata": {"_count": 2, "_size": 50, "tq_gap": 500}
            }),
            1,
            50,
        );
        assert_eq!(ap["finish"], true);
        assert_eq!(ap["totalFileCount"], 7);
        assert_eq!(ap["list"][0]["name"], "docs & pdf");
        assert_eq!(ap["list"][0]["dir"], true);
        assert_eq!(ap["list"][1]["ext"], "txt");
        assert_eq!(ap["hasMore"], false);

        let at_run = parse_archive_task(&json!({"data": {"task_id": "t1", "status": 1, "progress": 425}})).unwrap();
        assert_eq!(at_run["done"], false);
        assert_eq!(at_run["progress"], 42.5);
        let at_done = parse_archive_task(&json!({"data": {"task_id": "t1", "status": 2, "progress": 1000}})).unwrap();
        assert_eq!(at_done["done"], true);
        assert_eq!(at_done["progress"], 100.0);
        assert_eq!(
            parse_archive_task(&json!({"data": {"task_id": "t1", "status": 3}})).unwrap_err().code,
            "TASK_FAILED"
        );

        let rc = parse_recycle_page(
            &json!({
                "data": {
                    "total": 1,
                    "list": [{
                        "record_id": "rec-1",
                        "fid": "f-del",
                        "file_name": "old.pdf",
                        "file_type": 1,
                        "size": 1024,
                        "pdir_fid": "0",
                        "pdir_file_name": "文档",
                        "move_recycle_at": 1791757542479_i64,
                        "move_deep_recycle_at": 1799533542479_i64,
                        "invisible_remain": 4170040308_i64
                    }]
                }
            }),
            1,
            50,
        );
        assert_eq!(rc["total"], 1);
        assert_eq!(rc["list"][0]["recordId"], "rec-1");
        assert_eq!(rc["list"][0]["pdirName"], "文档");
        assert_eq!(rc["list"][0]["remainMs"], 4170040308_i64);

        let rv = parse_revisions(&json!({
            "data": [
                {"version": 3, "fid": "f1", "file_name": "doc.docx", "size": 2048, "updated_at": 1791800000000_i64, "is_current": true}
            ]
        }));
        assert_eq!(rv["list"][0]["version"], 3);
        assert_eq!(rv["list"][0]["current"], true);

        let rich = file_item(&json!({
            "fid": "f9",
            "file_name": "clip.mp4",
            "dir": false,
            "size": 4096,
            "format_type": "video/mp4",
            "obj_category": "video",
            "duration": 125,
            "fps": 29.97,
            "source_display": "save_share",
            "operated_at": 1791715727568_i64
        }));
        assert_eq!(rich["formatType"], "video/mp4");
        assert_eq!(rich["duration"], 125);
        assert_eq!(rich["fps"], 29.97);
        assert_eq!(rich["source"], "save_share");
    }
}
