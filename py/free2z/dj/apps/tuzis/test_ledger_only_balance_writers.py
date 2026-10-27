"""Only ``dj.apps.tuzis.ledger`` may write ``Creator.tuzis``.

Why this guard exists
---------------------
The double-entry ledger (epic, Pillar 2) dual-writes a journal row for
every balance mutation from inside the ledger primitives -- ``debit``,
``credit``, ``transfer``, ``debit_up_to`` (and the reservation helpers). A
writer that moves a balance with its own ``UPDATE... SET tuzis =...``
silently opts out of that journal, and the reconciliation drift it causes is
only visible after the fact. So every balance write must go through the
ledger, and this test is what keeps the next one from being added quietly.

What it checks
--------------
Every non-test ``.py`` file under ``py/`` and the repo's ``zcash/`` tooling
(migrations included -- a data migration that moves a balance is exactly the
kind of write that must not slip by) is parsed, and every syntactic shape that
can write a ``tuzis`` column is collected. Django's async twins (``aupdate``,
``acreate``, ``asave``, ``abulk_update``,...) are normalised to the sync name:

* ``<qs>.update(tuzis=...)`` / ``.update(**{"tuzis":...})``
* ``SomeClass(tuzis=...)`` -- a model constructor, e.g. inside
  ``bulk_create([Creator(tuzis=100)])``, which bypasses ``Creator.save()``
* ``<qs>.create(tuzis=...)``, ``create_user(..., tuzis=...)``,
  ``create_superuser(..., tuzis=...)``, ``serializer.save(tuzis=...)``
* ``get_or_create``/``update_or_create`` with ``tuzis`` in the kwargs or in
  ``defaults``/``create_defaults``
* ``update_fields=[..."tuzis"...]`` (``save``, the ``bulk_create`` upsert),
  positional ``save(False, False, None, ["tuzis"])``,
  ``bulk_update(objs, [..."tuzis"...])``
* ``obj.tuzis =...``, ``obj.tuzis +=...``, ``setattr(obj, "tuzis",...)``
* a raw SQL string literal ``SET... tuzis =`` or ``INSERT INTO t (... tuzis
  ...)``, quoted identifiers included

The name ``tuzis`` is not unique to the balance: ``Comment.tuzis`` is a
comment's vote score and ``CheckoutIntent.tuzis`` is a purchase quantity. A
site is therefore allowed only when BOTH hold:

1. ``(file, receiver, kind)`` is listed in ``NON_BALANCE_TUZIS_WRITERS`` with
   a reason, where ``receiver`` is the root name of the call chain
   (``Comment`` in ``Comment.objects.filter(...).update(...)``) and ``kind`` is
   the write (``update``, ``create``, ``constructor``); and
2. the site is DIRECT: ``<Receiver>.objects`` followed only by same-model
   queryset calls (``filter``, ``select_for_update``,...), or a bare
   ``Receiver(...)`` constructor. An attribute hop to another model
   (``Comment.objects.get(pk=1).author.save(update_fields=["tuzis"])``,
   ``comment.author.tuzis += 5``) is never covered; and
3. that name, resolved through the file's own imports, is a real model that has
   a ``tuzis`` field and is NOT ``Creator`` (nor a subclass or a model sharing
   its table). An ``import Creator as Comment`` cannot launder a balance write.

Three already-applied 2022-2025 data migrations predate the ledger and are
listed by exact path in ``HISTORICAL_MIGRATION_BALANCE_WRITERS``; a new
migration that moves a balance is not on that list and fails.

The double-entry ledger's SQL functions (``dj/apps/ledger/migrations/``) are
THE legitimate writer since the dual-write release: ``ledger.post_transfer``
projects every maintained ``user`` balance change onto ``Creator.tuzis`` in
the same statement (docs/tuzis/ledger-v2.md §4.4, the dual-write that R2
reconciles). That ``UPDATE g12f_creator SET tuzis`` lives inside a function
body in a migration file, so it is a string constant here and the SQL
scanner sees it. ``LEDGER_DUAL_WRITE_SQL`` lists those migration files by
exact path -- a positive control asserts each really contains the
projection, so the entry cannot go inert -- and nothing else under
``dj/apps/ledger/`` is exempt. ``dj/apps/tuzis/ledger.py`` (the wrappers the
product calls) is scanned like any other file: it writes the column through
the SQL functions and never itself.

The wrappers' ``credit`` also has a required shape (design §10 step 2):
``credit(creator, amount, *, source, ref_kind, ref_id, idem)``, all four
keywords, because a credit with no source account, no receipt and no key
cannot be attributed (R11) or replayed. ``test_every_credit_call_passes_the_
four_keywords`` fails on a bare ``ledger.credit(user, amount)`` anywhere in
the tree, and ``CREDIT_CALL_SITES`` pins the six callers §10.1 names -- a
seventh has to be added there, on purpose.

The allowlist is also checked for staleness: an entry that no longer matches a
site fails, because an inert exemption reads as live to whoever adds the next
one beside it.

What it does NOT catch
----------------------
* A column name the parser cannot see as a literal: kwargs built at runtime
  (``.update(**payload)``), an ``update_fields`` list held in a variable,
  ``setattr`` with a computed name, SQL built by concatenation or ``%``
  formatting of the column name.
* ``tuzis=`` passed to an arbitrary lowercase function that is not one of the
  write methods above (a local helper that forwards ``**kwargs`` to
  ``.update``) -- the forwarding ``.update(**kwargs)`` is itself dynamic.
* Writers outside Python: SQL in shell scripts (``bin/``, ``zcash/*.sh``) or
  run by hand in ``psql``.

Those are defended by the model, not by this test:
``Creator.save()`` never writes ``tuzis`` on a full save (see
``LEDGER_ONLY_FIELDS``) and ``CHECK (tuzis >= 0)`` refuses an overdraft
(g12f/0086). This test covers the honest-mistake path, which is the one that
actually recurs.
"""
from __future__ import annotations

import ast
import importlib
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

PY_ROOT = Path(__file__).resolve().parents[3]
LEDGER = Path("dj/apps/tuzis/ledger.py")
FIELD = "tuzis"

#``ledger.credit``'s required keywords (design §10 step 2).
REQUIRED_CREDIT_KEYWORDS = frozenset({"source", "ref_kind", "ref_id", "idem"})

#Every file that calls ``ledger.credit`` -- the six sites of design §10.1.
#A new caller is a decision: add it here with its (source, ref_kind).
CREDIT_CALL_SITES: dict[str, tuple[str, str]] = {
    "dj/apps/ztripe/fulfillment.py": ("sys:clearing_stripe", "stripe_transaction"),
    "dj/apps/tuzis/zec.py": ("sys:clearing_zec", "zec_receipt"),
    # grant_tuzis and the sign-up welcome grant  both credit here.
    "dj/apps/tuzis/grants.py": ("sys:promo", "tuzi_grant"),
    "dj/apps/g12f/translation/charges.py": ("sys:platform_revenue", "translation"),
    "dj/apps/dyte/views.py": ("sys:platform_revenue", "ppv"),
    "dj/apps/comments/management/commands/aiscore_comments.py": ("sys:promo", "comment_score"),
}

# (path relative to py/, receiver root name, write kind) -> why this is not a
# balance write. Each receiver must resolve (through that file's imports) to a
# model that has a ``tuzis`` field and is not Creator; see
# test_allowlisted_receivers_are_not_the_balance. An entry also only covers a
# DIRECT site: ``Comment.objects[.<queryset method>(...)]*.update(...)`` or a
# bare ``CardQuote(...)`` call. An attribute hop off the root
# (``Comment.objects.get(pk=1).author.save(update_fields=["tuzis"])``) or a
# different kind of write on the same root is not covered and fails.
NON_BALANCE_TUZIS_WRITERS: dict[tuple[str, str, str], str] = {
    ("dj/apps/comments/views.py", "Comment", "update"): (
        "vote_comment moves the comment's vote SCORE (Comment.tuzis, an "
        "IntegerField that goes negative on a downvote). The voter's 2Z is "
        "debited by ledger.debit() in the same transaction."
    ),
    ("dj/apps/comments/management/commands/aiscore_comments.py", "Comment",
     "update"): (
        "aiscore adds the AI score to the comment's SCORE (Comment.tuzis). The "
        "author's balance moves through ledger.credit()/ledger.debit_up_to() "
        "in the same transaction."
    ),
    ("dj/apps/pricing/constants.py", "CardQuote", "constructor"): (
        "CardQuote is a frozen pricing value object; its tuzis is the QUANTITY "
        "a card checkout would buy. It is not a model and writes no row."
    ),
    ("dj/apps/ztripe/views.py", "CheckoutIntent", "create"): (
        "creating a Stripe checkout intent records the QUANTITY of 2Z being "
        "bought (CheckoutIntent.tuzis, a PositiveIntegerField). Nothing is "
        "credited until fulfillment, which goes through ledger.credit()."
    ),
    ("dj/apps/purchases/views.py", "CheckoutIntent", "create"): (
        "the SDK purchase intent (#2239) opens the same Stripe checkout "
        "intent: CheckoutIntent.tuzis is the QUANTITY being bought. The "
        "credit is the same ztripe fulfilment's ledger.credit()."
    ),
}

# Applied, shipped data migrations that predate the ledger. They run against
# historical models (``apps.get_model``), which the ledger -- written against
# the live ``Creator`` -- cannot take, and editing an applied migration changes
# nothing in any database that has already run it. Exact paths: a NEW migration
# that moves a balance is not on this list and fails the guard.
HISTORICAL_MIGRATION_BALANCE_WRITERS: dict[str, str] = {
    "dj/apps/g12f/migrations/0049_auto_20221112_2253.py": (
        "2022 one-time initial 2Z grant when the column was introduced."
    ),
    "dj/apps/g12f/migrations/0054_auto_20221118_0547.py": (
        "2022 one-time +50 early-adopter grant."
    ),
    "dj/apps/g12f/migrations/0085_subscription_last_charged_at_and_more.py": (
        "#620: clamps negative balances to 0 so CHECK (tuzis >= 0) can be added."
    ),
}

# The ledger's SQL functions, by migration file (L1). Every entry must
# contain the §4.4 projection (`UPDATE public.g12f_creator SET tuzis`) inside
# a `ledger.post_transfer` body -- see test_ledger_dual_write_entries_are_live.
LEDGER_DUAL_WRITE_SQL: dict[str, str] = {
    "dj/apps/ledger/migrations/0001_initial.py": (
        "L1: ledger.post_transfer's dual-write projection keeps Creator.tuzis "
        "equal to balance/1000 for every maintained user account while "
        "ledger_config.dual_write is on (design §4.4); R2 reconciles it."
    ),
}

# save: serializer.save(tuzis=); create_user/create_superuser: a new row, so
# the INSERT writes the column even though Creator.save() excludes it on an
# update (reviewer finding on ).
_WRITE_METHODS_KWARG = {
    "update", "create", "save", "create_user", "create_superuser"}
_WRITE_METHODS_DEFAULTS = {"get_or_create", "update_or_create"}
_KNOWN_WRITE_METHODS = (
    _WRITE_METHODS_KWARG | _WRITE_METHODS_DEFAULTS
    | {"bulk_update", "bulk_create"})
# Queryset methods that return a queryset of the SAME model. Only these may sit
# between ``<Model>.objects`` and the write for an allowlist entry to apply.
_SAME_MODEL_QS_METHODS = {
    "all", "filter", "exclude", "select_related", "prefetch_related",
    "select_for_update", "using", "order_by", "annotate", "alias", "only",
    "defer", "distinct", "none",
}


def _normalize_method(name):
    """Django's async twins: ``aupdate`` -> ``update``, ``asave`` -> ``save``."""
    if name and name.startswith("a") and name[1:] in _KNOWN_WRITE_METHODS:
        return name[1:]
    return name


def _is_direct_manager_chain(node) -> bool:
    """``Model.objects`` followed only by same-model queryset calls."""
    while (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
           and node.func.attr in _SAME_MODEL_QS_METHODS):
        node = node.func.value
    return (isinstance(node, ast.Attribute)
            and node.attr in {"objects", "_default_manager"}
            and isinstance(node.value, ast.Name))
# ``tuzis`` may be quoted as an identifier ("tuzis", `tuzis`) -- Postgres
# accepts ``SET "tuzis" =...`` just as well (codex review).
_SQL_SET_RE = re.compile(
    r"\bset\b[^;]*?\btuzis\b[\"`]?\s*="
    # INSERT INTO t (..., tuzis,...) mints a balance just as well.
    r"|\binsert\s+into\b[^;(]*\([^)]*\btuzis\b",
    re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True)
class Site:
    path: str
    line: int
    shape: str
    receiver: str | None
    kind: str = "other"
    direct: bool = False

    @property
    def key(self):
        return (self.path, self.receiver, self.kind)

    def __str__(self):
        return (f"{self.path}:{self.line}: {self.shape} "
                f"(receiver={self.receiver}, kind={self.kind}, "
                f"direct={self.direct})")


def is_test_file(rel: Path) -> bool:
    name = rel.name
    return (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name in {"tests.py", "conftest.py"}
        or "tests" in rel.parts
    )


def _root_name(node) -> str | None:
    """Root identifier of an attribute/call/subscript chain, e.g.
    ``Comment.objects.filter(pk=1)`` -> ``Comment``; ``_creator_qs(c)`` ->
    ``_creator_qs``; ``self.model.objects`` -> ``self``."""
    while True:
        if isinstance(node, ast.Attribute):
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        elif isinstance(node, ast.Subscript):
            node = node.value
        elif isinstance(node, ast.Name):
            return node.id
        else:
            return None


def _str_consts(node) -> list[str]:
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [
            e.value for e in node.elts
            if isinstance(e, ast.Constant) and isinstance(e.value, str)
        ]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    return []


def _dict_has_field(node) -> bool:
    return isinstance(node, ast.Dict) and any(
        isinstance(k, ast.Constant) and k.value == FIELD for k in node.keys
    )


def _kwargs_write_field(call: ast.Call) -> bool:
    for kw in call.keywords:
        if kw.arg == FIELD:
            return True
        if kw.arg is None and _dict_has_field(kw.value):  # **{"tuzis":...}
            return True
    return False


def _docstring_nodes(tree) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            body = node.body
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                ids.add(id(body[0].value))
    return ids


def find_balance_writes(source: str, path: str) -> list[Site]:
    tree = ast.parse(source, filename=path)
    docstrings = _docstring_nodes(tree)
    sites: list[Site] = []

    def add(node, shape, receiver, kind, direct=False):
        sites.append(Site(path, node.lineno, shape, receiver, kind, direct))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            raw_method = func.attr if isinstance(func, ast.Attribute) else None
            method = _normalize_method(raw_method)
            receiver = _root_name(func.value) if raw_method else None
            direct = raw_method is not None and _is_direct_manager_chain(func.value)
            ctor = (func.id if isinstance(func, ast.Name) else raw_method)
            if (ctor and ctor[:1].isupper() and _kwargs_write_field(node)):
                add(node, f"{ctor}({FIELD}=...)", ctor, "constructor",
                    direct=isinstance(func, ast.Name))
            elif method in _WRITE_METHODS_KWARG and _kwargs_write_field(node):
                add(node, f".{raw_method}({FIELD}=...)", receiver, method, direct)
            elif method in _WRITE_METHODS_DEFAULTS and (
                _kwargs_write_field(node) or any(
                    kw.arg in {"defaults", "create_defaults"}
                    and _dict_has_field(kw.value) for kw in node.keywords
                )
            ):
                add(node, f".{raw_method}(... {FIELD} ...)", receiver, method,
                    direct)
            elif any(kw.arg == "update_fields" and FIELD in _str_consts(kw.value)
                     for kw in node.keywords):
                # save(update_fields=...) and the bulk_create upsert
                # bulk_create(..., update_conflicts=True, update_fields=...).
                add(node, f".{raw_method}(update_fields=[{FIELD!r}])", receiver,
                    "update_fields")
            elif method == "save" and any(FIELD in _str_consts(a) for a in node.args):
                # save(False, False, None, ["tuzis"]) -- positional form,
                # still legal until Django 6.0 (codex review).
                add(node, f".{raw_method}(..., [{FIELD!r}])", receiver,
                    "update_fields")
            elif method == "bulk_update" and (
                any(FIELD in _str_consts(a) for a in node.args[1:2])
                or any(kw.arg == "fields" and FIELD in _str_consts(kw.value)
                       for kw in node.keywords)
            ):
                add(node, f".{raw_method}(..., [{FIELD!r}])", receiver,
                    "bulk_update")
            elif (isinstance(func, ast.Name) and func.id == "setattr"
                  and len(node.args) >= 2
                  and _str_consts(node.args[1]) == [FIELD]):
                add(node, f"setattr(..., {FIELD!r}, ...)",
                    _root_name(node.args[0]), "setattr")
        elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                elts = target.elts if isinstance(target, (ast.Tuple, ast.List)) else [target]
                for t in elts:
                    if isinstance(t, ast.Attribute) and t.attr == FIELD:
                        add(node, f"<obj>.{FIELD} assignment",
                            _root_name(t.value), "assign")
        elif (isinstance(node, ast.Constant) and isinstance(node.value, str)
              and id(node) not in docstrings
              and _SQL_SET_RE.search(node.value)):
            add(node, "raw SQL SET tuzis", None, "sql")
    return sites


def _module_bindings(tree, rel: str) -> dict[str, tuple[str, str]]:
    """name -> (module, attribute) for every ``from x import y [as z]``,
    resolving relative imports against ``rel`` (a path relative to py/)."""
    package = list(Path(rel).with_suffix("").parts[:-1])
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if node.level:
            base = package[: len(package) - (node.level - 1)]
            module = ".".join(base + ([node.module] if node.module else []))
        else:
            module = node.module
        for alias in node.names:
            out[alias.asname or alias.name] = (module, alias.name)
    return out


# Python outside py/ that talks to the prod database: the zcash/ tooling runs
# on the payment host next to the credit loop. Keyed as "zcash/..." (repo-relative).
EXTRA_ROOTS = ("zcash",)


def _iter_root(root: Path, prefix: Path):
    for path in sorted(root.rglob("*.py")):
        rel = prefix / path.relative_to(root)
        if any(part.startswith(".") or part in {"node_modules", "__pycache__"}
               or part.startswith("venv") for part in rel.parts):
            continue
        if is_test_file(rel):
            continue
        yield rel, path


def iter_source_files():
    yield from _iter_root(PY_ROOT, Path())
    for extra in EXTRA_ROOTS:
        root = PY_ROOT.parent / extra
        if root.is_dir():
            yield from _iter_root(root, Path(extra))


def scan_tree() -> list[Site]:
    sites = []
    for rel, path in iter_source_files():
        sites.extend(find_balance_writes(path.read_text(), str(rel)))
    return sites


def violations(sites, allowlist=None) -> list[Site]:
    allowlist = NON_BALANCE_TUZIS_WRITERS if allowlist is None else allowlist
    return [
        s for s in sites
        if not (s.key in allowlist and s.direct)
        and s.path not in HISTORICAL_MIGRATION_BALANCE_WRITERS
        and not (s.path in LEDGER_DUAL_WRITE_SQL and s.kind == "sql")
    ]


def resolve_receiver(source: str, receiver: str, rel: str):
    """Resolve ``receiver`` to the object the file's imports bind it to."""
    bindings = _module_bindings(ast.parse(source), rel)
    if receiver not in bindings:
        # Defined in the file itself (e.g. a dataclass next to its factory).
        own = ".".join(Path(rel).with_suffix("").parts)
        return getattr(importlib.import_module(own), receiver, None)
    module, attr = bindings[receiver]
    return getattr(importlib.import_module(module), attr, None)


def assert_not_balance_model(model) -> None:
    from django.db import models as dj_models
    from dj.apps.g12f.models import Creator

    assert isinstance(model, type), model
    assert not issubclass(model, Creator), f"{model} IS the balance model"
    if issubclass(model, dj_models.Model):
        assert model._meta.db_table != Creator._meta.db_table, model
        assert model._meta.concrete_model is not Creator, model
        model._meta.get_field(FIELD)  # raises FieldDoesNotExist if absent
    else:
        # A plain value object must still genuinely carry the attribute.
        assert FIELD in getattr(model, "__annotations__", {}), model


# --------------------------------------------------------------------------
# The guard itself
# --------------------------------------------------------------------------


def test_no_raw_balance_writes_outside_ledger():
    bad = violations(scan_tree())
    assert not bad, (
        "Creator.tuzis is written only through dj.apps.tuzis.ledger "
        "(debit / credit / transfer / debit_up_to). Route these through it, or "
        "-- only if the column is NOT the balance -- add a justified entry to "
        "NON_BALANCE_TUZIS_WRITERS:\n  " + "\n  ".join(map(str, bad))
    )


def test_allowlist_has_no_stale_entries():
    sites = scan_tree()
    matched = {s.key for s in sites if s.direct}
    stale = sorted(set(NON_BALANCE_TUZIS_WRITERS) - matched)
    assert not stale, f"allowlist entries matching nothing: {stale}"
    matched_paths = {s.path for s in sites}
    stale_migrations = sorted(
        set(HISTORICAL_MIGRATION_BALANCE_WRITERS) - matched_paths)
    assert not stale_migrations, stale_migrations


@pytest.mark.parametrize("entry", sorted(NON_BALANCE_TUZIS_WRITERS))
def test_allowlisted_receivers_are_not_the_balance(entry):
    rel, receiver, _kind = entry
    assert len(NON_BALANCE_TUZIS_WRITERS[entry]) >= 40, "write a real reason"
    source = (PY_ROOT / rel).read_text()
    model = resolve_receiver(source, receiver, rel)
    assert model is not None, f"{rel}: cannot resolve {receiver!r} via imports"
    assert_not_balance_model(model)


def test_the_wrapper_module_writes_no_balance_itself():
    """``tuzis/ledger.py`` moves the column only through the
    ledger's SQL functions (``post_transfer``'s projection). It used to be
    the one file excluded from the scan; now it is scanned like any other,
    and a raw write reappearing in it is a violation, not a primitive."""
    source = (PY_ROOT / LEDGER).read_text()
    assert find_balance_writes(source, str(LEDGER)) == []
    assert "_ledger.spend(" in source, "the wrapper no longer calls the ledger?"


def test_scan_covers_the_tree():
    files = {str(rel) for rel, _ in iter_source_files()}
    assert "dj/apps/comments/views.py" in files
    assert "dj/apps/tuzis/zec.py" in files
    assert "dj/apps/g12f/management/commands/credit_creators.py" in files
    assert "zcashrpc/nodewatch.py" in files
    assert str(LEDGER) in files
    assert not any(Path(f).name.startswith("test_") for f in files)


# --------------------------------------------------------------------------
# ledger.credit(...) must carry source / ref_kind / ref_id / idem
# --------------------------------------------------------------------------


def _credit_bindings(tree, rel: str) -> set[str]:
    """Local names bound to the wrapper's ``credit`` by a ``from... import``."""
    names = set()
    for name, (module, attr) in _module_bindings(tree, rel).items():
        if module == "dj.apps.tuzis.ledger" and attr == "credit":
            names.add(name)
    return names


def find_credit_calls(source: str, path: str) -> list[tuple[Site, frozenset]]:
    """Every call of the wrapper's ``credit`` with the keyword names it
    passes. A ``**kwargs`` splat is recorded as no keywords at all: the
    guard cannot see through it, so it does not count."""
    tree = ast.parse(source, filename=path)
    direct = _credit_bindings(tree, path)
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_credit = (
            (isinstance(func, ast.Attribute) and func.attr == "credit"
             and _root_name(func.value) == "ledger")
            or (isinstance(func, ast.Name) and func.id in direct)
        )
        if not is_credit:
            continue
        keywords = frozenset(kw.arg for kw in node.keywords if kw.arg is not None)
        found.append((Site(path, node.lineno, "ledger.credit(...)", "ledger", "credit"), keywords))
    return found


def bare_credit_calls(source: str, path: str) -> list[Site]:
    return [
        site for site, keywords in find_credit_calls(source, path)
        if not REQUIRED_CREDIT_KEYWORDS <= keywords
    ]


def test_every_credit_call_passes_the_four_keywords():
    bad = []
    for rel, path in iter_source_files():
        if rel == LEDGER:
            continue
        bad.extend(bare_credit_calls(path.read_text(), str(rel)))
    assert not bad, (
        "ledger.credit(creator, amount, *, source, ref_kind, ref_id, idem): all "
        "four keywords are required (design §10 step 2) -- a credit with no "
        "source account, no receipt reference and no idempotency key cannot be "
        "attributed or replayed:\n  " + "\n  ".join(map(str, bad))
    )


def test_the_credit_call_sites_are_exactly_the_six_of_the_design():
    """§10.1 names six callers. A seventh is a decision, recorded in
    CREDIT_CALL_SITES with its source account and ref_kind; a stale entry is
    a caller that quietly vanished."""
    from dj.apps.tuzis.ledger import CREDIT_CODES

    found = {}
    for rel, path in iter_source_files():
        if rel == LEDGER:
            continue
        calls = find_credit_calls(path.read_text(), str(rel))
        if calls:
            found[str(rel)] = calls
    assert set(found) == set(CREDIT_CALL_SITES), (
        f"credit callers changed: found {sorted(found)}, pinned {sorted(CREDIT_CALL_SITES)}"
    )
    for rel, (source, ref_kind) in CREDIT_CALL_SITES.items():
        text = (PY_ROOT / rel).read_text()
        assert f'"{source}"' in text or f"'{source}'" in text, (rel, source)
        assert f'"{ref_kind}"' in text or f"'{ref_kind}'" in text, (rel, ref_kind)
        assert ref_kind in CREDIT_CODES, (rel, ref_kind)


CREDIT_IMPORTS = "from dj.apps.tuzis import ledger\n"
FULL_CREDIT = (
    "ledger.credit(user, 5, source='sys:promo', ref_kind='tuzi_grant', "
    "ref_id='1', idem='grant:1')\n"
)


@pytest.mark.parametrize("snippet", [
    "ledger.credit(user, 5)\n",
    "ledger.credit(user, 5, source='sys:promo')\n",
    "ledger.credit(user, 5, source='sys:promo', ref_kind='tuzi_grant', ref_id='1')\n",
    "ledger.credit(user, 5, **kw)\n",
    "ledger.credit(user, 5, source='sys:promo', **kw)\n",
    "balance = ledger.credit(request.user, amount)\n",
    "from dj.apps.tuzis.ledger import credit\ncredit(user, 5)\n",
    "from dj.apps.tuzis.ledger import credit as add\nadd(user, 5)\n",
    "import dj.apps.tuzis.ledger as ledger\nledger.credit(user, 5)\n",
])
def test_negative_control_each_bare_credit_shape_is_a_violation(snippet):
    bad = bare_credit_calls(CREDIT_IMPORTS + snippet, "dj/apps/example/views.py")
    assert len(bad) == 1, bad


def test_the_full_credit_shape_passes():
    assert bare_credit_calls(CREDIT_IMPORTS + FULL_CREDIT, "dj/apps/example/views.py") == []
    calls = find_credit_calls(CREDIT_IMPORTS + FULL_CREDIT, "dj/apps/example/views.py")
    assert len(calls) == 1 and calls[0][1] == REQUIRED_CREDIT_KEYWORDS


def test_negative_control_real_site_stripped_of_a_keyword_fails():
    """Mutate a real caller: drop `idem=` from the Stripe fulfilment credit."""
    rel = "dj/apps/ztripe/fulfillment.py"
    source = (PY_ROOT / rel).read_text()
    mutated, n = re.subn(r"\n\s*idem=f'stripe:\{payment_intent\}',", "", source)
    assert n == 1, "fixture drifted; update the pattern"
    assert bare_credit_calls(source, rel) == []
    assert [s.line for s in bare_credit_calls(mutated, rel)], "the stripped call was not caught"


def test_credit_refuses_a_bare_call_at_runtime():
    """The guard is static; the signature is the runtime half (§10 step 2)."""
    from dj.apps.tuzis import ledger as wrapper

    with pytest.raises(TypeError):
        wrapper.credit(object(), 5)


# --------------------------------------------------------------------------
# Negative controls: each shape a future writer could plausibly use is caught
# --------------------------------------------------------------------------

IMPORTS = (
    "from django.db.models import F\n"
    "from dj.apps.g12f.models import Creator\n"
)


@pytest.mark.parametrize("snippet", [
    "Creator.objects.filter(pk=1).update(tuzis=F('tuzis') + 5)\n",
    "Creator.objects.filter(pk=1).update(**{'tuzis': F('tuzis') - 1})\n",
    "Creator.objects.create(username='x', tuzis=100)\n",
    "Creator.objects.bulk_create([Creator(username='bonus', tuzis=100)])\n",
    "u = models.Creator(username='bonus', tuzis=100)\n",
    "Creator.objects.get_or_create(username='x', defaults={'tuzis': 100})\n",
    "Creator.objects.update_or_create(pk=1, defaults={'tuzis': 1})\n",
    "user.tuzis += 5\n",
    "user.tuzis = 5\n",
    "user.save(update_fields=['tuzis', 'updated_at'])\n",
    "user.save(update_fields=('tuzis',))\n",
    "user.save(False, False, None, ['tuzis'])\n",
    "serializer.save(tuzis=100)\n",
    "Creator.objects.bulk_create(objs, update_conflicts=True, unique_fields=['id'], update_fields=['tuzis'])\n",
    "cursor.execute('INSERT INTO g12f_creator (username, \"tuzis\") VALUES (%s, 100)')\n",
    "Creator.objects.bulk_update(users, ['tuzis'])\n",
    "Creator.objects.bulk_update(users, fields=['tuzis'])\n",
    "setattr(user, 'tuzis', 5)\n",
    "cursor.execute('UPDATE g12f_creator SET tuzis = tuzis + %s WHERE id = %s')\n",
    "cursor.execute('''update g12f_creator\n  set is_active = true,\n      tuzis = 0''')\n",
    "cursor.execute('UPDATE g12f_creator SET \"tuzis\" = \"tuzis\" + 5 WHERE id = 1')\n",
    "cursor.execute('UPDATE g12f_creator c SET c.`tuzis`=0')\n",
    "cursor.execute(f'UPDATE {table} SET tuzis = tuzis + {n}')\n",
    # a mint: no pk, so the INSERT writes the column (reviewer, )
    "Creator.objects.create_user('x', tuzis=100)\n",
    "Creator.objects.create_superuser('x', 'x@example.com', 'pw', tuzis=100)\n",
    # async twins (reviewer, )
    "Creator.objects.filter(pk=1).aupdate(tuzis=F('tuzis') + 5)\n",
    "Creator.objects.acreate(username='x', tuzis=100)\n",
    "Creator.objects.aget_or_create(username='x', defaults={'tuzis': 1})\n",
    "Creator.objects.aupdate_or_create(pk=1, defaults={'tuzis': 1})\n",
    "Creator.objects.abulk_update(users, ['tuzis'])\n",
    "user.asave(False, False, None, ['tuzis'])\n",
    "user.asave(update_fields=['tuzis'])\n",
])
def test_negative_control_each_shape_is_a_violation(snippet):
    sites = find_balance_writes(IMPORTS + snippet, "dj/apps/example/views.py")
    assert len(sites) == 1, sites
    assert violations(sites), sites


@pytest.mark.parametrize("snippet", [
    # reads are not writes
    "Creator.objects.filter(tuzis__gte=1).annotate(t=F('tuzis'))\n",
    "x = user.tuzis\n",
    "user.refresh_from_db(fields=['tuzis'])\n",
    "Creator.objects.values_list('tuzis', flat=True)\n",
    # a docstring describing the ledger's SQL is not SQL
    "def f():\n    '''UPDATE creator SET tuzis = tuzis - amt'''\n",
    # a different column that merely contains the word
    "Receipt.objects.create(tuzis_credited=5)\n",
    "cursor.execute('INSERT INTO tuzis_zeccreditreceipt (tuzis_credited) VALUES (1)')\n",
    "user.save(update_fields=['strikes'])\n",
])
def test_reads_and_lookalikes_are_not_flagged(snippet):
    assert find_balance_writes(IMPORTS + snippet, "x.py") == []


@pytest.mark.parametrize("snippet", [
    # attribute hop off an allowlisted root to the author's balance
    "Comment.objects.get(pk=1).author.save(update_fields=['tuzis'])\n",
    "Comment.objects.get(pk=1).author.tuzis += 5\n",
    "comment.author.tuzis = 0\n",
    "Comment.objects.get(pk=1).author.__class__.objects.filter(pk=1)"
    ".update(tuzis=5)\n",
    # same root, a different kind of write than the entry covers
    "Comment.objects.create(author=a, tuzis=5)\n",
    "Comment.objects.bulk_update(cs, ['tuzis'])\n",
    "setattr(Comment.objects.get(pk=1).author, 'tuzis', 5)\n",
    # a non-queryset call between the manager and the write
    "Comment.objects.get(pk=1).get_author_qs().update(tuzis=5)\n",
])
def test_negative_control_allowlisted_file_cannot_launder(snippet):
    """In a file that IS allowlisted for ``Comment`` score updates, anything
    other than a direct ``Comment.objects...update(...)`` still fails."""
    rel = "dj/apps/comments/views.py"
    source = "from .models import Comment\n" + snippet
    sites = find_balance_writes(source, rel)
    assert len(sites) == 1, sites
    assert violations(sites), sites


def test_allowlisted_direct_shape_still_passes():
    """Control for the control above: the exact allowlisted shape passes."""
    rel = "dj/apps/comments/views.py"
    source = (
        "from .models import Comment\n"
        "Comment.objects.select_for_update().filter(pk=1)"
        ".update(tuzis=F('tuzis') + 1)\n"
    )
    sites = find_balance_writes(source, rel)
    assert len(sites) == 1 and sites[0].direct, sites
    assert violations(sites) == []


def test_negative_control_zcash_tooling_is_scanned():
    source = "cursor.execute('UPDATE g12f_creator SET tuzis = tuzis + 1')\n"
    rel = "zcash/credit_by_hand.py"
    assert violations(find_balance_writes(source, rel))


def test_negative_control_real_file_retargeted_at_creator():
    """Mutate the real allowlisted file: the same statement against Creator
    must fail even though the file itself is on the allowlist."""
    rel = "dj/apps/comments/views.py"
    source = (PY_ROOT / rel).read_text()
    # Formatting-insensitive: only the receiver name is swapped.
    mutated, n = re.subn(
        r"\bComment(\s*\.\s*objects\s*\.\s*filter\(\s*pk\s*=\s*comment\.pk\s*\)"
        r"\s*\.\s*update\(\s*tuzis\s*=)",
        r"Creator\1",
        source,
    )
    assert n == 1, "fixture drifted; update the pattern"
    assert violations(find_balance_writes(source, rel)) == []
    bad = violations(find_balance_writes(mutated, rel))
    assert [s.receiver for s in bad] == ["Creator"], bad


def test_negative_control_alias_cannot_launder_creator():
    """``import Creator as Comment`` matches the allowlist key syntactically;
    resolution through imports is what refuses it."""
    source = (
        "from django.db.models import F\n"
        "from dj.apps.g12f.models import Creator as Comment\n"
        "Comment.objects.filter(pk=1).update(tuzis=F('tuzis') + 1)\n"
    )
    rel = "dj/apps/comments/views.py"
    sites = find_balance_writes(source, rel)
    assert violations(sites) == []  # the key alone would let it through...
    model = resolve_receiver(source, "Comment", rel)
    with pytest.raises(AssertionError):  #...the model check does not
        assert_not_balance_model(model)


def test_negative_control_real_comment_model_passes():
    from dj.apps.comments.models import Comment

    assert_not_balance_model(Comment)


def test_negative_control_new_migration_balance_write_is_a_violation():
    source = (
        "def forward(apps, schema_editor):\n"
        "    Creator = apps.get_model('g12f', 'Creator')\n"
        "    Creator.objects.filter(tuzis__lt=5).update(tuzis=5)\n"
    )
    rel = "dj/apps/g12f/migrations/0999_topup.py"
    assert [s.receiver for s in violations(find_balance_writes(source, rel))] == [
        "Creator"]


def test_historical_migration_allowlist_is_only_migrations():
    for path in HISTORICAL_MIGRATION_BALANCE_WRITERS:
        assert "/migrations/" in path and (PY_ROOT / path).is_file(), path


def test_ledger_dual_write_entries_are_live():
    """Positive control: each exempted ledger migration really carries the
    projection, as SQL, inside ``ledger.post_transfer`` -- so the exemption
    covers exactly the write the design prescribes and cannot go inert."""
    for path, reason in LEDGER_DUAL_WRITE_SQL.items():
        assert path.startswith("dj/apps/ledger/migrations/") and (PY_ROOT / path).is_file(), path
        assert len(reason) >= 40, "write a real reason"
        source = (PY_ROOT / path).read_text()
        sites = find_balance_writes(source, path)
        assert sites and {s.kind for s in sites} == {"sql"}, sites
        body = source[source.index("FUNCTION ledger.post_transfer("):]
        body = body[: body.index("END $$;")]
        assert body.count("UPDATE public.g12f_creator SET tuzis = tuzis") == 2, "one per maintained side"


def test_ledger_runtime_code_is_not_exempt():
    """Only the migration files are exempt: the ledger's Python (api.py and
    friends) must never write the balance column itself."""
    ledger_sites = [s for s in scan_tree() if s.path.startswith("dj/apps/ledger/")]
    assert {s.path for s in ledger_sites} <= set(LEDGER_DUAL_WRITE_SQL), ledger_sites
    source = "from django.db import connection\n" \
             "connection.cursor().execute('UPDATE g12f_creator SET tuzis = 0')\n"
    assert violations(find_balance_writes(source, "dj/apps/ledger/api.py"))
