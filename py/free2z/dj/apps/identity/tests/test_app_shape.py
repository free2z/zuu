"""What this app may be (: new apps are self-contained so they can move).

* Its models are exactly the ones  added: passkeys, recovery codes
  and auth context. Their only foreign key is to ``AUTH_USER_MODEL``, so
  the app moves with its own tables. A PR that adds a model changes this
  file on purpose, and must classify the model as a sign-in method or as
  not one (``methods.NOT_SIGNIN_METHODS``).
* Its runtime code imports nothing from another ``dj.apps`` package except
  two public functions: ``ktauth.credentials.identity_can_authenticate``
  and ``social.clients.configured_providers``. It reads other apps' models
  through ``django.apps.apps.get_model``, so moving this app does not mean
  re-plumbing imports.

The import scanner resolves relative imports, treats ``from dj.apps import
x`` as a crossing into ``dj.apps.x``, and flags ``importlib.import_module``
and ``__import__`` calls whose argument names a ``dj.apps`` module. Each of
those forms has a negative control below.
"""
import ast
from pathlib import Path

import pytest
from django.apps import apps
from django.conf import settings

import dj.apps.identity as identity_pkg

APP_DIR = Path(identity_pkg.__file__).resolve().parent
PACKAGE = "dj.apps.identity"

ALLOWED_CROSS_APP_IMPORTS = {
    ("dj.apps.ktauth.credentials", "identity_can_authenticate"),
    ("dj.apps.social.clients", "configured_providers"),
}

_DYNAMIC_IMPORTERS = {"import_module", "__import__"}


def _is_foreign(module: str) -> bool:
    return (
        (module == "dj.apps" or module.startswith("dj.apps."))
        and module != PACKAGE
        and not module.startswith(PACKAGE + ".")
    )


def _resolve(module: "str | None", level: int, package: str) -> str:
    if not level:
        return module or ""
    parts = package.split(".")
    if level > 1:
        parts = parts[: len(parts) - (level - 1)]
    base = ".".join(parts)
    return f"{base}.{module}" if module else base


def cross_app_imports(source: str, package: str) -> set:
    """``(module, name)`` pairs that reach outside ``dj.apps.identity``.

    ``package`` is the package the source file lives in, which is needed to
    resolve relative imports.
    """
    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            module = _resolve(node.module, node.level, package)
            for alias in node.names:
                if module == "dj.apps":
                    # `from dj.apps import twitter` imports a sibling app.
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
                # A computed module name cannot be checked, so it is refused.
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
    # A module's package is its directory, whether it is `__init__.py` or not.
    rel = path.relative_to(APP_DIR).with_suffix("")
    return ".".join([PACKAGE, *rel.parts[:-1]])


EXPECTED_MODELS = {"webauthncredential", "recoverycode", "authcontext"}


def test_the_app_has_exactly_its_own_models():
    assert set(apps.get_app_config("identity").models) == EXPECTED_MODELS


def test_the_only_relation_out_of_the_app_is_the_account():
    """No foreign key to another app's table (``otp``, ``knox``, sessions).

    AuthContext names its credential by a hash, not by a key into
    ``django_session`` or knox's table, so moving this app does not drag
    those tables with it.
    """
    user_model = apps.get_model(settings.AUTH_USER_MODEL)
    for model in apps.get_app_config("identity").get_models():
        for field in model._meta.get_fields():
            if field.is_relation and field.concrete:
                assert field.related_model is user_model, (model, field)


def test_every_model_is_classified_as_a_method_or_not():
    from dj.apps.identity import methods

    handled = {
        adapter.model_label
        for adapter in methods._adapters() if adapter.model_label
    }
    for model in apps.get_app_config("identity").get_models():
        label = model._meta.label
        assert (label in handled) != (label in methods.NOT_SIGNIN_METHODS), label


def test_runtime_code_reaches_other_apps_only_through_the_allowlist():
    crossings = set()
    for path in _runtime_modules():
        crossings |= cross_app_imports(path.read_text(), _package_of(path))
    assert crossings == ALLOWED_CROSS_APP_IMPORTS


@pytest.mark.parametrize("source", [
    "import dj.apps.twitter.models",
    "import dj.apps.twitter.models as m",
    "from dj.apps.twitter.models import TwitterProfile",
    "from dj.apps import twitter",
    "from dj.apps import twitter as tw",
    "from ..twitter import models",
    "from ..twitter.models import TwitterProfile",
    "from .. import twitter",
    "import importlib\nimportlib.import_module('dj.apps.twitter.views')",
    "from importlib import import_module\nimport_module('dj.apps.twitter')",
    "__import__('dj.apps.twitter.views')",
    "import importlib\nimportlib.import_module('..twitter', __package__)",
    "import importlib\nname = 'dj.apps.' + 'twitter'\nimportlib.import_module(name)",
])
def test_the_scanner_catches_each_import_form(source):
    """Negative controls: each form must be reported as a crossing."""
    assert cross_app_imports(source, PACKAGE), source


@pytest.mark.parametrize("source", [
    "from . import methods",
    "from .methods import can_remove",
    "import dj.apps.identity.methods",
    "from dj.apps.identity import methods",
    "from dj.apps import identity",
    "from django.apps import apps",
])
def test_the_scanner_allows_imports_within_the_app(source):
    assert cross_app_imports(source, PACKAGE) == set(), source
