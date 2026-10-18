//! 备份任务状态机（显式枚举 + 迁移守卫）。
//!
//! 状态：discovered → pending → uploading → verifying → success
//!                            ↘ failed / skipped / canceled（可从 pending/uploading/verifying 进入）
//! 守卫规则（非法迁移一律拒绝，不静默改写）：
//! - 终态（success/failed/skipped/canceled）只能回到 pending（手动重试）；
//! - uploading/verifying 只能从 pending 进入（或 resume 恢复 interrupted）；
//! - canceled 从任何非终态进入。

use serde::{Deserialize, Serialize};

/// 任务状态（与持久库字符串一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    /// 已发现（等待入队）
    Discovered,
    /// 排队中（等待上传槽）
    Pending,
    /// 上传中
    Uploading,
    /// 校验中（远端可见性/清单核对）
    Verifying,
    /// 成功
    Success,
    /// 失败（可重试；attempts 记录次数）
    Failed,
    /// 跳过（冲突/策略排除等，非错误）
    Skipped,
    /// 已取消（用户显式）
    Canceled,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Discovered => "discovered",
            TaskState::Pending => "pending",
            TaskState::Uploading => "uploading",
            TaskState::Verifying => "verifying",
            TaskState::Success => "success",
            TaskState::Failed => "failed",
            TaskState::Skipped => "skipped",
            TaskState::Canceled => "canceled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "discovered" => TaskState::Discovered,
            "pending" => TaskState::Pending,
            "uploading" => TaskState::Uploading,
            "verifying" => TaskState::Verifying,
            "success" => TaskState::Success,
            "failed" => TaskState::Failed,
            "skipped" => TaskState::Skipped,
            "canceled" => TaskState::Canceled,
            _ => return None,
        })
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, TaskState::Success | TaskState::Failed | TaskState::Skipped | TaskState::Canceled)
    }

    pub fn is_active(&self) -> bool {
        matches!(self, TaskState::Uploading | TaskState::Verifying)
    }

    /// 状态迁移守卫：合法迁移返回 Ok(())，非法返回 Err(说明)。
    pub fn can_transition_to(&self, next: TaskState) -> Result<(), String> {
        use TaskState::*;
        let ok = match (self, next) {
            // 正向流水线
            (Discovered, Pending) => true,
            (Pending, Uploading) => true,
            (Uploading, Verifying) => true,
            (Verifying, Success) => true,
            // 失败/跳过/取消：从任何非终态
            (Discovered, Failed | Skipped | Canceled) => true,
            (Pending, Failed | Skipped | Canceled) => true,
            (Uploading, Failed | Canceled) => true,
            (Verifying, Failed | Canceled) => true,
            // 手动重试：终态回 pending（attempts 由调用方维护）
            (Failed, Pending) => true,
            (Skipped, Pending) => true,
            (Canceled, Pending) => true,
            (Success, Pending) => false, // 成功不该重跑（防覆盖），需显式重新发现
            // 崩溃恢复：应用重启时 uploading/verifying → pending（标记 interrupted 恢复）
            (Uploading, Pending) | (Verifying, Pending) => true,
            _ => false,
        };
        if ok {
            Ok(())
        } else {
            Err(format!("非法状态迁移：{} → {}", self.as_str(), next.as_str()))
        }
    }
}

/// 计算下次重试延迟：指数 2^n × base。`attempts` 是**已失败次数**（本次失败后传入的值
/// 含本次）。返回 None 表示达到上限不再重试。
pub fn next_retry_delay_ms(attempts: u32, base_ms: u64, max_attempts: u32) -> Option<u64> {
    // attempts=1 表示第一次失败；还允许重试当且仅当已重试次数 < max_attempts-1 …
    // 语义简化：max_attempts 是"总尝试上限"。已尝试 attempts 次，若 attempts >= max 则停。
    if attempts >= max_attempts {
        return None;
    }
    let n = attempts.saturating_sub(1).min(16); // 第一次失败退避 base，第二次 2×base…
    Some(base_ms.saturating_mul(1u64 << n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_pipeline_is_legal() {
        assert!(TaskState::Discovered.can_transition_to(TaskState::Pending).is_ok());
        assert!(TaskState::Pending.can_transition_to(TaskState::Uploading).is_ok());
        assert!(TaskState::Uploading.can_transition_to(TaskState::Verifying).is_ok());
        assert!(TaskState::Verifying.can_transition_to(TaskState::Success).is_ok());
    }

    #[test]
    fn illegal_jumps_are_rejected() {
        assert!(TaskState::Discovered.can_transition_to(TaskState::Success).is_err());
        assert!(TaskState::Discovered.can_transition_to(TaskState::Uploading).is_err());
        assert!(TaskState::Pending.can_transition_to(TaskState::Verifying).is_err());
        assert!(TaskState::Success.can_transition_to(TaskState::Pending).is_err());
        assert!(TaskState::Success.can_transition_to(TaskState::Uploading).is_err());
    }

    #[test]
    fn terminal_states_reenter_pending_only() {
        for st in [TaskState::Failed, TaskState::Skipped, TaskState::Canceled] {
            assert!(st.can_transition_to(TaskState::Pending).is_ok());
            assert!(st.can_transition_to(TaskState::Uploading).is_err());
        }
    }

    #[test]
    fn cancel_allowed_from_any_active_state() {
        for st in [TaskState::Discovered, TaskState::Pending, TaskState::Uploading, TaskState::Verifying] {
            assert!(st.can_transition_to(TaskState::Canceled).is_ok());
        }
    }

    #[test]
    fn crash_recovery_maps_to_pending() {
        assert!(TaskState::Uploading.can_transition_to(TaskState::Pending).is_ok());
        assert!(TaskState::Verifying.can_transition_to(TaskState::Pending).is_ok());
    }

    #[test]
    fn backoff_is_exponential_with_cap_and_stop() {
        let base = 30_000u64;
        // attempts = 已失败总次数：1=首次失败（退避 base），2=第二次（2×base）…
        assert_eq!(next_retry_delay_ms(1, base, 6), Some(30_000));
        assert_eq!(next_retry_delay_ms(2, base, 6), Some(60_000));
        assert_eq!(next_retry_delay_ms(3, base, 6), Some(120_000));
        assert_eq!(next_retry_delay_ms(6, base, 6), None, "达到上限不再重试");
    }

    #[test]
    fn state_round_trip() {
        for st in [
            TaskState::Discovered, TaskState::Pending, TaskState::Uploading,
            TaskState::Verifying, TaskState::Success, TaskState::Failed,
            TaskState::Skipped, TaskState::Canceled,
        ] {
            assert_eq!(TaskState::parse(st.as_str()), Some(st));
        }
        assert_eq!(TaskState::parse("bogus"), None);
    }
}
