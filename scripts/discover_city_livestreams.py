#!/usr/bin/env python3
"""
Build a Census city list and search those city labels for YouTube livestream cameras.

The Census input is the 2025 Gazetteer places file. By default, this script
emits legal city records only in "Columbus, Ohio" format. Search runs are
append-only and resumable: existing YouTube IDs are skipped, new accepted
streams are located at the Census city centroid, and a checkpoint records
processed GEOIDs.

Build the city list:
    python scripts/discover_city_livestreams.py --build-city-list

Run a bounded search batch:
    python scripts/discover_city_livestreams.py --apply --resume --limit-cities 250

Run until every city in the list has been searched:
    python scripts/discover_city_livestreams.py --apply --resume
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
import sys
import time
import zipfile
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
CITY_JSON_FILE = ROOT / "data" / "us_cities_2025.json"
CITY_TXT_FILE = ROOT / "data" / "us_cities_2025.txt"
REPORT_FILE = ROOT / "data" / "us_city_livestream_report.json"
CHECKPOINT_FILE = ROOT / "data" / "us_city_livestream_checkpoint.json"

CENSUS_GAZETTEER_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
    "2025_Gazetteer/2025_Gaz_place_national.zip"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 "
    "StormScope/0.22.0"
)

STATE_NAMES = {
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
    "MT": "Montana",
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

COMMON_AMBIGUOUS_CITY_NAMES = {
    "bridgeport",
    "commerce",
    "clinton",
    "decatur",
    "eagle",
    "jackson",
    "jacksonville",
    "madison",
    "marina",
    "mobile",
    "mountain view",
    "long beach",
    "ontario",
    "orange",
    "roanoke",
    "sheridan",
    "springfield",
    "taylor",
    "union",
    "valley",
}

STATE_NAME_VALUES = {state.lower() for state in STATE_NAMES.values()}

FOREIGN_LOCATION_HINTS = {
    "alberta",
    "australia",
    "banff",
    "british columbia",
    "canada",
    "england",
    "ireland",
    "japan",
    "mexico",
    "new zealand",
    "ontario canada",
    "scotland",
    "south africa",
    "spain",
    "tofino",
    "united kingdom",
    "wales",
}

SAFE_STATE_ABBR_MATCHES = {
    abbr for abbr in STATE_NAMES if abbr not in {"HI", "ID", "IN", "ME", "OK", "OR"}
}

LEGAL_PLACE_LSADS = {"21", "25", "37", "43", "47", "53", "CG", "CN", "MG", "UC", "UG"}
CITY_LSADS = {"25"}
ALL_PLACE_LSADS = LEGAL_PLACE_LSADS | {"00", "55", "57", "62"}

SUFFIXES = [
    " metropolitan government (balance)",
    " metro government (balance)",
    " consolidated government",
    " unified government",
    " urban county",
    " city and borough",
    " municipality",
    " borough",
    " village",
    " town",
    " city",
    " CDP",
    " comunidad",
    " zona urbana",
    " (balance)",
]

BAD_TERMS = {
    "ambience",
    "ambient",
    "around the world",
    "asmr",
    "bitcoin",
    "cartoon",
    "casino",
    "chill",
    "church",
    "concert",
    "council",
    "court",
    "crypto",
    "dj ",
    "funeral",
    "game ",
    "gaming",
    "graduation",
    "karaoke",
    "lofi",
    "lo-fi",
    "market",
    "mass ",
    "meeting",
    "minecraft",
    "movie",
    "music",
    "podcast",
    "police scanner",
    "radio",
    "school board",
    "sermon",
    "service",
    "sleep",
    "song",
    "sports",
    "stocks",
    "trading",
    "valorant",
    "worship",
    "webcam tour",
}

STRONG_CAMERA_TERMS = {
    "airport",
    "beach",
    "bridge",
    "cam",
    "camera",
    "harbor",
    "harbour",
    "livecam",
    "marina",
    "pier",
    "railcam",
    "runway",
    "skyline",
    "traffic",
    "train",
    "web cam",
    "webcam",
}

WEATHER_LOCATION_TERMS = {
    "airport",
    "beach",
    "bridge",
    "downtown",
    "harbor",
    "harbour",
    "highway",
    "lake",
    "marina",
    "mountain",
    "pier",
    "port",
    "river",
    "road",
    "runway",
    "skyline",
    "square",
    "street",
    "traffic",
    "weather",
}

TOKEN_STOPWORDS = {
    "city",
    "town",
    "village",
    "live",
    "stream",
    "streaming",
    "webcam",
    "camera",
    "cam",
    "cams",
    "the",
    "and",
    "for",
    "from",
    "with",
    "official",
    "channel",
}

NEW_YORK_CITY_HINTS = {
    "brooklyn",
    "bronx",
    "east river",
    "manhattan",
    "new york city",
    "nyc",
    "queens",
    "staten island",
    "times square",
    "upper east side",
}

DEFAULT_QUERY_TEMPLATES = [
    "{label} live webcam",
    "{label} live cam",
]


@dataclass
class CityRecord:
    geoid: str
    label: str
    name: str
    raw_name: str
    state: str
    state_abbr: str
    lat: float
    lon: float
    lsad: str
    funcstat: str


@dataclass
class CityLocatedStream:
    video_id: str
    name: str
    lat: float
    lon: float
    state: str
    county: str
    city_label: str
    query: str
    title: str
    channel: str
    score: int
    reasons: list[str] = field(default_factory=list)


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


def clean_place_name(value: str) -> str:
    name = re.sub(r"\s+", " ", value).strip()
    for suffix in SUFFIXES:
        if name.endswith(suffix):
            name = name[: -len(suffix)].strip()
            break
    return name


def place_scope_lsads(scope: str) -> set[str]:
    if scope == "city":
        return CITY_LSADS
    if scope == "legal":
        return LEGAL_PLACE_LSADS
    if scope == "all":
        return ALL_PLACE_LSADS
    raise ValueError(f"unknown scope: {scope}")


def build_city_records(scope: str) -> list[CityRecord]:
    raw = run_curl([CENSUS_GAZETTEER_URL], timeout=60)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
        if not names:
            raise RuntimeError("Census Gazetteer zip was empty")
        text = zf.read(names[0]).decode("utf-8", "replace")

    wanted_lsads = place_scope_lsads(scope)
    records: list[CityRecord] = []
    seen_labels: set[str] = set()
    for row in csv.DictReader(text.splitlines(), delimiter="|"):
        state_abbr = row.get("USPS", "")
        if state_abbr not in STATE_NAMES:
            continue
        if row.get("LSAD") not in wanted_lsads:
            continue
        name = clean_place_name(row.get("NAME", ""))
        if not name:
            continue
        label = f"{name}, {STATE_NAMES[state_abbr]}"
        key = label.lower()
        if key in seen_labels:
            continue
        seen_labels.add(key)
        try:
            lat = round(float(row["INTPTLAT"]), 6)
            lon = round(float(row["INTPTLONG"]), 6)
        except (KeyError, ValueError):
            continue
        records.append(
            CityRecord(
                geoid=row["GEOID"],
                label=label,
                name=name,
                raw_name=row.get("NAME", ""),
                state=STATE_NAMES[state_abbr],
                state_abbr=state_abbr,
                lat=lat,
                lon=lon,
                lsad=row.get("LSAD", ""),
                funcstat=row.get("FUNCSTAT", ""),
            )
        )
    records.sort(key=lambda record: (record.state, record.name, record.geoid))
    return records


def write_city_list(records: list[CityRecord], json_path: Path, txt_path: Path) -> None:
    save_json_file(json_path, [record.__dict__ for record in records])
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    with txt_path.open("w", encoding="utf-8") as f:
        for record in records:
            f.write(record.label)
            f.write("\n")


def load_city_records(path: Path) -> list[CityRecord]:
    raw = load_json_file(path, [])
    if not isinstance(raw, list):
        raise RuntimeError(f"{path} does not contain a JSON list")
    return [CityRecord(**item) for item in raw]


def token_set(text: str) -> set[str]:
    tokens: set[str] = set()
    for token in re.findall(r"[a-z0-9]+", text.lower()):
        if len(token) < 3 or token in TOKEN_STOPWORDS:
            continue
        tokens.add(token)
    return tokens


def contains_state(blob: str, city: CityRecord) -> bool:
    lowered = blob.lower()
    if city.state.lower() in lowered:
        return True
    return bool(re.search(rf"(?<![A-Za-z]){re.escape(city.state_abbr)}(?![A-Za-z])", blob))


def contains_phrase(text: str, phrase: str) -> bool:
    words = re.findall(r"[a-z0-9]+", phrase.lower())
    if not words:
        return False
    pattern = r"(?<![a-z0-9])" + r"[^a-z0-9]+".join(re.escape(word) for word in words) + r"(?![a-z0-9])"
    return bool(re.search(pattern, text.lower()))


def find_other_state(title: str, city: CityRecord) -> str:
    for abbr, state_name in STATE_NAMES.items():
        if abbr == city.state_abbr:
            continue
        if state_name.lower() in {city.state.lower(), city.name.lower()}:
            continue
        if contains_phrase(title, state_name):
            return state_name
        if abbr in SAFE_STATE_ABBR_MATCHES and re.search(
            rf"(?<![A-Za-z]){re.escape(abbr)}(?![A-Za-z])",
            title,
            flags=re.IGNORECASE,
        ):
            return abbr
    return ""


def find_foreign_location_hint(title: str) -> str:
    for hint in sorted(FOREIGN_LOCATION_HINTS, key=len, reverse=True):
        if contains_phrase(title, hint):
            return hint
    return ""


def candidate_title_text(candidate: Any) -> str:
    return " ".join(
        value
        for value in [
            getattr(candidate, "verified_title", ""),
            getattr(candidate, "title", ""),
        ]
        if value
    )


def city_tokens_require_phrase(city: CityRecord, city_tokens: set[str]) -> bool:
    if not city_tokens:
        return True
    if len(city_tokens) == 1 and next(iter(city_tokens)) in STATE_NAME_VALUES:
        return True
    return False


def title_matches_city(candidate: Any, city: CityRecord) -> bool:
    title = candidate_title_text(candidate)
    lowered = title.lower()
    if not lowered:
        return False
    if city.label == "New York, New York":
        return any(hint in lowered for hint in NEW_YORK_CITY_HINTS)
    city_tokens = token_set(city.name)
    title_tokens = token_set(title)
    if contains_phrase(title, city.name):
        return True
    if city_tokens_require_phrase(city, city_tokens):
        return False
    return bool(city_tokens and city_tokens <= title_tokens)


def title_has_city_state(title: str, city: CityRecord) -> bool:
    return (
        contains_phrase(title, f"{city.name} {city.state}")
        or contains_phrase(title, f"{city.name} {city.state_abbr}")
        or contains_phrase(title, city.label)
    )


def candidate_blob(candidate: Any) -> str:
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


def score_city_candidate(candidate: Any, city: CityRecord, min_score: int) -> tuple[bool, int, list[str]]:
    import discover_youtube_cameras as ytd

    blob = candidate_blob(candidate)
    lowered = blob.lower()
    reasons: list[str] = []
    bad_hits = sorted(term for term in BAD_TERMS if term in lowered)
    if bad_hits:
        return False, -20, ["reject_terms:" + ",".join(bad_hits[:4])]

    if not title_matches_city(candidate, city):
        return False, 0, ["title_city_mismatch"]

    title = candidate_title_text(candidate)
    other_state = find_other_state(title, city)
    if other_state:
        return False, 0, [f"title_state_mismatch:{other_state}"]
    foreign_hint = find_foreign_location_hint(title)
    if foreign_hint:
        return False, 0, [f"title_foreign_location:{foreign_hint}"]

    ambiguous_city = len(city.name) <= 4 or city.name.lower() in COMMON_AMBIGUOUS_CITY_NAMES
    state_match = contains_state(blob, city)
    if ambiguous_city and not state_match:
        return False, 0, ["ambiguous_city_without_state"]
    if ambiguous_city and not title_has_city_state(title, city):
        return False, 0, ["ambiguous_city_without_title_state"]

    strong_hits = sorted(term for term in STRONG_CAMERA_TERMS if term in lowered)
    weather_hits = sorted(term for term in WEATHER_LOCATION_TERMS if term in lowered)
    if not strong_hits:
        return False, 0, ["no_camera_term"]

    scored = ytd.score_candidate(candidate)
    score = scored.score + 2
    reasons.extend(scored.reasons)
    reasons.append("city_match")
    if state_match:
        score += 2
        reasons.append("state_match")
    if weather_hits:
        score += min(3, len(weather_hits))
        reasons.append("location_terms:" + ",".join(weather_hits[:4]))
    if score < min_score:
        return False, score, [*reasons, f"low_score:{score}"]
    return True, score, reasons


def make_queries(city: CityRecord, templates: list[str]) -> list[str]:
    queries: list[str] = []
    seen: set[str] = set()
    for template in templates:
        query = template.format(label=city.label, city=city.name, state=city.state, abbr=city.state_abbr)
        key = re.sub(r"\s+", " ", query.strip().lower())
        if key and key not in seen:
            seen.add(key)
            queries.append(query.strip())
    return queries


def select_city_batch(
    records: list[CityRecord],
    processed_geoids: set[str],
    offset: int,
    limit: int,
    labels: list[str],
) -> list[CityRecord]:
    if labels:
        wanted = {label.lower() for label in labels}
        return [record for record in records if record.label.lower() in wanted]
    pending = [record for record in records if record.geoid not in processed_geoids]
    if offset:
        pending = pending[offset:]
    if limit:
        pending = pending[:limit]
    return pending


def append_streams(data_file: Path, streams: list[CityLocatedStream], limit_add: int) -> int:
    cameras = load_json_file(data_file, [])
    if not isinstance(cameras, list):
        raise RuntimeError(f"{data_file} does not contain a JSON array")
    existing_youtube = {str(cam.get("url") or "") for cam in cameras if cam.get("type") == "youtube"}
    max_id = max(int(cam.get("id") or 0) for cam in cameras) if cameras else 0
    added = 0
    for stream in streams:
        if limit_add and added >= limit_add:
            break
        if stream.video_id in existing_youtube:
            continue
        max_id += 1
        cameras.append(
            {
                "id": max_id,
                "name": stream.name,
                "lat": stream.lat,
                "lon": stream.lon,
                "url": stream.video_id,
                "type": "youtube",
                "state": stream.state,
                "county": stream.county,
                "direction": "",
                "source": "youtube",
            }
        )
        existing_youtube.add(stream.video_id)
        added += 1
    with data_file.open("w", encoding="utf-8") as f:
        json.dump(cameras, f, ensure_ascii=True)
    return added


def stream_to_report(stream: CityLocatedStream) -> dict[str, Any]:
    return {
        "video_id": stream.video_id,
        "name": stream.name,
        "lat": stream.lat,
        "lon": stream.lon,
        "state": stream.state,
        "county": stream.county,
        "city_label": stream.city_label,
        "query": stream.query,
        "title": stream.title,
        "channel": stream.channel,
        "score": stream.score,
        "reasons": stream.reasons,
    }


def validate_dataset(data_file: Path) -> dict[str, Any]:
    cameras = load_json_file(data_file, [])
    youtube = [cam for cam in cameras if cam.get("type") == "youtube"]
    return {
        "dataset_total": len(cameras),
        "type_counts": dict(sorted(Counter(cam.get("type") for cam in cameras).items())),
        "youtube_total": len(youtube),
        "duplicate_youtube_ids": sum(1 for count in Counter(cam.get("url") for cam in youtube).values() if count > 1),
    }


def search_city_batch(args: argparse.Namespace) -> int:
    import discover_youtube_cameras as ytd

    if not args.city_json.exists():
        records = build_city_records(args.scope)
        write_city_list(records, args.city_json, args.city_txt)
    records = load_city_records(args.city_json)
    checkpoint = load_json_file(args.checkpoint, {"processed_geoids": [], "accepted_video_ids": []}) if args.resume else {"processed_geoids": [], "accepted_video_ids": []}
    processed_geoids = set(checkpoint.get("processed_geoids", []))
    accepted_video_ids = set(checkpoint.get("accepted_video_ids", []))
    cameras = load_json_file(args.data, [])
    existing_youtube = {str(cam.get("url") or "") for cam in cameras if cam.get("type") == "youtube"}
    batch = select_city_batch(records, processed_geoids, args.offset, args.limit_cities, args.city_label)

    templates = args.query_template or DEFAULT_QUERY_TEMPLATES
    print(f"City records: {len(records)}")
    print(f"Batch cities: {len(batch)} resume={args.resume} processed={len(processed_geoids)}")
    print(f"Existing YouTube IDs: {len(existing_youtube)}")
    print(f"Query templates: {len(templates)}")

    raw_candidates: dict[str, tuple[Any, CityRecord, str]] = {}
    search_errors: list[dict[str, str]] = []
    content_rejected: list[dict[str, Any]] = []
    completed_geoids: list[str] = []
    retryable_geoids: list[str] = []

    for city_index, city in enumerate(batch, 1):
        city_new = 0
        city_had_error = False
        for query in make_queries(city, templates):
            try:
                found = ytd.harvest_query(query, args.max_pages, args.max_empty_pages, args.sleep)
            except Exception as exc:
                city_had_error = True
                search_errors.append({"city": city.label, "geoid": city.geoid, "query": query, "error": str(exc)})
                print(f"[{city_index}/{len(batch)}] ERROR {query}: {exc}")
                continue
            for candidate in found:
                if candidate.video_id in existing_youtube or candidate.video_id in accepted_video_ids:
                    continue
                if candidate.video_id in raw_candidates:
                    continue
                ok, score, reasons = score_city_candidate(candidate, city, args.min_score)
                if not ok:
                    content_rejected.append(
                        {
                            "video_id": candidate.video_id,
                            "title": candidate.title,
                            "channel": candidate.channel,
                            "city": city.label,
                            "query": query,
                            "score": score,
                            "failures": reasons,
                        }
                    )
                    continue
                candidate.score = score
                candidate.reasons = reasons
                raw_candidates[candidate.video_id] = (candidate, city, query)
                city_new += 1
            time.sleep(args.sleep)
        if city_had_error:
            retryable_geoids.append(city.geoid)
        else:
            completed_geoids.append(city.geoid)
        status = "retryable_error" if city_had_error else "complete"
        print(f"[{city_index}/{len(batch)}] {city.label}: candidates={city_new} status={status}")
        if args.resume and (city_index % args.checkpoint_every == 0):
            processed_geoids.update(completed_geoids)
            save_json_file(
                args.checkpoint,
                {"processed_geoids": sorted(processed_geoids), "accepted_video_ids": sorted(accepted_video_ids)},
            )

    live_streams: list[CityLocatedStream] = []
    live_rejected: list[dict[str, Any]] = []
    for index, (candidate, city, query) in enumerate(raw_candidates.values(), 1):
        try:
            verified = ytd.verify_live(candidate, args.verify_sleep)
        except Exception as exc:
            live_rejected.append(
                {
                    "video_id": candidate.video_id,
                    "title": candidate.title,
                    "channel": candidate.channel,
                    "city": city.label,
                    "failures": [f"verify_error:{exc}"],
                }
            )
            continue
        if not verified:
            live_rejected.append(
                {
                    "video_id": candidate.video_id,
                    "title": candidate.title,
                    "channel": candidate.channel,
                    "city": city.label,
                    "failures": ["not_live"],
                }
            )
            continue
        live_streams.append(
            CityLocatedStream(
                video_id=verified.video_id,
                name=ytd.clean_camera_name(verified),
                lat=city.lat,
                lon=city.lon,
                state=city.state,
                county=city.name,
                city_label=city.label,
                query=query,
                title=verified.verified_title or verified.title,
                channel=verified.verified_channel or verified.channel,
                score=verified.score,
                reasons=[*verified.reasons, "city_centroid_location"],
            )
        )
        if index % 25 == 0 or index == len(raw_candidates):
            print(f"Verified {index}/{len(raw_candidates)}; live={len(live_streams)}")

    live_streams.sort(key=lambda stream: (-stream.score, stream.state, stream.county, stream.name))
    added = append_streams(args.data, live_streams, args.limit_add) if args.apply else 0
    accepted_video_ids.update(stream.video_id for stream in live_streams)
    if args.resume:
        processed_geoids.update(completed_geoids)
        save_json_file(
            args.checkpoint,
            {"processed_geoids": sorted(processed_geoids), "accepted_video_ids": sorted(accepted_video_ids)},
        )

    validation = validate_dataset(args.data)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "applied": args.apply,
        "added": added,
        "summary": {
            "city_records": len(records),
            "batch_cities": len(batch),
            "queries_per_city": len(templates),
            "completed_cities": len(completed_geoids),
            "retryable_error_cities": len(set(retryable_geoids)),
            "search_errors": len(search_errors),
            "content_rejected": len(content_rejected),
            "candidate_count": len(raw_candidates),
            "verified_live": len(live_streams),
            **validation,
        },
        "accepted": [stream_to_report(stream) for stream in live_streams],
        "live_rejected": live_rejected,
        "content_rejected": content_rejected[:1000],
        "search_errors": search_errors,
    }
    save_json_file(args.report, report)
    print(
        "Summary: "
        f"added={added} candidates={len(raw_candidates)} live={len(live_streams)} "
        f"dataset_total={validation['dataset_total']} youtube={validation['youtube_total']}"
    )
    print(f"Report: {args.report}")
    if validation["duplicate_youtube_ids"]:
        print(f"Dataset validation failed: {validation}", file=sys.stderr)
        return 1
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--city-json", type=Path, default=CITY_JSON_FILE)
    parser.add_argument("--city-txt", type=Path, default=CITY_TXT_FILE)
    parser.add_argument("--report", type=Path, default=REPORT_FILE)
    parser.add_argument("--checkpoint", type=Path, default=CHECKPOINT_FILE)
    parser.add_argument("--scope", choices=["city", "legal", "all"], default="city")
    parser.add_argument("--build-city-list", action="store_true", help="download Census Gazetteer and write city list files")
    parser.add_argument("--apply", action="store_true", help="append accepted streams to the dataset")
    parser.add_argument("--resume", action="store_true", help="read/write checkpoint of processed city GEOIDs")
    parser.add_argument("--offset", type=int, default=0, help="skip this many unprocessed cities before searching")
    parser.add_argument("--limit-cities", type=int, default=0, help="maximum cities to search; 0 means all pending")
    parser.add_argument("--limit-add", type=int, default=0, help="maximum cameras to append; 0 means all accepted")
    parser.add_argument("--city-label", action="append", default=[], help="specific city label to search, e.g. 'Columbus, Ohio'")
    parser.add_argument("--query-template", action="append", default=[], help="custom query template using {label}, {city}, {state}, {abbr}")
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--max-empty-pages", type=int, default=1)
    parser.add_argument("--min-score", type=int, default=7)
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--verify-sleep", type=float, default=0.35)
    parser.add_argument("--checkpoint-every", type=int, default=25)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.build_city_list:
        records = build_city_records(args.scope)
        write_city_list(records, args.city_json, args.city_txt)
        print(f"Wrote {len(records)} city records")
        print(f"JSON: {args.city_json}")
        print(f"Text: {args.city_txt}")
        return 0
    return search_city_batch(args)


if __name__ == "__main__":
    raise SystemExit(main())
