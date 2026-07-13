"""Reusable geospatial camera feed protocol implementations."""

from __future__ import annotations

from dataclasses import dataclass

from .runtime import ProviderRuntime


@dataclass(frozen=True)
class IterisConfig:
    state_code: str
    state_name: str


def collect_iteris_geojson(runtime: ProviderRuntime, config: IterisConfig) -> int:
    """Collect the Iteris CDN camera GeoJSON response shape."""
    try:
        url = (
            f"https://{config.state_code.lower()}.cdn.iteris-atis.com/"
            "geojson/icons/metadata/icons.cameras.geojson"
        )
        data = runtime.fetch_json(url, timeout=20)
        count = 0
        for feature in data.get("features", []):
            coordinates = feature.get("geometry", {}).get("coordinates", [0, 0])
            properties = feature.get("properties", {})
            description = properties.get("description", "")
            camera_list = properties.get("cameras", [])
            if camera_list:
                for camera in camera_list:
                    name = camera.get("description", "") or camera.get("name", "") or description
                    image_url = camera.get("image", "") or camera.get("https_url", "") or camera.get("image_url", "")
                    if not image_url:
                        continue
                    runtime.add_camera(
                        name, coordinates[1], coordinates[0], image_url,
                        runtime.detect_type(image_url), config.state_name, "",
                        camera.get("direction", ""), "dot",
                    )
                    count += 1
            else:
                image_url = properties.get("image", "") or properties.get("url", "")
                if image_url:
                    runtime.add_camera(
                        description or f"{config.state_name} Camera",
                        coordinates[1], coordinates[0], image_url,
                        runtime.detect_type(image_url), config.state_name, "", "", "dot",
                    )
                    count += 1
        return count
    except Exception as error:
        runtime.log(f"  {config.state_name} Iteris: {error}")
        return 0
