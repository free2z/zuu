"""An audit must cover pinned tools even when scanner bootstrap installed them."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("audit_inventory_guard", SCRIPTS / "check-dependency-audit.py")
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)


class AuditInventory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lock = Path(self.tmp.name) / "lock-tools.txt"
        self.lock.write_text("".join(f"{name}==1.0 --hash=sha256:{'a' * 64}\n" for name in ("pip", "setuptools", "wheel")))
        self.rows = [{"name": name, "version": "1.0", "vulns": []} for name in ("pip", "setuptools", "wheel")]

    def check(self, rows=None):
        guard.ensure_pip_lock_coverage({"dependencies": self.rows if rows is None else rows}, [self.lock])

    def test_complete_bootstrap_inventory_passes(self):
        self.check()

    def test_each_omitted_bootstrap_package_fails(self):
        for omitted in ("pip", "setuptools", "wheel"):
            with self.subTest(omitted=omitted), self.assertRaisesRegex(guard.AuditFailure, "inventory mismatch"):
                self.check([row for row in self.rows if row["name"] != omitted])

    def test_wrong_version_fails(self):
        self.rows[0]["version"] = "2.0"
        with self.assertRaisesRegex(guard.AuditFailure, "inventory mismatch"):
            self.check()

    def test_missing_version_fails(self):
        del self.rows[0]["version"]
        with self.assertRaisesRegex(guard.AuditFailure, "has no version"):
            self.check()

    def test_empty_successful_report_fails(self):
        with self.assertRaisesRegex(guard.AuditFailure, "inventory mismatch"):
            self.check([])

    def test_unhashed_inventory_fails(self):
        self.lock.write_text("pip==1.0\n")
        with self.assertRaisesRegex(guard.AuditFailure, "no SHA-256 hash"):
            self.check()

    def test_marker_policy_uses_scanner_interpreter(self):
        with self.lock.open("a") as output:
            output.write(f"inactive==1.0 ; python_version < '1.0' --hash=sha256:{'b' * 64}\n")
        self.check()
        with self.lock.open("a") as output:
            output.write(f"active==1.0 ; python_version >= '3.0' --hash=sha256:{'b' * 64}\n")
        with self.assertRaisesRegex(guard.AuditFailure, "inventory mismatch for active"):
            self.check()

    def test_conflicting_lock_versions_fail(self):
        with self.lock.open("a") as output:
            output.write(f"pip==2.0 --hash=sha256:{'b' * 64}\n")
        with self.assertRaisesRegex(guard.AuditFailure, "conflicting versions"):
            self.check()


if __name__ == "__main__":
    unittest.main()
