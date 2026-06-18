#!/usr/bin/env python3
"""
Discover, verify, geocode, and optionally append YouTube live outdoor cameras.

The script intentionally uses curl for network access so the exact YouTube
search and watch/player probes can be reproduced from a shell. It is append-only:
existing camera rows are never removed or rewritten.

Typical exhaustive run:
    python scripts/discover_youtube_cameras.py --query-mode exhaustive --max-pages 8 --apply

Add direct YouTube IDs or watch URLs:
    python scripts/discover_youtube_cameras.py --query-mode custom --video https://www.youtube.com/watch?v=VIDEO_ID --apply

Dry-run report with automatic geocode candidates for review:
    python scripts/discover_youtube_cameras.py --query-mode standard --max-pages 3 --geocode
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
DEFAULT_REPORT = ROOT / "data" / "youtube_discovery_report.json"
DEFAULT_GEOCODE_CACHE = ROOT / "data" / "youtube_geocode_cache.json"
OVERRIDES_FILE = ROOT / "data" / "youtube_location_overrides.json"

YOUTUBE_LIVE_SP = "EgJAAQ=="
YOUTUBE_SEARCH_URL = "https://www.youtube.com/results"
YOUTUBEI_SEARCH_URL = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
YOUTUBEI_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 "
    "StormScope/0.17.0"
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

STATE_NAMES = set(US_STATES.values())

BAD_TERMS = {
    "ambience",
    "ambient",
    "anime",
    "asmr",
    "bitcoin",
    "casino",
    "cartoon",
    "chill",
    "church",
    "concert",
    "crypto",
    "dj ",
    "fireplace",
    "game ",
    "gaming",
    "karaoke",
    "lofi",
    "lo-fi",
    "market",
    "meditation",
    "minecraft",
    "movie",
    "music",
    "podcast",
    "prayer",
    "radio",
    "sermon",
    "sleep",
    "song",
    "stocks",
    "trading",
    "tv show",
    "valorant",
}

GOOD_TERMS = {
    "airport",
    "aviation",
    "bay",
    "beach",
    "boardwalk",
    "bridge",
    "cam",
    "camera",
    "canal",
    "city",
    "crossing",
    "cruise",
    "downtown",
    "freeway",
    "harbor",
    "harbour",
    "highway",
    "lake",
    "livecam",
    "marina",
    "mountain",
    "park",
    "pier",
    "plaza",
    "port",
    "rail",
    "railcam",
    "resort",
    "river",
    "runway",
    "ski",
    "skyline",
    "square",
    "station",
    "storm",
    "street",
    "traffic",
    "train",
    "volcano",
    "weather",
    "web cam",
    "webcam",
    "wildlife",
}

STRONG_CAMERA_TERMS = {
    "airport",
    "beach",
    "boardwalk",
    "cam",
    "camera",
    "harbor",
    "harbour",
    "livecam",
    "marina",
    "pier",
    "railcam",
    "runway",
    "ski",
    "skyline",
    "traffic",
    "train",
    "web cam",
    "webcam",
}

LOCATION_WORDS = {
    "airport",
    "avenue",
    "bay",
    "beach",
    "boardwalk",
    "bridge",
    "canal",
    "city",
    "crossing",
    "downtown",
    "harbor",
    "harbour",
    "highway",
    "lake",
    "marina",
    "mountain",
    "park",
    "pier",
    "plaza",
    "port",
    "resort",
    "river",
    "runway",
    "square",
    "station",
    "street",
    "volcano",
}

GENERIC_LOCATION_REJECTS = {
    "airport",
    "base cam",
    "beach",
    "beach camera",
    "boardwalk",
    "bridge",
    "cam",
    "camera",
    "city",
    "city plaza",
    "downtown",
    "earthcam",
    "harbor",
    "harbor park",
    "live",
    "live cam",
    "live webcam",
    "main chalet",
    "marina",
    "port",
    "railcam",
    "real time",
    "runway",
    "skyline",
    "traffic",
    "train",
    "webcam",
    "west harbour",
    "west harbor",
}

BROAD_LOCATION_QUERIES = {
    "alaska",
    "british columbia, canada",
    "canary islands, spain",
    "hawaii",
    "iceland volcano",
    "java",
    "sicily, italy",
    "southern california",
    "the forest",
    "the french alps",
    "the lower keys",
    "west maui",
}

TOKEN_STOPWORDS = {
    "and",
    "area",
    "base",
    "bay",
    "beach",
    "bridge",
    "cam",
    "camera",
    "city",
    "dock",
    "downtown",
    "east",
    "harbor",
    "harbour",
    "highway",
    "lake",
    "live",
    "marina",
    "mount",
    "mt",
    "north",
    "park",
    "pier",
    "plaza",
    "point",
    "port",
    "resort",
    "river",
    "road",
    "route",
    "runway",
    "south",
    "station",
    "street",
    "the",
    "traffic",
    "view",
    "west",
}

STANDARD_QUERIES = [
    "live webcam 24/7 beach USA",
    "live webcam beach pier USA",
    "live webcam boardwalk pier marina",
    "live webcam city skyline 24/7",
    "live webcam downtown plaza square",
    "live cam airport runway",
    "live airport plane spotting 24/7",
    "live train cam railcam USA",
    "live railcam train station",
    "earthcam live outdoor webcam",
    "live webcam mountain ski resort",
    "live webcam ski resort base",
    "live harbor port webcam 24/7",
    "live marina harbor cam",
    "live weather cam storm",
    "live webcam volcano mountain",
    "live webcam lake 24/7",
    "live webcam bridge river",
    "live webcam cruise port",
    "live webcam lighthouse harbor",
    "live cam national park wildlife",
    "live traffic cam highway freeway",
    "live webcam europe asia japan london",
]

EXHAUSTIVE_CATEGORIES = [
    "beach pier",
    "boardwalk",
    "city skyline",
    "downtown",
    "airport runway",
    "plane spotting",
    "train railcam",
    "harbor port",
    "marina",
    "ski resort",
    "mountain",
    "lake",
    "river bridge",
    "traffic highway",
    "weather storm",
    "national park",
    "wildlife",
    "lighthouse",
    "cruise port",
]

EXHAUSTIVE_REGIONS = [
    "USA",
    "Florida",
    "California",
    "Texas",
    "New York",
    "New Jersey",
    "North Carolina",
    "South Carolina",
    "Georgia",
    "Virginia",
    "Maryland",
    "Delaware",
    "Maine",
    "Massachusetts",
    "Washington",
    "Oregon",
    "Colorado",
    "Utah",
    "Wyoming",
    "Montana",
    "Michigan",
    "Wisconsin",
    "Minnesota",
    "Illinois",
    "Indiana",
    "Ohio",
    "Pennsylvania",
    "Arizona",
    "Nevada",
    "Hawaii",
    "Alaska",
    "Canada",
    "Mexico",
    "Caribbean",
    "United Kingdom",
    "Ireland",
    "Netherlands",
    "Germany",
    "France",
    "Spain",
    "Italy",
    "Greece",
    "Norway",
    "Sweden",
    "Japan",
    "Australia",
    "New Zealand",
]


@dataclasses.dataclass
class Candidate:
    video_id: str
    title: str
    channel: str = ""
    query: str = ""
    page: int = 0
    verified_title: str = ""
    verified_channel: str = ""
    playability_status: str = ""
    score: int = 0
    reasons: list[str] = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class LocatedCamera:
    video_id: str
    name: str
    lat: float
    lon: float
    state: str
    county: str
    location_query: str
    geocode_display_name: str
    score: int
    reasons: list[str]


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


def curl_text(url: str, *, timeout: int = 30) -> str:
    return run_curl([url], timeout=timeout).decode("utf-8", "replace")


def curl_json_post(url: str, body: dict[str, Any], *, timeout: int = 30) -> dict[str, Any]:
    raw = run_curl(
        ["-H", "Content-Type: application/json", "-X", "POST", url, "--data-binary", "@-"],
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
    return json.loads(raw.decode("utf-8", "replace"))


def extract_json_after(text: str, marker: str) -> dict[str, Any] | None:
    idx = text.find(marker)
    if idx < 0:
        return None
    idx = text.find("{", idx)
    if idx < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for pos in range(idx, len(text)):
        char = text[pos]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[idx : pos + 1])
    return None


def walk_json(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json(child)


def yt_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("simpleText"), str):
        return value["simpleText"]
    runs = value.get("runs")
    if isinstance(runs, list):
        return "".join(run.get("text", "") for run in runs if isinstance(run, dict)).strip()
    return ""


def make_queries(mode: str, extra_queries: list[str], queries_file: Path | None) -> list[str]:
    queries = [] if mode == "custom" else list(STANDARD_QUERIES)
    if mode == "exhaustive":
        for category in EXHAUSTIVE_CATEGORIES:
            for region in EXHAUSTIVE_REGIONS:
                queries.append(f"live webcam {category} {region} 24/7")
                if "railcam" in category or "airport" in category:
                    queries.append(f"live cam {category} {region}")
    if queries_file:
        for line in queries_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                queries.append(line)
    queries.extend(extra_queries)
    unique: list[str] = []
    seen: set[str] = set()
    for query in queries:
        key = re.sub(r"\s+", " ", query.strip().lower())
        if key and key not in seen:
            seen.add(key)
            unique.append(query.strip())
    return unique


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
    match = re.search(r"(?:v=|/)([A-Za-z0-9_-]{11})(?:[?&/#]|$)", value)
    return match.group(1) if match else None


def make_direct_video_ids(videos: list[str], videos_file: Path | None) -> list[str]:
    values = list(videos)
    if videos_file:
        for line in videos_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                values.append(line)
    ids: list[str] = []
    seen: set[str] = set()
    for value in values:
        video_id = normalize_video_id(value)
        if video_id and video_id not in seen:
            seen.add(video_id)
            ids.append(video_id)
    return ids


def parse_initial_search(query: str) -> tuple[dict[str, Any] | None, str | None, str]:
    params = urllib.parse.urlencode({"search_query": query, "sp": YOUTUBE_LIVE_SP})
    html = curl_text(f"{YOUTUBE_SEARCH_URL}?{params}", timeout=35)
    if "detected unusual traffic" in html.lower() or "sorry/index" in html.lower():
        raise RuntimeError("YouTube returned an unusual-traffic page")
    api_key_match = re.search(r'"INNERTUBE_API_KEY":"([^"]+)', html)
    version_match = re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)', html)
    data = extract_json_after(html, "var ytInitialData") or extract_json_after(html, "ytInitialData")
    version = version_match.group(1) if version_match else "2.20260616.04.00"
    api_key = api_key_match.group(1) if api_key_match else None
    return data, api_key, version


def collect_video_renderers(data: dict[str, Any], query: str, page: int) -> list[Candidate]:
    candidates: list[Candidate] = []
    for node in walk_json(data):
        renderer = node.get("videoRenderer")
        if not isinstance(renderer, dict):
            continue
        video_id = renderer.get("videoId")
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            continue
        title = yt_text(renderer.get("title"))
        channel = yt_text(renderer.get("ownerText")) or yt_text(renderer.get("longBylineText"))
        candidates.append(Candidate(video_id=video_id, title=title, channel=channel, query=query, page=page))
    return candidates


def collect_continuation_tokens(data: dict[str, Any]) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for node in walk_json(data):
        command = node.get("continuationCommand")
        if not isinstance(command, dict):
            continue
        token = command.get("token")
        if isinstance(token, str) and token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


def harvest_query(query: str, max_pages: int, max_empty_pages: int, sleep_seconds: float) -> list[Candidate]:
    data, api_key, client_version = parse_initial_search(query)
    if not data:
        return []
    all_candidates: list[Candidate] = []
    seen_ids: set[str] = set()
    seen_tokens: set[str] = set()
    empty_pages = 0
    page = 0
    while data and page < max_pages:
        page += 1
        page_candidates = []
        for candidate in collect_video_renderers(data, query, page):
            if candidate.video_id not in seen_ids:
                seen_ids.add(candidate.video_id)
                page_candidates.append(candidate)
        all_candidates.extend(page_candidates)
        empty_pages = empty_pages + 1 if not page_candidates else 0
        if empty_pages >= max_empty_pages:
            break
        tokens = [token for token in collect_continuation_tokens(data) if token not in seen_tokens]
        if not tokens or not api_key:
            break
        token = tokens[0]
        seen_tokens.add(token)
        body = {
            "context": {"client": {"clientName": "WEB", "clientVersion": client_version}},
            "continuation": token,
        }
        time.sleep(sleep_seconds)
        data = curl_json_post(f"{YOUTUBEI_SEARCH_URL}&key={api_key}", body, timeout=35)
    return all_candidates


def score_candidate(candidate: Candidate) -> Candidate:
    blob = f"{candidate.title} {candidate.channel}".lower()
    score = 0
    reasons: list[str] = []
    good_hits = sorted(term for term in GOOD_TERMS if term in blob)
    strong_hits = sorted(term for term in STRONG_CAMERA_TERMS if term in blob)
    bad_hits = sorted(term for term in BAD_TERMS if term in blob)
    if good_hits:
        score += min(6, len(good_hits) * 2)
        reasons.append("good:" + ",".join(good_hits[:6]))
    if strong_hits:
        score += 4
        reasons.append("strong_camera:" + ",".join(strong_hits[:4]))
    if "24/7" in blob or "live" in blob:
        score += 1
        reasons.append("live_word")
    if bad_hits:
        score -= 8
        reasons.append("reject_terms:" + ",".join(bad_hits[:4]))
    if "news" in blob and not strong_hits:
        score -= 4
        reasons.append("news_without_camera")
    candidate.score = score
    candidate.reasons = reasons
    return candidate


def verify_live(candidate: Candidate, sleep_seconds: float) -> Candidate | None:
    body = {
        "context": {"client": {"clientName": "WEB", "clientVersion": "2.20260616.04.00"}},
        "videoId": candidate.video_id,
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    time.sleep(sleep_seconds)
    data = curl_json_post(YOUTUBEI_PLAYER_URL, body, timeout=30)
    details = data.get("videoDetails") or {}
    status = (data.get("playabilityStatus") or {}).get("status", "")
    if not details.get("isLiveContent"):
        return None
    candidate.verified_title = details.get("title") or candidate.title
    candidate.verified_channel = details.get("author") or candidate.channel
    candidate.playability_status = status
    return candidate


def clean_for_location(text: str) -> str:
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = text.replace("—", "-").replace("–", "-")
    text = re.sub(r"(?i)\b(live|stream|streaming|webcam|web cam|camera|cam|cams|ptz|4k|hd|uhd|24/7|247|weather|earthcam|virtual railfan|railcam|plane spotting|watch|now)\b", " ", text)
    text = re.sub(r"[^A-Za-z0-9,.' /&-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -,:|")
    return text


def add_location_query(queries: list[str], value: str) -> None:
    value = re.sub(r"\s+", " ", value).strip(" -,:|")
    if not value:
        return
    if len(value) < 4 or len(value) > 90:
        return
    if value.lower() in GENERIC_LOCATION_REJECTS or value.lower() in BROAD_LOCATION_QUERIES:
        return
    if not significant_tokens(value):
        return
    if value.lower() not in {item.lower() for item in queries}:
        queries.append(value)


def significant_tokens(value: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+", value.lower())
    significant = []
    for token in tokens:
        if len(token) < 4:
            continue
        if token in TOKEN_STOPWORDS:
            continue
        if token in {"livecam", "webcam", "railcam"}:
            continue
        significant.append(token)
    return significant


def location_phrase_candidates(source: str) -> list[str]:
    phrase_types = (
        "Airport|Bay|Beach|Boardwalk|Bridge|Canal|Crossing|Harbor|Harbour|Island|"
        "Lake|Lighthouse|Marina|Mountain|Park|Pier|Plaza|Point|Port|Resort|River|"
        "Runway|Square|Station|Village|Volcano|Yard"
    )
    candidates: list[str] = []
    for match in re.finditer(rf"\b(Port of [A-Z][A-Za-z0-9 .'&/-]{{2,45}})", source):
        candidates.append(clean_for_location(match.group(1)))
    for match in re.finditer(rf"\b([A-Z][A-Za-z0-9 .'&/-]{{1,55}}\b(?:{phrase_types}))\b", source):
        phrase = clean_for_location(match.group(1))
        words = phrase.split()
        if len(words) > 7:
            phrase = " ".join(words[-7:])
        candidates.append(phrase)
    return candidates


def extract_location_queries(title: str, channel: str) -> list[str]:
    source = title.replace("—", "-").replace("–", "-")
    queries: list[str] = []

    state_abbr_pattern = "|".join(re.escape(code) for code in US_STATES)
    state_name_pattern = "|".join(re.escape(name) for name in sorted(STATE_NAMES, key=len, reverse=True))
    country_pattern = (
        "Canada|Mexico|United Kingdom|UK|Ireland|Netherlands|Germany|France|Spain|Italy|"
        "Greece|Norway|Sweden|Japan|Australia|New Zealand|Sint Maarten|Israel|Czechia|"
        "Switzerland|Austria|Portugal|Iceland|Finland|Denmark"
    )

    for match in re.finditer(rf"([A-Z][A-Za-z0-9 .'&/-]{{2,55}}),\s*([A-Z][A-Za-z .'&/-]{{2,40}}),\s*({country_pattern})\b", source):
        add_location_query(queries, f"{clean_for_location(match.group(1))}, {clean_for_location(match.group(2))}, {match.group(3)}")

    for match in re.finditer(rf"([A-Z][A-Za-z0-9 .'&/-]{{2,55}}),\s*({state_abbr_pattern})\b", source):
        add_location_query(queries, f"{clean_for_location(match.group(1))}, {US_STATES[match.group(2)]}")

    for match in re.finditer(rf"([A-Z][A-Za-z0-9 .'&/-]{{2,55}}),\s*({state_name_pattern}|{country_pattern})\b", source):
        add_location_query(queries, f"{clean_for_location(match.group(1))}, {match.group(2)}")

    for phrase in location_phrase_candidates(source):
        add_location_query(queries, phrase)

    for match in re.finditer(rf"\b([A-Z][A-Za-z .'&/-]{{2,45}})\s+({state_abbr_pattern})\b", source):
        add_location_query(queries, f"{clean_for_location(match.group(1))}, {US_STATES[match.group(2)]}")

    for match in re.finditer(r"(?i)\b(?:from|at|in)\s+([A-Z][A-Za-z0-9 .'&/-]{3,65})", source):
        add_location_query(queries, clean_for_location(match.group(1)))

    parts = re.split(r"\s+\|\s+|\s+-\s+|:", source)
    for part in parts[:4]:
        cleaned = clean_for_location(part)
        lower = cleaned.lower()
        if not cleaned:
            continue
        if any(word in lower for word in LOCATION_WORDS) or any(state.lower() in lower for state in STATE_NAMES):
            add_location_query(queries, cleaned)

    cleaned_title = clean_for_location(source)
    if 2 <= len(cleaned_title.split()) <= 8:
        add_location_query(queries, cleaned_title)

    if channel and any(word in channel.lower() for word in ("airport", "harbor", "rail", "beach", "weather")):
        cleaned_channel = clean_for_location(channel)
        if 2 <= len(cleaned_channel.split()) <= 8:
            add_location_query(queries, cleaned_channel)

    return queries


def geocode_result_matches_query(query: str, result: dict[str, Any], candidate: Candidate) -> bool:
    query_tokens = significant_tokens(query)
    if not query_tokens:
        return False
    display = str(result.get("display_name") or "")
    display_tokens = set(significant_tokens(display))
    if not any(token in display_tokens for token in query_tokens):
        return False

    title_blob = f"{candidate.verified_title or candidate.title} {candidate.verified_channel or candidate.channel}".lower()
    address = result.get("address") or {}
    result_context = " ".join(
        str(address.get(key) or "").lower()
        for key in ("state", "country", "city", "town", "village", "county")
    )
    for state in STATE_NAMES:
        if state.lower() in title_blob and state.lower() not in result_context:
            return False
    country_aliases = {
        "canada": "canada",
        "curacao": "curacao",
        "czechia": "czechia",
        "finland": "finland",
        "france": "france",
        "greece": "greece",
        "iceland": "iceland",
        "ireland": "ireland",
        "israel": "israel",
        "italy": "italy",
        "japan": "japan",
        "netherlands": "netherlands",
        "spain": "spain",
        "thailand": "thailand",
        "uk": "united kingdom",
        "united kingdom": "united kingdom",
    }
    for title_country, result_country in country_aliases.items():
        if title_country in title_blob and result_country not in result_context:
            return False
    return True


def load_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json_file(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, ensure_ascii=True)
        f.write("\n")


def geocode_query(query: str, cache: dict[str, Any], sleep_seconds: float) -> dict[str, Any] | None:
    cache_key = query.lower()
    if cache_key in cache:
        return cache[cache_key]
    params = urllib.parse.urlencode(
        {
            "format": "jsonv2",
            "addressdetails": 1,
            "limit": 1,
            "q": query,
        }
    )
    time.sleep(sleep_seconds)
    try:
        raw = curl_text(f"{NOMINATIM_URL}?{params}", timeout=30)
        results = json.loads(raw)
    except Exception as exc:
        cache[cache_key] = {"error": str(exc), "query": query}
        return None
    result = results[0] if results else None
    cache[cache_key] = result or {"miss": True, "query": query}
    return result


def state_and_county_from_geocode(result: dict[str, Any]) -> tuple[str, str]:
    address = result.get("address") or {}
    country_code = str(address.get("country_code") or "").lower()
    if country_code == "us":
        state = address.get("state") or ""
    else:
        state = address.get("country") or ""
    county = (
        address.get("county")
        or address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or address.get("state_district")
        or ""
    )
    return str(state), str(county)


def located_from_override(candidate: Candidate, override: dict[str, Any]) -> LocatedCamera:
    return LocatedCamera(
        video_id=candidate.video_id,
        name=str(override.get("name") or clean_camera_name(candidate)),
        lat=round(float(override["lat"]), 6),
        lon=round(float(override["lon"]), 6),
        state=str(override.get("state") or ""),
        county=str(override.get("county") or ""),
        location_query=str(override.get("location_query") or "override"),
        geocode_display_name=str(override.get("geocode_display_name") or "override"),
        score=candidate.score + 5,
        reasons=[*candidate.reasons, "location_override"],
    )


def clean_camera_name(candidate: Candidate) -> str:
    title = candidate.verified_title or candidate.title
    title = re.sub(r"\s+", " ", title).strip()
    title = re.sub(r"(?i)\s*\|\s*live.*$", "", title).strip()
    title = re.sub(r"(?i)\s*-\s*live stream.*$", "", title).strip()
    title = re.sub(r"(?i)\s*-\s*live cam.*$", " Live", title).strip()
    if len(title) > 90:
        title = title[:87].rstrip() + "..."
    return title or f"YouTube Live Camera {candidate.video_id}"


def locate_candidate(
    candidate: Candidate,
    overrides: dict[str, Any],
    geocode: bool,
    geocode_cache: dict[str, Any],
    geocode_sleep: float,
) -> tuple[LocatedCamera | None, list[str]]:
    if candidate.video_id in overrides:
        return located_from_override(candidate, overrides[candidate.video_id]), []
    if not geocode:
        return None, ["geocode_disabled"]
    failures: list[str] = []
    title = candidate.verified_title or candidate.title
    channel = candidate.verified_channel or candidate.channel
    for query in extract_location_queries(title, channel):
        result = geocode_query(query, geocode_cache, geocode_sleep)
        if not result or result.get("error") or result.get("miss"):
            failures.append(f"geocode_miss:{query}")
            continue
        try:
            lat = round(float(result["lat"]), 6)
            lon = round(float(result["lon"]), 6)
        except (KeyError, TypeError, ValueError):
            failures.append(f"bad_geocode:{query}")
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            failures.append(f"bad_coordinates:{query}")
            continue
        if not geocode_result_matches_query(query, result, candidate):
            failures.append(f"geocode_mismatch:{query}")
            continue
        state, county = state_and_county_from_geocode(result)
        display = str(result.get("display_name") or query)
        return (
            LocatedCamera(
                video_id=candidate.video_id,
                name=clean_camera_name(candidate),
                lat=lat,
                lon=lon,
                state=state,
                county=county,
                location_query=query,
                geocode_display_name=display,
                score=candidate.score,
                reasons=[*candidate.reasons, "geocoded"],
            ),
            failures,
        )
    return None, failures or ["no_location_query"]


def append_cameras(data_file: Path, located: list[LocatedCamera], limit_add: int) -> int:
    cameras = load_json_file(data_file, [])
    if not isinstance(cameras, list):
        raise RuntimeError(f"{data_file} does not contain a JSON array")
    existing_ids = {str(cam.get("url")) for cam in cameras if cam.get("type") == "youtube"}
    max_id = max(int(cam.get("id") or 0) for cam in cameras) if cameras else 0
    added = 0
    for camera in located:
        if limit_add and added >= limit_add:
            break
        if camera.video_id in existing_ids:
            continue
        max_id += 1
        cameras.append(
            {
                "id": max_id,
                "name": camera.name,
                "lat": camera.lat,
                "lon": camera.lon,
                "url": camera.video_id,
                "type": "youtube",
                "state": camera.state,
                "county": camera.county,
                "direction": "",
                "source": "youtube",
            }
        )
        existing_ids.add(camera.video_id)
        added += 1
    with data_file.open("w", encoding="utf-8") as f:
        json.dump(cameras, f, ensure_ascii=True)
    return added


def camera_to_report(camera: LocatedCamera) -> dict[str, Any]:
    return {
        "video_id": camera.video_id,
        "name": camera.name,
        "lat": camera.lat,
        "lon": camera.lon,
        "state": camera.state,
        "county": camera.county,
        "location_query": camera.location_query,
        "geocode_display_name": camera.geocode_display_name,
        "score": camera.score,
        "reasons": camera.reasons,
    }


def candidate_to_report(candidate: Candidate, failures: list[str] | None = None) -> dict[str, Any]:
    return {
        "video_id": candidate.video_id,
        "title": candidate.title,
        "channel": candidate.channel,
        "verified_title": candidate.verified_title,
        "verified_channel": candidate.verified_channel,
        "query": candidate.query,
        "page": candidate.page,
        "playability_status": candidate.playability_status,
        "score": candidate.score,
        "reasons": candidate.reasons,
        "failures": failures or [],
    }


def validate_dataset(data_file: Path) -> tuple[int, int, int, int]:
    cameras = load_json_file(data_file, [])
    youtube = [cam for cam in cameras if cam.get("type") == "youtube"]
    ids = [cam.get("url") for cam in youtube]
    duplicate_count = sum(1 for count in Counter(ids).values() if count > 1)
    bad_count = 0
    for cam in youtube:
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", str(cam.get("url") or "")):
            bad_count += 1
            continue
        try:
            lat = float(cam.get("lat"))
            lon = float(cam.get("lon"))
        except (TypeError, ValueError):
            bad_count += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            bad_count += 1
    return len(cameras), len(youtube), duplicate_count, bad_count


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_FILE, help="camera dataset path")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="generated discovery report path")
    parser.add_argument("--geocode-cache", type=Path, default=DEFAULT_GEOCODE_CACHE, help="generated Nominatim cache path")
    parser.add_argument("--overrides", type=Path, default=OVERRIDES_FILE, help="optional curated location overrides JSON")
    parser.add_argument("--query-mode", choices=["standard", "exhaustive", "custom"], default="standard")
    parser.add_argument("--query", action="append", default=[], help="additional live-search query")
    parser.add_argument("--queries-file", type=Path, help="newline-delimited search queries")
    parser.add_argument("--video", action="append", default=[], help="direct YouTube video ID or watch URL")
    parser.add_argument("--videos-file", type=Path, help="newline-delimited YouTube video IDs or watch URLs")
    parser.add_argument("--max-pages", type=int, default=6, help="maximum YouTube search pages per query")
    parser.add_argument("--max-empty-pages", type=int, default=2, help="stop a query after this many pages without new IDs")
    parser.add_argument("--min-score", type=int, default=5, help="minimum content score before live verification")
    parser.add_argument("--limit-add", type=int, default=0, help="maximum cameras to append; 0 means no limit")
    parser.add_argument("--sleep", type=float, default=0.35, help="delay between YouTube requests")
    parser.add_argument("--geocode-sleep", type=float, default=1.1, help="delay between Nominatim geocode requests")
    parser.add_argument("--geocode", action="store_true", help="use Nominatim to geocode candidates without overrides")
    parser.add_argument("--apply", action="store_true", help="append accepted cameras to the dataset")
    parser.add_argument("--keep-existing", action="store_true", help="include existing YouTube IDs in verification/reporting")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    cameras = load_json_file(args.data, [])
    existing_youtube_ids = {str(cam.get("url")) for cam in cameras if cam.get("type") == "youtube"}
    overrides = load_json_file(args.overrides, {})
    geocode_cache = load_json_file(args.geocode_cache, {})
    queries = make_queries(args.query_mode, args.query, args.queries_file)
    direct_video_ids = make_direct_video_ids(args.video, args.videos_file)

    print(f"Existing YouTube cameras: {len(existing_youtube_ids)}")
    print(f"Search queries: {len(queries)} mode={args.query_mode} max_pages={args.max_pages}")
    print(f"Direct videos: {len(direct_video_ids)}")

    raw_candidates: dict[str, Candidate] = {}
    query_errors: list[dict[str, str]] = []
    for index, query in enumerate(queries, 1):
        try:
            found = harvest_query(query, args.max_pages, args.max_empty_pages, args.sleep)
        except Exception as exc:
            query_errors.append({"query": query, "error": str(exc)})
            print(f"[{index}/{len(queries)}] ERROR {query}: {exc}")
            continue
        new_count = 0
        for candidate in found:
            if not args.keep_existing and candidate.video_id in existing_youtube_ids:
                continue
            if candidate.video_id in raw_candidates:
                continue
            raw_candidates[candidate.video_id] = candidate
            new_count += 1
        print(f"[{index}/{len(queries)}] {query}: {len(found)} IDs, {new_count} new")
        time.sleep(args.sleep)

    direct_new = 0
    for video_id in direct_video_ids:
        if not args.keep_existing and video_id in existing_youtube_ids:
            continue
        if video_id in raw_candidates:
            continue
        raw_candidates[video_id] = Candidate(video_id=video_id, title="", channel="", query="direct", page=0)
        direct_new += 1
    if direct_video_ids:
        print(f"Direct video IDs queued: {direct_new} new")

    scored = [score_candidate(candidate) for candidate in raw_candidates.values()]
    to_verify = [candidate for candidate in scored if candidate.score >= args.min_score or candidate.query == "direct"]
    rejected_content = [
        candidate for candidate in scored if candidate.score < args.min_score and candidate.query != "direct"
    ]

    print(f"Unique candidates: {len(raw_candidates)}")
    print(f"Content-score candidates to verify: {len(to_verify)}")

    live_candidates: list[Candidate] = []
    for index, candidate in enumerate(to_verify, 1):
        try:
            verified = verify_live(candidate, args.sleep)
        except Exception as exc:
            candidate.reasons.append(f"verify_error:{exc}")
            verified = None
        if verified:
            live_candidates.append(verified)
        if index % 25 == 0 or index == len(to_verify):
            print(f"Verified {index}/{len(to_verify)}; live={len(live_candidates)}")

    located: list[LocatedCamera] = []
    location_rejects: list[dict[str, Any]] = []
    for candidate in live_candidates:
        camera, failures = locate_candidate(candidate, overrides, args.geocode, geocode_cache, args.geocode_sleep)
        if camera:
            located.append(camera)
        else:
            location_rejects.append(candidate_to_report(candidate, failures))
        if args.geocode:
            save_json_file(args.geocode_cache, geocode_cache)

    located.sort(key=lambda item: (-item.score, item.state, item.name))

    added = 0
    if args.apply:
        added = append_cameras(args.data, located, args.limit_add)

    total, youtube_total, duplicate_youtube_ids, bad_youtube_records = validate_dataset(args.data)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "query_mode": args.query_mode,
        "max_pages": args.max_pages,
        "min_score": args.min_score,
        "applied": args.apply,
        "added": added,
        "summary": {
            "queries": len(queries),
            "direct_videos": len(direct_video_ids),
            "query_errors": len(query_errors),
            "unique_candidates": len(raw_candidates),
            "content_rejected": len(rejected_content),
            "verified_live": len(live_candidates),
            "located": len(located),
            "location_rejected": len(location_rejects),
            "dataset_total": total,
            "dataset_youtube": youtube_total,
            "duplicate_youtube_ids": duplicate_youtube_ids,
            "bad_youtube_records": bad_youtube_records,
        },
        "accepted": [camera_to_report(camera) for camera in located],
        "location_rejected": location_rejects,
        "content_rejected": [candidate_to_report(candidate) for candidate in rejected_content[:500]],
        "query_errors": query_errors,
    }
    save_json_file(args.report, report)

    print(
        "Summary: "
        f"added={added} live={len(live_candidates)} located={len(located)} "
        f"location_rejected={len(location_rejects)} dataset_total={total} youtube={youtube_total}"
    )
    print(f"Report: {args.report}")
    if duplicate_youtube_ids or bad_youtube_records:
        print(
            f"Dataset validation failed: duplicate_youtube_ids={duplicate_youtube_ids} "
            f"bad_youtube_records={bad_youtube_records}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
