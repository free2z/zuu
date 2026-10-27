"""Deployment configuration lookup works for source and packaged Python layouts."""
from pathlib import Path

import pytest

from zcashrpc.deployment_paths import deployment_root


@pytest.mark.parametrize(('module_path', 'expected'), [
    ('/checkout/py/free2z/dj/apps/g12f/paymentd_runtime.py', '/checkout'),
    ('/checkout/py/dj/apps/g12f/paymentd_runtime.py', '/checkout'),
    ('/py/dj/apps/g12f/paymentd_runtime.py', '/'),
    ('/py/zcashrpc/nodewatch.py', '/'),
])
def test_deployment_root_handles_checkout_and_image(module_path, expected, monkeypatch):
    monkeypatch.delenv('FREE2Z_DEPLOYMENT_ROOT', raising=False)
    assert deployment_root(module_path) == Path(expected)


def test_explicit_deployment_configuration_root(monkeypatch):
    monkeypatch.setenv('FREE2Z_DEPLOYMENT_ROOT', '/etc/free2z/deployment')
    assert deployment_root('/py/zcashrpc/nodewatch.py') == Path('/etc/free2z/deployment')
    monkeypatch.setenv('FREE2Z_DEPLOYMENT_ROOT', 'relative')
    with pytest.raises(ValueError, match='must be absolute'):
        deployment_root('/py/zcashrpc/nodewatch.py')


@pytest.mark.parametrize('module_name', [
    'dj.apps.g12f.paymentd_runtime', 'zcashrpc.nodewatch',
])
def test_runtime_module_import_at_installed_depth(module_name, monkeypatch):
    import importlib.util

    monkeypatch.delenv('FREE2Z_DEPLOYMENT_ROOT', raising=False)
    source_path = Path(importlib.util.find_spec(module_name).origin)
    installed_path = '/py/' + module_name.replace('.', '/') + '.py'
    namespace = {'__file__': installed_path, '__name__': module_name,
                 '__package__': module_name.rsplit('.', 1)[0]}
    exec(compile(source_path.read_text(), installed_path, 'exec'), namespace)
    assert namespace.get('REPOSITORY', namespace.get('_REPO_ROOT')) == Path('/')
