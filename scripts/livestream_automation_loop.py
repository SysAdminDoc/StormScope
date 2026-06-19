#!/usr/bin/env python3
"""
Continuously audit and discover livestream cameras.

Use ``--iterations 0`` for an endless loop. Each cycle can:
- remove confirmed broken YouTube rows with the strict audit script
- run broad live-filtered YouTube searches
- continue the resumable U.S. Census city-list search
- periodically refresh EarthCam and LiveBeaches discovery
"""

from __future__ import annotations

import argparse
import itertools
import subprocess
import sys
import time
from pathlib import Path


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

QUERY_PACKS = [
    [
        "live webcam 24/7 beach USA",
        "live beach cam pier boardwalk marina",
        "live webcam surf beach ocean 24/7",
        "live beach resort webcam 24/7",
        "live webcam florida beach",
        "live webcam carolina beach",
    ],
    [
        "live webcam city skyline 24/7",
        "live downtown webcam 24/7",
        "live city plaza webcam",
        "live street cam downtown",
        "live webcam times square city",
        "live webcam europe asia japan london",
    ],
    [
        "live cam airport runway",
        "live plane spotting airport webcam",
        "live airport tower cam",
        "live webcam train station railcam USA",
        "live train cam railcam",
        "live traffic cam highway freeway",
    ],
    [
        "earthcam live youtube webcam",
        "earthcam live beach",
        "earthcam live city",
        "live harbor port webcam 24/7",
        "live marina harbor cam",
        "live cruise port webcam",
    ],
    [
        "live webcam mountain ski resort",
        "live weather cam storm",
        "live webcam volcano observatory",
        "live cam national park wildlife",
        "live webcam zoo aquarium",
        "live indoor cam aquarium 24/7",
    ],
]


def timestamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S", time.gmtime())


def run_step(label: str, command: list[str], *, optional: bool = False) -> int:
    print(f"\n== {label} ==")
    print(" ".join(str(part) for part in command))
    proc = subprocess.run(command, cwd=ROOT)
    if proc.returncode and not optional:
        print(f"{label} failed with exit code {proc.returncode}", file=sys.stderr)
    elif proc.returncode:
        print(f"{label} skipped/failed with exit code {proc.returncode}", file=sys.stderr)
    return proc.returncode


def add_apply(command: list[str], apply: bool) -> list[str]:
    return [*command, "--apply"] if apply else command


def run_cycle(cycle: int, args: argparse.Namespace) -> bool:
    stamp = timestamp()
    ok = True

    if not args.skip_audit and (cycle == 1 or args.audit_every and cycle % args.audit_every == 0):
        command = [
            sys.executable,
            "scripts/audit_youtube_streams.py",
            "--report",
            str(DATA_DIR / f"youtube_audit_report_loop_{stamp}_cycle_{cycle}.json"),
            "--workers",
            str(args.audit_workers),
            "--timeout",
            str(args.audit_timeout),
            "--retries",
            str(args.audit_retries),
        ]
        if args.remove_unknown:
            command.append("--remove-unknown")
        ok = run_step("audit YouTube streams", add_apply(command, args.apply)) == 0 and ok

    pack = QUERY_PACKS[(cycle - 1) % len(QUERY_PACKS)]
    command = [
        sys.executable,
        "scripts/discover_youtube_cameras.py",
        "--query-mode",
        "custom",
        "--max-pages",
        str(args.max_pages),
        "--max-empty-pages",
        str(args.max_empty_pages),
        "--min-score",
        str(args.min_score),
        "--sleep",
        str(args.sleep),
        "--geocode-sleep",
        str(args.geocode_sleep),
        "--report",
        str(DATA_DIR / f"youtube_discovery_report_loop_{stamp}_cycle_{cycle}.json"),
    ]
    if args.geocode:
        command.append("--geocode")
    for query in pack:
        command.extend(["--query", query])
    ok = run_step("broad YouTube discovery", add_apply(command, args.apply)) == 0 and ok

    if not args.skip_city:
        command = [
            sys.executable,
            "scripts/discover_city_livestreams.py",
            "--resume",
            "--limit-cities",
            str(args.city_batch_size),
            "--max-pages",
            str(args.city_max_pages),
            "--max-empty-pages",
            "1",
            "--sleep",
            str(args.sleep),
            "--verify-sleep",
            str(args.sleep),
            "--report",
            str(DATA_DIR / f"us_city_livestream_report_loop_{stamp}_cycle_{cycle}.json"),
        ]
        ok = run_step("city-list discovery", add_apply(command, args.apply)) == 0 and ok

    if args.earthcam_every and cycle % args.earthcam_every == 0:
        command = [
            sys.executable,
            "scripts/discover_earthcam_feeds.py",
            "--report",
            str(DATA_DIR / f"earthcam_discovery_report_loop_{stamp}_cycle_{cycle}.json"),
        ]
        run_step("EarthCam discovery", add_apply(command, args.apply), optional=True)

    if args.livebeaches_every and cycle % args.livebeaches_every == 0:
        command = [
            sys.executable,
            "scripts/discover_livebeaches_feeds.py",
            "--max-pages-per-category",
            str(args.livebeaches_pages),
            "--report",
            str(DATA_DIR / f"livebeaches_discovery_report_loop_{stamp}_cycle_{cycle}.json"),
        ]
        run_step("LiveBeaches discovery", add_apply(command, args.apply), optional=True)

    return ok


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=1, help="cycle count; 0 means run forever")
    parser.add_argument("--apply", action="store_true", help="write dataset changes")
    parser.add_argument("--loop-sleep", type=float, default=300.0, help="delay between cycles")
    parser.add_argument("--skip-audit", action="store_true")
    parser.add_argument("--audit-every", type=int, default=1)
    parser.add_argument("--audit-workers", type=int, default=4)
    parser.add_argument("--audit-timeout", type=int, default=75)
    parser.add_argument("--audit-retries", type=int, default=1)
    parser.add_argument("--remove-unknown", action="store_true")
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--max-empty-pages", type=int, default=1)
    parser.add_argument("--min-score", type=int, default=5)
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--geocode", action="store_true", help="geocode broad YouTube discovery candidates")
    parser.add_argument("--geocode-sleep", type=float, default=1.1)
    parser.add_argument("--skip-city", action="store_true")
    parser.add_argument("--city-batch-size", type=int, default=100)
    parser.add_argument("--city-max-pages", type=int, default=1)
    parser.add_argument("--earthcam-every", type=int, default=5)
    parser.add_argument("--livebeaches-every", type=int, default=3)
    parser.add_argument("--livebeaches-pages", type=int, default=2)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    cycles = itertools.count(1) if args.iterations == 0 else range(1, args.iterations + 1)
    all_ok = True
    for cycle in cycles:
        print(f"\n######## Livestream automation cycle {cycle} ########")
        all_ok = run_cycle(cycle, args) and all_ok
        if args.iterations != 0 and cycle >= args.iterations:
            break
        time.sleep(args.loop_sleep)
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
