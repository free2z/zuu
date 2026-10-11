use anyhow::Result;
use std::os::unix::fs::PermissionsExt;
use zcash_paymentd::{
    Event, Payment,
    config::Consumer,
    delivery::{Automation, ExecAutomation},
};

#[tokio::test]
async fn example_commits_duplicate_event_once_and_refuses_unsupported_schema() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let database = dir.path().join("example.sqlite");
    let hook = ExecAutomation(Consumer {
        id: "example".into(),
        argv: vec![
            "/usr/bin/python3".into(),
            format!("{}/examples/record_event.py", env!("CARGO_MANIFEST_DIR")),
            database.to_string_lossy().into_owned(),
        ],
        timeout_seconds: 5,
        observe_unconfirmed: false,
    });
    let mut event = Event {
        schema_version: 1,
        journal_sequence: 1,
        event_id: "synthetic-note:1:confirmed".into(),
        kind: "payment.confirmed".into(),
        network: "test".into(),
        payment: Payment {
            id: "synthetic-note".into(),
            txid: "synthetic-transaction".into(),
            pool: "sapling".into(),
            output_index: 0,
            value_zatoshis: 1,
            memo_hex: hex::encode([0; 512]),
            recipient_hex: hex::encode([0; 43]),
        },
        block_height: 1,
        block_hash: "synthetic-block".into(),
        revision: 1,
    };
    hook.handle(&event).await?;
    hook.handle(&event).await?;
    event.schema_version = 2;
    event.event_id = "must-not-be-acknowledged".into();
    assert!(hook.handle(&event).await.is_err());
    let db = rusqlite::Connection::open(&database)?;
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM received", [], |r| r.get::<_, u32>(0))?,
        1
    );
    assert_eq!(
        db.query_row("SELECT event_id FROM received", [], |r| r
            .get::<_, String>(0))?,
        "synthetic-note:1:confirmed"
    );
    assert_eq!(
        std::fs::metadata(&database)?.permissions().mode() & 0o077,
        0
    );
    Ok(())
}
