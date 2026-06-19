#!/usr/bin/env python3
"""
Audit YouTube camera rows and optionally remove confirmed broken streams.

This is intentionally stricter than checking for the watch-page
``isLiveBroadcast`` marker. A stream is kept only when yt-dlp can extract
currently playable live metadata. Confirmed failed/non-live videos can be
removed with ``--apply``; transient extractor/network failures are kept unless
``--remove-unknown`` is explicitly supplied.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "cameras.json"
DEFAULT_REPORT = ROOT / "data" / "youtube_audit_report.json"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

TRANSIENT_ERROR_TERMS = (
    "429",
    "502",
    "503",
    "504",
    "cookies",
    "timed out",
    "timeout",
    "not a bot",
    "sign in to confirm",
    "temporarily",
    "temporary failure",
    "connection reset",
    "connection aborted",
    "remote end closed connection",
    "unable to download webpage",
    "transportendpoint",
)


@dataclasses.dataclass
class AuditResult:
    index: int
    video_id: str
    name: str
    status: str
    reason: str
    title: str = ""
    channel: str = ""
    live_status: str = ""
    is_live: bool | None = None
    extractor: str = "yt-dlp"
    attempts: int = 0

    def to_report(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, value: Any, *, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True, indent=indent)
        if indent is not None:
            f.write("\n")


def is_transient_error(message: str) -> bool:
    lowered = message.lower()
    return any(term in lowered for term in TRANSIENT_ERROR_TERMS)


def has_playable_format(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("url") or metadata.get("formats") or metadata.get("requested_formats"))


def audit_camera(index: int, camera: dict[str, Any], retries: int, timeout: int) -> AuditResult:
    import discover_youtube_cameras as ytd

    video_id = str(camera.get("url") or "").strip()
    name = str(camera.get("name") or "")
    if not VIDEO_ID_RE.fullmatch(video_id):
        return AuditResult(index, video_id, name, "failed", "invalid_video_id", attempts=0)

    last_error = ""
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            metadata = ytd.run_ytdlp_metadata(video_id, timeout=timeout)
        except Exception as exc:
            last_error = str(exc)
            if attempt < attempts and is_transient_error(last_error):
                time.sleep(2 * attempt)
                continue
            status = "unknown" if is_transient_error(last_error) else "failed"
            return AuditResult(index, video_id, name, status, compact_error(last_error), attempts=attempt)

        live_status = str(metadata.get("live_status") or "")
        is_live = metadata.get("is_live")
        title = str(metadata.get("title") or "")
        channel = str(metadata.get("channel") or metadata.get("uploader") or "")
        if is_live is not True and live_status != "is_live":
            return AuditResult(
                index,
                video_id,
                name,
                "failed",
                f"not_live:{live_status or is_live}",
                title=title,
                channel=channel,
                live_status=live_status,
                is_live=is_live if isinstance(is_live, bool) else None,
                attempts=attempt,
            )
        if not has_playable_format(metadata):
            return AuditResult(
                index,
                video_id,
                name,
                "failed",
                "no_playable_formats",
                title=title,
                channel=channel,
                live_status=live_status,
                is_live=is_live if isinstance(is_live, bool) else None,
                attempts=attempt,
            )
        return AuditResult(
            index,
            video_id,
            name,
            "ok",
            "playable_live",
            title=title,
            channel=channel,
            live_status=live_status,
            is_live=is_live if isinstance(is_live, bool) else None,
            attempts=attempt,
        )

    return AuditResult(index, video_id, name, "unknown", compact_error(last_error), attempts=attempts)


def compact_error(message: str) -> str:
    message = re.sub(r"\s+", " ", message).strip()
    if len(message) > 260:
        return message[:257].rstrip() + "..."
    return message


def audit_all(cameras: list[dict[str, Any]], args: argparse.Namespace) -> list[AuditResult]:
    youtube = [(index, cam) for index, cam in enumerate(cameras) if cam.get("type") == "youtube"]
    if args.limit:
        youtube = youtube[: args.limit]
    results: list[AuditResult] = []
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = [
            executor.submit(audit_camera, index, camera, args.retries, args.timeout)
            for index, camera in youtube
        ]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            completed += 1
            if completed % args.progress_every == 0 or completed == len(futures):
                counts = Counter(item.status for item in results)
                print(
                    f"Audited {completed}/{len(futures)} "
                    f"ok={counts.get('ok', 0)} failed={counts.get('failed', 0)} unknown={counts.get('unknown', 0)}",
                    flush=True,
                )
    return sorted(results, key=lambda item: item.index)


def apply_removals(
    cameras: list[dict[str, Any]],
    results: list[AuditResult],
    *,
    remove_unknown: bool,
    data_file: Path,
) -> int:
    remove_statuses = {"failed"}
    if remove_unknown:
        remove_statuses.add("unknown")
    remove_ids = {result.video_id for result in results if result.status in remove_statuses}
    if not remove_ids:
        return 0
    kept = [
        cam
        for cam in cameras
        if not (cam.get("type") == "youtube" and str(cam.get("url") or "") in remove_ids)
    ]
    save_json(data_file, kept)
    return len(cameras) - len(kept)


def dataset_summary(cameras: list[dict[str, Any]]) -> dict[str, Any]:
    youtube = [cam for cam in cameras if cam.get("type") == "youtube"]
    return {
        "dataset_total": len(cameras),
        "type_counts": dict(sorted(Counter(str(cam.get("type") or "") for cam in cameras).items())),
        "youtube_total": len(youtube),
        "duplicate_youtube_ids": sum(1 for count in Counter(str(cam.get("url") or "") for cam in youtube).values() if count > 1),
        "bad_youtube_ids": sum(
            1
            for cam in youtube
            if not VIDEO_ID_RE.fullmatch(str(cam.get("url") or ""))
        ),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--apply", action="store_true", help="remove confirmed failed YouTube rows from data")
    parser.add_argument("--remove-unknown", action="store_true", help="also remove transient/unknown failures")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=75)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0, help="audit only the first N YouTube rows")
    parser.add_argument("--progress-every", type=int, default=25)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    cameras = load_json(args.data)
    if not isinstance(cameras, list):
        raise RuntimeError(f"{args.data} does not contain a JSON array")

    before = dataset_summary(cameras)
    print(f"YouTube rows to audit: {before['youtube_total'] if not args.limit else min(args.limit, before['youtube_total'])}")
    results = audit_all(cameras, args)
    removed = apply_removals(cameras, results, remove_unknown=args.remove_unknown, data_file=args.data) if args.apply else 0
    after_cameras = load_json(args.data) if removed else cameras
    after = dataset_summary(after_cameras)
    status_counts = Counter(result.status for result in results)
    reason_counts = Counter(result.reason for result in results if result.status != "ok")
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "applied": args.apply,
        "remove_unknown": args.remove_unknown,
        "removed": removed,
        "summary": {
            "audited": len(results),
            "status_counts": dict(sorted(status_counts.items())),
            "top_failure_reasons": reason_counts.most_common(25),
            "before": before,
            "after": after,
        },
        "failed": [result.to_report() for result in results if result.status == "failed"],
        "unknown": [result.to_report() for result in results if result.status == "unknown"],
        "ok_sample": [result.to_report() for result in results if result.status == "ok"][:25],
    }
    save_json(args.report, report, indent=2)
    print(
        "Summary: "
        f"audited={len(results)} ok={status_counts.get('ok', 0)} "
        f"failed={status_counts.get('failed', 0)} unknown={status_counts.get('unknown', 0)} "
        f"removed={removed} youtube_after={after['youtube_total']} total_after={after['dataset_total']}"
    )
    print(f"Report: {args.report}")
    if after["duplicate_youtube_ids"] or after["bad_youtube_ids"]:
        print(f"Dataset validation failed: {after}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
