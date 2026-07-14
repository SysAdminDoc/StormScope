from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import dependency_audit  # noqa: E402


class DependencyAuditTests(unittest.TestCase):
    def test_checked_in_inventory_covers_python_node_and_vendor_pins(self) -> None:
        inventory = dependency_audit.dependency_inventory()
        keys = {dependency.key for dependency in inventory}
        self.assertIn(("PyPI", "ruff", "0.15.20"), keys)
        self.assertIn(("PyPI", "yt-dlp", "2026.7.4"), keys)
        self.assertIn(("npm", "@playwright/test", "1.61.1"), keys)
        self.assertIn(("npm", "playwright-core", "1.61.1"), keys)
        self.assertIn(("npm", "leaflet", "1.9.4"), keys)
        self.assertIn(("npm", "leaflet.markercluster", "1.5.3"), keys)
        self.assertIn(("npm", "hls.js", "1.6.16"), keys)

    def test_checked_in_reviewed_advisories_are_current_and_exact(self) -> None:
        inventory = dependency_audit.dependency_inventory()
        advisories = dependency_audit.reviewed_advisories()
        self.assertEqual(
            [],
            dependency_audit.validate_reviewed_advisories(inventory, advisories, date(2026, 7, 14)),
        )

    def test_affected_expired_and_unbounded_reviews_fail(self) -> None:
        inventory = [dependency_audit.Dependency("PyPI", "example", "1.0.0", ("test",))]
        advisory = {
            "ecosystem": "PyPI",
            "package": "example",
            "version": "1.0.0",
            "id": "CVE-2026-0001",
            "status": "affected",
            "reason": "test",
            "reviewed_on": "2026-01-01",
            "expires_on": "2026-12-31",
            "references": ["https://nvd.nist.gov/vuln/detail/CVE-2026-0001"],
        }
        failures = dependency_audit.validate_reviewed_advisories(
            inventory, [advisory], date(2027, 1, 1)
        )
        self.assertTrue(any("expired" in failure for failure in failures))
        self.assertTrue(any("1-180 days" in failure for failure in failures))
        self.assertTrue(any("marked affected" in failure for failure in failures))

    def test_osv_requires_a_non_affected_matching_disposition(self) -> None:
        inventory = [dependency_audit.Dependency("npm", "example", "1.0.0", ("test",))]
        results = [{"vulns": [{"id": "GHSA-test", "aliases": ["CVE-2026-0001"]}]}]
        reviewed = [{
            "ecosystem": "npm",
            "package": "example",
            "version": "1.0.0",
            "id": "CVE-2026-0001",
            "status": "not_affected_by_usage",
        }]
        self.assertEqual([], dependency_audit.evaluate_osv_results(inventory, results, reviewed))
        reviewed[0]["status"] = "patched"
        self.assertEqual(1, len(dependency_audit.evaluate_osv_results(inventory, results, reviewed)))

    def test_nvd_record_must_match_and_not_be_rejected(self) -> None:
        valid = {
            "totalResults": 1,
            "vulnerabilities": [{"cve": {"id": "CVE-2026-0001", "vulnStatus": "Analyzed"}}],
        }
        self.assertEqual([], dependency_audit.validate_nvd_payload("CVE-2026-0001", valid))
        valid["vulnerabilities"][0]["cve"]["vulnStatus"] = "Rejected"
        self.assertTrue(dependency_audit.validate_nvd_payload("CVE-2026-0001", valid))


if __name__ == "__main__":
    unittest.main()
