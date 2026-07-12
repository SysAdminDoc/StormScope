"""Verify, rebuild, and check updates/advisories for vendored browser packages."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import date
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "vendor" / "dependencies.json"
USER_AGENT = "StormScope/0.77.0 vendor-audit"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != 2 or not isinstance(payload.get("packages"), list):
        raise ValueError("unsupported vendor manifest")
    return payload


def manifest_entries(package: dict[str, Any]) -> list[dict[str, str]]:
    entries = list(package["files"])
    entries.append(package["license_file"])
    return entries


def local_path(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError(f"manifest path escapes destination: {relative}")
    return target


def verify(manifest: dict[str, Any], root: Path = ROOT) -> list[str]:
    failures: list[str] = []
    for package in manifest["packages"]:
        print(f"{package['name']} {package['version']} ({package['license']})")
        for entry in manifest_entries(package):
            target = local_path(root, entry["local"])
            if not target.is_file():
                failures.append(f"missing {entry['local']}")
                continue
            actual = sha256(target.read_bytes())
            if actual != entry["sha256"]:
                failures.append(f"hash mismatch {entry['local']}: {actual}")
    return failures


def validate_advisory_dispositions(manifest: dict[str, Any], today: date | None = None) -> list[str]:
    failures: list[str] = []
    current = today or date.today()
    for package in manifest["packages"]:
        for advisory in package.get("supplemental_advisories", []):
            label = f"{package['name']} {advisory.get('id', 'unknown')}"
            try:
                reviewed = date.fromisoformat(advisory["reviewed_on"])
                expires = date.fromisoformat(advisory["expires_on"])
            except (KeyError, TypeError, ValueError):
                failures.append(f"{label}: malformed review dates")
                continue
            if expires < current:
                failures.append(f"{label}: disposition expired {expires.isoformat()}")
            if expires <= reviewed or (expires - reviewed).days > 180:
                failures.append(f"{label}: review validity must be 1-180 days")
            if advisory.get("status") not in {"affected", "mitigated", "not_affected_by_usage"}:
                failures.append(f"{label}: invalid disposition status")
            if not str(advisory.get("reason") or "").strip():
                failures.append(f"{label}: disposition reason is required")
            references = advisory.get("references")
            if not isinstance(references, list) or not references or not all(
                isinstance(url, str) and url.startswith("https://") for url in references
            ):
                failures.append(f"{label}: HTTPS advisory references are required")
    return failures


def stable_version(value: Any) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def latest_stable_version(metadata: dict[str, Any]) -> str:
    latest = metadata.get("dist-tags", {}).get("latest")
    if stable_version(latest) is not None:
        return latest
    stable = [version for version in metadata.get("versions", {}) if stable_version(version) is not None]
    if not stable:
        raise ValueError("npm metadata contains no stable semantic version")
    return max(stable, key=lambda version: stable_version(version) or (0, 0, 0))


def request_bytes(url: str, data: bytes | None = None, content_type: str | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=25) as response:  # noqa: S310 - pinned HTTPS endpoints
        return response.read()


def package_metadata(name: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(name, safe="")
    return json.loads(request_bytes(f"https://registry.npmjs.org/{encoded}").decode("utf-8"))


def osv_advisories(name: str, version: str) -> list[dict[str, Any]]:
    query = json.dumps({"package": {"ecosystem": "npm", "name": name}, "version": version}).encode()
    response = request_bytes("https://api.osv.dev/v1/query", query, "application/json")
    return json.loads(response.decode("utf-8")).get("vulns", [])


def check_updates(manifest: dict[str, Any]) -> list[str]:
    attention: list[str] = []
    for package in manifest["packages"]:
        metadata = package_metadata(package["name"])
        latest = latest_stable_version(metadata)
        status = "current" if latest == package["version"] else f"newer stable {latest}"
        print(f"{package['name']}: pinned {package['version']} • {status}")
        if latest != package["version"]:
            attention.append(f"{package['name']} update {package['version']} -> {latest}")
        advisories = osv_advisories(package["name"], package["version"])
        if advisories:
            identifiers = ", ".join(item.get("id", "unknown") for item in advisories)
            attention.append(f"{package['name']} advisories: {identifiers}")
            print(f"  advisories: {identifiers}")
        else:
            print("  advisories: none reported by OSV")
    return attention


def normalized_entry_bytes(entry: dict[str, str], data: bytes) -> bytes:
    if entry["local"].startswith("vendor/licenses/"):
        return data.replace(b"\r\n", b"\n")
    return data


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(data)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def rebuild(manifest: dict[str, Any], destination: Path) -> None:
    for package in manifest["packages"]:
        archive = request_bytes(package["tarball"])
        archive_hash = sha256(archive)
        if archive_hash != package["tarball_sha256"]:
            raise ValueError(f"tarball hash mismatch for {package['name']}: {archive_hash}")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            for entry in manifest_entries(package):
                member = bundle.getmember(entry["source"])
                if not member.isfile():
                    raise ValueError(f"package member is not a file: {entry['source']}")
                extracted = bundle.extractfile(member)
                if extracted is None:
                    raise ValueError(f"unable to read package member: {entry['source']}")
                data = normalized_entry_bytes(entry, extracted.read())
                if sha256(data) != entry["sha256"]:
                    raise ValueError(f"manifest hash does not match package member: {entry['source']}")
                write_atomic(local_path(destination, entry["local"]), data)
        print(f"rebuilt {package['name']} {package['version']} from verified npm tarball")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--check-updates", action="store_true", help="query npm and OSV for newer stable releases and advisories")
    parser.add_argument("--rebuild", action="store_true", help="rebuild vendored files and licenses from pinned npm tarballs")
    parser.add_argument("--destination", type=Path, default=ROOT, help="root directory written by --rebuild")
    parser.add_argument("--behavior", action="store_true", help="run the headless Leaflet/markercluster/HLS behavior smoke")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = read_manifest(args.manifest)
        if args.rebuild:
            rebuild(manifest, args.destination.resolve())
        failures = verify(manifest, args.destination.resolve() if args.rebuild else ROOT)
        failures.extend(validate_advisory_dispositions(manifest))
        attention = check_updates(manifest) if args.check_updates else []
        if args.behavior:
            subprocess.run(["node", "tests/browser-smoke.js"], cwd=ROOT, check=True)
            print("browser behavior: Leaflet, markercluster, and HLS integration passed")
    except (OSError, ValueError, KeyError, tarfile.TarError, urllib.error.URLError, subprocess.CalledProcessError) as error:
        print(f"vendor dependency check failed: {error}", file=sys.stderr)
        return 1
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    if attention:
        for item in attention:
            print(f"ATTENTION: {item}", file=sys.stderr)
        return 2
    print("vendored dependency files and licenses match the pinned manifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
