#!/usr/bin/env python3
"""Real APT, signed local archives; no network or package installation.

The PATH adapter only adds --simulate to install. APT itself selects sources,
verifies signatures/hashes, loads both distribution suites, and resolves the
package. Missing APT/GPG is an error, not a skipped CI control.
"""
import email.utils
import gzip
import hashlib
import json
import os
import re
import sys
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/free2z/install-ubuntu-ci-packages.sh"
workflow = (ROOT / ".github/workflows/free2z-web-ci.yml").read_text()
for job, package in (("backend", "libpq-dev"), ("ui-tests", "libxml2-utils")):
    block = re.search(rf"^  {job}:\n(.*?)(?=^  [a-z][a-z-]*:|\Z)", workflow, re.M | re.S)
    assert block and f'run: sudo "$GITHUB_WORKSPACE/scripts/free2z/install-ubuntu-ci-packages.sh" {package}' in block[1]
    assert "sudo apt-get" not in block[1]
selector = (ROOT / "scripts/free2z/select-web-checks.py").read_text()
assert "'scripts/free2z/'" in selector
assert 'python "$GITHUB_WORKSPACE/scripts/free2z/test-ubuntu-ci-packages.py"' in workflow
browser = re.search(r"^  ui-browser:\n(.*?)(?=^  [a-z][a-z-]*:|\Z)", workflow, re.M | re.S)[1]
assert 'sudo "$GITHUB_WORKSPACE/scripts/free2z/install-ubuntu-ci-packages.sh" --playwright-deps "$(command -v node)" "$PWD/node_modules/playwright/cli.js"' in browser
assert "npx playwright install --only-shell chromium" in browser
assert "npx playwright install --with-deps" not in browser
print("PASS both consumers and helper-only CI selection remain wired")
if sys.argv[1:] == ["--wiring-only"]:
    raise SystemExit(0)
assert len(sys.argv) == 1, "only --wiring-only is supported"
APT = shutil.which("apt-get")
GPG = shutil.which("gpg")
if not APT or not GPG:
    raise SystemExit("real apt-get and gpg are required for these controls")


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=60, **kwargs)


with tempfile.TemporaryDirectory(prefix="ubuntu-apt-test-") as tmp:
    base = Path(tmp)
    home = base / "gnupg"
    home.mkdir(mode=0o700)
    gpg = [GPG, "--homedir", str(home), "--batch", "--pinentry-mode", "loopback",
           "--passphrase", ""]
    result = run(gpg + ["--quick-generate-key", "APT CI fixture <fixture@example.invalid>",
                        "ed25519", "sign", "0"])
    assert result.returncode == 0, result.stderr
    key = base / "fixture.gpg"
    with key.open("wb") as out:
        subprocess.run(gpg + ["--export"], stdout=out, check=True, timeout=30)
    arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()

    def repository(name, suites):
        repo = base / name
        for suite, version in suites:
            dist = repo / "dists" / suite
            index = dist / "main" / f"binary-{arch}" / "Packages"
            index.parent.mkdir(parents=True, exist_ok=True)
            index.write_text(f"Package: ci-ubuntu-fixture\nVersion: {version}\nArchitecture: {arch}\n"
                             "Maintainer: Fixture <fixture@example.invalid>\n"
                             "Description: signed offline fixture\n"
                             "Filename: pool/fixture.deb\nSize: 1\n"
                             f"SHA256: {hashlib.sha256(b'x').hexdigest()}\n\n")
            index.with_suffix(".gz").write_bytes(gzip.compress(index.read_bytes(), mtime=0))
            release = (f"Origin: Fixture\nLabel: Fixture\nSuite: {suite}\nCodename: {suite}\n"
                       f"Date: {email.utils.formatdate(usegmt=True)}\n"
                       f"Architectures: {arch}\nComponents: main\nSHA256:\n")
            for path in (index, index.with_suffix(".gz")):
                data = path.read_bytes()
                release += f" {hashlib.sha256(data).hexdigest()} {len(data)} {path.relative_to(dist)}\n"
            (dist / "Release").write_text(release)
            result = run(gpg + ["--yes", "--clearsign", "--output", str(dist / "InRelease"),
                                str(dist / "Release")])
            assert result.returncode == 0, result.stderr
        return repo

    ubuntu = repository("ubuntu", [("noble", "1.0"), ("noble-security", "2.0")])
    chrome = repository("chrome", [("stable", "9.0")])
    parts = base / "ambient-sources"
    parts.mkdir()

    def source(path, repo, suites):
        path.write_text(f"Types: deb\nURIs: {repo.as_uri()}\nSuites: {suites}\n"
                        f"Components: main\nArchitectures: {arch}\nSigned-By: {key}\n")

    source(parts / "ubuntu.sources", ubuntu, "noble noble-security")
    source(parts / "chrome.sources", chrome, "stable")
    ambient_lists = base / "ambient-lists"
    ambient_lists.mkdir()
    (base / "empty-config").mkdir()
    config = base / "apt.conf"
    config.write_text(f'Dir::Etc::parts "{base / "empty-config"}";\nDir::Etc::main "/dev/null";\nDir::Etc::sourcelist "/dev/null";\nDir::Etc::sourceparts "{parts}";\n'
                      f'Dir::State::lists "{ambient_lists}";\n'
                      f'Dir::Cache::pkgcache "{base / "pkgcache"}";\n'
                      f'Dir::Cache::srcpkgcache "{base / "srcpkgcache"}";\n'
                      'APT::Update::Error-Mode "any";\n')
    bindir = base / "bin"
    bindir.mkdir()
    calls = base / "calls.jsonl"
    adapter = bindir / "apt-get"
    adapter.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                       "args = sys.argv[1:]\n"
                       "with open(os.environ['APT_TEST_CALLS'], 'a') as out:\n"
                       "    out.write(json.dumps(args) + '\\n')\n"
                       "if 'install' in args: args.insert(0, '--simulate')\n"
                       f"os.execv({APT!r}, [{APT!r}] + args)\n")
    adapter.chmod(0o755)
    env = dict(os.environ, APT_CONFIG=str(config), APT_TEST_CALLS=str(calls),
               UBUNTU_APT_SOURCE_FILE=str(parts / "ubuntu.sources"),
               PATH=f"{bindir}:{os.environ['PATH']}", LC_ALL="C")

    def corrupt(repo, suite):
        index = repo / "dists" / suite / "main" / f"binary-{arch}" / "Packages"
        index.write_text(index.read_text().replace("Fixture", "Changed"))
        index.with_suffix(".gz").write_bytes(gzip.compress(index.read_bytes(), mtime=0))

    # Pinned Playwright's Linux dependency path launches this same nested
    # shell command when root. Use the real Node/shell and APT resolver, but
    # fixture packages: no browser download or system package mutation.
    node = shutil.which("node")
    assert node, "node is required for the nested Playwright dependency control"
    cli = base / "playwright-fixture.cjs"
    cli.write_text("const {spawnSync} = require('node:child_process');\n"
                   "if (process.argv.slice(2).join(' ') !== 'install-deps chromium') process.exit(9);\n"
                   "const child = spawnSync('sh', ['-c', 'apt-get update && apt-get install -y --no-install-recommends ci-ubuntu-fixture'], {stdio: 'inherit'});\n"
                   "process.exit(child.status ?? 8);\n")

    def helper(nested=False):
        calls.write_text("")
        args = ["--playwright-deps", node, str(cli)] if nested else ["ci-ubuntu-fixture"]
        return run(["bash", str(HELPER), *args], env=env)

    try:
        corrupt(chrome, "stable")
        old = run([APT, "update"], env=env)
        assert old.returncode != 0 and "Hash Sum mismatch" in old.stdout + old.stderr, old
        print("PASS real APT rejects ambient Chrome index hash mismatch")
        good = helper()
        assert good.returncode == 0, good.stdout + good.stderr
        assert "Inst ci-ubuntu-fixture (2.0" in good.stdout, good.stdout
        argv = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len(argv) == 2 and "update" in argv[0] and "install" in argv[1], argv
        assert argv[0][:-1] == argv[1][:-3], argv
        print("PASS scoped APT excludes broken Chrome, retains security suite, resolves install")
        nested = helper(nested=True)
        assert nested.returncode == 0 and "Inst ci-ubuntu-fixture (2.0" in nested.stdout, nested
        nested_argv = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len(nested_argv) == 2
        assert nested_argv[0][:-1] == nested_argv[1][:-4]
        print("PASS nested Node/shell dependency install retains identical source isolation")
        corrupt(ubuntu, "noble-security")
        bad = helper()
        assert bad.returncode != 0 and "Hash Sum mismatch" in bad.stdout + bad.stderr, bad
        assert len(calls.read_text().splitlines()) == 1
        print("PASS selected Ubuntu security hash failure prevents install")
        bad = helper(nested=True)
        assert bad.returncode != 0 and "Hash Sum mismatch" in bad.stdout + bad.stderr, bad
        assert len(calls.read_text().splitlines()) == 1
        print("PASS nested dependency source corruption stops before install")
        repository("ubuntu", [("noble", "1.0"), ("noble-security", "2.0")])
        signed = ubuntu / "dists/noble-security/InRelease"
        signed.write_text(signed.read_text().replace("Origin: Fixture", "Origin: Changed"))
        bad = helper()
        assert bad.returncode != 0 and any(word in bad.stdout + bad.stderr
                                           for word in ("BADSIG", "invalid signature", "signatures were invalid")), bad
        assert len(calls.read_text().splitlines()) == 1
        print("PASS selected Ubuntu signature failure prevents install")
        (parts / "ubuntu.sources").unlink()
        bad = helper()
        assert bad.returncode != 0 and not calls.read_text()
        print("PASS missing distro sources refuse before any APT operation")
    finally:
        subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"], check=False)
