from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import package_release  # noqa: E402


class PackageReleaseTests(unittest.TestCase):
    def write_surface_fixture(self, root: Path, version: str = "1.2.3", cache: int = 41) -> None:
        (root / "js").mkdir()
        (root / "scripts").mkdir()
        (root / "package.json").write_text(json.dumps({"name": "stormscope", "version": version}) + "\n")
        (root / "package-lock.json").write_text(json.dumps({
            "version": version, "packages": {"": {"version": version}}
        }) + "\n")
        (root / "js" / "app.js").write_text(f"var APP_VERSION = '{version}';\n")
        (root / "sw.js").write_text(f"var VERSION = 'v{cache}';\n")
        (root / "README.md").write_text(f"[version-{version}-blue]\n")
        (root / "CHANGELOG.md").write_text(
            f"# Changelog\n\n## v{version} - 2026-07-13\n\n- Prior release. SW v{cache}.\n\n## Unreleased\n\n"
        )
        for relative in package_release.USER_AGENT_FILES:
            (root / relative).write_text(f"USER_AGENT = 'StormScope/{version}'\n")

    def test_checked_in_version_surfaces_match(self) -> None:
        version = package_release.current_version()
        package_release.validate_version_surfaces(version)

    def test_deterministic_archive_has_fixed_metadata_and_verified_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_text("alpha\n", encoding="utf-8")
            (root / "b.txt").write_text("beta\n", encoding="utf-8")
            outputs = [root / "one.zip", root / "two.zip"]
            paths = ["a.txt", "b.txt"]
            with (
                mock.patch.object(package_release, "ROOT", root),
                mock.patch.object(package_release, "tracked_modes", return_value={path: 0o644 for path in paths}),
            ):
                manifests = [package_release.write_archive(output, "1.2.3", "abc123", paths) for output in outputs]
                digests = [package_release.validate_archive(output, manifest) for output, manifest in zip(outputs, manifests)]
            self.assertEqual(digests[0], digests[1])
            self.assertEqual(hashlib.sha256(outputs[0].read_bytes()).digest(), hashlib.sha256(outputs[1].read_bytes()).digest())
            with zipfile.ZipFile(outputs[0]) as archive:
                self.assertEqual(paths + [package_release.MANIFEST_NAME], archive.namelist())
                embedded = json.loads(archive.read(package_release.MANIFEST_NAME))
                self.assertEqual("abc123", embedded["commit"])
                self.assertTrue(all(info.date_time == package_release.FIXED_ZIP_TIME for info in archive.infolist()))

    def test_stale_artifacts_require_explicit_clean(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dist = Path(directory) / "dist"
            dist.mkdir()
            (dist / "old.zip").write_bytes(b"old")
            with (
                mock.patch.object(package_release, "ROOT", Path(directory)),
                mock.patch.object(package_release, "DIST", dist),
            ):
                with self.assertRaisesRegex(package_release.PackagingError, "Stale dist artifacts"):
                    package_release.prepare_dist(False)
                package_release.prepare_dist(True)
            self.assertEqual([], list(dist.iterdir()))

    def test_existing_release_tag_must_point_to_head(self) -> None:
        def fake_git(*arguments: str, check: bool = True) -> str:
            del check
            if arguments[0] == "status":
                return ""
            if arguments == ("rev-parse", "HEAD"):
                return "current"
            if arguments[:2] == ("rev-parse", "--verify"):
                return "stale"
            return "v1.2.3"

        with mock.patch.object(package_release, "run_git", side_effect=fake_git):
            with self.assertRaisesRegex(package_release.PackagingError, "Stale tag"):
                package_release.validate_repository_state("1.2.3")

    def test_prepare_dry_run_is_non_mutating_then_updates_every_surface(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_surface_fixture(root)
            before = {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}
            with (
                mock.patch.object(package_release, "ROOT", root),
                mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            ):
                package_release.prepare_release("1.3.0", "2026-07-14", ["Prepared release"], True)
                self.assertIn("no files changed", output.getvalue())
                self.assertEqual(before, {
                    path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
                })
                package_release.prepare_release("1.3.0", "2026-07-14", ["Prepared release"], False)
                package_release.validate_version_surfaces("1.3.0")
            self.assertIn("SW v42", (root / "CHANGELOG.md").read_text())
            self.assertIn("v42", (root / "sw.js").read_text())

    def test_atomic_surface_write_rolls_back_a_partial_replace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.txt"
            second = root / "second.txt"
            first.write_text("first-old")
            second.write_text("second-old")
            real_replace = package_release.os.replace
            calls = 0

            def fail_second_replace(source, destination):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("fixture replace failure")
                return real_replace(source, destination)

            with mock.patch.object(package_release.os, "replace", side_effect=fail_second_replace):
                with self.assertRaisesRegex(OSError, "fixture replace failure"):
                    package_release.atomic_write_texts({first: "first-new", second: "second-new"})
            self.assertEqual("first-old", first.read_text())
            self.assertEqual("second-old", second.read_text())


if __name__ == "__main__":
    unittest.main()
