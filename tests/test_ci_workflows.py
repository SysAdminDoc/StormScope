from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
DEPENDENCIES = (ROOT / ".github" / "workflows" / "dependency-audit.yml").read_text(encoding="utf-8")


class CiWorkflowTests(unittest.TestCase):
    def test_push_and_pull_request_run_the_complete_read_only_gate(self) -> None:
        self.assertIn("push:", CI)
        self.assertIn("pull_request:", CI)
        self.assertIn("contents: read", CI)
        self.assertIn("python scripts/check.py", CI)
        self.assertIn("python-version: '3.11'", CI)
        self.assertIn("node-version: '24'", CI)
        self.assertNotIn("contents: write", CI)

    def test_exact_lock_caches_and_failure_artifacts_are_explicit(self) -> None:
        self.assertIn("cache-dependency-path: requirements-dev.txt", CI)
        self.assertIn("cache-dependency-path: package-lock.json", CI)
        self.assertIn("playwright-1.61.1-${{ hashFiles('package-lock.json') }}", CI)
        self.assertIn("STORMSCOPE_TEST_ARTIFACTS: test-results/browser", CI)
        self.assertIn("if: failure()", CI)
        self.assertIn("retention-days: 7", CI)

    def test_scheduled_audit_reports_without_mutating_repository_data(self) -> None:
        self.assertIn("schedule:", DEPENDENCIES)
        self.assertIn("workflow_dispatch:", DEPENDENCIES)
        self.assertIn("contents: read", DEPENDENCIES)
        self.assertIn("dependency_audit.py --online", DEPENDENCIES)
        self.assertIn("vendor_dependencies.py --check-updates", DEPENDENCIES)
        self.assertIn("npm outdated", DEPENDENCIES)
        self.assertIn("pip', 'list', '--outdated'", DEPENDENCIES)
        self.assertIn("GITHUB_STEP_SUMMARY", DEPENDENCIES)
        self.assertNotIn("--rebuild", DEPENDENCIES)

    def test_third_party_actions_are_immutable_sha_pinned(self) -> None:
        for source in (CI, DEPENDENCIES):
            for line in source.splitlines():
                if "uses: actions/" not in line:
                    continue
                reference = line.split("uses: actions/", 1)[1].split()[0]
                sha = reference.rsplit("@", 1)[1]
                self.assertEqual(40, len(sha))
                self.assertTrue(all(character in "0123456789abcdef" for character in sha))


if __name__ == "__main__":
    unittest.main()
