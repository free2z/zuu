//! Session-scoped pull delivery: bounded operations, no background event queue.
use crate::wire::{self, NativeError, Result};
use f2z_sdk::{
    Client,
    ai::{ChatOptions, ChatStream},
    proto::ChatRequest,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

const MAX_OPERATIONS: usize = 8;
const IDLE: Duration = Duration::from_secs(120);
const MAX_EVENT_BYTES: usize = 1_048_576;
struct Operation {
    owner: String,
    generation: u64,
    key: String,
    cancel: CancellationToken,
    touched: Mutex<Instant>,
    stream: AsyncMutex<Option<ChatStream>>,
    opened: std::sync::atomic::AtomicBool,
}
struct State {
    generation: u64,
    cancel: CancellationToken,
    operations: HashMap<String, Arc<Operation>>,
}
pub struct Engine {
    pub client: Client,
    state: Mutex<State>,
    /// Only one authorization UI may be presented. Sign-out can cancel it.
    pub auth: AsyncMutex<()>,
    auth_window: Mutex<Option<String>>,
}
pub struct AuthWindow<'a>(&'a Mutex<Option<String>>);
impl Drop for AuthWindow<'_> {
    fn drop(&mut self) {
        if let Ok(mut owner) = self.0.lock() {
            *owner = None;
        }
    }
}
impl Engine {
    // Called only while the async authorization mutex is owned by this command.
    pub fn begin_auth(&self, owner: &str) -> Result<(AuthWindow<'_>, u64, CancellationToken)> {
        let mut window = self
            .auth_window
            .lock()
            .map_err(|_| NativeError::new("internal_error"))?;
        let (generation, cancel) = self.invalidate()?;
        *window = Some(owner.into());
        Ok((AuthWindow(&self.auth_window), generation, cancel))
    }
    pub fn new(client: Client) -> Self {
        Self {
            client,
            state: Mutex::new(State {
                generation: 0,
                cancel: CancellationToken::new(),
                operations: HashMap::new(),
            }),
            auth: AsyncMutex::new(()),
            auth_window: Mutex::new(None),
        }
    }
    fn state(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| NativeError::new("internal_error"))
    }
    pub fn snapshot(&self) -> Result<(u64, CancellationToken)> {
        let _transition = self
            .auth
            .try_lock()
            .map_err(|_| NativeError::new("authentication_busy"))?;
        let state = self.state()?;
        Ok((state.generation, state.cancel.clone()))
    }
    pub fn check(&self, generation: u64) -> Result<()> {
        if self.state()?.generation != generation {
            Err(NativeError::new("session_changed"))
        } else {
            Ok(())
        }
    }
    pub fn invalidate(&self) -> Result<(u64, CancellationToken)> {
        let mut state = self.state()?;
        state.cancel.cancel();
        for operation in state.operations.values() {
            operation.cancel.cancel();
        }
        state.operations.clear();
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| NativeError::new("internal_error"))?;
        state.cancel = CancellationToken::new();
        Ok((state.generation, state.cancel.clone()))
    }
    pub fn expire(&self) -> Result<()> {
        let mut state = self.state()?;
        state.operations.retain(|_, op| {
            // A caller actively awaiting next() is not an idle consumer.
            let live = op.stream.try_lock().is_err()
                || op.touched.lock().is_ok_and(|last| last.elapsed() < IDLE);
            if !live {
                op.cancel.cancel();
            }
            live
        });
        Ok(())
    }
    pub fn close_window(&self, owner: &str) -> Result<()> {
        let authenticating = self
            .auth_window
            .lock()
            .map_err(|_| NativeError::new("internal_error"))?;
        if authenticating.as_deref() == Some(owner) {
            self.invalidate()?;
        }
        drop(authenticating);
        let mut state = self.state()?;
        state.operations.retain(|_, op| {
            if op.owner == owner {
                op.cancel.cancel();
                false
            } else {
                true
            }
        });
        Ok(())
    }
    pub async fn session(&self) -> Result<Value> {
        let (generation, _) = self.snapshot()?;
        let signed_in = self
            .client
            .is_signed_in()
            .await
            .map_err(NativeError::from)?;
        let subject = self.client.subject().await;
        let scopes = self.client.granted_scopes().await;
        self.check(generation)?;
        Ok(
            json!({"signedIn":signed_in,"subject":subject,"grantedScopes":scopes,
            "persistence":match self.client.token_persistence() { f2z_sdk::Persistence::Persistent => "persistent", _ => "memory_only" },
            "generation":generation.to_string()}),
        )
    }
    pub async fn read<T, F>(&self, future: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        let (generation, cancel) = self.snapshot()?;
        let result = tokio::select! { biased; () = cancel.cancelled() => Err(NativeError::new("session_changed")), value = future => value };
        self.check(generation)?;
        result
    }
    fn register(&self, owner: &str, spec: &wire::ChatOperation) -> Result<Arc<Operation>> {
        wire::key(&spec.operation_id)?;
        wire::key(&spec.idempotency_key)?;
        let _transition = self
            .auth
            .try_lock()
            .map_err(|_| NativeError::new("authentication_busy").key(&spec.idempotency_key))?;
        self.expire()?;
        let operation = {
            let mut state = self.state()?;
            if state.operations.contains_key(&spec.operation_id) {
                return Err(NativeError::new("operation_exists").key(&spec.idempotency_key));
            }
            if state.operations.len() >= MAX_OPERATIONS {
                return Err(NativeError::new("too_many_operations").key(&spec.idempotency_key));
            }
            // Checked under the lock that pins the operation to
            // `state.generation`: a caller (the tool loop) that read the
            // session earlier never has its call made as another user.
            if spec
                .session_generation
                .as_deref()
                .is_some_and(|expected| expected != state.generation.to_string())
            {
                return Err(NativeError::new("session_changed").key(&spec.idempotency_key));
            }
            let op = Arc::new(Operation {
                owner: owner.into(),
                generation: state.generation,
                key: spec.idempotency_key.clone(),
                cancel: state.cancel.child_token(),
                touched: Mutex::new(Instant::now()),
                stream: AsyncMutex::new(None),
                opened: std::sync::atomic::AtomicBool::new(false),
            });
            state
                .operations
                .insert(spec.operation_id.clone(), op.clone());
            op
        };
        Ok(operation)
    }
    pub async fn start(
        &self,
        owner: &str,
        request: ChatRequest,
        spec: wire::ChatOperation,
    ) -> Result<Value> {
        let operation = self.register(owner, &spec)?;
        let options = ChatOptions::default()
            .with_idempotency_key(&operation.key)
            .with_max_retries(0);
        let ai = self.client.ai();
        let result = tokio::select! { biased;
            () = operation.cancel.cancelled() => Err(f2z_sdk::Error::Cancelled),
            result = ai.chat_with(request, options) => result
        };
        if let Err(e) = self.check(operation.generation) {
            return Err(e.key(&operation.key));
        }
        if operation.cancel.is_cancelled() {
            self.remove(&spec.operation_id, &operation)?;
            return Err(NativeError::new("cancelled").key(&operation.key));
        }
        match result {
            Ok(stream) => {
                let call_id = stream.call_id().map(str::to_owned);
                let mut slot = operation.stream.lock().await;
                if let Err(error) = self.check(operation.generation) {
                    return Err(error.key(&operation.key).call(call_id.as_deref()));
                }
                if operation.cancel.is_cancelled() {
                    self.remove(&spec.operation_id, &operation)?;
                    return Err(NativeError::new("cancelled")
                        .key(&operation.key)
                        .call(call_id.as_deref()));
                }
                *slot = Some(stream);
                operation
                    .opened
                    .store(true, std::sync::atomic::Ordering::Release);
                let mut opened = json!({"operationId":spec.operation_id});
                if let Some(call_id) = call_id {
                    opened["callId"] = Value::String(call_id);
                }
                Ok(opened)
            }
            Err(f2z_sdk::Error::Replayed(record)) => {
                self.remove(&spec.operation_id, &operation)?;
                Ok(
                    json!({"operationId":spec.operation_id,"callId":record.call_id,"replay":wire::call_record(&record)?}),
                )
            }
            Err(error) => {
                self.remove(&spec.operation_id, &operation)?;
                Err(NativeError::from(error).key(&operation.key))
            }
        }
    }
    fn find(&self, owner: &str, id: &str) -> Result<Arc<Operation>> {
        let state = self.state()?;
        let op = state
            .operations
            .get(id)
            .filter(|op| op.owner == owner && op.generation == state.generation)
            .ok_or_else(|| NativeError::new("operation_not_found"))?;
        Ok(op.clone())
    }
    fn remove(&self, id: &str, op: &Arc<Operation>) -> Result<()> {
        let mut state = self.state()?;
        if state
            .operations
            .get(id)
            .is_some_and(|stored| Arc::ptr_eq(stored, op))
        {
            state.operations.remove(id);
        }
        Ok(())
    }
    pub async fn next(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.expire()?;
        let op = self.find(owner, id)?;
        let mut guard = op
            .stream
            .try_lock()
            .map_err(|_| NativeError::new("reader_busy").key(&op.key))?;
        if !op.opened.load(std::sync::atomic::Ordering::Acquire) {
            return Err(NativeError::new("operation_opening").key(&op.key));
        }
        let Some(stream) = guard.as_mut() else {
            self.remove(id, &op)?;
            return Ok(None);
        };
        *op.touched
            .lock()
            .map_err(|_| NativeError::new("internal_error"))? = Instant::now();
        let result = tokio::select! { biased;
            () = op.cancel.cancelled() => Err(f2z_sdk::Error::Cancelled),
            result = stream.next() => result
        };
        let call_id = stream.call_id().map(str::to_owned);
        if let Err(e) = self.check(op.generation) {
            *guard = None;
            return Err(e.key(&op.key).call(call_id.as_deref()));
        }
        if op.cancel.is_cancelled() {
            *guard = None;
            self.remove(id, &op)?;
            return Err(NativeError::new("cancelled")
                .key(&op.key)
                .call(call_id.as_deref()));
        }
        *op.touched
            .lock()
            .map_err(|_| NativeError::new("internal_error"))? = Instant::now();
        match result {
            Ok(Some(event)) => {
                let terminal = matches!(
                    event,
                    f2z_sdk::proto::Event::Done(_) | f2z_sdk::proto::Event::Error(_)
                );
                let value =
                    wire::event(&event).map_err(|e| e.key(&op.key).call(call_id.as_deref()))?;
                if serde_json::to_vec(&value)
                    .map_err(|_| NativeError::new("protocol_error"))?
                    .len()
                    > MAX_EVENT_BYTES
                {
                    *guard = None;
                    self.remove(id, &op)?;
                    return Err(NativeError::new("event_too_large")
                        .key(&op.key)
                        .call(call_id.as_deref()));
                }
                if terminal {
                    *guard = None;
                }
                Ok(Some(value))
            }
            Ok(None) => {
                *guard = None;
                self.remove(id, &op)?;
                Ok(None)
            }
            Err(error) => {
                *guard = None;
                self.remove(id, &op)?;
                Err(NativeError::from(error)
                    .key(&op.key)
                    .call(call_id.as_deref()))
            }
        }
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Result<()> {
        let op = self.find(owner, id)?;
        op.cancel.cancel();
        self.remove(id, &op)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> Engine {
        Engine::new(
            Client::new(
                f2z_sdk::Config::new("public-test"),
                Arc::new(f2z_sdk::MemoryStore::new()),
            )
            .unwrap(),
        )
    }
    fn spec(id: &str) -> wire::ChatOperation {
        wire::ChatOperation {
            operation_id: id.into(),
            idempotency_key: format!("key-{id}"),
            session_generation: None,
        }
    }
    #[test]
    fn a_call_pinned_to_an_old_session_is_refused_at_registration() {
        let engine = engine();
        let (old, _) = engine.snapshot().unwrap();
        let pinned = |generation: u64| wire::ChatOperation {
            session_generation: Some(generation.to_string()),
            ..spec(&format!("pinned-{generation}"))
        };
        engine.register("main", &pinned(old)).unwrap();
        engine.invalidate().unwrap();
        assert_eq!(
            engine.register("main", &pinned(old)).err().unwrap().code,
            "session_changed"
        );
        let (now, _) = engine.snapshot().unwrap();
        engine.register("main", &pinned(now)).unwrap();
    }
    #[test]
    fn operations_are_bounded_owned_and_keys_are_preserved() {
        let engine = engine();
        for i in 0..MAX_OPERATIONS {
            engine.register("main", &spec(&i.to_string())).unwrap();
        }
        assert_eq!(
            engine.register("main", &spec("extra")).err().unwrap().code,
            "too_many_operations"
        );
        assert!(engine.find("other", "0").is_err());
        assert!(engine.cancel("other", "0").is_err());
        let operation = engine.find("main", "0").unwrap();
        assert_eq!(operation.key, "key-0");
        engine.cancel("main", "0").unwrap();
        assert!(operation.cancel.is_cancelled());
        engine.register("main", &spec("extra")).unwrap();
    }
    #[test]
    fn session_change_and_window_close_cancel_opening_operations() {
        let engine = engine();
        let operation = engine.register("main", &spec("opening")).unwrap();
        let (old, cancel) = engine.snapshot().unwrap();
        engine.invalidate().unwrap();
        assert!(operation.cancel.is_cancelled());
        assert!(cancel.is_cancelled());
        assert_eq!(engine.check(old).unwrap_err().code, "session_changed");
        assert!(engine.find("main", "opening").is_err());
        let operation = engine.register("other", &spec("other")).unwrap();
        engine.close_window("main").unwrap();
        assert!(!operation.cancel.is_cancelled());
        engine.close_window("other").unwrap();
        assert!(operation.cancel.is_cancelled());
    }
    #[tokio::test]
    async fn closing_the_authorizing_window_cancels_its_browser_attempt() {
        let engine = engine();
        let _guard = engine.auth.lock().await;
        let (_owner, generation, cancel) = engine.begin_auth("main").unwrap();
        engine.close_window("other").unwrap();
        assert!(!cancel.is_cancelled());
        engine.close_window("main").unwrap();
        assert!(cancel.is_cancelled());
        assert!(engine.check(generation).is_err());
    }
    #[tokio::test]
    async fn account_commands_do_not_start_during_authentication() {
        let engine = engine();
        let guard = engine.auth.lock().await;
        let (owner, _, _) = engine.begin_auth("main").unwrap();
        assert_eq!(
            engine.session().await.unwrap_err().code,
            "authentication_busy"
        );
        assert_eq!(
            engine
                .read(async {
                    panic!("old account request started");
                    #[allow(unreachable_code)]
                    Ok(())
                })
                .await
                .unwrap_err()
                .code,
            "authentication_busy"
        );
        let error = engine.register("main", &spec("during")).err().unwrap();
        assert_eq!(error.code, "authentication_busy");
        assert_eq!(error.idempotency_key.as_deref(), Some("key-during"));
        drop(owner);
        drop(guard);
        assert!(engine.register("main", &spec("after")).is_ok());
    }
    #[tokio::test]
    async fn only_one_reader_can_consume_an_operation() {
        let engine = engine();
        let op = engine.register("main", &spec("one")).unwrap();
        let guard = op.stream.lock().await;
        let error = engine.next("main", "one").await.unwrap_err();
        assert_eq!(error.code, "reader_busy");
        assert_eq!(error.idempotency_key.as_deref(), Some("key-one"));
        drop(guard);
        assert_eq!(
            engine.next("main", "one").await.unwrap_err().code,
            "operation_opening"
        );
    }
    #[test]
    fn idle_operations_release_slots_and_cancel_pending_delivery() {
        let engine = engine();
        let op = engine.register("main", &spec("idle")).unwrap();
        *op.touched.lock().unwrap() = Instant::now() - IDLE;
        engine.expire().unwrap();
        assert!(op.cancel.is_cancelled());
        assert!(engine.find("main", "idle").is_err());
    }
    #[tokio::test]
    async fn an_active_reader_is_not_expired_as_an_idle_consumer() {
        let engine = engine();
        let op = engine.register("main", &spec("active")).unwrap();
        *op.touched.lock().unwrap() = Instant::now() - IDLE;
        let guard = op.stream.lock().await;
        engine.expire().unwrap();
        assert!(!op.cancel.is_cancelled());
        drop(guard);
        engine.expire().unwrap();
        assert!(op.cancel.is_cancelled());
    }
    #[tokio::test]
    async fn late_account_results_are_discarded() {
        let engine = engine();
        let result = engine
            .read(async {
                engine.invalidate().unwrap();
                Ok("old account data")
            })
            .await;
        assert_eq!(result.unwrap_err().code, "session_changed");
    }
    #[test]
    fn an_old_completion_cannot_remove_reused_operation_id() {
        let engine = engine();
        let old = engine.register("main", &spec("same")).unwrap();
        engine.cancel("main", "same").unwrap();
        let new = engine.register("main", &spec("same")).unwrap();
        engine.remove("same", &old).unwrap();
        assert!(Arc::ptr_eq(&engine.find("main", "same").unwrap(), &new));
    }
}

#[cfg(test)]
#[path = "engine_http_tests.rs"]
mod http_tests;
