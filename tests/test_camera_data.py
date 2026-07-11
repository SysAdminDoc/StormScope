from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import camera_data  # noqa: E402
import repair_camera_data  # noqa: E402


def camera(camera_id: int = 1, **overrides):
    value = {
        "id": camera_id,
        "name": f"Camera {camera_id}",
        "lat": 40.0,
        "lon": -75.0,
        "url": f"https://example.com/{camera_id}.jpg",
        "type": "image",
        "state": "Test",
        "county": "",
        "direction": "",
        "source": "dot",
    }
    value.update(overrides)
    value.update(
        camera_data.unknown_metadata(
            camera_data.canonical_source_url(str(value.get("type") or ""), str(value.get("url") or ""))
        )
    )
    value.update({key: field for key, field in overrides.items() if key in camera_data.REQUIRED_FIELDS})
    return value


class CameraDataTests(unittest.TestCase):
    def test_published_schema_version_matches_runtime_contract(self):
        schema = json.loads((ROOT / "data" / "cameras.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(camera_data.CAMERA_SCHEMA_VERSION, schema["x-camera-schema-version"])

    def test_repair_migrates_legacy_health_fields_without_claiming_verification(self):
        legacy = camera(7)
        for field in (
            "last_verified",
            "health",
            "failure_class",
            "source_url",
            "refresh_cadence_seconds",
        ):
            legacy.pop(field)
        repaired, _ = repair_camera_data.repair([legacy])
        self.assertEqual(1, len(repaired))
        self.assertEqual(1, repaired[0]["id"])
        self.assertIsNone(repaired[0]["last_verified"])
        self.assertEqual("unknown", repaired[0]["health"])
        self.assertIsNone(repaired[0]["failure_class"])
        self.assertEqual("https://example.com/7.jpg", repaired[0]["source_url"])
        self.assertIsNone(repaired[0]["refresh_cadence_seconds"])

    def test_repair_is_idempotent_and_does_not_treat_ids_as_broken(self):
        healthy = camera(4942)
        repaired, counts = repair_camera_data.repair([healthy])
        self.assertEqual([{**healthy, "id": 1}], repaired)
        self.assertEqual(0, counts["broken"])

        repaired_again, second_counts = repair_camera_data.repair(repaired)
        self.assertEqual(repaired, repaired_again)
        self.assertTrue(all(count == 0 for count in second_counts.values()))

    def test_validator_covers_security_and_identity_invariants(self):
        invalid = [
            camera(1, url="http://example.com/1.jpg"),
            camera(1, status="Inactive", type="embed", url="https://earthcam.com/view"),
            camera(3, type="embed", url="https://earthcam.com.evil.test/view"),
            camera(4, url="https://example.com:notaport/image.jpg"),
            camera(5, status="active"),
        ]
        with self.assertRaises(camera_data.CameraDataValidationError) as caught:
            camera_data.validate_camera_data(invalid)
        message = str(caught.exception)
        self.assertIn("duplicate id", message)
        self.assertIn("media URL must use https", message)
        self.assertIn("unsupported status", message)
        self.assertIn("is not allowed", message)
        self.assertIn("invalid media URL", message)

    def test_repair_upgrades_only_verified_urls_and_creates_rollback_backup(self):
        verified_http = next(iter(repair_camera_data.VERIFIED_HTTPS_UPGRADES))
        unknown_http = "http://legacy.example.com/camera.jpg"
        repaired, counts = repair_camera_data.repair(
            [camera(1, url=verified_http), camera(2, url=unknown_http)]
        )
        self.assertEqual(repair_camera_data.VERIFIED_HTTPS_UPGRADES[verified_http], repaired[0]["url"])
        self.assertEqual(unknown_http, repaired[1]["url"])
        self.assertEqual(1, counts["https"])
        self.assertEqual(1, counts["unverified_http"])

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cameras.json"
            original = [camera(1, url=verified_http)]
            path.write_text(json.dumps(original), encoding="utf-8")
            self.assertEqual(0, repair_camera_data.main(["--data", str(path), "--apply"]))
            backup = path.with_name("cameras.json.bak")
            self.assertTrue(backup.exists())
            self.assertEqual(original, json.loads(backup.read_text(encoding="utf-8")))

    def test_atomic_write_backup_and_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cameras.json"
            original = [camera()]
            replacement = [camera(2)]
            path.write_text(json.dumps(original), encoding="utf-8")
            camera_data.save_camera_data(path, replacement)
            self.assertEqual(replacement, json.loads(path.read_text(encoding="utf-8")))
            camera_data.restore_camera_data(path)
            self.assertEqual(original, json.loads(path.read_text(encoding="utf-8")))
            self.assertFalse(path.with_name("cameras.json.lock").exists())

    def test_failed_atomic_replace_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cameras.json"
            original = [camera()]
            path.write_text(json.dumps(original), encoding="utf-8")
            with mock.patch.object(camera_data.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    camera_data.save_camera_data(path, [camera(2)], create_backup=False)
            self.assertEqual(original, json.loads(path.read_text(encoding="utf-8")))
            self.assertEqual([], list(path.parent.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
