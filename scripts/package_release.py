#!/usr/bin/env python3
"""Build and verify StormScope's deterministic source release ZIP."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import date
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
    "scripts/dependency_audit.py",
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


def version_tuple(value: str) -> tuple[int, int, int]:
    if not VERSION_PATTERN.fullmatch(value):
        raise PackagingError(f"Invalid release version: {value!r}")
    return tuple(int(part) for part in value.split("."))  # type: ignore[return-value]


def read_text_exact(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


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
    sw_cache = first_match("sw.js", r"^var VERSION\s*=\s*['\"]v(\d+)['\"]")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    latest_block = re.search(
        rf"^## v{re.escape(version)}\s+-[^\n]*\n(?P<body>[\s\S]*?)(?=^## (?:v\d|Unreleased)\b|\Z)",
        changelog,
        re.MULTILINE,
    )
    changelog_caches = re.findall(r"\bSW v(\d+)\b", latest_block.group("body")) if latest_block else []
    if not sw_cache or changelog_caches != [sw_cache]:
        mismatches.append(
            "service worker cache=" + (f"sw.js v{sw_cache}, changelog {changelog_caches}" if sw_cache else "missing")
        )
    if mismatches:
        raise PackagingError("Version surfaces do not match " + version + ": " + "; ".join(mismatches))


def replace_checked(text: str, old: str, new: str, expected: int, label: str) -> str:
    actual = text.count(old)
    if actual != expected:
        raise PackagingError(f"{label} expected {expected} version surface(s), found {actual}")
    return text.replace(old, new)


def prepared_surface_updates(
    target_version: str,
    release_date: str,
    notes: list[str],
) -> tuple[dict[Path, str], int]:
    current = current_version()
    if version_tuple(target_version) <= version_tuple(current):
        raise PackagingError(f"Prepared version v{target_version} must be newer than v{current}.")
    try:
        date.fromisoformat(release_date)
    except ValueError as error:
        raise PackagingError(f"Release date must use YYYY-MM-DD: {release_date!r}") from error
    normalized_notes = [str(note).strip() for note in notes]
    if not normalized_notes or any(not note or "\n" in note or "\r" in note for note in normalized_notes):
        raise PackagingError("At least one single-line --note is required for release preparation.")
    if any(re.search(r"\bSW v\d+\b", note) for note in normalized_notes):
        raise PackagingError("Release notes must not supply the SW cache version; it is assigned atomically.")
    normalized_notes = [note if note.endswith((".", "!", "?")) else note + "." for note in normalized_notes]

    sw_path = ROOT / "sw.js"
    sw_text = read_text_exact(sw_path)
    sw_match = re.search(r"^var VERSION\s*=\s*['\"]v(\d+)['\"];", sw_text, re.MULTILINE)
    if not sw_match:
        raise PackagingError("sw.js cache version surface is missing")
    current_cache = int(sw_match.group(1))
    next_cache = current_cache + 1

    updates: dict[Path, str] = {}

    def update(relative: str, old: str, new: str, expected: int = 1) -> None:
        path = ROOT / relative
        updates[path] = replace_checked(read_text_exact(path), old, new, expected, relative)

    update("package.json", f'"version": "{current}"', f'"version": "{target_version}"')
    update("package-lock.json", f'"version": "{current}"', f'"version": "{target_version}"', 2)
    update("js/app.js", f"APP_VERSION = '{current}'", f"APP_VERSION = '{target_version}'")
    update(
        "README.md",
        f"version-{current}-blue",
        f"version-{target_version}-blue",
    )
    for relative in USER_AGENT_FILES:
        path = ROOT / relative
        text = read_text_exact(path)
        current_agent = f"StormScope/{current}"
        count = text.count(current_agent)
        if not count:
            raise PackagingError(f"{relative} current User-Agent surface is missing")
        updates[path] = text.replace(current_agent, f"StormScope/{target_version}")
    updates[sw_path] = replace_checked(
        sw_text,
        f"var VERSION = 'v{current_cache}';",
        f"var VERSION = 'v{next_cache}';",
        1,
        "sw.js",
    )

    changelog_path = ROOT / "CHANGELOG.md"
    changelog = read_text_exact(changelog_path)
    newline = "\r\n" if "\r\n" in changelog else "\n"
    header = f"# Changelog{newline}{newline}"
    if not changelog.startswith(header):
        raise PackagingError("CHANGELOG.md must begin with the canonical heading")
    normalized_notes[-1] = normalized_notes[-1].rstrip(".") + f". SW v{next_cache}."
    section = (
        f"## v{target_version} - {release_date}{newline}{newline}"
        + newline.join(f"- {note}" for note in normalized_notes)
        + newline + newline
    )
    updates[changelog_path] = header + section + changelog[len(header):]
    validate_prepared_surface_updates(updates, target_version, next_cache)
    return updates, next_cache


def validate_prepared_surface_updates(updates: dict[Path, str], version: str, sw_cache: int) -> None:
    package = json.loads(updates[ROOT / "package.json"])
    lock = json.loads(updates[ROOT / "package-lock.json"])
    if package.get("version") != version or lock.get("version") != version:
        raise PackagingError("Prepared package versions do not match")
    if lock.get("packages", {}).get("", {}).get("version") != version:
        raise PackagingError("Prepared root lock package version does not match")
    exact_surfaces = {
        "js/app.js": f"APP_VERSION = '{version}'",
        "README.md": f"version-{version}-blue",
        "sw.js": f"var VERSION = 'v{sw_cache}';",
        "CHANGELOG.md": f"## v{version}",
    }
    for relative, expected in exact_surfaces.items():
        if expected not in updates[ROOT / relative]:
            raise PackagingError(f"Prepared {relative} surface is invalid")
    if updates[ROOT / "CHANGELOG.md"].count(f"SW v{sw_cache}") != 1:
        raise PackagingError("Prepared changelog does not contain exactly one current SW cache marker")
    for relative in USER_AGENT_FILES:
        values = set(re.findall(r"StormScope/([0-9]+\.[0-9]+\.[0-9]+)", updates[ROOT / relative]))
        if values != {version}:
            raise PackagingError(f"Prepared {relative} User-Agent does not match v{version}")


def atomic_write_texts(updates: dict[Path, str]) -> None:
    originals = {path: path.read_bytes() for path in updates}
    temporary: dict[Path, Path] = {}
    try:
        for path, text in updates.items():
            with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as handle:
                handle.write(text.encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
                temporary[path] = Path(handle.name)
        for path, staged in temporary.items():
            os.replace(staged, path)
    except Exception:
        for path, payload in originals.items():
            path.write_bytes(payload)
        raise
    finally:
        for staged in temporary.values():
            staged.unlink(missing_ok=True)


def prepare_release(target_version: str, release_date: str, notes: list[str], dry_run: bool) -> None:
    updates, sw_cache = prepared_surface_updates(target_version, release_date, notes)
    if dry_run:
        for path, prepared in updates.items():
            relative = path.relative_to(ROOT).as_posix()
            original = read_text_exact(path)
            sys.stdout.writelines(difflib.unified_diff(
                original.splitlines(keepends=True),
                prepared.splitlines(keepends=True),
                fromfile=relative,
                tofile=relative,
            ))
        print(f"Dry run passed for StormScope v{target_version} / SW v{sw_cache}; no files changed.")
        return
    originals = {path: read_text_exact(path) for path in updates}
    try:
        atomic_write_texts(updates)
        validate_version_surfaces(target_version)
    except Exception:
        atomic_write_texts(originals)
        raise
    print(f"Prepared StormScope v{target_version} / SW v{sw_cache} across {len(updates)} files.")


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
    parser.add_argument("--prepare", metavar="VERSION", help="atomically update every release version surface")
    parser.add_argument("--dry-run", action="store_true", help="show the prepared release diff without writing files")
    parser.add_argument("--date", dest="release_date", help="absolute release date for --prepare (YYYY-MM-DD)")
    parser.add_argument("--note", action="append", default=[], help="single-line changelog note for --prepare; repeatable")
    args = parser.parse_args()
    try:
        if args.prepare:
            if args.check or args.clean:
                raise PackagingError("--prepare cannot be combined with --check or --clean")
            prepare_release(args.prepare, args.release_date or date.today().isoformat(), args.note, args.dry_run)
            return 0
        if args.dry_run or args.release_date or args.note:
            raise PackagingError("--dry-run, --date, and --note require --prepare VERSION")
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
