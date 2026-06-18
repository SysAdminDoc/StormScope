[![Version](https://img.shields.io/badge/version-0.6.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()
[![Cameras](https://img.shields.io/badge/cameras-23%2C804-cyan)]()

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

## Features

- **Live Weather Radar** — Real-time NEXRAD radar via RainViewer (animated, adjustable opacity)
- **23,804 Live Cameras** — Traffic, weather, park, and outdoor webcams across 26+ US states plus international locations
- **204 YouTube Live Streams** — Verified-live 24/7 outdoor streams including beaches, airports, railcams, harbors, city skylines, ski resorts, and landmarks (red markers)
- **Click-to-View** — YouTube embeds, HLS video streams, and auto-refreshing image feeds in a modal viewer
- **Current Weather** — NWS hourly forecast data shown alongside each camera feed
- **Dark Theme** — CartoDB dark matter tiles with glassmorphism UI
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Mobile Responsive** — Works on desktop and mobile browsers

## Camera Coverage

23,804 cameras across 26+ US states:

| State | Cameras | | State | Cameras |
|-------|--------:|-|-------|--------:|
| Florida | 4,884 | | Ohio | 1,053 |
| California | 3,057 | | New York | 941 |
| Utah | 2,051 | | Georgia | 839 |
| Pennsylvania | 1,502 | | Texas | 806 |
| Washington | 1,349 | | Michigan | 767 |
| Colorado | 1,008 | | Nevada | 645 |
| Alabama | 584 | | Indiana | 568 |
| Missouri | 557 | | Idaho | 459 |
| Wisconsin | 447 | | New Hampshire | 404 |
| Connecticut | 347 | | Louisiana | 329 |
| Illinois | 314 | | Kentucky | 220 |
| Delaware | 295 | | NPS Parks | 189 |
| Arizona | 99 | | Alaska | 100 |

Plus: Montana, South Dakota, 189 National Park webcams, and 204 verified-live YouTube outdoor streams.

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
- Camera data from 20+ state DOT APIs + [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT) + NPS + verified-live YouTube streams

## Data Sources

- **Radar**: RainViewer — global weather radar composites, updated every 10 minutes
- **Cameras**: 20+ state DOT live APIs (Caltrans, FL511, WSDOT, NYCDOT, IDOT, MDOT, CDOT, etc.), OpenTrafficCamMap, NPS, and verified-live YouTube outdoor streams
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

Supported `type` values: `hls` (M3U8 streams), `image` (JPEG with auto-refresh), `mjpeg` (motion JPEG streams), `youtube` (YouTube video ID only, not a full URL).

## License

MIT
