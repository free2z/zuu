#!/usr/bin/env python3
"""Require periodic task names to be registered in the selected base revision.

Usage: scripts/free2z/check-periodic-register-first.py --base REV [--head REV]

A rolling deployment can defer work before every consumer knows a new task.
Register the task in one deployed release before adding its periodic schedule.
The checker supports direct task/periodic decorators with unambiguous names.
Runtime registry parity tests must prove that scanned definitions are imported
and registered, and that no dynamic schedule escapes the scan. The AST check
alone is not evidence that a worker registered a task. Compare
against the deployed source revision to validate a release batch. Comparing
only against a PR base cannot prove an earlier registration was deployed.

Exit codes: 0 clean, 1 finding, 2 input cannot be evaluated. Renamed or retired
tasks with pending database rows require separate operational validation.
"""

from __future__ import annotations

import argparse
import ast
import subprocess
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path

ROOT_PREFIX = "py/free2z/"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Schedule:
    name: str
    path: str
    line: int


class Unevaluable(Exception):
    """An input the check cannot read; never treated as clean."""


def is_test_module(path: str) -> bool:
    parts = path.split("/")
    base = parts[-1]
    return (
        "tests" in parts[:-1]
        or base.startswith("test_")
        or base.endswith("_test.py")
        or base == "conftest.py"
    )


def git(*args: str) -> bytes:
    proc = subprocess.run(["git", "-C", str(REPOSITORY_ROOT), *args], capture_output=True)
    if proc.returncode != 0:
        raise Unevaluable(
            f"git {' '.join(args)} failed: {proc.stderr.decode(errors='replace').strip()}"
        )
    return proc.stdout


def modules_in_dir(repo_root: str) -> dict[str, str]:
    """Every non-test ``py/free2z/**.py`` in a working tree, path -> source.

    Used by ``py/free2z/dj/apps/jobs/test_periodic_register_first.py`` to prove the
    static scan sees exactly the schedules Django actually registers."""
    import os
    # Only files git would ship: tracked, plus untracked-but-not-ignored (a
    # new module under review). Walking the directory instead picked up an
    # ignored local virtualenv under py/ and Procrastinate's own builtins.
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard",
         "--", ROOT_PREFIX],
        cwd=repo_root, capture_output=True, check=True,
    ).stdout.decode()
    sources: dict[str, str] = {}
    for rel in sorted(set(p for p in listing.split("\0") if p)):
        full = os.path.join(repo_root, rel)
        if rel.endswith(".py") and not is_test_module(rel) and os.path.isfile(full):
            with open(full, encoding="utf-8", errors="replace") as handle:
                sources[rel] = handle.read()
    return sources


def modules_at(rev: str) -> dict[str, str]:
    """Every non-test ``py/free2z/**.py`` at ``rev``, path -> source."""
    try:
        git("rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    except Unevaluable:
        raise Unevaluable(f"revision {rev!r} does not resolve to a commit")
    listing = git("ls-tree", "-r", "-z", "--name-only", rev, "--", ROOT_PREFIX)
    paths = [
        p for p in listing.decode().split("\0")
        if p.endswith(".py") and not is_test_module(p)
    ]
    if not paths:
        return {}
    request = "".join(f"{rev}:{p}\n" for p in paths).encode()
    proc = subprocess.run(
        ["git", "-C", str(REPOSITORY_ROOT), "cat-file", "--batch"], input=request, capture_output=True,
    )
    if proc.returncode != 0:
        raise Unevaluable("git cat-file --batch failed")
    out, sources, pos = proc.stdout, {}, 0
    for path in paths:
        header_end = out.index(b"\n", pos)
        header = out[pos:header_end].split()
        if len(header) != 3:
            raise Unevaluable(f"cannot read {rev}:{path}")
        size = int(header[2])
        start = header_end + 1
        sources[path] = out[start:start + size].decode("utf-8", errors="replace")
        pos = start + size + 1
    return sources


def module_name(path: str) -> str:
    dotted = path[len(ROOT_PREFIX):-len(".py")].replace("/", ".")
    return dotted[: -len(".__init__")] if dotted.endswith(".__init__") else dotted


def _decorator_attr(node: ast.expr) -> str | None:
    """`task` for ``@app.task`` / ``@app.task(...)``; None for anything else."""
    target = node.func if isinstance(node, ast.Call) else node
    if isinstance(target, ast.Attribute):
        return target.attr
    return None


def _string_constants(tree: ast.Module) -> dict[str, str]:
    consts: dict[str, str] = {}
    assignments: dict[str, int] = {}
    for stmt in tree.body:
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, (ast.AnnAssign, ast.AugAssign)) else []
        for target in targets:
            if isinstance(target, ast.Name):
                assignments[target.id] = assignments.get(target.id, 0) + 1
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and isinstance(stmt.value, ast.Constant)
            and isinstance(stmt.value.value, str)
        ):
            consts[stmt.targets[0].id] = stmt.value.value
        elif (
            isinstance(stmt, ast.AnnAssign)
            and isinstance(stmt.target, ast.Name)
            and isinstance(stmt.value, ast.Constant)
            and isinstance(stmt.value.value, str)
        ):
            consts[stmt.target.id] = stmt.value.value
    # Rebinding invalidates a value as evidence of what an earlier decorator saw.
    return {name: value for name, value in consts.items() if assignments[name] == 1}


def _import_aliases(tree: ast.Module, here: str) -> dict[str, str]:
    """local name -> dotted target (a module, or ``module.ATTR``)."""
    aliases: dict[str, str] = {}
    package = here.rsplit(".", 1)[0] if "." in here else ""
    for stmt in tree.body:
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                if alias.asname:
                    aliases[alias.asname] = alias.name
        elif isinstance(stmt, ast.ImportFrom):
            source = stmt.module or ""
            if stmt.level:
                parts = package.split(".")
                parts = parts[: len(parts) - (stmt.level - 1)] if stmt.level > 1 else parts
                source = ".".join(p for p in [*parts, source] if p)
            for alias in stmt.names:
                aliases[alias.asname or alias.name] = f"{source}.{alias.name}"
    return aliases


def _resolve(expr: ast.expr, here: str, consts: dict[str, dict[str, str]],
             aliases: dict[str, str]) -> str | None:
    """A static string for ``"x"``, ``NAME``, ``module.NAME`` or an imported
    ``NAME``; None for anything computed."""
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return expr.value
    if isinstance(expr, ast.Name):
        if expr.id in consts.get(here, {}):
            return consts[here][expr.id]
        target = aliases.get(expr.id)
        if target and "." in target:
            module, attr = target.rsplit(".", 1)
            return consts.get(module, {}).get(attr)
        return None
    if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
        module = aliases.get(expr.value.id, expr.value.id)
        return consts.get(module, {}).get(expr.attr)
    return None


def _task_name(deco: ast.expr, func: ast.AST, here: str,
               consts: dict[str, dict[str, str]],
               aliases: dict[str, str]) -> str | None:
    """The registered name, Procrastinate's ``module.func`` default when
    ``name=`` is absent, or None when it is not a static string."""
    if isinstance(deco, ast.Call):
        if any(kw.arg is None for kw in deco.keywords):
            return None  # **kwargs may replace the default registration name.
        for kw in deco.keywords:
            if kw.arg == "name":
                return _resolve(kw.value, here, consts, aliases)
    return f"{here}.{func.name}"


def scan(sources: dict[str, str], *, strict: bool):
    """Return (registered task names, schedules, unresolved schedules)."""
    registered: set[str] = set()
    schedules: list[Schedule] = []
    unresolved: list[str] = []
    trees: dict[str, tuple[str, ast.Module]] = {}
    for path, source in sorted(sources.items()):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                tree = ast.parse(source, filename=path)
        except SyntaxError as exc:
            if strict:
                raise Unevaluable(f"{path}: cannot parse ({exc.msg}, line {exc.lineno})")
            continue  # an unparsable base module registers nothing we can see
        trees[path] = (module_name(path), tree)
    consts = {mod: _string_constants(tree) for mod, tree in trees.values()}
    for path, (here, tree) in trees.items():
        aliases = _import_aliases(tree, here)
        # Module top level only: a decorator inside `if`, `try`, a class or
        # another function is not proof the import registers it. Nothing in
        # the tree registers a task that way, and
        # py/free2z/dj/apps/jobs/test_periodic_register_first.py fails if the scan
        # and the live registry ever disagree in EITHER direction -- which is
        # what makes a base that passed CI as a head trustworthy as a base.
        for func in tree.body:
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            attrs = [_decorator_attr(d) for d in func.decorator_list]
            task_decos = [d for d, a in zip(func.decorator_list, attrs) if a == "task"]
            if not task_decos:
                continue
            names = [_task_name(d, func, here, consts, aliases) for d in task_decos]
            registered.update(n for n in names if n)
            if "periodic" in attrs:
                for name in names:
                    if name is None:
                        unresolved.append(f"{path}:{func.lineno} {func.name}")
                    else:
                        schedules.append(Schedule(name, path, func.lineno))
        # A schedule the top-level scan cannot see (under `if settings.FLAG:`,
        # in a class, in a function) would otherwise pass silently. It is
        # unreadable, never clean: reported so `evaluate` exits 2 at head.
        top_level = {id(node) for node in tree.body}
        decorator_calls = {
            id(decorator)
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            for decorator in node.decorator_list
            if isinstance(decorator, ast.Call)
        }
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "periodic" and id(node) not in decorator_calls):
                unresolved.append(f"{path}:{node.lineno} periodic call outside a function decorator")
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and id(node) not in top_level
                and any(_decorator_attr(d) == "periodic" for d in node.decorator_list)
            ):
                unresolved.append(
                    f"{path}:{node.lineno} {node.name} (not at module top level)"
                )
    return registered, schedules, unresolved


def evaluate(base: str, head: str) -> tuple[int, list[str]]:
    head_modules = modules_at(head)
    if not head_modules:
        raise Unevaluable(f"revision {head!r} contains no application Python modules under {ROOT_PREFIX}")
    head_registered, head_schedules, unresolved = scan(head_modules, strict=True)
    if unresolved:
        return 2, [
            f"cannot evaluate the periodic task at {u}; define it at module "
            "top level with a string literal or a module-level string "
            "constant for name="
            for u in unresolved
        ]
    base_registered, _, _ = scan(modules_at(base), strict=False)
    findings = []
    for sched in head_schedules:
        if sched.name not in base_registered:
            findings.append(
                f"{sched.path}:{sched.line}: '{sched.name}' is scheduled "
                "(@app.periodic) in the same change that first registers it. "
                "Every worker lane defers its schedule as soon as that lane "
                "rolls, and the old consumer of its queue fails each tick "
                "with TaskNotFound (no retry) until it rolls too. Register first, produce "
                "second: ship the @app.task (inert body accepting "
                "`timestamp`) and its TASK_POLICIES entry now, the "
                "@app.periodic in a later release (see "
                "dyte.reconcile_create_unknowns)."
            )
    return (1 if findings else 0), findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", required=True,
                        help="the rev every worker lane is assumed to run (PR base, or the live prod tag)")
    parser.add_argument("--head", default="HEAD", help="the rev being shipped (default HEAD)")
    args = parser.parse_args(argv)
    try:
        code, messages = evaluate(args.base, args.head)
    except Unevaluable as exc:
        print(f"::error title=periodic register-first::{exc}", file=sys.stderr)
        print("check-periodic-register-first: CANNOT EVALUATE -- this is not a pass", file=sys.stderr)
        return 2
    for message in messages:
        print(f"::error title=periodic register-first::{message}")
    if code == 0:
        print(f"check-periodic-register-first: every schedule at {args.head} names a task "
              f"already registered at {args.base}")
    return code


if __name__ == "__main__":
    sys.exit(main())
