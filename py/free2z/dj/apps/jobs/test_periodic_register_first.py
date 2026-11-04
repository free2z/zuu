"""The static scan in ``scripts/free2z/check-periodic-register-first.py`` sees what Django
actually registers.

That checker reads ``@app.periodic`` / ``@app.task`` with ``ast`` so it can
compare two git revisions without importing either. A static scan that misses
a decorator form, or a ``name=`` it cannot follow, would make the governance
check pass while testing nothing -- and one that counts a definition Django
never imports would vouch for a name old workers do not know. This pins it to
the live registry in both directions, for schedules and for task names.

NO DATABASE: the in-process Procrastinate registry plus the source tree.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

from procrastinate.contrib.django import app

REPO_ROOT = pathlib.Path(__file__).resolve().parents[5]
CHECK = REPO_ROOT / "scripts" / "free2z" / "check-periodic-register-first.py"


def _checker():
    spec = importlib.util.spec_from_file_location("check_periodic_register_first", CHECK)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve their module by name
    spec.loader.exec_module(module)
    return module


def _scan():
    checker = _checker()
    return checker.scan(checker.modules_in_dir(str(REPO_ROOT)), strict=True)


def test_static_scan_finds_exactly_the_registered_schedules():
    _, schedules, unresolved = _scan()
    assert unresolved == []
    static = {s.name for s in schedules}
    live = {p.task.name for p in app.periodic_registry.periodic_tasks.values()}
    assert live, "no periodic task registered at all -- the comparison is vacuous"
    assert static == live, (
        f"missed by the static scan: {sorted(live - static)}; "
        f"invented by it: {sorted(static - live)}"
    )


def test_static_scan_sees_every_registered_task_name():
    registered, _, _ = _scan()
    live = {
        name for name in app.tasks
        # Procrastinate's own builtins are registered by the library, not by
        # a decorator in this repo (named either way across 3.x releases).
        if not name.startswith(("builtin:", "procrastinate."))
    }
    missing = live - registered
    assert not missing, (
        f"registered at runtime but invisible to the static scan: {sorted(missing)}; "
        "a schedule for one of these would be refused as 'not registered at base'"
    )
    # The direction the guard's safety rests on. Every base the checker reads
    # passed this test as a head, so a name the scan counts at base is one
    # Django really registered there -- not a definition in a module nothing
    # imports, which would let a later release schedule it against workers
    # that never knew it.
    invented = registered - live
    assert not invented, (
        f"counted as registered by the static scan but absent from the live "
        f"registry: {sorted(invented)}; import the module from a tasks module "
        "Procrastinate autodiscovers, or move the definition"
    )


def test_revision_scan_is_independent_of_invocation_directory(tmp_path, monkeypatch):
    checker = _checker()
    expected, expected_schedules, unresolved = checker.scan(checker.modules_at("HEAD"), strict=True)
    assert expected and expected_schedules and unresolved == []
    monkeypatch.chdir(tmp_path)
    registered, schedules, unresolved = checker.scan(checker.modules_at("HEAD"), strict=True)
    assert registered == expected
    assert {schedule.name for schedule in schedules} == {schedule.name for schedule in expected_schedules}
    assert unresolved == []


def test_empty_head_inventory_is_not_a_successful_release_check(monkeypatch):
    import pytest

    checker = _checker()
    monkeypatch.setattr(checker, "modules_at", lambda rev: {})
    with pytest.raises(checker.Unevaluable, match="contains no application Python modules"):
        checker.evaluate("base", "head")
