//! Compile and execute the exact native lifecycle/callback engine without a GTK/SDK
//! runtime. This is a controlled seam, never physical-device acceptance.
use f2z_notify_proto::Status;
#[path = "../../../../wallet/plugins/tauri-plugin-notify/src/engine.rs"]
mod engine;

#[tokio::test]
async fn real_http_bootstrap_lost_reply_rotates_then_revokes_without_resurrecting_consent() {
    use engine::Port;
    use f2z_notify::{
        Service,
        provider::{Delivery, Outcome},
    };
    use f2z_notify_proto::{Envelope, Provider};
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    struct Capture(Mutex<Vec<String>>);
    impl Delivery for Capture {
        fn configured(&self, _: Provider) -> bool {
            true
        }
        fn deliver<'a>(
            &'a self,
            _: Provider,
            token: &'a str,
            _: Envelope,
        ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
            self.0.lock().unwrap().push(token.into());
            Box::pin(async { Outcome::Accepted })
        }
    }
    struct HttpDevice {
        native: engine::tests::Device,
        url: String,
        lose: AtomicBool,
    }
    impl Port for HttpDevice {
        fn invoke(
            &self,
            command: &str,
            args: serde_json::Value,
        ) -> Result<serde_json::Value, &'static str> {
            self.native.invoke(command, args)
        }
        fn post<'a>(
            &'a self,
            _: &'a reqwest::Url,
            route: &'a str,
            value: serde_json::Value,
        ) -> Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send + 'a>> {
            Box::pin(async move {
                let r = reqwest::Client::new()
                    .post(format!("{}/notify/v1/{route}", self.url))
                    .json(&value)
                    .send()
                    .await
                    .map_err(|_| "offline")?;
                if r.status() != 204 {
                    return Err("denied");
                }
                // The real service has COMMITTED registration. Lose only the acknowledgement.
                if route == "register" && self.lose.swap(false, Ordering::SeqCst) {
                    return Err("offline");
                }
                Ok(())
            })
        }
    }
    let capture = Arc::new(Capture(Mutex::new(vec![])));
    let service = Service::new(
        vec!["a".repeat(64)],
        ed25519_dalek::SigningKey::from_bytes(&[8; 32]),
        capture.clone(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server =
        tokio::spawn(axum::serve(listener, f2z_notify::router(service.clone())).into_future());
    let device = HttpDevice {
        native: engine::tests::Device::new(),
        url: format!("http://{addr}"),
        lose: AtomicBool::new(true),
    };
    assert_eq!(
        engine::execute(&device, "enable", engine::tests::config())
            .await
            .err(),
        Some("offline")
    );
    let initial = device.native.record();
    let lease: serde_json::Value =
        serde_json::from_str(initial["lease"].as_str().unwrap()).unwrap();
    assert!(
        device
            .native
            .callback(lease["consent"].as_str().unwrap(), &"f".repeat(64))
    );
    assert_eq!(
        engine::execute(&device, "reconcile", engine::tests::config())
            .await
            .unwrap()
            .state,
        "enabled"
    );
    engine::execute(&device, "test_wake", engine::tests::config())
        .await
        .unwrap();
    service.dispatch(f2z_notify::now()).await;
    assert_eq!(*capture.0.lock().unwrap(), vec!["f".repeat(64)]);
    assert_eq!(
        engine::execute(&device, "disable", engine::tests::config())
            .await
            .unwrap()
            .state,
        "off"
    );
    assert!(
        !device
            .native
            .callback(lease["consent"].as_str().unwrap(), &"e".repeat(64))
    );
    assert_eq!(
        engine::execute(&device, "status", engine::tests::config())
            .await
            .unwrap()
            .state,
        "off"
    );
    let r = reqwest::Client::new()
        .post(format!("{}/notify/v1/wake", device.url))
        .json(&serde_json::json!({"queue":lease["queue"],"send":lease["send"],"sequence":2}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    server.abort();
    let _ = server.await;
}
