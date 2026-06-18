# Changelog

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
