#!/usr/bin/env python3
"""Validate website shard coverage, runtime versions and release authority."""
from pathlib import Path
import argparse
import re
import posixpath
import yaml


def validate_producer_build_inputs(root):
    """The web image must carry the same local source package as npm/CI."""
    ci = yaml.safe_load((root / '.github/workflows/free2z-web-ci.yml').read_text())
    compose = yaml.safe_load((root / 'build/free2z/compose.yml').read_text())
    builds = [s for s in ci['jobs']['images']['steps'] if s.get('uses', '').startswith('docker/build-push-action@')]
    if len(builds) != 1 or builds[0]['with']['context'] != '.':
        raise ValueError('web image requires the repository context for its declared producer package')
    if compose['services']['web']['build']['context'] != '../..' or compose['services']['web']['build']['dockerfile'] != 'build/free2z/web.Dockerfile':
        raise ValueError('local web image must use the same repository context')
    docker = (root / 'build/free2z/web.Dockerfile').read_text()
    for instruction in (
        'WORKDIR /src/ts/svelte/free2z',
        'WORKDIR /app/ts/svelte/free2z',
        'COPY ts/svelte/free2z/package*.json ./',
        'COPY ts/free2z/producer/ /src/ts/free2z/producer/',
        'COPY ts/svelte/free2z/ ./',
        'COPY ts/free2z/producer/ /app/ts/free2z/producer/',
        'COPY --from=builder /src/ts/svelte/free2z/build ./build',
        'RUN ln -s ts/svelte/free2z/build /app/build',
    ):
        if instruction not in docker.splitlines():
            raise ValueError('web producer build input is missing: ' + instruction)
    validate_producer_lock_identity('/src/ts/svelte/free2z', '/src/ts/free2z/producer')
    validate_producer_lock_identity('/app/ts/svelte/free2z', '/app/ts/free2z/producer')
    expected = ('**', '!ts/', '!ts/svelte/', '!ts/svelte/free2z/', '!ts/svelte/free2z/**',
                '!ts/free2z/', '!ts/free2z/producer/', '!ts/free2z/producer/**',
                '**/node_modules', '**/.svelte-kit', '**/build', '**/.vite', '**/.env', '**/.env.*', '**/npm-debug.log*')
    ignore = tuple((root / 'build/free2z/web.Dockerfile.dockerignore').read_text().splitlines())
    if ignore != expected:
        raise ValueError('web context must admit only application/producer source and exclude local dependencies and secrets')


def validate_producer_lock_identity(app, producer):
    if posixpath.relpath(producer, app) != '../../free2z/producer':
        raise ValueError('web install layout changes the canonical producer lock identity')


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
    parity = [s for s in jobs['backend']['steps'] if 'test_periodic_register_first.py::' in s.get('run', '')]
    if len(parity) != 1 or parity[0].get('if') != 'matrix.group == 1' or 'continue-on-error' in parity[0]:
        raise ValueError('backend must execute live task registry parity checks')
    if any(name not in parity[0]['run'] for name in ('::test_static_scan_finds_exactly_the_registered_schedules', '::test_static_scan_sees_every_registered_task_name')):
        raise ValueError('both schedule and registration parity checks are required')
    triggers = ci.get('on', ci.get(True, {}))
    if 'merge_group' not in triggers:
        raise ValueError('merge queue must run the required website gate')
    backend_steps = jobs['backend']['steps']
    selection = [s for s in backend_steps if s.get('id') == 'backend-browser']
    if len(selection) != 1 or selection[0].get('run') != 'python ../../scripts/free2z/select-backend-browser.py' or any(k in selection[0] for k in ('if', 'continue-on-error')):
        raise ValueError('every backend shard must collect its exact browser dependency selection')
    browser_if = "steps.backend-browser.outputs.required == 'true'"
    node_if = "matrix.group == 1 || " + browser_if
    node = [s for s in backend_steps if s.get('uses', '').startswith('actions/setup-node@')]
    renderer = [s for s in backend_steps if s.get('run') == 'npm ci' and s.get('working-directory') == 'ts/svelte/free2z']
    browser = [s for s in backend_steps if s.get('run') == 'npx --no-install playwright install --with-deps chromium']
    controls = [s for s in backend_steps if s.get('run') == 'python ../../scripts/free2z/test-select-backend-browser.py']
    if len(node) != 1 or node[0].get('if') != node_if or node[0].get('with', {}).get('cache-dependency-path') != 'ts/svelte/free2z/package-lock.json':
        raise ValueError('browser-selected backend shards require the renderer Node/lock setup')
    if len(renderer) != 1 or renderer[0].get('if') != node_if or 'continue-on-error' in renderer[0]:
        raise ValueError('browser-selected backend shards must install the exact renderer lock')
    if len(browser) != 1 or browser[0].get('if') != browser_if or browser[0].get('working-directory') != 'ts/svelte/free2z' or 'continue-on-error' in browser[0]:
        raise ValueError('backend producer integration requires matching Chromium and OS dependencies')
    if len(controls) != 1 or controls[0].get('if') != 'matrix.group == 1' or 'continue-on-error' in controls[0]:
        raise ValueError('backend browser selection must execute its real allocation controls')
    runner = next(s for s in backend_steps if 'scripts/free2z/ci-backend-pytest.sh' in s.get('run', ''))
    if not backend_steps.index(selection[0]) < backend_steps.index(node[0]) < backend_steps.index(renderer[0]) < backend_steps.index(browser[0]) < backend_steps.index(runner):
        raise ValueError('browser selection/setup must precede the real backend test runner')
    exports = [s for s in jobs['backend']['steps'] if 'export-task-registry.py' in s.get('run', '')]
    if len(exports) != 1 or exports[0].get('if') != 'matrix.group == 1' or 'continue-on-error' in exports[0] or jobs['backend']['steps'].index(exports[0]) <= jobs['backend']['steps'].index(parity[0]):
        raise ValueError('source-bound inventory must follow successful live registry parity')
    image_builds = [s for s in jobs['images']['steps'] if s.get('uses', '').startswith('docker/build-push-action@')]
    if len(image_builds) != 1 or any(image_builds[0]['with'].get(key) != value for key, value in {'platforms': 'linux/amd64', 'provenance': False, 'sbom': False}.items()):
        raise ValueError('published image digest must identify one platform manifest')
    image_steps = jobs['images']['steps']
    if any(s.get('uses', '').startswith('anchore/sbom-action@') for s in image_steps):
        raise ValueError('SBOM action must not reintroduce its mutable remote installer')
    sbom_generators = [s for s in image_steps if 'scripts/free2z/install-syft.py' in s.get('run', '')]
    normalizers = [s for s in image_steps if 'prepare-image-sbom.py prepare' in s.get('run', '')]
    exports = [s for s in image_steps if 'docker save ' in s.get('run', '')]
    if len(sbom_generators) != 1 or len(normalizers) != 1 or len(exports) != 1:
        raise ValueError('image inventory must be generated and validated before export')
    generator, normalizer, export = sbom_generators[0], normalizers[0], exports[0]
    expected_env = {'IMAGE_ID': '${{ steps.image-identity.outputs.id }}', 'SYFT_CHECK_FOR_APP_UPDATE': 'false'}
    expected_scan = '\n'.join(('set -euo pipefail',
                              'python3 scripts/free2z/install-syft.py "$RUNNER_TEMP/free2z-syft"',
                              'printf \'{}\\n\' > "$RUNNER_TEMP/free2z-syft/config.yaml"',
                              '"$RUNNER_TEMP/free2z-syft/syft" scan "docker:$IMAGE_ID" --config "$RUNNER_TEMP/free2z-syft/config.yaml" --output spdx-json=image.original.spdx.json'))
    if generator.get('run', '').strip() != expected_scan or generator.get('env') != expected_env or any(key in step for step in (generator, normalizer) for key in ('if', 'continue-on-error')):
        raise ValueError('complete checksum-pinned Syft inventory and validation must be mandatory')
    snapshots = [s for s in image_steps if s.get('id') == 'image-identity']
    if len(snapshots) != 1 or image_steps.index(snapshots[0]) >= image_steps.index(generator) or any(key in snapshots[0] for key in ('if', 'continue-on-error')):
        raise ValueError('record actual image identity before cataloging')
    if any(fragment not in snapshots[0].get('run', '') for fragment in ('docker image inspect "free2z-$KIND:candidate"', "'{{.Id}}'", '> image-config.digest', '>> "$GITHUB_OUTPUT"', "printf 'id=%s")):
        raise ValueError('SBOM scan must receive the inspected immutable local image ID')
    if not image_steps.index(generator) < image_steps.index(normalizer) < image_steps.index(export):
        raise ValueError('SBOM size/profile check must precede image artifact export')
    for fragment in ('docker image inspect "free2z-$KIND:candidate" --format',
                     "'{{.Id}}'", 'prepare image.original.spdx.json --image-id "$image_id" --image-config image-config.digest --output image.spdx.json --binding image-sbom-binding.json'):
        if fragment not in normalizer['run']:
            raise ValueError('SBOM must bind the actual tested image configuration')
    if 'mv image.spdx.json image.original.spdx.json image-sbom-binding.json image-bundle/' not in export['run']:
        raise ValueError('retain original inventory alongside its lossless predicate')
    static_audits = jobs['dependency-security-static']
    if set(static_audits['strategy']['matrix']['project']) != {'ts/react/free2z', 'docs/about-free2z', 'docs/free2z/website'}:
        raise ValueError('every static website dependency graph must be audited')
    audit_steps = [s for s in static_audits['steps'] if s.get('run') == 'bash scripts/free2z/run-dependency-audits.sh']
    if len(audit_steps) != 1 or audit_steps[0].get('env') != {'NPM_AUDIT_PROJECT': '${{ matrix.project }}', 'DEPENDENCY_AUDIT_NPM_ONLY': '1'} or 'continue-on-error' in audit_steps[0]:
        raise ValueError('static audit matrix must run the fail-closed scanner')
    installer = 'scripts/free2z/install-python-tool-lock.py'
    for job_name, kinds in (('dependency-security', ('ci-audit', 'ci-policy', 'lock-tools', 'language-data')), ('lint-python', ('ci-lint',)), ('changes', ('ci-policy',))):
        commands = '\n'.join(s.get('run', '') for s in jobs[job_name]['steps'])
        if re.search(r'\bpip install\b', commands):
            raise ValueError('CI tool installation must use isolated hash locks')
        for kind in kinds:
            steps = [s for s in jobs[job_name]['steps'] if f'{installer} {kind}' in s.get('run', '')]
            if len(steps) != 1 or any(key in steps[0] for key in ('if', 'continue-on-error')):
                raise ValueError('every CI/developer tool lock needs required installation coverage')
        if job_name == 'dependency-security':
            for kind in ('lock-tools', 'language-data'):
                if f'{installer} {kind} --verify-only' not in commands:
                    raise ValueError('developer artifact checks must clean their isolated environments')
            if 'PYTHON="$CI_AUDIT_PYTHON" ./scripts/free2z/run-dependency-audits.sh' not in commands:
                raise ValueError('audit must execute its installed isolated scanner')
            if 'for kind in test ci-audit ci-lint ci-policy;' not in commands:
                raise ValueError('every constrained input must be checked against its hash lock')
    registration = [s for s in jobs['backend']['steps'] if 'check-periodic-register-first.py' in s.get('run', '')]
    if len(registration) != 1 or registration[0].get('if') != 'matrix.group == 1' or 'continue-on-error' in registration[0]:
        raise ValueError('backend must enforce cross-revision periodic task registration')
    registration_command = registration[0]['run']
    if '--base "$BASE_SHA" --head HEAD' not in registration_command or 'github.event.merge_group.base_sha' not in registration[0].get('env', {}).get('BASE_SHA', ''):
        raise ValueError('periodic registration must compare the selected PR or merge-group base')
    native = jobs['native-payment-bridge']
    if native['env'].get('PAYMENTD_NATIVE_BRIDGE_TEST') != '1':
        raise ValueError('native financial bridge tests must execute rather than skip')
    native_commands = '\n'.join(s.get('run', '') for s in native['steps'])
    if 'cargo test --locked --test financial_delivery --test production_handoff_fixture --no-run' not in native_commands or 'python -m pytest dj/apps/g12f/test_paymentd_native_credit.py -q' not in native_commands:
        raise ValueError('native bridge must compile both fixtures and execute SQL integration tests')
    version=re.search(r'^FROM python:([0-9]+\.[0-9]+)',dockerfile,re.M)[1]
    for name in ('backend','dependency-security','native-payment-bridge','changes','lint-python'):
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
    if 'Release digest must identify one linux/amd64 image manifest' not in commands or '{{.Os}}/{{.Architecture}}' not in commands:
        raise ValueError('publisher must verify platform and reject image indexes')
    publication = [s for s in publish['steps'] if 'docker push ' in s.get('run', '')]
    if len(publication) != 1:
        raise ValueError('expected one checked image publication')
    command = publication[0]['run']
    check_command = 'python3 scripts/free2z/prepare-image-sbom.py check image-bundle/image.spdx.json --image-id "$image_id" --binding image-bundle/image-sbom-binding.json'
    if check_command not in command or not command.index('docker load ') < command.index(check_command) < command.index('docker push '):
        raise ValueError('publisher must recheck SBOM against loaded image before push')
    sbom_attestations = [s for s in publish['steps'] if s.get('with', {}).get('predicate-type') == 'https://spdx.dev/Document']
    expected_attestation = {'subject-name': '${{ steps.image.outputs.repository }}',
                            'subject-digest': '${{ steps.image.outputs.digest }}',
                            'predicate-type': 'https://spdx.dev/Document',
                            'predicate-path': 'image-bundle/image.spdx.json',
                            'push-to-registry': True}
    if len(sbom_attestations) != 1 or sbom_attestations[0].get('with') != expected_attestation or any(key in sbom_attestations[0] for key in ('if', 'continue-on-error')):
        raise ValueError('complete SBOM attestation must bind the exact published image digest')
    final=release['jobs']['release']
    final_commands = '\n'.join(s.get('run', '') for s in final['steps'])
    if '--task-registry task-registry/task-registry.json' not in final_commands:
        raise ValueError('release manifest must bind the verified task registry')
    if set(final['needs'])!={'checks','publish'}:raise ValueError('release manifest must await checks and all image publications')


def check(root):
    validate_producer_build_inputs(root)
    validate(yaml.safe_load((root/'.github/workflows/free2z-web-ci.yml').read_text()),yaml.safe_load((root/'.github/workflows/free2z-web-release.yml').read_text()),(root/'build/free2z/backend.Dockerfile').read_text(),(root/'ruff.toml').read_text())


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[2])
    check(parser.parse_args().root)
    print('Website CI coverage, runtime and release authority contracts passed')
