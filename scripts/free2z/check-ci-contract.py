#!/usr/bin/env python3
"""Validate website shard coverage, runtime versions and release authority."""
from pathlib import Path
import argparse
import re
import yaml


def validate(ci, release, dockerfile, ruff):
    jobs = ci['jobs']
    if ci['permissions'] != {'contents': 'read'}:
        raise ValueError('application tests must have read-only repository authority')
    application_jobs = set(jobs)-{'changes', 'gate'}
    gate = jobs['gate']
    if set(gate['needs']) != application_jobs | {'changes'} or gate['if'] != '${{ always() }}':
        raise ValueError('required gate must cover every selected check, including failures')
    verdicts = [step for step in gate['steps'] if step.get('run') == 'python3 scripts/free2z/verify-gate-results.py']
    if len(verdicts) != 1 or verdicts[0].get('env') != {'RESULTS': '${{ toJSON(needs) }}'} or 'if' in verdicts[0] or 'continue-on-error' in verdicts[0]:
        raise ValueError('gate must verify the complete result object without conditions')
    for name in application_jobs:
        job = jobs[name]
        if job.get('needs') != 'changes' or job.get('if') != "needs.changes.outputs.application == 'true'":
            raise ValueError('every application job must use the same selection decision')
        if job.get('permissions', {'contents':'read'}) != {'contents':'read'}:
            raise ValueError('application execution must not receive publishing authority')
    for name, variable, key in [('backend', 'BACKEND', 'group'), ('ui-browser', 'BROWSER', 'shard')]:
        job=jobs[name];env=job['env'];groups=job['strategy']['matrix'][key]
        if name=='backend':
            command=env['BACKEND_TEST_COMMAND']
            total=int(re.search(r'--splits\s+(\d+)', command)[1])
            if '--group ${{ matrix.group }}' not in command or '--durations-path .test_durations' not in command:
                raise ValueError('backend must bind its matrix and committed durations')
        else:
            total=int(env['BROWSER_TOTAL_SHARDS'])
        if groups != list(range(1,total+1)):
            raise ValueError('shard matrix must enumerate every test partition exactly once')
        budget=int(env[f'{variable}_BUDGET_SECONDS'])
        if budget+240 >= int(job['timeout-minutes'])*60:
            raise ValueError('internal timeout must leave setup and diagnostic headroom')
        helper=f'scripts/free2z/ci-{name if name=="backend" else "browser"}-'+('pytest.sh' if name=='backend' else 'shard.sh')
        runners=[s for s in job['steps'] if helper in s.get('run','') and 'test-ci-' not in s.get('run','')]
        if len(runners)!=1:
            raise ValueError('each shard must invoke its bounded runner once')
        runner=runners[0]
        if name=='backend' and any(k.startswith('BACKEND_') for k in runner.get('env',{})):
            raise ValueError('step must not override backend budget or command')
        if name=='ui-browser' and runner.get('env',{}).get('BROWSER_SHARD')!='${{ matrix.shard }}':
            raise ValueError('browser runner must bind its matrix shard')
        if name=='ui-browser' and set(runner.get('env',{})) != {'BROWSER_SHARD'}:
            raise ValueError('step must not override browser budget or total')
    registration = [s for s in jobs['backend']['steps'] if 'check-periodic-register-first.py' in s.get('run', '')]
    if len(registration) != 1 or registration[0].get('if') != 'matrix.group == 1' or 'continue-on-error' in registration[0]:
        raise ValueError('backend must enforce cross-revision periodic task registration')
    registration_command = registration[0]['run']
    if '--base "$BASE_SHA" --head HEAD' not in registration_command or 'github.event.merge_group.base_sha' not in registration[0].get('env', {}).get('BASE_SHA', ''):
        raise ValueError('periodic registration must compare the selected PR or merge-group base')
    version=re.search(r'^FROM python:([0-9]+\.[0-9]+)',dockerfile,re.M)[1]
    for name in ('backend','dependency-security'):
        pins=[str(s.get('with',{}).get('python-version','')) for s in jobs[name]['steps'] if s.get('uses','').startswith('actions/setup-python@')]
        if pins!=[version]:raise ValueError('CI Python must equal the application runtime')
    target=re.search(r'^target-version = "py([0-9]+)"',ruff,re.M)[1]
    if target!=version.replace('.',''):raise ValueError('lint target must equal the application runtime')
    if release['permissions']!={'contents':'read'}:raise ValueError('release default permissions must be read-only')
    checks=release['jobs']['checks']
    if checks['uses']!='./.github/workflows/free2z-web-ci.yml' or checks['if']!="github.repository == 'free2z/zuu' && github.ref == 'refs/heads/main' && github.ref_protected":
        raise ValueError('release must run the exact protected-main source checks')
    publish=release['jobs']['publish']
    if publish['needs']!='checks':raise ValueError('publishing must await application checks')
    commands='\n'.join(s.get('run','') for s in publish['steps'])
    if re.search(r'\b(npm|pip|pip3|pytest)\b|docker (run|build)',commands):
        raise ValueError('publisher must not execute application code or dependency installation')
    if 'test "$APPLICATION_COMPLETE" = true' not in commands:raise ValueError('scaffold cannot publish a release')
    if 'DOCKER_CONFIG="$anonymous_config" docker manifest inspect' not in commands:raise ValueError('release images must be anonymously consumable')
    final=release['jobs']['release']
    if set(final['needs'])!={'checks','publish'}:raise ValueError('release manifest must await checks and all image publications')


def check(root):
    validate(yaml.safe_load((root/'.github/workflows/free2z-web-ci.yml').read_text()),yaml.safe_load((root/'.github/workflows/free2z-web-release.yml').read_text()),(root/'build/free2z/backend.Dockerfile').read_text(),(root/'ruff.toml').read_text())


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[2])
    check(parser.parse_args().root)
    print('Website CI coverage, runtime and release authority contracts passed')
