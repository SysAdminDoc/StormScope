#!/usr/bin/env python3
"""Fail-fast local toolchain contract for StormScope development."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parent.parent
PYTHON_MIN = (3, 11, 0)
PYTHON_MAX = (4, 0, 0)
NODE_MIN = (18, 0, 0)
NPM_MIN = (9, 0, 0)
CURL_MIN = (8, 0, 0)
RUFF_VERSION = (0, 15, 20)
YT_DLP_VERSION = (2026, 7, 4)
PLAYWRIGHT_VERSION = "1.61.1"


@dataclass(frozen=True)
class Result:
    name: str
    actual: str
    supported: str
    ok: bool
    detail: str = ""


def version_tuple(value: str) -> tuple[int, ...]:
    """Parse the first dotted numeric version from command output."""
    token = ""
    started = False
    for character in value:
        if character.isdigit() or started and character == ".":
            token += character
            started = True
        elif started:
            break
    return tuple(int(part) for part in token.strip(".").split(".") if part)


def padded(value: tuple[int, ...], size: int = 3) -> tuple[int, ...]:
    return (value + (0,) * size)[:size]


def in_range(value: tuple[int, ...], minimum: tuple[int, ...], maximum: tuple[int, ...] | None = None) -> bool:
    normalized = padded(value)
    return normalized >= padded(minimum) and (maximum is None or normalized < padded(maximum))


def command_output(command: list[str]) -> str:
    completed = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
    return (completed.stdout or completed.stderr).strip()


def executable(names: tuple[str, ...]) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def probe_version(
    name: str,
    commands: tuple[str, ...],
    arguments: list[str],
    supported: str,
    validator: Callable[[tuple[int, ...]], bool],
) -> Result:
    path = executable(commands)
    if not path:
        return Result(name, "missing", supported, False, f"Install {commands[0]} and ensure it is on PATH.")
    try:
        output = command_output([path, *arguments])
        actual = version_tuple(output)
        if not actual:
            return Result(name, output or "unknown", supported, False, "Version output could not be parsed.")
        text = ".".join(str(part) for part in actual)
        return Result(name, text, supported, validator(actual), path)
    except (OSError, subprocess.CalledProcessError) as error:
        return Result(name, "unavailable", supported, False, str(error))


def probe_python_module(name: str, module: str, required: tuple[int, ...]) -> Result:
    supported = "==" + ".".join(str(part) for part in required)
    try:
        output = command_output([sys.executable, "-m", module, "--version"])
        actual = version_tuple(output)
        text = ".".join(str(part) for part in actual) if actual else output
        return Result(name, text, supported, padded(actual) == padded(required), sys.executable)
    except (OSError, subprocess.CalledProcessError) as error:
        return Result(name, "missing", supported, False, f"Install requirements-dev.txt ({error}).")


def probe_playwright() -> list[Result]:
    node = executable(("node", "node.exe"))
    supported = f"=={PLAYWRIGHT_VERSION}; Chromium + Firefox + WebKit installed"
    if not node:
        return [Result("Playwright", "missing", supported, False, "Node.js is not on PATH.")]
    script = """
const fs = require('node:fs');
const api = require('playwright');
const version = require('@playwright/test/package.json').version;
const engines = Object.fromEntries(['chromium', 'firefox', 'webkit'].map(name => {
  const path = api[name].executablePath();
  return [name, { path, installed: fs.existsSync(path) }];
}));
process.stdout.write(JSON.stringify({ version, engines }));
"""
    try:
        payload = json.loads(command_output([node, "-e", script]))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        return [Result("Playwright", "missing", supported, False, f"Run npm ci ({error}).")]
    results = [Result(
        "Playwright",
        str(payload.get("version") or "unknown"),
        f"=={PLAYWRIGHT_VERSION}",
        payload.get("version") == PLAYWRIGHT_VERSION,
        "package-lock.json",
    )]
    for engine in ("chromium", "firefox", "webkit"):
        state = payload.get("engines", {}).get(engine, {})
        results.append(Result(
            f"Playwright {engine}",
            "installed" if state.get("installed") else "missing",
            "installed",
            bool(state.get("installed")),
            state.get("path") or "Run: npx playwright install chromium firefox webkit",
        ))
    return results


def collect_results() -> list[Result]:
    python_actual = tuple(sys.version_info[:3])
    results = [Result(
        "Python",
        ".".join(str(part) for part in python_actual),
        ">=3.11,<4",
        in_range(python_actual, PYTHON_MIN, PYTHON_MAX),
        sys.executable,
    )]
    results.extend([
        probe_version("Node.js", ("node", "node.exe"), ["--version"], ">=18", lambda value: in_range(value, NODE_MIN)),
        probe_version("npm", ("npm", "npm.cmd"), ["--version"], ">=9", lambda value: in_range(value, NPM_MIN)),
        probe_version("curl", ("curl", "curl.exe"), ["--version"], ">=8", lambda value: in_range(value, CURL_MIN)),
        probe_python_module("Ruff", "ruff", RUFF_VERSION),
        probe_version(
            "yt-dlp",
            ("yt-dlp", "yt-dlp.exe"),
            ["--version"],
            "==2026.7.4",
            lambda value: padded(value) == padded(YT_DLP_VERSION),
        ),
    ])
    results.extend(probe_playwright())
    return results


def main() -> int:
    results = collect_results()
    print("StormScope local toolchain preflight")
    for result in results:
        marker = "ok" if result.ok else "FAIL"
        suffix = f" - {result.detail}" if result.detail else ""
        print(f"[{marker}] {result.name}: {result.actual} (supported {result.supported}){suffix}")
    failures = [result for result in results if not result.ok]
    if failures:
        print(f"\nPreflight failed: {len(failures)} requirement(s) need attention.", file=sys.stderr)
        return 1
    print("\nPreflight passed. The complete local regression gate is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
