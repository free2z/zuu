use crate::{Event, config::Consumer};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

#[async_trait]
pub trait Automation: Send + Sync {
    /// Return only after committing an idempotent effect keyed by event_id.
    /// A crash after an external effect can repeat this call.
    async fn handle(&self, event: &Event) -> Result<()>;
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
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow::anyhow!("hook has no process id"))?;
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
            input.write_all(&bytes).await?;
            input.write_all(b"\n").await?;
            drop(input);
            let status = child.wait().await?;
            ensure!(status.success(), "hook exited unsuccessfully");
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(self.0.timeout_seconds), operation)
            .await
            .map_err(|_| anyhow::anyhow!("hook timed out"))?
    }
}
