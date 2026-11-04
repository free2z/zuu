//! Real core HTTP integration at the bridge boundary; no OS/provider credentials.
use super::*;
use axum::{
    Json, Router,
    body::Body,
    extract::State as AxumState,
    http::{HeaderMap, Response},
    routing::{get, post},
};
use f2z_sdk::oauth::{AuthSession, AuthorizationRequest, BoxFuture};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Browser {
    issuer: String,
}
impl AuthSession for Browser {
    fn redirect_uri(&self) -> &str {
        "http://127.0.0.1:1/callback"
    }
    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
    ) -> BoxFuture<'a, std::result::Result<String, f2z_sdk::Error>> {
        Box::pin(async move {
            let url = url::Url::parse(&request.url).unwrap();
            let state = url
                .query_pairs()
                .find(|(k, _)| k == "state")
                .unwrap()
                .1
                .into_owned();
            let mut result = url::Url::parse(self.redirect_uri()).unwrap();
            result
                .query_pairs_mut()
                .append_pair("code", "test-code")
                .append_pair("state", &state)
                .append_pair("iss", &self.issuer);
            Ok(result.into())
        })
    }
}
struct Server {
    issuer: String,
    mode: u8,
    arrived: tokio::sync::Notify,
    calls: AtomicUsize,
    keys: Mutex<Vec<String>>,
}
async fn discovery(AxumState(s): AxumState<Arc<Server>>) -> Json<Value> {
    Json(
        json!({"issuer":s.issuer,"authorization_endpoint":format!("{}/authorize",s.issuer),
        "token_endpoint":format!("{}/token",s.issuer),"jwks_uri":format!("{}/jwks",s.issuer),
        "code_challenge_methods_supported":["S256"]}),
    )
}
async fn token() -> Json<Value> {
    Json(
        json!({"access_token":"test-access","token_type":"Bearer","expires_in":3600,"scope":"ai:chat"}),
    )
}
async fn chat(AxumState(s): AxumState<Arc<Server>>, headers: HeaderMap) -> Response<Body> {
    s.calls.fetch_add(1, Ordering::SeqCst);
    s.keys
        .lock()
        .unwrap()
        .push(headers["idempotency-key"].to_str().unwrap().into());
    s.arrived.notify_one();
    if s.mode == 1 {
        std::future::pending::<()>().await;
    }
    if s.mode == 2 {
        return Response::builder()
            .status(503)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"code":"unavailable","message":"temporary"}}"#,
            ))
            .unwrap();
    }
    Response::builder().header("content-type", "text/event-stream").header("x-f2z-call-id", "call-one")
        .body(Body::from("event: meta\ndata: {\"type\":\"meta\",\"call_id\":\"call-one\",\"model\":\"test\",\"hold_2z\":1}\n\nevent: delta\ndata: {\"type\":\"delta\",\"text\":\"partial\"}\n\n")).unwrap()
}
async fn setup(mode: u8) -> (Arc<Engine>, Arc<Server>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let server = Arc::new(Server {
        issuer: issuer.clone(),
        mode,
        arrived: tokio::sync::Notify::new(),
        calls: AtomicUsize::new(0),
        keys: Mutex::new(Vec::new()),
    });
    let router = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/token", post(token))
        .route("/v1/chat", post(chat))
        .with_state(server.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let config = f2z_sdk::Config::new("test-client")
        .with_issuer(&issuer)
        .with_ai_base(format!("{issuer}/v1"))
        .with_scopes(["ai:chat"])
        .with_request_timeout(Duration::from_secs(2));
    let client = Client::new(config, Arc::new(f2z_sdk::MemoryStore::new())).unwrap();
    client
        .sign_in(&Browser { issuer }, f2z_sdk::SignInOptions::default())
        .await
        .unwrap();
    (Arc::new(Engine::new(client)), server, task)
}
fn request() -> ChatRequest {
    serde_json::from_value(json!({"model":"test","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]})).unwrap()
}
fn spec() -> wire::ChatOperation {
    wire::ChatOperation {
        operation_id: "operation".into(),
        idempotency_key: "saved-key".into(),
        session_generation: None,
    }
}
#[tokio::test]
async fn interrupted_stream_keeps_exact_recovery_identifiers() {
    let (engine, server, task) = setup(0).await;
    let opened = engine.start("main", request(), spec()).await.unwrap();
    assert_eq!(opened["callId"], "call-one");
    let meta = engine.next("main", "operation").await.unwrap().unwrap();
    assert_eq!(meta["hold_2z"], "1");
    assert_eq!(
        engine.next("main", "operation").await.unwrap().unwrap()["text"],
        "partial"
    );
    let error = engine.next("main", "operation").await.unwrap_err();
    assert_eq!(error.idempotency_key.as_deref(), Some("saved-key"));
    assert_eq!(error.call_id.as_deref(), Some("call-one"));
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    task.abort();
}
#[tokio::test]
async fn cancellation_interrupts_start_before_response_headers() {
    let (engine, server, task) = setup(1).await;
    let running = {
        let engine = engine.clone();
        tokio::spawn(async move { engine.start("main", request(), spec()).await })
    };
    tokio::time::timeout(Duration::from_secs(3), server.arrived.notified())
        .await
        .unwrap();
    engine.cancel("main", "operation").unwrap();
    let error = tokio::time::timeout(Duration::from_millis(500), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.idempotency_key.as_deref(), Some("saved-key"));
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    task.abort();
}
#[tokio::test]
async fn retryable_failure_does_not_invent_an_unsaved_new_key() {
    let (engine, server, task) = setup(2).await;
    let error = engine.start("main", request(), spec()).await.unwrap_err();
    assert!(error.retryable);
    assert_eq!(error.idempotency_key.as_deref(), Some("saved-key"));
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    assert_eq!(*server.keys.lock().unwrap(), vec!["saved-key"]);
    task.abort();
}
