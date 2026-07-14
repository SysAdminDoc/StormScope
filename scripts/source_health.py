#!/usr/bin/env python3
"""Versioned, redacted camera-ingestion source health."""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

try:
    from camera_data import atomic_write_json
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.camera_data import atomic_write_json


SOURCE_HEALTH_SCHEMA_VERSION = 1
SOURCE_HEALTH_STATUSES = ("fresh", "retained", "failed", "unknown")
SOURCE_HEALTH_FAILURE_CLASSES = frozenset(
    {
        "authentication_required",
        "confirmed_dead",
        "empty_snapshot",
        "incomplete_snapshot",
        "location_ambiguous",
        "placeholder",
        "provider_error",
        "rate_limited",
        "scheduled_offline",
        "transient_network",
        "unsupported_embed",
    }
)
MAX_PROVIDERS = 256
MAX_PROVIDER_NAME = 160
MAX_FAMILY_NAME = 64
MAX_CAMERA_SOURCES = 32


class SourceHealthError(ValueError):
    """Raised when the generated source-health contract is invalid."""


def _parse_timestamp(value: Any, *, nullable: bool) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > 40:
        raise SourceHealthError("source-health timestamps must be bounded ISO text")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SourceHealthError("source-health timestamps must be valid ISO text") from exc
    if parsed.tzinfo is None:
        raise SourceHealthError("source-health timestamps require a timezone")
    return value


def _count(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SourceHealthError(f"{label} must be a non-negative integer")
    return value


def validate_source_health(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != SOURCE_HEALTH_SCHEMA_VERSION:
        raise SourceHealthError("source-health schema version is unsupported")
    _parse_timestamp(value.get("generated_at"), nullable=False)
    providers = value.get("providers")
    if not isinstance(providers, list) or len(providers) > MAX_PROVIDERS:
        raise SourceHealthError("source-health providers must be a bounded list")
    names: set[str] = set()
    actual_totals = {status: 0 for status in SOURCE_HEALTH_STATUSES}
    for record in providers:
        if not isinstance(record, dict):
            raise SourceHealthError("source-health provider records must be objects")
        name = record.get("name")
        family = record.get("family")
        status = record.get("status")
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_PROVIDER_NAME:
            raise SourceHealthError("source-health provider names must be bounded text")
        if name in names:
            raise SourceHealthError(f"duplicate source-health provider {name!r}")
        names.add(name)
        if not isinstance(family, str) or not family.strip() or len(family) > MAX_FAMILY_NAME:
            raise SourceHealthError(f"source-health family is invalid for {name!r}")
        if status not in SOURCE_HEALTH_STATUSES:
            raise SourceHealthError(f"source-health status is invalid for {name!r}")
        actual_totals[status] += 1
        sources = record.get("camera_sources")
        if (
            not isinstance(sources, list)
            or len(sources) > MAX_CAMERA_SOURCES
            or sources != sorted(set(sources))
            or any(
                not isinstance(source, str)
                or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", source)
                for source in sources
            )
        ):
            raise SourceHealthError(f"camera_sources are invalid for {name!r}")
        source_count_maps = []
        for field in ("previous_camera_source_counts", "camera_source_counts"):
            counts = record.get(field)
            if (
                not isinstance(counts, dict)
                or set(counts) - set(sources)
                or any(
                    not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", source)
                    or isinstance(count, bool)
                    or not isinstance(count, int)
                    or count < 0
                    for source, count in counts.items()
                )
            ):
                raise SourceHealthError(f"{field} is invalid for {name!r}")
            source_count_maps.append(counts)
        if set(sources) != set(source_count_maps[0]) | set(source_count_maps[1]):
            raise SourceHealthError(f"camera_sources do not match source counts for {name!r}")
        _parse_timestamp(record.get("last_attempt_at"), nullable=True)
        _parse_timestamp(record.get("last_success_at"), nullable=True)
        for field in (
            "fetched_count", "retained_count", "replaced_count", "previous_count", "final_count"
        ):
            _count(record.get(field), f"{name}.{field}")
        coverage_delta = record.get("coverage_delta")
        if isinstance(coverage_delta, bool) or not isinstance(coverage_delta, int):
            raise SourceHealthError(f"{name}.coverage_delta must be an integer")
        if coverage_delta != record["final_count"] - record["previous_count"]:
            raise SourceHealthError(f"{name}.coverage_delta does not match source counts")
        if sum(source_count_maps[0].values()) != record["previous_count"]:
            raise SourceHealthError(f"{name}.previous camera-source counts do not match previous_count")
        if sum(source_count_maps[1].values()) != record["final_count"]:
            raise SourceHealthError(f"{name}.camera-source counts do not match final_count")
        coverage_percent = record.get("coverage_delta_percent")
        if coverage_percent is not None and (
            isinstance(coverage_percent, bool) or not isinstance(coverage_percent, (int, float))
        ):
            raise SourceHealthError(f"{name}.coverage_delta_percent must be numeric or null")
        failure_class = record.get("failure_class")
        if failure_class is not None and failure_class not in SOURCE_HEALTH_FAILURE_CLASSES:
            raise SourceHealthError(f"source-health failure class is invalid for {name!r}")
        if status == "fresh" and failure_class is not None:
            raise SourceHealthError(f"fresh source {name!r} cannot have a failure class")
        if status in {"retained", "failed"} and failure_class is None:
            raise SourceHealthError(f"unhealthy source {name!r} requires a failure class")
        expected_percent = _coverage_percent(record["previous_count"], coverage_delta)
        if coverage_percent != expected_percent:
            raise SourceHealthError(f"{name}.coverage_delta_percent does not match source counts")
        if record["retained_count"] > record["final_count"]:
            raise SourceHealthError(f"{name}.retained_count exceeds final_count")
        if record["replaced_count"] > record["previous_count"]:
            raise SourceHealthError(f"{name}.replaced_count exceeds previous_count")
        if status == "retained" and (
            not record["final_count"] or record["retained_count"] != record["final_count"]
        ):
            raise SourceHealthError(f"retained source {name!r} must identify all retained rows")
        if status == "failed" and (record["final_count"] or record["retained_count"]):
            raise SourceHealthError(f"failed source {name!r} cannot retain camera rows")
        if status == "unknown" and (
            record["last_attempt_at"] is not None
            or record["last_success_at"] is not None
            or record["fetched_count"]
            or record["retained_count"]
            or record["replaced_count"]
            or failure_class is not None
        ):
            raise SourceHealthError(f"unknown source {name!r} cannot imply refresh history")
    if [record["name"] for record in providers] != sorted(names, key=str.casefold):
        raise SourceHealthError("source-health providers must be sorted by name")
    totals = value.get("totals")
    if not isinstance(totals, dict):
        raise SourceHealthError("source-health totals are required")
    for status, expected in actual_totals.items():
        if totals.get(status) != expected:
            raise SourceHealthError(f"source-health {status} total does not match providers")
    for field in ("cameras", "retained_cameras"):
        _count(totals.get(field), f"totals.{field}")
    if totals.get("cameras") != sum(record["final_count"] for record in providers):
        raise SourceHealthError("source-health camera total does not match providers")
    if totals.get("retained_cameras") != sum(record["retained_count"] for record in providers):
        raise SourceHealthError("source-health retained camera total does not match providers")
    if totals.get("coverage_delta") != sum(record["coverage_delta"] for record in providers):
        raise SourceHealthError("source-health coverage delta does not match providers")
    return value


def load_source_health(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SourceHealthError(f"unable to load source-health artifact: {path}") from exc
    return validate_source_health(value)


def write_source_health(path: Path, value: dict[str, Any]) -> None:
    validate_source_health(value)
    atomic_write_json(path, value, indent=2)


def classify_failure(error: Any) -> str:
    """Return only a bounded category; raw provider errors never enter the artifact."""
    text = str(error or "").casefold()
    if "returned no cameras" in text:
        return "empty_snapshot"
    if any(token in text for token in ("truncated", "incomplete", "missing players", "inventory is missing")):
        return "incomplete_snapshot"
    if "outside the" in text and "live window" in text:
        return "scheduled_offline"
    if "rate_limited" in text or "rate limit" in text or "http 429" in text:
        return "rate_limited"
    if "authentication_required" in text or "unauthorized" in text or "forbidden" in text:
        return "authentication_required"
    if "confirmed_dead" in text or "http_404" in text or "http 404" in text:
        return "confirmed_dead"
    if "location_ambiguous" in text or "coordinates" in text:
        return "location_ambiguous"
    if "unsupported_embed" in text or "unsupported" in text:
        return "unsupported_embed"
    if "placeholder" in text or "stale_provider_timestamp" in text:
        return "placeholder"
    if any(token in text for token in ("transient_network", "timed out", "timeout", "connection", "dns", "http 5")):
        return "transient_network"
    return "provider_error"


def _adapter_metadata(adapters: Iterable[Any]) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for adapter in adapters:
        name = str(adapter.name).strip()
        family = str(adapter.family).strip()
        if name in metadata:
            raise SourceHealthError(f"duplicate adapter metadata for {name!r}")
        metadata[name] = family
    return metadata


def _rows_for(cameras: list[dict[str, Any]], provider_name: str) -> list[dict[str, Any]]:
    return [
        camera for camera in cameras
        if camera.get("ingestion_source") == provider_name
        or (not camera.get("ingestion_source") and camera.get("provider") == provider_name)
    ]


def _camera_source_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(
        str(camera.get("source") or "").strip().casefold()
        for camera in rows
        if camera.get("source")
    )
    return dict(sorted(counts.items()))


def _coverage_percent(previous_count: int, coverage_delta: int) -> float | None:
    return round(coverage_delta * 100 / previous_count, 2) if previous_count else None


def _totals(records: list[dict[str, Any]]) -> dict[str, int]:
    totals = {status: 0 for status in SOURCE_HEALTH_STATUSES}
    for record in records:
        totals[record["status"]] += 1
    totals["cameras"] = sum(record["final_count"] for record in records)
    totals["retained_cameras"] = sum(record["retained_count"] for record in records)
    totals["coverage_delta"] = sum(record["coverage_delta"] for record in records)
    return totals


def _document(generated_at: str, records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(records, key=lambda record: record["name"].casefold())
    document = {
        "schema_version": SOURCE_HEALTH_SCHEMA_VERSION,
        "generated_at": generated_at,
        "providers": ordered,
        "totals": _totals(ordered),
    }
    return validate_source_health(document)


def seed_source_health(
    cameras: list[dict[str, Any]], adapters: Iterable[Any], generated_at: str
) -> dict[str, Any]:
    """Create an explicit baseline when older corpora predate attempt history."""
    _parse_timestamp(generated_at, nullable=False)
    records = []
    for name, family in _adapter_metadata(adapters).items():
        rows = _rows_for(cameras, name)
        source_counts = _camera_source_counts(rows)
        records.append(
            {
                "name": name,
                "family": family,
                "status": "unknown",
                "camera_sources": list(source_counts),
                "previous_camera_source_counts": source_counts,
                "camera_source_counts": source_counts,
                "last_attempt_at": None,
                "last_success_at": None,
                "fetched_count": 0,
                "retained_count": 0,
                "replaced_count": 0,
                "previous_count": len(rows),
                "final_count": len(rows),
                "coverage_delta": 0,
                "coverage_delta_percent": 0.0 if rows else None,
                "failure_class": None,
            }
        )
    return _document(generated_at, records)


def update_source_health(
    previous: dict[str, Any],
    existing: list[dict[str, Any]],
    merged: list[dict[str, Any]],
    results: Iterable[Any],
    adapters: Iterable[Any],
    accepted_names: set[str],
    attempted_at: str,
) -> dict[str, Any]:
    """Merge one selected adapter run into prior immutable source history."""
    validate_source_health(previous)
    _parse_timestamp(attempted_at, nullable=False)
    families = _adapter_metadata(adapters)
    records = {record["name"]: dict(record) for record in previous["providers"]}
    for result in results:
        name = result.name
        previous_rows = _rows_for(existing, name)
        final_rows = _rows_for(merged, name)
        accepted = name in accepted_names
        prior = records.get(name, {})
        coverage_delta = len(final_rows) - len(previous_rows)
        previous_source_counts = _camera_source_counts(previous_rows)
        final_source_counts = _camera_source_counts(final_rows)
        sources = sorted(set(previous_source_counts) | set(final_source_counts))
        if accepted:
            status = "fresh"
            failure_class = None
            last_success = attempted_at
        else:
            status = "retained" if final_rows else "failed"
            failure_class = classify_failure(result.error) if result.error else "incomplete_snapshot"
            last_success = prior.get("last_success_at")
        records[name] = {
            "name": name,
            "family": families.get(name, prior.get("family", "first-party-feed")),
            "status": status,
            "camera_sources": sources,
            "previous_camera_source_counts": previous_source_counts,
            "camera_source_counts": final_source_counts,
            "last_attempt_at": attempted_at,
            "last_success_at": last_success,
            "fetched_count": len(result.cameras),
            "retained_count": 0 if accepted else len(final_rows),
            "replaced_count": len(previous_rows) if accepted else 0,
            "previous_count": len(previous_rows),
            "final_count": len(final_rows),
            "coverage_delta": coverage_delta,
            "coverage_delta_percent": _coverage_percent(len(previous_rows), coverage_delta),
            "failure_class": failure_class,
        }
    return _document(attempted_at, records.values())
