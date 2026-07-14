"""Provider adapter boundary and legacy-compatibility tests."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_cameras  # noqa: E402
from providers import (  # noqa: E402
    FunctionProviderAdapter,
    ProviderAdapter,
    ProviderRegistry,
    ProviderResult,
    ProviderRuntime,
)
from providers.geospatial import IterisConfig, collect_iteris_geojson  # noqa: E402
from providers.traveler import (  # noqa: E402
    CarsGraphqlConfig,
    DataTablesConfig,
    MapIconsConfig,
    NewEnglandDataTablesConfig,
    collect_cars_graphql,
    collect_datatables,
    collect_mapicons,
    collect_new_england_datatables,
)


class ProviderAdapterTests(unittest.TestCase):
    def test_provider_result_is_atomic_and_fail_closed(self):
        self.assertTrue(ProviderResult("Provider", [{"id": 1}]).succeeded)
        self.assertFalse(ProviderResult("Provider", [], "timeout").succeeded)
        with self.assertRaisesRegex(ValueError, "partial"):
            ProviderResult("Provider", [{"id": 1}], "timeout")

    def test_registry_preserves_order_and_legacy_substring_selection(self):
        adapters = [
            FunctionProviderAdapter("Alpha DOT", "first-party-feed", lambda: 1),
            FunctionProviderAdapter("Beta 511", "traveler-api", lambda: 1),
            FunctionProviderAdapter("Beta Parks", "verified-curated", lambda: 1),
        ]
        registry = ProviderRegistry(adapters)
        self.assertEqual([adapter.name for adapter in registry.all()], [
            "Alpha DOT", "Beta 511", "Beta Parks",
        ])
        self.assertEqual([adapter.name for adapter in registry.select(["511", "Alpha"])], [
            "Beta 511", "Alpha DOT",
        ])
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            registry.select(["Beta"])
        self.assertIsInstance(adapters[0], ProviderAdapter)

    def test_adapter_enforces_runner_result_identity(self):
        adapter = FunctionProviderAdapter("Provider A", "test", lambda: 1)
        self.assertEqual(adapter.fetch(lambda name, collector: ProviderResult(name, [], "offline")).error, "offline")
        with self.assertRaisesRegex(TypeError, "contract"):
            adapter.fetch(lambda _name, _collector: ProviderResult("Wrong", [{"id": 1}]))

    def test_live_registry_wraps_every_legacy_provider_in_exact_order(self):
        legacy = fetch_cameras.provider_fetchers()
        adapters = fetch_cameras.provider_adapters(legacy).all()
        self.assertEqual([adapter.name for adapter in adapters], [name for name, _collector in legacy])
        self.assertEqual([adapter.collector for adapter in adapters], [collector for _name, collector in legacy])
        self.assertTrue(all(adapter.family for adapter in adapters))

    def test_live_protocol_families_and_cli_selection_are_explicit(self):
        registry = fetch_cameras.provider_adapters()
        by_name = {adapter.name: adapter.family for adapter in registry.all()}
        self.assertEqual(len(by_name), 78)
        self.assertEqual(by_name["Florida (FL511)"], "traveler-mapicons")
        self.assertEqual(by_name["Georgia DOT (DataTables)"], "traveler-datatables")
        self.assertEqual(by_name["Montana (Iteris)"], "geospatial-iteris")
        self.assertEqual(by_name["South Carolina (SkyVDN)"], "geospatial-stream")
        self.assertEqual(by_name["Kansas (KanDrive)"], "traveler-cars-graphql")
        self.assertEqual(
            [adapter.name for adapter in registry.select(["OKTraffic", "Caltrans", "OKTraffic"])],
            ["Oklahoma (OKTraffic)", "Caltrans (California)"],
        )
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            registry.select(["NPS"])
        with self.assertRaisesRegex(ValueError, "unknown"):
            registry.select(["not-a-provider"])

    def test_adapter_wrapping_is_byte_equivalent_before_provider_changes(self):
        legacy = [
            ("Provider A", lambda: 1),
            ("Provider B", lambda: 1),
        ]
        rows = {
            "Provider A": [{"id": 2, "name": "A", "provider": "Provider A"}],
            "Provider B": [{"id": 3, "name": "B", "provider": "Provider B"}],
        }

        def runner(name, _collector):
            return ProviderResult(name, json.loads(json.dumps(rows[name])))

        legacy_payload = json.dumps([runner(name, collector).__dict__ for name, collector in legacy], sort_keys=True)
        registry = ProviderRegistry([
            FunctionProviderAdapter(name, "test", collector) for name, collector in legacy
        ])
        adapter_payload = json.dumps([
            adapter.fetch(runner).__dict__ for adapter in registry.all()
        ], sort_keys=True)
        self.assertEqual(adapter_payload.encode(), legacy_payload.encode())

    def test_successful_legacy_runner_stamps_the_ingestion_source(self):
        fetch_cameras.cameras.clear()

        def collector():
            fetch_cameras.cameras.append({"name": "Camera"})
            return 1

        result = fetch_cameras.run_fetcher("Provider A", collector)
        self.assertEqual("Provider A", result.cameras[0]["ingestion_source"])


class ProviderFamilyTests(unittest.TestCase):
    def runtime(self, *, fetch_json=None, post_json=None, http_bytes=None):
        self.rows = []
        return ProviderRuntime(
            fetch_json=fetch_json or mock.Mock(),
            post_json=post_json or mock.Mock(),
            http_bytes=http_bytes or mock.Mock(),
            add_camera=lambda *args: self.rows.append(args),
            detect_type=lambda url: "hls" if url.endswith(".m3u8") else "image",
            log=mock.Mock(),
        )

    def test_mapicons_family_emits_exact_legacy_shape_and_fails_closed(self):
        runtime = self.runtime(fetch_json=mock.Mock(return_value={"item2": [
            {"itemId": "7", "title": "I-5", "location": [47.1, -122.2]},
            {"itemId": "bad", "location": [1]},
        ]}))
        self.assertEqual(collect_mapicons(runtime, MapIconsConfig("https://511.test", "Test")), 1)
        self.assertEqual(self.rows, [(
            "I-5", 47.1, -122.2, "https://511.test/map/Cctv/7",
            "image", "Test", "", "", "dot",
        )])
        failing = self.runtime(fetch_json=mock.Mock(side_effect=OSError("offline")))
        self.assertEqual(collect_mapicons(failing, MapIconsConfig("https://511.test", "Test")), 0)
        self.assertEqual(self.rows, [])

    def test_datatables_family_paginates_by_returned_rows(self):
        pages = [
            {"recordsTotal": 2, "data": [{
                "location": "Main", "latLng": {"geography": {"wellKnownText": "POINT (-84.1 33.7)"}},
                "images": [{"imageUrl": "/camera.jpg"}],
            }]},
            {"recordsTotal": 2, "data": [{
                "roadway": "Second", "latLng": {"geography": {"wellKnownText": "POINT (-84.2 33.8)"}},
                "images": [{"blocked": True, "imageUrl": "/blocked.jpg"}, {"imageUrl": "https://cdn/2.jpg"}],
            }]},
        ]
        post_json = mock.Mock(side_effect=pages)
        runtime = self.runtime(post_json=post_json)
        config = DataTablesConfig("https://511.test", "Georgia", "https://511.test/cctv")
        self.assertEqual(collect_datatables(runtime, config), 2)
        self.assertEqual([row[0] for row in self.rows], ["Main", "Second"])
        self.assertEqual([row[3] for row in self.rows], ["https://511.test/camera.jpg", "https://cdn/2.jpg"])
        self.assertEqual(post_json.call_args_list[1].args[1]["start"], 1)

    def test_new_england_datatables_keeps_feed_state_and_metadata(self):
        payload = {"recordsTotal": 1, "data": [{
            "state": "Maine", "location": "I-95", "county": "York", "direction": "N",
            "latLng": {"geography": {"wellKnownText": "POINT (-70.7 43.2)"}},
            "images": [{"disabled": False, "blocked": False, "imageUrl": "/still.jpg"}],
        }]}
        runtime = self.runtime(http_bytes=mock.Mock(return_value=json.dumps(payload).encode()))
        self.assertEqual(
            collect_new_england_datatables(runtime, NewEnglandDataTablesConfig()),
            1,
        )
        self.assertEqual(self.rows[0], (
            "I-95", 43.2, -70.7, "https://www.newengland511.org/still.jpg",
            "image", "Maine", "York", "N", "dot",
            "https://www.newengland511.org/cctv", 10,
        ))

    def test_iteris_family_supports_nested_and_flat_camera_records(self):
        runtime = self.runtime(fetch_json=mock.Mock(return_value={"features": [
            {"geometry": {"coordinates": [-110.0, 45.0]}, "properties": {
                "description": "Nested", "cameras": [{"https_url": "https://cdn/live.m3u8", "direction": "N"}],
            }},
            {"geometry": {"coordinates": [-111.0, 46.0]}, "properties": {
                "description": "Flat", "image": "https://cdn/still.jpg",
            }},
        ]}))
        self.assertEqual(collect_iteris_geojson(runtime, IterisConfig("MT", "Montana")), 2)
        self.assertEqual([row[0] for row in self.rows], ["Nested", "Flat"])
        self.assertEqual([row[4] for row in self.rows], ["hls", "image"])

    def test_cars_family_deduplicates_and_strips_transient_query(self):
        marker = {
            "__typename": "Camera", "active": True, "uri": "camera:1", "title": "US-1",
            "views": [{"url": "https://cdn/camera.jpg?token=short"}],
            "features": [{"geometry": {"coordinates": [-97.0, 39.0]}}],
        }
        payload = {"data": {"mapFeaturesQuery": {"mapFeatures": [marker, marker]}}}
        runtime = self.runtime(http_bytes=mock.Mock(return_value=json.dumps(payload).encode()))
        config = CarsGraphqlConfig(
            "https://cars.test", "Kansas",
            {"north": 40.1, "south": 36.9, "east": -94.5, "west": -102.1},
            "https://cars.test/",
        )
        self.assertEqual(collect_cars_graphql(runtime, config), 1)
        self.assertEqual(self.rows[0][3], "https://cdn/camera.jpg")
        self.assertEqual(self.rows[0][-2:], ("https://cars.test/", 60))


if __name__ == "__main__":
    unittest.main()
