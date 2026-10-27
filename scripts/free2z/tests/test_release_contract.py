import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts/free2z' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('release-manifest')
packager = load('package-runtime')
selector = load('select-web-checks')
assets = load('check-web-assets')


class ReleaseContract(unittest.TestCase):
    def valid(self):
        return {'schema_version': 1, 'source': {'repository': 'free2z/zuu', 'commit': 'a'*40}, 'build': {'workflow': release.WORKFLOW, 'run_id': '123', 'run_attempt': 1}, 'images': {k: {'repository': v, 'digest': 'sha256:'+'b'*64} for k, v in release.REPOSITORIES.items()}, 'static_assets': {'path': '/app/build/client', 'inventory': 'static-assets.json', 'sha256': 'sha256:'+'c'*64}}

    def test_exact_release_contract(self):
        release.validate(self.valid())
        mutations = [lambda v: v.update(schema_version=2), lambda v: v['source'].update(repository='attacker/zuu'), lambda v: v['source'].update(commit='main'), lambda v: v['build'].update(workflow='.github/workflows/other.yml'), lambda v: v['build'].update(run_attempt=True), lambda v: v['images'].pop('static'), lambda v: v['images']['web'].update(digest='latest'), lambda v: v['images']['backend'].update(repository='ghcr.io/attacker/backend'), lambda v: v['static_assets'].update(inventory='../secret')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value = self.valid()
                mutate(value)
                with self.assertRaises(ValueError): release.validate(value)

    def test_inventory_requires_real_assets_and_no_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError): release.inventory(root)
            asset = root/'_app/immutable/a.js';asset.parent.mkdir(parents=True);asset.write_text('fixture')
            self.assertEqual(release.inventory(root), {'_app/immutable/a.js': release.sha256(b'fixture')})
            (root/'link').symlink_to(asset)
            with self.assertRaises(ValueError): release.inventory(root)

    def test_runtime_excludes_test_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'source';source.mkdir()
            for name in packager.MODULES:
                (source/name).mkdir();(source/name/'__init__.py').write_text('')
            (source/'pytest_settings.py').write_text('PASSWORD_HASHERS=["weak"]')
            (source/'dj/test_secret.py').write_text('fixture')
            (source/'dj/settings.py').write_text('runtime')
            destination=Path(directory)/'runtime'
            packager.package(source,destination)
            self.assertFalse((destination/'pytest_settings.py').exists())
            self.assertFalse((destination/'dj/test_secret.py').exists())
            self.assertEqual((destination/'dj/settings.py').read_text(),'runtime')
            (source/'dj/link').symlink_to(source/'pytest_settings.py')
            with self.assertRaises(ValueError):packager.package(source,Path(directory)/'bad')

    def test_unresolved_lfs_is_not_a_publishable_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'ts/react/free2z/public/logo.png'
            path.parent.mkdir(parents=True);path.write_bytes(b'PNG fixture')
            assets.check(root)
            path.write_text('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'*64+'\nsize 123\n')
            with self.assertRaises(ValueError): assets.check(root)

    def test_change_selection(self):
        for path in ['py/free2z/dj/apps/a.py','ts/react/free2z/src/a.ts','ts/svelte/free2z/src/a.ts','scripts/free2z/check.py','.github/workflows/free2z-web-ci.yml','build/free2z/backend.Dockerfile','docs/about-free2z/docs/a.md']:
            self.assertTrue(selector.selected([path]),path)
        self.assertFalse(selector.selected(['wallet/zuuli/src/App.svelte','rs/crates/f2z-sdk/src/lib.rs']))

    def test_bootstrap_cannot_remove_application(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(ValueError): selector.complete(root,False)
            item=root/'py/free2z/scaffold.py';item.parent.mkdir(parents=True);item.write_text('fixture')
            expected={'py/free2z/scaffold.py':hashlib.sha256(b'fixture').hexdigest()}
            self.assertFalse(selector.complete(root,False,expected))
            with self.assertRaises(ValueError):selector.complete(root,True)
            lock=root/'py/free2z/requirements/main.txt';lock.parent.mkdir(parents=True);lock.write_text('fixture')
            with self.assertRaises(ValueError):selector.complete(root,False)
            for name in ('py/free2z/requirements/main.in', 'py/free2z/requirements/test.txt', 'py/free2z/dj/free2z/manage.py', 'py/free2z/dj/free2z/openapi/f2z.yaml', 'py/free2z/pytest_settings.py', 'ts/free2z/bridge/site/free2z.html', 'docs/free2z/website/package.json', 'ts/svelte/free2z/src/routes/[username]/private/[secret]/+page.svelte'):
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
            self.assertTrue(selector.complete(root,False))
            self.assertTrue(selector.complete(root,True))


if __name__=='__main__': unittest.main()
