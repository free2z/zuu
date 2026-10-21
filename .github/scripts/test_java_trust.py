"""Exercise real temporary Java CA stores; never modify the installed JDK."""
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parents[1]
CERTIFICATES = re.compile(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S)


class JavaTrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        cls.classes = Path(temporary.name)
        subprocess.run([shutil.which("javac"), "--release", "17", "-d", str(cls.classes),
                        str(SCRIPTS / "RemoveDistrustedRoots.java")], capture_output=True, check=True, timeout=30)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.store = self.folder / "temporary-ca-store"
        self.store_type = "PKCS12"
        self.java = shutil.which("java")
        self.keytool = shutil.which("keytool")
        self.assertTrue(self.java and self.keytool, "Java and keytool are required")
        affected = CERTIFICATES.findall((SCRIPTS / "java-trust-fixtures/affected-roots.pem").read_text())
        self.assertGreater(len(affected), 0)
        self.affected_count = len(affected)
        for index, certificate in enumerate(affected):
            self.add_certificate("affected" + str(index), certificate)
        control = CERTIFICATES.findall((ROOT / "wallet/zuuli/scripts/tls/ca-certificates.pem").read_text())[0]
        self.add_certificate("control", control)

    def command(self, arguments):
        return subprocess.run(arguments, capture_output=True, text=True, timeout=30, check=True)

    def add_certificate(self, alias, certificate):
        path = self.folder / (alias + ".crt")
        path.write_text(certificate)
        self.command([self.keytool, "-importcert", "-noprompt", "-alias", alias,
                      "-file", str(path), "-keystore", str(self.store), "-storetype", self.store_type, "-storepass", "changeit"])

    def repair(self, path=None):
        return self.command([self.java, "-cp", str(self.classes), "RemoveDistrustedRoots", str(path or self.store)])

    def test_exact_removal_preserves_control_metadata_backup_and_idempotence(self):
        original = self.store.read_bytes()
        self.store.chmod(0o640)
        before = self.store.stat()
        result = self.repair()
        self.assertIn("removed " + str(self.affected_count), result.stdout)
        control = self.command([self.keytool, "-exportcert", "-rfc", "-alias", "control",
                                "-keystore", str(self.store), "-storepass", "changeit"])
        self.assertEqual([ssl.PEM_cert_to_DER_cert(pem) for pem in CERTIFICATES.findall(control.stdout)],
                         [ssl.PEM_cert_to_DER_cert((self.folder / "control.crt").read_text())])
        for index in range(self.affected_count):
            with self.assertRaises(subprocess.CalledProcessError):
                self.command([self.keytool, "-exportcert", "-rfc", "-alias", "affected" + str(index),
                              "-keystore", str(self.store), "-storepass", "changeit"])
        after = self.store.stat()
        self.assertEqual((after.st_mode & 0o777, after.st_uid, after.st_gid),
                         (before.st_mode & 0o777, before.st_uid, before.st_gid))
        backup = self.store.with_name(self.store.name + ".before-emudhra")
        self.assertEqual(backup.read_bytes(), original)
        cleaned = self.store.read_bytes()
        self.repair()
        self.assertEqual(self.store.read_bytes(), cleaned)
        self.assertEqual(backup.read_bytes(), original)

    def test_jks_format_and_ordinary_root_are_preserved(self):
        self.store = self.folder / "jks-ca-store"
        self.store_type = "JKS"
        self.add_certificate("affected", (self.folder / "affected0.crt").read_text())
        self.add_certificate("control", (self.folder / "control.crt").read_text())
        self.assertEqual(self.store.read_bytes()[:4], bytes.fromhex("feedfeed"))
        self.repair()
        self.assertEqual(self.store.read_bytes()[:4], bytes.fromhex("feedfeed"))
        self.command([self.keytool, "-exportcert", "-rfc", "-alias", "control", "-keystore", str(self.store), "-storepass", "changeit"])
        with self.assertRaises(subprocess.CalledProcessError):
            self.command([self.keytool, "-exportcert", "-rfc", "-alias", "affected", "-keystore", str(self.store), "-storepass", "changeit"])

    def test_refuses_to_replace_store_with_no_remaining_trust_anchors(self):
        self.command([self.keytool, "-delete", "-alias", "control", "-keystore", str(self.store), "-storepass", "changeit"])
        original = self.store.read_bytes()
        with self.assertRaises(subprocess.CalledProcessError):
            self.repair()
        self.assertEqual(self.store.read_bytes(), original)
        self.assertFalse(self.store.with_name(self.store.name + ".before-emudhra").exists())

    def test_invalid_input_fails_without_replacing_it(self):
        self.store.write_bytes(b"invalid CA store")
        with self.assertRaises(subprocess.CalledProcessError):
            self.repair()
        self.assertEqual(self.store.read_bytes(), b"invalid CA store")
        self.assertFalse(self.store.with_name(self.store.name + ".before-emudhra").exists())

    def test_symlinked_jdk_store_keeps_its_link_and_updates_the_target(self):
        link = self.folder / "cacerts-link"
        link.symlink_to(self.store)
        self.repair(link)
        self.assertTrue(link.is_symlink())
        self.assertIn("store unchanged", self.repair().stdout)

    def test_backup_symlink_is_rejected_before_store_replacement(self):
        original = self.store.read_bytes()
        backup = self.store.with_name(self.store.name + ".before-emudhra")
        backup.symlink_to(self.folder / "absent")
        with self.assertRaises(subprocess.CalledProcessError):
            self.repair()
        self.assertEqual(self.store.read_bytes(), original)



if __name__ == "__main__":
    unittest.main()
