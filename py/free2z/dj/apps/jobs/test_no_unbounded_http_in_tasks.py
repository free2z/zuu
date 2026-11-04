"""
Guard: no outbound `requests` call reachable from a procrastinate task may
be unbounded.

`requests` has NO default timeout. A provider that accepts the TCP
connection and then never answers pins the calling thread for the life of
the process. On a procrastinate worker that is not one lost request: the
job sits in `doing` forever, the reclaimer cannot touch it (a task with no
derivable wall clock is classified NEVER in reclaim_policy.py, precisely
because an unbounded call gives you no number to threshold on), and every
other job on that queue waits behind it. That is the literal
"hung on an external call that never returns" cause the `job_stuck`
runbook lists, and it is how `dyte.sweep_live_meetings` -- periodic every
minute on the catch-all `default` queue -- could take the whole lane down.

Scope, deliberately narrow and mechanical: the task modules themselves
(`tasks.py`) and the provider clients they reach for (`client*.py`). This
is a lint, not a call-graph analysis; it cannot prove a helper three
modules deep is bounded. It pins the surface where the incidents happened
and where a new bare `requests.get` is most likely to be added.

Parsed with `ast`, not grepped, so it is formatting-insensitive by
construction (a call split over five lines reads the same as a one-liner)
and so the commented-out and docstring examples in `dyte/client.py` --
which contain real, timeout-less `requests.get(...)` text -- are correctly
invisible: they are not code.
"""
import ast
from pathlib import Path

import pytest

#py/dj/apps
APPS_ROOT = Path(__file__).resolve().parent.parent

#The module-level `requests` verbs that issue a request. `request` is in
#here too: `requests.request("POST", url,...)` is the same hazard wearing
#a different name, and dyte/client.py's docstrings show exactly that form.
REQUEST_VERBS = frozenset({
    "get", "post", "put", "patch", "delete", "head", "options", "request",
})


def _scanned_files():
    """Task modules and the provider clients they call, under py/dj/apps."""
    files = set(APPS_ROOT.glob("**/tasks.py"))
    files |= set(APPS_ROOT.glob("**/client*.py"))
    # Test modules are not shipped code paths; a test may legitimately
    # construct an unbounded call to prove something hangs.
    return sorted(f for f in files if not f.name.startswith("test_"))


def _requests_calls(tree):
    """Every `requests.<verb>(...)` Call node in an already-parsed module."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        if func.attr not in REQUEST_VERBS:
            continue
        value = func.value
        # `requests.get(...)`. A Session instance carries its own timeout
        # semantics and is not the shape this guard is about.
        if isinstance(value, ast.Name) and value.id == "requests":
            yield node


def _has_timeout(call):
    """True when the call passes `timeout=` -- or forwards **kwargs.

    `**kwargs` is accepted because the value cannot be read statically; a
    thin pass-through wrapper is not what this guard is hunting.
    """
    for keyword in call.keywords:
        if keyword.arg == "timeout":
            return True
        if keyword.arg is None:  # **kwargs
            return True
    return False


def test_the_guard_actually_finds_the_calls_it_claims_to_check():
    """Negative control for the scanner itself.

    A scan that silently matches nothing is a test that passes without
    testing. Pin that the sweep really does reach live `requests.*` calls
    in real shipped modules -- if a refactor moves them, this fails and
    says so rather than turning the guard below into a no-op.
    """
    found = {}
    for path in _scanned_files():
        tree = ast.parse(path.read_text(), filename=str(path))
        calls = list(_requests_calls(tree))
        if calls:
            found[path.name] = len(calls)

    assert found, (
        "the scanner found no requests.* calls at all in any tasks.py or "
        "client*.py under py/dj/apps -- the guard below is vacuous"
    )
    # The two modules the  audit named. Both are real outbound
    # provider calls on a task-reachable path.
    assert "client.py" in found or "clients.py" in found


@pytest.mark.parametrize("path", _scanned_files(), ids=lambda p: str(p.name))
def test_every_requests_call_in_a_task_module_carries_a_timeout(path):
    tree = ast.parse(path.read_text(), filename=str(path))
    unbounded = [
        call.lineno for call in _requests_calls(tree) if not _has_timeout(call)
    ]
    assert not unbounded, (
        f"{path}: requests.* call(s) with no timeout= at line(s) "
        f"{unbounded}. `requests` has no default timeout, so a black-holed "
        f"socket pins this worker forever and the reclaimer cannot heal it. "
        f"Pass timeout=(connect, read) from a setting."
    )
