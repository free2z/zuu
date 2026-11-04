"""Every credential issuer records an AuthContext -- an inventory.

A new sign-in path that forgets ``record_login`` does not fail any test of
its own: it signs people in, and its sessions simply have no AuthContext, so
OIDC ``max_age``/``prompt=login`` and the spend-cap step-up fail closed for
everyone who used it. Nobody notices until a relying party does. So this
file fails instead.

Two independent sweeps, because a sign-in is issued two ways here:

1. **Source.** Every function under ``py/dj`` that calls Django's
   ``login()`` (under any alias, or as ``auth.login``), knox's
   ``AuthToken.objects.create`` or ``ktauth.credentials.issue_bearer_token``
   must also call ``record_login`` -- AFTER the ``login()``/issue, because
   ``login()`` cycles the session key and the context must follow the new
   one.
2. **URLconf.** Every routed view class that inherits an upstream login view
   (dj-rest-auth's, knox's, Django's) issues its credential inside upstream
   code the source sweep cannot see. Each must be one this file knows, and
   the override that records must exist and call ``record_login``.

Each sweep has a negative control that feeds it a violating example.

Not covered, deliberately: Django admin's login (``/adminzzz/login/``). It is
reachable only with ``DEBUG`` on (``dj/free2z/urls.py`` answers 404 in every
deployment), and a session it creates has no context, which every reader
treats as "authenticate again".
"""
from __future__ import annotations

import ast
import inspect
import textwrap
from pathlib import Path

import pytest
from django.urls import URLPattern, URLResolver, get_resolver

DJ_ROOT = Path(__file__).resolve().parents[3]          # py/dj
HELPER = "record_login"

#Functions that issue a credential without being a sign-in, with the
#reason. Keyed by "<path relative to py/dj>::<function>".
EXEMPT = {
    # The helper every Knox issuer calls; the callers record, it cannot (it
    # does not know how the caller authenticated).
    "apps/ktauth/credentials.py::issue_bearer_token":
        "the shared token minter; each caller records",
}


# --------------------------------------------------------------------------- #
# Sweep 1: source
# --------------------------------------------------------------------------- #
def _login_aliases(tree: ast.Module):
    """Names bound to django.contrib.auth.login, and to the auth module."""
    functions, modules = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "django.contrib.auth":
            for alias in node.names:
                if alias.name == "login":
                    functions.add(alias.asname or "login")
        if isinstance(node, ast.ImportFrom) and node.module == "django.contrib":
            for alias in node.names:
                if alias.name == "auth":
                    modules.add(alias.asname or "auth")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "django.contrib.auth" and alias.asname:
                    modules.add(alias.asname)
    return functions, modules


def _issues(call: ast.Call, functions, modules) -> bool:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id in functions or func.id == "issue_bearer_token"
    if isinstance(func, ast.Attribute):
        if func.attr == "login" and isinstance(func.value, ast.Name) \
                and func.value.id in modules:
            return True
        if func.attr == "issue_bearer_token":
            return True
        # AuthToken.objects.create(...)
        value = func.value
        if func.attr == "create" and isinstance(value, ast.Attribute) \
                and value.attr == "objects" and isinstance(value.value, ast.Name) \
                and value.value.id == "AuthToken":
            return True
    return False


def _records(call: ast.Call) -> bool:
    func = call.func
    name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
    return name == HELPER


def violations_in(source: str, label: str) -> list[str]:
    """Every function in ``source`` that issues without recording after."""
    tree = ast.parse(source)
    functions, modules = _login_aliases(tree)
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        # Only this function's own statements: a nested def is its own entry.
        calls = []
        stack = list(node.body)
        while stack:
            child = stack.pop()
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                calls.append(child)
            stack.extend(ast.iter_child_nodes(child))
        issued = [c.lineno for c in calls if _issues(c, functions, modules)]
        if not issued:
            continue
        key = f"{label}::{node.name}"
        if key in EXEMPT:
            continue
        recorded = [c.lineno for c in calls if _records(c)]
        if not recorded or max(recorded) < max(issued):
            found.append(f"{key} (line {min(issued)})")
    return found


def _production_sources():
    for path in sorted(DJ_ROOT.rglob("*.py")):
        rel = path.relative_to(DJ_ROOT).as_posix()
        parts = rel.split("/")
        if "migrations" in parts or "tests" in parts or parts[-1].startswith("test_") \
                or parts[-1] == "conftest.py" or parts[-1] == "tests.py":
            continue
        yield rel, path.read_text()


def test_every_issuer_in_the_source_records_an_auth_context():
    found = []
    for rel, source in _production_sources():
        found.extend(violations_in(source, rel))
    assert not found, (
        "These functions create a session or a Knox token without calling "
        "dj.apps.identity.auth_context.record_login after it (#2242). Record "
        "the methods the request proved, or methods=INHERIT for an exchange:\n  "
        + "\n  ".join(found)
    )


def test_the_sweep_sees_every_issuer_it_knows_of():
    """The sweep must actually find the issuers, or passing proves nothing."""
    issuers = set()
    for rel, source in _production_sources():
        tree = ast.parse(source)
        functions, modules = _login_aliases(tree)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
                isinstance(c, ast.Call) and _issues(c, functions, modules)
                for c in ast.walk(node)
            ):
                issuers.add(f"{rel}::{node.name}")
    assert {
        "apps/otp/views.py::post",
        "apps/social/views.py::post",
        "apps/zauth/views.py::_provision_identity_and_token",
        "apps/twitter/views.py::get",
        "apps/twitter/views.py::post",
        "apps/twitter/views.py::handle_new_twitter_user",
        "apps/emails/views.py::post",
        "apps/ktauth/credentials.py::issue_bearer_token",
    } <= issuers, sorted(issuers)


@pytest.mark.parametrize("source, expected", [
    # Negative controls: each of these must be reported.
    ("""
from django.contrib.auth import login
def view(request, user):
    login(request, user)
""", 1),
    ("""
from django.contrib.auth import login as auth_login
def view(request, user):
    auth_login(request, user)
""", 1),
    ("""
from django.contrib import auth
def view(request, user):
    auth.login(request, user)
""", 1),
    ("""
from knox.models import AuthToken
def view(user):
    return AuthToken.objects.create(user)
""", 1),
    ("""
def view(creator, epoch):
    return issue_bearer_token(creator, epoch)
""", 1),
    # Recording BEFORE login() keys the context to the session login() is
    # about to throw away.
    ("""
from django.contrib.auth import login
def view(request, user):
    record_login(request, user, methods=["pwd"])
    login(request, user)
""", 1),
    # Positive controls.
    ("""
from django.contrib.auth import login
def view(request, user):
    login(request, user)
    record_login(request, user, methods=["pwd"])
""", 0),
    ("""
def unrelated(request):
    request.login()
    client.login(username="x")
""", 0),
], ids=["login", "aliased", "module-attr", "knox-create", "issue-bearer",
        "recorded-too-early", "ok", "not-django-login"])
def test_the_source_sweep_catches_a_violation(source, expected):
    assert len(violations_in(textwrap.dedent(source), "example.py")) == expected


# --------------------------------------------------------------------------- #
# Sweep 2: routed subclasses of upstream login views
# --------------------------------------------------------------------------- #
def _upstream_login_views():
    from dj_rest_auth.views import LoginView as RestAuthLoginView
    from django.contrib.auth.views import LoginView as DjangoLoginView
    from knox.views import LoginView as KnoxLoginView

    return (RestAuthLoginView, KnoxLoginView, DjangoLoginView)


#Routed subclasses of an upstream login view, and the method of each that
#records. The upstream view issues the credential; this override is where
#the context is written, so it must exist on the class itself.
KNOWN_LOGIN_VIEWS = {
    "dj.apps.g12f.views.creator.CreatorLoginView": "process_login",
    "dj.free2z.urls.LoginView": "get_post_response_data",
}


def _routed_view_classes(patterns=None):
    patterns = get_resolver().url_patterns if patterns is None else patterns
    for entry in patterns:
        if isinstance(entry, URLResolver):
            yield from _routed_view_classes(entry.url_patterns)
        elif isinstance(entry, URLPattern):
            cls = getattr(entry.callback, "cls", None) or getattr(
                entry.callback, "view_class", None)
            if cls is not None:
                yield cls


def login_view_violations(classes) -> list[str]:
    upstream = _upstream_login_views()
    found = []
    for cls in set(classes):
        if not issubclass(cls, upstream):
            continue
        name = f"{cls.__module__}.{cls.__qualname__}"
        method = KNOWN_LOGIN_VIEWS.get(name)
        if method is None:
            found.append(f"{name}: an unknown login view")
            continue
        if method not in vars(cls):
            found.append(f"{name}: does not override {method}")
            continue
        source = textwrap.dedent(inspect.getsource(vars(cls)[method]))
        if HELPER not in {
            getattr(c.func, "id", None) or getattr(c.func, "attr", None)
            for c in ast.walk(ast.parse(source)) if isinstance(c, ast.Call)
        }:
            found.append(f"{name}.{method}: does not call {HELPER}")
    return found


def test_every_routed_login_view_records_an_auth_context():
    found = login_view_violations(_routed_view_classes())
    assert not found, "\n".join(found)


def test_the_routed_login_views_are_the_known_ones():
    """Positive control: the walk finds both, so the check above ran."""
    routed = {f"{c.__module__}.{c.__qualname__}" for c in _routed_view_classes()}
    assert set(KNOWN_LOGIN_VIEWS) <= routed


def test_the_urlconf_sweep_catches_a_violation():
    from knox.views import LoginView as KnoxLoginView

    class NewTokenLogin(KnoxLoginView):
        pass

    from dj.apps.g12f.views.creator import CreatorLoginView

    assert login_view_violations([NewTokenLogin]) == [
        f"{NewTokenLogin.__module__}.{NewTokenLogin.__qualname__}: an unknown login view"]
    assert login_view_violations([CreatorLoginView]) == []
