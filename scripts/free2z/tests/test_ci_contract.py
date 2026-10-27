from pathlib import Path
import importlib.util
import unittest
import re
import yaml

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('ci_contract',ROOT/'scripts/free2z/check-ci-contract.py')
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)


class CIContract(unittest.TestCase):
    def setUp(self):
        self.ci=yaml.safe_load((ROOT/'.github/workflows/free2z-web-ci.yml').read_text())
        self.release=yaml.safe_load((ROOT/'.github/workflows/free2z-web-release.yml').read_text())
        self.docker=(ROOT/'build/free2z/backend.Dockerfile').read_text()
        self.ruff=(ROOT/'ruff.toml').read_text()

    def check(self):policy.validate(self.ci,self.release,self.docker,self.ruff)

    def test_actual_contract(self):self.check()

    def test_omitted_shard_fails(self):
        for job,key in [('backend','group'),('ui-browser','shard')]:
            with self.subTest(job=job):
                self.setUp();self.ci['jobs'][job]['strategy']['matrix'][key].pop()
                with self.assertRaises(ValueError):self.check()

    def test_lost_budget_or_gate_fails(self):
        for job in ['backend','ui-browser']:
            self.setUp();self.ci['jobs'][job]['timeout-minutes']=1
            with self.assertRaises(ValueError):self.check()
        self.setUp();self.ci['jobs']['gate']['needs'].remove('images')
        with self.assertRaises(ValueError):self.check()

    def test_periodic_registration_guard_cannot_disappear(self):
        steps = self.ci['jobs']['backend']['steps']
        guard = next(s for s in steps if 'check-periodic-register-first.py' in s.get('run', ''))
        steps.remove(guard)
        with self.assertRaises(ValueError): self.check()
        self.setUp()
        guard = next(s for s in self.ci['jobs']['backend']['steps'] if 'check-periodic-register-first.py' in s.get('run', ''))
        guard['continue-on-error'] = True
        with self.assertRaises(ValueError): self.check()

    def test_each_live_registry_parity_check_is_required(self):
        for name in ('::test_static_scan_finds_exactly_the_registered_schedules', '::test_static_scan_sees_every_registered_task_name'):
            self.setUp()
            step = next(s for s in self.ci['jobs']['backend']['steps'] if 'test_periodic_register_first.py::' in s.get('run', ''))
            step['run'] = step['run'].replace(name, '')
            with self.assertRaises(ValueError): self.check()

    def test_inventory_and_single_platform_attestation_cannot_be_bypassed(self):
        steps = self.ci['jobs']['backend']['steps']
        export = next(s for s in steps if 'export-task-registry.py' in s.get('run', ''))
        steps.remove(export)
        steps.insert(0, export)
        with self.assertRaises(ValueError): self.check()
        for key in ('platforms', 'provenance', 'sbom'):
            self.setUp()
            build = next(s for s in self.ci['jobs']['images']['steps'] if s.get('uses', '').startswith('docker/build-push-action@'))
            build['with'].pop(key)
            with self.assertRaises(ValueError): self.check()
        self.setUp()
        self.ci.get('on', self.ci.get(True)).pop('merge_group')
        with self.assertRaises(ValueError): self.check()

    def test_sbom_guard_order_and_attestation_are_required(self):
        for mutation in ('remove', 'conditional', 'continue', 'after-export', 'wrong-image'):
            with self.subTest(mutation=mutation):
                self.setUp()
                steps = self.ci['jobs']['images']['steps']
                guard = next(s for s in steps if 'prepare-image-sbom.py prepare' in s.get('run', ''))
                if mutation == 'remove': steps.remove(guard)
                elif mutation == 'conditional': guard['if'] = 'false'
                elif mutation == 'continue': guard['continue-on-error'] = True
                elif mutation == 'after-export': steps.remove(guard); steps.append(guard)
                else: guard['run'] = guard['run'].replace('--image-id "$image_id"', '--image-id sha256:wrong')
                with self.assertRaises(ValueError): self.check()
        for mutation in ('skip', 'wrong-subject', 'wrong-predicate', 'no-recheck'):
            with self.subTest(mutation=mutation):
                self.setUp()
                steps = self.release['jobs']['publish']['steps']
                attestation = next(s for s in steps if s.get('with', {}).get('predicate-type') == 'https://spdx.dev/Document')
                if mutation == 'skip': attestation['continue-on-error'] = True
                elif mutation == 'wrong-subject': attestation['with']['subject-digest'] = 'sha256:wrong'
                elif mutation == 'wrong-predicate': attestation['with']['predicate-path'] = 'image-bundle/image.original.spdx.json'
                else:
                    step = next(s for s in steps if 'docker push ' in s.get('run', ''))
                    step['run'] = step['run'].replace('prepare-image-sbom.py check', 'other-check.py check')
                with self.assertRaises(ValueError): self.check()

    def test_static_build_node_matches_ci(self):
        docker = (ROOT / 'build/free2z/static.Dockerfile').read_text()
        versions = re.findall(r'^FROM node:([0-9.]+)-bookworm-slim@sha256:[a-f0-9]{64} AS (?:classic|docs)$', docker, re.M)
        self.assertEqual(versions, ['24.22.1', '24.22.1'])
        for name in ('react', 'docs'):
            node = next(s for s in self.ci['jobs'][name]['steps'] if s.get('uses', '').startswith('actions/setup-node@'))
            self.assertEqual(str(node['with']['node-version']), versions[0])

    def test_each_static_dependency_graph_is_audited(self):
        self.ci['jobs']['dependency-security-static']['strategy']['matrix']['project'].pop()
        with self.assertRaises(ValueError): self.check()
        self.setUp()
        step = next(s for s in self.ci['jobs']['dependency-security-static']['steps'] if s.get('run') == 'bash scripts/free2z/run-dependency-audits.sh')
        step['continue-on-error'] = True
        with self.assertRaises(ValueError): self.check()

    def test_native_bridge_cannot_silently_skip(self):
        self.ci['jobs']['native-payment-bridge']['env'].pop('PAYMENTD_NATIVE_BRIDGE_TEST')
        with self.assertRaises(ValueError): self.check()

    def test_python_drift_fails_both_directions(self):
        for job in ['backend','dependency-security']:
            for mode in ['delete','bump']:
                self.setUp();steps=self.ci['jobs'][job]['steps'];step=next(s for s in steps if s.get('uses','').startswith('actions/setup-python@'))
                if mode=='delete':steps.remove(step)
                else:step['with']['python-version']='99.0'
                with self.assertRaises(ValueError):self.check()
        self.setUp();self.docker=self.docker.replace('FROM python:3.12','FROM python:3.13')
        with self.assertRaises(ValueError):self.check()
        self.setUp();self.ruff=self.ruff.replace('target-version = "py312"','target-version = "py313"')
        with self.assertRaises(ValueError):self.check()

    def test_privileged_execution_and_unchecked_release_fail(self):
        self.ci['jobs']['images']['permissions']={'contents':'read','packages':'write'}
        with self.assertRaises(ValueError):self.check()
        self.setUp();self.release['jobs']['publish']['needs']=[]
        with self.assertRaises(ValueError):self.check()
        self.setUp();self.release['jobs']['publish']['steps'].append({'run':'docker run application'})
        with self.assertRaises(ValueError):self.check()
        self.setUp();self.release['jobs']['checks']['if']='true'
        with self.assertRaises(ValueError):self.check()


if __name__=='__main__':unittest.main()
