"""Verify and retain public website evidence before opening its backend image."""
import importlib.util
import json
import re
import subprocess
import urllib.request
import zipfile

from .package import digest

REPOSITORY = 'free2z/zuu'
WORKFLOW = '.github/workflows/free2z-web-release.yml'
REPOSITORY_ID, OWNER_ID = '463741105', '102555797'
MAX_JSON = 16 * 1024 ** 2


def command(args, **kwargs):
    value = subprocess.check_output([str(arg) for arg in args], timeout=180, **kwargs)
    if len(value) > MAX_JSON:
        raise ValueError('verification output exceeds limit')
    return value


def read(path, maximum):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValueError('missing or oversized evidence file')
    return path.read_bytes()


def matches_certificate(results, build):
    invocation = f"https://github.com/{REPOSITORY}/actions/runs/{build['run_id']}/attempts/{build['run_attempt']}"
    if not isinstance(results, list) or not any(
            result.get('verificationResult', {}).get('signature', {}).get('certificate', {}).get('runInvocationURI') == invocation
            and result.get('verificationResult', {}).get('signature', {}).get('certificate', {}).get('sourceRepositoryIdentifier') == REPOSITORY_ID
            and result.get('verificationResult', {}).get('signature', {}).get('certificate', {}).get('sourceRepositoryOwnerIdentifier') == OWNER_ID
            for result in results):
        raise ValueError('attestation does not bind the expected run and numeric repository identity')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('unexpected registry redirect')


def backend_manifest(repository, expected):
    if not re.fullmatch(r'ghcr.io/free2z/free2z-(backend|web|static)', repository):
        raise ValueError('unexpected image repository')
    name = repository.removeprefix('ghcr.io/')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('https://ghcr.io/token?service=ghcr.io&scope=repository:' + name + ':pull', timeout=60) as response:
        token_data = response.read(65537)
    if len(token_data) > 65536:
        raise ValueError('registry token response too large')
    token = json.loads(token_data)['token']
    request = urllib.request.Request('https://ghcr.io/v2/' + name + '/manifests/' + expected,
                                    headers={'Authorization': 'Bearer ' + token,
                                             'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    with opener.open(request, timeout=60) as response:
        data = response.read(4 * 1024 ** 2 + 1)
    if len(data) > 4 * 1024 ** 2 or digest(data) != expected:
        raise ValueError('registry image manifest digest mismatch')
    value = json.loads(data)
    if 'manifests' in value or value.get('mediaType') not in (
            'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'):
        raise ValueError('image digest must identify a single image manifest')
    return data


def verify(repository, gh, tag, commit, destination):
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(
            r'free2z-web-' + commit + r'-[1-9][0-9]{0,19}-[1-9][0-9]{0,3}', tag):
        raise ValueError('web release tag must match this protected-main workflow commit')
    destination.mkdir(mode=0o700)
    command([gh, 'release', 'download', tag, '--repo', REPOSITORY,
             '--pattern', 'free2z-release.zip', '--dir', destination])
    archive = destination / 'free2z-release.zip'
    if archive.stat().st_size > 8 * 1024 ** 2:
        raise ValueError('website evidence archive too large')
    names = {'release.json': 65536, 'static-assets.json': 4 * 1024 ** 2,
             'release.intoto.jsonl': 2 * 1024 ** 2}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != len(names) or {entry.filename for entry in entries} != set(names):
            raise ValueError('unexpected website evidence inventory')
        for entry in entries:
            if entry.file_size > names[entry.filename] or entry.is_dir():
                raise ValueError('website evidence member too large')
            (destination / entry.filename).write_bytes(bundle.read(entry))
    archive.unlink()
    spec = importlib.util.spec_from_file_location('website_manifest', repository / 'scripts/free2z/release-manifest.py')
    website = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(website)
    manifest_bytes = read(destination / 'release.json', 65536)
    manifest = website.validate(json.loads(manifest_bytes))
    build = manifest['build']
    if manifest['source']['commit'] != commit or tag != f"free2z-web-{commit}-{build['run_id']}-{build['run_attempt']}":
        raise ValueError('website source or invocation differs from host workflow')
    policy = ['--repo', REPOSITORY, '--signer-workflow', REPOSITORY + '/' + WORKFLOW,
              '--source-ref', 'refs/heads/main', '--source-digest', commit,
              '--signer-digest', commit, '--deny-self-hosted-runners', '--format', 'json']

    def attest(subject, bundle):
        read(bundle, 2 * 1024 ** 2)
        result = command([gh, 'attestation', 'verify', subject, '--bundle', bundle, *policy])
        matches_certificate(json.loads(result), build)

    attest(destination / 'release.json', destination / 'release.intoto.jsonl')
    run = json.loads(command([gh, 'api', f"repos/{REPOSITORY}/actions/runs/{build['run_id']}/attempts/{build['run_attempt']}"]))
    if (run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('head_sha') != commit or run.get('head_branch') != 'main'
            or run.get('head_repository', {}).get('id') != int(REPOSITORY_ID)
            or run.get('path') != WORKFLOW or run.get('event') not in ('push', 'workflow_dispatch')
            or str(run.get('id')) != build['run_id'] or run.get('run_attempt') != build['run_attempt']):
        raise ValueError('website release is not a successful trusted-main invocation')
    if digest(read(destination / 'static-assets.json', 4 * 1024 ** 2)) != manifest['static_assets']['sha256']:
        raise ValueError('static inventory does not match signed manifest')
    for kind, image in manifest['images'].items():
        subject = destination / (kind + '.manifest.json')
        subject.write_bytes(backend_manifest(image['repository'], image['digest']))
        command([gh, 'attestation', 'download', subject, '--repo', REPOSITORY,
                 '--predicate-type', 'https://slsa.dev/provenance/v1'], cwd=destination)
        bundle = destination / (kind + '.intoto.jsonl')
        (destination / (image['digest'] + '.jsonl')).rename(bundle)
        attest(subject, bundle)
    return manifest
