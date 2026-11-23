use anyhow::Result;
#[cfg(target_os = "linux")]
use anyhow::bail;
use anyhow::ensure;
#[cfg(target_os = "linux")]
use std::time::Duration;
use tempfile::{Builder, TempDir};
use zcash_paymentd::{
    Event, Payment,
    config::Consumer,
    delivery::{Automation, ExecAutomation, HookFailure, failure_reason},
};

fn event() -> Event {
    Event {
        schema_version: 1,
        journal_sequence: 1,
        event_id: "event-id".into(),
        kind: "payment.confirmed".into(),
        network: "main".into(),
        payment: Payment {
            id: "payment-id".into(),
            txid: "txid".into(),
            pool: "ironwood".into(),
            output_index: 0,
            value_zatoshis: 1,
            memo_hex: hex::encode([0; 512]),
            recipient_hex: hex::encode([0; 43]),
        },
        block_height: 3_500_000,
        block_hash: "blockhash".into(),
        revision: 1,
    }
}
// The script body is fixed. All dynamic paths and expected values are argv data.
fn handler_argv(args: impl IntoIterator<Item = String>) -> Vec<String> {
    [
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "test -z \"$HOME\" || exit 2\ntest \"$2\" = \"$3\" || exit 3\n/bin/cat > \"$1\"".into(),
            "hook".into(),
        ],
        args.into_iter().collect(),
    ]
    .concat()
}

#[cfg(target_os = "linux")]
fn maximum_new_pipe_capacity() -> Result<usize> {
    let capacity = std::fs::read_to_string("/proc/sys/fs/pipe-max-size")?
        .trim()
        .parse::<usize>()?;
    ensure!(capacity > 0, "kernel pipe capacity limit must be positive");
    Ok(capacity)
}

#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> Result<bool> {
    let stat_path = format!("/proc/{pid}/stat");
    let stat = match std::fs::read_to_string(stat_path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        // A process that exits between open and read makes procfs return ESRCH.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    // `comm` is parenthesized and may contain spaces or parentheses. The state
    // field follows its final `)`; zombies and dead processes cannot execute.
    let state = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().next())
        .ok_or_else(|| anyhow::anyhow!("invalid /proc/{pid}/stat"))?;
    Ok(state != "Z" && state != "X")
}

#[tokio::test]
async fn handler_gets_json_literal_arguments_without_inherited_env() -> Result<()> {
    let root = TempDir::new()?;
    let marker = root.path().join("shell-injection");
    // Include a quote and command syntax in this test's directory name without
    // changing process-global TMPDIR; a shell-source interpolation would run it.
    let prefix = "hook-'$(touch \"$4\")'-";
    let d = Builder::new().prefix(&prefix).tempdir_in(root.path())?;
    ensure!(
        d.path().to_string_lossy().contains("'$(touch \"$4\")'"),
        "test temp directory must contain shell metacharacters"
    );
    let output = d.path().join("output");
    let output_path = output.to_string_lossy().into_owned();
    let literal = format!("$(touch {})", d.path().join("literal-marker").display());
    let a = ExecAutomation(Consumer {
        id: "test".into(),
        argv: handler_argv([
            output_path,
            literal.clone(),
            literal,
            marker.to_string_lossy().into_owned(),
        ]),
        timeout_seconds: 2,
        observe_unconfirmed: false,
    });
    let e = event();
    a.handle(&e).await?;
    assert!(
        !marker.exists(),
        "shell syntax in the temp path was evaluated"
    );
    assert!(!d.path().join("literal-marker").exists());
    let received: Event = serde_json::from_str(&std::fs::read_to_string(output)?)?;
    assert_eq!(received, e);
    Ok(())
}
#[tokio::test]
#[cfg(target_os = "linux")]
async fn timeout_includes_blocked_stdin_and_terminates_descendants() -> Result<()> {
    let d = TempDir::new()?;
    let descendant_pid = d.path().join("descendant-pid");
    let maximum_capacity = maximum_new_pipe_capacity()?;
    let mut large_event = event();
    // Event IDs are unbounded strings in the serialized Event delivery type.
    // Linux caps every new pipe's default capacity at pipe-max-size.
    large_event.event_id = format!("event-{}", "x".repeat(maximum_capacity + 4096));
    let wire = serde_json::to_vec(&large_event)?;
    ensure!(
        wire.len() > maximum_capacity,
        "test event must exceed maximum new-pipe capacity"
    );
    ensure!(
        serde_json::from_slice::<Event>(&wire)? == large_event,
        "large test event must remain a complete Event"
    );
    let a = ExecAutomation(Consumer {
        id: "hung".into(),
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "(/bin/sh -c 'echo $$ > \"$1\"; exec /bin/sleep 60' hook \"$1\") &\nexec /bin/sleep 60"
                .into(),
            "hook".into(),
            descendant_pid.to_string_lossy().into_owned(),
        ],
        timeout_seconds: 5,
        observe_unconfirmed: false,
    });
    let mut handle = tokio::spawn(async move { a.handle(&large_event).await });
    let readiness = tokio::time::timeout(Duration::from_secs(8), async {
        while !descendant_pid.exists() && !handle.is_finished() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    if readiness.is_err() || !descendant_pid.exists() {
        handle.abort();
        let _ = handle.await;
        bail!("non-reading child never signalled readiness");
    }

    // The ready child does not read stdin. A payload larger than the pipe must
    // leave the handler pending in write_all until ExecAutomation's deadline.
    if tokio::time::timeout(Duration::from_millis(100), &mut handle)
        .await
        .is_ok()
    {
        bail!("hook completed before the oversized stdin write blocked");
    }
    match tokio::time::timeout(Duration::from_secs(7), &mut handle).await {
        Ok(Ok(Err(error))) => ensure!(
            error.to_string().contains("hook timed out"),
            "expected ExecAutomation's write deadline, got: {error:#}"
        ),
        Ok(Ok(Ok(()))) => bail!("non-reading hook unexpectedly completed successfully"),
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            handle.abort();
            let _ = handle.await;
            bail!("outer test deadline expired; hook timeout did not bound stdin write");
        }
    }
    let pid = std::fs::read_to_string(descendant_pid)?
        .trim()
        .parse::<u32>()?;
    let descendant_exited = tokio::time::timeout(Duration::from_secs(2), async {
        while process_is_running(pid)? {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await;
    match descendant_exited {
        Ok(result) => result?,
        Err(_) => bail!("hook descendant process {pid} survived timeout"),
    }
    Ok(())
}

// Fixed shell bodies run through `/bin/sh -c`, matching `handler_argv`: no
// executable is written and then immediately spawned (avoids ETXTBSY races).
fn shell(body: &str) -> Vec<String> {
    vec!["/bin/sh".into(), "-c".into(), body.into(), "hook".into()]
}

fn hook_failure(error: &anyhow::Error) -> HookFailure {
    *error
        .downcast_ref::<HookFailure>()
        .expect("classified hook failure")
}

#[tokio::test]
async fn failures_are_classified_without_child_or_event_data() -> Result<()> {
    let d = TempDir::new()?;
    let cases: [(&str, &str, u64, HookFailure, &str); 3] = [
        (
            "exits",
            "/bin/cat >/dev/null\necho private-memo-text >&2\nexit 7",
            2,
            HookFailure::Exit(7),
            "hook exited with status 7",
        ),
        (
            "killed",
            "/bin/cat >/dev/null\nkill -9 $$",
            2,
            HookFailure::Signal(9),
            "hook killed by signal 9",
        ),
        (
            "slow",
            "/bin/cat >/dev/null\n/bin/sleep 30",
            1,
            HookFailure::TimedOut(1),
            "hook timed out after 1s",
        ),
    ];
    for (name, body, timeout_seconds, expected, reason) in cases {
        let a = ExecAutomation(Consumer {
            id: name.into(),
            argv: shell(body),
            timeout_seconds,
            observe_unconfirmed: false,
        });
        let error = a.handle(&event()).await.expect_err(name);
        assert_eq!(hook_failure(&error), expected);
        assert_eq!(failure_reason(&error), reason);
        assert!(!failure_reason(&error).contains("private"));
    }
    let missing = ExecAutomation(Consumer {
        id: "missing".into(),
        argv: vec![d.path().join("absent").to_string_lossy().into_owned()],
        timeout_seconds: 2,
        observe_unconfirmed: false,
    });
    let error = missing.handle(&event()).await.expect_err("missing hook");
    assert_eq!(hook_failure(&error), HookFailure::Start);
    assert_eq!(failure_reason(&error), "hook could not start");
    // Anything unclassified keeps a fixed generic reason, never its message.
    assert_eq!(
        failure_reason(&anyhow::anyhow!("memo 6a6f686e and SELECT * FROM users")),
        "hook failed"
    );
    Ok(())
}

#[tokio::test]
async fn hook_exiting_before_reading_reports_its_own_status() -> Result<()> {
    let a = ExecAutomation(Consumer {
        id: "early".into(),
        argv: shell("exit 3"),
        timeout_seconds: 2,
        observe_unconfirmed: false,
    });
    let error = a.handle(&event()).await.expect_err("early exit");
    assert_eq!(hook_failure(&error), HookFailure::Exit(3));
    Ok(())
}
