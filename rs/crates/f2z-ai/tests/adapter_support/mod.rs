//! Shared harness for the provider-adapter tests: a catalogue with one model
//! per adapter, a [`ProviderBackend`] pointed at an `f2z-ai-testkit` mock,
//! and a driver that reads an upstream to its end the way the call task does.

#![allow(
    dead_code,
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use f2z_ai::call::Upstream as _;
use f2z_ai::catalog::{VerifiedCatalog, now_unix};
use f2z_ai::config::ProviderConfig;
use f2z_ai::provider::resilience::{BreakerPolicy, RetryPolicy};
use f2z_ai::provider::{ProviderBackend, ProviderOutcome, Timeouts, Tuning};
use f2z_ai_proto::Event;
use f2z_ai_proto::catalog::Catalog;
use f2z_ai_proto::chat::{ChatRequest, ToolCall, Usage};
use f2z_ai_testkit::mock::{ChatFlavor, ProviderStyle, Scenario};
use serde_json::json;

/// A catalogue model, and the mock style and chat flavour it is served in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub style: ProviderStyle,
    pub flavor: ChatFlavor,
}

/// OpenAI Responses, on provider `openai`.
pub const RESPONSES: Model = Model {
    id: "m-responses",
    style: ProviderStyle::OpenAiResponses,
    flavor: ChatFlavor::OpenAi,
};
/// Anthropic Messages, on provider `anthropic`.
pub const ANTHROPIC: Model = Model {
    id: "m-anthropic",
    style: ProviderStyle::AnthropicMessages,
    flavor: ChatFlavor::OpenAi,
};
/// Chat Completions with OpenAI's usage, on provider `chatco`.
pub const CHAT: Model = Model {
    id: "m-chat",
    style: ProviderStyle::ChatCompletions,
    flavor: ChatFlavor::OpenAi,
};
/// Chat Completions with xAI's usage, on provider `xai`.
pub const XAI: Model = Model {
    id: "m-xai",
    style: ProviderStyle::ChatCompletions,
    flavor: ChatFlavor::Xai,
};
/// xAI's usage served to a provider configured for OpenAI's: the usage
/// chunk's `total_tokens` must still decide.
pub const XAI_ON_CHAT: Model = Model {
    id: "m-chat",
    style: ProviderStyle::ChatCompletions,
    flavor: ChatFlavor::Xai,
};

pub const MODELS: [Model; 5] = [RESPONSES, ANTHROPIC, CHAT, XAI, XAI_ON_CHAT];

fn model_json(
    id: &str,
    provider: &str,
    style: &str,
    ttfb_ms: u64,
    idle_ms: Option<u64>,
) -> serde_json::Value {
    let mut m = json!({
        "id": id, "provider": provider, "provider_model_id": format!("{id}-upstream"),
        "api_style": style,
        "prices": {"input_nusd_per_mtok": 1000, "cached_input_nusd_per_mtok": 100,
                   "cache_write_nusd_per_mtok": 1250, "output_nusd_per_mtok": 4000,
                   "image_nusd": 0, "tool_call_nusd": 0},
        "min_charge_2z": 1, "safety_factor_bps": 10000, "context_window": 200000,
        "max_output_tokens": 8192, "ttfb_timeout_ms": ttfb_ms, "enabled": true,
    });
    if let Some(idle) = idle_ms {
        m["idle_timeout_ms"] = json!(idle);
    }
    m
}

/// The adapter catalogue: every model with `ttfb_ms` as its first-byte
/// deadline.
pub fn catalog(ttfb_ms: u64) -> VerifiedCatalog {
    catalog_with(ttfb_ms, None)
}

/// The adapter catalogue with a per-model idle timeout.
pub fn catalog_with(ttfb_ms: u64, idle_ms: Option<u64>) -> VerifiedCatalog {
    let now = now_unix();
    let catalog: Catalog = serde_json::from_value(json!({
        "schema": 1, "version": 1, "issued_at": now - 60, "expires_at": now + 3600,
        "rate_card_version": 1, "platform_margin_bps": 2000,
        "models": [
            model_json("m-responses", "openai", "openai_responses", ttfb_ms, idle_ms),
            model_json("m-anthropic", "anthropic", "anthropic_messages", ttfb_ms, idle_ms),
            model_json("m-chat", "chatco", "openai_chat", ttfb_ms, idle_ms),
            model_json("m-xai", "xai", "openai_chat", ttfb_ms, idle_ms),
            model_json("m-unconfigured", "nobody", "openai_chat", ttfb_ms, idle_ms),
        ],
    }))
    .unwrap();
    VerifiedCatalog::from_verified(catalog).unwrap()
}

/// Fast tuning for tests: millisecond backoffs, and `max_retries`.
pub fn tuning(max_retries: u32) -> Tuning {
    Tuning {
        timeouts: Timeouts {
            connect: Duration::from_secs(2),
            idle: Duration::from_secs(10),
            hard_limit: Duration::from_secs(60),
        },
        retry: RetryPolicy {
            max_retries,
            base_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(5),
            max_retry_after: Duration::from_secs(2),
        },
        breaker: BreakerPolicy {
            failure_threshold: 1_000,
            open_for: Duration::from_secs(10),
        },
        budget_percent: 10,
        budget_burst: 1_000,
    }
}

/// A backend with every provider at `base_url`.
pub fn backend(base_url: &str, tuning: Tuning) -> ProviderBackend {
    let mut providers = BTreeMap::new();
    for (name, include) in [
        ("openai", true),
        ("anthropic", true),
        ("chatco", true),
        ("xai", false),
    ] {
        providers.insert(
            name.to_owned(),
            ProviderConfig {
                base_url: base_url.to_owned(),
                api_key: format!("test-key-{name}").into(),
                completion_tokens_include_reasoning: include,
            },
        );
    }
    ProviderBackend::new(&providers, tuning).unwrap()
}

pub fn request(model: &str) -> ChatRequest {
    serde_json::from_value(json!({
        "model": model,
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": "Be brief."}]},
            {"role": "user", "content": [{"type": "text", "text": "Say something."}]},
        ],
        "max_output_tokens": 512,
    }))
    .unwrap()
}

/// What an upstream produced.
#[derive(Debug)]
pub struct Run {
    pub events: Vec<Event>,
    pub outcome: ProviderOutcome,
    pub elapsed: Duration,
}

impl Run {
    pub fn text(&self) -> String {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::Delta(d) => Some(d.text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn deltas(&self) -> usize {
        self.events
            .iter()
            .filter(|e| matches!(e, Event::Delta(_)))
            .count()
    }

    pub fn tool_calls(&self) -> Vec<ToolCall> {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::ToolCall(c) => Some(c.clone()),
                _ => None,
            })
            .collect()
    }

    /// The `usage` events, which must number at most one.
    pub fn usage_event(&self) -> Option<Usage> {
        let usages: Vec<Usage> = self
            .events
            .iter()
            .filter_map(|e| match e {
                Event::Usage(u) => Some(u.usage),
                _ => None,
            })
            .collect();
        assert!(usages.len() <= 1, "more than one usage event: {usages:?}");
        if !usages.is_empty() {
            assert!(
                matches!(self.events.last(), Some(Event::Usage(_))),
                "usage must be the last event"
            );
        }
        usages.first().copied()
    }
}

/// Open `request` and read the upstream to its end.
pub async fn drive(
    backend: &ProviderBackend,
    catalog: &VerifiedCatalog,
    request: &ChatRequest,
) -> Run {
    let started = Instant::now();
    let mut upstream = backend.open(request, catalog, started).unwrap();
    let mut events = Vec::new();
    while let Some(event) = upstream.next().await {
        events.push(event);
    }
    let outcome = upstream
        .outcome()
        .expect("an ended upstream has an outcome");
    Run {
        events,
        outcome,
        elapsed: started.elapsed(),
    }
}

/// The visible text the mock streams for `n` tokens.
pub fn mock_text(n: u64) -> String {
    const WORDS: [&str; 8] = [
        "The ", "quick ", "brown ", "fox ", "jumps ", "over ", "lazy ", "dogs. ",
    ];
    (0..n).map(|i| WORDS[(i % 8) as usize]).collect()
}

/// `scenario` in `model`'s chat flavour.
pub fn in_flavor(scenario: Scenario, model: Model) -> Scenario {
    scenario.with_chat_flavor(model.flavor)
}
