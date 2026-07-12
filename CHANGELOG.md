# Changelog

## v0.45.0 - 2026-07-12

### +19 verified official Puerto Rico ACT traffic cameras
- Added the Puerto Rico Highways and Transportation Authority's public 21-row ITS inventory using exact provider IDs, coordinates, bilingual location metadata, direct same-origin image paths, and canonical per-camera source pages. No geocoding is used and the three existing Puerto Rico EarthCam views remain distinct.
- Each candidate must return a real nontrivial JPEG, a current Puerto Rico-local provider timestamp no more than two minutes old, and an advancing timestamp or frame hash across repeated probes. A short probe is followed by a bounded 60-second retry for slower roadway updates; **19 cameras advanced**.
- Rejected two real-but-frozen placeholder frames: SAN JUAN-CAM 07 has not updated since April 20, 2026, and SAN JUAN-CAM 30 since March 1, 2026. A transient HTTP 500 in an earlier pass aborted the provider refresh and preserved all last-known-good rows; the successful retry returned the complete verified set.
- Recorded ACT attribution, copyright/usage posture, 30-second observed refresh cadence, source URLs, and verification evidence in the ignored report. Corpus **33,615 → 33,634**; Puerto Rico **3 → 22**; deterministic shards and localized counts rebuilt; service-worker cache bumped to v22.

## v0.44.0 - 2026-07-12

### Complete verified coverage across all 50 states: 120 WV511 HLS cameras
- Added a bounded West Virginia provider using WV511's public map-service inventory: all 127 rows have exact provider IDs, fixed coordinates, county codes, labels, and active streaming metadata supplied by West Virginia DOT. No geocoding or fuzzy ArcGIS join is used.
- Resolved every camera ID through its official WV511 player page instead of assuming a stream host, then required valid non-ended HLS manifests, available media segments, and advancement across two probes. **120 cameras verified advancing**; seven feeds repeatedly returned HTTP 404 and were classified `confirmed_dead` in the ignored discovery report.
- Hardened the shared HLS verifier so a single failed probe can never produce a permanent-death classification; inconsistent probes remain retryable. WV511 refreshes now abort and retain last-known-good rows if any player or stream has a transient, rate-limit, or authentication failure.
- Manually reviewed all accepted WV511 label/county/coordinate tuples and immediately rechecked every accepted stream before commit. The release retains **119 healthy** rows; CAM096 was recently verified live but then returned repeated 404s, so it remains truthfully `degraded` and retryable rather than being deleted as permanently dead. Added the three exact RoadSummary media hosts to the CSP, rebuilt the deterministic corpus, and completed state-level coverage at **33,615 cameras across all 50 states plus Washington, D.C.** Service-worker cache bumped to v21.

## v0.43.0 - 2026-07-12

### Correctness: camera markers survive a mid-load shard→monolith fallback
- When progressive shard loading fails partway and the store falls back to the full `cameras.json` monolith, the store replaces its in-memory camera objects. Markers already added to the map still referenced the old shard objects, so they no longer matched the fresh search corpus and could disappear when a filter was applied. The loader now detects the source switch and rebuilds the marker layer from the fresh corpus, keeping the map and search results consistent. Service-worker cache bumped to v20.

## v0.42.0 - 2026-07-12

### Interaction and accessibility hardening (audit pass)
- **Escape key now closes the top-most open surface** — camera modal, then multi-camera monitor, then the NWS alert detail, then the search or layers panel — and returns focus to the control that opened it. Previously Escape only dismissed the two modals, so keyboard users could not close open panels or the alert detail.
- **The NWS alert detail can now be dismissed.** It gained a keyboard-accessible close button (`Hide alert details`) and collapses on Escape, returning focus to the alert that opened it. Before this, opening an alert detail left it stuck open until another alert was clicked, with no way to close it.
- **Closing the multi-camera monitor no longer drops keyboard focus.** The monitor is launched from the search panel, which is hidden while the monitor is open — so restoring focus to the (now-hidden) trigger silently sent focus to `<body>`. Focus now falls back to the always-visible search toggle when the original trigger is no longer focusable.
- Minor correctness: `btn-layers` `aria-expanded` is now set as a proper string, and the radar **Retry** button no longer passes its click event into `initRadar` as an options object.
- Added headless-browser smoke coverage for the alert-detail dismiss button and Escape-closes-the-search-panel-with-focus-return behavior.

## v0.41.0 - 2026-07-12

### +41 more playback-verified fixed-location YouTube live cameras (396 → 437)
- Second bounded YouTube discovery pass over 22 beach/pier/harbor/plaza queries plus the `See.Cam`/`SeeJH` operator families. **124 streams verified live** via the player + yt-dlp `is_live` gate.
- Manually vetted all 63 geocode candidates; **rejected 22** false placements and non-fixed feeds: "Blind Donkey … Cruz Bay, St John USVI" → Santa Cruz, **California**; "Newburyport Waterfront" → **Missouri**; "Pompano Beach Underwater Pier" → **Las Vegas**; "Fort Lauderdale … Elbo Room" → Kokomo, **Indiana** (geocoder matched the word "LIVING"); "Town Square … SeeJH.com" → **Nevada**; generic "Pier Camera"/"Lifeguard HQ"; "AC Boardwalk" → **Sweden**; and bare city/county-centroid placements.
- Accepted **41** streams whose named venue geocoded to the correct point in the correct state (Florida beaches & Keys, Clearwater/Panama City/Destin/Fort Myers resorts, Acadia & Bar Harbor Maine, San Diego Shelter Island, SF Pier 39, Outer Banks Avalon Pier, Dauphin Island Sea Lab AL, Ashland OR plaza, Bedford WY, Katmai Brooks Falls bear cam, plus international Fuerteventura Airport and Montego Bay). Two coordinates were **hand-corrected** where the geocoder resolved to a park HQ / bay centroid instead of the camera: Katmai Brooks Falls and the Inn at Bay Harbor.
- Each accepted stream stored a curated coordinate override and was re-verified live immediately before writing. Corpus 33,454 → **33,495**; rebuilt 45 shards; service-worker cache v18.

## v0.40.0 - 2026-07-12

### +27 playback-verified fixed-location YouTube live cameras (369 → 396)
- Ran a bounded, high-precision YouTube live-discovery pass over 12 specific-place queries (Florida Keys/Key West, Oahu & Kauai beach resorts, Myrtle Beach boardwalk, Ocean City NJ, Jackson Hole WY, Galveston seawall, Griffith/Olympia-Lacey railcams, St. George UT, USVI). Each candidate was verified live via the YouTube player + yt-dlp `live_status=is_live` gate — **126 streams confirmed live** across the queries.
- **Manually vetted every candidate before acceptance.** The automatic geocoder produced numerous false placements that were rejected: "Lime Out … Coral Bay, St John USVI" → Coral Bay, **Australia**; "Napili Kai … Maui" → Mojácar, **Spain**; "Key West Harbor at the Marker Hotel" → the Marker, **Dublin**; "CSX Chattanooga Sub" → **Massachusetts**; "Midway Atoll NWR" → Oahu; plus city/county-centroid-only placements and non-fixed "webcam tour"/"4K VIDEO UHD" montage uploads. **36 candidates rejected in total.**
- Accepted only the **27** streams whose title named a specific venue/landmark that geocoded to the correct point in the correct state; wrote a hand-checked coordinate override for each, then re-verified all 27 live immediately before writing. Corpus 33,427 → **33,454**; rebuilt 45 shards; added the SkyVDN-style CSP already covers YouTube (video IDs only). Service-worker cache bumped to v17.

## v0.39.0 - 2026-07-11

### Closed four low-coverage state gaps with verified keyless DOT feeds (+1,639 cameras)
- **South Carolina (SCDOT via SkyVDN HLS, 17 → 748)** — the `sc.cdn.iteris-atis.com` cameras geojson migrated to a flat SkyVDN structure (`https_url` HLS playlists + `image_url` thumbnails); the old Iteris parser expected a `cameras[]`/`image` shape and silently returned zero. New `fetch_skyvdn_hls` reads each `active` camera's `https_url`, verifies it with the two-probe advancing-manifest check (rejects `#EXT-X-ENDLIST`, non-advancing sequences, dead segments), and accepts only live streams. **731 of 761 verified advancing**, 30 rejected to the ignored report.
- **Alaska (511 mapicons, 104 → 227)** — new `fetch_alaska` reads the keyless `511.alaska.gov/map/mapIcons/Cameras` list and its `/map/Cctv/{id}` snapshot proxy; each candidate is image-verified (real JPEG/PNG magic, not HTML/placeholder). **123 of 123 verified live.**
- **Arizona (AZ511 DataTables, 108 → 752)** — new `fetch_az511` pages the `List/GetData/Cameras` DataTables endpoint and its `/map/Cctv/{id}` snapshot proxy with per-image verification. **644 of 644 verified live.** The AZ server caps responses at 100 rows regardless of the requested `length`, so the shared DataTables pager now advances `start` by the actual returned-row count (fixes a latent gap that would have skipped rows on any 100-capped 511 instance, Georgia unaffected).
- **South Dakota (Iteris, 43 → 184)** — the SD Iteris feed still uses the `cameras[]`/`image` shape and now parses 190 official snapshot rows.
- Corpus 31,788 → **33,427** (+1,639); rebuilt to 45 deterministic shards; synced localized counts, README table, and smoke-test assertions. West Virginia remains the only state-level gap.

## v0.38.0 - 2026-07-11

### Recovered Iowa DOT with per-image live verification (+1,123 cameras)
- Replaced the dead Iowa IRIS fetcher (`tr.511ia.org` is now an Angular SPA) with the keyless Iowa DOT ArcGIS FeatureServer (`Traffic_Cameras_View`), which exposes 1,244 cameras with absolute HTTPS snapshot URLs and WGS84 coordinates.
- Added a concurrent image verifier: each candidate snapshot is fetched and accepted only if it returns a real image body (JPEG/PNG/GIF/WebP magic), rejecting `confirmed_dead` 404s, HTML placeholders, and offline frames. **1,123 of 1,242 verified live**, 119 offline/dead rejected to the ignored report. Iowa grows from 4 remnant rows to 1,127; corpus 30,665 → **31,788**.
- Rebuilt the deterministic shards (now 43), bumped the service-worker cache version, and synced localized counts/tests.
- Made the radar-timeline smoke test hermetic: it previously mocked the NOAA lightning and wildfire services but left the NOAA MRMS radar *fallback* on real network. Under the larger corpus, RainViewer radar tiles occasionally error from browser connection-pool pressure and trigger the NOAA fallback, whose real-network timing made the timeline assertion flaky. Added deterministic NOAA MRMS ImageServer/query/WMS fixtures so the fallback is reproducible at any dataset size (product behavior unchanged; radar degrades gracefully to NOAA exactly as in production).
- Researched Minnesota, Massachusetts, and Hawaii: MnDOT's IRIS `camera_pub` feed and MassDOT's `Assets/CCTV` FeatureServer expose keyless coordinates but no keyless media URL (image/stream URLs moved behind SPA/TrafficLand); Hawaii's GoAkamai list endpoint is Akamai-WAF/TLS-fingerprint gated. All recorded as blocked/retryable. South Carolina (761) and Montana (38) confirmed already complete via their Iteris feeds.

## v0.37.0 - 2026-07-11

### Recovered Maryland CHART live cameras (+514 verified HLS)
- Repaired the broken Maryland CHART fetcher, which had silently returned zero because the feed no longer exposes an `imageUrl` field. Each `ONLINE` camera now streams from its per-camera Wowza server via `https://{cctvIp}/rtplive/{id}/playlist.m3u8` (`strmr3/strmr5/strmr10.sha.maryland.gov`).
- Accepted only playlists whose media segments advanced across two probes: **523 of 550** online cameras verified live, 27 non-advancing playlists rejected to the ignored report. Corpus 30,151 → **30,665**; Maryland grows from 9 remnant rows to 523.
- Added the `*.sha.maryland.gov` streaming hosts to the CSP `media-src`/`connect-src`, bumped the service-worker cache version, and rebuilt the 41 deterministic shards.
- Audited three other stale state fetchers: Minnesota (`tr.511mn.org` DNS retired) and Iowa (`tr.511ia.org` now an SPA) need new endpoints (research); New Mexico's snapshot host serves HTTP only (443 refused) and cannot meet the HTTPS/CSP contract — all left retryable.

## v0.36.0 - 2026-07-11

### New England 511 state-label correction (223 false geocodes fixed)
- Corrected a systemic false-geocode bug: all 404 New England 511 traffic cameras were previously labeled "New Hampshire" regardless of their real state. Re-fetched the keyless DataTables feed and assigned each camera its authoritative `state`, `county`, and `direction`, fixing **134 Maine and 89 Vermont** cameras that were mislabeled New Hampshire (coordinates were already correct; only the state field was wrong).
- Replaced the state-hardcoding `mapIcons` New England fetcher with a `fetch_newengland511()` DataTables reader (per-state labels, county, direction, WKT coordinate parse, 100-row pagination) so future refreshes stay correct. Maine now shows 141 cameras and Vermont 93 (up from 7 and 4 mislabeled remnants); New Hampshire correctly holds 185.
- Migration removed the 404 mislabeled rows and re-inserted the corrected set transactionally (total corpus unchanged at 30,151); deterministic shards rebuilt.

### Eight new keyless official DOT providers (+5,259 cameras)
- Closed near-zero state coverage gaps by adding eight first-party, keyless state DOT/511 camera providers, bringing the corpus from 24,892 to **30,151 cameras across 49 of 50 states plus Washington, D.C.** — West Virginia is now the only state-level gap.
- **Virginia (VDOT 511)** — 1,672 cameras from the keyless GeoJSON layer, using the official absolute snapshot URL, jurisdiction as county, and provider direction; only `active` non-`problem_stream` feeds accepted.
- **North Carolina (DriveNC)** — 1,114 cameras via the keyless `mapIcons/Cameras` + `/map/Cctv/{id}` JPEG proxy (the metadata-rich v2 API requires a developer key, so the keyless coordinate+image path was used).
- **Oregon (ODOT TripCheck)** — 1,127 cameras from the `cctvinventory` feed with absolute RoadCams image URLs.
- **Kansas (KanDrive, 518)** and **Nebraska (511 Nebraska, 352)** — CARS/OneNetwork GraphQL `MapFeatures` query at `normalCameras`/zoom 11, absolute JPEG views with the cache-buster stripped.
- **North Dakota (NDDOT)** — 186 still cameras from the keyless `rcrs_dynamic` ArcGIS MapServer layer (active only).
- **Mississippi (MDOT Traffic)** — 158 cameras via the ASP.NET `LoadCameraData` PageMethod plus a per-site stream-bubble scrape resolving the Wowza thumbnail JPEG.
- **Rhode Island (RIDOT)** — 139 cameras from the keyless Rhodeways ArcGIS MapServer layer, upgrading `http`→`https` snapshot URLs and encoding spaces; closes the former Rhode Island gap.
- Every accepted feed is an official first-party image endpoint verified to return a real JPEG/PNG; ArcGIS/field whitespace was stripped and non-HTTPS URLs upgraded or rejected. Blocked (documented, retryable): New Jersey (WAF 403 + broken server function), Arkansas (ARDOT API key + re-embed prohibition), Tennessee (SmartWay `ApiKey` header), West Virginia (fragile HTTP IP-literal host, deferred).
- Rebuilt the 41 deterministic progressive shards and index (reconstruct exactly once, unique IDs), synced localized search totals and PWA cache version, and preserved the transactional rollback backup.

## v0.35.0 - 2026-07-11

### Delaware and Kansas coverage
- Added 314 provider-located Delaware DOT HLS cameras after correcting the official inventory key casing, bringing the corpus to 24,892 cameras across 48 states plus Washington, D.C.
- Accepted only `Active`, HTTPS DelDOT rows whose media playlists served segments and advanced across two probes; 14 provider-declared unavailable rows were skipped and 30 reproducible HTTP 404 playlists were classified `confirmed_dead` in the ignored report.
- Added the playback-verified, embeddable Wichita Great Plains Transportation Museum railcam from an eight-page-per-query state/territory gap search, bringing YouTube coverage to 369 streams and eliminating Kansas as a state-level gap.
- Added the exact DelDOT HLS origin to the CSP, provider IDs/attribution/timestamps/cadence, updated localized totals, and rebuilt deterministic shards.

## v0.34.0 - 2026-07-11

### Verified official-camera expansion
- Added 360 provider-located Oklahoma DOT HLS views from the official OKTraffic inventory, bringing the corpus to 24,577 cameras; all accepted playlists exposed available media segments and advanced across two probes.
- Rejected 15 OKTraffic candidates whose direct playlists reproducibly returned HTTP 404, while retaining them in the ignored discovery report as `confirmed_dead` evidence.
- Added bounded provider-only refreshes, preserved existing row order and IDs when introducing a new provider, and recorded OKTraffic camera IDs, source pages, provider timestamps, attribution, and 10-second refresh cadence.

### Location accuracy
- Corrected the live Schweitzer Village camera from Oklahoma to its official Sandpoint, Idaho resort location and corrected the live Key West cruise-port camera from Darwin, Australia to its visually confirmed Mallory Square vantage.
- Added curated location overrides for both streams and blocked generic `Village`/`The Village` geocoder queries that can resolve to unrelated places.

## v0.33.0 - 2026-07-11

### Live-camera discovery
- Added 13 currently live, playback-verified YouTube cameras across African wildlife reserves, international beaches/ports, an underwater Honduran reef, New York, Redding, and Redondo Beach, bringing the corpus to 24,217 cameras and 368 YouTube streams.
- Manually validated and curated precise locations for ten broad-search discoveries, and rejected two live results whose generic titles produced unrelated geocoder matches.
- Hardened automatic location extraction against generic view names and country-only fallback pins, with regression tests for the observed false-geocode cases.
- Continued the resumable Census city search through 25 additional California cities and rebuilt all 33 deterministic camera shards.

## v0.32.0 - 2026-07-11

### Optional official hazard context
- Added default-off NOAA nowCOAST lightning-density and NIFC WFIGS current-wildfire-perimeter layers with explicit freshness, coverage, source attribution, and no account or backend dependency.
- Kept both providers independently abortable and retryable, retained last-known wildfire geometry after refresh failures, and bounded wildfire requests to the visible viewport with dateline-safe queries.
- Rendered context below NWS warning polygons and camera markers, added safe localized wildfire details, and persisted layer choices in local saved views.
- Added provider parsing, query, freshness, CSP, stacking, lifecycle, localization, desktop/mobile, and headless browser regression coverage.

## v0.31.0 - 2026-07-11

### Vendored dependency provenance
- Added a machine-readable inventory for Leaflet 1.9.4, Leaflet.markercluster 1.5.3, and HLS.js 1.6.16 with licenses, pinned npm tarballs, tarball hashes, every shipped-file hash, and exact third-party license texts.
- Added a local verifier that reports versions/licenses, detects byte or license drift, queries npm for newer stable releases, queries OSV for exact-version advisories, and exits distinctly for broken integrity versus update/security attention.
- Added deterministic, path-safe, atomic rebuilds from individually extracted hash-pinned package members; a clean scratch rebuild reproduced every checked-in byte.
- Integrated offline vendor verification into `scripts/check.py` and added Chromium runtime assertions for Leaflet, markercluster, and HLS versions/capabilities before upgrades.

## v0.30.0 - 2026-07-11

### Bounded multi-camera monitoring
- Added an accessible 2–4 camera selection flow to search results with a visible bandwidth warning before any multi-feed playback starts.
- Added a responsive two-column monitor for HLS, image, MJPEG, and YouTube feeds; unsupported provider embeds degrade to safe source links instead of nested third-party players.
- Added visibility-aware player lifecycle management: offscreen and hidden-tab feeds pause network/playback work, visible feeds resume, and one close action destroys every HLS instance, timer, media source, iframe, observer, and DOM node.
- Added selection/capability/lifecycle unit contracts and live browser coverage for direct-feed start, four-feed bounds, embed fallback, and zero-player teardown.

## v0.29.0 - 2026-07-11

### Internationalization
- Added a standalone English/Spanish locale catalog with persisted live switching, deterministic English fallback, interpolation, and locale-aware number/date/radar-age formatting.
- Extracted user-facing application control copy into catalog keys, including camera loading/search/health/feed recovery, saved views, radar states/settings, weather/WMO conditions, alerts, cache/update states, and accessibility labels.
- Localized static document text and attributes without reload, updated generated UI state when the locale changes, and kept provider/camera/official-alert names as source data.
- Added catalog parity, fallback, missing-key, formatting, and embedded-copy regression tests plus live Spanish browser assertions.

## v0.28.0 - 2026-07-11

### Radar timeline and accessibility
- Added a direct frame scrubber with explicit position, persisted bounded manual/0.5×/1×/2× playback, and current frame age in every clear/coverage/data state.
- Added standard, color-vision-friendly, and high-contrast radar presentations with matching textual light/moderate/heavy legends.
- Kept previous/next/scrubber controls operational in manual and reduced-motion modes and outside center-point coverage; only provider failures disable the timeline.
- Bounded the expanded layers panel to the viewport with keyboard/touch scrolling and extended the browser smoke across manual timeline and palette behavior.

## v0.27.0 - 2026-07-11

### Camera discovery and performance
- Split the schema-v2 camera corpus into a deterministic compact index and 33 bounded state shards, with cancellable progressive loading, progressive counts, chunked clustering, service-worker shard caching, and a tested monolith fallback.
- Added accessible name/road/state/county search, source/type/health filters, health-first name/distance sorting, a virtualized keyboard/screen-reader result list, and one shared result model for list and map markers.
- Enforced a 2.5-second first-shard browser budget and expanded the headless smoke to cover progressive, offline, mobile, search, favorites, and persistence paths.

### Local continuity and cache reliability
- Added local camera favorites, named map/layer/opacity views, last-view restoration, and versioned validated JSON import/export with safe migration, corrupt-state recovery, and no account dependency.
- Made runtime cache clearing wait for in-flight camera revalidation, suppress refills for the current page, preserve the offline shell, and resume caching on the next navigation.

## v0.26.0 - 2026-07-11

### Weather intelligence
- Added health-aware radar providers with automatic RainViewer-to-NOAA/NWS MRMS failover, explicit source/resolution/frame-age/degradation metadata, coverage overlay and center sampling, and distinct clear/no-coverage/stale/provider/tile-failure states.
- Added official NWS watches, warnings, and advisories with viewport/point queries, CAP normalization, dedupe/expiry/backoff, severity polygons and filters, keyboard-accessible list/detail views, and weather.gov safety guidance.
- Corrected weather routing with country/territory awareness, NWS-to-Open-Meteo fallback, persisted metric/US units, and separate forecast issue/valid and observation times.

### Reliability, provenance, and accessibility
- Upgraded camera data to schema v2 with truthful health, last-verification, failure-class, source-URL, and refresh-cadence fields; provider and YouTube automation now preserves transient/degraded results without inventing verification.
- Added visible online/offline and camera-freshness badges, explicit service-worker update activation, cached radar-manifest fallback, and shell-preserving cache diagnostics/recovery.
- Radar refreshes on provider cadence/resume; hidden tabs pause and safely restore radar and camera media; preload completion and cleanup are measurable.
- Made camera markers health-aware and camera-specific for assistive technology; modal backgrounds become inert; controls meet mobile target sizes; safe-area, reduced-motion, and forced-color modes are handled.
- Hardened fallbacks after live review: NOAA latest mosaics omit undefined WMS time parameters, RainViewer tile failures trigger NOAA selection, cached radar remains explicitly stale offline, and NWS land/point queries fail independently while the national feed is reused between pans.
- Successful HLS/image/MJPEG playback and retry failures now update a local non-destructive health overlay, preserving transient results without rewriting the shipped corpus.

## v0.25.0 - 2026-07-11

### Reliability and security
- Made every camera-data writer use one schema-validated, exclusively locked, fsynced atomic replacement path with backup and rollback support.
- Made provider refreshes non-destructive: outages, partial Caltrans runs, and truncated snapshots retain last-known-good rows; concurrent curated additions survive; global and per-provider coverage gates run before replacement.
- Made dry-run discovery byte-preserving, verification errors retryable, and applied checkpoint updates atomic, union-preserving, and limited to cities and stream IDs actually committed.
- Repaired the committed camera corpus by removing inactive, malformed, and duplicate feeds; upgrading safe HTTP URLs; normalizing IDs; and validating all 24,204 records.
- Restricted service-worker cleanup to StormScope caches, retained runtime data across shell upgrades, awaited cache writes and trims, rejected opaque/lookalike tile caching, surfaced quota failures, and added shell-preserving usage/clear controls to the layers panel.
- Hardened feed embeds with an exact-host allowlist, sandboxing, privacy-enhanced YouTube URLs, deterministic HLS/media cleanup, timeout/retry handling, and an always-available source fallback.

### Radar and quality
- Aligned RainViewer playback with its current public contract: API-provided host, Universal Blue scheme, native zoom 7, past-only frames, visible attribution, and actionable empty/rate-limit/index/tile error states that never leave stale radar displayed as current.
- Added a strict content security policy covering the app's verified data, media, tile, and frame providers.
- Added one local regression command, `python scripts/check.py`, covering Python tests, lint, JavaScript syntax/contracts, service-worker behavior, full camera schema validation, and a real headless desktop/mobile/modal/offline/cache/accessibility smoke.

## v0.24.0 - 2026-07-11

### Features
- Installable PWA: added `manifest.json` (standalone display, dark theme, maskable icons) and app icons under `assets/`.
- Added a service worker (`sw.js`) for offline support:
  - Precaches the full app shell (HTML/CSS/JS, vendored Leaflet/markercluster/HLS.js, icons) for offline launch.
  - Cache-first, LRU-bounded caching of RainViewer radar frames and CARTO basemap tiles so repeat visits reuse already-fetched imagery.
  - Stale-while-revalidate caching of the 5.5 MB camera dataset for instant repeat loads.
  - Time-sensitive APIs (NWS, Open-Meteo, RainViewer maps index) are always fetched fresh and never cached.
  - Network-first navigations fall back to the cached shell when offline.
- Service worker registration is guarded to `http(s)` so the app still works on `file://`.

## v0.23.0 - 2026-06-19

### Data
- Re-audited the current YouTube dataset and removed 3 streams that had ended or were no longer live.
- Continued the resumable U.S. city-list search across 150 more city labels, adding 20 playback-verified live streams and bringing the dataset to 24,234 cameras with 355 YouTube streams.
- Corrected four ambiguous city-list placements for Algonquin Park, Long Beach Lodge Tofino, a Southern Alberta bird feeder, and Robbie's Marina Islamorada.

### Automation
- Hardened city-list matching to reject foreign-location title hints and require explicit state evidence for ambiguous city names such as Long Beach, Marina, Mountain View, and Ontario.

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
