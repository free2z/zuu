//! The health-only listener: the one surface that may answer off the host.
//!
//! # What this file is actually testing
//!
//! `tests/admin.rs` asserts that `/healthz` and `/metrics` refuse a non-loopback
//! bind. That rule made the relay **undeployable**, and the discovery was
//! empirical rather than theoretical: the published image was run against the
//! Kubernetes manifest written for it and neither probe could pass. The kubelet
//! connects to the POD IP for an `httpGet`, and a Google Cloud load balancer
//! health-checks the pod IP directly when the Service is backed by a NEG, so a
//! loopback listener is unreachable to both by construction. The image is
//! distroless — no shell, no `wget`, no `curl` — so an `exec` probe has nothing
//! to call, and a `healthz` subcommand (the shape `f2z-kt` and `f2z-witness`
//! use) would answer the kubelet and do nothing at all for the load balancer.
//! The outcome would have been a pod reading `Ready` behind a 502.
//!
//! So there are now two surfaces, and the properties that matter are:
//!
//! 1. the health surface answers `/healthz` on a non-loopback address;
//! 2. it answers `/metrics` with **404**, so the loopback rule still protects
//!    the thing it was written to protect;
//! 3. `/healthz` is still the same constant with no digit in it;
//! 4. the operator surface is unchanged and still refuses to leave the host.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it through `lib.rs`. Relaxed here for the
// reason `rs/README.md` gives.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::time::Duration;

use f2z_relay::config::Config;
use f2z_relay::server::Server;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

async fn get(addr: std::net::SocketAddr, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("the health listener accepts");
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
        .await
        .expect("the request is written");
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    response
}

fn base() -> Config {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.address = "127.0.0.1:0".to_owned();
    config.store.backend = "memory".to_owned();
    config.identity.seed = "3c".repeat(32);
    config.antiabuse.per_source_limits = false;
    config.queues.expiry_tick_seconds = 3_600;
    config
}

#[tokio::test(flavor = "multi_thread")]
async fn the_health_listener_answers_healthz_on_a_non_loopback_address() {
    let mut config = base();
    // `0.0.0.0` is exactly what the Deployment sets, because that is the only
    // thing the kubelet and the load balancer can reach.
    config.health.enabled = true;
    config.health.address = "0.0.0.0:0".to_owned();
    config
        .check()
        .expect("a non-loopback health address is allowed");

    let server = Server::start(config).await.expect("the relay starts");
    let health = server.health_addr().expect("the health listener is bound");
    assert!(!health.ip().is_loopback(), "bound {health}, not off-host");

    // The kubelet's httpGet and the GCE health check are both this request.
    let response = get(health, "/healthz").await;
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).unwrap_or_default();
    assert_eq!(body, "ok\n");
    assert!(
        !body.chars().any(|c| c.is_ascii_digit()),
        "the health check reported a number"
    );
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_health_listener_does_not_serve_metrics() {
    // The point of the loopback rule is `/metrics`, and that protection is not
    // relaxed by any of this. 404 rather than 403: a 403 confirms the endpoint
    // is there and merely refused, which is one bit more than this listener
    // should say.
    let mut config = base();
    config.health.enabled = true;
    config.health.address = "127.0.0.1:0".to_owned();
    let server = Server::start(config).await.expect("the relay starts");
    let health = server.health_addr().expect("bound");
    assert!(get(health, "/metrics").await.starts_with("HTTP/1.1 404"));
    assert!(get(health, "/").await.starts_with("HTTP/1.1 404"));
    assert!(get(health, "/healthz").await.starts_with("HTTP/1.1 200"));

    // And the operator surface still has it.
    let admin = server.admin_addr().expect("bound");
    assert!(get(admin, "/metrics").await.starts_with("HTTP/1.1 200"));
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_health_listener_is_off_unless_asked_for() {
    let server = Server::start(base()).await.expect("the relay starts");
    assert!(server.health_addr().is_none());
    server.shutdown().await;
}

#[test]
fn the_admin_listener_is_still_refused_off_loopback() {
    // Nothing above relaxes the rule that matters. Restated here so a future
    // edit that "harmonises" the two listeners fails a test that says why.
    let mut config = base();
    config.admin.address = "0.0.0.0:0".to_owned();
    assert!(config.check().is_err());
}

#[test]
fn the_health_listener_may_not_shadow_another_listener() {
    // Both collisions change what a port serves without saying so, and the
    // second would put `/metrics` wherever `/healthz` is.
    let mut config = base();
    config.listen.address = "127.0.0.1:9944".to_owned();
    config.admin.address = "127.0.0.1:9101".to_owned();
    config.health.enabled = true;

    config.health.address = "127.0.0.1:9944".to_owned();
    assert!(config.check().is_err(), "shares the protocol listener");

    config.health.address = "127.0.0.1:9101".to_owned();
    assert!(config.check().is_err(), "shares the admin listener");

    config.health.address = "127.0.0.1:8081".to_owned();
    config.check().expect("a distinct address is fine");
}

#[test]
fn the_kubernetes_shape_is_valid_configuration() {
    // The exact configuration k8s/f2z-relay/deployment.yaml sets in the tuzi
    // repo, checked here so the two cannot drift silently: TLS is terminated by
    // the load balancer, the protocol listener is the NEG's serving port, and
    // the health listener is a second declared containerPort.
    let mut config = Config::default();
    config
        .apply_env([
            (
                "F2Z_RELAY_LISTEN_ADDRESS".to_owned(),
                "0.0.0.0:8080".to_owned(),
            ),
            ("F2Z_RELAY_LISTEN_INSECURE".to_owned(), "true".to_owned()),
            ("F2Z_RELAY_HEALTH_ENABLED".to_owned(), "true".to_owned()),
            (
                "F2Z_RELAY_HEALTH_ADDRESS".to_owned(),
                "0.0.0.0:8081".to_owned(),
            ),
            (
                "F2Z_RELAY_STORE_PATH".to_owned(),
                "/data/relay.sqlite".to_owned(),
            ),
            (
                "F2Z_RELAY_IDENTITY_PATH".to_owned(),
                "/data/identity.key".to_owned(),
            ),
        ])
        .expect("every variable names a real key");
    config.check().expect("the deployed configuration is valid");
    assert!(config.health.enabled);
    assert_eq!(config.health.address, "0.0.0.0:8081");
    assert_eq!(config.store.path, "/data/relay.sqlite");
}
