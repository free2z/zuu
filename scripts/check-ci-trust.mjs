#!/usr/bin/env node
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bootstrapStep, helperCommit, helperSha256 } from './ci-trust-bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = '.github/workflows';
const expectedPublishers = new Set(['zuuli-linux-image.yml', 'zuuli-store-capture-image.yml', 'f2z-images.yml']);
const buildkitImage = 'moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c';
const buildkitStep = `      - uses: docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0\n        with:\n          driver: docker-container\n          driver-opts: image=${buildkitImage}\n`;

const forbidden = new Set(['NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GIT_SSL_NO_VERIFY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'AWS_CA_BUNDLE', 'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE', 'CARGO_HTTP_CAINFO', 'RUSTUP_USE_CURL']);

function metadataLines(source) {
  const lines = [];
  let scalarIndent = null;
  for (const line of source.split("\n")) {
    const indent = line.match(/^ */)[0].length;
    if (scalarIndent !== null && (!line.trim() || indent > scalarIndent)) continue;
    scalarIndent = null;
    lines.push({line, indent});
    if (/:\s*[|>][+-]?(?:\s*#.*)?$/.test(line)) scalarIndent = indent;
  }
  return lines;
}

const reviewedWebsiteCall = "  checks:\n    if: github.repository == 'free2z/zuu' && github.ref == 'refs/heads/main' && github.ref_protected\n    uses: ./.github/workflows/free2z-web-ci.yml\n    permissions:\n      contents: read";

export function inspect(source, allowWebsiteCall = false) {
  const failures = [];
  const setupLines = [...source.matchAll(/^      (?:- |  )uses: docker\/setup-buildx-action@[^\n]+$/gmi)];
  const boundaries = [...source.matchAll(/^(?:      - |  [A-Za-z0-9_-]+:)/gm)].map(match => match.index);
  for (const setup of setupLines) {
    const start = boundaries.filter(index => index <= setup.index).at(-1);
    const end = boundaries.find(index => index > setup.index) ?? source.length;
    if (source.slice(start, end).split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trimEnd() + '\n' !== buildkitStep) failures.push('BuildKit must use the exact reviewed driver and immutable patched daemon image');
  }
  const lines = metadataLines(source);
  let nodeSelectors = 0;
  for (const [index, {line, indent}] of lines.entries()) {
    if (/^\s*(?:-\s+)?(?:["'][^"']+["']\s*:|<<:|!!|[?:]\s)/.test(line)) {
      failures.push('quoted, merged or tagged workflow mapping keys require review');
    }
    if (/^\s*(?:-\s+)?[A-Za-z_][\w-]*:\s*[&*]/.test(line)) {
      failures.push('workflow aliases or anchors require review');
    }
    if (!/^\s*env:/.test(line)) continue;
    if (!/^\s*env:\s*$/.test(line)) {
      failures.push('environment must use an explicit block mapping');
      continue;
    }
    for (const child of lines.slice(index + 1)) {
      if (!child.line.trim() || child.line.trimStart().startsWith('#')) continue;
      if (child.indent <= indent) break;
      if (child.indent !== indent + 2) {
        failures.push('environment must contain plain scalar keys');
        continue;
      }
      const entry = child.line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
      if (!entry) {
        failures.push('environment must contain plain scalar keys');
        continue;
      }
      const [, key] = entry;
      const portableKey = key.toUpperCase();
      if (forbidden.has(portableKey)) failures.push('custom roots or verification bypass requires review');
      if (portableKey === 'NODE_OPTIONS') {
        nodeSelectors++;
        if (indent !== 0 || child.line !== '  NODE_OPTIONS: --use-openssl-ca') failures.push('Node trust selection must have one workflow-level definition');
      }
    }
  }
  if (nodeSelectors !== 1) failures.push('workflow must select Node OpenSSL trust exactly once');
  const jobsSource = source.split(/^jobs:\s*\n/m);
  if (jobsSource.length !== 2) return [...failures, 'one jobs mapping required'];
  const starts = [...jobsSource[1].matchAll(/^  ([A-Za-z0-9_-]+):\s*\n/gm)];
  if (!starts.length) failures.push('no jobs inspected');
  for (const [index, match] of starts.entries()) {
    const job = jobsSource[1].slice(match.index, starts[index + 1]?.index ?? jobsSource[1].length);
    if (/^    services:/m.test(job)) failures.push(`${match[1]}: start services after bootstrap`);
    if (allowWebsiteCall && job.trimEnd() === reviewedWebsiteCall) continue;
    const steps = [...job.matchAll(/^    steps:\s*\n/gm)];
    if (steps.length !== 1) {
      failures.push(`${match[1]}: one runnable steps mapping required`);
      continue;
    }
    const after = job.slice(steps[0].index + steps[0][0].length);
    if (!after.startsWith(bootstrapStep)) failures.push(`${match[1]}: first step must be the exact immutable bootstrap`);
    if ((job.match(/name: Select verified CI trust before clients/g) ?? []).length !== 1) failures.push(`${match[1]}: bootstrap must execute exactly once`);
  }
  return failures;
}

function inspectWorkflow(file, source) {
  const failures = inspect(source, file === 'free2z-web-release.yml');
  const count = source.split(buildkitStep).length - 1;
  if (expectedPublishers.has(file) && count !== 2) failures.push('require both reviewed BuildKit publisher setups');
  return failures;
}

function validate() {
  const failures = [];
  for (const file of readdirSync(resolve(root, workflowDirectory)).filter(file => /\.ya?ml$/.test(file))) {
    const source = readFileSync(resolve(root, workflowDirectory, file), 'utf8');
    for (const failure of inspectWorkflow(file, source)) failures.push(`${file}: ${failure}`);
  }
  if (!bootstrapStep.includes(`/${helperCommit}/`) || !bootstrapStep.includes(helperSha256) || !bootstrapStep.includes(`'--source-commit', '${helperCommit}'`)) failures.push('immutable helper source/hash/asset binding missing');
  return failures;
}

function launcherRuntimeControls() {
  const temporary = mkdtempSync(join(tmpdir(), 'zuu-ci-trust-launcher-'));
  try {
    for (const name of ['python', 'python3']) {
      const target = join(temporary, name);
      writeFileSync(target, `#!/bin/sh\nprintf '${name}:%s\\n' "$*"\n`);
      chmodSync(target, 0o700);
    }
    const launcher = bootstrapStep.split('\n').find(line => line.includes('ci_python=python;'))?.trim();
    if (!launcher) throw new Error('Canonical Python launcher missing');
    for (const runner of ['Windows', 'Linux', 'macOS']) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c', launcher + '\n"$ci_python" -I -'], {
        env: {...process.env, RUNNER_OS: runner, PATH: temporary + ':/bin:/usr/bin'}, encoding: 'utf8', timeout: 5_000,
      });
      const expected = (runner === 'Windows' ? 'python' : 'python3') + ':-I -';
      if (result.status !== 0 || result.stdout.trim() !== expected) throw new Error('Python launcher selected the wrong executable');
    }
    console.log('actual Bash launcher: 3 platform controls passed');
  } finally { rmSync(temporary, {recursive: true, force: true}); }
}

function loaderRuntimeControls() {
  const temporary = mkdtempSync(join(tmpdir(), 'zuu-ci-trust-loader-'));
  try {
    const code = bootstrapStep.split("          \"$ci_python\" -I - <<'PY'\n")[1].split('          PY\n')[0].split('\n').map(line => line.slice(10)).join('\n');
    const harness = String.raw`
import contextlib, hashlib, io, json, os, pathlib, subprocess, sys, tempfile, urllib.request
payload = b"import json, pathlib, sys\npathlib.Path(__file__).with_suffix('.ran').write_text(json.dumps(sys.argv[1:]))\n"
source = json.loads(sys.stdin.read())
source = source.replace('${helperSha256}', hashlib.sha256(payload).hexdigest())
for scenario in ('host', 'container', 'checksum', 'redirect', 'existing', 'unknown-mode'):
 with tempfile.TemporaryDirectory(dir=sys.argv[1]) as directory:
  target = pathlib.Path(directory) / 'corpora-ci-trust-bootstrap.py'
  marker = target.with_suffix('.ran')
  if scenario == 'existing': target.write_bytes(b'existing content')
  os.environ['RUNNER_TEMP'] = directory
  os.environ['CI_TRUST_CONTAINER'] = '1' if scenario == 'container' else ('unexpected' if scenario == 'unknown-mode' else '0')
  response = io.BytesIO(payload + (b'tampered' if scenario == 'checksum' else b''))
  response.url = 'wrong-redirect' if scenario == 'redirect' else 'https://raw.githubusercontent.com/corpora-inc/encorpora/${helperCommit}/.github/scripts/ci_trust.py'
  class Opener:
   def open(self, *args, **kwargs): return response
  original = urllib.request.build_opener
  urllib.request.build_opener = lambda *args, **kwargs: Opener()
  try:
   try:
    exec(compile(source, '<actual-inline-bootstrap>', 'exec'), {})
    passed = True
   except (SystemExit, FileExistsError): passed = False
   expected = scenario in ('host', 'container')
   if passed != expected or marker.exists() != expected: raise RuntimeError('Loader control failed: ' + scenario)
   if expected:
    actual = json.loads(marker.read_text())
    if actual != (['--source-commit', '${helperCommit}'] + (['--clients-only'] if scenario == 'container' else [])): raise RuntimeError('Wrong execution mode')
    if target.stat().st_mode & 0o777 != 0o600: raise RuntimeError('Loader file is not private')
   elif scenario in ('checksum','redirect','unknown-mode') and target.exists(): raise RuntimeError('Invalid source activated')
   elif scenario == 'existing' and target.read_bytes() != b'existing content': raise RuntimeError('Existing state changed')
  finally: urllib.request.build_opener = original
print('actual inline loader: 6 runtime controls passed')
`;
    const result = spawnSync('python3', ['-I', '-c', harness, temporary], {input: JSON.stringify(code), encoding: 'utf8', timeout: 20_000});
    if (result.status !== 0) throw new Error(`Inline loader controls failed: ${result.stderr || result.error || result.status}`);
    console.log(result.stdout.trim());
  } finally { rmSync(temporary, {recursive: true, force: true}); }
}

function selfTest() {
  const baseline = `name: fixture\nenv:\n  NODE_OPTIONS: --use-openssl-ca\njobs:\n  fixture:\n    runs-on: ubuntu-24.04\n    steps:\n${bootstrapStep}      - uses: actions/checkout@${'a'.repeat(40)}\n`;
  if (inspect(baseline).length) throw new Error('Valid workflow fixture rejected');
  const reusable = baseline.replace(/  fixture:[\s\S]*$/, reviewedWebsiteCall + '\n');
  if (inspect(reusable, true).length || !inspect(reusable).length) throw new Error('Reusable website allowlist rejected or widened');
  for (const changed of [reusable.replace('contents: read', 'contents: write'), reusable.replace('web-ci.yml', 'other.yml'), reusable + '    secrets: inherit\n']) {
    if (!inspect(changed, true).length) throw new Error('Unreviewed reusable workflow accepted');
  }
  const cases = [
    [baseline.replace(bootstrapStep, ''), 'first step'],
    [baseline.replace(bootstrapStep, '      - run: curl https://example.com/\n' + bootstrapStep), 'first step'],
    [baseline.replace('        shell: bash', '        if: false\n        shell: bash'), 'first step'],
    [baseline.replace(helperCommit, 'main'), 'first step'],
    [baseline.replace(helperSha256, '0'.repeat(64)), 'first step'],
    [baseline.replace(`, '--source-commit', '${helperCommit}'`, ''), 'first step'],
    [baseline.replace(`'--source-commit', '${helperCommit}'`, `'--source-commit', '${'0'.repeat(40)}'`), 'first step'],
    [baseline.replace('  NODE_OPTIONS: --use-openssl-ca\n', ''), 'workflow must select'],
    [baseline.replace('    steps:', '    env:\n      NODE_OPTIONS: --use-bundled-ca\n    steps:'), 'one workflow-level'],
    [baseline.replace('    steps:', '    services:\n      fixture: {}\n    steps:'), 'start services'],
    [baseline.replace('    steps:', '    env: {NODE_OPTIONS: --use-bundled-ca}\n    steps:'), 'explicit block mapping'],
    [baseline.replace('    steps:', '    env:\n      "NODE_OPTIONS": --use-bundled-ca\n    steps:'), 'quoted'],
    [baseline.replace('    steps:', '    "env": {NODE_OPTIONS: --use-bundled-ca}\n    steps:'), 'quoted'],
    [baseline.replace('    steps:', '    <<: *unreviewed\n    steps:'), 'merged'],

    [baseline.replace("job.container.id != '' && '1' || '0'", "'0'"), 'first step'],
    [baseline.replace('    steps:', '    env:\n      NODE_EXTRA_CA_CERTS: /old-roots.pem\n    steps:'), 'custom roots'],
    [baseline.replace('    steps:', '    env:\n      SSL_CERT_FILE: /old-roots.pem\n    steps:'), 'custom roots'],
    [baseline.replace('    steps:', '    env:\n      ssl_cert_file: /old-roots.pem\n    steps:'), 'custom roots'],
    [baseline.replace('    steps:', '    env:\n      node_options: --use-bundled-ca\n    steps:'), 'one workflow-level'],
    [baseline.replace('    steps:', '    env:\n      NODE_TLS_REJECT_UNAUTHORIZED: "0"\n    steps:'), 'verification bypass'],
    [baseline.replace('    steps:', '    steps:\n' + bootstrapStep), 'exactly once'],
  ];
  const publisher = baseline + buildkitStep;
  if (inspect(publisher).length) throw new Error('Reviewed BuildKit fixture rejected');
  for (const replacement of [
    buildkitStep.replace('          driver: docker-container\n', ''),
    buildkitStep.replace(buildkitImage, 'moby/buildkit:latest'),
    buildkitStep.replace('docker/setup-buildx-action', 'Docker/setup-buildx-action'),
    buildkitStep.replace('docker-container', 'docker'),
    buildkitStep.replace('driver-opts: image=', 'driver-opts: ignored='),
    buildkitStep + '          driver-opts: image=moby/buildkit:latest\n',
    buildkitStep.replace('        with:\n', '        if: false\n        with:\n'),
  ]) cases.push([baseline + replacement, 'BuildKit']);
  cases.push([baseline.replace('ci_python=python;', 'ci_python=python3;'), 'first step']);
  for (const [source, expected] of cases) {
    if (!inspect(source).some(failure => failure.includes(expected))) throw new Error(`Mutation accepted: ${expected}`);
  }
  let publisherControls = 0;
  for (const file of expectedPublishers) {
    const actual = readFileSync(resolve(root, workflowDirectory, file), 'utf8');
    for (const position of ['first', 'second']) {
      const index = position === 'first' ? actual.indexOf(buildkitStep) : actual.lastIndexOf(buildkitStep);
      if (index < 0) throw new Error('Publisher setup mutation target absent');
      const removed = actual.slice(0, index) + actual.slice(index + buildkitStep.length);
      if (!inspectWorkflow(file, removed).some(failure => failure.includes('both reviewed'))) throw new Error('Dropped publisher daemon pin accepted');
      publisherControls++;
    }
  }
  console.log(`BuildKit publisher inventory: ${publisherControls} actual workflow removal controls passed`);
  launcherRuntimeControls();
  loaderRuntimeControls();
  console.log(`CI trust policy: ${cases.length} mutation controls passed`);
}

const failures = validate();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
if (process.argv.includes('--self-test')) selfTest();
console.log('All workflow jobs select the reviewed pre-checkout trust bootstrap');
