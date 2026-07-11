from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import discover_city_livestreams as city  # noqa: E402
import discover_youtube_cameras as youtube  # noqa: E402


def seed_camera():
    return {
        "id": 1,
        "name": "Seed",
        "lat": 40.0,
        "lon": -75.0,
        "url": "https://example.com/seed.jpg",
        "type": "image",
        "state": "Test",
        "county": "",
        "direction": "",
        "source": "dot",
    }


def city_record(geoid: str, name: str):
    return city.CityRecord(geoid, f"{name}, Test", name, name, "Test", "TS", 40.0, -75.0, "", "A")


class CityCheckpointTests(unittest.TestCase):
    def run_batch(
        self,
        directory: Path,
        records,
        *,
        apply: bool,
        limit_add: int = 0,
        harvest=None,
        verify=None,
    ):
        data = directory / "cameras.json"
        city_json = directory / "cities.json"
        checkpoint = directory / "checkpoint.json"
        report = directory / "report.json"
        city_json.write_text("[]", encoding="utf-8")
        arguments = [
            "--data", str(data), "--city-json", str(city_json), "--checkpoint", str(checkpoint),
            "--report", str(report), "--resume", "--query-template", "{label}",
            "--sleep", "0", "--verify-sleep", "0",
        ]
        if apply:
            arguments.append("--apply")
        if limit_add:
            arguments.extend(["--limit-add", str(limit_add)])
        with (
            mock.patch.object(city, "load_city_records", return_value=records),
            mock.patch.object(youtube, "harvest_query", side_effect=harvest or (lambda *args: [])),
            mock.patch.object(city, "score_city_candidate", return_value=(True, 10, ["test"])),
            mock.patch.object(
                youtube,
                "verify_live",
                side_effect=verify or (lambda candidate, _sleep: candidate),
            ),
            mock.patch.object(youtube, "clean_camera_name", side_effect=lambda candidate: candidate.title),
        ):
            self.assertEqual(0, city.main(arguments))

    def test_dry_run_leaves_dataset_and_checkpoint_byte_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            data = directory / "cameras.json"
            checkpoint = directory / "checkpoint.json"
            data.write_text(json.dumps([seed_camera()]), encoding="utf-8")
            checkpoint.write_text('{"processed_geoids":[],"accepted_video_ids":[]}', encoding="utf-8")
            before_data = data.read_bytes()
            before_checkpoint = checkpoint.read_bytes()
            self.run_batch(directory, [city_record("1", "Alpha")], apply=False)
            self.assertEqual(before_data, data.read_bytes())
            self.assertEqual(before_checkpoint, checkpoint.read_bytes())

    def test_limit_checkpoints_only_the_stream_actually_committed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            data = directory / "cameras.json"
            checkpoint = directory / "checkpoint.json"
            data.write_text(json.dumps([seed_camera()]), encoding="utf-8")
            checkpoint.write_text('{"processed_geoids":[],"accepted_video_ids":[]}', encoding="utf-8")

            def harvest(query, *_args):
                video_id = "AAAAAAAAAAA" if query.startswith("Alpha") else "BBBBBBBBBBB"
                return [youtube.Candidate(video_id=video_id, title=query, score=10, reasons=["test"])]

            records = [city_record("1", "Alpha"), city_record("2", "Beta")]
            self.run_batch(directory, records, apply=True, limit_add=1, harvest=harvest)
            state = json.loads(checkpoint.read_text(encoding="utf-8"))
            self.assertEqual(["AAAAAAAAAAA"], state["accepted_video_ids"])
            self.assertEqual(["1"], state["processed_geoids"])
            self.assertEqual(2, len(json.loads(data.read_text(encoding="utf-8"))))

    def test_verification_exception_keeps_city_retryable(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            data = directory / "cameras.json"
            checkpoint = directory / "checkpoint.json"
            data.write_text(json.dumps([seed_camera()]), encoding="utf-8")
            checkpoint.write_text('{"processed_geoids":[],"accepted_video_ids":[]}', encoding="utf-8")

            def harvest(*_args):
                return [youtube.Candidate(video_id="AAAAAAAAAAA", title="Alpha", score=10, reasons=["test"])]

            def fail_verify(*_args):
                raise RuntimeError("transient extractor failure")

            self.run_batch(
                directory,
                [city_record("1", "Alpha")],
                apply=True,
                harvest=harvest,
                verify=fail_verify,
            )
            state = json.loads(checkpoint.read_text(encoding="utf-8"))
            self.assertEqual([], state["processed_geoids"])
            self.assertEqual([], state["accepted_video_ids"])

    def test_checkpoint_update_unions_with_concurrent_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.json"
            checkpoint.write_text(
                '{"processed_geoids":["other"],"accepted_video_ids":["CCCCCCCCCCC"]}',
                encoding="utf-8",
            )
            state = city.update_checkpoint_file(checkpoint, {"local"}, {"AAAAAAAAAAA"})
            self.assertEqual(["local", "other"], state["processed_geoids"])
            self.assertEqual(["AAAAAAAAAAA", "CCCCCCCCCCC"], state["accepted_video_ids"])


if __name__ == "__main__":
    unittest.main()
