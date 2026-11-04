"""Portable app-link rendering and store-link validation contract."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

GENERATOR = Path(__file__).resolve().parents[1] / "gen-bridge-pages.py"
spec = importlib.util.spec_from_file_location("bridge_generator", GENERATOR)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def configuration():
    return {"accessContact": "access@example.test", "apps": {
        slug: {"name": slug, "role": "Synthetic app", "ios": {"channel": "testflight", "url": None},
               "android": {"channel": "play-internal", "url": None}}
        for slug in bridge.APPS
    }}


class BridgePagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="free2z-bridge-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "install-links.json"
        self.output = self.root / "site"

    def write_config(self, config):
        self.config.write_text(json.dumps(config))

    def invoke(self, *args):
        return bridge.main(["--config", str(self.config), "--out-dir", str(self.output), *args])

    def test_store_links_refuse_wrong_hosts_credentials_schemes_ports_and_platforms(self):
        cases = [
            ("ios", "http://testflight.apple.com/join/ABCDEFGH"),
            ("ios", "https://testflight.apple.com.evil.example/join/ABCDEFGH"),
            ("ios", "https://evil.example/join/ABCDEFGH"),
            ("ios", "javascript:alert(1)"),
            ("ios", "https://user@testflight.apple.com/join/ABCDEFGH"),
            ("ios", "https://testflight.apple.com:8443/join/ABCDEFGH"),
            ("ios", "https://testflight.apple.com:0/join/ABCDEFGH"),
            ("ios", "https://play.google.com/apps/internaltest/123"),
            ("android", "https://testflight.apple.com/join/ABCDEFGH"),
            ("android", "https://play.google.com/apps/internaltest/1#frag"),
        ]
        for platform, url in cases:
            with self.subTest(platform=platform, url=url):
                config = configuration()
                config["apps"]["e2e2z"][platform]["url"] = url
                self.write_config(config)
                self.assertEqual(self.invoke(), 2)
                self.assertFalse(self.output.exists())

    def test_valid_store_link_is_escaped_and_only_rendered_for_its_app(self):
        config = configuration()
        config["apps"]["e2e2z"]["ios"]["url"] = "https://testflight.apple.com/join/ABCDEFGH?a=1&b=2"
        self.write_config(config)
        self.assertEqual(self.invoke(), 0)
        for page in ("e2e2z-chat.html", "e2e2z.html"):
            self.assertIn('href="https://testflight.apple.com/join/ABCDEFGH?a=1&amp;b=2" rel="noreferrer">Join the e2e2z test on TestFlight</a>', (self.output / page).read_text())
        self.assertNotIn("Join the e2e2z test on TestFlight", (self.output / "zuuli.html").read_text())

    def test_check_rejects_modified_missing_and_unexpected_output(self):
        self.write_config(configuration())
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.invoke("--check"), 0)
        page = self.output / "zuuli.html"
        original = page.read_text()
        page.write_text(original + "modified")
        self.assertEqual(self.invoke("--check"), 1)
        page.unlink()
        self.assertEqual(self.invoke("--check"), 1)
        page.write_text(original)
        (self.output / "unexpected.html").write_text("synthetic")
        self.assertEqual(self.invoke("--check"), 1)

    def test_deployment_configuration_must_be_explicit(self):
        with self.assertRaises(SystemExit) as error:
            bridge.main([])
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
