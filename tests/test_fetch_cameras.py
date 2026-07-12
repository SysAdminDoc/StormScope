from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
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

    def test_verified_provider_can_replace_a_legacy_source_page(self):
        source_page = "https://www.nps.gov/media/webcam/view.htm?id=test"
        legacy = camera(1, source_page, source="nps")
        legacy["type"] = "embed"
        legacy["source_url"] = source_page
        fresh = camera(
            99,
            "https://www.nps.gov/webcams-test/current.jpg",
            source="nps",
            provider="Verified NPS",
        )
        fresh["source_url"] = source_page
        fresh["_replace_source_page"] = True

        merged = merge_provider_results(
            [legacy], [ProviderResult("Verified NPS", [fresh])]
        )

        self.assertEqual(1, len(merged))
        self.assertEqual(fresh["url"], merged[0]["url"])
        self.assertNotIn("_replace_source_page", merged[0])

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

    def test_hls_verification_does_not_confirm_dead_from_one_failed_probe(self):
        missing = urllib.error.HTTPError(
            "https://stream.test/flaky.m3u8", 404, "Not Found", {}, None
        )
        with mock.patch.object(
            fetch_cameras,
            "_hls_snapshot",
            side_effect=[missing, (11, ("segment-11.ts",))],
        ):
            verified, errors = fetch_cameras.verify_live_hls(
                ["https://stream.test/flaky.m3u8"], probe_interval=0, workers=1
            )
        self.assertEqual(set(), verified)
        self.assertEqual(
            "transient_network:inconsistent_probes:confirmed_dead:http_404",
            errors["https://stream.test/flaky.m3u8"],
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

    def test_deldot_accepts_only_active_advancing_https_streams(self):
        active_url = "https://video.deldot.gov/live/KCAM002.stream/playlist.m3u8"
        payload = {
            "timestamp": "2026-07-12T00:00:00Z",
            "videoCameras": [
                {
                    "id": "KCAM002",
                    "title": "W North St @ West Dover Connector",
                    "county": "Kent",
                    "lat": 39.153462,
                    "lon": -75.542016,
                    "enabled": True,
                    "status": "Active",
                    "urls": {"m3u8s": active_url},
                },
                {
                    "id": "KCAM003",
                    "title": "Unavailable",
                    "enabled": True,
                    "status": "Unavailable",
                    "urls": {
                        "m3u8s": "https://video.deldot.gov/live/KCAM003.stream/playlist.m3u8"
                    },
                },
            ],
        }
        with (
            mock.patch.object(fetch_cameras, "fetch_json", return_value=payload),
            mock.patch.object(fetch_cameras, "verify_live_hls", return_value=({active_url}, {})),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Delaware (live HLS)", fetch_cameras.fetch_delaware_live
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Delaware", row["state"])
        self.assertEqual("Kent", row["county"])
        self.assertEqual("KCAM002", row["provider_camera_id"])
        self.assertEqual(10, row["refresh_cadence_seconds"])
        self.assertEqual("https://tmc.deldot.gov/json/videocamera.json", row["source_url"])

    def test_wv511_uses_official_map_coordinates_and_advancing_player_stream(self):
        camera_id = "CAM117"
        stream_url = "https://vtc2.roadsummary.com/rtplive/CAM117/playlist.m3u8"
        inventory = {
            "count": 1,
            "cams": [
                {
                    "md5": camera_id,
                    "title": "I-81",
                    "description": (
                        '<div id="camDescription">[BER]I-81 @ 0.5'
                        '<span>West Virginia DOT</span></div><!--STREAMING:1-->'
                    ),
                    "start_lat": "39.302863",
                    "start_lng": "-78.078892",
                    "icon": "icon_feed",
                }
            ],
        }

        def response(url, **_kwargs):
            if "buildCamerasJSONjs" in url:
                return ("var camera_data = " + json.dumps(inventory)).encode()
            if "flowplayeri.aspx" in url:
                return f'<source src="{stream_url}">'.encode()
            raise AssertionError(url)

        with (
            mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response),
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                return_value=({stream_url}, {}),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "West Virginia (WV511)", fetch_cameras.fetch_wv511
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("West Virginia", row["state"])
        self.assertEqual("Berkeley", row["county"])
        self.assertEqual(camera_id, row["provider_camera_id"])
        self.assertEqual("I-81 @ 0.5", row["name"])
        self.assertEqual(39.302863, row["lat"])
        self.assertEqual(-78.078892, row["lon"])
        self.assertEqual(stream_url, row["url"])
        self.assertEqual("hls", row["type"])
        self.assertEqual(10, row["refresh_cadence_seconds"])
        self.assertEqual(
            "https://wv511.org/flowplayeri.aspx?CAMID=CAM117", row["source_url"]
        )
        verifier.assert_called_once_with(
            [stream_url], probe_interval=10.0, workers=12, referer="https://wv511.org/"
        )

    def test_wv511_rejects_a_truncated_inventory_before_stream_resolution(self):
        payload = "var camera_data = " + json.dumps({"count": 2, "cams": []})
        with self.assertRaises(fetch_cameras.IncompleteProviderError):
            fetch_cameras._parse_wv511_inventory(payload)

    def test_wydot_is_not_ingested_without_hotlink_permission(self):
        with mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer:
            result = fetch_cameras.run_fetcher("Wyoming DOT", fetch_cameras.fetch_wyoming)
        self.assertFalse(result.succeeded)
        self.assertIn("licensing_restricted", result.error)
        self.assertEqual([], result.cameras)
        report = report_writer.call_args.args[1]
        self.assertEqual(757, report["inventory_views"])
        self.assertEqual("licensing_restricted", report["failure_class"])

    def test_nmroads_uses_https_proxy_and_exact_provider_metadata(self):
        payload = {
            "cameraInfo": [{
                "name": "I-25@La_Bajada_Lower",
                "title": "I-25 NB @ Lower La Bajada",
                "enabled": True,
                "lat": 35.506,
                "lon": -106.244,
                "snapshotFile": "http://ss.nmroads.com/snapshots/test.jpg",
            }]
        }
        snapshots = {
            "I-25@La_Bajada_Lower": (
                "hash", 8229, "2026-07-12T09:34:44+00:00"
            )
        }
        with (
            mock.patch.object(fetch_cameras, "fetch_json", return_value=payload),
            mock.patch.object(
                fetch_cameras,
                "verify_nmroads_images",
                return_value=({"I-25@La_Bajada_Lower"}, {}, snapshots),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
        ):
            result = fetch_cameras.run_fetcher(
                "New Mexico DOT", fetch_cameras.fetch_newmexico
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("I-25@La_Bajada_Lower", row["provider_camera_id"])
        self.assertEqual(35.506, row["lat"])
        self.assertEqual(-106.244, row["lon"])
        self.assertEqual("N", row["direction"])
        self.assertTrue(row["url"].startswith("https://servicev5.nmroads.com/"))
        self.assertNotIn("ss.nmroads.com", row["url"])
        report = report_writer.call_args.args[1]
        self.assertEqual(1, report["inventory_total"])
        self.assertEqual(1, report["verified_live"])
        self.assertEqual([], report["rejected"])

    def test_nmroads_verification_requires_a_current_advancing_provider_frame(self):
        candidate = {"name": "I-40@Test"}
        first = ("hash-one", 8000, "2026-07-12T09:30:00+00:00")
        second = ("hash-two", 8100, "2026-07-12T09:31:00+00:00")
        with (
            mock.patch.object(
                fetch_cameras, "_nmroads_snapshot", side_effect=[first, second]
            ),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors, snapshots = fetch_cameras.verify_nmroads_images(
                [candidate], probe_interval=0, workers=1
            )
        self.assertEqual({"I-40@Test"}, verified)
        self.assertEqual({}, errors)
        self.assertEqual(second, snapshots["I-40@Test"])

    def test_tennessee_smartway_uses_current_public_config_and_advancing_hls(self):
        config = {
            "apiBaseUrl": "https://www.tdot.tn.gov/opendata/api/public/",
            "apiKey": "published-key",
            "cameras": "RoadwayCameras",
        }
        inventory = [{
            "id": 3165,
            "title": "I-40/75 @ West Hills",
            "active": "true",
            "jurisdiction": "Knoxville",
            "lat": 35.928889,
            "lng": -84.039167,
            "httpsVideoUrl": (
                "https://mcleansfs1.us-east-1.skyvdn.com:443/"
                "rtplive/R1_010/playlist.m3u8"
            ),
        }]
        stream_url = inventory[0]["httpsVideoUrl"]
        with (
            mock.patch.object(
                fetch_cameras, "fetch_json", side_effect=[config, inventory]
            ) as json_fetcher,
            mock.patch.object(
                fetch_cameras, "verify_tennessee_hls", return_value=({stream_url}, {})
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
            mock.patch.object(fetch_cameras, "TENNESSEE_DOT_MINIMUM_INVENTORY", 1),
        ):
            result = fetch_cameras.run_fetcher(
                "Tennessee DOT (SmartWay)", fetch_cameras.fetch_tndot
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Tennessee", row["state"])
        self.assertEqual("dot", row["source"])
        self.assertEqual("hls", row["type"])
        self.assertEqual("3165", row["provider_camera_id"])
        self.assertEqual(stream_url, row["url"])
        self.assertEqual(fetch_cameras.TENNESSEE_DOT_SOURCE, row["source_url"])
        self.assertEqual(
            {"ApiKey": "published-key"}, json_fetcher.call_args_list[1].kwargs["headers"]
        )
        verifier.assert_called_once_with([stream_url])
        self.assertEqual(1, report_writer.call_args.args[1]["verified_live"])

    def test_tennessee_smartway_excludes_mobile_duplicate_and_placeholder_rows(self):
        self.assertEqual(
            {
                3309, 3325, 4242, 4243, 4244, 4245, 4672, 6162, 6169,
            },
            set(fetch_cameras.TENNESSEE_DOT_EXCLUSIONS),
        )
        self.assertTrue(
            fetch_cameras.TENNESSEE_DOT_EXCLUSIONS[6162].startswith(
                "location_ambiguous:"
            )
        )
        self.assertTrue(
            fetch_cameras.TENNESSEE_DOT_EXCLUSIONS[4242].startswith("duplicate:")
        )
        self.assertTrue(
            fetch_cameras.TENNESSEE_DOT_EXCLUSIONS[3309].startswith("placeholder:")
        )

    def test_tennessee_hls_limits_each_media_host_and_retries_transients(self):
        hosts = [
            "https://one.skyvdn.com/a.m3u8",
            "https://one.skyvdn.com/b.m3u8",
            "https://two.skyvdn.com/c.m3u8",
        ]
        attempts = {url: 0 for url in hosts}

        def verify_group(urls, **_kwargs):
            for url in urls:
                attempts[url] += 1
            if urls == hosts[:2] and attempts[hosts[1]] == 1:
                return {hosts[0]}, {hosts[1]: "transient_network:http_503"}
            return set(urls), {}

        with (
            mock.patch.object(
                fetch_cameras, "verify_live_hls", side_effect=verify_group
            ) as verifier,
            mock.patch.object(fetch_cameras.time, "sleep") as sleeper,
        ):
            verified, errors = fetch_cameras.verify_tennessee_hls(
                hosts, probe_interval=0, retry_delay=15
            )
        self.assertEqual(set(hosts), verified)
        self.assertEqual({}, errors)
        self.assertEqual(3, verifier.call_count)
        self.assertTrue(all(
            call.kwargs == {"probe_interval": 0, "workers": 1}
            for call in verifier.call_args_list
        ))
        sleeper.assert_called_once_with(15)

    def test_tennessee_nps_uses_exact_sites_and_replaces_legacy_embeds(self):
        camera_ids = {
            item["provider_camera_id"] for item in fetch_cameras.TENNESSEE_NPS_FEEDS
        }
        snapshots = {
            camera_id: ("hash", 200000, "2026-07-12T09:55:13+00:00")
            for camera_id in camera_ids
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(camera_ids, {}, snapshots),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Tennessee NPS verified",
                fetch_cameras.fetch_tennessee_nps_verified,
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(2, len(result.cameras))
        self.assertTrue(all(row["state"] == "Tennessee" for row in result.cameras))
        self.assertTrue(all(row["source"] == "nps" for row in result.cameras))
        self.assertTrue(all(row["type"] == "image" for row in result.cameras))
        self.assertTrue(all(row["_replace_source_page"] for row in result.cameras))
        self.assertEqual({"Blount County", "Sevier County"}, {
            row["county"] for row in result.cameras
        })

    def test_massachusetts_nps_requires_all_current_monument_and_lighthouse_views(self):
        camera_ids = {
            item["provider_camera_id"]
            for item in fetch_cameras.MASSACHUSETTS_NPS_FEEDS
        }
        snapshots = {
            camera_id: ("hash", 400000, "2026-07-12T10:50:24+00:00")
            for camera_id in camera_ids
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(camera_ids, {}, snapshots),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Massachusetts NPS verified",
                fetch_cameras.fetch_massachusetts_nps_verified,
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(11, len(result.cameras))
        self.assertTrue(all(row["state"] == "Massachusetts" for row in result.cameras))
        self.assertTrue(all(row["county"] == "Suffolk County" for row in result.cameras))
        self.assertTrue(all(row["source"] == "nps" for row in result.cameras))
        self.assertEqual({"N", "E", "S", "W"}, {
            row["direction"] for row in result.cameras
        })
        self.assertEqual(camera_ids, {
            row["provider_camera_id"] for row in result.cameras
        })
        verifier.assert_called_once_with(
            [dict(item) for item in fetch_cameras.MASSACHUSETTS_NPS_FEEDS],
            probe_interval=2.0,
            workers=8,
        )

    def test_massachusetts_nps_partial_snapshot_fails_closed(self):
        candidate = fetch_cameras.MASSACHUSETTS_NPS_FEEDS[0]
        snapshots = {
            candidate["provider_camera_id"]: (
                "hash", 400000, "2026-07-12T10:50:24+00:00"
            )
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(
                    {candidate["provider_camera_id"]},
                    {},
                    snapshots,
                ),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Massachusetts NPS verified",
                fetch_cameras.fetch_massachusetts_nps_verified,
            )
        self.assertFalse(result.succeeded)
        self.assertEqual([], result.cameras)
        self.assertIn("truncated_verified_inventory:1<11", result.error)

    def test_massachusetts_mwra_accepts_only_two_unobstructed_advancing_hls(self):
        urls = {item["url"] for item in fetch_cameras.MASSACHUSETTS_MWRA_FEEDS}
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                return_value=(urls, {}),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Massachusetts MWRA", fetch_cameras.fetch_massachusetts_mwra
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(2, len(result.cameras))
        self.assertTrue(all(row["state"] == "Massachusetts" for row in result.cameras))
        self.assertTrue(all(row["source"] == "mwra" for row in result.cameras))
        self.assertTrue(all(row["type"] == "hls" for row in result.cameras))
        self.assertEqual({"Suffolk County", "Worcester County"}, {
            row["county"] for row in result.cameras
        })
        verifier.assert_called_once_with(
            [item["url"] for item in fetch_cameras.MASSACHUSETTS_MWRA_FEEDS],
            probe_interval=8.0,
            workers=2,
            referer=fetch_cameras.MASSACHUSETTS_MWRA_SOURCE,
        )

    def test_massachusetts_mwra_partial_snapshot_fails_closed(self):
        candidate = fetch_cameras.MASSACHUSETTS_MWRA_FEEDS[0]
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                return_value=({candidate["url"]}, {}),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Massachusetts MWRA", fetch_cameras.fetch_massachusetts_mwra
            )
        self.assertFalse(result.succeeded)
        self.assertEqual([], result.cameras)
        self.assertIn("truncated_verified_inventory:1<2", result.error)

    def test_clarksville_accepts_only_official_unlocked_advancing_players(self):
        candidate = fetch_cameras.TENNESSEE_CLARKSVILLE_FEEDS[0]
        alias, _name, _lat, _lon, source_page = candidate
        player_url = (
            f"https://g1.ipcamlive.com/player/player.php?alias={alias}"
            "&autoplay=1&mute=1"
        )
        hls_url = "https://s69.ipcamlive.com/streams/streamid/stream.m3u8"

        def response(url, **_kwargs):
            if url == fetch_cameras.TENNESSEE_CLARKSVILLE_SOURCE:
                return urllib.parse.urlsplit(source_page).path.encode()
            if url == source_page:
                return f'<iframe src="{player_url.replace("&", "&amp;")}"></iframe>'.encode()
            if url == player_url:
                return (
                    "var available = 1; var domainlockenabled = 0; "
                    "var address = 'http://s69.ipcamlive.com/'; "
                    "var streamid = 'streamid'; "
                    f"var alias = '{alias}';"
                ).encode()
            raise AssertionError(url)

        with (
            mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response),
            mock.patch.object(
                fetch_cameras, "verify_live_hls", return_value=({hls_url}, {})
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
            mock.patch.object(
                fetch_cameras, "TENNESSEE_CLARKSVILLE_FEEDS", (candidate,)
            ),
        ):
            result = fetch_cameras.run_fetcher(
                "Tennessee Clarksville IPCamLive",
                fetch_cameras.fetch_tennessee_clarksville,
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("ipcamlive", row["source"])
        self.assertEqual("embed", row["type"])
        self.assertEqual("Tennessee", row["state"])
        self.assertEqual("Montgomery County", row["county"])
        self.assertEqual(player_url, row["url"])
        verifier.assert_called_once_with([hls_url], probe_interval=6.0, workers=5)
        self.assertEqual(1, report_writer.call_args.args[1]["verified_live"])

    def test_ipcamlive_domain_lock_is_not_bypassed(self):
        source_page = "https://example.gov/camera"
        alias = "lockedalias"
        player_url = (
            "https://g1.ipcamlive.com/player/player.php?"
            f"alias={alias}&autoplay=1"
        )

        def response(url, **_kwargs):
            if url == source_page:
                return f'<iframe src="{player_url.replace("&", "&amp;")}"></iframe>'.encode()
            return (
                "var available = 1; var domainlockenabled = 1; "
                "var address = 'http://s69.ipcamlive.com/'; "
                "var streamid = 'streamid'; "
                f"var alias = '{alias}';"
            ).encode()

        with mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response):
            with self.assertRaisesRegex(ValueError, "domain_locked"):
                fetch_cameras._resolve_ipcamlive_player(source_page, alias)

    def test_new_mexico_nws_accepts_three_current_official_views(self):
        camera_ids = {
            item["provider_camera_id"] for item in fetch_cameras.NEW_MEXICO_NWS_FEEDS
        }
        snapshots = {
            camera_id: ("hash", 100000, "2026-07-12T09:15:00+00:00")
            for camera_id in camera_ids
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(camera_ids, {}, snapshots),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "New Mexico NWS", fetch_cameras.fetch_new_mexico_nws
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(3, len(result.cameras))
        self.assertTrue(all(row["source"] == "noaa" for row in result.cameras))
        self.assertTrue(all(row["state"] == "New Mexico" for row in result.cameras))
        self.assertTrue(all(row["county"] == "Bernalillo County" for row in result.cameras))
        self.assertTrue(all(row["refresh_cadence_seconds"] == 300 for row in result.cameras))
        self.assertEqual(camera_ids, {
            row["provider_camera_id"] for row in result.cameras
        })

    def test_new_mexico_nps_replaces_the_legacy_source_page_embed(self):
        candidate = fetch_cameras.NEW_MEXICO_NPS_FEEDS[0]
        snapshots = {
            candidate["provider_camera_id"]: (
                "hash", 100000, "2026-07-12T09:20:47+00:00"
            )
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=({candidate["provider_camera_id"]}, {}, snapshots),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "New Mexico NPS verified",
                fetch_cameras.fetch_new_mexico_nps_verified,
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("New Mexico", row["state"])
        self.assertEqual("nps", row["source"])
        self.assertEqual(candidate["url"], row["url"])
        self.assertTrue(row["_replace_source_page"])

    def test_new_mexico_usgs_accepts_only_current_exact_site_feeds(self):
        camera_ids = {
            item["provider_camera_id"] for item in fetch_cameras.NEW_MEXICO_USGS_FEEDS
        }
        snapshots = {
            camera_id: ("hash", 100000, "2026-07-12T09:22:37+00:00")
            for camera_id in camera_ids
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(camera_ids, {}, snapshots),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "New Mexico USGS", fetch_cameras.fetch_new_mexico_usgs
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(3, len(result.cameras))
        self.assertTrue(all(row["source"] == "usgs" for row in result.cameras))
        self.assertTrue(all(row["state"] == "New Mexico" for row in result.cameras))
        self.assertTrue(all(row["county"] == "Lincoln County" for row in result.cameras))
        self.assertEqual(camera_ids, {
            row["provider_camera_id"] for row in result.cameras
        })

    def test_new_mexico_nrao_requires_an_advancing_first_party_image(self):
        candidate = fetch_cameras.NEW_MEXICO_NRAO_FEEDS[0]
        snapshots = {
            candidate["provider_camera_id"]: (
                "hash-two", 224632, "2026-07-12T09:24:16+00:00"
            )
        }
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=({candidate["provider_camera_id"]}, {}, snapshots),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "New Mexico NRAO", fetch_cameras.fetch_new_mexico_nrao
            )
        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        self.assertEqual("nrao", result.cameras[0]["source"])
        self.assertEqual("NE", result.cameras[0]["direction"])
        verifier.assert_called_once_with(
            [dict(candidate)], probe_interval=16.0, workers=1
        )

    def test_pr_act_image_verification_requires_advancing_current_snapshots(self):
        candidate = {"camera_id": "13"}
        first = (100, "hash-one", 4000, "2026-07-12T03:30:00-04:00")
        second = (103, "hash-two", 4100, "2026-07-12T03:30:03-04:00")
        with (
            mock.patch.object(fetch_cameras, "_pr_act_snapshot", side_effect=[first, second]),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors, snapshots = fetch_cameras.verify_pr_act_images(
                [candidate], probe_interval=0, workers=1
            )
        self.assertEqual({"13"}, verified)
        self.assertEqual({}, errors)
        self.assertEqual(second, snapshots["13"])

    def test_pr_act_uses_exact_provider_coordinates_and_current_image_metadata(self):
        inventory = {
            "d": {
                "Success": True,
                "Cctv": [
                    {
                        "Id": 13,
                        "Name": "26-0.7_02 NB-IPV",
                        "LocationEn": "PR-26 Miramar",
                        "Latitude": 18.456976,
                        "Longitude": -66.080456,
                        "ImageUrl": "/images/cameras/26-0.7_02_MD-IPV.jpg",
                    }
                ],
            }
        }
        snapshot = (1783841403, "hash", 54004, "2026-07-12T03:30:03-04:00")
        with (
            mock.patch.object(fetch_cameras, "PR_ACT_MINIMUM_INVENTORY", 1),
            mock.patch.object(fetch_cameras, "post_json", return_value=inventory),
            mock.patch.object(
                fetch_cameras,
                "verify_pr_act_images",
                return_value=({"13"}, {}, {"13": snapshot}),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Puerto Rico (ACT/ITS)", fetch_cameras.fetch_pr_act
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Puerto Rico", row["state"])
        self.assertEqual("PR-26 Miramar (26-0.7_02 NB-IPV)", row["name"])
        self.assertEqual(18.456976, row["lat"])
        self.assertEqual(-66.080456, row["lon"])
        self.assertEqual("NB", row["direction"])
        self.assertEqual("13", row["provider_camera_id"])
        self.assertEqual(
            "https://its.act.pr.gov/images/cameras/26-0.7_02_MD-IPV.jpg",
            row["url"],
        )
        self.assertEqual("2026-07-12T03:30:03-04:00", row["provider_timestamp"])
        self.assertEqual(30, row["refresh_cadence_seconds"])
        self.assertEqual(
            "https://its.act.pr.gov/en/TrafficImage.aspx?Large=1&id=13",
            row["source_url"],
        )

    def test_guam_gntf_accepts_only_the_first_party_unlocked_advancing_embed(self):
        hls_url = "https://s116.ipcamlive.com/streams/currentstream/master.m3u8"
        homepage = (
            '<a href="https://g3.ipcamlive.com/player/player.php?'
            'alias=62737dba77480&mute=1">Camera</a>'
        ).encode()
        player = b"""
            var alias = '62737dba77480';
            var available = 1;
            var address = 'http://s116.ipcamlive.com/';
            var streamid = 'currentstream';
            var domainlockenabled = 0;
        """

        def response(url, **_kwargs):
            if url == "https://gntf.org/":
                return homepage
            if "g3.ipcamlive.com/player/player.php" in url:
                return player
            raise AssertionError(url)

        with (
            mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response),
            mock.patch.object(
                fetch_cameras, "verify_live_hls", return_value=({hls_url}, {})
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Guam (GNTF/IPCamLive)", fetch_cameras.fetch_guam_gntf
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Guam", row["state"])
        self.assertEqual("Dededo", row["county"])
        self.assertEqual("ipcamlive", row["source"])
        self.assertEqual("embed", row["type"])
        self.assertEqual("62737dba77480", row["provider_camera_id"])
        self.assertEqual("sports", row["category"])
        self.assertEqual(13.509444, row["lat"])
        self.assertEqual(144.826667, row["lon"])
        self.assertEqual("https://gntf.org/", row["source_url"])
        verifier.assert_called_once_with(
            [hls_url],
            probe_interval=6.0,
            workers=1,
            referer=row["url"],
        )

    def test_american_samoa_clipper_accepts_only_current_first_party_snapshot(self):
        alias = "6477b73ed2f62"
        player_url = (
            "https://g3.ipcamlive.com/player/player.php?alias=6477b73ed2f62"
        )
        hls_url = "https://s116.ipcamlive.com/streams/currentstream/master.m3u8"
        provider_timestamp = "2026-07-12T12:52:38+00:00"
        with (
            mock.patch.object(
                fetch_cameras,
                "_resolve_ipcamlive_player",
                return_value=(player_url, hls_url),
            ),
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(
                    {alias},
                    {},
                    {alias: ("frame-hash", 169031, provider_timestamp)},
                ),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
        ):
            result = fetch_cameras.run_fetcher(
                "American Samoa (Clipper Oil/IPCamLive)",
                fetch_cameras.fetch_american_samoa_clipper,
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("American Samoa", row["state"])
        self.assertEqual("Maoputasi County", row["county"])
        self.assertEqual("image", row["type"])
        self.assertEqual("ipcamlive", row["source"])
        self.assertEqual(alias, row["provider_camera_id"])
        self.assertEqual("harbor", row["category"])
        self.assertEqual(-14.277244, row["lat"])
        self.assertEqual(-170.685222, row["lon"])
        self.assertEqual(120, row["refresh_cadence_seconds"])
        self.assertEqual(
            "https://clipperoil.com/americansamoa/webcam/", row["source_url"]
        )
        self.assertEqual(provider_timestamp, row["provider_timestamp"])
        candidates = verifier.call_args.args[0]
        self.assertEqual(
            [{
                "provider_camera_id": alias,
                "url": row["url"],
                "max_age_seconds": 300,
            }],
            candidates,
        )
        self.assertEqual(2.0, verifier.call_args.kwargs["probe_interval"])
        self.assertEqual(1, verifier.call_args.kwargs["workers"])
        report = report_writer.call_args.args[1]
        self.assertEqual(1, report["verified_live"])
        self.assertEqual([], report["rejected"])

    def test_american_samoa_clipper_fails_closed_on_stale_snapshot(self):
        alias = "6477b73ed2f62"
        with (
            mock.patch.object(
                fetch_cameras,
                "_resolve_ipcamlive_player",
                return_value=("https://example.test/player", "https://example.test/live.m3u8"),
            ),
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(
                    set(),
                    {alias: "placeholder:stale_provider_timestamp"},
                    {},
                ),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
        ):
            result = fetch_cameras.run_fetcher(
                "American Samoa (Clipper Oil/IPCamLive)",
                fetch_cameras.fetch_american_samoa_clipper,
            )

        self.assertFalse(result.succeeded)
        self.assertEqual([], result.cameras)
        self.assertIn("snapshot unavailable", result.error)
        report = report_writer.call_args.args[1]
        self.assertEqual(0, report["verified_live"])
        self.assertEqual(
            "placeholder:stale_provider_timestamp",
            report["rejected"][0]["failure_class"],
        )

    def test_smithsonian_accepts_only_advancing_first_party_zoo_hls(self):
        urls = [
            "https://nzp-wowza02.si.edu/live_edge_nmr/nmr_1080_all.smil/playlist.m3u8",
            "https://nzp-wowza02.si.edu/live_edge_nmr_02/nmr_02_1080_all.smil/playlist.m3u8",
            "https://nzp-wowza01.si.edu/live_edge_lion/smil:lion01_all.smil/playlist.m3u8",
        ]
        with (
            mock.patch.object(
                fetch_cameras, "verify_live_hls", return_value=(set(urls), {})
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Smithsonian National Zoo",
                fetch_cameras.fetch_smithsonian_national_zoo,
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(3, len(result.cameras))
        self.assertEqual(["11305", "11307", "11330"], [
            row["provider_camera_id"] for row in result.cameras
        ])
        self.assertTrue(all(row["source"] == "smithsonian" for row in result.cameras))
        self.assertTrue(all(row["type"] == "hls" for row in result.cameras))
        self.assertTrue(all(row["state"] == "DC" for row in result.cameras))
        self.assertEqual(2, sum(
            row["lat"] == 38.930417 and row["lon"] == -77.048944
            for row in result.cameras
        ))
        verifier.assert_called_once_with(
            urls,
            probe_interval=8.0,
            workers=3,
            referer="https://nationalzoo.si.edu/webcams",
        )

    def test_nps_image_verification_requires_two_current_provider_snapshots(self):
        candidate = {
            "provider_camera_id": "yell-test",
            "url": "https://www.nps.gov/webcams-yell/test.jpg",
        }
        first = ("hash-one", 40000, "2026-07-12T09:00:00+00:00")
        second = ("hash-two", 41000, "2026-07-12T09:01:00+00:00")
        with (
            mock.patch.object(fetch_cameras, "_current_jpeg_snapshot", side_effect=[first, second]),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors, snapshots = fetch_cameras.verify_current_jpeg_images(
                [candidate], probe_interval=0, workers=1
            )
        self.assertEqual({"yell-test"}, verified)
        self.assertEqual({}, errors)
        self.assertEqual(second, snapshots["yell-test"])

    def test_current_jpeg_verification_can_require_content_advancement(self):
        candidate = {
            "provider_camera_id": "fast-refresh",
            "url": "https://example.com/current.jpg",
            "require_content_change": True,
        }
        snapshot = ("same-hash", 40000, "2026-07-12T09:00:00+00:00")
        with (
            mock.patch.object(
                fetch_cameras, "_current_jpeg_snapshot", side_effect=[snapshot, snapshot]
            ),
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors, _snapshots = fetch_cameras.verify_current_jpeg_images(
                [candidate], probe_interval=0, workers=1
            )
        self.assertEqual(set(), verified)
        self.assertEqual("placeholder:not_advancing", errors["fast-refresh"])

    def test_advancing_jpeg_can_use_cache_busting_without_provider_timestamp(self):
        candidate = {
            "provider_camera_id": "fast-refresh",
            "url": "https://example.com/current.jpg",
            "require_content_change": True,
            "cache_bust": True,
        }
        first = ("hash-one", 40000, None)
        second = ("hash-two", 41000, None)
        with (
            mock.patch.object(
                fetch_cameras, "_current_jpeg_snapshot", side_effect=[first, second]
            ) as snapshotter,
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors, snapshots = fetch_cameras.verify_current_jpeg_images(
                [candidate], probe_interval=0, workers=1
            )
        self.assertEqual({"fast-refresh"}, verified)
        self.assertEqual({}, errors)
        self.assertEqual(second, snapshots["fast-refresh"])
        called_urls = [call.args[0] for call in snapshotter.call_args_list]
        self.assertNotEqual(called_urls[0], called_urls[1])
        self.assertTrue(all("_stormscope_probe=" in url for url in called_urls))
        self.assertTrue(all(
            call.kwargs["require_provider_timestamp"] is False
            for call in snapshotter.call_args_list
        ))

    def test_wyoming_nps_accepts_current_images_and_advancing_old_faithful_hls(self):
        image_ids = {
            item["provider_camera_id"] for item in fetch_cameras.WYOMING_NPS_IMAGE_FEEDS
        }
        snapshots = {
            camera_id: ("hash", 40000, "2026-07-12T09:00:00+00:00")
            for camera_id in image_ids
        }
        old_faithful = fetch_cameras.WYOMING_OLD_FAITHFUL
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(image_ids, {}, snapshots),
            ),
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                return_value=({old_faithful["url"]}, {}),
            ) as hls_verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Wyoming NPS verified", fetch_cameras.fetch_wyoming_nps_verified
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(8, len(result.cameras))
        self.assertTrue(all(row["state"] == "Wyoming" for row in result.cameras))
        self.assertTrue(all(row["source"] == "nps" for row in result.cameras))
        self.assertEqual(7, sum(row["type"] == "image" for row in result.cameras))
        self.assertEqual(1, sum(row["type"] == "hls" for row in result.cameras))
        self.assertTrue(all(row["_replace_source_page"] for row in result.cameras))
        hls_verifier.assert_called_once_with(
            [old_faithful["url"]],
            probe_interval=10.0,
            workers=1,
            referer=old_faithful["source_url"],
        )

    def test_cobblestone_accepts_only_first_party_advancing_rtspme_embed(self):
        source_page = "https://cobblestoneonnorfork.com/live-webcam/"
        player_url = "https://rtsp.me/embed/ifn2nBEf/"
        hls_url = "https://mia.rtsp.me/token/expiry/hls/ifn2nBEf.m3u8?ip=test"

        def response(url, **_kwargs):
            if url == source_page:
                return f'<iframe src="{player_url}"></iframe>'.encode()
            if url == player_url:
                return f"var source = '{hls_url}';".encode()
            raise AssertionError(url)

        with (
            mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response),
            mock.patch.object(
                fetch_cameras, "verify_live_hls", return_value=({hls_url}, {})
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Arkansas (Cobblestone/RTSP.me)",
                fetch_cameras.fetch_arkansas_cobblestone,
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual("Arkansas", row["state"])
        self.assertEqual("Baxter County", row["county"])
        self.assertEqual("rtspme", row["source"])
        self.assertEqual("embed", row["type"])
        self.assertEqual("ifn2nBEf", row["provider_camera_id"])
        self.assertEqual("lake", row["category"])
        self.assertEqual(36.407202, row["lat"])
        self.assertEqual(-92.235216, row["lon"])
        self.assertEqual(source_page, row["source_url"])
        verifier.assert_called_once_with(
            [hls_url],
            probe_interval=7.0,
            workers=1,
            referer=player_url,
        )

    def test_cobblestone_reresolves_after_one_transient_probe(self):
        source_page = "https://cobblestoneonnorfork.com/live-webcam/"
        player_url = "https://rtsp.me/embed/ifn2nBEf/"
        hls_url = "https://mia.rtsp.me/token/expiry/hls/ifn2nBEf.m3u8?ip=test"

        def response(url, **_kwargs):
            if url == source_page:
                return f'<iframe src="{player_url}"></iframe>'.encode()
            if url == player_url:
                return f"var source = '{hls_url}';".encode()
            raise AssertionError(url)

        with (
            mock.patch.object(fetch_cameras, "_http_bytes", side_effect=response),
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                side_effect=[
                    (set(), {hls_url: "transient_network:inconsistent_probes:http_404"}),
                    ({hls_url}, {}),
                ],
            ) as verifier,
            mock.patch.object(fetch_cameras.time, "sleep"),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Arkansas (Cobblestone/RTSP.me)",
                fetch_cameras.fetch_arkansas_cobblestone,
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(2, verifier.call_count)

    def test_minnesota_511_accepts_only_strictly_verified_public_views(self):
        hls_url = "https://video.dot.state.mn.us/public/C1.stream/playlist.m3u8"
        image_url = "https://public.carsprogram.org/cameras/MN/C2-v1"
        rejected_url = "https://video.dot.state.mn.us/public/C3.stream/playlist.m3u8"
        inventory = [
            {
                "id": 101,
                "public": True,
                "name": "I-94 EB at Test Ave",
                "lastUpdated": 1783855322694,
                "location": {
                    "latitude": 44.98,
                    "longitude": -93.27,
                    "routeId": "I-94",
                    "cityReference": "in Minneapolis",
                },
                "views": [{"name": "I-94 EB at Test Ave", "type": "WMP", "url": hls_url}],
            },
            {
                "id": 102,
                "public": True,
                "name": "T.H.61 Test View 1",
                "lastUpdated": 1783855322694,
                "location": {
                    "latitude": 46.78,
                    "longitude": -92.10,
                    "routeId": "MN 61",
                },
                "views": [
                    {
                        "name": "T.H.61 Test View 1",
                        "type": "STILL_IMAGE",
                        "url": image_url,
                        "imageTimestamp": 1783855112000,
                    },
                    {
                        "name": "T.H.61 Test View 2",
                        "type": "WMP",
                        "url": rejected_url,
                    },
                ],
            },
        ]
        with (
            mock.patch.object(fetch_cameras, "MINNESOTA_511_MINIMUM_INVENTORY", 2),
            mock.patch.object(fetch_cameras, "fetch_json", return_value=inventory),
            mock.patch.object(
                fetch_cameras,
                "_retry_minnesota_hls",
                return_value=({hls_url}, {rejected_url: "confirmed_dead:http_404"}),
            ),
            mock.patch.object(
                fetch_cameras,
                "_retry_minnesota_images",
                return_value=(
                    {"102:0"},
                    {},
                    {"102:0": ("hash", 20000, "2026-07-12T11:20:00+00:00")},
                ),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
        ):
            result = fetch_cameras.run_fetcher(
                "Minnesota 511 (MnDOT IRIS)", fetch_cameras.fetch_minnesota_511
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(2, len(result.cameras))
        self.assertEqual({"hls", "image"}, {row["type"] for row in result.cameras})
        self.assertTrue(all(row["state"] == "Minnesota" for row in result.cameras))
        self.assertTrue(all(row["source"] == "dot" for row in result.cameras))
        self.assertTrue(all(row["category"] == "traffic" for row in result.cameras))
        self.assertEqual("EB", result.cameras[0]["direction"])
        self.assertEqual("102:0", result.cameras[1]["provider_camera_id"])
        report = report_writer.call_args.args[1]
        self.assertEqual(2, report["verified_live"])
        self.assertEqual({"hls": 1, "image": 1}, report["verified_by_type"])
        self.assertEqual("confirmed_dead:http_404", report["rejected"][0]["failure_class"])

    def test_minnesota_511_rejects_a_truncated_inventory(self):
        with (
            mock.patch.object(fetch_cameras, "MINNESOTA_511_MINIMUM_INVENTORY", 2),
            mock.patch.object(fetch_cameras, "fetch_json", return_value=[{"id": 1}]),
        ):
            result = fetch_cameras.run_fetcher(
                "Minnesota 511 (MnDOT IRIS)", fetch_cameras.fetch_minnesota_511
            )
        self.assertFalse(result.succeeded)
        self.assertIn("truncated_inventory:1", result.error)

    def test_minnesota_hls_retries_only_transient_failures_at_lower_concurrency(self):
        live_url = "https://video.dot.state.mn.us/public/live.m3u8"
        dead_url = "https://video.dot.state.mn.us/public/dead.m3u8"
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_live_hls",
                side_effect=[
                    (
                        set(),
                        {
                            live_url: "transient_network:http_503",
                            dead_url: "confirmed_dead:http_404",
                        },
                    ),
                    ({live_url}, {}),
                ],
            ) as verifier,
            mock.patch.object(fetch_cameras.time, "sleep"),
        ):
            verified, errors = fetch_cameras._retry_minnesota_hls(
                [live_url, dead_url], retry_delay=0
            )
        self.assertEqual({live_url}, verified)
        self.assertEqual({dead_url: "confirmed_dead:http_404"}, errors)
        self.assertEqual([live_url], verifier.call_args_list[1].args[0])
        self.assertEqual(8, verifier.call_args_list[1].kwargs["workers"])

    def test_minnesota_usgs_requires_every_curated_current_image(self):
        feed = {
            "provider_camera_id": "MN_Test_River",
            "name": "Test River",
            "lat": 45.0,
            "lon": -94.0,
            "county": "Test County",
            "site": "USGS-00000000",
        }
        expected_url = (
            "https://usgs-nims-images.s3.amazonaws.com/overlay/"
            "MN_Test_River/MN_Test_River_newest.jpg"
        )
        with (
            mock.patch.object(
                fetch_cameras, "MINNESOTA_USGS_NIMS_FEEDS", (feed,)
            ),
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(
                    {"MN_Test_River"},
                    {},
                    {
                        "MN_Test_River": (
                            "hash",
                            20000,
                            "2026-07-12T11:00:00+00:00",
                        )
                    },
                ),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Minnesota USGS verified",
                fetch_cameras.fetch_minnesota_usgs_verified,
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual(expected_url, row["url"])
        self.assertEqual("USGS-00000000", row["source_url"].split("/")[-2])
        self.assertEqual("river", row["category"])
        self.assertEqual("MN_Test_River", row["provider_camera_id"])
        candidates = verifier.call_args.args[0]
        self.assertEqual(7200, candidates[0]["max_age_seconds"])

    def test_minnesota_usgs_retains_last_known_good_on_any_failed_image(self):
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(set(), {"missing": "confirmed_dead:http_404"}, {}),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Minnesota USGS verified",
                fetch_cameras.fetch_minnesota_usgs_verified,
            )
        self.assertFalse(result.succeeded)
        self.assertIn("truncated_verified_inventory", result.error)

    def test_hawaii_usgs_requires_every_curated_current_image(self):
        feed = {
            "provider_camera_id": "HI_Kilauea_Testcam",
            "name": "Kilauea Test Camera",
            "lat": 19.4,
            "lon": -155.3,
            "direction": "E",
            "cadence": 120,
            "volcano": "kilauea",
        }
        expected_url = (
            "https://usgs-nims-images.s3.amazonaws.com/overlay/"
            "HI_Kilauea_Testcam/HI_Kilauea_Testcam_newest.jpg"
        )
        with (
            mock.patch.object(fetch_cameras, "HAWAII_USGS_NIMS_FEEDS", (feed,)),
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(
                    {"HI_Kilauea_Testcam"},
                    {},
                    {
                        "HI_Kilauea_Testcam": (
                            "hash",
                            20000,
                            "2026-07-12T12:34:38+00:00",
                        )
                    },
                ),
            ) as verifier,
            mock.patch.object(fetch_cameras, "atomic_write_json") as report_writer,
        ):
            result = fetch_cameras.run_fetcher(
                "Hawaii USGS verified", fetch_cameras.fetch_hawaii_usgs_verified
            )

        self.assertTrue(result.succeeded)
        self.assertEqual(1, len(result.cameras))
        row = result.cameras[0]
        self.assertEqual(expected_url, row["url"])
        self.assertEqual("Hawaii", row["state"])
        self.assertEqual("Hawaii County", row["county"])
        self.assertEqual("E", row["direction"])
        self.assertEqual("volcano", row["category"])
        self.assertEqual("HI_Kilauea_Testcam", row["provider_camera_id"])
        self.assertEqual("https://www.usgs.gov/volcanoes/kilauea/webcams", row["source_url"])
        self.assertEqual(300, verifier.call_args.args[0][0]["max_age_seconds"])
        self.assertEqual(1, report_writer.call_args.args[1]["verified_live"])

    def test_hawaii_usgs_retains_last_known_good_on_any_failed_image(self):
        with (
            mock.patch.object(
                fetch_cameras,
                "verify_current_jpeg_images",
                return_value=(set(), {"missing": "confirmed_dead:http_404"}, {}),
            ),
            mock.patch.object(fetch_cameras, "atomic_write_json"),
        ):
            result = fetch_cameras.run_fetcher(
                "Hawaii USGS verified", fetch_cameras.fetch_hawaii_usgs_verified
            )
        self.assertFalse(result.succeeded)
        self.assertIn("truncated_verified_inventory", result.error)


if __name__ == "__main__":
    unittest.main()
