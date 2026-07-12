from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import vendor_dependencies  # noqa: E402


class VendorAdvisoryTests(unittest.TestCase):
    def test_checked_in_dispositions_are_current_and_bounded(self):
        manifest = vendor_dependencies.read_manifest(ROOT / "vendor" / "dependencies.json")
        self.assertEqual([], vendor_dependencies.validate_advisory_dispositions(
            manifest, date(2026, 7, 12)
        ))

    def test_expired_or_unbounded_dispositions_fail(self):
        manifest = {"packages": [{"name": "leaflet", "supplemental_advisories": [{
            "id": "CVE-test", "status": "mitigated", "reason": "safe DOM construction",
            "reviewed_on": "2026-01-01", "expires_on": "2026-12-31",
            "references": ["https://example.test/CVE-test"]
        }]}]}
        failures = vendor_dependencies.validate_advisory_dispositions(manifest, date(2027, 1, 1))
        self.assertTrue(any("expired" in failure for failure in failures))
        self.assertTrue(any("1-180 days" in failure for failure in failures))

    def test_prerelease_latest_tag_falls_back_to_highest_stable_version(self):
        metadata = {
            "dist-tags": {"latest": "2.0.0-rc.1"},
            "versions": {"1.9.4": {}, "2.0.0-beta.2": {}, "1.10.0": {}}
        }
        self.assertEqual("1.10.0", vendor_dependencies.latest_stable_version(metadata))
        self.assertIsNone(vendor_dependencies.stable_version("2.0.0-canary.1"))


if __name__ == "__main__":
    unittest.main()
