use anyhow::Result;
use clap::{Parser, Subcommand};
use std::{path::PathBuf, time::Duration};
use zcash_paymentd::{
    chain::Zakura,
    config::{Config, private_file},
    delivery::{Automation, ExecAutomation},
    journal::{Journal, StateLock},
    now, scanner,
};

#[derive(Parser)]
#[command(about = "Receive-only Zcash payment observer and durable automation daemon")]
struct Args {
    #[arg(long)]
    config: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Run,
    /// Offline external receiver coverage proof; address supplied on bounded stdin.
    VerifyAddress,
    /// Read-only historical receipt proof. Never creates a lifecycle event.
    VerifyPayment {
        payment_id: String,
    },
    /// Bounded private active receipt inventory, ordered by stable identity.
    Payments {
        #[arg(long, default_value = "")]
        after: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    Status,
    /// Explicitly prints private payment/memo event data to stdout.
    Events {
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    /// Read-only private eligible unacknowledged revocation coordinates. Daemon must be stopped.
    HandoffRevocations {
        #[arg(long, default_value_t = 10_000)]
        max_receipts: u32,
        #[arg(long, default_value_t = 50_000)]
        max_events: u32,
        #[arg(long, default_value_t = 20)]
        timeout_seconds: u64,
    },
    /// Enqueue missing eligible lifecycle work without resetting ACKs. Daemon must be stopped.
    EnqueueMissing {
        #[arg(long, default_value_t = 10_000)]
        max_receipts: u32,
        #[arg(long, default_value_t = 50_000)]
        max_events: u32,
        #[arg(long, default_value_t = 20)]
        timeout_seconds: u64,
    },
    /// Re-deliver one journal event. Requires the daemon to be stopped.
    Replay {
        consumer: String,
        event_id: String,
    },
    /// Read-only private event proof, with a total 20-second deadline.
    VerifyEvent {
        event_id: String,
    },
}
#[tokio::main]
async fn main() -> Result<()> {
    let a = Args::parse();
    if matches!(a.command, Command::VerifyAddress) {
        // Keep private configuration, address and key parsing failures out of diagnostics.
        let proof = (|| {
            let c = Config::load(&a.config)?;
            let ufvk = private_file(&c.ufvk_file)?;
            let address = zcash_paymentd::receiver::read_address(std::io::stdin().lock())?;
            zcash_paymentd::receiver::verify_address(&c, &ufvk, &address)
        })()
        .map_err(|_| anyhow::anyhow!("address coverage unavailable; check private configuration, key, network and bounded address input"))?;
        println!("{}", serde_json::to_string(&proof)?);
        return Ok(());
    }
    let c = Config::load(&a.config)?;
    match a.command {
        Command::VerifyAddress => unreachable!("handled before state access"),
        Command::Payments { after, limit } => {
            println!(
                "{}",
                serde_json::to_string(&Journal::inspect(&c)?.payments(&after, limit)?)?
            );
        }
        Command::VerifyPayment { payment_id } => {
            let ufvk = private_file(&c.ufvk_file)?;
            let journal = Journal::inspect(&c)?;
            let node = Zakura::new(&c, &ufvk)?;
            let proof = tokio::time::timeout(
                Duration::from_secs(20),
                zcash_paymentd::proof::verify_payment(&node, &journal, &c, &ufvk, &payment_id),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| {
                anyhow::anyhow!("payment proof unavailable; inspect node, scope and journal")
            })?;
            println!("{}", serde_json::to_string(&proof)?);
        }
        Command::VerifyEvent { event_id } => {
            let ufvk = private_file(&c.ufvk_file)?;
            let journal = Journal::inspect(&c)?;
            let node = Zakura::new(&c, &ufvk)?;
            let result = tokio::time::timeout(
                Duration::from_secs(20),
                zcash_paymentd::proof::verify(&node, &journal, &c, &ufvk, &event_id),
            )
            .await;
            let proof = result.ok().and_then(Result::ok).ok_or_else(|| {
                anyhow::anyhow!("event proof unavailable; inspect node, scope and journal")
            })?;
            println!("{}", serde_json::to_string(&proof)?);
        }
        Command::Status => println!("{}", Journal::inspect(&c)?.status(&c)?),
        Command::Events { after, limit } => {
            for event in Journal::inspect(&c)?.events(after, limit)? {
                println!("{}", serde_json::to_string(&event)?);
            }
        }
        Command::Replay { consumer, event_id } => {
            anyhow::ensure!(
                c.consumers.iter().any(|v| v.id == consumer),
                "consumer is not configured"
            );
            let _lock = StateLock::acquire(&c.state_dir)?;
            Journal::open(&c, &private_file(&c.ufvk_file)?)?.replay(&consumer, &event_id)?;
        }
        Command::HandoffRevocations {
            max_receipts,
            max_events,
            timeout_seconds,
        } => {
            let result = (|| {
                Journal::inspect(&c)?;
                let lock = StateLock::acquire(&c.state_dir)?;
                Journal::handoff_revocations(&lock, &c, &private_file(&c.ufvk_file)?, max_receipts, max_events, Duration::from_secs(timeout_seconds))
            })().map_err(|_| anyhow::anyhow!("handoff unavailable; inspect stopped writer, journal identity, lifecycle, caps and deadline"))?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Command::EnqueueMissing {
            max_receipts,
            max_events,
            timeout_seconds,
        } => {
            let result = (|| {
                Journal::inspect(&c)?;
                let lock = StateLock::acquire(&c.state_dir)?;
                Journal::enqueue_missing(&lock, &c, &private_file(&c.ufvk_file)?, max_receipts, max_events, Duration::from_secs(timeout_seconds))
            })().map_err(|_| anyhow::anyhow!("handoff unavailable; inspect stopped writer, journal identity, lifecycle, caps and deadline"))?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Command::Run => run(c).await?,
    }
    Ok(())
}
async fn run(c: Config) -> Result<()> {
    let _lock = StateLock::acquire(&c.state_dir)?;
    let ufvk = private_file(&c.ufvk_file)?;
    let mut journal = Journal::open(&c, &ufvk)?;
    journal.scanner_health(None, false, false, None)?;
    let chain = Zakura::new(&c, &ufvk)?;
    let mut workers = Vec::new();
    for consumer in c.consumers.clone() {
        // Consumers have independent tasks/connections: a poisoned hook cannot stop scanning.
        let queue = Journal::open(&c, &ufvk)?;
        workers.push(tokio::spawn(async move {
            let hook = ExecAutomation(consumer.clone());
            loop {
                if let Some(d) = queue.next_for_automation(&consumer.id, now())? {
                    match hook.handle(&d.event).await {
                        Ok(()) => queue.acknowledge(&consumer.id, &d.event.event_id)?,
                        Err(_) => queue.failed(&consumer.id, &d, "hook failed or timed out")?,
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        }));
    }
    let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let scanning = async {
        loop {
            let previous_height = journal.cursor()?.map(|(h, _)| h);
            let delay = match scanner::scan(&chain, &mut journal, &c).await {
                Ok(_) => scanner::poll_delay(&journal, &c, previous_height)?,
                Err(_) => {
                    journal.scanner_health(None, false, false, None)?;
                    eprintln!(
                        "paymentd: scanner unavailable; inspect node retention, freshness, connectivity and configuration"
                    );
                    Duration::from_secs(c.poll_seconds)
                }
            };
            // Failed worker persistence is fatal rather than a silently dead queue.
            if workers.iter().any(|w| w.is_finished()) {
                anyhow::bail!("automation worker stopped unexpectedly");
            }
            tokio::time::sleep(delay).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    let result = tokio::select! { r=scanning => r, _=signal.recv() => Ok(()), _=tokio::signal::ctrl_c() => Ok(()) };
    journal.scanner_health(None, false, false, None)?;
    for worker in &workers {
        worker.abort();
    }
    for worker in workers {
        let _ = worker.await;
    }
    result
}
