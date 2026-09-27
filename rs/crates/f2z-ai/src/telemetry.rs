//! Structured JSON logs, and OpenTelemetry tracing when — and only when — an
//! OTLP endpoint is configured.
//!
//! # What reaches a log line
//!
//! One JSON object per line on stderr: timestamp, level, target, message and
//! the event's own fields. Fields are chosen at each call site from a small
//! vocabulary — route, status, elapsed time, call number, counts, byte sizes,
//! catalogue version. **Never a prompt, a completion, a header value or a
//! peer address**; see the crate docs and `tests/redaction.rs`.
//!
//! # Levels
//!
//! `log_level` applies to this crate. Every dependency is capped at `warn`
//! whatever it says, because the gateway does not control what a dependency
//! prints at `debug`/`trace` — hyper and the HTTP stack are the layer that
//! touches request bytes — and "the most verbose level an operator can set"
//! is the level the redaction test must hold at.
//!
//! # OpenTelemetry
//!
//! Off by default. With `otlp_endpoint` set, spans from this crate (the same
//! filter) are exported over OTLP/HTTP protobuf to `<endpoint>/v1/traces` by
//! the SDK's batch processor. The exporter's HTTP client is blocking and must
//! be built and shut down **outside** any tokio runtime — `main` does both.

use std::collections::HashMap;
use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{WithExportConfig as _, WithHttpConfig as _};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use secrecy::ExposeSecret as _;
use tracing::level_filters::LevelFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::registry::LookupSpan;

use crate::config::{Config, LogLevel};

/// The OpenTelemetry `service.name`.
pub const SERVICE_NAME: &str = "f2z-ai";

/// The filter: this crate at `level`, every other target at `warn` at most.
#[must_use]
pub fn filter(level: LogLevel) -> Targets {
    let own = match level {
        LogLevel::Error => LevelFilter::ERROR,
        LogLevel::Warn => LevelFilter::WARN,
        LogLevel::Info => LevelFilter::INFO,
        LogLevel::Debug => LevelFilter::DEBUG,
        LogLevel::Trace => LevelFilter::TRACE,
    };
    Targets::new()
        .with_target("f2z_ai", own)
        .with_default(LevelFilter::WARN.min(own))
}

/// The JSON log layer, writing to `writer`. Public so that a test can point
/// the production layer at a buffer.
pub fn json_layer<S, W>(level: LogLevel, writer: W) -> impl Layer<S> + Send + Sync + 'static
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_target(true)
        .with_ansi(false)
        .with_writer(writer)
        .with_filter(filter(level))
}

/// What [`init`] installed. Call [`Telemetry::shutdown`] outside the runtime.
#[derive(Debug)]
pub struct Telemetry {
    provider: Option<SdkTracerProvider>,
}

impl Telemetry {
    /// Whether an OTLP exporter is running.
    #[must_use]
    pub const fn otel_enabled(&self) -> bool {
        self.provider.is_some()
    }

    /// Flush and stop the exporter, if any. Blocking; call it outside the
    /// tokio runtime.
    pub fn shutdown(self) {
        if let Some(provider) = self.provider
            && let Err(error) = provider.shutdown_with_timeout(Duration::from_secs(5))
        {
            tracing::warn!(%error, "OpenTelemetry shutdown did not complete");
        }
    }
}

/// Build the OTLP tracer provider for `config`, or `None` when OpenTelemetry
/// is off.
///
/// # Errors
///
/// The exporter could not be built.
pub fn tracer_provider(config: &Config) -> Result<Option<SdkTracerProvider>, String> {
    let Some(endpoint) = &config.otlp_endpoint else {
        return Ok(None);
    };
    let mut headers = HashMap::new();
    if let Some(secret) = &config.otlp_authorization {
        headers.insert(
            "authorization".to_owned(),
            secret.expose_secret().to_owned(),
        );
    }
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/traces", endpoint.trim_end_matches('/')))
        .with_headers(headers)
        .with_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("OTLP exporter: {e}"))?;
    Ok(Some(
        SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(Resource::builder().with_service_name(SERVICE_NAME).build())
            .build(),
    ))
}

/// Install the global subscriber: JSON logs to stderr, plus OpenTelemetry if
/// configured. Call once, before building the tokio runtime.
///
/// # Errors
///
/// The exporter could not be built, or a global subscriber is already set.
pub fn init(config: &Config) -> Result<Telemetry, String> {
    let provider = tracer_provider(config)?;
    let otel = provider.as_ref().map(|provider| {
        tracing_opentelemetry::layer()
            .with_tracer(provider.tracer(SERVICE_NAME))
            .with_filter(filter(config.log_level))
    });
    let subscriber = tracing_subscriber::registry()
        .with(json_layer(config.log_level, std::io::stderr))
        .with(otel);
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| format!("installing the log subscriber: {e}"))?;
    Ok(Telemetry { provider })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otel_is_off_unless_an_endpoint_is_configured() {
        let config = Config::default();
        assert!(tracer_provider(&config).unwrap().is_none());
    }

    #[test]
    fn dependencies_never_log_below_warn_even_at_trace() {
        use tracing::Level;
        let targets = filter(LogLevel::Trace);
        assert!(targets.would_enable("f2z_ai::chat", &Level::TRACE));
        assert!(!targets.would_enable("hyper::proto::h1", &Level::DEBUG));
        assert!(!targets.would_enable("hyper::proto::h1", &Level::INFO));
        assert!(targets.would_enable("hyper::proto::h1", &Level::WARN));
        let quiet = filter(LogLevel::Error);
        assert!(!quiet.would_enable("hyper", &Level::WARN));
    }
}
