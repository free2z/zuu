//! [`ProviderBackend`]: the [`ChatBackend`] that starts a call on the
//! catalogue model's provider.
//!
//! `start` does no I/O. It resolves the model, picks the adapter by the
//! catalogue's `api_style`, translates the request and returns a
//! [`ProviderUpstream`] that has not sent anything yet: the provider request
//! goes out on the call's first read. So `start` can never outlive its
//! deadline (the call task's, `README.md` "the deadline for `start`"), a
//! provider failure arrives in the stream where chat-api.md §2.2 step 7 puts
//! it rather than as an HTTP error, and the provider's own deadlines are
//! enforced on the call's task by the upstream ([`super::upstream`]).
//!
//! It takes no hold and releases none: metering is the next layer, and the
//! settler is the single owner of a call's outcome.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::chat::ChatRequest;
use reqwest::{Client, Url};
use secrecy::SecretString;

use super::openai_chat::UsageConvention;
use super::resilience::{BreakerPolicy, CircuitBreaker, RetryBudget, RetryPolicy};
use super::upstream::{Prepared, ProviderUpstream};
use super::{client, for_style, output_cap, strict_model_ceiling};
use crate::admission::CallHandle;
use crate::call::Upstream;
use crate::catalog::VerifiedCatalog;
use crate::chat::ChatBackend;
use crate::config::{Config, ProviderConfig};
use crate::error::ApiFailure;

/// The provider deadlines that are not per model (chat-api.md §1). The
/// first-byte deadline is the catalogue model's `ttfb_timeout_ms`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timeouts {
    /// Connecting to the provider: 5 s.
    pub connect: Duration,
    /// Between two chunks of a stream: 60 s.
    pub idle: Duration,
    /// The whole call, from admission: 300 s.
    pub hard_limit: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: client::CONNECT_TIMEOUT,
            idle: Duration::from_secs(60),
            hard_limit: Duration::from_secs(300),
        }
    }
}

/// One configured provider account: its pooled client, its key, and its
/// retry budget and breaker.
pub struct ProviderHandle {
    /// The catalogue's name for it.
    pub name: String,
    pub(crate) client: Client,
    base_url: Url,
    key: SecretString,
    chat_usage: UsageConvention,
    pub(crate) breaker: Arc<CircuitBreaker>,
    pub(crate) budget: RetryBudget,
}

impl std::fmt::Debug for ProviderHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderHandle")
            .field("name", &self.name)
            .field("base_url", &self.base_url.as_str())
            .finish_non_exhaustive()
    }
}

impl ProviderHandle {
    /// Whether this provider's breaker is refusing calls now.
    #[must_use]
    pub fn circuit_open(&self) -> bool {
        self.breaker.is_open(Instant::now())
    }

    /// Retries this provider's budget holds now, in thousandths.
    #[must_use]
    pub fn retry_budget_milli(&self) -> u64 {
        self.budget.available_milli()
    }
}

/// The tuning a [`ProviderBackend`] runs with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tuning {
    /// Provider deadlines.
    pub timeouts: Timeouts,
    /// Per-call retries.
    pub retry: RetryPolicy,
    /// Per-provider breaker.
    pub breaker: BreakerPolicy,
    /// Per-provider retry budget: percent of primary attempts, and burst.
    pub budget_percent: u64,
    /// See [`Tuning::budget_percent`].
    pub budget_burst: u64,
}

impl Tuning {
    /// The v1 values.
    #[must_use]
    pub fn v1() -> Self {
        Self {
            budget_percent: 10,
            budget_burst: 20,
            ..Self::default()
        }
    }
}

/// Starts calls on the catalogue model's provider.
#[derive(Debug)]
pub struct ProviderBackend {
    providers: BTreeMap<String, Arc<ProviderHandle>>,
    tuning: Tuning,
}

impl ProviderBackend {
    /// Provider accounts configured in this process.
    pub fn configured_providers(&self) -> std::collections::BTreeSet<String> {
        self.providers.keys().cloned().collect()
    }

    /// A backend for `config.providers`, at the v1 tuning.
    ///
    /// # Errors
    ///
    /// A base URL or the TLS client could not be set up.
    pub fn from_config(config: &Config) -> Result<Self, String> {
        Self::new(&config.providers, Tuning::v1())
    }

    /// A backend for `providers` with `tuning`.
    ///
    /// # Errors
    ///
    /// A base URL or the TLS client could not be set up.
    pub fn new(
        providers: &BTreeMap<String, ProviderConfig>,
        tuning: Tuning,
    ) -> Result<Self, String> {
        let mut handles = BTreeMap::new();
        for (name, config) in providers {
            let handle = ProviderHandle {
                name: name.clone(),
                client: client::build_client(tuning.timeouts.connect)?,
                base_url: client::base_url(&config.base_url)?,
                key: config.api_key.clone(),
                chat_usage: if config.completion_tokens_include_reasoning {
                    UsageConvention::CompletionIncludesReasoning
                } else {
                    UsageConvention::CompletionExcludesReasoning
                },
                breaker: Arc::new(CircuitBreaker::new(tuning.breaker)),
                budget: RetryBudget::new(tuning.budget_percent, tuning.budget_burst),
            };
            handles.insert(name.clone(), Arc::new(handle));
        }
        Ok(Self {
            providers: handles,
            tuning,
        })
    }

    /// The handle for a provider, for inspection.
    #[must_use]
    pub fn provider(&self, name: &str) -> Option<&Arc<ProviderHandle>> {
        self.providers.get(name)
    }

    /// Prepare `request` on `catalog`'s model, for a call admitted at
    /// `admitted`. No I/O: the request is sent on the upstream's first read.
    ///
    /// # Errors
    ///
    /// `404 model_not_found`, `403 model_disabled` (not callable, or its
    /// provider is not configured on this gateway), `400 invalid_request`
    /// for a request the provider cannot express, `500 internal` for a
    /// provider key that is not a valid header.
    pub fn open(
        &self,
        request: &ChatRequest,
        catalog: &VerifiedCatalog,
        admitted: Instant,
    ) -> Result<ProviderUpstream, ApiFailure> {
        let catalog = catalog.catalog();
        let Some(model) = catalog.callable_model(&request.model) else {
            let exists = catalog.models.iter().any(|m| m.id == request.model);
            return Err(if exists {
                ApiFailure::new(ErrorCode::ModelDisabled, "the model is not callable")
            } else {
                ApiFailure::new(ErrorCode::ModelNotFound, "no such model")
            }
            .detail("model", request.model.as_str()));
        };
        let disabled = || {
            ApiFailure::new(
                ErrorCode::ModelDisabled,
                "the model's provider is not available on this gateway",
            )
            .detail("model", request.model.as_str())
        };
        let handle = self.providers.get(&model.provider).ok_or_else(disabled)?;
        let mut adapter = for_style(model.api_style, handle.chat_usage).ok_or_else(disabled)?;
        adapter.bind(request);
        strict_model_ceiling(request, model)?;
        let body = adapter.body(request, model, output_cap(request, model))?;
        let body = serde_json::to_vec(&body).map_err(|_| {
            ApiFailure::new(
                ErrorCode::Internal,
                "the provider request could not be encoded",
            )
        })?;
        let headers = client::checked_headers(adapter.as_ref(), &handle.key)?;
        let url = client::endpoint(&handle.base_url, adapter.path());
        let admitted = tokio::time::Instant::from_std(admitted);
        Ok(ProviderUpstream::new(Prepared {
            handle: Arc::clone(handle),
            adapter,
            url,
            headers,
            body: Bytes::from(body),
            ttfb: Duration::from_millis(model.ttfb_timeout_ms),
            // Per model: a model that reasons silently needs longer than the
            // default; the hard deadline bounds it regardless.
            idle: model
                .idle_timeout_ms
                .map_or(self.tuning.timeouts.idle, Duration::from_millis),
            hard_deadline: admitted
                .checked_add(self.tuning.timeouts.hard_limit)
                .unwrap_or(admitted),
            retry: self.tuning.retry,
            images: request
                .messages
                .iter()
                .flat_map(|m| &m.content)
                .filter(|p| matches!(p, f2z_ai_proto::chat::ContentPart::Image { .. }))
                .fold(0u64, |n, _| n.saturating_add(1)),
            tool_deltas: request.stream,
        }))
    }
}

#[async_trait]
impl ChatBackend for ProviderBackend {
    async fn start(
        &self,
        request: ChatRequest,
        catalog: Arc<VerifiedCatalog>,
        call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        Ok(Box::new(self.open(&request, &catalog, call.started())?))
    }
}
