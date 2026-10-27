"""Every outbound network call under ``py/`` states its own timeout.

Each prod pod runs a single sync gunicorn worker. An outbound call with
no timeout does not fail when the far end goes quiet -- it waits, and while it
waits the pod serves nothing. The libraries do not protect us:

* ``requests`` / ``httpx`` function calls: ``requests`` has NO default
  timeout at all.
* ``urllib.request.urlopen``, ``http.client.HTTP(S)Connection`` and
  ``socket.create_connection``: default to the global socket timeout, which is
  ``None``.
* ``requests_oauthlib`` ``fetch_*_token``: forwards to ``requests``, same.
* ``openai.OpenAI`` / ``anthropic.Anthropic`` (and their ``Client`` /
  ``AsyncClient`` aliases): 600s read x (1 + 2 retries),
  read from ``openai/_constants.py`` and ``anthropic/_constants.py``.
* ``openai.embeddings`` / ``openai.completions`` /... module-level proxies:
  the SDK's implicit client, with those same defaults and no way to pass ours.
* Redis through ``django_redis``: ``socket_timeout=None`` unless OPTIONS says
  otherwise, and the default cache is read on every API request.

So this test parses every non-test module under ``py/`` and fails on any such
call that does not pass ``timeout`` (or, for the SDK clients, is not built with
one), and on any ``django_redis`` cache in ``prod_settings`` without socket
bounds. It is an AST scan, not ruff: the pinned ruff has no rule for this
(``S113``, "request without timeout", is in ``flake8-bandit``, which the
deliberately narrow ``F``+``E9`` rule set does not enable, and does not know
about urllib, http.client, OAuth sessions or the AI SDKs anyway).

What it cannot see, stated rather than implied: a call through a variable
holding a ``requests.Session`` (``session.get``) -- telling that apart from a
dict's ``.get`` needs types, not syntax -- and calls whose timeout comes from a
client configured elsewhere (Stripe's ``default_http_client``, the Google
SDKs). Those are covered by the inventory in the  PR, not by this test.

``test_the_scanner_flags_every_unbounded_shape`` is the negative control: the
same scanner, fed source that makes each forbidden call, must flag every one
of them -- otherwise a green result on the real tree proves nothing.
"""

import ast
import warnings
from pathlib import Path

import pytest

PY_DIR = Path(__file__).resolve().parents[2]

HTTP_VERBS = {
    "get", "post", "put", "patch", "delete", "head", "options", "request",
    "stream",
}
HTTP_MODULES = {"requests", "httpx"}
TOKEN_FETCHES = {"fetch_request_token", "fetch_access_token", "fetch_token"}
SDK_CONSTRUCTORS = {"OpenAI", "AsyncOpenAI", "Anthropic", "AsyncAnthropic"}
# Both SDKs also export their client under a generic name
# (``openai.Client is openai.OpenAI``, ``anthropic.Client is
# anthropic.Anthropic``). ``Client`` alone is far too common to match on the
# attribute name -- ``storage.Client()`` and SendGrid's
# ``python_http_client.Client`` are not these -- so these count only when the
# name demonstrably came from an SDK package: ``openai.Client(...)`` through a
# module import (aliases followed), or a bare ``Client(...)`` that the module
# imported ``from openai``/``from anthropic``.
SDK_PACKAGES = {"openai", "anthropic"}
SDK_ALIAS_CONSTRUCTORS = {"Client", "AsyncClient"}
OPENAI_IMPLICIT_PROXIES = {
    "completions", "embeddings", "chat", "images", "moderations", "responses",
    "audio", "files",
}


def _dotted(node):
    """``a.b.c`` for a Name/Attribute chain, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _has_kw(call, name):
    return any(kw.arg == name for kw in call.keywords)


def _sdk_names(tree):
    """Names this module bound to the SDK packages and their constructors.

    Returns ``(modules, constructors)``: local names bound to the ``openai`` /
    ``anthropic`` modules (``import openai as oa`` gives ``oa``), and local
    names bound to one of their client classes, under any alias
    (``from openai import Client as C`` gives ``C``).
    """
    modules, constructors = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in SDK_PACKAGES:
                    modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] not in SDK_PACKAGES:
                continue
            for alias in node.names:
                if alias.name in SDK_CONSTRUCTORS | SDK_ALIAS_CONSTRUCTORS:
                    constructors.add(alias.asname or alias.name)
    return modules, constructors


def _is_sdk_constructor(parts, sdk_modules, sdk_constructors):
    attr = parts[-1]
    if attr in SDK_CONSTRUCTORS:
        return True
    if len(parts) == 1:
        return attr in sdk_constructors
    return (
        len(parts) == 2 and parts[0] in sdk_modules
        and attr in SDK_ALIAS_CONSTRUCTORS
    )


def _unbounded_calls(source, filename="<src>"):
    """Yield ``(lineno, description)`` for every unbounded outbound call."""
    with warnings.catch_warnings():
        # Pre-existing invalid escapes elsewhere in the tree are not this
        # test's business.
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(source, filename)
    sdk_modules, sdk_constructors = _sdk_names(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _dotted(node.func)
        if name is None:
            continue
        parts = name.split(".")
        head, attr = parts[0], parts[-1]
        timed = _has_kw(node, "timeout")

        if head in HTTP_MODULES and len(parts) == 2 and attr in HTTP_VERBS:
            if not timed:
                yield node.lineno, f"{name}() without timeout="
        elif attr == "urlopen":
            # urlopen(url, data=None, timeout=...): the third positional
            # argument is the timeout.
            if not timed and len(node.args) < 3:
                yield node.lineno, f"{name}() without timeout="
        elif attr in {"HTTPConnection", "HTTPSConnection"}:
            if not timed:
                yield node.lineno, f"{name}() without timeout="
        elif name in {"socket.create_connection", "create_connection"}:
            if not timed and len(node.args) < 2:
                yield node.lineno, f"{name}() without timeout="
        elif attr in TOKEN_FETCHES:
            if not timed:
                yield node.lineno, f"{name}() without timeout="
        elif _is_sdk_constructor(parts, sdk_modules, sdk_constructors):
            if not timed:
                yield node.lineno, (
                    f"{name}() built without timeout= (SDK default is "
                    "600s x 3 attempts)"
                )
        elif (
            head == "openai" and len(parts) >= 3
            and parts[1] in OPENAI_IMPLICIT_PROXIES
        ):
            yield node.lineno, (
                f"{name}() goes through the SDK's implicit module-level "
                "client, which cannot be given a timeout"
            )


def _production_modules():
    for path in sorted(PY_DIR.rglob("*.py")):
        rel = path.relative_to(PY_DIR)
        parts = rel.parts
        if (
            "migrations" in parts
            or "tests" in parts
            or any(p.startswith(".") for p in parts)
            or "site-packages" in parts
            or path.name.startswith("test_")
            or path.name in {"conftest.py", "pytest_settings.py"}
        ):
            continue
        yield path


def test_every_outbound_call_under_py_states_a_timeout():
    findings = []
    scanned = 0
    for path in _production_modules():
        scanned += 1
        for lineno, what in _unbounded_calls(path.read_text(), str(path)):
            findings.append(f"{path.relative_to(PY_DIR)}:{lineno}: {what}")
    # A scan of nothing passes vacuously; the tree has hundreds of modules.
    assert scanned > 200, scanned
    assert not findings, (
        "Outbound calls without a timeout (#2080). Each prod pod has ONE sync "
        "worker; an unbounded call can hold it forever. Pass an explicit "
        "(connect, read) timeout sized to the endpoint and handle the "
        "timeout:\n  " + "\n  ".join(findings)
    )


NEGATIVE_CONTROL = '''
import requests, httpx, socket, http.client, urllib.request, openai
from openai import OpenAI
import anthropic
requests.post("https://example.invalid/", data={})
requests.get("https://example.invalid/")
requests.request("POST", "https://example.invalid/")
httpx.get("https://example.invalid/")
urllib.request.urlopen("https://example.invalid/")
http.client.HTTPSConnection("example.invalid")
socket.create_connection(("example.invalid", 443))
oauth.fetch_access_token("https://example.invalid/")
OpenAI()
anthropic.Anthropic(api_key="k")
openai.embeddings.create(input=["x"], model="m")
openai.Client()
anthropic.AsyncClient(api_key="k")
'''

# The SDKs' generic ``Client`` names reached through imports. A separate
# fixture because a bare ``Client`` counts only when it was imported from an
# SDK, and NOT_AN_SDK_CLIENT needs a bare ``Client`` that was not.
NEGATIVE_CONTROL_ALIASES = '''
import openai as oa
from anthropic import Client
from openai import AsyncClient as OAIAsync, OpenAI as OAI
oa.Client()
Client(api_key="k")
OAIAsync()
OAI()
'''

BOUNDED_CONTROL = '''
import requests, httpx, socket, http.client, urllib.request
import openai, anthropic
from openai import OpenAI
requests.post("https://example.invalid/", data={}, timeout=(3.05, 5))
httpx.get("https://example.invalid/", timeout=5)
urllib.request.urlopen("https://example.invalid/", None, 5)
urllib.request.urlopen("https://example.invalid/", timeout=5)
http.client.HTTPSConnection("example.invalid", timeout=5)
socket.create_connection(("example.invalid", 443), 5)
oauth.fetch_access_token("https://example.invalid/", timeout=(3.05, 8))
OpenAI(timeout=30)
request.session.get("state")
client.get("/api/healthz/")
openai.Client(timeout=30)
anthropic.Client(timeout=30)
'''

# ``Client`` that is NOT an AI SDK client must not be flagged: Google Cloud
# Storage and SendGrid's HTTP client both use the name.
NOT_AN_SDK_CLIENT = '''
from google.cloud import storage
from python_http_client import Client
storage.Client()
Client(host="https://api.sendgrid.com")
elsewhere.Client()
'''


@pytest.mark.parametrize("source", [
    NEGATIVE_CONTROL, NEGATIVE_CONTROL_ALIASES,
], ids=["direct", "sdk-aliases"])
def test_the_scanner_flags_every_unbounded_shape(source):
    """Negative control: each forbidden call in the fixture is caught."""
    flagged = [line for line, _ in _unbounded_calls(source)]
    expected_lines = [
        i + 1 for i, text in enumerate(source.splitlines())
        if text and not text.startswith(("import", "from"))
    ]
    assert sorted(flagged) == expected_lines


def test_the_scanner_accepts_bounded_calls_and_unrelated_gets():
    """...and it does not cry wolf: bounded calls and dict ``.get`` pass."""
    assert list(_unbounded_calls(BOUNDED_CONTROL)) == []


def test_the_scanner_ignores_clients_that_are_not_ai_sdks():
    """``Client`` from storage/SendGrid is not an SDK constructor."""
    assert list(_unbounded_calls(NOT_AN_SDK_CLIENT)) == []


def _redis_cache_dicts(tree):
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        values = {
            k.value: v for k, v in zip(node.keys, node.values)
            if isinstance(k, ast.Constant)
        }
        backend = values.get("BACKEND")
        if (
            isinstance(backend, ast.Constant)
            and backend.value == "django_redis.cache.RedisCache"
        ):
            yield node, values.get("OPTIONS")


def _socket_options_bound(tree):
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(t, ast.Name) and t.id == "CACHE_REDIS_SOCKET_OPTIONS"
                for t in node.targets
            )
        ):
            return {
                k.value: v.value for k, v in zip(node.value.keys, node.value.values)
                if isinstance(k, ast.Constant) and isinstance(v, ast.Constant)
            }
    return {}


def _unpacks_socket_options(options):
    return isinstance(options, ast.Dict) and any(
        key is None and isinstance(value, ast.Name)
        and value.id == "CACHE_REDIS_SOCKET_OPTIONS"
        for key, value in zip(options.keys, options.values)
    )


def test_every_prod_redis_cache_has_socket_timeouts():
    tree = ast.parse((PY_DIR / "dj/free2z/prod_settings.py").read_text())
    bounds = _socket_options_bound(tree)
    for key in ("SOCKET_CONNECT_TIMEOUT", "SOCKET_TIMEOUT"):
        value = bounds.get(key)
        assert isinstance(value, (int, float)) and 0 < value <= 10, (key, value)

    caches = list(_redis_cache_dicts(tree))
    assert len(caches) >= 2, "expected the default + stripe admission caches"
    for node, options in caches:
        assert _unpacks_socket_options(options), (
            f"prod_settings.py:{node.lineno}: django_redis cache without "
            "**CACHE_REDIS_SOCKET_OPTIONS -- redis-py's socket timeouts "
            "default to None"
        )


@pytest.mark.parametrize("options_src, expected", [
    ('{"IGNORE_EXCEPTIONS": True, **CACHE_REDIS_SOCKET_OPTIONS}', True),
    ('{"IGNORE_EXCEPTIONS": True}', False),
])
def test_the_redis_check_can_fail(options_src, expected):
    """Negative control for the Redis half."""
    options = ast.parse(options_src, mode="eval").body
    assert _unpacks_socket_options(options) is expected
