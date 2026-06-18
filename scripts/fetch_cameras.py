"""
StormScope camera data fetcher.
Pulls cameras from multiple US state DOT APIs and merges into data/cameras.json.

Usage: python scripts/fetch_cameras.py
"""
import json
import gzip
import re
import ssl
import sys
import os
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ctx = ssl.create_default_context()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / 'data'
OUTPUT = DATA_DIR / 'cameras.json'

cameras = []
cam_id = 0
stats = {}


def next_id():
    global cam_id
    cam_id += 1
    return cam_id


def add_camera(name, lat, lon, url, cam_type='image', state='', county='',
               direction='', source='dot'):
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
    name = re.sub(r'<[^>]+>', '', str(name)).strip() or f'Camera {next_id()}'
    cameras.append({
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
    })


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


# ── Caltrans (California) ──
def fetch_caltrans():
    count = 0
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
            video = item.get('expando', {}).get('videoEnabled', False)
            add_camera(name, lat, lon, img_url, 'image', state_name, '', '', 'dot')
            count += 1
        return count
    except Exception as e:
        print(f'  {state_name} 511: {e}')
        return 0


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
            start += page_size
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
        data = fetch_json(url, headers={'User-Agent': 'StormScope/1.0'})
        count = 0
        for cam in data.get('data', []):
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
        data = fetch_json('https://tmc.deldot.gov/json/videocamera.json')
        count = 0
        items = data if isinstance(data, list) else data.get('videocameras', [])
        for cam in items:
            if not cam.get('enabled'):
                continue
            lat = cam.get('lat')
            lon = cam.get('lon')
            name = cam.get('title', 'DE Camera')
            urls = cam.get('urls', {})
            img_url = urls.get('m3u8s', '') or urls.get('m3u8', '') or urls.get('rtmp', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Delaware', cam.get('county', ''), '', 'dot')
            count += 1
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


# ── Maryland CHART ──
def fetch_maryland_chart():
    try:
        data = fetch_json('https://chart.maryland.gov/DataFeeds/GetCamerasJson', timeout=20)
        count = 0
        items = data if isinstance(data, list) else data.get('cameras', [])
        for cam in items:
            lat = cam.get('lat') or cam.get('latitude')
            lon = cam.get('lon') or cam.get('longitude')
            name = cam.get('description', '') or cam.get('name', 'MD Camera')
            img_url = cam.get('imageUrl', '') or cam.get('url', '')
            if not img_url:
                continue
            add_camera(name, lat, lon, img_url, detect_type(img_url),
                       'Maryland', '', '', 'dot')
            count += 1
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
    print(f'Fetching {name}...')
    try:
        count = func()
        stats[name] = count
        print(f'  {name}: {count} cameras')
    except Exception as e:
        stats[name] = f'ERROR: {e}'
        print(f'  {name}: ERROR - {e}')


def main():
    print('StormScope Camera Data Fetcher')
    print('=' * 50)

    # Load OpenTrafficCamMap baseline (AL, AK, AZ, DE, IN, KY, OH - states not covered by live APIs)
    # CA, CO, GA are covered by live fetchers; skip duplicates
    otcm_file = DATA_DIR / 'otcm_baseline.json'
    if otcm_file.exists():
        run_fetcher('OpenTrafficCamMap baseline', lambda: load_otcm_baseline(otcm_file))

    # Fetch from live APIs
    run_fetcher('Caltrans (California)', fetch_caltrans)
    run_fetcher('Florida (FL511)', lambda: fetch_511_mapicons('https://fl511.com', 'Florida'))
    run_fetcher('NYC DOT', fetch_nycdot)
    run_fetcher('WSDOT (Washington)', fetch_wsdot)
    run_fetcher('Illinois DOT', fetch_illinois)
    run_fetcher('Michigan DOT', fetch_michigan)
    run_fetcher('Colorado DOT (live)', fetch_colorado)
    run_fetcher('Austin TX', fetch_austin_tx)
    run_fetcher('TxDOT (statewide)', fetch_txdot)
    run_fetcher('Louisiana (LA511)', lambda: fetch_511_mapicons('https://www.511la.org', 'Louisiana'))
    run_fetcher('Pennsylvania (PA511)', lambda: fetch_511_mapicons('https://511pa.com', 'Pennsylvania'))
    run_fetcher('Wisconsin (WI511)', lambda: fetch_511_mapicons('https://511wi.gov', 'Wisconsin'))
    run_fetcher('Utah DOT', fetch_utah)
    run_fetcher('Nevada (NV511)', lambda: fetch_511_mapicons('https://nvroads.com', 'Nevada'))
    run_fetcher('New Hampshire (NE511)', lambda: fetch_511_mapicons('https://www.newengland511.org', 'New Hampshire'))
    run_fetcher('Connecticut (CT511)', lambda: fetch_511_mapicons('https://www.ctroads.org', 'Connecticut'))
    run_fetcher('Idaho (ID511)', lambda: fetch_511_mapicons('https://511.idaho.gov', 'Idaho'))
    run_fetcher('South Carolina (Iteris)', lambda: fetch_iteris_geojson('SC', 'South Carolina'))
    run_fetcher('Montana (Iteris)', lambda: fetch_iteris_geojson('MT', 'Montana'))
    run_fetcher('South Dakota (Iteris)', lambda: fetch_iteris_geojson('SD', 'South Dakota'))
    run_fetcher('Missouri DOT', fetch_missouri)
    run_fetcher('Delaware (live HLS)', fetch_delaware_live)
    run_fetcher('New Mexico DOT', fetch_newmexico)
    run_fetcher('Minnesota (IRIS)', fetch_mn_iris)
    run_fetcher('Iowa (IRIS)', fetch_ia_iris)
    run_fetcher('Wyoming DOT', fetch_wyoming)
    run_fetcher('Maryland (CHART)', fetch_maryland_chart)
    run_fetcher('Florida (ArcGIS)', fetch_fl_arcgis)
    run_fetcher('Georgia DOT (DataTables)', lambda: fetch_511_datatables(
        'https://511ga.org', 'Georgia', 'https://511ga.org/cctv'))
    run_fetcher('NPS Webcams', fetch_nps)

    # Deduplicate by lat/lon proximity
    print(f'\nTotal before dedup: {len(cameras)}')
    seen = set()
    unique = []
    for cam in cameras:
        key = (round(cam['lat'], 4), round(cam['lon'], 4))
        if key not in seen:
            seen.add(key)
            unique.append(cam)

    # Re-assign IDs
    for i, cam in enumerate(unique):
        cam['id'] = i + 1

    print(f'Total after dedup: {len(unique)}')

    # Write output
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(unique, f, ensure_ascii=True)

    print(f'\nWrote {len(unique)} cameras to {OUTPUT}')
    print(f'File size: {OUTPUT.stat().st_size / 1024:.0f} KB')

    # Summary by state
    print('\n' + '=' * 50)
    print('Summary by state:')
    state_counts = {}
    for cam in unique:
        s = cam.get('state', 'Unknown')
        state_counts[s] = state_counts.get(s, 0) + 1
    for s in sorted(state_counts.keys()):
        print(f'  {s}: {state_counts[s]}')
    print(f'\n  TOTAL: {len(unique)} cameras across {len(state_counts)} states')


if __name__ == '__main__':
    main()
