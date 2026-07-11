from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_cameras  # noqa: E402
import camera_data  # noqa: E402
from fetch_cameras import ProviderResult, merge_provider_results  # noqa: E402


def camera(camera_id: int, url: str, *, source: str = "dot", provider: str | None = None):
    value = {
        "id": camera_id,
        "name": f"Camera {camera_id}",
        "lat": 40.0 + camera_id / 100,
        "lon": -75.0,
        "url": url,
        "type": "image",
        "state": "Test",
        "county": "",
        "direction": "",
        "source": source,
    }
    if provider:
        value["provider"] = provider
    return value


class FetchMergeTests(unittest.TestCase):
    def setUp(self):
        fetch_cameras.cameras.clear()
        fetch_cameras.cam_id = 0
        fetch_cameras.stats.clear()

    def test_outage_retains_provider_and_curated_rows(self):
        existing = [
            camera(1, "https://dot.test/old.jpg", provider="Provider A"),
            camera(2, "https://curated.test/live.jpg", source="earthcam"),
        ]
        merged = merge_provider_results(existing, [ProviderResult("Provider A", [], "timeout")])
        self.assertEqual(existing, merged)

    def test_success_replaces_tagged_provider_without_erasing_legacy(self):
        existing = [
            camera(1, "https://dot.test/old.jpg", provider="Provider A"),
            camera(2, "https://dot.test/legacy.jpg"),
        ]
        fresh = camera(99, "https://dot.test/new.jpg", provider="Provider A")
        merged = merge_provider_results(existing, [ProviderResult("Provider A", [fresh])])
        self.assertEqual(
            ["https://dot.test/new.jpg", "https://dot.test/legacy.jpg"],
            [row["url"] for row in merged],
        )
        self.assertEqual([1, 2], [row["id"] for row in merged])

    def test_truncated_provider_snapshot_retains_previous_rows(self):
        existing = [
            camera(index, f"https://dot.test/{index}.jpg", provider="Provider A")
            for index in range(1, 11)
        ]
        existing.append(camera(11, "https://curated.test/new.jpg", source="earthcam"))
        fresh = camera(99, "https://dot.test/only-one.jpg", provider="Provider A")
        merged = merge_provider_results(existing, [ProviderResult("Provider A", [fresh])])
        self.assertNotIn(fresh["url"], [row["url"] for row in merged])
        self.assertEqual(11, len(merged))
        self.assertIn("https://curated.test/new.jpg", [row["url"] for row in merged])

    def test_partial_caltrans_district_failure_is_not_committable(self):
        first_district = {
            "data": [
                {
                    "cctv": {
                        "location": {"locationName": "D1", "latitude": 40, "longitude": -75},
                        "imageData": {"static": {"currentImageURL": "https://dot.test/d1.jpg"}},
                    }
                }
            ]
        }

        def fetch(url, *_args, **_kwargs):
            if "/d1/" in url:
                return first_district
            raise RuntimeError("district unavailable")

        with mock.patch.object(fetch_cameras, "fetch_json", side_effect=fetch):
            result = fetch_cameras.run_fetcher("Caltrans (California)", fetch_cameras.fetch_caltrans)
        self.assertFalse(result.succeeded)
        self.assertEqual([], fetch_cameras.cameras)

    def test_fetch_commit_merges_against_data_added_during_provider_collection(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cameras.json"
            original = [camera(1, "https://dot.test/old.jpg", provider="Provider A")]
            path.write_text(json.dumps(original), encoding="utf-8")

            def fetch_provider():
                def add_concurrent(current):
                    current.append(camera(2, "https://curated.test/concurrent.jpg", source="earthcam"))

                camera_data.update_camera_data(path, add_concurrent)
                fetch_cameras.add_camera(
                    "Fresh",
                    40,
                    -75,
                    "https://dot.test/fresh.jpg",
                    source="dot",
                )
                return 1

            with (
                mock.patch.object(fetch_cameras, "OUTPUT", path),
                mock.patch.object(fetch_cameras, "provider_fetchers", return_value=[("Provider A", fetch_provider)]),
            ):
                self.assertEqual(0, fetch_cameras.main([]))

            urls = [row["url"] for row in json.loads(path.read_text(encoding="utf-8"))]
            self.assertEqual(
                ["https://dot.test/fresh.jpg", "https://curated.test/concurrent.jpg"],
                urls,
            )


if __name__ == "__main__":
    unittest.main()
