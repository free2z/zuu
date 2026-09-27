//! [`InMemoryLedger`]: the ledger contract, in memory, behind one mutex.
//!
//! One mutex is the point, not a shortcut: every mutating operation of
//! metering.md §3 is "one atomic operation", and holding a single lock for the
//! whole check-and-reserve is the in-memory equivalent of the ledger's single
//! conditional update. A burst of parallel holds therefore races exactly as
//! the spec says it may not: never two holds both seeing enough balance.
//!
//! # What is modelled, and what is simplified
//!
//! * **Modelled:** frozen accounts, the account epoch (`aep`) and grant
//!   generation (`agen`), consented markup, per-grant spend caps with
//!   per-period collection history that survives re-consent, account debt
//!   from purchase reversals (purchase.md §3.1), the 16-open-hold
//!   limit (per user), replay by `hold_key`, absolute extension targets,
//!   expiry by a manual clock, idempotent settle and release, the
//!   first-terminal-transition-wins rule, and §5.5 shortfall settlement with
//!   the collected-amount splits of §2.3.
//! * **Simplified:** periods advance only when a test calls
//!   [`InMemoryLedger::start_new_period`], not by a calendar; the developer's
//!   and platform's credits are totals in [`LedgerTotals`], not accounts; the
//!   ledger clock starts at 0 and moves only by [`InMemoryLedger::advance`].

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use core::future::{Future, ready};
use core::time::Duration;

use f2z_ai_proto::Usage;
use f2z_ai_proto::chat::UsageSource;
use f2z_ai_proto::pricing::{Bps, MILLI_PER_2Z, metered_cost_nusd, price_nusd};

use super::{
    ExtendOutcome, HeldHold, HoldId, HoldKey, HoldOutcome, HoldRequest, HoldState, Inquiry,
    LedgerContract, LedgerError, RateCard, ReleaseOutcome, SettleOutcome, SettleRequest,
    Settlement,
};

/// The most open holds one user may have; a further hold is `TooManyHolds`
/// (metering.md §3).
pub const MAX_OPEN_HOLDS: u32 = 16;

/// A grant's consent, as recorded at consent time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GrantConfig {
    /// The markup the user consented to.
    pub markup_bps: Bps,
    /// The spend cap per period, whole 2Z; `None` is uncapped.
    pub spend_cap_2z: Option<u64>,
}

/// Everything recorded about one hold — the call record a test asserts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRecord {
    /// The hold.
    pub hold_id: HoldId,
    /// Its key.
    pub hold_key: HoldKey,
    /// Its state now.
    pub state: HoldState,
    /// The initial reservation (`meta.hold_2z`).
    pub initial_2z: u64,
    /// The reservation in force (`done.hold_2z`).
    pub reserved_2z: u64,
    /// When it expires unless extended.
    pub expires_at_ms: u64,
    /// The rate card snapshotted at hold time.
    pub rate_card_version: u64,
    /// The catalogue version recorded for reference.
    pub catalog_version: u64,
    /// The model whose minimum charge was snapshotted.
    pub model_id: String,
    /// The settlement, once settled.
    pub settlement: Option<Settlement>,
    /// The cost the first successful settle passed.
    pub cost_nusd: Option<u64>,
    /// The usage the first successful settle passed.
    pub usage: Option<Usage>,
    /// Its source.
    pub source: Option<UsageSource>,
    /// `metered_cost_nusd(usage, snapshot prices)` — compare with
    /// `cost_nusd` to catch a gateway that metered differently from the
    /// contract. The fake records the disagreement; it does not refuse.
    pub metered_from_usage: Option<u64>,
    /// How many settle calls reached this hold (idempotent replays included).
    pub settle_calls: u32,
    /// How many release calls reached this hold.
    pub release_calls: u32,
}

/// Where every collected milli-2Z went, across all settlements.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LedgerTotals {
    /// Taken from users.
    pub collected_milli_2z: u64,
    /// Priced but written off (§5.5).
    pub shortfall_milli_2z: u64,
    /// Owed to providers.
    pub provider_milli_2z: u64,
    /// Credited to developers, per app.
    pub developer_milli_2z: BTreeMap<String, u64>,
    /// The platform's net; can be negative only through shortfalls.
    pub platform_milli_2z: i64,
    /// Holds settled.
    pub settled: u64,
    /// Holds released by a release call.
    pub released: u64,
    /// Holds expired by the sweeper.
    pub expired: u64,
}

#[derive(Debug)]
struct Account {
    balance_milli: u64,
    frozen: bool,
    epoch: u64,
    /// Owed after a reversal took back 2Z already spent (purchase.md §3.1).
    debt_milli: u64,
    /// Every credit ever applied, including the part that repaid debt.
    funded_milli: u64,
    /// Collected by settlements.
    spent_milli: u64,
    /// Left the balance other than by spending: reversals, debt repayment.
    debited_milli: u64,
}

#[derive(Debug)]
struct Grant {
    generation: u64,
    live: bool,
    config: GrantConfig,
    period: u64,
    /// Collected per period. Survives re-consent and cap changes.
    collected: BTreeMap<u64, u64>,
}

#[derive(Debug)]
struct Hold {
    record: CallRecord,
    user: String,
    app: String,
    period: u64,
    margin: Bps,
    markup: Bps,
    min_charge_2z: u64,
    prices: f2z_ai_proto::pricing::ModelPrices,
}

#[derive(Debug, Default)]
struct State {
    now_ms: u64,
    accounts: HashMap<String, Account>,
    grants: HashMap<(String, String), Grant>,
    rate_cards: BTreeMap<u64, RateCard>,
    holds: BTreeMap<HoldId, Hold>,
    by_key: HashMap<HoldKey, HoldId>,
    next_hold: u64,
    next_receipt: u64,
    fail_next: u32,
    totals: LedgerTotals,
}

/// The in-memory fake of the ledger contract. See the module documentation.
#[derive(Debug, Default)]
pub struct InMemoryLedger {
    state: Mutex<State>,
}

fn to_milli(amount_2z: u64) -> Option<u64> {
    amount_2z.checked_mul(MILLI_PER_2Z)
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

impl State {
    fn gate(&mut self) -> Result<(), LedgerError> {
        if self.fail_next > 0 {
            self.fail_next = self.fail_next.saturating_sub(1);
            return Err(LedgerError::Unavailable);
        }
        self.sweep();
        Ok(())
    }

    /// Expire every open hold whose time has come. Lazily on every operation,
    /// so a settle after the expiry answers `not_open` even if the sweeper has
    /// not run — the spec's "a settle that arrives after the expiry".
    fn sweep(&mut self) -> usize {
        let now = self.now_ms;
        let mut n: usize = 0;
        let mut users = Vec::new();
        for hold in self.holds.values_mut() {
            if hold.record.state == HoldState::Open && now >= hold.record.expires_at_ms {
                hold.record.state = HoldState::Expired;
                users.push(hold.user.clone());
                n = n.saturating_add(1);
            }
        }
        for user in users {
            self.absorb_debt(&user);
        }
        self.totals.expired = self
            .totals
            .expired
            .saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        n
    }

    /// 2Z freed from a hold while the account owes a debt repay it first
    /// (purchase.md §3.1: "the hold settles normally and any remainder is
    /// then subject to the debt").
    fn absorb_debt(&mut self, user: &str) {
        let reserved = self.open_reserved_milli(user);
        if let Some(a) = self.accounts.get_mut(user) {
            let free = a.balance_milli.saturating_sub(reserved);
            let take = free.min(a.debt_milli);
            a.balance_milli = a.balance_milli.saturating_sub(take);
            a.debt_milli = a.debt_milli.saturating_sub(take);
            a.debited_milli = a.debited_milli.saturating_add(take);
        }
    }

    fn open_holds<'a>(&'a self, user: &'a str) -> impl Iterator<Item = &'a Hold> + 'a {
        self.holds
            .values()
            .filter(move |h| h.record.state == HoldState::Open && h.user == user)
    }

    fn open_reserved_milli(&self, user: &str) -> u64 {
        self.open_holds(user).fold(0u64, |acc, h| {
            acc.saturating_add(to_milli(h.record.reserved_2z).unwrap_or(u64::MAX))
        })
    }

    fn open_count(&self, user: &str) -> u32 {
        u32::try_from(self.open_holds(user).count()).unwrap_or(u32::MAX)
    }

    /// `balance − held`, and `0` while the account is in debt
    /// (purchase.md §1.1). Because a settle's excess is bounded by this, an AI
    /// call can never deepen a debt (metering.md §5.5).
    fn available_milli(&self, user: &str) -> u64 {
        self.accounts.get(user).map_or(0, |a| {
            if a.debt_milli > 0 {
                return 0;
            }
            a.balance_milli
                .saturating_sub(self.open_reserved_milli(user))
        })
    }

    /// `cap × 1000 − collected(period) − held_now(period)`, never negative;
    /// `None` when uncapped. No grant at all reads as a zero cap.
    fn cap_remaining_milli(&self, user: &str, app: &str, period: u64) -> Option<u64> {
        let Some(grant) = self.grants.get(&(user.to_owned(), app.to_owned())) else {
            return Some(0);
        };
        let cap = grant.config.spend_cap_2z?;
        let collected = grant.collected.get(&period).copied().unwrap_or(0);
        let held = self
            .open_holds(user)
            .filter(|h| h.app == app && h.period == period)
            .fold(0u64, |acc, h| {
                acc.saturating_add(to_milli(h.record.reserved_2z).unwrap_or(u64::MAX))
            });
        Some(
            to_milli(cap)
                .unwrap_or(u64::MAX)
                .saturating_sub(collected)
                .saturating_sub(held),
        )
    }

    fn inquire(&mut self, user: &str, app: &str) -> Result<Inquiry, LedgerError> {
        self.gate()?;
        let account = self.accounts.get(user).ok_or(LedgerError::UnknownAccount)?;
        let (frozen, debt_milli_2z) = (account.frozen, account.debt_milli);
        let period = self
            .grants
            .get(&(user.to_owned(), app.to_owned()))
            .map_or(0, |g| g.period);
        Ok(Inquiry {
            available_milli_2z: self.available_milli(user),
            cap_remaining_milli_2z: self.cap_remaining_milli(user, app, period),
            debt_milli_2z,
            open_holds: self.open_count(user),
            frozen,
        })
    }

    fn hold(&mut self, req: HoldRequest) -> Result<HoldOutcome, LedgerError> {
        self.gate()?;
        if let Some(id) = self.by_key.get(&req.hold_key) {
            let state = self
                .holds
                .get(id)
                .map_or(HoldState::Released, |h| h.record.state);
            return Ok(HoldOutcome::Replayed {
                hold_id: *id,
                state,
            });
        }
        if req.amount_2z == 0 {
            return Ok(HoldOutcome::InvalidAmount);
        }
        let account = self
            .accounts
            .get(&req.user)
            .ok_or(LedgerError::UnknownAccount)?;
        if account.frozen {
            return Ok(HoldOutcome::Frozen);
        }
        // Before any affordability arithmetic, so debt is never reported as
        // an ordinary shortage (metering.md §3, chat-api.md).
        if account.debt_milli > 0 {
            return Ok(HoldOutcome::InDebt);
        }
        let epoch = account.epoch;
        let key = (req.user.clone(), req.app.clone());
        let Some(grant) = self.grants.get(&key) else {
            return Ok(HoldOutcome::Revoked);
        };
        if !grant.live || grant.generation != req.agen || epoch != req.aep {
            return Ok(HoldOutcome::Revoked);
        }
        if grant.config.markup_bps != req.markup_bps {
            return Ok(HoldOutcome::MarkupMismatch);
        }
        let period = grant.period;
        let Some((margin, model)) = self.rate_cards.get(&req.rate_card_version).and_then(|rc| {
            rc.models
                .get(&req.model_id)
                .map(|m| (rc.platform_margin_bps, *m))
        }) else {
            return Ok(HoldOutcome::UnknownRateCard);
        };
        if self.open_count(&req.user) >= MAX_OPEN_HOLDS {
            return Ok(HoldOutcome::TooManyHolds);
        }
        let Some(amount_milli) = to_milli(req.amount_2z) else {
            return Ok(HoldOutcome::InsufficientBalance);
        };
        if self.available_milli(&req.user) < amount_milli {
            return Ok(HoldOutcome::InsufficientBalance);
        }
        if self
            .cap_remaining_milli(&req.user, &req.app, period)
            .is_some_and(|rem| rem < amount_milli)
        {
            return Ok(HoldOutcome::CapExceeded);
        }

        self.next_hold = self.next_hold.saturating_add(1);
        let hold_id = HoldId(self.next_hold);
        let expires_at_ms = self.now_ms.saturating_add(millis(req.ttl));
        self.by_key.insert(req.hold_key.clone(), hold_id);
        self.holds.insert(
            hold_id,
            Hold {
                record: CallRecord {
                    hold_id,
                    hold_key: req.hold_key,
                    state: HoldState::Open,
                    initial_2z: req.amount_2z,
                    reserved_2z: req.amount_2z,
                    expires_at_ms,
                    rate_card_version: req.rate_card_version,
                    catalog_version: req.catalog_version,
                    model_id: req.model_id,
                    settlement: None,
                    cost_nusd: None,
                    usage: None,
                    source: None,
                    metered_from_usage: None,
                    settle_calls: 0,
                    release_calls: 0,
                },
                user: req.user.clone(),
                app: req.app.clone(),
                period,
                margin,
                markup: req.markup_bps,
                min_charge_2z: model.min_charge_2z,
                prices: model.prices,
            },
        );
        Ok(HoldOutcome::Held(HeldHold {
            hold_id,
            available_milli_2z: self.available_milli(&req.user),
            cap_remaining_milli_2z: self.cap_remaining_milli(&req.user, &req.app, period),
            expires_at_ms,
        }))
    }

    fn extend(
        &mut self,
        hold_id: HoldId,
        reserve_to_2z: u64,
        ttl: Duration,
    ) -> Result<ExtendOutcome, LedgerError> {
        self.gate()?;
        let Some(hold) = self.holds.get(&hold_id) else {
            return Ok(ExtendOutcome::UnknownHold);
        };
        if hold.record.state != HoldState::Open {
            return Ok(ExtendOutcome::NotOpen {
                state: hold.record.state,
            });
        }
        let (user, app, period, reserved) = (
            hold.user.clone(),
            hold.app.clone(),
            hold.period,
            hold.record.reserved_2z,
        );
        let expires_at_ms = self.now_ms.saturating_add(millis(ttl));
        let mut outcome_reserved = reserved;
        let mut refusal = None;
        if reserve_to_2z > reserved {
            let diff_milli = to_milli(reserve_to_2z.saturating_sub(reserved)).unwrap_or(u64::MAX);
            if self.available_milli(&user) < diff_milli {
                refusal = Some(false);
            } else if self
                .cap_remaining_milli(&user, &app, period)
                .is_some_and(|rem| rem < diff_milli)
            {
                refusal = Some(true);
            } else {
                outcome_reserved = reserve_to_2z;
            }
        }
        if let Some(hold) = self.holds.get_mut(&hold_id) {
            hold.record.expires_at_ms = expires_at_ms;
            hold.record.reserved_2z = outcome_reserved;
        }
        Ok(match refusal {
            None => ExtendOutcome::Held {
                reserved_2z: outcome_reserved,
                expires_at_ms,
            },
            Some(false) => ExtendOutcome::InsufficientBalance {
                reserved_2z: outcome_reserved,
                expires_at_ms,
            },
            Some(true) => ExtendOutcome::CapExceeded {
                reserved_2z: outcome_reserved,
                expires_at_ms,
            },
        })
    }

    fn settle(&mut self, req: SettleRequest) -> Result<SettleOutcome, LedgerError> {
        self.gate()?;
        let Some(hold) = self.holds.get_mut(&req.hold_id) else {
            return Ok(SettleOutcome::UnknownHold);
        };
        hold.record.settle_calls = hold.record.settle_calls.saturating_add(1);
        match hold.record.state {
            HoldState::Settled => {
                if let Some(s) = &hold.record.settlement {
                    return Ok(SettleOutcome::Settled(s.clone()));
                }
                return Ok(SettleOutcome::NotOpen {
                    state: HoldState::Settled,
                });
            }
            state @ (HoldState::Released | HoldState::Expired) => {
                return Ok(SettleOutcome::NotOpen { state });
            }
            HoldState::Open => {}
        }
        let (user, app, period) = (hold.user.clone(), hold.app.clone(), hold.period);
        let reserved_milli = to_milli(hold.record.reserved_2z).unwrap_or(u64::MAX);
        let charge = price_nusd(req.cost_nusd, hold.margin, hold.markup, hold.min_charge_2z)
            .map_err(LedgerError::Pricing)?;
        let metered = metered_cost_nusd(&req.usage, &hold.prices).ok();

        // §5.5: beyond the hold, take no more than the user could have
        // reserved under it — the lesser of the available balance and the
        // hold's period's remaining cap.
        let total = charge.total_milli;
        let collected = if total <= reserved_milli {
            total
        } else {
            let excess = total.saturating_sub(reserved_milli);
            let mut takeable = self.available_milli(&user);
            if let Some(rem) = self.cap_remaining_milli(&user, &app, period) {
                takeable = takeable.min(rem);
            }
            reserved_milli.saturating_add(excess.min(takeable))
        };
        let shortfall = total.saturating_sub(collected);
        // §2.3: on a shortfall the loss falls on the platform, then the
        // developer, never the provider.
        let provider = charge.provider_milli;
        let developer = charge
            .developer_milli
            .min(collected.saturating_sub(provider));
        let platform = i128::from(collected)
            .saturating_sub(i128::from(provider))
            .saturating_sub(i128::from(developer));
        let platform = i64::try_from(platform).unwrap_or(i64::MIN);

        // Move the money.
        if let Some(account) = self.accounts.get_mut(&user) {
            account.balance_milli = account.balance_milli.saturating_sub(collected);
            account.spent_milli = account.spent_milli.saturating_add(collected);
        }
        if let Some(grant) = self.grants.get_mut(&(user.clone(), app.clone())) {
            let slot = grant.collected.entry(period).or_insert(0);
            *slot = slot.saturating_add(collected);
        }
        self.next_receipt = self.next_receipt.saturating_add(1);
        let receipt_id = format!("rcpt_{}", self.next_receipt);
        let t = &mut self.totals;
        t.collected_milli_2z = t.collected_milli_2z.saturating_add(collected);
        t.shortfall_milli_2z = t.shortfall_milli_2z.saturating_add(shortfall);
        t.provider_milli_2z = t.provider_milli_2z.saturating_add(provider);
        let dev = t.developer_milli_2z.entry(app.clone()).or_insert(0);
        *dev = dev.saturating_add(developer);
        t.platform_milli_2z = t.platform_milli_2z.saturating_add(platform);
        t.settled = t.settled.saturating_add(1);

        if let Some(hold) = self.holds.get_mut(&req.hold_id) {
            hold.record.state = HoldState::Settled;
        }
        self.absorb_debt(&user);
        let settlement = Settlement {
            hold_id: req.hold_id,
            receipt_id,
            charged_2z: charge.total_2z(),
            collected_milli_2z: collected,
            shortfall_milli_2z: shortfall,
            provider_milli_2z: provider,
            developer_milli_2z: developer,
            platform_milli_2z: platform,
            available_milli_2z: self.available_milli(&user),
            cap_remaining_milli_2z: self.cap_remaining_milli(&user, &app, period),
        };
        if let Some(hold) = self.holds.get_mut(&req.hold_id) {
            hold.record.settlement = Some(settlement.clone());
            hold.record.cost_nusd = Some(req.cost_nusd);
            hold.record.usage = Some(req.usage);
            hold.record.source = Some(req.source);
            hold.record.metered_from_usage = metered;
        }
        Ok(SettleOutcome::Settled(settlement))
    }

    fn release(&mut self, hold_id: HoldId) -> Result<ReleaseOutcome, LedgerError> {
        self.gate()?;
        let Some(hold) = self.holds.get_mut(&hold_id) else {
            return Ok(ReleaseOutcome::UnknownHold);
        };
        hold.record.release_calls = hold.record.release_calls.saturating_add(1);
        Ok(match hold.record.state {
            HoldState::Open => {
                hold.record.state = HoldState::Released;
                let user = hold.user.clone();
                self.totals.released = self.totals.released.saturating_add(1);
                self.absorb_debt(&user);
                ReleaseOutcome::Released
            }
            HoldState::Released => ReleaseOutcome::Released,
            HoldState::Expired => ReleaseOutcome::Expired,
            HoldState::Settled => ReleaseOutcome::Settled,
        })
    }
}

impl InMemoryLedger {
    /// An empty ledger with its clock at 0.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ---- setup -------------------------------------------------------------

    /// Create (or reset) `user`'s account with `balance_milli_2z`, epoch 1.
    pub fn open_account(&self, user: &str, balance_milli_2z: u64) {
        self.lock().accounts.insert(
            user.to_owned(),
            Account {
                balance_milli: balance_milli_2z,
                frozen: false,
                epoch: 1,
                debt_milli: 0,
                funded_milli: balance_milli_2z,
                spent_milli: 0,
                debited_milli: 0,
            },
        );
    }

    /// A purchase: credit `milli_2z`, repaying any debt first
    /// (purchase.md §3.1). No-op without an account.
    pub fn credit(&self, user: &str, milli_2z: u64) {
        if let Some(a) = self.lock().accounts.get_mut(user) {
            let repay = a.debt_milli.min(milli_2z);
            a.debt_milli = a.debt_milli.saturating_sub(repay);
            a.funded_milli = a.funded_milli.saturating_add(milli_2z);
            a.debited_milli = a.debited_milli.saturating_add(repay);
            a.balance_milli = a
                .balance_milli
                .saturating_add(milli_2z.saturating_sub(repay));
        }
    }

    /// A refund or chargeback taking back `milli_2z` (purchase.md §3.1): it
    /// debits what is *available* — 2Z under an open hold are not taken, and
    /// settle normally — and the rest becomes debt, which refuses every hold
    /// with `in_debt` until credits repay it. No-op without an account.
    pub fn reverse_credit(&self, user: &str, milli_2z: u64) {
        let mut s = self.lock();
        let available = match s.accounts.get(user) {
            Some(a) => a.balance_milli.saturating_sub(s.open_reserved_milli(user)),
            None => return,
        };
        if let Some(a) = s.accounts.get_mut(user) {
            let take = available.min(milli_2z);
            a.balance_milli = a.balance_milli.saturating_sub(take);
            a.debited_milli = a.debited_milli.saturating_add(take);
            a.debt_milli = a.debt_milli.saturating_add(milli_2z.saturating_sub(take));
        }
    }

    /// What `user` owes, in milli-2Z.
    #[must_use]
    pub fn debt_milli_2z(&self, user: &str) -> Option<u64> {
        self.lock().accounts.get(user).map(|a| a.debt_milli)
    }

    /// `user`'s balance (open holds not subtracted), in milli-2Z.
    #[must_use]
    pub fn balance_milli_2z(&self, user: &str) -> Option<u64> {
        self.lock().accounts.get(user).map(|a| a.balance_milli)
    }

    /// Freeze or unfreeze `user`.
    pub fn set_frozen(&self, user: &str, frozen: bool) {
        if let Some(a) = self.lock().accounts.get_mut(user) {
            a.frozen = frozen;
        }
    }

    /// `user`'s current account epoch (`aep`), if the account exists.
    #[must_use]
    pub fn account_epoch(&self, user: &str) -> Option<u64> {
        self.lock().accounts.get(user).map(|a| a.epoch)
    }

    /// A security event: bump `user`'s epoch, so every outstanding token's
    /// `aep` is stale. Returns the new epoch.
    pub fn bump_epoch(&self, user: &str) -> Option<u64> {
        self.lock().accounts.get_mut(user).map(|a| {
            a.epoch = a.epoch.saturating_add(1);
            a.epoch
        })
    }

    /// Consent (or re-consent): create the grant, or bump its generation and
    /// replace its config while keeping its spending history. Returns the
    /// generation (`agen`) a token must carry.
    pub fn grant(&self, user: &str, app: &str, config: GrantConfig) -> u64 {
        let mut s = self.lock();
        let grant = s
            .grants
            .entry((user.to_owned(), app.to_owned()))
            .or_insert(Grant {
                generation: 0,
                live: true,
                config,
                period: 0,
                collected: BTreeMap::new(),
            });
        grant.generation = grant.generation.saturating_add(1);
        grant.live = true;
        grant.config = config;
        grant.generation
    }

    /// Revoke the grant. Open holds are untouched and still settle (§5.10).
    pub fn revoke(&self, user: &str, app: &str) {
        if let Some(g) = self
            .lock()
            .grants
            .get_mut(&(user.to_owned(), app.to_owned()))
        {
            g.live = false;
        }
    }

    /// Start a new spend-cap period for the grant. Holds taken earlier keep
    /// settling against the period they were taken in.
    pub fn start_new_period(&self, user: &str, app: &str) {
        if let Some(g) = self
            .lock()
            .grants
            .get_mut(&(user.to_owned(), app.to_owned()))
        {
            g.period = g.period.saturating_add(1);
        }
    }

    /// Install a rate card.
    pub fn add_rate_card(&self, card: RateCard) {
        self.lock().rate_cards.insert(card.version, card);
    }

    // ---- clock, sweeper and faults -------------------------------------------

    /// The ledger clock, in milliseconds.
    #[must_use]
    pub fn now_ms(&self) -> u64 {
        self.lock().now_ms
    }

    /// Move the ledger clock forward. Expiry is evaluated lazily, so a hold
    /// past its time reads as expired on the next operation.
    pub fn advance(&self, by: Duration) {
        let mut s = self.lock();
        s.now_ms = s.now_ms.saturating_add(millis(by));
    }

    /// The platform's sweeper: expire every open hold past its time. Returns
    /// how many it expired.
    pub fn expire_due(&self) -> usize {
        self.lock().sweep()
    }

    /// Make the next `n` contract operations fail with
    /// [`LedgerError::Unavailable`] without taking effect (metering.md §5.11).
    pub fn fail_next(&self, n: u32) {
        self.lock().fail_next = n;
    }

    // ---- inspection ------------------------------------------------------------

    /// The record of one hold.
    #[must_use]
    pub fn call(&self, hold_id: HoldId) -> Option<CallRecord> {
        self.lock().holds.get(&hold_id).map(|h| h.record.clone())
    }

    /// Every hold's record, in id order.
    #[must_use]
    pub fn calls(&self) -> Vec<CallRecord> {
        self.lock()
            .holds
            .values()
            .map(|h| h.record.clone())
            .collect()
    }

    /// Where the money went.
    #[must_use]
    pub fn totals(&self) -> LedgerTotals {
        self.lock().totals.clone()
    }

    /// Check the invariants a load test must hold at the end of a run:
    ///
    /// * no user's open holds exceed their balance (available never negative);
    /// * every user's balance, plus what they spent, plus what reversals and
    ///   debt repayment took, equals what they were credited;
    /// * no user has more than [`MAX_OPEN_HOLDS`] open holds;
    /// * every settlement's collection plus shortfall is its price, and its
    ///   parts sum to its collection;
    /// * the totals' parts sum to the total collected.
    ///
    /// # Errors
    ///
    /// A description of the first violation.
    pub fn check_invariants(&self) -> Result<(), String> {
        let s = self.lock();
        for (user, a) in &s.accounts {
            let reserved = s.open_reserved_milli(user);
            if reserved > a.balance_milli {
                return Err(format!(
                    "{user}: open holds {reserved} m2Z exceed balance {} m2Z",
                    a.balance_milli
                ));
            }
            if a.balance_milli
                .checked_add(a.spent_milli)
                .and_then(|v| v.checked_add(a.debited_milli))
                != Some(a.funded_milli)
            {
                return Err(format!(
                    "{user}: balance {} + spent {} + debited {} != funded {}",
                    a.balance_milli, a.spent_milli, a.debited_milli, a.funded_milli
                ));
            }
            if s.open_count(user) > MAX_OPEN_HOLDS {
                return Err(format!("{user}: more than {MAX_OPEN_HOLDS} open holds"));
            }
        }
        for h in s.holds.values() {
            let Some(st) = &h.record.settlement else {
                continue;
            };
            let priced = to_milli(st.charged_2z);
            if st.collected_milli_2z.checked_add(st.shortfall_milli_2z) != priced {
                return Err(format!(
                    "{}: collected + shortfall != price",
                    h.record.hold_id
                ));
            }
            let parts = i128::from(st.provider_milli_2z)
                .saturating_add(i128::from(st.developer_milli_2z))
                .saturating_add(i128::from(st.platform_milli_2z));
            if parts != i128::from(st.collected_milli_2z) {
                return Err(format!(
                    "{}: splits do not sum to the collection",
                    h.record.hold_id
                ));
            }
        }
        let t = &s.totals;
        let dev: i128 = t
            .developer_milli_2z
            .values()
            .fold(0i128, |acc, v| acc.saturating_add(i128::from(*v)));
        let parts = i128::from(t.provider_milli_2z)
            .saturating_add(dev)
            .saturating_add(i128::from(t.platform_milli_2z));
        if parts != i128::from(t.collected_milli_2z) {
            return Err("totals: parts do not sum to the collection".to_owned());
        }
        Ok(())
    }
}

impl LedgerContract for InMemoryLedger {
    fn inquire(
        &self,
        user: &str,
        app: &str,
    ) -> impl Future<Output = Result<Inquiry, LedgerError>> + Send {
        ready(self.lock().inquire(user, app))
    }

    fn hold(
        &self,
        request: HoldRequest,
    ) -> impl Future<Output = Result<HoldOutcome, LedgerError>> + Send {
        ready(self.lock().hold(request))
    }

    fn extend(
        &self,
        hold_id: HoldId,
        reserve_to_2z: u64,
        ttl: Duration,
    ) -> impl Future<Output = Result<ExtendOutcome, LedgerError>> + Send {
        ready(self.lock().extend(hold_id, reserve_to_2z, ttl))
    }

    fn settle(
        &self,
        request: SettleRequest,
    ) -> impl Future<Output = Result<SettleOutcome, LedgerError>> + Send {
        ready(self.lock().settle(request))
    }

    fn release(
        &self,
        hold_id: HoldId,
    ) -> impl Future<Output = Result<ReleaseOutcome, LedgerError>> + Send {
        ready(self.lock().release(hold_id))
    }
}
