#!/usr/bin/env node
// Reviewed source identity for wallet Android Gradle builds, not a build verdict.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Bump SDK and re-review every affected Gradle file together; update hashes after
// inspecting the entire build, including root/buildSrc configuration and overrides.
const sdk = 36;
const reviewed = {
  'wallet/e2e2z/src-tauri/gen/android/app/build.gradle.kts': 'b9280cdc4a7385acaaaa94316113d648fedb29815fad345358a928d570230c96',
  'wallet/e2e2z/src-tauri/gen/android/build.gradle.kts': '9127a9c5f68472082082c6971299267f02bd057ce159cbeb2d46f8e8da23e5fc',
  'wallet/e2e2z/src-tauri/gen/android/buildSrc/build.gradle.kts': '30cbd42e953ac6f81de43e0528d6a70cba169045947df0bc4a09ad0cd78610e0',
  'wallet/free2z/src-tauri/gen/android/app/build.gradle.kts': 'f87112d935f68921873133f30ee661a8a7e0570a8dedfe358a80d3ae6e48184c',
  'wallet/free2z/src-tauri/gen/android/build.gradle.kts': 'f8d6b8ac33de9acbe318595de7be4500fec1009f8ea0edc508fd998cc15294c5',
  'wallet/free2z/src-tauri/gen/android/buildSrc/build.gradle.kts': '11818be939b3aa44d691228f8666fba5efc796cdc1b4fb8072ab7c91bc056eb0',
  'wallet/plugins/tauri-plugin-f2z/android/build.gradle.kts': 'd27f77836daff5c0171fd33ef722a495994a7f11447c52268e5e72953ebd50c7',
  'wallet/plugins/tauri-plugin-f2zmsg/android/build.gradle.kts': '1b0bc018f3203820ce741cc2c9641dfcd86d81371e87f1af9c0db37109ae5820',
  'wallet/plugins/tauri-plugin-zcash/android/build.gradle.kts': 'e5773796eee71d39c37fb0ced80d5777ccfd918fa7fa30613abcaf1f48dbd53a',
  'wallet/zuuli/src-tauri/gen/android/app/build.gradle.kts': '6e92cbf4d5c90e1d023628cfbffd296182d7fdbeda284be830d69b682aed0eff',
  'wallet/zuuli/src-tauri/gen/android/build.gradle.kts': '9127a9c5f68472082082c6971299267f02bd057ce159cbeb2d46f8e8da23e5fc',
  'wallet/zuuli/src-tauri/gen/android/buildSrc/build.gradle.kts': '30cbd42e953ac6f81de43e0528d6a70cba169045947df0bc4a09ad0cd78610e0',
};
// Explicit ownership disposition for first-party plugins without Android support.
const nonAndroidPlugins = new Set([]);
const hash = s => createHash('sha256').update(s).digest('hex');
function check(paths, read) {
  const errors = [];
  const builds = paths.filter(p => p.startsWith('wallet/') && p.includes('/android/') && /(?:^|\/)build\.gradle(?:\.kts)?$/.test(p));
  for (const p of builds) if (!(p in reviewed)) errors.push(`unreviewed Android build: ${p}`);
  for (const p of Object.keys(reviewed)) {
    if (!builds.includes(p)) { errors.push(`missing Android build: ${p}`); continue; }
    const source = read(p);
    if (hash(source) !== reviewed[p]) errors.push(`Android build changed; review and update identity: ${p}`);
    if (/\/app\/build\.gradle\.kts$/.test(p) || /^wallet\/plugins\//.test(p)) {
      if (!new RegExp(`^android \{\n(?:    [^\n]*\n)*?    compileSdk = ${sdk}$`, 'm').test(source))
        errors.push(`missing reviewed android compileSdk = ${sdk}: ${p}`);
    }
  }
  for (const p of paths.filter(p => /^wallet\/plugins\/[^/]+\/Cargo\.toml$/.test(p))) {
    const owner = p.split('/')[2];
    if (!(p.replace(/Cargo\.toml$/, 'android/build.gradle.kts') in reviewed) && !nonAndroidPlugins.has(owner)) errors.push(`unreviewed plugin Android ownership: ${p}`);
  }
  return errors;
}
const paths = execFileSync('git', ['ls-files', '--', 'wallet'], { encoding: 'utf8' }).trim().split('\n');
const read = p => readFileSync(p, 'utf8');
if (process.argv.includes('--self-test')) {
  if (check(paths, read).length) throw new Error('checked-in Android inventory is invalid');
  const target = 'wallet/zuuli/src-tauri/gen/android/app/build.gradle.kts';
  const original = read(target);
  const mutations = [
    original.replace('compileSdk = 36', '// compileSdk = 36\n    compileSdk = 35'),
    original.replace('compileSdk = 36', 'val decoy = """compileSdk = 36"""\n    compileSdk = 35'),
    original + '\nandroid.compileSdk = 35\n',
    original + '\nandroid { compileSdk = providers.gradleProperty("sdk").get().toInt() }\n',
    original + '\nandroid.setCompileSdkVersion(35)\n',
  ];
  for (const mutated of mutations) if (!check(paths, p => p === target ? mutated : read(p)).length) throw new Error('SDK mutation escaped');
  for (const extra of ['wallet/new/src-tauri/gen/android/app/build.gradle', 'wallet/plugins/new/android/build.gradle', 'wallet/plugins/new/Cargo.toml'])
    if (!check([...paths, extra], read).length) throw new Error(`ownership mutation escaped: ${extra}`);
  if (!check(paths.filter(p => p !== target), read).length) throw new Error('missing build escaped');
  console.log('Android SDK inventory self-test passed');
} else {
  const errors = check(paths, read);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Android compile SDK ${sdk}: reviewed ${Object.keys(reviewed).length} Android build files`);
}
