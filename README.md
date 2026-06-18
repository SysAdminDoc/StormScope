[![Version](https://img.shields.io/badge/version-0.12.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()
[![Cameras](https://img.shields.io/badge/cameras-24%2C399-cyan)]()

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

## Features

- **Live Weather Radar** — Real-time NEXRAD radar via RainViewer (animated, adjustable opacity)
- **24,399 Live Cameras** — Traffic, weather, park, EarthCam, LiveBeaches, and webcam feeds across 48 US states plus international locations
- **520 YouTube Live Streams** — Verified-live 24/7 streams including beaches, airports, railcams, harbors, city skylines, landmarks, indoor/outdoor feeds, wildlife cams, volcano cams, and city-list discoveries (red markers)
- **468 Provider Embed Feeds** — 275 EarthCam Network pages, 189 NPS embed pages, and 4 direct LiveBeaches/Brownrice player embeds
- **Click-to-View** — YouTube embeds, EarthCam pages, HLS video streams, and auto-refreshing image feeds in a modal viewer
- **Current Weather** — NWS hourly forecast data shown alongside each camera feed
- **Dark Theme** — CartoDB dark matter tiles with glassmorphism UI
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Mobile Responsive** — Works on desktop and mobile browsers

## Camera Coverage

24,399 cameras across 48 US states:

| State | Cameras | | State | Cameras |
|-------|--------:|-|-------|--------:|
| Florida | 4,966 | | Ohio | 1,067 |
| California | 3,120 | | Colorado | 1,015 |
| Utah | 2,053 | | New York | 992 |
| Pennsylvania | 1,519 | | Georgia | 848 |
| Washington | 1,358 | | Texas | 845 |
| Michigan | 783 | | Missouri | 571 |
| Nevada | 661 | | Idaho | 459 |
| Alabama | 600 | | Wisconsin | 451 |
| Indiana | 574 | | New Hampshire | 409 |
| Connecticut | 351 | | Louisiana | 338 |
| Illinois | 332 | | Kentucky | 226 |
| Delaware | 295 | | NPS Parks | 189 |
| Arizona | 123 | | Alaska | 107 |

Plus: Montana, South Dakota, the remaining lower-count US states, 54 international country/territory buckets, 189 National Park webcams, 275 EarthCam Network feeds, 4 LiveBeaches direct embeds, and 520 verified-live YouTube streams.

## Quick Start

No build step required. Serve with any static file server:

```bash
# Python
python -m http.server 8000

# Node.js
npx serve .

# VS Code
# Install "Live Server" extension, right-click index.html → Open with Live Server
```

Open `http://localhost:8000` in your browser.

## Tech Stack

- [Leaflet](https://leafletjs.com/) — Interactive map with CartoDB dark tiles
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) — Camera marker clustering
- [RainViewer API](https://www.rainviewer.com/api.html) — Free weather radar tiles (no key)
- [NWS API](https://www.weather.gov/documentation/services-web-api) — Free hourly weather data (no key)
- [HLS.js](https://github.com/video-dev/hls.js/) — HLS video stream playback
- Camera data from 20+ state DOT APIs + [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT) + NPS + EarthCam + LiveBeaches + verified-live YouTube streams

## Data Sources

- **Radar**: RainViewer — global weather radar composites, updated every 10 minutes
- **Cameras**: 20+ state DOT live APIs (Caltrans, FL511, WSDOT, NYCDOT, IDOT, MDOT, CDOT, etc.), OpenTrafficCamMap, NPS, EarthCam, LiveBeaches, and verified-live YouTube streams
- **City discovery list**: U.S. Census Bureau 2025 Gazetteer places file, filtered to legal city records and written as `City, State`
- **Weather**: National Weather Service (NWS) hourly forecast API

## Refreshing Camera Data

Run the data fetcher to pull fresh camera data from all state DOT APIs:

```bash
python scripts/fetch_cameras.py
```

This queries 20+ live APIs and merges 23,000+ DOT/NPS cameras into `data/cameras.json`.

Run the YouTube discovery automation to exhaust live-filtered search queries, verify live streams, and append only fixed-location streams with curated coordinates:

```bash
python scripts/discover_youtube_cameras.py --query-mode exhaustive --max-pages 8 --apply
```

Discovery reports are written to `data/youtube_discovery_report.json`. Curated fixed-location metadata lives in `data/youtube_location_overrides.json`; YouTube entries store the 11-character video ID only.

Known direct YouTube watch URLs can be verified and appended with:

```bash
python scripts/discover_youtube_cameras.py --query-mode custom --video https://www.youtube.com/watch?v=VIDEO_ID --apply
```

Run the EarthCam discovery automation to harvest the public EarthCam network API, verify online `cam_state` feeds, search EarthCam-branded YouTube live results, and append only deduplicated fixed-location records:

```bash
python scripts/discover_earthcam_feeds.py --apply
```

EarthCam provider entries are stored as `type: "embed"` with full page URLs. EarthCam YouTube entries still store only the 11-character video ID.

Run the LiveBeaches discovery automation to harvest category pages, extract direct supported player iframes, verify YouTube embeds, geocode fixed locations, and append deduplicated records:

```bash
python scripts/discover_livebeaches_feeds.py --apply --max-pages-per-category 2
```

LiveBeaches Brownrice player entries are stored as `type: "embed"` with direct player URLs; LiveBeaches YouTube entries store only the 11-character video ID.

Build the full U.S. city search list from the Census Gazetteer:

```bash
python scripts/discover_city_livestreams.py --build-city-list
```

This writes `data/us_cities_2025.txt` and `data/us_cities_2025.json` with 10,230 labels in `City, State` format. Continue the exhaustive YouTube live-search pass over that list with:

```bash
python scripts/discover_city_livestreams.py --apply --resume
```

Use `--limit-cities 200` for bounded batches. The script searches live-filtered YouTube results, verifies each accepted video is currently live, rejects common non-camera and wrong-state matches, stores only the 11-character video ID, and records progress in `data/us_city_livestream_checkpoint.json`. Cities with transient YouTube search errors stay retryable instead of being marked complete.

## Adding More Cameras

Camera data lives in `data/cameras.json`. Each entry:

```json
{
  "id": 1,
  "name": "I-10 McDonald Rd",
  "lat": 30.53555,
  "lon": -88.23918,
  "url": "https://example.com/stream/playlist.m3u8",
  "type": "hls",
  "state": "Alabama",
  "county": "Mobile",
  "direction": "E",
  "source": "dot"
}
```

Supported `type` values: `hls` (M3U8 streams), `image` (JPEG with auto-refresh), `mjpeg` (motion JPEG streams), `embed` (iframe page URL), `youtube` (YouTube video ID only, not a full URL).

## License

MIT
