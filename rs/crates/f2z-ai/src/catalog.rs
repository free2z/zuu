//! Readiness is a verified, unexpired catalogue. The source is a trait.
//!
//! `docs/ai-gateway/README.md`: *the gateway prices nothing it did not read
//! from a signed catalogue … No verified, unexpired catalogue means the
//! process does not report ready.* This module holds that rule and the two
//! that come with it — a running gateway does not replace a catalogue with a
//! lower `version` (with one bounded exception, below), and a catalogue is
//! checked against the clock every time it is read, not only when it was
//! fetched.
//!
//! # A lower version, legitimately (zuu#1067)
//!
//! The platform derives `version` from timestamps (tuzi #2235), so it can go
//! **down** for a minute or so — when the most recently updated model is
//! deleted, or across publisher pods whose clocks straddle a boundary. A
//! gateway that refused every lower version would stall on a stale copy. So
//! a lower version **is** installed when its `issued_at` is newer than the
//! held copy's and by no more than [`VERSION_REGRESSION_WINDOW_SECS`]. Every
//! other lower version is a replay: the held copy stays, the refusal is
//! logged and counted (`f2z_ai_catalog_replays_total`).
//!
//! Accepting a regression lowers the version the gateway holds, which would
//! let a replay of the superseded higher version back in by the ordinary
//! "higher wins" rule. It does not: a candidate whose version is not above
//! the highest ever installed, **and** whose `issued_at` is older than the
//! held copy's, is also a replay. Signature and expiry checks are unchanged
//! and happen before any of this.
//!
//! **The fetch-and-verify step is stubbed.** [`CatalogSource`] is the seam:
//! Wave 2 implements it by fetching the signed document and calling
//! `f2z_ai_proto::catalog::verify_catalog` against the trusted keys in the
//! config. The binary ships [`Unconfigured`], which never yields a catalogue,
//! so a deployed skeleton honestly reports **not ready** and `/v1/chat`
//! answers `503 catalog_unavailable`.

use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use f2z_ai_proto::catalog::Catalog;
use tokio::sync::watch;

use crate::metrics::Metrics;

/// A catalogue whose signature a [`CatalogSource`] has verified.
///
/// There is no way to obtain one from an unverified [`Catalog`] other than
/// [`VerifiedCatalog::from_verified`], which is the one line a reviewer of a
/// new source has to look at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCatalog(Catalog);

impl VerifiedCatalog {
    /// Wrap `catalog`, which the caller has verified.
    ///
    /// Runs [`Catalog::validate`] — a signature proves a catalogue authentic,
    /// not sane.
    ///
    /// # Errors
    ///
    /// The validation failure.
    pub fn from_verified(catalog: Catalog) -> Result<Self, String> {
        catalog.validate().map_err(|e| e.to_string())?;
        Ok(Self(catalog))
    }

    /// The catalogue.
    #[must_use]
    pub const fn catalog(&self) -> &Catalog {
        &self.0
    }
}

/// Where catalogues come from.
#[async_trait]
pub trait CatalogSource: Send + Sync + 'static {
    /// Fetch and verify the current catalogue.
    ///
    /// # Errors
    ///
    /// A human-readable reason, logged at `warn`. It must not contain a
    /// credential.
    async fn fetch(&self) -> Result<VerifiedCatalog, String>;
}

/// The binary's source in this build: none. See the module docs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Unconfigured;

#[async_trait]
impl CatalogSource for Unconfigured {
    async fn fetch(&self) -> Result<VerifiedCatalog, String> {
        Err("no catalogue source is configured in this build (zuu#1047 Wave 2)".to_owned())
    }
}

/// A fixed catalogue, for tests and local development. It performs no
/// verification of its own: whoever constructs the [`VerifiedCatalog`] did.
#[derive(Clone, Debug)]
pub struct Fixed(pub VerifiedCatalog);

#[async_trait]
impl CatalogSource for Fixed {
    async fn fetch(&self) -> Result<VerifiedCatalog, String> {
        Ok(self.0.clone())
    }
}

/// Unix seconds now. A clock that reads before 1970 reads as 0 — a broken
/// host clock, which the platform's node time sync is responsible for; the
/// verifying source (Wave 2) additionally refuses by `verify_catalog`'s own
/// expiry check.
#[must_use]
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// How much newer (`issued_at`, seconds) a lower-versioned catalogue may be
/// than the held one and still replace it (zuu#1067). The platform's own
/// regressions last about 60 s, about 5 minutes with clock skew.
pub const VERSION_REGRESSION_WINDOW_SECS: u64 = 600;

/// What [`State::install`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installed {
    /// It is now the catalogue in use.
    Replaced,
    /// Same version as the one in use; nothing changed.
    Unchanged,
    /// Lower version than the one in use: refused (a replay).
    Older,
    /// Already expired at `now`.
    Expired,
}

/// The catalogue in use.
#[derive(Debug, Default)]
pub struct State {
    current: RwLock<Option<Arc<VerifiedCatalog>>>,
    /// The highest version ever installed. Only ever rises.
    high_water: std::sync::atomic::AtomicU64,
}

impl State {
    /// The catalogue to price with at `now`, if one is loaded and unexpired.
    #[must_use]
    pub fn current(&self, now: u64) -> Option<Arc<VerifiedCatalog>> {
        let guard = self.current.read().unwrap_or_else(|p| p.into_inner());
        guard
            .as_ref()
            .filter(|c| now < c.catalog().expires_at)
            .map(Arc::clone)
    }

    /// Offer `candidate` at `now`.
    pub fn install(&self, candidate: VerifiedCatalog, now: u64) -> Installed {
        if now >= candidate.catalog().expires_at {
            return Installed::Expired;
        }
        let mut guard = self.current.write().unwrap_or_else(|p| p.into_inner());
        let high_water = self.high_water.load(std::sync::atomic::Ordering::SeqCst);
        if let Some(existing) = guard.as_ref() {
            let (held, offered) = (existing.catalog(), candidate.catalog());
            if offered.version == held.version {
                return Installed::Unchanged;
            }
            let newer_issue = offered.issued_at > held.issued_at;
            if offered.version < held.version {
                let within = offered.issued_at.saturating_sub(held.issued_at)
                    <= VERSION_REGRESSION_WINDOW_SECS;
                if !(newer_issue && within) {
                    return Installed::Older;
                }
                tracing::warn!(
                    held = held.version,
                    offered = offered.version,
                    "installing a lower catalogue version: its issued_at is newer and within the \
                     regression window (zuu#1067)"
                );
            } else if offered.version <= high_water && offered.issued_at < held.issued_at {
                // Higher than what is held only because a regression was
                // accepted, and older than what is held: the superseded copy.
                return Installed::Older;
            }
        }
        self.high_water.fetch_max(
            candidate.catalog().version,
            std::sync::atomic::Ordering::SeqCst,
        );
        *guard = Some(Arc::new(candidate));
        Installed::Replaced
    }
}

/// Poll `source` every `interval` until `stop`, installing what it returns.
pub(crate) async fn poll(
    source: Arc<dyn CatalogSource>,
    state: Arc<State>,
    metrics: Arc<Metrics>,
    interval: Duration,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        // A fetch is bounded by the poll interval and interrupted by shutdown:
        // a source that hangs must neither stop the refresh loop for good nor
        // hold the process at SIGTERM.
        let fetched = tokio::select! {
            fetched = tokio::time::timeout(interval, source.fetch()) => fetched
                .unwrap_or_else(|_| Err("catalogue fetch timed out".to_owned())),
            () = crate::shutdown::raised(&mut stop) => return,
        };
        match fetched {
            Ok(candidate) => {
                let version = candidate.catalog().version;
                match state.install(candidate, now_unix()) {
                    Installed::Replaced => {
                        tracing::info!(version, "verified catalogue installed");
                        metrics.set_catalog_version(version);
                    }
                    Installed::Unchanged => {}
                    Installed::Older => {
                        metrics.record_catalog_replay();
                        tracing::warn!(
                            version,
                            "refused a catalogue older than the one in use (replay?)"
                        );
                    }
                    Installed::Expired => {
                        tracing::warn!(version, "refused an expired catalogue");
                    }
                }
            }
            Err(reason) => tracing::warn!(%reason, "catalogue fetch failed"),
        }
        if state.current(now_unix()).is_none() {
            metrics.set_catalog_version(0);
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = crate::shutdown::raised(&mut stop) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(version: u64, expires_at: u64) -> VerifiedCatalog {
        issued(version, 1, expires_at)
    }

    fn issued(version: u64, issued_at: u64, expires_at: u64) -> VerifiedCatalog {
        let text = include_str!("../../f2z-ai-proto/fixtures/catalog/catalog.json");
        let mut c: Catalog = serde_json::from_str(text).unwrap();
        c.version = version;
        c.issued_at = issued_at;
        c.expires_at = expires_at;
        VerifiedCatalog::from_verified(c).unwrap()
    }

    #[test]
    fn a_lower_version_with_a_newer_issue_within_the_window_is_installed() {
        let state = State::default();
        let t = 1_000;
        assert_eq!(
            state.install(issued(50, t, t + 3600), t),
            Installed::Replaced
        );
        // The platform's regression: lower version, issued 60 s later.
        assert_eq!(
            state.install(issued(49, t + 60, t + 3600), t + 60),
            Installed::Replaced
        );
        assert_eq!(state.current(t + 60).unwrap().catalog().version, 49);
        // The superseded higher version, replayed: refused, though it is
        // "higher" than what is held now.
        assert_eq!(
            state.install(issued(50, t, t + 3600), t + 61),
            Installed::Older
        );
        // A genuinely newer one is installed as usual.
        assert_eq!(
            state.install(issued(51, t + 120, t + 3600), t + 120),
            Installed::Replaced
        );
    }

    #[test]
    fn a_lower_version_outside_the_window_or_not_newer_is_a_replay() {
        let state = State::default();
        let t = 1_000;
        assert_eq!(
            state.install(issued(50, t, t + 3600), t),
            Installed::Replaced
        );
        // Older issue: a replay.
        assert_eq!(
            state.install(issued(49, t - 1, t + 3600), t),
            Installed::Older
        );
        // Same issue instant: not newer.
        assert_eq!(state.install(issued(49, t, t + 3600), t), Installed::Older);
        // Newer, but beyond the window.
        let late = t + VERSION_REGRESSION_WINDOW_SECS + 1;
        assert_eq!(
            state.install(issued(49, late, late + 3600), late),
            Installed::Older
        );
        // The boundary itself is inside.
        let edge = t + VERSION_REGRESSION_WINDOW_SECS;
        assert_eq!(
            state.install(issued(49, edge, edge + 3600), edge),
            Installed::Replaced
        );
        assert_eq!(state.current(edge).unwrap().catalog().version, 49);
    }

    #[test]
    fn a_lower_version_never_replaces_a_higher_one() {
        let state = State::default();
        assert_eq!(state.install(catalog(5, 100), 10), Installed::Replaced);
        assert_eq!(state.install(catalog(4, 200), 10), Installed::Older);
        assert_eq!(state.install(catalog(5, 200), 10), Installed::Unchanged);
        assert_eq!(state.current(10).unwrap().catalog().version, 5);
        assert_eq!(state.install(catalog(6, 200), 10), Installed::Replaced);
        assert_eq!(state.current(10).unwrap().catalog().version, 6);
    }

    #[test]
    fn expiry_is_checked_on_every_read_not_only_at_install() {
        let state = State::default();
        assert_eq!(state.install(catalog(1, 100), 10), Installed::Replaced);
        assert!(state.current(99).is_some());
        assert!(state.current(100).is_none(), "expires_at is exclusive");
    }

    #[test]
    fn an_expired_catalogue_is_never_installed() {
        let state = State::default();
        assert_eq!(state.install(catalog(1, 100), 100), Installed::Expired);
        assert!(state.current(0).is_none());
    }

    #[test]
    fn an_insane_catalogue_is_refused_even_if_verified() {
        let text = include_str!("../../f2z-ai-proto/fixtures/catalog/catalog.json");
        let mut c: Catalog = serde_json::from_str(text).unwrap();
        c.expires_at = c.issued_at;
        assert!(VerifiedCatalog::from_verified(c).is_err());
    }
}
