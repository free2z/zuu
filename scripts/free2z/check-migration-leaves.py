#!/usr/bin/env python3
"""Free2Z application check: check migration leaves."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# `<something>/migrations/<name>.py`, at any depth. Matches `__init__.py` too:
# if main added a brand-new migrations package we want its `__init__.py` in the
# merged tree, or the package is not importable and its migrations vanish
# silently -- a false green.
MIGRATION_PATH_RE = re.compile(r"(?:^|/)migrations/[^/]+\.py$")

# Directories that must never be copied into the sandbox: build artifacts and
# local virtualenvs are large, and a stale __pycache__ copied without its
# source is a way to import a migration that no longer exists.
COPY_IGNORE = shutil.ignore_patterns(
    "__pycache__", "*.pyc", "*.pyo", ".venv", "venv", "node_modules", ".git",
    "*.egg-info", ".pytest_cache", ".mypy_cache",
)

DEFAULT_SETTINGS = "dj.free2z.settings"

# This probe deliberately imports ONLY Django. It runs outside both synthetic
# trees, so its result answers one narrow question without letting branch/base
# PYTHONPATH contents influence the answer: can the configured interpreter see
# its installed Django package at all?
DJANGO_ENVIRONMENT_PROBE = "import django"

# Runs inside the sandbox. Prints one JSON object on stdout; anything Django
# writes to stderr is passed through to the user untouched.
INNER = r"""
import json, sys
import django

django.setup()

from django.db.migrations.loader import MigrationLoader

# connection=None: disk only, no django_migrations table, no DB socket.
loader = MigrationLoader(None, ignore_no_migrations=True)

# detect_conflicts() is what `migrate` and `makemigrations` themselves call.
conflicts = loader.detect_conflicts()

def describe(app_label, name):
    migration = loader.disk_migrations.get((app_label, name))
    info = {"name": name, "file": None, "dependencies": []}
    if migration is None:
        return info
    module = sys.modules.get(type(migration).__module__)
    info["file"] = getattr(module, "__file__", None)
    # The REAL dependency list, straight off the loaded Migration. The repair
    # instructions print it back with only the stale same-app edge rewritten:
    # a migration can legitimately depend on another app (FK ordering, data
    # migrations), and telling somebody to overwrite the whole list would trade
    # a detected collision for an undetected ordering bug.
    for dep in migration.dependencies:
        info["dependencies"].append([str(dep[0]), str(dep[1])])
    return info

out = {}
for app_label, names in conflicts.items():
    out[app_label] = {
        "leaves": [describe(app_label, n) for n in sorted(names)],
        "all": sorted(n for (a, n) in loader.disk_migrations if a == app_label),
    }

print("__MIGRATION_LEAVES_JSON__" + json.dumps(out))
"""


class CheckError(RuntimeError):
    """Something prevented the check from running. Exit 2, never 0."""


def check_django_environment(python: str) -> None:
    """Fail closed if `python` cannot import Django outside either code tree.

    `run_loader()` intentionally puts a synthetic branch/base `py/` first on
    sys.path. That is required to load the merged migration graph, but it means
    an import failure there is evidence about the synthetic tree, not about the
    interpreter: a branch can shadow `django` or break startup via
    `sitecustomize.py`. Diagnose the environment only after a separate probe
    whose cwd and import path cannot contain repository code.
    """
    env = dict(os.environ)
    for name in (
        "DJANGO_SETTINGS_MODULE",
        "PYTHONPATH",
        "PYTHONSTARTUP",
    ):
        env.pop(name, None)

    try:
        with tempfile.TemporaryDirectory(
            prefix="migration-leaves-python."
        ) as clean_cwd:
            proc = subprocess.run(
                [python, "-B", "-c", DJANGO_ENVIRONMENT_PROBE],
                cwd=clean_cwd,
                env=env,
                capture_output=True,
                text=True,
            )
    except OSError as exc:
        raise CheckError(
            f"could not execute configured interpreter {python!r}: {exc}\n\n"
            "This is an environment problem, not a migration problem -- "
            "nothing here says anything about your branch. Activate the "
            "project venv and re-run."
        ) from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        if detail:
            detail = f"\n\nInterpreter output:\n{detail}"
        raise CheckError(
            f"django is not importable in a clean external context by "
            f"{python!r} (exit {proc.returncode}).\n\n"
            "This is an environment problem, not a migration problem -- "
            "nothing here says anything about your branch. Activate the "
            f"project venv and re-run.{detail}"
        )


def git(args: list[str], cwd: Path, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise CheckError(
            f"git {' '.join(args)} failed ({proc.returncode}):\n{proc.stderr.strip()}"
        )
    return proc.stdout


def resolve_base(repo_root: Path, base: str, fetch: bool) -> str:
    """Return the commit sha for `base`, fetching it first unless told not to.

    The fetch is the load-bearing part of this whole script. Skipping it means
    comparing against whatever `origin/main` happened to be the last time
    somebody ran `git fetch`, which on a laptop can be hours stale -- exactly
    the staleness this exists to defeat.
    """
    if fetch:
        remote, _, branch = base.partition("/")
        if not (remote and branch):
            raise CheckError(
                f"--base {base!r} is not of the form <remote>/<branch>, so it "
                f"cannot be fetched. Pass --no-fetch if you meant a local ref."
            )
        proc = subprocess.run(
            ["git", "fetch", "--no-tags", "--quiet", remote, branch],
            cwd=str(repo_root), capture_output=True, text=True,
        )
        if proc.returncode != 0:
            # FAIL CLOSED. Tolerating a failed fetch and falling back to a
            # remote-tracking ref from hours ago is the single worst thing this
            # script could do: its ONLY advantage over the rest of the gate is
            # that its base is fresh, and it would print OK at exactly the
            # moment that guarantee stopped holding.
            raise CheckError(
                f"could not fetch {branch} from {remote} "
                f"({proc.returncode}):\n{proc.stderr.strip()}\n\n"
                f"Refusing to fall back to a possibly stale {base}: a fresh "
                f"base is the entire point of this check.\n"
                f"If you are deliberately checking against a local ref, pass "
                f"--no-fetch."
            )

    out = git(["rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
              cwd=repo_root, check=False).strip()
    if not out:
        raise CheckError(
            f"cannot resolve base ref {base!r}.\n"
            f"In CI, fetch it first:  git fetch --no-tags --depth=1 origin main\n"
            f"Locally:                git fetch origin"
        )
    return out


def base_migration_paths(repo_root: Path, base_sha: str, py_rel: str) -> set[str]:
    listing = git(["ls-tree", "-r", "--name-only", base_sha, "--", py_rel],
                  cwd=repo_root)
    return {p for p in listing.splitlines() if MIGRATION_PATH_RE.search(p)}


def worktree_migration_paths(repo_root: Path, py_dir: Path) -> set[str]:
    found = set()
    for path in py_dir.rglob("*.py"):
        if any(part in ("__pycache__", ".venv", "venv", "node_modules")
               for part in path.parts):
            continue
        rel = path.relative_to(repo_root).as_posix()
        if MIGRATION_PATH_RE.search(rel):
            found.add(rel)
    return found


class LoaderFailure(RuntimeError):
    """The merged tree exists but Django could not import it."""

    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        self.detail = detail


def overlay_blobs(repo_root: Path, sandbox: Path, base_sha: str,
                  paths: set[str]) -> None:
    for rel in sorted(paths):
        blob = subprocess.run(
            ["git", "show", f"{base_sha}:{rel}"],
            cwd=str(repo_root), capture_output=True,
        )
        if blob.returncode != 0:
            raise CheckError(
                f"git show {base_sha}:{rel} failed:\n"
                f"{blob.stderr.decode('utf-8', 'replace').strip()}"
            )
        target = sandbox / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob.stdout)


def build_worktree_sandbox(repo_root: Path, py_dir: Path, base_sha: str,
                           base_only: set[str]) -> tuple[Path, Path]:
    """Working tree's code + code-side files, with base-only migrations added.

    A copy rather than an in-place edit of the real tree: this runs on
    developer laptops, and a crashed run must not be able to leave a stray
    migration file behind in somebody's checkout.
    """
    sandbox = Path(tempfile.mkdtemp(prefix="migration-leaves."))
    py_rel = py_dir.relative_to(repo_root)
    dest_py = sandbox / py_rel
    dest_py.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(py_dir, dest_py, ignore=COPY_IGNORE, symlinks=True)
    try:
        overlay_blobs(repo_root, sandbox, base_sha, base_only)
    except Exception:
        shutil.rmtree(sandbox, ignore_errors=True)
        raise
    return sandbox, dest_py


def build_base_sandbox(repo_root: Path, py_dir: Path, base_sha: str,
                       branch_only: set[str]) -> tuple[Path, Path]:
    """The MIRROR IMAGE: the base ref's whole tree, with this branch's
    migrations added.

    Why a second arrangement exists at all
    --------------------------------------
    The primary sandbox is the working tree's code with main's *migration
    files* dropped in. That is not a real merge, and it has one realistic
    failure: a migration that main landed alongside a new helper module.
    Migrations here do import app code (`from dj.apps... import ...`), so
    overlaying main's newest migration onto an older branch's code can raise
    ImportError -- a red gate for a branch whose merged migration graph is
    perfectly fine, because after a real merge that helper would be present.

    So on an import failure we retry with the sides swapped: base's whole
    `py/` (via `git archive`, no history required, works on a --depth=1
    checkout) plus this branch's new migrations. The union of migrations is
    identical, so the leaf answer is the same; only which side's non-migration
    code is present differs. If both arrangements fail to import, the guard
    exits 2 and says so rather than guessing.
    """
    sandbox = Path(tempfile.mkdtemp(prefix="migration-leaves-base."))
    py_rel = py_dir.relative_to(repo_root)
    dest_py = sandbox / py_rel
    try:
        archive = subprocess.run(
            ["git", "archive", "--format=tar", base_sha, "--", py_rel.as_posix()],
            cwd=str(repo_root), capture_output=True,
        )
        if archive.returncode != 0:
            raise CheckError(
                f"git archive {base_sha} -- {py_rel} failed:\n"
                f"{archive.stderr.decode('utf-8', 'replace').strip()}"
            )
        untar = subprocess.run(
            ["tar", "-x", "-C", str(sandbox)],
            input=archive.stdout, capture_output=True,
        )
        if untar.returncode != 0:
            raise CheckError(
                "could not unpack the base tree:\n"
                f"{untar.stderr.decode('utf-8', 'replace').strip()}"
            )
        if not dest_py.is_dir():
            raise CheckError(f"base tree has no {py_rel}/ directory")
        for rel in sorted(branch_only):
            target = sandbox / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo_root / rel, target)
    except Exception:
        shutil.rmtree(sandbox, ignore_errors=True)
        raise
    return sandbox, dest_py


def run_loader(dest_py: Path, settings_module: str, python: str) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(dest_py)
    env["DJANGO_SETTINGS_MODULE"] = settings_module
    # Determinism + "this is a check, not a server" hygiene.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("PYTHONSTARTUP", None)

    proc = subprocess.run(
        [python, "-c", INNER],
        cwd=str(dest_py), env=env, capture_output=True, text=True,
    )
    # Django app loading is chatty on stderr here (procrastinate announces every
    # periodic task at import). Swallow it on success so a passing run is three
    # lines, and surface every byte of it the moment anything goes wrong.
    if proc.returncode != 0:
        raise LoaderFailure(
            f"Django could not load the migration graph (exit {proc.returncode})",
            proc.stderr,
        )

    marker = "__MIGRATION_LEAVES_JSON__"
    for line in proc.stdout.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker):])
    raise LoaderFailure("the loader subprocess produced no result line",
                        proc.stderr + proc.stdout)


NUMBER_RE = re.compile(r"^(\d+)")


def next_free_number(names: list[str]) -> str:
    highest = 0
    for name in names:
        m = NUMBER_RE.match(name)
        if m:
            highest = max(highest, int(m.group(1)))
    return f"{highest + 1:04d}"


def report(conflicts: dict, sandbox: Path, repo_root: Path,
           base: str, base_paths: set[str], py_dir: Path) -> None:
    """Print an actionable failure. Names the app, both sides, and the fix."""
    say = sys.stderr.write
    say("\n")
    say("=" * 78 + "\n")
    say("MIGRATION LEAF COLLISION\n")
    say(f"Merging this branch into {base} would leave more than one leaf node in\n")
    say("the migration graph.\n")
    say("-" * 78 + "\n")

    for app_label in sorted(conflicts):
        info = conflicts[app_label]
        say(f"\napp '{app_label}':\n")
        ours: list[str] = []
        theirs: list[str] = []
        for leaf in info["leaves"]:
            rel = None
            if leaf.get("file"):
                try:
                    rel = Path(leaf["file"]).resolve().relative_to(
                        sandbox.resolve()).as_posix()
                except ValueError:
                    rel = leaf["file"]
            on_main = rel in base_paths if rel else False
            side = base if on_main else "this branch"
            (theirs if on_main else ours).append(leaf["name"])
            say(f"    {leaf['name']:<48} <- {side}\n")
            if rel:
                say(f"        {rel}\n")

        suggested = next_free_number(info["all"])
        say("\n")
        if ours and theirs:
            mine = ours[0]
            mine_leaf = next(l for l in info["leaves"] if l["name"] == mine)
            say(f"    {base} already advanced past the migration this branch\n")
            say(f"    forked from. Rebase and renumber '{mine}':\n\n")
            new_name = NUMBER_RE.sub(suggested, mine, count=1)
            say("        git fetch origin && git rebase origin/main\n")
            say(f"        git mv {rel_migration(py_dir, repo_root, app_label, mine)} \\\n")
            say(f"               {rel_migration(py_dir, repo_root, app_label, new_name)}\n\n")
            # Rewrite ONLY the stale same-app edge and print every other
            # dependency back verbatim. A migration can legitimately depend on
            # another app (FK ordering, data migrations reading another app's
            # table); an instruction to overwrite the whole list would swap a
            # detected collision for an undetected ordering bug that also stops
            # the deploy -- just later, and without a guard to catch it.
            rewritten = []
            replaced = False
            for dep_app, dep_name in mine_leaf.get("dependencies") or []:
                if dep_app == app_label and not replaced:
                    rewritten.append((app_label, theirs[0]))
                    replaced = True
                else:
                    rewritten.append((dep_app, dep_name))
            if not replaced:
                rewritten.append((app_label, theirs[0]))
            rendered = ", ".join(f'("{a}", "{n}")' for a, n in rewritten)
            say(f"    then repoint its same-app dependency at {base}'s leaf --\n")
            say("    keeping every other dependency exactly as it is:\n\n")
            say(f"        dependencies = [{rendered}]\n")
            if len(rewritten) > 1:
                say("\n    (the non-'" + app_label + "' entries above are yours and are\n")
                say("    reproduced unchanged -- do not drop them.)\n")
        else:
            say("    Both leaves are on the same side, so this is a fork that was\n")
            say("    committed as-is rather than a stale-base collision. Renumber one\n")
            say("    of them and chain it onto the other.\n")

    say("\n" + "-" * 78 + "\n")
    say("Then confirm locally and PUSH:\n\n")
    say("    make migration-leaves\n\n")
    say("Push a new commit -- do NOT click 'Re-run jobs'. A re-run replays the\n")
    say("ORIGINAL commit and the ORIGINAL workflow file, so it neither sees the\n")
    say(f"new {base} nor (on a PR older than this guard) contains this check at\n")
    say("all. Only a new push produces a run against a fresh base. A green run\n")
    say(f"from before {base} moved proves nothing, which is how all three of the\n")
    say("Migrations must retain a single leaf for each application.\n\n")
    say("If both migrations must be preserved exactly as written (a genuine\n")
    say("concurrent fork, not a stale base), generate a merge migration instead:\n\n")
    say("    python py/free2z/dj/free2z/manage.py makemigrations --merge\n\n")
    say("This check accepts a merge migration: it collapses the fork to one leaf.\n")
    say("\nWHY THIS MATTERS: `manage.py migrate` refuses to run against a two-leaf\n")
    say("graph. migrate is a Cloud Build step that APPLY waits on, so a collision\n")
    say("aborts the ENTIRE production deploy -- every unrelated change riding that\n")
    say("build, not just this one.\n")
    say("=" * 78 + "\n")


def rel_migration(py_dir: Path, repo_root: Path, app_label: str, name: str) -> str:
    """Best-effort repo-relative path for a migration, for the copy-paste hint."""
    for candidate in py_dir.rglob(f"{app_label}/migrations"):
        return (candidate.relative_to(repo_root) / f"{name}.py").as_posix()
    return f"<{app_label}>/migrations/{name}.py"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail if merging this branch into the base ref would fork "
                    "the Django migration graph.")
    parser.add_argument("--base", default="origin/main",
                        help="base ref to merge against (default: origin/main)")
    parser.add_argument("--no-fetch", action="store_true",
                        help="do not fetch the base ref first. Only for tests "
                             "and offline use: a stale base is the bug.")
    parser.add_argument("--repo-root", default=None)
    parser.add_argument("--py-dir", default=None,
                        help="python package root (default: <repo-root>/py)")
    parser.add_argument("--settings", default=os.environ.get(
        "MIGRATION_LEAVES_SETTINGS", DEFAULT_SETTINGS))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--keep-sandbox", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.repo_root:
            repo_root = Path(args.repo_root).resolve()
        else:
            repo_root = Path(git(["rev-parse", "--show-toplevel"],
                                 cwd=Path.cwd()).strip()).resolve()
        py_dir = Path(args.py_dir).resolve() if args.py_dir else repo_root / "py" / "free2z"
        if not py_dir.is_dir():
            raise CheckError(f"python package dir not found: {py_dir}")

        # Diagnose a genuinely missing/broken Django environment before either
        # synthetic tree can affect imports. Arrangement failures are NEVER
        # enough to make this claim: their cwd/PYTHONPATH differ by design.
        check_django_environment(args.python)

        py_rel = py_dir.relative_to(repo_root).as_posix()
        base_sha = resolve_base(repo_root, args.base, fetch=not args.no_fetch)
        base_paths = base_migration_paths(repo_root, base_sha, py_rel)
        disk_paths = worktree_migration_paths(repo_root, py_dir)
        base_only = base_paths - disk_paths

        print(f"migration-leaves: base {args.base} = {base_sha[:12]}")
        print(f"migration-leaves: {len(disk_paths)} migration files on disk, "
              f"{len(base_only)} overlaid from {args.base}")
        for rel in sorted(base_only):
            print(f"migration-leaves:   + {rel}")

        # Two arrangements of the SAME union of migrations, differing only in
        # whose non-migration code is present. The first is tried because it
        # reflects the branch under review; the second exists because main's
        # newest migration may import a helper main added alongside it, which
        # an older branch does not have -- see build_base_sandbox().
        arrangements = [
            ("branch code + base migrations",
             lambda: build_worktree_sandbox(repo_root, py_dir, base_sha, base_only)),
            ("base code + branch migrations",
             lambda: build_base_sandbox(repo_root, py_dir, base_sha,
                                        disk_paths - base_paths)),
        ]

        first_failure: LoaderFailure | None = None
        for label, make in arrangements:
            sandbox, dest_py = make()
            try:
                try:
                    conflicts = run_loader(dest_py, args.settings, args.python)
                except LoaderFailure as failure:
                    if first_failure is None:
                        first_failure = failure
                    print(f"migration-leaves: '{label}' did not import "
                          f"({failure}); retrying with the sides swapped")
                    continue
                if conflicts:
                    # The report goes to stderr; flush stdout first so CI logs
                    # interleave in the order things actually happened.
                    sys.stdout.flush()
                    report(conflicts, sandbox, repo_root, args.base,
                           base_paths, py_dir)
                    return 1
                break
            finally:
                if args.keep_sandbox:
                    print(f"migration-leaves: sandbox kept at {sandbox}")
                else:
                    shutil.rmtree(sandbox, ignore_errors=True)
        else:
            # Neither arrangement imports. Do not guess; say what is wrong.
            sys.stderr.write(first_failure.detail if first_failure else "")
            raise CheckError(
                f"{first_failure}\n\n"
                "Both arrangements of the merged tree failed to import, so the\n"
                "migration graph could not be resolved either way. The usual\n"
                "cause is a branch far enough behind that migrations and the\n"
                "code they import no longer line up in EITHER direction:\n\n"
                "    git fetch origin && git rebase origin/main\n\n"
                "and run this again. The traceback above is from the first\n"
                "attempt (this branch's code)."
            )
    except CheckError as exc:
        sys.stderr.write(f"\nmigration-leaves: CANNOT RUN: {exc}\n")
        return 2

    print(f"migration-leaves: OK -- merging into {args.base} leaves exactly one "
          f"leaf per app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
