//! Usage parsing, the money-critical half of zuu#1064: every adapter against
//! the `f2z-ai-testkit` mock provider, over every [`Ending`], with and without
//! a usage report, with reasoning, prompt caching and Anthropic's cumulative
//! server-tool usage — asserting that the usage the adapter parsed **is**
//! `Scenario::expected_usage`, the testkit's statement of what a correct
//! adapter derives from the stream the mock actually sent.
//!
//! A missing report must be reported as missing (`UsageReport::Missing`),
//! never as a zero usage, and must not reach the client as a `usage` event.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;

use adapter_support::*;
use f2z_ai::provider::{Phase, UsageReport};
use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::chat::FinishReason;
use f2z_ai_testkit::mock::{AnthropicCumulative, Ending, MockProvider, ProviderStyle, Scenario};

/// The usage shapes, each on top of the default scenario (12 in, 16 out).
fn shapes() -> Vec<(&'static str, Scenario)> {
    vec![
        ("plain", Scenario::default()),
        (
            "reasoning",
            Scenario::default()
                .with_output_tokens(40)
                .with_reasoning_tokens(25),
        ),
        ("cache", {
            let mut s = Scenario::default().with_cache(300, 120);
            s.cache_write_1h_tokens = 50;
            s
        }),
        ("reasoning+cache", {
            let mut s = Scenario::default()
                .with_input_tokens(1_187)
                .with_output_tokens(342)
                .with_reasoning_tokens(100)
                .with_cache(64, 32);
            s.cache_write_1h_tokens = 32;
            s
        }),
        (
            "anthropic-cumulative",
            Scenario::default().with_anthropic_cumulative(AnthropicCumulative {
                server_tool_input_tokens: 8_003,
                server_tool_uses: 3,
                message_deltas: 3,
            }),
        ),
        (
            "all-reasoning-empty-answer",
            Scenario::default()
                .with_output_tokens(9)
                .with_reasoning_tokens(9),
        ),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parsed_usage_is_expected_usage_for_every_style_ending_and_shape() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(0));
    let catalog = catalog(10_000);
    let mut cases = 0;
    for model in MODELS {
        for (shape, base) in shapes() {
            for ending in [Ending::Complete, Ending::MaxOutputTokens, Ending::Failed] {
                for omit_usage in [false, true] {
                    let mut scenario = in_flavor(base.clone(), model).with_ending(ending);
                    scenario.omit_usage = omit_usage;
                    mock.set_scenario(scenario.clone());
                    let label = format!("{} {shape} {ending:?} omit_usage={omit_usage}", model.id);
                    let run = drive(&backend, &catalog, &request(model.id)).await;
                    check(&label, model, &scenario, &run);
                    cases += 1;
                }
            }
        }
    }
    assert_eq!(cases, 5 * 6 * 3 * 2);
    mock.shutdown().await;
}

fn check(label: &str, model: Model, scenario: &Scenario, run: &Run) {
    let expected = scenario.expected_usage(model.style, true);
    let outcome = &run.outcome;

    // The number that settles the call.
    assert_eq!(outcome.usage.reported(), expected, "{label}: parsed usage");
    if expected.is_none() {
        assert!(
            matches!(outcome.usage, UsageReport::Missing { .. }),
            "{label}: a missing report is Missing, never a zero usage"
        );
    }
    // What the client sees agrees with what the settler sees — except that
    // a failure before any content is a lone `error` (chat-api.md §3.1), so
    // its usage, if any, stays in the outcome.
    let lone_error = scenario.ending == Ending::Failed && scenario.visible_tokens() == 0;
    let expected_event = if lone_error { None } else { expected };
    assert_eq!(
        run.usage_event(),
        expected_event,
        "{label}: the usage event"
    );

    // Anthropic's TTL split is carried, not summed away.
    if model.style == ProviderStyle::AnthropicMessages && expected.is_some() {
        assert_eq!(
            outcome.cache_write_1h_tokens,
            scenario
                .cache_write_1h_tokens
                .min(scenario.cache_write_tokens),
            "{label}: 1h cache writes"
        );
    }

    // The text, whole and in order.
    let visible = scenario.visible_tokens();
    assert_eq!(run.text(), mock_text(visible), "{label}: text");
    assert_eq!(run.deltas() as u64, visible, "{label}: one delta per token");
    assert_eq!(outcome.attempts, 1, "{label}: attempts");

    match scenario.ending {
        Ending::Complete | Ending::MaxOutputTokens => {
            assert_eq!(outcome.failure, None, "{label}: failure");
            let want = if scenario.ending == Ending::Complete {
                FinishReason::Stop
            } else {
                FinishReason::Length
            };
            assert_eq!(outcome.finish_reason, Some(want), "{label}: finish reason");
        }
        Ending::Failed => {
            let failure = outcome.failure.as_ref().expect("a failed ending fails");
            assert_eq!(failure.code, ErrorCode::ProviderError, "{label}");
            assert_eq!(outcome.finish_reason, None, "{label}");
            let want_phase = if visible > 0 {
                Phase::AfterContent
            } else {
                // Nothing was produced: a pre-content failure, which the
                // retry rule may retry (none here: max_retries is 0).
                Phase::BeforeContent
            };
            assert_eq!(failure.phase, want_phase, "{label}: phase");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anthropic_input_counts_survive_a_missing_report_as_partial_only() {
    let mock = MockProvider::start(Scenario::default().with_cache(5, 7).without_usage())
        .await
        .unwrap();
    let backend = backend(&mock.base_url(), tuning(0));
    let run = drive(&backend, &catalog(10_000), &request(ANTHROPIC.id)).await;
    match run.outcome.usage {
        UsageReport::Missing {
            partial: Some(partial),
        } => {
            assert_eq!(
                (
                    partial.input_tokens,
                    partial.cached_input_tokens,
                    partial.cache_write_tokens
                ),
                (12, 5, 7)
            );
            assert_eq!(
                partial.output_tokens, 0,
                "message_start's placeholder output is not a count"
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(run.usage_event(), None);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_outputs_parse_exactly() {
    // A long stream: many chunk boundaries fall inside frames.
    let scenario = Scenario::default()
        .with_input_tokens(90_000)
        .with_output_tokens(5_000)
        .with_reasoning_tokens(1_234)
        .with_cache(10_000, 2_000);
    let mock = MockProvider::start(scenario.clone()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(0));
    let catalog = catalog(10_000);
    for model in MODELS {
        let scenario = in_flavor(scenario.clone(), model);
        mock.set_scenario(scenario.clone());
        let run = drive(&backend, &catalog, &request(model.id)).await;
        assert_eq!(
            run.outcome.usage.reported(),
            scenario.expected_usage(model.style, true),
            "{}",
            model.id
        );
        assert_eq!(
            run.text(),
            mock_text(scenario.visible_tokens()),
            "{}",
            model.id
        );
    }
    mock.shutdown().await;
}
