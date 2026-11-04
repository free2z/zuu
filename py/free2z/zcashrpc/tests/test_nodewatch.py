"""Node-health parser and state tests with synthetic observations.

HTTP and gRPC boundaries are mocked. The fixtures preserve response syntax,
ordered block-height relationships, and bounded serving-floor searches without
encoding a deployment's wallet birthday, measured history, or restart counts.
"""
import json
import re
from types import SimpleNamespace

import pytest

from zcashrpc import nodewatch


#metric file -> the signal it is supposed to count.

_NOW = 1_756_000_000
_HEIGHT = 3_120_000

# Synthetic ordered heights: required < checkpoint < measured floor < tip.
_REQUIRED = 3_100_000
_MEASURED_FLOOR = 3_160_000

# Representative grpcurl refusal shapes preserve parser-negative controls.
_REFUSED_PRUNED = (
    'ERROR:\n'
    '  Code: InvalidArgument\n'
    '  Message: GetBlock: getblock failed, error: error requesting verbose '
    'block: -1: block not found\n'
)
_REFUSED_NO_COMMITMENT_TREE = (
    'ERROR:\n'
    '  Code: InvalidArgument\n'
    '  Message: GetBlock: getblock failed, error: error requesting verbose '
    'block: -1: historical note commitment tree at '
    '000000000000000000000000000000000000000000000000000000000000abcd is '
    'unavailable: this node was fast-synced with verified commitment trees, '
    'so per-height trees below the last checkpoint Height(3130000) were never '
    'written\n'
)
#...and what a server that is not answering looks like, which must NOT be
#read as a fact about the height.
_UNREACHABLE = (
    'Failed to dial target host "127.0.0.1:9067": dial tcp 127.0.0.1:9067: '
    'connect: connection refused\n'
)


def _floor_policy(known_broken=None, required=_REQUIRED):
    policy = {'required_height': required}
    if known_broken is not None:
        policy['known_broken'] = known_broken
    return policy


def _outcome_for(stderr, returncode=1):
    """`_grpc_get_block`'s verdict on one raw grpcurl result."""
    import unittest.mock as mock
    with mock.patch.object(
            nodewatch.subprocess, 'run',
            return_value=SimpleNamespace(
                returncode=returncode, stdout='', stderr=stderr)):
        return nodewatch._grpc_get_block(1)


def _fake_grpcurl(floor, unreachable_below=None):
    """Emulate ordered serving history with both refusal types below the floor."""
    def run(argv, **kwargs):
        payload = json.loads(argv[argv.index('-d') + 1])
        height = payload['height']
        if unreachable_below is not None and height < unreachable_below:
            return SimpleNamespace(returncode=1, stdout='', stderr=_UNREACHABLE)
        if height >= floor:
            return SimpleNamespace(
                returncode=0, stdout='{"height": "%d"}' % height, stderr='')
        refusal = (_REFUSED_NO_COMMITMENT_TREE if height < 3_130_000
                   else _REFUSED_PRUNED)
        return SimpleNamespace(returncode=1, stdout='', stderr=refusal)
    return run


def _table(window=30, released='2026-01-01'):
    return {'images': {'zakuracore/zakura:1.0.0': {
        'released': released, 'support_window_days': window}}}


def _sample(**overrides):
    """A completely healthy observation. Each test breaks exactly one thing."""
    fields = dict(
        now=_NOW,
        rpc_ok=True,
        rpc_reason='ok',
        tip_height=_HEIGHT,
        tip_age_seconds=41,
        network_height=_HEIGHT,
        deprecation_height=None,
        deprecation_unreadable=None,
        lwd_ok=True,
        lwd_reason='ok',
        containers={'zakura': 20, 'lightwalletd': 10},
        node_image='zakuracore/zakura:1.0.0',
        node_image_created='2026-01-01T00:00:00Z',
        eos_log_line=None,
        # Healthy synthetic measurement: the required height was served.
        lwd_floor_state='at-or-below',
        lwd_floor=_REQUIRED,
        lwd_floor_detail='ok',
    )
    fields.update(overrides)
    return nodewatch.Sample(**fields)


def _state_with_tip_since(since, height=_HEIGHT, restart_baseline=None):
    state = {'tip': {'height': height, 'since': since}}
    if restart_baseline is not None:
        state['restarts'] = [[
            _NOW - nodewatch.RESTART_WINDOW_SECONDS, restart_baseline]]
    return state


class _FakeResponse:
    """Enough of http.client.HTTPResponse for `probe_rpc` / `probe_lightwalletd`."""

    def __init__(self, body, status=200):
        self._body = body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


@pytest.mark.parametrize('body,expected', [
    (b'', 'empty body'),
    (b'<html>gateway</html>', 'body is not JSON'),
    (b'{"result": {"chain": "main"}}', 'no integer result.blocks'),
    (b'{"result": {"chain": "test", "blocks": 5}}', 'not main'),
    (b'{"result": {"chain": "main", "blocks": 5}}', 'no network height'),
    (b'{"error": {"code": -1}, "result": null}', 'JSON-RPC error'),
])
def test_probe_rpc_asserts_a_body_not_a_connection(mocker, body, expected):
    """Validate response content even when the HTTP connection succeeds."""
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen',
        return_value=_FakeResponse(body))
    ok, reason, height, _, _network = nodewatch.probe_rpc()
    assert ok is False
    assert expected in reason
    assert height is None


def test_probe_rpc_accepts_a_real_body(mocker):
    """The positive control: the guard above must not reject a healthy node."""
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen',
        return_value=_FakeResponse(
            json.dumps({'result': {'chain': 'main', 'blocks': _HEIGHT,
                                   'estimatedheight': _HEIGHT,
                                   'time': _NOW - 41}}).encode()))
    ok, _, height, tip_time, network = nodewatch.probe_rpc()
    assert (ok, height, tip_time, network) == (
        True, _HEIGHT, _NOW - 41, _HEIGHT)


def test_probe_lightwalletd_rejects_an_empty_body(mocker):
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen',
        return_value=_FakeResponse(b'   \n'))
    ok, reason = nodewatch.probe_lightwalletd()
    assert ok is False and 'empty body' in reason


_REAL_LOOKING_METRICS = b'''# HELP go_goroutines Number of goroutines that currently exist.
# TYPE go_goroutines gauge
go_goroutines 42
process_resident_memory_bytes 1.234e+08
grpc_server_started_total{grpc_method="GetLightdInfo",grpc_type="unary"} 17
'''


def test_probe_lightwalletd_accepts_a_body_naming_no_lightwalletd_metric():
    """Accept valid Prometheus data without assuming a vendor metric prefix."""
    assert b'lightwalletd' not in _REAL_LOOKING_METRICS
    ok, reason = _probe_lwd_with(_REAL_LOOKING_METRICS)
    assert ok is True, reason


@pytest.mark.parametrize('body', [
    b'<html><head><title>502 Bad Gateway</title></head><body></body></html>',
    b'Moved Permanently. Redirecting to /metrics/\n',
    b'\n\n   \t\n',
])
def test_probe_lightwalletd_rejects_a_body_that_is_not_prometheus(body):
    """Reject non-metric content even when the HTTP endpoint responds."""
    ok, reason = _probe_lwd_with(body)
    assert ok is False, reason


def _probe_lwd_with(body, status=200):
    import unittest.mock
    with unittest.mock.patch.object(
            nodewatch.urllib.request, 'urlopen',
            return_value=_FakeResponse(body, status)):
        return nodewatch.probe_lightwalletd()


# ------------------------------------------------------------------ tip


def test_an_rpc_outage_does_not_restart_the_staleness_clock():
    """Preserve the observed-tip timer through a temporary RPC outage."""
    since = _NOW - 99999
    _, state = nodewatch.evaluate(
        _sample(rpc_ok=False, rpc_reason='empty body', tip_height=None),
        _state_with_tip_since(since),
        _table())
    assert state['tip']['since'] == since


# ------------------------------------------------------------------ restarts


# ------------------------------------------------------------------ lightwalletd


# ------------------------------------------------- the serving floor
#
# Exercise unavailable history without treating it as a transport outage.


def test_a_pruned_floor_is_found_by_bisection(mocker):
    """Find the synthetic serving floor within the configured call budget."""
    mocker.patch.object(
        nodewatch.subprocess, 'run',
        side_effect=_fake_grpcurl(floor=_MEASURED_FLOOR))

    state, floor, _ = nodewatch.probe_lightwalletd_floor(_REQUIRED, 3_180_000)
    assert (state, floor) == ('measured', _MEASURED_FLOOR)
    # The requirement, the anchor, then the bisection -- and bounded.
    assert nodewatch.subprocess.run.call_count <= nodewatch.FLOOR_MAX_CALLS


def test_todays_two_refusals_are_answers_about_a_height_not_an_outage():
    """Distinguish block-history refusal responses from connection failures."""
    for text in (_REFUSED_PRUNED, _REFUSED_NO_COMMITMENT_TREE):
        outcome, detail = _outcome_for(text)
        assert outcome == 'refused', text
    outcome, detail = _outcome_for(_UNREACHABLE)
    assert outcome == 'unreachable', detail
    assert 'connection refused' in detail


def test_the_fast_sync_checkpoint_is_the_lower_of_two_barriers(mocker):
    """Preserve the checkpoint diagnostic when the required height is unavailable."""
    mocker.patch.object(
        nodewatch.subprocess, 'run',
        side_effect=_fake_grpcurl(floor=_MEASURED_FLOOR))
    outcome, detail = nodewatch._grpc_get_block(_REQUIRED)
    assert outcome == 'refused'
    assert 'last checkpoint Height(3130000) were never written' in detail


# ---------------------------------------- honest now, protective later


# ------------------------------------------------------------------ end of support


def test_probe_deprecation_returns_none_when_the_node_lacks_the_rpc(mocker):
    """Zakura 1.0.0 predates this RPC.

    Not a fault and it must not page: the caller falls back to the table.
    """
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen',
        return_value=_FakeResponse(
            b'{"result": null, "error": {"code": -32601, '
            b'"message": "Method not found"}}'))
    assert nodewatch.probe_deprecation() == (None, None)


@pytest.mark.parametrize('body,expected', [
    # zcashd's flat field.
    (b'{"result": {"deprecationheight": 3461234}}', 3461234),
    # The Zebra-derived nested shape. Codex adversarial review, fifth pass:
    # hard-coding the flat name silently discards the authoritative deadline
    # on a CURRENT node, and the operator then trusts a manual table whose
    # build-timestamp deadline can run late.
    (b'{"result": {"end_of_service": {"block_height": 3461234, '
     b'"estimated_time": "2026-10-01T00:00:00Z"}}}', 3461234),
    (b'{"result": {"endOfService": {"blockHeight": 3461234}}}', 3461234),
    (b'{"result": {"end_deprecation_height": 3461234}}', 3461234),
])
def test_probe_deprecation_reads_the_height_in_either_schema(
        mocker, body, expected):
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen',
        return_value=_FakeResponse(body))
    assert nodewatch.probe_deprecation() == (expected, None)


@pytest.mark.parametrize('body', [
    b'{"error": {"code": -32601, "message": "Method not found"}}',
    b'{"error": {"code": -8, "message": "Unknown method getdeprecationinfo"}}',
])
def test_only_method_not_found_enables_the_date_table_fallback(mocker, body):
    """zakura 1.0.0 must reach the fallback without paging on its own."""
    mocker.patch.object(
        nodewatch.urllib.request, 'urlopen', return_value=_FakeResponse(body))
    assert nodewatch.probe_deprecation() == (None, None)


def test_the_log_scan_is_bounded_by_lines_not_only_by_time(mocker):
    """Codex adversarial review, sixth pass, finding 6.

    `--since` bounds time, not bytes. A node in a verbose crash loop can write
    gigabytes in 30 minutes, and replaying all of it into this process every
    five minutes would put the probe's own OOM pressure on the box it exists to
    observe.
    """
    run = mocker.patch.object(
        nodewatch.subprocess, 'run',
        return_value=SimpleNamespace(returncode=0, stdout='', stderr=''))
    nodewatch.scan_logs_for_end_of_support()
    argv = run.call_args[0][0]
    assert '--tail' in argv, argv
    assert argv[argv.index('--tail') + 1] == nodewatch.EOS_LOG_TAIL


def test_the_vendor_warning_is_found_when_the_node_logs_it_to_stderr(mocker):
    """Codex adversarial review, third pass, finding 4.

    `docker logs` delivers the CONTAINER's stderr on OUR stderr. Reading only
    stdout would make the "independent of our support table" path silently
    return nothing for any image that logs its warning (or its panic) to
    stderr. The compose file's `tty: true` happens to merge the streams today,
    but a signal that depends on an undocumented container setting is not
    independent.
    """
    vendor = 'WARN zakurad: Zakura refuses to run if the release date is older than 7 days'
    mocker.patch.object(
        nodewatch.subprocess, 'run',
        return_value=SimpleNamespace(returncode=0, stdout='', stderr=vendor))
    assert nodewatch.scan_logs_for_end_of_support() == vendor


# --------------------------------------------------- the  false positive
#
# Startup INFO messages announcing the support checker are not warnings.
# Fixtures retain ANSI color codes to exercise the actual log parser.
_ESC = '\x1b'
_STARTUP_TASK_SPAWN = (
    f'2026-01-01T00:00:00.100000Z {_ESC}[32m INFO{_ESC}[0m '
    f'{_ESC}[2mzakurad::commands::start{_ESC}[0m{_ESC}[2m:{_ESC}[0m '
    f'spawning end of support checking task')
_STARTUP_RANGE_CHECK = (
    f'2026-01-01T00:00:00.200000Z {_ESC}[32m INFO{_ESC}[0m '
    f'{_ESC}[2mzakurad::components::sync::end_of_support{_ESC}[0m'
    f'{_ESC}[2m:{_ESC}[0m Checking if Zakura release is inside support range ...')
_STARTUP_SUPPORTED_UNTIL = (
    f'2026-01-01T00:00:00.300000Z {_ESC}[32m INFO{_ESC}[0m '
    f'{_ESC}[2mzakurad::components::sync::end_of_support{_ESC}[0m'
    f'{_ESC}[2m:{_ESC}[0m Zakura release is supported until block 3200000, '
    f'please report bugs at https://github.com/ZakuraCore/zakura/issues')

# Vendor warning syntax remains a positive control for the log parser.
_VENDOR_WARN = (
    f'2026-01-02T00:00:00.100000Z {_ESC}[33m WARN{_ESC}[0m '
    f'{_ESC}[2mzakurad::components::sync::end_of_support{_ESC}[0m'
    f'{_ESC}[2m:{_ESC}[0m Your Zakura release is too old and it will stop '
    f'running in 3 days. Download and install a newer release')
_VENDOR_PANIC = (
    'thread \'tokio-runtime-worker\' panicked at '
    'zakurad/src/components/sync/end_of_support.rs:74:9:\n'
    'Zakura refuses to run if the release date is older than 16 days. '
    'Download and install a newer release')


def test_the_startup_task_spawn_line_is_no_longer_read_as_end_of_support():
    """The  regression, recorded in both directions.

    The first half is the RED proof and it is not decoration: it spells the
    pattern that shipped and shows it matching the observed INFO line, so this
    test fails loudly if anyone reintroduces a bare `end of support`
    alternative. The second half is the fix.
    """
    shipped_before = re.compile(
        r'end of support|refuses to run if the release date|'
        r'release is too old', re.IGNORECASE)
    assert shipped_before.search(_STARTUP_TASK_SPAWN), (
        'the observed line must still demonstrate the old false positive')
    assert not nodewatch.EOS_LOG_PATTERN.search(
        nodewatch._ANSI_ESCAPE.sub('', _STARTUP_TASK_SPAWN))


@pytest.mark.parametrize('line', [
    _STARTUP_TASK_SPAWN,
    _STARTUP_RANGE_CHECK,
    _STARTUP_SUPPORTED_UNTIL,
])
def test_the_routine_startup_chatter_never_matches(line):
    """All three INFO lines, not just the one that was observed firing.

    `Zakura release is supported until block N` escapes the old pattern only by
    luck -- it happens to contain no `end of support` substring -- so it is
    pinned here: any future widening that catches it would page continuously on
    a perfectly healthy node, which is strictly worse than the bug being fixed.
    """
    assert not nodewatch.EOS_LOG_PATTERN.search(
        nodewatch._ANSI_ESCAPE.sub('', line))


@pytest.mark.parametrize('line', [
    _VENDOR_WARN,
    _VENDOR_PANIC,
    # The panic as `docker logs` renders it when the abort is logged through
    # tracing rather than the default hook.
    f'2026-01-02T00:00:00Z {_ESC}[31mERROR{_ESC}[0m zakurad::application: '
    f'panicked at end_of_support.rs:74:9: Zakura refuses to run if the '
    f'release date is older than 16 days',
    # A REWORDED future warning. This is what keeps the path "needs no constant
    # from us": it is still an escalated line out of the end_of_support module,
    # so it still fires even though none of our phrases appear.
    f'2026-01-02T00:00:00Z {_ESC}[33m WARN{_ESC}[0m '
    f'{_ESC}[2mzakurad::components::sync::end_of_support{_ESC}[0m: this build '
    f'reaches its end of support at block 3200000 and will halt',
    # No colour at all: `docker logs` without a tty, and the wording used by
    # the two tests above this block.
    'WARN zakurad: Zakura refuses to run if the release date is older '
    'than 7 days',
])
def test_a_genuine_end_of_support_warning_still_matches(line):
    """The negative control that stops the fix from being "match nothing"."""
    assert nodewatch.EOS_LOG_PATTERN.search(
        nodewatch._ANSI_ESCAPE.sub('', line))


# --------------------------------------------------------------- probe state
def test_a_missing_state_file_is_a_first_run_not_an_error(tmp_path):
    state, error = nodewatch.read_state(tmp_path / 'absent.json')
    assert (state, error) == ({}, None)


@pytest.mark.parametrize('content', ['not json at all', '[1, 2, 3]'])
def test_an_unreadable_state_file_is_reported(tmp_path, content):
    path = tmp_path / 'state.json'
    path.write_text(content)
    state, error = nodewatch.read_state(path)
    assert state == {} and error


def test_a_failed_state_write_is_reported(tmp_path):
    blocked = tmp_path / 'afile'
    blocked.write_text('not a directory')
    assert nodewatch.write_state({'tip': {}}, blocked / 'sub' / 'state.json')


# ---------------------------------------------------------- ops agent config


# -------------------------------------------------------------- the installer


# ------------------------------------------------------------- negative control
