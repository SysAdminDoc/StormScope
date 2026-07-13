#!/usr/bin/env python3
"""Build and verify StormScope's deterministic source release ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from build_radar_config import RadarConfigError, load_config, render_javascript, validate_html_csp
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.build_radar_config import RadarConfigError, load_config, render_javascript, validate_html_csp


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MANIFEST_NAME = "release-manifest.json"
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
USER_AGENT_FILES = (
    "scripts/discover_city_livestreams.py",
    "scripts/discover_earthcam_feeds.py",
    "scripts/discover_livebeaches_feeds.py",
    "scripts/discover_youtube_cameras.py",
    "scripts/fetch_cameras.py",
    "scripts/vendor_dependencies.py",
)


class PackagingError(RuntimeError):
    """Release input or output violates the deterministic packaging contract."""


def run_git(*arguments: str, check: bool = True) -> str:
    completed = subprocess.run(
        ["git", *arguments], cwd=ROOT, check=check, capture_output=True, text=True, encoding="utf-8"
    )
    return completed.stdout.strip()


def current_version() -> str:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = str(package.get("version") or "")
    if not VERSION_PATTERN.fullmatch(version):
        raise PackagingError(f"package.json has an invalid release version: {version!r}")
    return version


def first_match(path: str, pattern: str) -> str | None:
    match = re.search(pattern, (ROOT / path).read_text(encoding="utf-8"), re.MULTILINE)
    return match.group(1) if match else None


def validate_version_surfaces(version: str) -> None:
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    surfaces: dict[str, str | None] = {
        "package.json": current_version(),
        "package-lock.json": str(lock.get("version") or ""),
        "package-lock.json root package": str(lock.get("packages", {}).get("", {}).get("version") or ""),
        "js/app.js": first_match("js/app.js", r"APP_VERSION\s*=\s*['\"]([^'\"]+)"),
        "README.md badge": first_match("README.md", r"version-([0-9]+\.[0-9]+\.[0-9]+)-blue"),
        "CHANGELOG.md latest": first_match("CHANGELOG.md", r"^## v([0-9]+\.[0-9]+\.[0-9]+)\s+-"),
    }
    mismatches = [f"{name}={actual or 'missing'}" for name, actual in surfaces.items() if actual != version]
    for relative in USER_AGENT_FILES:
        values = set(re.findall(r"StormScope/([0-9]+\.[0-9]+\.[0-9]+)", (ROOT / relative).read_text(encoding="utf-8")))
        if values != {version}:
            mismatches.append(f"{relative}={','.join(sorted(values)) or 'missing'}")
    if mismatches:
        raise PackagingError("Version surfaces do not match " + version + ": " + "; ".join(mismatches))


def validate_radar_build_config() -> None:
    config = load_config(ROOT / "config" / "radar-provider.json")
    generated = (ROOT / "js" / "radar-build-config.js").read_text(encoding="utf-8")
    if generated != render_javascript(config):
        raise PackagingError("js/radar-build-config.js is stale; run scripts/build_radar_config.py")
    validate_html_csp((ROOT / "index.html").read_text(encoding="utf-8"), config)


def validate_repository_state(version: str) -> str:
    status = run_git("status", "--porcelain", "--untracked-files=normal")
    if status:
        raise PackagingError("Tracked or untracked changes must be committed before packaging:\n" + status)
    head = run_git("rev-parse", "HEAD")
    tag = f"v{version}"
    tagged = run_git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", check=False)
    if tagged and tagged != head:
        raise PackagingError(f"Stale tag {tag} points to {tagged}, not HEAD {head}.")
    latest = run_git("tag", "--list", "v[0-9]*", "--sort=-version:refname").splitlines()
    if latest:
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", latest[0])
        if match and tuple(map(int, match.groups())) > tuple(map(int, version.split("."))):
            raise PackagingError(f"Latest tag {latest[0]} is newer than package version v{version}.")
    return head


def tracked_files() -> list[str]:
    paths = [path for path in run_git("ls-files").splitlines() if path]
    if not paths:
        raise PackagingError("Git returned no tracked release files.")
    unsafe = [path for path in paths if PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts]
    if unsafe:
        raise PackagingError("Unsafe tracked paths: " + ", ".join(unsafe))
    return sorted(paths)


def tracked_modes() -> dict[str, int]:
    modes: dict[str, int] = {}
    for line in run_git("ls-files", "--stage").splitlines():
        metadata, path = line.split("\t", 1)
        git_mode = metadata.split(" ", 1)[0]
        modes[path] = 0o755 if git_mode == "100755" else 0o644
    return modes


def release_manifest(version: str, commit: str, paths: list[str]) -> dict[str, Any]:
    return {
        "schema": 1,
        "project": "StormScope",
        "version": version,
        "commit": commit,
        "files": [
            {
                "path": path,
                "bytes": (ROOT / path).stat().st_size,
                "sha256": hashlib.sha256((ROOT / path).read_bytes()).hexdigest(),
            }
            for path in paths
        ],
    }


def manifest_bytes(manifest: dict[str, Any]) -> bytes:
    return (json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")


def zip_info(path: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (mode & 0xFFFF) << 16
    return info


def write_archive(output: Path, version: str, commit: str, paths: list[str]) -> dict[str, Any]:
    modes = tracked_modes()
    manifest = release_manifest(version, commit, paths)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.comment = f"StormScope v{version}".encode("ascii")
        for path in paths:
            archive.writestr(zip_info(path, modes.get(path, 0o644)), (ROOT / path).read_bytes(), compresslevel=9)
        archive.writestr(zip_info(MANIFEST_NAME), manifest_bytes(manifest), compresslevel=9)
    return manifest


def validate_archive(output: Path, manifest: dict[str, Any]) -> str:
    expected_paths = [item["path"] for item in manifest["files"]] + [MANIFEST_NAME]
    with zipfile.ZipFile(output, "r") as archive:
        names = archive.namelist()
        if names != expected_paths or len(names) != len(set(names)):
            raise PackagingError("Archive entries are missing, duplicated, or out of deterministic order.")
        for info in archive.infolist():
            if info.date_time != FIXED_ZIP_TIME:
                raise PackagingError(f"Archive timestamp drifted for {info.filename}.")
        embedded = json.loads(archive.read(MANIFEST_NAME))
        if embedded != manifest:
            raise PackagingError("Embedded release manifest does not match the build manifest.")
        for item in manifest["files"]:
            payload = archive.read(item["path"])
            if len(payload) != item["bytes"] or hashlib.sha256(payload).hexdigest() != item["sha256"]:
                raise PackagingError(f"Archive verification failed for {item['path']}.")
    return hashlib.sha256(output.read_bytes()).hexdigest()


def prepare_dist(clean: bool) -> None:
    existing = sorted(path.name for path in DIST.iterdir()) if DIST.exists() else []
    if existing and not clean:
        raise PackagingError("Stale dist artifacts found: " + ", ".join(existing) + ". Re-run with --clean.")
    if DIST.exists() and clean:
        resolved = DIST.resolve()
        if resolved != (ROOT / "dist").resolve():
            raise PackagingError(f"Refusing to remove unexpected path: {resolved}")
        shutil.rmtree(DIST)
    DIST.mkdir(exist_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify version surfaces only; do not package")
    parser.add_argument("--clean", action="store_true", help="Remove stale dist artifacts before packaging")
    args = parser.parse_args()
    try:
        version = current_version()
        validate_version_surfaces(version)
        validate_radar_build_config()
        print(f"Version parity passed for StormScope v{version}.")
        if args.check:
            return 0
        commit = validate_repository_state(version)
        prepare_dist(args.clean)
        paths = tracked_files()
        output = DIST / f"StormScope-v{version}.zip"
        manifest = write_archive(output, version, commit, paths)
        digest = validate_archive(output, manifest)
        print(f"Built {output.relative_to(ROOT)}")
        print(f"Files: {len(paths):,} tracked + {MANIFEST_NAME}")
        print(f"SHA256: {digest}")
        return 0
    except (OSError, RadarConfigError, subprocess.CalledProcessError, PackagingError, zipfile.BadZipFile) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
