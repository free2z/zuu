from __future__ import annotations

import pytest

from dj.apps.jobs.worker_harness import (
    WorkerExitCeilingExceeded,
    WorkerExitWaitTimeout,
    wait_for_worker_exit,
    wait_for_worker_shutdown_state,
)


class _Clock:
    def __init__(self, elapsed: float):
        self.elapsed = elapsed
        self.calls = 0

    def __call__(self) -> float:
        self.calls += 1
        return 0.0 if self.calls == 1 else self.elapsed


class _Worker:
    name = 'fake-worker'

    def __init__(self, returncode: int = 0, error: Exception | None = None):
        self.returncode = returncode
        self.error = error

    def wait_until_exited(self, ceiling: float) -> int:
        if self.error:
            raise self.error
        return self.returncode

    @staticmethod
    def log() -> str:
        return 'fake worker log'


def test_wait_for_worker_exit_reports_normal_telemetry(tmp_path, monkeypatch,
                                                       capsys):
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _Clock(2.5))

    assert wait_for_worker_exit(_Worker(), 10, summary_path=str(summary)) == 0

    output = capsys.readouterr().err
    assert 'exited in 2.50s' in output
    assert '25.0% of 10.00s ceiling' in output
    assert 'used 70.0%' not in output
    assert summary.read_text() == (
        '- chaos worker fake-worker: exited in 2.50s '
        '(25.0% of 10.00s ceiling)\n'
    )


def test_wait_for_worker_exit_warns_at_the_70_percent_boundary(tmp_path,
                                                               monkeypatch,
                                                               capsys):
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _Clock(7))

    assert wait_for_worker_exit(_Worker(), 10, summary_path=str(summary)) == 0

    output = capsys.readouterr().err
    summary_text = summary.read_text()
    assert 'used 70.0% of its 10.00s exit ceiling' in output
    assert 'used 70.0% of its 10.00s exit ceiling' in summary_text


def test_wait_for_worker_exit_distinguishes_a_ceiling_breach(tmp_path,
                                                            monkeypatch):
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _Clock(10.5))

    with pytest.raises(WorkerExitCeilingExceeded, match=(
            r'EXIT CEILING BREACHED.*105\.0%.*no behavioral assertion failed')):
        wait_for_worker_exit(
            _Worker(error=WorkerExitWaitTimeout('timed out after 10s')),
            10,
            summary_path=str(summary),
        )

    assert 'EXIT CEILING BREACHED' in summary.read_text()
    assert 'no behavioral assertion failed' in summary.read_text()


def test_wait_for_worker_exit_does_not_relabel_an_assertion(tmp_path, monkeypatch):
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _Clock(10.5))

    with pytest.raises(AssertionError, match='behavioral assertion failed'):
        wait_for_worker_exit(
            _Worker(error=AssertionError('behavioral assertion failed')),
            10,
            summary_path=str(summary),
        )

    assert not summary.exists()


class _TickingClock:
    """A monotonic clock that advances ``step`` seconds per read."""

    def __init__(self, step: float):
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


def test_shutdown_state_wait_is_labelled_a_ceiling_breach(tmp_path,
                                                          monkeypatch):
    """'s red run timed out in the requeue wait, not the exit wait.

    That wait must carry the same breach label as the exit wait, or the
    exact failure  was filed about still reads as a bare timeout.
    """
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _TickingClock(1.0))
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.sleep',
                        lambda _s: None)

    with pytest.raises(WorkerExitCeilingExceeded, match=(
            r'(?s)requeue.*EXIT CEILING BREACHED.*no behavioral assertion '
            r'failed.*fake worker log')):
        wait_for_worker_shutdown_state(
            _Worker(), lambda: False, 10,
            'worker to requeue the job and record its abort',
            summary_path=str(summary),
        )

    assert 'EXIT CEILING BREACHED' in summary.read_text()


def test_shutdown_state_wait_reports_and_warns(tmp_path, monkeypatch, capsys):
    summary = tmp_path / 'summary.md'
    monkeypatch.setattr('dj.apps.jobs.worker_harness.time.monotonic',
                        _Clock(8))

    assert wait_for_worker_shutdown_state(
        _Worker(), lambda: 'seen', 10, 'the job to requeue',
        summary_path=str(summary),
    ) == 'seen'

    output = capsys.readouterr().err
    assert 'reached it in 8.00s (80.0% of 10.00s ceiling)' in output
    assert 'used 80.0% of its 10.00s exit ceiling' in summary.read_text()
