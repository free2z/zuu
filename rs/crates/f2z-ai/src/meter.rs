//! Durable single-model admission, settlement, and public receipt projection.
//! Provider work is authorized only by a new durable claim and a confirmed hold.

use crate::{
    admission::CallHandle,
    auth::Principal,
    call::Upstream,
    catalog::VerifiedCatalog,
    chat::ChatBackend,
    error::ApiFailure,
    ledger::{self, Identity, Ledger, Operation},
    provider::{ProviderBackend, ProviderOutcome, UsageReport},
    settle::{CallRecord, Settler},
};
use async_trait::async_trait;
use f2z_ai_proto::{ErrorCode, Event, Milli2z, Whole2z};
use f2z_ai_proto::{
    catalog::CatalogModel,
    chat::{ChatRequest, ContentPart, EstimateResponse, FinishReason, Usage, UsageSource},
    event::{Done, ErrorEvent, Meta, UsageEvent},
    pricing::{Bps, apply_safety_factor, metered_cost_nusd, price_nusd},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn unavailable() -> ApiFailure {
    ApiFailure::new(
        ErrorCode::Unavailable,
        "ledger operation remains unconfirmed",
    )
    .retry_after(1)
}
fn invalid() -> ApiFailure {
    ApiFailure::new(ErrorCode::Internal, "ledger or pricing contract refused")
}
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn status(v: &Value) -> Result<&str, ApiFailure> {
    v.get("status").and_then(Value::as_str).ok_or_else(invalid)
}
fn money(v: &Value, key: &str) -> Result<u64, ApiFailure> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n <= SAFE_INTEGER)
        .ok_or_else(invalid)
}
fn whole(milli: u64) -> Result<Whole2z, ApiFailure> {
    Milli2z::new(milli).to_whole_exact().ok_or_else(invalid)
}
fn refusal(s: &str) -> ApiFailure {
    let code = match s {
        "revoked" => ErrorCode::TokenRevoked,
        "frozen" => ErrorCode::AccountFrozen,
        "in_debt" => ErrorCode::AccountInDebt,
        "cap_exceeded" => ErrorCode::CapExceeded,
        "insufficient_balance" => ErrorCode::InsufficientBalance,
        "too_many_holds" => ErrorCode::TooManyHolds,
        "unknown_rate_card" | "markup_mismatch" => ErrorCode::CatalogUnavailable,
        _ => return invalid(),
    };
    ApiFailure::new(code, "ledger refused admission")
}

#[derive(Clone, Deserialize)]
struct Context {
    available_milli_2z: u64,
    cap_remaining_milli_2z: Option<u64>,
    debt_milli_2z: u64,
    open_holds: u32,
    frozen: bool,
    consented_markup_bps: u32,
    effective_markup_bps: u32,
}
impl Context {
    fn parse(v: Value) -> Result<Self, ApiFailure> {
        if status(&v)? != "ok" {
            return Err(refusal(status(&v)?));
        }
        if v.get("cap_remaining_milli_2z").is_none() {
            return Err(invalid());
        }
        let c: Self = serde_json::from_value(v).map_err(|_| invalid())?;
        if c.available_milli_2z > SAFE_INTEGER
            || c.cap_remaining_milli_2z.is_some_and(|n| n > SAFE_INTEGER)
            || c.debt_milli_2z > SAFE_INTEGER
            || c.consented_markup_bps > 10_000
            || c.effective_markup_bps > 10_000
            || c.open_holds > i32::MAX as u32
        {
            return Err(invalid());
        }
        Ok(c)
    }
    fn markup(&self) -> Bps {
        Bps(self.consented_markup_bps.min(self.effective_markup_bps))
    }
    fn spendable(&self) -> Result<u64, ApiFailure> {
        if self.frozen {
            return Err(refusal("frozen"));
        }
        if self.debt_milli_2z != 0 {
            return Err(refusal("in_debt"));
        }
        Ok(self
            .cap_remaining_milli_2z
            .map_or(self.available_milli_2z, |cap| {
                cap.min(self.available_milli_2z)
            }))
    }
}

#[derive(Clone)]
struct Plan {
    model: CatalogModel,
    input: u64,
    output: u64,
    hold: Whole2z,
    markup: Bps,
    margin: Bps,
}
impl Plan {
    fn worst(&self, output: u64) -> Result<Whole2z, ApiFailure> {
        let mut prices = self.model.prices;
        prices.input_nusd_per_mtok = prices
            .input_nusd_per_mtok
            .max(prices.cached_input_nusd_per_mtok)
            .max(prices.cache_write_nusd_per_mtok);
        let usage = Usage {
            input_tokens: self.input,
            output_tokens: output,
            tool_calls: if prices.tool_call_nusd > 0 { 8 } else { 0 },
            ..Usage::default()
        };
        let cost = metered_cost_nusd(&usage, &prices).map_err(|_| invalid())?;
        price_nusd(cost, self.margin, self.markup, self.model.min_charge_2z)
            .map(|c| c.total_2z())
            .map_err(|_| invalid())
    }
    fn estimate(&self, c: &Context, version: u64) -> EstimateResponse {
        EstimateResponse {
            model: self.model.id.clone(),
            input_tokens: self.input,
            max_output_tokens: self.output,
            hold_2z: self.hold,
            min_charge_2z: Some(self.model.min_charge_2z),
            available_milli_2z: Some(Milli2z::new(c.available_milli_2z)),
            cap_remaining_milli_2z: Some(c.cap_remaining_milli_2z.map(Milli2z::new)),
            catalog_version: Some(version),
        }
    }
}
fn plan(request: &ChatRequest, catalog: &VerifiedCatalog, c: &Context) -> Result<Plan, ApiFailure> {
    if !request.fallback.is_empty()
        || request.messages.iter().any(|m| {
            m.content
                .iter()
                .any(|p| !matches!(p, ContentPart::Text { .. }))
        })
    {
        return Err(ApiFailure::new(
            ErrorCode::InvalidRequest,
            "this gateway release supports text input and a single model",
        ));
    }
    let catalog = catalog.catalog();
    let model = catalog
        .callable_model(&request.model)
        .ok_or_else(|| ApiFailure::new(ErrorCode::ModelNotFound, "model is not callable"))?
        .clone();
    if !model.capabilities.tools
        && (!request.tools.is_empty()
            || request
                .messages
                .iter()
                .any(|m| !m.tool_calls.is_empty() || m.tool_call_id.is_some()))
    {
        return Err(ApiFailure::new(
            ErrorCode::InvalidRequest,
            "this model does not support function tools",
        ));
    }
    // Conservative byte-token reservation, including roles, message framing,
    // tool definitions and prior tool arguments/results. Metadata is excluded.
    // Final billing uses provider usage, never this byte bound.
    let bytes = serde_json::to_vec(&(&request.messages, &request.tools))
        .map_err(|_| invalid())?
        .len();
    let input = apply_safety_factor(
        u64::try_from(bytes)
            .map_err(|_| invalid())?
            .saturating_add(64),
        model.safety_factor_bps,
    )
    .map_err(|_| invalid())?;
    crate::provider::strict_model_ceiling(request, &model)?;
    // `strict`: the output the caller asked for, which nothing below may
    // lower. `chat::validate` guarantees `max_output_tokens` is present.
    let strict = request
        .max_output_tokens
        .filter(|_| request.max_output_tokens_strict);
    // With `strict`, every window refusal says why and with what numbers.
    let window_refusal = |message: &'static str| {
        let failure = ApiFailure::new(ErrorCode::ContextLengthExceeded, message);
        match strict {
            Some(asked) => failure
                .detail("reason", crate::provider::STRICT_OUTPUT_REASON)
                .detail("input_tokens_estimate", input)
                .detail("context_window", model.context_window)
                .detail("max_output_tokens", asked),
            None => failure,
        }
    };
    let window = model
        .context_window
        .checked_sub(input)
        .ok_or_else(|| window_refusal("input exceeds context window"))?;
    let ceiling = window
        .min(model.max_output_tokens)
        .min(request.max_output_tokens.unwrap_or(model.max_output_tokens));
    if ceiling == 0 {
        return Err(window_refusal("no output fits context window"));
    }
    if let Some(asked) = strict
        && ceiling < asked
    {
        // The model ceiling was refused above, so only the window is left.
        return Err(window_refusal(
            "the input leaves less than max_output_tokens of the context window, and max_output_tokens_strict forbids lowering it",
        ));
    }
    let consented = Bps(c.consented_markup_bps);
    let mut p = Plan {
        model,
        input,
        output: ceiling,
        hold: Whole2z::ZERO,
        markup: c.markup(),
        margin: catalog.platform_margin_bps,
    };
    let available = c.spendable()? / 1000;
    let short = || {
        if c.cap_remaining_milli_2z
            .is_some_and(|cap| cap < c.available_milli_2z)
        {
            "cap_exceeded"
        } else {
            "insufficient_balance"
        }
    };
    if let Some(asked) = strict {
        // No clamp: the worst case of the full requested output must fit, or
        // the call is refused here — before the hold, so nothing is reserved,
        // charged or sent to a provider.
        //
        // Affordability is judged at the grant's **consented** markup, the
        // most the ledger can apply (`b = min(consented, effective)`,
        // metering.md §3 `hold`). Judging at the effective markup alone would
        // let an approval landing between the context read and the hold raise
        // the price after the hold exists, and the post-hold `extend` would
        // then refuse a call that had already reserved money.
        let mut bound = p.clone();
        bound.markup = consented;
        let required = bound.worst(asked)?;
        if required.get() > available {
            let mut failure = refusal(short())
                .detail("reason", crate::provider::STRICT_OUTPUT_REASON)
                .detail("max_output_tokens", asked)
                .detail("required_2z", required.get())
                .detail("available_milli_2z", c.available_milli_2z)
                .detail("min_charge_2z", p.model.min_charge_2z.get());
            if let Some(cap) = c.cap_remaining_milli_2z {
                failure = failure.detail("cap_remaining_milli_2z", cap);
            }
            return Err(failure);
        }
        p.output = asked;
        p.hold = p.worst(asked)?;
        return Ok(p);
    }
    if p.worst(1)?.get() > available {
        return Err(refusal(short()));
    }
    let (mut low, mut high) = (1, ceiling);
    while low < high {
        let mid = low
            .checked_add(high.saturating_sub(low).div_ceil(2))
            .ok_or_else(invalid)?;
        if p.worst(mid)?.get() <= available {
            low = mid;
        } else {
            high = mid.saturating_sub(1);
        }
    }
    p.output = low;
    p.hold = p.worst(low)?;
    Ok(p)
}

struct Active {
    identity: Identity,
    id: Uuid,
    plan: Mutex<Option<Plan>>,
    request_meta: Value,
    hold: Mutex<Option<Operation>>,
    hold_id: Mutex<Option<Uuid>>,
    completion: Mutex<Option<Value>>,
    provider_started: Mutex<bool>,
    output_bytes: Mutex<u64>,
    final_record: Mutex<Option<Value>>,
}

/// Production backend and settler share a bounded map: one entry per admitted
/// call, removed only by the existing detached settlement owner.
pub struct Metered {
    ledger: Arc<dyn Ledger>,
    provider: Arc<dyn ChatBackend>,
    active: Mutex<BTreeMap<u64, Arc<Active>>>,
    configured: Option<std::collections::BTreeSet<String>>,
    allowed_models: Option<std::collections::BTreeSet<String>>,
}
impl Metered {
    /// Share this same instance between gateway backend and detached settler.
    pub fn new(ledger: Arc<dyn Ledger>, provider: ProviderBackend) -> Self {
        let configured = provider.configured_providers();
        let mut backend = Self::with_provider(ledger, Arc::new(provider));
        backend.configured = Some(configured);
        backend
    }
    /// Injectable provider seam for bounded fault tests.
    pub fn with_provider(ledger: Arc<dyn Ledger>, provider: Arc<dyn ChatBackend>) -> Self {
        Self {
            ledger,
            provider,
            active: Mutex::new(BTreeMap::new()),
            configured: None,
            allowed_models: None,
        }
    }
    /// Restrict new paid work to reviewed model IDs while preserving old receipts.
    #[must_use]
    pub fn with_allowed_models(
        mut self,
        models: Option<std::collections::BTreeSet<String>>,
    ) -> Self {
        self.allowed_models = models;
        self
    }
    fn model_allowed(&self, model: &str) -> bool {
        self.allowed_models
            .as_ref()
            .is_none_or(|models| models.contains(model))
    }
    fn require_model(&self, model: &str) -> Result<(), ApiFailure> {
        if self.model_allowed(model) {
            return Ok(());
        }
        Err(ApiFailure::new(
            ErrorCode::ModelDisabled,
            "model is not enabled for new calls",
        )
        .detail("model", model))
    }
    async fn context(&self, p: &Principal) -> Result<(Identity, Context), ApiFailure> {
        let identity = Identity::try_from(p).map_err(|_| invalid())?;
        let c = ledger::recover(self.ledger.as_ref(), &Operation::Context(identity))
            .await
            .map_err(|_| unavailable())?;
        Ok((identity, Context::parse(c)?))
    }
}

#[async_trait]
impl ChatBackend for Metered {
    async fn models(
        &self,
        catalog: Arc<VerifiedCatalog>,
        principal: &Principal,
    ) -> Result<Value, ApiFailure> {
        let (_, c) = self.context(principal).await?;
        let cat = catalog.catalog();
        let models=cat.models.iter().filter(|m| self.model_allowed(&m.id) && cat.callable_model(&m.id).is_some() && self.configured.as_ref().is_none_or(|providers|providers.contains(&m.provider))).map(|m| {
            let mut prices=serde_json::Map::new();
            for (name, rate) in [("input_milli_2z_per_mtok",m.prices.input_nusd_per_mtok),("cached_input_milli_2z_per_mtok",m.prices.cached_input_nusd_per_mtok),("cache_write_milli_2z_per_mtok",m.prices.cache_write_nusd_per_mtok),("output_milli_2z_per_mtok",m.prices.output_nusd_per_mtok),("image_milli_2z",m.prices.image_nusd),("tool_call_milli_2z",m.prices.tool_call_nusd)] {
                let numerator=u128::from(rate).checked_mul(u128::from(cat.platform_margin_bps.0)+10_000).and_then(|n| n.checked_mul(u128::from(c.markup().0)+10_000)).ok_or_else(invalid)?;
                let n=u64::try_from(numerator.div_ceil(1_000_000_000_000)).map_err(|_| invalid())?;
                if n > SAFE_INTEGER { return Err(invalid()); } prices.insert(name.into(),json!(n));
            }
            Ok(json!({"id":m.id,"provider":m.provider,"display_name":m.id,"context_window":m.context_window,"max_output_tokens":m.max_output_tokens,"capabilities":{"vision":false,"tools":m.capabilities.tools,"reasoning":m.capabilities.reasoning},"prices":prices,"min_charge_2z":m.min_charge_2z,"ttfb_timeout_ms":m.ttfb_timeout_ms}))
        }).collect::<Result<Vec<_>, ApiFailure>>()?;
        Ok(
            json!({"catalog_version":cat.version,"includes_markup_bps":c.markup().0,"models":models}),
        )
    }
    async fn estimate(
        &self,
        request: ChatRequest,
        catalog: Arc<VerifiedCatalog>,
        principal: &Principal,
    ) -> Result<Value, ApiFailure> {
        self.require_model(&request.model)?;
        let (_, c) = self.context(principal).await?;
        serde_json::to_value(plan(&request, &catalog, &c)?.estimate(&c, catalog.catalog().version))
            .map_err(|_| invalid())
    }
    async fn receipt(&self, id: &str, principal: &Principal) -> Result<Value, ApiFailure> {
        let identity = Identity::try_from(principal).map_err(|_| invalid())?;
        let call = id
            .parse()
            .map_err(|_| ApiFailure::new(ErrorCode::CallNotFound, "call not found"))?;
        let row = ledger::recover(self.ledger.as_ref(), &Operation::Read { identity, call })
            .await
            .map_err(|_| unavailable())?;
        match status(&row)? {
            "found" => project(row.get("record").ok_or_else(invalid)?, false),
            "not_found" => Err(ApiFailure::new(ErrorCode::CallNotFound, "call not found")),
            "revoked" => Err(refusal("revoked")),
            _ => Err(invalid()),
        }
    }
    async fn start(
        &self,
        mut request: ChatRequest,
        catalog: Arc<VerifiedCatalog>,
        call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        let principal = call.principal().ok_or_else(invalid)?;
        let identity = Identity::try_from(principal).map_err(|_| invalid())?;
        let body = serde_json::to_vec(&request).map_err(|_| invalid())?;
        let fingerprint = ring::digest::digest(&ring::digest::SHA256, &body)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let id = Uuid::now_v7();
        let provider = catalog
            .catalog()
            .models
            .iter()
            .find(|m| m.id == request.model)
            .map_or("unavailable", |m| m.provider.as_str());
        let request_meta = json!({"model":request.model,"requested_model":request.model,"provider":provider,"catalog_version":catalog.catalog().version,"metadata":request.metadata});
        let claim = Operation::Claim {
            identity,
            call: id,
            key: call.idempotency_key().map(str::to_owned),
            fingerprint,
            request: request_meta.clone(),
        };
        let active = Arc::new(Active {
            identity,
            id,
            plan: Mutex::new(None),
            request_meta,
            hold: Mutex::new(None),
            hold_id: Mutex::new(None),
            completion: Mutex::new(None),
            provider_started: Mutex::new(false),
            output_bytes: Mutex::new(0),
            final_record: Mutex::new(None),
        });
        lock(&self.active).insert(call.id(), Arc::clone(&active));
        let row = ledger::recover(self.ledger.as_ref(), &claim)
            .await
            .map_err(|_| unavailable().detail("call_id", id.to_string()))?;
        let existing = row.get("call_id").and_then(Value::as_str);
        if status(&row)? != "claimed" {
            // This request did not win admission. Its settlement guard must not
            // complete/release the already-running call owned by another request.
            lock(&self.active).remove(&call.id());
            return match status(&row)? {
                "replayed" => Ok(Box::new(Replay(project(
                    row.get("record").ok_or_else(invalid)?,
                    true,
                )?))),
                "pending" | "conflict" => Err(ApiFailure::new(
                    ErrorCode::IdempotencyConflict,
                    "idempotency key belongs to an existing call",
                )
                .detail("call_id", existing)),
                "revoked" => Err(refusal("revoked")),
                "not_found" => Err(ApiFailure::new(
                    ErrorCode::CallNotFound,
                    "call record expired",
                )),
                _ => Err(invalid()),
            };
        }
        if existing != Some(id.to_string().as_str()) {
            return Err(invalid());
        }
        // Replay precedes spendability: a completed call remains readable even
        // after its charge exhausted the current balance/cap.
        if let Err(refusal) = self.require_model(&request.model) {
            // Persist a terminal zero-charge refusal before returning. Otherwise
            // a disabled model would burn its key as an unfinished claim. Replay
            // above remains available even when deployment policy changes.
            *lock(&active.completion) = Some(json!({
                "model": request.model, "provider": provider, "finish_reason": "stop",
                "partial": false, "error": {"code": "model_disabled", "message": "model is not enabled for new calls"}
            }));
            finalize(self.ledger.as_ref(), &active)
                .await
                .map_err(|_| unavailable().detail("call_id", id.to_string()))?;
            return Err(refusal);
        }
        let admitted_context = Context::parse(row.get("context").ok_or_else(invalid)?.clone())?;
        let p = plan(&request, &catalog, &admitted_context)?;
        *lock(&active.plan) = Some(p.clone());
        let hold = Operation::Hold {
            identity,
            call: id,
            amount_milli: i64::try_from(p.hold.to_milli().ok_or_else(invalid)?.get())
                .map_err(|_| invalid())?,
            model: p.model.id.clone(),
            rate_card: i64::try_from(catalog.catalog().rate_card_version).map_err(|_| invalid())?,
            catalog: catalog.catalog().version.to_string(),
            consented_markup: i32::try_from(admitted_context.consented_markup_bps)
                .map_err(|_| invalid())?,
            provider: p.model.provider.clone(),
        };
        // Store intent BEFORE awaiting: a lost hold response still has a recovery owner.
        *lock(&active.hold) = Some(hold.clone());
        let (held, ambiguous) = match self.ledger.execute(&hold).await {
            Ok(row) => (row, false),
            Err(_) => (
                self.ledger
                    .execute(&hold)
                    .await
                    .map_err(|_| unavailable().detail("call_id", id.to_string()))?,
                true,
            ),
        };
        if !matches!(status(&held)?, "held" | "replayed") {
            // Refusal after a lost response cannot prove that the first hold did
            // not commit. Keep its intent for captured-identity completion recovery.
            if !ambiguous
                && matches!(
                    status(&held)?,
                    "revoked"
                        | "frozen"
                        | "unknown_rate_card"
                        | "markup_mismatch"
                        | "in_debt"
                        | "too_many_holds"
                        | "cap_exceeded"
                        | "insufficient_balance"
                )
            {
                *lock(&active.hold) = None;
            }
            return Err(refusal(status(&held)?));
        }
        if held.get("state").and_then(Value::as_str) != Some("open") {
            return Err(unavailable().detail("call_id", id.to_string()));
        }
        // Success rows are nullable in the SQL ABI only for other statuses.
        // Validate every required success field before any provider request.
        let hold_id: Uuid = held
            .get("hold_id")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        let reserved = money(&held, "amount")?;
        if reserved == 0 {
            return Err(invalid());
        }
        money(&held, "available")?;
        match held.get("cap_remaining") {
            Some(Value::Null) => {}
            Some(_) => {
                money(&held, "cap_remaining")?;
            }
            None => return Err(invalid()),
        }
        if held
            .get("expires_at")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(invalid());
        }
        *lock(&active.hold_id) = Some(hold_id);
        let applied = held
            .get("applied_markup_bps")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 10_000)
            .ok_or_else(invalid)?;
        let mut actual = p.clone();
        actual.markup = Bps(u32::try_from(applied).map_err(|_| invalid())?);
        actual.hold = actual.worst(actual.output)?;
        if actual.hold.to_milli().ok_or_else(invalid)?.get() > reserved {
            let extended = ledger::recover(
                self.ledger.as_ref(),
                &Operation::Extend {
                    identity,
                    hold: hold_id,
                    amount_milli: Some(
                        i64::try_from(actual.hold.to_milli().ok_or_else(invalid)?.get())
                            .map_err(|_| invalid())?,
                    ),
                },
            )
            .await
            .map_err(|_| unavailable())?;
            if status(&extended)? != "held" {
                return Err(refusal(status(&extended)?));
            }
            if extended.get("state").and_then(Value::as_str) != Some("open")
                || money(&extended, "amount")? < actual.hold.to_milli().ok_or_else(invalid)?.get()
            {
                return Err(invalid());
            }
            money(&extended, "available")?;
            if extended.get("cap_remaining").is_none()
                || extended
                    .get("expires_at")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return Err(invalid());
            }
        } else {
            actual.hold = whole(reserved)?;
        }
        *lock(&active.plan) = Some(actual.clone());
        request.max_output_tokens = Some(actual.output);
        let upstream = self.provider.start(request, catalog, call).await?;
        *lock(&active.provider_started) = true;
        let mut meta = Meta::new(id.to_string(), actual.model.id.clone(), actual.hold);
        meta.requested_model = Some(actual.model.id.clone());
        meta.provider = Some(actual.model.provider.clone());
        meta.max_output_tokens = Some(actual.output);
        meta.input_tokens_estimate = Some(actual.input);
        Ok(Box::new(MeterStream {
            upstream,
            active,
            ledger: Arc::clone(&self.ledger),
            meta: Some(meta),
            queued: VecDeque::new(),
            terminal: None,
            ended: false,
            outcome: None,
            heartbeat: Box::pin(tokio::time::sleep(Duration::from_secs(60))),
            extending: None,
        }))
    }
}

/// Project only public, checked fields; never forward internal settlement usage
/// metadata, transfer IDs, raw SQL errors, or the ledger envelope wholesale.
#[allow(clippy::indexing_slicing)] // Every indexed write targets the object constructed by json! below.
fn project(record: &Value, replayed: bool) -> Result<Value, ApiFailure> {
    let state = status(record)?;
    if !matches!(
        state,
        "streaming" | "settling" | "settled" | "settled_partial" | "released"
    ) {
        return Err(invalid());
    }
    let id = record
        .get("call_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let _: Uuid = id.parse().map_err(|_| invalid())?;
    let request = record
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let mut out = json!({"call_id":id,"status":state,"replayed":replayed});
    for key in [
        "model",
        "requested_model",
        "provider",
        "catalog_version",
        "metadata",
    ] {
        out[key] = request.get(key).ok_or_else(invalid)?.clone();
    }
    for key in ["created_at", "settled_at"] {
        out[key] = record.get(key).ok_or_else(invalid)?.clone();
    }
    if let Some(completion) = record.get("completion").filter(|v| !v.is_null()) {
        for key in ["finish_reason", "usage_source"] {
            if let Some(v) = completion.get(key) {
                out[key] = v.clone();
            }
        }
        if let Some(usage) = completion.get("usage") {
            let usage: Usage = serde_json::from_value(usage.clone()).map_err(|_| invalid())?;
            out["usage"] = serde_json::to_value(usage).map_err(|_| invalid())?;
        }
        if let Some(error) = completion.get("error") {
            out["error"] = error.clone();
        }
    }
    if let Some(error) = record.get("error").filter(|v| !v.is_null()) {
        out["error"] = json!({"code":error.get("code").and_then(Value::as_str).ok_or_else(invalid)?,"message":error.get("message").and_then(Value::as_str).ok_or_else(invalid)?});
    }
    // A call, not an individual hold, determines terminality.
    if state == "released" {
        out["charged_2z"] = json!(0);
    }
    if let Some(s) = record.get("settlement").filter(|v| !v.is_null()) {
        let held = whole(money(s, "hold_milli_2z")?)?;
        out["hold_2z"] = json!(held);
        if matches!(state, "settled" | "settled_partial") {
            if s.get("outcome").and_then(Value::as_str) != Some("settled") {
                return Err(invalid());
            }
            let priced = money(s, "priced_milli_2z")?;
            let charged = whole(priced)?;
            let collected = money(s, "collected_milli_2z")?;
            let shortfall = money(s, "shortfall_milli_2z")?;
            if charged == Whole2z::ZERO
                || shortfall > priced.saturating_sub(held.to_milli().ok_or_else(invalid)?.get())
                || collected.checked_add(shortfall) != Some(priced)
            {
                return Err(invalid());
            }
            let hold: Uuid = s
                .get("hold_id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?;
            out["charged_2z"] = json!(charged);
            out["receipt_id"] = json!(format!("rcpt_{hold}"));
            out["collected_milli_2z"] = json!(collected);
            out["shortfall_milli_2z"] = json!(shortfall);
            out["released_2z"] = json!(held.saturating_sub(charged));
            out["markup_bps"] = s.get("applied_markup_bps").ok_or_else(invalid)?.clone();
        } else if state == "released" {
            out["released_2z"] = json!(held);
        }
    } else if matches!(state, "settled" | "settled_partial") {
        return Err(invalid());
    }
    Ok(out)
}

#[allow(clippy::indexing_slicing)] // Writes target the locally constructed JSON object, never an array.
fn completion(active: &Active, outcome: Option<&ProviderOutcome>) -> Value {
    let bytes = *lock(&active.output_bytes);
    let reported = outcome.and_then(|o| o.usage.reported());
    let error = if let Some(f) = outcome.and_then(|o| o.failure.as_ref()) {
        json!({"code":f.code,"message":"provider call failed"})
    } else if outcome.is_none() {
        json!({"code":"unavailable","message":"gateway stopped before provider completion"})
    } else if reported.is_none() {
        // No tokenizer-backed fallback yet: fail this unsupported billing path,
        // release the hold, and make the platform absorb unknown provider cost.
        // Never manufacture zero usage or bill a UTF-8 byte count as tokens.
        json!({"code":"provider_error","message":"provider usage unavailable; this gateway cannot meter the response"})
    } else {
        Value::Null
    };
    let mut value = json!({"model":active.request_meta.get("model"),"provider":active.request_meta.get("provider"),"finish_reason":outcome.and_then(|o|o.finish_reason).unwrap_or(FinishReason::Stop),"partial":bytes>0 && !error.is_null(),"error":error});
    if let Some(usage) = reported {
        value["usage"] = json!(usage);
        value["usage_source"] = json!("provider");
    }
    value
}

async fn finalize(ledger: &dyn Ledger, active: &Active) -> Result<Value, ApiFailure> {
    if let Some(record) = lock(&active.final_record).clone() {
        return Ok(record);
    }
    let intent = lock(&active.completion).clone().ok_or_else(invalid)?;
    // Completion is authorized by CAPTURED admission epochs, not today's grant.
    // Persist intent first; this also recovers a committed hold whose reply was
    // lost, without re-running authorization or ever creating a new reservation.
    let complete = Operation::Complete {
        identity: active.identity,
        call: active.id,
        completion: intent.clone(),
        no_hold: lock(&active.hold).is_none(),
    };
    let first = ledger::recover(ledger, &complete)
        .await
        .map_err(|_| unavailable())?;
    if status(&first)? == "not_found" && !*lock(&active.provider_started) {
        return Ok(Value::Null);
    }
    if !matches!(status(&first)?, "recorded" | "replayed") {
        return Err(invalid());
    }
    let record = first.get("record").ok_or_else(invalid)?;
    let late_cost = status(record)? == "released"
        && *lock(&active.provider_started)
        && intent.get("usage").is_some();
    if matches!(status(record)?, "settled" | "settled_partial" | "released") && !late_cost {
        let public = project(record, false)?;
        *lock(&active.final_record) = Some(public.clone());
        return Ok(public);
    }
    let attempts = record
        .get("attempts")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if attempts.len() > 1 {
        return Err(invalid());
    } // This release admits one attempt.
    let known = *lock(&active.hold_id);
    let recovered = attempts
        .first()
        .map(|a| {
            a.get("hold_id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .parse::<Uuid>()
                .map_err(|_| invalid())
        })
        .transpose()?;
    if known.is_some() && recovered.is_some() && known != recovered {
        return Err(invalid());
    }
    let Some(hold) = known.or(recovered) else {
        return Err(unavailable());
    };
    *lock(&active.hold_id) = Some(hold);
    let failed = !intent.get("error").is_none_or(Value::is_null);
    let output = *lock(&active.output_bytes) > 0;
    let usage = intent
        .get("usage")
        .map(|v| serde_json::from_value::<Usage>(v.clone()).map_err(|_| invalid()))
        .transpose()?;
    let operation = if !late_cost
        && (!*lock(&active.provider_started) || (failed && !output) || usage.is_none())
    {
        Operation::Release {
            hold,
            usage: json!({}),
        }
    } else {
        let usage = usage.ok_or_else(invalid)?;
        let p = lock(&active.plan).clone().ok_or_else(invalid)?;
        let cost = metered_cost_nusd(&usage, &p.model.prices).map_err(|_| invalid())?;
        Operation::Settle {
            hold,
            cost_nusd: i64::try_from(cost.get()).map_err(|_| invalid())?,
            usage: serde_json::to_value(usage).map_err(|_| invalid())?,
        }
    };
    let result = ledger::recover(ledger, &operation)
        .await
        .map_err(|_| unavailable())?;
    if !matches!(
        status(&result)?,
        "settled" | "released" | "expired" | "not_open"
    ) {
        return Err(invalid());
    }
    // A terminal winner (including an expired/released hold) is authoritative;
    // never derive amounts from the operation we hoped would commit.
    let done = ledger::recover(ledger, &complete)
        .await
        .map_err(|_| unavailable())?;
    if !matches!(status(&done)?, "recorded" | "replayed") {
        return Err(invalid());
    }
    let public = project(done.get("record").ok_or_else(invalid)?, false)?;
    if matches!(status(&public)?, "streaming" | "settling") {
        return Err(unavailable());
    }
    *lock(&active.final_record) = Some(public.clone());
    Ok(public)
}

fn terminal_unchecked(active: &Active, record: Option<&Value>) -> Event {
    let Some(p) = lock(&active.plan).clone() else {
        return Event::Error(ErrorEvent::uncharged(
            ErrorCode::Internal,
            "missing admission plan",
        ));
    };
    let intent = lock(&active.completion).clone().unwrap_or(Value::Null);
    let finish = intent
        .get("finish_reason")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(FinishReason::Stop);
    let source = if intent.get("usage_source").and_then(Value::as_str) == Some("provider") {
        UsageSource::Provider
    } else {
        UsageSource::Estimated
    };
    let mut done = Done::pending(p.hold, finish);
    done.usage_source = source;
    if let Some(r) = record {
        if r.get("status").and_then(Value::as_str) == Some("released") {
            done = Done::released(p.hold, finish);
        } else if let (Some(charge), Some(receipt)) = (
            r.get("charged_2z").and_then(Value::as_u64),
            r.get("receipt_id").and_then(Value::as_str),
        ) {
            done = Done::settled(Whole2z::new(charge), receipt, finish);
            done.hold_2z = Some(p.hold);
            done.released_2z = r
                .get("released_2z")
                .and_then(Value::as_u64)
                .map(Whole2z::new);
            done.collected_milli_2z = r
                .get("collected_milli_2z")
                .and_then(Value::as_u64)
                .map(Milli2z::new);
            done.shortfall_milli_2z = r
                .get("shortfall_milli_2z")
                .and_then(Value::as_u64)
                .map(Milli2z::new);
        }
    }
    done.usage_source = source;
    if let Some(error) = intent.get("error").filter(|v| !v.is_null()) {
        Event::Error(ErrorEvent {
            code: error
                .get("code")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(ErrorCode::Unavailable),
            message: "provider call failed".into(),
            settlement: done.settlement,
            charged_2z: done.charged_2z,
            receipt_id: done.receipt_id,
            collected_milli_2z: done.collected_milli_2z,
            shortfall_milli_2z: done.shortfall_milli_2z,
            partial: *lock(&active.output_bytes) > 0,
        })
    } else {
        Event::Done(done)
    }
}

fn terminal(active: &Active, record: Option<&Value>) -> Event {
    let event = terminal_unchecked(active, record);
    let valid = match &event {
        Event::Done(done) => done.check().is_ok(),
        Event::Error(error) => error.check().is_ok(),
        _ => false,
    };
    if valid {
        event
    } else {
        // A malformed final response never becomes a final charge on the wire.
        Event::Error(ErrorEvent {
            code: ErrorCode::Internal,
            message: "settlement result could not be validated".into(),
            settlement: f2z_ai_proto::settlement::Settlement::Pending,
            charged_2z: None,
            receipt_id: None,
            collected_milli_2z: None,
            shortfall_milli_2z: None,
            partial: *lock(&active.output_bytes) > 0,
        })
    }
}

type TerminalFuture = Pin<Box<dyn Future<Output = Option<Value>> + Send>>;
type ExtendFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
struct MeterStream {
    upstream: Box<dyn Upstream>,
    active: Arc<Active>,
    ledger: Arc<dyn Ledger>,
    meta: Option<Meta>,
    queued: VecDeque<Event>,
    terminal: Option<TerminalFuture>,
    ended: bool,
    outcome: Option<ProviderOutcome>,
    heartbeat: Pin<Box<tokio::time::Sleep>>,
    extending: Option<ExtendFuture>,
}
#[async_trait]
impl Upstream for MeterStream {
    fn call_id(&self) -> Option<String> {
        Some(self.active.id.to_string())
    }
    async fn next(&mut self) -> Option<Event> {
        loop {
            if let Some(event) = self.queued.pop_front() {
                return Some(event);
            }
            if self.ended {
                return None;
            }
            if let Some(future) = self.terminal.as_mut() {
                let record = future.await;
                self.terminal = None;
                self.ended = true;
                return Some(terminal(&self.active, record.as_ref()));
            }
            let event = tokio::select! {
                event=self.upstream.next()=>event,
                ()=&mut self.heartbeat=>{
                    let id=*lock(&self.active.hold_id);
                    if let Some(hold)=id {
                        let ledger=Arc::clone(&self.ledger); let identity=self.active.identity;
                        self.extending=Some(Box::pin(async move { let _=ledger::recover(ledger.as_ref(),&Operation::Extend {identity,hold,amount_milli:None}).await; }));
                    }
                    self.heartbeat.as_mut().reset(tokio::time::Instant::now().checked_add(Duration::from_secs(60)).unwrap_or_else(tokio::time::Instant::now));
                    continue;
                },
                ()=async { if let Some(future)=self.extending.as_mut() {future.await;} else {std::future::pending::<()>().await;} }=>{self.extending=None;continue;},
            };
            if let Some(event) = event {
                match &event {
                    Event::Delta(delta) => {
                        let mut n = lock(&self.active.output_bytes);
                        *n = n.saturating_add(u64::try_from(delta.text.len()).unwrap_or(u64::MAX));
                    }
                    Event::ToolCall(tool) => {
                        let mut n = lock(&self.active.output_bytes);
                        *n = n.saturating_add(
                            u64::try_from(tool.arguments.len()).unwrap_or(u64::MAX),
                        );
                    }
                    Event::Usage(_) => continue,
                    _ => {}
                }
                if let Some(meta) = self.meta.take() {
                    self.queued.push_back(event);
                    return Some(Event::Meta(meta));
                }
                return Some(event);
            }
            self.outcome = self.upstream.outcome();
            *lock(&self.active.completion) = Some(completion(&self.active, self.outcome.as_ref()));
            let success = self.outcome.as_ref().is_some_and(|o| o.failure.is_none());
            if success || *lock(&self.active.output_bytes) > 0 {
                if let Some(meta) = self.meta.take() {
                    self.queued.push_back(Event::Meta(meta));
                }
                let intent = lock(&self.active.completion).clone().unwrap_or(Value::Null);
                if let Some(usage) = intent
                    .get("usage")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                {
                    self.queued.push_back(Event::Usage(UsageEvent {
                        usage,
                        source: if self
                            .outcome
                            .as_ref()
                            .is_some_and(|o| matches!(o.usage, UsageReport::Reported(_)))
                        {
                            UsageSource::Provider
                        } else {
                            UsageSource::Estimated
                        },
                    }));
                }
            }
            let ledger = Arc::clone(&self.ledger);
            let active = Arc::clone(&self.active);
            self.terminal = Some(Box::pin(async move {
                tokio::time::timeout(Duration::from_secs(10), finalize(ledger.as_ref(), &active))
                    .await
                    .ok()
                    .and_then(Result::ok)
            }));
        }
    }
    fn outcome(&mut self) -> Option<ProviderOutcome> {
        self.outcome.clone().or_else(|| self.upstream.outcome())
    }
    fn keep_upload_reservation(&mut self, reservation: tokio::sync::OwnedSemaphorePermit) {
        self.upstream.keep_upload_reservation(reservation);
    }
}

#[async_trait]
impl Settler for Metered {
    async fn settle(&self, record: CallRecord) {
        let active = lock(&self.active).remove(&record.id);
        let Some(active) = active else {
            return;
        };
        if lock(&active.completion).is_none() {
            *lock(&active.completion) = Some(completion(&active, record.outcome.as_ref()));
        }
        // Bounded by the hold lifetime, and independently by server drain grace.
        let deadline = tokio::time::Instant::now()
            .checked_add(Duration::from_secs(300))
            .unwrap_or_else(tokio::time::Instant::now);
        loop {
            if finalize(self.ledger.as_ref(), &active).await.is_ok() {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                tracing::warn!(call_id=%active.id,"settlement unresolved; durable expiry recovery owns call");
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

struct Replay(Value);
#[async_trait]
impl Upstream for Replay {
    fn replay_record(&self) -> Option<Value> {
        Some(self.0.clone())
    }
    async fn next(&mut self) -> Option<Event> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_final_amounts_never_become_a_public_charge() {
        let mut record = json!({"call_id":Uuid::now_v7(),"status":"settled","request":{"model":"m","requested_model":"m","provider":"p","catalog_version":1,"metadata":{}},"created_at":"2026-09-27T00:00:00Z","settled_at":"2026-09-27T00:00:01Z","settlement":{"hold_id":Uuid::now_v7(),"outcome":"settled","hold_milli_2z":1000,"priced_milli_2z":1000,"collected_milli_2z":1000,"shortfall_milli_2z":0,"applied_markup_bps":0}});
        assert!(project(&record, false).is_ok());
        record["settlement"]["priced_milli_2z"] = json!(0);
        record["settlement"]["collected_milli_2z"] = json!(0);
        assert!(project(&record, false).is_err());
        record["settlement"]["priced_milli_2z"] = json!(1000);
        record["settlement"]["collected_milli_2z"] = json!(900);
        record["settlement"]["shortfall_milli_2z"] = json!(100);
        assert!(project(&record, false).is_err());
    }

    // free2z/zuu#1122: `max_output_tokens_strict` refuses instead of clamping.
    // ~100 output tokens per whole 2Z before margin, so a few 2Z of balance
    // is clamped well below the 1800 tokens AHA asks for.
    fn priced(context_window: u64) -> VerifiedCatalog {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        VerifiedCatalog::from_verified(
            serde_json::from_value(json!({
                "schema": 1, "version": 1, "issued_at": now - 60, "expires_at": now + 3600,
                "rate_card_version": 1, "platform_margin_bps": 2000,
                "models": [{
                    "id": "m", "provider": "p", "provider_model_id": "m-up",
                    "api_style": "openai_responses",
                    "prices": {"input_nusd_per_mtok": 1000, "cached_input_nusd_per_mtok": 100,
                               "cache_write_nusd_per_mtok": 1250,
                               "output_nusd_per_mtok": 100_000_000_000_u64,
                               "image_nusd": 0, "tool_call_nusd": 0},
                    "min_charge_2z": 1, "safety_factor_bps": 10000,
                    "context_window": context_window, "max_output_tokens": 8192,
                    "ttfb_timeout_ms": 10000, "enabled": true
                }]
            }))
            .unwrap(),
        )
        .unwrap()
    }
    fn ctx(available: u64, cap: Option<u64>) -> Context {
        ctx_markup(available, cap, 0, 0)
    }
    fn ctx_markup(available: u64, cap: Option<u64>, consented: u32, effective: u32) -> Context {
        Context::parse(json!({"status":"ok","available_milli_2z":available,
            "cap_remaining_milli_2z":cap,"debt_milli_2z":0,"open_holds":0,"frozen":false,
            "consented_markup_bps":consented,"effective_markup_bps":effective}))
        .unwrap()
    }
    fn ask(tokens: u64, strict: bool) -> ChatRequest {
        serde_json::from_value(json!({"model":"m","max_output_tokens":tokens,
            "max_output_tokens_strict":strict,
            "messages":[{"role":"user","content":[{"type":"text","text":"teach me"}]}]}))
        .unwrap()
    }
    fn strict_refusal(e: &ApiFailure, code: ErrorCode) {
        assert_eq!(e.code(), code.as_str(), "{e:?}");
        assert_eq!(
            e.detail_of("reason"),
            Some(&json!(crate::provider::STRICT_OUTPUT_REASON))
        );
    }

    #[test]
    fn strict_refuses_the_balance_clamp_that_the_default_applies() {
        let catalog = priced(200_000);
        let low = ctx(5_000, None);
        // Premise (the #1122 bug): by default the call is admitted, shorter.
        let clamped = plan(&ask(1800, false), &catalog, &low).unwrap();
        assert!(clamped.output < 1800, "{}", clamped.output);
        assert!(clamped.output > 0);
        // Strict: refused, with what it would have cost.
        let e = plan(&ask(1800, true), &catalog, &low).err().unwrap();
        strict_refusal(&e, ErrorCode::InsufficientBalance);
        assert_eq!(e.status().as_u16(), 402);
        let full = plan(&ask(1800, false), &catalog, &ctx(u64::from(u32::MAX), None)).unwrap();
        assert_eq!(e.detail_of("required_2z"), Some(&json!(full.hold.get())));
        assert_eq!(e.detail_of("max_output_tokens"), Some(&json!(1800)));
        assert_eq!(e.detail_of("available_milli_2z"), Some(&json!(5_000)));
        assert!(e.detail_of("cap_remaining_milli_2z").is_none());
    }

    #[test]
    fn strict_refuses_the_cap_clamp_as_cap_exceeded() {
        let e = plan(
            &ask(1800, true),
            &priced(200_000),
            &ctx(10_000_000, Some(5_000)),
        )
        .err()
        .unwrap();
        strict_refusal(&e, ErrorCode::CapExceeded);
        assert_eq!(e.detail_of("cap_remaining_milli_2z"), Some(&json!(5_000)));
    }

    #[test]
    fn strict_admits_exactly_the_affordable_boundary_at_the_full_limit() {
        let catalog = priced(200_000);
        let full = plan(&ask(1800, false), &catalog, &ctx(10_000_000, None)).unwrap();
        let exact = full.hold.to_milli().unwrap().get();
        let p = plan(&ask(1800, true), &catalog, &ctx(exact, None)).unwrap();
        assert_eq!((p.output, p.hold), (1800, full.hold));
        // One whole 2Z less and the same request no longer fits.
        let e = plan(&ask(1800, true), &catalog, &ctx(exact - 1000, None))
            .err()
            .unwrap();
        strict_refusal(&e, ErrorCode::InsufficientBalance);
    }

    #[test]
    fn strict_affordability_is_judged_at_the_consented_markup() {
        // The ledger applies min(consented, effective) at hold time, so an
        // approval between the context read and the hold can raise the price
        // up to the consented markup. A strict call that only fits at the
        // lower effective markup must be refused *before* the hold, never
        // held and then refused by the post-hold extension.
        let catalog = priced(200_000);
        let at_effective = plan(&ask(1800, false), &catalog, &ctx(u64::from(u32::MAX), None))
            .unwrap()
            .hold;
        let at_consented = plan(
            &ask(1800, false),
            &catalog,
            &ctx_markup(u64::from(u32::MAX), None, 5000, 5000),
        )
        .unwrap()
        .hold;
        assert!(at_consented > at_effective);
        let between = at_effective.to_milli().unwrap().get();
        let e = plan(
            &ask(1800, true),
            &catalog,
            &ctx_markup(between, None, 5000, 0),
        )
        .err()
        .unwrap();
        strict_refusal(&e, ErrorCode::InsufficientBalance);
        assert_eq!(e.detail_of("required_2z"), Some(&json!(at_consented.get())));
        // Enough for the consented worst case: admitted, held at the
        // effective markup, full limit.
        let enough = at_consented.to_milli().unwrap().get();
        let p = plan(
            &ask(1800, true),
            &catalog,
            &ctx_markup(enough, None, 5000, 0),
        )
        .unwrap();
        assert_eq!((p.output, p.hold), (1800, at_effective));
    }

    #[test]
    fn strict_refusals_carry_their_details_at_every_boundary() {
        // Not even one output token affordable.
        let e = plan(&ask(1800, true), &priced(200_000), &ctx(500, None))
            .err()
            .unwrap();
        strict_refusal(&e, ErrorCode::InsufficientBalance);
        assert!(e.detail_of("required_2z").is_some());
        // Input alone exceeds the window.
        let mut huge = ask(10, true);
        huge.messages[0].content = vec![ContentPart::Text {
            text: "x".repeat(9000),
        }];
        let e = plan(&huge, &priced(8192), &ctx(u64::from(u32::MAX), None))
            .err()
            .unwrap();
        strict_refusal(&e, ErrorCode::ContextLengthExceeded);
        assert_eq!(e.detail_of("max_output_tokens"), Some(&json!(10)));
        // Without strict, the same refusals keep their pre-#1122 shape.
        huge.max_output_tokens_strict = false;
        let e = plan(&huge, &priced(8192), &ctx(u64::from(u32::MAX), None))
            .err()
            .unwrap();
        assert!(e.detail_of("reason").is_none());
    }

    #[test]
    fn strict_refuses_the_model_and_window_clamps() {
        let catalog = priced(200_000);
        let rich = ctx(u64::from(u32::MAX), None);
        assert_eq!(
            plan(&ask(9000, false), &catalog, &rich).unwrap().output,
            8192
        );
        let e = plan(&ask(9000, true), &catalog, &rich).err().unwrap();
        strict_refusal(&e, ErrorCode::InvalidRequest);
        assert_eq!(e.detail_of("field"), Some(&json!("max_output_tokens")));
        assert_eq!(e.detail_of("model_max_output_tokens"), Some(&json!(8192)));

        // A long input leaves less than 1800 tokens of an 8192-token window.
        let narrow = priced(8192);
        let long = |tokens, strict| {
            let mut r = ask(tokens, strict);
            r.messages[0].content = vec![ContentPart::Text {
                text: "x".repeat(7000),
            }];
            r
        };
        let clamped = plan(&long(1800, false), &narrow, &rich).unwrap().output;
        assert!(clamped < 1800, "{clamped}");
        let e = plan(&long(1800, true), &narrow, &rich).err().unwrap();
        strict_refusal(&e, ErrorCode::ContextLengthExceeded);
        assert_eq!(e.detail_of("context_window"), Some(&json!(8192)));
        // The window it does leave is still usable strictly.
        assert_eq!(
            plan(&long(clamped, true), &narrow, &rich).unwrap().output,
            clamped
        );
    }
}
