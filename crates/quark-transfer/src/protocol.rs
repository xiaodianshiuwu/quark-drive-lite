use crate::manager::{err, Result};
use unicode_normalization::UnicodeNormalization;
pub const OSS_USER_AGENT: &str = "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";
#[cfg(test)]
pub fn put_meta(
    mime: &str,
    date: &str,
    bucket: &str,
    key: &str,
    part: u64,
    upload_id: &str,
) -> String {
    put_meta_with_ctx(mime, date, bucket, key, part, upload_id, None)
}
pub fn put_meta_with_ctx(
    mime: &str,
    date: &str,
    bucket: &str,
    key: &str,
    part: u64,
    upload_id: &str,
    hash_context: Option<&str>,
) -> String {
    // The observed protocol signs this header with exactly this capitalization.
    let context = hash_context
        .map(|s| format!("X-Oss-Hash-Ctx:{s}\n"))
        .unwrap_or_default();
    format!("PUT\n\n{mime}\n{date}\n{context}x-oss-date:{date}\nx-oss-user-agent:{OSS_USER_AGENT}\n/{bucket}/{key}?partNumber={part}&uploadId={upload_id}")
}
pub fn complete_meta(
    md5: &str,
    date: &str,
    callback: &str,
    bucket: &str,
    key: &str,
    upload_id: &str,
) -> String {
    format!("POST\n{md5}\napplication/xml\n{date}\nx-oss-callback:{callback}\nx-oss-date:{date}\nx-oss-user-agent:{OSS_USER_AGENT}\n/{bucket}/{key}?uploadId={upload_id}")
}
pub fn xml(parts: &[(u64, String)]) -> String {
    let mut out =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CompleteMultipartUpload>\n".to_string();
    for (n, etag) in parts {
        out += &format!("<Part>\n<PartNumber>{n}</PartNumber>\n<ETag>{etag}</ETag>\n</Part>\n");
    }
    out + "</CompleteMultipartUpload>"
}
pub fn oss_url(raw: &str, bucket: &str, key: &str) -> Result<reqwest::Url> {
    let input = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let u = reqwest::Url::parse(&input).map_err(|_| err("SERVER", "上传地址无效"))?;
    let host = u
        .host_str()
        .ok_or_else(|| err("SERVER", "上传地址缺少主机"))?;
    if !["http", "https"].contains(&u.scheme())
        || bucket.is_empty()
        || bucket.len() > 253
        || !bucket.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !part.starts_with('-')
                && !part.ends_with('-')
        })
        || key.is_empty()
        || key.split('/').any(|part| part == "." || part == "..")
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(err("SERVER", "上传地址或存储桶无效"));
    }
    let mut target = reqwest::Url::parse(&format!("https://{bucket}.{host}/"))
        .map_err(|_| err("SERVER", "上传对象地址无效"))?;
    target
        .path_segments_mut()
        .map_err(|_| err("SERVER", "上传对象路径无效"))?
        .clear()
        .extend(key.trim_start_matches('/').split('/'));
    Ok(target)
}
pub fn safe_name(input: &str) -> String {
    let mut name: String = input
        .nfc()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).into();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        name = "未命名文件".into();
    }
    let first = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&first.as_str())
        || ((first.starts_with("COM") || first.starts_with("LPT"))
            && first.len() == 4
            && matches!(first.as_bytes()[3], b'1'..=b'9'))
    {
        name = format!("_{name}");
    }
    if name.len() > 180 {
        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", trim_utf8(s, 19)))
            .unwrap_or_default();
        let stem = if ext.is_empty() {
            name.as_str()
        } else {
            name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name)
        };
        name = format!("{}{}", trim_utf8(stem, 180 - ext.len()), ext);
    }
    name
}
pub fn safe_dir_segment(input: &str) -> String {
    let mut name: String = input
        .nfc()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).into();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        name = "未命名文件夹".into();
    }
    let first = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&first.as_str())
        || ((first.starts_with("COM") || first.starts_with("LPT"))
            && first.len() == 4
            && matches!(first.as_bytes()[3], b'1'..=b'9'))
    {
        name = format!("_{name}");
    }
    if name.len() > 100 {
        name = trim_utf8(&name, 100)
            .trim_end_matches(['.', ' '])
            .to_string();
        if name.is_empty() {
            name = "未命名文件夹".into();
        }
    }
    name
}
pub fn join_safe_rel_dir(base: &std::path::Path, segments: &[String]) -> Result<std::path::PathBuf> {
    if !base.is_absolute() {
        return Err(err("INVALID_ARG", "下载根目录必须是绝对路径"));
    }
    if segments.len() > 32 {
        return Err(err("INVALID_ARG", "下载目录层级过深（最多支持 32 级子目录）"));
    }
    let mut out = base.to_path_buf();
    for raw in segments {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let seg = safe_dir_segment(trimmed);
        out.push(seg);
    }
    if !out.starts_with(base) {
        return Err(err("INVALID_ARG", "下载子目录路径无效"));
    }
    Ok(out)
}
fn trim_utf8(s: &str, n: usize) -> &str {
    let mut end = s.len().min(n);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
pub fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_strings_match_existing_oss_wire_contract() {
        let ua = "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";
        assert_eq!(OSS_USER_AGENT, ua);
        assert_eq!(put_meta("text/plain", "Tue, 15 Oct 2026 00:00:00 GMT", "fixture-bucket", "fixture/key", 2, "upload-id"), format!("PUT\n\ntext/plain\nTue, 15 Oct 2026 00:00:00 GMT\nx-oss-date:Tue, 15 Oct 2026 00:00:00 GMT\nx-oss-user-agent:{ua}\n/fixture-bucket/fixture/key?partNumber=2&uploadId=upload-id"));
        assert_eq!(complete_meta("digest", "date", "callback", "bucket", "obj", "id"), format!("POST\ndigest\napplication/xml\ndate\nx-oss-callback:callback\nx-oss-date:date\nx-oss-user-agent:{ua}\n/bucket/obj?uploadId=id"));
    }
    #[test]
    fn completion_xml_keeps_part_number_order() {
        assert_eq!(xml(&[(1,"aa".into()),(2,"bb".into())]), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CompleteMultipartUpload>\n<Part>\n<PartNumber>1</PartNumber>\n<ETag>aa</ETag>\n</Part>\n<Part>\n<PartNumber>2</PartNumber>\n<ETag>bb</ETag>\n</Part>\n</CompleteMultipartUpload>");
    }
    #[test]
    fn signed_upload_origin_and_download_names_are_constrained() {
        assert!(oss_url("https://oss.example.net", "bucket", "obj").is_ok());
        // A dotted DNS bucket is not an origin escape; URL normalizes :443.
        assert!(oss_url("https://oss.example.net", "dns.bucket", "obj").is_ok());
        assert!(oss_url("https://oss.example.net:443", "bucket", "obj").is_ok());
        assert!(oss_url("https://oss.example.net:444", "bucket", "obj").is_err());
        assert!(oss_url("https://oss.example.net", "bad/bucket", "obj").is_err());
        assert!(oss_url("https://user:pass@oss.example.net", "bucket", "obj").is_err());
        assert!(oss_url("https://oss.example.net/?token=x", "bucket", "obj").is_err());
        assert_eq!(
            oss_url("oss.example.net", "bucket", "a/b?#%.txt")
                .unwrap()
                .as_str(),
            "https://bucket.oss.example.net/a/b%3F%23%25.txt"
        );
        assert_eq!(safe_name("../CON.txt"), ".._CON.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(
            content_range("bytes 0-1048575/5000000"),
            Some((0, 1048575, 5000000))
        );
        assert_eq!(content_range("bytes */5000000"), None);
    }
    #[test]
    fn prefix_context_is_signed_in_the_observed_header_position() {
        assert_eq!(put_meta_with_ctx("text/plain", "date", "b", "k", 2, "u", Some("Y3R4")), format!("PUT\n\ntext/plain\ndate\nX-Oss-Hash-Ctx:Y3R4\nx-oss-date:date\nx-oss-user-agent:{OSS_USER_AGENT}\n/b/k?partNumber=2&uploadId=u"));
    }
    #[test]
    fn safe_rel_dir_sanitizes_windows_chars_reserved_names_and_traversal() {
        let base = std::env::temp_dir().join("qdl-base");
        let joined = join_safe_rel_dir(
            &base,
            &[
                "2026/Q1:报表*?".into(),
                "..".into(),
                "CON".into(),
                "trailing. ".into(),
            ],
        )
        .unwrap();
        assert!(joined.starts_with(&base));
        let rel: Vec<String> = joined
            .strip_prefix(&base)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert_eq!(rel, vec!["2026_Q1_报表__", "未命名文件夹", "_CON", "trailing"]);
        // Depth limit enforced
        let too_deep: Vec<String> = (0..33).map(|i| format!("d{i}")).collect();
        assert_eq!(
            join_safe_rel_dir(&base, &too_deep).unwrap_err().code,
            "INVALID_ARG"
        );
    }
}
