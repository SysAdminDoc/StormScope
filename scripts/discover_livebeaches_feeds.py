#!/usr/bin/env python3
"""
Discover LiveBeaches webcam pages and append direct live player records.

The script scrapes LiveBeaches category pages for /webcams/ URLs, fetches each
webcam page, extracts the primary player iframe, geocodes the page title, and
appends only deduplicated fixed-location feeds:

- YouTube iframes are verified through the existing YouTube live verifier.
- Brownrice player iframes are accepted only when the player endpoint responds.

Run a bounded provider pass:
    python scripts/discover_livebeaches_feeds.py --apply --max-pages-per-category 2
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
REPORT_FILE = ROOT / "data" / "livebeaches_discovery_report.json"
GEOCODE_CACHE_FILE = ROOT / "data" / "livebeaches_geocode_cache.json"

BASE_URL = "https://www.livebeaches.com"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 "
    "StormScope/0.10.0"
)

DEFAULT_CATEGORIES = [
    "50-best-beach-webcams",
    "featured-cams",
    "boardwalk-cams",
    "pier-cams",
    "marina-cams",
    "harbor-cams",
    "city-cams",
    "weather-cams",
    "wildlife-cams",
    "hd-cams",
    "surf-cams",
    "hotel-cams",
    "sunrise-cams",
    "lighthouse-cams",
    "main-street-cams",
    "pool-cams",
]

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
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
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
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
}

PLAYER_HOST_ALLOWLIST = {
    "player.brownrice.com",
}

IFRAME_REJECT_HOSTS = {
    "www.stay22.com",
    "stay22.com",
    "fundingchoicesmessages.google.com",
}


@dataclass
class PageCandidate:
    page_url: str
    title: str
    player_url: str
    feed_type: str
    video_id: str = ""


@dataclass
class LocatedFeed:
    name: str
    lat: float
    lon: float
    url: str
    feed_type: str
    state: str
    county: str
    source_page: str
    location_query: str
    geocode_display_name: str


def run_curl(args: list[str], *, timeout: int = 35, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = [
        "curl.exe",
        "-L",
        "--compressed",
        "-A",
        USER_AGENT,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        *args,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"curl failed: {proc.returncode}")
    return proc


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True, indent=2)
        f.write("\n")


def clean_text(value: str) -> str:
    value = re.sub(r"<.*?>", " ", value, flags=re.S)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def category_url(slug: str, page: int) -> str:
    base = f"{BASE_URL}/category/{slug}/"
    if page <= 1:
        return base
    return f"{base}page/{page}/"


def extract_webcam_links(category_html: str, base_url: str) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    for match in re.finditer(r"<a\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", category_html, re.I | re.S):
        href = urllib.parse.urljoin(base_url, html.unescape(match.group(1)))
        if "/webcams/" not in href:
            continue
        title = clean_text(match.group(2))
        title = re.sub(r"^\s*Play\s+", "", title, flags=re.I)
        if not title:
            title = href.rstrip("/").split("/")[-1].replace("-", " ").title()
        href = href.split("#", 1)[0]
        if href not in seen:
            seen.add(href)
            links.append((title, href))
    return links


def harvest_pages(categories: list[str], max_pages_per_category: int, sleep: float) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    found: list[tuple[str, str]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()
    for category in categories:
        empty_pages = 0
        for page in range(1, max_pages_per_category + 1):
            url = category_url(category, page)
            try:
                text = run_curl(["-fsSL", url]).stdout
            except Exception as exc:
                errors.append({"category": category, "page": str(page), "url": url, "error": str(exc)})
                empty_pages += 1
                if empty_pages >= 2:
                    break
                continue
            links = extract_webcam_links(text, url)
            new_links = 0
            for title, href in links:
                if href in seen:
                    continue
                seen.add(href)
                found.append((title, href))
                new_links += 1
            print(f"LiveBeaches {category} page {page}: links={len(links)} new={new_links}")
            if new_links == 0:
                empty_pages += 1
                if empty_pages >= 2:
                    break
            else:
                empty_pages = 0
            time.sleep(sleep)
    return found, errors


def page_title(text: str, fallback: str) -> str:
    for pattern in [
        r'<meta property="og:title" content="([^"]+)"',
        r"<title>(.*?)</title>",
        r"<h1[^>]*>(.*?)</h1>",
    ]:
        match = re.search(pattern, text, re.I | re.S)
        if match:
            title = clean_text(match.group(1))
            title = re.sub(r"\s+-\s+Live Beaches.*$", "", title, flags=re.I).strip()
            if title:
                return title
    return fallback


def normalize_youtube_id(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if "youtube.com" in parsed.netloc:
        if parsed.path.startswith("/embed/"):
            candidate = parsed.path.split("/embed/", 1)[1].split("/", 1)[0]
        else:
            query = urllib.parse.parse_qs(parsed.query)
            candidate = (query.get("v") or [""])[0]
        return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate or "") else ""
    if parsed.netloc.endswith("youtu.be"):
        candidate = parsed.path.strip("/").split("/", 1)[0]
        return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate or "") else ""
    return ""


def extract_iframes(page_url: str, text: str) -> list[str]:
    sources: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"<iframe\s+[^>]*src=[\"']([^\"']+)[\"']", text, re.I):
        src = html.unescape(match.group(1)).strip()
        if not src:
            continue
        absolute = urllib.parse.urljoin(page_url, src)
        host = urllib.parse.urlparse(absolute).netloc.lower()
        if host in IFRAME_REJECT_HOSTS:
            continue
        if absolute not in seen:
            seen.add(absolute)
            sources.append(absolute)
    return sources


def inspect_page(fallback_title: str, page_url: str) -> tuple[PageCandidate | None, list[str]]:
    try:
        text = run_curl(["-fsSL", page_url]).stdout
    except Exception as exc:
        return None, [f"page_fetch:{exc}"]
    title = page_title(text, fallback_title)
    for iframe in extract_iframes(page_url, text):
        video_id = normalize_youtube_id(iframe)
        if video_id:
            return PageCandidate(page_url=page_url, title=title, player_url=iframe, feed_type="youtube", video_id=video_id), []
        host = urllib.parse.urlparse(iframe).netloc.lower()
        if host in PLAYER_HOST_ALLOWLIST:
            return PageCandidate(page_url=page_url, title=title, player_url=iframe, feed_type="embed"), []
    return None, ["no_supported_player"]


def verify_youtube(candidate: PageCandidate, sleep: float) -> tuple[bool, str]:
    import discover_youtube_cameras as ytd

    probe = ytd.Candidate(
        video_id=candidate.video_id,
        title=candidate.title,
        channel="LiveBeaches",
        query="livebeaches",
        page=0,
    )
    try:
        verified = ytd.verify_live(probe, sleep)
    except Exception as exc:
        return False, f"youtube_verify:{exc}"
    return (bool(verified), "" if verified else "youtube_not_live")


def verify_embed(url: str) -> tuple[bool, str]:
    proc = run_curl(["-I", "-s", url], timeout=30, check=False)
    headers = proc.stdout.lower()
    if proc.returncode != 0:
        return False, f"embed_fetch:{proc.returncode}"
    if " 200 " not in headers.splitlines()[0]:
        return False, "embed_not_200"
    xfo = re.search(r"^x-frame-options:\s*(.+)$", headers, re.M)
    if xfo and xfo.group(1).strip() in {"deny", "sameorigin"}:
        return False, f"x_frame_options:{xfo.group(1).strip()}"
    return True, ""


def location_queries(title: str) -> list[str]:
    cleaned = clean_text(title)
    cleaned = re.sub(r"\b(Live|Streaming|HD|4K|Webcam|Web Cam|Camera|Cam)\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -|,")
    queries: list[str] = []
    state_match = re.search(r"\b([A-Z][A-Za-z .'-]{2,60}),\s*([A-Z]{2})\b", title)
    if state_match and state_match.group(2) in US_STATES:
        queries.append(f"{state_match.group(1)}, {US_STATES[state_match.group(2)]}")
    if cleaned:
        queries.append(cleaned)
    queries.append(title)
    unique: list[str] = []
    seen: set[str] = set()
    for query in queries:
        query = re.sub(r"\s+", " ", query).strip(" -|,")
        key = query.lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(query)
    return unique


def geocode_title(title: str, cache: dict[str, Any], sleep: float) -> tuple[dict[str, Any] | None, str, str]:
    for query in location_queries(title):
        key = query.lower()
        if key in cache:
            rows = cache[key]
        else:
            params = urllib.parse.urlencode({"format": "jsonv2", "q": query, "limit": 1, "addressdetails": 1})
            try:
                rows = json.loads(run_curl(["-fsSL", f"{NOMINATIM_URL}?{params}"], timeout=30).stdout)
            except Exception:
                rows = []
            cache[key] = rows
            time.sleep(sleep)
        if not rows:
            continue
        row = rows[0]
        try:
            lat = round(float(row["lat"]), 6)
            lon = round(float(row["lon"]), 6)
        except (KeyError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        address = row.get("address") or {}
        country_code = str(address.get("country_code") or "").lower()
        if country_code == "us":
            state = str(address.get("state") or address.get("region") or "")
        else:
            state = str(address.get("country") or address.get("state") or "")
        county = str(
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("hamlet")
            or address.get("county")
            or ""
        )
        if not state:
            continue
        return {
            "lat": lat,
            "lon": lon,
            "state": state,
            "county": county,
            "display_name": row.get("display_name", ""),
        }, query, ""
    return None, "", "geocode_miss"


def locate_candidate(candidate: PageCandidate, cache: dict[str, Any], sleep: float) -> tuple[LocatedFeed | None, str]:
    geocoded, query, failure = geocode_title(candidate.title, cache, sleep)
    if not geocoded:
        return None, failure
    name = candidate.title
    url = candidate.video_id if candidate.feed_type == "youtube" else candidate.player_url
    return (
        LocatedFeed(
            name=name,
            lat=geocoded["lat"],
            lon=geocoded["lon"],
            url=url,
            feed_type=candidate.feed_type,
            state=geocoded["state"],
            county=geocoded["county"],
            source_page=candidate.page_url,
            location_query=query,
            geocode_display_name=str(geocoded.get("display_name") or ""),
        ),
        "",
    )


def append_feeds(data_file: Path, feeds: list[LocatedFeed], limit_add: int) -> int:
    cameras = load_json(data_file, [])
    existing_urls = {str(cam.get("url") or "") for cam in cameras}
    max_id = max(int(cam.get("id") or 0) for cam in cameras) if cameras else 0
    added = 0
    for feed in feeds:
        if limit_add and added >= limit_add:
            break
        if feed.url in existing_urls:
            continue
        max_id += 1
        cameras.append(
            {
                "id": max_id,
                "name": feed.name,
                "lat": feed.lat,
                "lon": feed.lon,
                "url": feed.url,
                "type": feed.feed_type,
                "state": feed.state,
                "county": feed.county,
                "direction": "",
                "source": "livebeaches" if feed.feed_type == "embed" else "youtube",
            }
        )
        existing_urls.add(feed.url)
        added += 1
    with data_file.open("w", encoding="utf-8") as f:
        json.dump(cameras, f, ensure_ascii=True)
    return added


def validate_dataset(data_file: Path) -> dict[str, Any]:
    cameras = load_json(data_file, [])
    youtube = [cam for cam in cameras if cam.get("type") == "youtube"]
    return {
        "dataset_total": len(cameras),
        "type_counts": dict(sorted(Counter(cam.get("type") for cam in cameras).items())),
        "youtube_total": len(youtube),
        "duplicate_youtube_ids": sum(1 for count in Counter(cam.get("url") for cam in youtube).values() if count > 1),
    }


def feed_to_report(feed: LocatedFeed) -> dict[str, Any]:
    return {
        "name": feed.name,
        "lat": feed.lat,
        "lon": feed.lon,
        "url": feed.url,
        "type": feed.feed_type,
        "state": feed.state,
        "county": feed.county,
        "source_page": feed.source_page,
        "location_query": feed.location_query,
        "geocode_display_name": feed.geocode_display_name,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--report", type=Path, default=REPORT_FILE)
    parser.add_argument("--geocode-cache", type=Path, default=GEOCODE_CACHE_FILE)
    parser.add_argument("--category", action="append", default=[], help="LiveBeaches category slug")
    parser.add_argument("--max-pages-per-category", type=int, default=2)
    parser.add_argument("--limit-pages", type=int, default=0, help="maximum webcam pages to inspect")
    parser.add_argument("--limit-add", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--geocode-sleep", type=float, default=1.0)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    sys.path.insert(0, str(ROOT / "scripts"))
    cameras = load_json(args.data, [])
    existing_urls = {str(cam.get("url") or "") for cam in cameras}
    categories = args.category or DEFAULT_CATEGORIES
    page_links, harvest_errors = harvest_pages(categories, args.max_pages_per_category, args.sleep)
    if args.limit_pages:
        page_links = page_links[: args.limit_pages]
    print(f"LiveBeaches pages queued: {len(page_links)}")

    cache = load_json(args.geocode_cache, {})
    inspected: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    located: list[LocatedFeed] = []
    seen_feed_urls: set[str] = set()

    for index, (fallback_title, page_url) in enumerate(page_links, 1):
        candidate, failures = inspect_page(fallback_title, page_url)
        if not candidate:
            rejected.append({"page_url": page_url, "title": fallback_title, "failures": failures})
            continue
        feed_url = candidate.video_id if candidate.feed_type == "youtube" else candidate.player_url
        if feed_url in existing_urls or feed_url in seen_feed_urls:
            rejected.append({"page_url": page_url, "title": candidate.title, "feed_url": feed_url, "failures": ["duplicate"]})
            continue
        if candidate.feed_type == "youtube":
            ok, failure = verify_youtube(candidate, args.sleep)
        else:
            ok, failure = verify_embed(candidate.player_url)
        if not ok:
            rejected.append({"page_url": page_url, "title": candidate.title, "feed_url": feed_url, "failures": [failure]})
            continue
        feed, failure = locate_candidate(candidate, cache, args.geocode_sleep)
        save_json(args.geocode_cache, cache)
        if not feed:
            rejected.append({"page_url": page_url, "title": candidate.title, "feed_url": feed_url, "failures": [failure]})
            continue
        located.append(feed)
        seen_feed_urls.add(feed_url)
        inspected.append({"page_url": page_url, "title": candidate.title, "feed_url": feed_url, "type": candidate.feed_type})
        if index % 25 == 0 or index == len(page_links):
            print(f"Inspected {index}/{len(page_links)} located={len(located)} rejected={len(rejected)}")

    located.sort(key=lambda feed: (feed.feed_type, feed.state, feed.county, feed.name))
    added = append_feeds(args.data, located, args.limit_add) if args.apply else 0
    validation = validate_dataset(args.data)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "applied": args.apply,
        "added": added,
        "categories": categories,
        "summary": {
            "page_links": len(page_links),
            "harvest_errors": len(harvest_errors),
            "located": len(located),
            "rejected": len(rejected),
            **validation,
        },
        "accepted": [feed_to_report(feed) for feed in located],
        "rejected": rejected[:1000],
        "harvest_errors": harvest_errors,
    }
    save_json(args.report, report)
    print(
        "Summary: "
        f"added={added} located={len(located)} rejected={len(rejected)} "
        f"dataset_total={validation['dataset_total']} types={validation['type_counts']}"
    )
    print(f"Report: {args.report}")
    if validation["duplicate_youtube_ids"]:
        print(f"Dataset validation failed: {validation}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
