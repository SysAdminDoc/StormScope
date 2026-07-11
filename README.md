[![Version](https://img.shields.io/badge/version-0.26.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()
[![Cameras](https://img.shields.io/badge/cameras-24%2C204-cyan)]()

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

## Features

- **Live Weather Radar** — Animated RainViewer radar with official NOAA/NWS MRMS failover, source/age/coverage status, and adjustable opacity
- **Official Weather Alerts** — Viewport-scoped NWS watches, warnings, and advisories with severity polygons and accessible details
- **24,204 Live Cameras** — Traffic, weather, park, EarthCam, LiveBeaches, and webcam feeds across 48 US states plus international locations
- **355 YouTube Live Streams** — Playback-verified 24/7 streams including beaches, airports, railcams, harbors, city skylines, landmarks, indoor/outdoor feeds, wildlife cams, volcano cams, and city-list discoveries (red markers)
- **451 Provider Embed Feeds** — 275 EarthCam Network pages, 172 active NPS embed pages, and 4 direct LiveBeaches/Brownrice player embeds
- **Click-to-View** — YouTube embeds, EarthCam pages, HLS video streams, and auto-refreshing image feeds in a modal viewer
- **Current Weather** — Country-aware NWS forecasts with Open-Meteo fallback, metric/US units, and explicit issue/observation times
- **Dark Theme** — CartoDB dark matter tiles with glassmorphism UI
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Installable PWA** — Offline camera/radar fallback, visible cache/freshness state, safe cache recovery, and deterministic update activation
- **Mobile Responsive** — Works on desktop and mobile browsers

## Camera Coverage

24,204 cameras across 48 US states:

| State | Cameras | | State | Cameras |
|-------|--------:|-|-------|--------:|
| Florida | 4,956 | | Ohio | 1,066 |
| California | 3,120 | | Colorado | 1,013 |
| Utah | 2,053 | | New York | 993 |
| Pennsylvania | 1,515 | | Georgia | 848 |
| Washington | 1,354 | | Texas | 832 |
| Michigan | 777 | | Missouri | 563 |
| Nevada | 661 | | Idaho | 459 |
| Alabama | 595 | | Wisconsin | 452 |
| Indiana | 573 | | New Hampshire | 408 |
| Connecticut | 352 | | Louisiana | 338 |
| Illinois | 331 | | Kentucky | 226 |
| NPS Parks | 172 | | Arizona | 108 |
| Alaska | 104 | | South Dakota | 43 |

Plus: Montana, South Carolina, the remaining lower-count US states, 43 international country/territory buckets, 172 active National Park webcams, 275 EarthCam Network feeds, 4 LiveBeaches direct embeds, and 355 playback-verified YouTube streams.

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

Install the local quality-gate dependency once:

```bash
npm install
npx playwright install chromium
```

Run the complete local regression gate before changing or publishing the app:

```bash
python scripts/check.py
```

It validates the camera corpus and runs Python units, lint, JavaScript syntax/contracts, service-worker tests, and a real headless desktop/mobile/modal/offline/cache/accessibility smoke.

## Tech Stack

- [Leaflet](https://leafletjs.com/) — Interactive map with CartoDB dark tiles
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) — Camera marker clustering
- [RainViewer API](https://www.rainviewer.com/api.html) — Free weather radar tiles (no key)
- [NOAA/NWS MRMS](https://mapservices.weather.noaa.gov/) — Official fallback radar imagery and history (no key)
- [NWS API](https://www.weather.gov/documentation/services-web-api) — Free hourly weather data (no key)
- [HLS.js](https://github.com/video-dev/hls.js/) — HLS video stream playback
- Camera data from 20+ state DOT APIs + [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT) + NPS + EarthCam + LiveBeaches + verified-live YouTube streams

## Data Sources

- **Radar**: RainViewer primary with official NOAA/NWS MRMS fallback; the UI identifies the active source, age, resolution, coverage, and degradation reason
- **Cameras**: 20+ state DOT live APIs (Caltrans, FL511, WSDOT, NYCDOT, IDOT, MDOT, CDOT, etc.), OpenTrafficCamMap, NPS, EarthCam, LiveBeaches, and verified-live YouTube streams
- **City discovery list**: U.S. Census Bureau 2025 Gazetteer places file, filtered to legal city records and written as `City, State`
- **Weather**: National Weather Service (NWS) hourly forecast API

## Refreshing Camera Data

Run the data fetcher to pull fresh camera data from all state DOT APIs:

```bash
python scripts/fetch_cameras.py
```

This queries 20+ live APIs and transactionally merges DOT/NPS results into `data/cameras.json`. Provider failures retain their last-known-good rows, curated sources are preserved, schema and coverage gates run before replacement, and the previous valid dataset is saved as `data/cameras.json.bak`. Restore it with:

```bash
python scripts/fetch_cameras.py --rollback
```

All camera writers share the schema-v1 contract in `data/cameras.schema.json` and use an exclusive lock plus fsynced temporary file and atomic replacement. A dry-run city search may read `data/us_city_livestream_checkpoint.json` with `--resume`, but changes neither that checkpoint nor the camera dataset unless `--apply` is present.

Run the YouTube discovery automation to exhaust live-filtered search queries, verify live streams with extractor playback metadata, and append only fixed-location streams with curated coordinates:

```bash
python scripts/discover_youtube_cameras.py --query-mode exhaustive --max-pages 8 --apply
```

Discovery reports are written to `data/youtube_discovery_report.json`. Curated fixed-location metadata lives in `data/youtube_location_overrides.json`; YouTube entries store the 11-character video ID only.

Audit existing YouTube rows and remove confirmed broken/non-live streams:

```bash
python scripts/audit_youtube_streams.py --apply
```

For long unattended discovery, run the loop driver. `--iterations 0` runs continuously; omit `--apply` for a dry run:

```bash
python scripts/livestream_automation_loop.py --iterations 0 --apply --geocode
```

The audit keeps transient extractor/network failures by default and removes only confirmed failed rows. Discovery and audit reports are ignored under `data/*_report*.json`.

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
  "source": "dot",
  "last_verified": null,
  "health": "unknown",
  "failure_class": null,
  "source_url": "https://example.com/stream/playlist.m3u8",
  "refresh_cadence_seconds": null
}
```

Supported `type` values: `hls` (M3U8 streams), `image` (JPEG with auto-refresh), `mjpeg` (motion JPEG streams), `embed` (iframe page URL), `youtube` (YouTube video ID only, not a full URL).

Health/provenance fields are schema-v2 metadata. `unknown` and `null` mean the feed has not been verified by the current pipeline; they never imply success. Transient provider failures degrade existing rows instead of deleting them.

## License

MIT
