"""
StormScope camera data fetcher.
Pulls cameras from multiple US state DOT APIs and merges into data/cameras.json.

Usage: python scripts/fetch_cameras.py
"""
import argparse
import concurrent.futures
import hashlib
import json
import gzip
import html
import re
import ssl
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from dataclasses import dataclass
from typing import Callable

try:
    from camera_data import (
        atomic_write_json,
        canonical_source_url,
        feed_identity,
        healthy_metadata,
        restore_camera_data,
        unknown_metadata,
        update_camera_data,
        utc_now_iso,
        validate_camera_data,
    )
except ModuleNotFoundError:  # pragma: no cover - package import during tests
    from scripts.camera_data import (
        atomic_write_json,
        canonical_source_url,
        feed_identity,
        healthy_metadata,
        restore_camera_data,
        unknown_metadata,
        update_camera_data,
        utc_now_iso,
        validate_camera_data,
    )

sys.stdout.reconfigure(encoding='utf-8')
ctx = ssl.create_default_context()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / 'data'
OUTPUT = DATA_DIR / 'cameras.json'

cameras = []
cam_id = 0
stats = {}
active_provider = ''
PROVIDER_RETENTION_RATIO = 0.9


class IncompleteProviderError(RuntimeError):
    """Raised when a multi-request provider returns only a partial snapshot."""


@dataclass(frozen=True)
class ProviderResult:
    name: str
    cameras: list[dict]
    error: str = ''

    @property
    def succeeded(self):
        return not self.error and bool(self.cameras)


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
    try:
        url = f'{base_url}/map/mapIcons/Cameras'
        data = fetch_json(url)
        items = data.get('item2', data) if isinstance(data, dict) else data
        if not isinstance(items, list):
            return 0
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            lat, lon = loc[0], loc[1]
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'{state_name} Camera {item_id}'
            img_url = f'{base_url}/map/Cctv/{item_id}'
            add_camera(name, lat, lon, img_url, 'image', state_name, '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  {state_name} 511: {e}')
        return 0


# ── New England 511 (ME/NH/VT) — DataTables feed with correct per-state labels ──
def fetch_newengland511():
    base = 'https://www.newengland511.org'
    all_rows = []
    start = 0
    while True:
        raw = _http_bytes(
            base + '/List/GetData/Cameras',
            headers={'Accept': 'application/json',
                     'Content-Type': 'application/x-www-form-urlencoded',
                     'X-Requested-With': 'XMLHttpRequest',
                     'Referer': base + '/cctv', 'Origin': base},
            data=f'draw=1&start={start}&length=100&search[value]='.encode('ascii'),
            method='POST', timeout=30)
        payload = json.loads(raw)
        rows = payload.get('data', [])
        all_rows.extend(rows)
        total = payload.get('recordsTotal', 0)
        start += 100
        if not rows or start >= total:
            break
    count = 0
    for row in all_rows:
        state_name = row.get('state', '') or ''
        if state_name not in {'Maine', 'New Hampshire', 'Vermont'}:
            continue
        images = row.get('images') or []
        image_id = None
        for img in images:
            if not img.get('disabled') and not img.get('blocked') and img.get('imageUrl'):
                image_id = img['imageUrl']
                break
        if not image_id:
            continue
        img_url = base + image_id if image_id.startswith('/') else image_id
        wkt = ''
        try:
            wkt = row.get('latLng', {}).get('geography', {}).get('wellKnownText', '')
        except (AttributeError, TypeError):
            continue
        match = re.search(r'POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)', wkt)
        if not match:
            continue
        lon, lat = float(match.group(1)), float(match.group(2))
        name = row.get('location', '') or row.get('roadway', '') or f'{state_name} Camera'
        add_camera(name, lat, lon, img_url, 'image', state_name,
                   row.get('county', '') or '', row.get('direction', '') or '', 'dot',
                   base + '/cctv', 10)
        count += 1
    return count


# ── 511 DataTables (Georgia, Florida detail) ──
def fetch_511_datatables(base_url, state_name, referer=None):
    try:
        url = f'{base_url}/List/GetData/Cameras'
        hdrs = {}
        if referer:
            hdrs['Referer'] = referer
            hdrs['Origin'] = base_url
        all_rows = []
        start = 0
        page_size = 500
        while True:
            body = {'draw': start // page_size + 1, 'start': start, 'length': page_size}
            data = post_json(url, body, hdrs)
            rows = data.get('data', [])
            if not rows:
                break
            all_rows.extend(rows)
            total = data.get('recordsTotal', 0)
            start += len(rows)
            if start >= total:
                break
        count = 0
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
            name = row.get('location', '') or row.get('roadway', '') or f'{state_name} Camera'
            images = row.get('images', [])
            img_url = ''
            for img in images:
                if not img.get('blocked'):
                    raw_url = img.get('imageUrl', '')
                    if raw_url:
                        if raw_url.startswith('/'):
                            img_url = base_url + raw_url
                        else:
                            img_url = raw_url
                        break
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       state_name, '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  {state_name} DataTables: {e}')
        return 0


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
        data = fetch_json(url, headers={'User-Agent': 'StormScope/0.35.0'})
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


# ── Minnesota DOT ──
def fetch_mndot():
    try:
        url = ('https://511mn.org/map/mapIcons/Cameras')
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'MN Camera {item_id}'
            img_url = f'https://511mn.org/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Minnesota', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  MnDOT: {e}')
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


# ── New Jersey DOT ──
def fetch_njdot():
    try:
        url = 'https://511nj.org/map/mapIcons/Cameras'
        data = fetch_json(url)
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'NJ Camera {item_id}'
            img_url = f'https://511nj.org/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'New Jersey', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  NJ DOT: {e}')
        return 0


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
def fetch_tndot():
    try:
        url = 'https://smartway.tn.gov/map/mapIcons/Cameras'
        data = fetch_json(url, headers={'Accept': '*/*'})
        items = data.get('item2', []) if isinstance(data, dict) else data
        count = 0
        for item in items:
            loc = item.get('location', [0, 0])
            if not isinstance(loc, list) or len(loc) < 2:
                continue
            item_id = item.get('itemId', '')
            name = item.get('title', '') or f'TN Camera {item_id}'
            img_url = f'https://smartway.tn.gov/map/Cctv/{item_id}'
            add_camera(name, loc[0], loc[1], img_url, 'image', 'Tennessee', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  TN DOT: {e}')
        return 0


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
    try:
        url = f'https://{state_code.lower()}.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson'
        data = fetch_json(url, timeout=20)
        count = 0
        for feat in data.get('features', []):
            geom = feat.get('geometry', {})
            coords = geom.get('coordinates', [0, 0])
            props = feat.get('properties', {})
            desc = props.get('description', '')
            cam_list = props.get('cameras', [])
            if cam_list:
                for c in cam_list:
                    name = c.get('description', '') or c.get('name', '') or desc
                    img_url = c.get('image', '') or c.get('https_url', '') or c.get('image_url', '')
                    if not img_url:
                        continue
                    add_camera(name, coords[1], coords[0], img_url, detect_type(img_url),
                               state_name, '', c.get('direction', ''), 'dot')
                    count += 1
            else:
                img_url = props.get('image', '') or props.get('url', '')
                if img_url:
                    add_camera(desc or f'{state_name} Camera', coords[1], coords[0],
                               img_url, detect_type(img_url), state_name, '', '', 'dot')
                    count += 1
        return count
    except Exception as e:
        print(f'  {state_name} Iteris: {e}')
        return 0


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


# ── New Mexico DOT ──
def fetch_newmexico():
    try:
        data = fetch_json('https://servicev4.nmroads.com/RealMapWAR/GetCameraInfo', timeout=20)
        count = 0
        items = data if isinstance(data, list) else [data]
        for cam in items:
            if not cam.get('enabled'):
                continue
            lat = cam.get('lat')
            lon = cam.get('lon')
            name = cam.get('name', '') or cam.get('title', 'NM Camera')
            img_url = cam.get('snapshotFile', '')
            if img_url and not img_url.startswith('http'):
                img_url = f'https://ss.nmroads.com/{img_url}'
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, 'image', 'New Mexico', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  New Mexico: {e}')
        return 0


# ── Minnesota (IRIS) ──
def fetch_mn_iris():
    try:
        data = fetch_json('https://tr.511mn.org/tgcameras/api/cameras', timeout=20)
        count = 0
        for cam in data:
            lat = cam.get('latitude') or cam.get('lat')
            lon = cam.get('longitude') or cam.get('lon')
            name = cam.get('name', '') or cam.get('description', 'MN Camera')
            img_url = cam.get('imageUrl', '') or cam.get('url', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Minnesota', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  MN IRIS: {e}')
        return 0


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
    try:
        data = fetch_json('https://map.wyoroad.info/wtimap/data/wtimap-webcameras.json', timeout=20)
        count = 0
        items = data if isinstance(data, list) else data.get('features', [])
        for feat in items:
            props = feat.get('properties', feat)
            geom = feat.get('geometry', {})
            coords = geom.get('coordinates', [0, 0])
            name = props.get('name', '') or props.get('CAMERATITLE', 'WY Camera')
            markup = props.get('IMAGEMARKUP', '')
            m = re.search(r'src="([^"]+)"', markup) if markup else None
            img_url = m.group(1) if m else (props.get('imageUrl', '') or props.get('url', ''))
            if not img_url:
                continue
            lat = coords[1] if len(coords) >= 2 else props.get('lat')
            lon = coords[0] if len(coords) >= 2 else props.get('lon')
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Wyoming', '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  Wyoming: {e}')
        return 0


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


# ── CARS / OneNetwork 511 GraphQL (Kansas, Nebraska) ──
CARS_MAP_QUERY = (
    'query MapFeatures($input: MapFeaturesArgs!){mapFeaturesQuery(input:$input)'
    '{mapFeatures{__typename uri title features{id geometry properties type}'
    ' ... on Camera{active views(limit:3){uri category ... on CameraView{url}}}}'
    ' error{message type}}}'
)


def fetch_cars_graphql(base_url, state_name, bbox, source_page):
    try:
        body = json.dumps({
            'query': CARS_MAP_QUERY,
            'variables': {'input': {**bbox, 'zoom': 11, 'layerSlugs': ['normalCameras']}},
        }).encode('utf-8')
        payload = json.loads(_http_bytes(
            base_url + '/api/graphql',
            headers={'Accept': 'application/json', 'Content-Type': 'application/json',
                     'Origin': base_url, 'Referer': base_url + '/'},
            data=body, method='POST', timeout=40))
        result = (payload.get('data') or {}).get('mapFeaturesQuery') or {}
        feats = result.get('mapFeatures') or []
        count = 0
        seen = set()
        for marker in feats:
            if marker.get('__typename') != 'Camera' or not marker.get('active'):
                continue
            uri = marker.get('uri')
            if uri in seen:
                continue
            views = marker.get('views') or []
            img_url = str(views[0].get('url')) if views and views[0] else ''
            img_url = img_url.split('?', 1)[0]
            if not img_url.startswith('https://'):
                continue
            geom = ((marker.get('features') or [{}])[0].get('geometry') or {})
            coords = geom.get('coordinates') or [0, 0]
            if not isinstance(coords, list) or len(coords) < 2:
                continue
            seen.add(uri)
            name = str(marker.get('title', '') or f'{state_name} Camera').strip()
            add_camera(name, coords[1], coords[0], img_url, 'image', state_name,
                       '', '', 'dot', source_page, 60)
            count += 1
        return count
    except Exception as e:
        print(f'  {state_name} CARS GraphQL: {e}')
        return 0


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
        ('New England 511 (ME/NH/VT)', fetch_newengland511),
        ('Connecticut (CT511)', lambda: fetch_511_mapicons('https://www.ctroads.org', 'Connecticut')),
        ('Idaho (ID511)', lambda: fetch_511_mapicons('https://511.idaho.gov', 'Idaho')),
        ('South Carolina (SkyVDN)', lambda: fetch_skyvdn_hls(
            'SC', 'South Carolina', 'https://www.511sc.org/', 'scdot_skyvdn_discovery_report.json')),
        ('Montana (Iteris)', lambda: fetch_iteris_geojson('MT', 'Montana')),
        ('South Dakota (Iteris)', lambda: fetch_iteris_geojson('SD', 'South Dakota')),
        ('Missouri DOT', fetch_missouri),
        ('Delaware (live HLS)', fetch_delaware_live),
        ('New Mexico DOT', fetch_newmexico),
        ('Minnesota (IRIS)', fetch_mn_iris),
        ('Iowa DOT', fetch_iowa_dot),
        ('Wyoming DOT', fetch_wyoming),
        ('Maryland (CHART)', fetch_maryland_chart),
        ('West Virginia (WV511)', fetch_wv511),
        ('Puerto Rico (ACT/ITS)', fetch_pr_act),
        ('Guam (GNTF/IPCamLive)', fetch_guam_gntf),
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
        ('NPS Webcams', fetch_nps),
    ])
    return providers


def merge_provider_results(
        existing: list[dict],
        results: list[ProviderResult],
        retention_ratio: float = PROVIDER_RETENTION_RATIO) -> list[dict]:
    accepted_results = []
    for result in results:
        if not result.succeeded:
            continue
        previous_count = sum(1 for camera in existing if camera.get('provider') == result.name)
        minimum_count = int(previous_count * retention_ratio + 0.999999)
        if previous_count and len(result.cameras) < minimum_count:
            stats[result.name] = (
                f'ERROR: incomplete snapshot ({len(result.cameras)} < {minimum_count}); '
                'retaining last-known-good rows'
            )
            continue
        accepted_results.append(result)
    successful = {result.name for result in accepted_results}
    degraded_providers = {
        result.name for result in results
        if result.name not in successful
    }
    fresh_by_provider = {result.name: result.cameras for result in accepted_results}
    inserted_providers = set()
    ordered = []
    for camera in existing:
        provider = camera.get('provider')
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
    for index, camera in enumerate(merged, 1):
        camera['id'] = index
    return merged


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

    selected_fetchers = provider_fetchers()
    if args.provider:
        available_fetchers = selected_fetchers
        selected_fetchers = []
        missing = []
        for requested_name in args.provider:
            matches = [
                item for item in available_fetchers
                if requested_name.casefold() in item[0].casefold()
            ]
            if len(matches) == 1:
                if matches[0] not in selected_fetchers:
                    selected_fetchers.append(matches[0])
            else:
                missing.append(requested_name.casefold())
        if missing:
            raise ValueError(f"unknown or ambiguous provider(s): {', '.join(sorted(missing))}")

    print('StormScope Camera Data Fetcher')
    print('=' * 50)
    results = [run_fetcher(name, fetcher) for name, fetcher in selected_fetchers]
    if not any(result.succeeded for result in results):
        raise RuntimeError('all providers failed; dataset was not changed')

    def commit(current):
        merged = merge_provider_results(current, results)
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
