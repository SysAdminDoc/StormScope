[![Version](https://img.shields.io/badge/version-0.44.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()
[![Cameras](https://img.shields.io/badge/cameras-33%2C615-cyan)]()
[![Live Site](https://img.shields.io/badge/live_site-open_StormScope-7c3aed)](https://sysadmindoc.github.io/StormScope/)

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

**[Open the live StormScope map →](https://sysadmindoc.github.io/StormScope/)**

## Features

- **Live Weather Radar** — Animated RainViewer radar with official NOAA/NWS MRMS failover, source/age/coverage status, and adjustable opacity
- **Accessible Radar Timeline** — Direct frame scrubbing, manual-only/0.5×/1×/2× playback, explicit frame age and light/moderate/heavy scale text, plus standard, color-vision-friendly, and high-contrast presentations
- **Official Weather Alerts** — Viewport-scoped NWS watches, warnings, and advisories with severity polygons and accessible details
- **Optional Hazard Context** — Keyless NOAA lightning density and viewport-bounded NIFC wildfire perimeters start off, show freshness and attribution, fail independently, and stay below warnings and cameras
- **33,615 Live Cameras** — Traffic, weather, park, EarthCam, LiveBeaches, and webcam feeds across all 50 US states plus Washington, D.C., territories, and international locations
- **Fast Camera Discovery** — Progressive state shards make the map interactive before the full corpus loads; accessible search, health/source/type filters, health-first name/distance sorting, and a virtualized result list stay synchronized with the map
- **Local Favorites and Views** — Favorite cameras, restore the last map/layer/opacity state, save named views, and validate portable JSON imports/exports without an account
- **English and Spanish UI** — Live language switching covers controls, recovery states, weather/radar labels, WMO conditions, alerts, dates, numbers, and units with deterministic English fallback
- **Bounded Multi-Camera Monitor** — Select 2–4 search results after a bandwidth warning; offscreen/hidden direct feeds pause, one close destroys all players, and unsupported provider embeds become safe source links
- **437 YouTube Live Streams** — Playback-verified 24/7 streams including beaches, airports, railcams, harbors, city skylines, landmarks, indoor/outdoor feeds, wildlife cams, volcano cams, and city-list discoveries (red markers)
- **451 Provider Embed Feeds** — 275 EarthCam Network pages, 172 active NPS embed pages, and 4 direct LiveBeaches/Brownrice player embeds
- **Click-to-View** — YouTube embeds, EarthCam pages, HLS video streams, and auto-refreshing image feeds in a modal viewer
- **Current Weather** — Country-aware NWS forecasts with Open-Meteo fallback, metric/US units, and explicit issue/observation times
- **Dark Theme** — CartoDB dark matter tiles with glassmorphism UI
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Installable PWA** — Offline camera/radar fallback, visible cache/freshness state, safe cache recovery, and deterministic update activation
- **Mobile Responsive** — Works on desktop and mobile browsers

## Camera Coverage

33,615 cameras across all 50 US states plus Washington, D.C.:

| State | Cameras | | State | Cameras |
|-------|--------:|-|-------|--------:|
| Florida | 4,988 | | Indiana | 574 |
| California | 3,129 | | Missouri | 563 |
| Utah | 2,054 | | Maryland | 523 |
| Virginia | 1,677 | | Kansas | 519 |
| Pennsylvania | 1,515 | | Idaho | 460 |
| Washington | 1,355 | | Wisconsin | 452 |
| Iowa | 1,127 | | Oklahoma | 361 |
| North Carolina | 1,128 | | Connecticut | 352 |
| Oregon | 1,128 | | Nebraska | 350 |
| Ohio | 1,066 | | Louisiana | 338 |
| Colorado | 1,013 | | Illinois | 331 |
| New York | 996 | | Delaware | 315 |
| Georgia | 848 | | Alaska | 228 |
| Texas | 833 | | Kentucky | 226 |
| Michigan | 778 | | North Dakota | 189 |
| Arizona | 752 | | New Hampshire | 185 |
| South Carolina | 749 | | South Dakota | 184 |
| Nevada | 661 | | Mississippi | 160 |
| Alabama | 597 | | Maine | 146 |

Plus: Rhode Island (139), West Virginia (120 WV511 streams: 119 healthy and one retryable degraded), Vermont (93), Montana (39), and the remaining lower-count US states, international country/territory buckets, 172 active National Park webcams, 275 EarthCam Network feeds, 4 LiveBeaches direct embeds, and 437 playback-verified YouTube streams.

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

It validates the camera corpus and deterministic shards, verifies vendored dependency/license hashes, runs Python units, lint, JavaScript syntax/contracts and service-worker tests, and enforces a real headless desktop/mobile/modal/offline/cache/accessibility smoke. The smoke requires the first camera shard to render within 2.5 seconds on the local Chromium test profile.

Audit exact vendored versions, licenses, newer stable releases, and OSV advisories while also exercising Leaflet 1.9.4, markercluster 1.5.3, and HLS.js 1.6.16 in Chromium:

```bash
python scripts/vendor_dependencies.py --check-updates --behavior
```

Rebuild every vendored file and third-party license from hash-pinned npm tarballs:

```bash
python scripts/vendor_dependencies.py --rebuild
```

The pinned package/tarball/file/license inventory is `vendor/dependencies.json`. Update that manifest deliberately before an upgrade; a newer version or advisory exits the audit with status 2, while any byte or license mismatch exits with status 1.

## Tech Stack

- [Leaflet 1.9.4](https://leafletjs.com/) (BSD-2-Clause) — Interactive map with CartoDB dark tiles
- [Leaflet.markercluster 1.5.3](https://github.com/Leaflet/Leaflet.markercluster) (MIT) — Camera marker clustering
- [RainViewer API](https://www.rainviewer.com/api.html) — Free weather radar tiles (no key)
- [NOAA/NWS MRMS](https://mapservices.weather.noaa.gov/) — Official fallback radar imagery and history (no key)
- [NWS API](https://www.weather.gov/documentation/services-web-api) — Free hourly weather data (no key)
- [HLS.js 1.6.16](https://github.com/video-dev/hls.js/) (Apache-2.0) — HLS video stream playback
- Camera data from 30+ official state/local DOT sources + [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT) + NPS + EarthCam + LiveBeaches + verified-live YouTube streams

## Data Sources

- **Radar**: RainViewer primary with official NOAA/NWS MRMS fallback; the UI identifies the active source, age, resolution, coverage, and degradation reason
- **Hazard context**: NOAA nowCOAST 15-minute lightning density and NIFC WFIGS current wildfire perimeters, both optional and keyless
- **Cameras**: 30+ official state/local DOT sources (Caltrans, FL511, WSDOT, NYCDOT, IDOT, MDOT, CDOT, WV511, etc.), OpenTrafficCamMap, NPS, EarthCam, LiveBeaches, and verified-live YouTube streams
- **City discovery list**: U.S. Census Bureau 2025 Gazetteer places file, filtered to legal city records and written as `City, State`
- **Weather**: National Weather Service (NWS) hourly forecast API

## Refreshing Camera Data

Run the data fetcher to pull fresh camera data from all state DOT APIs:

```bash
python scripts/fetch_cameras.py
```

This queries 30+ live sources and transactionally merges DOT/NPS results into `data/cameras.json`. Provider failures retain their last-known-good rows, curated sources are preserved, schema and coverage gates run before replacement, and the previous valid dataset is saved as `data/cameras.json.bak`. Use `--provider Oklahoma`, `--provider Delaware`, or `--provider "West Virginia"` for a bounded provider-only refresh; HLS feeds must advance across two media-playlist probes before acceptance. Restore the rollback copy with:

```bash
python scripts/fetch_cameras.py --rollback
```

Rebuild the checked-in state shards and compact index after any accepted camera-data change:

```bash
python scripts/build_camera_shards.py
```

The app loads `data/cameras.index.json` and `data/camera-shards/` progressively, with the schema-v2 monolith retained as a tested migration fallback. All camera writers share the schema-v2 contract in `data/cameras.schema.json` and use an exclusive lock plus fsynced temporary file and atomic replacement. A dry-run city search may read `data/us_city_livestream_checkpoint.json` with `--resume`, but changes neither that checkpoint nor the camera dataset unless `--apply` is present.

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
