#!/usr/bin/env python3
"""Audit every exact Python, Node, and vendored dependency pin."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "requirements-dev.txt"
PACKAGE_LOCK = ROOT / "package-lock.json"
VENDOR_MANIFEST = ROOT / "vendor" / "dependencies.json"
ADVISORY_POLICY = ROOT / "config" / "dependency-advisories.json"
USER_AGENT = "StormScope/0.110.0 dependency-audit"
PIN_PATTERN = re.compile(r"^([A-Za-z0-9_.-]+)==([A-Za-z0-9][A-Za-z0-9.+_-]*)$")
ALLOWED_ECOSYSTEMS = {"npm", "PyPI"}
ALLOWED_STATUSES = {"affected", "mitigated", "not_affected_by_usage", "patched"}


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    name: str
    version: str
    surfaces: tuple[str, ...]

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.ecosystem, canonical_name(self.ecosystem, self.name), self.version)

    @property
    def label(self) -> str:
        return f"{self.ecosystem}:{self.name}@{self.version}"


def canonical_name(ecosystem: str, name: str) -> str:
    lowered = name.strip().lower()
    if ecosystem == "PyPI":
        return re.sub(r"[-_.]+", "-", lowered)
    return lowered


def python_pins(path: Path = REQUIREMENTS) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN_PATTERN.fullmatch(line)
        if not match:
            raise ValueError(f"{path.name}:{line_number} is not an exact package==version pin")
        dependencies.append(Dependency("PyPI", match.group(1), match.group(2), (path.name,)))
    if not dependencies:
        raise ValueError(f"{path.name} contains no dependency pins")
    return dependencies


def node_package_name(lock_path: str) -> str:
    marker = "node_modules/"
    if marker not in lock_path:
        raise ValueError(f"unsupported package-lock path: {lock_path!r}")
    name = lock_path.rsplit(marker, 1)[1]
    if not name or name.endswith("/"):
        raise ValueError(f"invalid package-lock package path: {lock_path!r}")
    return name


def node_pins(path: Path = PACKAGE_LOCK) -> list[Dependency]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    packages = payload.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("package-lock.json has no packages map")
    dependencies: list[Dependency] = []
    for lock_path, metadata in sorted(packages.items()):
        if not lock_path:
            continue
        if not isinstance(metadata, dict) or not str(metadata.get("version") or "").strip():
            raise ValueError(f"package-lock entry {lock_path!r} has no exact version")
        dependencies.append(Dependency(
            "npm",
            node_package_name(lock_path),
            str(metadata["version"]),
            (f"package-lock.json:{lock_path}",),
        ))
    if not dependencies:
        raise ValueError("package-lock.json contains no installed dependency pins")
    return dependencies


def vendor_pins(path: Path = VENDOR_MANIFEST) -> list[Dependency]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != 2 or not isinstance(payload.get("packages"), list):
        raise ValueError("unsupported vendor dependency manifest")
    dependencies: list[Dependency] = []
    for package in payload["packages"]:
        name = str(package.get("name") or "").strip()
        version = str(package.get("version") or "").strip()
        if not name or not version:
            raise ValueError("vendored dependency is missing name/version")
        dependencies.append(Dependency("npm", name, version, ("vendor/dependencies.json",)))
    return dependencies


def dependency_inventory() -> list[Dependency]:
    merged: dict[tuple[str, str, str], set[str]] = {}
    labels: dict[tuple[str, str, str], tuple[str, str, str]] = {}
    for dependency in [*python_pins(), *node_pins(), *vendor_pins()]:
        merged.setdefault(dependency.key, set()).update(dependency.surfaces)
        labels.setdefault(dependency.key, (dependency.ecosystem, dependency.name, dependency.version))
    inventory = [
        Dependency(ecosystem, name, version, tuple(sorted(merged[key])))
        for key, (ecosystem, name, version) in labels.items()
    ]
    return sorted(inventory, key=lambda item: (item.ecosystem, canonical_name(item.ecosystem, item.name), item.version))


def read_policy(path: Path = ADVISORY_POLICY) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != 1 or not isinstance(payload.get("reviewed_advisories"), list):
        raise ValueError("unsupported dependency advisory policy")
    return payload


def reviewed_advisories(
    policy: dict[str, Any] | None = None,
    vendor_path: Path = VENDOR_MANIFEST,
) -> list[dict[str, Any]]:
    result = [dict(item) for item in (policy or read_policy())["reviewed_advisories"]]
    vendor = json.loads(vendor_path.read_text(encoding="utf-8"))
    for package in vendor.get("packages", []):
        for advisory in package.get("supplemental_advisories", []):
            result.append({
                **advisory,
                "ecosystem": "npm",
                "package": package["name"],
                "version": package["version"],
            })
    return result


def advisory_identifiers(advisory: dict[str, Any]) -> set[str]:
    identifiers = {str(advisory.get("id") or "").upper()}
    aliases = advisory.get("aliases", [])
    if isinstance(aliases, list):
        identifiers.update(str(alias).upper() for alias in aliases)
    return {identifier for identifier in identifiers if identifier}


def validate_reviewed_advisories(
    inventory: Iterable[Dependency],
    advisories: Iterable[dict[str, Any]],
    current: date | None = None,
) -> list[str]:
    failures: list[str] = []
    today = current or date.today()
    inventory_keys = {dependency.key for dependency in inventory}
    seen: set[tuple[str, str, str, str]] = set()
    for advisory in advisories:
        ecosystem = str(advisory.get("ecosystem") or "")
        package = str(advisory.get("package") or "")
        version = str(advisory.get("version") or "")
        advisory_id = str(advisory.get("id") or "unknown")
        label = f"{ecosystem}:{package}@{version} {advisory_id}"
        if ecosystem not in ALLOWED_ECOSYSTEMS:
            failures.append(f"{label}: unsupported ecosystem")
        key = (ecosystem, canonical_name(ecosystem, package), version)
        if key not in inventory_keys:
            failures.append(f"{label}: reviewed version is not an exact current pin")
        duplicate = (*key, advisory_id.upper())
        if duplicate in seen:
            failures.append(f"{label}: duplicate reviewed advisory")
        seen.add(duplicate)
        try:
            reviewed = date.fromisoformat(str(advisory["reviewed_on"]))
            expires = date.fromisoformat(str(advisory["expires_on"]))
        except (KeyError, TypeError, ValueError):
            failures.append(f"{label}: malformed review dates")
            continue
        if expires < today:
            failures.append(f"{label}: review expired {expires.isoformat()}")
        if expires <= reviewed or (expires - reviewed).days > 180:
            failures.append(f"{label}: review validity must be 1-180 days")
        status = advisory.get("status")
        if status not in ALLOWED_STATUSES:
            failures.append(f"{label}: invalid disposition status")
        elif status == "affected":
            failures.append(f"{label}: exact current pin is marked affected")
        if not str(advisory.get("reason") or "").strip():
            failures.append(f"{label}: disposition reason is required")
        references = advisory.get("references")
        if not isinstance(references, list) or not references or not all(
            isinstance(url, str) and url.startswith("https://") for url in references
        ):
            failures.append(f"{label}: HTTPS advisory references are required")
    return failures


def request_json(url: str, data: bytes | None = None) -> Any:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=35) as response:  # noqa: S310 - fixed HTTPS APIs
        return json.loads(response.read().decode("utf-8"))


def osv_query_batch(inventory: list[Dependency]) -> list[dict[str, Any]]:
    body = json.dumps({
        "queries": [
            {"package": {"ecosystem": dependency.ecosystem, "name": dependency.name}, "version": dependency.version}
            for dependency in inventory
        ]
    }).encode("utf-8")
    payload = request_json("https://api.osv.dev/v1/querybatch", body)
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list) or len(results) != len(inventory):
        raise ValueError("OSV querybatch returned a mismatched result set")
    return results


def evaluate_osv_results(
    inventory: list[Dependency],
    results: list[dict[str, Any]],
    advisories: list[dict[str, Any]],
) -> list[str]:
    attention: list[str] = []
    reviewed = []
    for advisory in advisories:
        reviewed.append((
            (
                str(advisory.get("ecosystem") or ""),
                canonical_name(str(advisory.get("ecosystem") or ""), str(advisory.get("package") or "")),
                str(advisory.get("version") or ""),
            ),
            advisory_identifiers(advisory),
            str(advisory.get("status") or ""),
        ))
    for dependency, result in zip(inventory, results, strict=True):
        vulnerabilities = result.get("vulns", []) if isinstance(result, dict) else []
        identifiers: list[str] = []
        for vulnerability in vulnerabilities if isinstance(vulnerabilities, list) else []:
            ids = {str(vulnerability.get("id") or "").upper()}
            aliases = vulnerability.get("aliases", [])
            if isinstance(aliases, list):
                ids.update(str(alias).upper() for alias in aliases)
            ids.discard("")
            identifiers.extend(sorted(ids))
            matching = [status for key, reviewed_ids, status in reviewed if key == dependency.key and ids & reviewed_ids]
            if not matching or any(status in {"affected", "patched"} for status in matching):
                attention.append(f"{dependency.label} OSV advisory {'/'.join(sorted(ids)) or 'unknown'}")
        suffix = ", ".join(sorted(set(identifiers))) if identifiers else "none"
        print(f"{dependency.label}: OSV advisories {suffix}")
    return attention


def nvd_payload(cve_id: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(cve_id, safe="")
    payload = request_json(f"https://services.nvd.nist.gov/rest/json/cves/2.0?cveId={encoded}")
    if not isinstance(payload, dict):
        raise ValueError(f"NVD returned invalid data for {cve_id}")
    return payload


def validate_nvd_payload(cve_id: str, payload: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    vulnerabilities = payload.get("vulnerabilities")
    if payload.get("totalResults") != 1 or not isinstance(vulnerabilities, list) or len(vulnerabilities) != 1:
        return [f"NVD did not return exactly one record for {cve_id}"]
    record = vulnerabilities[0].get("cve", {}) if isinstance(vulnerabilities[0], dict) else {}
    if str(record.get("id") or "").upper() != cve_id.upper():
        failures.append(f"NVD record identifier mismatch for {cve_id}")
    if str(record.get("vulnStatus") or "").lower() == "rejected":
        failures.append(f"NVD marks {cve_id} rejected")
    return failures


def online_audit(
    inventory: list[Dependency],
    advisories: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    attention = evaluate_osv_results(inventory, osv_query_batch(inventory), advisories)
    cve_ids = sorted({
        identifier
        for advisory in advisories
        for identifier in advisory_identifiers(advisory)
        if identifier.startswith("CVE-")
    })
    for cve_id in cve_ids:
        payload = nvd_payload(cve_id)
        failures.extend(validate_nvd_payload(cve_id, payload))
        if not failures:
            print(f"{cve_id}: NVD record confirmed")
    return failures, attention


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--online", action="store_true", help="query OSV for every exact pin and NVD for reviewed CVEs")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        inventory = dependency_inventory()
        advisories = reviewed_advisories()
        failures = validate_reviewed_advisories(inventory, advisories)
        attention: list[str] = []
        if args.online and not failures:
            online_failures, attention = online_audit(inventory, advisories)
            failures.extend(online_failures)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
        print(f"dependency audit failed: {error}", file=sys.stderr)
        return 1
    for dependency in inventory:
        print(f"PIN: {dependency.label} ({', '.join(dependency.surfaces)})")
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    if attention:
        for item in attention:
            print(f"ATTENTION: {item}", file=sys.stderr)
        return 2
    mode = "OSV/NVD live audit" if args.online else "offline policy audit"
    print(f"{mode} passed for {len(inventory)} exact dependency pins and {len(advisories)} reviewed advisories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
