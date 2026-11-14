use crate::{Event, config::Consumer};
use anyhow::Result;
use async_trait::async_trait;
use std::{fmt, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

#[async_trait]
pub trait Automation: Send + Sync {
    /// Return only after committing an idempotent effect keyed by event_id.
    /// A crash after an external effect can repeat this call.
    async fn handle(&self, event: &Event) -> Result<()>;
}

/// Why one hook delivery failed. Every variant renders from fixed words and
/// integers only: the text is persisted as `deliveries.last_error`, shown by
/// `status` and summarized by production health, so it must never carry
/// payment, memo, address, SQL or child output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookFailure {
    /// The executable could not be spawned (missing, not executable, fork failure).
    Start,
    /// The event could not be written to the hook's stdin.
    Input,
    /// The hook exited normally with a nonzero status.
    Exit(i32),
    /// The hook was terminated by a signal (for example its own group SIGKILL).
    Signal(i32),
    /// Waiting for the hook failed.
    Wait,
    /// The consumer's `timeout_seconds` elapsed; the whole group was killed.
    TimedOut(u64),
}

impl fmt::Display for HookFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start => write!(f, "hook could not start"),
            Self::Input => write!(f, "hook input could not be written"),
            Self::Exit(code) => write!(f, "hook exited with status {code}"),
            Self::Signal(signal) => write!(f, "hook killed by signal {signal}"),
            Self::Wait => write!(f, "hook wait failed"),
            Self::TimedOut(seconds) => write!(f, "hook timed out after {seconds}s"),
        }
    }
}

impl std::error::Error for HookFailure {}

/// The bounded, data-free journal reason for a failed delivery. Errors that are
/// not a classified `HookFailure` keep the historical generic text rather than
/// risk persisting an arbitrary message.
pub fn failure_reason(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<HookFailure>()
        .map_or_else(|| "hook failed".to_owned(), ToString::to_string)
}

fn exit_failure(status: std::process::ExitStatus) -> HookFailure {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => HookFailure::Exit(code),
        (None, Some(signal)) => HookFailure::Signal(signal),
        (None, None) => HookFailure::Wait,
    }
}

pub struct ExecAutomation(pub Consumer);
#[async_trait]
impl Automation for ExecAutomation {
    async fn handle(&self, event: &Event) -> Result<()> {
        let mut command = tokio::process::Command::new(&self.0.argv[0]);
        command
            .args(&self.0.argv[1..])
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // New process group lets timeout terminate descendants, not just the wrapper.
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| HookFailure::Start)?;
        let pid = child.id().ok_or(HookFailure::Start)?;
        struct Group(u32);
        impl Drop for Group {
            fn drop(&mut self) {
                unsafe {
                    libc::kill(-(self.0 as i32), libc::SIGKILL);
                }
            }
        }
        let _group = Group(pid);
        let bytes = serde_json::to_vec(event)?;
        let operation = async {
            let mut input = child.stdin.take().expect("piped stdin");
            let written = async {
                input.write_all(&bytes).await?;
                input.write_all(b"\n").await
            }
            .await;
            drop(input);
            let status = child.wait().await.map_err(|_| HookFailure::Wait)?;
            // A hook that exits before reading reports its own status; a write
            // failure is only the cause when the hook then claims success.
            if !status.success() {
                return Err(exit_failure(status));
            }
            written.map_err(|_| HookFailure::Input)?;
            Ok(())
        };
        let seconds = self.0.timeout_seconds;
        tokio::time::timeout(Duration::from_secs(seconds), operation)
            .await
            .map_err(|_| HookFailure::TimedOut(seconds))?
            .map_err(anyhow::Error::from)
    }
}
