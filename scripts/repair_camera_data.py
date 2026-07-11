#!/usr/bin/env python3
"""Normalize the legacy camera corpus into the current versioned contract."""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from camera_data import feed_identity, load_json, save_camera_data
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.camera_data import feed_identity, load_json, save_camera_data


ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
KNOWN_BROKEN_URLS = {
    "ttps://wzmedia.dot.ca.gov/D8/LB-8_10_282.stream/playlist.m3u8",
}
VERIFIED_HTTPS_UPGRADES = {
    "http://www.trimarc.org/images/milestone/CCTV_03_RussellvilleRd_and_CampbellLn.jpg":
        "https://www.trimarc.org/images/milestone/CCTV_03_RussellvilleRd_and_CampbellLn.jpg",
    "http://www.trimarc.org/images/milestone/CCTV_03_NashvilleRd_and_CampbellLn.jpg":
        "https://www.trimarc.org/images/milestone/CCTV_03_NashvilleRd_and_CampbellLn.jpg",
    "http://www.trimarc.org/images/milestone/CCTV_03_ScottsvilleRd_and_LoversLn.jpg":
        "https://www.trimarc.org/images/milestone/CCTV_03_ScottsvilleRd_and_LoversLn.jpg",
    "http://www.trimarc.org/images/milestone/CCTV_03_MorgantownRd_and_VeteransMemorialLn.jpg":
        "https://www.trimarc.org/images/milestone/CCTV_03_MorgantownRd_and_VeteransMemorialLn.jpg",
    "http://wzmedia.dot.ca.gov/D8/LB-8_10_389.stream/playlist.m3u8":
        "https://wzmedia.dot.ca.gov/D8/LB-8_10_389.stream/playlist.m3u8",
}


def repair(cameras: list[dict]) -> tuple[list[dict], dict[str, int]]:
    repaired: list[dict] = []
    seen = set()
    counts = {
        "inactive": 0,
        "broken": 0,
        "duplicate": 0,
        "https": 0,
        "trimmed": 0,
        "unverified_http": 0,
    }
    for original in cameras:
        camera = dict(original)
        if str(camera.get("status") or "").lower() == "inactive":
            counts["inactive"] += 1
            continue
        url = str(camera.get("url") or "")
        if url.strip() in KNOWN_BROKEN_URLS:
            counts["broken"] += 1
            continue
        stripped = url.strip()
        if stripped != url:
            counts["trimmed"] += 1
            camera["url"] = stripped
        if stripped in VERIFIED_HTTPS_UPGRADES:
            camera["url"] = VERIFIED_HTTPS_UPGRADES[stripped]
            counts["https"] += 1
        elif stripped.startswith("http://"):
            counts["unverified_http"] += 1
        identity = feed_identity(camera)
        if identity in seen:
            counts["duplicate"] += 1
            continue
        seen.add(identity)
        repaired.append(camera)
    for camera_id, camera in enumerate(repaired, 1):
        camera["id"] = camera_id
    return repaired, counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    cameras = load_json(args.data, [])
    repaired, counts = repair(cameras)
    summary = save_camera_data(args.data, repaired) if args.apply else None
    print(f"Before: {len(cameras)} After: {len(repaired)} Repairs: {counts}")
    if summary:
        print(f"Wrote schema v{summary.schema_version}: {args.data}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
