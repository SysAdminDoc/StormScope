"""
StormScope camera data fetcher.
Pulls cameras from multiple US state DOT APIs and merges into data/cameras.json.

Usage: python scripts/fetch_cameras.py
"""
import argparse
import concurrent.futures
import email.utils
import hashlib
import json
import gzip
import html
import itertools
import http.cookiejar
import re
import ssl
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

try:
    from camera_data import (
        CameraDataError,
        atomic_write_json,
        canonical_source_url,
        feed_identity,
        healthy_metadata,
        load_camera_data,
        provider_identity,
        reserve_camera_ids,
        restore_camera_data,
        unknown_metadata,
        update_camera_data,
        utc_now_iso,
        validate_camera_data,
    )
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.camera_data import (
        CameraDataError,
        atomic_write_json,
        canonical_source_url,
        feed_identity,
        healthy_metadata,
        load_camera_data,
        provider_identity,
        reserve_camera_ids,
        restore_camera_data,
        unknown_metadata,
        update_camera_data,
        utc_now_iso,
        validate_camera_data,
    )

try:
    from providers import FunctionProviderAdapter, ProviderRegistry, ProviderResult, ProviderRuntime
    from providers.geospatial import IterisConfig, collect_iteris_geojson
    from providers.traveler import (
        CarsGraphqlConfig,
        DataTablesConfig,
        MapIconsConfig,
        NewEnglandDataTablesConfig,
        collect_cars_graphql,
        collect_datatables,
        collect_mapicons,
        collect_new_england_datatables,
    )
except (ImportError, ModuleNotFoundError):  # pragma: no cover - package import during tests
    from scripts.providers import FunctionProviderAdapter, ProviderRegistry, ProviderResult, ProviderRuntime
    from scripts.providers.geospatial import IterisConfig, collect_iteris_geojson
    from scripts.providers.traveler import (
        CarsGraphqlConfig,
        DataTablesConfig,
        MapIconsConfig,
        NewEnglandDataTablesConfig,
        collect_cars_graphql,
        collect_datatables,
        collect_mapicons,
        collect_new_england_datatables,
    )

try:
    from source_health import load_source_health, update_source_health, write_source_health
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.source_health import load_source_health, update_source_health, write_source_health

sys.stdout.reconfigure(encoding='utf-8')
ctx = ssl.create_default_context()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / 'data'
OUTPUT = DATA_DIR / 'cameras.json'
SOURCE_HEALTH_OUTPUT = DATA_DIR / 'source-health.json'

cameras = []
cam_id = 0
stats = {}
active_provider = ''
PROVIDER_RETENTION_RATIO = 0.9


class IncompleteProviderError(RuntimeError):
    """Raised when a multi-request provider returns only a partial snapshot."""


def provider_runtime() -> ProviderRuntime:
    """Resolve patchable ingestion services at call time for provider families."""
    return ProviderRuntime(
        fetch_json=fetch_json,
        post_json=post_json,
        http_bytes=_http_bytes,
        add_camera=add_camera,
        detect_type=detect_type,
        log=print,
    )


def next_id():
    global cam_id
    cam_id += 1
    return cam_id


def add_camera(name, lat, lon, url, cam_type='image', state='', county='',
               direction='', source='dot', source_url=None,
               refresh_cadence_seconds=None):
    if not url or not lat or not lon:
        return
    try:
        lat = float(lat)
        lon = float(lon)
    except (ValueError, TypeError):
        return
    if lat == 0 or lon == 0:
        return
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return
    name = re.sub(r'<[^>]+>', '', str(name)).strip() or 'Unnamed camera'
    camera = {
        'id': next_id(),
        'name': name,
        'lat': round(lat, 6),
        'lon': round(lon, 6),
        'url': url,
        'type': cam_type,
        'state': state,
        'county': county,
        'direction': direction,
        'source': source
    }
    if active_provider:
        camera['provider'] = active_provider
    source_url = source_url or canonical_source_url(cam_type, str(url))
    if active_provider == 'OpenTrafficCamMap baseline':
        camera.update(unknown_metadata(source_url))
    else:
        camera.update(healthy_metadata(source_url))
    camera['refresh_cadence_seconds'] = refresh_cadence_seconds
    cameras.append(camera)


def fetch_json(url, headers=None, timeout=15):
    hdrs = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate'}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
    raw = resp.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf-8', errors='replace'))


def post_json(url, body, headers=None, timeout=15):
    hdrs = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip, deflate'}
    if headers:
        hdrs.update(headers)
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=hdrs, method='POST')
    resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
    raw = resp.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf-8', errors='replace'))


def detect_type(url):
    u = url.lower()
    if '.m3u8' in u:
        return 'hls'
    if '.mjpg' in u or '.mjpeg' in u or 'mjpeg' in u:
        return 'mjpeg'
    return 'image'


def _hls_manifest_text(url, timeout=20, referer='https://oktraffic.org/'):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
        'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        'Referer': referer,
    }
    request = urllib.request.Request(url, headers=headers)
    response = urllib.request.urlopen(request, timeout=timeout, context=ctx)
    payload = response.read()
    text = payload.decode('utf-8', errors='replace')
    if not text.lstrip().startswith('#EXTM3U'):
        raise ValueError('confirmed_not_live:invalid_manifest')
    return text, response.geturl()


def _hls_snapshot(url, timeout=20, referer='https://oktraffic.org/'):
    text, manifest_url = _hls_manifest_text(url, timeout, referer)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if '#EXT-X-ENDLIST' in lines:
        raise ValueError('confirmed_not_live:endlist')
    if any(line.startswith('#EXT-X-STREAM-INF:') for line in lines):
        variant = next((line for line in lines if not line.startswith('#')), '')
        if not variant:
            raise ValueError('confirmed_not_live:empty_master')
        manifest_url = urllib.parse.urljoin(manifest_url, variant)
        text, manifest_url = _hls_manifest_text(manifest_url, timeout, referer)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if '#EXT-X-ENDLIST' in lines:
            raise ValueError('confirmed_not_live:endlist')
    sequence_match = re.search(r'^#EXT-X-MEDIA-SEQUENCE:(\d+)$', text, re.MULTILINE)
    sequence = int(sequence_match.group(1)) if sequence_match else -1
    segments = tuple(
        urllib.parse.urljoin(manifest_url, line)
        for line in lines
        if not line.startswith('#')
    )
    if not segments:
        raise ValueError('confirmed_not_live:no_segments')
    segment_request = urllib.request.Request(
        segments[-1],
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            'Referer': referer,
            'Range': 'bytes=0-1023',
        },
    )
    segment_response = urllib.request.urlopen(segment_request, timeout=timeout, context=ctx)
    content_type = (segment_response.headers.get('Content-Type') or '').lower()
    if 'text/html' in content_type or 'json' in content_type or not segment_response.read(1024):
        raise ValueError('confirmed_not_live:segment_unavailable')
    return sequence, segments[-3:]


def verify_live_hls(urls, probe_interval=6.0, workers=12,
                    referer='https://oktraffic.org/'):
    unique_urls = list(dict.fromkeys(urls))

    def probe_all():
        snapshots = {}
        errors = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_hls_snapshot, url, 20, referer): url
                for url in unique_urls
            }
            for future in concurrent.futures.as_completed(futures):
                url = futures[future]
                try:
                    snapshots[url] = future.result()
                except Exception as exc:
                    message = str(exc)
                    if isinstance(exc, urllib.error.HTTPError):
                        if exc.code in {404, 410}:
                            message = f'confirmed_dead:http_{exc.code}'
                        elif exc.code == 429:
                            message = 'rate_limited:http_429'
                        elif exc.code in {401, 403}:
                            message = f'authentication_required:http_{exc.code}'
                        else:
                            message = f'transient_network:http_{exc.code}'
                    elif not message.startswith(('confirmed_not_live:', 'confirmed_dead:')):
                        message = f'transient_network:{message}'
                    errors[url] = message
        return snapshots, errors

    first, first_errors = probe_all()
    if probe_interval:
        time.sleep(probe_interval)
    second, second_errors = probe_all()
    verified = {
        url for url in unique_urls
        if url in first and url in second
        and (second[url][0] > first[url][0] or second[url][1] != first[url][1])
    }
    errors = {}
    for url in unique_urls:
        if url in verified:
            continue
        first_error = first_errors.get(url)
        second_error = second_errors.get(url)
        if first_error and second_error:
            first_class = first_error.split(':', 1)[0]
            second_class = second_error.split(':', 1)[0]
            if first_class == second_class:
                errors[url] = second_error
            else:
                errors[url] = (
                    f'transient_network:inconsistent_probes:{first_class},{second_class}'
                )
        elif first_error or second_error:
            detail = first_error or second_error
            errors[url] = f'transient_network:inconsistent_probes:{detail}'
        else:
            errors[url] = 'confirmed_not_live:not_advancing'
    return verified, errors


def fetch_oktraffic():
    source_page = 'https://oktraffic.org/'
    camera_filter = {
        'include': {
            'relation': 'mapCameras',
            'scope': {
                'include': 'streamDictionary',
                'where': {
                    'status': {'neq': 'Out Of Service'},
                    'type': 'Web',
                    'blockAtis': {'neq': '1'},
                },
            },
        },
    }
    query = urllib.parse.quote(json.dumps(camera_filter, separators=(',', ':')))
    poles = fetch_json(f'https://oktraffic.org/api/CameraPoles?filter={query}', timeout=30)
    candidates = []
    seen_urls = set()
    for pole in poles:
        pole_id = pole.get('id')
        for camera in pole.get('mapCameras') or []:
            stream = camera.get('streamDictionary') or {}
            url = str(stream.get('streamSrc') or '').strip()
            if not url.startswith('https://') or url in seen_urls:
                continue
            seen_urls.add(url)
            candidates.append({
                'pole_id': pole_id,
                'camera_id': camera.get('id'),
                'name': camera.get('location') or stream.get('streamName') or pole.get('name'),
                'lat': camera.get('latitude'),
                'lon': camera.get('longitude'),
                'direction': camera.get('direction') or '',
                'city': camera.get('city') or '',
                'record_time': camera.get('recordTime'),
                'url': url,
            })
    verified_urls, verification_errors = verify_live_hls([item['url'] for item in candidates])
    rejected = []
    added = 0
    for item in candidates:
        if item['url'] not in verified_urls:
            rejected.append({
                'provider_camera_id': item['camera_id'],
                'name': item['name'],
                'url': item['url'],
                'failure_class': verification_errors.get(
                    item['url'], 'transient_network:verification_incomplete'
                ),
            })
            continue
        before = len(cameras)
        add_camera(
            item['name'], item['lat'], item['lon'], item['url'],
            'hls', 'Oklahoma', item['city'], item['direction'], 'dot',
            f"https://oktraffic.org/tcameras/camera.aspx?id={item['pole_id']}",
            10,
        )
        if len(cameras) == before:
            rejected.append({
                'provider_camera_id': item['camera_id'],
                'name': item['name'],
                'url': item['url'],
                'failure_class': 'location_ambiguous:invalid_coordinates',
            })
            continue
        cameras[-1]['provider_camera_id'] = str(item['camera_id'])
        cameras[-1]['provider_record_time'] = item['record_time']
        added += 1
    atomic_write_json(
        DATA_DIR / 'oktraffic_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Oklahoma (OKTraffic)',
            'source_url': source_page,
            'attribution': 'OKTraffic',
            'refresh_cadence_seconds': 10,
            'poles': len(poles),
            'candidates': len(candidates),
            'verified_live': added,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  OKTraffic HLS verification: {added}/{len(candidates)} advancing')
    return added


# ── Caltrans (California) ──
def fetch_caltrans():
    count = 0
    failed_districts = []
    for d in range(1, 13):
        try:
            url = f'https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02d}.json'
            data = fetch_json(url)
            for entry in data.get('data', []):
                cctv = entry.get('cctv', entry)
                loc = cctv.get('location', {})
                img = cctv.get('imageData', {})
                static_img = img.get('static', {}).get('currentImageURL', '')
                stream_url = img.get('streamingVideoURL', '')
                media_url = stream_url or static_img
                if not media_url:
                    continue
                if cctv.get('inService') == 'false':
                    continue
                name = loc.get('locationName') or loc.get('nearbyPlace') or f'Caltrans D{d}'
                add_camera(name, loc.get('latitude'), loc.get('longitude'),
                           media_url, detect_type(media_url), 'California', '', '', 'dot')
                count += 1
        except Exception as e:
            print(f'  Caltrans D{d}: {e}')
            failed_districts.append(d)
    if failed_districts:
        raise IncompleteProviderError(f'Caltrans districts failed: {failed_districts}')
    return count


# ── 511 Platform (FL, LA, PA, WI, and others) ──
def fetch_511_mapicons(base_url, state_name):
    return collect_mapicons(provider_runtime(), MapIconsConfig(base_url, state_name))


# ── New England 511 (ME/NH/VT) — DataTables feed with correct per-state labels ──
def fetch_newengland511():
    return collect_new_england_datatables(
        provider_runtime(),
        NewEnglandDataTablesConfig(),
    )


# ── 511 DataTables (Georgia, Florida detail) ──
def fetch_511_datatables(base_url, state_name, referer=None):
    return collect_datatables(
        provider_runtime(),
        DataTablesConfig(base_url, state_name, referer),
    )


# ── NYC DOT ──
def fetch_nycdot():
    try:
        data = fetch_json('https://webcams.nyctmc.org/api/cameras')
        count = 0
        for cam in data:
            name = cam.get('name', 'NYC Camera')
            lat = cam.get('latitude')
            lon = cam.get('longitude')
            cam_id_val = cam.get('id', '')
            img_url = f'https://webcams.nyctmc.org/api/cameras/{cam_id_val}/image'
            add_camera(name, lat, lon, img_url, 'image', 'New York', 'New York City', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  NYC DOT: {e}')
        return 0


# ── WSDOT (Washington) ──
def fetch_wsdot():
    try:
        url = ('https://www.wsdot.wa.gov/arcgis/rest/services/Production/'
               'WSDOTTrafficCameras/MapServer/0/query?where=1%3D1&outFields='
               'CameraID,CameraTitl,ImageURL,CameraOwne&outSR=4326&f=json')
        data = fetch_json(url, timeout=30)
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            geom = feat.get('geometry', {})
            name = attrs.get('CameraTitl', 'WSDOT Camera')
            img_url = attrs.get('ImageURL', '')
            if not img_url:
                continue
            add_camera(name, geom.get('y'), geom.get('x'),
                       img_url, detect_type(img_url), 'Washington', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  WSDOT: {e}')
        return 0


# ── Illinois DOT ──
def fetch_illinois():
    try:
        url = ('https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/'
               'TrafficCamerasTM_Public/FeatureServer/0/query?where=1%3D1&outFields='
               'CameraLocation,CameraDirection,SnapShot&outSR=4326&f=json')
        data = fetch_json(url, timeout=30)
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            geom = feat.get('geometry', {})
            name = attrs.get('CameraLocation', '') or attrs.get('CameraDirection', 'IL Camera')
            img_url = attrs.get('SnapShot', '')
            if not img_url:
                continue
            add_camera(name, geom.get('y'), geom.get('x'),
                       img_url, 'image', 'Illinois', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Illinois DOT: {e}')
        return 0


# ── Michigan DOT ──
def fetch_michigan():
    try:
        data = fetch_json('https://mdotjboss.state.mi.us/MiDrive/camera/list')
        count = 0
        for cam in data:
            county_field = cam.get('county', '')
            lat_m = re.search(r'lat=([\d.-]+)', county_field)
            lon_m = re.search(r'lon=([\d.-]+)', county_field)
            if not lat_m or not lon_m:
                continue
            lat = float(lat_m.group(1))
            lon = float(lon_m.group(1))
            img_html = cam.get('image', '')
            src_m = re.search(r'src="([^"]+)"', img_html)
            if not src_m:
                continue
            img_url = src_m.group(1)
            if img_url.startswith('/'):
                img_url = 'https://mdotjboss.state.mi.us' + img_url
            name = f"{cam.get('route', '')} {cam.get('location', '')}".strip() or 'MI Camera'
            add_camera(name, lat, lon, img_url, 'image', 'Michigan', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Michigan DOT: {e}')
        return 0


# ── Colorado DOT ──
def fetch_colorado():
    try:
        data = fetch_json('https://cotg.carsprogram.org/cameras_v1/api/cameras', timeout=30)
        count = 0
        for cam in data:
            if cam.get('public') is False or cam.get('active') is False:
                continue
            loc = cam.get('location', {})
            lat = loc.get('latitude')
            lon = loc.get('longitude')
            name = cam.get('name', '') or loc.get('routeId', 'CO Camera')
            views = cam.get('views', [])
            img_url = ''
            for v in views:
                url = v.get('videoPreviewUrl') or v.get('url', '')
                if url:
                    img_url = url
                    break
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Colorado', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Colorado DOT: {e}')
        return 0


# ── Austin, TX ──
def fetch_austin_tx():
    try:
        data = fetch_json('https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=2000')
        count = 0
        for cam in data:
            if cam.get('camera_status') != 'TURNED_ON':
                continue
            loc = cam.get('location', {})
            coords = loc.get('coordinates', [0, 0])
            if not coords or len(coords) < 2:
                continue
            lon, lat = coords[0], coords[1]
            name = cam.get('location_name', 'Austin Camera')
            img_url = cam.get('screenshot_address', '')
            if not img_url:
                cam_id_val = cam.get('camera_id', '')
                img_url = f'https://cctv.austinmobility.io/image/{cam_id_val}.jpg'
            add_camera(name, lat, lon, img_url, 'image', 'Texas', 'Austin', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Austin TX: {e}')
        return 0


# ── TxDOT (Texas statewide) ──
def fetch_txdot():
    try:
        url = ('https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/'
               'TxDOT_CCTV_Cameras/FeatureServer/0/query?where=1%3D1&outFields=*'
               '&outSR=4326&f=json&resultRecordCount=5000')
        data = fetch_json(url, timeout=30)
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            geom = feat.get('geometry', {})
            name = attrs.get('CAMERANAME', '') or attrs.get('LOCATION', 'TX Camera')
            img_url = attrs.get('IMAGEURL', '') or attrs.get('URL', '')
            if not img_url:
                continue
            add_camera(name, geom.get('y'), geom.get('x'),
                       img_url, detect_type(img_url), 'Texas', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  TxDOT: {e}')
        return 0


# ── NPS Webcams ──
def fetch_nps():
    try:
        url = 'https://developer.nps.gov/api/v1/webcams?api_key=DEMO_KEY&limit=500'
        data = fetch_json(url, headers={'User-Agent': 'StormScope/0.112.0'})
        count = 0
        for cam in data.get('data', []):
            if str(cam.get('status') or '').lower() == 'inactive':
                continue
            lat = cam.get('latitude', '')
            lon = cam.get('longitude', '')
            if not lat or not lon:
                continue
            try:
                lat, lon = float(lat), float(lon)
            except (ValueError, TypeError):
                continue
            if lat == 0 or lon == 0:
                continue
            title = re.sub(r'<[^>]+>', '', cam.get('title', 'NPS Webcam'))
            park = ''
            state = ''
            if cam.get('relatedParks'):
                park = cam['relatedParks'][0].get('fullName', '')
                state = cam['relatedParks'][0].get('states', '')
            cam_url = cam.get('url', '')
            if not cam_url:
                continue
            add_camera(title, lat, lon, cam_url, 'embed', state, park, '', 'nps')
            count += 1
        return count
    except Exception as e:
        print(f'  NPS: {e}')
        return 0


# ── Verified Wyoming NPS feeds ──
WYOMING_NPS_IMAGE_FEEDS = (
    {
        'provider_camera_id': 'yell-mammoth-parade',
        'name': 'Mammoth Hot Springs - Travertine Terraces',
        'lat': 44.976418715,
        'lon': -110.700087547,
        'url': 'https://www.nps.gov/webcams-yell/mammoth_parade.jpg',
        'county': 'Park County',
        'direction': '',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=696F20E1-F421-B232-FE72D6D85B157422'),
    },
    {
        'provider_camera_id': 'yell-washburn-ne',
        'name': 'Mount Washburn - Northeastern View',
        'lat': 44.797831049,
        'lon': -110.434384583,
        'url': 'https://www.nps.gov/webcams-yell/washburn_ne.jpg',
        'county': 'Park County',
        'direction': 'NE',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=81B46891-1DD8-B71B-0B6575944D4DECD5'),
    },
    {
        'provider_camera_id': 'yell-washburn-s',
        'name': 'Mount Washburn - Southern View',
        'lat': 44.797831049,
        'lon': -110.434384583,
        'url': 'https://www.nps.gov/webcams-yell/washburn_sw.jpg',
        'county': 'Park County',
        'direction': 'S',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=81B4689E-1DD8-B71B-0B8741319EA29FD3'),
    },
    {
        'provider_camera_id': 'yell-east-out',
        'name': 'Yellowstone East Entrance - Out of Park',
        'lat': 44.489854349,
        'lon': -110.001113483,
        'url': 'https://www.nps.gov/webcams-yell/east_out.jpg',
        'county': 'Park County',
        'direction': 'E',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=45FDA0AC-0A10-4ACA-A0C6-44F440575AE1'),
    },
    {
        'provider_camera_id': 'yell-east-in',
        'name': 'Yellowstone East Entrance - Into Park',
        'lat': 44.489854349,
        'lon': -110.001113483,
        'url': 'https://www.nps.gov/webcams-yell/east_in.jpg',
        'county': 'Park County',
        'direction': 'W',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=E3772256-9585-4859-A1FD-FC47F15F7226'),
    },
    {
        'provider_camera_id': 'deto-prairie-dog-town',
        'name': 'Devils Tower Prairie Dog Town from Amphitheater',
        'lat': 44.582910805,
        'lon': -104.707953792,
        'url': 'https://www.nps.gov/webcams-deto/deto1.jpg',
        'county': 'Crook County',
        'direction': '',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=34A2E299-D1A6-73B6-83317D912825FDF8'),
    },
    {
        'provider_camera_id': 'deto-tower-prairie-dog-town',
        'name': 'Devils Tower from Prairie Dog Town',
        'lat': 44.585137073,
        'lon': -104.707873617,
        'url': 'https://www.nps.gov/webcams-deto/deto2.jpg',
        'county': 'Crook County',
        'direction': '',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=34CA6D33-B7F4-4D81-012FADCDA97D746E'),
    },
)

WYOMING_OLD_FAITHFUL = {
    'provider_camera_id': 'yell-old-faithful',
    'name': 'Old Faithful and Upper Geyser Basin',
    'lat': 44.459886644,
    'lon': -110.830614567,
    'url': 'https://cs7.pixelcaster.com/nps/faithful.stream/playlist_dvr.m3u8',
    'county': 'Park County',
    'source_url': 'https://www.nps.gov/yell/learn/photosmultimedia/webcams.htm',
}


def _current_jpeg_snapshot(
    url, require_provider_timestamp=True, max_age_seconds=1200, minimum_bytes=10_000
):
    request = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'StormScope/0.112.0',
            'Accept': 'image/jpeg,image/*,*/*',
            'Cache-Control': 'no-cache',
        },
    )
    with urllib.request.urlopen(request, timeout=25, context=ctx) as response:
        content_type = (response.headers.get('Content-Type') or '').lower()
        last_modified = response.headers.get('Last-Modified')
        body = response.read()
    if (
        'image' not in content_type
        or len(body) < minimum_bytes
        or not body.startswith(b'\xff\xd8\xff')
    ):
        raise ValueError('placeholder:not_a_current_jpeg')
    if not last_modified and require_provider_timestamp:
        raise ValueError('placeholder:missing_provider_timestamp')
    if not last_modified:
        return hashlib.sha256(body).hexdigest(), len(body), None
    provider_time = email.utils.parsedate_to_datetime(last_modified)
    if provider_time.tzinfo is None:
        provider_time = provider_time.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - provider_time.astimezone(timezone.utc)
    if age < -timedelta(minutes=5) or age > timedelta(seconds=max_age_seconds):
        raise ValueError(f'placeholder:stale_provider_timestamp:{int(age.total_seconds())}')
    return hashlib.sha256(body).hexdigest(), len(body), provider_time.isoformat()


def verify_current_jpeg_images(candidates, probe_interval=2.0, workers=7):
    snapshots = {}
    errors = {}
    probe_sequence = itertools.count()

    def probe(item):
        try:
            url = item['url']
            if item.get('cache_bust'):
                parsed = urllib.parse.urlsplit(url)
                query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                query.append((
                    '_stormscope_probe',
                    f'{time.time_ns()}-{next(probe_sequence)}',
                ))
                url = urllib.parse.urlunsplit(parsed._replace(
                    query=urllib.parse.urlencode(query)
                ))
            return (
                item['provider_camera_id'],
                _current_jpeg_snapshot(
                    url,
                    require_provider_timestamp=not item.get('require_content_change'),
                    max_age_seconds=item.get('max_age_seconds', 1200),
                    minimum_bytes=item.get('minimum_bytes', 10_000),
                ),
                None,
            )
        except Exception as exc:  # noqa: BLE001
            return item['provider_camera_id'], None, str(exc)

    first = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for camera_id, snapshot, error in executor.map(probe, candidates):
            if error:
                errors.setdefault(camera_id, []).append(error)
            else:
                first[camera_id] = snapshot
    if probe_interval:
        time.sleep(probe_interval)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for camera_id, snapshot, error in executor.map(probe, candidates):
            if error:
                errors.setdefault(camera_id, []).append(error)
            else:
                snapshots[camera_id] = snapshot

    verified = set(first) & set(snapshots)
    final_errors = {}
    for candidate in candidates:
        camera_id = candidate['provider_camera_id']
        if (
            camera_id in verified
            and candidate.get('require_content_change')
            and first[camera_id][0] == snapshots[camera_id][0]
        ):
            verified.remove(camera_id)
            final_errors[camera_id] = 'placeholder:not_advancing'
            continue
        if camera_id in verified:
            continue
        details = errors.get(camera_id, ['transient_network:incomplete'])
        detail = details[-1]
        final_errors[camera_id] = (
            detail if detail.startswith(('placeholder:', 'confirmed_dead:'))
            else f'transient_network:{detail}'
        )
    return verified, final_errors, snapshots


def fetch_wyoming_nps_verified():
    image_candidates = [dict(item) for item in WYOMING_NPS_IMAGE_FEEDS]
    verified_images, image_errors, image_snapshots = verify_current_jpeg_images(image_candidates)
    old_faithful = dict(WYOMING_OLD_FAITHFUL)
    verified_hls, hls_errors = verify_live_hls(
        [old_faithful['url']], probe_interval=10.0, workers=1,
        referer=old_faithful['source_url'],
    )
    rejected = []
    count = 0

    for camera in image_candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified_images:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': image_errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'Wyoming', camera['county'], camera['direction'], 'nps',
            camera['source_url'], 60,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = image_snapshots[camera_id][2]
        cameras[-1]['_replace_source_page'] = True
        count += 1

    if old_faithful['url'] in verified_hls:
        add_camera(
            old_faithful['name'], old_faithful['lat'], old_faithful['lon'],
            old_faithful['url'], 'hls', 'Wyoming', old_faithful['county'], '', 'nps',
            old_faithful['source_url'], 10,
        )
        cameras[-1]['provider_camera_id'] = old_faithful['provider_camera_id']
        cameras[-1]['_replace_source_page'] = True
        count += 1
    else:
        rejected.append({
            'provider_camera_id': old_faithful['provider_camera_id'],
            'name': old_faithful['name'],
            'failure_class': hls_errors.get(
                old_faithful['url'], 'transient_network:incomplete'
            ),
        })

    atomic_write_json(
        DATA_DIR / 'wyoming_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service',
            'source_url': 'https://www.nps.gov/subjects/digital/webcams.htm',
            'geographic_scope': 'Wyoming - Yellowstone and Devils Tower',
            'attribution': {
                'old_faithful': 'NPS, Canon USA, and Yellowstone Forever',
                'still_images': 'National Park Service',
            },
            'usage': 'Direct first-party feeds; media is linked and not mirrored',
            'refresh_cadence_seconds': {'image': 60, 'hls': 10},
            'candidates': len(image_candidates) + 1,
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  Wyoming NPS verification: {count}/{len(image_candidates) + 1} live')
    return count


# ── Virginia DOT (VDOT) ──
def fetch_vdot():
    try:
        url = ('https://www.511virginia.org/map/mapIcons/Cameras')
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'VA Camera {item_id}'
            img_url = f'https://www.511virginia.org/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Virginia', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  VDOT: {e}')
        return 0


# ── Iowa DOT ──
def fetch_iowa():
    try:
        url = 'https://lb.511ia.org/map/mapIcons/Cameras'
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'IA Camera {item_id}'
            img_url = f'https://lb.511ia.org/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Iowa', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Iowa DOT: {e}')
        return 0


# ── Nebraska DOT ──
def fetch_nebraska():
    try:
        url = 'https://511.nebraska.gov/map/mapIcons/Cameras'
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'NE Camera {item_id}'
            img_url = f'https://511.nebraska.gov/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Nebraska', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Nebraska DOT: {e}')
        return 0


# ── New Jersey Turnpike Authority — public inventory + advancing HLS ──
NJTA_SOURCE_URL = 'https://www.njta.gov/travel-resources/camera-list/'
NJTA_EXPECTED_INVENTORY = 137
NJTA_REJECTED_IDS = {
    '56', '57', '127', '974', '993', '997', '1006', '1023',
}
NJTA_COUNTIES = {
    '1': 'Burlington County',
    '2': 'Burlington County',
    '5': 'Burlington County',
    '9': 'Middlesex County',
    '28': 'Union County',
    '29': 'Essex County',
    '30': 'Bergen County',
    '31': 'Bergen County',
    '32': 'Middlesex County',
    '34': 'Burlington County',
    '35': 'Hudson County',
    '36': 'Essex County',
    '37': 'Essex County',
    '38': 'Hudson County',
    '39': 'Hudson County',
    '40': 'Burlington County',
    '41': 'Essex County',
    '43': 'Essex County',
    '44': 'Burlington County',
    '45': 'Burlington County',
    '47': 'Hudson County',
    '48': 'Hudson County',
    '49': 'Hudson County',
    '50': 'Hudson County',
    '51': 'Bergen County',
    '53': 'Hudson County',
    '54': 'Bergen County',
    '55': 'Bergen County',
    '60': 'Hudson County',
    '61': 'Hudson County',
    '63': 'Essex County',
    '64': 'Hudson County',
    '65': 'Hudson County',
    '69': 'Cape May County',
    '72': 'Atlantic County',
    '73': 'Burlington County',
    '74': 'Ocean County',
    '75': 'Ocean County',
    '76': 'Ocean County',
    '77': 'Monmouth County',
    '78': 'Ocean County',
    '79': 'Ocean County',
    '80': 'Monmouth County',
    '81': 'Monmouth County',
    '85': 'Monmouth County',
    '96': 'Middlesex County',
    '97': 'Middlesex County',
    '98': 'Middlesex County',
    '101': 'Middlesex County',
    '104': 'Essex County',
    '105': 'Essex County',
    '106': 'Essex County',
    '107': 'Passaic County',
    '113': 'Union County',
    '123': 'Essex County',
    '125': 'Essex County',
    '126': 'Bergen County',
    '128': 'Bergen County',
    '129': 'Bergen County',
    '130': 'Bergen County',
    '859': 'Essex County',
    '963': 'Burlington County',
    '964': 'Burlington County',
    '965': 'Mercer County',
    '966': 'Mercer County',
    '967': 'Burlington County',
    '968': 'Salem County',
    '969': 'Gloucester County',
    '970': 'Salem County',
    '971': 'Mercer County',
    '972': 'Middlesex County',
    '973': 'Salem County',
    '975': 'Middlesex County',
    '976': 'Middlesex County',
    '977': 'Union County',
    '978': 'Middlesex County',
    '979': 'Middlesex County',
    '980': 'Union County',
    '981': 'Union County',
    '982': 'Middlesex County',
    '983': 'Middlesex County',
    '984': 'Union County',
    '985': 'Middlesex County',
    '986': 'Union County',
    '987': 'Hudson County',
    '988': 'Bergen County',
    '989': 'Essex County',
    '990': 'Hudson County',
    '991': 'Atlantic County',
    '992': 'Cape May County',
    '994': 'Cape May County',
    '995': 'Atlantic County',
    '996': 'Monmouth County',
    '998': 'Monmouth County',
    '999': 'Monmouth County',
    '1000': 'Monmouth County',
    '1001': 'Monmouth County',
    '1002': 'Monmouth County',
    '1003': 'Monmouth County',
    '1004': 'Monmouth County',
    '1005': 'Monmouth County',
    '1007': 'Middlesex County',
    '1008': 'Middlesex County',
    '1009': 'Middlesex County',
    '1010': 'Middlesex County',
    '1012': 'Bergen County',
    '1013': 'Middlesex County',
    '1014': 'Union County',
    '1015': 'Union County',
    '1016': 'Union County',
    '1017': 'Union County',
    '1018': 'Essex County',
    '1019': 'Essex County',
    '1020': 'Essex County',
    '1021': 'Essex County',
    '1022': 'Essex County',
    '1024': 'Essex County',
    '1025': 'Essex County',
    '1026': 'Essex County',
    '1048': 'Hudson County',
    '1052': 'Bergen County',
    '1053': 'Bergen County',
    '1054': 'Bergen County',
    '1055': 'Bergen County',
    '1056': 'Bergen County',
    '1057': 'Bergen County',
    '1058': 'Cape May County',
    '1059': 'Atlantic County',
    '1060': 'Ocean County',
}


def _njta_camera_name(item, roadway):
    parts = [roadway]
    mile_marker = item.get('mile_marker')
    if mile_marker is not None:
        parts.append(f'MM {float(mile_marker):g}')
    relative_direction = str(item.get('relative_direction', '') or '').strip().upper()
    if relative_direction:
        parts.append(relative_direction)
    relative_text = str(item.get('relative_text', '') or '').strip()
    if relative_text:
        parts.append(relative_text)
    return ' '.join(parts)


def fetch_njta():
    page = _http_bytes(
        NJTA_SOURCE_URL,
        headers={'Accept': 'text/html,application/xhtml+xml'},
    ).decode('utf-8', 'replace')
    match = re.search(r'data-block-config=(["\'])(.*?)\1', page, flags=re.DOTALL)
    if not match:
        raise IncompleteProviderError('NJTA data-block-config unavailable')
    config = json.loads(html.unescape(match.group(2)))
    grouped = config.get('initialData', {}).get('cameras', {})
    inventory = []
    for key, roadway in (
        ('turnpike', 'New Jersey Turnpike'),
        ('parkway', 'Garden State Parkway'),
    ):
        for raw in grouped.get(key, []):
            inventory.append({**raw, '_roadway': roadway, '_group': key})
    if len(inventory) != NJTA_EXPECTED_INVENTORY:
        raise IncompleteProviderError(
            f'truncated_inventory:{len(inventory)}!={NJTA_EXPECTED_INVENTORY}'
        )

    inventory_ids = [str(item.get('id', '')) for item in inventory]
    inventory_urls = [str(item.get('video_url', '')) for item in inventory]
    if len(set(inventory_ids)) != len(inventory_ids):
        raise IncompleteProviderError('duplicate_provider_camera_id')
    if len(set(inventory_urls)) != len(inventory_urls):
        raise IncompleteProviderError('duplicate_provider_camera_url')
    accepted_ids = set(inventory_ids) - NJTA_REJECTED_IDS
    if accepted_ids != set(NJTA_COUNTIES):
        missing = sorted(accepted_ids - set(NJTA_COUNTIES))
        stale = sorted(set(NJTA_COUNTIES) - accepted_ids)
        raise IncompleteProviderError(
            f'location_inventory_changed:missing={missing}:stale={stale}'
        )

    candidates = [
        item for item in inventory if str(item['id']) not in NJTA_REJECTED_IDS
    ]
    verified, errors = verify_live_hls(
        [item['video_url'] for item in candidates],
        probe_interval=6.0,
        workers=12,
        referer=NJTA_SOURCE_URL,
    )
    rejected = [
        {
            'provider_camera_id': f'njta:{camera_id}',
            'failure_class': (
                'placeholder:manually_rejected_mispointed'
                if camera_id in {'127', '993', '1006'}
                else 'confirmed_dead:repeatable_hls_404'
            ),
        }
        for camera_id in sorted(NJTA_REJECTED_IDS, key=int)
    ]
    for item in candidates:
        url = item['video_url']
        camera_id = str(item['id'])
        if url not in verified:
            rejected.append({
                'provider_camera_id': f'njta:{camera_id}',
                'failure_class': errors.get(
                    url, 'transient_network:verification_incomplete'
                ),
            })
            continue
        raw_direction = str(item.get('relative_direction', '') or '').upper()
        direction = 'N' if raw_direction.startswith('N') else (
            'S' if raw_direction.startswith('S') else ''
        )
        add_camera(
            _njta_camera_name(item, item['_roadway']),
            item['lat'], item['lng'], url, 'hls', 'New Jersey',
            NJTA_COUNTIES[camera_id], direction, 'dot', NJTA_SOURCE_URL, 10,
        )
        cameras[-1]['provider_camera_id'] = f'njta:{camera_id}'
        cameras[-1]['category'] = 'traffic'

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'new_jersey_njta_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'New Jersey Turnpike Authority',
            'source_url': NJTA_SOURCE_URL,
            'disclaimer_url': 'https://www.njta.gov/disclaimer/',
            'attribution': 'New Jersey Turnpike Authority',
            'license_or_usage_terms': (
                'NJTA publishes these streams for public traveler information. '
                'StormScope links the original streams with attribution and does '
                'not proxy or archive them.'
            ),
            'inventory': len(inventory),
            'verified_live': count,
            'manual_reviewed': len(candidates),
            'rejected': rejected,
            'refresh_cadence_seconds': 10,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  NJTA HLS verification: {count}/{len(candidates)} advancing')
    return count


# ── South Carolina DOT ──
def fetch_scdot():
    try:
        url = 'https://www.511sc.org/map/mapIcons/Cameras'
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'SC Camera {item_id}'
            img_url = f'https://www.511sc.org/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'South Carolina', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  SC DOT: {e}')
        return 0


# ── Tennessee DOT ──
TENNESSEE_DOT_CONFIG = 'https://smartway.tn.gov/config/config.prod.json'
TENNESSEE_DOT_SOURCE = 'https://smartway.tn.gov/traffic'
TENNESSEE_DOT_MINIMUM_INVENTORY = 600
TENNESSEE_DOT_EXCLUSIONS = {
    3309: 'placeholder:maintenance_frame',
    3325: 'placeholder:black_frame',
    4242: 'duplicate:6057',
    4243: 'duplicate:6058',
    4244: 'duplicate:6059',
    4245: 'duplicate:6060',
    4672: 'placeholder:maintenance_frame',
    6162: 'location_ambiguous:movable_trailer_camera',
    6169: 'location_ambiguous:movable_trailer_camera',
}


def verify_tennessee_hls(urls, probe_interval=8.0, retry_delay=15.0):
    def verify_groups(targets):
        groups = {}
        for url in targets:
            hostname = urllib.parse.urlsplit(url).hostname or ''
            groups.setdefault(hostname, []).append(url)

        verified = set()
        errors = {}

        def verify_group(group_urls):
            return verify_live_hls(
                group_urls, probe_interval=probe_interval, workers=1
            )

        with concurrent.futures.ThreadPoolExecutor(
            max_workers=max(1, min(5, len(groups)))
        ) as executor:
            for group_verified, group_errors in executor.map(
                verify_group, groups.values()
            ):
                verified.update(group_verified)
                errors.update(group_errors)
        return verified, errors

    verified, errors = verify_groups(urls)
    retryable = [
        url for url in urls
        if url not in verified
        and str(errors.get(url) or '').startswith('transient_network:')
    ]
    if retryable:
        time.sleep(retry_delay)
        retry_verified, retry_errors = verify_groups(retryable)
        verified.update(retry_verified)
        for url in retryable:
            if url in retry_verified:
                errors.pop(url, None)
            elif url in retry_errors:
                errors[url] = retry_errors[url]
    return verified, errors


def fetch_tndot():
    config = fetch_json(TENNESSEE_DOT_CONFIG, timeout=20)
    api_base = str(config.get('apiBaseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    camera_path = str(config.get('cameras') or '').strip()
    if not api_base.startswith('https://') or not api_key or not camera_path:
        raise IncompleteProviderError('provider_error:invalid_SmartWay_public_config')
    api_url = urllib.parse.urljoin(api_base, camera_path)
    items = fetch_json(api_url, headers={'ApiKey': api_key}, timeout=40)
    if not isinstance(items, list) or len(items) < TENNESSEE_DOT_MINIMUM_INVENTORY:
        raise IncompleteProviderError(
            f'truncated_inventory:{len(items) if isinstance(items, list) else 0}'
        )
    active = [
        camera for camera in items
        if str(camera.get('active')).lower() == 'true'
        and str(camera.get('httpsVideoUrl') or '').startswith('https://')
        and camera.get('lat') is not None
        and camera.get('lng') is not None
    ]
    candidates = [
        camera for camera in active
        if int(camera.get('id') or 0) not in TENNESSEE_DOT_EXCLUSIONS
    ]
    urls = [camera['httpsVideoUrl'] for camera in candidates]
    verified, errors = verify_tennessee_hls(urls)
    rejected = [
        {
            'provider_camera_id': str(camera.get('id') or ''),
            'name': camera.get('title') or camera.get('description') or '',
            'jurisdiction': camera.get('jurisdiction') or '',
            'failure_class': TENNESSEE_DOT_EXCLUSIONS[int(camera['id'])],
        }
        for camera in active
        if int(camera.get('id') or 0) in TENNESSEE_DOT_EXCLUSIONS
    ]
    count = 0
    for camera in candidates:
        stream_url = camera['httpsVideoUrl']
        if stream_url not in verified:
            rejected.append({
                'provider_camera_id': str(camera.get('id') or ''),
                'name': camera.get('title') or camera.get('description') or '',
                'jurisdiction': camera.get('jurisdiction') or '',
                'failure_class': errors.get(stream_url, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera.get('title') or camera.get('description') or f"TDOT Camera {camera['id']}",
            camera['lat'], camera['lng'], stream_url, 'hls', 'Tennessee', '', '',
            'dot', TENNESSEE_DOT_SOURCE, 10,
        )
        cameras[-1]['provider_camera_id'] = str(camera['id'])
        count += 1

    minimum_verified = int(len(candidates) * 0.85)
    atomic_write_json(
        DATA_DIR / 'tennessee_dot_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Tennessee Department of Transportation SmartWay',
            'source_url': TENNESSEE_DOT_SOURCE,
            'api_url': api_url,
            'attribution': 'Tennessee Department of Transportation / SmartWay',
            'usage_terms': (
                'Public real-time traveler-information service; '
                'no express reuse license located'
            ),
            'refresh_cadence_seconds': 10,
            'inventory_total': len(items),
            'active_with_https_hls': len(active),
            'verification_candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count < minimum_verified:
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{minimum_verified}'
        )
    print(f'  Tennessee DOT HLS verification: {count}/{len(candidates)} advancing')
    return count


TENNESSEE_NPS_FEEDS = (
    {
        'provider_camera_id': 'grsm-look-rock-air-quality',
        'name': 'Great Smoky Mountains NP - Look Rock Air Quality',
        'lat': 35.633482,
        'lon': -83.941606,
        'url': 'https://www.nps.gov/featurecontent/ard/webcams/images/grsm.jpg',
        'county': 'Blount County',
        'direction': 'E',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=6878C635-B83A-8F41-A6E3B0160539BEAA'),
    },
    {
        'provider_camera_id': 'grsm-kuwohi-air-quality',
        'name': 'Great Smoky Mountains NP - Kuwohi Air Quality',
        'lat': 35.562778,
        'lon': -83.4981,
        'url': 'https://www.nps.gov/featurecontent/ard/webcams/images/grcd.jpg',
        'county': 'Sevier County',
        'direction': '',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=C3DE0FD2-1DD8-B71B-0B7029E73676D939'),
    },
)


def fetch_tennessee_nps_verified():
    candidates = [dict(item) for item in TENNESSEE_NPS_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=2
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'Tennessee', camera['county'], camera['direction'], 'nps',
            camera['source_url'], 900,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['_replace_source_page'] = True
        count += 1

    atomic_write_json(
        DATA_DIR / 'tennessee_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service',
            'source_url': 'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm',
            'attribution': 'National Park Service',
            'usage_terms': 'NPS-created website material is generally public domain',
            'usage_terms_url': 'https://www.nps.gov/aboutus/disclaimer.htm',
            'geographic_scope': 'Great Smoky Mountains National Park, Tennessee',
            'refresh_cadence_seconds': 900,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  Tennessee NPS image verification: {count}/{len(candidates)} current')
    return count


MASSACHUSETTS_NPS_FEEDS = (
    {
        'provider_camera_id': 'bost-bunker-hill-south',
        'name': 'Bunker Hill Monument - Looking South',
        'lat': 42.376253,
        'lon': -71.06075,
        'url': 'https://www.nps.gov/webcams-bost/se-ts.jpeg',
        'direction': 'S',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=B1447BC9-A568-BC47-B0BE8A051F9D441E'),
    },
    {
        'provider_camera_id': 'bost-bunker-hill-east',
        'name': 'Bunker Hill Monument - Looking East',
        'lat': 42.376253,
        'lon': -71.06075,
        'url': 'https://www.nps.gov/webcams-bost/ne-ts.jpeg',
        'direction': 'E',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=B157B8BD-C808-C652-965AA8D1EC0CCCA4'),
    },
    {
        'provider_camera_id': 'bost-bunker-hill-north',
        'name': 'Bunker Hill Monument - Looking North',
        'lat': 42.376253,
        'lon': -71.06075,
        'url': 'https://www.nps.gov/webcams-bost/nw-ts.jpeg',
        'direction': 'N',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=B168A52D-A28F-0833-AB8832CB627D347E'),
    },
    {
        'provider_camera_id': 'bost-bunker-hill-west',
        'name': 'Bunker Hill Monument - Looking West',
        'lat': 42.376253,
        'lon': -71.06075,
        'url': 'https://www.nps.gov/webcams-bost/sw-ts.jpeg',
        'direction': 'W',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=B17835F2-AC01-8A62-F2F0EC85B33643D3'),
    },
    {
        'provider_camera_id': 'bost-dorchester-heights-west',
        'name': 'Dorchester Heights Monument - Looking West',
        'lat': 42.332725,
        'lon': -71.045837,
        'url': 'https://www.nps.gov/webcams-bost/west-001.jpeg',
        'direction': 'W',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=9AAE89A9-533B-47A4-A5C4-A568562EFB62'),
    },
    {
        'provider_camera_id': 'bost-dorchester-heights-north',
        'name': 'Dorchester Heights Monument - Looking North',
        'lat': 42.332725,
        'lon': -71.045837,
        'url': 'https://www.nps.gov/webcams-bost/north-001.jpeg',
        'direction': 'N',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=EC95E4C8-7524-4F4F-8B5E-993B4BAEAD6F'),
    },
    {
        'provider_camera_id': 'bost-dorchester-heights-east',
        'name': 'Dorchester Heights Monument - Looking East',
        'lat': 42.332725,
        'lon': -71.045837,
        'url': 'https://www.nps.gov/webcams-bost/east-001.jpeg',
        'direction': 'E',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=5A35A7A4-0CCF-4AF4-A02A-545094FB42E1'),
    },
    {
        'provider_camera_id': 'bost-dorchester-heights-south',
        'name': 'Dorchester Heights Monument - Looking South',
        'lat': 42.332725,
        'lon': -71.045837,
        'url': 'https://www.nps.gov/webcams-bost/south-001.jpeg',
        'direction': 'S',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=D450CFAD-8FC5-4A69-BA51-CCC666A1C9AA'),
    },
    {
        'provider_camera_id': 'boha-boston-light-west',
        'name': 'Little Brewster - Boston Light Looking West',
        'lat': 42.329333,
        'lon': -70.891806,
        'url': 'https://www.nps.gov/webcams-boha/west-001.jpeg',
        'direction': 'W',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=CFA25A47-F869-239A-B5B838DCE750B775'),
    },
    {
        'provider_camera_id': 'boha-boston-light-north',
        'name': 'Little Brewster - Boston Light Looking North',
        'lat': 42.329333,
        'lon': -70.891806,
        'url': 'https://www.nps.gov/webcams-boha/north-001.jpeg',
        'direction': 'N',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=D64C5AE8-0B37-21E1-5B7A8BE3F83A5E9C'),
    },
    {
        'provider_camera_id': 'boha-boston-light-east',
        'name': 'Little Brewster - Boston Light Looking East',
        'lat': 42.329333,
        'lon': -70.891806,
        'url': 'https://www.nps.gov/webcams-boha/east-001.jpeg',
        'direction': 'E',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=D5BED697-F515-890D-5B26E4B45F0CE3D8'),
    },
)

MASSACHUSETTS_NPS_MANUAL_REJECTIONS = (
    {
        'provider_camera_id': 'boha-boston-light-south',
        'name': 'Little Brewster - Boston Light Looking South',
        'failure_class': 'placeholder:stale_embedded_timestamp_2026-05-19',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=D5607165-B7B3-D1D0-E3C4108889ED095E'),
    },
)


def fetch_massachusetts_nps_verified():
    candidates = [dict(item) for item in MASSACHUSETTS_NPS_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=8
    )
    rejected = [dict(item) for item in MASSACHUSETTS_NPS_MANUAL_REJECTIONS]
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'Massachusetts', 'Suffolk County', camera['direction'], 'nps',
            camera['source_url'], 60,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'massachusetts_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service',
            'source_url': 'https://www.nps.gov/bost/learn/photosmultimedia/webcams.htm',
            'attribution': 'National Park Service',
            'usage_terms': 'NPS-created website material is generally public domain',
            'usage_terms_url': 'https://www.nps.gov/aboutus/disclaimer.htm',
            'geographic_scope': (
                'Boston National Historical Park and Boston Harbor Islands, '
                'Massachusetts'
            ),
            'refresh_cadence_seconds': 60,
            'candidates': len(candidates) + len(MASSACHUSETTS_NPS_MANUAL_REJECTIONS),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  Massachusetts NPS image verification: {count}/{len(candidates)} current')
    return count


MASSACHUSETTS_MWRA_SOURCE = 'https://www.mwra.com/about-mwra/live-camera-feeds'
MASSACHUSETTS_MWRA_FEEDS = (
    {
        'provider_camera_id': 'mwra-ditp-boston-harbor',
        'name': 'MWRA Deer Island - Boston Harbor',
        'lat': 42.35,
        'lon': -70.958969,
        'url': 'https://www.mwra.com/sites/default/files/camera-streams/ditp.m3u8',
        'county': 'Suffolk County',
        'direction': 'W',
    },
    {
        'provider_camera_id': 'mwra-cosgrove-wachusett-reservoir',
        'name': 'MWRA Cosgrove - Wachusett Reservoir',
        'lat': 42.398307,
        'lon': -71.689638,
        'url': 'https://www.mwra.com/sites/default/files/camera-streams/cosgrove.m3u8',
        'county': 'Worcester County',
        'direction': '',
    },
)

MASSACHUSETTS_MWRA_MANUAL_REJECTIONS = (
    {
        'provider_camera_id': 'mwra-quabbin-reservoir',
        'name': 'MWRA Quabbin Reservoir',
        'failure_class': 'placeholder:maintenance_scaffolding_obscures_view',
        'url': 'https://www.mwra.com/sites/default/files/camera-streams/quabbin.m3u8',
    },
)


def fetch_massachusetts_mwra():
    candidates = [dict(item) for item in MASSACHUSETTS_MWRA_FEEDS]
    verified, errors = verify_live_hls(
        [camera['url'] for camera in candidates],
        probe_interval=8.0,
        workers=2,
        referer=MASSACHUSETTS_MWRA_SOURCE,
    )
    rejected = [dict(item) for item in MASSACHUSETTS_MWRA_MANUAL_REJECTIONS]
    for camera in candidates:
        if camera['url'] not in verified:
            rejected.append({
                'provider_camera_id': camera['provider_camera_id'],
                'name': camera['name'],
                'failure_class': errors.get(
                    camera['url'], 'transient_network:incomplete'
                ),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'hls',
            'Massachusetts', camera['county'], camera['direction'], 'mwra',
            MASSACHUSETTS_MWRA_SOURCE, 6,
        )
        cameras[-1]['provider_camera_id'] = camera['provider_camera_id']

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'massachusetts_mwra_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Massachusetts Water Resources Authority',
            'source_url': MASSACHUSETTS_MWRA_SOURCE,
            'attribution': 'Massachusetts Water Resources Authority',
            'usage_terms': (
                'First-party public live-camera page; no express reuse license found'
            ),
            'geographic_scope': (
                'Deer Island, Wachusett Reservoir, and Quabbin Reservoir, '
                'Massachusetts'
            ),
            'refresh_cadence_seconds': 6,
            'candidates': len(candidates) + len(MASSACHUSETTS_MWRA_MANUAL_REJECTIONS),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  Massachusetts MWRA HLS verification: {count}/{len(candidates)} advancing')
    return count


TENNESSEE_CLARKSVILLE_SOURCE = 'https://www.clarksvilletn.gov/189/Traffic-Cameras'
TENNESSEE_CLARKSVILLE_FEEDS = (
    ('61310c11c88f4', 'Forrest Hills/Wilma Rudolph Camera', 36.576396, -87.301625,
     'https://www.clarksvilletn.gov/1109/Forrest-HillsWilma-Rudolph-Camera'),
    ('61310bc852732', 'Terminal/Wilma Rudolph Camera', 36.588047, -87.293666,
     'https://www.clarksvilletn.gov/1110/TerminalWilma-Rudolph-Camera'),
    ('61310cec8872e', 'Exit 11 Camera', 36.525337, -87.221567,
     'https://www.clarksvilletn.gov/1112/Exit-11-Camera'),
    ('613a762a8184d', 'Exit 4 Camera', 36.599925, -87.28259,
     'https://www.clarksvilletn.gov/1116/Exit-4-Camera'),
    ('614a400064a41', 'Peachers Mill/101st Camera', 36.586005, -87.391051,
     'https://www.clarksvilletn.gov/1121/Peachers-Mill101st-Camera'),
    ('654bec1f29e78', 'Trenton Road/Spring Creek Parkway Camera',
     36.611557, -87.320324,
     'https://www.clarksvilletn.gov/1254/13108/Trenton-Spring-Creek-Parkway'),
    ('68396965be373', 'Peachers Mill/Tiny Town Camera', 36.625424, -87.369947,
     'https://www.clarksvilletn.gov/1390/Peachers-Mill-Tiny-Town-Camera'),
    ('61310c8c412d5', 'Peachers Mill/Providence Camera', 36.550166, -87.382655,
     'https://www.clarksvilletn.gov/1111/Peachers-MillProvidence-Camera'),
    ('6138e5bb22549', 'Madison/Hwy 76 Camera', 36.508674, -87.273053,
     'https://www.clarksvilletn.gov/1115/9588/MadisonHwy-76-Camera'),
    ('64f77b13b6139', 'Fire Station Road/Hwy 76 Camera', 36.520803, -87.235445,
     'https://www.clarksvilletn.gov/1244/12726/Fire-Station-Rd-Hwy-76'),
    ('654becee17d17', 'Whitfield/101st Parkway Camera', 36.580856, -87.336436,
     'https://www.clarksvilletn.gov/1253/Whitfield-101st-Parkway-Camera'),
    ('6839cd98c0e23', 'Fort Campbell/Tiny Town Camera', 36.629532, -87.433943,
     'https://www.clarksvilletn.gov/1385/Fort-Campbell-Tiny-Town'),
    ('6839ce06c0b9c', 'Trenton Road/Tiny Town Camera', 36.624594, -87.317871,
     'https://www.clarksvilletn.gov/1391/Trenton-Road-Tiny-Town-Camera'),
)


def _resolve_ipcamlive_player(source_page, expected_alias):
    page = _http_bytes(source_page, timeout=30).decode('utf-8', 'replace')
    player_matches = re.findall(
        r'https://g\d+\.ipcamlive\.com/player/player\.php\?[^"\'< >]+',
        page,
        re.IGNORECASE,
    )
    player_url = next((
        html.unescape(url) for url in player_matches
        if re.search(rf'[?&]alias={re.escape(expected_alias)}(?:&|$)', html.unescape(url))
    ), None)
    if not player_url:
        raise ValueError('unsupported_embed:first_party_player_missing')
    player = _http_bytes(
        player_url, headers={'Referer': source_page}, timeout=30
    ).decode('utf-8', 'replace')
    if not re.search(r'\bvar\s+available\s*=\s*1\s*;', player):
        raise ValueError('confirmed_not_live:player_unavailable')
    if not re.search(r'\bvar\s+domainlockenabled\s*=\s*0\s*;', player):
        raise ValueError('unsupported_embed:domain_locked')
    address_match = re.search(
        r"\bvar\s+address\s*=\s*'https?://(s\d+\.ipcamlive\.com)/'\s*;",
        player,
        re.IGNORECASE,
    )
    stream_match = re.search(r"\bvar\s+streamid\s*=\s*'([A-Za-z0-9]+)'\s*;", player)
    alias_match = re.search(r"\bvar\s+alias\s*=\s*'([^']+)'\s*;", player)
    if (
        not address_match or not stream_match or not alias_match
        or alias_match.group(1) != expected_alias
    ):
        raise ValueError('unsupported_embed:player_contract_changed')
    hls_url = (
        f'https://{address_match.group(1).lower()}/streams/'
        f'{stream_match.group(1)}/stream.m3u8'
    )
    return player_url, hls_url


def fetch_tennessee_clarksville():
    index_html = _http_bytes(TENNESSEE_CLARKSVILLE_SOURCE, timeout=30).decode(
        'utf-8', 'replace'
    )
    resolved = []
    rejected = []
    for alias, name, lat, lon, source_page in TENNESSEE_CLARKSVILLE_FEEDS:
        if urllib.parse.urlsplit(source_page).path not in index_html:
            rejected.append({
                'provider_camera_id': alias,
                'name': name,
                'failure_class': 'unsupported_embed:camera_removed_from_official_index',
            })
            continue
        try:
            player_url, hls_url = _resolve_ipcamlive_player(source_page, alias)
        except Exception as exc:  # noqa: BLE001
            rejected.append({
                'provider_camera_id': alias,
                'name': name,
                'failure_class': str(exc),
            })
            continue
        resolved.append({
            'provider_camera_id': alias,
            'name': name,
            'lat': lat,
            'lon': lon,
            'source_url': source_page,
            'player_url': player_url,
            'hls_url': hls_url,
        })

    hls_urls = [camera['hls_url'] for camera in resolved]
    verified, errors = verify_live_hls(
        hls_urls, probe_interval=6.0, workers=5
    )
    count = 0
    for camera in resolved:
        if camera['hls_url'] not in verified:
            rejected.append({
                'provider_camera_id': camera['provider_camera_id'],
                'name': camera['name'],
                'failure_class': errors.get(
                    camera['hls_url'], 'transient_network:incomplete'
                ),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['player_url'],
            'embed', 'Tennessee', 'Montgomery County', '', 'ipcamlive',
            camera['source_url'], 10,
        )
        cameras[-1]['provider_camera_id'] = camera['provider_camera_id']
        cameras[-1]['category'] = 'traffic'
        count += 1

    atomic_write_json(
        DATA_DIR / 'tennessee_clarksville_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'City of Clarksville Street Department / IPCamLive',
            'source_url': TENNESSEE_CLARKSVILLE_SOURCE,
            'location_evidence_url': (
                'https://gis.mcgtn.org/arcgis/rest/services/'
                'ERINGStreetNames/MapServer/0'
            ),
            'attribution': 'City of Clarksville Street Department; IPCamLive',
            'usage_terms': (
                'City-published public 24/7 traffic/weather players with '
                'IPCamLive domain locking disabled'
            ),
            'candidates': len(TENNESSEE_CLARKSVILLE_FEEDS),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(TENNESSEE_CLARKSVILLE_FEEDS):
        raise IncompleteProviderError(
            f'incomplete_Clarksville_snapshot:{count}/'
            f'{len(TENNESSEE_CLARKSVILLE_FEEDS)}'
        )
    print(f'  Clarksville IPCamLive verification: {count}/{len(resolved)} advancing')
    return count


# ── Maryland (CHART) ──
def fetch_maryland():
    try:
        url = ('https://chart.maryland.gov/DataFeeds/GetCameraData')
        data = fetch_json(url, headers={'Accept': '*/*'})
        count = 0
        items = data if isinstance(data, list) else data.get('cameras', data.get('features', []))
        for cam in items:
            lat = cam.get('latitude') or cam.get('lat')
            lon = cam.get('longitude') or cam.get('lon')
            name = cam.get('description', '') or cam.get('name', 'MD Camera')
            img_url = cam.get('imageUrl', '') or cam.get('url', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Maryland', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Maryland: {e}')
        return 0


# ── Oregon (TripCheck) ──
def fetch_oregon():
    try:
        url = ('https://www.tripcheck.com/Scripts/map/data/cctvinventory.js')
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0', 'Accept': '*/*'})
        resp = urllib.request.urlopen(req, timeout=15, context=ctx)
        raw = resp.read()
        if raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        text = raw.decode('utf-8', errors='replace')
        # Extract JSON from JS variable assignment
        m = re.search(r'=\s*(\[.*\])\s*;', text, re.DOTALL)
        if not m:
            return 0
        data = json.loads(m.group(1))
        count = 0
        for cam in data:
            lat = cam.get('latitude') or cam.get('lat')
            lon = cam.get('longitude') or cam.get('lon') or cam.get('lng')
            name = cam.get('title', '') or cam.get('name', 'OR Camera')
            img_url = cam.get('imageUrl', '') or cam.get('url', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Oregon', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Oregon: {e}')
        return 0


# ── Utah DOT ──
def fetch_utah():
    try:
        url = ('https://udottraffic.utah.gov/map/mapIcons/Cameras')
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'UT Camera {item_id}'
            img_url = f'https://udottraffic.utah.gov/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Utah', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Utah DOT: {e}')
        return 0


# ── Iteris CDN GeoJSON (SC, MT, SD) ──
def fetch_iteris_geojson(state_code, state_name):
    return collect_iteris_geojson(
        provider_runtime(),
        IterisConfig(state_code, state_name),
    )


# ── SkyVDN HLS (SC SCDOT 511) — Iteris geojson metadata + verified live streams ──
def fetch_skyvdn_hls(state_code, state_name, source_page, report_name):
    try:
        url = (f'https://{state_code.lower()}.cdn.iteris-atis.com'
               '/geojson/icons/metadata/icons.cameras.geojson')
        data = fetch_json(url, timeout=30)
        candidates = []
        seen = set()
        for feat in data.get('features', []):
            props = feat.get('properties', {}) or {}
            if not props.get('active'):
                continue
            stream = str(props.get('https_url') or '').strip()
            if not stream.startswith('https://') or stream in seen:
                continue
            geom = feat.get('geometry', {}) or {}
            coords = geom.get('coordinates') or [0, 0]
            if not isinstance(coords, list) or len(coords) < 2:
                continue
            seen.add(stream)
            candidates.append({
                'camera_id': props.get('id'),
                'name': props.get('description') or props.get('route') or f'{state_name} Camera',
                'lat': coords[1],
                'lon': coords[0],
                'county': props.get('jurisdiction') or '',
                'direction': props.get('direction') or '',
                'url': stream,
            })
        verified_urls, verification_errors = verify_live_hls([c['url'] for c in candidates])
        rejected = []
        added = 0
        for item in candidates:
            if item['url'] not in verified_urls:
                rejected.append({
                    'provider_camera_id': item['camera_id'],
                    'name': item['name'],
                    'url': item['url'],
                    'failure_class': verification_errors.get(
                        item['url'], 'transient_network:verification_incomplete'),
                })
                continue
            before = len(cameras)
            add_camera(item['name'], item['lat'], item['lon'], item['url'],
                       'hls', state_name, item['county'], item['direction'], 'dot',
                       source_page, 10)
            if len(cameras) == before:
                rejected.append({
                    'provider_camera_id': item['camera_id'],
                    'name': item['name'],
                    'url': item['url'],
                    'failure_class': 'location_ambiguous:invalid_coordinates',
                })
                continue
            cameras[-1]['provider_camera_id'] = str(item['camera_id'])
            added += 1
        atomic_write_json(
            DATA_DIR / report_name,
            {
                'generated_at': utc_now_iso(),
                'provider': f'{state_name} (SkyVDN)',
                'source_url': source_page,
                'attribution': f'{state_name} DOT',
                'refresh_cadence_seconds': 10,
                'candidates': len(candidates),
                'verified_live': added,
                'rejected': rejected,
            },
            indent=2,
        )
        print(f'  {state_name} SkyVDN HLS verification: {added}/{len(candidates)} advancing')
        return added
    except Exception as e:
        print(f'  {state_name} SkyVDN: {e}')
        return 0


# ── Alaska (511 mapicons) — verified live snapshot proxy ──
def fetch_alaska():
    try:
        data = fetch_json('https://511.alaska.gov/map/mapIcons/Cameras', timeout=25)
        items = data.get('item2', []) if isinstance(data, dict) else data
        candidates = []
        seen = set()
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = str(item.get('itemId', '')).strip()
            if not item_id:
                continue
            img_url = f'https://511.alaska.gov/map/Cctv/{item_id}'
            if img_url in seen:
                continue
            seen.add(img_url)
            candidates.append({
                'id': item_id,
                'name': item.get('title', '') or f'Alaska Camera {item_id}',
                'lat': loc[0], 'lon': loc[1], 'url': img_url,
            })
        verified, errors = verify_live_images([c['url'] for c in candidates])
        count = 0
        rejected = []
        for cam in candidates:
            if cam['url'] not in verified:
                rejected.append({'provider_camera_id': cam['id'], 'name': cam['name'],
                                 'url': cam['url'],
                                 'failure_class': errors.get(cam['url'], 'transient_network:incomplete')})
                continue
            add_camera(cam['name'], cam['lat'], cam['lon'], cam['url'], 'image',
                       'Alaska', '', '', 'dot', 'https://511.alaska.gov/', 60)
            count += 1
        atomic_write_json(
            DATA_DIR / 'alaska_511_discovery_report.json',
            {'generated_at': utc_now_iso(), 'provider': 'Alaska (511)',
             'source_url': 'https://511.alaska.gov/', 'attribution': 'Alaska DOT&PF',
             'refresh_cadence_seconds': 60, 'candidates': len(candidates),
             'verified_live': count, 'rejected': rejected},
            indent=2,
        )
        print(f'  Alaska 511 image verification: {count}/{len(candidates)} live')
        return count
    except Exception as e:
        print(f'  Alaska: {e}')
        return 0


# ── Arizona (AZ511 DataTables) — verified live snapshot proxy ──
def fetch_az511():
    try:
        base = 'https://az511.com'
        url = f'{base}/List/GetData/Cameras'
        all_rows = []
        start = 0
        while True:
            raw = _http_bytes(
                url,
                headers={'Accept': 'application/json',
                         'Content-Type': 'application/x-www-form-urlencoded',
                         'X-Requested-With': 'XMLHttpRequest',
                         'Referer': base + '/', 'Origin': base},
                data=f'draw=1&start={start}&length=100&search[value]='.encode('ascii'),
                method='POST', timeout=30)
            payload = json.loads(raw)
            rows = payload.get('data', [])
            if not rows:
                break
            all_rows.extend(rows)
            total = payload.get('recordsTotal', 0)
            start += len(rows)
            if start >= total:
                break
        candidates = []
        seen = set()
        for row in all_rows:
            wkt = ''
            try:
                wkt = row.get('latLng', {}).get('geography', {}).get('wellKnownText', '')
            except (AttributeError, TypeError):
                continue
            m = re.search(r'POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)', wkt)
            if not m:
                continue
            lon, lat = float(m.group(1)), float(m.group(2))
            img_url = ''
            for img in row.get('images', []) or []:
                if img.get('disabled') or img.get('blocked'):
                    continue
                raw_url = img.get('imageUrl', '')
                if raw_url:
                    img_url = base + raw_url if raw_url.startswith('/') else raw_url
                    break
            if not img_url or img_url in seen:
                continue
            seen.add(img_url)
            candidates.append({
                'id': str(row.get('id', '')),
                'name': row.get('location') or row.get('roadway') or 'Arizona Camera',
                'lat': lat, 'lon': lon, 'direction': row.get('direction', '') or '',
                'url': img_url,
            })
        verified, errors = verify_live_images([c['url'] for c in candidates])
        count = 0
        rejected = []
        for cam in candidates:
            if cam['url'] not in verified:
                rejected.append({'provider_camera_id': cam['id'], 'name': cam['name'],
                                 'url': cam['url'],
                                 'failure_class': errors.get(cam['url'], 'transient_network:incomplete')})
                continue
            add_camera(cam['name'], cam['lat'], cam['lon'], cam['url'], 'image',
                       'Arizona', '', cam['direction'], 'dot', base + '/', 60)
            count += 1
        atomic_write_json(
            DATA_DIR / 'az511_discovery_report.json',
            {'generated_at': utc_now_iso(), 'provider': 'Arizona (AZ511)',
             'source_url': base + '/', 'attribution': 'Arizona DOT',
             'refresh_cadence_seconds': 60, 'candidates': len(candidates),
             'verified_live': count, 'rejected': rejected},
            indent=2,
        )
        print(f'  AZ511 image verification: {count}/{len(candidates)} live')
        return count
    except Exception as e:
        print(f'  Arizona: {e}')
        return 0


# ── Missouri DOT ──
def fetch_missouri():
    try:
        data = fetch_json('https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json')
        count = 0
        items = data if isinstance(data, list) else data.get('cameras', data.get('features', []))
        for cam in items:
            name = cam.get('location', '') or cam.get('name', 'MO Camera')
            lat = cam.get('y') or cam.get('lat') or cam.get('latitude')
            lon = cam.get('x') or cam.get('lon') or cam.get('longitude')
            html = cam.get('html', '')
            m = re.search(r'(https?://[^\s"\']+\.m3u8[^\s"\']*)', html)
            img_url = m.group(1) if m else ''
            if not img_url:
                img_url = cam.get('url', '') or cam.get('imageUrl', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Missouri', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Missouri: {e}')
        return 0


# ── Delaware DOT (live HLS) ──
def fetch_delaware_live():
    try:
        api_url = 'https://tmc.deldot.gov/json/videocamera.json'
        data = fetch_json(api_url)
        items = data if isinstance(data, list) else data.get('videoCameras', [])
        candidates = []
        for cam in items:
            if not cam.get('enabled') or cam.get('status') != 'Active':
                continue
            urls = cam.get('urls', {})
            stream_url = urls.get('m3u8s', '') or urls.get('m3u8', '')
            if not stream_url.startswith('https://'):
                continue
            candidates.append((cam, stream_url))
        verified_urls, verification_errors = verify_live_hls(
            [stream_url for _, stream_url in candidates]
        )
        count = 0
        rejected = []
        for cam, stream_url in candidates:
            if stream_url not in verified_urls:
                rejected.append({
                    'provider_camera_id': cam.get('id'),
                    'name': cam.get('title'),
                    'url': stream_url,
                    'failure_class': verification_errors.get(
                        stream_url, 'transient_network:verification_incomplete'
                    ),
                })
                continue
            before = len(cameras)
            add_camera(
                cam.get('title', 'DE Camera'), cam.get('lat'), cam.get('lon'),
                stream_url, 'hls', 'Delaware', cam.get('county', ''), '', 'dot',
                api_url, 10,
            )
            if len(cameras) == before:
                rejected.append({
                    'provider_camera_id': cam.get('id'),
                    'name': cam.get('title'),
                    'url': stream_url,
                    'failure_class': 'location_ambiguous:invalid_coordinates',
                })
                continue
            cameras[-1]['provider_camera_id'] = str(cam.get('id'))
            count += 1
        atomic_write_json(
            DATA_DIR / 'deldot_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Delaware (live HLS)',
                'source_url': api_url,
                'attribution': 'Delaware Department of Transportation',
                'provider_timestamp': None if isinstance(data, list) else data.get('timestamp'),
                'inventory_total': len(items),
                'candidates': len(candidates),
                'verified_live': count,
                'rejected': rejected,
            },
            indent=2,
        )
        print(f'  DelDOT HLS verification: {count}/{len(candidates)} advancing')
        return count
    except Exception as e:
        print(f'  Delaware live: {e}')
        return 0


DELAWARE_CMLF_CAMERAS = (
    {
        'player_id': 'ubwk93C3',
        'name': 'Cape May-Lewes Ferry - Lewes Bulkhead Osprey',
        'stream': 'LewesOsprey.stream',
        'category': 'wildlife',
    },
    {
        'player_id': 'XogzbMib',
        'name': 'Cape May-Lewes Ferry - Lewes Toll Booth',
        'stream': 'LewesTollBooth.stream',
        'category': 'ferry_traffic',
    },
    {
        'player_id': 'FsOGfNId',
        'name': 'Cape May-Lewes Ferry - Lewes Staging Lanes',
        'stream': 'LewesParkingLot.stream',
        'category': 'ferry_traffic',
    },
    {
        'player_id': 'lxHUe3TN',
        'name': 'Cape May-Lewes Ferry - Lewes Green',
        'stream': 'LewesGreen.stream',
        'category': 'ferry_harbor',
    },
    {
        'player_id': 'hN4hXxOq',
        'name': 'Cape May-Lewes Ferry - Lewes Freeman Highway',
        'stream': 'FreemanHighway.stream',
        'category': 'ferry_traffic',
    },
    {
        'player_id': '7964lNnn',
        'name': 'Cape May-Lewes Ferry - Lewes Grain On the Rocks',
        'stream': 'OTRLewes.stream',
        'category': 'ferry_harbor',
    },
)


def fetch_delaware_cmlf_verified():
    source_page = 'https://www.cmlf.com/check-traffic-live-webcam-feeds/'
    page = _http_bytes(source_page, timeout=30).decode('utf-8', 'replace')
    missing_players = [
        item['player_id']
        for item in DELAWARE_CMLF_CAMERAS
        if item['player_id'] not in page
    ]
    if missing_players:
        raise IncompleteProviderError(
            f'CMLF official camera inventory is missing players: {missing_players}'
        )
    hls_by_id = {
        item['player_id']: (
            'https://5b18e54927a82.streamlock.net/live/'
            f"{item['stream']}/playlist.m3u8"
        )
        for item in DELAWARE_CMLF_CAMERAS
    }
    verified, errors = verify_live_hls(
        list(hls_by_id.values()),
        probe_interval=8.0,
        workers=6,
        referer=source_page,
    )
    rejected = [
        {
            'provider_camera_id': f'cmlf:{player_id}',
            'failure_class': errors.get(
                hls_url, 'confirmed_not_live:not_advancing'
            ),
        }
        for player_id, hls_url in hls_by_id.items()
        if hls_url not in verified
    ]
    if rejected:
        atomic_write_json(
            DATA_DIR / 'youtube_discovery_report_delaware_cmlf.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Cape May-Lewes Ferry / Delaware River and Bay Authority',
                'source_url': source_page,
                'verified_live': len(verified),
                'rejected': rejected,
            },
            indent=2,
        )
        raise IncompleteProviderError('CMLF HLS verification is incomplete')

    accepted = []
    for item in DELAWARE_CMLF_CAMERAS:
        player_id = item['player_id']
        player_url = f'https://cdn.jwplayer.com/players/{player_id}-wHOfzSFM.html'
        add_camera(
            item['name'],
            38.782424,
            -75.119877,
            player_url,
            'embed',
            'Delaware',
            'Sussex County',
            '',
            'dot',
            source_page,
            30,
        )
        cameras[-1]['provider_camera_id'] = f'cmlf:{player_id}'
        cameras[-1]['category'] = item['category']
        accepted.append({
            'provider_camera_id': f'cmlf:{player_id}',
            'name': item['name'],
            'player_url': player_url,
            'verification_stream_url': hls_by_id[player_id],
        })
    atomic_write_json(
        DATA_DIR / 'youtube_discovery_report_delaware_cmlf.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Cape May-Lewes Ferry / Delaware River and Bay Authority',
            'source_url': source_page,
            'geographic_scope': 'Lewes Ferry Terminal, Lewes, Sussex County, Delaware',
            'location_evidence': (
                'The official webcam page identifies every accepted player as a '
                'Lewes terminal view and publishes the terminal GPS point '
                '38.782424,-75.119877.'
            ),
            'attribution': 'Cape May-Lewes Ferry / Delaware River and Bay Authority',
            'license_or_usage_terms': (
                'DRBA reserves copyright in site contents. StormScope therefore '
                'stores the exact provider-published branded JWPlayer iframe and '
                'does not persist, proxy, or archive the verification HLS media.'
            ),
            'verified_live': len(accepted),
            'rejected': [],
            'refresh_cadence_seconds': 30,
            'accepted': accepted,
        },
        indent=2,
    )
    print(
        f'  CMLF Lewes HLS verification: '
        f'{len(accepted)}/{len(DELAWARE_CMLF_CAMERAS)} advancing'
    )
    return len(accepted)


# ── New Mexico DOT ──
NEW_MEXICO_DOT_API = 'https://servicev5.nmroads.com/RealMapWAR'
NEW_MEXICO_DOT_SOURCE = 'https://www.nmroads.com/default.html'


def _nmroads_image_url(camera_name, timestamp=0):
    return f'{NEW_MEXICO_DOT_API}/GetCameraImage?' + urllib.parse.urlencode({
        'ts': timestamp,
        'cameraName': camera_name,
    })


def _nmroads_snapshot(camera):
    camera_name = camera['name']
    timestamp_url = f'{NEW_MEXICO_DOT_API}/GetCachedObject?' + urllib.parse.urlencode({
        'key': f'{camera_name}Time',
    })
    raw_timestamp = _http_bytes(timestamp_url, timeout=20).strip()
    try:
        provider_milliseconds = int(raw_timestamp)
    except ValueError as exc:
        body = _http_bytes(
            _nmroads_image_url(camera_name, time.time_ns()),
            headers={'Accept': 'image/jpeg,image/*,*/*', 'Cache-Control': 'no-cache'},
            timeout=25,
        )
        if not body:
            raise ValueError('confirmed_dead:empty_image') from exc
        raise ValueError('placeholder:missing_provider_timestamp') from exc
    provider_time = datetime.fromtimestamp(
        provider_milliseconds / 1000, tz=timezone.utc
    )
    age = datetime.now(timezone.utc) - provider_time
    if age < -timedelta(minutes=5) or age > timedelta(minutes=3):
        raise ValueError(f'placeholder:stale_provider_timestamp:{int(age.total_seconds())}')

    body = _http_bytes(
        _nmroads_image_url(camera_name, time.time_ns()),
        headers={'Accept': 'image/jpeg,image/*,*/*', 'Cache-Control': 'no-cache'},
        timeout=25,
    )
    if not body:
        raise ValueError('confirmed_dead:empty_image')
    if len(body) < 2_000 or not body.startswith(b'\xff\xd8\xff'):
        raise ValueError('placeholder:not_a_valid_jpeg')
    return hashlib.sha256(body).hexdigest(), len(body), provider_time.isoformat()


def verify_nmroads_images(candidates, probe_interval=65.0, workers=12):
    first = {}
    second = {}
    errors = {}

    def probe(item):
        try:
            return item['name'], _nmroads_snapshot(item), None
        except Exception as exc:  # noqa: BLE001
            return item['name'], None, str(exc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for camera_name, snapshot, error in executor.map(probe, candidates):
            if error:
                errors.setdefault(camera_name, []).append(error)
            else:
                first[camera_name] = snapshot
    if probe_interval:
        time.sleep(probe_interval)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for camera_name, snapshot, error in executor.map(probe, candidates):
            if error:
                errors.setdefault(camera_name, []).append(error)
            else:
                second[camera_name] = snapshot

    verified = set(first) & set(second)
    final_errors = {}
    for camera in candidates:
        camera_name = camera['name']
        if camera_name in verified:
            first_snapshot = first[camera_name]
            second_snapshot = second[camera_name]
            if (
                first_snapshot[0] != second_snapshot[0]
                or first_snapshot[2] != second_snapshot[2]
            ):
                continue
            verified.remove(camera_name)
            final_errors[camera_name] = 'placeholder:not_advancing'
            continue
        details = errors.get(camera_name, ['transient_network:incomplete'])
        detail = details[-1]
        final_errors[camera_name] = (
            detail if detail.startswith(('placeholder:', 'confirmed_dead:',
                                         'transient_network:'))
            else f'transient_network:{detail}'
        )
    return verified, final_errors, second


def _nmroads_direction(title):
    match = re.search(r'(?i)(?:^|[^A-Z])(NB|SB|EB|WB)(?:[^A-Z]|$)', title)
    if match:
        return match.group(1)[0].upper()
    for word, direction in (
        ('north', 'N'), ('south', 'S'), ('east', 'E'), ('west', 'W')
    ):
        if re.search(rf'(?i)\b{word}\b', title):
            return direction
    return ''


def fetch_newmexico():
    api_url = f'{NEW_MEXICO_DOT_API}/GetCameraInfo'
    data = fetch_json(api_url, timeout=20)
    items = data if isinstance(data, list) else data.get('cameraInfo', [])
    enabled = [camera for camera in items if camera.get('enabled')]
    verified, errors, snapshots = verify_nmroads_images(enabled)
    rejected = []
    count = 0
    for camera in enabled:
        camera_name = camera['name']
        if camera_name not in verified:
            rejected.append({
                'provider_camera_id': camera_name,
                'name': camera.get('title') or camera_name,
                'grouping': camera.get('grouping') or '',
                'district': camera.get('district'),
                'failure_class': errors.get(
                    camera_name, 'transient_network:incomplete'
                ),
            })
            continue
        add_camera(
            camera.get('title') or camera_name,
            camera['lat'],
            camera['lon'],
            _nmroads_image_url(camera_name),
            'image',
            'New Mexico',
            '',
            _nmroads_direction(camera.get('title') or camera_name),
            'dot',
            NEW_MEXICO_DOT_SOURCE,
            60,
        )
        cameras[-1]['provider_camera_id'] = camera_name
        cameras[-1]['provider_timestamp'] = snapshots[camera_name][2]
        count += 1

    atomic_write_json(
        DATA_DIR / 'new_mexico_dot_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'New Mexico Department of Transportation',
            'source_url': api_url,
            'public_source_url': NEW_MEXICO_DOT_SOURCE,
            'attribution': 'New Mexico Department of Transportation / NMRoads',
            'usage_terms': (
                'Public traveler-information service; no express reuse license located'
            ),
            'refresh_cadence_seconds': 60,
            'inventory_total': len(items),
            'enabled': len(enabled),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  New Mexico DOT image verification: {count}/{len(enabled)} current')
    return count


# ── NOAA/NWS Albuquerque current five-minute stills ──
NEW_MEXICO_NWS_FEEDS = (
    {
        'provider_camera_id': 'extne',
        'name': 'NWS Albuquerque - Sunport and Sandia Mountains',
        'url': 'https://www.weather.gov/images/abq/webcam/extne_000.jpg',
        'direction': 'NE',
    },
    {
        'provider_camera_id': 'extsouth',
        'name': 'NWS Albuquerque - South toward Manzano Mountains',
        'url': 'https://www.weather.gov/images/abq/webcam/extsouth_000.jpg',
        'direction': 'S',
    },
    {
        'provider_camera_id': 'extwest',
        'name': 'NWS Albuquerque - West Mesa',
        'url': 'https://www.weather.gov/images/abq/webcam/extwest_000.jpg',
        'direction': 'W',
    },
)
NEW_MEXICO_NWS_SOURCE = 'https://www.weather.gov/abq/webcam'
NEW_MEXICO_NWS_LAT = 35.036792990052
NEW_MEXICO_NWS_LON = -106.625605101972


def fetch_new_mexico_nws():
    candidates = [dict(item) for item in NEW_MEXICO_NWS_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=3
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], NEW_MEXICO_NWS_LAT, NEW_MEXICO_NWS_LON,
            camera['url'], 'image', 'New Mexico', 'Bernalillo County',
            camera['direction'], 'noaa', NEW_MEXICO_NWS_SOURCE, 300,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        count += 1

    atomic_write_json(
        DATA_DIR / 'new_mexico_nws_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'NOAA National Weather Service Albuquerque',
            'source_url': NEW_MEXICO_NWS_SOURCE,
            'attribution': 'NOAA/National Weather Service',
            'geographic_scope': 'NWS Albuquerque office and Sunport',
            'location_evidence': 'Official office address matched by U.S. Census geocoder',
            'refresh_cadence_seconds': 300,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  New Mexico NWS image verification: {count}/{len(candidates)} current')
    return count


NEW_MEXICO_NPS_FEEDS = (
    {
        'provider_camera_id': 'vall-valle-grande-cabin',
        'name': 'Valle Grande from the Cabin District',
        'lat': 35.86438952202784,
        'lon': -106.51895703889164,
        'url': 'https://www.nps.gov/webcams-vall/valle_grande_cabin_webcam.jpg',
        'county': 'Sandoval County',
        'source_url': ('https://www.nps.gov/media/webcam/view.htm?'
                       'id=A6FB0323-FCA4-211B-12314249C522ED57'),
    },
)


def fetch_new_mexico_nps_verified():
    candidates = [dict(item) for item in NEW_MEXICO_NPS_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=1
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'New Mexico', camera['county'], '', 'nps', camera['source_url'], 60,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['_replace_source_page'] = True
        count += 1

    atomic_write_json(
        DATA_DIR / 'new_mexico_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service',
            'source_url': candidates[0]['source_url'],
            'attribution': 'National Park Service',
            'geographic_scope': 'Valles Caldera National Preserve, New Mexico',
            'refresh_cadence_seconds': 60,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  New Mexico NPS image verification: {count}/{len(candidates)} current')
    return count


NEW_MEXICO_USGS_FEEDS = (
    {
        'provider_camera_id': 'nm-gavilan-canyon-skunk-canyon',
        'name': 'Gavilan Canyon at Skunk Canyon near Hollywood',
        'lat': 33.34488056,
        'lon': -105.6439111,
        'url': ('https://usgs-nims-images.s3.amazonaws.com/overlay/'
                'NM_Gavilan_Canyon_at_Skunk_Canyon_near_Hollywood/'
                'NM_Gavilan_Canyon_at_Skunk_Canyon_near_Hollywood_newest.jpg'),
        'county': 'Lincoln County',
        'source_url': ('https://www.usgs.gov/centers/new-mexico-water-science-center/'
                       'science/new-mexico-water-science-center-webcams'),
        'refresh_cadence_seconds': 300,
    },
    {
        'provider_camera_id': '08386500',
        'name': 'Rio Ruidoso above Ruidoso',
        'lat': 33.33673056,
        'lon': -105.7414806,
        'url': ('https://usgs-nims-images.s3.amazonaws.com/overlay/'
                'NM_RIO_RUIDOSO_ABOVE_RUIDOSO/'
                'NM_RIO_RUIDOSO_ABOVE_RUIDOSO_newest.jpg'),
        'county': 'Lincoln County',
        'source_url': ('https://www.usgs.gov/media/webcams/'
                       'rio-ruidoso-webcam-upstream-ruidoso-nm'),
        'refresh_cadence_seconds': 120,
    },
    {
        'provider_camera_id': '08386505',
        'name': 'Rio Ruidoso at Ruidoso',
        'lat': 33.33653056,
        'lon': -105.7263083,
        'url': ('https://usgs-nims-images.s3.amazonaws.com/overlay/'
                'NM_RIO_RUIDOSO_AT_RUIDOSO/'
                'NM_RIO_RUIDOSO_AT_RUIDOSO_newest.jpg'),
        'county': 'Lincoln County',
        'source_url': ('https://www.usgs.gov/media/webcams/'
                       'rio-ruidoso-ruidoso-nm-webcam'),
        'refresh_cadence_seconds': 120,
    },
)


def fetch_new_mexico_usgs():
    candidates = [dict(item) for item in NEW_MEXICO_USGS_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=4
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'New Mexico', camera['county'], '', 'usgs', camera['source_url'],
            camera['refresh_cadence_seconds'],
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        count += 1

    atomic_write_json(
        DATA_DIR / 'new_mexico_usgs_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'U.S. Geological Survey New Mexico Water Science Center',
            'attribution': 'U.S. Geological Survey',
            'usage_terms': 'Public domain',
            'geographic_scope': 'New Mexico stream and canyon monitoring sites',
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  New Mexico USGS image verification: {count}/{len(candidates)} current')
    return count


NEW_MEXICO_NRAO_FEEDS = (
    {
        'provider_camera_id': 'vla-antenna-assembly-building-ne',
        'name': 'Very Large Array - Antenna Assembly Building Northeast View',
        'lat': 34.07276,
        'lon': -107.62833,
        'url': 'https://public.nrao.edu/wp-content/uploads/temp/vla_webcam_temp.jpg',
        'county': 'Socorro County',
        'direction': 'NE',
        'source_url': 'https://public.nrao.edu/vla-webcam/',
        'require_content_change': True,
        'cache_bust': True,
    },
)


def fetch_new_mexico_nrao():
    candidates = [dict(item) for item in NEW_MEXICO_NRAO_FEEDS]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=16.0, workers=1
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'New Mexico', camera['county'], camera['direction'], 'nrao',
            camera['source_url'], 15,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        if snapshots[camera_id][2]:
            cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        count += 1

    atomic_write_json(
        DATA_DIR / 'new_mexico_nrao_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Radio Astronomy Observatory',
            'source_url': NEW_MEXICO_NRAO_FEEDS[0]['source_url'],
            'attribution': 'NRAO/AUI/NSF',
            'usage_terms': 'CC BY 4.0',
            'usage_terms_url': 'https://public.nrao.edu/media-use/',
            'geographic_scope': 'Very Large Array, Socorro County, New Mexico',
            'refresh_cadence_seconds': 15,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  New Mexico NRAO image verification: {count}/{len(candidates)} current')
    return count


# ── Minnesota 511 (CARS / MnDOT IRIS) ──
MINNESOTA_511_SOURCE = 'https://511mn.org/list/cameras'
MINNESOTA_511_API = 'https://mntg.carsprogram.org/cameras_v1/api/cameras'
MINNESOTA_511_MINIMUM_INVENTORY = 1400


def _retry_minnesota_hls(urls, retry_delay=12.0):
    verified, errors = verify_live_hls(
        urls, probe_interval=8.0, workers=32, referer=MINNESOTA_511_SOURCE
    )
    retryable = [
        url for url in urls
        if url not in verified
        and str(errors.get(url) or '').startswith('transient_network:')
    ]
    if not retryable:
        return verified, errors
    if retry_delay:
        time.sleep(retry_delay)
    retry_verified, retry_errors = verify_live_hls(
        retryable, probe_interval=8.0, workers=8, referer=MINNESOTA_511_SOURCE
    )
    verified.update(retry_verified)
    for url in retryable:
        if url in retry_verified:
            errors.pop(url, None)
        elif url in retry_errors:
            errors[url] = retry_errors[url]
    return verified, errors


def _retry_minnesota_images(
    candidates, probe_interval=910.0, retry_delay=12.0
):
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=probe_interval, workers=32
    )
    retryable = [
        item for item in candidates
        if item['provider_camera_id'] not in verified
        and str(errors.get(item['provider_camera_id']) or '').startswith(
            'transient_network:'
        )
    ]
    if not retryable:
        return verified, errors, snapshots
    if retry_delay:
        time.sleep(retry_delay)
    retry_verified, retry_errors, retry_snapshots = verify_current_jpeg_images(
        retryable, probe_interval=2.0, workers=8
    )
    verified.update(retry_verified)
    snapshots.update(retry_snapshots)
    for item in retryable:
        camera_id = item['provider_camera_id']
        if camera_id in retry_verified:
            errors.pop(camera_id, None)
        elif camera_id in retry_errors:
            errors[camera_id] = retry_errors[camera_id]
    return verified, errors, snapshots


def _minnesota_direction(name):
    match = re.search(r'\b(NB|SB|EB|WB|N|S|E|W)\b', str(name), re.IGNORECASE)
    return match.group(1).upper() if match else ''


def fetch_minnesota_511():
    inventory = fetch_json(MINNESOTA_511_API, timeout=60)
    if not isinstance(inventory, list) or len(inventory) < MINNESOTA_511_MINIMUM_INVENTORY:
        raise IncompleteProviderError(
            f'truncated_inventory:{len(inventory) if isinstance(inventory, list) else 0}'
        )

    candidates = []
    rejected = []
    seen_urls = set()
    for camera in inventory:
        location = camera.get('location') or {}
        if camera.get('public') is not True:
            continue
        for view_index, view in enumerate(camera.get('views') or []):
            url = str(view.get('url') or '').strip()
            provider_camera_id = f"{camera.get('id')}:{view_index}"
            if not url.startswith('https://'):
                rejected.append({
                    'provider_camera_id': provider_camera_id,
                    'name': view.get('name') or camera.get('name') or '',
                    'failure_class': 'unsupported_embed:no_https_media',
                })
                continue
            if url in seen_urls:
                rejected.append({
                    'provider_camera_id': provider_camera_id,
                    'name': view.get('name') or camera.get('name') or '',
                    'failure_class': 'duplicate:normalized_feed_url',
                })
                continue
            seen_urls.add(url)
            view_type = str(view.get('type') or '')
            if view_type not in {'WMP', 'STILL_IMAGE'}:
                rejected.append({
                    'provider_camera_id': provider_camera_id,
                    'name': view.get('name') or camera.get('name') or '',
                    'failure_class': f'unsupported_embed:view_type_{view_type or "missing"}',
                })
                continue
            candidates.append({
                'provider_camera_id': provider_camera_id,
                'provider_location_id': str(camera.get('id') or ''),
                'name': view.get('name') or camera.get('name') or 'MnDOT Camera',
                'lat': location.get('latitude'),
                'lon': location.get('longitude'),
                'city_reference': location.get('cityReference') or '',
                'route_id': location.get('routeId') or '',
                'url': url,
                'type': 'hls' if view_type == 'WMP' else 'image',
                'provider_updated': camera.get('lastUpdated'),
                'provider_image_timestamp': view.get('imageTimestamp'),
            })

    hls_candidates = [item for item in candidates if item['type'] == 'hls']
    image_candidates = [
        {**item, 'cache_bust': True, 'require_content_change': True}
        for item in candidates if item['type'] == 'image'
    ]
    verified_hls, hls_errors = _retry_minnesota_hls(
        [item['url'] for item in hls_candidates]
    )
    verified_images, image_errors, image_snapshots = _retry_minnesota_images(
        image_candidates
    )

    count = 0
    type_counts = {'hls': 0, 'image': 0}
    for item in candidates:
        if item['type'] == 'hls':
            is_verified = item['url'] in verified_hls
            failure = hls_errors.get(item['url'])
        else:
            is_verified = item['provider_camera_id'] in verified_images
            failure = image_errors.get(item['provider_camera_id'])
        if not is_verified:
            rejected.append({
                'provider_camera_id': item['provider_camera_id'],
                'name': item['name'],
                'url': item['url'],
                'failure_class': failure or 'transient_network:verification_incomplete',
            })
            continue
        before = len(cameras)
        add_camera(
            item['name'], item['lat'], item['lon'], item['url'], item['type'],
            'Minnesota', '', _minnesota_direction(item['name']), 'dot',
            MINNESOTA_511_SOURCE, 10 if item['type'] == 'hls' else 900,
        )
        if len(cameras) == before:
            rejected.append({
                'provider_camera_id': item['provider_camera_id'],
                'name': item['name'],
                'failure_class': 'location_ambiguous:invalid_provider_coordinates',
            })
            continue
        row = cameras[-1]
        row['provider_camera_id'] = item['provider_camera_id']
        row['provider_location_id'] = item['provider_location_id']
        row['provider_updated'] = item['provider_updated']
        row['provider_image_timestamp'] = item['provider_image_timestamp']
        if item['type'] == 'image':
            snapshot = image_snapshots.get(item['provider_camera_id'])
            if snapshot and snapshot[2]:
                row['provider_timestamp'] = snapshot[2]
        row['category'] = 'traffic'
        type_counts[item['type']] += 1
        count += 1

    minimum_verified = int(len(candidates) * 0.80)
    atomic_write_json(
        DATA_DIR / 'minnesota_511_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Minnesota 511 / MnDOT IRIS',
            'source_url': MINNESOTA_511_SOURCE,
            'api_url': MINNESOTA_511_API,
            'attribution': 'Minnesota Department of Transportation / Minnesota 511',
            'usage_terms': (
                'Official public real-time traveler-information service; '
                'no express reuse license located'
            ),
            'refresh_cadence_seconds': {'hls': 10, 'image': 900},
            'inventory_locations': len(inventory),
            'candidate_views': len(candidates),
            'verified_live': count,
            'verified_by_type': type_counts,
            'rejected': rejected,
        },
        indent=2,
    )
    if count < minimum_verified:
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{minimum_verified}'
        )
    print(
        f'  Minnesota 511 verification: {count}/{len(candidates)} current '
        f'({type_counts["hls"]} HLS, {type_counts["image"]} images)'
    )
    return count


MINNESOTA_USGS_NIMS_FEEDS = (
    {
        'provider_camera_id': 'MN_Rainy_River_at_Boat_Landing_below_International_Falls',
        'name': 'Rainy River at Boat Landing below International Falls',
        'lat': 48.5922222,
        'lon': -93.4466667,
        'county': 'Koochiching County',
        'site': 'USGS-05129515',
    },
    {
        'provider_camera_id': 'MN_CLEARWATER_RIVER_AT_RED_LAKE_FALLS_MN',
        'name': 'Clearwater River at Red Lake Falls',
        'lat': 47.88620556,
        'lon': -96.2765806,
        'county': 'Red Lake County',
        'site': 'USGS-05078500',
    },
    {
        'provider_camera_id': 'MN_Buffalo_River_near_Dilworth',
        'name': 'Buffalo River near Dilworth',
        'lat': 46.963238,
        'lon': -96.661716,
        'county': 'Clay County',
        'site': 'USGS-05062000',
    },
    {
        'provider_camera_id': 'MN_Knife_River_Near_Two_Harbors',
        'name': 'Knife River near Two Harbors',
        'lat': 46.94694,
        'lon': -91.795577,
        'county': 'Lake County',
        'site': 'USGS-04015330',
    },
    {
        'provider_camera_id': 'MN_St_Croix_River_at_Stillwater',
        'name': 'St. Croix River at Stillwater',
        'lat': 45.05607806,
        'lon': -92.8040963,
        'county': 'Washington County',
        'site': 'USGS-05341550',
    },
    {
        'provider_camera_id': 'MN_Mississippi_River_below_Lock_and_Dam_2_at_Hastings',
        'name': 'Mississippi River below Lock and Dam 2 at Hastings',
        'lat': 44.7458333,
        'lon': -92.8477778,
        'county': 'Dakota County',
        'site': 'USGS-05331580',
    },
    {
        'provider_camera_id': 'MN_Cannon_River_at_Northfield',
        'name': 'Cannon River at Northfield',
        'lat': 44.4585833,
        'lon': -93.1596667,
        'county': 'Rice County',
        'site': 'USGS-05355024',
    },
    {
        'provider_camera_id': 'MN_Mississippi_River_at_St_Paul',
        'name': 'Mississippi River at Saint Paul',
        'lat': 44.9444444,
        'lon': -93.0881111,
        'county': 'Ramsey County',
        'site': 'USGS-05331000',
    },
    {
        'provider_camera_id': 'MN_Otter_Tail_River_below_Orwell_Dam_nr_Fergus_Falls',
        'name': 'Otter Tail River below Orwell Dam near Fergus Falls',
        'lat': 46.2143495,
        'lon': -96.1841473,
        'county': 'Otter Tail County',
        'site': 'USGS-05046000',
    },
    {
        'provider_camera_id': 'MN_Snake_River_near_Pine_City',
        'name': 'Snake River near Pine City',
        'lat': 45.84162199,
        'lon': -92.9335412,
        'county': 'Pine County',
        'site': 'USGS-05338500',
    },
    {
        'provider_camera_id': 'MN_Des_Moines_River_at_Jackson',
        'name': 'Des Moines River at Jackson',
        'lat': 43.6207916,
        'lon': -94.9851299,
        'county': 'Jackson County',
        'site': 'USGS-05476000',
    },
    {
        'provider_camera_id': 'MN_Minnesota_River_at_Morton',
        'name': 'Minnesota River at Morton',
        'lat': 44.5460717,
        'lon': -94.9963838,
        'county': 'Redwood County',
        'site': 'USGS-05316580',
    },
)


def fetch_minnesota_usgs_verified():
    candidates = []
    for feed in MINNESOTA_USGS_NIMS_FEEDS:
        candidate = dict(feed)
        camera_id = candidate['provider_camera_id']
        candidate['url'] = (
            'https://usgs-nims-images.s3.amazonaws.com/overlay/'
            f'{camera_id}/{camera_id}_newest.jpg'
        )
        candidate['max_age_seconds'] = 7200
        candidates.append(candidate)

    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=6
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(
                    camera_id, 'transient_network:verification_incomplete'
                ),
            })
            continue
        source_url = (
            'https://waterdata.usgs.gov/monitoring-location/'
            f'{camera["site"]}/'
        )
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'],
            'image', 'Minnesota', camera['county'], '', 'usgs', source_url, 3600,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['category'] = 'river'
        count += 1

    atomic_write_json(
        DATA_DIR / 'minnesota_usgs_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'USGS National Imagery Management System',
            'source_url': 'https://api.waterdata.usgs.gov/nims/v0',
            'attribution': 'U.S. Geological Survey',
            'usage_terms': 'USGS-authored NIMS/HIVIS imagery is public domain',
            'refresh_cadence_seconds': 3600,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  Minnesota USGS image verification: {count}/{len(candidates)} current')
    return count


HAWAII_USGS_NIMS_FEEDS = (
    {
        'provider_camera_id': 'HI_Kilauea_KWcam',
        'name': 'Kilauea Halemaumau West-Rim Panorama (KWcam)',
        'lat': 19.40754, 'lon': -155.29175, 'direction': 'E', 'cadence': 120,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Kilauea_B1cam',
        'name': 'Kilauea Caldera East Rim (B1cam)',
        'lat': 19.402388, 'lon': -155.267455, 'direction': '', 'cadence': 120,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_MDLcam',
        'name': 'Mauna Loa Southwest Rift Zone from Dandelion Cone (MDLcam)',
        'lat': 19.35303, 'lon': -155.6653, 'direction': '', 'cadence': 300,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Kilauea_PWcam',
        'name': 'Puu Oo West Flank (PWcam)',
        'lat': 19.390348, 'lon': -155.108235, 'direction': '', 'cadence': 600,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_MK2cam',
        'name': 'Mauna Loa Summit from Maunakea (MK2cam)',
        'lat': 19.78955, 'lon': -155.45848, 'direction': 'S', 'cadence': 300,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Kilauea_MITDcam',
        'name': 'Kilauea Southwest Rift Zone from Hilina Pali (MITDcam)',
        'lat': 19.3356, 'lon': -155.301, 'direction': 'N', 'cadence': 300,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Kilauea_KPcam',
        'name': 'Kilauea Summit from Mauna Loa Strip Road (KPcam)',
        'lat': 19.4934, 'lon': -155.38326, 'direction': '', 'cadence': 300,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_MLcam',
        'name': 'Mokuaweoweo Caldera Northwest Rim (MLcam)',
        'lat': 19.481624, 'lon': -155.599231, 'direction': '', 'cadence': 300,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_HLcam',
        'name': 'Mauna Loa Northwest Flank from Hualalai (HLcam)',
        'lat': 19.68108, 'lon': -155.82105, 'direction': '', 'cadence': 1200,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Kilauea_MUcam',
        'name': 'Maunaulu (MUcam)',
        'lat': 19.3673, 'lon': -155.2007, 'direction': '', 'cadence': 300,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_M3cam',
        'name': 'Mauna Loa Upper Southwest Rift Zone (M3cam)',
        'lat': 19.35393, 'lon': -155.66462, 'direction': '', 'cadence': 300,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_MSPcam',
        'name': 'Mauna Loa Southwest Rift Zone from South Point (MSPcam)',
        'lat': 18.9793, 'lon': -155.668, 'direction': '', 'cadence': 600,
        'volcano': 'mauna-loa',
    },
    {
        'provider_camera_id': 'HI_Kilauea_HPcam',
        'name': 'Holei Pali (HPcam)',
        'lat': 19.31714, 'lon': -155.10235, 'direction': '', 'cadence': 1200,
        'volcano': 'kilauea',
    },
    {
        'provider_camera_id': 'HI_Mauna_Loa_M2cam',
        'name': 'Mauna Loa Middle Southwest Rift Zone (M2cam)',
        'lat': 19.21526, 'lon': -155.73906, 'direction': '', 'cadence': 300,
        'volcano': 'mauna-loa',
    },
)


def fetch_hawaii_usgs_verified():
    candidates = []
    for feed in HAWAII_USGS_NIMS_FEEDS:
        candidate = dict(feed)
        camera_id = candidate['provider_camera_id']
        candidate['url'] = (
            'https://usgs-nims-images.s3.amazonaws.com/overlay/'
            f'{camera_id}/{camera_id}_newest.jpg'
        )
        candidate['max_age_seconds'] = max(300, candidate['cadence'] * 2)
        candidates.append(candidate)

    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=7
    )
    rejected = []
    count = 0
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(
                    camera_id, 'transient_network:verification_incomplete'
                ),
            })
            continue
        source_url = (
            f'https://www.usgs.gov/volcanoes/{camera["volcano"]}/webcams'
        )
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'],
            'image', 'Hawaii', 'Hawaii County', camera['direction'], 'usgs',
            source_url, camera['cadence'],
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['category'] = 'volcano'
        count += 1

    atomic_write_json(
        DATA_DIR / 'hawaii_usgs_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'USGS Hawaiian Volcano Observatory / NIMS',
            'source_url': 'https://www.usgs.gov/observatories/hvo',
            'attribution': 'U.S. Geological Survey, Hawaiian Volcano Observatory',
            'usage_terms': 'USGS-authored HVO/NIMS imagery is public domain',
            'geographic_scope': 'Kilauea and Mauna Loa, Hawaii County, Hawaii',
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  Hawaii USGS image verification: {count}/{len(candidates)} current')
    return count


# ── Iowa (IRIS) ──
_IMAGE_MAGIC = (b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'GIF87a', b'GIF89a', b'RIFF')


def _image_is_live(url, timeout=15):
    try:
        request = urllib.request.Request(
            url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
                          'Accept': 'image/*,*/*'})
        response = urllib.request.urlopen(request, timeout=timeout, context=ctx)
        content_type = (response.headers.get('Content-Type') or '').lower()
        head = response.read(64)
        if 'image' not in content_type and not any(head.startswith(sig) for sig in _IMAGE_MAGIC):
            return url, 'placeholder:not_an_image'
        if not any(head.startswith(sig) for sig in _IMAGE_MAGIC):
            return url, 'placeholder:unrecognized_body'
        return url, None
    except urllib.error.HTTPError as exc:
        if exc.code in {404, 410}:
            return url, f'confirmed_dead:http_{exc.code}'
        if exc.code == 429:
            return url, 'rate_limited:http_429'
        if exc.code in {401, 403}:
            return url, f'authentication_required:http_{exc.code}'
        return url, f'transient_network:http_{exc.code}'
    except Exception as exc:  # noqa: BLE001
        return url, f'transient_network:{exc}'


def verify_live_images(urls, workers=16):
    verified = set()
    errors = {}
    unique = list(dict.fromkeys(urls))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for url, error in executor.map(_image_is_live, unique):
            if error is None:
                verified.add(url)
            else:
                errors[url] = error
    return verified, errors


# ── Iowa DOT (keyless ArcGIS FeatureServer, verified live snapshots) ──
def fetch_iowa_dot():
    query = ('https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/'
             'Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1'
             '&outFields=Desc_,ImageURL,REGION,latitude,longitude&f=json'
             '&resultRecordCount=3000')
    data = json.loads(_http_bytes(query, headers={'Accept': 'application/json'}, timeout=40))
    candidates = []
    seen = set()
    for feat in data.get('features', []):
        attrs = feat.get('attributes', {})
        img_url = str(attrs.get('ImageURL', '')).strip()
        if not img_url.startswith('https://') or img_url in seen:
            continue
        lat, lon = attrs.get('latitude'), attrs.get('longitude')
        if not lat or not lon:
            continue
        seen.add(img_url)
        candidates.append({
            'name': str(attrs.get('Desc_', '') or 'Iowa Camera').strip(),
            'lat': lat, 'lon': lon, 'url': img_url,
            'county': str(attrs.get('REGION', '') or ''),
        })
    verified, errors = verify_live_images([c['url'] for c in candidates])
    count = 0
    rejected = []
    for cam in candidates:
        if cam['url'] not in verified:
            rejected.append({'name': cam['name'], 'url': cam['url'],
                             'failure_class': errors.get(cam['url'], 'transient_network:incomplete')})
            continue
        add_camera(cam['name'], cam['lat'], cam['lon'], cam['url'], 'image', 'Iowa',
                   cam['county'], '', 'dot', 'https://511ia.org/', 60)
        count += 1
    atomic_write_json(
        DATA_DIR / 'iowa_dot_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Iowa DOT',
            'source_url': 'https://public-iowadot.opendata.arcgis.com/datasets/traffic-cameras-3',
            'attribution': 'Iowa Department of Transportation',
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    print(f'  Iowa DOT image verification: {count}/{len(candidates)} live')
    return count


def fetch_ia_iris():
    try:
        data = fetch_json('https://tr.511ia.org/tgcameras/api/cameras', timeout=20)
        count = 0
        for cam in data:
            lat = cam.get('latitude') or cam.get('lat')
            lon = cam.get('longitude') or cam.get('lon')
            name = cam.get('name', '') or cam.get('description', 'IA Camera')
            img_url = cam.get('imageUrl', '') or cam.get('url', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Iowa', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  IA IRIS: {e}')
        return 0


# ── Wyoming DOT ──
def fetch_wyoming():
    report = {
        'generated_at': utc_now_iso(),
        'provider': 'Wyoming Department of Transportation',
        'source_url': 'https://map.wyoroad.info/511-map/',
        'inventory_sites': 228,
        'inventory_views': 757,
        'accepted': 0,
        'failure_class': 'licensing_restricted',
        'reason': (
            'Frames are marked All rights reserved and no third-party '
            'hotlink or embed grant is published'
        ),
        'contact': 'wyoroad@wyo.gov',
    }
    atomic_write_json(DATA_DIR / 'wyoming_dot_discovery_report.json', report, indent=2)
    raise IncompleteProviderError('licensing_restricted:WYDOT_hotlink_permission_required')


# ── Maryland CHART (live HLS via per-camera Wowza server) ──
def fetch_maryland_chart():
    try:
        api_url = 'https://chart.maryland.gov/DataFeeds/GetCamerasJson'
        data = fetch_json(api_url, timeout=20)
        items = data if isinstance(data, list) else data.get('cameras', [])
        candidates = []
        seen = set()
        for cam in items:
            if cam.get('commMode') != 'ONLINE':
                continue
            cam_ip = str(cam.get('cctvIp') or '').strip()
            cam_id = str(cam.get('id') or '').strip()
            if not cam_ip.endswith('.sha.maryland.gov') or not cam_id:
                continue
            stream_url = f'https://{cam_ip}/rtplive/{cam_id}/playlist.m3u8'
            if stream_url in seen:
                continue
            seen.add(stream_url)
            candidates.append((cam, stream_url))
        verified_urls, verification_errors = verify_live_hls(
            [stream_url for _, stream_url in candidates]
        )
        count = 0
        rejected = []
        for cam, stream_url in candidates:
            if stream_url not in verified_urls:
                rejected.append({
                    'provider_camera_id': cam.get('id'),
                    'name': cam.get('name') or cam.get('description'),
                    'url': stream_url,
                    'failure_class': verification_errors.get(
                        stream_url, 'transient_network:verification_incomplete'
                    ),
                })
                continue
            before = len(cameras)
            name = cam.get('description', '') or cam.get('name', 'Maryland Camera')
            source_url = cam.get('publicVideoURL') or api_url
            if not str(source_url).startswith('https://'):
                source_url = api_url
            add_camera(name, cam.get('lat'), cam.get('lon'), stream_url, 'hls',
                       'Maryland', '', '', 'dot', source_url, 10)
            if len(cameras) == before:
                rejected.append({
                    'provider_camera_id': cam.get('id'),
                    'name': name,
                    'url': stream_url,
                    'failure_class': 'location_ambiguous:invalid_coordinates',
                })
                continue
            cameras[-1]['provider_camera_id'] = str(cam.get('id'))
            count += 1
        atomic_write_json(
            DATA_DIR / 'maryland_chart_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Maryland (CHART)',
                'source_url': api_url,
                'attribution': 'Maryland Department of Transportation State Highway Administration',
                'inventory_total': len(items),
                'candidates': len(candidates),
                'verified_live': count,
                'rejected': rejected,
            },
            indent=2,
        )
        print(f'  Maryland CHART HLS verification: {count}/{len(candidates)} advancing')
        return count
    except Exception as e:
        print(f'  Maryland CHART: {e}')
        return 0


# ── Florida ArcGIS (more detailed than 511 mapicons) ──
def fetch_fl_arcgis():
    try:
        count = 0
        offset = 0
        while True:
            url = (f'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/'
                   f'FL511_Traffic_Cameras/FeatureServer/0/query?where=1%3D1&outFields=*'
                   f'&f=json&resultRecordCount=2000&resultOffset={offset}')
            data = fetch_json(url, timeout=30)
            feats = data.get('features', [])
            if not feats:
                break
            for feat in feats:
                attrs = feat.get('attributes', {})
                geom = feat.get('geometry', {})
                name = attrs.get('DESCRIPT', 'FL Camera')
                img_url = attrs.get('IMAGE', '')
                if not img_url:
                    continue
                add_camera(name, geom.get('y'), geom.get('x'), img_url, 'image',
                           'Florida', attrs.get('COUNTY', ''), attrs.get('DIRECTION', ''), 'dot')
                count += 1
            offset += len(feats)
            if not data.get('exceededTransferLimit'):
                break
        return count
    except Exception as e:
        print(f'  FL ArcGIS: {e}')
        return 0


def _http_bytes(url, headers=None, data=None, method=None, timeout=30):
    hdrs = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate'}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
    raw = resp.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw


# ── Puerto Rico (ACT/ITS) — exact public inventory + current still metadata ──
PR_ACT_MINIMUM_INVENTORY = 20
PR_ACT_TIMEZONE = timezone(timedelta(hours=-4))


def _pr_act_snapshot(candidate):
    camera_id = int(candidate['camera_id'])
    metadata_url = 'https://its.act.pr.gov/en/TrafficImage.aspx/GetImageData'
    player_url = f'https://its.act.pr.gov/en/TrafficImage.aspx?Large=1&id={camera_id}'
    payload = post_json(
        metadata_url,
        {'id': camera_id},
        headers={
            'Origin': 'https://its.act.pr.gov',
            'Referer': player_url,
            'X-Requested-With': 'XMLHttpRequest',
        },
        timeout=20,
    )
    metadata = payload.get('d') or {}
    image_source = str(metadata.get('ImageSource', '')).strip()
    if urllib.parse.unquote(image_source) != urllib.parse.unquote(candidate['image_path']):
        raise ValueError('placeholder:metadata_image_mismatch')
    timestamp_text = str(metadata.get('DateTime', '')).strip()
    try:
        provider_time = datetime.strptime(
            timestamp_text, '%m/%d/%Y %I:%M:%S %p'
        ).replace(tzinfo=PR_ACT_TIMEZONE)
    except ValueError as exc:
        raise ValueError('placeholder:invalid_provider_timestamp') from exc
    age_seconds = (datetime.now(timezone.utc) - provider_time.astimezone(timezone.utc)).total_seconds()
    if age_seconds < -120 or age_seconds > 120:
        raise ValueError(f'placeholder:stale_provider_timestamp:{int(age_seconds)}')

    image_url = candidate['url'] + '?' + urllib.parse.urlencode({'DateTime': timestamp_text})
    request = urllib.request.Request(
        image_url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            'Accept': 'image/*,*/*',
            'Referer': player_url,
        },
    )
    response = urllib.request.urlopen(request, timeout=20, context=ctx)
    content_type = (response.headers.get('Content-Type') or '').lower()
    body = response.read()
    if (not body.startswith(_IMAGE_MAGIC)
            or 'image' not in content_type
            or len(body) < 1024):
        raise ValueError('placeholder:not_a_current_image')
    return (
        int(provider_time.timestamp()),
        hashlib.sha256(body).hexdigest(),
        len(body),
        provider_time.isoformat(),
    )


def verify_pr_act_images(candidates, probe_interval=6.0, workers=8):
    def probe_all():
        snapshots = {}
        errors = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_pr_act_snapshot, candidate): candidate['camera_id']
                for candidate in candidates
            }
            for future in concurrent.futures.as_completed(futures):
                camera_id = futures[future]
                try:
                    snapshots[camera_id] = future.result()
                except Exception as exc:
                    if isinstance(exc, urllib.error.HTTPError):
                        if exc.code in {404, 410}:
                            reason = f'confirmed_dead:http_{exc.code}'
                        elif exc.code == 429:
                            reason = 'rate_limited:http_429'
                        elif exc.code in {401, 403}:
                            reason = f'authentication_required:http_{exc.code}'
                        else:
                            reason = f'transient_network:http_{exc.code}'
                    else:
                        reason = str(exc)
                        if not reason.startswith(('placeholder:', 'confirmed_dead:')):
                            reason = f'transient_network:{reason}'
                    errors[camera_id] = reason
        return snapshots, errors

    first, first_errors = probe_all()
    if probe_interval:
        time.sleep(probe_interval)
    second, second_errors = probe_all()
    verified = {
        candidate['camera_id'] for candidate in candidates
        if candidate['camera_id'] in first and candidate['camera_id'] in second
        and (
            second[candidate['camera_id']][0] > first[candidate['camera_id']][0]
            or second[candidate['camera_id']][1] != first[candidate['camera_id']][1]
        )
    }
    errors = {}
    for candidate in candidates:
        camera_id = candidate['camera_id']
        if camera_id in verified:
            continue
        first_error = first_errors.get(camera_id)
        second_error = second_errors.get(camera_id)
        if first_error and second_error:
            first_class = first_error.split(':', 1)[0]
            second_class = second_error.split(':', 1)[0]
            if first_class == second_class:
                errors[camera_id] = second_error
            else:
                errors[camera_id] = (
                    f'transient_network:inconsistent_probes:{first_class},{second_class}'
                )
        elif first_error or second_error:
            detail = first_error or second_error
            errors[camera_id] = f'transient_network:inconsistent_probes:{detail}'
        else:
            errors[camera_id] = 'confirmed_not_live:not_advancing'
    return verified, errors, second


def fetch_pr_act():
    inventory_url = 'https://its.act.pr.gov/en/Default.aspx/GetCctv'
    source_page = 'https://its.act.pr.gov/en/TrafficCameras.aspx'
    payload = post_json(
        inventory_url,
        {},
        headers={
            'Origin': 'https://its.act.pr.gov',
            'Referer': source_page,
            'X-Requested-With': 'XMLHttpRequest',
        },
        timeout=30,
    )
    result = payload.get('d') or {}
    records = result.get('Cctv') or []
    if not result.get('Success') or len(records) < PR_ACT_MINIMUM_INVENTORY:
        raise IncompleteProviderError(
            f'Puerto Rico ACT inventory incomplete ({len(records)} rows)'
        )
    candidates = []
    seen_ids = set()
    seen_urls = set()
    for record in records:
        camera_id = str(record.get('Id', '')).strip()
        image_path = str(record.get('ImageUrl', '')).strip()
        try:
            lat = float(record.get('Latitude'))
            lon = float(record.get('Longitude'))
        except (TypeError, ValueError):
            continue
        if (not camera_id.isdigit()
                or camera_id in seen_ids
                or not image_path.startswith('/images/cameras/')
                or not (17.8 <= lat <= 18.6 and -67.5 <= lon <= -65.1)):
            continue
        image_url = urllib.parse.urljoin(
            'https://its.act.pr.gov', urllib.parse.quote(image_path, safe='/')
        )
        if image_url in seen_urls:
            continue
        raw_name = str(record.get('Name', '')).strip()
        location = str(record.get('LocationEn', '')).strip()
        if location and raw_name and location.casefold() != raw_name.casefold():
            name = f'{location} ({raw_name})'
        else:
            name = location or raw_name
        if not name:
            continue
        direction_match = re.search(r'\b(NB|SB|EB|WB)\b', f'{raw_name} {location}', re.I)
        candidates.append({
            'camera_id': camera_id,
            'name': name,
            'lat': lat,
            'lon': lon,
            'url': image_url,
            'image_path': image_path,
            'direction': direction_match.group(1).upper() if direction_match else '',
        })
        seen_ids.add(camera_id)
        seen_urls.add(image_url)
    if len(candidates) != len(records):
        raise IncompleteProviderError(
            f'Puerto Rico ACT inventory validation rejected '
            f'{len(records) - len(candidates)} of {len(records)} rows'
        )

    verified, verification_errors, snapshots = verify_pr_act_images(candidates)
    retry_candidates = [
        candidate for candidate in candidates
        if verification_errors.get(candidate['camera_id']) ==
        'confirmed_not_live:not_advancing'
    ]
    if retry_candidates:
        retry_verified, retry_errors, retry_snapshots = verify_pr_act_images(
            retry_candidates, probe_interval=60.0, workers=8
        )
        verified.update(retry_verified)
        snapshots.update(retry_snapshots)
        for candidate in retry_candidates:
            camera_id = candidate['camera_id']
            if camera_id in retry_verified:
                verification_errors.pop(camera_id, None)
            else:
                verification_errors[camera_id] = retry_errors.get(
                    camera_id, 'confirmed_not_live:not_advancing'
                )
    rejected = []
    count = 0
    for candidate in sorted(candidates, key=lambda item: int(item['camera_id'])):
        camera_id = candidate['camera_id']
        if camera_id not in verified:
            reason = verification_errors.get(camera_id, 'transient_network:incomplete')
            rejected.append({
                'provider_camera_id': camera_id,
                'name': candidate['name'],
                'failure_class': reason.split(':', 1)[0],
                'detail': reason,
            })
            continue
        player_url = f'https://its.act.pr.gov/en/TrafficImage.aspx?Large=1&id={camera_id}'
        add_camera(
            candidate['name'], candidate['lat'], candidate['lon'], candidate['url'],
            'image', 'Puerto Rico', '', candidate['direction'], 'dot', player_url, 30,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][3]
        count += 1

    failure_counts = {}
    for item in rejected:
        key = item['failure_class']
        failure_counts[key] = failure_counts.get(key, 0) + 1
    atomic_write_json(
        DATA_DIR / 'pr_act_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Puerto Rico (ACT/ITS)',
            'inventory_url': inventory_url,
            'source_url': source_page,
            'geographic_scope': 'Puerto Rico; current public ACT camera inventory',
            'attribution': 'Puerto Rico Highways and Transportation Authority (ACT)',
            'license_or_usage_terms': (
                'ACT pages state copyright and All rights reserved; no explicit camera '
                'reuse license is displayed. StormScope links the public live images '
                'in place and does not mirror them.'
            ),
            'refresh_cadence_seconds': 30,
            'inventory_count': len(records),
            'verified_live': count,
            'rejected': len(rejected),
            'rejected_by_class': failure_counts,
            'rejections': sorted(rejected, key=lambda item: int(item['provider_camera_id'])),
        },
    )
    transient = [
        item for item in rejected
        if item['failure_class'] in {
            'transient_network', 'rate_limited', 'authentication_required'
        }
    ]
    if transient:
        raise IncompleteProviderError(
            f'Puerto Rico ACT had {len(transient)} retryable image failures'
        )
    print(f'  Puerto Rico ACT image verification: {count}/{len(records)} advancing')
    return count


PUERTO_RICO_NEON_PHENOCAMS = (
    {
        'provider_camera_id': 'NEON.D04.GUAN.DP1.00033',
        'name': 'NSF NEON Guánica Forest Phenocam - Tower Top',
        'lat': 17.96955,
        'lon': -66.8687,
        'county': 'Guánica Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.GUAN.DP1.00033.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/guan',
        'category': 'research_phenology',
    },
    {
        'provider_camera_id': 'NEON.D04.GUAN.DP1.00042',
        'name': 'NSF NEON Guánica Forest Phenocam - Tower Bottom',
        'lat': 17.96955,
        'lon': -66.8687,
        'county': 'Guánica Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.GUAN.DP1.00042.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/guan',
        'category': 'research_phenology',
    },
    {
        'provider_camera_id': 'NEON.D04.LAJA.DP1.00033',
        'name': 'NSF NEON Lajas Experimental Station Phenocam - Tower Top',
        'lat': 18.021261,
        'lon': -67.076889,
        'county': 'Lajas Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.LAJA.DP1.00033.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/laja',
        'category': 'research_phenology',
    },
    {
        'provider_camera_id': 'NEON.D04.LAJA.DP1.00042',
        'name': 'NSF NEON Lajas Experimental Station Phenocam - Tower Bottom',
        'lat': 18.021261,
        'lon': -67.076889,
        'county': 'Lajas Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.LAJA.DP1.00042.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/laja',
        'category': 'research_phenology',
    },
    {
        'provider_camera_id': 'NEON.D04.CUPE.DP1.20002',
        'name': 'NSF NEON Río Cupeyes Phenocam',
        'lat': 18.11352,
        'lon': -66.98676,
        'county': 'San Germán Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.CUPE.DP1.20002.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/cupe',
        'category': 'river_research',
    },
    {
        'provider_camera_id': 'NEON.D04.GUIL.DP1.20002',
        'name': 'NSF NEON Río Yahuecas Phenocam',
        'lat': 18.17406,
        'lon': -66.79868,
        'county': 'Adjuntas Municipio',
        'url': 'https://phenocam.nau.edu/data/latest/NEON.D04.GUIL.DP1.20002.jpg',
        'source_url': 'https://www.neonscience.org/field-sites/guil',
        'category': 'river_research',
    },
)


def fetch_puerto_rico_neon_phenocams():
    candidates = [
        {
            'provider_camera_id': item['provider_camera_id'],
            'url': item['url'],
            'max_age_seconds': 5400,
        }
        for item in PUERTO_RICO_NEON_PHENOCAMS
    ]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=6
    )
    rejected = [
        {
            'provider_camera_id': item['provider_camera_id'],
            'name': item['name'],
            'failure_class': errors.get(
                item['provider_camera_id'], 'transient_network:verification_incomplete'
            ).split(':', 1)[0],
            'detail': errors.get(
                item['provider_camera_id'], 'transient_network:verification_incomplete'
            ),
        }
        for item in PUERTO_RICO_NEON_PHENOCAMS
        if item['provider_camera_id'] not in verified
    ]
    accepted = []
    for item in PUERTO_RICO_NEON_PHENOCAMS:
        camera_id = item['provider_camera_id']
        if camera_id not in verified:
            continue
        add_camera(
            item['name'], item['lat'], item['lon'], item['url'], 'image',
            'Puerto Rico', item['county'], '', 'university', item['source_url'], 1800,
        )
        cameras[-1]['provider'] = 'NSF NEON / PhenoCam Network'
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_hash'] = snapshots[camera_id][0]
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['category'] = item['category']
        accepted.append({
            'provider_camera_id': camera_id,
            'name': item['name'],
            'lat': item['lat'],
            'lon': item['lon'],
            'url': item['url'],
            'source_url': item['source_url'],
            'provider_timestamp': snapshots[camera_id][2],
            'provider_hash': snapshots[camera_id][0],
        })
    atomic_write_json(
        DATA_DIR / 'pr_act_discovery_report_neon.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'NSF NEON / PhenoCam Network',
            'inventory_url': 'https://www.neonscience.org/data-collection/phenocams',
            'geographic_scope': 'Guánica, Lajas, Río Cupeyes, and Río Yahuecas',
            'location_evidence': (
                'Official NEON field-site coordinates and descriptions identify each '
                'tower or land-water-interface camera; no geocoder is used.'
            ),
            'attribution': 'PhenoCam Network and applicable site acknowledgments',
            'license_or_usage_terms': 'CC BY 4.0',
            'terms_url': 'https://phenocam.nau.edu/webcam/fairuse_statement/',
            'refresh_cadence_seconds': 1800,
            'verified_live': len(accepted),
            'accepted': accepted,
            'rejections': rejected,
        },
        indent=2,
    )
    if len(accepted) != len(PUERTO_RICO_NEON_PHENOCAMS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{len(accepted)}<'
            f'{len(PUERTO_RICO_NEON_PHENOCAMS)}'
        )
    print('  Puerto Rico NSF NEON image verification: '
          f'{len(accepted)}/{len(PUERTO_RICO_NEON_PHENOCAMS)} current')
    return len(accepted)


# ── Guam (GNTF/IPCamLive) — first-party fixed destination camera embed ──
def fetch_guam_gntf():
    source_page = 'https://gntf.org/'
    alias = '62737dba77480'
    player_url = (
        'https://g3.ipcamlive.com/player/player.php?alias=62737dba77480'
        '&autoplay=1&disableautofullscreen=1&disablefullscreen=1&mute=1'
    )
    homepage = _http_bytes(source_page, timeout=30).decode('utf-8', 'replace')
    if not re.search(
            rf'https://g3\.ipcamlive\.com/player/player\.php\?alias={alias}\b',
            homepage,
            re.IGNORECASE):
        raise IncompleteProviderError('GNTF first-party camera link is missing')
    player = _http_bytes(
        player_url, headers={'Referer': source_page}, timeout=30
    ).decode('utf-8', 'replace')
    available = re.search(r'\bvar\s+available\s*=\s*1\s*;', player)
    domain_unlocked = re.search(r'\bvar\s+domainlockenabled\s*=\s*0\s*;', player)
    address_match = re.search(
        r"\bvar\s+address\s*=\s*'https?://(s\d+\.ipcamlive\.com)/'\s*;",
        player,
        re.IGNORECASE,
    )
    stream_match = re.search(
        r"\bvar\s+streamid\s*=\s*'([A-Za-z0-9]+)'\s*;", player
    )
    alias_match = re.search(
        r"\bvar\s+alias\s*=\s*'([^']+)'\s*;", player
    )
    if (not available or not domain_unlocked or not address_match or not stream_match
            or not alias_match or alias_match.group(1) != alias):
        raise IncompleteProviderError('GNTF IPCamLive player is unavailable or changed')
    hls_url = (
        f'https://{address_match.group(1).lower()}/streams/'
        f'{stream_match.group(1)}/master.m3u8'
    )
    verified, errors = verify_live_hls(
        [hls_url], probe_interval=6.0, workers=1, referer=player_url
    )
    if hls_url not in verified:
        reason = errors.get(hls_url, 'confirmed_not_live:verification_failed')
        atomic_write_json(
            DATA_DIR / 'ipcamlive_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Guam (GNTF/IPCamLive)',
                'source_url': source_page,
                'verified_live': 0,
                'rejected': 1,
                'rejections': [{
                    'provider_camera_id': alias,
                    'failure_class': reason.split(':', 1)[0],
                    'detail': reason,
                }],
            },
        )
        if reason.startswith(('transient_network:', 'rate_limited:',
                              'authentication_required:')):
            raise IncompleteProviderError(f'GNTF camera retryable failure: {reason}')
        return 0

    add_camera(
        'Guam National Tennis Center Court',
        13.509444,
        144.826667,
        player_url,
        'embed',
        'Guam',
        'Dededo',
        '',
        'ipcamlive',
        source_page,
        10,
    )
    cameras[-1]['provider_camera_id'] = alias
    cameras[-1]['category'] = 'sports'
    atomic_write_json(
        DATA_DIR / 'ipcamlive_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Guam (GNTF/IPCamLive)',
            'source_url': source_page,
            'player_url': player_url,
            'verification_stream_url': hls_url,
            'geographic_scope': 'Guam National Tennis Center, Dededo, Guam',
            'location_evidence_urls': [
                'https://gntf.org/contact-us/',
                ('https://governor.guam.gov/press_release/'
                 'leon-guerrero-tenorio-administration-celebrates-146k-in-'
                 'guam-national-tennis-center-improvements/'),
            ],
            'attribution': 'Guam National Tennis Federation; IPCamLive player',
            'license_or_usage_terms': (
                'The first-party operator publishes the IPCamLive player and its '
                'domain lock is disabled. IPCamLive viewer terms permit viewing '
                'through an owner-provided embed; StormScope stores only that player URL.'
            ),
            'verified_live': 1,
            'rejected': 0,
            'refresh_cadence_seconds': 10,
        },
    )
    print('  Guam GNTF IPCamLive verification: 1/1 advancing')
    return 1


def fetch_american_samoa_clipper():
    source_page = 'https://clipperoil.com/americansamoa/webcam/'
    alias = '6477b73ed2f62'
    try:
        player_url, _ = _resolve_ipcamlive_player(source_page, alias)
    except ValueError as exc:
        raise IncompleteProviderError(f'Clipper Oil player unavailable: {exc}') from exc

    snapshot_url = (
        'https://g3.ipcamlive.com/player/snapshot.php?alias=6477b73ed2f62'
    )
    candidates = [{
        'provider_camera_id': alias,
        'url': snapshot_url,
        'max_age_seconds': 300,
    }]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=1
    )
    if alias not in verified:
        reason = errors.get(alias, 'transient_network:verification_incomplete')
        atomic_write_json(
            DATA_DIR / 'american_samoa_clipper_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Clipper Oil American Samoa / IPCamLive',
                'source_url': source_page,
                'verified_live': 0,
                'rejected': [{
                    'provider_camera_id': alias,
                    'failure_class': reason,
                }],
            },
            indent=2,
        )
        raise IncompleteProviderError(f'Clipper Oil snapshot unavailable: {reason}')

    add_camera(
        'Clipper Oil Pago Pago Harbor Cam',
        -14.277244,
        -170.685222,
        snapshot_url,
        'image',
        'American Samoa',
        'Maoputasi County',
        'N',
        'ipcamlive',
        source_page,
        120,
    )
    cameras[-1]['provider_camera_id'] = alias
    cameras[-1]['provider_timestamp'] = snapshots[alias][2]
    cameras[-1]['category'] = 'harbor'
    atomic_write_json(
        DATA_DIR / 'american_samoa_clipper_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Clipper Oil American Samoa / IPCamLive',
            'source_url': source_page,
            'player_url': player_url,
            'snapshot_url': snapshot_url,
            'geographic_scope': (
                'Clipper Oil office and warehouse, southern Pago Pago Harbor, '
                'Fagatogo, Maoputasi County, American Samoa'
            ),
            'location_evidence': (
                'The first-party page identifies the fixed office/warehouse view '
                'at the southern end of Pago Pago Harbor; the public camera-map '
                'point reverse-geocodes to Route 001 at the Port of Pago Pago.'
            ),
            'attribution': 'Clipper Oil American Samoa; IPCamLive',
            'license_or_usage_terms': (
                'The first-party operator publishes a domain-unlocked IPCamLive '
                'player. IPCamLive documents the alias snapshot as a public '
                'two-minute preview endpoint; StormScope links it and does not mirror it.'
            ),
            'verified_live': 1,
            'provider_timestamp': snapshots[alias][2],
            'refresh_cadence_seconds': 120,
            'rejected': [],
        },
        indent=2,
    )
    print('  American Samoa Clipper Oil image verification: 1/1 current')
    return 1


MONTANA_NPS_FEEDS = (
    {
        'provider_camera_id': '81B4691B-1DD8-B71B-0BB9DBEE21A59335',
        'name': 'Apgar Mountain',
        'lat': 48.51827,
        'lon': -114.0206,
        'url': 'https://www.nps.gov/webcams-glac/ApgarLookout-01.jpg',
        'county': 'Flathead County',
        'direction': 'NE',
        'category': 'scenic',
    },
    {
        'provider_camera_id': '81B4692D-1DD8-B71B-0B9AE4B7C186B022',
        'name': 'Apgar Village',
        'lat': 48.527745,
        'lon': -113.9931745,
        'url': 'https://www.nps.gov/webcams-glac/ApgarVillage.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'scenic',
    },
    {
        'provider_camera_id': 'D428B88A-BC1A-A5BF-88E3D63CF89D3452',
        'name': 'Lake McDonald - 2',
        'lat': 48.527745,
        'lon': -113.9931745,
        'url': 'https://www.nps.gov/webcams-glac/lakemcdonaldptz.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'scenic',
    },
    {
        'provider_camera_id': '7290EA71-A74E-A7B4-74805070A3996FAC',
        'name': 'Apgar Visitor Center Plaza',
        'lat': 48.523099,
        'lon': -113.988412,
        'url': 'https://www.nps.gov/webcams-glac/ApgarVisitorCenter.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'public_land',
    },
    {
        'provider_camera_id': '81B46955-1DD8-B71B-0B698C4D88410C05',
        'name': 'Middle Fork of the Flathead River',
        'lat': 48.4995083,
        'lon': -113.9759333,
        'url': 'https://www.nps.gov/webcams-glac/MiddleForkBridge.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'river',
    },
    {
        'provider_camera_id': '81B46943-1DD8-B71B-0B46D68861599592',
        'name': 'Glacier National Park Headquarters',
        'lat': 48.5021135,
        'lon': -113.9883873,
        'url': 'https://www.nps.gov/webcams-glac/Headquarters.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'public_land',
    },
    {
        'provider_camera_id': '33478DF3-1DD8-B71B-0B8C97DB0A03B0F7',
        'name': 'Glacier National Park West Entrance',
        'lat': 48.5064094,
        'lon': -113.987652,
        'url': 'https://www.nps.gov/webcams-glac/WestEntrance.jpg',
        'county': 'Flathead County',
        'direction': '',
        'category': 'traffic',
    },
    {
        'provider_camera_id': 'AE7C9B53-910E-6D3A-D6133266826C6977',
        'name': 'St. Mary Visitor Center',
        'lat': 48.7473324,
        'lon': -113.4390195,
        'url': 'https://www.nps.gov/webcams-glac/StMaryPTZ.jpg',
        'county': 'Glacier County',
        'direction': '',
        'category': 'public_land',
    },
    {
        'provider_camera_id': '29CE45EA-EF1D-13A4-9C8E92F1FBFED9C7',
        'name': 'Two Medicine',
        'lat': 48.4863116,
        'lon': -113.3674028,
        'url': 'https://www.nps.gov/webcams-glac/TwoMedicine.jpg',
        'county': 'Glacier County',
        'direction': '',
        'category': 'scenic',
    },
)


def fetch_montana_nps_verified():
    candidates = [
        {
            **item,
            'source_url': (
                'https://www.nps.gov/media/webcam/view.htm?'
                f'id={item["provider_camera_id"]}'
            ),
            'max_age_seconds': 300,
            'require_content_change': True,
            'cache_bust': True,
        }
        for item in MONTANA_NPS_FEEDS
    ]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=65.0, workers=6
    )
    rejected = []
    for camera in candidates:
        camera_id = camera['provider_camera_id']
        if camera_id not in verified:
            rejected.append({
                'provider_camera_id': camera_id,
                'name': camera['name'],
                'failure_class': errors.get(camera_id, 'transient_network:incomplete'),
            })
            continue
        add_camera(
            camera['name'], camera['lat'], camera['lon'], camera['url'], 'image',
            'Montana', camera['county'], camera['direction'], 'nps',
            camera['source_url'], 60,
        )
        cameras[-1]['provider_camera_id'] = camera_id
        cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
        cameras[-1]['category'] = camera['category']

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'montana_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service - Glacier National Park',
            'source_url': 'https://www.nps.gov/glac/learn/photosmultimedia/webcams.htm',
            'attribution': 'National Park Service',
            'license_or_usage_terms': (
                'NPS-created website material is generally public domain; '
                'StormScope links the original current images.'
            ),
            'usage_terms_url': 'https://www.nps.gov/aboutus/disclaimer.htm',
            'refresh_cadence_seconds': 60,
            'candidates': len(candidates),
            'verified_live': count,
            'rejected': rejected,
        },
        indent=2,
    )
    if count != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(candidates)}'
        )
    print(f'  Montana NPS image verification: {count}/{len(candidates)} advancing')
    return count


RHODE_ISLAND_URI_QUADCAMS = (
    {
        'alias': 'davis',
        'name': 'URI Kingston Campus Quadrangle Cam',
        'lat': 41.486511,
        'lon': -71.5282976,
        'direction': '',
        'category': 'campus',
        'location_evidence': 'Davis Hall, 10 Lippitt Road, Kingston campus',
    },
    {
        'alias': 'baycampus',
        'name': 'URI Narragansett Bay Campus Cam',
        'lat': 41.4907502,
        'lon': -71.4224636,
        'direction': '',
        'category': 'harbor',
        'location_evidence': 'URI Narragansett Bay Campus, 215 South Ferry Road',
    },
    {
        'alias': 'cacs',
        'name': 'URI Ocean Robotics Laboratory Construction - Facing North',
        'lat': 41.4905483,
        'lon': -71.423211,
        'direction': 'N',
        'category': 'campus',
        'location_evidence': 'Center for Atmospheric Chemistry Studies, Bay Campus',
    },
    {
        'alias': 'osec',
        'name': 'URI Ocean Robotics Laboratory Construction - Facing South',
        'lat': 41.4919504,
        'lon': -71.4231717,
        'direction': 'S',
        'category': 'campus',
        'location_evidence': 'Ocean Science and Exploration Center, Bay Campus',
    },
)


def fetch_rhode_island_uri_quadcams():
    source_page = 'https://www.uri.edu/about/quadcams/'
    resolved = {}
    rejected = []
    for item in RHODE_ISLAND_URI_QUADCAMS:
        try:
            resolved[item['alias']] = _resolve_ipcamlive_player(
                source_page, item['alias']
            )
        except ValueError as exc:
            rejected.append({
                'provider_camera_id': item['alias'],
                'failure_class': f'unsupported_embed:{exc}',
            })
    if len(resolved) != len(RHODE_ISLAND_URI_QUADCAMS):
        atomic_write_json(
            DATA_DIR / 'rhode_island_uri_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'University of Rhode Island / IPCamLive',
                'source_url': source_page,
                'verified_live': 0,
                'rejected': rejected,
            },
            indent=2,
        )
        raise IncompleteProviderError(
            f'truncated_player_inventory:{len(resolved)}<{len(RHODE_ISLAND_URI_QUADCAMS)}'
        )

    hls_by_alias = {alias: value[1] for alias, value in resolved.items()}
    verified_hls, hls_errors = verify_live_hls(
        list(hls_by_alias.values()), probe_interval=6.0, workers=4, referer=source_page
    )
    for item in RHODE_ISLAND_URI_QUADCAMS:
        alias = item['alias']
        hls_url = hls_by_alias[alias]
        if hls_url not in verified_hls:
            rejected.append({
                'provider_camera_id': alias,
                'failure_class': hls_errors.get(
                    hls_url, 'transient_network:verification_incomplete'
                ),
            })
            continue
        player_url = resolved[alias][0]
        add_camera(
            item['name'], item['lat'], item['lon'], player_url, 'embed',
            'Rhode Island', 'Washington County', item['direction'], 'ipcamlive',
            source_page, 10,
        )
        cameras[-1]['provider_camera_id'] = alias
        cameras[-1]['category'] = item['category']

    count = len(verified_hls)
    atomic_write_json(
        DATA_DIR / 'rhode_island_uri_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'University of Rhode Island / IPCamLive',
            'source_url': source_page,
            'geographic_scope': 'Kingston and Narragansett Bay campuses, Rhode Island',
            'location_evidence': [
                {
                    'provider_camera_id': item['alias'],
                    'evidence': item['location_evidence'],
                    'lat': item['lat'],
                    'lon': item['lon'],
                }
                for item in RHODE_ISLAND_URI_QUADCAMS
            ],
            'attribution': 'University of Rhode Island; IPCamLive',
            'license_or_usage_terms': (
                'URI deliberately publishes each domain-unlocked IPCamLive player. '
                'StormScope stores the original player URL and does not proxy media.'
            ),
            'verified_live': count,
            'rejected': rejected,
            'refresh_cadence_seconds': 10,
        },
        indent=2,
    )
    if count != len(RHODE_ISLAND_URI_QUADCAMS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(RHODE_ISLAND_URI_QUADCAMS)}'
        )
    print(f'  URI Quadcam HLS verification: {count}/{len(RHODE_ISLAND_URI_QUADCAMS)} advancing')
    return count


def fetch_mississippi_state_university():
    source_page = 'https://www.utc.msstate.edu/live-cameras'
    hls_url = (
        'https://gameday-camera.its.msstate.edu/stream/'
        'daviswade_skydeck_east/channel/0/hls/live/index.m3u8'
    )
    verified, errors = verify_live_hls(
        [hls_url], probe_interval=6.0, workers=1, referer=source_page
    )
    if hls_url not in verified:
        reason = errors.get(hls_url, 'transient_network:verification_incomplete')
        atomic_write_json(
            DATA_DIR / 'mississippi_university_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Mississippi State University Television Center',
                'source_url': source_page,
                'verified_live': 0,
                'rejected': [{
                    'provider_camera_id': 'msstate-daviswade-skydeck-east',
                    'failure_class': reason,
                }],
            },
            indent=2,
        )
        raise IncompleteProviderError(f'MSU HLS unavailable: {reason}')

    add_camera(
        'Mississippi State University Main Campus South Cam',
        33.456539317712,
        -88.794470722226,
        hls_url,
        'hls',
        'Mississippi',
        'Oktibbeha County',
        'S',
        'university',
        source_page,
        4,
    )
    cameras[-1]['provider_camera_id'] = 'msstate-daviswade-skydeck-east'
    cameras[-1]['category'] = 'campus'
    atomic_write_json(
        DATA_DIR / 'mississippi_university_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Mississippi State University Television Center',
            'source_url': source_page,
            'geographic_scope': (
                'Davis Wade Stadium, Mississippi State University, '
                'Starkville, Oktibbeha County, Mississippi'
            ),
            'location_evidence': (
                'The first-party live-camera page labels Main Campus - South; '
                'the manifest identifies Davis Wade Skydeck East, and the '
                'official stadium address fixes the accepted point.'
            ),
            'attribution': 'Mississippi State University Television Center',
            'license_or_usage_terms': (
                'The university publishes this HLS stream for public viewing. '
                'StormScope links the original feed and does not proxy or archive it.'
            ),
            'verified_live': 1,
            'rejected': [],
            'refresh_cadence_seconds': 4,
        },
        indent=2,
    )
    print('  Mississippi State University HLS verification: 1/1 advancing')
    return 1


NEW_HAMPSHIRE_UNIVERSITY_CAMS = (
    {
        'provider_camera_id': 'franklin-pierce-monadnock',
        'name': 'Franklin Pierce University - Mount Monadnock',
        'lat': 42.770947004468,
        'lon': -72.057688117976,
        'url': 'https://www.franklinpierce.edu/webcam_monadnock/thumbnail1.jpg',
        'county': 'Cheshire County',
        'direction': '',
        'source_url': 'https://franklinpierce.edu/webcam_monadnock/index.html',
        'refresh_cadence_seconds': 300,
        'max_age_seconds': 10_800,
        'category': 'weather_scenic',
    },
    {
        'provider_camera_id': 'psu-boyd-science-center-1',
        'name': 'Plymouth State University - Boyd Science Center',
        'lat': 43.7571075,
        'lon': -71.6898445,
        'url': 'https://vortex.plymouth.edu/webcam/1/latest.jpeg',
        'county': 'Grafton County',
        'direction': 'N',
        'source_url': 'https://vortex.plymouth.edu/webcam/',
        'refresh_cadence_seconds': 300,
        'max_age_seconds': 1800,
        'category': 'campus_weather',
    },
)


def fetch_new_hampshire_university_cameras():
    for item in NEW_HAMPSHIRE_UNIVERSITY_CAMS:
        page = _http_bytes(item['source_url'], timeout=30).decode('utf-8', 'replace')
        if item['url'] not in page and item['url'].rsplit('/', 1)[-1] not in page:
            raise IncompleteProviderError(
                f"university source page is missing {item['provider_camera_id']}"
            )
    verified, errors, snapshots = verify_current_jpeg_images(
        list(NEW_HAMPSHIRE_UNIVERSITY_CAMS),
        probe_interval=2.0,
        workers=2,
    )
    rejected = [
        {
            'provider_camera_id': item['provider_camera_id'],
            'failure_class': errors.get(
                item['provider_camera_id'],
                'transient_network:verification_incomplete',
            ),
        }
        for item in NEW_HAMPSHIRE_UNIVERSITY_CAMS
        if item['provider_camera_id'] not in verified
    ]
    report_path = DATA_DIR / 'youtube_discovery_report_new_hampshire_university.json'
    if rejected:
        atomic_write_json(
            report_path,
            {
                'generated_at': utc_now_iso(),
                'provider': 'New Hampshire university weather cameras',
                'verified_live': len(verified),
                'rejected': rejected,
            },
            indent=2,
        )
        raise IncompleteProviderError(
            'New Hampshire university camera verification is incomplete'
        )

    accepted = []
    for item in NEW_HAMPSHIRE_UNIVERSITY_CAMS:
        add_camera(
            item['name'],
            item['lat'],
            item['lon'],
            item['url'],
            'image',
            'New Hampshire',
            item['county'],
            item['direction'],
            'university',
            item['source_url'],
            item['refresh_cadence_seconds'],
        )
        cameras[-1]['provider_camera_id'] = item['provider_camera_id']
        cameras[-1]['category'] = item['category']
        accepted.append({
            'provider_camera_id': item['provider_camera_id'],
            'name': item['name'],
            'url': item['url'],
            'source_url': item['source_url'],
            'snapshot': snapshots[item['provider_camera_id']],
        })
    atomic_write_json(
        report_path,
        {
            'generated_at': utc_now_iso(),
            'provider': 'Franklin Pierce University / Plymouth State University',
            'geographic_scope': 'Rindge and Plymouth, New Hampshire',
            'location_evidence': (
                'Each first-party camera page names the campus/view. Coordinates '
                'resolve the official Franklin Pierce University address and the '
                'Boyd Science Center building; counties were cross-checked.'
            ),
            'license_or_usage_terms': (
                'Both universities publish the JPEGs as public webcam views. '
                'StormScope hotlinks the originals with first-party attribution '
                'and does not proxy or archive the images.'
            ),
            'verified_live': len(accepted),
            'rejected': [],
            'accepted': accepted,
        },
        indent=2,
    )
    print('  New Hampshire university image verification: 2/2 current')
    return len(accepted)


WEST_VIRGINIA_CANAAN_CAMS = (
    {
        'alias': '6911368c776d3',
        'name': 'Canaan Valley Resort Ski Area Overlook',
        'category': 'ski',
    },
    {
        'alias': '6788f7b7d0365',
        'name': 'Canaan Valley Resort Golf Course',
        'category': 'golf',
    },
    {
        'alias': '67588ef2adde5',
        'name': 'Canaan Valley Resort Tubing Hill Base',
        'category': 'ski',
    },
)


def fetch_west_virginia_canaan():
    source_page = 'https://www.canaanresort.com/resort-webcam'
    resolved = {}
    rejected = [{
        'provider_camera_id': '689fab99423ec',
        'failure_class': 'confirmed_not_live:player_available_0',
    }]
    for item in WEST_VIRGINIA_CANAAN_CAMS:
        try:
            resolved[item['alias']] = _resolve_ipcamlive_player(
                source_page, item['alias']
            )
        except ValueError as exc:
            rejected.append({
                'provider_camera_id': item['alias'],
                'failure_class': f'unsupported_embed:{exc}',
            })
    if len(resolved) != len(WEST_VIRGINIA_CANAAN_CAMS):
        raise IncompleteProviderError(
            f'truncated_player_inventory:{len(resolved)}<{len(WEST_VIRGINIA_CANAAN_CAMS)}'
        )

    hls_by_alias = {alias: value[1] for alias, value in resolved.items()}
    verified_hls, hls_errors = verify_live_hls(
        list(hls_by_alias.values()), probe_interval=6.0, workers=3, referer=source_page
    )
    for item in WEST_VIRGINIA_CANAAN_CAMS:
        alias = item['alias']
        hls_url = hls_by_alias[alias]
        if hls_url not in verified_hls:
            rejected.append({
                'provider_camera_id': alias,
                'failure_class': hls_errors.get(
                    hls_url, 'transient_network:verification_incomplete'
                ),
            })
            continue
        add_camera(
            item['name'], 39.0242855, -79.4650593, resolved[alias][0], 'embed',
            'West Virginia', 'Tucker County', '', 'ipcamlive', source_page, 10,
        )
        cameras[-1]['provider_camera_id'] = alias
        cameras[-1]['category'] = item['category']

    count = len(verified_hls)
    atomic_write_json(
        DATA_DIR / 'west_virginia_canaan_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Canaan Valley Resort State Park / IPCamLive',
            'source_url': source_page,
            'geographic_scope': (
                'Canaan Valley Resort State Park, 230 Main Lodge Road, '
                'Davis, Tucker County, West Virginia'
            ),
            'location_evidence': (
                'The first-party directions link publishes the accepted venue '
                'point; FCC Census Area metadata confirms Tucker County.'
            ),
            'attribution': 'Canaan Valley Resort State Park; IPCamLive',
            'license_or_usage_terms': (
                'The resort publishes each domain-unlocked player. StormScope '
                'stores the original player URLs and does not proxy media.'
            ),
            'verified_live': count,
            'rejected': rejected,
            'refresh_cadence_seconds': 10,
        },
        indent=2,
    )
    if count != len(WEST_VIRGINIA_CANAAN_CAMS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(WEST_VIRGINIA_CANAAN_CAMS)}'
        )
    print(f'  Canaan Valley HLS verification: {count}/{len(WEST_VIRGINIA_CANAAN_CAMS)} advancing')
    return count


def fetch_west_virginia_nps_verified():
    source_page = (
        'https://www.nps.gov/media/webcam/view.htm?'
        'id=03D5B344-9A69-16BC-F00004463B3C22F8'
    )
    camera_id = '03D5B344-9A69-16BC-F00004463B3C22F8'
    image_url = 'https://www.nps.gov/webcams-neri/image.jpg'
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 600,
        'cache_bust': True,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=2.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Canyon Rim image unavailable: {reason}')

    add_camera(
        'Canyon Rim Webcam', 38.067253920980896, -81.07805251441228,
        image_url, 'image', 'West Virginia', 'Fayette County', '', 'nps',
        source_page, 300,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'scenic'
    cameras[-1]['_replace_source_page'] = True
    atomic_write_json(
        DATA_DIR / 'west_virginia_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service - New River Gorge',
            'source_url': source_page,
            'attribution': 'National Park Service',
            'license_or_usage_terms': 'NPS-created website material is generally public domain',
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'rejected': [],
            'refresh_cadence_seconds': 300,
        },
        indent=2,
    )
    print('  West Virginia NPS image verification: 1/1 current')
    return 1


def fetch_west_virginia_state_park():
    source_page = (
        'https://wvstateparks.com/parks/babcock-state-park/additional-information/'
    )
    camera_id = 'wvsp-babcock-glade-creek-grist-mill'
    image_url = 'https://wvdnr.gov/babcock%5Cbabcock.jpg'
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 600,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=2.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Babcock State Park image unavailable: {reason}')

    add_camera(
        'Babcock State Park - Glade Creek Grist Mill',
        37.9794612,
        -80.94681,
        image_url,
        'image',
        'West Virginia',
        'Fayette County',
        '',
        'state_park',
        source_page,
        5,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'public_land'
    atomic_write_json(
        DATA_DIR / 'west_virginia_state_park_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'West Virginia State Parks / WVDNR',
            'source_url': source_page,
            'geographic_scope': (
                'Glade Creek Grist Mill, Babcock State Park, '
                'Fayette County, West Virginia'
            ),
            'location_evidence': (
                'The first-party page and park map identify the exact named mill; '
                'the public mill point is used rather than inferring the camera mount.'
            ),
            'attribution': 'West Virginia State Parks / WVDNR',
            'license_or_usage_terms': (
                'The state park publishes this public current image. StormScope '
                'links the original endpoint and does not proxy or archive it.'
            ),
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'rejected': [],
            'refresh_cadence_seconds': 5,
        },
        indent=2,
    )
    print('  West Virginia State Park image verification: 1/1 current')
    return 1


def fetch_maine_nps_verified():
    source_page = 'https://www.nps.gov/AirWebCams/acad'
    camera_id = 'ACA416'
    image_url = (
        'https://www.nps.gov/featurecontent/ard/webcams/images/acadlarge.jpg'
    )
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 1800,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=2.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Acadia air-quality image unavailable: {reason}')

    add_camera(
        'Acadia National Park - McFarland Hill Air Quality',
        44.377086,
        -68.2608,
        image_url,
        'image',
        'Maine',
        'Hancock County',
        'NE',
        'nps',
        source_page,
        900,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'weather_scenic'
    atomic_write_json(
        DATA_DIR / 'maine_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service - Acadia National Park',
            'source_url': source_page,
            'geographic_scope': (
                'McFarland Hill air-quality monitoring station, Acadia National Park, '
                'Hancock County, Maine'
            ),
            'location_evidence': (
                'The first-party NPS/EPA webcam inventory supplies station ACA416 '
                'and its exact published coordinates.'
            ),
            'attribution': 'National Park Service Air Resources Division',
            'license_or_usage_terms': (
                'NPS-created website material is generally public domain'
            ),
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'rejected': [],
            'refresh_cadence_seconds': 900,
        },
        indent=2,
    )
    print('  Maine NPS image verification: 1/1 current')
    return 1


def fetch_maine_ferry_verified():
    source_page = 'https://www.maine.gov/dot/programs-services/ferry/rockland-ferry'
    camera_id = 'RocklandFerry'
    image_url = 'https://www.maine.gov/mdot/maps/cameras/RocklandFerry.jpg'
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 180,
        'require_content_change': True,
        'cache_bust': True,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=65.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Rockland Ferry image unavailable: {reason}')

    add_camera(
        'Rockland Ferry Terminal',
        44.107223,
        -69.1080293,
        image_url,
        'image',
        'Maine',
        'Knox County',
        'E',
        'dot',
        source_page,
        60,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'ferry_harbor'
    atomic_write_json(
        DATA_DIR / 'maine_ferry_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Maine State Ferry Service / MaineDOT',
            'source_url': source_page,
            'geographic_scope': 'Rockland Ferry Terminal, Knox County, Maine',
            'location_evidence': (
                'The first-party ferry page names the terminal and camera; the '
                'accepted point is the mapped Maine State Ferry Service terminal.'
            ),
            'attribution': 'Maine State Ferry Service / MaineDOT',
            'license_or_usage_terms': (
                'MaineDOT publishes the current image for public traveler information; '
                'StormScope links the original endpoint without proxying or archiving it.'
            ),
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'rejected': [],
            'refresh_cadence_seconds': 60,
        },
        indent=2,
    )
    print('  Maine ferry image verification: 1/1 advancing')
    return 1


ALASKA_AVO_CAMS = (
    {
        'code': 'katmai_kabu',
        'name': 'Katmai Volcano KABU Cam',
        'lat': 58.2702,
        'lon': -155.2843,
        'county': 'Lake and Peninsula Borough',
        'direction': 'E',
    },
    {
        'code': 'redoubt',
        'name': 'Redoubt Volcano RDJH Cam',
        'lat': 60.5905,
        'lon': -152.8058,
        'county': 'Kenai Peninsula Borough',
        'direction': 'S',
    },
    {
        'code': 'shishaldin_wtug2',
        'name': 'Shishaldin Volcano WTUG2 Cam',
        'lat': 54.8466,
        'lon': -164.3873,
        'county': 'Aleutians East Borough',
        'direction': 'ESE',
    },
)


KENTUCKY_KYTC_CURATED_IDS = frozenset({
    220, 336, 337, 349, 355, 382, 486, 494, 498, 499, 500, 502, 503, 504,
    505, 507, 508, 509, 510, 511, 515, 516, 517, 519, 520, 521, 522, 523, 524,
})
KENTUCKY_KYTC_REPLACED_URLS = {
    337: 'https://www.trimarc.org/images/milestone/CCTV_05_ADMS112_KY22-EB.jpg',
    382: 'https://www.trimarc.org/images/milestone/CCTV_06_471_0027.jpg',
    336: 'https://www.trimarc.org/images/milestone/CCTV_05_ADMS111_KY22-WB.jpg',
    349: 'https://www.trimarc.org/images/milestone/CCTV_05_64_0054-1.jpg',
    486: 'https://www.trimarc.org/images/milestone/CCTV_08_KY80_0290.jpg',
    220: 'https://www.trimarc.org/images/milestone/CCTV_04_65_0738.jpg',
}
KENTUCKY_KYTC_DIRECTIONS = {
    'East': 'E',
    'West': 'W',
    'North': 'N',
    'South': 'S',
    'North-South': 'N/S',
    'East-West': 'E/W',
}

NORTH_DAKOTA_FAA_CAMERA_IDS = frozenset({
    12931, 12932, 13061, 13077, 13078, 13113, 13114, 13166, 13167,
    13593, 13594, 13596, 13609, 13612, 13623, 13667, 13787, 14060,
})
NORTH_DAKOTA_FAA_COUNTIES = {
    802: 'Stark County',
    837: 'Bowman County',
    842: 'Barnes County',
    852: 'Williams County',
    865: 'McLean County',
    970: 'Dunn County',
    974: 'Cass County',
    977: 'Cass County',
    989: 'Traill County',
    1021: 'Benson County',
    1098: 'McKenzie County',
}
FAA_DIRECTIONS = {
    'North': 'N',
    'NorthEast': 'NE',
    'East': 'E',
    'SouthEast': 'SE',
    'South': 'S',
    'SouthWest': 'SW',
    'West': 'W',
    'NorthWest': 'NW',
}


def fetch_kentucky_kytc_verified():
    endpoint = (
        'https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/'
        'trafficCamerasCur_Prd/FeatureServer/0/query?'
        + urllib.parse.urlencode({
            'where': '1=1',
            'outFields': '*',
            'returnGeometry': 'true',
            'f': 'json',
        })
    )
    source_page = (
        'https://www.arcgis.com/home/item.html?'
        'id=0666efd2054343b080b5c2f0924ef2ae'
    )
    payload = fetch_json(endpoint)
    features = payload.get('features') or []
    kentucky = [
        feature for feature in features
        if (feature.get('attributes') or {}).get('state') == 'Kentucky'
    ]
    if len(features) < 250 or len(kentucky) < 241:
        raise IncompleteProviderError(
            f'truncated_inventory:{len(features)} total,{len(kentucky)} Kentucky'
        )

    selected = {}
    rejected = []
    for feature in kentucky:
        attributes = feature.get('attributes') or {}
        try:
            camera_id = int(attributes.get('id'))
        except (TypeError, ValueError):
            continue
        if camera_id not in KENTUCKY_KYTC_CURATED_IDS:
            continue
        geometry = feature.get('geometry') or {}
        snapshot = str(attributes.get('snapshot') or '')
        try:
            lat = float(attributes['latitude'])
            lon = float(attributes['longitude'])
        except (KeyError, TypeError, ValueError):
            rejected.append({
                'provider_camera_id': f'kytc:{camera_id}',
                'failure_class': 'location_ambiguous:missing_coordinates',
            })
            continue
        if (
            attributes.get('status') != 'Online'
            or not snapshot.startswith('https://www.trimarc.org/images/milestone/')
            or not snapshot.lower().endswith('.jpg')
            or abs(float(geometry.get('y', lat)) - lat) > 0.000001
            or abs(float(geometry.get('x', lon)) - lon) > 0.000001
            or not str(attributes.get('description') or '').strip()
            or not str(attributes.get('county') or '').strip()
        ):
            rejected.append({
                'provider_camera_id': f'kytc:{camera_id}',
                'failure_class': 'transient_network:provider_metadata_incomplete',
            })
            continue
        selected[camera_id] = {
            'attributes': attributes,
            'lat': lat,
            'lon': lon,
            'url': snapshot,
        }

    if set(selected) != KENTUCKY_KYTC_CURATED_IDS:
        raise IncompleteProviderError(
            f'truncated_curated_inventory:{len(selected)}<{len(KENTUCKY_KYTC_CURATED_IDS)}'
        )
    candidates = [
        {
            'provider_camera_id': f'kytc:{camera_id}',
            'url': selected[camera_id]['url'],
            'max_age_seconds': 600,
        }
        for camera_id in sorted(selected)
    ]
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=3.0, workers=8
    )
    for camera_id in sorted(selected):
        provider_id = f'kytc:{camera_id}'
        if provider_id not in verified:
            rejected.append({
                'provider_camera_id': provider_id,
                'failure_class': errors.get(
                    provider_id, 'transient_network:verification_incomplete'
                ),
            })
            continue
        item = selected[camera_id]
        attributes = item['attributes']
        add_camera(
            str(attributes['description']).strip(), item['lat'], item['lon'],
            item['url'], 'image', 'Kentucky',
            f"{str(attributes['county']).strip()} County",
            KENTUCKY_KYTC_DIRECTIONS.get(
                str(attributes.get('direction') or '').strip(), ''
            ),
            'dot', source_page, 120,
        )
        cameras[-1]['provider_camera_id'] = provider_id
        cameras[-1]['provider_timestamp'] = snapshots[provider_id][2]
        cameras[-1]['category'] = 'traffic'
        if camera_id in KENTUCKY_KYTC_REPLACED_URLS:
            cameras[-1]['_replace_feed_urls'] = [
                KENTUCKY_KYTC_REPLACED_URLS[camera_id]
            ]

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'kentucky_kytc_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Kentucky Transportation Cabinet (KYTC)',
            'source_url': source_page,
            'inventory_total': len(features),
            'kentucky_inventory': len(kentucky),
            'curated_verified': count,
            'attribution': 'Kentucky Transportation Cabinet',
            'license_or_usage_terms': 'CC0 1.0 Universal public-domain dedication',
            'rejected': rejected,
            'refresh_cadence_seconds': 120,
        },
        indent=2,
    )
    if count != len(KENTUCKY_KYTC_CURATED_IDS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(KENTUCKY_KYTC_CURATED_IDS)}'
        )
    print(f'  Kentucky KYTC image verification: {count}/{len(KENTUCKY_KYTC_CURATED_IDS)} current')
    return count


def fetch_faa_weathercams_north_dakota():
    base_url = 'https://weathercams.faa.gov'
    state_page = f'{base_url}/cameras/state/ND'
    headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 Chrome/130.0 StormScope/0.112.0'
        ),
        'Accept': 'application/json, image/*, */*',
        'Referer': state_page,
    }
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))

    def request(url, *, accept='application/json, */*'):
        request_headers = {**headers, 'Accept': accept}
        return opener.open(
            urllib.request.Request(url, headers=request_headers),
            timeout=30,
        )

    with request(state_page, accept='text/html,*/*') as response:
        response.read(1024)
    with request(f'{base_url}/api/sites') as response:
        inventory = json.loads(response.read().decode('utf-8'))
    sites = [
        site for site in (inventory.get('payload') or [])
        if site.get('state') == 'ND'
    ]
    inventory_camera_count = sum(len(site.get('cameras') or []) for site in sites)
    if (
        inventory.get('success') is not True
        or int(inventory.get('count') or 0) < 900
        or len(sites) < 21
        or inventory_camera_count < 84
    ):
        raise IncompleteProviderError(
            f'truncated_inventory:{len(sites)} sites,{inventory_camera_count} cameras'
        )

    selected = {}
    rejected = []
    now = datetime.now(timezone.utc)
    for site in sites:
        site_id = int(site.get('siteId') or 0)
        for camera in site.get('cameras') or []:
            camera_id = int(camera.get('cameraId') or 0)
            if camera_id not in NORTH_DAKOTA_FAA_CAMERA_IDS:
                continue
            try:
                last_success = datetime.fromisoformat(
                    str(camera['cameraLastSuccess']).replace('Z', '+00:00')
                )
                lat = float(camera['latitude'])
                lon = float(camera['longitude'])
            except (KeyError, TypeError, ValueError) as exc:
                rejected.append({
                    'provider_camera_id': f'FAA-{camera_id}',
                    'failure_class': f'transient_network:invalid_metadata:{exc}',
                })
                continue
            age = (now - last_success.astimezone(timezone.utc)).total_seconds()
            direction = str(camera.get('cameraDirection') or '')
            if (
                site_id not in NORTH_DAKOTA_FAA_COUNTIES
                or not site.get('siteActive')
                or site.get('siteInMaintenance')
                or not site.get('validated')
                or camera.get('cameraInMaintenance')
                or camera.get('cameraOutOfOrder')
                or direction not in FAA_DIRECTIONS
                or age < -300
                or age > 1200
                or abs(float(site['latitude']) - lat) > 0.000001
                or abs(float(site['longitude']) - lon) > 0.000001
            ):
                rejected.append({
                    'provider_camera_id': f'FAA-{camera_id}',
                    'failure_class': 'placeholder:stale_or_inconsistent_inventory',
                })
                continue
            selected[camera_id] = {
                'site': site,
                'camera': camera,
                'lat': lat,
                'lon': lon,
            }
    if set(selected) != NORTH_DAKOTA_FAA_CAMERA_IDS:
        raise IncompleteProviderError(
            f'truncated_curated_inventory:{len(selected)}<{len(NORTH_DAKOTA_FAA_CAMERA_IDS)}'
        )

    def snapshot(camera_id):
        metadata_url = f'{base_url}/api/cameras/{camera_id}/images/last/1'
        with request(metadata_url) as response:
            metadata = json.loads(response.read().decode('utf-8'))
        records = metadata.get('payload') or []
        if metadata.get('success') is not True or len(records) != 1:
            raise ValueError('transient_network:image_metadata_unavailable')
        record = records[0]
        if int(record.get('cameraId') or 0) != camera_id:
            raise ValueError('transient_network:image_camera_id_mismatch')
        provider_time = datetime.fromisoformat(
            str(record['imageDatetime']).replace('Z', '+00:00')
        )
        age = (datetime.now(timezone.utc) - provider_time.astimezone(timezone.utc)).total_seconds()
        image_url = str(record.get('imageUri') or '')
        if age < -300 or age > 1200:
            raise ValueError(f'placeholder:stale_provider_timestamp:{int(age)}')
        if not image_url.startswith('https://images.wcams-static.faa.gov/webimages/'):
            raise ValueError('unsupported_embed:unexpected_image_host')
        with request(image_url, accept='image/jpeg,image/*,*/*') as response:
            content_type = str(response.headers.get('Content-Type') or '').lower()
            body = response.read()
        if (
            'image' not in content_type
            or len(body) < 5000
            or not body.startswith(b'\xff\xd8\xff')
        ):
            raise ValueError('placeholder:not_a_current_jpeg')
        return hashlib.sha256(body).hexdigest(), len(body), provider_time.isoformat()

    first = {}
    second = {}
    errors = {}
    for camera_id in sorted(selected):
        try:
            first[camera_id] = snapshot(camera_id)
        except Exception as exc:
            errors.setdefault(camera_id, []).append(str(exc))
    time.sleep(3.0)
    for camera_id in sorted(selected):
        try:
            second[camera_id] = snapshot(camera_id)
        except Exception as exc:
            errors.setdefault(camera_id, []).append(str(exc))
    verified = set(first) & set(second)

    for camera_id in sorted(selected):
        if camera_id not in verified:
            details = errors.get(camera_id) or ['transient_network:incomplete']
            rejected.append({
                'provider_camera_id': f'FAA-{camera_id}',
                'failure_class': details[-1],
            })
            continue
        item = selected[camera_id]
        site = item['site']
        camera = item['camera']
        site_id = int(site['siteId'])
        detail_page = (
            f'{base_url}/cameras/state/ND/cameraSite/{site_id}/details/'
            f'camera/{camera_id}'
        )
        site_name = str(site.get('siteName') or site.get('siteArea') or site_id).strip()
        direction = FAA_DIRECTIONS[str(camera['cameraDirection'])]
        add_camera(
            f'FAA WeatherCam: {site_name} - {camera["cameraDirection"]}',
            item['lat'], item['lon'], detail_page, 'embed', 'North Dakota',
            NORTH_DAKOTA_FAA_COUNTIES[site_id], direction, 'faa', detail_page, 600,
        )
        operated_by = str(site.get('operatedBy') or site_name).strip()
        cameras[-1]['provider'] = f'FAA WeatherCams / {operated_by}'
        cameras[-1]['provider_camera_id'] = f'FAA-{camera_id}'
        cameras[-1]['provider_timestamp'] = second[camera_id][2]
        cameras[-1]['category'] = 'airport_weather'

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'north_dakota_faa_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'FAA WeatherCams / North Dakota airports',
            'source_url': state_page,
            'inventory_sites': len(sites),
            'inventory_cameras': inventory_camera_count,
            'verified_live': count,
            'attribution': 'Federal Aviation Administration and operating airports',
            'license_or_usage_terms': (
                'FAA Order 1370.79A permits distribution/copying of public FAA '
                'website information; attribution is preserved and media is not proxied.'
            ),
            'rejected': rejected,
            'refresh_cadence_seconds': 600,
        },
        indent=2,
    )
    if count != len(NORTH_DAKOTA_FAA_CAMERA_IDS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(NORTH_DAKOTA_FAA_CAMERA_IDS)}'
        )
    print(f'  North Dakota FAA image verification: {count}/{len(NORTH_DAKOTA_FAA_CAMERA_IDS)} current')
    return count


def fetch_kentucky_nps_verified():
    source_page = 'https://www.nps.gov/maca/learn/photosmultimedia/webcams.htm'
    camera_id = 'nps:maca-green-river-bluffs'
    image_url = 'https://www.nps.gov/featurecontent/ard/webcams/images/macalarge.jpg'
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 1800,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=2.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Mammoth Cave image unavailable: {reason}')
    add_camera(
        'Green River Bluffs & Air Quality', 37.193166, -86.103329,
        image_url, 'image', 'Kentucky', 'Edmonson County', '', 'nps',
        source_page, 300,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'scenic'
    cameras[-1]['_replace_feed_urls'] = [
        'https://www.nps.gov/subjects/air/webcams.htm?site=maca'
    ]
    atomic_write_json(
        DATA_DIR / 'kentucky_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service - Mammoth Cave National Park',
            'source_url': source_page,
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'attribution': 'National Park Service',
            'license_or_usage_terms': 'NPS-created website material is generally public domain',
            'rejected': [],
            'refresh_cadence_seconds': 300,
        },
        indent=2,
    )
    print('  Kentucky NPS image verification: 1/1 current')
    return 1


def fetch_north_dakota_nps_verified():
    source_page = 'https://www.nps.gov/AirWebCams/THRO'
    camera_id = 'THR422'
    image_url = 'https://www.nps.gov/featurecontent/ard/webcams/images/throlarge.jpg'
    candidate = {
        'provider_camera_id': camera_id,
        'url': image_url,
        'max_age_seconds': 1800,
    }
    verified, errors, snapshots = verify_current_jpeg_images(
        [candidate], probe_interval=2.0, workers=1
    )
    if camera_id not in verified:
        reason = errors.get(camera_id, 'transient_network:verification_incomplete')
        raise IncompleteProviderError(f'Painted Canyon image unavailable: {reason}')
    add_camera(
        'Theodore Roosevelt National Park - Painted Canyon Air Quality',
        46.894844, -103.377719, image_url, 'image', 'North Dakota',
        'Billings County', '', 'nps', source_page, 900,
    )
    cameras[-1]['provider_camera_id'] = camera_id
    cameras[-1]['provider_timestamp'] = snapshots[camera_id][2]
    cameras[-1]['category'] = 'weather_scenic'
    atomic_write_json(
        DATA_DIR / 'north_dakota_nps_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'National Park Service - Theodore Roosevelt National Park',
            'source_url': source_page,
            'verified_live': 1,
            'provider_timestamp': snapshots[camera_id][2],
            'attribution': 'National Park Service',
            'license_or_usage_terms': 'NPS-created website material is generally public domain',
            'rejected': [],
            'refresh_cadence_seconds': 900,
        },
        indent=2,
    )
    print('  North Dakota NPS image verification: 1/1 current')
    return 1


def fetch_alaska_avo_verified():
    provider_root = 'https://avo.alaska.edu/ashcam-api'
    candidates = []
    metadata_by_code = {}
    rejected = []
    now_timestamp = datetime.now(timezone.utc).timestamp()
    for item in ALASKA_AVO_CAMS:
        code = item['code']
        source_page = f'{provider_root}/webcamApi/webcam/{code}'
        try:
            metadata = fetch_json(source_page)['webcam']
            newest = metadata['newestImage']
            provider_timestamp = int(newest['imageTimestamp'])
            image_url = str(metadata['currentImageUrl'])
            if metadata.get('webcamCode') != code:
                raise ValueError('provider_camera_id_mismatch')
            if metadata.get('isPublic') != 'Y' or metadata.get('hasImages') != 'Y':
                raise ValueError('confirmed_not_live:not_public_or_no_images')
            if abs(float(metadata['latitude']) - item['lat']) > 0.000001:
                raise ValueError('location_ambiguous:latitude_changed')
            if abs(float(metadata['longitude']) - item['lon']) > 0.000001:
                raise ValueError('location_ambiguous:longitude_changed')
            if image_url != f'{provider_root}/images/{code}/current.jpg':
                raise ValueError('unsupported_embed:unexpected_current_image_url')
            age_seconds = now_timestamp - provider_timestamp
            if age_seconds < -300 or age_seconds > 7200:
                raise ValueError(f'placeholder:stale_provider_timestamp:{int(age_seconds)}')
            if not re.fullmatch(r'[0-9a-f]{32}', str(newest.get('md5') or '')):
                raise ValueError('placeholder:missing_provider_hash')
        except Exception as exc:
            rejected.append({
                'provider_camera_id': code,
                'failure_class': str(exc),
            })
            continue
        metadata_by_code[code] = metadata
        candidates.append({
            'provider_camera_id': code,
            'url': image_url,
            'max_age_seconds': 7200,
            'minimum_bytes': 8192,
        })

    if len(candidates) != len(ALASKA_AVO_CAMS):
        raise IncompleteProviderError(
            f'truncated_metadata_inventory:{len(candidates)}<{len(ALASKA_AVO_CAMS)}'
        )
    verified, errors, snapshots = verify_current_jpeg_images(
        candidates, probe_interval=2.0, workers=3
    )
    for item in ALASKA_AVO_CAMS:
        code = item['code']
        if code not in verified:
            rejected.append({
                'provider_camera_id': code,
                'failure_class': errors.get(
                    code, 'transient_network:verification_incomplete'
                ),
            })
            continue
        metadata = metadata_by_code[code]
        add_camera(
            item['name'], item['lat'], item['lon'], metadata['currentImageUrl'],
            'image', 'Alaska', item['county'], item['direction'], 'usgs',
            f'{provider_root}/webcamApi/webcam/{code}', 3600,
        )
        cameras[-1]['provider_camera_id'] = code
        cameras[-1]['provider_timestamp'] = datetime.fromtimestamp(
            int(metadata['newestImage']['imageTimestamp']), timezone.utc
        ).isoformat()
        cameras[-1]['provider_hash'] = metadata['newestImage']['md5']
        cameras[-1]['category'] = 'volcano'

    count = len(verified)
    atomic_write_json(
        DATA_DIR / 'alaska_avo_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Alaska Volcano Observatory / U.S. Geological Survey',
            'source_url': provider_root,
            'geographic_scope': 'Katmai, Redoubt, and Shishaldin volcano cameras',
            'location_evidence': (
                'The first-party AVO API supplies each exact camera coordinate, '
                'bearing, current-image URL, provider timestamp, and content hash.'
            ),
            'attribution': 'Alaska Volcano Observatory / U.S. Geological Survey',
            'license_or_usage_terms': (
                'AVO staff imagery is generally reusable with displayed credit and '
                'restrictions checked; StormScope links the original current images.'
            ),
            'verified_live': count,
            'rejected': rejected,
            'refresh_cadence_seconds': 3600,
        },
        indent=2,
    )
    if count != len(ALASKA_AVO_CAMS):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{count}<{len(ALASKA_AVO_CAMS)}'
        )
    print(f'  Alaska AVO image verification: {count}/{len(ALASKA_AVO_CAMS)} current')
    return count


def smithsonian_live_window_active(now=None):
    current = now or datetime.now(timezone.utc)
    return 7 <= current.astimezone(ZoneInfo('America/New_York')).hour < 19


def fetch_smithsonian_national_zoo():
    if not smithsonian_live_window_active():
        raise IncompleteProviderError(
            'Smithsonian scheduled feeds are outside the 07:00-19:00 ET live window'
        )
    source_root = 'https://nationalzoo.si.edu/webcams'
    candidates = [
        {
            'provider_camera_id': '11305',
            'name': 'Smithsonian National Zoo Naked Mole-Rat Cam 1',
            'lat': 38.930417,
            'lon': -77.048944,
            'url': ('https://nzp-wowza02.si.edu/live_edge_nmr/'
                    'nmr_1080_all.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/naked-mole-rat-cam',
            'refresh_cadence_seconds': 11,
        },
        {
            'provider_camera_id': '11307',
            'name': 'Smithsonian National Zoo Naked Mole-Rat Cam 2',
            'lat': 38.930417,
            'lon': -77.048944,
            'url': ('https://nzp-wowza02.si.edu/live_edge_nmr_02/'
                    'nmr_02_1080_all.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/naked-mole-rat-cam',
            'refresh_cadence_seconds': 17,
        },
        {
            'provider_camera_id': '11330',
            'name': 'Smithsonian National Zoo Lion Cam',
            'lat': 38.928487,
            'lon': -77.046557,
            'url': ('https://nzp-wowza01.si.edu/live_edge_lion/'
                    'smil:lion01_all.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/lion-cam',
            'refresh_cadence_seconds': 11,
        },
        {
            'provider_camera_id': '15789',
            'name': 'Smithsonian National Zoo Giant Panda Cam 1',
            'lat': 38.931072,
            'lon': -77.052735,
            'url': ('https://nzp-wowza01.si.edu/live_edge_panda25/'
                    'smil:panda125_01.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/panda-cam',
            'refresh_cadence_seconds': 12,
        },
        {
            'provider_camera_id': '15791',
            'name': 'Smithsonian National Zoo Giant Panda Cam 2',
            'lat': 38.931072,
            'lon': -77.052735,
            'url': ('https://nzp-wowza01.si.edu/live_edge_panda25/'
                    'smil:panda125_02.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/panda-cam',
            'refresh_cadence_seconds': 12,
        },
        {
            'provider_camera_id': '17420',
            'name': 'Smithsonian National Zoo Elephant Cam',
            'lat': 38.931127,
            'lon': -77.05117,
            'url': ('https://nzp-wowza01.si.edu/live_edge_elephant_zixi/'
                    'elephant_zixi.smil/playlist.m3u8'),
            'source_url': 'https://nationalzoo.si.edu/webcams/elephants',
            'refresh_cadence_seconds': 12,
        },
    ]
    verified, errors = verify_live_hls(
        [item['url'] for item in candidates],
        probe_interval=8.0,
        workers=6,
        referer=source_root,
    )
    accepted = []
    rejected = []
    for item in candidates:
        if item['url'] not in verified:
            detail = errors.get(item['url'], 'transient_network:verification_incomplete')
            rejected.append({
                'provider_camera_id': item['provider_camera_id'],
                'name': item['name'],
                'failure_class': detail.split(':', 1)[0],
                'detail': detail,
            })
            continue
        add_camera(
            item['name'], item['lat'], item['lon'], item['url'], 'hls',
            'DC', 'Washington', '', 'smithsonian', item['source_url'],
            item['refresh_cadence_seconds'],
        )
        cameras[-1]['provider_camera_id'] = item['provider_camera_id']
        cameras[-1]['category'] = 'wildlife'
        accepted.append({
            'provider_camera_id': item['provider_camera_id'],
            'name': item['name'],
            'lat': item['lat'],
            'lon': item['lon'],
            'url': item['url'],
            'source_url': item['source_url'],
            'refresh_cadence_seconds': item['refresh_cadence_seconds'],
        })
    atomic_write_json(
        DATA_DIR / 'smithsonian_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Smithsonian National Zoo',
            'geographic_scope': 'National Zoo, Washington, DC',
            'location_evidence_urls': [
                'https://nationalzoo.si.edu/animals/exhibits/small-mammal-house',
                'https://nationalzoo.si.edu/animals/exhibits/great-cats',
                'https://nationalzoo.si.edu/animals/giant-panda',
                'https://nationalzoo.si.edu/animals/exhibits/elephant-trails',
            ],
            'attribution': 'Smithsonian National Zoo',
            'license_or_usage_terms': (
                'Smithsonian Terms permit personal, educational, and noncommercial '
                'fair use with source attribution. StormScope hotlinks the first-party '
                'live playlists and does not copy or rehost media.'
            ),
            'terms_url': 'https://www.si.edu/termsofuse',
            'scheduled_live_window': '07:00-19:00 America/New_York',
            'verified_live': len(accepted),
            'rejected': len(rejected),
            'accepted': accepted,
            'rejections': rejected,
        },
    )
    if len(accepted) != len(candidates):
        raise IncompleteProviderError(
            f'truncated_verified_inventory:{len(accepted)}<{len(candidates)}'
        )
    print(f'  Smithsonian National Zoo HLS verification: '
          f'{len(accepted)}/{len(candidates)} advancing')
    return len(accepted)


def fetch_arkansas_cobblestone():
    source_page = 'https://cobblestoneonnorfork.com/live-webcam/'
    player_url = 'https://rtsp.me/embed/ifn2nBEf/'
    homepage = _http_bytes(source_page, timeout=30).decode('utf-8', 'replace')
    if player_url not in homepage:
        raise IncompleteProviderError('Cobblestone first-party camera embed is missing')
    def resolve_hls():
        player = _http_bytes(
            player_url, headers={'Referer': source_page}, timeout=30
        ).decode('utf-8', 'replace')
        match = re.search(r"https://[^'\"]+\.m3u8[^'\"]*", player)
        if not match:
            raise IncompleteProviderError('Cobblestone RTSP.me live playlist is missing')
        resolved = match.group(0)
        parsed = urllib.parse.urlsplit(resolved)
        if (parsed.scheme != 'https' or not parsed.hostname
                or not (parsed.hostname == 'rtsp.me'
                        or parsed.hostname.endswith('.rtsp.me'))
                or '/hls/ifn2nBEf.m3u8' not in parsed.path):
            raise IncompleteProviderError('Cobblestone RTSP.me playlist contract changed')
        return resolved

    hls_url = ''
    detail = 'transient_network:verification_incomplete'
    verification_attempts = 0
    for attempt in range(3):
        verification_attempts = attempt + 1
        hls_url = resolve_hls()
        verified, errors = verify_live_hls(
            [hls_url], probe_interval=7.0, workers=1, referer=player_url
        )
        if hls_url in verified:
            break
        detail = errors.get(hls_url, 'transient_network:verification_incomplete')
        if not detail.startswith('transient_network:') or attempt == 2:
            break
        time.sleep(2 ** attempt)
    else:  # pragma: no cover - loop always exits through range exhaustion
        verified = set()
    if hls_url not in verified:
        atomic_write_json(
            DATA_DIR / 'rtspme_discovery_report.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Cobblestone Resort / RTSP.me',
                'source_url': source_page,
                'verified_live': 0,
                'rejected': 1,
                'rejections': [{
                    'provider_camera_id': 'ifn2nBEf',
                    'failure_class': detail.split(':', 1)[0],
                    'detail': detail,
                }],
            },
        )
        if detail.startswith(('transient_network:', 'rate_limited:',
                              'authentication_required:')):
            raise IncompleteProviderError(
                f'Cobblestone camera retryable failure: {detail}'
            )
        return 0
    add_camera(
        'Lake Norfork at Cobblestone Resort',
        36.4072021,
        -92.2352157,
        player_url,
        'embed',
        'Arkansas',
        'Baxter County',
        '',
        'rtspme',
        source_page,
        10,
    )
    cameras[-1]['provider_camera_id'] = 'ifn2nBEf'
    cameras[-1]['category'] = 'lake'
    atomic_write_json(
        DATA_DIR / 'rtspme_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Cobblestone Resort / RTSP.me',
            'source_url': source_page,
            'player_url': player_url,
            'verification_stream_url': hls_url,
            'geographic_scope': 'Cobblestone Resort, Gamaliel, Arkansas',
            'location_evidence': (
                'First-party address and Get Directions link identify 149 Co Rd 820, '
                'Gamaliel, AR 72537 at 36.4072021,-92.2352157.'
            ),
            'attribution': 'Cobblestone Resort on Norfork Lake; RTSP.me player',
            'license_or_usage_terms': (
                'The operator intentionally publishes the live player on its public '
                'webcam page and no camera-specific reuse restriction was found. '
                'StormScope stores only the stable player URL and does not retain '
                'or rehost the expiring HLS media URL.'
            ),
            'verified_live': 1,
            'rejected': 0,
            'verification_attempts': verification_attempts,
            'refresh_cadence_seconds': 10,
        },
    )
    print('  Cobblestone RTSP.me verification: 1/1 advancing')
    return 1


ARKANSAS_HAZCAMS_COUNTIES = {
    'alexander-ar-us-001': 'Saline County',
    'arkadelphia-ar-us-001': 'Clark County',
    'bay-ar-us-001': 'Craighead County',
    'conway-ar-us-002': 'Faulkner County',
    'crossett-ar-us-001': 'Ashley County',
    'el-dorado-ar-us-001': 'Union County',
    'fairfield-bay-ar-us-001': 'Van Buren County',
    'hamburg-ar-us-001': 'Ashley County',
    'helena-ar-us-001': 'Phillips County',
    'little-rock-ar-us-001': 'Pulaski County',
    'newport-ar-us-001': 'Jackson County',
    'pine-bluff-ar-us-001': 'Jefferson County',
    'prescott-ar-us-001': 'Nevada County',
    'siloam-springs-ar-us-001': 'Benton County',
    'stuttgart-ar-us-001': 'Arkansas County',
    'wynne-ar-us-001': 'Cross County',
    'wynne-ar-us-002': 'Cross County',
}


def fetch_arkansas_hazcams():
    source_home = 'https://hazcams.com/'
    html_text = _http_bytes(source_home, timeout=30).decode('utf-8', 'replace')
    next_data_match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html_text,
        re.DOTALL,
    )
    if not next_data_match:
        raise IncompleteProviderError('Hazcams public station inventory is missing')
    try:
        page_data = json.loads(next_data_match.group(1))
        inventory = page_data['props']['pageProps']['stations']
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise IncompleteProviderError(
            'Hazcams public station inventory contract changed'
        ) from exc
    if not isinstance(inventory, list):
        raise IncompleteProviderError('Hazcams public station inventory is invalid')

    arkansas_inventory = {
        item.get('id'): item
        for item in inventory
        if isinstance(item, dict)
        and re.fullmatch(r'[a-z0-9-]+-ar-us-\d+', str(item.get('id') or ''))
    }
    expected_ids = set(ARKANSAS_HAZCAMS_COUNTIES)
    missing_ids = sorted(expected_ids - set(arkansas_inventory))
    uncurated_ids = sorted(set(arkansas_inventory) - expected_ids)
    now_ms = int(time.time() * 1000)
    rejected = []
    candidates = []
    for provider_id in sorted(expected_ids):
        item = arkansas_inventory.get(provider_id)
        if not item:
            continue
        lat = item.get('lat')
        lon = item.get('lon')
        timestamp_ms = item.get('timestamp')
        failures = []
        if item.get('online') is not True or item.get('video') is not True:
            failures.append('confirmed_not_live:provider_offline')
        if not isinstance(lat, (int, float)) or not 33.0 <= float(lat) <= 36.6:
            failures.append('location_ambiguous:invalid_latitude')
        if not isinstance(lon, (int, float)) or not -94.7 <= float(lon) <= -89.6:
            failures.append('location_ambiguous:invalid_longitude')
        if not isinstance(timestamp_ms, (int, float)):
            failures.append('confirmed_not_live:missing_station_timestamp')
        elif timestamp_ms < now_ms - 30 * 60 * 1000:
            failures.append('confirmed_not_live:stale_station_timestamp')
        elif timestamp_ms > now_ms + 24 * 60 * 60 * 1000:
            failures.append('provider_error:future_station_timestamp')
        if failures:
            rejected.append({
                'provider_camera_id': provider_id,
                'failure_class': failures[0],
                'failures': failures,
            })
            continue
        candidates.append(item)

    if missing_ids or rejected:
        atomic_write_json(
            DATA_DIR / 'youtube_discovery_report_arkansas_hazcams.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Hazcams / Arkansas Weather Network',
                'source_url': source_home,
                'inventory_count': len(arkansas_inventory),
                'expected_count': len(expected_ids),
                'verified_live': 0,
                'missing_provider_camera_ids': missing_ids,
                'rejected': rejected,
                'uncurated_provider_camera_ids': uncurated_ids,
            },
            indent=2,
        )
        raise IncompleteProviderError(
            'Hazcams Arkansas inventory is incomplete or reports an offline station'
        )

    hls_by_id = {
        item['id']: f"https://video.hazcams.com/{item['id']}/index.m3u8"
        for item in candidates
    }
    verified_hls, hls_errors = verify_live_hls(
        list(hls_by_id.values()),
        probe_interval=8.0,
        workers=8,
        referer=source_home,
    )
    failed_hls = [
        {
            'provider_camera_id': provider_id,
            'failure_class': hls_errors.get(
                hls_url, 'confirmed_not_live:not_advancing'
            ),
        }
        for provider_id, hls_url in hls_by_id.items()
        if hls_url not in verified_hls
    ]
    if failed_hls:
        atomic_write_json(
            DATA_DIR / 'youtube_discovery_report_arkansas_hazcams.json',
            {
                'generated_at': utc_now_iso(),
                'provider': 'Hazcams / Arkansas Weather Network',
                'source_url': source_home,
                'inventory_count': len(arkansas_inventory),
                'expected_count': len(expected_ids),
                'verified_live': len(verified_hls),
                'rejected': failed_hls,
                'uncurated_provider_camera_ids': uncurated_ids,
            },
            indent=2,
        )
        raise IncompleteProviderError('Hazcams Arkansas HLS verification is incomplete')

    accepted = []
    compass_points = ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')
    for item in sorted(candidates, key=lambda row: (row['name'], row['id'])):
        provider_id = item['id']
        bearing = item.get('bearing')
        direction = ''
        if isinstance(bearing, (int, float)):
            direction = compass_points[int((float(bearing) + 22.5) // 45) % 8]
        source_page = f'https://hazcams.com/station/{provider_id}'
        embed_url = (
            f'https://hazcams.com/embed/station/{provider_id}'
            '?backgroundColor=171a21&hd=true&keep_aspect=true&linkout=true&sponsor=true'
        )
        add_camera(
            f"{item['name']} Weather Cam",
            item['lat'],
            item['lon'],
            embed_url,
            'embed',
            'Arkansas',
            ARKANSAS_HAZCAMS_COUNTIES[provider_id],
            direction,
            'hazcams',
            source_page,
            4,
        )
        cameras[-1]['provider_camera_id'] = provider_id
        cameras[-1]['category'] = 'weather'
        accepted.append({
            'provider_camera_id': provider_id,
            'name': item['name'],
            'lat': item['lat'],
            'lon': item['lon'],
            'county': ARKANSAS_HAZCAMS_COUNTIES[provider_id],
            'source_url': source_page,
            'verification_stream_url': hls_by_id[provider_id],
        })

    atomic_write_json(
        DATA_DIR / 'youtube_discovery_report_arkansas_hazcams.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'Hazcams / Arkansas Weather Network',
            'source_url': source_home,
            'geographic_scope': '17 current weather-camera stations across Arkansas',
            'provider_inventory_count': len(arkansas_inventory),
            'expected_count': len(expected_ids),
            'location_evidence': (
                'Hazcams machine-readable station metadata supplies exact coordinates; '
                'county names were cross-checked against the U.S. Census geocoder. '
                'Henderson State University independently identifies the Arkadelphia '
                'station as its official campus weather camera.'
            ),
            'location_evidence_url': (
                'https://www.hsu.edu/news/2026/feb/25/weathercam/'
            ),
            'attribution': 'Hazcams and the station sponsors shown in each player',
            'license_or_usage_terms': (
                'Hazcams intentionally exposes a branded public embed route for each '
                'station. StormScope stores that supported player URL with sponsor '
                'and link-out attribution enabled; verification HLS URLs are neither '
                'persisted in the corpus nor proxied or archived.'
            ),
            'privacy_policy_url': 'https://hazcams.com/privacypolicy.html',
            'verified_live': len(accepted),
            'rejected': [],
            'uncurated_provider_camera_ids': uncurated_ids,
            'refresh_cadence_seconds': 4,
            'accepted': accepted,
        },
        indent=2,
    )
    print(f'  Hazcams Arkansas HLS verification: {len(accepted)}/{len(expected_ids)} advancing')
    return len(accepted)


CONNECTICUT_ANGELCAM_CAMERAS = (
    {
        'provider_camera_id': '111999',
        'alias': '17ydm1ozye',
        'name': 'Connecticut Audubon Milford Point Osprey Cam',
        'lat': 41.173934010404,
        'lon': -73.103990039371,
        'county': 'New Haven County',
        'source_url': (
            'https://ctaudubon.org/conservation/science/bird-cams/'
            'milford-point-osprey-cam/'
        ),
        'category': 'wildlife',
    },
    {
        'provider_camera_id': '40266',
        'alias': '1eyv39e1r7',
        'name': 'Falkner Island Lighthouse Cam',
        'lat': 41.21205,
        'lon': -72.65361,
        'county': 'New Haven County',
        'source_url': 'https://menunkatuck.org/falkner-island-lighthouse-camera',
        'category': 'lighthouse',
    },
    {
        'provider_camera_id': '127096',
        'alias': '16lb553el4',
        'name': 'Hammonasset Beach State Park Osprey Cam',
        'lat': 41.252384,
        'lon': -72.546026,
        'county': 'New Haven County',
        'source_url': 'https://menunkatuck.org/hammo-osprey-cam',
        'category': 'wildlife',
    },
    {
        'provider_camera_id': '127097',
        'alias': '2dy6nn7vrk',
        'name': 'Meigs Point Nature Center Feeder Cam',
        'lat': 41.252384,
        'lon': -72.546026,
        'county': 'New Haven County',
        'source_url': 'https://menunkatuck.org/meigs-point-nature-center-camera',
        'category': 'nature_center',
    },
)


def _resolve_angelcam_hls(item):
    embed_url = f"https://v.angelcam.com/iframe?v={item['alias']}&autoplay=1"
    player = _http_bytes(
        embed_url,
        headers={'Referer': item['source_url']},
        timeout=30,
    ).decode('utf-8', 'replace')
    match = re.search(r"['\"]hls['\"]\s*:\s*['\"]([^'\"]+\.m3u8[^'\"]*)", player)
    if not match:
        raise IncompleteProviderError(
            f"AngelCam live playlist is missing for {item['provider_camera_id']}"
        )
    try:
        hls_url = json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError as exc:
        raise IncompleteProviderError('AngelCam live playlist encoding changed') from exc
    parsed = urllib.parse.urlsplit(hls_url)
    expected_path = (
        f"/cameras/{item['provider_camera_id']}/streams/hls/playlist.m3u8"
    )
    if (
        parsed.scheme != 'https'
        or not parsed.hostname
        or not parsed.hostname.endswith('.angelcam.com')
        or parsed.path != expected_path
        or not urllib.parse.parse_qs(parsed.query).get('token')
    ):
        raise IncompleteProviderError('AngelCam live playlist contract changed')
    return embed_url, hls_url


def fetch_connecticut_angelcam_verified():
    resolved = {}
    for item in CONNECTICUT_ANGELCAM_CAMERAS:
        source_page = _http_bytes(item['source_url'], timeout=30).decode(
            'utf-8', 'replace'
        )
        if item['alias'] not in source_page:
            raise IncompleteProviderError(
                f"first-party page is missing AngelCam alias {item['alias']}"
            )
        resolved[item['provider_camera_id']] = _resolve_angelcam_hls(item)
    verified, errors = verify_live_hls(
        [hls_url for _, hls_url in resolved.values()],
        probe_interval=8.0,
        workers=4,
        referer='https://v.angelcam.com/',
    )
    rejected = [
        {
            'provider_camera_id': f"angelcam:{item['provider_camera_id']}",
            'failure_class': errors.get(
                resolved[item['provider_camera_id']][1],
                'confirmed_not_live:not_advancing',
            ),
        }
        for item in CONNECTICUT_ANGELCAM_CAMERAS
        if resolved[item['provider_camera_id']][1] not in verified
    ]
    report_path = DATA_DIR / 'youtube_discovery_report_connecticut_angelcam.json'
    if rejected:
        atomic_write_json(
            report_path,
            {
                'generated_at': utc_now_iso(),
                'provider': 'Connecticut Audubon / Menunkatuck / AngelCam',
                'verified_live': len(verified),
                'rejected': rejected,
            },
            indent=2,
        )
        raise IncompleteProviderError('Connecticut AngelCam verification is incomplete')

    accepted = []
    for item in CONNECTICUT_ANGELCAM_CAMERAS:
        provider_id = item['provider_camera_id']
        embed_url, _ = resolved[provider_id]
        add_camera(
            item['name'],
            item['lat'],
            item['lon'],
            embed_url,
            'embed',
            'Connecticut',
            item['county'],
            '',
            'angelcam',
            item['source_url'],
            6,
        )
        cameras[-1]['provider_camera_id'] = f'angelcam:{provider_id}'
        cameras[-1]['category'] = item['category']
        accepted.append({
            'provider_camera_id': f'angelcam:{provider_id}',
            'name': item['name'],
            'url': embed_url,
            'source_url': item['source_url'],
        })
    atomic_write_json(
        report_path,
        {
            'generated_at': utc_now_iso(),
            'provider': 'Connecticut Audubon / Menunkatuck / AngelCam',
            'geographic_scope': (
                'Milford Point, Falkner Island, and Hammonasset Beach State Park, '
                'New Haven County, Connecticut'
            ),
            'location_evidence': (
                'First-party operator and Connecticut DEEP/USFWS pages identify '
                'each public camera location. Public building or landmark points '
                'are used for sensitive wildlife cameras.'
            ),
            'attribution': (
                'The Connecticut Audubon Society, Menunkatuck Audubon Society, '
                'Friends of Hammonasset, and AngelCam'
            ),
            'license_or_usage_terms': (
                'AngelCam permits published content to be accessed through its '
                'service functionality. StormScope stores only the exact public '
                'iframe and never persists, proxies, or archives expiring HLS tokens.'
            ),
            'terms_url': 'https://www.angelcam.com/terms',
            'verified_live': len(accepted),
            'rejected': [],
            'refresh_cadence_seconds': 6,
            'accepted': accepted,
        },
        indent=2,
    )
    print('  Connecticut AngelCam HLS verification: 4/4 advancing')
    return len(accepted)


# ── West Virginia (WV511) — official map inventory + per-camera live HLS ──
WV511_COUNTIES = {
    'BER': 'Berkeley',
    'BOO': 'Boone',
    'BRA': 'Braxton',
    'CAB': 'Cabell',
    'FAY': 'Fayette',
    'GRA': 'Grant',
    'GRE': 'Greenbrier',
    'HAR': 'Harrison',
    'JAC': 'Jackson',
    'JEF': 'Jefferson',
    'KAN': 'Kanawha',
    'LEW': 'Lewis',
    'LOG': 'Logan',
    'MAR': 'Marion',
    'MER': 'Mercer',
    'MIN': 'Mineral',
    'MON': 'Monongalia',
    'OHI': 'Ohio',
    'PRE': 'Preston',
    'PUT': 'Putnam',
    'RAL': 'Raleigh',
    'TUC': 'Tucker',
    'WEZ': 'Wetzel',
    'WOO': 'Wood',
}


def _parse_wv511_inventory(payload):
    text = payload.decode('utf-8', 'replace') if isinstance(payload, bytes) else str(payload)
    match = re.search(r'\bvar\s+camera_data\s*=\s*(\{.*\})\s*;?\s*$', text, re.DOTALL)
    if not match:
        raise ValueError('WV511 camera_data payload missing')
    data = json.loads(match.group(1))
    records = data.get('cams') or []
    declared = int(data.get('count', -1))
    if declared != len(records) or not records:
        raise IncompleteProviderError(
            f'WV511 inventory count mismatch ({declared} declared, {len(records)} returned)'
        )
    parsed = []
    seen = set()
    for record in records:
        camera_id = str(record.get('md5', '')).strip().upper()
        description_html = html.unescape(str(record.get('description', '')))
        if (not re.fullmatch(r'CAM\d{3}', camera_id)
                or camera_id in seen
                or record.get('icon') != 'icon_feed'
                or '<!--STREAMING:1-->' not in description_html):
            continue
        description_match = re.search(
            r'<div[^>]+id=["\']camDescription["\'][^>]*>(.*?)<span\b',
            description_html,
            re.IGNORECASE | re.DOTALL,
        )
        if not description_match:
            continue
        label = re.sub(r'<[^>]+>', ' ', description_match.group(1))
        label = re.sub(r'\s+', ' ', label).strip()
        county_match = re.match(r'^\[([A-Z]{3})\]\s*', label)
        if not county_match or county_match.group(1) not in WV511_COUNTIES:
            continue
        label = label[county_match.end():].strip()
        try:
            lat = float(record.get('start_lat'))
            lon = float(record.get('start_lng'))
        except (TypeError, ValueError):
            continue
        if not (37.0 <= lat <= 41.0 and -83.0 <= lon <= -77.0):
            continue
        seen.add(camera_id)
        parsed.append({
            'camera_id': camera_id,
            'name': label or str(record.get('title', '')).strip() or 'WV511 Camera',
            'lat': lat,
            'lon': lon,
            'county': WV511_COUNTIES[county_match.group(1)],
        })
    if len(parsed) != declared:
        raise IncompleteProviderError(
            f'WV511 inventory validation rejected {declared - len(parsed)} of {declared} rows'
        )
    return parsed


def _wv511_stream_url(camera_id):
    player_url = f'https://wv511.org/flowplayeri.aspx?CAMID={camera_id}'
    page = _http_bytes(
        player_url,
        headers={'Referer': 'https://wv511.org/CameraListing.aspx'},
        timeout=20,
    ).decode('utf-8', 'replace')
    streams = set(re.findall(
        r'https://vtc\d+\.roadsummary\.com/rtplive/(CAM\d{3})/playlist\.m3u8',
        page,
        re.IGNORECASE,
    ))
    if streams != {camera_id}:
        raise ValueError('confirmed_not_live:player_stream_missing')
    stream_match = re.search(
        rf'https://vtc\d+\.roadsummary\.com/rtplive/{camera_id}/playlist\.m3u8',
        page,
        re.IGNORECASE,
    )
    return stream_match.group(0)


def fetch_wv511():
    inventory_url = 'https://wv511.org/wsvc/gmap.asmx/buildCamerasJSONjs'
    source_page = 'https://wv511.org/CameraListing.aspx'
    records = _parse_wv511_inventory(_http_bytes(
        inventory_url,
        headers={'Accept': 'application/javascript, text/javascript, */*',
                 'Referer': 'https://wv511.org/webmapi.aspx'},
        timeout=40,
    ))
    rejected = []
    candidates = []

    def resolve(record):
        try:
            return record, _wv511_stream_url(record['camera_id']), ''
        except Exception as exc:
            if isinstance(exc, urllib.error.HTTPError):
                if exc.code in {404, 410}:
                    reason = f'confirmed_dead:http_{exc.code}'
                elif exc.code == 429:
                    reason = 'rate_limited:http_429'
                elif exc.code in {401, 403}:
                    reason = f'authentication_required:http_{exc.code}'
                else:
                    reason = f'transient_network:http_{exc.code}'
            else:
                reason = str(exc)
                if not reason.startswith(('confirmed_not_live:', 'confirmed_dead:')):
                    reason = f'transient_network:{reason}'
            return record, '', reason

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        futures = [executor.submit(resolve, record) for record in records]
        for future in concurrent.futures.as_completed(futures):
            record, stream_url, reason = future.result()
            if reason:
                rejected.append({
                    'provider_camera_id': record['camera_id'],
                    'name': record['name'],
                    'failure_class': reason.split(':', 1)[0],
                    'detail': reason,
                })
            else:
                candidates.append({**record, 'url': stream_url})

    verified, verification_errors = verify_live_hls(
        [candidate['url'] for candidate in candidates],
        probe_interval=10.0,
        workers=12,
        referer='https://wv511.org/',
    )
    count = 0
    for candidate in sorted(candidates, key=lambda item: item['camera_id']):
        stream_url = candidate['url']
        if stream_url not in verified:
            reason = verification_errors.get(stream_url, 'confirmed_not_live:verification_failed')
            rejected.append({
                'provider_camera_id': candidate['camera_id'],
                'name': candidate['name'],
                'failure_class': reason.split(':', 1)[0],
                'detail': reason,
            })
            continue
        player_url = f"https://wv511.org/flowplayeri.aspx?CAMID={candidate['camera_id']}"
        add_camera(
            candidate['name'], candidate['lat'], candidate['lon'], stream_url,
            'hls', 'West Virginia', candidate['county'], '', 'dot', player_url, 10,
        )
        cameras[-1]['provider_camera_id'] = candidate['camera_id']
        count += 1

    failure_counts = {}
    for item in rejected:
        key = item['failure_class']
        failure_counts[key] = failure_counts.get(key, 0) + 1
    atomic_write_json(
        DATA_DIR / 'wv511_discovery_report.json',
        {
            'generated_at': utc_now_iso(),
            'provider': 'West Virginia (WV511)',
            'inventory_url': inventory_url,
            'source_url': source_page,
            'geographic_scope': 'West Virginia statewide',
            'attribution': 'West Virginia DOT',
            'license_or_usage_terms': (
                'No explicit reuse license is displayed on the public WV511 camera pages; '
                'public read-only viewing endpoints only.'
            ),
            'refresh_cadence_seconds': 10,
            'inventory_count': len(records),
            'stream_candidates': len(candidates),
            'verified_live': count,
            'rejected': len(rejected),
            'rejected_by_class': failure_counts,
            'rejections': sorted(rejected, key=lambda item: item['provider_camera_id']),
        },
    )
    transient = [
        item for item in rejected
        if item['failure_class'] in {
            'transient_network', 'rate_limited', 'authentication_required'
        }
    ]
    if transient:
        raise IncompleteProviderError(
            f'WV511 had {len(transient)} retryable player/stream failures'
        )
    print(f'  WV511 HLS verification: {count}/{len(records)} advancing')
    return count


# ── Virginia (VDOT 511) — GeoJSON with absolute snapshot + HLS URLs ──
def fetch_va_511():
    try:
        url = 'https://511.vdot.virginia.gov/services/map/layers/map/cams'
        data = json.loads(_http_bytes(url, headers={'Accept': 'application/json'}, timeout=30))
        count = 0
        for feat in data.get('features', []):
            props = feat.get('properties', {})
            if not props.get('active') or props.get('problem_stream'):
                continue
            img_url = str(props.get('image_url', ''))
            if not img_url.startswith('https://'):
                continue
            coords = (feat.get('geometry', {}) or {}).get('coordinates', [0, 0])
            if not isinstance(coords, list) or len(coords) < 2:
                continue
            name = props.get('description', '') or props.get('route', '') or 'Virginia Camera'
            add_camera(name, coords[1], coords[0], img_url, 'image', 'Virginia',
                       props.get('jurisdiction', '') or '', props.get('direction', '') or '',
                       'dot', 'https://511.vdot.virginia.gov/cameras', 60)
            count += 1
        return count
    except Exception as e:
        print(f'  Virginia 511: {e}')
        return 0


# ── Oregon (ODOT TripCheck) — cctvinventory served as .js JSON ──
def fetch_or_tripcheck():
    try:
        data = json.loads(_http_bytes(
            'https://www.tripcheck.com/Scripts/map/data/cctvinventory.js', timeout=30))
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            filename = str(attrs.get('filename', '')).strip()
            if not filename:
                continue
            img_url = 'https://tripcheck.com/RoadCams/cams/' + urllib.parse.quote(filename)
            name = str(attrs.get('title', '') or 'Oregon Camera').strip()
            add_camera(name, attrs.get('latitude'), attrs.get('longitude'), img_url,
                       'image', 'Oregon', '', '', 'dot', 'https://www.tripcheck.com/', 300)
            count += 1
        return count
    except Exception as e:
        print(f'  Oregon TripCheck: {e}')
        return 0


# ── Rhode Island (RIDOT Rhodeways) — keyless ArcGIS MapServer ──
def fetch_ri_ridot():
    try:
        url = ('https://risegis.ri.gov/hosting/rest/services/RIDOT/Rhodeways/MapServer/6/query'
               '?where=Enabled%3D1&outFields=Description,Direction,CCVEWebURL'
               '&returnGeometry=true&outSR=4326&f=json')
        data = json.loads(_http_bytes(url, headers={'Accept': 'application/json'}, timeout=30))
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            img_url = str(attrs.get('CCVEWebURL', '')).strip()
            if img_url.startswith('http://'):
                img_url = 'https://' + img_url[len('http://'):]
            if not img_url.startswith('https://'):
                continue
            img_url = urllib.parse.quote(img_url, safe=':/?&=%')
            geom = feat.get('geometry', {})
            name = str(attrs.get('Description', '') or 'Rhode Island Camera').strip()
            add_camera(name, geom.get('y'), geom.get('x'), img_url, 'image', 'Rhode Island',
                       '', attrs.get('Direction', '') or '', 'dot',
                       'https://www.dot.ri.gov/travel/cameras_metro.php', 60)
            count += 1
        return count
    except Exception as e:
        print(f'  Rhode Island RIDOT: {e}')
        return 0


# ── North Dakota (NDDOT rcrs) — keyless ArcGIS MapServer, still cameras ──
def fetch_nd_dot():
    try:
        url = ('https://gis.dot.nd.gov/ArcGIS/rest/services/external/rcrs_dynamic/MapServer/5/query'
               '?where=1%3D1&outFields=Description,FullPath,Active'
               '&returnGeometry=true&outSR=4326&f=json')
        data = json.loads(_http_bytes(url, headers={'Accept': 'application/json'}, timeout=30))
        count = 0
        for feat in data.get('features', []):
            attrs = feat.get('attributes', {})
            if str(attrs.get('Active', 'Y')).upper() != 'Y':
                continue
            img_url = str(attrs.get('FullPath', '')).strip()
            if not img_url.startswith('https://'):
                continue
            img_url = urllib.parse.quote(img_url, safe=':/?&=%')
            geom = feat.get('geometry', {})
            name = str(attrs.get('Description', '') or 'North Dakota Camera').strip()
            add_camera(name, geom.get('y'), geom.get('x'), img_url, 'image', 'North Dakota',
                       '', '', 'dot', 'https://travel.dot.nd.gov/cameras/', 300)
            count += 1
        return count
    except Exception as e:
        print(f'  North Dakota DOT: {e}')
        return 0


def fetch_cars_graphql(base_url, state_name, bbox, source_page):
    return collect_cars_graphql(
        provider_runtime(),
        CarsGraphqlConfig(base_url, state_name, bbox, source_page),
    )


# ── Mississippi (MDOT Traffic) — ASP.NET PageMethod + per-site stream bubble ──
def fetch_ms_mdot():
    try:
        markers = json.loads(_http_bytes(
            'https://www.mdottraffic.com/default.aspx/LoadCameraData',
            headers={'Accept': 'application/json',
                     'Content-Type': 'application/json; charset=utf-8',
                     'Origin': 'https://www.mdottraffic.com',
                     'Referer': 'https://www.mdottraffic.com/'},
            data=b'{}', method='POST', timeout=40)).get('d', [])
        count = 0
        for marker in markers:
            marker_id = str(marker.get('markerid', ''))
            if '_' not in marker_id:
                continue
            site = marker_id.split('_', 1)[1]
            try:
                html = _http_bytes(
                    f'https://www.mdottraffic.com/mapbubbles/camerasite.aspx?site={site}',
                    timeout=20).decode('utf-8', 'replace')
            except Exception:
                continue
            stream = re.search(r'streamname=(\d+)\.stream', html)
            host = re.search(r'(streamingjxn\d)', html)
            if not stream or not host:
                continue
            img_url = (f'https://{host.group(1)}.mdottraffic.com/thumbnail?application=rtplive'
                       f'&streamname={stream.group(1)}.stream&size=352x240&format=jpg&fitmode=stretch')
            name = str(marker.get('tooltip', '') or 'Mississippi Camera').strip()
            add_camera(name, marker.get('lat'), marker.get('lon'), img_url, 'image',
                       'Mississippi', '', '', 'dot', 'https://www.mdottraffic.com/', 30)
            count += 1
        return count
    except Exception as e:
        print(f'  Mississippi MDOT: {e}')
        return 0


# ── OpenTrafficCamMap baseline (states not covered by live fetchers) ──
def load_otcm_baseline(filepath):
    with open(filepath, 'r') as f:
        existing = json.load(f)
    live_states = {'California', 'Colorado', 'Delaware', 'Georgia', 'Washington'}
    count = 0
    for cam in existing:
        if cam.get('state', '') in live_states:
            continue
        add_camera(cam['name'], cam['lat'], cam['lon'], cam['url'],
                   cam.get('type', 'image'), cam.get('state', ''),
                   cam.get('county', ''), cam.get('direction', ''),
                   cam.get('source', 'dot'))
        count += 1
    return count


def run_fetcher(name, func):
    global active_provider
    print(f'Fetching {name}...')
    start = len(cameras)
    active_provider = name
    try:
        count = func()
        rows = cameras[start:]
        del cameras[start:]
        if not count or not rows:
            error = 'provider returned no cameras'
            stats[name] = f'ERROR: {error}'
            print(f'  {name}: {error}; retaining last-known-good rows')
            return ProviderResult(name, [], error)
        for row in rows:
            row['ingestion_source'] = name
        stats[name] = len(rows)
        print(f'  {name}: {len(rows)} cameras')
        return ProviderResult(name, rows)
    except Exception as e:
        del cameras[start:]
        stats[name] = f'ERROR: {e}'
        print(f'  {name}: ERROR - {e}; retaining last-known-good rows')
        return ProviderResult(name, [], str(e))
    finally:
        active_provider = ''


def provider_fetchers() -> list[tuple[str, Callable[[], int]]]:
    providers = []
    otcm_file = DATA_DIR / 'otcm_baseline.json'
    if otcm_file.exists():
        providers.append(('OpenTrafficCamMap baseline', lambda: load_otcm_baseline(otcm_file)))
    providers.extend([
        ('Caltrans (California)', fetch_caltrans),
        ('Florida (FL511)', lambda: fetch_511_mapicons('https://fl511.com', 'Florida')),
        ('NYC DOT', fetch_nycdot),
        ('WSDOT (Washington)', fetch_wsdot),
        ('Illinois DOT', fetch_illinois),
        ('Michigan DOT', fetch_michigan),
        ('Colorado DOT (live)', fetch_colorado),
        ('Austin TX', fetch_austin_tx),
        ('TxDOT (statewide)', fetch_txdot),
        ('Oklahoma (OKTraffic)', fetch_oktraffic),
        ('Louisiana (LA511)', lambda: fetch_511_mapicons('https://www.511la.org', 'Louisiana')),
        ('Pennsylvania (PA511)', lambda: fetch_511_mapicons('https://511pa.com', 'Pennsylvania')),
        ('Wisconsin (WI511)', lambda: fetch_511_mapicons('https://511wi.gov', 'Wisconsin')),
        ('Utah DOT', fetch_utah),
        ('Nevada (NV511)', lambda: fetch_511_mapicons('https://nvroads.com', 'Nevada')),
        ('New Jersey Turnpike Authority', fetch_njta),
        ('New England 511 (ME/NH/VT)', fetch_newengland511),
        ('Connecticut (CT511)', lambda: fetch_511_mapicons('https://www.ctroads.org', 'Connecticut')),
        ('Connecticut AngelCam verified', fetch_connecticut_angelcam_verified),
        ('Idaho (ID511)', lambda: fetch_511_mapicons('https://511.idaho.gov', 'Idaho')),
        ('South Carolina (SkyVDN)', lambda: fetch_skyvdn_hls(
            'SC', 'South Carolina', 'https://www.511sc.org/', 'scdot_skyvdn_discovery_report.json')),
        ('Tennessee DOT (SmartWay)', fetch_tndot),
        ('Tennessee NPS verified', fetch_tennessee_nps_verified),
        ('Tennessee Clarksville IPCamLive', fetch_tennessee_clarksville),
        ('Massachusetts NPS verified', fetch_massachusetts_nps_verified),
        ('Massachusetts MWRA', fetch_massachusetts_mwra),
        ('Montana (Iteris)', lambda: fetch_iteris_geojson('MT', 'Montana')),
        ('Montana NPS verified', fetch_montana_nps_verified),
        ('South Dakota (Iteris)', lambda: fetch_iteris_geojson('SD', 'South Dakota')),
        ('Missouri DOT', fetch_missouri),
        ('Delaware (live HLS)', fetch_delaware_live),
        ('Delaware (Cape May-Lewes Ferry)', fetch_delaware_cmlf_verified),
        ('New Mexico DOT', fetch_newmexico),
        ('New Mexico NWS', fetch_new_mexico_nws),
        ('New Mexico NPS verified', fetch_new_mexico_nps_verified),
        ('New Mexico USGS', fetch_new_mexico_usgs),
        ('New Mexico NRAO', fetch_new_mexico_nrao),
        ('Minnesota 511 (MnDOT IRIS)', fetch_minnesota_511),
        ('Minnesota USGS verified', fetch_minnesota_usgs_verified),
        ('Hawaii USGS verified', fetch_hawaii_usgs_verified),
        ('Iowa DOT', fetch_iowa_dot),
        ('Wyoming DOT', fetch_wyoming),
        ('Maryland (CHART)', fetch_maryland_chart),
        ('West Virginia (WV511)', fetch_wv511),
        ('Puerto Rico (ACT/ITS)', fetch_pr_act),
        ('Puerto Rico NSF NEON / PhenoCam', fetch_puerto_rico_neon_phenocams),
        ('Guam (GNTF/IPCamLive)', fetch_guam_gntf),
        ('American Samoa (Clipper Oil/IPCamLive)', fetch_american_samoa_clipper),
        ('Rhode Island URI Quadcams', fetch_rhode_island_uri_quadcams),
        ('Mississippi State University', fetch_mississippi_state_university),
        ('New Hampshire university cameras', fetch_new_hampshire_university_cameras),
        ('West Virginia Canaan IPCamLive', fetch_west_virginia_canaan),
        ('West Virginia NPS verified', fetch_west_virginia_nps_verified),
        ('West Virginia State Park', fetch_west_virginia_state_park),
        ('Maine NPS verified', fetch_maine_nps_verified),
        ('Maine Ferry verified', fetch_maine_ferry_verified),
        ('Kentucky Transportation Cabinet (KYTC)', fetch_kentucky_kytc_verified),
        ('FAA WeatherCams / North Dakota airports', fetch_faa_weathercams_north_dakota),
        ('Kentucky NPS verified', fetch_kentucky_nps_verified),
        ('North Dakota NPS verified', fetch_north_dakota_nps_verified),
        ('Alaska Volcano Observatory / U.S. Geological Survey', fetch_alaska_avo_verified),
        ('Smithsonian National Zoo', fetch_smithsonian_national_zoo),
        ('Arkansas (Cobblestone/RTSP.me)', fetch_arkansas_cobblestone),
        ('Arkansas (Hazcams weather network)', fetch_arkansas_hazcams),
        ('Florida (ArcGIS)', fetch_fl_arcgis),
        ('Georgia DOT (DataTables)', lambda: fetch_511_datatables(
            'https://511ga.org', 'Georgia', 'https://511ga.org/cctv')),
        ('Virginia (VDOT 511)', fetch_va_511),
        ('North Carolina (DriveNC)', lambda: fetch_511_mapicons('https://drivenc.gov', 'North Carolina')),
        ('Oregon (ODOT TripCheck)', fetch_or_tripcheck),
        ('Rhode Island (RIDOT)', fetch_ri_ridot),
        ('North Dakota (NDDOT)', fetch_nd_dot),
        ('Kansas (KanDrive)', lambda: fetch_cars_graphql(
            'https://www.kandrive.gov', 'Kansas',
            {'north': 40.1, 'south': 36.9, 'east': -94.5, 'west': -102.1},
            'https://www.kandrive.gov/')),
        ('Nebraska (511 Nebraska)', lambda: fetch_cars_graphql(
            'https://511.nebraska.gov', 'Nebraska',
            {'north': 43.1, 'south': 39.9, 'east': -95.2, 'west': -104.2},
            'https://www.511.nebraska.gov/')),
        ('Mississippi (MDOT Traffic)', fetch_ms_mdot),
        ('Alaska (511)', fetch_alaska),
        ('Arizona (AZ511)', fetch_az511),
        ('Wyoming NPS verified', fetch_wyoming_nps_verified),
        ('NPS Webcams', fetch_nps),
    ])
    return providers


EXPLICIT_PROVIDER_FAMILIES = {
    "Florida (FL511)": "traveler-mapicons",
    "Louisiana (LA511)": "traveler-mapicons",
    "Pennsylvania (PA511)": "traveler-mapicons",
    "Wisconsin (WI511)": "traveler-mapicons",
    "Nevada (NV511)": "traveler-mapicons",
    "Connecticut (CT511)": "traveler-mapicons",
    "Idaho (ID511)": "traveler-mapicons",
    "North Carolina (DriveNC)": "traveler-mapicons",
    "New England 511 (ME/NH/VT)": "traveler-datatables",
    "Georgia DOT (DataTables)": "traveler-datatables",
    "Montana (Iteris)": "geospatial-iteris",
    "South Dakota (Iteris)": "geospatial-iteris",
    "South Carolina (SkyVDN)": "geospatial-stream",
    "Kansas (KanDrive)": "traveler-cars-graphql",
    "Nebraska (511 Nebraska)": "traveler-cars-graphql",
}


def provider_family(name: str, collector: Callable[[], int]) -> str:
    """Return the explicit protocol family, then classify one-off adapters."""
    if name in EXPLICIT_PROVIDER_FAMILIES:
        return EXPLICIT_PROVIDER_FAMILIES[name]
    function_name = getattr(collector, '__name__', '').casefold()
    provider_name = name.casefold()
    if 'baseline' in provider_name:
        return 'baseline-file'
    if '511_mapicons' in function_name or 'cars_graphql' in function_name:
        return 'traveler-api'
    if 'iteris_geojson' in function_name or 'arcgis' in function_name:
        return 'geospatial-api'
    if 'verified' in function_name or 'nps' in provider_name or 'usgs' in provider_name:
        return 'verified-curated'
    if any(token in provider_name for token in ('ipcamlive', 'angelcam', 'hazcams', 'weathercams')):
        return 'hosted-camera'
    return 'first-party-feed'


def provider_adapters(fetchers=None) -> ProviderRegistry:
    fetchers = provider_fetchers() if fetchers is None else fetchers
    return ProviderRegistry([
        FunctionProviderAdapter(name, provider_family(name, collector), collector)
        for name, collector in fetchers
    ])


def merge_provider_results(
        existing: list[dict],
        results: list[ProviderResult],
        retention_ratio: float = PROVIDER_RETENTION_RATIO,
        id_allocator=None,
        evaluation=None) -> list[dict]:
    accepted_results, rejected_snapshots = evaluation or evaluate_provider_results(
        existing, results, retention_ratio
    )
    for name, detail in rejected_snapshots.items():
        if detail is not None:
            stats[name] = (
                f'ERROR: incomplete snapshot ({detail[0]} < {detail[1]}); '
                'retaining last-known-good rows'
            )

    successful = {result.name for result in accepted_results}
    degraded_providers = {result.name for result in results if result.name not in successful}
    fresh_by_provider = {result.name: result.cameras for result in accepted_results}
    old_by_provider_identity = {}
    old_by_feed_identity = {}
    old_by_source_page = {}
    old_by_url = {}
    for camera in existing:
        durable_identity = provider_identity(camera)
        if durable_identity is not None:
            old_by_provider_identity.setdefault(durable_identity, []).append(camera)
        old_by_feed_identity.setdefault(feed_identity(camera), []).append(camera)
        if camera.get('source_url'):
            old_by_source_page.setdefault(camera['source_url'], []).append(camera)
        if camera.get('url'):
            old_by_url.setdefault(camera['url'], []).append(camera)

    replacement_source_pages = set()
    replacement_feed_urls = set()
    claimed_ids = set()
    for result in accepted_results:
        for camera in result.cameras:
            candidates = []
            if camera.pop('_replace_source_page', False) and camera.get('source_url'):
                replacement_source_pages.add(camera['source_url'])
                candidates.extend(old_by_source_page.get(camera['source_url'], []))
            for url in camera.pop('_replace_feed_urls', []):
                if url:
                    replacement_feed_urls.add(url)
                    candidates.extend(old_by_url.get(url, []))
            durable_identity = provider_identity(camera)
            if durable_identity is not None:
                candidates.extend(old_by_provider_identity.get(durable_identity, []))
            candidates.extend(old_by_feed_identity.get(feed_identity(camera), []))
            candidate_ids = {candidate['id'] for candidate in candidates}
            if len(candidate_ids) > 1:
                raise CameraDataError(
                    f"ambiguous stable identity for {camera.get('name')!r}: {sorted(candidate_ids)}"
                )
            if candidate_ids:
                camera_id = candidate_ids.pop()
                if camera_id in claimed_ids:
                    raise CameraDataError(f"camera ID {camera_id} was claimed by multiple refreshed feeds")
                camera['id'] = camera_id
                claimed_ids.add(camera_id)
            else:
                camera.pop('id', None)
    inserted_providers = set()
    ordered = []
    for camera in existing:
        if (
            camera.get('source_url') in replacement_source_pages
            or camera.get('url') in replacement_feed_urls
        ):
            continue
        provider = camera.get('ingestion_source') or camera.get('provider')
        if provider in successful:
            if provider not in inserted_providers:
                ordered.extend(fresh_by_provider[provider])
                inserted_providers.add(provider)
            continue
        if provider in degraded_providers and camera.get('health') != 'offline':
            camera['health'] = 'degraded'
            camera['failure_class'] = 'provider_error'
        ordered.append(camera)
    for result in accepted_results:
        if result.name not in inserted_providers:
            ordered.extend(result.cameras)
            inserted_providers.add(result.name)
    merged = []
    seen = set()
    for camera in ordered:
        identity = feed_identity(camera)
        if identity in seen:
            continue
        seen.add(identity)
        merged.append(camera)
    new_cameras = [camera for camera in merged if 'id' not in camera]
    if new_cameras:
        allocator = id_allocator or (
            lambda count: range(
                max((int(camera.get('id') or 0) for camera in existing), default=0) + 1,
                max((int(camera.get('id') or 0) for camera in existing), default=0) + count + 1,
            )
        )
        reserved_ids = list(allocator(len(new_cameras)))
        if len(reserved_ids) != len(new_cameras):
            raise CameraDataError('camera ID allocator returned the wrong number of IDs')
        for camera, camera_id in zip(new_cameras, reserved_ids):
            camera['id'] = camera_id
    return sorted(merged, key=lambda camera: camera['id'])


def evaluate_provider_results(
        existing: list[dict],
        results: list[ProviderResult],
        retention_ratio: float = PROVIDER_RETENTION_RATIO):
    accepted_results = []
    rejected_snapshots = {}
    for result in results:
        if not result.succeeded:
            rejected_snapshots[result.name] = None
            continue
        previous_count = sum(
            1 for camera in existing
            if (camera.get('ingestion_source') or camera.get('provider')) == result.name
        )
        minimum_count = int(previous_count * retention_ratio + 0.999999)
        if previous_count and len(result.cameras) < minimum_count:
            rejected_snapshots[result.name] = (len(result.cameras), minimum_count)
            continue
        accepted_results.append(result)
    return accepted_results, rejected_snapshots


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rollback', action='store_true', help='restore the last-known-good camera dataset')
    parser.add_argument(
        '--provider', action='append', default=[],
        help='fetch only the named provider; may be repeated',
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.rollback:
        summary = restore_camera_data(OUTPUT)
        print(f'Restored schema v{summary.schema_version} dataset with {summary.total} cameras')
        return 0

    selected_adapters = provider_adapters().select(args.provider)
    attempted_at = utc_now_iso()
    previous_health = load_source_health(SOURCE_HEALTH_OUTPUT)

    print('StormScope Camera Data Fetcher')
    print('=' * 50)
    results = [adapter.fetch(run_fetcher) for adapter in selected_adapters]
    if not any(result.succeeded for result in results):
        current = load_camera_data(OUTPUT)
        health = update_source_health(
            previous_health, current, current, results, selected_adapters,
            set(), attempted_at,
        )
        write_source_health(SOURCE_HEALTH_OUTPUT, health)
        raise RuntimeError('all providers failed; dataset was not changed')

    previous_cameras = []
    accepted_names = set()

    def commit(current):
        previous_cameras.extend(dict(camera) for camera in current)
        evaluation = evaluate_provider_results(current, results)
        accepted_names.update(result.name for result in evaluation[0])
        merged = merge_provider_results(
            current,
            results,
            id_allocator=lambda count: reserve_camera_ids(
                OUTPUT.with_name('camera-id-sequence.json'), current, count
            ),
            evaluation=evaluation,
        )
        source_counts = {}
        for camera in current:
            source = camera['source']
            source_counts[source] = source_counts.get(source, 0) + 1
        minimum_sources = {
            source: count
            if source in {'earthcam', 'ipcamlive', 'livebeaches', 'youtube'}
            else int(count * 0.9)
            for source, count in source_counts.items()
        }
        validate_camera_data(
            merged,
            minimum_total=int(len(current) * 0.9),
            minimum_source_counts=minimum_sources,
        )
        current[:] = merged
        return merged

    merged, summary = update_camera_data(OUTPUT, commit)
    health = update_source_health(
        previous_health, previous_cameras, merged, results, selected_adapters,
        accepted_names, attempted_at,
    )
    write_source_health(SOURCE_HEALTH_OUTPUT, health)

    print(f'\nWrote {summary.total} schema v{summary.schema_version} cameras to {OUTPUT}')
    print(f'File size: {OUTPUT.stat().st_size / 1024:.0f} KB')

    # Summary by state
    print('\n' + '=' * 50)
    print('Summary by state:')
    state_counts = {}
    for cam in merged:
        s = cam.get('state', 'Unknown')
        state_counts[s] = state_counts.get(s, 0) + 1
    for s in sorted(state_counts.keys()):
        print(f'  {s}: {state_counts[s]}')
    print(f'\n  TOTAL: {len(merged)} cameras across {len(state_counts)} states')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
