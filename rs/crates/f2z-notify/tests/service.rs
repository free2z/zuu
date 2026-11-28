use ed25519_dalek::SigningKey;
use f2z_notify::{
    Error, Service,
    provider::{Delivery, Outcome},
};
use f2z_notify_proto::*;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Device {
    deliveries: Mutex<Vec<(String, Envelope)>>,
    stale: bool,
}
impl Delivery for Device {
    fn configured(&self, _: Provider) -> bool {
        true
    }
    fn deliver<'a>(
        &'a self,
        _: Provider,
        token: &'a str,
        e: Envelope,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            self.deliveries.lock().unwrap().push((token.into(), e));
            if self.stale {
                Outcome::Stale
            } else {
                Outcome::Accepted
            }
        })
    }
}
fn cap(c: char) -> String {
    c.to_string().repeat(64)
}
fn registration() -> Register {
    Register {
        invitation: cap('a'),
        queue: cap('b'),
        manage: cap('c'),
        send: cap('d'),
        provider: Provider::Apns,
        token: cap('e'),
        expires: 100 + LEASE,
    }
}
fn wake(n: u64) -> Wake {
    Wake {
        queue: cap('b'),
        send: cap('d'),
        sequence: n,
    }
}
fn rotate(g: u64, t: char) -> Rotate {
    Rotate {
        queue: cap('b'),
        manage: cap('c'),
        generation: g,
        token: cap(t),
    }
}
fn service(d: Arc<dyn Delivery>) -> Arc<Service> {
    Service::new(vec![cap('a')], SigningKey::from_bytes(&[8; 32]), d).unwrap()
}
#[tokio::test]
async fn real_queue_signs_only_contentless_device_bound_nonreplayed_wakes() {
    let d = Arc::new(Device::default());
    let s = service(d.clone());
    s.register(registration(), 100).await.unwrap();
    s.register(registration(), 101).await.unwrap(); // lost bootstrap reply
    s.wake(wake(1), 101).await.unwrap();
    s.dispatch(101).await;
    let deliveries = d.deliveries.lock().unwrap();
    let (_, e) = &deliveries[0];
    let key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    assert_eq!(e.verify(&key, &cap('b'), 1, 0, 101), Some(1));
    assert_eq!(e.verify(&key, &cap('b'), 1, 1, 101), None);
    assert_eq!(e.verify(&key, &cap('b'), 2, 0, 101), None);
    assert_eq!(e.verify(&key, &cap('a'), 1, 0, 101), None);
    assert_eq!(e.verify(&key, &cap('b'), 1, 0, 162), None);
    let mut forged = e.clone();
    forged.expires = "999".into();
    assert_eq!(forged.verify(&key, &cap('b'), 1, 0, 101), None);
    let mut forged = e.clone();
    forged.signature = cap('0');
    assert_eq!(forged.verify(&key, &cap('b'), 1, 0, 101), None);
    assert_eq!(
        serde_json::to_value(e).unwrap().as_object().unwrap().len(),
        5
    );
}
#[tokio::test]
async fn capabilities_rotation_revoke_expiry_and_provider_stale_are_enforced() {
    let d = Arc::new(Device::default());
    let s = service(d.clone());
    s.register(registration(), 100).await.unwrap();
    let mut bad = wake(1);
    bad.send = cap('c');
    assert_eq!(s.wake(bad, 101).await, Err(Error::Denied));
    s.wake(wake(1), 101).await.unwrap();
    assert_eq!(s.wake(wake(2), 101).await, Err(Error::Busy));
    s.rotate(rotate(2, 'f'), 102).await.unwrap();
    s.rotate(rotate(2, 'f'), 102).await.unwrap();
    assert_eq!(s.rotate(rotate(2, 'e'), 103).await, Err(Error::Denied));
    assert_eq!(s.rotate(rotate(1, 'e'), 103).await, Err(Error::Denied));
    s.dispatch(103).await;
    assert!(d.deliveries.lock().unwrap().is_empty()); // old queued token cancelled
    assert_eq!(s.wake(wake(1), 170).await, Err(Error::Denied));
    s.wake(wake(2), 170).await.unwrap();
    s.dispatch(170).await;
    assert_eq!(d.deliveries.lock().unwrap()[0].0, cap('f'));
    s.revoke(Revoke {
        queue: cap('b'),
        manage: cap('c'),
    })
    .await
    .unwrap();
    s.revoke(Revoke {
        queue: cap('b'),
        manage: cap('c'),
    })
    .await
    .unwrap();
    assert_eq!(s.wake(wake(3), 240).await, Err(Error::Denied));
    s.dispatch(240).await;
    assert_eq!(d.deliveries.lock().unwrap().len(), 1);
    let stale = Arc::new(Device {
        stale: true,
        ..Device::default()
    });
    let s = service(stale);
    s.register(registration(), 100).await.unwrap();
    s.wake(wake(1), 101).await.unwrap();
    s.dispatch(101).await;
    assert_eq!(s.wake(wake(2), 200).await, Err(Error::Denied));
    let s = service(Arc::new(Device::default()));
    s.register(registration(), 100).await.unwrap();
    assert_eq!(s.wake(wake(1), 100 + LEASE).await, Err(Error::Denied));
}
#[tokio::test]
async fn expired_pending_is_removed_without_external_io_and_invite_cannot_be_reused() {
    let d = Arc::new(Device::default());
    let s = service(d.clone());
    s.register(registration(), 100).await.unwrap();
    let mut another = registration();
    another.queue = cap('f');
    assert_eq!(s.register(another, 101).await, Err(Error::Denied));
    s.wake(wake(1), 101).await.unwrap();
    s.dispatch(162).await;
    assert!(d.deliveries.lock().unwrap().is_empty());
    s.wake(wake(2), 163).await.unwrap();
}
struct Blocking {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl Delivery for Blocking {
    fn configured(&self, _: Provider) -> bool {
        true
    }
    fn deliver<'a>(
        &'a self,
        _: Provider,
        _: &'a str,
        _: Envelope,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            self.started.notify_one();
            self.release.notified().await;
            Outcome::Accepted
        })
    }
}
#[tokio::test]
async fn revocation_waits_for_an_inflight_external_call_and_fences_all_later_sends() {
    let d = Arc::new(Blocking {
        started: Default::default(),
        release: Default::default(),
    });
    let s = service(d.clone());
    s.register(registration(), 100).await.unwrap();
    s.wake(wake(1), 101).await.unwrap();
    let dispatch = tokio::spawn({
        let s = s.clone();
        async move { s.dispatch(101).await }
    });
    d.started.notified().await;
    let revoke = tokio::spawn({
        let s = s.clone();
        async move {
            s.revoke(Revoke {
                queue: cap('b'),
                manage: cap('c'),
            })
            .await
        }
    });
    tokio::task::yield_now().await;
    assert!(!revoke.is_finished());
    d.release.notify_one();
    dispatch.await.unwrap();
    revoke.await.unwrap().unwrap();
    assert_eq!(s.wake(wake(2), 200).await, Err(Error::Denied));
}
fn http_registration() -> Register {
    let mut r = registration();
    r.expires = f2z_notify::now() + LEASE;
    r
}
#[tokio::test]
async fn http_registration_delivery_and_privacy_negative_controls() {
    let d = Arc::new(Device::default());
    let s = service(d.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(axum::serve(listener, f2z_notify::router(s.clone())).into_future());
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/notify/v1/register");
    for field in [
        "creatorId",
        "walletAddress",
        "viewingKey",
        "seed",
        "memo",
        "amount",
        "sender",
    ] {
        let mut body = serde_json::to_value(http_registration()).unwrap();
        body[field] = serde_json::json!("PRIVATE-CANARY");
        let response = client.post(&url).json(&body).send().await.unwrap();
        assert_eq!(response.status(), 422);
        assert!(!response.text().await.unwrap().contains("PRIVATE-CANARY"));
    }
    for header in ["Authorization", "Cookie"] {
        assert_eq!(
            client
                .post(&url)
                .header(header, "PRIVATE-CANARY")
                .json(&http_registration())
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    assert_eq!(
        client
            .post(format!("{url}?x=PRIVATE-CANARY"))
            .json(&http_registration())
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .post(&url)
            .body("PRIVATE-CANARY".repeat(2000))
            .send()
            .await
            .unwrap()
            .status(),
        415
    );
    assert!(d.deliveries.lock().unwrap().is_empty());
    assert_eq!(
        client
            .post(url)
            .json(&http_registration())
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        client
            .post(format!("http://{addr}/notify/v1/wake"))
            .json(&wake(1))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    s.dispatch(f2z_notify::now()).await;
    assert_eq!(d.deliveries.lock().unwrap().len(), 1);
    task.abort();
    let _ = task.await;
}
#[test]
fn api_client_and_mcp_unsupported_inventory_match_exactly() {
    let spec: serde_json::Value =
        serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    let unsupported: serde_json::Value =
        serde_json::from_str(include_str!("../api/unsupported.json")).unwrap();
    let examples = [
        ("Register", serde_json::to_value(registration()).unwrap()),
        ("Rotate", serde_json::to_value(rotate(2, 'f')).unwrap()),
        (
            "Revoke",
            serde_json::to_value(Revoke {
                queue: cap('b'),
                manage: cap('c'),
            })
            .unwrap(),
        ),
        ("Wake", serde_json::to_value(wake(1)).unwrap()),
    ];
    assert_eq!(spec["paths"].as_object().unwrap().len(), examples.len());
    assert_eq!(unsupported["mcp"]["supported"], serde_json::json!([]));
    assert_eq!(
        unsupported["mcp"]["unsupported"].as_array().unwrap().len(),
        examples.len()
    );
    for (name, example) in examples {
        let schema = &spec["components"]["schemas"][name];
        assert_eq!(schema["additionalProperties"], false);
        let mut fields: Vec<_> = example.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        let mut required: Vec<_> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect();
        required.sort();
        assert_eq!(fields, required);
        assert_eq!(
            schema["properties"].as_object().unwrap().len(),
            fields.len()
        );
        let path = format!("/notify/v1/{}", name.to_lowercase());
        assert_eq!(
            spec["paths"][&path]["post"]["operationId"],
            format!("notify{name}")
        );
        assert_eq!(spec["paths"][&path].as_object().unwrap().len(), 1);
        assert!(
            unsupported["mcp"]["unsupported"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["operationId"] == format!("notify{name}"))
        );
    }
}
#[tokio::test]
async fn global_exhaustion_and_duplicate_tokens_fail_before_provider_io() {
    let d = Arc::new(Device::default());
    let invitations = (1..=61).map(|n| format!("{n:064x}")).collect();
    let s = Service::new(invitations, SigningKey::from_bytes(&[8; 32]), d.clone()).unwrap();
    for n in 1..=61 {
        let mut r = Register {
            invitation: format!("{n:064x}"),
            queue: format!("{:064x}", n + 100),
            manage: format!("{:064x}", n + 200),
            send: format!("{:064x}", n + 300),
            provider: Provider::Apns,
            token: format!("{:064x}", n + 400),
            expires: 100 + LEASE,
        };
        if n == 2 {
            let correct = r.token.clone();
            r.token = format!("{:064x}", 401);
            assert_eq!(s.register(r, 100).await, Err(Error::Denied));
            r = Register {
                invitation: format!("{n:064x}"),
                queue: format!("{:064x}", n + 100),
                manage: format!("{:064x}", n + 200),
                send: format!("{:064x}", n + 300),
                provider: Provider::Apns,
                token: correct,
                expires: 100 + LEASE,
            };
        }
        s.register(r, 100).await.unwrap();
        let result = s
            .wake(
                Wake {
                    queue: format!("{:064x}", n + 100),
                    send: format!("{:064x}", n + 300),
                    sequence: 1,
                },
                101,
            )
            .await;
        assert_eq!(result, if n <= 60 { Ok(()) } else { Err(Error::Busy) });
    }
    assert!(d.deliveries.lock().unwrap().is_empty());
    for _ in 0..61 {
        s.dispatch(101).await;
    }
    assert_eq!(d.deliveries.lock().unwrap().len(), 60);
}
#[tokio::test]
async fn concurrent_identical_bootstrap_is_idempotent_and_does_not_extend_absolute_expiry() {
    let s = service(Arc::new(Device::default()));
    let a = tokio::spawn({
        let s = s.clone();
        async move { s.register(registration(), 100).await }
    });
    let b = tokio::spawn({
        let s = s.clone();
        async move { s.register(registration(), 101).await }
    });
    a.await.unwrap().unwrap();
    b.await.unwrap().unwrap();
    let mut extend = registration();
    extend.expires += 1;
    assert_eq!(s.register(extend, 102).await, Err(Error::Denied));
    assert_eq!(s.wake(wake(1), 100 + LEASE).await, Err(Error::Denied));
}
