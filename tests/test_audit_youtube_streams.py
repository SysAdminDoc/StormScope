from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import audit_youtube_streams as audit  # noqa: E402
import camera_data  # noqa: E402


def youtube_camera(camera_id: int, video_id: str, *, verified_at: str | None = None):
    value = {
        "id": camera_id,
        "name": f"Camera {camera_id}",
        "lat": 40.0,
        "lon": -75.0,
        "url": video_id,
        "type": "youtube",
        "state": "Test",
        "county": "",
        "direction": "",
        "source": "youtube",
    }
    if verified_at:
        value.update(
            camera_data.healthy_metadata(
                camera_data.canonical_source_url("youtube", video_id),
                verified_at=verified_at,
            )
        )
    else:
        value.update(camera_data.unknown_metadata(camera_data.canonical_source_url("youtube", video_id)))
    return value


class AuditMetadataTests(unittest.TestCase):
    def test_targeted_audit_selects_only_requested_video_ids(self):
        cameras = [
            youtube_camera(1, "AAAAAAAAAAA"),
            youtube_camera(2, "BBBBBBBBBBB"),
            youtube_camera(3, "CCCCCCCCCCC"),
        ]
        args = SimpleNamespace(
            video=["BBBBBBBBBBB"],
            limit=0,
            workers=1,
            retries=0,
            timeout=1,
            progress_every=1,
        )
        with mock.patch.object(
            audit,
            "audit_camera",
            side_effect=lambda index, camera, _retries, _timeout: audit.AuditResult(
                index, camera["url"], camera["name"], "ok", "playable_live"
            ),
        ) as inspect:
            results = audit.audit_all(cameras, args)
        self.assertEqual(["BBBBBBBBBBB"], [result.video_id for result in results])
        self.assertEqual(1, inspect.call_count)

    def test_success_updates_health_transient_degrades_and_only_confirmed_failure_removes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cameras.json"
            previous_success = "2026-01-01T00:00:00Z"
            cameras = [
                youtube_camera(1, "AAAAAAAAAAA"),
                youtube_camera(2, "BBBBBBBBBBB", verified_at=previous_success),
                youtube_camera(3, "CCCCCCCCCCC"),
            ]
            path.write_text(json.dumps(cameras), encoding="utf-8")
            results = [
                audit.AuditResult(0, "AAAAAAAAAAA", "A", "ok", "playable_live"),
                audit.AuditResult(1, "BBBBBBBBBBB", "B", "unknown", "timeout"),
                audit.AuditResult(2, "CCCCCCCCCCC", "C", "failed", "not_live"),
            ]
            removed = audit.apply_removals(
                cameras,
                results,
                remove_unknown=True,
                data_file=path,
            )
            self.assertEqual(1, removed)
            updated = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(2, len(updated))
            self.assertEqual("healthy", updated[0]["health"])
            self.assertIsNotNone(updated[0]["last_verified"])
            self.assertIsNone(updated[0]["failure_class"])
            self.assertEqual("degraded", updated[1]["health"])
            self.assertEqual("transient", updated[1]["failure_class"])
            self.assertEqual(previous_success, updated[1]["last_verified"])
            self.assertEqual("BBBBBBBBBBB", updated[1]["url"])


if __name__ == "__main__":
    unittest.main()
