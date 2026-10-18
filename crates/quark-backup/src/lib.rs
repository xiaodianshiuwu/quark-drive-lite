//! Windows 重装前海量文件批量上传（夸克备份）。
//!
//! 模块（按 Phase-2 计划 §二）：
//! - `state`：任务状态机（显式枚举 + 迁移守卫）
//! - `store`：SQLite 持久任务库（身份键 (account, rootDir, targetFid, relPath)）
//! - `scanner`：分批目录扫描（walkdir，junction/symlink 默认不跟随）
//! - `scheduler`：水位背压 + 并发调度 + 指数退避
//! - `uploader`：复用 quark-transfer 的单文件上传核心，绕过其 GUI 任务队列
//! - `verifier`：清单核对 + 抽样下载比对
//!
pub mod manager;
pub mod scheduler;
pub mod verifier;
pub mod scanner;
pub mod state;
pub mod store;

pub use state::{next_retry_delay_ms, TaskState};
pub use manager::{BackupError, BackupManager, CoreRemote};
pub use scheduler::{worker_loop, BackupConfig, RemoteOps, SchedulerStats};
pub use verifier::{verify_manifest, verify_sample, VerifyReport};
pub use store::{Store, Task};
