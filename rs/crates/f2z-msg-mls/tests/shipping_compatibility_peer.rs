//! A process boundary between independently locked old/new shipping engines.
//! Run through scripts/check-mls-shipping-compatibility.sh; no shared Rust types,
//! provider instances or memory. Each step opens the actual durable SQLite store.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use f2z_msg_mls::MlsEngine;
use f2z_msg_store::SqliteBackend;
use openmls::prelude::{GroupId, MlsGroup};
use std::{env, fs, path::PathBuf};
mod common;
use common::{NOW, directory_entry, issue_credential};
const GROUP: &[u8] = b"shipping-compatibility";

#[test]
#[ignore = "requires two separately locked builds; use the shipping compatibility script"]
fn shipping_compatibility_peer() {
    let root = PathBuf::from(env::var_os("F2Z_MLS_COMPAT_DIR").expect("fixture directory"));
    let actor = env::var("F2Z_MLS_COMPAT_ACTOR").expect("actor");
    let step = env::var("F2Z_MLS_COMPAT_STEP").expect("step");
    let (account, device) = match actor.as_str() {
        "alice" => (11, 111),
        "bob" => (22, 222),
        _ => panic!("unknown actor"),
    };
    let (credential, signer) =
        issue_credential(&actor, account, device, NOW - 1_000_000, NOW + 1_000_000);
    let engine = MlsEngine::new(
        SqliteBackend::open(&root.join(format!("{actor}.sqlite"))).expect("store"),
        signer,
        credential,
        NOW,
    )
    .expect("engine");
    let read = |name: &str| fs::read(root.join(name)).expect("wire input");
    let write = |name: &str, wire: &[u8]| fs::write(root.join(name), wire).expect("wire output");
    match step.as_str() {
        "key-package" => write(
            "key-package",
            &engine.generate_key_package().expect("key package"),
        ),
        "add" => {
            let (bob, _) = issue_credential("bob", 22, 222, NOW - 1_000_000, NOW + 1_000_000);
            let entry = directory_entry(&[bob]);
            let kp = engine
                .verify_key_package(&read("key-package"), &entry, NOW)
                .expect("verified peer");
            let mut group = engine.create_group(GROUP).expect("group");
            let (_, welcome) = engine.add_member(&mut group, &kp, NOW).expect("add");
            write("welcome", &welcome);
        }
        "join" => {
            engine
                .join_from_welcome(&read("welcome"), NOW)
                .expect("join");
        }
        "update" => {
            let mut group = MlsGroup::load(engine.provider().store(), &GroupId::from_slice(GROUP))
                .expect("load")
                .expect("persisted group");
            write("commit", &engine.update(&mut group).expect("update"));
            write(
                "message",
                &engine
                    .send(&mut group, b"after shipping update")
                    .expect("send"),
            );
        }
        "receive" => {
            let mut group = MlsGroup::load(engine.provider().store(), &GroupId::from_slice(GROUP))
                .expect("load")
                .expect("persisted group");
            engine
                .receive(&mut group, &read("commit"), actor.as_bytes(), NOW)
                .expect("cross-version update path");
            assert_eq!(
                engine
                    .receive(
                        &mut group,
                        &read("message"),
                        format!("{actor}-message").as_bytes(),
                        NOW
                    )
                    .expect("cross-version message")
                    .payload(),
                Some(b"after shipping update".as_slice())
            );
        }
        _ => panic!("unknown step"),
    }
}
