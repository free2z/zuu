"""Measure node RPC responses, synchronization progress, restarts, and wallet serving history.

The probe validates response content rather than only open ports. It checks
lightwalletd historical-block availability against a supplied floor policy and
reports deprecation deadlines from the node or a configured support table.
Missing policy or unmeasurable history produces an explicit signal. State tracks
progress across cycles; failed state persistence suppresses the healthy heartbeat.

Configuration uses NODE_HEALTH_* environment variables. Docker supplies container
state and grpcurl supplies gRPC probes. Output is a stable log-signal contract;
monitoring configuration and host scheduling are supplied by the deployment.
"""
import calendar
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from zcashrpc.deployment_paths import deployment_root

# --------------------------------------------------------------- signals
# Deployment monitoring consumes these stable signal phrases. Consumers must
# update their filter contracts when a signal changes.
#
# The `node-health: ` prefix exists so the metric filters cannot be matched by
# any other line the VM happens to ship to the same log.
CYCLE_SIGNAL = 'node-health: cycle ok'
RPC_UNHEALTHY_SIGNAL = 'node-health: NODE RPC UNHEALTHY'
TIP_STALE_SIGNAL = 'node-health: CHAIN TIP STALE'
TIP_BEHIND_SIGNAL = 'node-health: CHAIN TIP BEHIND'
RESTART_LOOP_SIGNAL = 'node-health: CONTAINER RESTART LOOP'
LIGHTWALLETD_UNHEALTHY_SIGNAL = 'node-health: LIGHTWALLETD UNHEALTHY'
SUPPORT_EXPIRING_SIGNAL = 'node-health: ZAKURA END OF SUPPORT'
SUPPORT_UNKNOWN_SIGNAL = 'node-health: ZAKURA SUPPORT WINDOW UNKNOWN'
#The MEASUREMENT, emitted every cycle whether the news is good or bad. Its
#metric extracts the number, so the floor is a graph rather than a sentence.
LWD_FLOOR_SIGNAL = 'node-health: lightwalletd serving floor'
#The probe could not take that measurement at all -- which must never read as
#"the floor is fine". See `probe_lightwalletd_floor`.
LWD_FLOOR_UNMEASURED_SIGNAL = 'node-health: LIGHTWALLETD FLOOR UNMEASURED'
#The business property, and the only one of the three that pages on the
#stack's behalf. Gated on `zcash/stack/lightwalletd-serving-floor.json`.
LWD_UNSERVABLE_SIGNAL = 'node-health: LIGHTWALLETD CANNOT SERVE THE BIRTHDAY'

# ----------------------------------------------------------------- config
NODE_CONTAINER = os.environ.get('NODE_HEALTH_NODE_CONTAINER', 'zakura')
LWD_CONTAINER = os.environ.get('NODE_HEALTH_LWD_CONTAINER', 'lightwalletd')

# Loopback, per zcash/stack/docker-compose.lwd.yml: 8232 is published as
# 127.0.0.1:8232 and 9068 as 127.0.0.1:9068.
RPC_URL = os.environ.get('NODE_HEALTH_RPC_URL', 'http://127.0.0.1:8232/')
LWD_URL = os.environ.get(
    'NODE_HEALTH_LWD_URL', 'http://127.0.0.1:9068/metrics')
HTTP_TIMEOUT = float(os.environ.get('NODE_HEALTH_HTTP_TIMEOUT', '10'))

#lightwalletd's WALLET-FACING surface: gRPC `CompactTxStreamer`, published as
#127.0.0.1:9067 by zcash/stack/docker-compose.lwd.yml.
LWD_GRPC_TARGET = os.environ.get('NODE_HEALTH_LWD_GRPC', '127.0.0.1:9067')

#gRPC probes use an explicitly available grpcurl executable. If it is missing
#or cannot run, report an unmeasurable serving floor rather than healthy state.
GRPCURL = os.environ.get('NODE_HEALTH_GRPCURL', 'grpcurl')
GRPC_TIMEOUT = float(os.environ.get('NODE_HEALTH_GRPC_TIMEOUT', '15'))

#How far below the node's tip to anchor the bisection.
#
#The bisection needs a height it is CERTAIN lightwalletd can serve. The tip
#itself is not that: lightwalletd ingests a block after the node has it, so
#asking for the newest block races a healthy pipeline. 200 blocks is ~4 hours
#at 75s spacing -- far outside any ingest lag that is not itself a failure.
#If even that height is refused, the answer is not "the floor is high", it is
#`LIGHTWALLETD UNHEALTHY`: a server that cannot serve a four-hour-old block
#is wedged, which is exactly the gRPC-deadlock case the metrics probe cannot
#see and this repo listed under "What is NOT verified".
FLOOR_TIP_MARGIN = int(os.environ.get('NODE_HEALTH_FLOOR_TIP_MARGIN', '200'))

#Hard ceiling on gRPC calls per cycle, so a bug cannot turn the probe into a
#load generator against the money path. A bisection over the whole 64,000
#block span between the declared requirement and the tip needs 16 steps plus
#two anchors; 24 leaves headroom and still bounds the damage. Exhausting it
#is reported as UNMEASURED rather than rounded into an answer.
FLOOR_MAX_CALLS = int(os.environ.get('NODE_HEALTH_FLOOR_MAX_CALLS', '24'))

#Seconds the tip may stay at one height before the node is declared stuck.
#
#Zcash targets 75-second block spacing (post-Blossom). Inter-block gaps are
#close to exponential, so P(gap > t) = exp(-t / 75):
#
#t = 600s  -> exp(-8)  = 3.4e-4   ~ one spurious window per 3,000 blocks
#t = 900s  -> exp(-12) = 6.1e-6   ~ one per 163,000 blocks (~141 days)
#t = 1200s -> exp(-16) = 1.1e-7   ~ one per 8.9M blocks (~19 years)
#
#900s would page two or three times a year on a perfectly healthy chain,
#which is how a money-path alert gets muted. 1200s buys ~55x more margin for
#five more minutes of detection latency. Real Zcash difficulty adjustment
#also produces occasional long
#blocks when hashrate drops, which the pure Poisson figure understates, so
#the extra margin is not theoretical.
TIP_STALE_SECONDS = int(os.environ.get('NODE_HEALTH_TIP_STALE_SECONDS', '1200'))

#Blocks the local tip may trail the network before the node counts as behind.
#
#A MOVING tip is not the same as a CAUGHT-UP tip. After a stale snapshot
#restore or disk trouble a node can download one block every few minutes,
#forever, while RPC answers, the containers stay up and lightwalletd serves
#wallets chain data that is days old. `TIP_STALE_SECONDS` alone cannot see
#that -- the height keeps changing, so the staleness clock keeps resetting --
#and every policy here would stay green. (Codex adversarial review, second
#pass, finding 1.)
#
#40 blocks is ~50 minutes at 75-second spacing. A pruned node restarting
#normally closes a gap that size in well under a cycle, and `estimatedheight`
#is an estimate that can legitimately be a block or two out, so this is far
#enough above the noise to page only on a node that is genuinely not keeping
#up. The alert additionally requires two consecutive cycles.
TIP_BEHIND_BLOCKS = int(os.environ.get('NODE_HEALTH_TIP_BEHIND_BLOCKS', '40'))

#Which `getblockchaininfo` field carries the NETWORK tip, in preference order.
#
#zcashd publishes `estimatedheight`; Zebra-derived nodes publish one or both
#of `estimatedheight` and `headers`. A body carrying NEITHER is treated as an
#unhealthy RPC response rather than as "lag cannot be measured": a check that
#silently stops covering something is the failure mode this whole module is
#about, and the installer runs one cycle and shows its output, so a wrong
#field name here surfaces during installation rather than never. Override
#with NODE_HEALTH_NETWORK_HEIGHT_FIELDS if the running node names it
#something else.
NETWORK_HEIGHT_FIELDS = [
    field.strip() for field in os.environ.get(
        'NODE_HEALTH_NETWORK_HEIGHT_FIELDS', 'estimatedheight,headers').split(',')
    if field.strip()
]

#Rolling window and count for the restart-growth signal.
#
#Absolute counters accumulate across unrelated events. Measure growth in a
#bounded window to distinguish repeated failures from a single restart.
#Three restarts inside 15 minutes means a
#container that cannot stay up for five minutes on average, which no planned
#operation looks like.
RESTART_WINDOW_SECONDS = int(
    os.environ.get('NODE_HEALTH_RESTART_WINDOW_SECONDS', '900'))
RESTART_THRESHOLD = int(os.environ.get('NODE_HEALTH_RESTART_THRESHOLD', '3'))

#Seconds per block, for turning a block distance into a human deadline.
#Zcash's post-Blossom target spacing.
BLOCK_SECONDS = 75

#Days of notice on the authoritative `getdeprecationinfo` path.
#
#14 days matches zcashd's own deprecation *warning* window, and it is long
#enough to pull a current image, pin it, get the change reviewed and merged
#through this repo's PR pipeline, and roll it -- which is the actual unit of
#work this alert has to fit inside. It is a flat number rather than a
#fraction because the node reports a deadline, not a support window: there is
#no "life" to take a fraction of.
DEPRECATION_WARN_DAYS = int(
    os.environ.get('NODE_HEALTH_DEPRECATION_WARN_DAYS', '14'))

#How far back to scan container logs for the vendor's own end-of-support text.
EOS_LOG_SINCE = os.environ.get('NODE_HEALTH_EOS_LOG_SINCE', '30m')
#...and by LINES. `--since` bounds time, not bytes: a node in a verbose crash
#loop can write gigabytes in 30 minutes, and asking Docker to replay all of
#it into this process's memory every five minutes would put the probe's own
#OOM pressure on the box it is meant to be observing. The vendor's
#end-of-support warning is printed at startup, so the newest few hundred
#lines of a restart loop always contain it. (Codex adversarial review, sixth
#pass, finding 6.)
EOS_LOG_TAIL = os.environ.get('NODE_HEALTH_EOS_LOG_TAIL', '2000')

#ANSI colour codes, stripped before matching and before forwarding.
#
#zakurad writes coloured `tracing` output and `docker logs` hands it to us
#byte for byte, so the level arrives wrapped:
#`\x1b[32m INFO\x1b[0m\x1b[2m zakurad::...`. The pattern below keys on the
#level, so it must not have to spell those escapes; and the line is forwarded
#verbatim into the metric, so stripping them here is also what keeps Cloud
#Logging readable instead of full of `[2m[0m`.
_ANSI_ESCAPE = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')

#The vendor's own end-of-support text -- the WARNING, not the announcement
#that the check exists.
#
#Match warning/error/panic support messages. A startup INFO announcement
#that the support checker was armed does not establish an expiring deadline.
EOS_LOG_PATTERN = re.compile(
    os.environ.get(
        'NODE_HEALTH_EOS_LOG_PATTERN',
        r'refuses to run if the release date'
        r'|release is too old'
        r'|(?:\bWARN\b|\bERROR\b|panic).{0,200}?end[ _]of[ _]support',
    ),
    re.IGNORECASE,
)

STATE_PATH = Path(
    os.environ.get('NODE_HEALTH_STATE', '/var/lib/free2z/node-health.json'))

_REPO_ROOT = deployment_root(__file__)
SUPPORT_TABLE_PATH = Path(os.environ.get(
    'NODE_HEALTH_SUPPORT_TABLE',
    str(_REPO_ROOT / 'zcash' / 'stack' / 'zakura-support.json'),
))
#Human-readable path used in log lines, so an operator reading Cloud Logging
#is told which committed file to edit rather than a path on one VM.
SUPPORT_TABLE_LABEL = 'zcash/stack/zakura-support.json'

FLOOR_POLICY_PATH = Path(os.environ.get(
    'NODE_HEALTH_FLOOR_POLICY',
    str(_REPO_ROOT / 'zcash' / 'stack' / 'lightwalletd-serving-floor.json'),
))
FLOOR_POLICY_LABEL = 'zcash/stack/lightwalletd-serving-floor.json'

_ISO_DATE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})')


class Sample:
    """Everything one cycle observed, with no decisions taken yet.

    Kept as a plain container so `evaluate` is a pure function of observation
    plus previous state: that is what makes the thresholds testable without a
    VM, a node, or Docker.
    """

    def __init__(
        self,
        now,
        rpc_ok,
        rpc_reason,
        tip_height,
        tip_age_seconds,
        network_height,
        deprecation_height,
        deprecation_unreadable,
        lwd_ok,
        lwd_reason,
        containers,
        node_image,
        node_image_created,
        eos_log_line,
        lwd_floor_state='skipped',
        lwd_floor=None,
        lwd_floor_detail=None,
    ):
        self.now = now
        self.rpc_ok = rpc_ok
        self.rpc_reason = rpc_reason
        self.tip_height = tip_height
        self.tip_age_seconds = tip_age_seconds
        self.network_height = network_height
        self.deprecation_height = deprecation_height
        self.deprecation_unreadable = deprecation_unreadable
        self.lwd_ok = lwd_ok
        self.lwd_reason = lwd_reason
        #{container name: restart count}
        self.containers = containers
        self.node_image = node_image
        self.node_image_created = node_image_created
        self.eos_log_line = eos_log_line
        #One of `probe_lightwalletd_floor`'s five outcomes:
        #'at-or-below' | 'measured' | 'unmeasured' | 'unserved' | 'skipped'.
        self.lwd_floor_state = lwd_floor_state
        #The height, when there is one. For 'at-or-below' it is the declared
        #requirement, which lightwalletd served, and the true floor is that
        #or lower -- the probe stops there because nothing below it is worth
        #16 more gRPC calls on a money path.
        self.lwd_floor = lwd_floor
        self.lwd_floor_detail = lwd_floor_detail


# ------------------------------------------------------------------ probes
def _rpc_call(method, url=RPC_URL, timeout=HTTP_TIMEOUT):
    """(status, body_bytes, error). No interpretation; callers decide."""
    payload = json.dumps({
        'jsonrpc': '1.0',
        'id': 'f2z-nodewatch',
        'method': method,
        'params': [],
    }).encode()
    request = urllib.request.Request(
        url, data=payload, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), None
    except urllib.error.HTTPError as exc:
        # A 500 with a body may still be a usable JSON-RPC error; read it.
        return exc.code, exc.read(), None
    except (urllib.error.URLError, OSError) as exc:
        return None, b'', f'no response from {url}: {exc}'


#Key names that carry a halt height, in preference order, searched at ANY
#depth of the `getdeprecationinfo` result.
#
#zcashd published a flat `deprecationheight`; Zebra-derived nodes nest it
#under an `end_of_service` object. Hard-coding either shape means a node that
#DOES publish its halt height gets silently ignored, the operator falls back
#to the manual table, and a build-timestamp deadline that runs late clears
#the UNKNOWN alert while the node halts on schedule. (Codex adversarial
#review, fifth pass.) Searching by name at any depth costs nothing and
#survives a schema move; a shape carrying NONE of these is reported rather
#than shrugged off -- see `probe_deprecation`.
DEPRECATION_HEIGHT_KEYS = (
    'end_of_service', 'endofservice',
    'deprecationheight', 'deprecation_height',
    'enddeprecationheight', 'end_deprecation_height',
    'block_height', 'blockheight',
)


#JSON-RPC "the method does not exist" -- the ONLY error that means "this
#node simply predates the RPC" rather than "the authoritative source is
#broken". -32601 is the JSON-RPC 2.0 code; the message forms cover servers
#that return a different code with the same meaning.
_METHOD_NOT_FOUND_CODE = -32601
_METHOD_NOT_FOUND_TEXT = (
    'method not found', 'unknown method', 'no such method',
    'not supported', 'unsupported method',
)


def _is_method_not_found(rpc_error):
    if isinstance(rpc_error, dict):
        if rpc_error.get('code') == _METHOD_NOT_FOUND_CODE:
            return True
        message = str(rpc_error.get('message', '')).lower()
    else:
        message = str(rpc_error).lower()
    return any(phrase in message for phrase in _METHOD_NOT_FOUND_TEXT)


def _find_height(value, depth=0):
    """The first int under a `DEPRECATION_HEIGHT_KEYS` name, at any depth."""
    if depth > 4 or not isinstance(value, dict):
        return None
    for key in DEPRECATION_HEIGHT_KEYS:
        for actual, found in value.items():
            if str(actual).lower().replace('-', '_') != key:
                continue
            if isinstance(found, int) and not isinstance(found, bool):
                return found
            nested = _find_height(found, depth + 1)
            if nested is not None:
                return nested
    for found in value.values():
        nested = _find_height(found, depth + 1)
        if nested is not None:
            return nested
    return None


def probe_deprecation(url=RPC_URL, timeout=HTTP_TIMEOUT):
    """(halt height or None, unreadable-shape description or None).

    THE AUTHORITATIVE END-OF-SUPPORT ANSWER. A Zakura release defines its
    shutdown by a fixed Mainnet height; anything we compute from a release date
    or a Docker build timestamp is an estimate of that height, and an estimate
    that runs LATE is worse than none because it clears the
    `SUPPORT WINDOW UNKNOWN` alert while the node halts on schedule.

    Three outcomes, and the third is the one that stops this from failing
    quietly:

    * a height -- use it, ignore everything else;
    * `(None, None)` -- the node does not implement the RPC at all, which is
      true of older implementations. Fall back to
      `zcash/stack/zakura-support.json`.
    * `(None, "...")` -- the node ANSWERED and this probe could not find a
      halt height in the reply. That means the schema moved, and falling back
      silently is precisely how a late build-timestamp deadline gets believed.
      The caller pages `SUPPORT WINDOW UNKNOWN` naming the keys it saw,
      whatever the table says.
    """
    _status, body, error = _rpc_call('getdeprecationinfo', url, timeout)
    if error:
        # The whole RPC endpoint is down; `probe_rpc` already reports that and
        # a second page about it would be noise.
        return None, None
    if not body:
        return None, f'empty body from {url} for getdeprecationinfo'
    try:
        parsed = json.loads(body)
    except ValueError:
        return None, 'getdeprecationinfo did not return JSON'
    if not isinstance(parsed, dict):
        return None, 'getdeprecationinfo did not return a JSON object'
    rpc_error = parsed.get('error')
    if rpc_error:
        # ONLY "there is no such method" means "this node predates the RPC".
        # Every other error means the authoritative source exists and is
        # BROKEN, and quietly falling back to date arithmetic there is how a
        # late build-timestamp deadline gets believed. (Codex adversarial
        # review, sixth pass, finding 2.)
        if _is_method_not_found(rpc_error):
            return None, None
        return None, (
            f'getdeprecationinfo failed: {rpc_error}; the node HAS an '
            f'authoritative halt height and this probe cannot read it')
    result = parsed.get('result')
    if not isinstance(result, dict) or not result:
        return None, 'getdeprecationinfo returned no result object'
    height = _find_height(result)
    if height is not None:
        return height, None
    return None, (
        'the node answers getdeprecationinfo but this probe found no halt '
        'height in the reply (top-level keys: '
        + ', '.join(sorted(str(key) for key in result))
        + '); the schema moved -- update DEPRECATION_HEIGHT_KEYS in '
          'py/zcashrpc/nodewatch.py')


def probe_rpc(url=RPC_URL, timeout=HTTP_TIMEOUT):
    """A real JSON-RPC round trip.

    Returns (ok, reason, tip_height, tip_time, network_height).

    An open connection can return an empty body. Each validation is a named
    failure: the body must exist, parse as JSON, carry no `error`, and carry an
    integer `result.blocks` on `main`.
    """
    status, body, error = _rpc_call('getblockchaininfo', url, timeout)
    if error:
        return False, error, None, None, None

    if not body:
        # Keep the stable "empty body" diagnostic for log consumers.
        return False, f'empty body from {url} (HTTP {status})', None, None, None
    try:
        parsed = json.loads(body)
    except ValueError:
        snippet = body[:120].decode('utf-8', 'replace')
        return False, f'body is not JSON (HTTP {status}): {snippet}', None, None, None
    if not isinstance(parsed, dict):
        return False, f'body is not a JSON object (HTTP {status})', None, None, None
    if parsed.get('error'):
        return False, f'JSON-RPC error: {parsed["error"]}', None, None, None
    result = parsed.get('result')
    if not isinstance(result, dict):
        return False, 'body carries no result object', None, None, None
    height = result.get('blocks')
    if not isinstance(height, int):
        return False, 'no integer result.blocks in body', None, None, None
    chain = result.get('chain')
    if chain not in (None, 'main'):
        return False, f'node is on chain {chain!r}, not main', None, None, None
    # `mediantime` is the median of the last 11 block headers, so it lags the
    # real tip by roughly five blocks (~6 minutes). It is reported in the
    # heartbeat for triage only and NOTHING alerts on it -- staleness is
    # measured from this probe's own observations instead. Do not tighten a
    # threshold against this number without accounting for that lag.
    tip_time = result.get('time') or result.get('mediantime')

    # The NETWORK tip, so a node that is moving but hopelessly behind can be
    # told from one that is caught up. Missing is a failure, not a shrug.
    network = None
    for field in NETWORK_HEIGHT_FIELDS:
        value = result.get(field)
        if isinstance(value, int):
            network = value
            break
    if network is None:
        return False, (
            'no network height in body (need one of '
            + ', '.join(NETWORK_HEIGHT_FIELDS)
            + '); set NODE_HEALTH_NETWORK_HEIGHT_FIELDS if this node names it '
              'something else'), None, None, None
    return (True, 'ok', height,
            tip_time if isinstance(tip_time, int) else None, network)


def probe_lightwalletd(url=LWD_URL, timeout=HTTP_TIMEOUT):
    """Validate the HTTP metrics response independently of the gRPC probe.

    Require a 2xx response containing Prometheus exposition. Metric names are
    implementation-dependent; NODE_HEALTH_LWD_BODY_PATTERN can constrain them
    when a deployment has a verified contract. This check cannot prove gRPC
    availability. probe_lightwalletd_floor exercises GetBlock through grpcurl.
    """
    pattern = os.environ.get(
        'NODE_HEALTH_LWD_BODY_PATTERN',
        r'(?m)^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^\n}]*\})?[ \t]+[-+0-9.eE]')
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = response.status
            body = response.read()
    except urllib.error.HTTPError as exc:
        return False, f'HTTP {exc.code} from {url}'
    except (urllib.error.URLError, OSError) as exc:
        return False, f'no response from {url}: {exc}'
    if status // 100 != 2:
        return False, f'HTTP {status} from {url}'
    if not body.strip():
        return False, f'empty body from {url} (HTTP {status})'
    if pattern and not re.search(pattern, body.decode('utf-8', 'replace')):
        return False, f'body from {url} does not match {pattern!r}'
    return True, 'ok'


#gRPC status codes that mean THE SERVER ANSWERED and declined this height.
#
#The distinction this set draws is the whole reason the floor probe can tell
#a broken lightwalletd from a pruned one. Refusals can arrive as
#InvalidArgument -- the node's `block not found` (pruned away) and its
#`historical note commitment tree... is unavailable` (fast-synced, no
#per-height tree below the checkpoint) -- and both are lightwalletd
#faithfully relaying an answer. `Unavailable`, `DeadlineExceeded`,
#`Unimplemented` and a dial failure are NOT answers about a height; they are
#the server being unreachable or wedged, which is a different alert.
_GRPC_ANSWERED_CODES = frozenset({'InvalidArgument', 'NotFound', 'OutOfRange'})
_GRPC_CODE_RE = re.compile(r'^\s*Code:\s*(\w+)\s*$', re.MULTILINE)


def _grpc_get_block(height, grpcurl=None, target=None, timeout=None):
    """(outcome, detail) for one `CompactTxStreamer/GetBlock`.

    Outcome is one of:

    * `'served'`    -- lightwalletd returned the block.
    * `'refused'`   -- lightwalletd answered, declining this height. An ANSWER,
                       so the server is alive and this is a fact about the
                       stack's coverage.
    * `'unreachable'` -- the call reached no answering server, or the server
                       failed in a way that is not about the height.
    * `'unrunnable'`  -- `grpcurl` itself could not be executed.

    The last two are kept apart on purpose: one is lightwalletd's problem and
    one is ours, they need different runbooks, and collapsing them is how a
    missing binary ends up filed as a node outage (or worse, as nothing).
    """
    grpcurl = GRPCURL if grpcurl is None else grpcurl
    target = LWD_GRPC_TARGET if target is None else target
    timeout = GRPC_TIMEOUT if timeout is None else timeout
    argv = [
        grpcurl, '-plaintext',
        '-max-time', str(int(timeout)),
        '-d', json.dumps({'height': int(height)}),
        target, 'cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock',
    ]
    try:
        completed = subprocess.run(
            argv, capture_output=True, text=True,
            timeout=timeout + 5, check=False)
    except FileNotFoundError:
        return 'unrunnable', (
            f'{grpcurl} is not installed or not on this unit\'s PATH, so the '
            f'wallet-facing gRPC surface cannot be probed at all')
    except (OSError, subprocess.SubprocessError) as exc:
        return 'unrunnable', f'{grpcurl} could not be run: {exc}'
    if completed.returncode == 0:
        return 'served', 'ok'
    text = ((completed.stderr or '') + (completed.stdout or '')).strip()
    text = ' '.join(text.split())[:400]
    code = _GRPC_CODE_RE.search(
        (completed.stderr or '') + (completed.stdout or ''))
    if code and code.group(1) in _GRPC_ANSWERED_CODES:
        return 'refused', text
    return 'unreachable', (
        f'GetBlock {height} on {target}: {text or "no output"}')


def probe_lightwalletd_floor(required_height, anchor_height, **kwargs):
    """(state, floor, detail) -- the lowest height lightwalletd can serve.

    Wallet recovery requires historical blocks from the wallet birthday.
    A healthy RPC, advancing tip, or metrics endpoint does not prove those
    blocks are available. This probe measures that requirement directly.

    HOW IT MEASURES, in as few calls as possible:

    1. Ask for `required_height` itself. If lightwalletd serves it the answer
       is `('at-or-below', required_height,...)` in ONE call and the probe
       stops -- the exact floor below a requirement that is already met is
       trivia, and 16 more gRPC calls per cycle against the money path is not
       a price worth paying for trivia.
    2. Otherwise bisect (`required_height`, `anchor`], where `anchor` is
       `tip - FLOOR_TIP_MARGIN`. Refusal is monotone in height on this stack --
       both barriers (the pruning window and the fast-sync checkpoint) are
       lower bounds, so a served height implies every higher one is served --
       which is what makes a bisection sound rather than a sample.
    3. If the ANCHOR is refused, the answer is not a high floor; it is that
       lightwalletd cannot serve a four-hour-old block, and the caller turns
       that into `LIGHTWALLETD UNHEALTHY`. This is the gRPC-deadlock gap that
       `probe_lightwalletd`'s docstring has always admitted it could not see.

    Never returns a number it did not prove. Every way of failing to measure --
    no grpcurl, no anchor, an exhausted call budget -- comes back as
    `'unmeasured'` or `'skipped'`, never as a floor.
    """
    if required_height is None:
        return 'unmeasured', None, (
            f'no required_height declared in {FLOOR_POLICY_LABEL}, so there '
            f'is nothing to measure against')
    budget = [FLOOR_MAX_CALLS]

    def ask(height):
        if budget[0] <= 0:
            return 'budget', f'exceeded {FLOOR_MAX_CALLS} gRPC calls'
        budget[0] -= 1
        return _grpc_get_block(height, **kwargs)

    def unmeasured(detail):
        return 'unmeasured', None, detail

    outcome, detail = ask(required_height)
    if outcome in ('unrunnable', 'budget'):
        return unmeasured(detail)
    if outcome == 'unreachable':
        return 'unserved', None, detail
    if outcome == 'served':
        return 'at-or-below', required_height, 'ok'

    # Refused. Find out by how much.
    if anchor_height is None:
        # The node's tip is unreadable, so there is no height we can assume is
        # servable and no sound bisection. RPC UNHEALTHY is already firing for
        # the same cause; this must not page a second time for it.
        return 'skipped', None, (
            'the node tip is unreadable, so the bisection has no anchor')
    anchor = int(anchor_height) - FLOOR_TIP_MARGIN
    if anchor <= required_height:
        # Only possible on a chain that has barely passed the requirement.
        return 'at-or-below', required_height, (
            f'tip {anchor_height} is within {FLOOR_TIP_MARGIN} blocks of the '
            f'requirement; nothing to bisect')
    outcome, detail = ask(anchor)
    if outcome in ('unrunnable', 'budget'):
        return unmeasured(detail)
    if outcome == 'unreachable':
        return 'unserved', None, detail
    if outcome != 'served':
        return 'unserved', None, (
            f'lightwalletd refused height {anchor}, {FLOOR_TIP_MARGIN} blocks '
            f'below the node tip {anchor_height}: {detail}')

    low, high = required_height, anchor          # low refused, high served
    while high - low > 1:
        mid = (low + high) // 2
        outcome, detail = ask(mid)
        if outcome == 'served':
            high = mid
        elif outcome == 'refused':
            low = mid
        elif outcome == 'unrunnable':
            return unmeasured(detail)
        elif outcome == 'budget':
            return unmeasured(
                f'bisection {detail} between {low} and {high}; raise '
                f'NODE_HEALTH_FLOOR_MAX_CALLS or look for a probe bug')
        else:
            return 'unserved', None, detail
    return 'measured', high, 'ok'


def _docker(args, timeout=20, merge_streams=False):
    """(stdout, error). `merge_streams` also returns what the command wrote to
    stderr, which is how `docker logs` delivers the CONTAINER's stderr.

    Without it the end-of-support scan reads only stdout, so a node image that
    logs its vendor warning (or its panic) to stderr would be invisible and the
    "independent of our support table" path would silently return nothing. The
    current compose file sets `tty: true`, which merges the streams -- but a
    signal that depends on an undocumented container setting is not
    independent. (Codex adversarial review, third pass, finding 4.)
    """
    try:
        completed = subprocess.run(
            ['docker', *args],
            capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    if completed.returncode != 0:
        return None, (completed.stderr or completed.stdout).strip()
    if merge_streams:
        return (completed.stdout or '') + (completed.stderr or ''), None
    return completed.stdout, None


def docker_restart_counts(names):
    """{name: restart count} for the containers that exist.

    A container that is absent is simply missing from the mapping; `evaluate`
    treats that as a health failure rather than as zero restarts, because
    "there is no zakura container" must never read as "zakura is calm".
    """
    out, err = _docker(
        ['inspect', '--format', '{{.Name}}\t{{.RestartCount}}', *names])
    if out is None:
        print(f'!! docker inspect failed: {err}', file=sys.stderr)
        return {}
    counts = {}
    for line in out.splitlines():
        parts = line.strip().split('\t')
        if len(parts) != 2:
            continue
        name = parts[0].lstrip('/')
        try:
            counts[name] = int(parts[1])
        except ValueError:
            continue
    return counts


def docker_image_of(container):
    """(image reference, image build timestamp) for a running container."""
    out, _ = _docker(
        ['inspect', '--format', '{{.Config.Image}}', container])
    if not out:
        return None, None
    image = out.strip()
    created, _ = _docker(['image', 'inspect', '--format', '{{.Created}}', image])
    return image, (created.strip() if created else None)


def scan_logs_for_end_of_support(container=NODE_CONTAINER, since=EOS_LOG_SINCE):
    """The vendor's own end-of-support WARNING, if it emitted one.

    Not its announcement that the check exists: see `EOS_LOG_PATTERN`, which
    has to tell a startup INFO line apart from the warning it is named after.
    ANSI colour codes are removed before matching, so the pattern can key on
    the level without spelling escape sequences, and before returning, so the
    text forwarded into the metric is readable.
    """
    out, _ = _docker(
        ['logs', '--since', since, '--tail', EOS_LOG_TAIL, container],
        timeout=30, merge_streams=True)
    if not out:
        return None
    for line in out.splitlines():
        plain = _ANSI_ESCAPE.sub('', line)
        if EOS_LOG_PATTERN.search(plain):
            return plain.strip()[:300]
    return None


# ------------------------------------------------------------ support table
def load_support_table(path=SUPPORT_TABLE_PATH):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        print(f'!! could not read {path}: {exc}', file=sys.stderr)
        return {}


def load_floor_policy(path=FLOOR_POLICY_PATH):
    """The declared serving expectation, or None if it cannot be read.

    None is NOT "no expectation, carry on": `evaluate` turns it into
    `LIGHTWALLETD FLOOR UNMEASURED`, naming this file, for the same reason
    `load_support_table` returning `{}` ends in a nag. The alternative is a
    probe that quietly stops checking the one property it was written for
    because a file did not ship -- `zcash/pipeline/install-node-health.sh`
    refuses to install without it precisely so that cannot happen quietly.
    """
    try:
        loaded = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        print(f'!! could not read {path}: {exc}', file=sys.stderr)
        return None
    if not isinstance(loaded, dict):
        print(f'!! {path} does not contain a JSON object', file=sys.stderr)
        return None
    return loaded


def _parse_iso_date_to_epoch(text):
    if not text:
        return None
    match = _ISO_DATE.match(str(text))
    if not match:
        return None
    year, month, day = (int(part) for part in match.groups())
    try:
        # timegm, not mktime: these dates are UTC and the VM's local zone must
        # not shift a support deadline by a day.
        return int(calendar.timegm((year, month, day, 0, 0, 0, 0, 0, 0)))
    except (OverflowError, ValueError):
        return None


def support_status(image, image_created, table, now):
    """(days_remaining, warn_days, detail, unknown_reason) for the running image.

    `days_remaining` and `warn_days` are None when the window is undeclared;
    `unknown_reason` is then a sentence naming what a human must go and commit.
    """
    images = (table or {}).get('images') or {}
    if not image:
        return None, None, None, (
            f'the running {NODE_CONTAINER} image could not be read from '
            f'docker, so its support window cannot be looked up in '
            f'{SUPPORT_TABLE_LABEL}')
    entry = images.get(image)
    if entry is None:
        return None, None, None, (
            f'image {image} is not declared in {SUPPORT_TABLE_LABEL}; add it '
            f'with the support window read off the running binary')
    window = entry.get('support_window_days')
    if not isinstance(window, int) or window <= 0:
        return None, None, None, (
            f'image {image} is declared in {SUPPORT_TABLE_LABEL} with no '
            f'support_window_days, so no pre-warning can be computed; read '
            f'the window off the running binary and commit it')

    raw_released = entry.get('released')
    declared = _parse_iso_date_to_epoch(raw_released)
    if declared is not None:
        released_epoch, provenance = declared, 'declared'
    elif raw_released not in (None, ''):
        # Present but unparseable. Falling back to the image build date here
        # would substitute an unverified, LATER timestamp for a date somebody
        # meant to pin -- clearing this alert and starting the warning after
        # the node has already halted. An absent date is a documented fallback;
        # a typo is not. (Codex adversarial review, seventh pass, finding 1.)
        return None, None, None, (
            f'image {image} declares released={raw_released!r} in '
            f'{SUPPORT_TABLE_LABEL}, which is not a YYYY-MM-DD date; fix the '
            f'typo rather than letting the image build date stand in for it')
    else:
        released_epoch = _parse_iso_date_to_epoch(image_created)
        provenance = 'from the image build date, unverified'
        if released_epoch is None:
            return None, None, None, (
                f'image {image} declares no released date in '
                f'{SUPPORT_TABLE_LABEL} and its build date could not be read '
                f'from docker, so no pre-warning can be computed')

    elapsed_days = int((now - released_epoch) // 86400)
    days_remaining = window - elapsed_days
    # A fraction of the life, floored at two days: see the module docstring.
    warn_days = max(2, window // 4)
    released_text = time.strftime('%Y-%m-%d', time.gmtime(released_epoch))
    detail = (
        f'image {image} released {released_text} ({provenance}), '
        f'support window {window} days, warn at {warn_days} days')
    return days_remaining, warn_days, detail, None


#Signals whose policies count FAILURES over 15 minutes and tolerate one.
#Emitting two lines for one cycle would turn that tolerance into none.
_AT_MOST_ONCE_PER_CYCLE = (RPC_UNHEALTHY_SIGNAL, LIGHTWALLETD_UNHEALTHY_SIGNAL)


def _one_line_per_service(lines):
    seen = {}
    out = []
    for line in lines:
        signal = next(
            (s for s in _AT_MOST_ONCE_PER_CYCLE if line.startswith(s + ' - ')),
            None)
        if signal is None:
            out.append(line)
            continue
        if signal in seen:
            out[seen[signal]] += '; also: ' + line[len(signal) + 3:]
            continue
        seen[signal] = len(out)
        out.append(line)
    return out


# ----------------------------------------------------------------- evaluate
def _floor_lines(sample, floor_policy):
    """Return signals and a service-failure detail for the serving-floor policy.

    Emit measurements independently of the policy's known_broken declaration.
    A non-null declaration suppresses the unservable-history alert while
    preserving measurements; a missing policy emits an unmeasured signal.
    Compare against the required height rather than changes in the floor,
    since pruning can advance the floor while a node operates normally.
    """
    if sample.lwd_floor_state == 'skipped':
        return [], None
    if sample.lwd_floor_state == 'unserved':
        # lightwalletd could not serve a block four hours old. That is not a
        # fact about the floor, it is the gRPC-deadlock case the /metrics
        # probe cannot see; report it as the lightwalletd failure it is, so it
        # lands on that service's existing policy and runbook.
        return [], sample.lwd_floor_detail
    if sample.lwd_floor_state == 'unmeasured':
        return [f'{LWD_FLOOR_UNMEASURED_SIGNAL} - {sample.lwd_floor_detail}'], None
    if floor_policy is None:
        return [f'{LWD_FLOOR_UNMEASURED_SIGNAL} - {FLOOR_POLICY_LABEL} is '
                f'missing or unreadable on this host, so the measured floor '
                f'has nothing to be compared against'], None

    required = floor_policy.get('required_height')
    if required is None:
        # Only reachable if the declaration changed under a running cycle: the
        # probe returns 'unmeasured' for a missing requirement. Report rather
        # than divide by it -- a probe that raises stops emitting everything.
        return [f'{LWD_FLOOR_UNMEASURED_SIGNAL} - no required_height declared '
                f'in {FLOOR_POLICY_LABEL}'], None
    known_broken = floor_policy.get('known_broken')
    floor = sample.lwd_floor
    if sample.lwd_floor_state == 'at-or-below':
        head = f'height {floor} or below'
        verdict = f'meets the required {required}'
        if known_broken:
            # The fix landed and nobody armed the alert. Say so where an
            # operator reading the board will see it, every cycle.
            verdict += (
                f'; {FLOOR_POLICY_LABEL} still declares known_broken '
                f'({known_broken.get("issue", "no issue")}), so the page is '
                f'STILL DISARMED -- set known_broken to null to arm it')
        return [f'{LWD_FLOOR_SIGNAL} - {head}, {verdict}'], None

    gap = floor - required
    head = f'height {floor}'
    detail = (f'{gap} blocks above the required {required}, so a wallet '
              f'restoring from that birthday is served nothing')
    lines = []
    if known_broken:
        # The declaration's `clears_when` is a paragraph for a human reading a
        # diff; this is one line in a log stream. Carry the first sentence of
        # it -- enough to say what has to happen -- and leave the rest in the
        # file the line already names.
        clears = str(known_broken.get('clears_when') or
                     'no exit condition declared').split('. ')[0][:160]
        lines.append(
            f'{LWD_FLOOR_SIGNAL} - {head}, {detail}; known broken, '
            f'{known_broken.get("issue", "no issue")} ({clears})')
    else:
        lines.append(f'{LWD_FLOOR_SIGNAL} - {head}, {detail}')
        lines.append(
            f'{LWD_UNSERVABLE_SIGNAL} - floor {floor} is {gap} blocks above '
            f'the required {required} declared in {FLOOR_POLICY_LABEL}, and '
            f'no known_broken exemption is declared')
    return lines, None


def evaluate(sample, previous_state, table, floor_policy=None):
    """(lines to log, new state). Pure: no I/O, no clock, no Docker.

    Every threshold in this repository's Zcash-node alerting is applied here
    and nowhere else, so `tests/test_nodewatch.py` can drive each one and the
    metric regexes can be run against the exact strings production emits.
    """
    lines = []
    state = {}
    healthy = True

    # ---- RPC, and the tip height it reports.
    if not sample.rpc_ok:
        healthy = False
        lines.append(f'{RPC_UNHEALTHY_SIGNAL} - {sample.rpc_reason}')

    # ---- Chain tip staleness, measured by THIS probe's own observations.
    #
    # Not by the tip block's timestamp: a miner may set that up to ~90 minutes
    # ahead of real time, which would make a frozen chain look fresher than it
    # is. Measure elapsed time since the last height change instead. Report
    # block timestamp age in the heartbeat only as supporting diagnostic data.
    previous_tip = (previous_state or {}).get('tip') or {}
    if sample.tip_height is None:
        # Keep the previous observation rather than resetting the clock; an RPC
        # outage must not silently restart the staleness timer, or a node that
        # flaps between "no answer" and "same height" never trips it.
        state['tip'] = previous_tip
    elif previous_tip.get('height') != sample.tip_height:
        state['tip'] = {'height': sample.tip_height, 'since': sample.now}
    else:
        state['tip'] = previous_tip
        stalled_for = int(sample.now - previous_tip.get('since', sample.now))
        if stalled_for >= TIP_STALE_SECONDS:
            healthy = False
            lines.append(
                f'{TIP_STALE_SIGNAL} - height {sample.tip_height} unchanged '
                f'for {stalled_for}s (threshold {TIP_STALE_SECONDS}s)')

    # ---- The tip is moving, but is it keeping up?
    #
    # Separate from staleness on purpose: a node downloading one block every
    # few minutes resets the staleness clock every cycle and looks perfectly
    # healthy while serving wallets chain data that is days old.
    if sample.tip_height is not None and sample.network_height is not None:
        behind = sample.network_height - sample.tip_height
        if behind > TIP_BEHIND_BLOCKS:
            healthy = False
            lines.append(
                f'{TIP_BEHIND_SIGNAL} - height {sample.tip_height} is '
                f'{behind} blocks behind network height '
                f'{sample.network_height} (threshold {TIP_BEHIND_BLOCKS})')

    # ---- Restart growth over a rolling window.
    history = list((previous_state or {}).get('restarts') or [])
    history.append([sample.now, dict(sample.containers)])
    cutoff = sample.now - (RESTART_WINDOW_SECONDS * 4)
    history = [entry for entry in history if entry[0] >= cutoff]
    state['restarts'] = history
    missing_signal = {
        NODE_CONTAINER: RPC_UNHEALTHY_SIGNAL,
        LWD_CONTAINER: LIGHTWALLETD_UNHEALTHY_SIGNAL,
    }
    for name in (NODE_CONTAINER, LWD_CONTAINER):
        if name not in sample.containers:
            # A container Docker cannot even inspect must never read as "zero
            # restarts, therefore calm". Report it against the service it
            # belongs to, which is also the policy whose runbook covers it.
            healthy = False
            lines.append(
                f'{missing_signal[name]} - container {name} is not present in '
                f'docker inspect output')
            continue
        baseline = None
        for stamp, counts in history:
            if stamp <= sample.now - RESTART_WINDOW_SECONDS and name in counts:
                baseline = counts[name]
        if baseline is None:
            continue
        grew = sample.containers[name] - baseline
        if grew >= RESTART_THRESHOLD:
            healthy = False
            lines.append(
                f'{RESTART_LOOP_SIGNAL} - {name} restarted {grew} times in '
                f'{RESTART_WINDOW_SECONDS}s (threshold {RESTART_THRESHOLD})')

    # ---- lightwalletd.
    if not sample.lwd_ok:
        healthy = False
        lines.append(f'{LIGHTWALLETD_UNHEALTHY_SIGNAL} - {sample.lwd_reason}')

    # ----...and the thing lightwalletd exists to do. See `_floor_lines`.
    #
    # Neither the measurement nor the unservable verdict suppresses the
    # heartbeat, for the reason the end-of-support warning does not either: the
    # heartbeat's ABSENCE is a CRITICAL "the probe is dead or the host is
    # gone"; firing it for a historical coverage gap would name the wrong
    # cause and duplicate the dedicated signal. A lightwalletd
    # that cannot serve a four-hour-old block DOES suppress it, because that is
    # an ordinary lightwalletd failure and always has been.
    floor_lines, floor_failure = _floor_lines(sample, floor_policy)
    lines.extend(floor_lines)
    if floor_failure:
        healthy = False
        lines.append(f'{LIGHTWALLETD_UNHEALTHY_SIGNAL} - {floor_failure}')

    # ---- End of support. The whole point: warn BEFORE the kill switch trips.
    #
    # The node's own halt height wins outright when it publishes one. Falling
    # back to date arithmetic in that case would be strictly worse: a rebuilt
    # image carries a build timestamp later than the release it contains, so
    # the computed deadline runs LATE, the UNKNOWN alert clears, and the node
    # halts at its height with the pre-warning still quiet.
    if sample.deprecation_height is not None and sample.tip_height is not None:
        blocks_left = sample.deprecation_height - sample.tip_height
        days_left = int(blocks_left * BLOCK_SECONDS // 86400)
        if days_left <= DEPRECATION_WARN_DAYS:
            if blocks_left < 0:
                head = f'halt height passed {abs(blocks_left)} blocks ago'
            else:
                head = f'{days_left} days left'
            lines.append(
                f'{SUPPORT_EXPIRING_SIGNAL} - {head}: the node reports it '
                f'halts at height {sample.deprecation_height}, '
                f'{blocks_left} blocks from the current tip '
                f'{sample.tip_height} (~{BLOCK_SECONDS}s/block), warn at '
                f'{DEPRECATION_WARN_DAYS} days')
    elif sample.deprecation_unreadable:
        # The node HAS a halt height and we cannot read it. Falling through to
        # the date table here is how a late build-timestamp deadline gets
        # believed, so this pages regardless of what the table says.
        lines.append(
            f'{SUPPORT_UNKNOWN_SIGNAL} - {sample.deprecation_unreadable}')
    else:
        days, warn_days, detail, unknown = support_status(
            sample.node_image, sample.node_image_created, table, sample.now)
        if unknown:
            lines.append(f'{SUPPORT_UNKNOWN_SIGNAL} - {unknown} (the node does '
                         f'not answer getdeprecationinfo, so its own halt '
                         f'height is unavailable)')
        elif days is not None and days <= warn_days:
            if days < 0:
                head = f'expired {abs(days)} days ago'
            else:
                head = f'{days} days left'
            lines.append(f'{SUPPORT_EXPIRING_SIGNAL} - {head}: {detail}')
    if sample.eos_log_line:
        lines.append(
            f'{SUPPORT_EXPIRING_SIGNAL} - the node logged: '
            f'{sample.eos_log_line}')

    # ---- One line per service per cycle for the two signals whose policies
    # count failures rather than occurrences.
    #
    # A single bad cycle used to emit NODE RPC UNHEALTHY twice -- once for the
    # failed HTTP probe, once for the missing container -- which is a sum of 2
    # and pages immediately, defeating the deliberate one-cycle tolerance for
    # `docker compose down/up`. The extra detail is folded into the line that
    # was already emitted rather than dropped. (Codex adversarial review,
    # seventh pass, finding 2.)
    lines = _one_line_per_service(lines)

    # ---- The heartbeat, emitted only when nothing above tripped.
    #
    # Same shape as `credit_creators`' `cycle ok` line: its ABSENCE is the
    # alert, which covers both "the probe is dead" and "the node is sick", and
    # in the second case a named policy above says which. The end-of-support
    # warning deliberately does NOT suppress it -- a node that is healthy today
    # and expires next week must keep its heartbeat, or the two signals would
    # page as one.
    if healthy:
        age = sample.tip_age_seconds if sample.tip_age_seconds is not None else 0
        lines.append(
            f'{CYCLE_SIGNAL} - tip {sample.tip_height} age {max(0, int(age))}s, '
            f'{NODE_CONTAINER} restarts {sample.containers[NODE_CONTAINER]}, '
            f'{LWD_CONTAINER} restarts {sample.containers[LWD_CONTAINER]}')
    return lines, state


# --------------------------------------------------------------------- main
def read_state(path=STATE_PATH):
    """(state, error). A MISSING file is not an error; an unreadable one is.

    The distinction matters because both stateful signals -- tip staleness and
    restart growth -- are computed by comparing against the previous cycle. On
    a genuine first run there is nothing to compare against and one heartbeat
    with no staleness verdict is correct. If the file exists and cannot be read,
    or was written by something that produced garbage, every cycle would look
    like a first run forever: a frozen tip and a restart loop would both stay
    invisible while `cycle ok` kept the absence policy green. That is fail-open
    on the exact failure this module exists to catch, so it is reported.
    """
    path = Path(path)
    if not path.exists():
        return {}, None
    try:
        loaded = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        return {}, f'could not read {path}: {exc}'
    if not isinstance(loaded, dict):
        return {}, f'{path} does not contain a JSON object'
    return loaded, None


def write_state(state, path=STATE_PATH):
    """None on success, else a message. A failed write is a health failure.

    Not because this cycle's observations are wrong -- they are fine -- but
    because the NEXT cycle then has no baseline, and a probe that can never
    build a baseline can never report a stale tip or a restart loop while still
    printing a heartbeat. Fail closed: `main` drops the heartbeat, and the
    absence policy pages.
    """
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(state))
        tmp.replace(path)
    except OSError as exc:
        return f'could not write {path}: {exc}'
    return None


def collect(now=None, floor_policy=None):
    now = int(time.time()) if now is None else now
    rpc_ok, rpc_reason, height, tip_time, network = probe_rpc()
    deprecation, deprecation_unreadable = probe_deprecation()
    lwd_ok, lwd_reason = probe_lightwalletd()
    floor_state, floor, floor_detail = probe_lightwalletd_floor(
        (floor_policy or {}).get('required_height'), height)
    counts = docker_restart_counts([NODE_CONTAINER, LWD_CONTAINER])
    image, image_created = docker_image_of(NODE_CONTAINER)
    return Sample(
        now=now,
        rpc_ok=rpc_ok,
        rpc_reason=rpc_reason,
        tip_height=height,
        tip_age_seconds=(now - tip_time) if tip_time else None,
        network_height=network,
        deprecation_height=deprecation,
        deprecation_unreadable=deprecation_unreadable,
        lwd_ok=lwd_ok,
        lwd_reason=lwd_reason,
        containers=counts,
        node_image=image,
        node_image_created=image_created,
        eos_log_line=scan_logs_for_end_of_support(),
        lwd_floor_state=floor_state,
        lwd_floor=floor,
        lwd_floor_detail=floor_detail,
    )


def suppress_heartbeat(lines, reason):
    """Drop the `cycle ok` line and say why, keeping every failure line.

    Used when the probe cannot persist state. The heartbeat asserts "everything
    checked is healthy", and a probe with no usable baseline has not checked
    two of the four things. Emitting it anyway would keep the absence policy
    green through exactly the failures this module was written for.
    """
    kept = [line for line in lines if not line.startswith(CYCLE_SIGNAL)]
    if len(kept) != len(lines):
        kept.append(
            f'!! heartbeat suppressed: {reason}. The tip-staleness and '
            f'restart-growth signals need a baseline across cycles; without '
            f'one they can never fire, so this cycle must not claim health.')
    return kept


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    dry_run = '--dry-run' in argv
    previous, read_error = read_state()
    floor_policy = load_floor_policy()
    sample = collect(floor_policy=floor_policy)
    lines, state = evaluate(
        sample, previous, load_support_table(), floor_policy)
    write_error = None if dry_run else write_state(state)
    problem = read_error or write_error
    if problem:
        lines = suppress_heartbeat(lines, problem)
    for line in lines:
        print(line, flush=True)
    # Health is reported through stable log signals. A completed observation
    # exits successfully even when the service it observes is unhealthy.
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
