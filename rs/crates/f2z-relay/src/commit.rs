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
//! # …and why that thread is nevertheless supervised (zuu#685)
//!
//! Being a thread put this worker **outside** zuu#683's supervision, which
//! holds `tokio::task::JoinHandle`s and polls them. That is a type boundary and
//! not an oversight in a list of names, and it left the relay with the worst
//! shape in the system: when this thread died, [`CommitWriter::append`] began
//! returning [`CommitError::WriterStopped`], `engine.rs` turned that into a
//! per-request `ERR_UNAVAILABLE`, and the process went on answering `/healthz`
//! with `200` while it could not store a single message. Under delete-on-ack
//! that is not downtime; a sender told `accepted` by a relay that never wrote
//! the message has had data destroyed between them.
//!
//! So [`CommitWriter::start`] hands back a [`WriterStopped`] alongside the
//! handle: the thread owns a `oneshot::Sender` it never sends on, and dropping
//! it — by returning, or by unwinding out of a panic — resolves the receiver.
//! `server.rs` supervises a task that awaits exactly that, so the writer's
//! death arrives at [`crate::server::Server::run_until_stopped`] in the same
//! shape every other task's does.
//!
//! **The bridging task is itself supervised**, which is the point: it is
//! registered in the same `Vec<Supervised>` as the four tokio tasks, so a
//! watchdog that is itself killed is reported exactly as the thing it watches
//! would be. Solving a supervision gap by adding an unsupervised supervisor
//! would move the hole rather than close it.
//!
//! The alternative — `spawn_blocking`, whose handle is pollable — was
//! considered and rejected: an aborted blocking task cannot be cancelled once
//! it is running, so the shutdown path would have to wait out
//! `SHUTDOWN_GRACE` on **every** ordinary stop, and the test that proves the
//! supervision works could not produce the failure at all.
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

/// What the writer takes over the channel.
///
/// An enum with one shipped variant, so that the testing-only way to kill the
/// thread is a *message* rather than a magic value inside a real [`Job`]. The
/// shipped binary contains `Append` and nothing else.
enum Message {
    /// One append, waiting for a transaction.
    Append(Job),
    /// Die here, exactly where a panic inside the writer would leave the
    /// relay. Behind the `testing` feature, like `Server::abort_task`, and for
    /// the same reason: the real cause is a bug rather than an input, and a
    /// fault-injection hook that reached the shipped binary would be a far
    /// worse thing to carry than one that cannot.
    #[cfg(any(test, feature = "testing"))]
    Stop,
}

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

/// Resolves when the group-commit writer thread has ended, for any reason.
///
/// The thread holds the matching `oneshot::Sender` and never sends on it, so
/// the only thing that can complete this is the sender being **dropped** —
/// which happens when `run` returns and when a panic unwinds out of it. There
/// is nothing for the writer to remember to do, which is the property that
/// makes this trustworthy: a liveness signal the worker has to publish is a
/// liveness signal a panicking worker does not publish.
#[derive(Debug)]
pub struct WriterStopped(tokio::sync::oneshot::Receiver<core::convert::Infallible>);

impl WriterStopped {
    /// Wait for the writer thread to end.
    pub async fn wait(self) {
        // `Ok` is unreachable — `Infallible` has no values — so this resolves
        // only on the sender's drop.
        let Err(_dropped) = self.0.await;
    }
}

/// A handle on the writer.
#[derive(Clone, Debug)]
pub struct CommitWriter {
    sender: std::sync::mpsc::Sender<Message>,
    durability: Durability,
}

impl CommitWriter {
    /// Start the writer thread.
    ///
    /// `window` is how long a batch gathers after its first job; `max_batch` is
    /// the most appends one transaction takes.
    ///
    /// Returns the handle **and** a [`WriterStopped`] that resolves when the
    /// thread ends (zuu#685). The caller is expected to supervise it: a relay
    /// whose write path is gone must stop, not answer probes.
    ///
    /// # Errors
    ///
    /// The thread could not be spawned.
    pub fn start(
        store: Arc<dyn RelayStore + Send + Sync>,
        metrics: Arc<Metrics>,
        window: Duration,
        max_batch: usize,
    ) -> std::io::Result<(Self, WriterStopped)> {
        let durability = store.durability();
        let (sender, receiver) = std::sync::mpsc::channel::<Message>();
        let (alive, stopped) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("f2z-relay-commit".to_owned())
            .spawn(move || {
                // Moved in and never used: it exists to be dropped when this
                // closure ends, however it ends.
                let _alive = alive;
                run(&store, &metrics, &receiver, window, max_batch.max(1));
            })?;
        Ok((Self { sender, durability }, WriterStopped(stopped)))
    }

    /// Make the writer thread exit, exactly where a panic inside it would.
    ///
    /// Returns whether the message could be delivered. See [`Message::Stop`]
    /// for why this is behind a feature that never reaches the binary.
    #[cfg(any(test, feature = "testing"))]
    pub fn stop_for_test(&self) -> bool {
        self.sender.send(Message::Stop).is_ok()
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
            .send(Message::Append(Job {
                send_addr,
                auth,
                payload,
                received_at_ms,
                reply,
            }))
            .map_err(|_| CommitError::WriterStopped)?;
        answer.await.map_err(|_| CommitError::WriterStopped)
    }
}

fn run(
    store: &Arc<dyn RelayStore + Send + Sync>,
    metrics: &Arc<Metrics>,
    receiver: &std::sync::mpsc::Receiver<Message>,
    window: Duration,
    max_batch: usize,
) {
    let durability = store.durability();
    loop {
        // Block until there is anything to do. A relay with no traffic costs no
        // wakeups, which on a shared VPS is a real number.
        let Ok(message) = receiver.recv() else {
            return;
        };
        let first = match message {
            Message::Append(job) => job,
            #[cfg(any(test, feature = "testing"))]
            Message::Stop => return,
        };
        let deadline = Instant::now().checked_add(window);
        let mut batch = vec![first];
        #[cfg(any(test, feature = "testing"))]
        let mut stopping = false;

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
                Ok(Message::Append(job)) => batch.push(job),
                // Commit what is in hand first: those jobs' senders are waiting
                // on a durable answer, and §13.2 says a message accepted into
                // this batch must not be thrown away.
                #[cfg(any(test, feature = "testing"))]
                Ok(Message::Stop) => {
                    stopping = true;
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                // The last sender went away. Commit what is in hand — those
                // clients are gone, but their queues' readers are not, and a
                // message thrown away here is a message §13.2 says must not be.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        commit(store, metrics, durability, batch);

        #[cfg(any(test, feature = "testing"))]
        if stopping {
            return;
        }
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
        let (writer, _stopped) =
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
        let (writer, _stopped) = CommitWriter::start(
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
        let (writer, _stopped) =
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

    /// zuu#685's mechanism, with **no injection hook involved at all**.
    ///
    /// Dropping the last `Sender` makes `receiver.recv()` fail and `run`
    /// return, which is a genuine end of the writer thread. The signal has to
    /// arrive from the thread unwinding its own locals — there is nothing the
    /// writer remembers to do — and that is exactly why a panic inside it is
    /// covered too. Without this, `stop_for_test` could be proving only that
    /// one testing path works.
    #[tokio::test]
    async fn the_liveness_signal_fires_when_the_writer_thread_really_ends() {
        let (store, _send_addr, _send_key) = store_with_queue();
        let (writer, stopped) =
            CommitWriter::start(store, Arc::new(Metrics::new()), Duration::from_millis(1), 8)
                .unwrap();
        drop(writer);
        tokio::time::timeout(Duration::from_secs(5), stopped.wait())
            .await
            .expect("the writer thread's death is observable to a supervisor");
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
