"""Reusable traveler-information camera feed protocol implementations."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .runtime import ProviderRuntime


@dataclass(frozen=True)
class MapIconsConfig:
    base_url: str
    state_name: str


@dataclass(frozen=True)
class DataTablesConfig:
    base_url: str
    state_name: str
    referer: str | None = None


@dataclass(frozen=True)
class NewEnglandDataTablesConfig:
    base_url: str = "https://www.newengland511.org"
    state_names: frozenset[str] = frozenset({"Maine", "New Hampshire", "Vermont"})


@dataclass(frozen=True)
class CarsGraphqlConfig:
    base_url: str
    state_name: str
    bbox: dict[str, float]
    source_page: str


CARS_MAP_QUERY = (
    "query MapFeatures($input: MapFeaturesArgs!){mapFeaturesQuery(input:$input)"
    "{mapFeatures{__typename uri title features{id geometry properties type}"
    " ... on Camera{active views(limit:3){uri category ... on CameraView{url}}}}"
    " error{message type}}}"
)


def collect_mapicons(runtime: ProviderRuntime, config: MapIconsConfig) -> int:
    """Collect the common 511 ``mapIcons/Cameras`` response shape."""
    try:
        data = runtime.fetch_json(f"{config.base_url}/map/mapIcons/Cameras")
        items = data.get("item2", data) if isinstance(data, dict) else data
        if not isinstance(items, list):
            return 0
        count = 0
        for item in items:
            location = item.get("location", [0, 0])
            if not isinstance(location, list) or len(location) < 2:
                continue
            item_id = item.get("itemId", "")
            name = item.get("title", "") or f"{config.state_name} Camera {item_id}"
            runtime.add_camera(
                name, location[0], location[1],
                f"{config.base_url}/map/Cctv/{item_id}", "image",
                config.state_name, "", "", "dot",
            )
            count += 1
        return count
    except Exception as error:
        runtime.log(f"  {config.state_name} 511: {error}")
        return 0


def collect_datatables(runtime: ProviderRuntime, config: DataTablesConfig) -> int:
    """Collect the common 511 DataTables/WKT response shape."""
    try:
        url = f"{config.base_url}/List/GetData/Cameras"
        headers = {}
        if config.referer:
            headers = {"Referer": config.referer, "Origin": config.base_url}
        all_rows = []
        start = 0
        page_size = 500
        while True:
            body = {"draw": start // page_size + 1, "start": start, "length": page_size}
            data = runtime.post_json(url, body, headers)
            rows = data.get("data", [])
            if not rows:
                break
            all_rows.extend(rows)
            start += len(rows)
            if start >= data.get("recordsTotal", 0):
                break
        count = 0
        for row in all_rows:
            try:
                wkt = row.get("latLng", {}).get("geography", {}).get("wellKnownText", "")
            except (AttributeError, TypeError):
                continue
            match = re.search(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", wkt)
            if not match:
                continue
            image_url = ""
            for image in row.get("images", []):
                if not image.get("blocked") and image.get("imageUrl"):
                    raw_url = image["imageUrl"]
                    image_url = config.base_url + raw_url if raw_url.startswith("/") else raw_url
                    break
            if not image_url:
                continue
            name = row.get("location", "") or row.get("roadway", "") or f"{config.state_name} Camera"
            runtime.add_camera(
                name, float(match.group(2)), float(match.group(1)), image_url,
                runtime.detect_type(image_url), config.state_name, "", "", "dot",
            )
            count += 1
        return count
    except Exception as error:
        runtime.log(f"  {config.state_name} DataTables: {error}")
        return 0


def collect_new_england_datatables(
    runtime: ProviderRuntime,
    config: NewEnglandDataTablesConfig,
) -> int:
    """Collect New England 511 while retaining its authoritative state labels."""
    try:
        all_rows = []
        start = 0
        while True:
            raw = runtime.http_bytes(
                config.base_url + "/List/GetData/Cameras",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": config.base_url + "/cctv",
                    "Origin": config.base_url,
                },
                data=f"draw=1&start={start}&length=100&search[value]=".encode("ascii"),
                method="POST",
                timeout=30,
            )
            payload = json.loads(raw)
            rows = payload.get("data", [])
            all_rows.extend(rows)
            start += 100
            if not rows or start >= payload.get("recordsTotal", 0):
                break
        count = 0
        for row in all_rows:
            state_name = row.get("state", "") or ""
            if state_name not in config.state_names:
                continue
            image_url = ""
            for image in row.get("images") or []:
                if not image.get("disabled") and not image.get("blocked") and image.get("imageUrl"):
                    raw_url = image["imageUrl"]
                    image_url = config.base_url + raw_url if raw_url.startswith("/") else raw_url
                    break
            if not image_url:
                continue
            try:
                wkt = row.get("latLng", {}).get("geography", {}).get("wellKnownText", "")
            except (AttributeError, TypeError):
                continue
            match = re.search(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", wkt)
            if not match:
                continue
            name = row.get("location", "") or row.get("roadway", "") or f"{state_name} Camera"
            runtime.add_camera(
                name, float(match.group(2)), float(match.group(1)), image_url, "image",
                state_name, row.get("county", "") or "", row.get("direction", "") or "",
                "dot", config.base_url + "/cctv", 10,
            )
            count += 1
        return count
    except Exception as error:
        runtime.log(f"  New England 511: {error}")
        return 0


def collect_cars_graphql(runtime: ProviderRuntime, config: CarsGraphqlConfig) -> int:
    """Collect the CARS/OneNetwork GraphQL camera response shape."""
    try:
        body = json.dumps({
            "query": CARS_MAP_QUERY,
            "variables": {"input": {**config.bbox, "zoom": 11, "layerSlugs": ["normalCameras"]}},
        }).encode("utf-8")
        payload = json.loads(runtime.http_bytes(
            config.base_url + "/api/graphql",
            headers={
                "Accept": "application/json", "Content-Type": "application/json",
                "Origin": config.base_url, "Referer": config.base_url + "/",
            },
            data=body, method="POST", timeout=40,
        ))
        features = ((payload.get("data") or {}).get("mapFeaturesQuery") or {}).get("mapFeatures") or []
        count = 0
        seen = set()
        for marker in features:
            if marker.get("__typename") != "Camera" or not marker.get("active"):
                continue
            uri = marker.get("uri")
            if uri in seen:
                continue
            views = marker.get("views") or []
            image_url = str(views[0].get("url")) if views and views[0] else ""
            image_url = image_url.split("?", 1)[0]
            if not image_url.startswith("https://"):
                continue
            geometry = ((marker.get("features") or [{}])[0].get("geometry") or {})
            coordinates = geometry.get("coordinates") or [0, 0]
            if not isinstance(coordinates, list) or len(coordinates) < 2:
                continue
            seen.add(uri)
            name = str(marker.get("title", "") or f"{config.state_name} Camera").strip()
            runtime.add_camera(
                name, coordinates[1], coordinates[0], image_url, "image",
                config.state_name, "", "", "dot", config.source_page, 60,
            )
            count += 1
        return count
    except Exception as error:
        runtime.log(f"  {config.state_name} CARS GraphQL: {error}")
        return 0
