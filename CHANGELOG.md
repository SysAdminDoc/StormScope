# Changelog

## v0.22.0 - 2026-06-19

### Data
- Audited all 710 existing YouTube rows with extractor playback checks and removed 474 confirmed broken, unavailable, ended, or non-playable streams.
- Added 102 newly discovered live streams from city, skyline, airport, rail, traffic, harbor, weather, wildlife, indoor, and city-list searches, then retained 338 YouTube streams in the cleaned dataset.
- Updated total camera coverage to 24,217 cameras with no duplicate or malformed YouTube IDs.

### Automation
- Added `scripts/audit_youtube_streams.py` for full-dataset YouTube audits, report generation, and confirmed-failure removal.
- Added `scripts/livestream_automation_loop.py` for unattended recurring audits plus broad YouTube, city-list, EarthCam, and LiveBeaches discovery passes.
- Tightened YouTube discovery verification so new streams must pass `yt-dlp` live playback extraction, not only stale `isLiveBroadcast` metadata.
- Classified YouTube anti-bot/rate-limit extractor blocks as unknown/transient so the audit does not falsely remove streams that were previously verified in the same run.

## v0.21.0 - 2026-06-18

### Features
- **International weather** — cameras outside the US now get weather data via Open-Meteo API (free, global). Includes WMO weather code translation and wind direction from degrees. NWS still used for US cameras.

### Fixes
- **Focus trap on modal** — Tab/Shift+Tab now cycles within the modal when open; focus returns to the triggering element on close (WCAG 2.4.3)
- **Embed URL allowlist** — `loadEmbedFeed` now validates URLs against a list of known camera domains (earthcam.com, nps.gov, etc.) and adds `sandbox` attribute to iframes for defense-in-depth
- **Open-Meteo field names** — corrected `wind_speed_10` to `wind_speed_10m` and `wind_direction_10` to `wind_direction_10m`

### Performance
- **Lazy tooltips** — tooltips are now bound on first hover instead of at load time; eliminates 24K+ DOM element creation during startup
- **Batch marker insertion** — switched from individual `addLayer()` to `addLayers()` for the full marker array, reducing cluster computation passes
- **Radar frame preloading** — next frame is preloaded during animation to reduce flicker on step

### Visual
- **Embed marker differentiation** — EarthCam/embed cameras now have a distinct purple marker with dashed border, separate from YouTube (red/solid) and DOT (cyan/solid) markers; provides shape-based differentiation beyond color alone

## v0.20.0 - 2026-06-18

### Fixes
- **Security: XSS in tooltips** — camera names from external APIs were rendered as raw HTML in Leaflet tooltips; now escaped via textContent
- **Security: XSS in weather panel** — NWS API data was interpolated via innerHTML; now built with DOM construction and textContent
- **Security: YouTube embed URL** — video IDs now URL-encoded to prevent injection via malformed camera data
- **Bug: Nowcast label wrong** — radar frames were mislabeled; last 2 frames always showed "Nowcast" regardless of actual past/nowcast boundary. Now uses the real `past.length` boundary and labels nowcast frames as "Forecast"
- **Bug: Radar animation continues when layer hidden** — toggling radar off now stops the animation timer
- **Bug: Weather race condition** — rapidly switching cameras could overwrite weather data from a previous camera; now uses AbortController to cancel stale fetches and verifies `activeCamera` before writing
- **Bug: Missing HTTP status check** — cameras.json and RainViewer fetches didn't check `resp.ok`; now throw on non-200 responses
- **Bug: Image/MJPEG error handlers fire after modal closed** — error callbacks now check `activeCamera` before mutating DOM
- **Bug: Hls global reference crash** — `Hls` checked without `typeof`; would throw ReferenceError if HLS.js failed to load
- **Bug: Weather state not reset** — opening a new camera could flash stale weather text from the previous one; now resets weather DOM on open

### UX
- **International cameras** — weather section now shows "Weather data is available for US locations only (NWS coverage)" instead of the vague "Weather data unavailable for this location"
- **Embed feeds** — added error handling and `loading="lazy"` for iframe embeds
- **Modal focus** — close button receives focus when modal opens
- **Modal scrollbar** — styled dark thin scrollbar for modal body overflow

### Accessibility
- Added `role="dialog"`, `aria-modal="true"`, `aria-labelledby` to camera modal
- Added `role="application"`, `aria-label` to map container
- Added `role="toolbar"`, `aria-label` to radar controls
- Added `role="status"`, `aria-live="polite"` to camera count, radar time, and weather status
- Added `aria-label` to all buttons (layers toggle, radar controls, modal close)
- Added `aria-expanded`, `aria-controls` to layers toggle button
- Added `aria-hidden="true"` to all decorative SVG icons
- Added `role="img"` with `aria-label` to camera marker SVGs
- Added `title` attribute to YouTube and embed iframes
- Added `label` element for radar opacity slider
- Added `aria-label` and `role="status"` to live feed indicator dots

### Visual
- **Dark-themed tooltips** — added `.cam-tooltip` CSS (was referenced but never defined); tooltips now match the dark glassmorphism UI instead of Leaflet's white default
- **Focus-visible styles** — added `outline: 2px solid accent` for keyboard navigation on all interactive elements
- **Reduced-motion support** — `@media (prefers-reduced-motion: reduce)` disables pulse animation and button transitions
- **Design tokens** — replaced hardcoded `#000`, `#2ecc71`, YouTube red values with CSS variables (`--bg-surface`, `--success`, `--youtube`, `--youtube-glow`)
- **Button transitions** — changed `transition: all` to explicit properties to avoid animating layout properties
- **Feed error text** — added `max-width` and `line-height` for readability
- Added `meta theme-color` for mobile browser chrome

## v0.19.0 - 2026-06-18

- Added 4 more verified-live YouTube streams from deeper LiveBeaches harvesting, increasing YouTube coverage from 706 to 710 streams
- Added Belize beach resort, Maine harbor, New Jersey osprey, and Seaside Heights boardwalk feeds
- Expanded total camera coverage from 24,585 to 24,589 cameras

## v0.18.0 - 2026-06-18

- Added 32 more verified-live YouTube streams, increasing YouTube coverage from 674 to 706 streams
- Expanded Beach Life Cams, livespotting, PixCams, Africam, harbor, beach, ferry, wildlife, safari, and waterhole coverage
- Corrected bad auto-geocodes for Anguilla, Weymouth, German harbors, Majete, Sabi Sand, Maasai Mara, Namibia, Seychelles, St. John, and Mallorca additions
- Expanded total camera coverage from 24,553 to 24,585 cameras

## v0.17.0 - 2026-06-18

- Added 20 more verified-live YouTube streams, increasing YouTube coverage from 654 to 674 streams
- Expanded ferry, harbor, lighthouse, observatory, campus, weather station, port, resort, and public weather-camera coverage
- Corrected fixed placements for Northport Pier, Southampton, Brunsbuettel, Martha's Vineyard, Alonissos, Neuwerk, Rockport, Pine Mountain Observatory, Weber State, and Springfield
- Expanded total camera coverage from 24,533 to 24,553 cameras

## v0.16.0 - 2026-06-18

- Added 46 more verified-live YouTube streams, increasing YouTube coverage from 608 to 654 streams
- Expanded mountain, campus, airport, wildlife, aquarium, pier, marina, beach, eagle nest, bear, walrus, and weather-camera coverage
- Corrected auto-geocode misses for Gatlinburg, Madeira, Catalina Island, Alaska wildlife cams, and other fixed-location additions
- Expanded total camera coverage from 24,487 to 24,533 cameras

## v0.15.0 - 2026-06-18

- Added 42 more verified-live YouTube streams, increasing YouTube coverage from 566 to 608 streams
- Expanded Europe, Mediterranean, Madeira, Mallorca, Japan, Canada, wildlife, city, beach, harbor, ferry, rail, and weather-camera coverage
- Corrected auto-geocode misses for Mallorca, Madeira, Cannes, Corfu, Germany, Tokyo, and other fixed-location additions
- Expanded total camera coverage from 24,445 to 24,487 cameras

## v0.14.0 - 2026-06-18

- Added 33 more verified-live YouTube streams, increasing YouTube coverage from 533 to 566 streams
- Expanded operator/provider discovery with Webcams de Mexico, SouthWest RailCams, Ozolio, WebcamTaxi, town-square, resort, zoo, rail, volcano, and beach feeds
- Corrected bad auto-geocodes for Mexico, Romania, Puerto Rico, and Madeira additions before committing
- Expanded total camera coverage from 24,412 to 24,445 cameras

## v0.13.0 - 2026-06-18

- Added 13 more verified-live YouTube streams from deeper LiveBeaches category harvesting, increasing YouTube coverage from 520 to 533 streams
- Added more coral reef, rail, harbor, pier, lighthouse, bridge, skyline, market-square, and beach resort feeds
- Expanded total camera coverage from 24,399 to 24,412 cameras

## v0.12.0 - 2026-06-18

- Added 26 more verified-live YouTube streams, increasing YouTube coverage from 494 to 520 streams
- Expanded fixed-location coverage with airport/runway cams, surf cams, bird-feeder cams, street cams, patio cams, and additional international feeds
- Expanded total camera coverage from 24,373 to 24,399 cameras

## v0.11.0 - 2026-06-18

- Added 86 more verified-live YouTube streams, increasing YouTube coverage from 408 to 494 streams
- Expanded LiveBeaches category harvesting, city-list retry search, and source-family discovery with more beach, rail, harbor, volcano, airport, wildlife, skyline, resort, indoor, and international feeds
- Made city-list checkpointing retry-aware so transient YouTube search errors do not mark cities as fully processed
- Corrected two older YouTube country/state buckets and fixed bad automated placements for Emerald Beach Resort and Frying Pan Tower
- Expanded total camera coverage from 24,287 to 24,373 cameras

## v0.10.0 - 2026-06-18

- Added LiveBeaches discovery automation for category-page harvesting, direct Brownrice embed extraction, YouTube iframe verification, and fixed-location geocoding
- Added 15 LiveBeaches-derived feeds: 11 verified-live YouTube streams and 4 direct Brownrice player embeds
- Expanded total camera coverage from 24,272 to 24,287 cameras and YouTube coverage from 397 to 408 streams

## v0.9.0 - 2026-06-18

- Added 112 more verified-live YouTube streams, increasing YouTube coverage from 285 to 397 streams
- Expanded source-family discovery coverage with railcams, airport/runway cams, beach and harbor cams, aquarium feeds, wildlife cams, skyline cams, and manually placed fixed-location livestreams
- Tightened city-list matching for ambiguous city names and removed a wrong-city Sheridan collision before committing
- Refreshed EarthCam provider discovery; no additional provider embeds were available beyond the existing 275 feeds
- Expanded total camera coverage from 24,160 to 24,272 cameras

## v0.8.0 - 2026-06-18

- Added a Census Gazetteer city-list generator that writes 10,230 U.S. city labels in `City, State` format
- Added checkpointed city livestream discovery automation for exhaustive YouTube live searches across the generated city list
- Added 58 more verified-live YouTube streams, increasing YouTube coverage from 227 to 285 streams
- Expanded total camera coverage from 24,102 to 24,160 cameras, including new city, beach, traffic, rail, airport, weather, and indoor/outdoor cams

## v0.7.0 - 2026-06-18

- Added EarthCam discovery automation for the public EarthCam network API and EarthCam-branded YouTube live search
- Added 275 online EarthCam provider feeds as embed cameras, including indoor and outdoor fixed-location livestream pages
- Added 23 more verified-live EarthCam YouTube streams, increasing YouTube coverage from 204 to 227 streams
- Expanded total camera coverage from 23,804 to 24,102 cameras and documented `embed` camera records

## v0.6.0 — 2026-06-18

- Added 57 more verified-live YouTube outdoor streams, increasing YouTube coverage from 147 to 204 streams
- Added direct YouTube URL/ID ingestion to the discovery automation for known live cams
- Expanded beach, boardwalk, harbor, city, and Ohio live-cam coverage, using city-level coordinates where exact camera mounts are not published

## v0.5.0 — 2026-06-18

- Added 50 more verified-live YouTube outdoor streams, increasing YouTube coverage from 97 to 147 streams
- Added append-only YouTube discovery automation that exhausts live-filtered search queries, verifies streams through YouTube player metadata, and writes a discovery report
- Added curated location overrides for safe fixed-location YouTube additions while keeping ambiguous verified streams out of the map dataset

## v0.4.0 — 2026-06-18

- Added 50 new verified-live YouTube outdoor streams, increasing YouTube coverage from 47 to 97 streams
- Expanded fixed-location webcam coverage across beaches, airports, rail lines, harbors, ski resorts, city skylines, and international landmarks
- Added new YouTube coverage for Ohio, Colorado, Connecticut, New Jersey, Utah, Vermont, Michigan, Maryland, Delaware, Sint Maarten, New Zealand, Australia, Canada, Greece, Spain, Czechia, United Kingdom, Israel, Japan, Netherlands, and Italy

## v0.3.0 — 2026-06-17

- Added 39 YouTube 24/7 live stream webcams (red markers) across the US
- YouTube embed player in modal with autoplay + mute
- Distinct red markers for YouTube streams vs cyan for DOT cameras
- Coverage includes EarthCam, explore.org, ABC13, and independent live cams
- Locations: beach cams (FL, CA, TX, NC, SC), city skylines (NYC, Chicago, Seattle, Houston, Nashville, Minneapolis), national parks (Yellowstone, Grand Canyon), and landmarks (Times Square, Space Needle, Bourbon Street)

## v0.2.0 — 2026-06-17

- Expanded camera coverage from 7,029 to 23,600 cameras across 26+ US states
- Added live API fetchers for: Florida (4,884), NYC DOT, WSDOT, Illinois DOT, Michigan DOT, Colorado DOT, Austin TX, Louisiana, Pennsylvania, Wisconsin, Utah, Nevada, New Hampshire, Connecticut, Idaho, South Carolina, Montana, South Dakota, Missouri, Georgia DOT, Florida ArcGIS
- Added 189 National Park Service webcams (Old Faithful, Grand Canyon, etc.)
- Added comprehensive Python data fetcher script (`scripts/fetch_cameras.py`)
- Vendored all JS/CSS dependencies locally (Leaflet, MarkerCluster, HLS.js)
- Fixed retina tile URL causing "Zoom Level Not Supported" at high zoom
- Deployed to GitHub Pages at sysadmindoc.github.io/StormScope/
- Added favicon

## v0.1.0 — 2026-06-17

- Initial release
- Full-screen dark Leaflet map (CartoDB dark matter tiles)
- Live weather radar overlay via RainViewer API (free, no API key)
- Radar animation controls (play/pause, step forward/back)
- Adjustable radar opacity
- 7,029 live traffic cameras across 10 US states (AL, AK, AZ, CA, CO, DE, GA, IN, KY, OH)
- Camera marker clustering for performance at scale
- Click-to-view camera modal with auto-refreshing image feeds and HLS video streams
- NWS weather data overlay in camera modal (temperature, conditions, wind, humidity)
- Layer toggle controls (radar, cameras)
- Responsive design for desktop and mobile
- Camera data sourced from OpenTrafficCamMap (MIT licensed)
