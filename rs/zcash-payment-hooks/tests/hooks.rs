use anyhow::Result;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;
use zcash_paymentd::{
    Event, Payment,
    config::Consumer,
    delivery::{Automation, ExecAutomation},
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
fn script(dir: &TempDir, name: &str, body: &str) -> Result<String> {
    let p = dir.path().join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n"))?;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700))?;
    Ok(p.to_string_lossy().into_owned())
}
#[tokio::test]
async fn handler_gets_json_literal_arguments_without_inherited_env() -> Result<()> {
    let d = TempDir::new()?;
    let output = d.path().join("output");
    let hook = script(
        &d,
        "hook",
        "test -z \"$HOME\" || exit 2\ntest \"$2\" = '$(touch should-not-exist)' || exit 3\n/bin/cat > \"$1\"",
    )?;
    let a = ExecAutomation(Consumer {
        id: "test".into(),
        argv: vec![
            hook,
            output.to_string_lossy().into_owned(),
            "$(touch should-not-exist)".into(),
        ],
        timeout_seconds: 2,
        observe_unconfirmed: false,
    });
    let e = event();
    a.handle(&e).await?;
    let received: Event = serde_json::from_str(&std::fs::read_to_string(output)?)?;
    assert_eq!(received, e);
    Ok(())
}
#[tokio::test]
async fn timeout_includes_blocked_stdin_and_terminates_descendants() -> Result<()> {
    let d = TempDir::new()?;
    let marker = d.path().join("descendant-survived");
    let hook = script(
        &d,
        "hung",
        "(/bin/sleep 2; /usr/bin/touch \"$1\") &\n/bin/sleep 60",
    )?;
    let a = ExecAutomation(Consumer {
        id: "hung".into(),
        argv: vec![hook, marker.to_string_lossy().into_owned()],
        timeout_seconds: 1,
        observe_unconfirmed: false,
    });
    assert!(a.handle(&event()).await.is_err());
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert!(!marker.exists());
    Ok(())
}
