#!/usr/bin/env python3
"""Exercise real signed APT repositories; package installation is simulated.

Run as root in Linux (CI or a disposable container). No host sources are changed.
The PATH adapter adds --simulate only to install; update remains real APT.
"""
from contextlib import ExitStack
from email.utils import formatdate
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(argv, *, env=None, check=True):
    result = subprocess.run(argv, env=env, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(f"{argv[0]} failed:\n{result.stdout}\n{result.stderr}")
    return result


def main():
    assert os.geteuid() == 0, "run with sudo in Linux"
    apt = shutil.which("apt-get")
    assert apt
    installer = Path(__file__).resolve().with_name("install-ubuntu-deps.sh")
    with tempfile.TemporaryDirectory(prefix="apt-isolation-fixture-") as tmp, ExitStack() as cleanup:
        root = Path(tmp)
        root.chmod(0o755)
        keys = root / "keys"
        keys.mkdir(mode=0o700)
        cleanup.callback(run, ["gpgconf", "--homedir", str(keys), "--kill", "gpg-agent"], check=False)
        gpg = ["gpg", "--batch", "--homedir", str(keys), "--pinentry-mode", "loopback", "--passphrase", ""]
        run(gpg + ["--quick-generate-key", "APT isolation fixture", "rsa2048", "sign", "0"])
        public_key = root / "fixture.gpg"
        public_key.write_bytes(subprocess.check_output(gpg + ["--export"]))
        arch = run(["dpkg", "--print-architecture"]).stdout.strip()
        repo = root / "repo"
        for suite, version in [("base", "1"), ("security", "2"), ("unrelated", "3")]:
            package = root / f"package-{suite}"
            (package / "DEBIAN").mkdir(parents=True)
            (package / "DEBIAN/control").write_text(
                f"Package: apt-isolation-probe\nVersion: {version}\nArchitecture: all\n"
                "Maintainer: Fixture <fixture@example.invalid>\nDescription: isolated test package\n"
            )
            pool = repo / "pool" / suite
            pool.mkdir(parents=True)
            deb = pool / f"probe_{version}_all.deb"
            run(["dpkg-deb", "--build", str(package), str(deb)])
            relative = f"main/binary-{arch}/Packages"
            distribution = repo / "dists" / suite
            index = distribution / relative
            index.parent.mkdir(parents=True)
            data = (
                f"Package: apt-isolation-probe\nVersion: {version}\nArchitecture: all\n"
                "Maintainer: Fixture <fixture@example.invalid>\nDescription: isolated test package\n"
                f"Filename: pool/{suite}/{deb.name}\nSize: {deb.stat().st_size}\n"
                f"SHA256: {hashlib.sha256(deb.read_bytes()).hexdigest()}\n\n"
            ).encode()
            index.write_bytes(data)
            release = distribution / "Release"
            release.write_text(
                f"Suite: {suite}\nCodename: {suite}\nArchitectures: {arch}\nComponents: main\n"
                f"Date: {formatdate(usegmt=True)}\n"
                f"SHA256:\n {hashlib.sha256(data).hexdigest()} {len(data)} {relative}\n"
            )
            run(gpg + ["--yes", "--output", str(distribution / "InRelease"), "--clearsign", str(release)])

        def sources(suites):
            return (
                f"Types: deb\nURIs: file:{repo}\nSuites: {' '.join(suites)}\n"
                f"Components: main\nSigned-By: {public_key}\n"
            )

        source = root / "ubuntu.sources"
        source.write_text(sources(["base", "security"]))
        original = source.read_bytes()
        ambient = root / "ambient"
        ambient.mkdir()
        (ambient / "ubuntu.sources").write_bytes(original)
        (ambient / "unrelated.sources").write_text(sources(["unrelated"]))
        bad_index = repo / f"dists/unrelated/main/binary-{arch}/Packages"
        bad_index.write_bytes(bad_index.read_bytes() + b"corrupt index\n")
        lists = root / "ambient-lists"
        lists.mkdir()
        negative = run([
            apt, "-o", "Dir::Etc::sourcelist=/dev/null", "-o", f"Dir::Etc::sourceparts={ambient}",
            "-o", f"Dir::State::lists={lists}", "-o", "APT::Update::Error-Mode=any", "update",
        ], check=False)
        assert negative.returncode and "Hash Sum mismatch" in negative.stdout + negative.stderr
        print("PASS: ambient unrelated repository hash mismatch rejects update")

        adapter = root / "bin"
        adapter.mkdir()
        calls = root / "calls.jsonl"
        wrapper = adapter / "apt-get"
        wrapper.write_text(
            "#!/usr/bin/env python3\nimport json,os,sys\n"
            "with open(os.environ['APT_FIXTURE_CALLS'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
            "args=sys.argv[1:]\n"
            "if 'install' in args: args.insert(0,'--simulate')\n"
            f"os.execv({apt!r},[{apt!r},*args])\n"
        )
        wrapper.chmod(0o755)
        env = {**os.environ, "PATH": f"{adapter}:{os.environ['PATH']}",
               "APT_FIXTURE_CALLS": str(calls), "UBUNTU_APT_SOURCE_FILE": str(source)}

        def invoke():
            calls.write_text("")
            result = run(["bash", str(installer), "apt-isolation-probe"], env=env, check=False)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()]
            for args in recorded:
                state = next(item.split("=", 1)[1] for item in args if item.startswith("Dir::State::lists="))
                assert not Path(state).exists(), "temporary index directory leaked"
            return result, recorded

        result, recorded = invoke()
        assert result.returncode == 0, result.stdout + result.stderr
        assert "Inst apt-isolation-probe (2 " in result.stdout, result.stdout
        assert len(recorded) == 2 and "update" in recorded[0] and "install" in recorded[1]
        assert recorded[0][:-1] == recorded[1][:-3], "update/install options differ"
        assert source.read_bytes() == original
        print("PASS: scoped signed APT chooses security version 2; source unchanged and private indices removed")

        selected = repo / f"dists/security/main/binary-{arch}/Packages"
        good_index = selected.read_bytes()
        selected.write_bytes(good_index + b"corrupt selected index\n")
        result, recorded = invoke()
        assert result.returncode and "Hash Sum mismatch" in result.stdout + result.stderr
        assert len(recorded) == 1, "install ran after selected index failure"
        selected.write_bytes(good_index)
        print("PASS: selected security index hash failure prevents install")

        signed = repo / "dists/security/InRelease"
        signed.write_bytes(signed.read_bytes().replace(b"Suite: security", b"Suite: tampered"))
        result, recorded = invoke()
        assert result.returncode and "BADSIG" in result.stdout + result.stderr
        assert len(recorded) == 1, "install ran after signature failure"
        print("PASS: selected security signature failure prevents install")

        source.unlink()
        result, recorded = invoke()
        assert result.returncode and not recorded
        print("PASS: missing selected source fails before any APT invocation")


if __name__ == "__main__":
    main()
