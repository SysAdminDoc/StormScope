#!/usr/bin/env python3
"""Versioned validation and transactional persistence for camera data."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import shutil
import tempfile
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, TypeVar
from urllib.parse import urlsplit, urlunsplit


CAMERA_SCHEMA_VERSION = 2
ALLOWED_TYPES = frozenset({"embed", "hls", "image", "mjpeg", "youtube"})
ALLOWED_SOURCES = frozenset(
    {"dot", "earthcam", "ipcamlive", "livebeaches", "nps", "youtube"}
)
ALLOWED_STATUSES = frozenset({"Active", "Offline", "Unknown"})
ALLOWED_HEALTH = frozenset({"unknown", "healthy", "degraded", "offline"})
ALLOWED_FAILURE_CLASSES = frozenset(
    {"transient", "provider_error", "confirmed_offline", "unsupported", "inactive"}
)
EMBED_HOST_SUFFIXES = frozenset(
    {
        "abbeyroad.com",
        "earthcam.com",
        "esbnyc.com",
        "ipcamlive.com",
        "myearthcam.com",
        "nps.gov",
        "player.brownrice.com",
    }
)
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
REQUIRED_FIELDS = frozenset(
    {
        "id",
        "name",
        "lat",
        "lon",
        "url",
        "type",
        "source",
        "last_verified",
        "health",
        "failure_class",
        "source_url",
        "refresh_cadence_seconds",
    }
)

T = TypeVar("T")


class CameraDataError(RuntimeError):
    """Base error for the camera-data contract."""


class CameraDataValidationError(CameraDataError):
    """Raised when camera data violates the versioned contract."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        preview = "; ".join(errors[:10])
        suffix = f"; and {len(errors) - 10} more" if len(errors) > 10 else ""
        super().__init__(f"camera schema v{CAMERA_SCHEMA_VERSION} validation failed: {preview}{suffix}")


class CameraDataLockTimeout(CameraDataError):
    """Raised when another writer keeps the dataset lock beyond the timeout."""


@dataclass(frozen=True)
class CameraDataSummary:
    schema_version: int
    total: int
    source_counts: dict[str, int]
    type_counts: dict[str, int]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_source_url(camera_type: str, value: str) -> str | None:
    if camera_type == "youtube" and VIDEO_ID_RE.fullmatch(value):
        return f"https://www.youtube.com/watch?v={value}"
    if value.startswith("https://"):
        return value
    return None


def healthy_metadata(source_url: str | None, *, verified_at: str | None = None) -> dict[str, Any]:
    return {
        "last_verified": verified_at or utc_now_iso(),
        "health": "healthy",
        "failure_class": None,
        "source_url": source_url,
        "refresh_cadence_seconds": None,
    }


def unknown_metadata(source_url: str | None) -> dict[str, Any]:
    return {
        "last_verified": None,
        "health": "unknown",
        "failure_class": None,
        "source_url": source_url,
        "refresh_cadence_seconds": None,
    }


def load_json(path: Path, default: T | None = None) -> Any | T:
    if not path.exists():
        return copy.deepcopy(default)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _normalized_url(value: str) -> str:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").lower()
    netloc = hostname
    try:
        port = parsed.port
    except ValueError:
        return value
    if port:
        netloc = f"{netloc}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path, parsed.query, ""))


def feed_identity(camera: dict[str, Any]) -> tuple[str, str]:
    camera_type = str(camera.get("type") or "")
    value = str(camera.get("url") or "")
    if camera_type == "youtube":
        return camera_type, value
    return camera_type, _normalized_url(value)


def is_allowed_embed_host(hostname: str | None) -> bool:
    host = (hostname or "").lower().rstrip(".")
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in EMBED_HOST_SUFFIXES)


def validate_camera_data(
    cameras: Any,
    *,
    minimum_total: int = 0,
    minimum_source_counts: dict[str, int] | None = None,
) -> CameraDataSummary:
    errors: list[str] = []
    if not isinstance(cameras, list):
        raise CameraDataValidationError(["root must be a JSON array"])

    ids: set[int] = set()
    feeds: dict[tuple[str, str], int] = {}
    source_counts: Counter[str] = Counter()
    type_counts: Counter[str] = Counter()

    for index, camera in enumerate(cameras):
        label = f"row {index}"
        if not isinstance(camera, dict):
            errors.append(f"{label}: must be an object")
            continue
        missing = sorted(REQUIRED_FIELDS.difference(camera))
        if missing:
            errors.append(f"{label}: missing {', '.join(missing)}")

        camera_id = camera.get("id")
        if isinstance(camera_id, bool) or not isinstance(camera_id, int) or camera_id <= 0:
            errors.append(f"{label}: id must be a positive integer")
        elif camera_id in ids:
            errors.append(f"{label}: duplicate id {camera_id}")
        else:
            ids.add(camera_id)

        name = camera.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{label}: name must be non-empty text")
        elif name != name.strip():
            errors.append(f"{label}: name has surrounding whitespace")

        for field, low, high in (("lat", -90.0, 90.0), ("lon", -180.0, 180.0)):
            value = camera.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append(f"{label}: {field} must be numeric")
            elif not math.isfinite(float(value)) or not low <= float(value) <= high:
                errors.append(f"{label}: {field} is outside {low:g}..{high:g}")

        camera_type = camera.get("type")
        if camera_type not in ALLOWED_TYPES:
            errors.append(f"{label}: unsupported type {camera_type!r}")
        else:
            type_counts[camera_type] += 1

        source = camera.get("source")
        if source not in ALLOWED_SOURCES:
            errors.append(f"{label}: unsupported source {source!r}")
        else:
            source_counts[source] += 1

        for field in ("state", "county", "direction"):
            if field in camera and not isinstance(camera[field], str):
                errors.append(f"{label}: {field} must be text")

        provider = camera.get("provider")
        if provider is not None and (not isinstance(provider, str) or not provider.strip()):
            errors.append(f"{label}: provider must be non-empty text")

        status = camera.get("status")
        if status not in (None, ""):
            if not isinstance(status, str) or status not in ALLOWED_STATUSES:
                errors.append(f"{label}: unsupported status {status!r}")

        last_verified = camera.get("last_verified")
        if last_verified is not None:
            if not isinstance(last_verified, str):
                errors.append(f"{label}: last_verified must be an ISO timestamp or null")
            else:
                try:
                    parsed_verified = datetime.fromisoformat(last_verified.replace("Z", "+00:00"))
                    if parsed_verified.tzinfo is None:
                        raise ValueError("timezone is required")
                except ValueError:
                    errors.append(f"{label}: last_verified must be a timezone-aware ISO timestamp")

        health = camera.get("health")
        if health not in ALLOWED_HEALTH:
            errors.append(f"{label}: unsupported health {health!r}")
        failure_class = camera.get("failure_class")
        if failure_class is not None and failure_class not in ALLOWED_FAILURE_CLASSES:
            errors.append(f"{label}: unsupported failure_class {failure_class!r}")
        if health == "healthy" and failure_class is not None:
            errors.append(f"{label}: healthy rows cannot have a failure_class")
        if health == "healthy" and last_verified is None:
            errors.append(f"{label}: healthy rows require last_verified")
        if health == "offline" and failure_class not in {"confirmed_offline", "unsupported", "inactive"}:
            errors.append(f"{label}: offline rows require a permanent failure_class")
        if failure_class in {"confirmed_offline", "unsupported", "inactive"} and health != "offline":
            errors.append(f"{label}: permanent failures require offline health")
        if failure_class in {"transient", "provider_error"} and health not in {"unknown", "degraded"}:
            errors.append(f"{label}: transient failures cannot mark a row offline or healthy")

        cadence = camera.get("refresh_cadence_seconds")
        if cadence is not None and (
            isinstance(cadence, bool) or not isinstance(cadence, int) or cadence <= 0
        ):
            errors.append(f"{label}: refresh_cadence_seconds must be a positive integer or null")

        source_url = camera.get("source_url")
        if source_url is not None:
            if not isinstance(source_url, str):
                errors.append(f"{label}: source_url must be an https URL or null")
            else:
                try:
                    parsed_source = urlsplit(source_url)
                    _ = parsed_source.port
                except ValueError as exc:
                    errors.append(f"{label}: invalid source_url ({exc})")
                else:
                    if parsed_source.scheme != "https" or not parsed_source.hostname:
                        errors.append(f"{label}: source_url must use https")
        if health == "healthy" and source_url is None:
            errors.append(f"{label}: healthy rows require source_url")

        url = camera.get("url")
        if not isinstance(url, str) or not url:
            errors.append(f"{label}: url must be non-empty text")
            continue
        if url != url.strip():
            errors.append(f"{label}: url has surrounding whitespace")
            continue
        if camera_type == "youtube":
            if not VIDEO_ID_RE.fullmatch(url):
                errors.append(f"{label}: YouTube url must be an 11-character video id")
        else:
            parsed = urlsplit(url)
            try:
                _ = parsed.port
            except ValueError as exc:
                errors.append(f"{label}: invalid media URL ({exc})")
                parsed = None
            if parsed is None:
                pass
            elif parsed.scheme != "https" or not parsed.hostname:
                errors.append(f"{label}: media URL must use https")
            elif camera_type == "embed" and not is_allowed_embed_host(parsed.hostname):
                errors.append(f"{label}: embed host {parsed.hostname!r} is not allowed")

        identity = feed_identity(camera)
        if identity in feeds:
            errors.append(f"{label}: duplicate feed also used by row {feeds[identity]}")
        else:
            feeds[identity] = index

    if len(cameras) < minimum_total:
        errors.append(f"dataset has {len(cameras)} rows; minimum is {minimum_total}")
    for source, required in (minimum_source_counts or {}).items():
        actual = source_counts.get(source, 0)
        if actual < required:
            errors.append(f"source {source!r} has {actual} rows; minimum is {required}")
    if errors:
        raise CameraDataValidationError(errors)
    return CameraDataSummary(
        schema_version=CAMERA_SCHEMA_VERSION,
        total=len(cameras),
        source_counts=dict(sorted(source_counts.items())),
        type_counts=dict(sorted(type_counts.items())),
    )


def load_camera_data(path: Path, *, validate: bool = True) -> list[dict[str, Any]]:
    cameras = load_json(path, [])
    if validate:
        validate_camera_data(cameras)
    return cameras


def _lock_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.lock")


@contextmanager
def dataset_lock(
    path: Path,
    *,
    timeout: float = 10.0,
    poll_interval: float = 0.05,
    stale_after: float = 900.0,
) -> Iterator[None]:
    lock_path = _lock_path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(descriptor, "w", encoding="ascii") as handle:
                handle.write(f"pid={os.getpid()} created={time.time():.6f}\n")
                handle.flush()
                os.fsync(handle.fileno())
            break
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > stale_after:
                    lock_path.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise CameraDataLockTimeout(f"timed out waiting for {lock_path}")
            time.sleep(poll_interval)
    try:
        yield
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _atomic_write_json_unlocked(path: Path, value: Any, *, indent: int | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=True, indent=indent)
            if indent is not None:
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
        _fsync_directory(path.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def atomic_write_json(path: Path, value: Any, *, indent: int | None = 2) -> None:
    with dataset_lock(path):
        _atomic_write_json_unlocked(path, value, indent=indent)


def update_json(
    path: Path,
    default: T,
    mutator: Callable[[Any], T],
    *,
    indent: int | None = 2,
) -> T:
    """Atomically read, mutate, and replace a generic JSON document."""
    with dataset_lock(path):
        current = load_json(path, default)
        working = copy.deepcopy(current)
        result = mutator(working)
        _atomic_write_json_unlocked(path, working, indent=indent)
    return result


def _backup_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.bak")


def _write_backup_unlocked(path: Path) -> Path | None:
    if not path.exists():
        return None
    backup = _backup_path(path)
    temporary = backup.with_name(f".{backup.name}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(path, temporary)
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, backup)
        _fsync_directory(path.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return backup


def save_camera_data(
    path: Path,
    cameras: list[dict[str, Any]],
    *,
    minimum_total: int = 0,
    minimum_source_counts: dict[str, int] | None = None,
    create_backup: bool = True,
) -> CameraDataSummary:
    summary = validate_camera_data(
        cameras,
        minimum_total=minimum_total,
        minimum_source_counts=minimum_source_counts,
    )
    with dataset_lock(path):
        if create_backup:
            _write_backup_unlocked(path)
        _atomic_write_json_unlocked(path, cameras, indent=None)
    return summary


def update_camera_data(
    path: Path,
    mutator: Callable[[list[dict[str, Any]]], T],
    *,
    minimum_total: int = 0,
    minimum_source_counts: dict[str, int] | None = None,
    create_backup: bool = True,
) -> tuple[T, CameraDataSummary]:
    with dataset_lock(path):
        cameras = load_json(path, [])
        validate_camera_data(cameras)
        working = copy.deepcopy(cameras)
        result = mutator(working)
        summary = validate_camera_data(
            working,
            minimum_total=minimum_total,
            minimum_source_counts=minimum_source_counts,
        )
        if create_backup:
            _write_backup_unlocked(path)
        _atomic_write_json_unlocked(path, working, indent=None)
    return result, summary


def restore_camera_data(path: Path) -> CameraDataSummary:
    backup = _backup_path(path)
    with dataset_lock(path):
        cameras = load_json(backup, None)
        if cameras is None:
            raise CameraDataError(f"no rollback dataset exists at {backup}")
        summary = validate_camera_data(cameras)
        _atomic_write_json_unlocked(path, cameras, indent=None)
    return summary
