import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('real temporary Java stores preserve safe roots, metadata and invalid-input guards', () => {
  const result = spawnSync('python3', [resolve(root, '.github/scripts/test_java_trust.py')], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('JVM network jobs repair trust before SDK or Gradle; signers keep repository code excluded', () => {
  let repairs = 0, localSigners = 0;
  for (const name of ['zuuli.yml', 'zuuli-packaging.yml', 'zuuli-release.yml', 'free2z-release.yml', 'e2e2z-release.yml']) {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows', name), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (!String(step.uses).startsWith('actions/setup-java@')) continue;
        if (jobName === 'android-sign-upload') {
          localSigners++;
          assert(!steps.some(s => String(s.uses).startsWith('actions/checkout@')));
          assert(!steps.some(s => /(?:sdkmanager|gradlew|\bgradle\s)/.test(s.run ?? '')));
          continue;
        }
        repairs++;
        const repair = steps[index + 1];
        assert.equal(repair.name, 'Remove distrusted Java CA roots', name + '/' + jobName);
        assert.equal(repair.run, 'sudo "$JAVA_HOME/bin/java" "$GITHUB_WORKSPACE/.github/scripts/RemoveDistrustedRoots.java" "$JAVA_HOME/lib/security/cacerts"');
        assert.equal(repair.if, step.if);
        assert(['ubuntu-latest', 'ubuntu-24.04'].includes(job['runs-on']) || (jobName === 'sdk_mobile' && job.strategy.matrix.include.find(m => m.platform === 'android').os === 'ubuntu-latest'), 'privileged repair must run on the reviewed Linux builder');
      }
    }
  }
  assert.equal(repairs, 6); assert.equal(localSigners, 3);
});
