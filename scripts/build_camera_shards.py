#!/usr/bin/env python3
"""Build deterministic, bounded camera shards and a compact manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

try:
    from camera_data import CAMERA_SCHEMA_VERSION, atomic_write_json, load_camera_data
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.camera_data import CAMERA_SCHEMA_VERSION, atomic_write_json, load_camera_data


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "cameras.json"
DEFAULT_INDEX = ROOT / "data" / "cameras.index.json"
DEFAULT_SHARD_DIR = ROOT / "data" / "camera-shards"
DEFAULT_SHARD_SIZE = 750
MAX_SHARD_SIZE = 1000
INDEX_VERSION = 1


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def camera_bbox(cameras: list[dict[str, Any]]) -> list[float]:
    lats = [float(camera["lat"]) for camera in cameras]
    lons = [float(camera["lon"]) for camera in cameras]
    return [round(min(lons), 6), round(min(lats), 6), round(max(lons), 6), round(max(lats), 6)]


def build_shards(
    data_file: Path,
    index_file: Path,
    shard_dir: Path,
    *,
    shard_size: int = DEFAULT_SHARD_SIZE,
) -> dict[str, Any]:
    if not 1 <= shard_size <= MAX_SHARD_SIZE:
        raise ValueError(f"shard_size must be between 1 and {MAX_SHARD_SIZE}")
    cameras = sorted(load_camera_data(data_file), key=lambda camera: int(camera["id"]))
    ids = [int(camera["id"]) for camera in cameras]
    if len(ids) != len(set(ids)):
        raise ValueError("camera IDs must be unique before sharding")

    shard_dir.mkdir(parents=True, exist_ok=True)
    descriptors = []
    expected_files: set[Path] = set()
    for offset in range(0, len(cameras), shard_size):
        shard = cameras[offset: offset + shard_size]
        shard_number = offset // shard_size + 1
        shard_id = f"{shard_number:04d}"
        shard_file = shard_dir / f"{shard_id}.json"
        expected_files.add(shard_file.resolve())
        atomic_write_json(shard_file, shard, indent=None)
        relative_path = os.path.relpath(shard_file, index_file.parent).replace("\\", "/")
        descriptors.append(
            {
                "id": shard_id,
                "path": relative_path,
                "count": len(shard),
                "first_id": int(shard[0]["id"]),
                "last_id": int(shard[-1]["id"]),
                "bbox": camera_bbox(shard),
                "sha256": hashlib.sha256(canonical_json_bytes(shard)).hexdigest(),
            }
        )

    manifest = {
        "index_version": INDEX_VERSION,
        "camera_schema_version": CAMERA_SCHEMA_VERSION,
        "total": len(cameras),
        "shard_size": shard_size,
        "dataset_sha256": hashlib.sha256(canonical_json_bytes(cameras)).hexdigest(),
        "shards": descriptors,
    }
    atomic_write_json(index_file, manifest, indent=None)

    for stale_file in shard_dir.glob("*.json"):
        if stale_file.resolve() not in expected_files:
            stale_file.unlink()
    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--shard-dir", type=Path, default=DEFAULT_SHARD_DIR)
    parser.add_argument("--shard-size", type=int, default=DEFAULT_SHARD_SIZE)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = build_shards(args.data, args.index, args.shard_dir, shard_size=args.shard_size)
    print(
        f"Wrote {manifest['total']:,} cameras to {len(manifest['shards'])} "
        f"bounded shards (maximum {manifest['shard_size']} rows)"
    )
    print(f"Index: {args.index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
