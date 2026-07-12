from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_camera_shards  # noqa: E402
import camera_data  # noqa: E402


def camera(camera_id: int):
    value = {
        "id": camera_id,
        "name": f"Camera {camera_id}",
        "lat": 40 + camera_id / 100,
        "lon": -75 - camera_id / 100,
        "url": f"https://example.com/{camera_id}.jpg",
        "type": "image",
        "state": "Test",
        "county": "",
        "direction": "",
        "source": "dot",
    }
    value.update(camera_data.unknown_metadata(value["url"]))
    return value


class CameraShardBuilderTests(unittest.TestCase):
    def test_builder_is_deterministic_bounded_and_reconstructs_every_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_file = root / "cameras.json"
            index_file = root / "cameras.index.json"
            shard_dir = root / "camera-shards"
            data_file.write_text(json.dumps([camera(3), camera(1), camera(5), camera(2), camera(4)]), encoding="utf-8")

            manifest = build_camera_shards.build_shards(
                data_file, index_file, shard_dir, shard_size=2
            )
            first_bytes = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in [index_file, *sorted(shard_dir.glob("*.json"))]
            }
            second_manifest = build_camera_shards.build_shards(
                data_file, index_file, shard_dir, shard_size=2
            )
            second_bytes = {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in [index_file, *sorted(shard_dir.glob("*.json"))]
            }

            self.assertEqual(manifest, second_manifest)
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(5, manifest["total"])
            self.assertTrue(all(descriptor["count"] <= 2 for descriptor in manifest["shards"]))
            rebuilt = []
            for descriptor in manifest["shards"]:
                rebuilt.extend(json.loads((index_file.parent / descriptor["path"]).read_text(encoding="utf-8")))
            self.assertEqual([1, 2, 3, 4, 5], [item["id"] for item in rebuilt])
            camera_data.validate_camera_data(rebuilt)

    def test_checked_in_manifest_and_shards_cover_the_schema_v2_dataset(self):
        manifest = json.loads((ROOT / "data" / "cameras.index.json").read_text(encoding="utf-8"))
        self.assertEqual(camera_data.CAMERA_SCHEMA_VERSION, manifest["camera_schema_version"])
        self.assertEqual(33_634, manifest["total"])
        self.assertTrue(all(descriptor["count"] <= build_camera_shards.MAX_SHARD_SIZE for descriptor in manifest["shards"]))
        ids = []
        for descriptor in manifest["shards"]:
            shard = json.loads((ROOT / "data" / descriptor["path"]).read_text(encoding="utf-8"))
            self.assertEqual(descriptor["count"], len(shard))
            ids.extend(camera["id"] for camera in shard)
        self.assertEqual(list(range(1, 33_635)), ids)


if __name__ == "__main__":
    unittest.main()
