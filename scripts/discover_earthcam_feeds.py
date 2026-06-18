#!/usr/bin/env python3
"""
Discover, verify, and optionally append EarthCam livestream feeds.

The script uses EarthCam's public map/network APIs as the primary source for
EarthCam-hosted and MyEarthCam feeds, then optionally searches YouTube live
results for EarthCam-branded livestreams. It is append-only: existing camera
rows are never removed or rewritten.

Typical run:
    python scripts/discover_earthcam_feeds.py --apply

Provider-only inventory without YouTube probing:
    python scripts/discover_earthcam_feeds.py --skip-youtube
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
REPORT_FILE = ROOT / "data" / "earthcam_discovery_report.json"
YOUTUBE_OVERRIDES_FILE = ROOT / "data" / "youtube_location_overrides.json"

EARTHCAM_NETWORK_URL = "https://www.earthcam.com/api/mapsearch/get_locations_network.php?r=ecn&a=fetch"
EARTHCAM_REGION_URL = "https://www.earthcam.com/api/dotcom/network_search.php?r=ecn&a=fetch"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 "
    "StormScope/0.9.0"
)

US_STATES = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "DC": "DC",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "IA": "Iowa",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "MA": "Massachusetts",
    "MD": "Maryland",
    "ME": "Maine",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MO": "Missouri",
    "MS": "Mississippi",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "NE": "Nebraska",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NV": "Nevada",
    "NY": "New York",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VA": "Virginia",
    "VT": "Vermont",
    "WA": "Washington",
    "WI": "Wisconsin",
    "WV": "West Virginia",
    "WY": "Wyoming",
}

EARTHCAM_YOUTUBE_QUERIES = [
    "EarthCam Live",
    "EarthCam live webcam",
    "EarthCam Live 24/7",
    "EarthCam Live city",
    "EarthCam Live beach",
    "EarthCam Live skyline",
    "EarthCam Live New York",
    "EarthCam Live Florida",
]

UPGRADE_HTTP_HOSTS = {
    "earthcam.com",
    "www.earthcam.com",
    "myearthcam.com",
    "www.myearthcam.com",
    "abbeyroad.com",
    "www.abbeyroad.com",
}

NON_FEED_TERMS = {
    "ambience",
    "ambient",
    "anime",
    "asmr",
    "bitcoin",
    "cartoon",
    "chill",
    "crypto",
    "gaming",
    "lofi",
    "lo-fi",
    "meditation",
    "minecraft",
    "movie",
    "music",
    "podcast",
    "radio",
    "sleep",
    "song",
    "stocks",
    "trading",
    "valorant",
}

TOKEN_STOPWORDS = {
    "earthcam",
    "live",
    "webcam",
    "camera",
    "cam",
    "cams",
    "stream",
    "streaming",
    "view",
    "views",
    "video",
    "from",
    "with",
    "the",
    "and",
    "city",
    "state",
    "north",
    "south",
    "east",
    "west",
    "beach",
    "street",
    "square",
    "harbor",
    "harbour",
    "balcony",
    "pier",
    "park",
    "plaza",
    "skyline",
    "24",
    "247",
    "4k",
    "hd",
}


@dataclass
class ProviderFeed:
    provider_id: str
    name: str
    url: str
    lat: float
    lon: float
    state: str
    county: str
    city: str
    country: str
    region_state: str
    location: str
    source_status: int
    source_url: str
    source: str = "earthcam"
    reasons: list[str] = field(default_factory=list)


@dataclass
class YouTubeFeed:
    video_id: str
    name: str
    lat: float
    lon: float
    state: str
    county: str
    title: str
    channel: str
    match_reason: str


def run_curl(args: list[str], *, data: bytes | None = None, timeout: int = 30) -> bytes:
    cmd = [
        "curl",
        "-fsSL",
        "--compressed",
        "-A",
        USER_AGENT,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
    ]
    cmd.extend(args)
    proc = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"curl failed ({proc.returncode}): {err}")
    return proc.stdout


def curl_json(url: str, *, timeout: int = 30) -> Any:
    raw = run_curl([url], timeout=timeout)
    return json.loads(raw.decode("utf-8", "replace"))


def load_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json_file(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True, indent=2)
        f.write("\n")


def normalize_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        url = "https:" + url
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower() or "https"
    netloc = parsed.netloc.lower()
    if scheme == "http" and netloc in UPGRADE_HTTP_HOSTS:
        scheme = "https"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    query = parsed.query
    return urllib.parse.urlunsplit((scheme, netloc, path, query, ""))


def compact_key(value: str) -> str:
    return normalize_url(value).rstrip("/").lower()


def state_name(country: str, state: str | None) -> str:
    if country == "United States" and state:
        return US_STATES.get(state, state)
    return country or state or ""


def county_name(city: str | None, location: str | None, country: str | None) -> str:
    if city:
        return city.strip()
    if location:
        return location.strip()
    return country or ""


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if -90 <= number <= 90:
        return number
    return None


def safe_lon(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if -180 <= number <= 180:
        return number
    return None


def extract_places(payload: Any) -> list[dict[str, Any]]:
    try:
        places = payload["data"][0]["places"]
    except (KeyError, TypeError, IndexError):
        return []
    return places if isinstance(places, list) else []


def region_key(place: dict[str, Any]) -> tuple[str, str] | None:
    country = place.get("country")
    state = place.get("state")
    if country == "United States" and state:
        return ("US", str(state))
    if country:
        return (str(country), "")
    return None


def discover_region_items(places: list[dict[str, Any]], sleep_seconds: float) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    regions: list[tuple[str, str]] = []
    for place in places:
        key = region_key(place)
        if key and key not in regions:
            regions.append(key)

    items: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    for index, (country, state) in enumerate(regions, 1):
        params = urllib.parse.urlencode({"r": "ecn", "a": "fetch", "country": country, "state": state})
        url = f"{EARTHCAM_REGION_URL.split('?')[0]}?{params}"
        try:
            payload = curl_json(url, timeout=35)
            cam_items = payload.get("data", {}).get("cam_items", [])
            if isinstance(cam_items, list):
                for item in cam_items:
                    item_id = item.get("id")
                    if isinstance(item_id, str):
                        items[item_id] = item
            print(f"[{index}/{len(regions)}] EarthCam region {country} {state}: {len(cam_items) if isinstance(cam_items, list) else 0}")
        except Exception as exc:
            errors.append({"country": country, "state": state, "error": str(exc)})
            print(f"[{index}/{len(regions)}] ERROR EarthCam region {country} {state}: {exc}")
        time.sleep(sleep_seconds)
    return items, errors


def build_provider_feed(place: dict[str, Any], region_item: dict[str, Any] | None) -> tuple[ProviderFeed | None, list[str]]:
    failures: list[str] = []
    provider_id = str(place.get("id") or "")
    if not provider_id:
        failures.append("missing_id")
    source_status = int((region_item or {}).get("cam_state", 0) or 0)
    if source_status != 1:
        failures.append(f"cam_state:{source_status}")
    lat = safe_float((place.get("posn") or [None, None])[0] if isinstance(place.get("posn"), list) else None)
    lon = safe_lon((place.get("posn") or [None, None])[1] if isinstance(place.get("posn"), list) else None)
    if lat is None or lon is None:
        failures.append("bad_coordinates")
    url = normalize_url(str(place.get("url") or ""))
    if not url:
        failures.append("missing_url")
    title = str((region_item or {}).get("title") or place.get("name") or "").strip()
    if not title:
        failures.append("missing_name")
    country = str(place.get("country") or (region_item or {}).get("country") or "").strip()
    state = str(place.get("state") or (region_item or {}).get("state") or "").strip()
    city = str(place.get("city") or (region_item or {}).get("city") or "").strip()
    location = str(place.get("location") or "").strip()
    if failures:
        return None, failures
    return (
        ProviderFeed(
            provider_id=provider_id,
            name=f"EarthCam: {title}",
            url=url,
            lat=round(float(lat), 6),
            lon=round(float(lon), 6),
            state=state_name(country, state),
            county=county_name(city, location, country),
            city=city,
            country=country,
            region_state=state,
            location=location,
            source_status=source_status,
            source_url=str(place.get("url") or ""),
            reasons=["earthcam_api", "cam_state:1", "mapped_coordinates"],
        ),
        [],
    )


def discover_provider_feeds(sleep_seconds: float) -> tuple[list[ProviderFeed], list[dict[str, Any]], list[dict[str, str]]]:
    payload = curl_json(EARTHCAM_NETWORK_URL, timeout=35)
    places = extract_places(payload)
    region_items, region_errors = discover_region_items(places, sleep_seconds)

    accepted: list[ProviderFeed] = []
    rejected: list[dict[str, Any]] = []
    for place in places:
        item = region_items.get(str(place.get("id") or ""))
        feed, failures = build_provider_feed(place, item)
        if feed:
            accepted.append(feed)
        else:
            rejected.append(
                {
                    "id": place.get("id"),
                    "name": place.get("name"),
                    "url": place.get("url"),
                    "location": place.get("location"),
                    "failures": failures,
                }
            )
    accepted.sort(key=lambda feed: (feed.country, feed.region_state, feed.name, feed.url))
    return accepted, rejected, region_errors


def token_set(text: str) -> set[str]:
    tokens = set()
    for token in re.findall(r"[a-z0-9]+", text.lower()):
        if len(token) < 3 or token in TOKEN_STOPWORDS:
            continue
        tokens.add(token)
    return tokens


def youtube_candidate_blob(candidate: Any) -> str:
    return " ".join(
        value
        for value in [
            getattr(candidate, "verified_title", ""),
            getattr(candidate, "title", ""),
            getattr(candidate, "verified_channel", ""),
            getattr(candidate, "channel", ""),
        ]
        if value
    )


def match_provider_feed(candidate: Any, provider_feeds: list[ProviderFeed]) -> tuple[ProviderFeed | None, str]:
    candidate_text = youtube_candidate_blob(candidate)
    candidate_tokens = token_set(candidate_text)
    if not candidate_tokens:
        return None, "no_candidate_tokens"
    best: tuple[int, ProviderFeed, set[str]] | None = None
    for feed in provider_feeds:
        feed_text = f"{feed.name} {feed.city} {feed.location} {feed.state} {feed.country} {feed.url}"
        feed_tokens = token_set(feed_text)
        overlap = candidate_tokens & feed_tokens
        score = len(overlap)
        if feed.city and feed.city.lower() in candidate_text.lower():
            score += 3
        if feed.country and feed.country.lower() in candidate_text.lower():
            score += 1
        short_landmark_match = len(candidate_tokens) <= 3 and len(overlap) >= 2
        if (score >= 4 or short_landmark_match) and (best is None or score > best[0]):
            best = (score, feed, overlap)
    if not best:
        return None, "no_provider_match"
    return best[1], "provider_match:" + ",".join(sorted(best[2]))


def locate_youtube_candidate(candidate: Any, provider_feeds: list[ProviderFeed], overrides: dict[str, Any]) -> tuple[YouTubeFeed | None, str]:
    video_id = str(getattr(candidate, "video_id", ""))
    title = getattr(candidate, "verified_title", "") or getattr(candidate, "title", "") or f"EarthCam Live {video_id}"
    channel = getattr(candidate, "verified_channel", "") or getattr(candidate, "channel", "")
    override = overrides.get(video_id)
    if isinstance(override, dict):
        return (
            YouTubeFeed(
                video_id=video_id,
                name=str(override.get("name") or title),
                lat=float(override["lat"]),
                lon=float(override["lon"]),
                state=str(override.get("state") or ""),
                county=str(override.get("county") or ""),
                title=title,
                channel=channel,
                match_reason="youtube_location_override",
            ),
            "",
        )
    match, reason = match_provider_feed(candidate, provider_feeds)
    if not match:
        return None, reason
    return (
        YouTubeFeed(
            video_id=video_id,
            name=title if title.lower().startswith("earthcam") else f"EarthCam Live: {title}",
            lat=match.lat,
            lon=match.lon,
            state=match.state,
            county=match.county,
            title=title,
            channel=channel,
            match_reason=reason,
        ),
        "",
    )


def discover_youtube_feeds(
    provider_feeds: list[ProviderFeed],
    existing_youtube_ids: set[str],
    overrides: dict[str, Any],
    queries: list[str],
    direct_video_ids: list[str],
    max_pages: int,
    max_empty_pages: int,
    sleep_seconds: float,
    include_existing: bool,
) -> tuple[list[YouTubeFeed], list[dict[str, Any]], list[dict[str, str]]]:
    try:
        import discover_youtube_cameras as ytd
    except Exception as exc:
        return [], [], [{"query": "import", "error": str(exc)}]

    raw: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
    for index, query in enumerate(queries, 1):
        try:
            found = ytd.harvest_query(query, max_pages, max_empty_pages, sleep_seconds)
        except Exception as exc:
            errors.append({"query": query, "error": str(exc)})
            print(f"[{index}/{len(queries)}] ERROR YouTube {query}: {exc}")
            continue
        new_count = 0
        for candidate in found:
            blob = f"{candidate.title} {candidate.channel}".lower()
            if "earthcam" not in blob:
                continue
            if any(term in blob for term in NON_FEED_TERMS):
                continue
            if not include_existing and candidate.video_id in existing_youtube_ids:
                continue
            if candidate.video_id in raw:
                continue
            raw[candidate.video_id] = candidate
            new_count += 1
        print(f"[{index}/{len(queries)}] YouTube {query}: {len(found)} IDs, {new_count} EarthCam candidates")
        time.sleep(sleep_seconds)

    direct_new = 0
    for video_id in direct_video_ids:
        if not include_existing and video_id in existing_youtube_ids:
            continue
        if video_id in raw:
            continue
        raw[video_id] = ytd.Candidate(video_id=video_id, title="", channel="EarthCam", query="direct", page=0)
        direct_new += 1
    if direct_video_ids:
        print(f"Direct EarthCam YouTube IDs queued: {direct_new} new")

    live: list[Any] = []
    rejected: list[dict[str, Any]] = []
    for index, candidate in enumerate(raw.values(), 1):
        try:
            verified = ytd.verify_live(candidate, sleep_seconds)
        except Exception as exc:
            rejected.append(
                {
                    "video_id": candidate.video_id,
                    "title": candidate.title,
                    "channel": candidate.channel,
                    "failures": [f"verify_error:{exc}"],
                }
            )
            continue
        if not verified:
            rejected.append(
                {
                    "video_id": candidate.video_id,
                    "title": candidate.title,
                    "channel": candidate.channel,
                    "failures": ["not_live"],
                }
            )
            continue
        live.append(verified)
        if index % 25 == 0 or index == len(raw):
            print(f"Verified YouTube {index}/{len(raw)}; live={len(live)}")

    located: list[YouTubeFeed] = []
    for candidate in live:
        feed, failure = locate_youtube_candidate(candidate, provider_feeds, overrides)
        if feed:
            located.append(feed)
        else:
            rejected.append(
                {
                    "video_id": candidate.video_id,
                    "title": getattr(candidate, "verified_title", "") or candidate.title,
                    "channel": getattr(candidate, "verified_channel", "") or candidate.channel,
                    "failures": [failure],
                }
            )
    located.sort(key=lambda feed: (feed.state, feed.name, feed.video_id))
    return located, rejected, errors


def append_feeds(data_file: Path, provider_feeds: list[ProviderFeed], youtube_feeds: list[YouTubeFeed]) -> tuple[int, int]:
    cameras = load_json_file(data_file, [])
    if not isinstance(cameras, list):
        raise RuntimeError(f"{data_file} does not contain a JSON array")
    existing_embed_urls = {
        compact_key(str(cam.get("url") or ""))
        for cam in cameras
        if cam.get("type") == "embed"
    }
    existing_youtube_ids = {
        str(cam.get("url") or "")
        for cam in cameras
        if cam.get("type") == "youtube"
    }
    max_id = max(int(cam.get("id") or 0) for cam in cameras) if cameras else 0
    added_provider = 0
    added_youtube = 0

    for feed in provider_feeds:
        key = compact_key(feed.url)
        if key in existing_embed_urls:
            continue
        max_id += 1
        cameras.append(
            {
                "id": max_id,
                "name": feed.name,
                "lat": feed.lat,
                "lon": feed.lon,
                "url": feed.url,
                "type": "embed",
                "state": feed.state,
                "county": feed.county,
                "direction": "",
                "source": "earthcam",
            }
        )
        existing_embed_urls.add(key)
        added_provider += 1

    for feed in youtube_feeds:
        if feed.video_id in existing_youtube_ids:
            continue
        max_id += 1
        cameras.append(
            {
                "id": max_id,
                "name": feed.name,
                "lat": round(feed.lat, 6),
                "lon": round(feed.lon, 6),
                "url": feed.video_id,
                "type": "youtube",
                "state": feed.state,
                "county": feed.county,
                "direction": "",
                "source": "youtube",
            }
        )
        existing_youtube_ids.add(feed.video_id)
        added_youtube += 1

    with data_file.open("w", encoding="utf-8") as f:
        json.dump(cameras, f, ensure_ascii=True)
    return added_provider, added_youtube


def unique_new_provider_feeds(provider_feeds: list[ProviderFeed], existing_embed_urls: set[str]) -> list[ProviderFeed]:
    seen = set(existing_embed_urls)
    unique: list[ProviderFeed] = []
    for feed in provider_feeds:
        key = compact_key(feed.url)
        if key in seen:
            continue
        seen.add(key)
        unique.append(feed)
    return unique


def unique_new_youtube_feeds(youtube_feeds: list[YouTubeFeed], existing_youtube_ids: set[str]) -> list[YouTubeFeed]:
    seen = set(existing_youtube_ids)
    unique: list[YouTubeFeed] = []
    for feed in youtube_feeds:
        if feed.video_id in seen:
            continue
        seen.add(feed.video_id)
        unique.append(feed)
    return unique


def provider_to_report(feed: ProviderFeed) -> dict[str, Any]:
    return {
        "id": feed.provider_id,
        "name": feed.name,
        "lat": feed.lat,
        "lon": feed.lon,
        "url": feed.url,
        "state": feed.state,
        "county": feed.county,
        "city": feed.city,
        "country": feed.country,
        "location": feed.location,
        "source_status": feed.source_status,
        "reasons": feed.reasons,
    }


def youtube_to_report(feed: YouTubeFeed) -> dict[str, Any]:
    return {
        "video_id": feed.video_id,
        "name": feed.name,
        "lat": feed.lat,
        "lon": feed.lon,
        "state": feed.state,
        "county": feed.county,
        "title": feed.title,
        "channel": feed.channel,
        "match_reason": feed.match_reason,
    }


def validate_dataset(data_file: Path) -> dict[str, Any]:
    cameras = load_json_file(data_file, [])
    counts = Counter(cam.get("type") for cam in cameras)
    bad_records = 0
    for cam in cameras:
        try:
            lat = float(cam.get("lat"))
            lon = float(cam.get("lon"))
        except (TypeError, ValueError):
            bad_records += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            bad_records += 1
            continue
        if cam.get("type") == "youtube" and not re.fullmatch(r"[A-Za-z0-9_-]{11}", str(cam.get("url") or "")):
            bad_records += 1
    youtube_ids = [cam.get("url") for cam in cameras if cam.get("type") == "youtube"]
    embed_urls = [compact_key(str(cam.get("url") or "")) for cam in cameras if cam.get("type") == "embed"]
    return {
        "dataset_total": len(cameras),
        "type_counts": dict(sorted(counts.items())),
        "bad_records": bad_records,
        "duplicate_youtube_ids": sum(1 for count in Counter(youtube_ids).values() if count > 1),
        "duplicate_embed_urls": sum(1 for count in Counter(embed_urls).values() if count > 1),
    }


def normalize_video_id(value: str) -> str | None:
    value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.endswith("youtu.be"):
        candidate = parsed.path.strip("/").split("/")[0]
        return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate) else None
    if "youtube.com" in parsed.netloc:
        query = urllib.parse.parse_qs(parsed.query)
        candidate = (query.get("v") or [""])[0]
        return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate) else None
    return None


def make_direct_video_ids(values: list[str], videos_file: Path | None) -> list[str]:
    raw_values = list(values)
    if videos_file:
        for line in videos_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                raw_values.append(line)
    ids: list[str] = []
    seen: set[str] = set()
    for value in raw_values:
        video_id = normalize_video_id(value)
        if video_id and video_id not in seen:
            seen.add(video_id)
            ids.append(video_id)
    return ids


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_FILE, help="camera dataset path")
    parser.add_argument("--report", type=Path, default=REPORT_FILE, help="generated discovery report path")
    parser.add_argument("--youtube-overrides", type=Path, default=YOUTUBE_OVERRIDES_FILE)
    parser.add_argument("--sleep", type=float, default=0.15, help="delay between provider API requests")
    parser.add_argument("--apply", action="store_true", help="append accepted feeds to the dataset")
    parser.add_argument("--skip-youtube", action="store_true", help="only discover EarthCam provider/API feeds")
    parser.add_argument("--youtube-query", action="append", default=[], help="additional EarthCam YouTube live query")
    parser.add_argument("--youtube-video", action="append", default=[], help="direct EarthCam YouTube video ID or watch URL")
    parser.add_argument("--youtube-videos-file", type=Path, help="newline-delimited EarthCam YouTube video IDs or watch URLs")
    parser.add_argument("--youtube-max-pages", type=int, default=2, help="maximum YouTube continuation pages per query")
    parser.add_argument("--youtube-max-empty-pages", type=int, default=1)
    parser.add_argument("--youtube-sleep", type=float, default=0.35)
    parser.add_argument("--include-existing-youtube", action="store_true", help="include already-added YouTube IDs in report")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    cameras = load_json_file(args.data, [])
    existing_embed_urls = {
        compact_key(str(cam.get("url") or ""))
        for cam in cameras
        if cam.get("type") == "embed"
    }
    existing_youtube_ids = {
        str(cam.get("url") or "")
        for cam in cameras
        if cam.get("type") == "youtube"
    }
    print(f"Existing cameras: {len(cameras)}")
    print(f"Existing EarthCam embed URLs: {len(existing_embed_urls)}")
    print(f"Existing YouTube IDs: {len(existing_youtube_ids)}")

    provider_feeds, provider_rejected, provider_errors = discover_provider_feeds(args.sleep)
    new_provider_feeds = unique_new_provider_feeds(provider_feeds, existing_embed_urls)
    print(f"EarthCam provider feeds: accepted={len(provider_feeds)} new={len(new_provider_feeds)} rejected={len(provider_rejected)}")

    youtube_feeds: list[YouTubeFeed] = []
    youtube_rejected: list[dict[str, Any]] = []
    youtube_errors: list[dict[str, str]] = []
    if not args.skip_youtube:
        queries = list(dict.fromkeys(EARTHCAM_YOUTUBE_QUERIES + args.youtube_query))
        direct_video_ids = make_direct_video_ids(args.youtube_video, args.youtube_videos_file)
        overrides = load_json_file(args.youtube_overrides, {})
        youtube_feeds, youtube_rejected, youtube_errors = discover_youtube_feeds(
            provider_feeds,
            existing_youtube_ids,
            overrides,
            queries,
            direct_video_ids,
            args.youtube_max_pages,
            args.youtube_max_empty_pages,
            args.youtube_sleep,
            args.include_existing_youtube,
        )
    new_youtube_feeds = unique_new_youtube_feeds(youtube_feeds, existing_youtube_ids)
    print(f"EarthCam YouTube feeds: accepted={len(youtube_feeds)} new={len(new_youtube_feeds)} rejected={len(youtube_rejected)}")

    added_provider = 0
    added_youtube = 0
    if args.apply:
        added_provider, added_youtube = append_feeds(args.data, new_provider_feeds, new_youtube_feeds)

    validation = validate_dataset(args.data)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "applied": args.apply,
        "added_provider": added_provider,
        "added_youtube": added_youtube,
        "summary": {
            "provider_accepted": len(provider_feeds),
            "provider_new": len(new_provider_feeds),
            "provider_rejected": len(provider_rejected),
            "provider_errors": len(provider_errors),
            "youtube_accepted": len(youtube_feeds),
            "youtube_new": len(new_youtube_feeds),
            "youtube_rejected": len(youtube_rejected),
            "youtube_errors": len(youtube_errors),
            **validation,
        },
        "provider_accepted": [provider_to_report(feed) for feed in provider_feeds],
        "provider_rejected": provider_rejected,
        "provider_errors": provider_errors,
        "youtube_accepted": [youtube_to_report(feed) for feed in youtube_feeds],
        "youtube_rejected": youtube_rejected,
        "youtube_errors": youtube_errors,
    }
    save_json_file(args.report, report)
    print(
        "Summary: "
        f"added_provider={added_provider} added_youtube={added_youtube} "
        f"dataset_total={validation['dataset_total']} types={validation['type_counts']}"
    )
    print(f"Report: {args.report}")

    if validation["bad_records"] or validation["duplicate_youtube_ids"] or validation["duplicate_embed_urls"]:
        print(f"Dataset validation failed: {validation}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
