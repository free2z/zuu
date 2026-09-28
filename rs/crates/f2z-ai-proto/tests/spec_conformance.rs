//! The crate against the prose spec it implements, read from the repository.
//!
//! * `docs/free2z/sdk/spec/errors.md` §2–§4: every code's HTTP status and "Retry"
//!   column must be what [`ErrorCode::http_status`] and
//!   [`ErrorCode::retryable`] answer, and the tables and
//!   [`ErrorCode::ALL`] must list the same codes.
//! * `docs/free2z/sdk/spec/chat-api.md`: every SSE frame in it decodes, and every
//!   terminal one passes its settlement `check()`; the non-streamed response
//!   (§4) and the estimate (§6) decode.
//! * `docs/free2z/sdk/spec/purchase.md` §1.1: the balance decodes.
//!
//! These read files outside the crate, so they run in this repository and not
//! from a packaged `.crate` — which is where the spec lives anyway.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeSet;

use f2z_ai_proto::balance::Balance;
use f2z_ai_proto::chat::{ChatResponse, EstimateResponse};
use f2z_ai_proto::error::ErrorCode;
use f2z_ai_proto::event::Event;

fn spec(name: &str) -> String {
    let path = format!(
        "{}/../../../docs/free2z/sdk/spec/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// One row of an errors.md code table.
struct Row {
    status: String,
    code: String,
    retry: String,
}

/// The rows of every table in §2–§4 whose first two columns are a status and
/// a backticked code.
fn error_rows() -> Vec<Row> {
    let doc = spec("errors.md");
    let start = doc.find("\n## 2.").expect("errors.md §2 heading moved");
    let end = doc.find("\n## 5.").expect("errors.md §5 heading moved");
    let mut rows = Vec::new();
    for line in doc[start..end].lines() {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        // "| 401 | `invalid_token` | no | …" splits to ["", "401", "`invalid_token`", "no", …].
        // The header row is "| Status | `code` | Retry | …".
        if cells.len() < 5 || !cells[0].is_empty() || cells[1] == "Status" {
            continue;
        }
        let Some(code) = cells[2].strip_prefix('`').and_then(|c| c.strip_suffix('`')) else {
            continue;
        };
        rows.push(Row {
            status: cells[1].to_owned(),
            code: code.to_owned(),
            retry: cells[3].to_owned(),
        });
    }
    assert!(
        rows.len() >= 20,
        "parsed only {} rows from errors.md — the table format changed",
        rows.len()
    );
    rows
}

#[test]
fn every_documented_code_has_its_status_and_retryability() {
    let mut documented = BTreeSet::new();
    for row in error_rows() {
        if row.status == "(SDK-local)" {
            // `stream_interrupted`: never sent by the gateway, so not a code.
            let code: ErrorCode = serde_json::from_str(&format!("\"{}\"", row.code)).unwrap();
            assert_eq!(
                code,
                ErrorCode::Unknown,
                "{} is SDK-local and must not be in ErrorCode",
                row.code
            );
            continue;
        }
        let code: ErrorCode = serde_json::from_str(&format!("\"{}\"", row.code)).unwrap();
        assert_ne!(
            code,
            ErrorCode::Unknown,
            "errors.md documents `{}`, which the crate does not carry",
            row.code
        );
        assert_eq!(code.as_str(), row.code);

        let status = if row.status == "(stream)" {
            None
        } else {
            Some(
                row.status
                    .parse::<u16>()
                    .unwrap_or_else(|_| panic!("{}: status {:?}", row.code, row.status)),
            )
        };
        assert_eq!(code.http_status(), status, "{}: status", row.code);

        let retry = if row.retry.starts_with("yes") {
            true
        } else if row.retry.starts_with("no") {
            false
        } else {
            panic!("{}: unreadable Retry cell {:?}", row.code, row.retry)
        };
        assert_eq!(code.retryable(), retry, "{}: retryable", row.code);
        documented.insert(code.as_str());
    }
    let carried: BTreeSet<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(
        carried, documented,
        "ErrorCode::ALL and errors.md §2–§4 list different codes"
    );
}

#[test]
fn the_catalogue_parser_is_not_vacuous() {
    // Negative control for the parser: a code the tables certainly contain,
    // with the values they certainly give it.
    let rows = error_rows();
    let internal = rows.iter().find(|r| r.code == "internal").unwrap();
    assert_eq!(internal.status, "500");
    assert!(internal.retry.starts_with("yes"));
    assert!(
        rows.iter()
            .any(|r| r.code == "delivery_aborted" && r.status == "(stream)")
    );
}

/// Every `event: <name>` + `data: <json>` pair in a document.
fn sse_frames(doc: &str) -> Vec<(String, String)> {
    let mut frames = Vec::new();
    let mut name: Option<String> = None;
    for line in doc.lines() {
        if let Some(n) = line.strip_prefix("event: ") {
            name = Some(n.to_owned());
        } else if let Some(d) = line.strip_prefix("data: ")
            && let Some(n) = name.take()
        {
            frames.push((n, d.to_owned()));
        }
    }
    frames
}

#[test]
fn every_sse_frame_in_the_chat_spec_decodes_and_checks() {
    let frames = sse_frames(&spec("chat-api.md"));
    assert!(frames.len() >= 10, "found {} frames", frames.len());
    let mut terminal = 0;
    for (name, data) in &frames {
        let event = Event::from_sse(name, data).unwrap_or_else(|e| panic!("{name} {data}: {e}"));
        match &event {
            Event::Done(d) => {
                d.check().unwrap_or_else(|e| panic!("{data}: {e}"));
                terminal += 1;
            }
            Event::Error(e) => {
                e.check().unwrap_or_else(|err| panic!("{data}: {err}"));
                terminal += 1;
            }
            _ => {}
        }
        // Nothing in the spec's frames is lost on a round trip through the
        // crate: every member the spec shows is a member the crate carries.
        let reencoded: serde_json::Value =
            serde_json::from_str(&event.data_json().unwrap()).unwrap();
        let original: serde_json::Value = serde_json::from_str(data).unwrap();
        for key in original.as_object().unwrap().keys() {
            assert!(
                reencoded.get(key).is_some(),
                "{name}: the crate drops `{key}` from the spec's frame"
            );
        }
    }
    assert!(terminal >= 3, "found {terminal} terminal frames");
}

/// The first ```json block after `heading`.
fn json_block_after(doc: &str, heading: &str) -> serde_json::Value {
    let at = doc
        .find(heading)
        .unwrap_or_else(|| panic!("{heading} moved"));
    let rest = &doc[at..];
    let open = rest.find("```json\n").unwrap() + "```json\n".len();
    let close = rest[open..].find("\n```").unwrap();
    serde_json::from_str(&rest[open..open + close]).unwrap()
}

fn assert_nothing_dropped(original: &serde_json::Value, reencoded: &serde_json::Value, what: &str) {
    for key in original.as_object().unwrap().keys() {
        assert!(
            reencoded.get(key).is_some(),
            "{what}: the crate drops `{key}`"
        );
    }
}

#[test]
fn the_non_streamed_response_and_estimate_in_the_spec_decode() {
    let doc = spec("chat-api.md");

    let response = json_block_after(&doc, "## 4. Non-streamed response");
    let parsed: ChatResponse = serde_json::from_value(response.clone()).unwrap();
    parsed.check().unwrap();
    assert_nothing_dropped(
        &response,
        &serde_json::to_value(&parsed).unwrap(),
        "ChatResponse",
    );

    let estimate = json_block_after(&doc, "## 6. `POST /v1/chat/estimate`");
    let parsed: EstimateResponse = serde_json::from_value(estimate.clone()).unwrap();
    assert_nothing_dropped(
        &estimate,
        &serde_json::to_value(&parsed).unwrap(),
        "EstimateResponse",
    );
}

#[test]
fn the_balance_in_the_spec_decodes() {
    let doc = spec("purchase.md");
    let balance = json_block_after(&doc, "### 1.1 `GET /balance`");
    let parsed: Balance = serde_json::from_value(balance.clone()).unwrap();
    assert!(!parsed.in_debt());
    assert_eq!(serde_json::to_value(&parsed).unwrap(), balance);
}

/// The top-level `details` keys the errors.md tables with a `details` column
/// document, per code.
fn documented_details() -> Vec<(String, String)> {
    let doc = spec("errors.md");
    let mut out = Vec::new();
    let mut in_table = false;
    for line in doc.lines() {
        if !line.starts_with('|') {
            in_table = false;
            continue;
        }
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        if cells.contains(&"`details`") {
            in_table = true;
            continue;
        }
        if !in_table || cells.len() < 4 {
            continue;
        }
        let code = cells[2].trim_matches('`').to_owned();
        // The last real cell: "| … | `a`, `b` (`null` for `total`) |".
        let last = cells[cells.len() - 2];
        // Drop parentheticals, then: "`k` ∈ `v1`, `v2`" names only `k`.
        let mut cell = String::new();
        let mut depth = 0u32;
        for ch in last.chars() {
            match ch {
                '(' => depth += 1,
                ')' => depth = depth.saturating_sub(1),
                _ if depth == 0 => cell.push(ch),
                _ => {}
            }
        }
        let keys: Vec<&str> = if cell.contains('∈') {
            // Every segment but the last ends with a key; the last is values.
            let segments: Vec<&str> = cell.split('∈').collect();
            segments[..segments.len() - 1]
                .iter()
                .filter_map(|before| before.trim_end().rsplit('`').nth(1))
                .collect()
        } else {
            cell.split('`').skip(1).step_by(2).collect()
        };
        for key in keys {
            out.push((code.clone(), key.to_owned()));
        }
    }
    out
}

#[test]
fn every_pre_call_details_key_is_allowed_to_retry() {
    use f2z_ai_proto::error::PRE_CALL_DETAILS;
    let documented = documented_details();
    assert!(
        documented.len() >= 15,
        "parsed only {} details keys — the table format changed",
        documented.len()
    );
    for (code, key) in &documented {
        // `idempotency_conflict`'s `call_id` names a call that ran; it is
        // deliberately not a pre-call key (and the code is not retryable).
        if key == "call_id" {
            assert_eq!(code, "idempotency_conflict");
            continue;
        }
        assert!(
            PRE_CALL_DETAILS.contains(&key.as_str()),
            "errors.md documents details.{key} on `{code}`, missing from PRE_CALL_DETAILS"
        );
    }
    // Negative control on the parser.
    assert!(
        documented
            .iter()
            .any(|(c, k)| c == "cap_exceeded" && k == "resets_at")
    );
    assert!(
        !documented
            .iter()
            .any(|(_, k)| k == "total" || k == "missing")
    );
}
