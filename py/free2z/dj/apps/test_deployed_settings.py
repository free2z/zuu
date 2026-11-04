"""The published application runtime excludes test-only password settings."""
import importlib.util
from pathlib import Path

import pytest

PY_DIR = Path(__file__).resolve().parents[2]
REPO = PY_DIR.parents[1]


def _packager():
    spec = importlib.util.spec_from_file_location(
        "free2z_runtime_packager", REPO / "scripts/free2z/package-runtime.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_runtime_contains_application_settings_but_no_test_password_settings(tmp_path):
    output = tmp_path / "runtime"
    copied = _packager().package(PY_DIR, output)
    assert "dj/free2z/settings.py" in copied
    assert (output / "dj/free2z/settings.py").read_bytes() == (
        PY_DIR / "dj/free2z/settings.py"
    ).read_bytes()
    assert not (output / "pytest_settings.py").exists()
    assert all(Path(item).name != "pytest_settings.py" for item in copied)
    assert "iterations = 1" in (PY_DIR / "pytest_settings.py").read_text()
    for path in output.rglob("*.py"):
        assert "class FastPBKDF2Hasher" not in path.read_text(), path


def test_packager_refuses_missing_application_modules(tmp_path):
    with pytest.raises(ValueError, match="missing runtime module"):
        _packager().package(tmp_path / "empty", tmp_path / "runtime")


@pytest.mark.django_db
def test_a_resaved_zpage_password_still_verifies(creator_factory):
    """The test hasher must preserve the prefix used by the save guard."""
    from dj.apps.g12f.models import zPage

    page = zPage.objects.create(
        creator=creator_factory(), title="pw", password="fixture-secret"
    )
    assert page.password.startswith("pbkdf2_sha256$")
    assert page.check_password("fixture-secret")

    page.title = "pw edited"
    page.save()
    page.refresh_from_db()

    assert page.check_password("fixture-secret"), (
        "the second save re-hashed an already-hashed password; the test-only "
        "hasher's algorithm prefix does not match the guard in zPage.save()"
    )
