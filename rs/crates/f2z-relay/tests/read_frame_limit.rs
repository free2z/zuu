//! READ pagination limits are exercised through the production relay socket.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::io;
use std::sync::{Arc, Mutex};

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{AppendRequest, QueuedMessage, ReadResponse};
use f2z_codec::frame::{FramePayload, RelayFrame, Response};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::types::Payload;
use f2z_relay::config::Config;
use f2z_relay::server::Server;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::client::{Client, ClientConfig};
use f2z_relay_testkit::transport::{Transport, TransportStream, WireMessage};
use f2z_relay_testkit::websocket;
use futures_util::future::BoxFuture;

const PADDING_BUCKET: usize = 512;
const MESSAGE_COUNT: usize = 5;

#[derive(Clone, Default)]
struct CapturedFrames(Arc<Mutex<Vec<Vec<u8>>>>);

impl CapturedFrames {
    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    fn after(&self, start: usize) -> Vec<Vec<u8>> {
        self.0.lock().unwrap()[start..].to_vec()
    }
}

struct RecordingStream {
    inner: Box<dyn TransportStream>,
    captured: CapturedFrames,
}

impl TransportStream for RecordingStream {
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>> {
        let recv = self.inner.recv();
        let captured = self.captured.clone();
        Box::pin(async move {
            let message = recv.await?;
            if let Some(bytes) = message.as_ref().and_then(WireMessage::binary) {
                captured.0.lock().unwrap().push(bytes.to_vec());
            }
            Ok(message)
        })
    }
}

fn encoded_read_frame(payloads: &[Vec<u8>], has_more: u8) -> Vec<u8> {
    let messages = payloads
        .iter()
        .enumerate()
        .map(|(index, payload)| QueuedMessage {
            index: u64::try_from(index).unwrap(),
            received_at_ms: 0,
            payload: Payload::new(payload.clone()).unwrap(),
        })
        .collect::<Vec<_>>();
    let body = ReadResponse {
        messages: messages.into(),
        has_more,
    }
    .encode_canonical()
    .unwrap();
    RelayFrame::response(7, Response::ok(body).unwrap())
        .encode_canonical()
        .unwrap()
}

fn capture_client_config() -> ClientConfig {
    let buckets = PaddingBuckets::new(vec![u32::try_from(PADDING_BUCKET).unwrap()]).unwrap();
    let mut config = ClientConfig::default();
    config.policy.emitted_padding = buckets.clone();
    config.padding = buckets;
    config
}

async fn connect(url: &str, captured: Option<CapturedFrames>) -> Client {
    let mut transport = websocket::connect(url).await.unwrap();
    if let Some(captured) = captured {
        transport = Transport::new(
            transport.sink,
            Box::new(RecordingStream {
                inner: transport.stream,
                captured,
            }),
        );
    }
    Client::connect(transport, capture_client_config())
        .await
        .unwrap()
}

async fn read_and_decode_frame(
    client: &mut Client,
    captured: &CapturedFrames,
    recv_key: &SigningKey,
    recv_addr: f2z_codec::types::QueueAddress,
    from_index: u64,
    max_bytes: u32,
    max_frame_bytes: usize,
) -> ReadResponse {
    let frame_start = captured.len();
    let client_result = client
        .read(recv_key, recv_addr, from_index, 0, max_bytes)
        .await
        .unwrap();
    let frames = captured.after(frame_start);
    assert_eq!(frames.len(), 1, "one READ must emit one response frame");
    let bytes = &frames[0];
    assert!(
        bytes.len() <= max_frame_bytes,
        "complete response frame exceeds cap"
    );

    let frame = decode_canonical::<RelayFrame>(bytes).unwrap().into_value();
    frame.validate().unwrap();
    let FramePayload::Response(response) = frame.payload else {
        panic!("READ response frame must carry a response");
    };
    assert!(response.is_ok());
    let decoded = decode_canonical::<ReadResponse>(response.body())
        .unwrap()
        .into_value();
    assert_eq!(
        decoded, client_result,
        "client and captured wire decode differ"
    );
    decoded
}

#[tokio::test(flavor = "multi_thread")]
async fn read_responses_obey_payload_and_complete_frame_limits_over_real_relay() {
    let payloads = (0..MESSAGE_COUNT)
        .map(|index| vec![0xa0 + u8::try_from(index).unwrap(); PADDING_BUCKET])
        .collect::<Vec<_>>();
    let two_message_frame_bytes = encoded_read_frame(&payloads[..2], 1).len();
    assert!(two_message_frame_bytes > 2 * PADDING_BUCKET);
    let frame_cap = u32::try_from(two_message_frame_bytes).unwrap();

    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.store.backend = "memory".to_owned();
    config.identity.seed = "5a".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.per_source_limits = false;
    config.commit.window_ms = 1;
    config.queues.expiry_tick_seconds = 3_600;
    config.padding.sizes = vec![u32::try_from(PADDING_BUCKET).unwrap()];
    config.limits.max_frame_bytes = frame_cap;
    let server = Server::start(config).await.unwrap();

    let captured = CapturedFrames::default();
    let mut reader = connect(&server.url(), Some(captured.clone())).await;
    let recv_key = SigningKey::from_seed(&[0x51; 32]);
    let queue = reader.create_queue(&recv_key, 0, 0, None).await.unwrap();

    let mut sender = connect(&server.url(), None).await;
    let send_key = SigningKey::from_seed(&[0x52; 32]);
    sender.bind_send(&send_key, queue.send_addr).await.unwrap();
    for payload in &payloads {
        sender
            .call_signed::<f2z_relay_proto::command::ops::Append>(
                &send_key,
                queue.send_addr,
                &AppendRequest {
                    payload: Payload::new(payload.clone()).unwrap(),
                },
            )
            .await
            .unwrap();
    }

    // `max_bytes` counts payload only: two 512-byte ciphertexts fit exactly,
    // even though their full response frame is larger than 1024 bytes.
    let positive = read_and_decode_frame(
        &mut reader,
        &captured,
        &recv_key,
        queue.recv_addr,
        0,
        1024,
        two_message_frame_bytes,
    )
    .await;
    assert_eq!(positive.messages.as_slice().len(), 2);
    assert_eq!(
        positive.messages.as_slice()[0].payload.as_slice(),
        payloads[0]
    );
    assert_eq!(
        positive.messages.as_slice()[1].payload.as_slice(),
        payloads[1]
    );
    assert_eq!(positive.has_more, 1);

    // The one-message progress rule applies to ciphertext bytes, not encoding
    // overhead: even a one-byte positive preference returns the first message.
    let too_small = read_and_decode_frame(
        &mut reader,
        &captured,
        &recv_key,
        queue.recv_addr,
        0,
        1,
        two_message_frame_bytes,
    )
    .await;
    assert_eq!(too_small.messages.as_slice().len(), 1);
    assert_eq!(
        too_small.messages.as_slice()[0].payload.as_slice(),
        payloads[0]
    );
    assert_eq!(too_small.has_more, 1);

    // Zero means no payload preference; the complete frame cap still holds.
    let zero = read_and_decode_frame(
        &mut reader,
        &captured,
        &recv_key,
        queue.recv_addr,
        0,
        0,
        two_message_frame_bytes,
    )
    .await;
    assert_eq!(zero.messages.as_slice().len(), 2);
    assert_eq!(zero.has_more, 1);

    // A 4 GiB preference must not inflate the response past the frame cap.
    let mut pages = Vec::new();
    let mut from_index = 0;
    loop {
        let page = read_and_decode_frame(
            &mut reader,
            &captured,
            &recv_key,
            queue.recv_addr,
            from_index,
            u32::MAX,
            two_message_frame_bytes,
        )
        .await;
        let more = page.has_more == 1;
        if let Some(last) = page.messages.as_slice().last() {
            from_index = last.index + 1;
        }
        pages.push(page);
        if !more {
            break;
        }
    }
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[0].messages.as_slice().len(), 2);
    assert_eq!(pages[1].messages.as_slice().len(), 2);
    assert_eq!(pages[2].messages.as_slice().len(), 1);
    assert_eq!(pages[0].has_more, 1);
    assert_eq!(pages[1].has_more, 1);
    assert_eq!(pages[2].has_more, 0, "the final page must clear has_more");

    let flattened = pages
        .iter()
        .flat_map(|page| page.messages.as_slice())
        .collect::<Vec<_>>();
    assert_eq!(flattened.len(), MESSAGE_COUNT);
    for (index, message) in flattened.iter().enumerate() {
        assert_eq!(message.index, u64::try_from(index).unwrap());
        assert_eq!(message.payload.as_slice(), payloads[index]);
    }

    // READ never mutates. Replaying the pages produces identical indices and
    // ciphertexts, proving frame truncation did not consume or reorder rows.
    let mut replayed = Vec::new();
    for expected in &pages {
        let start = expected
            .messages
            .as_slice()
            .first()
            .map_or(0, |message| message.index);
        let replay = read_and_decode_frame(
            &mut reader,
            &captured,
            &recv_key,
            queue.recv_addr,
            start,
            u32::MAX,
            two_message_frame_bytes,
        )
        .await;
        replayed.push(replay);
    }
    assert_eq!(replayed, pages);
    server.shutdown().await;
}
