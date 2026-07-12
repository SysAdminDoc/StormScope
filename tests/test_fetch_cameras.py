from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.error
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
    value.update(camera_data.unknown_metadata(camera_data.canonical_source_url("image", url)))
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
        self.assertEqual("degraded", merged[0]["health"])
        self.assertEqual("provider_error", merged[0]["failure_class"])
        self.assertEqual("unknown", merged[1]["health"])
        self.assertEqual(2, len(merged))

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

    def test_new_provider_is_appended_without_renumbering_existing_rows(self):
        existing = [camera(1, "https://dot.test/legacy.jpg")]
        fresh = camera(99, "https://dot.test/new.jpg", provider="Provider B")
        merged = merge_provider_results(existing, [ProviderResult("Provider B", [fresh])])
        self.assertEqual(
            ["https://dot.test/legacy.jpg", "https://dot.test/new.jpg"],
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
            dataset = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual("healthy", dataset[0]["health"])
            self.assertIsNotNone(dataset[0]["last_verified"])
            self.assertEqual("https://dot.test/fresh.jpg", dataset[0]["source_url"])
            self.assertEqual("unknown", dataset[1]["health"])

    def test_hls_verification_requires_an_advancing_media_playlist(self):
        with (
            mock.patch.object(
                fetch_cameras,
                "_hls_snapshot",
                side_effect=[(10, ("segment-10.ts",)), (11, ("segment-11.ts",))],
            ),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors = fetch_cameras.verify_live_hls(
                ["https://stream.test/live.m3u8"], probe_interval=0, workers=1
            )
        self.assertEqual({"https://stream.test/live.m3u8"}, verified)
        self.assertEqual({}, errors)

    def test_hls_verification_rejects_a_stale_media_playlist(self):
        snapshot = (10, ("segment-10.ts",))
        with (
            mock.patch.object(fetch_cameras, "_hls_snapshot", side_effect=[snapshot, snapshot]),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors = fetch_cameras.verify_live_hls(
                ["https://stream.test/stale.m3u8"], probe_interval=0, workers=1
            )
        self.assertEqual(set(), verified)
        self.assertEqual(
            "confirmed_not_live:not_advancing",
            errors["https://stream.test/stale.m3u8"],
        )

    def test_hls_verification_classifies_missing_streams_as_confirmed_dead(self):
        missing = urllib.error.HTTPError(
            "https://stream.test/missing.m3u8", 404, "Not Found", {}, None
        )
        with mock.patch.object(fetch_cameras, "_hls_snapshot", side_effect=missing):
            verified, errors = fetch_cameras.verify_live_hls(
                ["https://stream.test/missing.m3u8"], probe_interval=0, workers=1
            )
        self.assertEqual(set(), verified)
        self.assertEqual(
            "confirmed_dead:http_404",
            errors["https://stream.test/missing.m3u8"],
        )

    def test_oktraffic_uses_provider_coordinates_and_verified_hls(self):
        payload = [
            {
                "id": 3,
                "name": "I-44 & I-240",
                "mapCameras": [
                    {
                        "id": 1103130967,
                        "latitude": "35.39637",
                        "longitude": "-97.57406",
                        "location": "I-44 & I-240 N",
                        "direction": "N",
                        "city": "Oklahoma City",
                        "recordTime": "2026-07-11 19:05:42",
                        "streamDictionary": {
                            "streamSrc": "https://stream.oktraffic.org/live/one.m3u8"
                        },
                    }
                ],
            }
        ]
        with (
            mock.patch.object(fetch_cameras, "fetch_json", return_value=payload),
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                return_value=({"https://stream.oktraffic.org/live/one.m3u8"}, {}),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher("Oklahoma (OKTraffic)", fetch_cameras.fetch_oktraffic)
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Oklahoma", row["state"])
        self.assertEqual("Oklahoma City", row["county"])
        self.assertEqual("1103130967", row["provider_camera_id"])
        self.assertEqual("Oklahoma (OKTraffic)", row["provider"])
        self.assertEqual(10, row["refresh_cadence_seconds"])
        self.assertEqual("healthy", row["health"])
        self.assertEqual("https://oktraffic.org/tcameras/camera.aspx?id=3", row["source_url"])


if __name__ == "__main__":
    unittest.main()
