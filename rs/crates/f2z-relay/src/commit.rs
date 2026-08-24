//! The group-commit writer, and why it is not an optimization.
//!
//! # The arithmetic
//!
//! `f2z-relay-store` runs `synchronous = FULL` over WAL, so **a transaction
//! costs an fsync**, and a cheap VPS's disk does on the order of 50-200 of those
//! a second. One transaction per `APPEND` therefore caps the whole relay at
//! roughly one append per fsync — a ceiling low enough that
//! [ADR 0005](https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0005-federation.md)'s
//! "$5/month VPS" economics do not work. Batching N appends arriving within a
//! few milliseconds into **one** transaction costs one fsync for all N, and the
//! ceiling becomes N times higher for the same disk.
//!
//! `f2z-relay-store` exposes exactly the two things this needs:
//! [`RelayStore::append_batch`], which is the *primitive* rather than a
//! convenience wrapper, and `SqliteStore::commits`, which counts fsyncs so the
//! amortization is checkable rather than asserted. `tests/group_commit.rs`
//! checks it: a hundred concurrent appends must move the commit counter by a
//! small number, not by a hundred.
//!
//! # Batching does not weaken durability, and the distinction is published
//!
//! §11.1 has three `durability_mode` values and this relay publishes
//! `fsync-per-append`. That is not a stretch:
//!
//! > *deferring the fsync past the response is `batched`; amortizing one fsync
//! > across many responses that all wait for it is still `fsync-per-append`.*
//!
//! Every append in a batch waits for the same commit, and no reply is sent
//! before it. Which is the second reason this module exists at all:
//!
//! # `accepted` is never written to the socket before the commit is durable
//!
//! `Committed<T>` has a crate-private constructor in `f2z-relay-store`, so the
//! only value that can exist is one the completed transaction minted. In this
//! module that type is unwrapped **on the writer thread, after
//! `append_batch` returned**, and the `oneshot` reply is sent in the same
//! statement. There is no path by which a connection task holds an
//! `Appended` before the disk does — not because the code is careful, but
//! because there is nothing to hold until the commit has happened.
//!
//! # Why a thread and not a task
//!
//! An fsync is a blocking syscall of unbounded duration. Running it on a Tokio
//! worker parks that worker, and on a 1 GB VPS there are not many workers. So
//! the writer owns an OS thread and takes work over a channel; the window is a
//! `recv_timeout`, which is the one place a blocking receive is exactly the
//! right primitive.
//!
//! The other store operations — `create_queue`, `read`, `ack`, `delete_queue` —
//! are called inline from the connection tasks. They contend on the same
//! connection mutex, so they queue behind a batch rather than racing it, and
//! none of them is on the path this module exists to widen. `ACK` does commit,
//! and batching it would be the obvious next step; it is deliberately not done
//! in v1 because an `ACK` is one row-range delete per reader rather than one per
//! message, and adding a second batcher before the first one has been measured
//! in production is how a relay acquires two schedulers nobody can reason about.
//!
//! [`RelayStore::append_batch`]: f2z_relay_store::RelayStore::append_batch

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};

use f2z_codec::types::{Payload, QueueAddress};
use f2z_relay_store::{Append, Appended, Durability, RelayStore, SendAuth, StoreError};

use crate::metrics::Metrics;

/// One append, waiting for a transaction.
struct Job {
    send_addr: QueueAddress,
    auth: SendAuth,
    payload: Payload,
    received_at_ms: u64,
    reply: tokio::sync::oneshot::Sender<Reply>,
}

// The payload is somebody's ciphertext.
impl core::fmt::Debug for Job {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Job")
            .field("payload", &self.payload)
            .field("received_at_ms", &self.received_at_ms)
            .finish_non_exhaustive()
    }
}

/// What the writer sends back.
///
/// The `Ok` variant exists **only** downstream of a `Committed<Appended>` that
/// the store minted, so holding one is holding the fact that the write is
/// durable at [`Durability`].
#[derive(Debug)]
pub struct Accepted {
    /// The reader's address, for the `MSG` push of §6.4.
    pub recv_addr: QueueAddress,
    /// The index assigned. **Never sent to the writer** (§6.3).
    pub index: u64,
    /// The stamp recorded. Also never sent to the writer.
    pub received_at_ms: u64,
    /// What the store's commit actually promised.
    pub durability: Durability,
}

type Reply = Result<Accepted, StoreError>;

/// Why an append could not even be queued.
#[derive(Debug)]
pub enum CommitError {
    /// The writer thread is gone. A relay in this state cannot accept anything,
    /// and the caller answers `ERR_UNAVAILABLE` — §6.3 collapses every
    /// send-side refusal to one code, and "the relay is broken" is one of them.
    WriterStopped,
}

/// A handle on the writer.
#[derive(Clone, Debug)]
pub struct CommitWriter {
    sender: std::sync::mpsc::Sender<Job>,
    durability: Durability,
}

impl CommitWriter {
    /// Start the writer thread.
    ///
    /// `window` is how long a batch gathers after its first job; `max_batch` is
    /// the most appends one transaction takes.
    ///
    /// # Errors
    ///
    /// The thread could not be spawned.
    pub fn start(
        store: Arc<dyn RelayStore + Send + Sync>,
        metrics: Arc<Metrics>,
        window: Duration,
        max_batch: usize,
    ) -> std::io::Result<Self> {
        let durability = store.durability();
        let (sender, receiver) = std::sync::mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("f2z-relay-commit".to_owned())
            .spawn(move || run(&store, &metrics, &receiver, window, max_batch.max(1)))?;
        Ok(Self { sender, durability })
    }

    /// What this writer's commits promise — §11.1's `durability_mode`.
    #[must_use]
    pub const fn durability(&self) -> Durability {
        self.durability
    }

    /// Submit an append and wait for its commit.
    ///
    /// # Errors
    ///
    /// [`CommitError::WriterStopped`] if the writer is gone. A per-append
    /// refusal — unknown address, wrong key, quota exhausted — comes back as
    /// the inner `Err`, because one writer hitting its cap must not undo an
    /// unrelated queue's durable write.
    pub async fn append(
        &self,
        send_addr: QueueAddress,
        auth: SendAuth,
        payload: Payload,
        received_at_ms: u64,
    ) -> Result<Reply, CommitError> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.sender
            .send(Job {
                send_addr,
                auth,
                payload,
                received_at_ms,
                reply,
            })
            .map_err(|_| CommitError::WriterStopped)?;
        answer.await.map_err(|_| CommitError::WriterStopped)
    }
}

fn run(
    store: &Arc<dyn RelayStore + Send + Sync>,
    metrics: &Arc<Metrics>,
    receiver: &std::sync::mpsc::Receiver<Job>,
    window: Duration,
    max_batch: usize,
) {
    let durability = store.durability();
    loop {
        // Block until there is anything to do. A relay with no traffic costs no
        // wakeups, which on a shared VPS is a real number.
        let Ok(first) = receiver.recv() else {
            return;
        };
        let deadline = Instant::now().checked_add(window);
        let mut batch = vec![first];

        // Gather. The window starts at the *first* job rather than being a
        // fixed tick, so a lone append waits at most `window` and a burst
        // waits less.
        while batch.len() < max_batch {
            let Some(deadline) = deadline else {
                break;
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(remaining) {
                Ok(job) => batch.push(job),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                // The last sender went away. Commit what is in hand — those
                // clients are gone, but their queues' readers are not, and a
                // message thrown away here is a message §13.2 says must not be.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        commit(store, metrics, durability, batch);
    }
}

fn commit(
    store: &Arc<dyn RelayStore + Send + Sync>,
    metrics: &Arc<Metrics>,
    durability: Durability,
    batch: Vec<Job>,
) {
    let appends: Vec<Append<'_>> = batch
        .iter()
        .map(|job| Append {
            send_addr: job.send_addr,
            auth: job.auth,
            payload: &job.payload,
            received_at_ms: job.received_at_ms,
        })
        .collect();

    Metrics::inc(&metrics.commit_transactions);
    let outcome = store.append_batch(&appends);

    match outcome {
        Ok(committed) => {
            // `Committed<T>` is unwrapped **here**, after the transaction, and
            // the replies go out in the same statement. That ordering is what
            // §8.4's `accepted` means, and it is not a convention: the value
            // did not exist a line earlier.
            let mut results = committed.into_inner().into_iter();
            for job in batch {
                let reply = match results.next() {
                    Some(Ok(appended)) => {
                        Metrics::inc(&metrics.appends_committed);
                        Ok(accepted(&appended, durability))
                    }
                    Some(Err(error)) => Err(error),
                    None => Err(StoreError::Corrupt(
                        "append_batch returned fewer results than it was given appends",
                    )),
                };
                // A client that hung up between sending and committing loses
                // its answer, and the message stays: §2.5 says an in-flight
                // command whose response was not received has *unknown* status,
                // and §8.3 says APPEND is deliberately not idempotent.
                let _ = job.reply.send(reply);
            }
        }
        Err(error) => {
            // The transaction itself failed, so nothing in the batch was
            // written. Every job learns that, and §6.3 collapses it to
            // `ERR_UNAVAILABLE` on the wire.
            crate::log_error!(
                "commit transaction failed",
                "appends" = u32::try_from(batch.len()).unwrap_or(u32::MAX)
            );
            let mut first = Some(error);
            for job in batch {
                let reply = first.take().map_or_else(
                    || Err(StoreError::Corrupt("the commit transaction failed")),
                    Err,
                );
                let _ = job.reply.send(reply);
            }
        }
    }
}

fn accepted(appended: &Appended, durability: Durability) -> Accepted {
    Accepted {
        recv_addr: appended.recv_addr,
        index: appended.index,
        received_at_ms: appended.received_at_ms,
        durability,
    }
}

/// A counter the tests use to prove the amortization. Not wired into the relay:
/// the real number is `SqliteStore::commits`, and this exists so a store that
/// is not SQLite can still be asked.
#[derive(Debug, Default)]
pub struct CommitCounter(pub AtomicU64);

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::types::PublicKey;
    use f2z_relay_proto::queue::{AppendQuota, QueueKind};
    use f2z_relay_store::{MemoryStore, QueueSpec};

    fn store_with_queue() -> (Arc<dyn RelayStore + Send + Sync>, QueueAddress, PublicKey) {
        let store = MemoryStore::new();
        let recv_addr = QueueAddress::new([1u8; 32]);
        let send_addr = QueueAddress::new([2u8; 32]);
        let recv_key = PublicKey::new([3u8; 32]);
        let send_key = PublicKey::new([4u8; 32]);
        let _created = store
            .create_queue(&QueueSpec {
                kind: QueueKind::Standard,
                recv_addr,
                send_addr,
                recv_key,
                message_ttl_seconds: 600,
                idle_ttl_seconds: 6_000,
                quota: AppendQuota {
                    max_messages: 1_000,
                    max_bytes: 1 << 20,
                },
                created_at_ms: 0,
            })
            .unwrap();
        let _bound = store.bind_send(&send_addr, &send_key, 0).unwrap();
        (Arc::new(store), send_addr, send_key)
    }

    #[tokio::test]
    async fn an_append_is_answered_only_after_its_transaction() {
        let (store, send_addr, send_key) = store_with_queue();
        let metrics = Arc::new(Metrics::new());
        let writer =
            CommitWriter::start(store, Arc::clone(&metrics), Duration::from_millis(1), 16).unwrap();
        let payload = Payload::new(vec![0u8; 1024]).unwrap();
        let accepted = writer
            .append(send_addr, SendAuth::Signed(send_key), payload, 1_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(accepted.index, 0);
        assert_eq!(accepted.durability, Durability::Memory);
        assert_eq!(
            metrics
                .appends_committed
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn many_concurrent_appends_share_transactions() {
        let (store, send_addr, send_key) = store_with_queue();
        let metrics = Arc::new(Metrics::new());
        let writer = CommitWriter::start(
            Arc::clone(&store),
            Arc::clone(&metrics),
            Duration::from_millis(20),
            64,
        )
        .unwrap();

        let mut tasks = Vec::new();
        for _ in 0..64u32 {
            let writer = writer.clone();
            tasks.push(tokio::spawn(async move {
                let payload = Payload::new(vec![0u8; 1024]).unwrap();
                writer
                    .append(send_addr, SendAuth::Signed(send_key), payload, 1_000)
                    .await
                    .unwrap()
                    .unwrap()
            }));
        }
        let mut indices = Vec::new();
        for task in tasks {
            indices.push(task.await.unwrap().index);
        }
        indices.sort_unstable();
        assert_eq!(indices, (0..64u64).collect::<Vec<_>>());

        // The amortization, as a number rather than a claim. 64 appends into a
        // 20 ms window must not have cost 64 transactions.
        let transactions = metrics
            .commit_transactions
            .load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            transactions < 64,
            "64 concurrent appends took {transactions} transactions; group commit did nothing"
        );
    }

    #[tokio::test]
    async fn one_writers_refusal_does_not_undo_the_batch() {
        let (store, send_addr, send_key) = store_with_queue();
        let metrics = Arc::new(Metrics::new());
        let writer =
            CommitWriter::start(store, Arc::clone(&metrics), Duration::from_millis(20), 8).unwrap();

        let good = writer.append(
            send_addr,
            SendAuth::Signed(send_key),
            Payload::new(vec![0u8; 1024]).unwrap(),
            1_000,
        );
        let absent = writer.append(
            QueueAddress::new([0x5b; 32]),
            SendAuth::Signed(send_key),
            Payload::new(vec![0u8; 1024]).unwrap(),
            1_000,
        );
        let (good, absent) = tokio::join!(good, absent);
        assert!(good.unwrap().is_ok());
        assert!(absent.unwrap().is_err());
    }

    #[test]
    fn a_job_never_renders_its_payload() {
        let (reply, _answer) = tokio::sync::oneshot::channel();
        let job = Job {
            send_addr: QueueAddress::new([9u8; 32]),
            auth: SendAuth::ContactStamp,
            payload: Payload::new(vec![0xde, 0xad, 0xbe, 0xef]).unwrap(),
            received_at_ms: 1,
            reply,
        };
        let rendered = format!("{job:?}");
        assert!(
            !rendered.contains("222"),
            "decimal byte list leaked: {rendered}"
        );
        assert!(!rendered.contains("deadbeef"));
    }
}
