from pathlib import Path
import importlib.util
import unittest
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
        self.setUp();self.ci['jobs']['web-gate']['needs'].remove('images')
        with self.assertRaises(ValueError):self.check()

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
