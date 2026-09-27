//! Bounded, parameterized calls to the public ledger function ABI.
//! No schema creation, table access, credentials, or deployment defaults live here.
//! A timeout is an UNKNOWN commit outcome: callers retry the identical operation.

use crate::auth::Principal;
use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::row::Row;
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use std::time::Duration;
use uuid::Uuid;

/// Epochs captured at admission; completion continues with these after revocation.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Identity {
    /// Authenticated account UUID.
    pub subject: Uuid,
    /// OAuth client UUID.
    pub app: Uuid,
    /// Exact account revocation epoch.
    pub account_epoch: i32,
    /// Exact grant generation.
    pub grant_generation: i32,
}
impl TryFrom<&Principal> for Identity {
    type Error = Failure;
    fn try_from(p: &Principal) -> Result<Self, Failure> {
        Ok(Self {
            subject: p.sub.parse().map_err(|_| Failure)?,
            app: p.client_id.parse().map_err(|_| Failure)?,
            account_epoch: i32::try_from(p.aep).map_err(|_| Failure)?,
            grant_generation: i32::try_from(p.agen).map_err(|_| Failure)?,
        })
    }
}

/// Redacted transport/protocol failure; never return database error text to callers.
#[derive(Clone, Copy, Debug)]
pub struct Failure;
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ledger unavailable or invalid response")
    }
}
impl std::error::Error for Failure {}

/// Immutable operations. Retain the same value across ambiguous-outcome retries.
#[derive(Clone)]
#[allow(missing_docs)] // Positional ABI fields retain their explicit names and units.
pub enum Operation {
    Context(Identity),
    Claim {
        identity: Identity,
        call: Uuid,
        key: Option<String>,
        fingerprint: String,
        request: Value,
    },
    Read {
        identity: Identity,
        call: Uuid,
    },
    Complete {
        identity: Identity,
        call: Uuid,
        completion: Value,
        no_hold: bool,
    },
    Hold {
        identity: Identity,
        call: Uuid,
        amount_milli: i64,
        model: String,
        rate_card: i64,
        catalog: String,
        consented_markup: i32,
        provider: String,
    },
    Extend {
        identity: Identity,
        hold: Uuid,
        amount_milli: Option<i64>,
    },
    Settle {
        hold: Uuid,
        cost_nusd: i64,
        usage: Value,
    },
    Release {
        hold: Uuid,
        usage: Value,
    },
}

/// The function transport. Implementations must bound both connection acquisition
/// and execution and must never replay with newly generated identifiers.
#[async_trait]
pub trait Ledger: Send + Sync {
    /// Execute one immutable function invocation; transport errors are ambiguous.
    async fn execute(&self, operation: &Operation) -> Result<Value, Failure>;
}

/// A small multiplexing-safe pool. Each function uses its own short transaction
/// with local lock/statement deadlines. No transaction crosses provider I/O.
pub struct Postgres {
    pool: PgPool,
}
impl Postgres {
    /// Verify TLS and the entire function ABI before serving requests.
    pub async fn connect(url: &SecretString, max_connections: u32) -> Result<Self, Failure> {
        Self::connect_mode(url, max_connections, false).await
    }
    /// Local integration tests only: plaintext is allowed exclusively to a literal
    /// loopback IP. This constructor is never used by production configuration.
    pub async fn connect_loopback_test(
        url: &SecretString,
        max_connections: u32,
    ) -> Result<Self, Failure> {
        Self::connect_mode(url, max_connections, true).await
    }
    async fn connect_mode(
        url: &SecretString,
        max_connections: u32,
        loopback_test: bool,
    ) -> Result<Self, Failure> {
        use sqlx_core::connection::ConnectOptions as _;
        let options: PgConnectOptions = url.expose_secret().parse().map_err(|_| Failure)?;
        if !(1..=20).contains(&max_connections) {
            return Err(Failure);
        }
        if loopback_test
            && !options
                .get_host()
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        {
            return Err(Failure);
        }
        let options = options
            .ssl_mode(if loopback_test {
                sqlx_postgres::PgSslMode::Disable
            } else {
                sqlx_postgres::PgSslMode::VerifyFull
            })
            .statement_cache_capacity(0)
            .disable_statement_logging();
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(1))
            .connect_with(options)
            .await
            .map_err(|_| Failure)?;
        let this = Self { pool };
        // The same short transaction/deadline policy protects readiness probes.
        tokio::time::timeout(Duration::from_secs(7), async {
            let mut tx=this.pool.begin().await.map_err(|_| Failure)?;
            sqlx_core::query::query("SET LOCAL statement_timeout = '5s'").persistent(false).execute(&mut *tx).await.map_err(|_| Failure)?;
            for signature in [
                "ledger.gateway_context(uuid,uuid,integer,integer)",
                "ledger.call_claim(uuid,uuid,integer,integer,uuid,text,text,jsonb)",
                "ledger.call_complete(uuid,uuid,integer,integer,uuid,jsonb,boolean)",
                "ledger.call_read(uuid,uuid,integer,integer,uuid)",
                "ledger.hold(uuid,uuid,bigint,text,text,integer,integer,integer,integer,text,bigint,text,integer,jsonb)",
                "ledger.extend(uuid,bigint,integer,integer,integer)",
                "ledger.settle(uuid,bigint,jsonb)", "ledger.release(uuid,jsonb)",
            ] {
                sqlx_core::query::query("SELECT $1::text::regprocedure").bind(signature).persistent(false).execute(&mut *tx).await.map_err(|_| Failure)?;
            }
            tx.commit().await.map_err(|_| Failure)
        }).await.map_err(|_| Failure)??;
        Ok(this)
    }

    async fn call(&self, op: &Operation) -> Result<Value, Failure> {
        let mut tx = self.pool.begin().await.map_err(|_| Failure)?;
        sqlx_core::query::query("SET LOCAL lock_timeout = '2s'")
            .persistent(false)
            .execute(&mut *tx)
            .await
            .map_err(|_| Failure)?;
        sqlx_core::query::query("SET LOCAL statement_timeout = '5s'")
            .persistent(false)
            .execute(&mut *tx)
            .await
            .map_err(|_| Failure)?;
        // Dropping a timed-out transaction rolls it back before SQLx reuses it.
        let query = match op {
            Operation::Context(i) => sqlx_core::query::query("SELECT ledger.gateway_context($1::uuid,$2::uuid,$3::int,$4::int) AS result")
                .bind(i.subject).bind(i.app).bind(i.account_epoch).bind(i.grant_generation),
            Operation::Claim { identity:i, call, key, fingerprint, request } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.call_claim($1::uuid,$2::uuid,$3::int,$4::int,$5::uuid,$6::text,$7::text,$8::jsonb) r")
                .bind(i.subject).bind(i.app).bind(i.account_epoch).bind(i.grant_generation).bind(call).bind(key).bind(fingerprint).bind(request),
            Operation::Read { identity:i, call } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.call_read($1::uuid,$2::uuid,$3::int,$4::int,$5::uuid) r")
                .bind(i.subject).bind(i.app).bind(i.account_epoch).bind(i.grant_generation).bind(call),
            Operation::Complete { identity:i, call, completion, no_hold } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.call_complete($1::uuid,$2::uuid,$3::int,$4::int,$5::uuid,$6::jsonb,$7::bool) r")
                .bind(i.subject).bind(i.app).bind(i.account_epoch).bind(i.grant_generation).bind(call).bind(completion).bind(no_hold),
            Operation::Hold { identity:i, call, amount_milli, model, rate_card, catalog, consented_markup, provider } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.hold($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::int,$7::int,$8::int,$9::int,$10::text,$11::bigint,$12::text,$13::int,$14::jsonb) r")
                .bind(i.subject).bind(i.app).bind(amount_milli).bind(format!("{call}:1")).bind(call.to_string()).bind(1_i32).bind(300_i32).bind(i.account_epoch).bind(i.grant_generation).bind(model).bind(rate_card).bind(catalog).bind(consented_markup).bind(serde_json::json!({"provider":provider})),
            Operation::Extend { identity:i, hold, amount_milli } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.extend($1::uuid,$2::bigint,$3::int,$4::int,$5::int) r")
                .bind(hold).bind(amount_milli).bind(300_i32).bind(i.account_epoch).bind(i.grant_generation),
            Operation::Settle { hold, cost_nusd, usage } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.settle($1::uuid,$2::bigint,$3::jsonb) r")
                .bind(hold).bind(cost_nusd).bind(usage),
            Operation::Release { hold, usage } => sqlx_core::query::query("SELECT to_jsonb(r) AS result FROM ledger.release($1::uuid,$2::jsonb) r")
                .bind(hold).bind(usage),
        };
        let row = query
            .persistent(false)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| Failure)?;
        let value = row.try_get("result").map_err(|_| Failure)?;
        tx.commit().await.map_err(|_| Failure)?;
        Ok(value)
    }
}
#[async_trait]
impl Ledger for Postgres {
    async fn execute(&self, op: &Operation) -> Result<Value, Failure> {
        tokio::time::timeout(Duration::from_secs(7), self.call(op))
            .await
            .map_err(|_| Failure)?
    }
}

/// Retry an uncertain transport outcome once, preserving every operation field.
pub async fn recover(ledger: &dyn Ledger, op: &Operation) -> Result<Value, Failure> {
    match ledger.execute(op).await {
        Ok(v) => Ok(v),
        Err(_) => ledger.execute(op).await,
    }
}
