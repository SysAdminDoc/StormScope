#!/usr/bin/env python3
"""Regression coverage for fixed-location YouTube discovery."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import discover_youtube_cameras as youtube  # noqa: E402


class YouTubeLocationExtractionTests(unittest.TestCase):
    def test_generic_skyline_view_is_not_a_location(self) -> None:
        self.assertEqual(youtube.extract_location_queries("Skyline View", ""), [])

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


if __name__ == "__main__":
    unittest.main()
