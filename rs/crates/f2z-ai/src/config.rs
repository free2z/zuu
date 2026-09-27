//! Configuration: a TOML file, then `F2Z_AI_*` environment overrides.
//!
//! ```toml
//! listen = "0.0.0.0:8080"          # public: /v1/*
//! admin_listen = "0.0.0.0:9090"    # /healthz /readyz /metrics — not routed publicly
//! max_concurrent_calls = 10000
//! drain_timeout_secs = 300
//! otlp_endpoint = "http://otel-collector:4318"   # omit: OpenTelemetry off
//! otlp_authorization_file = "/var/run/secrets/otlp-authorization"
//! ```
//!
//! Every key is optional and has the default in [`Config::default`]. Every
//! key can be set from the environment as `F2Z_AI_<KEY>` (upper case), which
//! wins over the file. Strictness is the same as the rest of `rs/`: an unknown
//! key in the file, or an unknown `F2Z_AI_*` variable, is a startup error — a
//! misspelt `F2Z_AI_DRAIN_TIMOUT_SECS` that silently kept the default would
//! cut every stream on the next deploy.
//!
//! # Secrets
//!
//! A secret is a [`SecretString`]: its `Debug` renders `[REDACTED]`, so the
//! [`Config`] can be logged. A secret is accepted **only** from the
//! environment (`F2Z_AI_OTLP_AUTHORIZATION`) or from a file the config names
//! (`otlp_authorization_file`), never as an inline value in the config file,
//! which ends up in a ConfigMap, a repository or a support ticket.
//!
//! # Providers
//!
//! ```toml
//! [providers.anthropic]                       # the catalogue's `provider` name
//! api_key_file = "/var/run/secrets/anthropic" # or F2Z_AI_PROVIDER_ANTHROPIC_API_KEY
//! # base_url = "https://api.anthropic.com"    # the default for openai, anthropic, xai
//!
//! [providers.xai]
//! # completion_tokens_include_reasoning = false   # the default for xai only
//! ```
//!
//! A provider is configured by its table or by its key variable alone
//! (`F2Z_AI_PROVIDER_<NAME>_API_KEY`, the name upper-cased); either way it
//! must end up with exactly one key. An inline `api_key` is refused like
//! every other secret. A base URL must be `https://` (plain `http://` only to
//! loopback, for a mock provider).
//!
//! # Authentication and limits ([`crate::auth`])
//!
//! ```toml
//! auth_issuer = "https://free2z.cash"                  # the default; `iss`, exact
//! # auth_jwks_uri = "https://free2z.cash/api/oauth/jwks" # default: from discovery
//! auth_epoch_endpoint = "http://web.tuzi.svc:8000/api/oauth/internal/epoch/"
//! auth_epoch_token_file = "/var/run/secrets/oidc-internal"   # or F2Z_AI_AUTH_EPOCH_TOKEN
//! redis_url_file = "/var/run/secrets/redis-url"              # or F2Z_AI_REDIS_URL
//! redis_namespace = "free2z"   # the IdP's OIDC_EPOCH_REDIS_NAMESPACE (its DBNAME)
//! ```
//!
//! Token verification is **on** when `auth_epoch_endpoint` and its token are
//! configured, and then every `/v1/chat` needs a valid token. Without them
//! the gateway refuses every call `503` — it never serves unauthenticated.
//! Redis is optional: without it revocation always asks the endpoint and the
//! limits are per pod. The epoch endpoint may be plain `http://` (an
//! in-cluster Service); the issuer and `auth_jwks_uri` must be `https://`
//! (`http://` only to loopback, for a test issuer).

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use secrecy::SecretString;
use serde::Deserialize;

/// 4 MiB: the body limit for a request without image parts (chat-api.md §1).
pub const DEFAULT_MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// 20 MiB: the body limit for a request with image parts (chat-api.md §1).
pub const DEFAULT_MAX_BODY_BYTES_WITH_IMAGES: usize = 20 * 1024 * 1024;

/// 256 MiB: request bodies being read at once, gateway-wide — twelve
/// maximum-size image requests, or sixty-four maximum-size text ones.
pub const DEFAULT_MAX_UPLOAD_BUFFER_BYTES: usize = 256 * 1024 * 1024;

/// 256 KiB: the per-stream delivery buffer (chat-api.md §2.4, ADR 0001).
pub const DEFAULT_DELIVERY_BUFFER_BYTES: usize = 256 * 1024;

/// The environment variable prefix.
pub const ENV_PREFIX: &str = "F2Z_AI_";

/// The variable naming the config file. Consumed by the binary, and the one
/// `F2Z_AI_*` name that is not a config key.
pub const ENV_CONFIG_FILE: &str = "F2Z_AI_CONFIG";

/// The variable carrying the OTLP `authorization` header value.
pub const ENV_OTLP_AUTHORIZATION: &str = "F2Z_AI_OTLP_AUTHORIZATION";

/// `F2Z_AI_PROVIDER_<NAME>_API_KEY`: a provider's key.
pub const ENV_PROVIDER_PREFIX: &str = "F2Z_AI_PROVIDER_";
/// The suffix of a provider key variable.
pub const ENV_PROVIDER_KEY_SUFFIX: &str = "_API_KEY";
/// The internal epoch endpoint's shared secret.
pub const ENV_AUTH_EPOCH_TOKEN: &str = "F2Z_AI_AUTH_EPOCH_TOKEN";
/// The Redis URL (it may carry a password).
pub const ENV_REDIS_URL: &str = "F2Z_AI_REDIS_URL";

/// Authentication, revocation and limits ([`crate::auth`]).
#[derive(Clone)]
pub struct AuthConfig {
    /// `iss`, compared exactly.
    pub issuer: String,
    /// This gateway's identifier in `aud`.
    pub audience: String,
    /// The JWKS URL; `None` = from the issuer's discovery document.
    pub jwks_uri: Option<String>,
    /// The least time between two refetches on an unknown `kid`.
    pub jwks_min_refetch: Duration,
    /// The IdP's internal epoch endpoint, ending in `/`. `None` = auth off:
    /// every call is refused.
    pub epoch_endpoint: Option<String>,
    /// Its shared secret.
    pub epoch_token: Option<SecretString>,
    /// Its per-call timeout.
    pub epoch_timeout: Duration,
    /// The shared Redis. `None` = revocation via the endpoint only, limits
    /// per pod.
    pub redis_url: Option<SecretString>,
    /// The key namespace the IdP publishes under.
    pub redis_namespace: String,
    /// Per Redis call.
    pub redis_timeout: Duration,
    /// Per (app, user), sustained requests per minute.
    pub rate_user_per_minute: u32,
    /// Per (app, user), burst.
    pub rate_user_burst: u32,
    /// Per app, sustained requests per minute.
    pub rate_app_per_minute: u32,
    /// Per app, burst.
    pub rate_app_burst: u32,
    /// Open calls per user.
    pub concurrency_per_user: u32,
    /// How long a lease outlives a gateway that died holding it.
    pub concurrency_lease: Duration,
}

impl AuthConfig {
    /// Whether tokens are verified at all.
    #[must_use]
    pub const fn enabled(&self) -> bool {
        self.epoch_endpoint.is_some()
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            issuer: "https://free2z.cash".to_owned(),
            audience: "f2z-ai".to_owned(),
            jwks_uri: None,
            jwks_min_refetch: Duration::from_secs(60),
            epoch_endpoint: None,
            epoch_token: None,
            epoch_timeout: Duration::from_millis(1000),
            redis_url: None,
            redis_namespace: "free2z".to_owned(),
            redis_timeout: Duration::from_millis(250),
            rate_user_per_minute: 60,
            rate_user_burst: 20,
            rate_app_per_minute: 6000,
            rate_app_burst: 600,
            concurrency_per_user: 4,
            concurrency_lease: Duration::from_secs(360),
        }
    }
}

impl fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthConfig")
            .field("issuer", &self.issuer)
            .field("audience", &self.audience)
            .field("jwks_uri", &self.jwks_uri)
            .field("jwks_min_refetch", &self.jwks_min_refetch)
            .field("epoch_endpoint", &self.epoch_endpoint)
            .field(
                "epoch_token",
                &self.epoch_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("epoch_timeout", &self.epoch_timeout)
            .field("redis_url", &self.redis_url.as_ref().map(|_| "[REDACTED]"))
            .field("redis_namespace", &self.redis_namespace)
            .field("redis_timeout", &self.redis_timeout)
            .field("rate_user_per_minute", &self.rate_user_per_minute)
            .field("rate_user_burst", &self.rate_user_burst)
            .field("rate_app_per_minute", &self.rate_app_per_minute)
            .field("rate_app_burst", &self.rate_app_burst)
            .field("concurrency_per_user", &self.concurrency_per_user)
            .field("concurrency_lease", &self.concurrency_lease)
            .finish()
    }
}

/// The public API base URL of a provider this build knows by name.
#[must_use]
pub fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com"),
        "anthropic" => Some("https://api.anthropic.com"),
        "xai" => Some("https://api.x.ai"),
        _ => None,
    }
}

/// One provider account the gateway calls.
#[derive(Clone)]
pub struct ProviderConfig {
    /// `https://…` (or `http://` to loopback). Routes are appended to it.
    pub base_url: String,
    /// The provider key. Never rendered: `Debug` is redacted.
    pub api_key: SecretString,
    /// Chat Completions only: whether `completion_tokens` includes
    /// `reasoning_tokens` when the usage chunk cannot say
    /// (`provider::openai_chat`). `true` except for `xai`.
    pub completion_tokens_include_reasoning: bool,
}

impl fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field(
                "completion_tokens_include_reasoning",
                &self.completion_tokens_include_reasoning,
            )
            .finish()
    }
}

/// Everything the process runs on. Construct with [`Config::load`].
#[derive(Clone, Debug)]
pub struct Config {
    /// The public listener: `/v1/*` only.
    pub listen: SocketAddr,
    /// The admin listener: `/healthz`, `/readyz`, `/metrics`. Bind it where a
    /// kubelet can reach it (a pod IP, not loopback, in a cluster) and do not
    /// route it through the public Service.
    pub admin_listen: SocketAddr,
    /// Calls in flight at once, gateway-wide, counted until the response body
    /// ends. Beyond it: `503 unavailable` with `Retry-After`.
    pub max_concurrent_calls: usize,
    /// The `Retry-After` sent with an overload or draining `503`, in seconds.
    pub retry_after_secs: u32,
    /// How long a drain waits for in-flight calls before aborting them.
    pub drain_timeout: Duration,
    /// After the abort: how long to wait for aborted calls to unwind and for
    /// connections to close before they are dropped outright.
    pub abort_grace: Duration,
    /// How long the settler gets to finish the queue at shutdown.
    pub settle_grace: Duration,
    /// Request to response head. A backstop: `500 internal`.
    pub request_timeout: Duration,
    /// Time allowed to receive a request body. A slow upload holds a
    /// concurrency slot, so this is short.
    pub body_read_timeout: Duration,
    /// Time allowed to receive a request's headers.
    pub header_read_timeout: Duration,
    /// The body limit for a request without image parts.
    pub max_body_bytes: usize,
    /// The body limit for a request with image parts; also the hard cap on
    /// what is read at all.
    pub max_body_bytes_with_images: usize,
    /// Gateway-wide bytes of request bodies being read at once. A body
    /// reserves its declared length (the image cap if it declares none)
    /// before it is read; beyond the budget, `503 unavailable` +
    /// `Retry-After`. Without it, `max_concurrent_calls` × 20 MiB would be
    /// the memory bound.
    pub max_upload_buffer_bytes: usize,
    /// How often the catalogue source is polled.
    pub catalog_poll: Duration,
    /// How far (seconds of `issued_at`) below the newest catalogue installed
    /// a lower version may be and still install (zuu#1067). The default is
    /// the producer's `VERSION_REGRESSION_BOUND_SECONDS`, 420.
    pub catalog_version_regression_bound: Duration,
    /// Undelivered event bytes one stream may buffer before delivery ends
    /// with `delivery_aborted` (chat-api.md §2.4). The upstream read never
    /// waits on it.
    pub delivery_buffer_bytes: usize,
    /// Time with frames waiting and none delivered before delivery ends with
    /// `delivery_aborted` (chat-api.md §2.4).
    pub delivery_stall: Duration,
    /// The level for this crate's own log lines. Dependencies are capped at
    /// `warn` whatever this says (see [`crate::telemetry`]).
    pub log_level: LogLevel,
    /// The OTLP/HTTP collector base URL (`http://host:4318`). `None`, the
    /// default, means OpenTelemetry is off.
    pub otlp_endpoint: Option<String>,
    /// The `authorization` header sent to the collector.
    pub otlp_authorization: Option<SecretString>,
    /// Provider accounts, by the catalogue's `provider` name.
    pub providers: BTreeMap<String, ProviderConfig>,
    /// Authentication, revocation and limits.
    pub auth: AuthConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 8080)),
            admin_listen: SocketAddr::from(([127, 0, 0, 1], 9090)),
            max_concurrent_calls: 10_000,
            retry_after_secs: 1,
            drain_timeout: Duration::from_secs(300),
            abort_grace: Duration::from_secs(5),
            settle_grace: Duration::from_secs(10),
            request_timeout: Duration::from_secs(310),
            body_read_timeout: Duration::from_secs(30),
            header_read_timeout: Duration::from_secs(10),
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_body_bytes_with_images: DEFAULT_MAX_BODY_BYTES_WITH_IMAGES,
            max_upload_buffer_bytes: DEFAULT_MAX_UPLOAD_BUFFER_BYTES,
            catalog_poll: Duration::from_secs(30),
            catalog_version_regression_bound: Duration::from_secs(
                crate::catalog::DEFAULT_VERSION_REGRESSION_BOUND_SECS,
            ),
            delivery_buffer_bytes: DEFAULT_DELIVERY_BUFFER_BYTES,
            delivery_stall: Duration::from_secs(30),
            log_level: LogLevel::Info,
            otlp_endpoint: None,
            otlp_authorization: None,
            providers: BTreeMap::new(),
            auth: AuthConfig::default(),
        }
    }
}

/// A log level for this crate's own output.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    /// Faults only.
    Error,
    /// Faults and things an operator should look at.
    Warn,
    /// The default.
    Info,
    /// More.
    Debug,
    /// Everything this crate emits. Still never a prompt or a completion.
    Trace,
}

impl LogLevel {
    /// Parse a level name, case-insensitively. Unknown is `None`, never a
    /// default.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            "trace" => Some(Self::Trace),
            _ => None,
        }
    }
}

/// Why the configuration was refused.
#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn err(message: impl Into<String>) -> ConfigError {
    ConfigError(message.into())
}

/// The file's shape. Every field optional; unknown keys refused.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    listen: Option<String>,
    admin_listen: Option<String>,
    max_concurrent_calls: Option<u64>,
    retry_after_secs: Option<u64>,
    drain_timeout_secs: Option<u64>,
    abort_grace_secs: Option<u64>,
    settle_grace_secs: Option<u64>,
    request_timeout_secs: Option<u64>,
    body_read_timeout_secs: Option<u64>,
    header_read_timeout_secs: Option<u64>,
    max_body_bytes: Option<u64>,
    max_body_bytes_with_images: Option<u64>,
    max_upload_buffer_bytes: Option<u64>,
    catalog_poll_secs: Option<u64>,
    catalog_version_regression_bound_secs: Option<u64>,
    delivery_buffer_bytes: Option<u64>,
    delivery_stall_secs: Option<u64>,
    log_level: Option<String>,
    otlp_endpoint: Option<String>,
    otlp_authorization_file: Option<PathBuf>,
    providers: Option<BTreeMap<String, RawProvider>>,
    auth_issuer: Option<String>,
    auth_audience: Option<String>,
    auth_jwks_uri: Option<String>,
    auth_jwks_refetch_secs: Option<u64>,
    auth_epoch_endpoint: Option<String>,
    auth_epoch_token_file: Option<PathBuf>,
    auth_epoch_timeout_ms: Option<u64>,
    redis_url_file: Option<PathBuf>,
    redis_namespace: Option<String>,
    redis_timeout_ms: Option<u64>,
    rate_user_per_minute: Option<u64>,
    rate_user_burst: Option<u64>,
    rate_app_per_minute: Option<u64>,
    rate_app_burst: Option<u64>,
    concurrency_per_user: Option<u64>,
    concurrency_lease_secs: Option<u64>,
}

/// One `[providers.<name>]` table.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProvider {
    base_url: Option<String>,
    api_key_file: Option<PathBuf>,
    completion_tokens_include_reasoning: Option<bool>,
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Integer,
}

/// Every key, and how an environment value for it is read.
const KEYS: &[(&str, Kind)] = &[
    ("listen", Kind::Text),
    ("admin_listen", Kind::Text),
    ("max_concurrent_calls", Kind::Integer),
    ("retry_after_secs", Kind::Integer),
    ("drain_timeout_secs", Kind::Integer),
    ("abort_grace_secs", Kind::Integer),
    ("settle_grace_secs", Kind::Integer),
    ("request_timeout_secs", Kind::Integer),
    ("body_read_timeout_secs", Kind::Integer),
    ("header_read_timeout_secs", Kind::Integer),
    ("max_body_bytes", Kind::Integer),
    ("max_body_bytes_with_images", Kind::Integer),
    ("max_upload_buffer_bytes", Kind::Integer),
    ("catalog_poll_secs", Kind::Integer),
    ("catalog_version_regression_bound_secs", Kind::Integer),
    ("delivery_buffer_bytes", Kind::Integer),
    ("delivery_stall_secs", Kind::Integer),
    ("log_level", Kind::Text),
    ("otlp_endpoint", Kind::Text),
    ("otlp_authorization_file", Kind::Text),
    ("auth_issuer", Kind::Text),
    ("auth_audience", Kind::Text),
    ("auth_jwks_uri", Kind::Text),
    ("auth_jwks_refetch_secs", Kind::Integer),
    ("auth_epoch_endpoint", Kind::Text),
    ("auth_epoch_token_file", Kind::Text),
    ("auth_epoch_timeout_ms", Kind::Integer),
    ("redis_url_file", Kind::Text),
    ("redis_namespace", Kind::Text),
    ("redis_timeout_ms", Kind::Integer),
    ("rate_user_per_minute", Kind::Integer),
    ("rate_user_burst", Kind::Integer),
    ("rate_app_per_minute", Kind::Integer),
    ("rate_app_burst", Kind::Integer),
    ("concurrency_per_user", Kind::Integer),
    ("concurrency_lease_secs", Kind::Integer),
];

/// Keys that hold a secret and therefore may not appear inline in the file.
const INLINE_SECRETS: &[&str] = &["otlp_authorization", "auth_epoch_token", "redis_url"];

impl Config {
    /// Load `file` (if any), apply the `F2Z_AI_*` members of `env`, validate.
    ///
    /// `env` is passed in rather than read here so that a test can supply one
    /// without mutating the process environment. The binary passes
    /// `std::env::vars()`.
    ///
    /// # Errors
    ///
    /// A [`ConfigError`] naming the key or variable at fault.
    pub fn load<I>(file: Option<&Path>, env: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let mut table = match file {
            Some(path) => {
                let text = std::fs::read_to_string(path)
                    .map_err(|e| err(format!("{}: {e}", path.display())))?;
                text.parse::<toml::Table>()
                    .map_err(|e| err(format!("{}: {e}", path.display())))?
            }
            None => toml::Table::new(),
        };
        if let Some(toml::Value::Table(providers)) = table.get("providers") {
            for (name, provider) in providers {
                if provider.get("api_key").is_some() {
                    return Err(err(format!(
                        "`providers.{name}.api_key` is a secret and is not accepted inline in the \
                         config file; set {ENV_PROVIDER_PREFIX}{}{ENV_PROVIDER_KEY_SUFFIX} or \
                         `api_key_file`",
                        name.to_ascii_uppercase()
                    )));
                }
            }
        }
        for key in INLINE_SECRETS {
            if table.contains_key(*key) {
                return Err(err(format!(
                    "`{key}` is a secret and is not accepted inline in the config file; set \
                     {ENV_PREFIX}{} or `{key}_file`",
                    key.to_ascii_uppercase()
                )));
            }
        }

        let mut env_secret = None;
        let mut env_secrets = BTreeMap::new();
        let mut provider_keys = BTreeMap::new();
        let env: BTreeMap<String, String> = env
            .into_iter()
            .filter(|(name, _)| name.starts_with(ENV_PREFIX))
            .collect();
        for (name, value) in env {
            if name == ENV_CONFIG_FILE {
                continue;
            }
            if name == ENV_OTLP_AUTHORIZATION {
                env_secret = Some(SecretString::from(value));
                continue;
            }
            if name == ENV_AUTH_EPOCH_TOKEN || name == ENV_REDIS_URL {
                env_secrets.insert(name, SecretString::from(value));
                continue;
            }
            if let Some(provider) = name
                .strip_prefix(ENV_PROVIDER_PREFIX)
                .and_then(|rest| rest.strip_suffix(ENV_PROVIDER_KEY_SUFFIX))
            {
                if provider.is_empty()
                    || !provider
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                {
                    return Err(err(format!(
                        "`{name}`: a provider name in a key variable is upper-case letters, \
                         digits and underscores"
                    )));
                }
                provider_keys.insert(provider.to_ascii_lowercase(), SecretString::from(value));
                continue;
            }
            let key = name
                .get(ENV_PREFIX.len()..)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let Some((_, kind)) = KEYS.iter().find(|(k, _)| *k == key) else {
                return Err(err(format!(
                    "unknown environment variable `{name}`; the F2Z_AI_* namespace is reserved \
                     for this gateway's configuration"
                )));
            };
            let parsed = match kind {
                Kind::Text => toml::Value::String(value),
                Kind::Integer => toml::Value::Integer(
                    value
                        .trim()
                        .parse::<i64>()
                        .map_err(|_| err(format!("`{name}` must be an integer")))?,
                ),
            };
            table.insert(key, parsed);
        }

        let raw: Raw = table
            .try_into()
            .map_err(|e: toml::de::Error| err(e.to_string()))?;
        Self::from_raw(raw, env_secret, env_secrets, provider_keys)
    }

    fn from_raw(
        mut raw: Raw,
        env_secret: Option<SecretString>,
        mut env_secrets: BTreeMap<String, SecretString>,
        provider_keys: BTreeMap<String, SecretString>,
    ) -> Result<Self, ConfigError> {
        let auth = auth(&mut raw, &mut env_secrets)?;
        let defaults = Self::default();
        let addr = |key: &str, value: Option<String>, default: SocketAddr| match value {
            Some(text) => text
                .parse::<SocketAddr>()
                .map_err(|_| err(format!("`{key}` must be an ip:port socket address"))),
            None => Ok(default),
        };
        let secs =
            |value: Option<u64>, default: Duration| value.map_or(default, Duration::from_secs);
        let size = |key: &str, value: Option<u64>, default: usize| match value {
            Some(n) => usize::try_from(n).map_err(|_| err(format!("`{key}` is too large"))),
            None => Ok(default),
        };

        let log_level = match raw.log_level {
            Some(name) => {
                LogLevel::parse(&name).ok_or_else(|| err(format!("unknown log_level `{name}`")))?
            }
            None => defaults.log_level,
        };

        let otlp_authorization = match (env_secret, raw.otlp_authorization_file.take()) {
            (Some(_), Some(_)) => {
                return Err(err(format!(
                    "both {ENV_OTLP_AUTHORIZATION} and `otlp_authorization_file` are set; choose one"
                )));
            }
            (Some(secret), None) => Some(secret),
            (None, Some(path)) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| err(format!("{}: {e}", path.display())))?;
                Some(SecretString::from(
                    text.trim_end_matches(['\r', '\n']).to_owned(),
                ))
            }
            (None, None) => None,
        };

        let providers = providers(raw.providers.take().unwrap_or_default(), provider_keys)?;

        let config = Self {
            listen: addr("listen", raw.listen, defaults.listen)?,
            admin_listen: addr("admin_listen", raw.admin_listen, defaults.admin_listen)?,
            max_concurrent_calls: size(
                "max_concurrent_calls",
                raw.max_concurrent_calls,
                defaults.max_concurrent_calls,
            )?,
            retry_after_secs: match raw.retry_after_secs {
                Some(n) => u32::try_from(n).map_err(|_| err("`retry_after_secs` is too large"))?,
                None => defaults.retry_after_secs,
            },
            drain_timeout: secs(raw.drain_timeout_secs, defaults.drain_timeout),
            abort_grace: secs(raw.abort_grace_secs, defaults.abort_grace),
            settle_grace: secs(raw.settle_grace_secs, defaults.settle_grace),
            request_timeout: secs(raw.request_timeout_secs, defaults.request_timeout),
            body_read_timeout: secs(raw.body_read_timeout_secs, defaults.body_read_timeout),
            header_read_timeout: secs(raw.header_read_timeout_secs, defaults.header_read_timeout),
            max_body_bytes: size(
                "max_body_bytes",
                raw.max_body_bytes,
                defaults.max_body_bytes,
            )?,
            max_body_bytes_with_images: size(
                "max_body_bytes_with_images",
                raw.max_body_bytes_with_images,
                defaults.max_body_bytes_with_images,
            )?,
            max_upload_buffer_bytes: size(
                "max_upload_buffer_bytes",
                raw.max_upload_buffer_bytes,
                defaults.max_upload_buffer_bytes,
            )?,
            catalog_poll: secs(raw.catalog_poll_secs, defaults.catalog_poll),
            catalog_version_regression_bound: secs(
                raw.catalog_version_regression_bound_secs,
                defaults.catalog_version_regression_bound,
            ),
            delivery_buffer_bytes: size(
                "delivery_buffer_bytes",
                raw.delivery_buffer_bytes,
                defaults.delivery_buffer_bytes,
            )?,
            delivery_stall: secs(raw.delivery_stall_secs, defaults.delivery_stall),
            log_level,
            otlp_endpoint: raw.otlp_endpoint.filter(|s| !s.is_empty()),
            otlp_authorization,
            providers,
            auth,
        };
        config.validate()?;
        Ok(config)
    }

    /// The cross-field rules.
    fn validate(&self) -> Result<(), ConfigError> {
        if self.max_concurrent_calls == 0 {
            return Err(err("`max_concurrent_calls` must be at least 1"));
        }
        if self.max_upload_buffer_bytes < self.max_body_bytes_with_images {
            return Err(err(
                "`max_upload_buffer_bytes` must be at least `max_body_bytes_with_images`, or a \
                 body without a Content-Length could never be read",
            ));
        }
        if u32::try_from(self.max_body_bytes_with_images).is_err() {
            return Err(err("`max_body_bytes_with_images` must be below 4 GiB"));
        }
        if self.delivery_buffer_bytes == 0 {
            return Err(err("`delivery_buffer_bytes` must be at least 1"));
        }
        if self.max_body_bytes == 0 {
            return Err(err("`max_body_bytes` must be at least 1"));
        }
        if self.max_body_bytes > self.max_body_bytes_with_images {
            return Err(err(
                "`max_body_bytes` must not exceed `max_body_bytes_with_images`: the image limit \
                 is the larger of the two by definition (chat-api.md §1)",
            ));
        }
        for (key, value) in [
            ("request_timeout_secs", self.request_timeout),
            ("body_read_timeout_secs", self.body_read_timeout),
            ("header_read_timeout_secs", self.header_read_timeout),
            ("catalog_poll_secs", self.catalog_poll),
            ("delivery_stall_secs", self.delivery_stall),
        ] {
            if value.is_zero() {
                return Err(err(format!("`{key}` must be at least 1")));
            }
        }
        if let Some(endpoint) = &self.otlp_endpoint {
            if endpoint.starts_with("https://") {
                return Err(err(
                    "`otlp_endpoint` must be http://: this build carries no TLS for the OTLP \
                     exporter, so an https:// collector would fail on the first export instead \
                     of here. Point it at an in-cluster collector",
                ));
            }
            if !endpoint.starts_with("http://") {
                return Err(err("`otlp_endpoint` must be an http:// URL"));
            }
        }
        if self.auth.concurrency_lease < self.request_timeout {
            return Err(err(
                "`concurrency_lease_secs` must be at least `request_timeout_secs`: a lease that \
                 expires while its call can still be starting stops counting a live call",
            ));
        }
        if self.otlp_authorization.is_some() && self.otlp_endpoint.is_none() {
            return Err(err(
                "an OTLP authorization is set but `otlp_endpoint` is not; OpenTelemetry is off \
                 unless an endpoint is configured",
            ));
        }
        Ok(())
    }
}

/// A secret from its variable or its file, not both.
fn secret(
    variable: &str,
    from_env: Option<SecretString>,
    key: &str,
    file: Option<PathBuf>,
) -> Result<Option<SecretString>, ConfigError> {
    match (from_env, file) {
        (Some(_), Some(_)) => Err(err(format!(
            "both {variable} and `{key}` are set; choose one"
        ))),
        (Some(secret), None) => Ok(Some(secret)),
        (None, Some(path)) => {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| err(format!("{}: {e}", path.display())))?;
            Ok(Some(SecretString::from(
                text.trim_end_matches(['\r', '\n']).to_owned(),
            )))
        }
        (None, None) => Ok(None),
    }
}

fn positive_u32(key: &str, value: Option<u64>, default: u32) -> Result<u32, ConfigError> {
    let Some(value) = value else {
        return Ok(default);
    };
    match u32::try_from(value) {
        Ok(n) if n >= 1 => Ok(n),
        _ => Err(err(format!("`{key}` must be between 1 and 4294967295"))),
    }
}

/// The authentication keys.
fn auth(
    raw: &mut Raw,
    env_secrets: &mut BTreeMap<String, SecretString>,
) -> Result<AuthConfig, ConfigError> {
    let defaults = AuthConfig::default();
    let issuer = raw.auth_issuer.take().unwrap_or(defaults.issuer);
    crate::auth::jwks::check_url(&issuer).map_err(|e| err(format!("auth_issuer: {e}")))?;
    let jwks_uri = raw.auth_jwks_uri.take().filter(|s| !s.is_empty());
    if let Some(uri) = &jwks_uri {
        crate::auth::jwks::check_url(uri).map_err(|e| err(format!("auth_jwks_uri: {e}")))?;
    }
    let epoch_endpoint = raw.auth_epoch_endpoint.take().filter(|s| !s.is_empty());
    if let Some(endpoint) = &epoch_endpoint {
        let url =
            reqwest::Url::parse(endpoint).map_err(|_| err("`auth_epoch_endpoint` is not a URL"))?;
        if !matches!(url.scheme(), "http" | "https") || !endpoint.ends_with('/') {
            return Err(err(
                "`auth_epoch_endpoint` must be an http:// or https:// URL ending in `/` (the \
                 subject is appended)",
            ));
        }
    }
    let epoch_token = secret(
        ENV_AUTH_EPOCH_TOKEN,
        env_secrets.remove(ENV_AUTH_EPOCH_TOKEN),
        "auth_epoch_token_file",
        raw.auth_epoch_token_file.take(),
    )?;
    if epoch_endpoint.is_some() != epoch_token.is_some() {
        return Err(err(format!(
            "`auth_epoch_endpoint` and its token ({ENV_AUTH_EPOCH_TOKEN} or \
             `auth_epoch_token_file`) are configured together or not at all"
        )));
    }
    let redis_url = secret(
        ENV_REDIS_URL,
        env_secrets.remove(ENV_REDIS_URL),
        "redis_url_file",
        raw.redis_url_file.take(),
    )?;
    let namespace = raw
        .redis_namespace
        .take()
        .unwrap_or(defaults.redis_namespace);
    if namespace.is_empty() || namespace.contains(':') {
        return Err(err(
            "`redis_namespace` must be non-empty and contain no `:`",
        ));
    }
    let millis = |key: &str, value: Option<u64>, default: Duration| match value {
        Some(0) => Err(err(format!("`{key}` must be at least 1"))),
        Some(n) => Ok(Duration::from_millis(n)),
        None => Ok(default),
    };
    let config = AuthConfig {
        issuer,
        audience: raw.auth_audience.take().unwrap_or(defaults.audience),
        jwks_uri,
        jwks_min_refetch: raw
            .auth_jwks_refetch_secs
            .map_or(defaults.jwks_min_refetch, Duration::from_secs),
        epoch_endpoint,
        epoch_token,
        epoch_timeout: millis(
            "auth_epoch_timeout_ms",
            raw.auth_epoch_timeout_ms,
            defaults.epoch_timeout,
        )?,
        redis_url,
        redis_namespace: namespace,
        redis_timeout: millis(
            "redis_timeout_ms",
            raw.redis_timeout_ms,
            defaults.redis_timeout,
        )?,
        rate_user_per_minute: positive_u32(
            "rate_user_per_minute",
            raw.rate_user_per_minute,
            defaults.rate_user_per_minute,
        )?,
        rate_user_burst: positive_u32(
            "rate_user_burst",
            raw.rate_user_burst,
            defaults.rate_user_burst,
        )?,
        rate_app_per_minute: positive_u32(
            "rate_app_per_minute",
            raw.rate_app_per_minute,
            defaults.rate_app_per_minute,
        )?,
        rate_app_burst: positive_u32(
            "rate_app_burst",
            raw.rate_app_burst,
            defaults.rate_app_burst,
        )?,
        concurrency_per_user: positive_u32(
            "concurrency_per_user",
            raw.concurrency_per_user,
            defaults.concurrency_per_user,
        )?,
        concurrency_lease: match raw.concurrency_lease_secs {
            Some(0) => return Err(err("`concurrency_lease_secs` must be at least 1")),
            Some(n) => Duration::from_secs(n),
            None => defaults.concurrency_lease,
        },
    };
    if config.audience.is_empty() {
        return Err(err("`auth_audience` must not be empty"));
    }
    Ok(config)
}

/// Merge the `[providers.*]` tables with the key variables.
fn providers(
    mut tables: BTreeMap<String, RawProvider>,
    mut keys: BTreeMap<String, SecretString>,
) -> Result<BTreeMap<String, ProviderConfig>, ConfigError> {
    let mut names: Vec<String> = tables.keys().cloned().collect();
    names.extend(keys.keys().filter(|k| !tables.contains_key(*k)).cloned());
    let mut out = BTreeMap::new();
    for name in names {
        let raw = tables.remove(&name).unwrap_or_default();
        let variable = format!(
            "{ENV_PROVIDER_PREFIX}{}{ENV_PROVIDER_KEY_SUFFIX}",
            name.to_ascii_uppercase()
        );
        let api_key = match (keys.remove(&name), raw.api_key_file) {
            (Some(_), Some(_)) => {
                return Err(err(format!(
                    "provider `{name}` has both {variable} and `api_key_file`; choose one"
                )));
            }
            (Some(key), None) => key,
            (None, Some(path)) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| err(format!("{}: {e}", path.display())))?;
                SecretString::from(text.trim_end_matches(['\r', '\n']).to_owned())
            }
            (None, None) => {
                return Err(err(format!(
                    "provider `{name}` has no key: set {variable} or `api_key_file`"
                )));
            }
        };
        let base_url = match raw.base_url {
            Some(url) => url,
            None => default_base_url(&name)
                .ok_or_else(|| err(format!("provider `{name}` needs a `base_url`")))?
                .to_owned(),
        };
        crate::provider::client::base_url(&base_url)
            .map_err(|e| err(format!("providers.{name}.base_url: {e}")))?;
        let include_reasoning = raw
            .completion_tokens_include_reasoning
            .unwrap_or(name != "xai");
        out.insert(
            name,
            ProviderConfig {
                base_url,
                api_key,
                completion_tokens_include_reasoning: include_reasoning,
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn file(contents: &str) -> tempfile::Path {
        tempfile::Path::new(contents)
    }

    /// A throwaway file under the target directory; no tempfile dependency.
    mod tempfile {
        use std::sync::atomic::{AtomicU32, Ordering};

        pub(super) struct Path(std::path::PathBuf);

        static NEXT: AtomicU32 = AtomicU32::new(0);

        impl Path {
            pub(super) fn new(contents: &str) -> Self {
                let n = NEXT.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "f2z-ai-config-test-{}-{n}.toml",
                    std::process::id()
                ));
                std::fs::write(&path, contents).unwrap();
                Self(path)
            }

            pub(super) fn path(&self) -> &std::path::Path {
                &self.0
            }
        }

        impl Drop for Path {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }

    #[test]
    fn defaults_are_the_contract_numbers_and_otel_is_off() {
        let config = Config::load(None, env(&[])).unwrap();
        assert_eq!(config.max_body_bytes, 4 * 1024 * 1024);
        assert_eq!(config.max_body_bytes_with_images, 20 * 1024 * 1024);
        assert_eq!(config.drain_timeout, Duration::from_secs(300));
        assert_eq!(config.catalog_poll, Duration::from_secs(30));
        assert_eq!(config.delivery_buffer_bytes, 256 * 1024);
        assert_eq!(config.delivery_stall, Duration::from_secs(30));
        assert!(config.otlp_endpoint.is_none());
        assert!(config.otlp_authorization.is_none());
    }

    #[test]
    fn the_environment_overrides_the_file() {
        let f = file("drain_timeout_secs = 100\nlisten = \"127.0.0.1:1\"\n");
        let config = Config::load(
            Some(f.path()),
            env(&[("F2Z_AI_DRAIN_TIMEOUT_SECS", "7"), ("UNRELATED", "x")]),
        )
        .unwrap();
        assert_eq!(config.drain_timeout, Duration::from_secs(7));
        assert_eq!(config.listen, SocketAddr::from(([127, 0, 0, 1], 1)));
    }

    #[test]
    fn a_misspelt_variable_or_key_is_an_error_not_a_default() {
        let error = Config::load(None, env(&[("F2Z_AI_DRAIN_TIMOUT_SECS", "7")])).unwrap_err();
        assert!(
            error.to_string().contains("F2Z_AI_DRAIN_TIMOUT_SECS"),
            "{error}"
        );

        let f = file("drain_timout_secs = 7\n");
        let error = Config::load(Some(f.path()), env(&[])).unwrap_err();
        assert!(error.to_string().contains("drain_timout_secs"), "{error}");
    }

    #[test]
    fn a_secret_inline_in_the_file_is_refused() {
        let f = file("otlp_endpoint = \"http://c:4318\"\notlp_authorization = \"Bearer s3cr3t\"\n");
        let error = Config::load(Some(f.path()), env(&[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not accepted inline"), "{error}");
        assert!(!error.contains("s3cr3t"), "{error}");
    }

    #[test]
    fn a_secret_from_the_environment_never_renders() {
        let config = Config::load(
            None,
            env(&[
                ("F2Z_AI_OTLP_ENDPOINT", "http://collector:4318"),
                ("F2Z_AI_OTLP_AUTHORIZATION", "Bearer s3cr3t-canary"),
            ]),
        )
        .unwrap();
        assert!(config.otlp_authorization.is_some());
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("s3cr3t-canary"), "{rendered}");
    }

    #[test]
    fn a_secret_file_is_read_and_trimmed() {
        let secret = file("Bearer from-file\n");
        let f = file(&format!(
            "otlp_endpoint = \"http://c:4318\"\notlp_authorization_file = {:?}\n",
            secret.path()
        ));
        let config = Config::load(Some(f.path()), env(&[])).unwrap();
        use secrecy::ExposeSecret as _;
        assert_eq!(
            config.otlp_authorization.unwrap().expose_secret(),
            "Bearer from-file"
        );
    }

    #[test]
    fn an_https_collector_is_refused_at_startup() {
        let error = Config::load(None, env(&[("F2Z_AI_OTLP_ENDPOINT", "https://c:4318")]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("http://"), "{error}");
    }

    #[test]
    fn the_text_limit_may_not_exceed_the_image_limit() {
        let error = Config::load(
            None,
            env(&[
                ("F2Z_AI_MAX_BODY_BYTES", "100"),
                ("F2Z_AI_MAX_BODY_BYTES_WITH_IMAGES", "10"),
            ]),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("max_body_bytes"), "{error}");
    }

    #[test]
    fn a_provider_key_comes_from_the_environment_or_a_file_never_inline() {
        let config = Config::load(
            None,
            env(&[("F2Z_AI_PROVIDER_ANTHROPIC_API_KEY", "sk-ant-canary")]),
        )
        .unwrap();
        let anthropic = &config.providers["anthropic"];
        assert_eq!(anthropic.base_url, "https://api.anthropic.com");
        assert!(anthropic.completion_tokens_include_reasoning);
        assert!(!format!("{config:?}").contains("sk-ant-canary"));

        let f = file("[providers.openai]\napi_key = \"sk-inline-canary\"\n");
        let error = Config::load(Some(f.path()), env(&[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not accepted inline"), "{error}");
        assert!(!error.contains("sk-inline-canary"), "{error}");

        let key = file("xai-from-file\n");
        let f = file(&format!(
            "[providers.xai]\napi_key_file = {:?}\n",
            key.path()
        ));
        let config = Config::load(Some(f.path()), env(&[])).unwrap();
        use secrecy::ExposeSecret as _;
        assert_eq!(
            config.providers["xai"].api_key.expose_secret(),
            "xai-from-file"
        );
        assert!(!config.providers["xai"].completion_tokens_include_reasoning);
    }

    #[test]
    fn a_provider_without_a_key_or_with_a_plain_http_url_is_refused() {
        let f = file("[providers.openai]\n");
        assert!(Config::load(Some(f.path()), env(&[])).is_err());
        let f = file("[providers.openai]\nbase_url = \"http://api.openai.com\"\n");
        let error = Config::load(
            Some(f.path()),
            env(&[("F2Z_AI_PROVIDER_OPENAI_API_KEY", "k")]),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("https://"), "{error}");
        assert!(
            Config::load(None, env(&[("F2Z_AI_PROVIDER_MYSTERY_API_KEY", "k")])).is_err(),
            "an unknown provider needs a base_url"
        );
    }

    #[test]
    fn auth_is_off_by_default_and_on_with_an_endpoint_and_its_token() {
        let config = Config::load(None, env(&[])).unwrap();
        assert!(!config.auth.enabled());
        assert_eq!(config.auth.issuer, "https://free2z.cash");
        assert_eq!(config.auth.audience, "f2z-ai");
        assert_eq!(config.auth.concurrency_per_user, 4);

        let config = Config::load(
            None,
            env(&[
                (
                    "F2Z_AI_AUTH_EPOCH_ENDPOINT",
                    "http://web.tuzi:8000/api/oauth/internal/epoch/",
                ),
                ("F2Z_AI_AUTH_EPOCH_TOKEN", "epoch-canary"),
                ("F2Z_AI_REDIS_URL", "redis://:redis-canary@redis:6379/0"),
                ("F2Z_AI_REDIS_NAMESPACE", "free2z_prod"),
                ("F2Z_AI_RATE_USER_BURST", "5"),
            ]),
        )
        .unwrap();
        assert!(config.auth.enabled());
        assert_eq!(config.auth.redis_namespace, "free2z_prod");
        assert_eq!(config.auth.rate_user_burst, 5);
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("epoch-canary"), "{rendered}");
        assert!(!rendered.contains("redis-canary"), "{rendered}");
    }

    #[test]
    fn auth_misconfigurations_are_refused() {
        let endpoint = (
            "F2Z_AI_AUTH_EPOCH_ENDPOINT",
            "http://idp/api/oauth/internal/epoch/",
        );
        let token = ("F2Z_AI_AUTH_EPOCH_TOKEN", "t");
        for (case, pairs) in [
            ("endpoint without token", vec![endpoint]),
            ("token without endpoint", vec![token]),
            (
                "no trailing slash",
                vec![("F2Z_AI_AUTH_EPOCH_ENDPOINT", "http://idp/epoch"), token],
            ),
            (
                "plain-http issuer",
                vec![("F2Z_AI_AUTH_ISSUER", "http://free2z.cash")],
            ),
            (
                "namespace with a colon",
                vec![("F2Z_AI_REDIS_NAMESPACE", "a:b")],
            ),
            ("zero burst", vec![("F2Z_AI_RATE_USER_BURST", "0")]),
            (
                "lease shorter than a call",
                vec![("F2Z_AI_CONCURRENCY_LEASE_SECS", "60")],
            ),
        ] {
            assert!(Config::load(None, env(&pairs)).is_err(), "{case}");
        }
        let f = file("redis_url = \"redis://:inline-canary@r\"\n");
        let error = Config::load(Some(f.path()), env(&[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not accepted inline"), "{error}");
        assert!(!error.contains("inline-canary"), "{error}");
    }

    #[test]
    fn zero_concurrency_is_refused() {
        assert!(Config::load(None, env(&[("F2Z_AI_MAX_CONCURRENT_CALLS", "0")])).is_err());
        assert!(Config::load(None, env(&[("F2Z_AI_MAX_CONCURRENT_CALLS", "-1")])).is_err());
    }
}
