//! Readiness is a verified, unexpired catalogue. The source is a trait.
//!
//! `docs/ai-gateway/README.md`: *the gateway prices nothing it did not read
//! from a signed catalogue … No verified, unexpired catalogue means the
//! process does not report ready.* This module holds that rule and the two
//! that come with it — a running gateway never replaces a catalogue with a
//! lower `version`, and a catalogue is checked against the clock every time it
//! is read, not only when it was fetched.
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
        if let Some(existing) = guard.as_ref() {
            let (have, offered) = (existing.catalog().version, candidate.catalog().version);
            if offered < have {
                return Installed::Older;
            }
            if offered == have {
                return Installed::Unchanged;
            }
        }
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
        match source.fetch().await {
            Ok(candidate) => {
                let version = candidate.catalog().version;
                match state.install(candidate, now_unix()) {
                    Installed::Replaced => {
                        tracing::info!(version, "verified catalogue installed");
                        metrics.set_catalog_version(version);
                    }
                    Installed::Unchanged => {}
                    Installed::Older => tracing::warn!(
                        version,
                        "refused a catalogue older than the one in use (replay?)"
                    ),
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
        let text = include_str!("../../f2z-ai-proto/fixtures/catalog/catalog.json");
        let mut c: Catalog = serde_json::from_str(text).unwrap();
        c.version = version;
        c.issued_at = 1;
        c.expires_at = expires_at;
        VerifiedCatalog::from_verified(c).unwrap()
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
