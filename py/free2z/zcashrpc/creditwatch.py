"""Monitor credit-loop progress independently of the loop's own control flow.

Progress is a change in successful-cycle heartbeat count, not a log-file mtime
or a running-process flag. The watchdog distinguishes absent/stalled progress
from explicit financial refusals, preserves bounded recovery state, and checks
producer readiness before requesting maintenance recovery. A recovery request
cannot substitute for financial credit reconciliation.

Host services, source attestations, monitoring policies, and scheduling are
provided by the deployment. The pure evaluator is tested with synthetic samples.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import time
import fcntl
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from zcashrpc.paymentd_mode import buy_producer_mode, guarded_release, MAINTENANCE_HEARTBEAT

# paymentd-producer-guard-v1: supervision is maintenance-only after cutover.


# ------------------------------------------------------------------ signals
#
# Every one of these is watched by a filter in monitoring/. Do not reword one
# without reading THE SIGNAL CONTRACT above.
CYCLE_SIGNAL = 'credit-watchdog: cycle ok'
# The durable pre-action record is deliberately distinct from the success
# signal: a killed or failed systemctl call must never look recovered.
RESTART_ATTEMPT_SIGNAL = 'credit-watchdog: RESTARTING THE CREDIT LOOP'
RESTART_SIGNAL = 'credit-watchdog: RESTARTED THE CREDIT LOOP'
GIVING_UP_SIGNAL = 'credit-watchdog: GIVING UP'
PREFLIGHT_SAFE_MARKER = 'credit-watchdog: PREFLIGHT SAFE'
# One signal for "the watchdog cannot do its job", rather than one per cause.
# The causes are different (no log, no state file, a nonsense threshold, a
# `systemctl` that failed or hung) but the RESPONSE is identical -- the credit
# loop is now unsupervised and a human must look -- and a family of five
# near-identical CRITICAL policies is how a board becomes wallpaper.
IMPAIRED_SIGNAL = 'credit-watchdog: IMPAIRED'


# ------------------------------------------------------------------- config
#
# Shared with credit-loop.sh through /etc/default/free2z-credit-loop, which
# BOTH units read via `EnvironmentFile=`. One file, one value: a logfile path
# set for the loop and not for the watchdog would leave the watchdog tailing an
# empty file, concluding the heartbeat had stopped, and restarting a perfectly
# healthy loop every threshold forever. (install-services.sh writes both units.)
LOGFILE = os.environ.get(
    'CREDIT_LOOP_LOGFILE', '/var/log/free2z/credit-loop.log')
PREFLIGHT_MODE = os.environ.get('CREDIT_WATCHDOG_PREFLIGHT') == '1'

STATE_PATH = Path(os.environ.get(
    'CREDIT_WATCHDOG_STATE', '/var/lib/free2z/credit-watchdog.json'))

# The lock is deliberately adjacent to the state file and overridable for
# hermetic tests.  It is held from the state read through the final systemd
# actuation; locking only the JSON write still lets two timer/manual runs make
# the same decision and then both restart the money path.
LOCK_PATH = Path(os.environ.get(
    'CREDIT_WATCHDOG_LOCK', str(STATE_PATH) + '.lock'))

UNIT = os.environ.get('CREDIT_WATCHDOG_UNIT', 'free2z-credit-loop.service')

# THE DEPENDENCY THAT CAN BE THE WEDGED PARTY, AND WHY RESTARTING THE LOOP DOES
# NOT CLEAR IT.
#
# `cloud-sql-proxy.service` carries `Restart=always`, which does nothing here: a
# half-open socket to Cloud SQL does not make the proxy EXIT, so systemd never
# restarts it. The loop then fail-stops, `Restart=on-failure` brings it back
# after 30s, it reconnects through the SAME wedged proxy, and the cycle repeats
# forever. This watchdog would do exactly the same thing -- restart, no
# heartbeat, restart, hit the rate limit, give up -- while the fix sat one layer
# down the whole time.
#
# So the escalation ladder has three rungs, not two:
#
#   1. restart the loop, up to CREDIT_WATCHDOG_MAX_RESTARTS times;
#   2. ONCE per window, restart the dependency AND the loop;
#   3. give up, loudly, naming what the loop said was wedged.
#
# WHY NOT `BindsTo=cloud-sql-proxy.service` ON THE LOOP. It does not deliver
# this recovery. `BindsTo`/`PartOf` propagate a STOP downward -- the loop dies
# when the proxy dies -- and the failure here is precisely that the proxy never
# dies. systemd has no directive meaning "restarting A also restarts B", so the
# declarative option would read as a fix while changing nothing. It would also
# couple the two units in the other direction, where a deliberate proxy restart
# takes crediting down with it.
#
# Rung 2 is capped at ONE dependency restart per window on purpose: a proxy
# restart drops any admin session's connection, and an actuator that fires
# freely on a money path is how a recovery mechanism becomes an outage. Set
# CREDIT_WATCHDOG_DEPENDENCY_UNITS empty to disable rung 2 entirely.
DEPENDENCY_UNITS_DEFAULT = 'cloud-sql-proxy.service'

# THE THRESHOLD. Derived, and the derivation is the part that was wrong first
# time round -- it is HEARTBEAT-TO-HEARTBEAT, not one call and not one cycle.
#
# `credit_creators` prints the heartbeat, so the gap between two of them spans
# the TAIL of one cycle and the HEAD of the next:
#
#     credit_creators (heartbeat) -> credit_pages_unified -> sleep INTERVAL
#       -> sync -> secret -> credit_creators (heartbeat)
#
# so the longest LEGITIMATE gap under 's defaults is
#
#     2*DJANGO_TIMEOUT + SYNC_TIMEOUT + SECRET_TIMEOUT + INTERVAL
#       + CREDIT_WALLET_SYNC_LOCK_TIMEOUT + 2*CREDIT_WALLET_TIP_TIMEOUT
#       + 6*KILL_GRACE
#     = 3600 + 600 + 60 + 90 + 30 + 60 + 180 = 4620s
#
# and NOT the 2490s that one cycle's calls suggest. A 2700s threshold would
# therefore SIGTERM a `credit_creators` still legitimately grinding through a
# backlog -- the one action here that can permanently lose a payment on
# pre- host code. (Codex adversarial review, round 2, finding 1.)
#
# The ceiling on the ceiling is the thing this backstops: the loop's own
# fail-stop needs MAX_CONSECUTIVE_FAILURES (5) wedged cycles, ~2.6h (9360s)
# worst case, and only for hangs its bounds can see. This must sit inside that
# to be the faster path for the hangs they cannot.
#
# 5400s = 90 minutes = 60 missed cycles. Above the 4620s ceiling with ~17%
# margin, and a little over half the fail-stop's worst case.
# `warn_if_thresholds_conflict()` recomputes the ceiling from whatever the loop
# is actually configured with; `warn_if_loop_is_unbounded()` says so when the
# deployed loop has no deadlines at all and the ceiling does not exist.
STALE_SECONDS_DEFAULT = 5400

# Escalating restart-loop protection.
#
# THE WINDOW HAS TO BE ABLE TO HOLD THE RESTARTS. Each restart resets
# `progress_at`, so the next one cannot happen for another STALE_SECONDS: N
# restarts span (N-1)*STALE_SECONDS, and by the time the Nth is decided the
# first is already (N-1)*STALE_SECONDS old. With a 3-restart budget, a 5400s
# threshold and a 10800s window the first entry ages out at exactly the moment
# the third decision is made, `len(restarts) >= 3` is UNREACHABLE, and both the
# escalation rung and the give-up rung are dead code -- the watchdog flaps the
# loop forever, never tries the proxy, and never hands over to a human.
# (Codex adversarial review, round 3, finding 3. It was dead code, and the
# suite did not catch it because the fixtures fabricated restarts 3000s apart,
# a spacing the state machine cannot produce.)
#
# So the window must exceed MAX_RESTARTS * STALE_SECONDS, with a cycle of
# margin: (3+1)*5400 = 21600s = 6h. `load_config()` raises a too-small
# configured window to that bound rather than obeying an unreachable one, and
# says so.
MAX_RESTARTS_DEFAULT = 3
RESTART_WINDOW_SECONDS_DEFAULT = 21600


def required_window(max_restarts, stale_seconds):
    """The smallest window in which `max_restarts` restarts can co-exist."""
    return (max_restarts + 1) * stale_seconds

# `systemctl restart` blocks until the unit has stopped and started again, and
# a wedged unit takes TimeoutStopSec (90s by default) to be SIGKILLed. Bound it
# anyway: a watchdog that can itself hang on the call it makes to fix a hang is
# a joke with a long punchline.
# NOT read with a bare int() any more. It was the one knob that escaped
# _bounded_int, whose whole point is that a bad value is refused LOUDLY and
# never silently defaulted:
#
#   CREDIT_WATCHDOG_RESTART_TIMEOUT=3m  -> ValueError at IMPORT, so the unit
#     failed every five minutes forever with no IMPAIRED line at all -- the only
#     signal was the 30-minute absence policy.
#   CREDIT_WATCHDOG_RESTART_TIMEOUT=0   -> parsed fine, then every restart
#     reported "NOT confirmed restarted" while still burning budget, and rung
#     2's `break` meant the LOOP was never restarted at all.
#
# It goes through load_config() with everything else now.
RESTART_TIMEOUT_DEFAULT = 180

# A watchdog invocation should normally observe the previous run within one
# timer interval. A wall-clock gap is treated as a forward jump only when the
# persisted monotonic clock says little real time elapsed. A genuinely absent
# timer/VM therefore remains actionable when it returns; wall time alone cannot
# distinguish that outage from an NTP/RTC correction.
CLOCK_FORWARD_JUMP_SECONDS = 3600
CLOCK_FORWARD_JUMP_TOLERANCE_SECONDS = 600

# THE UNIT'S OWN DEADLINE, AND WHY THIS MODULE HAS TO KNOW IT.
#
# install-services.sh sets `TimeoutStartSec=900` on free2z-credit-watchdog. Rung
# 2 restarts TWO units in sequence, and each unit consumes two bounded calls
# (try-restart plus its is-active postcondition), so the worst permitted run is
# `2 * (1 + len(dependency_units)) * restart_timeout` plus the probes, the log
# scan and the state write. Bounding restart_timeout at 1..3600 while
# TimeoutStartSec stayed FIXED at 900 left a range where systemd
# kills the watchdog mid-escalation -- before it can report the timeout or
# persist its budget -- and the next timer run repeats the same escalation.
# That is the restart storm the round-6 fix was about, reachable purely by
# raising one env var.
#
# So the two are reconciled here rather than left to a comment: the effective
# restart timeout is CLAMPED to what the unit's start deadline can actually
# accommodate, loudly. Clamping keeps recovery working, where refusing would
# disable it. install-services.sh writes both numbers from ONE shell variable,
# so they cannot drift apart in the first place.
# (Owner review of, additional blocker B.)
UNIT_START_TIMEOUT_DEFAULT = 900
# Probes, the log scan, the state write, and systemd's own start-up accounting.
RESTART_OVERHEAD_SECONDS = 120
# `restart_unit()` has one bounded systemctl call and one bounded postcondition
# probe.  Both consume the configured timeout in the worst case.
RESTART_CALLS_PER_UNIT = 2

# The heartbeat, matched on its PREFIX. The full shape
# (`- scanned N notes, credited M notes for X 2Z`) belongs to
# monitoring/log-metrics/zec-credit-cycle.json, which is where a reword must be
# noticed. Matching the whole line here too would mean a harmless change to the
# tail turns this watchdog into a restart storm against a perfectly healthy
# loop -- failing in the more expensive direction, on a money path.
HEARTBEAT_PREFIX = 'credit_creators: cycle ok - '
_HEARTBEAT_RE = re.compile(r'^credit_creators: cycle ok - ')

# What the loop says wedged. `!! HANG: wallet sync via zecrocks did not
# return within 600s and was SIGTERMed (timeout exit 124)`. Tolerant by design:
# the loop bounds only the calls somebody remembered to wrap, so the absence of
# this line is the normal case for exactly the stalls this watchdog is here for.
_HANG_RE = re.compile(r'^!! HANG: (.+?) did not return')

# Presence of the atomic crediting code on the host. A PRESENCE check only: it
# does not prove the file is 's version, and a stale or partial copy
# suppresses the warning. `bin/check-credit-code-drift.py --compare` against a
# fresh `sha256sum` is the authoritative check and covers every file.
_REPO_PY_ROOT = Path(__file__).resolve().parents[1]
ATOMIC_CREDIT_MODULE = Path(os.environ.get(
    'CREDIT_WATCHDOG_ATOMIC_MODULE',
    str(_REPO_PY_ROOT / 'dj' / 'apps' / 'tuzis' / 'zec.py')))

# THE LOOP SCRIPT ITSELF. The whole safety argument for the 5400s default is
# "a cycle cannot legitimately be silent longer than the loop's own deadlines",
# and that is only true of a loop that HAS deadlines.  adds them; a host
# still carrying the older `credit-loop.sh` has an unbounded `manage.py`, so a
# legitimate 50-minute backlog run would be SIGTERMed by this watchdog. So the
# claim is CHECKED rather than assumed: if the deployed script does not contain
# `timeout -k`, that is reported.
#
# It is a text check on the deployed file, not a version assertion -- the same
# kind of evidence, with the same limits, as the `zec.py` presence check. When
# the path does not exist at all (a dev run, or a host laid out differently)
# nothing is claimed in either direction; install-services.sh sets this
# explicitly to the loop user's copy, because this unit runs as root and its own
# $HOME is not the loop's.
LOOP_SCRIPT = os.environ.get(
    'CREDIT_WATCHDOG_LOOP_SCRIPT',
    str(Path(os.path.expanduser('~')) / 'credit-loop.sh'))

# The loop's own deadlines, read from the same environment both units share, so
# the conflict warning below can be computed rather than remembered.
_LOOP_BOUND_DEFAULTS = {'SYNC_TIMEOUT': 600, 'SECRET_TIMEOUT': 60,
                        'DJANGO_TIMEOUT': 1800, 'KILL_GRACE': 30,
                        'INTERVAL': 90, 'CREDIT_WALLET_TIP_TIMEOUT': 30,
                        'CREDIT_WALLET_SYNC_LOCK_TIMEOUT': 30}


# The watchdog's restart decision is only safe if the concrete external calls
# in credit-loop.sh are bounded. Checking for a free-floating `timeout -k`
# substring was not meaningful: a comment, an unrelated command, or one bound
# on the wrong call all passed while a required network/database call could
# still hang forever. Keep these patterns deliberately narrow and conservative;
# an edit to the loop that changes this call shape becomes IMPAIRED until this
# verifier and its negative controls are updated together.
def _without_shell_comments(text):
    return '\n'.join(line.split('#', 1)[0] for line in text.splitlines())


def _required_loop_bound_patterns():
    continuation = r'\s*(?:\\\s*)?'
    return {
        'wallet sync': re.compile(
            r'sync_out\s*=\s*"\$\(\s*timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$SYNC_TIMEOUT"' + continuation +
            r'"\$DEVTOOL"\s+wallet\s+-w\s+"\$WALLET"\s+sync\s+-s\s+"\$LWD"'
            r'\s+--connection\s+direct\s+2>&1\s*\)'
        ),
        'wallet enhance': re.compile(
            r'enhance_out\s*=\s*"\$\(\s*timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$wallet_remaining"' + continuation +
            r'"\$DEVTOOL"\s+wallet\s+-w\s+"\$WALLET"\s+enhance\s+-s\s+"\$LWD"'
            r'\s+--connection\s+direct\s+2>&1\s*\)'
        ),
        'wallet hydration verification': re.compile(
            r'hydration_out\s*=\s*"\$\(\s*timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$wallet_remaining"' + continuation +
            r'"\$PYBIN"\s+-s\s+-m\s+zcashrpc\.wallet_hydration\s+2>&1\s*\)'
        ),
        'Secret Manager read': re.compile(
            r'DBPASS\s*=\s*"\$\(\s*timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$SECRET_TIMEOUT"' + continuation +
            r'gcloud\s+secrets\s+versions\s+access\s+latest\s+'
            r'--secret=free2z-dbpass' + continuation +
            r'--project\s+"\$CREDIT_SECRET_PROJECT"'
            r'\s+2>/dev/null\s*\)'
        ),
        'wallet tip observer': re.compile(
            r'tip_out\s*=\s*"\$\(\s*timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$CREDIT_WALLET_TIP_TIMEOUT"\s+' +
            continuation + r'"\$PYBIN"\s+-s\s+-m\s+zcashrpc\.wallet_tip'
            r'\s+2>&1\s*\)'
        ),
        'wallet freshness check': re.compile(
            r'if\s+!\s+timeout\s+-k\s+"\$KILL_GRACE"\s+'
            r'"\$CREDIT_WALLET_TIP_TIMEOUT"' + continuation +
            r'"\$CREDIT_WALLET_SYNC_PYTHON"\s+-B\s+-I\s+-c\s+'
            r'"\$ISOLATED_WALLET_MODULE_RUNNER"' + continuation +
            r'zcashrpc\.wallet_sync_freshness\s+"\$CREDIT_WALLET_SYNC_LIB"\s+check' + continuation +
            r'--marker\s+"\$CREDIT_WALLET_SYNC_MARKER"' + continuation +
            r'--wallet-db\s+"\$WALLET/data\.sqlite"' + continuation +
            r'--source\s+"\$LWD"' + continuation +
            r'--max-age\s+"\$CREDIT_WALLET_SYNC_POST_SYNC_MAX_AGE"' + continuation +
            r'--max-lag\s+"\$CREDIT_WALLET_SYNC_MAX_LAG"'
        ),
        'wallet freshness lock': re.compile(
            r'flock\s+-x\s+-w\s+"\$CREDIT_WALLET_SYNC_LOCK_TIMEOUT"\s+9'
        ),
        'manage.py wrapper': re.compile(
            r'run_django\s*\(\).*?out\s*=\s*"\$\(\s*timeout\s+-k\s+'
            r'"\$KILL_GRACE"\s+"\$deadline"' + continuation +
            r'"\$PYBIN"\s+-s\s+manage\.py\s+"\$cmd"\s+2>&1\s*\)',
            re.DOTALL,
        ),
        'credit_creators call': re.compile(
            r'run_django\s+credit_creators\s+"\$DJANGO_TIMEOUT"'
        ),
        'credit_pages_unified call': re.compile(
            r'run_django\s+credit_pages_unified\s+"\$remaining"'
        ),
    }


def missing_loop_bounds(text):
    """Return concrete required call shapes absent from ``credit-loop.sh``."""
    source = _without_shell_comments(text)
    missing = []
    for name, pattern in _required_loop_bound_patterns().items():
        if len(pattern.findall(source)) != 1:
            missing.append(name)
    return missing


@dataclass
class Config:
    stale_seconds: int = STALE_SECONDS_DEFAULT
    max_restarts: int = MAX_RESTARTS_DEFAULT
    restart_window_seconds: int = RESTART_WINDOW_SECONDS_DEFAULT
    unit: str = UNIT
    dependency_units: list = field(default_factory=list)
    restart_timeout: int = RESTART_TIMEOUT_DEFAULT
    unit_start_timeout: int = UNIT_START_TIMEOUT_DEFAULT
    errors: list = field(default_factory=list)
    # Things worth printing that are not errors -- e.g. a window this module
    # widened because the configured one made the ladder unreachable.
    notes: list = field(default_factory=list)
    # Set when the stale threshold is BELOW the loop's own longest legitimate
    # heartbeat-to-heartbeat gap. It is a refusal, not a note: with the
    # threshold under the ceiling, "silent for N seconds" no longer
    # distinguishes stuck from working.
    ceiling_conflict: str = None

    @property
    def ok(self):
        return not self.errors


def _bounded_int(name, raw, default, low, high, errors):
    """Reject anything that would disable or invert a control.

     learned this the expensive way on `timeout`: `SYNC_TIMEOUT=0`
    *disables* the deadline, so one plausible keystroke restored the original
    incident with every signal green. The failure modes here are the mirror
    image and worse, because this one has an actuator: a stale threshold of `0`
    makes every cycle stale and restarts the money loop every five minutes
    forever, and `CREDIT_WATCHDOG_MAX_RESTARTS=0` makes it give up before it
    ever tries. Both are refused, and a refusal is IMPAIRED (loud) rather than
    a fallback to the default (silent, and wrong in a way nobody can see).

    The LENGTH check runs first because Python happily parses a 40-digit
    integer and the range comparison would then be the only thing standing
    between a typo and a 10^40-second threshold; rejecting on magnitude is the
    point, so do it where the magnitude is legible.
    """
    if raw is None:
        return default
    text = str(raw).strip()
    if not re.fullmatch(r'[0-9]{1,9}', text):
        errors.append(
            f'{name}={raw!r} is not a whole number of 1-9 digits')
        return default
    value = int(text)
    if not low <= value <= high:
        errors.append(f'{name}={value} is outside {low}..{high}')
        return default
    return value


def load_config(env=None):
    env = os.environ if env is None else env
    errors = []
    config = _config_from(env, errors)
    # The escalation must FIT INSIDE the unit's own start deadline.
    unit_start = _bounded_int(
        'CREDIT_WATCHDOG_UNIT_START_TIMEOUT',
        env.get('CREDIT_WATCHDOG_UNIT_START_TIMEOUT'),
        UNIT_START_TIMEOUT_DEFAULT, 60, 86400, errors)
    restarts_per_run = 1 + len(config.dependency_units)
    budget = unit_start - RESTART_OVERHEAD_SECONDS
    max_restart_timeout = budget // (RESTART_CALLS_PER_UNIT * restarts_per_run)
    if max_restart_timeout < 5:
        errors.append(
            f'CREDIT_WATCHDOG_UNIT_START_TIMEOUT ({unit_start}s) leaves no '
            f'viable restart timeout after {RESTART_OVERHEAD_SECONDS}s of '
            f'overhead and {RESTART_CALLS_PER_UNIT} bounded calls per unit')
        max_restart_timeout = 5
    if config.restart_timeout > max_restart_timeout:
        config.notes.append(
            f'{IMPAIRED_SIGNAL} - CREDIT_WATCHDOG_RESTART_TIMEOUT '
            f'({config.restart_timeout}s) x {RESTART_CALLS_PER_UNIT} calls x '
            f'{restarts_per_run} units does '
            f'not fit inside the unit\'s TimeoutStartSec ({unit_start}s) once '
            f'{RESTART_OVERHEAD_SECONDS}s of overhead is allowed for. systemd '
            f'would kill this mid-escalation, before it could report or persist '
            f'its budget, and the next run would repeat it. Using '
            f'{max_restart_timeout}s. Raise TimeoutStartSec in '
            f'install-services.sh (and CREDIT_WATCHDOG_UNIT_START_TIMEOUT with '
            f'it) if you need longer.')
        config.restart_timeout = max_restart_timeout
    config.unit_start_timeout = unit_start

    # The ladder must be REACHABLE. See required_window().
    needed = required_window(config.max_restarts, config.stale_seconds)
    if config.restart_window_seconds < needed:
        config.notes.append(
            f'{IMPAIRED_SIGNAL} - CREDIT_WATCHDOG_RESTART_WINDOW_SECONDS '
            f'({config.restart_window_seconds}s) cannot hold '
            f'{config.max_restarts} restarts that are {config.stale_seconds}s '
            f'apart, so the escalation and give-up rungs would be unreachable '
            f'and the loop would flap forever. Using {needed}s instead. Set it '
            f'to at least that in /etc/default/free2z-credit-loop.')
        config.restart_window_seconds = needed
    # Computed HERE so `evaluate()` can refuse on it. It used to run in
    # `main()` AFTER the restart had already been executed, which meant an
    # operator who widened DJANGO_TIMEOUT for a legitimate backlog got the
    # backlog killed at 90 minutes and a warning about it afterwards.
    # (Codex adversarial review, round 4, finding 2.)
    config.ceiling_conflict = warn_if_thresholds_conflict(config, env)
    return config


def _config_from(env, errors):
    return Config(
        stale_seconds=_bounded_int(
            'CREDIT_WATCHDOG_STALE_SECONDS',
            env.get('CREDIT_WATCHDOG_STALE_SECONDS'),
            STALE_SECONDS_DEFAULT, 300, 86400, errors),
        max_restarts=_bounded_int(
            'CREDIT_WATCHDOG_MAX_RESTARTS',
            env.get('CREDIT_WATCHDOG_MAX_RESTARTS'),
            MAX_RESTARTS_DEFAULT, 1, 20, errors),
        restart_window_seconds=_bounded_int(
            'CREDIT_WATCHDOG_RESTART_WINDOW_SECONDS',
            env.get('CREDIT_WATCHDOG_RESTART_WINDOW_SECONDS'),
            RESTART_WINDOW_SECONDS_DEFAULT, 600, 604800, errors),
        unit=env.get('CREDIT_WATCHDOG_UNIT', UNIT),
        # 5..3600: a restart that takes an hour is not a restart, and anything
        # under 5s cannot outlast systemd's own stop sequence.
        restart_timeout=_bounded_int(
            'CREDIT_WATCHDOG_RESTART_TIMEOUT',
            env.get('CREDIT_WATCHDOG_RESTART_TIMEOUT'),
            RESTART_TIMEOUT_DEFAULT, 5, 3600, errors),
        dependency_units=[
            name for name in re.split(
                r'[,\s]+',
                env.get('CREDIT_WATCHDOG_DEPENDENCY_UNITS',
                        DEPENDENCY_UNITS_DEFAULT))
            if name
        ],
        errors=errors,
    )


def loop_bounds_state(path=None):
    """'yes' / 'no' / 'unknown' -- does the deployed loop carry 's bounds?

    This is a PRECONDITION of the actuator, not a footnote. The 5400s threshold
    means "stuck rather than working" only because the loop's own deadlines cap
    a legitimate heartbeat-to-heartbeat gap at 4620s. Against an UNBOUNDED loop
    there is no such cap: a real backlog run can exceed 90 minutes, get
    SIGTERMed, be restarted, and never finish -- the watchdog then prevents the
    recovery it was installed to perform.

    'unknown' when the file is not readable. Unknown is a safety failure, not
    evidence that the loop is bounded: restarting under that unverified timing
    assumption can kill a legitimate long-running cycle. Recovery remains
    available once the deployed file can be verified.
    """
    path = Path(LOOP_SCRIPT if path is None else path)
    try:
        text = path.read_text(errors='replace')
    except OSError:
        return 'unknown'
    return 'yes' if not missing_loop_bounds(text) else 'no'


def atomic_credit_code_state(path=None):
    """'yes' / 'no' / 'unknown' -- can a watchdog kill credit_zec_purchase?

    File presence is not the safety property. A partial restore can put an old
    ``zec.py`` back at the expected path while leaving the receipt and credit as
    two commits; the watchdog would then be allowed to SIGTERM the exact window
    that permanently loses a payment. Parse the deployed source and require the
    receipt insert, ledger credit, and event write to occur under
    ``transaction.atomic()`` in ``credit_zec_purchase``. The durable event
    helper is accepted only with its canonical import and a verified deployed
    implementation: Event.save and outbox.enqueue must share its atomic block
    and database alias. A syntax/read failure is ``unknown`` and fail-closed.
    """
    path = Path(ATOMIC_CREDIT_MODULE if path is None else path)
    try:
        tree = ast.parse(path.read_text(errors='replace'), filename=str(path))
    except (OSError, SyntaxError, ValueError):
        return 'unknown'

    def is_atomic_context(node):
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'atomic'
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == 'transaction'
        )

    def is_method_call(node, owner, parent, method):
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == method
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == parent
            and isinstance(node.func.value.value, ast.Name)
            and node.func.value.value.id == owner
        )

    required = {
        'receipt': ('ZecCreditReceipt', 'objects', 'create'),
        'credit': ('ledger', None, 'credit'),
        'event': ('Event', 'objects', 'create'),
    }
    class AtomicBodyCalls(ast.NodeVisitor):
        """Collect only calls on an unconditional lexical execution path.

        ``ast.walk`` also enters nested functions and conditional branches. A
        dead helper containing the three expected calls would then authorize
        the watchdog to SIGTERM a real, non-atomic credit operation. Reject
        those constructs by treating them as opaque; an unfamiliar control
        flow therefore fails closed instead of pretending to prove atomicity.
        """

        def __init__(self):
            self.found = set()
            self.durable_event = False

        def visit_FunctionDef(self, node):  # noqa: N802 - ast API
            return None

        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef
        visit_Lambda = visit_FunctionDef

        def visit_If(self, node):  # noqa: N802 - conditional path is unknown
            return None

        visit_For = visit_If
        visit_AsyncFor = visit_If
        visit_While = visit_If
        visit_Match = visit_If
        # Calls inside these expressions are not unconditional: short-circuit
        # operands and comprehensions may never execute. Treat them like an
        # opaque control-flow branch so a dead expression cannot certify a
        # non-atomic money path as safe to interrupt.
        visit_BoolOp = visit_If
        visit_IfExp = visit_If
        visit_ListComp = visit_If
        visit_SetComp = visit_If
        visit_DictComp = visit_If
        visit_GeneratorExp = visit_If

        def visit_Try(self, node):  # noqa: N802 - only the normal try body
            for statement in node.body:
                self.visit(statement)

        def visit_Call(self, node):  # noqa: N802 - ast API
            if isinstance(node.func, ast.Name) and node.func.id == 'create_durable_event':
                self.durable_event = True
            for name, (owner, parent, method) in required.items():
                if parent is None:
                    matches = (
                        isinstance(node.func, ast.Attribute)
                        and node.func.attr == method
                        and isinstance(node.func.value, ast.Name)
                        and node.func.value.id == owner
                    )
                else:
                    matches = is_method_call(node, owner, parent, method)
                if matches:
                    self.found.add(name)
            self.generic_visit(node)

    def without_docstring(body):
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            return body[1:]
        return body

    def same_ast(left, right):
        return ast.dump(left) == ast.dump(right)

    def durable_helper_state(function):
        # A familiar function NAME is not a proof. Accept only the canonical,
        # unconditional import, with no local rebinding, and inspect the helper
        # in the same deployed apps tree. Never import/execute that source.
        imports = [node for node in function.body if isinstance(node, ast.ImportFrom)
                   and node.module == 'dj.apps.events.dispatch' and node.level == 0]
        if len(imports) != 1 or len(imports[0].names) != 1 or not any(
                alias.name == 'create_durable_event' and alias.asname is None
                for alias in imports[0].names):
            return 'no'
        for node in ast.walk(function):
            if (isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))
                    and node.id == 'create_durable_event'):
                return 'no'
            if (isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef))
                    and node.name == 'create_durable_event'):
                return 'no'
            if isinstance(node, (ast.Import, ast.ImportFrom)) and node is not imports[0]:
                if any((a.asname or a.name.split('.')[0]) == 'create_durable_event'
                       for a in node.names):
                    return 'no'
        helper_path = path.parent.parent / 'events' / 'dispatch.py'
        try:
            helper_tree = ast.parse(helper_path.read_text(), filename=str(helper_path))
        except (OSError, SyntaxError, ValueError):
            return 'unknown'
        # Deliberately recognize this small helper's execution shape, rather
        # than guessing about arbitrary callbacks or indirect writes. Comments,
        # docstrings and delivery metadata may change; new execution structure
        # requires a fresh assessment before recovery may interrupt a credit.
        module_body = without_docstring(helper_tree.body)
        expected_imports = ast.parse(
            'from django.conf import settings\n'
            'from django.db import transaction\n'
            'from dj.apps.jobs import outbox\n'
            'from .models import Event\n').body
        if len(module_body) != 5 or {
                ast.dump(n) for n in module_body[:4]} != {
                ast.dump(n) for n in expected_imports}:
            return 'no'
        helper = module_body[4]
        if (not isinstance(helper, ast.FunctionDef)
                or helper.name != 'create_durable_event' or helper.decorator_list
                or not any(same_ast(helper.args, ast.parse(signature).body[0].args)
                    for signature in ('def helper(**fields): pass',
                                      'def helper(*, wake_up=True, **fields): pass'))):
            return 'no'
        body = without_docstring(helper.body)
        skeleton = ast.parse(
            'using = Event.objects.db\n'
            'with transaction.atomic(using=using):\n'
            '    event = Event(**fields)\n'
            '    event._durable_publication = True\n'
            '    event.save(using=using, force_insert=True)\n'
            'return event\n').body
        if (len(body) != 3 or not same_ast(body[0], skeleton[0])
                or not isinstance(body[1], ast.With)
                or len(body[1].items) != 1
                or not same_ast(body[1].items[0], skeleton[1].items[0])
                or not same_ast(body[2], skeleton[2])):
            return 'no'
        writes = body[1].body
        if len(writes) != 4 or any(
                not same_ast(actual, expected)
                for actual, expected in zip(writes[:3], skeleton[1].body)):
            return 'no'
        promise = writes[3].value if isinstance(writes[3], ast.Expr) else None
        if not (isinstance(promise, ast.Call)
                and same_ast(promise.func, ast.parse('outbox.enqueue').body[0].value)):
            return 'no'
        if not any(k.arg == 'using' and isinstance(k.value, ast.Name)
                   and k.value.id == 'using' for k in promise.keywords):
            return 'no'
        allowed_calls = {
            ast.dump(ast.parse('event.to_dict()').body[0].value),
            ast.dump(ast.parse('str(event.pk)').body[0].value),
        }
        if (any(k.arg is None for k in promise.keywords)
                or any(isinstance(n, ast.Call) and n is not promise
                       and ast.dump(n) not in allowed_calls for n in ast.walk(promise))):
            return 'no'
        return 'yes'

    for function in ast.walk(tree):
        if not (isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
                and function.name == 'credit_zec_purchase'):
            continue
        for node in function.body:
            if not isinstance(node, (ast.With, ast.AsyncWith)):
                continue
            if not any(is_atomic_context(item.context_expr)
                       for item in node.items):
                continue
            calls = AtomicBodyCalls()
            for statement in node.body:
                calls.visit(statement)
            if calls.found == set(required):
                return 'yes'
            if calls.found == {'receipt', 'credit'} and calls.durable_event:
                return durable_helper_state(function)
        return 'no'
    return 'no'

# credit-loop.sh does NOT refuse to start on a bad wallet-tip setting (the
# observer is advisory): it logs and falls back. The ceiling must be computed
# from the value the loop actually runs with, not the raw env text, or a typo
# the loop ignored (30000 for 30s) makes this watchdog refuse every restart,
# and a negative one hides a real conflict. Mirrors the shell block exactly.
_WALLET_TIP_MAX_BOUND = 14400


def effective_wallet_tip_timeout(env):
    """The outer wallet-tip timeout credit-loop.sh will really use."""
    def parse(name, default):
        raw = env.get(name)
        raw = str(default) if raw is None or raw == '' else str(raw)
        if (not re.fullmatch(r'[1-9][0-9]*', raw) or len(raw) > 5
                or int(raw) > _WALLET_TIP_MAX_BOUND):
            return default
        return int(raw)

    outer = parse('CREDIT_WALLET_TIP_TIMEOUT', 30)
    grpc = parse('CREDIT_WALLET_TIP_GRPC_TIMEOUT', 15)
    if grpc >= outer:
        grpc = 15
        if grpc >= outer:
            outer = 30
    if grpc + 10 >= outer:
        grpc, outer = 15, 30
    return outer


def warn_if_thresholds_conflict(config, env=None):
    """One line if the loop can legitimately be silent longer than we allow.

    The safety argument for restarting a money loop rests entirely on "a loop
    still working cannot be silent this long", and that is only true while this
    threshold exceeds the sum of the loop's own deadlines. Raising
    `DJANGO_TIMEOUT` for a slow backlog is a reasonable operator action, and it
    silently invalidates the argument. Both units read the same
    `/etc/default/free2z-credit-loop`, so the sum is computable here rather
    than left to somebody's memory.

    A warning, never a refusal: refusing to supervise the loop because a
    deadline was widened would trade a narrow, documented kill window for no
    supervision at all.
    """
    env = os.environ if env is None else env

    def bound(name):
        raw = env.get(name)
        try:
            return int(str(raw).strip()) if raw is not None else \
                _LOOP_BOUND_DEFAULTS[name]
        except ValueError:
            return _LOOP_BOUND_DEFAULTS[name]

    # HEARTBEAT to HEARTBEAT spans the tail of one cycle and the head of the
    # next -- see STALE_SECONDS_DEFAULT. The shared sync/enhance/hydration phase
    # has one deadline. Freshness validation and advisory tip observation each
    # have a wallet-tip timeout; the producer-mode probe adds a second secret
    # read. The shared freshness lock is awaited once and has no timeout grace.
    # Six subprocess deadlines can each be followed by KILL_GRACE.
    lock_timeout = bound('CREDIT_WALLET_SYNC_LOCK_TIMEOUT')
    if (lock_timeout < 1 or lock_timeout > 14400):
        lock_timeout = _LOOP_BOUND_DEFAULTS['CREDIT_WALLET_SYNC_LOCK_TIMEOUT']
    total = (2 * bound('DJANGO_TIMEOUT') + bound('SYNC_TIMEOUT')
             + 2 * bound('SECRET_TIMEOUT') + bound('INTERVAL')
             + lock_timeout + 2 * effective_wallet_tip_timeout(env)
             + 6 * bound('KILL_GRACE'))
    if total < config.stale_seconds:
        return None
    return (
        f'{IMPAIRED_SIGNAL} - the credit loop\'s longest legitimate '
        f'heartbeat-to-heartbeat gap is {total}s '
        f'(2*DJANGO_TIMEOUT + SYNC_TIMEOUT + 2*SECRET_TIMEOUT + INTERVAL + '
        f'CREDIT_WALLET_SYNC_LOCK_TIMEOUT + '
        f'2*CREDIT_WALLET_TIP_TIMEOUT + 6*KILL_GRACE) '
        f'but CREDIT_WATCHDOG_STALE_SECONDS is {config.stale_seconds}s, so a '
        f'cycle that is still legitimately working can look stale. Restarting '
        f'then SIGTERMs a running credit_creators, which on pre-#1346 host '
        f'code can lose a payment permanently. Raise '
        f'CREDIT_WATCHDOG_STALE_SECONDS above {total}s in '
        f'/etc/default/free2z-credit-loop.')


# ------------------------------------------------------------------ sampling
@dataclass
class Sample:
    now: int
    monotonic: float = None
    heartbeats: int = 0
    log_error: str = None
    atomic_credit_code_state: str = 'yes'
    # What the loop itself last said was wedged, if anything. See scan_log().
    last_hang: str = None
    # `systemctl is-active` for the watched unit. `restart` on an inactive unit
    # STARTS it, so this is what stops a watchdog from resurrecting a loop
    # somebody stopped on purpose. See unit_state().
    unit_state: str = 'active'
    # Opaque; changes every time the unit enters `active`. None means systemd
    # could not provide an observation, rather than an empty successful value.
    # See unit_started_at().
    unit_started_at: str = None
    # 'yes' / 'no' / 'unknown' -- does the DEPLOYED credit-loop.sh carry
    # 's `timeout -k` deadlines? The stale threshold is derived from them,
    # so without them there is no ceiling and "silent for 90 minutes" no longer
    # implies "stuck". See loop_bounds_state().
    loop_bounds: str = 'yes'
    producer_mode: str = 'legacy'
    producer_ready: bool = True


def scan_log(path=None, producer_mode='legacy'):
    """(heartbeat count, what last wedged, error).

    Two things out of one pass over the same file.

    THE SECOND ONE IS THE 3AM HALF. "Restarted three times, still no heartbeat"
    is a report that names no culprit, and a watchdog that names the wrong
    culprit is only marginally better than one that says nothing.  makes
    the loop print `!! HANG: <what> did not return within Ns...` naming the
    exact external call it had to kill -- the wallet sync, the Secret Manager
    read, or `manage.py credit_creators` -- so the attribution already exists in
    the file this module is reading anyway.

    Only a hang recorded AFTER the last heartbeat is reported. A `!! HANG:` from
    three days ago describes an incident that resolved, and quoting it during a
    fresh one sends the responder to the wrong layer.

    It is deliberately tolerant of the line being absent: a stall in a call
    nobody wrapped -- which is the whole reason this watchdog exists as well as
    those bounds -- produces no `!! HANG:` at all, and "no bounded call reported
    a hang" is itself a useful thing to say.
    """
    path = LOGFILE if path is None else path
    try:
        count = 0
        last_heartbeat_line = -1
        last_hang = None
        last_hang_line = -1
        for index, line in enumerate(open(path, 'r', errors='replace')):
            if ((_HEARTBEAT_RE.match(line) if producer_mode == 'legacy'
                 else line.startswith(MAINTENANCE_HEARTBEAT))):
                count += 1
                last_heartbeat_line = index
                continue
            match = _HANG_RE.match(line)
            if match:
                last_hang = match.group(1).strip()
                last_hang_line = index
        if last_hang is not None and last_hang_line < last_heartbeat_line:
            last_hang = None
        return count, last_hang, None
    except OSError as exc:
        return None, None, f'cannot read the credit loop log: {exc}'


def unit_state(unit, timeout=20):
    """`systemctl is-active <unit>`, or 'unknown' if it cannot be asked.

    `systemctl restart` on an INACTIVE unit starts it. So a watchdog with no
    such check will resurrect a credit loop an operator stopped deliberately --
    during maintenance, or during a schema incident where running it against
    the database is the thing they were avoiding. Reinstalling the units is
    enough to trigger it, since install-services.sh runs one validation cycle.
    (Codex adversarial review, finding 5.)

    'unknown' means THE QUESTION COULD NOT BE ANSWERED -- a timeout, an OSError,
    or empty output. It is NOT a synonym for active. This used to say the
    caller treated it as active, on the reasoning that failing to reach systemd
    must not disable recovery; that is fail-OPEN on an actuator, and on this
    actuator the action is SIGTERMing a money loop. If systemd cannot be asked
    whether the unit is running, the honest answer is that we do not know, and
    a watchdog that does not know must not fire. (Owner review of //
    , blocker 1.)
    """
    try:
        done = subprocess.run(
            ['systemctl', 'is-active', unit],
            capture_output=True, text=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return 'unknown'
    return (done.stdout or '').strip() or 'unknown'


def unit_started_at(unit, timeout=20):
    """`ActiveEnterTimestampMonotonic` for the unit, as an opaque string.

    THE MAINTENANCE-PAUSE FALSE RESTART. `progress_at` only advances on a
    heartbeat-count change or on one of our own restarts, so a loop that was
    deliberately STOPPED and later started again carries the whole pause as
    apparent staleness: the first tick after `resume_services()` sees an
    unchanged count and `stale_for` = the entire window, and SIGTERMs a healthy
    loop that started seconds ago. A six-hour maintenance window produces
    `RESTARTING THE CREDIT LOOP - no new heartbeat for 21600s` and sends the
    responder at cloud-sql-proxy for a non-event.

    This is not exotic: `deploy-credit-code.sh` stops the loop for the upgrade,
    and its `--assume-migrated` flow tells the operator to go run a production
    migration by hand and come back -- inherently multi-hour. The documented
    path triggers it.

    The MONOTONIC form is used rather than the wall-clock one on purpose: it is
    an opaque counter that simply CHANGES on every entry into `active`, so this
    is an equality test with no date parsing, no locale, and no clock skew --
    and a reboot resets it, which reads as "restarted", which is correct.

    A unit that keeps re-entering active is crash-looping, not wedged, and
    re-arming there is also correct: restarting a crash-loop accomplishes
    nothing, systemd is already doing it, and the heartbeat absence policy
    (`prod | ZEC credit loop not crediting`, 15m) is the signal that covers it.
    """
    try:
        done = subprocess.run(
            ['systemctl', 'show', '-p', 'ActiveEnterTimestampMonotonic',
             '--value', unit],
            capture_output=True, text=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if done.returncode != 0:
        return None
    value = (done.stdout or '').strip()
    return value or None


def collect(now=None, path=None, atomic_module=None, unit=None):
    now = int(time.time()) if now is None else now
    mode = buy_producer_mode()
    count, last_hang, error = scan_log(path, producer_mode=mode)
    module = ATOMIC_CREDIT_MODULE if atomic_module is None else Path(
        atomic_module)
    return Sample(
        now=now,
        monotonic=time.monotonic(),
        heartbeats=0 if count is None else count,
        log_error=error,
        atomic_credit_code_state=atomic_credit_code_state(module),
        last_hang=last_hang,
        unit_state=unit_state(UNIT if unit is None else unit),
        unit_started_at=unit_started_at(UNIT if unit is None else unit),
        loop_bounds=loop_bounds_state(),
        producer_mode=mode,
        producer_ready=(mode == 'legacy' or guarded_release(Path(LOOP_SCRIPT).resolve().parents[2])),
    )


# ------------------------------------------------------------------ decision
def _recent(restarts, now, window):
    out = []
    for entry in restarts or []:
        if isinstance(entry, bool) or not isinstance(entry, int):
            continue
        # Keep future entries.  They are evidence that this host's wall clock
        # moved backwards; dropping them would erase the restart budget and
        # authorize extra attempts after an NTP correction.  They age out once
        # the clock catches up, while the rollback guard below prevents action
        # during the correction itself.
        if entry > now or now - entry < window:
            out.append(entry)
    return sorted(out)


def _state_times(state):
    """Return persisted wall-clock timestamps, including future evidence."""
    values = []
    for key in ('progress_at', 'last_observed_at', 'clock_high_water'):
        value = state.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            values.append(value)
    for key in ('restarts', 'dependency_restarts', 'restart_decisions'):
        for value in state.get(key, []) or []:
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                values.append(value)
    return values


def _clock_rollback(previous, now):
    """Whether the sample is earlier than any persisted wall-clock evidence."""
    return bool(_state_times(previous)) and now < max(_state_times(previous))


def _clock_forward_jump(previous, now, monotonic_now):
    """Whether wall time jumped while the host's monotonic clock did not."""
    observed = previous.get('last_observed_at')
    observed_monotonic = previous.get('monotonic_at')
    if (not isinstance(observed, int) or isinstance(observed, bool)
            or not isinstance(observed_monotonic, (int, float))
            or isinstance(observed_monotonic, bool)
            or not isinstance(monotonic_now, (int, float))
            or isinstance(monotonic_now, bool)):
        return False
    wall_delta = now - observed
    monotonic_delta = monotonic_now - observed_monotonic
    return (wall_delta > CLOCK_FORWARD_JUMP_SECONDS
            and 0 <= monotonic_delta <
            wall_delta - CLOCK_FORWARD_JUMP_TOLERANCE_SECONDS)


def _attribution(sample):
    """One clause naming what the loop itself said was wedged.

    "Restarted three times, still no heartbeat" names no culprit, and at 3am
    that is the difference between looking at zec.rocks, the Cloud SQL proxy,
    and Secret Manager.  already writes the answer into the log; this
    quotes it back.
    """
    if sample.last_hang:
        return f'the loop last reported `{sample.last_hang}` wedged'
    return ('the loop reported no bounded call as wedged, so the stall is NOT '
            'one of the calls credit-loop.sh wraps -- look at its dependencies '
            '(cloud-sql-proxy, Secret Manager, zec.rocks) before the loop itself')


def _supervision_precondition_failure(sample, config, previous=None):
    """Return an impairment when recovery would be unsafe or ungrounded.

    These checks must run before either a first baseline or a restart re-arm.
    A baseline only proves that the watchdog has observed a log; it does not
    prove that the watched unit is running or that restarting it is safe. In
    particular, emitting ``cycle ok`` here would arm the absence policy while
    the loop was stopped, running unbounded code, or still using the legacy
    split-transaction credit path.
    """
    if sample.producer_mode not in ('legacy', 'paymentd', 'invalid') or not sample.producer_ready:
        return (f'{IMPAIRED_SIGNAL} - producer selection/readiness unavailable; '
                'NOT restarting a release without verified maintenance guards.')

    if sample.unit_state == 'unknown':
        return (
            f'{IMPAIRED_SIGNAL} - could not determine whether {config.unit} is '
            f'running (`systemctl is-active` timed out, failed, or answered '
            f'nothing). NOT restarting: a restart would START a unit that may '
            f'have been stopped on purpose, and this cannot tell the '
            f'difference. Check the host.')

    if sample.unit_state not in ('active', 'activating', 'reloading'):
        return (
            f'{IMPAIRED_SIGNAL} - {config.unit} is `{sample.unit_state}`, not '
            f'running. NOT restarting: `systemctl restart` would START a unit '
            f'somebody stopped on purpose. Nobody is being credited while it is '
            f'down. Start it when you mean to, or stop '
            f'free2z-credit-watchdog.timer for a planned window.')

    if sample.loop_bounds != 'yes':
        if sample.loop_bounds == 'unknown':
            explanation = (
                f'{LOOP_SCRIPT} is missing or unreadable, so the deployed loop '
                f'cannot be verified as carrying #1468\'s `timeout -k` bounds')
        else:
            try:
                missing = missing_loop_bounds(Path(LOOP_SCRIPT).read_text(errors='replace'))
            except OSError:
                missing = ['the loop script could not be read']
            explanation = (
                f'{LOOP_SCRIPT} has no `timeout -k` bounds verified for required '
                f'calls; missing bounded call structure: '
                f'{", ".join(missing)} (#1468)')
        return (
            f'{IMPAIRED_SIGNAL} - {explanation}; a cycle has NO verified '
            f'ceiling on how long it can legitimately be silent. NOT restarting: '
            f'without that ceiling, silence cannot distinguish a wedged cycle '
            f'from a working one, and killing a slow-but-progressing '
            f'credit_creators is how a backlog never finishes. Deploy and verify '
            f'the bounded loop (zcash/pipeline/deploy-credit-code.sh --apply).')

    if sample.atomic_credit_code_state != 'yes':
        if sample.atomic_credit_code_state == 'unknown':
            detail = (
                f'{ATOMIC_CREDIT_MODULE} is missing, unreadable, or invalid '
                f'Python, so its atomic crediting semantics cannot be verified')
        else:
            detail = (
                f'{ATOMIC_CREDIT_MODULE} does not contain the required '
                f'credit_zec_purchase transaction.atomic() covering the receipt, '
                f'ledger credit, and event writes')
        return (
            f'{IMPAIRED_SIGNAL} - LEGACY CREDIT CODE ON HOST: {detail}. '
            f'NOT restarting: a SIGTERM between those two commits loses that '
            f'payment permanently. Deploy the #1346 code '
            f'(zcash/pipeline/deploy-credit-code.sh --apply), then this recovers '
            f'on its own.')

    if config.ceiling_conflict:
        return (f'{config.ceiling_conflict} This cannot tell a wedged cycle '
                f'from a working one, so no health heartbeat is emitted.')

    return None


def evaluate(sample, previous, config):
    """(lines, next_state, units to restart). Pure -- no clock, no subprocess.

    Everything that decides whether the money loop gets SIGTERMed is in here so
    that `bin/test-credit-watchdog.sh` can drive every branch from a fixture,
    including the three that matter most: a FRESH heartbeat must not restart
    anything, output-without-a-heartbeat must be treated as stale, and a host
    that has never once printed the heartbeat must be reported rather than
    power-cycled forever.

    The third return value is an ORDERED list. When the escalation rung fires it
    is `[cloud-sql-proxy.service, free2z-credit-loop.service]` -- the dependency
    first, so the loop comes up against a fresh proxy instead of re-attaching to
    the wedged one. ``restarts`` and ``dependency_restarts`` count commands
    actually reached by ``main()``, while ``restart_decisions`` and
    ``pending_restart_units`` preserve a decision before actuation.
    """
    now = sample.now
    # A financial heartbeat count cannot become a maintenance baseline. Keep
    # the actuator budget, but re-arm progress when the producer changes.
    if previous.get('producer_mode', 'legacy') != sample.producer_mode:
        previous = dict(previous, heartbeats=None, progress_at=None, ever_seen=False,
                        pending_restart_units=[])
    lines = []
    restarts = _recent(previous.get('restarts'), now, config.restart_window_seconds)
    dependency_restarts = _recent(
        previous.get('dependency_restarts'), now,
        config.restart_window_seconds)
    decisions = _recent(
        previous.get('restart_decisions'), now,
        config.restart_window_seconds)
    pending = previous.get('pending_restart_units', [])
    if not isinstance(pending, list) or any(
            not isinstance(unit, str) or not unit for unit in pending):
        pending = None
    # STICKY. `ever_seen` is the difference between "this loop stopped" and
    # "this host has never once printed the heartbeat". The second is what a
    # host running a pre- `credit_creators` looks like -- the command did
    # not print the line at all -- and a watchdog that treats the two the same
    # restarts the money loop every 90 minutes forever against a host that was
    # never going to emit the signal.
    #
    # It has to be sticky rather than "is the count zero right now", because
    # logrotate legitimately takes a healthy loop's count to zero once a day,
    # and a genuine wedge spanning that rotation must still be recovered.
    state = {
        'heartbeats': sample.heartbeats,
        'producer_mode': sample.producer_mode,
        'progress_at': previous.get('progress_at'),
        'restarts': restarts,
        # A decision is not an attempted command. The latter is recorded by
        # main() immediately before each subprocess invocation.
        'restart_decisions': decisions,
        'pending_restart_units': pending if pending is not None else [],
        'ever_seen': bool(previous.get('ever_seen')) or sample.heartbeats > 0,
        'unit_started_at': sample.unit_started_at,
        'dependency_restarts': dependency_restarts,
        # Keep a high-water mark.  `time.time()` is persisted for compatibility
        # with the existing state format, but it is not monotonic across NTP
        # corrections or a bad RTC.
        'last_observed_at': max(
            [sample.now] + [value for value in _state_times(previous)
                            if isinstance(value, int)]),
        'clock_high_water': max(
            [sample.now] + [value for value in _state_times(previous)
                            if isinstance(value, int)]),
        'monotonic_at': sample.monotonic,
    }

    if not config.ok:
        state['progress_at'] = state['progress_at'] or now
        return ([f'{IMPAIRED_SIGNAL} - refusing to supervise with an unusable '
                 f'configuration: {"; ".join(config.errors)}. Nothing was '
                 f'restarted.'], state, [])

    if sample.log_error:
        # Keep progress_at where it was. When the log comes back the count will
        # differ from whatever we last recorded and register as progress.
        state['heartbeats'] = previous.get('heartbeats', sample.heartbeats)
        state['progress_at'] = state['progress_at'] or now
        return ([f'{IMPAIRED_SIGNAL} - {sample.log_error}. The credit loop is '
                 f'UNSUPERVISED: no heartbeat can be observed, so nothing was '
                 f'restarted. Check that {LOGFILE} exists and that '
                 f'install-ops-agent.sh has been run.'], state, [])

    # A wall-clock rollback is not a reason to forget the future.  In
    # particular, `_recent()` intentionally retained future attempt timestamps
    # above; treating them as absent here would reset the restart budget exactly
    # when NTP/RTC correction makes repeated recovery most dangerous.  Hold the
    # complete read/evaluate/persist/actuate cycle in this fail-closed state
    # until the clock reaches the persisted high-water mark.
    if _clock_rollback(previous, now):
        state['progress_at'] = previous.get('progress_at')
        state['last_observed_at'] = max(_state_times(previous))
        state['clock_high_water'] = max(_state_times(previous))
        state['clock_rollback_seen'] = True
        return ([f'{IMPAIRED_SIGNAL} - wall clock moved backwards from '
                 f'{max(_state_times(previous))} to {now}; preserving future '
                 f'restart attempts and the existing progress baseline. NOT '
                 f'restarting until the clock catches up, so NTP/RTC correction '
                 f'cannot reset the recovery budget.'], state, [])

    if _clock_forward_jump(previous, now, sample.monotonic):
        state['progress_at'] = now
        state['last_observed_at'] = now
        state['clock_high_water'] = now
        state['clock_forward_jump_seen'] = True
        return ([f'{IMPAIRED_SIGNAL} - wall clock jumped forward from '
                 f'{previous["last_observed_at"]} to {now}; re-arming the '
                 f'heartbeat baseline instead of treating the whole gap as '
                 f'staleness. NOT restarting during the correction.'], state, [])

    state['clock_rollback_seen'] = False
    state['clock_forward_jump_seen'] = False

    precondition_failure = _supervision_precondition_failure(
        sample, config, previous)
    if precondition_failure:
        # Do not advance `progress_at`: this is not a valid supervision
        # baseline. Once the host is safe, the next cycle must take a genuine
        # first baseline and emit the normal cycle signal.
        state['progress_at'] = previous.get('progress_at')
        return [precondition_failure], state, []

    # ---- RE-ARM ON A RESTART WE DID NOT DO. See unit_started_at(). A unit that
    # has entered `active` since the last cycle has been stopped and started --
    # a maintenance pause, a reboot, a manual `systemctl restart`, or one of our
    # own -- and the silence during that window says nothing about whether the
    # loop is wedged NOW. Counting it as staleness SIGTERMs a loop that started
    # seconds ago, which is what deploy-credit-code.sh's own --assume-migrated
    # flow would have produced on its first real use.
    previous_started = previous.get('unit_started_at')
    if (sample.unit_started_at and previous_started
            and sample.unit_started_at != previous_started):
        if sample.heartbeats <= (previous.get('heartbeats') or 0):
            state['progress_at'] = now
            state['pending_restart_units'] = []
            lines.append(
                f'{IMPAIRED_SIGNAL} - {config.unit} restarted but has not '
                f'produced a new credit_creators heartbeat yet; refusing to '
                f'call the rollout healthy. The watchdog will re-check after '
                f'the first completed credit cycle.')
            return lines, state, []
        state['progress_at'] = now
        state['pending_restart_units'] = []
        lines.append(
            f'{CYCLE_SIGNAL} - {config.unit} has restarted since the last '
            f'cycle, so the clock is re-armed rather than counting the gap as '
            f'staleness; stale after {config.stale_seconds}s')
        return lines, state, []

    previous_at = previous.get('progress_at')
    previous_count = previous.get('heartbeats')
    if not isinstance(previous_at, int) or isinstance(previous_at, bool):
        # First run, or a state file that lost its baseline. Arm, do not act:
        # a watchdog whose first action after every reboot is to restart the
        # thing it watches is a reboot loop with extra steps.
        state['progress_at'] = now
        lines.append(
            f'{CYCLE_SIGNAL} - armed, baseline {sample.heartbeats} heartbeats; '
            f'stale after {config.stale_seconds}s')
        return lines, state, []

    if previous_count != sample.heartbeats:
        # A recovery decision may have been persisted before the process was
        # killed, but if the loop produced a heartbeat before the pending
        # command was reached, discard that stale action. It was a decision,
        # not an instruction to restart a loop that has recovered itself.
        state['pending_restart_units'] = []
        # PROGRESS. Note this is a change in the COUNT, in either direction:
        # a decrease is logrotate, not a wedge.
        state['progress_at'] = now
        lines.append(
            f'{CYCLE_SIGNAL} - last new heartbeat observed 0s ago, '
            f'{sample.heartbeats} in the current log; stale after '
            f'{config.stale_seconds}s; {len(restarts)} restart(s) in the last '
            f'{config.restart_window_seconds}s')
        return lines, state, []

    if pending:
        # The escalation decision is intentionally persisted before actuation.
        # If the process dies before the per-action accounting write, resume
        # the unperformed action on the next cycle without emitting another
        # decision metric. Once an action is accounted for, main() clears this
        # list before invoking it, so a failed dependency cannot queue the loop
        # behind a known-broken proxy.
        lines.append(
            f'{IMPAIRED_SIGNAL} - continuing the previously recorded restart '
            f'decision for {", ".join(pending)}; the preceding unit did not '
            f'complete, so no later unit was attempted yet.')
        return lines, state, list(pending)

    stale_for = now - previous_at
    if stale_for <= config.stale_seconds:
        lines.append(
            f'{CYCLE_SIGNAL} - last new heartbeat observed {stale_for}s ago, '
            f'{sample.heartbeats} in the current log; stale after '
            f'{config.stale_seconds}s; {len(restarts)} restart(s) in the last '
            f'{config.restart_window_seconds}s')
        return lines, state, []

    # ---- stale.
    why = _attribution(sample)

    # Nonlegacy readiness proves the maintenance emitter exists. A dependency
    # can wedge before its first cycle, so retain the bounded recovery ladder.
    if not state['ever_seen'] and sample.producer_mode == 'legacy':
        # Never, not merely not-lately. Restarting cannot make a host start
        # printing a line its code does not contain, so this is reported rather
        # than acted on -- and the diagnosis is named, because "3 restarts and
        # still nothing" would send a responder hunting a wedge that is not
        # there.
        lines.append(
            f'{IMPAIRED_SIGNAL} - no `credit_creators: cycle ok` line has EVER '
            f'been seen in {LOGFILE} (armed {stale_for}s ago). NOT restarting: '
            f'a restart cannot make code print a line it does not contain. The '
            f'likely cause is that the host tree is behind the repo -- the '
            f'pre-#1132 credit command never printed this heartbeat at all. '
            f'Check bin/check-credit-code-drift.py --compare, and {why}.')
        return lines, state, []

    if len(restarts) >= max(0, config.max_restarts):
        # RUNG 2, once per window: the loop may not be the wedged party.
        if config.dependency_units and not dependency_restarts:
            state['progress_at'] = now
            state['restart_decisions'] = decisions + [now]
            state['pending_restart_units'] = (
                list(config.dependency_units) + [config.unit])
            lines.append(
                f'{RESTART_ATTEMPT_SIGNAL} - ESCALATING before loop restart attempt '
                f'{len(restarts) + 1} (after {len(restarts)} actual loop restart '
                f'attempts) of {config.unit} in '
                f'{config.restart_window_seconds}s with no '
                f'heartbeat for {stale_for}s: also restarting '
                f'{", ".join(config.dependency_units)} first. A half-open '
                f'socket does not make cloud-sql-proxy EXIT, so its '
                f'Restart=always never fires and every loop restart reconnects '
                f'through the same wedged proxy. Once per window only; {why}.')
            # BE HONEST WHEN THE ATTRIBUTION DISAGREES. If the loop named a
            # NON-database call -- a wedged zec.rocks sync, say, and zec.rocks
            # is measured failing several times a day -- the proxy was never the
            # suspect, and a >4.5h upstream outage would otherwise end in a
            # DB-proxy restart plus a CRITICAL give-up page for something that
            # was never the proxy.
            #
            # Rung 2 still FIRES: skipping it would remove recovery for the case
            # where the sync wedged because nothing downstream was reachable,
            # and the blast radius is one proxy restart per window. But the
            # responder is told the restart was precautionary rather than
            # indicated, so the page does not read as "the proxy broke".
            if sample.last_hang and 'manage.py' not in sample.last_hang:
                lines.append(
                    f'{IMPAIRED_SIGNAL} - note: that dependency restart is '
                    f'PRECAUTIONARY, not indicated. The loop blamed '
                    f'`{sample.last_hang}`, which is not the database path, so '
                    f'{", ".join(config.dependency_units)} was probably never '
                    f'the problem. Start from what the loop actually named.')
            return lines, state, list(config.dependency_units) + [config.unit]
        # RUNG 3. Deliberately do NOT move progress_at: the line then repeats
        # every cycle for as long as the condition holds, which is what makes it
        # a presence signal a 1h autoClose can track -- and what makes an
        # auto-healing loop that never heals LOUDER than one that simply died.
        lines.append(
            f'{GIVING_UP_SIGNAL} - {len(restarts)} restarts of {config.unit} '
            f'(and {len(dependency_restarts)} of its dependencies) in the last '
            f'{config.restart_window_seconds}s and there is still no '
            f'credit_creators heartbeat after {stale_for}s. Restarting again is '
            f'not working; this needs a human. {why[0].upper()}{why[1:]}. No '
            f'further restart until the window drains.')
        return lines, state, []

    state['progress_at'] = now
    state['restart_decisions'] = decisions + [now]
    state['pending_restart_units'] = [config.unit]
    lines.append(
        f'{RESTART_ATTEMPT_SIGNAL} - no new credit_creators heartbeat for {stale_for}s '
        f'(threshold {config.stale_seconds}s); decided to restart {config.unit} '
        f'(restart {len(restarts) + 1} of {config.max_restarts} allowed; actual '
        f'command attempt {len(restarts) + 1} in '
        f'{config.restart_window_seconds}s); {why}')
    return lines, state, [config.unit]


# --------------------------------------------------------------------- state
def _validate_state(loaded, path):
    """Reject malformed state before it can erase a persisted budget."""
    integer_fields = ('heartbeats', 'progress_at', 'last_observed_at',
                      'clock_high_water')
    for key in integer_fields:
        if key in loaded and loaded[key] is not None and (
                isinstance(loaded[key], bool) or not isinstance(loaded[key], int)
                or loaded[key] < 0):
            return f'{path} has invalid {key}; refusing recovery'
    for key in ('restarts', 'dependency_restarts', 'restart_decisions'):
        values = loaded.get(key, [])
        if not isinstance(values, list) or any(
                isinstance(value, bool) or not isinstance(value, int) or value < 0
                for value in values):
            return f'{path} has invalid {key}; refusing recovery'
    pending = loaded.get('pending_restart_units', [])
    if not isinstance(pending, list) or any(
            not isinstance(value, str) or not value for value in pending):
        return f'{path} has invalid pending_restart_units; refusing recovery'
    if 'ever_seen' in loaded and not isinstance(loaded['ever_seen'], bool):
        return f'{path} has invalid ever_seen; refusing recovery'
    if 'unit_started_at' in loaded and loaded['unit_started_at'] is not None \
            and not isinstance(loaded['unit_started_at'], str):
        return f'{path} has invalid unit_started_at; refusing recovery'
    if 'clock_rollback_seen' in loaded and not isinstance(
            loaded['clock_rollback_seen'], bool):
        return f'{path} has invalid clock_rollback_seen; refusing recovery'
    if 'clock_forward_jump_seen' in loaded and not isinstance(
            loaded['clock_forward_jump_seen'], bool):
        return f'{path} has invalid clock_forward_jump_seen; refusing recovery'
    if 'monotonic_at' in loaded and loaded['monotonic_at'] is not None and (
            isinstance(loaded['monotonic_at'], bool)
            or not isinstance(loaded['monotonic_at'], (int, float))
            or loaded['monotonic_at'] < 0):
        return f'{path} has invalid monotonic_at; refusing recovery'
    return None


def read_state(path=None):
    """(state, error). Missing is fine; unreadable is not.

    A state file that cannot be read makes every cycle look like a first run,
    and a permanent first run never restarts anything while still printing
    `cycle ok` -- fail-open on precisely the failure this module exists for.
    So it is reported, and it suppresses the heartbeat.
    """
    path = STATE_PATH if path is None else Path(path)
    if not path.exists():
        return {}, None
    try:
        loaded = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        return {}, f'could not read {path}: {exc}'
    if not isinstance(loaded, dict):
        return {}, f'{path} does not contain a JSON object'
    validation_error = _validate_state(loaded, path)
    if validation_error:
        return {}, validation_error
    return loaded, None


def write_state(state, path=None):
    """None on success, else a message. A failed write is a health failure.

    Without a persisted baseline the next cycle re-arms, so the loop can be
    dead forever and this will never restart it -- while `cycle ok` keeps the
    absence policy green. Fail closed: drop the heartbeat and say why.
    """
    path = STATE_PATH if path is None else Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(state))
        tmp.replace(path)
    except OSError as exc:
        return f'could not write {path}: {exc}'
    return None


def restart_unit(unit, timeout=None, deadline=None):
    """None on success, else a message. Never raises.

    `systemctl try-restart` is deliberate: unlike `restart`, it never starts an
    inactive unit. That property closes the race between the earlier active
    state sample and an operator stopping the loop. A fresh `is-active` check is
    the postcondition, so a no-op or a concurrent stop is reported as an
    unconfirmed recovery rather than as a successful restart.
    """
    timeout = RESTART_TIMEOUT_DEFAULT if timeout is None else timeout

    def remaining():
        if deadline is None:
            return float(timeout)
        return min(float(timeout), deadline - time.monotonic())

    first_timeout = remaining()
    if first_timeout <= 0:
        return (f'no restart budget remains for `systemctl try-restart {unit}`; '
                f'the watchdog deadline was reached before this unit')
    mode = buy_producer_mode()
    if mode != 'legacy' and not guarded_release(Path(LOOP_SCRIPT).resolve().parents[2]):
        return 'producer changed or maintenance readiness unavailable; NOT restarting'
    try:
        done = subprocess.run(
            ['systemctl', 'try-restart', unit],
            capture_output=True, text=True, timeout=first_timeout, check=False)
    except subprocess.TimeoutExpired:
        return (f'`systemctl try-restart {unit}` did not return within {timeout}s. '
                f'The unit was NOT confirmed restarted.')
    except OSError as exc:
        return f'could not run systemctl: {exc}'
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or '').strip().replace('\n', ' ')
        return (f'`systemctl try-restart {unit}` exited {done.returncode}: '
                f'{detail[:400]}')
    post_timeout = remaining()
    if post_timeout <= 0:
        return (f'`systemctl try-restart {unit}` returned, but no time remained '
                f'for its postcondition probe; the unit was NOT confirmed '
                f'restarted.')
    postcondition = unit_state(unit, post_timeout)
    if postcondition != 'active':
        return (f'`systemctl try-restart {unit}` completed, but its postcondition '
                f'failed: {unit} is `{postcondition}` rather than `active`. '
                f'The unit may have been stopped concurrently; no restart was '
                f'confirmed.')
    return None


def suppress_heartbeat(lines, reason):
    """Drop `cycle ok` and say why, keeping every other line.

    The heartbeat asserts "this watchdog checked, and the loop is alive". A
    cycle that could not persist its baseline has not checked anything it can
    act on, so claiming health would keep the absence policy green through the
    watchdog's own failure -- the same trap, one level up.
    """
    kept = [line for line in lines if not line.startswith(CYCLE_SIGNAL)]
    if len(kept) != len(lines):
        kept.append(
            f'{IMPAIRED_SIGNAL} - heartbeat suppressed: {reason}. Without a '
            f'persisted baseline every cycle looks like a first run, so a dead '
            f'credit loop would never be restarted.')
    return kept


def preflight_safe_marker(sample, config):
    """Return a machine-checkable outcome for a stopped-loop preflight.

    The deploy/install workflow deliberately runs the watchdog while the money
    loop is stopped.  That must not require a credit heartbeat, but a systemd
    oneshot exit of zero is not useful evidence: the watchdog intentionally
    reports an inactive loop, and malformed state also exits zero.  This marker
    is emitted only when all evidence needed to supervise *once the loop is
    armed* is valid.  An inactive/failed loop is the one expected exception to
    the normal active-unit check; the deployer owns that planned stop.
    """
    if not PREFLIGHT_MODE or sample.unit_state not in ('inactive', 'failed'):
        return None
    if sample.log_error or sample.loop_bounds != 'yes':
        return None
    if sample.atomic_credit_code_state != 'yes' or not config.ok:
        return None
    # Notes are emitted as IMPAIRED diagnostics (for example, a restart
    # timeout clamped to fit TimeoutStartSec). The stopped-loop installer must
    # not accept a safe marker from the same run as any such warning.
    if config.ceiling_conflict or config.notes:
        return None
    return (
        f'{PREFLIGHT_SAFE_MARKER} - {config.unit} is stopped; watchdog '
        f'checks are valid and no heartbeat is required until the loop starts')


class LockUnavailable(Exception):
    pass


@contextmanager
def watchdog_lock(path=None):
    """Non-blocking exclusive lock for the complete watchdog critical path."""
    path = LOCK_PATH if path is None else Path(path)
    handle = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open('a+')
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ValueError) as exc:
        if handle is not None:
            handle.close()
        raise LockUnavailable(f'could not acquire {path}: {exc}') from exc
    try:
        yield handle
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _main_locked(dry_run, config):
    previous, read_error = read_state()
    if read_error:
        # Never replace a malformed or unreadable state file with a fresh
        # baseline.  The original is the evidence needed to recover the
        # restart budget safely; only an explicit operator repair may remove it.
        print(
            f'{IMPAIRED_SIGNAL} - refusing recovery because {read_error}. '
            f'The original state was preserved at {STATE_PATH}; repair or '
            f'restore it explicitly, then run the watchdog again.',
            flush=True)
        return 0
    sample = collect()
    lines, state, restart_these = evaluate(sample, previous, config)

    # THE BUDGET IS PERSISTED BEFORE ANYTHING IS RESTARTED, and a failed write
    # CANCELS the restart.
    #
    # It used to actuate first and save afterwards. If /var/lib/free2z became
    # unwritable -- a full disk, a bad chown -- every five-minute run would then
    # read the same stale state, see the same empty budget, and restart the
    # money loop AGAIN, forever: the advertised rate limiter could never
    # advance, and if the stale state was already at the escalation rung it
    # would power-cycle cloud-sql-proxy every five minutes too. A backlog needing
    # more than five minutes could never finish.
    #
    # Ordering it this way makes the failure direction safe: the worst case is
    # now a restart that was budgeted and then not performed, which costs one
    # cycle of delay, instead of an unbounded restart storm.
    # (Codex adversarial review, round 6, finding 3.)
    write_error = None if dry_run else write_state(state)
    if write_error and restart_these:
        # A CANCELLED RESTART MUST NOT LOOK LIKE A RESTART. `evaluate()` has
        # already put RESTART_ATTEMPT_SIGNAL in `lines`, and that phrase is what
        # `zec_credit_watchdog_restart` counts -- so leaving it in would page
        # `prod | ZEC credit loop restart was attempted` for a decision that
        # provably did not happen, and a responder would go looking for the
        # effects of an intervention that was cancelled. Drop it and say what
        # actually occurred.
        lines = [ln for ln in lines
                 if not ln.startswith(RESTART_ATTEMPT_SIGNAL)]
        lines.append(
            f'{IMPAIRED_SIGNAL} - NOT restarting {", ".join(restart_these)}: '
            f'the restart budget could not be persisted ({write_error}). '
            f'Acting anyway would mean every future cycle re-reads the same '
            f'stale budget and restarts again, forever.')
        restart_these = []

    if not write_error:
        marker = preflight_safe_marker(sample, config)
        expected_stop_signal = (
            f'{IMPAIRED_SIGNAL} - {config.unit} is `{sample.unit_state}`, '
            f'not running.')
        has_only_expected_stop_signal = all(
            not line.startswith(IMPAIRED_SIGNAL)
            or line.startswith(expected_stop_signal)
            for line in lines)
        if marker and has_only_expected_stop_signal:
            # The stopped loop is intentional only for the installer preflight.
            # Do not emit a CRITICAL IMPAIRED signal for that same known-safe
            # state; retain every other impairment so the installer cannot
            # certify a clock/state/configuration problem as safe.
            lines = [line for line in lines
                     if not line.startswith(IMPAIRED_SIGNAL)]
            lines.append(marker)

    lines.extend(config.notes)

    # ---- EMIT BEFORE ACTUATING.
    #
    # Everything above is a DECISION; everything below is an ACTION that can
    # block for minutes and can be killed (systemd's TimeoutStartSec bounds this
    # whole unit). Printing only at the end meant a kill during the restart lost
    # the record of it entirely: budget consumed, loop power-cycled, and not one
    # line in the log -- an invisible intervention, which is the exact bug class
    # this module exists to end.
    #
    # So the decision is flushed to the log first, and the outcome of the action
    # is flushed after it.
    problem = write_error
    if problem:
        lines = suppress_heartbeat(lines, problem)
    for line in lines:
        print(line, flush=True)

    outcome = []
    if restart_these and not dry_run:
        for index, unit in enumerate(restart_these):
            # A decision is emitted above and persisted before any action. Now
            # account for exactly the unit whose command is about to be
            # invoked. In particular, if dependency restart fails, the loop
            # remains accounted for without falsely queueing the loop behind a
            # failed dependency on the next timer cycle.
            state['pending_restart_units'] = restart_these[index:]
            action_deadline = getattr(_main_locked, '_action_deadline', None)
            if action_deadline is not None and (
                    action_deadline - time.monotonic() <= 0):
                outcome.append(
                    f'{IMPAIRED_SIGNAL} - NOT attempting {unit}: the watchdog '
                    f'unit start budget is exhausted before this command.')
                state_write_error = write_state(state)
                if state_write_error:
                    outcome.append(
                        f'{IMPAIRED_SIGNAL} - the pending action could not be '
                        f'preserved ({state_write_error}).')
                break
            # Account for the command immediately before invoking it, and clear
            # the cross-cycle continuation list. If this process dies after the
            # write, the command may be lost, but the next unit can never be
            # attempted against an unknown result from this one. That is the
            # safe failure direction for the dependency-first escalation: a
            # failed proxy restart must not leave the loop queued for the next
            # timer tick.
            state['pending_restart_units'] = []
            attempt_at = int(time.time())
            if unit == config.unit:
                state['restarts'] = _recent(
                    state.get('restarts'), attempt_at,
                    config.restart_window_seconds) + [attempt_at]
            else:
                state['dependency_restarts'] = _recent(
                    state.get('dependency_restarts'), attempt_at,
                    config.restart_window_seconds) + [attempt_at]
            state_write_error = write_state(state)
            if state_write_error:
                outcome.append(
                    f'{IMPAIRED_SIGNAL} - NOT attempting {unit}: the actual '
                    f'attempt could not be persisted ({state_write_error}). '
                    f'The pending decision remains for a later cycle.')
                break
            failure = restart_unit(
                unit, config.restart_timeout, deadline=action_deadline)
            if failure:
                outcome.append(
                    f'{IMPAIRED_SIGNAL} - {failure} The attempt still counts '
                    f'against the actual {"loop" if unit == config.unit else "dependency"} '
                    f'restart budget, so a systemctl that always fails cannot '
                    f'be retried forever.')
                # Do NOT go on to the next unit. If restarting the DEPENDENCY
                # failed, restarting the loop on top of it only adds noise to a
                # recovery that is already broken, and the responder needs to
                # see the first failure rather than the second.
                break
            if unit == config.unit:
                outcome.append(
                    f'{RESTART_SIGNAL} - {unit} is active after the '
                    f'try-restart postcondition.')
    elif restart_these:
        outcome.append(f'{IMPAIRED_SIGNAL} - --dry-run: '
                       f'{", ".join(restart_these)} was NOT restarted.')

    for line in outcome:
        print(line, flush=True)
    # Exit status is not the health contract. Log signals distinguish failures;
    # the absence of CYCLE_SIGNAL must be monitored separately.
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    dry_run = '--dry-run' in argv
    config = load_config()
    try:
        with watchdog_lock():
            # Use a process-local attribute so the existing pure evaluate API
            # stays unchanged while the action deadline is shared by every
            # sequential unit in one escalation.
            _main_locked._action_deadline = (
                time.monotonic() + config.unit_start_timeout
                - RESTART_OVERHEAD_SECONDS)
            try:
                return _main_locked(dry_run, config)
            finally:
                _main_locked._action_deadline = None
    except LockUnavailable as exc:
        print(
            f'{IMPAIRED_SIGNAL} - watchdog invocation already holds the state '
            f'lock; refusing to read, persist, or actuate concurrently ({exc}). '
            f'The other invocation owns the complete critical path.',
            flush=True)
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
