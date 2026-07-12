#!/usr/bin/env python3
"""Convert EarthCam full-page embeds into hotlinkable live snapshot image feeds.

EarthCam's cam pages cannot be embedded off-site: the HTML5 player gates live
playback to authorized domains and the HLS stream is signed with a per-session
token that is minted in the page HTML (not fetchable cross-origin). The result
is that ``type: embed`` EarthCam rows never play inside StormScope — the iframe
loads the site chrome but the video never starts.

EarthCam's public network API, however, exposes a per-camera ``image.php``
snapshot URL that hotlinks from any origin (no referer gate, real JPEG) and
refreshes to the latest frame on each request. This script matches our stored
EarthCam rows to that API by page URL and rewrites the matched rows to a
refreshing ``type: image`` feed (the same mechanism the DOT image cameras use),
so the actual camera view renders in the modal instead of a dead iframe.

Rows with no hotlinkable snapshot (myEarthCam/partner-hosted cameras) are left
as embeds with their existing "open source" fallback link.

    python scripts/convert_earthcam_snapshots.py            # dry run
    python scripts/convert_earthcam_snapshots.py --apply    # write changes
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path

try:
    from camera_data import (
        atomic_write_json,
        load_camera_data,
        update_camera_data,
        utc_now_iso,
    )
except ModuleNotFoundError:  # pragma: no cover - package import
    from scripts.camera_data import (
        atomic_write_json,
        load_camera_data,
        update_camera_data,
        utc_now_iso,
    )

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
REPORT_FILE = ROOT / "data" / "earthcam_snapshot_report.json"
NETWORK_URL = "https://www.earthcam.com/api/mapsearch/get_locations_network.php?r=ecn&a=fetch"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0"
REFRESH_CADENCE_SECONDS = 30
_IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"RIFF")

_ctx = ssl.create_default_context()


def _get(url: str, *, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=timeout, context=_ctx) as response:
        return response.read()


def find_places(payload: object) -> list[dict]:
    if isinstance(payload, dict):
        if isinstance(payload.get("places"), list):
            return payload["places"]
        for value in payload.values():
            found = find_places(value)
            if found:
                return found
    if isinstance(payload, list):
        for value in payload:
            found = find_places(value)
            if found:
                return found
    return []


def build_snapshot_map() -> dict[str, str]:
    payload = json.loads(_get(NETWORK_URL, timeout=40).decode("utf-8", "replace"))
    mapping: dict[str, str] = {}
    for place in find_places(payload):
        url = str(place.get("url") or "").strip()
        image = str(place.get("image") or "").strip()
        if url and image.startswith("https://") and "image.php" in image:
            mapping[url] = image
    return mapping


def image_is_live(url: str, *, timeout: int = 15) -> tuple[str, bool]:
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*"}
        )
        with urllib.request.urlopen(request, timeout=timeout, context=_ctx) as response:
            content_type = (response.headers.get("Content-Type") or "").lower()
            head = response.read(64)
        looks_image = "image" in content_type or any(head.startswith(sig) for sig in _IMAGE_MAGIC)
        return url, looks_image
    except (urllib.error.URLError, TimeoutError, OSError):
        return url, False


def verify_images(urls: list[str], workers: int = 16) -> set[str]:
    verified: set[str] = set()
    unique = list(dict.fromkeys(urls))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for url, ok in executor.map(image_is_live, unique):
            if ok:
                verified.add(url)
    return verified


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the converted rows")
    args = parser.parse_args(argv)

    cameras = load_camera_data(DATA_FILE)
    embeds = [c for c in cameras if c.get("source") == "earthcam" and c.get("type") == "embed"]
    print(f"EarthCam embed rows: {len(embeds)}")

    snapshot_map = build_snapshot_map()
    print(f"EarthCam API snapshot URLs: {len(snapshot_map)}")

    candidates = [(c, snapshot_map[c["url"]]) for c in embeds if c.get("url") in snapshot_map]
    print(f"Matched by page URL: {len(candidates)}")

    verified = verify_images([image for _, image in candidates])
    convertible = {c["id"]: image for c, image in candidates if image in verified}
    unmatched = [c for c in embeds if c["id"] not in convertible]
    print(f"Verified live JPEG snapshots: {len(convertible)}")
    print(f"Left as embed (no hotlinkable snapshot): {len(unmatched)}")

    now = utc_now_iso()

    def convert(rows: list[dict]) -> int:
        changed = 0
        for row in rows:
            image = convertible.get(row.get("id"))
            if not image:
                continue
            row["type"] = "image"
            row["url"] = image
            row["health"] = "healthy"
            row["failure_class"] = None
            row["last_verified"] = now
            row["refresh_cadence_seconds"] = REFRESH_CADENCE_SECONDS
            changed += 1
        return changed

    atomic_write_json(
        REPORT_FILE,
        {
            "generated_at": now,
            "embed_rows": len(embeds),
            "api_snapshots": len(snapshot_map),
            "matched": len(candidates),
            "converted": len(convertible),
            "left_as_embed": [
                {"id": c["id"], "name": c["name"], "url": c["url"]} for c in unmatched
            ],
        },
        indent=2,
    )

    if not args.apply:
        print(f"Dry run — would convert {len(convertible)} rows. Re-run with --apply.")
        return 0

    changed, summary = update_camera_data(DATA_FILE, convert)
    print(f"Converted {changed} EarthCam rows to live snapshot image feeds.")
    print(f"Validated {summary.total:,} cameras (schema v{summary.schema_version}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
