from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_radar_config as radar_config  # noqa: E402


def enabled_config() -> dict:
    return {
        "schema_version": 1,
        "enabled": True,
        "discovery_url": "https://radar.example.test/api/weather-maps.json",
        "tile_origins": ["https://tiles.example.test", "https://tiles2.example.test:8443/"],
        "attribution": {"label": "Example Radar", "url": "https://example.test/radar"},
        "capabilities": {
            "max_zoom": 10,
            "freshness": {"stale_after_minutes": 12, "fail_after_minutes": 30},
            "history": {"enabled": True, "window_minutes": 120},
        },
    }


class BuildRadarConfigTests(unittest.TestCase):
    def test_checked_in_config_is_disabled_and_generated_output_matches(self) -> None:
        config = radar_config.load_config(radar_config.DEFAULT_CONFIG)
        self.assertEqual(
            {
                "schemaVersion": 1,
                "enabled": False,
                "providerId": radar_config.PROVIDER_ID,
                "protocol": "rainviewer-v2",
            },
            config,
        )
        self.assertEqual(radar_config.render_javascript(config), radar_config.DEFAULT_OUTPUT.read_text(encoding="utf-8"))

    def test_enabled_config_normalizes_fixed_identity_and_capabilities(self) -> None:
        config = radar_config.normalize_config(enabled_config())
        self.assertEqual("build-radar", config["providerId"])
        self.assertEqual("rainviewer-v2", config["protocol"])
        self.assertEqual("https://radar.example.test/api/weather-maps.json", config["discoveryUrl"])
        self.assertEqual(["https://tiles.example.test", "https://tiles2.example.test:8443"], config["tileOrigins"])
        self.assertEqual(10, config["capabilities"]["maxZoom"])
        self.assertEqual(120, config["capabilities"]["history"]["windowMinutes"])

    def test_unsafe_endpoint_forms_are_rejected(self) -> None:
        invalid_urls = (
            "http://radar.example.test/api",
            "https://user:secret@radar.example.test/api",
            "https://radar.example.test/api?token=secret",
            "https://radar.example.test/api#fragment",
            "https://*.example.test/api",
            "https://radar.example.test/api\nheader: value",
        )
        for value in invalid_urls:
            config = enabled_config()
            config["discovery_url"] = value
            with self.subTest(value=value), self.assertRaises(radar_config.RadarConfigError):
                radar_config.normalize_config(config)

    def test_tile_origins_must_be_explicit_https_origins(self) -> None:
        invalid_origins = (
            "http://tiles.example.test",
            "https://user:secret@tiles.example.test",
            "https://tiles.example.test/path",
            "https://tiles.example.test?token=secret",
            "https://*.example.test",
        )
        for value in invalid_origins:
            config = enabled_config()
            config["tile_origins"] = [value]
            with self.subTest(value=value), self.assertRaises(radar_config.RadarConfigError):
                radar_config.normalize_config(config)

    def test_invalid_capability_and_attribution_contracts_fail_closed(self) -> None:
        mutations = (
            lambda config: config["capabilities"].update(max_zoom=23),
            lambda config: config["capabilities"]["freshness"].update(fail_after_minutes=12),
            lambda config: config["capabilities"].update(history={"enabled": False, "window_minutes": 1}),
            lambda config: config["attribution"].update(label=""),
            lambda config: config["attribution"].update(url="javascript:alert(1)"),
            lambda config: config.update(provider_id="attacker-controlled"),
        )
        for mutate in mutations:
            config = enabled_config()
            mutate(config)
            with self.assertRaises(radar_config.RadarConfigError):
                radar_config.normalize_config(config)

    def test_csp_helpers_require_and_merge_exact_origins(self) -> None:
        config = radar_config.normalize_config(enabled_config())
        expected = (
            "https://radar.example.test",
            "https://tiles.example.test",
            "https://tiles2.example.test:8443",
        )
        self.assertEqual(expected, radar_config.required_connect_origins(config))
        csp = "default-src 'self'; connect-src 'self'; object-src 'none';"
        with self.assertRaisesRegex(radar_config.RadarConfigError, "missing"):
            radar_config.validate_csp(csp, config)
        merged = radar_config.merge_connect_src(csp, config)
        radar_config.validate_csp(merged, config)
        self.assertEqual(1, merged.count("https://radar.example.test"))
        self.assertEqual(merged, radar_config.merge_connect_src(merged, config))
        with self.assertRaisesRegex(radar_config.RadarConfigError, "wildcard"):
            radar_config.validate_csp(merged.replace("connect-src", "connect-src https://*.example.test"), config)
        with self.assertRaisesRegex(radar_config.RadarConfigError, "exactly one"):
            radar_config.validate_csp(merged + " connect-src https://radar.example.test;", config)

    def test_html_csp_render_is_explicit_and_non_destructive(self) -> None:
        config = radar_config.normalize_config(enabled_config())
        html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\';"><p>body</p>'
        with self.assertRaises(radar_config.RadarConfigError):
            radar_config.validate_html_csp(html, config)
        rendered = radar_config.render_html_with_csp(html, config)
        radar_config.validate_html_csp(rendered, config)
        self.assertTrue(rendered.endswith("<p>body</p>"))

    def test_generated_runtime_is_deeply_immutable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "radar.json"
            output_path = root / "radar-build-config.js"
            config_path.write_text(json.dumps(enabled_config()), encoding="utf-8")
            radar_config.build(config_path, output_path)
            probe = (
                "const c=require(process.argv[1]);"
                "if(!Object.isFrozen(c)||!Object.isFrozen(c.tileOrigins)||!Object.isFrozen(c.capabilities.history))process.exit(2);"
                "try{c.providerId='changed'}catch(e){};if(c.providerId!=='build-radar')process.exit(3);"
            )
            subprocess.run(["node", "-e", probe, str(output_path)], check=True)


if __name__ == "__main__":
    unittest.main()
