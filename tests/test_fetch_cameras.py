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


if __name__ == "__main__":
    unittest.main()
