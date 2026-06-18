# Changelog

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
