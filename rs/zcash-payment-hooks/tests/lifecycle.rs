use anyhow::Result;
use async_trait::async_trait;
use std::sync::Mutex;
use tempfile::TempDir;
use zcash_paymentd::{
    Payment,
    chain::{Chain, ChainTip, ObservedBlock},
    config::{Config, Consumer},
    journal::{Journal, StateLock},
    scanner,
};

fn config(dir: &TempDir) -> Config {
    Config {
        network: "main".into(),
        rpc_url: "http://127.0.0.1:8232".into(),
        rpc_cookie_file: None,
        ufvk_file: dir.path().join("key"),
        state_dir: dir.path().join("state"),
        birthday_height: 3_500_000,
        automation_start_height: 3_500_001,
        confirmations: 1,
        poll_seconds: 1,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![
            Consumer {
                id: "first".into(),
                argv: vec!["/usr/bin/true".into()],
                timeout_seconds: 1,
                observe_unconfirmed: false,
            },
            Consumer {
                id: "second".into(),
                argv: vec!["/usr/bin/true".into()],
                timeout_seconds: 1,
                observe_unconfirmed: false,
            },
        ],
    }
}
fn payment(pool: &str, index: usize) -> Payment {
    Payment {
        id: format!("main:tx:{pool}:{index}"),
        txid: "tx".into(),
        pool: pool.into(),
        output_index: index,
        value_zatoshis: 1_234_567, // Deliberately synthetic fixture amount.
        memo_hex: hex::encode([0xf6; 512]),
        recipient_hex: hex::encode([0; 43]),
    }
}
fn block(height: u32, hash: &str, previous: &str, payments: Vec<Payment>) -> ObservedBlock {
    ObservedBlock {
        height,
        hash: hash.into(),
        previous_hash: previous.into(),
        payments,
    }
}

#[test]
fn durable_retry_reorg_remining_and_backfill() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "test-viewing-key")?;
    j.append(&block(
        3_500_000,
        "a",
        "parent",
        vec![payment("sapling", 0)],
    ))?;
    assert!(
        j.events(0, 100)?.is_empty(),
        "backfill must not execute automation"
    );
    j.append(&block(
        3_500_001,
        "b",
        "a",
        vec![payment("orchard", 0), payment("ironwood", 0)],
    ))?;
    let original = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(
        j.events(0, 100)?.len(),
        2,
        "pool distinguishes otherwise identical note ids"
    );
    j.failed("first", &original, "timeout")?;
    assert!(j.next("first", 0)?.is_none());
    assert!(
        j.next("second", i64::MAX)?.is_some(),
        "consumer failure must not block another"
    );
    drop(j);
    let mut j = Journal::open(&c, "test-viewing-key")?;
    let retried = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(retried.event.event_id, original.event.event_id);
    assert_eq!(retried.attempts, 1);
    j.acknowledge("first", &retried.event.event_id)?;
    j.rollback_one()?;
    assert_eq!(
        j.next("first", i64::MAX)?.unwrap().event.kind,
        "payment.revoked"
    );
    assert!(
        j.replay("first", &original.event.event_id).is_err(),
        "orphaned confirmation cannot be replayed"
    );
    j.append(&block(3_500_001, "c", "a", vec![payment("orchard", 0)]))?;
    let events = j.events(0, 100)?;
    assert!(
        j.replay("first", &format!("{}:1:revoked", original.event.payment.id))
            .is_err()
    );
    assert_eq!(events.last().unwrap().revision, 2);
    assert_ne!(events.last().unwrap().event_id, original.event.event_id);
    assert_eq!(events.last().unwrap().payment.id, original.event.payment.id);
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].journal_sequence < pair[1].journal_sequence)
    );
    assert!(Journal::open(&c, "different-key").is_err());
    Ok(())
}
#[test]
fn missing_memo_rolls_back_receipt_and_block() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let mut p = payment("ironwood", 0);
    p.memo_hex.clear();
    assert!(
        j.append(&block(
            c.birthday_height,
            "a",
            "parent",
            vec![payment("orchard", 0), p]
        ))
        .is_err()
    );
    assert!(j.cursor()?.is_none());
    assert!(j.events(0, 100)?.is_empty());
    Ok(())
}
#[test]
fn removed_consumer_and_new_consumer_do_not_automatically_backfill() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("orchard", 0)],
    ))?;
    c.consumers.remove(0);
    c.consumers.push(Consumer {
        id: "new".into(),
        argv: vec!["/usr/bin/true".into()],
        timeout_seconds: 1,
        observe_unconfirmed: false,
    });
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    assert!(j.next("new", i64::MAX)?.is_none());
    j.append(&block(
        c.automation_start_height + 1,
        "c",
        "b",
        vec![payment("orchard", 1)],
    ))?;
    assert_eq!(
        j.next("new", i64::MAX)?.unwrap().event.payment.output_index,
        1
    );
    assert_eq!(j.status(&c)?["pending_deliveries"], 3);
    Ok(())
}
struct FakeChain {
    blocks: Mutex<Vec<ObservedBlock>>,
    fail: bool,
    tip_offset: i64,
}
#[async_trait]
impl Chain for FakeChain {
    async fn tip(&self) -> Result<ChainTip> {
        Ok(ChainTip {
            height: self.blocks.lock().unwrap().last().unwrap().height,
            timestamp: zcash_paymentd::now() + self.tip_offset,
        })
    }
    async fn hash(&self, h: u32) -> Result<String> {
        if self.fail {
            anyhow::bail!("pruned block unavailable")
        };
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .find(|b| b.height == h)
            .unwrap()
            .hash
            .clone())
    }
    async fn block(&self, h: u32, _: &str) -> Result<ObservedBlock> {
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .find(|b| b.height == h)
            .unwrap()
            .clone())
    }
}
#[tokio::test]
async fn scanning_confirmations_forks_and_missing_history() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.confirmations = 2;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = FakeChain {
        blocks: Mutex::new(vec![
            block(c.birthday_height - 1, "parent", "earlier", vec![]),
            block(c.birthday_height, "a", "parent", vec![]),
            block(
                c.birthday_height + 1,
                "b",
                "a",
                vec![payment("ironwood", 0)],
            ),
            block(c.birthday_height + 2, "tip", "b", vec![]),
        ]),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.cursor()?.unwrap().0, c.birthday_height + 1);
    assert!(j.ready(&c)?);
    chain.blocks.lock().unwrap()[2] = block(c.birthday_height + 1, "fork", "a", vec![]);
    chain.blocks.lock().unwrap()[3] = block(c.birthday_height + 2, "newtip", "fork", vec![]);
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.events(0, 100)?.last().unwrap().kind, "payment.revoked");
    assert_eq!(j.status(&c)?["active_receipts"], 0);
    let broken = FakeChain {
        blocks: chain.blocks,
        fail: true,
        tip_offset: 0,
    };
    let cursor = j.cursor()?;
    assert!(scanner::scan(&broken, &mut j, &c).await.is_err());
    assert_eq!(j.cursor()?, cursor);
    Ok(())
}
#[test]
fn second_writer_is_refused() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _first = StateLock::acquire(&c.state_dir)?;
    assert!(StateLock::acquire(&c.state_dir).is_err());
    Ok(())
}

struct ForkDuringRecheck {
    hashes: Mutex<std::collections::HashMap<u32, String>>,
    cursor: u32,
}
#[async_trait]
impl Chain for ForkDuringRecheck {
    async fn tip(&self) -> Result<ChainTip> {
        Ok(ChainTip {
            height: self.cursor + 1,
            timestamp: zcash_paymentd::now(),
        })
    }
    async fn hash(&self, h: u32) -> Result<String> {
        let mut hashes = self.hashes.lock().unwrap();
        let value = hashes[&h].clone();
        if h == self.cursor && value == "old" {
            hashes.insert(h, "fork".into());
            hashes.insert(h + 1, "new-tip".into());
        }
        Ok(value)
    }
    async fn block(&self, _: u32, _: &str) -> Result<ObservedBlock> {
        anyhow::bail!("no block should be fetched")
    }
}
#[tokio::test]
async fn no_new_blocks_fork_race_cannot_enable_automation() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.confirmations = 2;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "old",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    j.scanner_health(
        Some(c.automation_start_height + 1),
        true,
        true,
        Some(zcash_paymentd::now() + 300),
    )?;
    let chain = ForkDuringRecheck {
        hashes: Mutex::new(std::collections::HashMap::from([
            (c.automation_start_height, "old".into()),
            (c.automation_start_height + 1, "old-tip".into()),
        ])),
        cursor: c.automation_start_height,
    };
    assert!(scanner::scan(&chain, &mut j, &c).await.is_err());
    assert!(!j.ready(&c)?);
    Ok(())
}

#[test]
fn persisted_readiness_expires_and_future_clock_is_not_ready() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let j = Journal::open(&c, "key")?;
    j.scanner_health(
        Some(c.birthday_height),
        true,
        true,
        Some(zcash_paymentd::now() + 300),
    )?;
    assert!(j.ready(&c)?);
    let db = rusqlite::Connection::open(c.state_dir.join("journal.sqlite"))?;
    for checked_at in [zcash_paymentd::now() - 100, zcash_paymentd::now() + 100] {
        let value=serde_json::json!({"checked_at":checked_at,"tip":c.birthday_height,"ok":true,"ready":true,"fresh_until":zcash_paymentd::now()+300}).to_string();
        db.execute("UPDATE meta SET value=?1 WHERE key='scanner'", [value])?;
        assert!(!j.ready(&c)?);
        assert_eq!(j.status(&c)?["effective_ready"], false);
    }
    Ok(())
}

#[test]
fn inactive_consumer_retains_revoke_and_remine_obligations() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let delivered = j.next("first", i64::MAX)?.unwrap();
    j.acknowledge("first", &delivered.event.event_id)?;
    let inactive = c.consumers.remove(0);
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    j.rollback_one()?;
    j.append(&block(
        c.automation_start_height,
        "c",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    assert_eq!(j.status(&c)?["consumers"].as_array().unwrap().len(), 1);
    c.consumers.push(inactive);
    drop(j);
    let j = Journal::open(&c, "key")?;
    let revoke = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(revoke.event.kind, "payment.revoked");
    j.acknowledge("first", &revoke.event.event_id)?;
    let remine = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(remine.event.kind, "payment.confirmed");
    assert_eq!(remine.event.revision, 2);
    Ok(())
}

#[test]
fn new_consumer_does_not_receive_revocation_without_prior_confirmation() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    c.consumers.push(Consumer {
        id: "new".into(),
        argv: vec!["/usr/bin/true".into()],
        timeout_seconds: 1,
        observe_unconfirmed: false,
    });
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    j.rollback_one()?;
    assert!(j.next("new", i64::MAX)?.is_none());
    j.append(&block(
        c.automation_start_height,
        "c",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    assert_eq!(
        j.next("new", i64::MAX)?.unwrap().event.kind,
        "payment.confirmed"
    );
    Ok(())
}

#[test]
fn explicit_replay_enrolls_new_consumer_for_revoke_and_remine() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let original = j.events(0, 10)?.remove(0);
    c.consumers.push(Consumer {
        id: "new".into(),
        argv: vec!["/usr/bin/true".into()],
        timeout_seconds: 1,
        observe_unconfirmed: false,
    });
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    assert!(j.next("new", i64::MAX)?.is_none());
    j.replay("new", &original.event_id)?;
    let replay = j.next("new", i64::MAX)?.unwrap();
    j.acknowledge("new", &replay.event.event_id)?;
    assert!(j.replay("unknown", &original.event_id).is_err());
    j.rollback_one()?;
    let revoked = j.next("new", i64::MAX)?.unwrap();
    assert_eq!(revoked.event.kind, "payment.revoked");
    j.acknowledge("new", &revoked.event.event_id)?;
    j.append(&block(
        c.automation_start_height,
        "c",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    assert_eq!(j.next("new", i64::MAX)?.unwrap().event.revision, 2);
    Ok(())
}
#[test]
fn node_tip_deadline_expires_even_with_long_poll_lease() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.poll_seconds = 3600;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let j = Journal::open(&c, "key")?;
    j.scanner_health(
        Some(c.birthday_height),
        true,
        true,
        Some(zcash_paymentd::now() + 1),
    )?;
    assert!(j.ready(&c)?);
    j.scanner_health(
        Some(c.birthday_height),
        true,
        true,
        Some(zcash_paymentd::now() - 1),
    )?;
    assert!(!j.ready(&c)?);
    assert_eq!(j.status(&c)?["effective_ready"], false);
    Ok(())
}
struct StalesDuringScan {
    chain: FakeChain,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl Chain for StalesDuringScan {
    async fn tip(&self) -> Result<ChainTip> {
        if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            anyhow::bail!("node tip became stale during scan")
        };
        self.chain.tip().await
    }
    async fn hash(&self, h: u32) -> Result<String> {
        self.chain.hash(h).await
    }
    async fn block(&self, h: u32, hash: &str) -> Result<ObservedBlock> {
        self.chain.block(h, hash).await
    }
}
#[tokio::test]
async fn slow_scan_must_reverify_node_freshness_before_delivery() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = StalesDuringScan {
        chain: FakeChain {
            blocks: Mutex::new(vec![
                block(c.birthday_height - 1, "parent", "earlier", vec![]),
                block(c.birthday_height, "a", "parent", vec![]),
                block(
                    c.automation_start_height,
                    "b",
                    "a",
                    vec![payment("ironwood", 0)],
                ),
            ]),
            fail: false,
            tip_offset: 0,
        },
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    assert!(scanner::scan(&chain, &mut j, &c).await.is_err());
    assert!(
        j.next("first", i64::MAX)?.is_some(),
        "receipt stays durable for later healthy reconciliation"
    );
    assert!(!j.ready(&c)?);
    Ok(())
}

#[tokio::test]
async fn future_tip_cannot_extend_freshness_beyond_verification_age() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.poll_seconds = 3600;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = FakeChain {
        blocks: Mutex::new(vec![
            block(c.birthday_height - 1, "parent", "earlier", vec![]),
            block(c.birthday_height, "a", "parent", vec![]),
            block(
                c.automation_start_height,
                "b",
                "a",
                vec![payment("ironwood", 0)],
            ),
        ]),
        fail: false,
        tip_offset: 3600,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(j.ready(&c)?);
    let h = j.status(&c)?["scanner"].clone();
    let checked = h["checked_at"].as_i64().unwrap();
    let deadline = h["fresh_until"].as_i64().unwrap();
    assert!(
        deadline <= checked + c.max_tip_age_seconds as i64,
        "future blocktime must not extend verification age"
    );
    Ok(())
}

struct SlowFinalHash {
    chain: FakeChain,
    tip_calls: std::sync::atomic::AtomicUsize,
    delay: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl Chain for SlowFinalHash {
    async fn tip(&self) -> Result<ChainTip> {
        if self
            .tip_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            self.delay.store(true, std::sync::atomic::Ordering::SeqCst)
        }
        self.chain.tip().await
    }
    async fn hash(&self, h: u32) -> Result<String> {
        if self.delay.swap(false, std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        self.chain.hash(h).await
    }
    async fn block(&self, h: u32, hash: &str) -> Result<ObservedBlock> {
        self.chain.block(h, hash).await
    }
}
#[tokio::test]
async fn slow_final_anchor_cannot_refresh_expired_future_tip_evidence() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.poll_seconds = 3600;
    c.max_tip_age_seconds = 1;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let chain = SlowFinalHash {
        chain: FakeChain {
            blocks: Mutex::new(vec![
                block(c.birthday_height, "a", "parent", vec![]),
                block(c.automation_start_height, "b", "a", vec![]),
            ]),
            fail: false,
            tip_offset: 3600,
        },
        tip_calls: std::sync::atomic::AtomicUsize::new(0),
        delay: std::sync::atomic::AtomicBool::new(false),
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(!j.ready(&c)?);
    Ok(())
}

#[test]
fn early_observation_is_opt_in_durable_and_does_not_wait_for_confirmation() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.confirmations = 3;
    c.consumers[0].observe_unconfirmed = true;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.observe(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.observe(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let first = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(first.event.kind, "payment.observed");
    assert!(j.next("second", i64::MAX)?.is_none());
    j.acknowledge("first", &first.event.event_id)?;
    j.observe(&block(
        c.automation_start_height + 1,
        "c",
        "b",
        vec![payment("orchard", 1)],
    ))?;
    assert_eq!(
        j.next("first", i64::MAX)?
            .unwrap()
            .event
            .payment
            .output_index,
        1,
        "capturing a first-seen note must not wait for confirmation and stall later buyers"
    );
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    assert_eq!(
        j.events(0, 100)?.len(),
        2,
        "restart does not emit observations again"
    );
    j.reconcile_confirmations(c.automation_start_height)?;
    let confirmed = j.next("second", i64::MAX)?.unwrap().event;
    assert_eq!(confirmed.kind, "payment.confirmed");
    assert_eq!(confirmed.payment.id, first.event.payment.id);
    assert_eq!(confirmed.revision, first.event.revision);
    assert_eq!(j.reconcile_confirmations(c.automation_start_height)?, 0);
    Ok(())
}

#[tokio::test]
async fn removing_last_early_consumer_keeps_canonical_tail_without_false_revocation() -> Result<()>
{
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.confirmations = 3;
    c.consumers[0].observe_unconfirmed = true;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = FakeChain {
        blocks: Mutex::new(vec![
            block(c.birthday_height - 1, "parent", "earlier", vec![]),
            block(c.birthday_height, "a", "parent", vec![]),
            block(
                c.automation_start_height,
                "b",
                "a",
                vec![payment("ironwood", 0)],
            ),
        ]),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    c.consumers.remove(0);
    drop(j);
    let mut j = Journal::open(&c, "key")?;
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.cursor()?.unwrap().0, c.automation_start_height);
    assert!(
        j.events(0, 100)?
            .iter()
            .all(|e| e.kind != "payment.revoked")
    );
    assert!(j.ready(&c)?);
    Ok(())
}

#[tokio::test]
async fn readonly_proof_fences_depth_loss_and_preserves_historical_revoke_after_same_hash_returns()
-> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.confirmations = 3;
    c.consumers[0].observe_unconfirmed = true;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = FakeChain {
        blocks: Mutex::new(vec![
            block(c.birthday_height - 1, "parent", "earlier", vec![]),
            block(c.birthday_height, "a", "parent", vec![]),
            block(
                c.automation_start_height,
                "b",
                "a",
                vec![payment("ironwood", 0)],
            ),
            block(c.automation_start_height + 1, "c", "b", vec![]),
            block(c.automation_start_height + 2, "d", "c", vec![]),
        ]),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    let confirmed = j
        .events(0, 100)?
        .into_iter()
        .find(|e| e.kind == "payment.confirmed")
        .unwrap();
    let reader = Journal::inspect(&c)?;
    let proof =
        zcash_paymentd::proof::verify(&chain, &reader, &c, "key", &confirmed.event_id).await?;
    assert_eq!(proof.confirmations, 3);
    assert!(
        reader
            .proof_event(&c, "wrong-key", &confirmed.event_id)
            .is_err()
    );
    chain.blocks.lock().unwrap().truncate(3);
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(reader.proof_event(&c, "key", &confirmed.event_id).is_err());
    assert!(j.replay("first", &confirmed.event_id).is_err());
    let revoked = j
        .events(0, 100)?
        .into_iter()
        .find(|e| e.kind == "payment.revoked")
        .unwrap();
    let proof =
        zcash_paymentd::proof::verify(&chain, &reader, &c, "key", &revoked.event_id).await?;
    assert_eq!(
        proof.confirmations, 0,
        "revocation authenticates historical loss, not current inclusion"
    );
    chain.blocks.lock().unwrap().extend([
        block(c.automation_start_height + 1, "c", "b", vec![]),
        block(c.automation_start_height + 2, "d", "c", vec![]),
    ]);
    scanner::scan(&chain, &mut j, &c).await?;
    let proof =
        zcash_paymentd::proof::verify(&chain, &reader, &c, "key", &revoked.event_id).await?;
    assert_eq!(
        proof.confirmations, 0,
        "canonical return does not turn historical revocation into inclusion proof"
    );
    let latest = j.events(0, 100)?.last().unwrap().clone();
    assert_eq!(latest.kind, "payment.confirmed");
    assert_eq!(latest.payment.id, confirmed.payment.id);
    assert_eq!(latest.revision, 2);
    assert_ne!(latest.event_id, confirmed.event_id);
    // A different fork at the same tip height must not give an orphan numerical
    // confirmations just because its old height lies below that tip.
    chain.blocks.lock().unwrap().truncate(2);
    chain.blocks.lock().unwrap().extend([
        block(c.automation_start_height, "fork-b", "a", vec![]),
        block(c.automation_start_height + 1, "fork-c", "fork-b", vec![]),
        block(c.automation_start_height + 2, "fork-d", "fork-c", vec![]),
    ]);
    scanner::scan(&chain, &mut j, &c).await?;
    let orphan_proof =
        zcash_paymentd::proof::verify(&chain, &reader, &c, "key", &revoked.event_id).await?;
    assert_eq!(
        orphan_proof.confirmations, 0,
        "orphan has no canonical depth"
    );
    Ok(())
}

#[test]
fn additive_upgrade_keeps_old_receipts_confirmed_without_historical_observation() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let original = j.events(0, 100)?;
    drop(j);
    let db = rusqlite::Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute_batch("ALTER TABLE receipts DROP COLUMN confirmed; ALTER TABLE consumers DROP COLUMN observe_unconfirmed;")?;
    drop(db);
    let mut j = Journal::open(&c, "key")?;
    assert_eq!(j.reconcile_confirmations(c.automation_start_height)?, 0);
    assert_eq!(j.events(0, 100)?, original);
    assert!(!j.scans_unconfirmed()?);
    Ok(())
}

#[test]
fn orphaned_observation_is_cancelled_and_remine_keeps_stable_note_identity() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.consumers[0].observe_unconfirmed = true;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.observe(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let original = j.next("first", i64::MAX)?.unwrap();
    j.rollback_one()?;
    assert_eq!(
        j.next("first", i64::MAX)?.unwrap().event.kind,
        "payment.revoked"
    );
    j.observe(&block(
        c.automation_start_height,
        "new-b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let last = j.events(0, 100)?.last().unwrap().clone();
    assert_eq!(last.revision, 2);
    assert_eq!(last.payment.id, original.event.payment.id);
    assert_eq!(last.kind, "payment.observed");
    Ok(())
}

#[test]
fn depth_loss_cancels_unacknowledged_observation_before_revision_changes() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.consumers[0].observe_unconfirmed = true;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.observe(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    j.reconcile_confirmations(c.automation_start_height)?;
    j.reconcile_confirmations(c.automation_start_height - 1)?;
    let head = j.next("first", i64::MAX)?.unwrap().event;
    assert_eq!(head.kind, "payment.revoked");
    assert!(j.proof_event(&c, "key", &head.event_id).is_ok());
    Ok(())
}

#[test]
fn readonly_journal_refuses_public_or_symlinked_provenance() -> Result<()> {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let _writer = Journal::open(&c, "key")?;
    assert!(Journal::inspect(&c).is_ok());
    let path = c.state_dir.join("journal.sqlite");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
    assert!(Journal::inspect(&c).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    std::fs::set_permissions(&c.state_dir, std::fs::Permissions::from_mode(0o755))?;
    assert!(Journal::inspect(&c).is_err());
    std::fs::set_permissions(&c.state_dir, std::fs::Permissions::from_mode(0o700))?;
    let saved = c.state_dir.join("saved.sqlite");
    std::fs::rename(&path, &saved)?;
    symlink(&saved, &path)?;
    assert!(Journal::inspect(&c).is_err());
    std::fs::remove_file(&path)?;
    std::fs::rename(&saved, &path)?;
    let mut linked = c.clone();
    linked.state_dir = dir.path().join("linked");
    symlink(&c.state_dir, &linked.state_dir)?;
    assert!(Journal::inspect(&linked).is_err());
    Ok(())
}

#[test]
fn writer_retains_contention_grace_while_readonly_proof_deadline_stays_short() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let _writer = Journal::open(&c, "key")?;
    let db_path = c.state_dir.join("journal.sqlite");
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || -> Result<()> {
        let db = rusqlite::Connection::open(db_path)?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        locked_tx.send(())?;
        std::thread::sleep(std::time::Duration::from_millis(1600));
        db.execute_batch("COMMIT")?;
        Ok(())
    });
    locked_rx.recv()?;
    // Opening writer state mutates metadata; a one-second timeout fails here.
    let result = Journal::open(&c, "key");
    holder.join().expect("lock holder")?;
    assert!(
        result.is_ok(),
        "brief writer contention must not stop the daemon"
    );
    assert!(Journal::inspect(&c).is_ok());
    Ok(())
}

#[tokio::test]
async fn readonly_proof_rejects_freshness_expiring_during_rpc() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.max_tip_age_seconds = 1;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        vec![payment("ironwood", 0)],
    ))?;
    let event = j.events(0, 100)?.pop().unwrap();
    // Keep the recorded scanner lease live: only the new proof's node evidence
    // expires, so this detects removal of the proof's final freshness guard.
    j.scanner_health(
        Some(c.automation_start_height),
        true,
        true,
        Some(zcash_paymentd::now() + 300),
    )?;
    let reader = Journal::inspect(&c)?;
    for offset in [-1, 3600] {
        let chain = SlowFinalHash {
            chain: FakeChain {
                blocks: Mutex::new(vec![block(c.automation_start_height, "b", "a", vec![])]),
                fail: false,
                tip_offset: offset,
            },
            tip_calls: std::sync::atomic::AtomicUsize::new(0),
            delay: std::sync::atomic::AtomicBool::new(true),
        };
        assert!(
            zcash_paymentd::proof::verify(&chain, &reader, &c, "key", &event.event_id)
                .await
                .is_err()
        );
        chain.delay.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            zcash_paymentd::proof::verify_payment(&chain, &reader, &c, "key", &event.payment.id)
                .await
                .is_err()
        );
        assert!(
            reader.ready(&c)?,
            "scanner lease remains valid; rejection is proof freshness"
        );
    }
    Ok(())
}

#[test]
fn readonly_journal_refuses_writable_ancestor_and_pins_canonical_parent() -> Result<()> {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let private_parent = dir.path().join("private-parent");
    std::fs::create_dir(&private_parent)?;
    c.state_dir = private_parent.join("state");
    let _lock = StateLock::acquire(&c.state_dir)?;
    let _writer = Journal::open(&c, "key")?;
    std::fs::set_permissions(&private_parent, std::fs::Permissions::from_mode(0o777))?;
    assert!(Journal::inspect(&c).is_err());
    std::fs::set_permissions(&private_parent, std::fs::Permissions::from_mode(0o700))?;
    let alias = dir.path().join("alias");
    symlink(&private_parent, &alias)?;
    c.state_dir = alias.join("state");
    // An ancestor alias is safe only because inspection pins the checked
    // canonical directory/file; SQLite must never reopen the lexical alias.
    assert!(Journal::inspect(&c).is_ok());
    Ok(())
}

#[tokio::test]
async fn bounded_history_batches_keep_hooks_unready_until_canonical_catchup() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let mut blocks = vec![block(c.birthday_height - 1, "parent", "earlier", vec![])];
    for offset in 0..=200 {
        let hash = format!("hash-{offset}");
        let prev = blocks.last().unwrap().hash.clone();
        blocks.push(block(
            c.birthday_height + offset,
            &hash,
            &prev,
            if offset == 1 {
                vec![payment("ironwood", 0)]
            } else {
                vec![]
            },
        ));
    }
    let chain = FakeChain {
        blocks: Mutex::new(blocks),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.cursor()?.unwrap().0, c.birthday_height + 99);
    assert_eq!(
        scanner::poll_delay(&j, &c, None)?,
        std::time::Duration::from_millis(250)
    );
    assert!(!j.ready(&c)?);
    assert!(
        j.next("first", i64::MAX)?.is_some(),
        "payments persist during catchup but must not dispatch"
    );
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.cursor()?.unwrap().0, c.birthday_height + 199);
    assert_eq!(
        scanner::poll_delay(&j, &c, Some(c.birthday_height + 99))?,
        std::time::Duration::from_millis(250)
    );
    assert!(!j.ready(&c)?);
    scanner::scan(&chain, &mut j, &c).await?;
    assert_eq!(j.cursor()?.unwrap().0, c.birthday_height + 200);
    assert!(j.ready(&c)?);
    assert_eq!(
        scanner::poll_delay(&j, &c, Some(c.birthday_height + 199))?,
        std::time::Duration::from_secs(c.poll_seconds)
    );
    Ok(())
}

#[tokio::test]
async fn successful_scan_without_forward_progress_keeps_full_poll_interval() -> Result<()> {
    let dir = TempDir::new()?;
    let c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let chain = FakeChain {
        blocks: Mutex::new(vec![block(
            c.birthday_height - 1,
            "parent",
            "earlier",
            vec![],
        )]),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(j.cursor()?.is_none());
    assert!(!j.ready(&c)?);
    assert_eq!(
        scanner::poll_delay(&j, &c, None)?,
        std::time::Duration::from_secs(c.poll_seconds)
    );
    // A failed node/decryption attempt invalidates readiness, but neither
    // no-progress nor a reverse cursor move permits the short catchup loop.
    j.append(&block(c.birthday_height, "a", "parent", vec![]))?;
    j.scanner_health(None, false, false, None)?;
    for previous in [c.birthday_height, c.birthday_height + 1] {
        assert_eq!(
            scanner::poll_delay(&j, &c, Some(previous))?,
            std::time::Duration::from_secs(c.poll_seconds)
        );
    }
    Ok(())
}

#[tokio::test]
async fn historical_receipts_have_current_proof_without_bypassing_automation_floor() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.automation_start_height = c.birthday_height + 100;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    let p = payment("ironwood", 0);
    let chain = FakeChain {
        blocks: Mutex::new(vec![
            block(c.birthday_height - 1, "parent", "earlier", vec![]),
            block(c.birthday_height, "a", "parent", vec![p.clone()]),
        ]),
        fail: false,
        tip_offset: 0,
    };
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(j.events(0, 100)?.is_empty());
    let reader = Journal::inspect(&c)?;
    assert_eq!(reader.payments("", 1)?, vec![p.id.clone()]);
    assert!(reader.payments(&p.id, 1)?.is_empty());
    assert!(reader.payments("", 1001).is_err());
    assert!(reader.proof_payment(&c, "wrong-key", &p.id).is_err());
    let mut changed = c.clone();
    changed.automation_start_height += 1;
    assert!(reader.proof_payment(&changed, "key", &p.id).is_err());
    let proof = zcash_paymentd::proof::verify_payment(&chain, &reader, &c, "key", &p.id).await?;
    assert_eq!(proof.record.payment, p);
    assert_eq!(proof.confirmations, 1);
    assert!(j.events(0, 100)?.is_empty());
    chain.blocks.lock().unwrap()[1].hash = "fork".into();
    chain.blocks.lock().unwrap()[1].payments.clear();
    assert!(
        zcash_paymentd::proof::verify_payment(&chain, &reader, &c, "key", &p.id)
            .await
            .is_err()
    );
    scanner::scan(&chain, &mut j, &c).await?;
    assert!(reader.proof_payment(&c, "key", &p.id).is_err());
    assert!(j.events(0, 100)?.is_empty());
    Ok(())
}

#[test]
fn paused_positive_head_does_not_hide_ordered_revocations_or_change_ack_state() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.automation_start_height = c.birthday_height;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(
        c.birthday_height,
        "a",
        "parent",
        vec![payment("sapling", 0)],
    ))?;
    let positive = j.next("first", i64::MAX)?.unwrap();
    // Two later notes have already been delivered before this earlier note was replayed.
    j.acknowledge("first", &positive.event.event_id)?;
    j.append(&block(
        c.birthday_height + 1,
        "b",
        "a",
        vec![payment("orchard", 0)],
    ))?;
    let credited = j.next("first", i64::MAX)?.unwrap();
    j.acknowledge("first", &credited.event.event_id)?;
    j.append(&block(
        c.birthday_height + 2,
        "c",
        "b",
        vec![payment("ironwood", 0)],
    ))?;
    let second_credit = j.next("first", i64::MAX)?.unwrap();
    j.acknowledge("first", &second_credit.event.event_id)?;
    j.replay("first", &positive.event.event_id)?;
    j.rollback_one()?;
    j.rollback_one()?;
    j.scanner_health(None, false, false, None)?;
    assert_eq!(j.next("first", i64::MAX)?.unwrap().event, positive.event);
    let first_revoke = j.next_for_automation("first", i64::MAX)?.unwrap();
    assert_eq!(first_revoke.event.kind, "payment.revoked");
    assert_eq!(
        first_revoke.event.payment.id,
        second_credit.event.payment.id
    );
    j.failed("first", &first_revoke, "hook unavailable")?;
    assert!(
        j.next_for_automation("first", 0)?.is_none(),
        "oldest revoke backoff must not be bypassed by the next revoke"
    );
    drop(j);
    let j = Journal::open(&c, "key")?;
    let retry = j.next_for_automation("first", i64::MAX)?.unwrap();
    assert_eq!(retry.event, first_revoke.event);
    assert_eq!(retry.attempts, 1);
    j.acknowledge("first", &retry.event.event_id)?;
    let second_revoke = j.next_for_automation("first", i64::MAX)?.unwrap();
    assert_eq!(second_revoke.event.payment.id, credited.event.payment.id);
    j.acknowledge("first", &second_revoke.event.event_id)?;
    assert!(
        j.next_for_automation("first", i64::MAX)?.is_none(),
        "positive remains paused after corrections"
    );
    let still_pending = j.next("first", i64::MAX)?.unwrap();
    assert_eq!(still_pending.event, positive.event);
    assert_eq!(still_pending.attempts, 0);
    j.scanner_health(
        Some(c.birthday_height),
        true,
        true,
        Some(zcash_paymentd::now() + 300),
    )?;
    assert_eq!(
        j.next_for_automation("first", i64::MAX)?.unwrap().event,
        positive.event,
        "normal FIFO resumes on fresh scanner evidence"
    );
    Ok(())
}

#[test]
fn own_superseded_positive_is_explicitly_cancelled_and_remine_waits_for_revoke() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    c.automation_start_height = c.birthday_height;
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(
        c.birthday_height,
        "a",
        "parent",
        vec![payment("orchard", 0)],
    ))?;
    let stale = j.next("first", i64::MAX)?.unwrap();
    j.rollback_one()?;
    let db = rusqlite::Connection::open(c.state_dir.join("journal.sqlite"))?;
    let cancellation: (bool, String) = db.query_row(
        "SELECT acked,last_error FROM deliveries WHERE consumer='first' AND event_id=?1",
        [&stale.event.event_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(cancellation, (true, "superseded by reorg".into()));
    let revoked = j.next_for_automation("first", i64::MAX)?.unwrap();
    assert_eq!(revoked.event.kind, "payment.revoked");
    j.append(&block(
        c.birthday_height,
        "b",
        "parent",
        vec![payment("orchard", 0)],
    ))?;
    j.scanner_health(
        Some(c.birthday_height),
        true,
        true,
        Some(zcash_paymentd::now() + 300),
    )?;
    assert_eq!(
        j.next_for_automation("first", i64::MAX)?.unwrap().event,
        revoked.event
    );
    j.failed("first", &revoked, "retry")?;
    assert!(j.next_for_automation("first", 0)?.is_none());
    j.acknowledge("first", &revoked.event.event_id)?;
    let remine = j.next_for_automation("first", i64::MAX)?.unwrap();
    assert_eq!(remine.event.kind, "payment.confirmed");
    assert_eq!(remine.event.revision, stale.event.revision + 1);
    assert_ne!(remine.event.event_id, stale.event.event_id);
    Ok(())
}
