"""No new session-scoped Postgres state under ``py/`` (ledger-v2 §12).

Django is going behind PgBouncer in TRANSACTION mode. There, a client owns a
server connection for exactly one transaction; the next transaction -- the
next statement, in autocommit -- may run on a different backend, and the
backend this one used is handed to some other client. So anything a statement
leaves on the SESSION either vanishes before the code that relies on it runs,
or leaks into a stranger's request:

* a session advisory lock (``pg_advisory_lock`` / ``pg_try_advisory_lock`` /
  ``pg_advisory_unlock`` and their ``_shared`` forms, ``pg_advisory_unlock_all``)
  is taken on one backend and "released" on another, so it is never released:
  exactly the sitemap lane this issue converted to ``pg_try_advisory_xact_lock``;
* ``SET name =...`` without ``LOCAL`` (and ``set_config(..., false)``) outlives
  the transaction and is inherited by whoever gets the backend next;
* ``LISTEN`` registers on a backend the client does not keep;
* ``CREATE TEMP TABLE`` survives on the backend and is invisible from the next;
* ``DECLARE... CURSOR`` / ``WITH HOLD`` / a named psycopg cursor, and
  ``PREPARE``, are fetched or executed from a later transaction that may be on
  another backend (``cursor "..." does not exist``). ``QuerySet.iterator()`` is
  covered by ``DISABLE_SERVER_SIDE_CURSORS`` instead, pinned in
  ``test_pgbouncer_settings.py``.

This is a pure static scan -- no database -- over every ``.py`` under ``py/``
except tests, which only ever run against a direct Postgres and legitimately
use session state to simulate a second client. Migrations ARE scanned: they
run through whatever ``DBHOST`` the migrate Job is given.

SQL is found by parsing each module and reading its string literals (f-string
constant parts included), split into statements on ``;``: a statement that
BEGINS with ``SET`` / ``LISTEN`` / ``DECLARE`` / ``PREPARE`` / ``CREATE TEMP``
is the shape we forbid, which keeps ``UPDATE t SET...`` and a function
header's ``SET search_path`` (function-scoped, not session-scoped) out of it.
Advisory-lock calls and ``set_config`` are matched anywhere in the source.

What it cannot see, stated rather than implied: SQL assembled at runtime from
pieces none of which is itself one of these shapes, and SQL that lives in
another repository (procrastinate's own ``LISTEN``, handled by the billing
lane's ``PROCRASTINATE_LISTEN_NOTIFY`` switch).

An occurrence that is genuinely safe goes in ``ALLOWLIST`` with the reason.
``test_the_scanner_flags_every_session_state_shape`` is the negative control:
the same scanner, fed source containing each forbidden shape, must flag every
one -- and must NOT flag the transaction-scoped equivalents -- or a green run
on the real tree proves nothing.
"""

from __future__ import annotations

import ast
import re
import warnings
from pathlib import Path

PY_DIR = Path(__file__).resolve().parents[2]

#``(path relative to py/, kind) -> reason``. Every entry must still match
#something (``test_allowlist_has_no_stale_entries``): an exemption nothing
#uses reads as live to whoever adds the next one beside it.
_CONCURRENTLY_MIGRATION = (
    "atomic=False migration for CREATE/DROP INDEX CONCURRENTLY, which "
    "PostgreSQL refuses inside a transaction, so SET LOCAL is impossible and "
    "the timeout has to be session-level. Already applied everywhere. The "
    "migrate Job must therefore connect DIRECTLY to Postgres, never through "
    "the transaction-mode pooler (ledger-v2 §12, #2221): there the SET and "
    "the CONCURRENTLY statement could reach different backends and the "
    "timeout would leak to another client."
)

#``(path relative to py/, kind) -> reason``. Every entry must still match
#something (``test_allowlist_has_no_stale_entries``): an exemption nothing
#uses reads as live to whoever adds the next one beside it. Keyed per FILE,
#so a new migration with the same need is flagged and has to say so.
ALLOWLIST: dict[tuple[str, str], str] = {
    (
        "dj/apps/g12f/migrations/0094_index_zpage_source_language.py",
        "session-set",
    ): _CONCURRENTLY_MIGRATION,
    (
        "dj/apps/g12f/migrations/0095_zpage_pub_latest_idx.py",
        "session-set",
    ): _CONCURRENTLY_MIGRATION,
    (
        "dj/apps/g12f/migrations/0102_backfill_zpage_published_at.py",
        "session-set-config",
    ): _CONCURRENTLY_MIGRATION + " It restores the previous values in a "
    "finally block, which is correct on one direct session.",
    (
        "dj/apps/g12f/migrations/0114_creator_public_id.py",
        "session-set",
    ): _CONCURRENTLY_MIGRATION,
    (
        "dj/apps/uploads/migrations/0015_webp_file_idx.py",
        "session-set",
    ): _CONCURRENTLY_MIGRATION,
    (
        "dj/apps/oidc/migrations/0004_ai_report_unsafe_index.py",
        "session-set",
    ): _CONCURRENTLY_MIGRATION,
}

_ADVISORY_SESSION_RE = re.compile(
    r"\bpg_(?:try_)?advisory_(?:un)?lock(?:_shared)?\s*\("
)
_ADVISORY_UNLOCK_ALL_RE = re.compile(r"\bpg_advisory_unlock_all\s*\(")
# set_config(name, value, is_local): only is_local=false is session state.
_SET_CONFIG_SESSION_RE = re.compile(
    r"\bset_config\s*\([^()]*,\s*false\s*\)", re.IGNORECASE
)
_NAMED_CURSOR_RE = re.compile(
    r"\.cursor\(\s*(?:name\s*=|[\"'])"
)

_LEADING_NOISE_RE = re.compile(r"^(?:\s+|--[^\n]*\n|/\*.*?\*/)*", re.DOTALL)
# A session SET: SET [SESSION] <guc> {=|TO}..., or one of the special forms.
# Not SET LOCAL, SET TRANSACTION, SET CONSTRAINTS (all transaction-scoped).
#
# Statement keywords are matched in UPPER CASE, which is how every SQL
# statement under py/ is written; matched case-insensitively they flag help
# text ("Set it to this environment's public origin...") instead of SQL.
# GUC names are matched in any case.
_SESSION_SET_RE = re.compile(
    r"^SET\s+(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)"
    r"(?:SESSION\s+)?"
    r"(?:ROLE\b|SESSION\s+AUTHORIZATION\b|CHARACTERISTICS\b|TIME\s+ZONE\b"
    r"|NAMES\b|SCHEMA\b"
    r"|[A-Za-z_][A-Za-z0-9_.]*\s*(?:=|\bTO\b))"
)
_STATEMENT_SHAPES = {
    "session-set": _SESSION_SET_RE,
    "listen": re.compile(r"^LISTEN\s+\S"),
    "temp-table": re.compile(
        r"^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\s+"
        r"(?:TABLE|VIEW|SEQUENCE)\b"
    ),
    "declare-cursor": re.compile(
        r"^DECLARE\s+\S+\s+(?:BINARY\s+|(?:NO\s+)?SCROLL\s+|"
        r"(?:A|IN)SENSITIVE\s+)*CURSOR\b"
    ),
    "prepare": re.compile(r"^PREPARE\s+\w+\s*(?:\(|AS\b)"),
}


def _string_literals(tree):
    """Every string literal, with an f-string's constant parts joined.

    An f-string's constant parts are NOT also yielded on their own: in
    ``f"UPDATE {table} SET x = 1"`` the part ``" SET x = 1"`` is not a
    statement.
    """
    inside_fstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            inside_fstrings.update(id(part) for part in node.values)
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            yield node.lineno, "".join(
                part.value if isinstance(part, ast.Constant) else " x "
                for part in node.values
            )
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in inside_fstrings
        ):
            yield node.lineno, node.value


def _statements(sql):
    for piece in sql.split(";"):
        yield _LEADING_NOISE_RE.sub("", piece, count=1)


def scan_source(source: str) -> list[tuple[int, str, str]]:
    """``(line, kind, excerpt)`` for each session-state shape in ``source``."""
    findings = []
    with warnings.catch_warnings():
        # An invalid escape in some scanned module is its own problem.
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(source)
    for lineno, text in _string_literals(tree):
        for statement in _statements(text):
            for kind, pattern in _STATEMENT_SHAPES.items():
                if pattern.match(statement):
                    findings.append((lineno, kind, statement[:60].strip()))
    for kind, pattern in (
        ("session-advisory-lock", _ADVISORY_SESSION_RE),
        ("advisory-unlock-all", _ADVISORY_UNLOCK_ALL_RE),
        ("session-set-config", _SET_CONFIG_SESSION_RE),
        ("named-cursor", _NAMED_CURSOR_RE),
    ):
        for match in pattern.finditer(source):
            lineno = source.count("\n", 0, match.start()) + 1
            findings.append((lineno, kind, match.group(0)[:60]))
    return sorted(set(findings))


def _scanned_files():
    for path in sorted(PY_DIR.rglob("*.py")):
        rel = path.relative_to(PY_DIR)
        parts = rel.parts
        if (
            "tests" in parts
            or any(p.startswith(".") for p in parts)
            or "site-packages" in parts
            or path.name.startswith("test_")
            or path.name in {"conftest.py", "pytest_settings.py"}
        ):
            continue
        yield rel, path


def _tree_findings():
    out = []
    for rel, path in _scanned_files():
        for lineno, kind, excerpt in scan_source(path.read_text()):
            out.append((str(rel), lineno, kind, excerpt))
    return out


def test_no_new_session_scoped_postgres_state():
    offenders = [
        f"py/{rel}:{lineno}: {kind}: {excerpt!r}"
        for rel, lineno, kind, excerpt in _tree_findings()
        if (rel, kind) not in ALLOWLIST
    ]
    assert not offenders, (
        "Session-scoped Postgres state does not survive PgBouncer transaction "
        "pooling (#2221, docs/tuzis/ledger-v2.md §12). Use the "
        "transaction-scoped form (pg_try_advisory_xact_lock, SET LOCAL / "
        "set_config(..., true), a keyset loop instead of a cursor, "
        "ON COMMIT DROP inside one atomic block), or add an ALLOWLIST entry "
        "that explains why this one is safe:\n" + "\n".join(offenders)
    )


def test_allowlist_has_no_stale_entries():
    found = {(rel, kind) for rel, _lineno, kind, _excerpt in _tree_findings()}
    stale = sorted(set(ALLOWLIST) - found)
    assert not stale, f"ALLOWLIST entries that match nothing: {stale}"
    assert all(len(reason) >= 20 for reason in ALLOWLIST.values())


_FORBIDDEN_SAMPLE = '''
def f(cursor, connection):
    cursor.execute("SELECT pg_try_advisory_lock(%s)", [1])
    cursor.execute("SELECT pg_advisory_lock(%s)", [1])
    cursor.execute("SELECT pg_advisory_unlock(%s)", [1])
    cursor.execute("SELECT pg_try_advisory_lock_shared(1)")
    cursor.execute("SELECT pg_advisory_unlock_all()")
    cursor.execute("SET statement_timeout = 1000")
    cursor.execute("SET lock_timeout TO '2s'")
    cursor.execute("SET SESSION idle_in_transaction_session_timeout = 5")
    cursor.execute("SET TIME ZONE 'UTC'")
    cursor.execute("SET ROLE ai_gateway")
    cursor.execute("SET search_path TO ledger")
    cursor.execute("SELECT 1; SET work_mem = '64MB'")
    cursor.execute(f"SET application_name = {name!r}")
    cursor.execute("""
        -- a comment first
        SET enable_seqscan = off
    """)
    cursor.execute("SELECT set_config('statement_timeout', '1s', false)")
    cursor.execute("LISTEN procrastinate_any_queue")
    cursor.execute("CREATE TEMP TABLE t (id int)")
    cursor.execute("CREATE TEMPORARY TABLE t (id int)")
    cursor.execute("DECLARE c CURSOR WITH HOLD FOR SELECT 1")
    cursor.execute("DECLARE c NO SCROLL CURSOR FOR SELECT 1")
    cursor.execute("PREPARE q AS SELECT 1")
    connection.cursor(name="stream")
    connection.cursor("stream")
'''

_EXPECTED_KINDS = [
    "session-advisory-lock",
    "session-advisory-lock",
    "session-advisory-lock",
    "session-advisory-lock",
    "advisory-unlock-all",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set",
    "session-set-config",
    "listen",
    "temp-table",
    "temp-table",
    "declare-cursor",
    "declare-cursor",
    "prepare",
    "named-cursor",
    "named-cursor",
]

_ALLOWED_SAMPLE = '''
_HEADER = "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public"
def f(cursor, connection, qs):
    cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [1])
    cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", [1, 2])
    cursor.execute("SELECT pg_advisory_xact_lock_shared(1)")
    cursor.execute("SET LOCAL statement_timeout = 1000")
    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    cursor.execute("SET CONSTRAINTS ALL DEFERRED")
    cursor.execute("SELECT set_config('statement_timeout', %s, true)", ["1s"])
    cursor.execute("UPDATE g12f_creator SET tuzis = 0 WHERE id = 1")
    cursor.execute("""
        UPDATE g12f_creator
        SET tuzis = 0
    """)
    cursor.execute("""CREATE FUNCTION f() RETURNS void
        LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT 1 $$""")
    cursor.execute("NOTIFY procrastinate_any_queue")
    connection.cursor()
    help_text = "Set the value to something sensible."
    hint = "Set it to this environment's public origin."
    other = "Set pagination=cursor when supplying a cursor."
    cursor.execute(f"UPDATE {table} SET last_beat_at = now()")
    label = "Set up your listening room"
    for row in qs.iterator(chunk_size=100):
        pass
'''


def test_the_scanner_flags_every_session_state_shape():
    kinds = [kind for _line, kind, _excerpt in scan_source(_FORBIDDEN_SAMPLE)]
    assert sorted(kinds) == sorted(_EXPECTED_KINDS), kinds


def test_the_scanner_accepts_the_transaction_scoped_forms():
    assert scan_source(_ALLOWED_SAMPLE) == []
