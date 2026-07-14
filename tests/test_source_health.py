"""Camera ingestion source-health contract tests."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from providers import ProviderResult  # noqa: E402
from source_health import (  # noqa: E402
    SourceHealthError,
    classify_failure,
    load_source_health,
    seed_source_health,
    update_source_health,
    validate_source_health,
    write_source_health,
)


ATTEMPT = "2026-07-14T18:00:00Z"
PREVIOUS = "2026-07-12T20:46:37Z"


def adapter(name: str, family: str = "test") -> SimpleNamespace:
    return SimpleNamespace(name=name, family=family)


def camera(provider: str, source: str = "dot", *, degraded: bool = False) -> dict:
    return {
        "provider": provider,
        "source": source,
        "health": "degraded" if degraded else "healthy",
        "failure_class": "provider_error" if degraded else None,
        "last_verified": "2026-07-12T18:00:00Z",
    }


class SourceHealthTests(unittest.TestCase):
    def test_seed_is_sorted_deterministic_and_explicit_about_unknown_history(self):
        adapters = [adapter("Provider C"), adapter("Provider A"), adapter("Provider B")]
        cameras = [camera("Provider A"), camera("Provider B", degraded=True)]

        first = seed_source_health(cameras, adapters, PREVIOUS)
        second = seed_source_health(copy.deepcopy(cameras), list(reversed(adapters)), PREVIOUS)

        self.assertEqual(first, second)
        self.assertEqual(
            [record["name"] for record in first["providers"]],
            ["Provider A", "Provider B", "Provider C"],
        )
        by_name = {record["name"]: record for record in first["providers"]}
        self.assertEqual("unknown", by_name["Provider A"]["status"])
        self.assertEqual("unknown", by_name["Provider B"]["status"])
        self.assertIsNone(by_name["Provider A"]["last_attempt_at"])
        self.assertIsNone(by_name["Provider B"]["failure_class"])
        self.assertEqual("unknown", by_name["Provider C"]["status"])
        self.assertEqual({"dot": 1}, by_name["Provider A"]["camera_source_counts"])
        self.assertEqual(
            {"fresh": 0, "retained": 0, "failed": 0, "unknown": 3},
            {key: first["totals"][key] for key in ("fresh", "retained", "failed", "unknown")},
        )

    def test_update_records_fresh_retained_and_failed_counts_without_raw_errors(self):
        adapters = [adapter("Provider A"), adapter("Provider B"), adapter("Provider C")]
        existing = [camera("Provider A"), camera("Provider A"), camera("Provider B")]
        previous = seed_source_health(existing, adapters, PREVIOUS)
        fresh_rows = [
            {**camera("Attribution A"), "ingestion_source": "Provider A"}
            for _ in range(3)
        ]
        merged = fresh_rows + [camera("Provider B")]
        results = [
            ProviderResult("Provider A", fresh_rows),
            ProviderResult("Provider B", [], "timeout https://secret.example/token"),
            ProviderResult("Provider C", [], "provider returned no cameras"),
        ]

        health = update_source_health(
            previous, existing, merged, results, adapters, {"Provider A"}, ATTEMPT
        )
        records = {record["name"]: record for record in health["providers"]}
        self.assertEqual(
            {
                "status": "fresh", "fetched_count": 3, "retained_count": 0,
                "replaced_count": 2, "previous_count": 2, "final_count": 3,
                "coverage_delta": 1, "coverage_delta_percent": 50.0,
            },
            {key: records["Provider A"][key] for key in (
                "status", "fetched_count", "retained_count", "replaced_count",
                "previous_count", "final_count", "coverage_delta", "coverage_delta_percent",
            )},
        )
        self.assertEqual("retained", records["Provider B"]["status"])
        self.assertEqual("transient_network", records["Provider B"]["failure_class"])
        self.assertIsNone(records["Provider B"]["last_success_at"])
        self.assertEqual(1, records["Provider B"]["retained_count"])
        self.assertEqual("failed", records["Provider C"]["status"])
        self.assertEqual("empty_snapshot", records["Provider C"]["failure_class"])
        self.assertNotIn("secret.example", json.dumps(health))
        self.assertEqual({"dot": 2}, records["Provider A"]["previous_camera_source_counts"])
        self.assertEqual({"dot": 3}, records["Provider A"]["camera_source_counts"])

    def test_artifact_round_trips_and_rejects_unbounded_or_inconsistent_data(self):
        health = seed_source_health([camera("Provider A")], [adapter("Provider A")], PREVIOUS)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source-health.json"
            write_source_health(path, health)
            self.assertEqual(health, load_source_health(path))

        malformed = copy.deepcopy(health)
        malformed["providers"][0]["failure_class"] = "https://secret.example/detail"
        with self.assertRaisesRegex(SourceHealthError, "failure class"):
            validate_source_health(malformed)

        inconsistent = copy.deepcopy(health)
        inconsistent["totals"]["fresh"] = 9
        with self.assertRaisesRegex(SourceHealthError, "total"):
            validate_source_health(inconsistent)

        inconsistent = copy.deepcopy(health)
        inconsistent["providers"][0]["coverage_delta"] = 1
        inconsistent["totals"]["coverage_delta"] = 1
        with self.assertRaisesRegex(SourceHealthError, "does not match source counts"):
            validate_source_health(inconsistent)

        inconsistent = copy.deepcopy(health)
        inconsistent["providers"][0]["camera_sources"] = ["dot<script>"]
        with self.assertRaisesRegex(SourceHealthError, "camera_sources"):
            validate_source_health(inconsistent)

    def test_failure_classifier_is_closed_and_drops_provider_detail(self):
        self.assertEqual("rate_limited", classify_failure("HTTP 429 at https://secret.example"))
        self.assertEqual("incomplete_snapshot", classify_failure("truncated_inventory:2<20"))
        self.assertEqual("scheduled_offline", classify_failure("outside the 07:00-19:00 live window"))
        self.assertEqual("provider_error", classify_failure("token=super-secret vendor-specific failure"))


if __name__ == "__main__":
    unittest.main()
