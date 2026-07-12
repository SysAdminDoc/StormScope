#!/usr/bin/env python3
"""Regression coverage for fixed-location YouTube discovery."""

from __future__ import annotations

import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import discover_youtube_cameras as youtube  # noqa: E402


class YouTubeLocationExtractionTests(unittest.TestCase):
    def test_generic_skyline_view_is_not_a_location(self) -> None:
        self.assertEqual(youtube.extract_location_queries("Skyline View", ""), [])

    def test_generic_village_label_is_not_a_location(self) -> None:
        queries = youtube.extract_location_queries("Schweitzer Webcam: The Village", "")
        self.assertNotIn("The Village", queries)

    def test_country_only_fallback_is_rejected_when_specific_place_is_present(self) -> None:
        queries = youtube.extract_location_queries(
            "LIVE 24/7 | Skiathos Bay & Port – Real-Time Ship Spotting from Greece",
            "",
        )
        self.assertIn("Skiathos Bay & Port", queries)
        self.assertNotIn("Greece", queries)

    def test_country_with_noise_does_not_become_a_camera_pin(self) -> None:
        queries = youtube.extract_location_queries(
            "ERUZIONE ETNA - Nunziata di Mascali live webcam - Panoramica Etna est",
            "Italy - WS",
        )
        self.assertNotIn("Italy - WS", queries)

    def test_live_playback_requires_public_embedding(self) -> None:
        base = {"is_live": True, "url": "https://example.com/live.m3u8"}
        self.assertFalse(youtube.ytdlp_confirms_live_playback(base))
        self.assertFalse(youtube.ytdlp_confirms_live_playback({
            **base, "playable_in_embed": True, "availability": "private"
        }))
        self.assertTrue(youtube.ytdlp_confirms_live_playback({
            **base, "playable_in_embed": True, "availability": "public"
        }))

    def test_live_verification_retries_transient_extractor_failures(self) -> None:
        candidate = youtube.Candidate(video_id="3ieUramhCCI", title="NCTC Eagle Cam")
        playback = {
            "is_live": True,
            "live_status": "is_live",
            "playable_in_embed": True,
            "availability": "public",
            "url": "https://example.com/live.m3u8",
            "title": "NCTC Eagle Nest: Camera 1",
            "channel": "U.S. Fish & Wildlife Service",
        }
        with (
            mock.patch.object(youtube, "time") as time_mock,
            mock.patch.object(
                youtube,
                "curl_json_post",
                return_value={
                    "playabilityStatus": {"status": "OK"},
                    "videoDetails": {
                        "title": playback["title"],
                        "author": playback["channel"],
                    },
                },
            ),
            mock.patch.object(
                youtube,
                "run_ytdlp_metadata",
                side_effect=[RuntimeError("no formats"), RuntimeError("timeout"), playback],
            ) as extractor,
        ):
            verified = youtube.verify_live(candidate, 0.2)

        self.assertIs(candidate, verified)
        self.assertEqual(3, extractor.call_count)
        self.assertEqual([mock.call(0.2), mock.call(1.0), mock.call(2.0)], time_mock.sleep.call_args_list)

    def test_curated_live_stream_can_replace_a_legacy_embed_in_place(self) -> None:
        old_source = "https://www.nps.gov/media/webcam/view.htm?id=legacy"
        old_row = {
            "id": 1,
            "name": "Legacy embed",
            "lat": 32.1,
            "lon": -104.4,
            "url": old_source,
            "type": "embed",
            "state": "",
            "county": "",
            "direction": "",
            "source": "nps",
            "last_verified": None,
            "health": "unknown",
            "failure_class": None,
            "source_url": old_source,
            "refresh_cadence_seconds": None,
        }
        located = youtube.LocatedCamera(
            video_id="BwiIsjXt3KI",
            name="Carlsbad Caverns Natural Entrance Bat Cam",
            lat=32.176913,
            lon=-104.441431,
            state="New Mexico",
            county="Eddy County",
            location_query="override",
            geocode_display_name="official location",
            score=10,
            reasons=["location_override"],
            source_url="https://explore.org/livecams/bats/carlsbad-caverns",
            replace_source_url=old_source,
            provider="Explore.org / National Park Service",
            category="wildlife",
        )
        with tempfile.TemporaryDirectory() as directory:
            data_file = Path(directory) / "cameras.json"
            data_file.write_text(json.dumps([old_row]), encoding="utf-8")
            added, replaced = youtube.append_cameras(data_file, [located], 0)
            rows = json.loads(data_file.read_text(encoding="utf-8"))
        self.assertEqual((0, 1), (added, replaced))
        self.assertEqual(1, len(rows))
        self.assertEqual(1, rows[0]["id"])
        self.assertEqual("youtube", rows[0]["source"])
        self.assertEqual("BwiIsjXt3KI", rows[0]["url"])
        self.assertEqual(30, rows[0]["refresh_cadence_seconds"])
        self.assertEqual("Explore.org / National Park Service", rows[0]["provider"])
        self.assertEqual("wildlife", rows[0]["category"])
        self.assertEqual("BwiIsjXt3KI", rows[0]["provider_camera_id"])


if __name__ == "__main__":
    unittest.main()
