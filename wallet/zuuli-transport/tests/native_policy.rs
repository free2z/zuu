//! Real TCP/SOCKS/HTTP2 fixtures exercising the production tonic connector.
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tower::ServiceExt;
use zuuli_transport::Policy;

async fn rpc(channel: tonic::transport::Channel) -> bool {
    let request = http::Request::builder()
        .uri("http://wallet.fixture.test/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock")
        .header("content-type", "application/grpc")
        .body(tonic::body::Body::default())
        .unwrap();
    matches!(tokio::time::timeout(Duration::from_secs(2), channel.oneshot(request)).await, Ok(Ok(r)) if r.status() == 200)
}
async fn mode(policy: &Policy, enabled: bool, suspended: bool) {
    let guard = policy.transition().await;
    policy.set(&guard, enabled, suspended);
}

#[tokio::test]
async fn production_channel_remote_dns_no_fallback_revocation_and_lifecycle() {
    let requests = Arc::new(AtomicUsize::new(0));
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_addr = server.local_addr().unwrap();
    let count = requests.clone();
    let http_task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            let (socket, _) = server.accept().await.unwrap();
            let count = count.clone();
            children.spawn(async move {
                let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                    .serve_connection(
                        TokioIo::new(socket),
                        hyper::service::service_fn(move |_| {
                            count.fetch_add(1, Ordering::SeqCst);
                            async {
                                Ok::<_, std::convert::Infallible>(
                                    http::Response::builder()
                                        .header("grpc-status", "0")
                                        .body(http_body_util::Full::new(bytes::Bytes::from_static(
                                            b"fixture",
                                        )))
                                        .unwrap(),
                                )
                            }
                        }),
                    )
                    .await;
            });
        }
    });
    let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let direct_port = direct.local_addr().unwrap().port();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let socks_count = Arc::new(AtomicUsize::new(0));
    let count = socks_count.clone();
    let proxy_task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            let (mut socket, _) = proxy.accept().await.unwrap();
            let count = count.clone();
            children.spawn(async move {
                let mut greeting = [0; 3];
                socket.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [5, 1, 0]);
                socket.write_all(&[5, 0]).await.unwrap();
                let mut command = [0; 5];
                socket.read_exact(&mut command).await.unwrap();
                assert_eq!(
                    &command[..4],
                    &[5, 1, 0, 3],
                    "SOCKS must contain a hostname, never a locally resolved IP"
                );
                let mut host = vec![0; command[4] as usize];
                socket.read_exact(&mut host).await.unwrap();
                assert_eq!(host, b"wallet.fixture.test");
                assert_eq!(socket.read_u16().await.unwrap(), direct_port);
                count.fetch_add(1, Ordering::SeqCst);
                // Fixture resolves remotely by mapping the requested host to a
                // separate backend. It never connects to the bypass listener.
                let mut backend = TcpStream::connect(server_addr).await.unwrap();
                socket
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut backend).await;
            });
        }
    });
    let policy = Arc::new(Policy::new(proxy_addr));
    mode(&policy, true, false).await;
    let url = format!("http://wallet.fixture.test:{direct_port}");
    let old = policy.channel(&url).await.unwrap();
    assert!(
        rpc(old.clone()).await,
        "a working protected path, not a blocking-only setting"
    );
    assert_eq!(socks_count.load(Ordering::SeqCst), 1);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(policy.direct().await.is_err());
    assert!(policy.direct_now().is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), direct.accept())
            .await
            .is_err(),
        "no destination TCP bypass"
    );
    // Background / network switch revokes existing stream before acknowledgement.
    policy.suspend();
    assert!(!rpc(old.clone()).await);
    assert!(policy.channel(&url).await.is_err());
    mode(&policy, true, false).await;
    assert!(
        !rpc(old.clone()).await,
        "old channel cannot adopt resumed epoch"
    );
    assert!(rpc(policy.channel(&url).await.unwrap()).await);
    mode(&policy, false, false).await;
    let direct_channel = policy
        .channel(&format!("http://{server_addr}"))
        .await
        .unwrap();
    assert!(
        rpc(direct_channel.clone()).await,
        "direct mode negative control"
    );
    mode(&policy, true, false).await;
    assert!(
        !rpc(direct_channel).await,
        "existing clearnet channel revoked"
    );
    assert!(
        !rpc(old).await,
        "enable-disable-enable does not resurrect channels"
    );
    // Unavailable proxy: even a reachable destination cannot cause fallback.
    proxy_task.abort();
    proxy_task.await.unwrap_err();
    let before = requests.load(Ordering::SeqCst);
    assert!(
        policy
            .channel(&format!("http://{server_addr}"))
            .await
            .is_err()
    );
    assert_eq!(requests.load(Ordering::SeqCst), before);
    assert_eq!(policy.status().state, "degraded");
    http_task.abort();
    http_task.await.unwrap_err();
}

#[tokio::test]
async fn transition_drains_operations_and_rejects_connections_captured_before_transition() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policy = Arc::new(Policy::default());
    let lease = policy.direct().await.unwrap();
    let pending_policy = policy.clone();
    let transition = tokio::spawn(async move { mode(&pending_policy, true, false).await });
    tokio::task::yield_now().await;
    assert!(
        !transition.is_finished(),
        "cannot acknowledge on while direct work owns a lease"
    );
    let pending_policy = policy.clone();
    let addr = listener.local_addr().unwrap();
    let connect =
        tokio::spawn(async move { pending_policy.channel(&format!("http://{addr}")).await });
    tokio::task::yield_now().await;
    drop(lease);
    transition.await.unwrap();
    assert!(
        connect.await.unwrap().is_err(),
        "captured direct epoch cannot connect after on"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

/// Run only in scripts/tor-leak-fixture.sh's isolated network/mount namespace.
#[tokio::test]
#[ignore = "requires isolated network and resolver; run scripts/tor-leak-fixture.sh"]
async fn isolated_live_dns_negative_control() {
    if std::env::var_os("ZUULI_ISOLATED_DNS_FIXTURE").is_none() {
        return;
    }
    let dns = tokio::net::UdpSocket::bind("127.0.0.1:53").await.unwrap();
    let queries = Arc::new(AtomicUsize::new(0));
    let count = queries.clone();
    let task = tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let (n, addr) = dns.recv_from(&mut buf).await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            let mut end = 12;
            while buf[end] != 0 {
                end += 1 + buf[end] as usize;
            }
            end += 5;
            let ipv4 = buf[end - 4..end - 2] == [0, 1];
            let mut answer = buf[..end].to_vec();
            answer[2] = 0x81;
            answer[3] = 0x80;
            answer[6..8].copy_from_slice(&(u16::from(ipv4)).to_be_bytes());
            if ipv4 {
                answer.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1]);
            }
            dns.send_to(&answer, addr).await.unwrap();
            assert!(n >= end);
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let policy = Arc::new(Policy::new(proxy_addr));
    mode(&policy, true, false).await;
    let fixture = tokio::spawn(async move {
        let (mut socket, _) = proxy.accept().await.unwrap();
        let mut greeting = [0; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        socket.write_all(&[5, 0]).await.unwrap();
        let mut command = [0; 5];
        socket.read_exact(&mut command).await.unwrap();
        assert_eq!(command[3], 3);
        let mut host = vec![0; command[4] as usize];
        socket.read_exact(&mut host).await.unwrap();
        assert_eq!(host, b"dns-control.fixture.test");
        socket
            .write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap(); // Explicit refusal.
    });
    assert!(
        policy
            .channel(&format!("http://dns-control.fixture.test:{}", addr.port()))
            .await
            .is_err()
    );
    fixture.await.unwrap();
    assert_eq!(
        queries.load(Ordering::SeqCst),
        0,
        "enabled requests must never query the live local DNS fixture"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    // Same hostname resolves and reaches the destination with direct mode:
    // both counters are live, rather than unobserved/dummy zeroes.
    mode(&policy, false, false).await;
    let connect = tokio::spawn(async move {
        policy
            .channel(&format!("http://dns-control.fixture.test:{}", addr.port()))
            .await
    });
    let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert!(
        queries.load(Ordering::SeqCst) > 0,
        "negative control must hit local DNS"
    );
    eprintln!(
        "Tor-mode DNS=0 TCP=0; direct negative control DNS={} TCP=1",
        queries.load(Ordering::SeqCst)
    );
    drop(socket);
    connect.abort();
    let _ = connect.await;
    task.abort();
    let _ = task.await;
}

#[tokio::test]
#[ignore = "explicit public benign read probe; requires owned Tor on 19050"]
async fn public_tor_tls_read_probe() {
    let policy = Arc::new(Policy::new("127.0.0.1:19050".parse().unwrap()));
    mode(&policy, true, false).await;
    let channel = policy
        .channel("https://zec.rocks:443")
        .await
        .expect("TLS/HTTP2 through Tor");
    let request = http::Request::builder()
        .method("POST")
        .uri("https://zec.rocks/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo")
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .body(tonic::body::Body::new(http_body_util::Full::new(
            bytes::Bytes::from_static(&[0, 0, 0, 0, 0]),
        )))
        .unwrap();
    let response = channel.oneshot(request).await.unwrap();
    assert_eq!(response.status(), 200);
    use http_body_util::BodyExt;
    let body = response.into_body().collect().await.unwrap();
    assert_eq!(body.trailers().unwrap().get("grpc-status").unwrap(), "0");
    assert!(!body.to_bytes().is_empty());
    eprintln!(
        "GetLightdInfo: HTTPS + HTTP2 + gRPC status 0 through owned Tor 0.4.9.11 (SafeSocks=1); no wallet loaded, no transaction sent"
    );
}

#[tokio::test]
async fn cancelled_blocking_work_keeps_transition_lease_until_real_completion() {
    let (release, wait) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        zuuli_transport::spawn_blocking_direct(move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
        })
        .await
    });
    ready.await.unwrap();
    worker.abort();
    let _ = worker.await;
    let transition = tokio::spawn(async {
        let guard = zuuli_transport::global().transition().await;
        zuuli_transport::global().set(&guard, true, false);
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !transition.is_finished(),
        "cancelled waiter must not release a live resolver/directory worker"
    );
    release.send(()).unwrap();
    transition.await.unwrap();
    mode(zuuli_transport::global(), false, false).await;
}

#[tokio::test]
async fn stalled_proxy_times_out_without_a_reachable_direct_fallback() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policy = Arc::new(Policy::new(proxy.local_addr().unwrap()));
    mode(&policy, true, false).await;
    let proxy_task = tokio::spawn(async move {
        let (mut socket, _) = proxy.accept().await.unwrap();
        let mut greeting = [0; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 0]);
        // Never finish negotiation: simulates bootstrap/lost proxy readiness.
        std::future::pending::<()>().await;
    });
    assert!(
        policy
            .channel(&format!("http://{}", destination.local_addr().unwrap()))
            .await
            .is_err()
    );
    assert_eq!(policy.status().state, "degraded");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), destination.accept())
            .await
            .is_err()
    );
    proxy_task.abort();
    let _ = proxy_task.await;
}

#[tokio::test]
async fn background_event_captured_during_transition_cannot_be_overwritten_by_ack() {
    let policy = Policy::default();
    let requested = policy.suspend();
    let guard = policy.transition().await;
    policy.suspend(); // Native pause/resume/network event while settings drain.
    assert!(policy.finish_transition(&guard, true, requested).is_err());
    assert!(policy.status().suspended);
    assert!(policy.direct_now().is_err());
    drop(guard);
    let requested = policy.suspend();
    let guard = policy.transition().await;
    let result = policy.finish_transition(&guard, true, requested).unwrap();
    assert!(result.enabled);
    assert!(!result.suspended);
}
