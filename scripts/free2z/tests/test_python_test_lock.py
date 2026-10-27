"""Test inputs cannot drift from their hashes or production constraints."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("requirements_guard", SCRIPTS / "check-python-requirements-lock.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class TestLock(unittest.TestCase):
    kind = "test"
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.source = root / f"{self.kind}.in"
        self.lock = root / f"{self.kind}.txt"
        self.runtime = root / "main.txt"
        self.docker = root / "Dockerfile"
        image = "python:3.12-bookworm@sha256:" + "a" * 64
        self.docker.write_text(f"FROM {image}\n")
        self.source.write_text("-c main.txt\npytest==9.1.1\n")
        self.lock.write_text(
            f"# Target image: {image} (linux/amd64)\n"
            f"pytest==9.1.1 --hash=sha256:{'b' * 64}\n"
            f"# via -r requirements/{self.kind}.in\n"
            f"packaging==26.3 --hash=sha256:{'c' * 64}\n"
            "# via pytest\n"
        )
        self.runtime.write_text(f"packaging==26.3 --hash=sha256:{'c' * 64}\n")

    def check(self):
        return guard.check(self.source, self.lock, self.docker, kind=self.kind)

    def test_matching_test_lock(self):
        self.assertEqual(self.check(), 0)

    def test_stale_direct_input_is_rejected(self):
        self.source.write_text("-c main.txt\npytest==9.1.2\n")
        with self.assertRaisesRegex(guard.RequirementsError, "does not match direct lock"):
            self.check()

    def test_runtime_overlap_cannot_be_upgraded_by_tests(self):
        self.lock.write_text(self.lock.read_text().replace("packaging==26.3", "packaging==99.0"))
        with self.assertRaisesRegex(guard.RequirementsError, "differs from runtime constraint"):
            self.check()

    def test_only_one_exact_runtime_constraint_is_allowed(self):
        for directive in ("", "-c other.txt\n", "-c main.txt\n-c main.txt\n", "-c main.txt\n--index-url https://example.invalid\n"):
            with self.subTest(directive=directive):
                self.source.write_text(directive + "pytest==9.1.1\n")
                with self.assertRaises(guard.RequirementsError):
                    self.check()

    def test_runtime_parser_still_rejects_constraints(self):
        with self.assertRaisesRegex(guard.RequirementsError, "not a direct package pin"):
            guard.parse_source(self.source)

    def test_main_provenance_cannot_impersonate_test_input(self):
        self.lock.write_text(self.lock.read_text().replace(f"requirements/{self.kind}.in", "requirements/main.in"))
        with self.assertRaisesRegex(guard.RequirementsError, "missing direct provenance"):
            self.check()

    def test_hashless_transitive_is_rejected(self):
        self.lock.write_text(self.lock.read_text().replace(f" --hash=sha256:{'c' * 64}", ""))
        with self.assertRaisesRegex(guard.RequirementsError, "has no SHA-256 hash"):
            self.check()


class CIAuditLock(TestLock):
    kind = "ci-audit"


class CILintLock(TestLock):
    kind = "ci-lint"


class CIPolicyLock(TestLock):
    kind = "ci-policy"


if __name__ == "__main__":
    unittest.main()
