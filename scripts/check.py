#!/usr/bin/env python3
"""Run StormScope's complete local regression gate."""

from __future__ import annotations

import subprocess
import sys
from collections import Counter
from pathlib import Path

try:
    from camera_data import CAMERA_SCHEMA_VERSION, load_camera_data, validate_camera_data
except ModuleNotFoundError:  # pragma: no cover - package import
    from scripts.camera_data import CAMERA_SCHEMA_VERSION, load_camera_data, validate_camera_data

try:
    from source_health import load_source_health
except ModuleNotFoundError:  # pragma: no cover - package import
    from scripts.source_health import load_source_health


ROOT = Path(__file__).resolve().parent.parent


def run(*command: str) -> None:
    print(f"\n> {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> int:
    node_tests = sorted(str(path.relative_to(ROOT)) for path in (ROOT / "tests").glob("*.test.js"))
    run(sys.executable, "scripts/preflight.py")
    run(sys.executable, "scripts/build_radar_config.py", "--check-csp", "index.html")
    run(sys.executable, "scripts/package_release.py", "--check")
    run(sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v")
    run(sys.executable, "-m", "ruff", "check", "scripts", "tests")
    run(sys.executable, "scripts/vendor_dependencies.py")
    run(sys.executable, "scripts/dependency_audit.py")
    run("node", "--check", "js/app.js")
    run("node", "--check", "sw.js")
    if node_tests:
        run("node", "--test", *node_tests)
    run("node", "tests/browser-smoke.js")
    run("node", "tests/cross-browser-smoke.js")

    cameras = load_camera_data(ROOT / "data" / "cameras.json")
    validate_camera_data(cameras)
    source_health = load_source_health(ROOT / "data" / "source-health.json")
    source_counts = Counter(camera.get("ingestion_source") or camera.get("provider") for camera in cameras)
    for record in source_health["providers"]:
        if record["final_count"] != source_counts[record["name"]]:
            raise RuntimeError(f"source-health camera count is stale for {record['name']!r}")
    print(f"\nValidated {len(cameras):,} cameras against schema v{CAMERA_SCHEMA_VERSION}.")
    print(f"Validated source-health schema v{source_health['schema_version']} for "
          f"{len(source_health['providers'])} ingestion sources.")
    print("All local regression gates passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
