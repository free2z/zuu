"""Which host Django's default database connects to: the pooler or direct.

 deploys PgBouncer (transaction mode) into every namespace DARK: the
`pgbouncer` Service exists, and nothing uses it until the owner names the
namespace in ``DB_POOLER_NAMESPACES`` (k8s/free2z/config.yaml). This module is
the one place that decision is made, so prod_settings.py stays a single line
and the tests can drive it without re-importing settings.

The rules, in order:

1. **``manage.py migrate`` (and the other commands in DIRECT_COMMANDS) always
   connect directly**, whatever the environment says. Five already-applied
   ``atomic=False`` CONCURRENTLY migrations set a *session-level*
   ``lock_timeout`` (the allowlist in dj/apps/test_pgbouncer_session_state.py),
   and ledger-v2's L2 will too; through a transaction pooler that SET lands on
   whichever backend served it and leaks to the next client. The Cloud Build
   migrate step never sees the ConfigMap anyway -- this is the second wall,
   for a `kubectl exec... manage.py migrate` in a pod that does.
2. ``DB_POOLER_BYPASS=true`` forces direct, for a one-off Job that needs
   session state.
3. Pooled only if this pod's ``NAMESPACE`` is listed in
   ``DB_POOLER_NAMESPACES`` (comma-separated). Empty -- the default, and what
   the ConfigMap ships -- means direct everywhere, i.e. today's behaviour.

A value that cannot be read is an ``ImproperlyConfigured`` at import, not a
silent fallback. The flip is a ConfigMap change followed by a rollout: a typo
then leaves the new pods crashlooping and the old pods serving, which is loud
and harmless, where "fall back to direct" would report a cutover that never
happened.

Pooling also REQUIRES ``PROCRASTINATE_LISTEN_NOTIFY=false`` in the same
environment. LISTEN is session state: behind a transaction pooler the backend
that registered it is handed to another client, and the billing lane would
silently stop hearing notifications (it would still poll, but nothing would
say so). Refusing the combination makes the runbook's two-key edit impossible
to half-do.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# `migrate` for the session-level lock_timeout above. `dbshell` is a human in
# psql, whose SETs would leak to other clients. `dbbackup` / `dbrestore` shell
# out to pg_dump / pg_restore, which issue session SETs before they BEGIN.
DIRECT_COMMANDS = frozenset({"migrate", "dbshell", "dbbackup", "dbrestore"})

# The namespaces cbenv.sh deploys. A name outside this set is a typo
# ("production") that would otherwise leave every namespace direct while the
# ConfigMap looked cut over.
KNOWN_NAMESPACES = frozenset({"prod", "stage", "test"})

# The Service in k8s/pgbouncer/service.yaml; port 5432 there maps to 6432.
DEFAULT_POOLER_HOST = "pgbouncer"

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off", ""})


class PoolerConfigError(ValueError):
    """The pooler environment cannot be interpreted; refuse to boot."""


@dataclass(frozen=True)
class DatabaseRoute:
    host: str
    pooled: bool
    reason: str


# The ONE reading of PROCRASTINATE_LISTEN_NOTIFY, shared with
# dj.apps.jobs.procrastinate_pool.listen_notify_enabled() so the boot guard
# and the worker cannot disagree. Its historical meaning is "LISTEN unless
# explicitly off": only these spellings turn it off, and anything else -- the
# empty string, a typo -- leaves LISTEN ON. A reader that took "" as false
# here would pass a pooled pod whose billing lane still LISTENs.
LISTEN_NOTIFY_OFF = frozenset({"0", "false", "no", "off"})


def listen_notify_enabled(environ: Mapping[str, str]) -> bool:
    raw = environ.get("PROCRASTINATE_LISTEN_NOTIFY", "true")
    return raw.strip().lower() not in LISTEN_NOTIFY_OFF


def _flag(environ: Mapping[str, str], name: str, default: str) -> bool:
    raw = environ.get(name, default).strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise PoolerConfigError(
        f"{name}={environ.get(name)!r} is neither true nor false"
    )


def _command(argv: Sequence[str]) -> str | None:
    """The management command, if this process is `manage.py <command>`."""
    if len(argv) < 2:
        return None
    program = argv[0].rsplit("/", 1)[-1]
    if program in {"manage.py", "django-admin", "django-admin.py"}:
        return argv[1]
    # `python -m django migrate` leaves argv[0] as the module's path.
    if program == "__main__.py":
        return argv[1]
    return None


def pooled_namespaces(environ: Mapping[str, str]) -> frozenset[str]:
    raw = environ.get("DB_POOLER_NAMESPACES", "")
    names = frozenset(part.strip() for part in raw.split(",") if part.strip())
    unknown = sorted(names - KNOWN_NAMESPACES)
    if unknown:
        raise PoolerConfigError(
            f"DB_POOLER_NAMESPACES names unknown namespace(s) {unknown}; "
            f"expected a subset of {sorted(KNOWN_NAMESPACES)}"
        )
    return names


def resolve(environ: Mapping[str, str], argv: Sequence[str]) -> DatabaseRoute:
    """Decide the default database's host for this process."""
    direct = environ.get("DBHOST", "localhost")
    # Validate the list even on the direct paths, so a typo cannot hide
    # behind whichever process happened to boot first.
    namespaces = pooled_namespaces(environ)
    command = _command(argv)
    if command in DIRECT_COMMANDS:
        return DatabaseRoute(direct, False, f"`{command}` always connects directly")
    if _flag(environ, "DB_POOLER_BYPASS", "false"):
        return DatabaseRoute(direct, False, "DB_POOLER_BYPASS is set")
    namespace = environ.get("NAMESPACE", "").strip()
    if namespace not in namespaces:
        return DatabaseRoute(
            direct, False, f"namespace {namespace!r} is not in DB_POOLER_NAMESPACES"
        )
    # Pooled: LISTEN must be EXPLICITLY off. The shared parser treats
    # anything it does not recognise as on, so this refuses "", a typo, and
    # an absent key alike -- the only way through is a spelling the worker
    # also reads as off.
    if listen_notify_enabled(environ):
        raw = environ.get("PROCRASTINATE_LISTEN_NOTIFY")
        raise PoolerConfigError(
            f"namespace {namespace!r} is pooled (DB_POOLER_NAMESPACES) but "
            f"PROCRASTINATE_LISTEN_NOTIFY={raw!r} is not explicitly false; a "
            "transaction pooler does not carry the session a LISTEN is "
            "registered on. Set PROCRASTINATE_LISTEN_NOTIFY=\"false\" in "
            "the same ConfigMap edit (docs/k8s/pgbouncer.md)."
        )
    host = environ.get("DB_POOLER_HOST", DEFAULT_POOLER_HOST).strip()
    if not host:
        raise PoolerConfigError("DB_POOLER_HOST is empty")
    return DatabaseRoute(host, True, f"namespace {namespace!r} is pooled")
