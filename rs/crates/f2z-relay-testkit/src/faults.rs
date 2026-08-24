//! Fault injection — the half of the testkit that is worth more than the happy
//! path.
//!
//! Under delete-on-ack the failure paths are where data loss lives. A client
//! that gets `APPEND` and `READ` right and gets a dropped `ACK` response wrong
//! will lose messages in production and pass every test that only ever sees a
//! healthy relay. `WIRE.md` §2.5 states the shape of the problem outright: "an
//! in-flight command whose response was not received has **unknown** status",
//! and §8.3 spells out the two halves of the answer — `ACK` is idempotent so a
//! retry is safe, `APPEND` is not so a retry duplicates. Neither sentence is
//! testable against a relay that always answers.
//!
//! So every fault here exists to make a specific client obligation reachable:
//!
//! | Fault | The client rule it tests |
//! |---|---|
//! | [`Effect::Drop`] | §2.5 unknown status; §8.3 idempotent `ACK` retry |
//! | [`Effect::Delay`] | §4.3 correlate by `request_id`, never by arrival order |
//! | [`Effect::Reorder`] | §4.3 "responses may arrive out of order … and will" |
//! | [`Effect::Close`] / [`Effect::CloseBefore`] | §2.5 close at any time; reconnect and re-`SUBSCRIBE` |
//! | [`Effect::Refuse`] | §10, every code, including the ones a healthy relay never emits |
//! | [`Effect::Stall`] | §4.3 in-flight window: a client that never times out fills it and gets a fatal `ERR_TOO_MANY_INFLIGHT` |
//! | [`PolicyFaults::expire_messages_after`] | §7.7 TTL expiry, and `QUEUE_EVENT(3)` |
//! | [`PolicyFaults::max_queue_messages`] | §6.3 `ERR_UNAVAILABLE` collapse: a full queue is indistinguishable from an absent one |
//! | [`PolicyFaults::unsound_antireplay_window`] | [#586] — the capability document a conforming relay may publish and a client must refuse |
//!
//! # These are faults, not relaxations
//!
//! Everything here makes the relay behave *worse* than the specification
//! allows in ways a real relay or a real network can. Nothing here makes it
//! accept something a conforming relay would reject — that is
//! [`crate::config::Relaxations`], which is a separate type for exactly this
//! reason.
//!
//! [#586]: https://github.com/free2z/zuu/issues/586

use std::sync::{Arc, Mutex};
use std::time::Duration;

use f2z_codec::ErrorCode;
use f2z_codec::commands::{Command, PushEvent};

/// Which outbound frames a rule applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Trigger {
    /// Responses to one command code.
    Command(Command),
    /// Every response, whatever the command.
    AnyResponse,
    /// Pushes of one event kind (§6.4).
    Push(PushEvent),
    /// Every push.
    AnyPush,
}

impl Trigger {
    /// Whether this trigger selects a response to `command`.
    ///
    /// `command` is `None` for a response to a code the relay does not know
    /// (`ERR_UNKNOWN_COMMAND`, §3.5), which [`Trigger::AnyResponse`] still
    /// selects — a client has to handle a dropped error response too.
    #[must_use]
    pub fn matches_response(self, command: Option<Command>) -> bool {
        match self {
            Self::AnyResponse => true,
            Self::Command(wanted) => command == Some(wanted),
            Self::Push(_) | Self::AnyPush => false,
        }
    }

    /// Whether this trigger selects a push of `event`.
    #[must_use]
    pub fn matches_push(self, event: Option<PushEvent>) -> bool {
        match self {
            Self::AnyPush => true,
            Self::Push(wanted) => event == Some(wanted),
            Self::Command(_) | Self::AnyResponse => false,
        }
    }
}

/// What a rule does to the frames it selects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Effect {
    /// Silently discard the frame. The command still executed: this is the
    /// lost-response case of §2.5, not a refusal.
    Drop,
    /// Hold the frame for this long before writing it.
    Delay(Duration),
    /// Hold the frame until the next outbound frame is ready, then write that
    /// one first (§4.3).
    ///
    /// A held frame is flushed when the connection closes, so a reorder rule
    /// that never sees a second frame degrades to a delay rather than to a
    /// silent drop.
    Reorder,
    /// Never write the frame and never release the request. The command still
    /// executed; the client's `request_id` stays outstanding, which is what
    /// puts pressure on §4.3's in-flight window.
    Stall,
    /// Write the frame, then close the connection.
    Close,
    /// Close the connection instead of writing the frame — the mid-stream
    /// disconnect where the client cannot know whether the command applied.
    CloseBefore,
    /// Answer the command with this code instead of executing it.
    ///
    /// Applied *before* any state changes, so a refused `APPEND` really did not
    /// append. This is the one effect that is evaluated in the engine rather
    /// than on the way out.
    Refuse(ErrorCode),
}

/// How many times a rule fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Times {
    /// Every matching frame, for as long as the rule is armed.
    Always,
    /// The next `n` matching frames, then the rule retires itself.
    Exactly(u32),
}

/// One fault rule: what to match, what to do, how often.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fault {
    /// Which frames this rule selects.
    pub trigger: Trigger,
    /// What happens to them.
    pub effect: Effect,
    /// How many times.
    pub times: Times,
}

impl Fault {
    /// A rule that fires on every matching frame.
    #[must_use]
    pub const fn always(trigger: Trigger, effect: Effect) -> Self {
        Self {
            trigger,
            effect,
            times: Times::Always,
        }
    }

    /// A rule that fires once and retires.
    #[must_use]
    pub const fn once(trigger: Trigger, effect: Effect) -> Self {
        Self {
            trigger,
            effect,
            times: Times::Exactly(1),
        }
    }

    /// A rule that fires `n` times and retires.
    #[must_use]
    pub const fn times(trigger: Trigger, effect: Effect, n: u32) -> Self {
        Self {
            trigger,
            effect,
            times: Times::Exactly(n),
        }
    }

    /// Consume one firing. Returns `false` when the rule has retired.
    fn consume(&mut self) -> bool {
        match &mut self.times {
            Times::Always => true,
            Times::Exactly(remaining) => {
                if *remaining == 0 {
                    false
                } else {
                    *remaining = remaining.saturating_sub(1);
                    true
                }
            }
        }
    }

    fn retired(&self) -> bool {
        matches!(self.times, Times::Exactly(0))
    }
}

/// Faults that are properties of the relay's policy rather than of one frame.
///
/// These change what the relay *is*, so they are read on every relevant
/// decision instead of being consumed. Several of them also change the
/// published capability document, which is the point: a client that reads
/// policy from `GET_CAPABILITIES` must see the policy it is about to be held
/// to.
///
/// Deliberately **not** `#[non_exhaustive]`: a client developer builds one of
/// these with struct-update syntax in their own test file, and a crate whose
/// test-harness configuration could only be constructed from inside the crate
/// would be unusable for the thing it exists to do.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PolicyFaults {
    /// Expire stored messages this long after they were appended, whatever TTL
    /// the queue was granted (§7.7).
    ///
    /// `Some(Duration::ZERO)` expires a message the instant the clock is read
    /// again, which is the fastest way to reach `QUEUE_EVENT(3)` and to prove a
    /// client does not assume a `READ` returns what it appended.
    pub expire_messages_after: Option<Duration>,
    /// Expire a queue this long after its last activity, whatever idle TTL it
    /// was granted (§7.7). Reaches `QUEUE_EVENT(2)` and, for the sender,
    /// `ERR_UNAVAILABLE` on a queue that used to work.
    pub expire_queue_after: Option<Duration>,
    /// Override `max_queue_messages` (§13.1 layer 2). Set it to 1 and the
    /// second `APPEND` is `ERR_UNAVAILABLE` — the §6.3 collapse, reached
    /// cheaply.
    pub max_queue_messages: Option<u32>,
    /// Override `max_queue_bytes` (§13.1 layer 2).
    pub max_queue_bytes: Option<u64>,
    /// Refuse `CREATE_QUEUE` with `ERR_QUOTA` once the relay holds this many
    /// queues (§10 code 14 — a recv-side quota, which unlike the send side is
    /// allowed to be distinguishable).
    pub max_queues: Option<usize>,
    /// §13.1 layer 4. Creation answers `ERR_BACKPRESSURE`, appends answer
    /// `ERR_UNAVAILABLE`, and `READ` / `ACK` / `DELETE_QUEUE` are **never**
    /// refused — refusing the operations that make the relay smaller is a
    /// deadlock, and a client that cannot drain under backpressure will find
    /// out here.
    pub global_backpressure: bool,
    /// Publish, and then actually enforce, `antireplay_window_ms =
    /// clock_skew_ms` — below the `2 × clock_skew_ms` floor that [#586] says
    /// `WIRE.md` should state and does not.
    ///
    /// Both halves matter. The document is what
    /// `ClientPolicy::require_sound_antireplay_window` refuses on; the
    /// enforcement is what makes the refusal *justified*, because with the
    /// short retention the relay really does age a seen-set entry out while the
    /// frame it covers is still inside the timestamp window.
    ///
    /// [#586]: https://github.com/free2z/zuu/issues/586
    pub unsound_antireplay_window: bool,
    /// Shrink the seen-set bound so `ERR_BACKPRESSURE` from §5.5 is reachable
    /// without sending 65 536 commands.
    pub seen_set_max: Option<usize>,
}

/// A live handle to one relay's faults.
///
/// Cheap to clone and shared with every connection, so a test can arm a fault
/// in the middle of a conversation — which is the only way to reach half of
/// them. Arming is not a restart.
#[derive(Clone, Debug, Default)]
pub struct FaultInjector {
    inner: Arc<Mutex<Faults>>,
}

#[derive(Debug, Default)]
struct Faults {
    rules: Vec<Fault>,
    policy: PolicyFaults,
}

impl FaultInjector {
    /// An injector with nothing armed.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Arm a rule.
    pub fn arm(&self, fault: Fault) {
        if let Ok(mut faults) = self.inner.lock() {
            faults.rules.push(fault);
        }
    }

    /// Arm several rules at once.
    pub fn arm_all(&self, faults: impl IntoIterator<Item = Fault>) {
        for fault in faults {
            self.arm(fault);
        }
    }

    /// Disarm every rule. Policy faults are left alone; use
    /// [`FaultInjector::set_policy`] for those.
    pub fn disarm(&self) {
        if let Ok(mut faults) = self.inner.lock() {
            faults.rules.clear();
        }
    }

    /// Replace the policy faults.
    pub fn set_policy(&self, policy: PolicyFaults) {
        if let Ok(mut faults) = self.inner.lock() {
            faults.policy = policy;
        }
    }

    /// The current policy faults.
    #[must_use]
    pub fn policy(&self) -> PolicyFaults {
        self.inner
            .lock()
            .map(|faults| faults.policy)
            .unwrap_or_default()
    }

    /// How many rules are armed. Retired rules are removed as they retire.
    #[must_use]
    pub fn armed(&self) -> usize {
        self.inner.lock().map_or(0, |faults| faults.rules.len())
    }

    /// The refusal a rule demands for `command`, consuming one firing.
    ///
    /// Called by the engine before the command runs, so a refusal really does
    /// prevent the state change.
    #[must_use]
    pub fn take_refusal(&self, command: Option<Command>) -> Option<ErrorCode> {
        match self.take(|fault| match fault.effect {
            Effect::Refuse(_) if fault.trigger.matches_response(command) => Some(fault.effect),
            _ => None,
        }) {
            Some(Effect::Refuse(code)) => Some(code),
            _ => None,
        }
    }

    /// The delivery effect a rule demands for a response, consuming one firing.
    #[must_use]
    pub fn take_response_effect(&self, command: Option<Command>) -> Option<Effect> {
        self.take(|fault| match fault.effect {
            Effect::Refuse(_) => None,
            effect if fault.trigger.matches_response(command) => Some(effect),
            _ => None,
        })
    }

    /// The delivery effect a rule demands for a push, consuming one firing.
    #[must_use]
    pub fn take_push_effect(&self, event: Option<PushEvent>) -> Option<Effect> {
        self.take(|fault| match fault.effect {
            Effect::Refuse(_) => None,
            effect if fault.trigger.matches_push(event) => Some(effect),
            _ => None,
        })
    }

    /// First matching rule wins, and firing it may retire it.
    fn take(&self, select: impl Fn(&Fault) -> Option<Effect>) -> Option<Effect> {
        let mut faults = self.inner.lock().ok()?;
        let mut chosen = None;
        for fault in &mut faults.rules {
            if let Some(effect) = select(fault)
                && fault.consume()
            {
                chosen = Some(effect);
                break;
            }
        }
        faults.rules.retain(|fault| !fault.retired());
        chosen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_once_rule_fires_once_and_retires() {
        let injector = FaultInjector::new();
        injector.arm(Fault::once(Trigger::Command(Command::Ack), Effect::Drop));
        assert_eq!(injector.armed(), 1);
        assert_eq!(
            injector.take_response_effect(Some(Command::Ack)),
            Some(Effect::Drop)
        );
        assert_eq!(injector.take_response_effect(Some(Command::Ack)), None);
        assert_eq!(injector.armed(), 0);
    }

    #[test]
    fn a_command_rule_ignores_other_commands() {
        let injector = FaultInjector::new();
        injector.arm(Fault::always(Trigger::Command(Command::Read), Effect::Drop));
        assert_eq!(injector.take_response_effect(Some(Command::Ack)), None);
        assert_eq!(
            injector.take_response_effect(Some(Command::Read)),
            Some(Effect::Drop)
        );
        // Always means always.
        assert_eq!(
            injector.take_response_effect(Some(Command::Read)),
            Some(Effect::Drop)
        );
    }

    #[test]
    fn refusals_and_delivery_effects_do_not_steal_each_others_rules() {
        let injector = FaultInjector::new();
        injector.arm(Fault::always(
            Trigger::Command(Command::Append),
            Effect::Refuse(ErrorCode::Unavailable),
        ));
        assert_eq!(injector.take_response_effect(Some(Command::Append)), None);
        assert_eq!(
            injector.take_refusal(Some(Command::Append)),
            Some(ErrorCode::Unavailable)
        );
    }

    #[test]
    fn push_rules_and_response_rules_are_separate() {
        let injector = FaultInjector::new();
        injector.arm(Fault::always(Trigger::AnyPush, Effect::Drop));
        assert_eq!(injector.take_response_effect(Some(Command::Read)), None);
        assert_eq!(
            injector.take_push_effect(Some(PushEvent::Msg)),
            Some(Effect::Drop)
        );
    }

    #[test]
    fn every_error_code_can_be_demanded() {
        // §10's codes are stable forever and a client has to handle all of
        // them, including the ones a healthy relay never emits.
        let injector = FaultInjector::new();
        for code in ErrorCode::ALL {
            injector.arm(Fault::once(
                Trigger::Command(Command::Append),
                Effect::Refuse(code),
            ));
        }
        for code in ErrorCode::ALL {
            assert_eq!(
                injector.take_refusal(Some(Command::Append)),
                Some(code),
                "rules fire in the order they were armed"
            );
        }
        assert_eq!(injector.armed(), 0);
    }
}
