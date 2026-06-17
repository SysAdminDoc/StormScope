[![Version](https://img.shields.io/badge/version-0.1.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

## Features

- **Live Weather Radar** — Real-time NEXRAD radar via RainViewer (animated, adjustable opacity)
- **7,029 Live Cameras** — Traffic and weather cameras across 10 US states
- **Click-to-View** — HLS video streams and auto-refreshing image feeds in a modal viewer
- **Current Weather** — NWS hourly forecast data shown alongside each camera feed
- **Dark Theme** — CartoDB dark matter tiles with glassmorphism UI
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Mobile Responsive** — Works on desktop and mobile browsers

## Camera Coverage

| State | Cameras | Feed Type |
|-------|---------|-----------|
| California | 2,912 | HLS + Image |
| Ohio | 1,091 | HLS + Image |
| Colorado | 669 | HLS + Image |
| Indiana | 654 | HLS + Image |
| Alabama | 587 | HLS + Image |
| Alaska | 397 | Image |
| Delaware | 295 | Image |
| Kentucky | 222 | HLS + Image |
| Arizona | 102 | Image |
| Georgia | 100 | Image |

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
- Camera data from [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT)

## Data Sources

- **Radar**: RainViewer — global weather radar composites, updated every 10 minutes
- **Cameras**: State DOT traffic cameras via OpenTrafficCamMap dataset
- **Weather**: National Weather Service (NWS) hourly forecast API

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

Supported `type` values: `hls` (M3U8 streams), `image` (JPEG with auto-refresh), `mjpeg` (motion JPEG streams).

## License

MIT
