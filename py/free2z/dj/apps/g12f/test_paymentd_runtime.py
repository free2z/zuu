"""Financial hooks fail closed on host, backend and producer authority."""
import subprocess
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from zcashrpc import paymentd_mode

from dj.apps.g12f import paymentd_runtime as runtime
from dj.apps.g12f.paymentd_protocol import PaymentEvidenceError


@pytest.fixture(autouse=True)
def approved_guard_source(tmp_path, monkeypatch):
    """Unit-test byte identity independently of deployment source availability."""
    guard = tmp_path / 'zcash/pipeline/free2z-host-guard.sh'
    guard.parent.mkdir(parents=True)
    guard.write_bytes(b'#!/bin/sh\n# synthetic approved test guard\nexit 0\n')
    (guard.parent / 'authorised-money-host.env').write_text(
        'FREE2Z_MONEY_HOST_INSTANCE_ID=123456789\n',
    )
    monkeypatch.setattr(runtime, 'REPOSITORY', tmp_path)


@contextmanager
def mocked_runtime(marker=b'paymentd\n'):
    guard=(runtime.REPOSITORY/'zcash/pipeline/free2z-host-guard.sh').read_bytes()
    mode='paymentd' if marker==b'paymentd\n' else 'legacy' if marker==b'legacy\n' else 'invalid'
    with patch.object(runtime,'root_bytes',return_value=guard), \
            patch.object(paymentd_mode,'buy_producer_mode',return_value=mode) as classify:
        yield classify


def test_sqlite_fallback_cannot_start_financial_hook():
    with patch.object(runtime,'connection',SimpleNamespace(vendor='sqlite')), patch.object(runtime.subprocess,'run') as run:
        with pytest.raises(PaymentEvidenceError):
            runtime.require_runtime(writes=True)
        run.assert_not_called()


@pytest.mark.parametrize('marker',[b'',b'legacy\n',b'paymentd',b'paymentd\nextra'])
def test_invalid_or_legacy_producer_mode_blocks_writes(marker):
    with patch.object(runtime,'connection',SimpleNamespace(vendor='postgresql')), \
         mocked_runtime(marker),patch.object(runtime.subprocess,'run'):
        with pytest.raises(PaymentEvidenceError):
            runtime.require_runtime(writes=True)


def test_approved_host_guard_and_marker_required_without_db_env_inheritance():
    with patch.object(runtime,'connection',SimpleNamespace(vendor='postgresql')), \
         mocked_runtime() as classify,patch.object(runtime.subprocess,'run') as run:
        runtime.require_runtime(writes=True)
        classify.assert_called_once_with()
    assert run.call_args.args[0][0]=='/usr/local/sbin/free2z-host-guard'
    assert run.call_args.kwargs['env']=={'PATH':'/usr/bin:/bin'}
    assert run.call_args.kwargs['timeout']==15


def test_readonly_status_does_not_require_financial_activation():
    with patch.object(runtime,'connection',SimpleNamespace(vendor='postgresql')), \
         mocked_runtime(b'legacy\n'),patch.object(runtime.subprocess,'run'):
        runtime.require_runtime(writes=False)


def test_replaced_guard_or_unavailable_host_is_refused():
    with patch.object(runtime,'connection',SimpleNamespace(vendor='postgresql')), \
         patch.object(runtime,'root_bytes',return_value=b'#!/bin/sh\nexit 0\n'), \
         patch.object(runtime.subprocess,'run') as run:
        with pytest.raises(PaymentEvidenceError):
            runtime.require_runtime(writes=True)
        run.assert_not_called()
    with patch.object(runtime,'connection',SimpleNamespace(vendor='postgresql')), \
         mocked_runtime(),patch.object(runtime.subprocess,'run',side_effect=subprocess.TimeoutExpired('guard',15)):
        with pytest.raises(PaymentEvidenceError):
            runtime.require_runtime(writes=True)
