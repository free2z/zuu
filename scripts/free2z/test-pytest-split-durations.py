#!/usr/bin/env python3
"""Exercise the pinned pytest-split duration-file behavior on a tiny suite."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class PytestSplitDurationContract(unittest.TestCase):
    def test_weighted_allocation_is_deterministic_and_covers_new_tests(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pytest-split-contract-") as temp:
            root = Path(temp)
            module = root / "test_contract.py"
            names = [
                "test_a_heavy",
                "test_b_medium",
                "test_c_light",
                "test_d_tiny",
                "test_e_new_without_measurement",
            ]
            module.write_text(
                "\n".join(f"def {name}():\n    assert True\n" for name in names),
                encoding="utf-8",
            )
            duration_path = root / "durations.json"
            durations = {
                f"test_contract.py::{name}": seconds
                for name, seconds in zip(names[:4], (100.0, 40.0, 2.0, 1.0))
            }
            # Stale node IDs must be filtered before computing the average used
            # for a newly added test, or this obsolete value would dominate it.
            durations["test_contract.py::test_stale_removed"] = 10000.0
            duration_path.write_text(json.dumps(durations), encoding="utf-8")

            def collect(group: int) -> tuple[set[str], float]:
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "--collect-only",
                        "-q",
                        "--splits",
                        "2",
                        "--group",
                        str(group),
                        "--splitting-algorithm",
                        "least_duration",
                        "--durations-path",
                        str(duration_path),
                    ],
                    cwd=root,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                node_ids = {
                    line.strip()
                    for line in result.stdout.splitlines()
                    if line.startswith("test_contract.py::")
                }
                estimate = re.search(
                    r"estimated duration: ([0-9.]+)s", result.stdout
                )
                self.assertIsNotNone(estimate, result.stdout)
                return node_ids, float(estimate.group(1))

            first, first_estimate = collect(1)
            second, second_estimate = collect(2)
            # Repeat the same collection to pin stable group membership.
            first_again, first_estimate_again = collect(1)
            second_again, second_estimate_again = collect(2)
            self.assertEqual((first, second), (first_again, second_again))
            self.assertEqual(
                (first_estimate, second_estimate),
                (first_estimate_again, second_estimate_again),
            )
            expected = {f"test_contract.py::{name}" for name in names}
            self.assertEqual(first | second, expected)
            self.assertFalse(first & second, "a collected case was assigned to both groups")
            self.assertIn("test_contract.py::test_a_heavy", first)
            self.assertIn("test_contract.py::test_b_medium", second)
            self.assertAlmostEqual(first_estimate, 100.0)
            # This also proves stale IDs do not skew the missing test's
            # fallback average: (100 + 40 + 2 + 1) / 4 = 35.75 seconds.
            self.assertAlmostEqual(second_estimate, 78.75)
            # A newly added node has no committed timing. The plugin must still
            # include it exactly once using its documented run-time average.
            self.assertEqual(
                sum(
                    "test_contract.py::test_e_new_without_measurement" in group
                    for group in (first, second)
                ),
                1,
            )
            self.assertIn(
                "test_contract.py::test_e_new_without_measurement", second
            )

    def test_store_durations_sums_setup_call_and_teardown(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pytest-split-phases-") as temp:
            root = Path(temp)
            (root / "test_phase.py").write_text(
                "def test_phase_sum():\n    assert True\n", encoding="utf-8"
            )
            (root / "conftest.py").write_text(
                "import pytest\n"
                "@pytest.hookimpl(hookwrapper=True)\n"
                "def pytest_runtest_makereport(item, call):\n"
                "    outcome = yield\n"
                "    report = outcome.get_result()\n"
                "    report.duration = {\"setup\": 0.125, \"call\": 0.5, "
                "\"teardown\": 0.25}[report.when]\n",
                encoding="utf-8",
            )
            duration_path = root / "durations.json"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "-q",
                    "--store-durations",
                    "--durations-path",
                    str(duration_path),
                ],
                cwd=root,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            stored = json.loads(duration_path.read_text(encoding="utf-8"))
            self.assertEqual(stored, {"test_phase.py::test_phase_sum": 0.875})


if __name__ == "__main__":
    unittest.main(verbosity=2)
