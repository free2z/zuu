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

/// 256 KiB: the per-stream delivery buffer (chat-api.md §2.4, ADR 0001).
pub const DEFAULT_DELIVERY_BUFFER_BYTES: usize = 256 * 1024;

/// The environment variable prefix.
pub const ENV_PREFIX: &str = "F2Z_AI_";

/// The variable naming the config file. Consumed by the binary, and the one
/// `F2Z_AI_*` name that is not a config key.
pub const ENV_CONFIG_FILE: &str = "F2Z_AI_CONFIG";

/// The variable carrying the OTLP `authorization` header value.
pub const ENV_OTLP_AUTHORIZATION: &str = "F2Z_AI_OTLP_AUTHORIZATION";

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
    /// How often the catalogue source is polled.
    pub catalog_poll: Duration,
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
            catalog_poll: Duration::from_secs(30),
            delivery_buffer_bytes: DEFAULT_DELIVERY_BUFFER_BYTES,
            delivery_stall: Duration::from_secs(30),
            log_level: LogLevel::Info,
            otlp_endpoint: None,
            otlp_authorization: None,
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
    catalog_poll_secs: Option<u64>,
    delivery_buffer_bytes: Option<u64>,
    delivery_stall_secs: Option<u64>,
    log_level: Option<String>,
    otlp_endpoint: Option<String>,
    otlp_authorization_file: Option<PathBuf>,
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
    ("catalog_poll_secs", Kind::Integer),
    ("delivery_buffer_bytes", Kind::Integer),
    ("delivery_stall_secs", Kind::Integer),
    ("log_level", Kind::Text),
    ("otlp_endpoint", Kind::Text),
    ("otlp_authorization_file", Kind::Text),
];

/// Keys that hold a secret and therefore may not appear inline in the file.
const INLINE_SECRETS: &[&str] = &["otlp_authorization"];

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
        Self::from_raw(raw, env_secret)
    }

    fn from_raw(raw: Raw, env_secret: Option<SecretString>) -> Result<Self, ConfigError> {
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

        let otlp_authorization = match (env_secret, raw.otlp_authorization_file) {
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
            catalog_poll: secs(raw.catalog_poll_secs, defaults.catalog_poll),
            delivery_buffer_bytes: size(
                "delivery_buffer_bytes",
                raw.delivery_buffer_bytes,
                defaults.delivery_buffer_bytes,
            )?,
            delivery_stall: secs(raw.delivery_stall_secs, defaults.delivery_stall),
            log_level,
            otlp_endpoint: raw.otlp_endpoint.filter(|s| !s.is_empty()),
            otlp_authorization,
        };
        config.validate()?;
        Ok(config)
    }

    /// The cross-field rules.
    fn validate(&self) -> Result<(), ConfigError> {
        if self.max_concurrent_calls == 0 {
            return Err(err("`max_concurrent_calls` must be at least 1"));
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
        if self.otlp_authorization.is_some() && self.otlp_endpoint.is_none() {
            return Err(err(
                "an OTLP authorization is set but `otlp_endpoint` is not; OpenTelemetry is off \
                 unless an endpoint is configured",
            ));
        }
        Ok(())
    }
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
    fn zero_concurrency_is_refused() {
        assert!(Config::load(None, env(&[("F2Z_AI_MAX_CONCURRENT_CALLS", "0")])).is_err());
        assert!(Config::load(None, env(&[("F2Z_AI_MAX_CONCURRENT_CALLS", "-1")])).is_err());
    }
}
