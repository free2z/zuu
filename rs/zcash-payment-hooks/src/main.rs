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

struct StreamDeadline {
    deadline: std::time::Instant,
    cancel: std::sync::mpsc::Sender<()>,
    watcher: Option<std::thread::JoinHandle<()>>,
}

impl StreamDeadline {
    fn new(timeout: Duration) -> Self {
        let deadline = std::time::Instant::now() + timeout;
        let (cancel, receiver) = std::sync::mpsc::channel();
        let watcher = std::thread::spawn(move || {
            if matches!(
                receiver
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                // Do not flush or acquire stdout's lock: the consumer may have
                // stopped draining it. Process death releases the journal lock.
                unsafe { libc::_exit(124) }
            }
        });
        Self {
            deadline,
            cancel,
            watcher: Some(watcher),
        }
    }

    fn stop(&mut self) {
        let _ = self.cancel.send(());
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
    }

    fn finish(mut self) -> Result<()> {
        self.stop();
        anyhow::ensure!(
            std::time::Instant::now() < self.deadline,
            "handoff stream deadline exceeded"
        );
        Ok(())
    }
}

impl Drop for StreamDeadline {
    fn drop(&mut self) {
        self.stop();
    }
}

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
    /// Report the stopped-journal handoff protocol without reading private state.
    HandoffCapabilities,
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
    /// Stream a complete private revocation inventory as a verified header,
    /// ordered records and boundary footer. Missing footer means failure.
    HandoffRevocationsStream {
        #[arg(long, default_value_t = 20)]
        timeout_seconds: u64,
    },
    /// Enqueue missing eligible lifecycle work without resetting ACKs. Daemon must be stopped.
    EnqueueMissing {
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
    if matches!(a.command, Command::HandoffCapabilities) {
        println!(
            "{}",
            serde_json::json!({"schema":1,"stream_protocol":1,"enqueue_missing":true})
        );
        return Ok(());
    }
    let c = Config::load(&a.config)?;
    match a.command {
        Command::VerifyAddress => unreachable!("handled before state access"),
        Command::HandoffCapabilities => unreachable!("handled before state access"),
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
            })().map_err(|_| anyhow::anyhow!("legacy handoff unavailable; inspect stopped writer, journal identity, lifecycle and deadline"))?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Command::HandoffRevocationsStream { timeout_seconds } => {
            anyhow::ensure!(
                (1..=120).contains(&timeout_seconds),
                "handoff deadline must be 1..120 seconds"
            );
            let deadline = StreamDeadline::new(Duration::from_secs(timeout_seconds));
            (|| {
                Journal::inspect(&c)?;
                let lock = StateLock::acquire(&c.state_dir)?;
                Journal::handoff_revocations_stream(
                    &lock,
                    &c,
                    &private_file(&c.ufvk_file)?,
                    Duration::from_secs(timeout_seconds),
                    &mut std::io::stdout().lock(),
                )
            })()
            .map_err(|_| anyhow::anyhow!("handoff stream unavailable; inspect stopped writer, journal identity, lifecycle and deadline"))?;
            deadline.finish()?;
        }
        Command::EnqueueMissing { timeout_seconds } => {
            let result = (|| {
                Journal::inspect(&c)?;
                let lock = StateLock::acquire(&c.state_dir)?;
                Journal::enqueue_missing(&lock, &c, &private_file(&c.ufvk_file)?, Duration::from_secs(timeout_seconds))
            })().map_err(|_| anyhow::anyhow!("handoff unavailable; inspect stopped writer, journal identity, lifecycle and deadline"))?;
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
                Err(error) => {
                    journal.scanner_health(None, false, false, None)?;
                    eprintln!(
                        "paymentd: scanner unavailable; {}",
                        scanner::failure_summary(&error)
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

#[cfg(test)]
mod deadline_tests {
    use super::StreamDeadline;
    use std::time::{Duration, Instant};

    #[test]
    fn completed_stream_cancels_and_joins_its_watchdog() {
        StreamDeadline::new(Duration::from_millis(250))
            .finish()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
    }

    #[test]
    fn late_stream_completion_cannot_report_success() {
        let (cancel, _receiver) = std::sync::mpsc::channel();
        let guard = StreamDeadline {
            deadline: Instant::now(),
            cancel,
            watcher: None,
        };
        assert!(guard.finish().is_err());
    }
}
