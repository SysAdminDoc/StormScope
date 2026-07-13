#!/usr/bin/env python3
"""Validate and compile the optional build-time radar provider configuration."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "radar-provider.json"
DEFAULT_OUTPUT = ROOT / "js" / "radar-build-config.js"
PROVIDER_ID = "build-radar"
PROTOCOL = "rainviewer-v2"
SCHEMA_VERSION = 1
_CSP_META_RE = re.compile(
    r'(<meta\s+[^>]*http-equiv=["\']Content-Security-Policy["\'][^>]*content=)'
    r'(?P<quote>["\'])(?P<csp>.*?)(?P=quote)([^>]*>)',
    re.IGNORECASE | re.DOTALL,
)


class RadarConfigError(ValueError):
    """Raised when build-time radar configuration is unsafe or malformed."""


def _require_exact_keys(value: dict[str, Any], required: set[str], optional: set[str], label: str) -> None:
    missing = required - value.keys()
    unknown = value.keys() - required - optional
    if missing:
        raise RadarConfigError(f"{label} is missing: {', '.join(sorted(missing))}")
    if unknown:
        raise RadarConfigError(f"{label} has unsupported fields: {', '.join(sorted(unknown))}")


def _https_url(value: Any, label: str, *, origin_only: bool = False) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise RadarConfigError(f"{label} must be a non-empty URL without surrounding whitespace")
    if "*" in value:
        raise RadarConfigError(f"{label} must not contain wildcards")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise RadarConfigError(f"{label} must not contain control characters")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise RadarConfigError(f"{label} must use an absolute HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise RadarConfigError(f"{label} must not contain credentials")
    if parsed.query or parsed.fragment:
        raise RadarConfigError(f"{label} must not contain a query or fragment")
    try:
        port = parsed.port
    except ValueError as error:
        raise RadarConfigError(f"{label} has an invalid port") from error
    if origin_only and parsed.path not in ("", "/"):
        raise RadarConfigError(f"{label} must be an origin without a path")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    authority = host if port is None else f"{host}:{port}"
    if origin_only:
        return f"https://{authority}"
    return f"https://{authority}{parsed.path or '/'}"


def _positive_number(value: Any, label: str, *, integer: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise RadarConfigError(f"{label} must be a positive {'integer' if integer else 'number'}")
    if integer and (not isinstance(value, int) or isinstance(value, bool)):
        raise RadarConfigError(f"{label} must be a positive integer")
    return value


def normalize_config(raw: Any) -> dict[str, Any]:
    """Return the strict runtime contract, rejecting unsafe or ambiguous input."""
    if not isinstance(raw, dict):
        raise RadarConfigError("radar configuration must be an object")
    _require_exact_keys(raw, {"schema_version", "enabled"}, {"discovery_url", "tile_origins", "attribution", "capabilities"}, "config")
    if raw["schema_version"] != SCHEMA_VERSION:
        raise RadarConfigError(f"schema_version must be {SCHEMA_VERSION}")
    if not isinstance(raw["enabled"], bool):
        raise RadarConfigError("enabled must be a boolean")
    base: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "enabled": raw["enabled"],
        "providerId": PROVIDER_ID,
        "protocol": PROTOCOL,
    }
    if not raw["enabled"]:
        if raw.keys() != {"schema_version", "enabled"}:
            raise RadarConfigError("disabled configuration must not retain endpoint settings")
        return base

    _require_exact_keys(
        raw,
        {"schema_version", "enabled", "discovery_url", "tile_origins", "attribution", "capabilities"},
        set(),
        "enabled config",
    )
    discovery_url = _https_url(raw["discovery_url"], "discovery_url")
    tile_origins = raw["tile_origins"]
    if not isinstance(tile_origins, list) or not tile_origins:
        raise RadarConfigError("tile_origins must be a non-empty array")
    normalized_origins = [_https_url(value, f"tile_origins[{index}]", origin_only=True) for index, value in enumerate(tile_origins)]
    if len(set(normalized_origins)) != len(normalized_origins):
        raise RadarConfigError("tile_origins must not contain duplicates")

    attribution = raw["attribution"]
    if not isinstance(attribution, dict):
        raise RadarConfigError("attribution must be an object")
    _require_exact_keys(attribution, {"label", "url"}, set(), "attribution")
    label = attribution["label"]
    if not isinstance(label, str) or not label.strip() or label.strip() != label or len(label) > 80:
        raise RadarConfigError("attribution.label must be 1-80 trimmed characters")
    attribution_url = _https_url(attribution["url"], "attribution.url")

    capabilities = raw["capabilities"]
    if not isinstance(capabilities, dict):
        raise RadarConfigError("capabilities must be an object")
    _require_exact_keys(capabilities, {"max_zoom", "freshness", "history"}, set(), "capabilities")
    max_zoom = _positive_number(capabilities["max_zoom"], "capabilities.max_zoom", integer=True)
    if max_zoom > 22:
        raise RadarConfigError("capabilities.max_zoom must not exceed 22")

    freshness = capabilities["freshness"]
    if not isinstance(freshness, dict):
        raise RadarConfigError("capabilities.freshness must be an object")
    _require_exact_keys(freshness, {"stale_after_minutes", "fail_after_minutes"}, set(), "capabilities.freshness")
    stale_after = _positive_number(freshness["stale_after_minutes"], "stale_after_minutes")
    fail_after = _positive_number(freshness["fail_after_minutes"], "fail_after_minutes")
    if fail_after <= stale_after:
        raise RadarConfigError("fail_after_minutes must be greater than stale_after_minutes")

    history = capabilities["history"]
    if not isinstance(history, dict):
        raise RadarConfigError("capabilities.history must be an object")
    _require_exact_keys(history, {"enabled", "window_minutes"}, set(), "capabilities.history")
    if not isinstance(history["enabled"], bool):
        raise RadarConfigError("capabilities.history.enabled must be a boolean")
    window = history["window_minutes"]
    if history["enabled"]:
        window = _positive_number(window, "capabilities.history.window_minutes")
    elif window != 0:
        raise RadarConfigError("disabled history must use window_minutes 0")

    base.update(
        {
            "discoveryUrl": discovery_url,
            "tileOrigins": normalized_origins,
            "attribution": {"label": label, "url": attribution_url},
            "capabilities": {
                "maxZoom": max_zoom,
                "freshness": {"staleAfterMinutes": stale_after, "failAfterMinutes": fail_after},
                "history": {"enabled": history["enabled"], "windowMinutes": window},
            },
        }
    )
    return base


def required_connect_origins(config: dict[str, Any]) -> tuple[str, ...]:
    """Return exact CSP connect-src origins required by a normalized config."""
    if not config["enabled"]:
        return ()
    discovery = urlsplit(config["discoveryUrl"])
    discovery_origin = f"{discovery.scheme}://{discovery.netloc}"
    return tuple(dict.fromkeys([discovery_origin, *config["tileOrigins"]]))


def merge_connect_src(
    csp: str,
    config: dict[str, Any],
    remove_origins: tuple[str, ...] = (),
) -> str:
    """Add configured origins to connect-src while preserving other directives."""
    directives = [part.strip() for part in csp.split(";") if part.strip()]
    positions = [index for index, directive in enumerate(directives) if directive.split()[0].lower() == "connect-src"]
    if len(positions) != 1:
        raise RadarConfigError("CSP must contain exactly one explicit connect-src directive")
    index = positions[0]
    tokens = directives[index].split()
    existing = [source for source in tokens[1:] if source not in remove_origins]
    additions = [origin for origin in required_connect_origins(config) if origin not in existing]
    directives[index] = " ".join([tokens[0], *existing, *additions])
    return "; ".join(directives) + ";"


def validate_csp(csp: str, config: dict[str, Any]) -> None:
    directives = [tokens for part in csp.split(";") if (tokens := part.split())]
    connect_directives = [tokens[1:] for tokens in directives if tokens[0].lower() == "connect-src"]
    if len(connect_directives) != 1:
        raise RadarConfigError("CSP must contain exactly one explicit connect-src directive")
    connect_sources = connect_directives[0]
    if any("*" in source or source.lower() == "https:" for source in connect_sources):
        raise RadarConfigError("CSP connect-src must not contain wildcard or scheme-wide sources")
    missing = [origin for origin in required_connect_origins(config) if origin not in connect_sources]
    if missing:
        raise RadarConfigError(f"CSP connect-src is missing: {', '.join(missing)}")


def extract_html_csp(html: str) -> str:
    match = _CSP_META_RE.search(html)
    if not match:
        raise RadarConfigError("HTML must contain a Content-Security-Policy meta element")
    return match.group("csp")


def validate_html_csp(html: str, config: dict[str, Any]) -> None:
    validate_csp(extract_html_csp(html), config)


def render_html_with_csp(
    html: str,
    config: dict[str, Any],
    remove_origins: tuple[str, ...] = (),
) -> str:
    """Return HTML with the CSP merged; callers decide whether to persist it."""
    match = _CSP_META_RE.search(html)
    if not match:
        raise RadarConfigError("HTML must contain a Content-Security-Policy meta element")
    updated = merge_connect_src(match.group("csp"), config, remove_origins)
    return html[: match.start("csp")] + updated + html[match.end("csp") :]


def render_javascript(config: dict[str, Any]) -> str:
    payload = json.dumps(config, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return f"""/* Generated by scripts/build_radar_config.py; do not edit. */
(function (root) {{
  'use strict';
  function deepFreeze(value) {{
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) {{ deepFreeze(value[key]); }});
    return Object.freeze(value);
  }}
  var config = deepFreeze({payload});
  Object.defineProperty(root, 'StormScopeRadarBuildConfig', {{
    value: config,
    enumerable: true,
    writable: false,
    configurable: false
  }});
  if (typeof module === 'object' && module.exports) module.exports = config;
}})(typeof globalThis !== 'undefined' ? globalThis : this);
"""


def load_generated_config(path: Path) -> dict[str, Any] | None:
    """Read the prior generated payload so obsolete CSP origins can be removed."""
    if not path.exists():
        return None
    match = re.search(r"var config = deepFreeze\((\{.*\})\);", path.read_text(encoding="utf-8"))
    if not match:
        raise RadarConfigError(f"Cannot parse prior generated radar configuration: {path}")
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise RadarConfigError(f"Cannot parse prior generated radar configuration: {error}") from error
    if not isinstance(value, dict):
        raise RadarConfigError("Prior generated radar configuration is not an object")
    return value


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RadarConfigError(f"Cannot read radar configuration: {error}") from error
    return normalize_config(raw)


def build(config_path: Path, output_path: Path) -> dict[str, Any]:
    config = load_config(config_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_javascript(config), encoding="utf-8", newline="\n")
    return config


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check-csp", type=Path, help="validate an HTML CSP without editing the file")
    parser.add_argument("--update-csp", type=Path, help="replace prior configured origins and add current origins")
    parser.add_argument("--print-connect-src", action="store_true", help="print required connect-src origins")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        previous = load_generated_config(args.output)
        if args.check_csp and args.update_csp:
            raise RadarConfigError("--check-csp and --update-csp cannot be combined")
        if args.check_csp:
            validate_html_csp(args.check_csp.read_text(encoding="utf-8"), config)
        if args.update_csp:
            html = args.update_csp.read_text(encoding="utf-8")
            remove_origins = required_connect_origins(previous) if previous else ()
            args.update_csp.write_text(
                render_html_with_csp(html, config, remove_origins),
                encoding="utf-8",
                newline="\n",
            )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(render_javascript(config), encoding="utf-8", newline="\n")
        if args.print_connect_src:
            print(" ".join(required_connect_origins(config)))
    except (OSError, RadarConfigError) as error:
        parser.error(str(error))
    print(f"Wrote {args.output} ({'enabled' if config['enabled'] else 'disabled'}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
