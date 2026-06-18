"""Update YouTube live cam dataset with verified-live streams."""
import json
import os

youtube_cams = [
    # FLORIDA
    {"name": "Hollywood Beach Broadwalk, FL", "lat": 26.0112, "lon": -80.1187, "url": "cmkAbDUEoyA", "state": "Florida", "county": "Broward County"},
    {"name": "Port Miami Webcam + VHF Radio (PTZtv)", "lat": 25.7743, "lon": -80.1640, "url": "DxZziUUr6CY", "state": "Florida", "county": "Miami-Dade County"},
    {"name": "Miami Biscayne Bay North Waterfront 24/7", "lat": 25.7907, "lon": -80.1300, "url": "5YCajRjvWCg", "state": "Florida", "county": "Miami-Dade County"},
    {"name": "Siesta Key Beach, FL - LIVE", "lat": 27.2678, "lon": -82.5541, "url": "NLhxcyzXQxM", "state": "Florida", "county": "Sarasota County"},
    {"name": "Clearwater Beach, FL - Frenchy's Cam", "lat": 27.9778, "lon": -82.8267, "url": "rxBBRLWF0mM", "state": "Florida", "county": "Pinellas County"},
    {"name": "St. Augustine - St. George Street 24/7", "lat": 29.8946, "lon": -81.3131, "url": "ZksWoEAhmTU", "state": "Florida", "county": "St. Johns County"},
    {"name": "Everglades, FL - Wildfire Cam (EarthCam)", "lat": 25.7617, "lon": -80.9479, "url": "cUOxrEr9hho", "state": "Florida", "county": "Collier County"},

    # NEW YORK
    {"name": "NYC Live Cam - Times Square, Skyline 24/7", "lat": 40.7580, "lon": -73.9855, "url": "VGnFLdQW39A", "state": "New York", "county": "New York City"},
    {"name": "EarthCam Live: Times Square Crossroads", "lat": 40.7565, "lon": -73.9869, "url": "z-jYdOIKcTQ", "state": "New York", "county": "New York City"},
    {"name": "EarthCam Live: Coney Island", "lat": 40.5749, "lon": -73.9859, "url": "H67j7H-7QD0", "state": "New York", "county": "Brooklyn"},
    {"name": "Peace Bridge - US/Canada Border 24/7", "lat": 42.9069, "lon": -78.9042, "url": "9En2186vo5g", "state": "New York", "county": "Erie County"},
    {"name": "FOX Weather - Live 24/7 National Weather", "lat": 40.7536, "lon": -73.9772, "url": "wt6SIE7BXS8", "state": "New York", "county": "New York City"},

    # CALIFORNIA
    {"name": "Venice Beach - Venice V Hotel Cam", "lat": 33.9885, "lon": -118.4726, "url": "EO_1LWqsCNE", "state": "California", "county": "Los Angeles"},
    {"name": "Venice Beach North Boardwalk 24/7", "lat": 33.9920, "lon": -118.4750, "url": "98jOtUeM3m8", "state": "California", "county": "Los Angeles"},
    {"name": "SF-Oakland Bay Bridge 24/7", "lat": 37.7983, "lon": -122.3778, "url": "CXYr04BWvmc", "state": "California", "county": "San Francisco"},
    {"name": "San Diego Live Webcam (Rotating) 4K", "lat": 32.7157, "lon": -117.1611, "url": "edz0ux7JClE", "state": "California", "county": "San Diego"},
    {"name": "LAX Airport Runways 24L & 24R 24/7", "lat": 33.9416, "lon": -118.4085, "url": "12KqO5IBLeY", "state": "California", "county": "Los Angeles"},
    {"name": "Surfline TV - LIVE Surf Cams 24/7", "lat": 33.4275, "lon": -117.6117, "url": "hm9iAviOZ20", "state": "California", "county": "San Clemente"},
    {"name": "Big Bear Bald Eagle Nest - Cam 1", "lat": 34.2439, "lon": -116.9114, "url": "B4-L2nfGcuE", "state": "California", "county": "San Bernardino"},

    # TEXAS
    {"name": "Houston ABC13 Tower Cam 24/7", "lat": 29.7399, "lon": -95.4148, "url": "SDK_m1_BVJ4", "state": "Texas", "county": "Harris County"},
    {"name": "Houston Downtown Skyline 24/7", "lat": 29.7604, "lon": -95.3698, "url": "wUQc3RoLAPs", "state": "Texas", "county": "Harris County"},

    # ILLINOIS
    {"name": "Chicago Midway Airport (StreamTime 4K)", "lat": 41.7868, "lon": -87.7522, "url": "67BCsiW-1Io", "state": "Illinois", "county": "Cook County"},
    {"name": "Chicago NW Power House Railcam", "lat": 41.8862, "lon": -87.6418, "url": "6M6rK0ssjYg", "state": "Illinois", "county": "Cook County"},

    # LOUISIANA
    {"name": "EarthCam Live: New Orleans Street View", "lat": 29.9584, "lon": -90.0653, "url": "Ksrleaxxxhw", "state": "Louisiana", "county": "Orleans Parish"},
    {"name": "New Orleans MSY Airport 24/7", "lat": 29.9934, "lon": -90.2580, "url": "MH0_mPt-VXE", "state": "Louisiana", "county": "Jefferson Parish"},

    # NEVADA
    {"name": "Las Vegas Airport 26R & 26L 24/7", "lat": 36.0840, "lon": -115.1537, "url": "_-Qg5jD-PfA", "state": "Nevada", "county": "Clark County"},

    # WYOMING
    {"name": "Jackson Hole Town Square - SeeJH.ai", "lat": 43.4799, "lon": -110.7624, "url": "DoUOrTJbIu4", "state": "Wyoming", "county": "Teton County"},

    # WASHINGTON
    {"name": "Leavenworth, WA - Bavarian Village Cam", "lat": 47.5962, "lon": -120.6615, "url": "TmtVbezZaqg", "state": "Washington", "county": "Chelan County"},

    # MAINE / NEW ENGLAND
    {"name": "New England Summer LIVE - Webcams & Weather", "lat": 43.6591, "lon": -70.2568, "url": "x_ruIH2UmjQ", "state": "Maine", "county": "Portland"},

    # GEORGIA
    {"name": "Waycross, GA - Live Train Cam (PTZ)", "lat": 31.2136, "lon": -82.3540, "url": "bCIIn4c5LrM", "state": "Georgia", "county": "Ware County"},

    # INDIANA
    {"name": "Elkhart, IN - Live Train Cam (PTZ)", "lat": 41.6820, "lon": -85.9767, "url": "YR1PdWaSxgk", "state": "Indiana", "county": "Elkhart County"},

    # IOWA
    {"name": "Fort Madison, IA - Live Train Cam (PTZ)", "lat": 40.6298, "lon": -91.3151, "url": "L6eG4ahJc_Q", "state": "Iowa", "county": "Lee County"},

    # MISSOURI
    {"name": "La Plata, MO - Live Train Cam", "lat": 40.0234, "lon": -92.4913, "url": "X-ir2KfXMX0", "state": "Missouri", "county": "Macon County"},

    # NEBRASKA
    {"name": "North Platte, NE - Golden Spike Tower Railcam", "lat": 41.1190, "lon": -100.7618, "url": "laKzBnfVIsQ", "state": "Nebraska", "county": "Lincoln County"},
    {"name": "Kearney, NE - Live Train Cam", "lat": 40.6993, "lon": -99.0832, "url": "23tmCNeFh7A", "state": "Nebraska", "county": "Buffalo County"},

    # PENNSYLVANIA
    {"name": "Horseshoe Curve, Altoona, PA - Train Cam", "lat": 40.4840, "lon": -78.4500, "url": "ssuM6NJQ2no", "state": "Pennsylvania", "county": "Blair County"},
    {"name": "Kensington Cam 3 - Philadelphia, PA", "lat": 39.9907, "lon": -75.1249, "url": "cWd_niy8Rz8", "state": "Pennsylvania", "county": "Philadelphia"},

    # KENTUCKY
    {"name": "La Grange, KY - Trains in the Street! (PTZ)", "lat": 38.4076, "lon": -85.3788, "url": "9SLt3AT0rXk", "state": "Kentucky", "county": "Oldham County"},

    # VIRGINIA
    {"name": "Ashland, VA - Live Train Cam (PTZ)", "lat": 37.7590, "lon": -77.4789, "url": "_eArnSLGhSo", "state": "Virginia", "county": "Hanover County"},

    # ARIZONA
    {"name": "Flagstaff, AZ - Live Train Cam (PTZ)", "lat": 35.1983, "lon": -111.6513, "url": "7xdHH9KMSVk", "state": "Arizona", "county": "Coconino County"},

    # MONTANA
    {"name": "Essex, MT - Trains at Glacier NP", "lat": 48.2797, "lon": -113.6108, "url": "yoZkbeEbWb4", "state": "Montana", "county": "Flathead County"},

    # WASHINGTON DC
    {"name": "DC Union Station Railcam 24/7 (Amtrak/Acela)", "lat": 38.8973, "lon": -77.0066, "url": "WQivi2ZbvkU", "state": "DC", "county": "Washington DC"},

    # MINNESOTA
    {"name": "Live Rail & Weather - 16 Streams MN & WI", "lat": 44.9478, "lon": -93.1039, "url": "i5IePnt63J4", "state": "Minnesota", "county": "Ramsey County"},

    # NORTH CAROLINA
    {"name": "ABC11 Raleigh-Durham LIVE", "lat": 35.7796, "lon": -78.6382, "url": "ueregi3uBNQ", "state": "North Carolina", "county": "Wake County"},
    {"name": "Live Deer, Bird & Wildlife Cam (NC)", "lat": 35.5951, "lon": -82.5515, "url": "oI8R4_UG3Fs", "state": "North Carolina", "county": "Buncombe County"},

    # HAWAII
    {"name": "Hawaii Humpback Whale Sanctuary, Maui 4K", "lat": 20.7984, "lon": -156.3319, "url": "iWCeBAxRCBo", "state": "Hawaii", "county": "Maui"},

    # INTERNATIONAL
    {"name": "EarthCam Live: Dublin, Ireland", "lat": 53.3498, "lon": -6.2603, "url": "3nyPER2kzqk", "state": "", "county": "Dublin"},
    {"name": "Vancouver LIVE - Cruise Ships 24/7", "lat": 49.2888, "lon": -123.1108, "url": "rxyNjFKwzJA", "state": "", "county": "Vancouver, BC"},
]

main = os.path.expanduser('~/repos/StormScope/data/cameras.json')
with open(main) as f:
    cameras = json.load(f)

cameras = [c for c in cameras if c.get('type') != 'youtube']
print(f'After removing old YouTube: {len(cameras)} DOT/NPS cameras')

max_id = max(c['id'] for c in cameras) if cameras else 0
seen = set((round(c['lat'], 4), round(c['lon'], 4)) for c in cameras)

added = 0
for yt in youtube_cams:
    key = (round(yt['lat'], 4), round(yt['lon'], 4))
    if key not in seen:
        max_id += 1
        cameras.append({
            'id': max_id,
            'name': yt['name'],
            'lat': yt['lat'],
            'lon': yt['lon'],
            'url': yt['url'],
            'type': 'youtube',
            'state': yt['state'],
            'county': yt.get('county', ''),
            'direction': '',
            'source': 'youtube'
        })
        seen.add(key)
        added += 1

with open(main, 'w', encoding='utf-8') as f:
    json.dump(cameras, f, ensure_ascii=True)

yt_count = len([c for c in cameras if c['type'] == 'youtube'])
print(f'Added {added} verified YouTube live cams')
print(f'Total YouTube: {yt_count}')
print(f'Total cameras: {len(cameras)}')
print(f'File size: {os.path.getsize(main) / 1024:.0f} KB')

states = {}
for c in cameras:
    if c['type'] == 'youtube':
        s = c.get('state', 'Other') or 'International'
        states[s] = states.get(s, 0) + 1
print('\nYouTube cams by state/region:')
for s in sorted(states.keys()):
    print(f'  {s}: {states[s]}')
