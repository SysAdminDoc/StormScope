[![Version](https://img.shields.io/badge/version-0.93.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-brightgreen)]()
[![Cameras](https://img.shields.io/badge/cameras-36%2C592-cyan)]()
[![Live Site](https://img.shields.io/badge/live_site-open_StormScope-7c3aed)](https://sysadmindoc.github.io/StormScope/)

# StormScope

Live US weather radar with webcam overlays. See real-time radar and click traffic cameras to view current weather conditions through live feeds.

**[Open the live StormScope map →](https://sysadmindoc.github.io/StormScope/)**

## Features

- **Live Weather Radar** — Animated RainViewer radar with official NOAA/NWS MRMS failover, source/age/coverage status, and adjustable opacity
- **Accessible Radar Timeline** — Direct frame scrubbing, manual-only/0.5×/1×/2× playback, explicit frame age and light/moderate/heavy scale text, color-accessible palettes, and a rolling request budget that automatically falls back to NOAA before exceeding RainViewer's public limit
- **Synchronized Map Comparison** — An opt-in two-pane workspace keeps center/zoom aligned while each pane independently selects radar time, GOES satellite, or current NWS hazards; low-data, hidden-tab, request, tile, decoded-memory, and frame-time budgets are enforced
- **Official Weather Alerts** — Viewport-scoped NWS watches, warnings, and advisories with severity polygons and accessible details
- **Incident Camera Context** — Alert and wildfire details rank up to eight non-offline cameras inside or within 50 km of the mapped boundary by durable verification evidence, distance, and bearing, with map/open actions and an atomic playable 2–4 camera monitor
- **Accessible Situation Summary** — A keyboard-triggered semantic panel reports localized map position/zoom, center radar coverage/age/echo intensity, warning and independently loaded wildfire counts, and the globally nearest verified cameras; alerts and cameras open without moving the map
- **Optional Hazard Context** — Keyless NOAA lightning density and complete paginated, viewport-bounded NIFC wildfire perimeters start off, show freshness and attribution, fail independently, retain the last complete snapshot, and stay below warnings and cameras
- **Official GOES Satellite Context** — Optional NOAA NESDIS merged GeoColor imagery uses the latest authoritative frame, bounded viewport exports, explicit coverage/freshness/attribution, and an independent pane below radar, warnings, and cameras
- **36,592 Indexed Cameras** — 13,071 verified healthy, 1 degraded, and 23,520 not yet verified across traffic, FAA, NOAA/NWS, USGS, NRAO, park, university, provider, and webcam sources
- **Fast Camera Discovery** — Progressive state shards make the map interactive before the full corpus loads; accessible search, health/source/type filters, health-first name/distance sorting, and a virtualized result list stay synchronized with the map without reclustering on scroll; Arrow/Page/Home/End navigation crosses unrendered slices
- **Visible Feed Provenance** — Every camera viewer distinguishes provider frame time, StormScope verification, expiring device-local playback evidence, provider/source, feed type, cadence, and degraded reason without relying on hover text
- **Local Favorites and Workflow Profiles** — Named schema-v3 profiles restore map, layers, radar presentation, alert threshold, camera filters, weather units, and data mode; three immutable presets and validated portable migration/import/export work without an account
- **Shareable Map Scenes** — Copy or share a bounded versioned link containing the map, public layers, radar frame/presentation, alerts, camera filters, and active camera without exposing favorites or private local state
- **NHC Tropical Cyclones** — Optional official advisory centers, forecast points/tracks/cones, and coastal watches/warnings with explicit partial/no-active states and nearby cameras
- **WPC Flood Outlooks & Gauges** — Selected Day 1–3 excessive-rainfall and five-day significant-river outlooks remain independent; viewport gauges appear only after a USGS observation is joined to matching official NOAA NWPS flood thresholds
- **Private Local Overlays** — Strict bounded GeoJSON/GPX imports render with fixed safe styling, remain session-only by default, persist in IndexedDB only after Keep locally, export canonically, and never enter shared scene links or network requests
- **Connection-Aware Data Usage** — Automatic mode honors Save-Data by pausing the camera corpus, radar animation/preload, and frequent still refreshes; Standard and Low overrides work in every browser, with explicit catalog and feed starts
- **Installable PWA** — Stable installed identity, verified Severe Weather and Travel shortcuts, wide/narrow install screenshots, Chromium install prompting, and accurate Safari Add to Home Screen guidance
- **Recoverable Offline Storage** — Cache diagnostics report cache bytes plus origin usage/quota, percentage, and persistence state; users can request durable offline storage or clear runtime data while preserving the app shell
- **English and Spanish UI** — Live language switching covers controls, cache recovery, compass/CAP vocabulary, source taxonomy, radar/provider states, weather labels, WMO conditions, dates, numbers, and units; source-authored NWS prose is explicitly identified when it remains in English
- **Bounded Multi-Camera Monitor** — Select 2–4 search results after a bandwidth warning; offscreen/hidden direct feeds pause, one close destroys all players, and unsupported provider embeds become safe source links
- **599 YouTube Live Streams** — Playback-verified streams including beaches, airports, railcams, harbors, city skylines, landmarks, campuses, indoor/outdoor feeds, wildlife cams, volcano cams, and city-list discoveries (red markers)
- **256 EarthCam Live Snapshot Feeds** — EarthCam Network cameras render their official refreshing `image.php` snapshot frame directly in the viewer (EarthCam's player gates live video to authorized domains, so 256 of 276 rows now use the hotlinkable public snapshot instead of a non-playing page embed); 20 partner-hosted EarthCam rows remain page embeds
- **253 Provider Embed Feeds** — 20 EarthCam embed pages, 162 active NPS embed pages, 18 FAA WeatherCam pages, 17 Hazcams weather players, 6 DRBA ferry players, 4 AngelCam players, 4 direct LiveBeaches/Brownrice players, 21 first-party IPCamLive embeds, and 1 first-party RTSP.me lake feed
- **Click-to-View** — YouTube embeds, EarthCam live snapshots, HLS video streams, and auto-refreshing image feeds in a modal viewer
- **Observed and Forecast Weather** — US cameras pair the nearest valid NWS station observation, age, source, and distance with independently recoverable hourly forecast context; Open-Meteo provides current-condition fallback elsewhere or when both NWS branches fail
- **Light and Dark Themes** — Glassmorphism UI with a matching CartoDB dark/light basemap; the Appearance control offers Match system (respects `prefers-color-scheme`), Always dark, and Always light, and the choice persists locally
- **No API Keys** — Runs entirely client-side with free, keyless APIs
- **Installable PWA** — Offline camera/radar fallback, visible cache/freshness state, safe cache recovery, and deterministic update activation
- **Mobile Responsive** — Portrait and short-height landscape layouts keep layers, alerts, search results, camera details, multi-camera monitoring, and the radar timeline internally scrollable and keyboard reachable in both themes

## Camera Coverage

36,592 indexed cameras across all 50 US states plus Washington, D.C. The generated manifest records 13,071 verified healthy, 1 degraded, 0 offline, and 23,520 unverified feeds:

| State | Cameras | | State | Cameras |
|-------|--------:|-|-------|--------:|
| Florida | 4,988 | | Alabama | 597 |
| California | 3,129 | | Indiana | 574 |
| Utah | 2,054 | | Missouri | 563 |
| Minnesota | 1,722 | | Maryland | 523 |
| Virginia | 1,677 | | Kansas | 519 |
| Pennsylvania | 1,515 | | Idaho | 460 |
| Washington | 1,355 | | Wisconsin | 452 |
| North Carolina | 1,128 | | Oklahoma | 361 |
| Oregon | 1,128 | | Connecticut | 356 |
| Iowa | 1,127 | | Nebraska | 350 |
| Ohio | 1,066 | | Louisiana | 338 |
| Colorado | 1,013 | | Illinois | 331 |
| New York | 996 | | Delaware | 323 |
| Georgia | 848 | | Kentucky | 252 |
| Texas | 833 | | Alaska | 233 |
| Michigan | 778 | | New Mexico | 199 |
| Arizona | 752 | | North Dakota | 211 |
| South Carolina | 749 | | New Hampshire | 199 |
| Tennessee | 677 | | South Dakota | 186 |
| Nevada | 661 | | Mississippi | 162 |

Plus: Maine (149, including Acadia NPS, Rockland Ferry, and Hog Island wildlife additions), Rhode Island (148, including 4 first-party URI campus views and 5 current harbor/downtown/wildlife/rail YouTube feeds), New Jersey (144, including 129 advancing NJTA HLS cameras), West Virginia (127, including 3 Canaan Valley resort views, 3 current NCTC eagle views, and a corrected Canyon Rim NPS image), Vermont (96, including 6 current YouTube cameras), Massachusetts (49, including 11 directly verified NPS images, 2 MWRA HLS feeds, and 32 current YouTube cameras), Montana (49, including 9 current Glacier NPS images and 2 current YouTube cameras), Hawaii (37, including 14 current public-domain USGS HVO images and 19 current YouTube cameras), U.S. Virgin Islands (30, including 27 currently verified YouTube streams), Arkansas (28, including 17 advancing Hazcams weather players), Puerto Rico (28, including 19 advancing ACT traffic cameras and 6 current CC BY 4.0 NSF NEON/PhenoCam research images), Wyoming (17, including 8 directly verified NPS feeds and 2 current Range destination cameras), Washington, D.C. (13, including 6 first-party Smithsonian wildlife streams and a Union Station railcam), Guam (1 verified first-party destination camera), American Samoa (1 current Pago Pago Harbor image), and the remaining lower-count US states and territories, international country buckets, 197 active National Park webcams, 2 MWRA HLS feeds, 256 EarthCam live snapshot feeds and 20 EarthCam embed pages, 18 FAA WeatherCam embeds, 17 Hazcams embeds, 4 AngelCam embeds, 22 first-party IPCamLive feeds, 6 Smithsonian HLS feeds, 3 NOAA/NWS stills, 32 USGS stills, 1 NRAO still, 9 university/PhenoCam feeds, 4 LiveBeaches direct embeds, and 599 playback-verified YouTube streams.

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

Install the complete pinned local toolchain from a clean checkout:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements-dev.txt
npm ci
npx playwright install chromium firefox webkit
python scripts/preflight.py
```

The preflight reports every actual version and install path before work starts. Supported versions are Python `>=3.10,<4`, Node.js `>=18`, npm `>=9`, curl `>=8`, Ruff `0.15.20`, yt-dlp `2026.6.9`, and Playwright `1.61.1` with its pinned Chromium, Firefox, and WebKit engines installed. Python tools are exact-pinned in `requirements-dev.txt`; Node tooling is exact-locked by `package-lock.json` and declares npm `11.13.0` as the development package manager.

Run the complete local regression gate before changing or publishing the app:

```bash
python scripts/check.py
```

The gate runs the preflight first, then uses Playwright Chromium for the exhaustive smoke and reduced Firefox/WebKit contracts for boot, search, modal cleanup, cached offline shell, and HLS branch behavior. The Windows WebKit port uses an injected native-HLS capability to exercise that branch because the port does not ship the platform media stack.

It validates the camera corpus and deterministic shards, verifies vendored dependency/license hashes plus expiring supplemental CVE dispositions, runs Python units, lint, JavaScript syntax/contracts and service-worker tests, and enforces a real headless desktop/mobile/modal/offline/cache/accessibility smoke. The smoke requires the first camera shard to render within 2.5 seconds on the local Chromium test profile.

Build the one release asset only from a clean committed tree:

```bash
python scripts/package_release.py --clean
```

The packager rejects version drift, dirty/untracked input, stale tags, and stale `dist/` files; writes only `dist/StormScope-vX.Y.Z.zip`; fixes entry order, timestamps, compression, and permissions; embeds `release-manifest.json` with the exact commit and SHA-256/size of every tracked file; then reopens and verifies the archive before printing its final SHA-256. Repeating the command for the same commit produces identical bytes.

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
- [NOAA National Hurricane Center GIS](https://www.nhc.noaa.gov/gis/) — Official tropical forecast points, tracks, cones, and watches/warnings (no key)
- [NOAA Weather Prediction Center](https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php) — Official excessive-rainfall and significant-river-flood outlooks (no key)
- [USGS Water Data](https://api.waterdata.usgs.gov/) + [NOAA NWPS](https://water.noaa.gov/about/api) — Current gauge observations displayed only with matching official flood thresholds (no key)
- [NWS API](https://www.weather.gov/documentation/services-web-api) — Free hourly weather data (no key)
- [HLS.js 1.6.16](https://github.com/video-dev/hls.js/) (Apache-2.0) — HLS video stream playback
- Camera data from 30+ official state/local DOT sources + [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) (MIT) + NOAA/NWS + USGS + NRAO + NPS + MWRA + EarthCam + IPCamLive + LiveBeaches + verified-live YouTube streams

## Data Sources

- **Radar**: RainViewer primary with official NOAA/NWS MRMS fallback; distributors may package one strictly allowlisted RainViewer-v2-compatible primary instead. The UI identifies the active source, age, resolution, coverage, and degradation reason
- **Hazard context**: NOAA nowCOAST 15-minute lightning density and NIFC WFIGS current wildfire perimeters, both optional and keyless
- **Tropical context**: NOAA NHC forecast points, tracks, cones, and coastal watches/warnings from the official tropical weather summary ArcGIS service, optional and keyless
- **Flood planning context**: NOAA WPC excessive-rainfall/significant-river outlooks plus strictly threshold-authorized USGS/NWPS gauge joins, optional and keyless; the UI explicitly distinguishes outlook guidance from warnings and all-clear claims
- **Local overlays**: GeoJSON/GPX files are validated and rendered entirely on-device; they are never uploaded, linked from properties, cached by the service worker, or included in scene URLs
- **Cameras**: 30+ official state/local DOT sources (Caltrans, FL511, WSDOT, NYCDOT, IDOT, MDOT, CDOT, WV511, NMRoads, Tennessee SmartWay, Clarksville Traffic Cameras, etc.), OpenTrafficCamMap, NOAA/NWS, USGS, NRAO, NPS, MWRA, EarthCam, first-party IPCamLive destinations, LiveBeaches, and verified-live YouTube streams
- **City discovery list**: U.S. Census Bureau 2025 Gazetteer places file, filtered to legal city records and written as `City, State`
- **Weather**: National Weather Service (NWS) hourly forecast API

## Custom Radar Distributions

`config/radar-provider.json` is disabled in the official distribution. A distributor may configure exactly one credential-free HTTPS RainViewer-v2-compatible discovery endpoint, explicit tile origins, required attribution, native zoom, history, and freshness thresholds. The provider ID and protocol are fixed; query strings, fragments, credentials, wildcards, unknown fields, and insecure origins fail validation.

After editing the configuration, regenerate the immutable local runtime module and synchronize only its exact origins into `connect-src`:

```bash
python scripts/build_radar_config.py --update-csp index.html
python scripts/package_release.py --check
```

The packaged endpoint replaces RainViewer as the primary source and falls directly to NOAA/NWS MRMS when unhealthy. Runtime URL parameters and local storage cannot select or alter it. Disabling or changing the configuration with the same command removes the prior generated origins before adding the current allowlist.

## Comparing Maps

Open **Layers → Compare two maps**. The left pane starts on the latest radar frame and the right pane on the latest validated GOES GeoColor image. Either pane can independently select a radar frame, satellite, or the current normalized NWS hazard geometry while center and zoom remain synchronized. Comparison maps are temporary: closing the workspace or hiding the tab destroys their layers, requests, timers, and Leaflet instances.

Comparison uses manual radar frames with no preload or animation, at most 72 comparison/basemap requests per rolling minute, at most 64 live tile nodes per pane, and a 32 MiB decoded-tile estimate ceiling. In low-data or Save-Data mode, only one network raster pane runs; choose NWS hazards in the other pane to activate its suspended radar or satellite selection.

## Refreshing Camera Data

Run the data fetcher to pull fresh camera data from all state DOT APIs:

```bash
python scripts/fetch_cameras.py
```

This queries 30+ live sources and transactionally merges DOT/NPS results into `data/cameras.json`. Ordered typed adapters in `scripts/providers/` isolate shared MapIcons, DataTables/WKT, Iteris GeoJSON, and CARS GraphQL protocols behind an injected runtime; one-off collectors retain the same adapter/result boundary. Provider failures retain their last-known-good rows, curated sources are preserved, schema and coverage gates run before replacement, and the previous valid dataset is saved as `data/cameras.json.bak`. Use `--provider Oklahoma`, `--provider Delaware`, `--provider "West Virginia"`, or `--provider "Puerto Rico"` for a bounded provider-only refresh; selection remains case-insensitive and unambiguous. HLS feeds must advance across two media-playlist probes, while ACT images must expose current provider timestamps and advancing frames. Restore the rollback copy with:

```bash
python scripts/fetch_cameras.py --rollback
```

Rebuild the checked-in state shards and compact index after any accepted camera-data change:

```bash
python scripts/build_camera_shards.py
```

The app loads `data/cameras.index.json` and `data/camera-shards/` progressively, with the schema-v2 monolith retained as a tested migration fallback. All camera writers share the schema-v2 contract in `data/cameras.schema.json`, preserve stable camera IDs through refreshes, and reserve new IDs from an atomic never-reused sequence before using an exclusive lock plus fsynced temporary file and atomic replacement. A dry-run city search may read `data/us_city_livestream_checkpoint.json` with `--resume`, but changes neither that checkpoint nor the camera dataset unless `--apply` is present.

Run the YouTube discovery automation to exhaust live-filtered search queries, verify live streams with extractor playback metadata, and append only fixed-location streams with curated coordinates:

```bash
python scripts/discover_youtube_cameras.py --query-mode exhaustive --max-pages 8 --apply
```

Discovery reports are written to `data/youtube_discovery_report.json`. Curated fixed-location metadata lives in `data/youtube_location_overrides.json`; YouTube entries store the 11-character video ID only.

Audit existing YouTube rows and remove confirmed broken/non-live streams:

```bash
python scripts/audit_youtube_streams.py --apply
```

Target a known canonical stream without auditing the full corpus by repeating `--video VIDEO_ID` as needed.

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

Health/provenance fields are schema-v2 metadata. `unknown` and `null` mean the feed has not been verified by the current pipeline; they never imply success. Transient provider failures degrade existing rows instead of deleting them. Browser playback never rewrites this provider evidence: device-local playable, unavailable, unsupported, and retry outcomes are stored separately with a six-hour expiry.

## License

MIT
