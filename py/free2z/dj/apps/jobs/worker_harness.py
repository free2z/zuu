"""
Test support: a REAL ``manage.py procrastinate worker`` as a subprocess
of the test that owns it.

Shared by ``test_chaos_worker.py`` (which kills the worker) and
``test_jobs_smoke.py`` (which lets it consume the smoke probes). It is a
module under ``dj/`` rather than a conftest fixture because both suites
want the same object with the same guarantees, and because the guarantees
are worth spelling out once:

* the subprocess hits THIS test's database. pytest-django names it
  ``test_<DBNAME>``; the host/port/user/password already come through the
  environment (``settings.py`` reads ``DBHOST`` & co.), the name does not,
  so it is set explicitly from the live connection;
* it runs in its own session/process group, so a signal aimed at it can
  never reach pytest, and SIGSTOP/SIGCONT are unambiguous;
* ``close()`` always terminates it, continuing a stopped process first
  (a stopped process ignores SIGTERM), then escalating to SIGKILL. No
  worker outlives its test, whatever the test did to it;
* nothing production-specific is inherited: the bounded connector and the
  liveness beacon (``PROCRASTINATE_WORKER_POOL_SIZE``, ) are the
  pod's concern and would need psycopg pool sizing that has nothing to do
  with what these tests measure.

Nothing here is imported by production code. It lives under ``dj/`` and
therefore ships in the image; that is harmless (it is inert unless
called) and it keeps the two suites from carrying two diverging copies.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Iterable

from django.db import connection

from dj.apps.jobs.chaos_tasks import ARMING_ENV_VAR

PY_ROOT = Path(__file__).resolve().parents[3]
MANAGE_PY = PY_ROOT / 'dj' / 'free2z' / 'manage.py'


class WorkerExitCeilingExceeded(TimeoutError):
    """A worker did not reach a terminal state before its test ceiling."""


class WaitUntilTimeout(TimeoutError):
    """The shared polling helper reached its deadline."""


class WorkerExitWaitTimeout(WaitUntilTimeout):
    """The worker-specific exit wait reached its deadline."""


def _append_step_summary(line: str, summary_path: str | None) -> None:
    if not summary_path:
        return
    with open(summary_path, 'a', encoding='utf-8') as summary:
        summary.write(line + '\n')


def _ceiling_breach(label: str, ceiling: float, started: float,
                    summary_path: str | None, log: str,
                    cause: BaseException) -> WorkerExitCeilingExceeded:
    elapsed = max(0.0, time.monotonic() - started)
    percent = elapsed * 100 / ceiling
    telemetry = (
        f'chaos worker {label}: EXIT CEILING BREACHED after '
        f'{elapsed:.2f}s ({percent:.1f}% of {ceiling:.2f}s ceiling)'
    )
    # Honest about what a timeout can and cannot tell you: it is either a
    # slow runner or a real hang, and only the elapsed telemetry that green
    # runs print tells those apart.
    distinction = (
        f'{telemetry}; no behavioral assertion failed (a slow runner or a '
        'real hang -- compare the elapsed telemetry of green runs)'
    )
    print(telemetry, file=sys.stderr, flush=True)
    _append_step_summary(f'- ❌ {distinction}', summary_path)
    exc = WorkerExitCeilingExceeded(f'{distinction}; worker log:\n{log}')
    exc.__cause__ = cause
    return exc


def _report_within_ceiling(label: str, ceiling: float, started: float,
                           summary_path: str | None, warn: bool,
                           warn_percent: int, done: str = 'exited') -> None:
    elapsed = max(0.0, time.monotonic() - started)
    percent = elapsed * 100 / ceiling
    telemetry = (
        f'chaos worker {label}: {done} in {elapsed:.2f}s '
        f'({percent:.1f}% of {ceiling:.2f}s ceiling)'
    )
    print(telemetry, file=sys.stderr, flush=True)
    _append_step_summary(f'- {telemetry}', summary_path)
    if warn and percent >= warn_percent:
        warning = (
            f'⚠️ chaos worker {label} used {percent:.1f}% of its '
            f'{ceiling:.2f}s exit ceiling while the worker still {done} '
            'successfully'
        )
        print(warning, file=sys.stderr, flush=True)
        _append_step_summary(warning, summary_path)


def _check_ceiling(ceiling: float, summary_path: str | None) -> str | None:
    if ceiling <= 0:
        raise ValueError('worker exit ceiling must be greater than zero')
    if summary_path is None:
        summary_path = os.environ.get('GITHUB_STEP_SUMMARY')
    return summary_path


def wait_for_worker_exit(worker, ceiling: float, *,
                         warn_percent: int = 70,
                         summary_path: str | None = None) -> int:
    """Wait for a worker and report how much of its exit ceiling it used.

    A timeout here is an infrastructure/test-harness ceiling breach, not a
    behavioral assertion. Keep it as a distinct exception so pytest's failure
    points at the ceiling path and cannot be mistaken for the assertions that
    follow the wait.
    """
    summary_path = _check_ceiling(ceiling, summary_path)
    started = time.monotonic()
    try:
        returncode = worker.wait_until_exited(ceiling)
    except WorkerExitWaitTimeout as exc:
        raise _ceiling_breach(worker.name, ceiling, started, summary_path,
                              worker.log(), exc) from exc
    _report_within_ceiling(worker.name, ceiling, started, summary_path,
                           returncode == 0, warn_percent)
    return returncode


def wait_for_worker_shutdown_state(worker, predicate: Callable[[], object],
                                   ceiling: float, what: str, *,
                                   warn_percent: int = 70,
                                   summary_path: str | None = None):
    """``wait_until`` under an exit ceiling, with the same telemetry.

    For the shutdown-path waits that are bounded by the exit ceiling but
    observe state rather than process exit (e.g. "the worker requeued the
    job before exiting"). 's own red run timed out HERE, not in the
    exit wait, so this must carry the same breach label and 70% warning.
    """
    summary_path = _check_ceiling(ceiling, summary_path)
    label = f'{worker.name} ({what})'
    started = time.monotonic()
    try:
        result = wait_until(predicate, ceiling, what)
    except WaitUntilTimeout as exc:
        raise _ceiling_breach(label, ceiling, started, summary_path,
                              worker.log(), exc) from exc
    _report_within_ceiling(label, ceiling, started, summary_path, True,
                           warn_percent, done='reached it')
    return result


class Worker:
    """One real ``manage.py procrastinate worker``, owned by the test."""

    def __init__(self, name: str, log_dir: Path, *, queues: Iterable[str],
                 shutdown_graceful: float | None = None,
                 extra_env: dict[str, str] | None = None):
        self.name = name
        self.log_path = Path(log_dir) / f'{name}.log'
        self._log = open(self.log_path, 'ab')
        env = dict(os.environ)
        env['DBNAME'] = connection.settings_dict['NAME']
        env['PYTHONPATH'] = os.pathsep.join(
            p for p in [str(PY_ROOT), env.get('PYTHONPATH', '')] if p)
        env[ARMING_ENV_VAR] = '1'
        env['PYTHONUNBUFFERED'] = '1'
        env.pop('PROCRASTINATE_WORKER_POOL_SIZE', None)
        env.update(extra_env or {})
        args = [
            sys.executable, str(MANAGE_PY), 'procrastinate', 'worker',
            '--queues=' + ','.join(queues), f'--name={name}',
            '--concurrency=1',
            # LISTEN/NOTIFY is on by default; the poll is the fallback so a
            # missed notification costs a second, not the test.
            '--fetch-job-polling-interval=1',
        ]
        if shutdown_graceful is not None:
            args.append(f'--shutdown-graceful-timeout={shutdown_graceful}')
        self.proc = subprocess.Popen(
            args, env=env, cwd=str(PY_ROOT),
            stdout=self._log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    @property
    def pid(self) -> int:
        return self.proc.pid

    def signal(self, sig: int) -> None:
        self.proc.send_signal(sig)

    def wait(self, timeout: float) -> int:
        return self.proc.wait(timeout=timeout)

    def wait_until_exited(self, timeout: float) -> int:
        """Wait for terminal state with shared diagnostics after state checks.

        ``Popen.wait(timeout=...)`` already observes terminal state using
        bounded polling on POSIX. This wrapper uses the harness's shared
        bounded wait so failures carry the worker log; callers still assert
        the expected database and marker state separately.
        """
        def _exited():
            return None if self.proc.poll() is None else (self.proc.returncode,)

        try:
            return wait_until(_exited, timeout,
                              f'worker {self.name} to exit')[0]
        except WaitUntilTimeout as exc:
            raise WorkerExitWaitTimeout(
                f'{exc}; worker log:\n{self.log()}'
            ) from exc

    def alive(self) -> bool:
        return self.proc.poll() is None

    def log(self) -> str:
        self._log.flush()
        return self.log_path.read_text(errors='replace')

    def close(self) -> None:
        if self.alive():
            try:
                self.proc.send_signal(signal.SIGCONT)
            except ProcessLookupError:
                pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self._log.close()


def wait_until(predicate: Callable[[], object], timeout: float, what: str,
               every: float = 0.1):
    """Poll ``predicate`` until truthy; raise with the last observation."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(every)
    raise WaitUntilTimeout(
        f'timed out after {timeout}s waiting for {what} '
        f'(last observation: {last!r})'
    )


def process_state(pid: int) -> str:
    """'stopped' / 'running' / 'gone', portably enough for Linux and macOS."""
    try:
        out = subprocess.run(
            ['ps', '-o', 'stat=', '-p', str(pid)],
            capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return 'gone'
    if not out:
        return 'gone'
    return 'stopped' if out.startswith('T') else 'running'
