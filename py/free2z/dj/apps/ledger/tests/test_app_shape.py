"""What this app may be (: new apps are self-contained so they can move).

* Its runtime code imports only the shared economy epoch preparation helpers
  and the immutable ``MAINTENANCE`` priority scalar from other ``dj.apps``
  packages. The scalar comes from ``jobs.priorities``, which contains shared
  priority values and their ordering assertion, not jobs runtime code. Other
  app crossings, including dynamic model lookup and services, remain
  prohibited. The only foreign database object its SQL knows is the
  ``g12f_creator`` TABLE, named in SQL (the balance projection during
  dual-write, design §4.4) and as a string model label on the ``owner``
  foreign key.
* Its migration depends on ``g12f`` only (the creator table it references).

The import scanner is the one from ``dj.apps.identity.tests.test_app_shape``
in shape: it resolves relative imports, treats ``from dj.apps import x`` as
a crossing into ``dj.apps.x``, and flags ``importlib.import_module`` /
``__import__`` calls naming a ``dj.apps`` module. Each form has a negative
control below.
"""
import ast
import importlib
import re
from pathlib import Path

import pytest

import dj.apps.ledger as ledger_pkg

APP_DIR = Path(ledger_pkg.__file__).resolve().parent
PACKAGE = "dj.apps.ledger"

# Exact shared-helper exceptions: epoch preparation for the finance write ABI
# and the immutable scalar used to order the ledger maintenance task. No app
# models or runtime services may cross this boundary.
ALLOWED_CROSS_APP_IMPORTS = {
    ("dj.apps.economy.epoch", "pin_supported_policy"),
    ("dj.apps.economy.epoch", "prepared_writer"),
    ("dj.apps.jobs.priorities", "MAINTENANCE"),
}

# The tables the SQL may name outside its own: exactly one.
FOREIGN_TABLES_THE_SQL_MAY_TOUCH = {"g12f_creator"}

_DYNAMIC_IMPORTERS = {"import_module", "__import__"}


def _is_foreign(module: str) -> bool:
    return (
        (module == "dj.apps" or module.startswith("dj.apps."))
        and module != PACKAGE
        and not module.startswith(PACKAGE + ".")
    )


def _resolve(module, level, package):
    if not level:
        return module or ""
    parts = package.split(".")
    if level > 1:
        parts = parts[: len(parts) - (level - 1)]
    base = ".".join(parts)
    return f"{base}.{module}" if module else base


def cross_app_imports(source: str, package: str) -> set:
    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            module = _resolve(node.module, node.level, package)
            for alias in node.names:
                if module == "dj.apps":
                    target = f"dj.apps.{alias.name}"
                    if _is_foreign(target):
                        found.add((target, None))
                elif _is_foreign(module):
                    found.add((module, alias.name))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if _is_foreign(alias.name):
                    found.add((alias.name, None))
        elif isinstance(node, ast.Call):
            func = node.func
            name = getattr(func, "attr", None) or getattr(func, "id", None)
            if name not in _DYNAMIC_IMPORTERS or not node.args:
                continue
            arg = node.args[0]
            if not (isinstance(arg, ast.Constant) and isinstance(arg.value, str)):
                found.add(("<dynamic import>", None))
                continue
            module = arg.value
            if module.startswith("."):
                level = len(module) - len(module.lstrip("."))
                module = _resolve(module.lstrip(".") or None, level, package)
            if _is_foreign(module):
                found.add((module, None))
    return found


def _runtime_modules():
    return [
        path for path in APP_DIR.rglob("*.py")
        if "tests" not in path.relative_to(APP_DIR).parts
    ]


def _package_of(path: Path) -> str:
    rel = path.relative_to(APP_DIR).with_suffix("")
    return ".".join([PACKAGE, *rel.parts[:-1]])


def test_runtime_code_reaches_no_other_app():
    crossings = set()
    for path in _runtime_modules():
        crossings |= cross_app_imports(path.read_text(), _package_of(path))
    assert crossings == ALLOWED_CROSS_APP_IMPORTS


def test_the_app_does_not_read_other_apps_models_through_the_registry():
    """``apps.get_model("g12f",...)`` would be a crossing the import scanner
    cannot see; the ledger has no reason to load another app's model."""
    for path in _runtime_modules():
        source = path.read_text()
        for match in re.finditer(r"get_model\(\s*[\"']([\w.]+)[\"']", source):
            label = match.group(1)
            assert label.startswith("ledger"), f"{path.name}: get_model({label!r})"


def test_the_migration_depends_only_on_the_creator_table():
    migration = importlib.import_module(f"{PACKAGE}.migrations.0001_initial")
    assert migration.Migration.dependencies == [("g12f", "0114_creator_public_id")]


def test_the_sql_names_no_foreign_table_but_the_creator():
    migration = importlib.import_module(f"{PACKAGE}.migrations.0001_initial")
    named = set(re.findall(r"\bpublic\.(\w+)", migration.FUNCTIONS_SQL))
    foreign = {t for t in named if not t.startswith("ledger_")}
    assert foreign == FOREIGN_TABLES_THE_SQL_MAY_TOUCH, foreign


def test_the_owner_foreign_key_is_declared_by_label_not_by_import():
    source = (APP_DIR / "models.py").read_text()
    tree = ast.parse(source)
    fk_targets = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "ForeignKey":
            first = node.args[0] if node.args else next(
                (kw.value for kw in node.keywords if kw.arg == "to"), None)
            fk_targets.append(first)
    assert fk_targets, "models.py declares the owner foreign key"
    for target in fk_targets:
        if isinstance(target, ast.Constant):
            assert isinstance(target.value, str)
        else:
            # A model of this app, by name.
            assert isinstance(target, ast.Name) and target.id in {"Account"}, ast.dump(target)


@pytest.mark.parametrize("source", [
    "import dj.apps.g12f.models",
    "from dj.apps.g12f.models import Creator",
    "from dj.apps import tuzis",
    "from ..tuzis import ledger",
    "from .. import g12f",
    "from dj.apps.jobs.tasks import reclaim_stalled_jobs_task",
    "import importlib\nimportlib.import_module('dj.apps.tuzis.ledger')",
    "__import__('dj.apps.g12f')",
    "import importlib\nname = 'dj.apps.' + 'g12f'\nimportlib.import_module(name)",
])
def test_the_scanner_catches_each_import_form(source):
    assert cross_app_imports(source, PACKAGE), source


@pytest.mark.parametrize("source", [
    "from . import api",
    "from .system_accounts import SYSTEM_ACCOUNTS",
    "import dj.apps.ledger.api",
    "from dj.apps import ledger",
    "from django.db import connection",
])
def test_the_scanner_allows_imports_within_the_app(source):
    assert cross_app_imports(source, PACKAGE) == set(), source


def test_only_the_named_maintenance_scalar_is_an_allowed_jobs_import():
    shared_constant = (
        "from dj.apps.jobs.priorities import MAINTENANCE"
    )
    runtime_service = (
        "from dj.apps.jobs.tasks import reclaim_stalled_jobs_task"
    )
    assert cross_app_imports(shared_constant, PACKAGE) == {
        ("dj.apps.jobs.priorities", "MAINTENANCE"),
    }
    assert cross_app_imports(runtime_service, PACKAGE) == {
        ("dj.apps.jobs.tasks", "reclaim_stalled_jobs_task"),
    }
    assert cross_app_imports(runtime_service, PACKAGE) != ALLOWED_CROSS_APP_IMPORTS
