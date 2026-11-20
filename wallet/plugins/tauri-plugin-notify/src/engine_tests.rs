use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
/// The exact native persisted JSON string record, re-decoded on every native
/// operation, including restart between stop and the next Rust operation.
pub(crate) struct Device {
    disk: Mutex<String>,
    token: Mutex<String>,
    permission: Mutex<String>,
    calls: Mutex<Vec<(String, Value)>>,
    offline: AtomicBool,
    fail_save: AtomicBool,
    start_failure: AtomicBool,
    crash_after_stop: AtomicBool,
}
impl Device {
    pub(crate) fn new() -> Self {
        Self {
            disk: Mutex::new("{}".into()),
            token: Mutex::new("e".repeat(64)),
            permission: Mutex::new("granted".into()),
            calls: Mutex::new(vec![]),
            offline: AtomicBool::new(false),
            fail_save: AtomicBool::new(false),
            start_failure: AtomicBool::new(false),
            crash_after_stop: AtomicBool::new(false),
        }
    }
    pub(crate) fn record(&self) -> Value {
        serde_json::from_str(&self.disk.lock().unwrap()).unwrap()
    }
    fn replace(&self, v: Value) {
        *self.disk.lock().unwrap() = v.to_string();
    }
    fn lease(&self) -> Lease {
        serde_json::from_str(self.record()["lease"].as_str().unwrap()).unwrap()
    }
    pub(crate) fn callback(&self, revision: &str, token: &str) -> bool {
        let mut v = self.record();
        let accepted = record::token(&mut v, revision, token, time());
        self.replace(v);
        accepted
    }
}
impl Port for Device {
    fn invoke(&self, command: &str, args: Value) -> Result<Value, &'static str> {
        let mut v = self.record();
        match command {
            "snapshot" | "start" => {
                if command == "start" {
                    if self.start_failure.load(Ordering::SeqCst) {
                        return Err("unavailable");
                    }
                    if let Some(token) =
                        Some(self.token.lock().unwrap().clone()).filter(|s| !s.is_empty())
                    {
                        record::token(&mut v, args["revision"].as_str().unwrap(), &token, time());
                        self.replace(v.clone());
                    }
                }
                return Ok(
                    json!({"permission":*self.permission.lock().unwrap(),"token":v["token"].as_str().unwrap_or(""),"enabled":v["enabled"]=="1","revision":v["revision"].as_str().unwrap_or("0"),"lease":v.get("lease"),"pending":v.get("pending")}),
                );
            }
            "begin" => record::begin(
                &mut v,
                args["revision"].as_str().unwrap(),
                args["lease"].as_str().unwrap(),
            )?,
            "save" => {
                if self.fail_save.load(Ordering::SeqCst) {
                    return Err("unavailable");
                }
                record::save(
                    &mut v,
                    args["revision"].as_str().unwrap(),
                    args["lease"].as_str().unwrap(),
                    time(),
                )?;
            }
            "stop" => {
                record::stop(&mut v)?;
                self.replace(v);
                if self.crash_after_stop.load(Ordering::SeqCst) {
                    return Err("unavailable");
                }
                return Ok(json!({}));
            }
            "clear" => record::clear(&mut v, args["revision"].as_str().unwrap())?,
            "resume" => {}
            "consume" => {
                if v["revision"] != args["revision"] {
                    return Err("unavailable");
                }
                if v["pending"] == args["pending"] {
                    v.as_object_mut().unwrap().remove("pending");
                }
            }
            _ => panic!("unexpected native operation {command}"),
        }
        self.replace(v);
        Ok(json!({}))
    }
    fn post<'a>(
        &'a self,
        _: &'a reqwest::Url,
        route: &'a str,
        value: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), &'static str>> + Send + 'a>>
    {
        self.calls.lock().unwrap().push((route.into(), value));
        Box::pin(async move {
            if self.offline.load(Ordering::SeqCst) {
                Err("offline")
            } else {
                Ok(())
            }
        })
    }
}
pub(crate) fn config() -> Result<(reqwest::Url, [u8; 32], &'static str), &'static str> {
    Ok((
        reqwest::Url::parse("https://notify.invalid/").unwrap(),
        SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes(),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ))
}
#[tokio::test]
async fn off_and_unconfigured_never_enroll_or_touch_provider() {
    let d = Device::new();
    assert_eq!(run(&d, "status").await.unwrap().state, "unconfigured");
    assert_eq!(
        http_post(
            &reqwest::Url::parse("https://notify.invalid/").unwrap(),
            "../send",
            &json!({})
        )
        .await,
        Err("unconfigured")
    );
    assert_eq!(execute(&d, "status", config()).await.unwrap().state, "off");
    assert!(d.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn delayed_first_token_finishes_on_reconcile_and_restart_without_new_consent() {
    let d = Device::new();
    *d.token.lock().unwrap() = String::new();
    assert_eq!(
        execute(&d, "enable", config()).await.unwrap().state,
        "waiting-token"
    );
    let initial = d.lease();
    assert!(!initial.registered);
    assert_eq!(initial.token, "");
    // Construct a new runtime from only what the native secure store persisted.
    let restarted = Device::new();
    restarted.replace(d.record());
    assert!(restarted.callback(&initial.consent, &"f".repeat(64)));
    assert_eq!(
        execute(&restarted, "reconcile", config())
            .await
            .unwrap()
            .state,
        "enabled"
    );
    assert_eq!(restarted.lease().expires, initial.expires);
    assert_eq!(restarted.lease().queue, initial.queue);
    assert_eq!(restarted.lease().token, "f".repeat(64));
}
#[tokio::test]
async fn failure_and_disable_cancel_delayed_callbacks_and_stale_save_after_restart() {
    let d = Device::new();
    d.start_failure.store(true, Ordering::SeqCst);
    assert_eq!(
        execute(&d, "enable", config()).await.err(),
        Some("unavailable")
    );
    let old = d.lease();
    d.crash_after_stop.store(true, Ordering::SeqCst);
    d.fail_save.store(true, Ordering::SeqCst);
    assert!(execute(&d, "disable", config()).await.is_err());
    let durable = d.record();
    assert_eq!(durable["enabled"], "0");
    assert!(
        serde_json::from_str::<Value>(durable["lease"].as_str().unwrap()).unwrap()["disabled"]
            == true
    );
    let restarted = Device::new();
    restarted.replace(durable);
    assert!(!restarted.callback(&old.consent, &"f".repeat(64)));
    assert!(save(&restarted, &old).is_err());
    assert_eq!(
        execute(&restarted, "reconcile", config())
            .await
            .unwrap()
            .state,
        "off"
    );
    assert_eq!(restarted.calls.lock().unwrap()[0].0, "revoke");
    assert!(restarted.record().get("lease").is_none());
    assert!(!restarted.callback(&old.consent, &"f".repeat(64)));
}
#[tokio::test]
async fn interrupted_old_native_representation_cannot_reenroll_from_a_lease_alone() {
    let d = Device::new();
    execute(&d, "enable", config()).await.unwrap();
    let mut v = d.record();
    v["enabled"] = json!("0");
    v.as_object_mut().unwrap().remove("token");
    d.replace(v);
    d.calls.lock().unwrap().clear();
    assert_eq!(execute(&d, "status", config()).await.unwrap().state, "off");
    assert_eq!(d.calls.lock().unwrap()[0].0, "revoke");
}
#[tokio::test]
async fn rotation_during_lost_register_reply_retries_original_then_rotates() {
    let d = Device::new();
    d.offline.store(true, Ordering::SeqCst);
    assert_eq!(execute(&d, "enable", config()).await.err(), Some("offline"));
    let original = d.lease();
    assert!(!original.registered);
    assert!(d.callback(&original.consent, &"f".repeat(64)));
    d.offline.store(false, Ordering::SeqCst);
    execute(&d, "reconcile", config()).await.unwrap();
    let calls = d.calls.lock().unwrap();
    assert_eq!(calls[0].1, calls[1].1);
    assert_eq!(calls[2].0, "rotate");
    assert_eq!(calls[2].1["generation"], 2);
    assert_eq!(calls[2].1["token"], "f".repeat(64));
    drop(calls);
    assert_eq!(d.lease().expires, original.expires);
}
#[tokio::test]
async fn rotation_ambiguity_retains_generation_and_absolute_expiry() {
    let d = Device::new();
    execute(&d, "enable", config()).await.unwrap();
    let initial = d.lease();
    d.callback(&initial.consent, &"f".repeat(64));
    d.offline.store(true, Ordering::SeqCst);
    assert!(execute(&d, "reconcile", config()).await.is_err());
    d.offline.store(false, Ordering::SeqCst);
    execute(&d, "reconcile", config()).await.unwrap();
    let c = d.calls.lock().unwrap();
    assert_eq!(c[1].1, c[2].1);
    assert_eq!(d.lease().expires, initial.expires);
}
#[tokio::test]
async fn revoked_permission_and_expiry_stop_without_register_or_send() {
    for expired in [false, true] {
        let d = Device::new();
        execute(&d, "enable", config()).await.unwrap();
        if expired {
            let mut l = d.lease();
            l.expires = time() - 1;
            let mut v = d.record();
            v["lease"] = json!(serde_json::to_string(&l).unwrap());
            d.replace(v);
        } else {
            *d.permission.lock().unwrap() = "denied".into();
        }
        d.calls.lock().unwrap().clear();
        assert_eq!(
            execute(&d, "test_wake", config()).await.unwrap().state,
            if expired { "expired" } else { "denied" }
        );
        assert!(d.calls.lock().unwrap().is_empty());
        assert_eq!(d.record()["enabled"], "0");
    }
}
#[tokio::test]
async fn signed_callbacks_are_generation_bound_replay_fenced_and_durable() {
    let d = Device::new();
    execute(&d, "enable", config()).await.unwrap();
    let l = d.lease();
    let mut e = Envelope {
        queue: l.queue,
        generation: "1".into(),
        sequence: "1".into(),
        expires: (time() + 60).to_string(),
        signature: String::new(),
    };
    e.signature = hex::encode(
        SigningKey::from_bytes(&[8; 32])
            .sign(e.message().as_bytes())
            .to_bytes(),
    );
    let mut v = d.record();
    v["pending"] = json!(serde_json::to_string(&e).unwrap());
    d.replace(v);
    assert!(execute(&d, "reconcile", config()).await.unwrap().wake);
    let mut v = d.record();
    v["pending"] = json!(serde_json::to_string(&e).unwrap());
    d.replace(v);
    assert!(!execute(&d, "reconcile", config()).await.unwrap().wake);
}
