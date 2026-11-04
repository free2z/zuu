import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CAPTURE_CA_SHA256 = '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAPTURE_TLS_ENVIRONMENT = Object.freeze({
  NODE_OPTIONS: '--use-openssl-ca',
  SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
  SSL_CERT_DIR: '/etc/ssl/verified-empty',
  CURL_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
  CARGO_HTTP_CAINFO: '/etc/ssl/certs/ca-certificates.crt',
});
// Replace the default bundle and hashed fallback before any package fetch.
// The browser/tool versions stay pinned; only their certificate trust changes.
export const CAPTURE_TLS_BOOTSTRAP = `printf '%s  %s\\n' '${CAPTURE_CA_SHA256}' /run/capture-ca.pem | sha256sum -c - && rm -rf /etc/ssl/certs /etc/ssl/verified-empty && mkdir -p /etc/ssl/certs /etc/ssl/verified-empty && install -m 0644 /run/capture-ca.pem /etc/ssl/certs/ca-certificates.crt`;
export async function captureTlsDockerArguments(root = projectRoot) {
  const path = resolve(root, 'scripts/tls/ca-certificates.pem');
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), CAPTURE_CA_SHA256, 'capture CA bundle checksum mismatch');
  return [...Object.entries(CAPTURE_TLS_ENVIRONMENT).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--volume', `${path}:/run/capture-ca.pem:ro`];
}
export async function assertCaptureTlsRuntime() {
  for (const [name, value] of Object.entries(CAPTURE_TLS_ENVIRONMENT)) assert.equal(process.env[name], value, `capture TLS environment differs: ${name}`);
  assert.equal(createHash('sha256').update(await readFile(CAPTURE_TLS_ENVIRONMENT.SSL_CERT_FILE)).digest('hex'), CAPTURE_CA_SHA256, 'runtime CA bundle checksum mismatch');
  assert.deepEqual(await readdir(CAPTURE_TLS_ENVIRONMENT.SSL_CERT_DIR), [], 'capture CA fallback directory must be empty');
  assert.deepEqual(await readdir('/etc/ssl/certs'), ['ca-certificates.crt'], 'default CA paths must contain only the verified bundle');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  assert.deepEqual(process.argv.slice(2), ['--verify-runtime']);
  await assertCaptureTlsRuntime();
}
