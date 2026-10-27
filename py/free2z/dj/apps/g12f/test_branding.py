"""Verify that default branding assets are packaged with the Django application.

Django-owned image URLs must resolve through staticfiles without depending on
the separately built classic or Svelte frontends.
"""

import ast
import re
from pathlib import Path

from django.contrib.staticfiles import finders
from django.test import override_settings

from dj.apps.g12f import branding
from dj.apps.g12f.views.crawler import SITE_IMAGE

# Locate the public repository from the nested Python application.
REPO_ROOT = Path(__file__).resolve().parents[5]
PY_ROOT = REPO_ROOT / "py" / "free2z"
G12F_STATIC = PY_ROOT / "dj" / "apps" / "g12f" / "static"
SVELTE_STATIC = REPO_ROOT / "ts" / "svelte" / "free2z" / "static"

# Classic-only URLs, assembled from fragments to avoid matching this scan.
CLASSIC_ONLY_ASSETS = [
    "/logo" + "512.png",
    "/logo" + "192.png",
    "/2Z-" + "alpha-crop.png",
    "/2z-" + "ai.png",
    "/tuzi" + ".svg",
    "/Roboto_" + "Regular.json",
    "/favicon" + ".zcash",
    "/asset-" + "manifest.json",
]


def test_default_logo_file_is_collectable():
    """The logo belongs to the application static directory."""
    asset = G12F_STATIC / branding.DEFAULT_LOGO_STATIC_PATH
    assert asset.is_file(), (
        f"{asset} does not exist, so /djstatic/"
        f"{branding.DEFAULT_LOGO_STATIC_PATH} would 404 for every "
        "avatar-less creator and every zPage with no featured image"
    )
    assert asset.stat().st_size > 0, f"{asset} is empty"


def test_default_logo_is_reachable_through_the_staticfiles_finders():
    """Asserts the MECHANISM collectstatic uses, not just that a file exists.

    A file sitting in `g12f/static/` is only collected if the app is installed
    and `AppDirectoriesFinder` is active. `finders.find()` is exactly what
    `collectstatic` calls, so this fails the moment either of those changes —
    the case a bare `Path.is_file()` assertion sails straight past.
    """
    found = finders.find(branding.DEFAULT_LOGO_STATIC_PATH)
    assert found, (
        f"collectstatic would not pick up {branding.DEFAULT_LOGO_STATIC_PATH}; "
        "check that 'dj.apps.g12f' is in INSTALLED_APPS and that "
        "AppDirectoriesFinder is still in STATICFILES_FINDERS"
    )
    assert Path(found).resolve() == (
        G12F_STATIC / branding.DEFAULT_LOGO_STATIC_PATH
    ).resolve()


def test_default_logo_survives_the_statictar_glob():
    """`//py:statictar` globs `dj/free2z/static/**/*.*` — dot required.

    The packaging chain is collectstatic -> that glob -> `/base/dj/free2z/`.
    A collected path whose basename has no `.` is silently dropped by the glob
    and the URL 404s in production with every check green, which is the one
    link neither the finder test above nor the nginx route harness covers.
    """
    name = Path(branding.DEFAULT_LOGO_STATIC_PATH).name
    assert "." in name and not name.startswith("."), (
        f"{name} would not match //py:statictar's `**/*.*` glob"
    )


def test_default_logo_url_matches_production():
    """Both settings modules must agree, and neither may use `/static/`.

    `/static/` is served from `root /base/build/` (the classic CRA build) by
    `location ^~ /static/` in k8s/free2z/nginx.conf. A Django static URL under
    that prefix points into a tree that has never held Django's collected
    files and that  Phase 4 deletes.
    """
    with override_settings(STATIC_URL="/djstatic/"):
        assert branding.default_logo_url() == "/djstatic/g12f/logo512.png"
    # No override: the default settings module is what a shell, a management
    # command or a local run uses, and it must not emit a CRA-build URL either.
    assert branding.default_logo_url() == "/djstatic/g12f/logo512.png"


def test_default_logo_is_not_served_by_another_deployment():
    """It must not move under /brand/ or /_app/, which new-ui owns.

    Those paths are proxied to the SvelteKit Deployment. Cloud Build applies
    free2z and new-ui together with no rollout ordering, so a URL Django emits
    that only new-ui can serve is a 404 for the length of every rollout — and
    social unfurlers cache what they fetch, so the damage outlives the window.
    """
    with override_settings(STATIC_URL="/djstatic/"):
        url = branding.default_logo_url()
    assert url.startswith("/djstatic/"), (
        f"{url} is not served by the free2z pod itself"
    )




def test_site_image_uses_the_shared_constant():
    """The crawler tier's site card must not drift from the branding module."""
    assert SITE_IMAGE == branding.DEFAULT_SOCIAL_IMAGE_PATH


def _string_literals(source: Path):
    """Yield every non-docstring `str` constant in a module.

    Deliberately AST-based rather than a text grep: comments and docstrings
    routinely NAME these paths (this file and `dj.apps.g12f.branding` both do,
    explaining why they are forbidden). Only a value that can actually reach a
    response body is a defect.
    """
    tree = ast.parse(source.read_text(encoding="utf-8", errors="ignore"))
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(
            node,
            (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
        ):
            doc = node.body[0] if node.body else None
            if (
                isinstance(doc, ast.Expr)
                and isinstance(doc.value, ast.Constant)
                and isinstance(doc.value.value, str)
            ):
                docstrings.add(id(doc.value))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstrings
        ):
            yield node.value


def _references_classic_asset(literal: str, asset: str) -> bool:
    """True when `literal` names `asset` as a ROOT-level URL path.

    Substring matching would be wrong: `g12f/logo512.png` — the relocated,
    surviving path — ends with `/logo512.png`. Only a path that resolves at the
    site root reaches `root /base/build/`.
    """
    if literal == asset or literal.startswith(asset + "?"):
        return True
    return bool(re.fullmatch(r"https?://[^/]+" + re.escape(asset), literal))


def test_no_python_source_hardcodes_a_classic_build_asset():
    """No module under py/ may reference a URL only the CRA build serves."""
    offenders = []
    this_file = Path(__file__).resolve()
    for source in PY_ROOT.rglob("*.py"):
        if source.resolve() == this_file or "/migrations/" in str(source):
            continue
        try:
            literals = list(_string_literals(source))
        except SyntaxError:  # pragma: no cover - vendored/py2 leftovers
            continue
        for literal in literals:
            for asset in CLASSIC_ONLY_ASSETS:
                if _references_classic_asset(literal, asset):
                    offenders.append(
                        f"{source.relative_to(REPO_ROOT)}: {asset}"
                    )
    assert not offenders, (
        "These reference assets that only the classic CRA build "
        "(/base/build/) can serve, which #953 Phase 4 deletes:\n  "
        + "\n  ".join(offenders)
    )


def test_no_django_template_hardcodes_a_classic_build_asset():
    """Same rule for the crawler/social templates, which are easy to miss."""
    offenders = []
    for template in PY_ROOT.rglob("*.html"):
        text = template.read_text(encoding="utf-8", errors="ignore")
        for asset in CLASSIC_ONLY_ASSETS:
            if asset in text:
                offenders.append(f"{template.relative_to(REPO_ROOT)}: {asset}")
    assert not offenders, (
        "These templates reference assets that only the classic CRA build "
        "(/base/build/) can serve:\n  " + "\n  ".join(offenders)
    )


