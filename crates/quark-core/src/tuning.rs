//! Signed remote runtime tuning profile (L1 hot-config).
//!
//! Parameters are fetched exclusively from the Ed25519-verified Hub manifest when
//! `serverOptIn == true`, clamped to strictly safe bounds, persisted locally in
//! `<profile>/runtime-tuning.json`, and applied live without restarting or
//! reinstalling the application.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

const MIB: u64 = 1024 * 1024;
const TUNING_FILENAME: &str = "runtime-tuning.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TuningProfile {
    /// Monotonically increasing remote profile revision (0 = built-in defaults).
    pub version: u64,
    /// Files at or below this byte threshold skip the 1-byte Range probe and download
    /// in a single direct stream with inline hashing. Set to 0 to disable.
    pub small_file_direct_max_bytes: u64,
    /// Adaptive multipart chunk sizes (MiB) by file size tier.
    pub chunk_size_gt_2g_mb: u64,
    pub chunk_size_gt_512m_mb: u64,
    pub chunk_size_gt_128m_mb: u64,
    pub chunk_size_gt_32m_mb: u64,
    pub chunk_size_default_mb: u64,
    /// Enable AIMD dynamic concurrency backoff when part retries spike on weak networks.
    pub aimd_enabled: bool,
    /// Retry count window before halving active multipart workers.
    pub aimd_retry_threshold: u32,
    /// Floor for AIMD concurrency reduction.
    pub aimd_min_parallel: usize,
    /// Consecutive clean parts before stepping concurrency back up by +1.
    pub aimd_recover_clean_parts: u32,
    /// Negative cache TTL (ms) for failed `fs.dirDetail` calls in the renderer.
    pub dir_detail_neg_cache_ms: u64,
    /// Background `fs.dirDetail` prefetch concurrency in the renderer.
    pub dir_detail_concurrency: u32,
}

impl Default for TuningProfile {
    fn default() -> Self {
        Self {
            version: 0,
            small_file_direct_max_bytes: 8 * MIB,
            chunk_size_gt_2g_mb: 16,
            chunk_size_gt_512m_mb: 8,
            chunk_size_gt_128m_mb: 4,
            chunk_size_gt_32m_mb: 2,
            chunk_size_default_mb: 1,
            aimd_enabled: true,
            aimd_retry_threshold: 2,
            aimd_min_parallel: 2,
            aimd_recover_clean_parts: 8,
            dir_detail_neg_cache_ms: 300_000,
            dir_detail_concurrency: 2,
        }
    }
}

impl TuningProfile {
    /// Clamp every field to safe operating bounds so malformed remote configs
    /// can never destabilize transfers or exhaust memory.
    pub fn sanitized(mut self) -> Self {
        self.small_file_direct_max_bytes = self.small_file_direct_max_bytes.min(32 * MIB);
        self.chunk_size_gt_2g_mb = self.chunk_size_gt_2g_mb.clamp(1, 16);
        self.chunk_size_gt_512m_mb = self.chunk_size_gt_512m_mb.clamp(1, 16);
        self.chunk_size_gt_128m_mb = self.chunk_size_gt_128m_mb.clamp(1, 16);
        self.chunk_size_gt_32m_mb = self.chunk_size_gt_32m_mb.clamp(1, 8);
        self.chunk_size_default_mb = self.chunk_size_default_mb.clamp(1, 4);
        self.aimd_retry_threshold = self.aimd_retry_threshold.clamp(1, 10);
        self.aimd_min_parallel = self.aimd_min_parallel.clamp(1, 8);
        self.aimd_recover_clean_parts = self.aimd_recover_clean_parts.clamp(3, 32);
        self.dir_detail_neg_cache_ms = self.dir_detail_neg_cache_ms.clamp(10_000, 3_600_000);
        self.dir_detail_concurrency = self.dir_detail_concurrency.clamp(1, 4);
        self
    }

    pub fn from_patch(base: &Self, patch: &Value) -> Result<Self> {
        let obj = patch
            .as_object()
            .ok_or_else(|| Error::new("INVALID_ARG", "热配置必须为 JSON 对象"))?;
        let mut merged = serde_json::to_value(base)
            .map_err(|_| Error::new("SYSTEM", "热配置序列化失败"))?;
        if let Some(target) = merged.as_object_mut() {
            for (k, v) in obj {
                if target.contains_key(k) {
                    target.insert(k.clone(), v.clone());
                }
            }
        }
        let parsed: Self = serde_json::from_value(merged)
            .map_err(|_| Error::new("INVALID_ARG", "热配置字段类型无效"))?;
        Ok(parsed.sanitized())
    }

    pub fn load_from_dir(profile_dir: &Path) -> Self {
        let path = profile_dir.join(TUNING_FILENAME);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            return Self::default();
        };
        if !meta.file_type().is_file() || meta.len() > 64 * 1024 {
            return Self::default();
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return Self::default();
        };
        serde_json::from_slice::<Self>(&bytes)
            .map(Self::sanitized)
            .unwrap_or_default()
    }

    pub fn save_to_dir(&self, profile_dir: &Path) -> Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(profile_dir)
            .map_err(|_| Error::new("LOCAL_IO", "无法创建热配置目录"))?;
        let path = profile_dir.join(TUNING_FILENAME);
        let tmp = profile_dir.join(format!(".{TUNING_FILENAME}.{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|_| Error::new("SYSTEM", "热配置编码失败"))?;
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts
                .open(&tmp)
                .map_err(|_| Error::new("LOCAL_IO", "无法写入热配置临时文件"))?;
            f.write_all(&bytes)
                .and_then(|_| f.sync_all())
                .map_err(|_| Error::new("LOCAL_IO", "写入热配置失败"))?;
        }
        #[cfg(windows)]
        {
            let _ = std::fs::remove_file(&path);
        }
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::new("LOCAL_IO", "保存热配置文件失败"));
        }
        Ok(())
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    pub fn choose_chunk_size(&self, total: u64) -> u64 {
        let mb = if total > 2048 * MIB {
            self.chunk_size_gt_2g_mb
        } else if total > 512 * MIB {
            self.chunk_size_gt_512m_mb
        } else if total > 128 * MIB {
            self.chunk_size_gt_128m_mb
        } else if total > 32 * MIB {
            self.chunk_size_gt_32m_mb
        } else {
            self.chunk_size_default_mb
        };
        mb.clamp(1, 16) * MIB
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tuning_profile_clamps_out_of_bounds_values_and_persists() {
        let base = TuningProfile::default();
        let patched = TuningProfile::from_patch(
            &base,
            &json!({
                "version": 7,
                "smallFileDirectMaxBytes": 999_999_999u64,
                "chunkSizeGt2gMb": 128,
                "aimdMinParallel": 0,
                "dirDetailNegCacheMs": 500,
                "dirDetailConcurrency": 99,
                "unknownField": "ignored"
            }),
        )
        .unwrap();
        assert_eq!(patched.version, 7);
        assert_eq!(patched.small_file_direct_max_bytes, 32 * MIB);
        assert_eq!(patched.chunk_size_gt_2g_mb, 16);
        assert_eq!(patched.aimd_min_parallel, 1);
        assert_eq!(patched.dir_detail_neg_cache_ms, 10_000);
        assert_eq!(patched.dir_detail_concurrency, 4);

        let dir = tempfile::tempdir().unwrap();
        patched.save_to_dir(dir.path()).unwrap();
        let loaded = TuningProfile::load_from_dir(dir.path());
        assert_eq!(loaded, patched);
    }
}
