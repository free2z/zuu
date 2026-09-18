//! The signed-in free2z session, held natively for the one caller that cannot
//! be handed one — [ADR 0017](../../../../docs/e2ee/decisions/0017-internal-directory-activation.md)
//! §4.1's follow-up, argued here on its own merits.
//!
//! # Why this exists at all
//!
//! ADR 0017 §4's enrollment takes the Knox token as an **argument** to
//! `f2zmsg_enroll`, uses it for one request and drops it, and §9 records that
//! as deliberate: "carrying the Knox token in Rust state would keep a
//! long-lived credential in a second place". That reasoning holds wherever a
//! caller can pass one, and `f2zmsg_enroll` can, because the WebView invokes
//! it.
//!
//! `issue-device-credential-v2` cannot. It arrives from the operating system
//! over a verified App Link, is handled entirely in Rust
//! ([`crate::intent`] is deliberately not a `#[tauri::command]`, #367), and
//! has to fetch a `HandleAssertion` with the user's free2z session before it
//! can publish the requesting device. There is no argument for the token to
//! ride on, and adding one would mean the *renderer* naming the session an
//! inbound intent is answered under — which is the confused deputy that whole
//! module exists to avoid.
//!
//! # What this is, exactly
//!
//! A **write-only slot**, in memory, for the process:
//!
//! - The WebView publishes the token it already holds
//!   (`src/lib/api/http.ts`'s `zuuli.knox.token`) whenever it changes, and once
//!   at startup — including publishing `null`, which is how "signed out" is
//!   stated rather than inferred from silence.
//! - Nothing reads it back over IPC. [`free2z_session_sync`] returns `()`, and
//!   `the_session_slot_is_write_only` asserts this module exposes no command
//!   that hands a token out.
//! - It is never persisted, never logged (both `Debug` impls redact), and is
//!   dropped with the process.
//!
//! # What it widens, and what bounds it
//!
//! The renderer already holds **the user's** token: it is the credential it
//! authenticates every free2z API call with. A compromised WebView can call the
//! backend directly, and can call `f2zmsg_enroll` with that token as an
//! argument — the residual risk `lib.rs` already records for the enrollment
//! trio.
//!
//! What writing this slot adds is different, and it is worth naming precisely:
//! the ability to state that the wallet's session is **somebody else's**. An
//! app-crate command is not capability-gated, so under `#367` anything that
//! reaches the invoke bridge can write it; ZUULI's CSP forbids frames
//! (`frame-src 'none'`), so that means an XSS in ZUULI's own origin rather than
//! a hostile embed.
//!
//! What bounds it is the publishing path rather than this module
//! ([ADR 0017](../../../../docs/e2ee/decisions/0017-internal-directory-activation.md)
//! §4.1), and the bound is the reason that path is ordered the way it is:
//!
//! - **Nothing about this wallet is disclosed before the confirmation.** The
//!   seed is not read and `identity_pk` is not sent anywhere. The one request
//!   made first — free2z naming the account this session belongs to — carries
//!   the session's own token and nothing else.
//! - **The confirmation names that account.** The handle the *authority* signs
//!   is established **after** the approval, and the publication is refused
//!   unless it is the handle the requesting app asked for.
//!
//! So a slot somebody else wrote costs a declined dialog: a request that is
//! declined or ignored leaks nothing about this wallet, and publishing under a
//! foreign account requires a human to approve a dialog naming it.

use std::sync::Mutex;
use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use tauri::{AppHandle, Manager as _, Runtime};

/// How long a native caller waits for the WebView's first publication.
///
/// An inbound App Link can reach `intent.rs` before the window has finished
/// loading on a cold start, and answering "you are not signed in" to a user who
/// is would be a lie the user cannot correct. Bounded, because a WebView that
/// never publishes must not hang an intent whose own window is minutes wide.
const FIRST_SYNC_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the wait re-checks. Short enough to be invisible next to a
/// WebView boot, long enough not to spin.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The process's one free2z session slot.
#[derive(Default)]
pub struct Free2zSession {
    slot: Mutex<Slot>,
}

#[derive(Default)]
struct Slot {
    /// Whether the WebView has said anything yet. A `None` token *before* the
    /// first publication is "not known"; after it, it is "signed out".
    published: bool,
    token: Option<SecretString>,
    /// Bumped on every publication. It is what the account cache is keyed by,
    /// so a session that changed can never be answered from a cache entry the
    /// old one filled — without keeping a second copy of the token to compare.
    generation: u64,
    account: Option<CachedAccount>,
}

/// What free2z last answered about this session, and when.
struct CachedAccount {
    generation: u64,
    name: String,
    at: std::time::Instant,
}

/// How long a resolved account name is reused.
///
/// This is the rate limit on the one authenticated request the publishing path
/// makes **before** a human has approved anything (ADR 0017 §4.1): a caller
/// that sends intents in a loop gets one `GET /api/auth/user/` a minute per
/// session rather than one per intent. Short enough that a sign-out that
/// somehow did not reach the slot cannot keep answering for long, and the
/// generation key means a *changed* session is never answered from it at all.
const ACCOUNT_CACHE_TTL: Duration = Duration::from_secs(60);

/// Hand-written: a derived `Debug` would print the slot's contents.
impl std::fmt::Debug for Free2zSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = match self.slot.lock() {
            Ok(slot) if !slot.published => "unpublished",
            Ok(slot) if slot.token.is_some() => "signed in",
            Ok(_) => "signed out",
            Err(_) => "poisoned",
        };
        f.debug_struct("Free2zSession")
            .field("state", &state)
            .finish()
    }
}

impl Free2zSession {
    /// Publish what the WebView holds. `None` means signed out.
    pub fn publish(&self, token: Option<String>) {
        if let Ok(mut slot) = self.slot.lock() {
            slot.published = true;
            slot.generation = slot.generation.saturating_add(1);
            slot.token = token
                .map(|token| token.trim().to_owned())
                .filter(|token| !token.is_empty())
                .map(SecretString::new);
            // Whatever free2z said about the previous session is about the
            // previous session.
            slot.account = None;
        }
    }

    /// The account free2z last named for **this** session, if that answer is
    /// still fresh.
    #[must_use]
    pub fn cached_account(&self, generation: u64) -> Option<String> {
        let slot = self.slot.lock().ok()?;
        let cached = slot.account.as_ref()?;
        (cached.generation == generation && cached.at.elapsed() < ACCOUNT_CACHE_TTL)
            .then(|| cached.name.clone())
    }

    /// Remember free2z's answer for this session.
    pub fn remember_account(&self, generation: u64, name: &str) {
        if let Ok(mut slot) = self.slot.lock() {
            if slot.generation == generation {
                slot.account = Some(CachedAccount {
                    generation,
                    name: name.to_owned(),
                    at: std::time::Instant::now(),
                });
            }
        }
    }

    /// The token, if the WebView has published one. `None` covers both "not
    /// published yet" and "signed out"; [`Free2zSession::token`] is the caller
    /// that tells them apart by waiting.
    #[cfg(test)]
    fn current(&self) -> Option<String> {
        let slot = self.slot.lock().ok()?;
        slot.token
            .as_ref()
            .map(|token| token.expose_secret().clone())
    }

    fn published(&self) -> bool {
        self.slot.lock().is_ok_and(|slot| slot.published)
    }

    /// The session for one native request, waiting up to
    /// [`FIRST_SYNC_TIMEOUT`] for the WebView's first publication.
    ///
    /// Returns `None` for a signed-out session and for a WebView that never
    /// answered — the caller cannot distinguish them, and neither can act on
    /// the difference: both mean this process cannot speak for a free2z
    /// account right now.
    /// The token **and** the generation it belongs to, so a caller can key a
    /// cache on the session rather than on the secret.
    pub async fn session(&self) -> Option<(u64, String)> {
        let deadline = std::time::Instant::now() + FIRST_SYNC_TIMEOUT;
        while !self.published() && std::time::Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        let slot = self.slot.lock().ok()?;
        let token = slot.token.as_ref()?.expose_secret().clone();
        Some((slot.generation, token))
    }
}

/// What the WebView publishes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionArgs {
    /// The Knox token, or `null` when signed out.
    #[serde(default)]
    pub token: Option<String>,
}

/// Hand-written so the token never reaches a log line.
impl std::fmt::Debug for SessionArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionArgs")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Publish the WebView's free2z session to the native slot.
///
/// Write-only: it answers `()`. See the module note for why the slot exists and
/// what it does not widen.
#[tauri::command]
pub fn free2z_session_sync<R: Runtime>(app: AppHandle<R>, args: SessionArgs) {
    app.state::<Free2zSession>().publish(args.token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_published_token_is_readable_only_in_process_and_never_rendered() {
        let session = Free2zSession::default();
        assert!(!session.published());
        assert_eq!(session.current(), None);
        assert!(format!("{session:?}").contains("unpublished"));

        session.publish(Some("knox-token".to_owned()));
        assert_eq!(session.current().as_deref(), Some("knox-token"));
        let rendered = format!("{session:?}");
        assert!(rendered.contains("signed in"));
        assert!(
            !rendered.contains("knox-token"),
            "a session must not render its token: {rendered}"
        );

        session.publish(None);
        assert!(session.published(), "signed out is a published state");
        assert_eq!(session.current(), None);
        assert!(format!("{session:?}").contains("signed out"));

        // Whitespace and emptiness are not sessions.
        session.publish(Some("   ".to_owned()));
        assert_eq!(session.current(), None);
    }

    /// The account cache is the rate limit on the one authenticated request
    /// the publishing path makes before anybody has approved anything, and it
    /// is keyed by the session rather than by the secret: a republished slot
    /// is a different session, and nothing free2z said about the old one may
    /// answer for it.
    #[test]
    fn a_resolved_account_is_reused_only_for_the_session_it_was_resolved_for() {
        let session = Free2zSession::default();
        session.publish(Some("knox-token".to_owned()));
        let (generation, _) = tauri::async_runtime::block_on(session.session()).unwrap();
        assert_eq!(session.cached_account(generation), None);

        session.remember_account(generation, "alice");
        assert_eq!(session.cached_account(generation).as_deref(), Some("alice"));
        assert_eq!(
            session.cached_account(generation + 1),
            None,
            "another session is not this one",
        );

        // A new publication is a new session, cache and all — including a
        // republication of the very same token.
        session.publish(Some("knox-token".to_owned()));
        let (next, _) = tauri::async_runtime::block_on(session.session()).unwrap();
        assert_ne!(next, generation);
        assert_eq!(session.cached_account(next), None);

        // An answer for a session that has already moved on is dropped rather
        // than written.
        session.remember_account(generation, "mallory");
        assert_eq!(session.cached_account(next), None);
    }

    #[test]
    fn the_arguments_carry_a_token_and_nothing_else_and_redact_it() {
        let args: SessionArgs =
            serde_json::from_str(r#"{"token":"knox-token"}"#).expect("the one argument");
        assert_eq!(args.token.as_deref(), Some("knox-token"));
        assert!(!format!("{args:?}").contains("knox-token"));
        let signed_out: SessionArgs = serde_json::from_str(r#"{"token":null}"#).expect("null");
        assert!(signed_out.token.is_none());
        assert!(
            serde_json::from_str::<SessionArgs>(r#"{"token":"t","handle":"alice"}"#).is_err(),
            "deny_unknown_fields must refuse an argument this command does not read",
        );
    }

    /// The slot is write-only, and that is what keeps it from widening what the
    /// renderer can read: a command here that answered with the token would
    /// turn the session into something any frame could exfiltrate (#367).
    #[test]
    fn the_session_slot_is_write_only() {
        let source = include_str!("session.rs");
        let production = source
            .split_once("\nmod tests {")
            .expect("this module keeps its tests in one place")
            .0;
        // Matched at the start of a line, so the module note's own mention of
        // `#[tauri::command]` is prose rather than a command.
        let commands: Vec<&str> = production
            .match_indices("\n#[tauri::command]\n")
            .map(|(at, _)| {
                production[at + 1..]
                    .lines()
                    .nth(1)
                    .expect("a command declaration follows its attribute")
            })
            .collect();
        assert_eq!(
            commands.len(),
            1,
            "one command, and it is the publisher: {commands:?}"
        );
        let publisher = commands[0];
        assert!(publisher.contains("free2z_session_sync"));
        assert!(
            !publisher.contains("->"),
            "the session command must return nothing: {publisher}"
        );
    }

    #[tokio::test]
    async fn a_reader_waits_for_the_first_publication_and_then_stops_waiting() {
        let session = std::sync::Arc::new(Free2zSession::default());
        let writer = std::sync::Arc::clone(&session);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            writer.publish(Some("late-token".to_owned()));
        });
        assert_eq!(
            session.session().await.map(|(_, token)| token).as_deref(),
            Some("late-token")
        );

        // Once published, a read is immediate.
        let started = std::time::Instant::now();
        assert_eq!(
            session.session().await.map(|(_, token)| token).as_deref(),
            Some("late-token")
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
