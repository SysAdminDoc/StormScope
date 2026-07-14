# Changelog

## v0.100.0 - 2026-07-14

- Added keyless place/address geocoding search at the top of the camera search panel (Photon primary, Nominatim fallback — both OpenStreetMap). Debounced type-ahead (≥300 ms) respects provider fair-use limits, returns up to five results as an accessible listbox (arrow/Enter/Escape keyboard navigation), pans and zooms the map on selection, shows OpenStreetMap attribution, and degrades gracefully when both providers fail. Queries are used only for the in-session map view and are never stored, shared, or added to scene links. Added `js/geocode.js` with unit + headless coverage, EN/ES localization, and `photon.komoot.io`/`nominatim.openstreetmap.org` in `connect-src`. SW v73.

## v0.99.0 - 2026-07-14

- Added an optional, default-off SPC severe & tornado watch layer from the keyless NOAA `watch_warn_adv` ArcGIS service, filtered to Tornado Watch and Severe Thunderstorm Watch product types. These are watch AREAS (a region under threat), distinct from the CAP warnings already shown. Already-expired and non-severe watches are dropped, tornado watches render above severe-thunderstorm watches below the CAP warnings, insecure (non-HTTPS) official URLs are nulled, and DOM-only popups link the official SPC watch. Freshness/attribution, transfer-limit pagination, a 2-minute refresh, and last-good recovery match the other context layers; the layer participates in shareable scenes and workflow profiles and reuses the already-allowlisted `mapservices.weather.noaa.gov` origin. Added `js/severe-watches.js` with unit + headless coverage and EN/ES. SW v72.

## v0.98.0 - 2026-07-14

- Added an optional, default-off SPC convective (categorical) outlook layer from the keyless NOAA `SPC_wx_outlks` ArcGIS service, with a Day 1/2/3 selector. Categorical risk polygons (general thunderstorm → marginal → slight → enhanced → moderate → high) use official SPC colors, transfer-limit pagination, issue/valid times, freshness/attribution, last-good recovery, and DOM-only popups that state the guidance is not a warning. The layer participates in shareable scenes and workflow profiles and reuses the already-allowlisted `mapservices.weather.noaa.gov` origin (no CSP change). Added `js/convective-outlooks.js` with unit coverage, EN/ES localization, and headless day-switch coverage. SW v71.

## v0.97.0 - 2026-07-14

- Added an optional, default-off USGS earthquakes layer from the keyless static GeoJSON summary feeds (`Access-Control-Allow-Origin: *`). Selectable magnitude (significant/M4.5+/M2.5+/M1.0+/all) and period (hour/day/week/month) drive magnitude-scaled, magnitude-colored markers with DOM-only popups (place, magnitude, depth, time, official USGS event link scheme-guarded to http/https). Freshness, attribution, and independent abort-on-teardown match the other context layers; the layer participates in shareable scenes and workflow profiles. Added `js/earthquakes.js` with unit coverage, EN/ES localization, a hostile-content headless regression, and `earthquake.usgs.gov` in `connect-src`. SW v70.

## v0.96.0 - 2026-07-14

- Added a header "locate me" control that centers the map on the device location via the browser Geolocation API and drops a transient marker. Permission prompts, denials, timeouts, and unsupported browsers are handled with a localized (EN/ES) polite-announcer message. Coordinates are used only for the in-session view and marker — never stored, shared, or added to scene links. Headless-mocked coverage recenters on a mocked position and confirms the announcement. SW v69.

## v0.95.0 - 2026-07-14

- Hardened modal focus containment: `trapFocus` now detects when focus has escaped the open modal (for example when a live-feed re-render removes the focused control and focus falls back to `<body>`) and pulls it back into the modal on the next Tab, so keyboard and screen-reader users can no longer reach the inert background of the camera, comparison, or monitor modals. SW v68.

## v0.94.0 - 2026-07-14

- Hardened cross-origin privacy: every direct camera media element (HLS `video`, MJPEG/image `img`, and the multi-camera monitor's image/HLS players) plus the radar tile pixel sampler now set `referrerPolicy='no-referrer'`, matching the existing iframe policy so the document origin and path never leak to DOT/FAA/USGS/relay hosts.
- Added clickjacking protection via a JavaScript frame-guard that breaks out of cross-origin framing. (CSP `frame-ancestors` is spec-ignored when delivered via `<meta>` and a static host cannot send a CSP response header, so a frame-guard is the only deliverable control.)
- Guarded popup anchor hrefs built from fetched provider text against Leaflet CVE-2025-69993: added `safeExternalUrl()` (allows only http/https, else `#`) and routed the NHC advisory and USGS gauge source links through it. All feature popups already construct DOM via `textContent`; a regression contract now asserts the referrer policy, the CSP directive, DOM-only popups, and the scheme guard. SW v67.

## v0.93.0 - 2026-07-12

- Added an opt-in synchronized two-map comparison workspace with independent per-pane radar frame, latest validated GOES GeoColor, and current normalized NWS hazard selections. Opening pauses normal refresh/animation work; close or hidden-tab lifecycle destroys comparison layers, timers, handlers, and Leaflet instances before normal work resumes.
- Enforced a 72-request rolling comparison ceiling, 64 tile nodes per pane, 32 MiB decoded-tile estimate, manual/no-preload radar, debounced satellite refresh, and low-data single-raster policy. Headless desktop/mobile gates cover independent time selection, synchronized p95 frame budgets, 32/24 MiB JS heap deltas, hazard zero-radar-request behavior, responsive bounds, and teardown. Added EN/ES and refreshed install screenshots. SW v66.

## v0.92.0 - 2026-07-12

- Added an optional distribution-time RainViewer-v2-compatible radar endpoint with a fixed provider identity, explicit HTTPS discovery/tile allowlist, required attribution, declared zoom/history/freshness capabilities, generated immutable runtime configuration, and CSP synchronization. Unsafe or stale configuration blocks the release gate; no URL or local-state override exists.
- The configured source uses the existing discovery, health, timeline, attribution, rendering, and tile-error contracts and falls independently to NOAA/NWS MRMS. Default RainViewer behavior is unchanged. Added generator/CSP/runtime/unit and real headless configured-provider fixtures. SW v65.

## v0.91.0 - 2026-07-12

- Split camera ingestion behind an ordered typed provider registry and atomic `ProviderResult` contract. Shared MapIcons, DataTables/WKT, Iteris GeoJSON, and CARS GraphQL implementations now use injected runtime services in `scripts/providers/`, while facade functions preserve provider names, CLI substring/request ordering, transactional merge behavior, and test patch points.
- Added focused adapter selection, protocol fixture, error containment, exact-row, pagination, deduplication, and compatibility tests. The committed camera monolith, index, and all shards remain byte-identical. SW v64.

## v0.90.0 - 2026-07-12

- Added client-only GeoJSON and GPX overlays with atomic validation for type/MIME/5 MiB size, 2,000 features, 100,000 positions, supported geometry/ring structure, coordinate/elevation ranges, scalar properties, unsafe keys, XML entities, and bounded GPX waypoints/routes/track segments.
- Imports use fixed app-owned styling in a z380 pane, safe text-only popups, per-feature nearby cameras, visibility/zoom/export/remove controls, canonical single/bundle export, and session-only defaults. Explicit Keep locally uses a separate versioned IndexedDB store; scenes and diagnostics exclude names, IDs, properties, and geometry. Added EN/ES, persistence/reload, hostile-content, GPX, rejection, export, mobile, and offline-shell coverage. SW v63.

## v0.89.0 - 2026-07-12

- Added optional official WPC Day 1–3 excessive-rainfall and five-day significant-river-flood outlooks with independent paginated feeds, exact issue/valid periods, category/pattern styling, source links, explicit planning limitations, and last-good partial recovery.
- Added viewport-bounded flood gauges that render only when a current USGS stage observation safely joins to the same NOAA NWPS station, matching stage units, and finite official action/minor/moderate/major thresholds. Added profile/scene Day selection, lifecycle refresh, CSP, diagnostics, EN/ES UI, unit/live-query/rendered coverage, and SW v62.

## v0.88.0 - 2026-07-12

- Added a default-off official NOAA NHC tropical-cyclone layer using the CORS-enabled forecast point, track, cone, and coastal watch/warning GeoJSON services. Advisory mismatches fail closed, feed states distinguish ready/partial/no-active/unavailable, and total failures retain the last good layer.
- Added official advisory links, issue times, intensity, shape/dash-distinct watch styling, active-storm status, nearby-camera discovery using cone-first geometry, profile/scene persistence, lifecycle refresh, redacted diagnostics state, and headless happy/partial/no-active coverage. Service-worker cache bumped to v61.

## v0.87.0 - 2026-07-12

- Added an optional, default-off NOAA NESDIS merged GOES East/West GeoColor layer from the official time-enabled 24-hour image service. Metadata supplies the authoritative latest frame; image exports are clamped to viewport pixels and 76.5° satellite coverage and split safely across the antimeridian.
- Satellite freshness, coverage, attribution, loading/error states, visibility lifecycle, map-move refresh, saved profiles, and scene links are explicit. A dedicated z315 pane keeps imagery below lightning/radar, warnings, and cameras; failures remain independent. Added unit and rendered provider coverage. Service-worker cache bumped to v60.

## v0.86.0 - 2026-07-12

- Upgraded named views to schema-v3 workflow profiles covering map/layers/opacity, radar palette/preferred speed, alert threshold, all camera filters, weather units, and Auto/Standard/Low data preference. Existing v2 views migrate without resetting fields they never stored; automatic last-view persistence remains map-only; theme, locale, and favorite IDs are never overwritten.
- Added immutable Severe Weather, Wildfire Watch, and Travel Cameras presets that preserve map position and weather units. Added validation, migration, export/import, low-data speed restoration, preset immutability, and rendered round-trip coverage. Service-worker cache bumped to v59.

## v0.85.0 - 2026-07-12

- Stabilized PWA identity with the prior implicit start URL, added tested Severe Weather and Travel scene shortcuts, and supplied exact wide/narrow dark-theme install screenshots with a reproducible headless capture command.
- Added capability-gated Chromium installation, installed-state handling, Safari/iPadOS Add to Home Screen guidance, localized prompt states, and prompt failure recovery. Fixed camera-count overlap with radar controls and added manifest/install/browser tests. Service-worker cache bumped to v58 and now precaches install screenshots.

## v0.84.0 - 2026-07-12

- Expanded offline cache diagnostics with origin storage usage, quota, percentage, and persistent versus best-effort durability. A user-triggered Keep offline data action handles granted, denied, failed, and unsupported persistence requests while the existing clear action still preserves the offline app shell. Added localized and rendered storage-path coverage. Service-worker cache bumped to v57.

## v0.83.0 - 2026-07-12

- Added Automatic, Standard, and Low data modes. Automatic honors the browser Save-Data preference; Low starts radar manually, suppresses speculative frame preload, changes still-image refresh from 15 to 60 seconds, and preserves alerts and explicitly opened feeds.
- Low-data startup now validates only the camera manifest instead of downloading all 49 shards. Search exposes an explicit catalog load action, shared camera links hash-verify only the matching durable-ID shard, and Standard resumes the complete aggregate-verified generation. Added unit and headless request-count coverage. Service-worker cache bumped to v56.

## v0.82.0 - 2026-07-12

- Added a keyboard-accessible, user-triggered situation summary with localized map coordinates/zoom, radar source/coverage/age and Universal Blue light/moderate/heavy center echoes, active alert/warning counts, independently loaded wildfire perimeter counts/freshness, and the five globally nearest verified cameras.
- The summary uses structured headings and a dedicated polite announcer, supports direct alert reading and camera opening without changing map center/zoom, restores focus on close/Escape, and remains bounded/reachable on mobile and short landscape layouts. Added true nearest-verified sorting, radar-pixel classification, runtime, unit, and rendered accessibility coverage. Service-worker cache bumped to v55.

## v0.81.0 - 2026-07-12

- Added bounded incident-to-camera spatial queries for alerts and wildfire polygons, including holes, MultiPolygons, antimeridian geometry, boundary distance, relative bearing, authoritative health ranking, offline exclusion, and a 50 km/8-result ceiling with bounding-box prefiltering.
- Alert details and bounded wildfire popups now show truthful loading/no-geometry/no-result states plus camera distance/bearing/health/verification/view direction and map/open/monitor actions. Incident monitor launch atomically replaces prior selection with the top 2–4 playable cameras. Added geometry, monitor rollback, runtime, and rendered workflow coverage. Service-worker cache bumped to v54.

## v0.80.0 - 2026-07-12

- Added a distinct current-observation section for US cameras using the nearest usable NWS station, including station identity/distance, observed timestamp and localized age, conditions, temperature, humidity, wind, selected units, and explicit source.
- NWS station and hourly-forecast requests now recover independently: unusable nearer stations fall through a bounded distance-ranked list, either section can remain available when the other fails, and Open-Meteo is used only when both NWS branches fail. Added strict NWS URL/unit validation plus unit, fallback, and rendered browser coverage. Service-worker cache bumped to v53.

## v0.79.0 - 2026-07-12

- Added bounded versioned scene links that restore map center/zoom, public layer state, radar opacity/palette/playback speed/nearest frame, alert severity, camera filters, and an active camera while excluding favorites, saved views, locale, theme, and unknown private fields.
- Added Copy and Web Share actions with clipboard/manual fallbacks, safe old/invalid-link recovery that preserves local state, offline codec caching, and unit/runtime/headless browser coverage. Service-worker cache bumped to v52.

## v0.78.0 - 2026-07-12

- Added deterministic release packaging with strict parity checks across package metadata, app runtime, README badge, latest changelog, lockfile, and every tool user agent. Packaging requires a clean committed tree, rejects stale/newer tags and stale artifacts, and writes exactly `dist/StormScope-vX.Y.Z.zip`.
- ZIP entry order, timestamps, compression, and permissions are fixed; an embedded manifest records the exact commit plus every tracked file's size and SHA-256. The packager reopens and verifies all bytes/metadata before printing the final digest, with regression coverage for reproducibility, stale artifacts, and stale tags. The complete gate checks parity before tests. Service-worker cache bumped to v51.

## v0.77.0 - 2026-07-12

- Added a single fail-fast local toolchain preflight that reports actual/supported versions and paths for Python, Node.js, npm, curl, Ruff, yt-dlp, Playwright, Chromium, Firefox, and WebKit, aggregating every missing or incompatible requirement before exiting nonzero.
- Exact-pinned Python development tools in `requirements-dev.txt`, added the Python/Ruff floor in `pyproject.toml`, declared Node/npm engines and npm package-manager version, switched setup to reproducible `npm ci`, and made the complete regression gate run preflight first. Added parser/range regression tests and clean-setup documentation. Service-worker cache bumped to v50.

## v0.76.0 - 2026-07-12

- Added a compact short-height layout for 844×390 and 667×375 landscape viewports. Panels now stay within the viewport and scroll internally, search results retain a usable minimum region, modal/monitor media compresses without hiding headers, and the full radar timeline remains reachable.
- Extended headless rendered QA across both dark and light themes for layers, alerts, search, camera modal, multi-camera monitor, and radar controls. Each surface is screenshot-captured in memory and every key control is focused and scrolled into view. Service-worker cache bumped to v49.

## v0.75.0 - 2026-07-12

- Completed deterministic Spanish runtime localization for all 16 compass directions, CAP severity/urgency/certainty vocabulary, camera source taxonomy, radar degradation reasons, unavailable timestamps, and service-worker cache/recovery failures.
- NWS-authored forecast and alert prose is now visibly identified as provider text instead of appearing to be an untranslated application string. NWS weather also shows its source, camera marker titles use localized health copy, missing alert titles use a localized fallback, and deterministic Leaflet attribution prefixes no longer remain English after a locale switch. Service-worker cache bumped to v48.

## v0.74.0 - 2026-07-12

- Added an accessible, always-visible camera feed-details panel for provider frame time, StormScope verification time, device-local playback observation, source/provider, feed type, refresh cadence, and degraded reason. Missing provider evidence is stated explicitly instead of being inferred.
- Local playback results update the open panel immediately without mutating durable provider health. Removed the verification-only hover tooltip and added Chromium regression coverage for the semantic details list. Service-worker cache bumped to v47.

## v0.73.0 - 2026-07-12

- Added a bounded 50-entry local diagnostics ring for `error` and `unhandledrejection`, with URL and coordinate redaction before persistence. Synchronous boot failures and uncaught runtime failures show a localized recovery banner with reload, runtime-cache reset, and diagnostics export actions.
- Diagnostics JSON includes app version, corpus generation, provider states, aggregate cache/quota data, and redacted errors. It excludes cache keys, feed URLs, coordinates, favorites, saved views, and imported local state.
- Runtime-cache recovery deletes only data/tile caches and preserves the offline shell. Added unit, Chromium download/redaction, and Firefox/WebKit shell regression coverage. Service-worker cache bumped to v46.

## v0.72.0 - 2026-07-12

- Added reduced Firefox and WebKit browser contracts alongside the exhaustive Chromium smoke. Both engines now prove full-corpus boot, virtual search, modal open/cleanup, and a populated cached offline shell.
- Firefox verifies the real HLS.js/MSE capability path. The Windows Playwright WebKit port receives an explicit native-HLS capability shim so the app's native branch is exercised despite that port lacking the platform media stack.
- Refactored the deterministic browser server/network fixtures for reuse and added `npm run smoke:browsers`; the complete local gate installs/runs all browser contracts without remote CI.

## v0.71.0 - 2026-07-12

- Decoupled camera virtual-window painting from full-corpus search, sort, and marker synchronization. Scrolling now replaces only the visible result rows; instrumentation-backed headless coverage proves it performs no full sort, `clearLayers`, or `addLayers` work.
- Added roving keyboard navigation across the complete virtual collection. Arrow Up/Down, Page Up/Down, Home, and End keep the focused result rendered beyond the initial slice; each result exposes `aria-posinset` and `aria-setsize`, while favorite and monitor actions remain keyboard-operable on the active row.
- Added a focus-visible treatment and browser contracts that traverse from the first to the 598th filtered result. Service-worker cache bumped to v45.

## v0.70.0 - 2026-07-12

- Expanded the vendored dependency manifest to schema v2 with reviewed supplemental security advisories. Leaflet CVE-2025-69993 now has an explicit 90-day disposition tied to StormScope's DOM/`textContent` popup construction; the local gate fails on expiry, malformed dates, review windows over 180 days, missing reasons, or missing HTTPS references.
- npm update selection now rejects prerelease/canary `latest` tags and falls back to the highest stable semantic version. OSV checks remain active during live update audits.
- Added unit coverage for disposition expiry and stable-version selection plus a rendered hostile NIFC popup regression proving provider strings create no elements and execute no handlers.

## v0.69.0 - 2026-07-12

- NIFC wildfire queries now paginate in stable `OBJECTID ASC` order using the service's advertised page size until ArcGIS clears `exceededTransferLimit`, including the GeoJSON `properties` form used by the live service.
- Added bounded page caps, no-progress rejection, abort propagation, dateline-page deduplication, and a monotonically guarded request generation. A failed later page cannot replace a complete wildfire layer; the prior snapshot remains visible with an explicit incomplete state.
- Expanded unit and headless fixtures to require multiple pages and prove page-two geometry renders. Service-worker cache bumped to v44.

## v0.68.0 - 2026-07-12

- Enforced RainViewer's public request limit with a pure rolling 60-second budget capped at a conservative 90 requests. Every radar tile, invisible preload tile, coverage tile, and center-sampling image is reserved before the browser can start its request.
- Preloads are suppressed when fewer than 20 requests remain. On exhaustion, animation pauses, pending preload work is removed, the retry time is exposed, and the app switches once to NOAA/NWS MRMS without a request burst.
- Added rolling-window/retry-time unit simulation, provider health propagation, application wiring assertions, and headless network counting. Service-worker cache bumped to v43.

## v0.67.0 - 2026-07-12

- Separated device-local playback observations from durable provider health. Browser CORS/offline/unsupported/retry outcomes now persist under a canonical feed key with observation time and a bounded six-hour expiry, without changing camera `health`, `failure_class`, or `last_verified`.
- HLS is considered locally playable only after decoded media fires `loadeddata`, not when a manifest parses. Refreshing images require a second successful cache-busted load before recording a playable/advanced observation; the first load remains an initial-image observation.
- Added a headless playback contract proving observations expire, image refresh advancement is required, and local playback cannot mutate provider health evidence. Service-worker cache bumped to v42.

## v0.66.0 - 2026-07-12

- Published camera index v2 with an authoritative UTC generation time, exact health/provider/verification totals, exact on-disk shard byte hashes, and an ordered aggregate generation hash. The UI now reports indexed, verified healthy, degraded, and unverified counts instead of calling the entire corpus live, and offline freshness uses the cached generation timestamp rather than page-load time.
- Camera shards now load through generation-keyed URLs and are validated for index/schema version, descriptor totals, SHA-256 bytes, strictly increasing IDs, ranges, aggregate hash, and summary counts. A corrupt or mixed generation is discarded and replaced by the complete monolith recovery dataset.
- Changed service-worker camera routing: the root index is network-first with offline fallback, immutable generation shards are cache-first without background replacement, and only the monolith recovery path remains stale-while-revalidate. Service-worker cache bumped to v41 and runtime data cache to v2.

## v0.65.0 - 2026-07-12

- Camera IDs are now durable across provider refreshes. Explicit replacements, provider-owned camera IDs, and unchanged canonical feeds retain the existing numeric ID; ambiguous identity claims fail closed instead of silently retargeting saved favorites.
- Added an atomic camera-ID sequence high-watermark shared by provider refresh and every discovery writer. Removed IDs are never reassigned, failed writes may leave safe gaps, and the repair utility no longer renumbers the corpus.
- Updated regression coverage for URL rotation, explicit replacement, concurrent inserts, sparse IDs, and non-reuse after deletion or interrupted persistence.

## v0.64.1 - 2026-07-12

- Fixed light-theme contrast on status surfaces. Status chips, camera health badges (healthy/degraded/offline), the alert-list inset buttons, and the camera-modal scrollbar previously used colors hardcoded for the dark theme — light-pink/light-green status text and a white scrollbar thumb — which were nearly invisible on light panels. Introduced four adaptive tokens (`--bg-inset`, `--scrollbar-thumb`, `--success-text`, `--danger-text`) with dark and light values; in light mode danger text now measures 5.51:1 and success text 4.54:1 on panels (both pass WCAG AA), while dark mode is pixel-identical to before.
- Service-worker cache bumped to v40 (shell asset `css/style.css` changed).

## v0.64.0 - 2026-07-12

- Added an optional light theme. A new **Appearance** control in the layers panel offers **Match system** (follows `prefers-color-scheme` and updates live when the OS setting changes), **Always dark**, and **Always light**; the choice persists in `localStorage`. Light mode swaps the CartoDB basemap to `light_all` and overrides the semantic color tokens (`--bg-*`, `--border*`, `--accent`, `--text*`, plus new `--on-accent`/`--bg-elevated`) — layout, spacing, and component rules are shared with dark. Verified in-browser: primary text 16.98:1 and secondary text 6.36:1 contrast on light panels (both pass WCAG AA). English/Spanish labels added.
- Raised the two smallest UI type sizes (`.alerts-disclaimer`, `.radar-legend`) from 10px to an 11px floor for more comfortable reading; contrast unchanged.
- Service-worker cache bumped to v39 (shell assets changed).

## v0.63.0 - 2026-07-12

- EarthCam Network feeds now render live in the viewer instead of loading a non-playing page embed. EarthCam's HTML5 player gates live video to authorized domains and signs its HLS with a per-session token minted in the page HTML, so off-site `type: embed` rows never played. Their public network API, however, exposes a per-camera `image.php` snapshot URL that hotlinks from any origin as a real refreshing JPEG. New `scripts/convert_earthcam_snapshots.py` matches EarthCam rows to that API by page URL and rewrites the matched rows to refreshing `type: image` feeds — the same mechanism the DOT image cameras use — so the actual camera view shows in the modal.
- **256 of 276** EarthCam rows converted (each verified as a live JPEG before acceptance); the remaining **20** partner-hosted rows (myEarthCam/AbbeyRoad and moved pages) keep their page embed with the "open source" fallback link. No media is rehosted — the browser loads EarthCam's own public snapshot endpoint directly, and each row keeps its EarthCam page as `source_url` attribution.
- Corpus unchanged at **36,592**; image feeds **28,495 -> 28,751**; provider embeds **509 -> 253**; deterministic shards remain **49**; no shell/service-worker change (data-only). Pairs with the prior YouTube embed fix so both provider families now play in-app.

## v0.62.0 - 2026-07-12

- Expanded Rhode Island **143 -> 148** with current fixed views at Newport Harbor, downtown Westerly, Block Island North Light, Davisville, and East Greenwich. All five YouTube IDs remained public, embed-enabled, backed by playable HLS, manually frame-reviewed, and fixed to operator or exact-address evidence; the fresh RIDOT inventory's 139 usable rows were already present.
- Expanded Puerto Rico **22 -> 28** with the complete six-camera NSF NEON/PhenoCam inventory at Guánica, Lajas, Río Cupeyes, and Río Yahuecas. The fail-closed provider contract requires all six current JPEGs, provider timestamps, official field-site coordinates, and CC BY 4.0 attribution; 19 of 21 ACT rows remain current while two frozen provider images stay excluded.
- Expanded Washington, D.C. **9 -> 13** with two distinct Smithsonian giant-panda views, the Elephant Community Center, and a current Union Station railcam. Smithsonian refreshes now run only during the operator's **07:00-19:00 ET** live window, require all six zoo playlists to advance, and retain last-known-good rows outside that window or on partial verification. DDOT exposes 250 authoritative CCTV locations but no supported public media endpoint.
- Expanded Wyoming **15 -> 17** with Range's current Dubois town and Lava Mountain Lodge streams. Exact operator/NWS/location evidence and live browser/HLS checks passed; 757 WYDOT views remain licensing-restricted, and nine current Cheyenne BOPU images remain deferred until defensible per-camera coordinates are available.
- The bounded state batches recorded **409 candidate rejection outcomes** before acceptance, led by wrong geography/content false positives, confirmed non-live or archived streams, placeholders, unsupported players, and ambiguous locations. **45 YouTube query families** returned HTTP 403 and remain retryable rather than exhausted.
- Corpus **36,575 -> 36,592**; Rhode Island **143 -> 148**; Puerto Rico **22 -> 28**; Washington, D.C. **9 -> 13**; Wyoming **15 -> 17**; YouTube **591 -> 599**; University/PhenoCam **3 -> 9**; Smithsonian **3 -> 6**; images **28,489 -> 28,495**; HLS **6,986 -> 6,989**; deterministic shards remain **49**; service-worker cache v38.

## v0.61.0 - 2026-07-12

- Expanded Arkansas **11 -> 28** with all 17 current Hazcams weather-network stations. The fail-closed provider contract requires the complete curated inventory, current online/video metadata, provider coordinates, fresh timestamps, and advancing HLS, while StormScope stores only branded public embeds with sponsor/link-out attribution.
- Expanded Delaware **315 -> 323** with six advancing Cape May-Lewes Ferry terminal views from the official DRBA inventory and two current Delaware DNREC Mispillion Harbor streams. Copyrighted ferry media remains behind provider-published JWPlayer embeds; sensitive wildlife locations use the operators' public facility points.
- Expanded New Hampshire **185 -> 199** with 12 current exact-location YouTube streams and two current first-party university JPEGs spanning summit weather, ski, rail, beach, museum, campus, and wildlife views. The fresh 181-camera New England 511 inventory exactly matched the existing corpus.
- Expanded Connecticut **352 -> 356** with four advancing AngelCam views from Connecticut Audubon, Menunkatuck Audubon, and Friends of Hammonasset. Added explicit `angelcam`, `hazcams`, and JWPlayer schema/runtime/CSP trust contracts; expiring verification HLS tokens are never persisted.
- Re-ran the zero-camera Northern Mariana Islands gap. EarthCam Saipan still reports `cam_state=0` and a fresh HLS token returns HTTP 404; five exact YouTube query forms remain HTTP 403 rate-limited, while the successful Garapan query exhausted six continuation pages without a current fixed live camera.
- Corpus **36,532 -> 36,575**; DOT **35,395 -> 35,401**; YouTube **577 -> 591**; University **1 -> 3**; Hazcams **0 -> 17**; AngelCam **0 -> 4**; provider embeds **482 -> 509**; deterministic shards remain **49**; service-worker cache v37.

## v0.60.0 - 2026-07-12

- Expanded Kentucky from **226 to 252** state-labeled cameras. Added **23** current KYTC JPEG views from the official 250-row ArcGIS inventory and two current wildlife streams at Mill Creek and the Kentucky Equine Adoption Center. Six renamed/moved KYTC identities were replaced rather than duplicated, and Mammoth Cave's blank-state legacy embed was upgraded in place to the current Green River Bluffs NPS image. All 30 direct images and both YouTube manifests passed final probes and manual frame review.
- Expanded North Dakota from **189 to 211** with 18 advancing FAA WeatherCam airport views, the current Theodore Roosevelt Painted Canyon NPS image, and three first-party UND Clifford Hall skycams. FAA integration uses a primed public session, validates the 21-site/84-camera state inventory, fetches ephemeral images only for freshness checks, stores stable detail pages, preserves airport attribution, and adds an explicit `faa` schema/filter/embed-trust/CSP contract. Fifty-three nonadvancing recent FAA views remain retryable; 13 stale views were rejected.
- Expanded Alaska from **228 to 233** with three exact-coordinate AVO/USGS volcano images at Katmai, Redoubt, and Shishaldin plus current Round Island walrus and UAF muskox streams. The AVO contract validates first-party camera identity, coordinates, public status, timestamp, MD5, exact image URL, and repeated real JPEG responses; AVO's public-domain/credit rules are retained. Ambiguous Naknek/Valdez, domain-restricted UAS, and false-location results were excluded.
- Expanded West Virginia from **124 to 127** with all three distinct, first-party U.S. Fish and Wildlife Service NCTC eagle views. The official page fixes the intentionally public Shepherdstown campus location, current frames were manually reviewed, and each canonical ID remained public, embed-enabled, and backed by advancing HLS. The 12-family continuation sweep verified 15 live results; 12 wrong-state/composite results were rejected and nine HTTP-403 query families remain retryable.
- Built an ignored 56-jurisdiction coverage matrix without equating nonzero counts with completion; Northern Mariana Islands remains the only zero-camera jurisdiction after its prior bounded source review. YouTube verification now retries transient extractor failures with bounded exponential backoff, preventing single `no formats` responses from discarding otherwise proven live feeds.
- Corpus **36,477 -> 36,532**; Kentucky **226 -> 252** after one blank-state correction; North Dakota **189 -> 211**; Alaska **228 -> 233**; West Virginia **124 -> 127**; DOT **35,372 -> 35,395**; FAA **0 -> 18**; NPS **196 -> 197**; USGS **29 -> 32**; YouTube **567 -> 577**; deterministic shards remain **49**; service-worker cache v36.

## v0.59.0 - 2026-07-12

- Expanded Maine from **146 to 149** with the current Acadia McFarland Hill NPS air-quality image, an independently advancing MaineDOT Rockland Ferry Terminal image, and the public/embeddable Audubon/Explore Hog Island osprey stream. Official station, terminal, and operator evidence fixes all three locations; Burnt Coat Harbor and other restricted, archived, unsupported, ambiguous, or rate-limited candidates remain rejected or retryable.
- Expanded Mississippi from **160 to 162** with Mississippi State University's first-party advancing campus HLS feed and the fixed west-facing Corinth Crossroads Museum railcam. Added a truthful `university` source/filter/CSP contract instead of mislabeling the campus feed. Twenty-four current live search results were manually rejected as wrong-state matches, while nine YouTube query families that returned HTTP 403 remain retryable.
- Expanded South Dakota from **184 to 186** with two first-party South Dakota Mines campus streams. Both canonical IDs were rechecked current-live, public, embed-enabled, fixed to the operator-published campus, and backed by advancing HLS media immediately before import; the unavailable Dino/M Hill feeds and stale SDPB host were not accepted.
- Expanded West Virginia from **120 to 124** by adding three domain-unlocked, first-party Canaan Valley Resort IPCamLive views and replacing the unlocated Canyon Rim NPS page embed with its current direct image and exact Fayette County metadata. The Babcock State Park image advanced during discovery but failed its immediate precommit freshness recheck, so it remains a fail-closed retry instead of entering the corpus; ResortCams is licensing-restricted and Winterplace retains a TLS blocker.
- YouTube overrides now preserve operator/category/provider identity through the transactional discovery writer. New provider integrations retain last-known-good data on partial or stale verification, direct media origins are explicitly CSP-approved, and all accepted YouTube/HLS feeds passed final current-live, embedding, manifest, segment-availability, and advancement probes.
- Corpus **36,467 -> 36,477**; Maine **146 -> 149**; Mississippi **160 -> 162**; South Dakota **184 -> 186**; West Virginia **120 -> 124** after one blank-state correction; DOT **35,371 -> 35,372**; NPS **195 -> 196**; IPCamLive **19 -> 22**; YouTube **563 -> 567**; University **0 -> 1**; deterministic shards remain **49**; service-worker cache v35.

## v0.58.0 - 2026-07-12

- Expanded New Jersey from **14 to 144** accurately located cameras. Added **129** New Jersey Turnpike Authority Turnpike/Parkway HLS views from the first-party embedded inventory with official coordinates and FCC-cross-checked counties. All 129 advanced across repeated manifest/segment probes; **132** active frames were manually reviewed, with three mispointed views rejected and five repeatable HLS 404s retained as confirmed dead.
- Expanded Montana from **39 to 49** with all nine current Glacier National Park JPEG views plus the University of Montana/Cornell Hellgate Osprey nest stream. Every NPS image advanced across its one-minute provider cadence, carried a fresh provider timestamp, and passed manual review; the wildlife stream passed public/embed/current-live metadata and advancing-HLS checks at its intentionally public viewing point.
- Expanded Vermont from **93 to 96** with Rikert Outdoor Center and two Sugarbush Allyn's Lodge cameras, and Rhode Island from **139 to 143** with all four official URI Kingston/Narragansett campus players. The five new YouTube streams and four URI players passed an immediate batch recheck for active manifests, advancing segments, public embedding, exact operator locations, and canonical identities.
- Added fail-closed NJTA, Glacier NPS, and URI provider contracts plus curated location overrides. A partial provider response cannot replace the accepted set. Deferred an active Angelcam because the schema has no truthful source value; retained MDT authentication/stable-URL work, a black Montana FWP placeholder, unresolved Glacier mount points, YouTube continuation timeouts/403s, and other transient sources as retryable.
- Corpus **36,320 -> 36,467**; New Jersey **14 -> 144**; Rhode Island **139 -> 143**; Vermont **93 -> 96**; Montana **39 -> 49**; DOT **35,242 -> 35,371**; NPS **186 -> 195**; IPCamLive **15 -> 19**; YouTube **558 -> 563**; deterministic shards remain **49**; service-worker cache v34.

## v0.57.0 - 2026-07-12

- Added the first accepted American Samoa camera: Clipper Oil's fixed Pago Pago Harbor view. The first-party page identifies the southern-harbor office/warehouse location, and the independently mapped point was cross-checked against Fagatogo, Maoputasi County, the operator description, and the visible harbor geometry.
- Added a fail-closed Clipper Oil/IPCamLive provider contract that resolves the operator-published, domain-unlocked player but stores only IPCamLive's public two-minute snapshot endpoint. Acceptance requires a real current JPEG, a fresh provider timestamp, and advancing content across repeated probes; dead rotating HLS URLs are never persisted, and the existing last-known-good row survives any later verification failure.
- Searched American Samoa, Guam, and Northern Mariana Islands official, operator, destination, public-land, transportation, science, weather, and YouTube families. Held the exact-location Saipan EarthCam and Guam GCIC South IPCamLive cameras as retryable `confirmed_not_live`; rejected archived, mobile, composite, wrong-location, and unrelated live results. Direct YouTube continuation searches eventually returned HTTP 403 and remain retryable rather than being treated as exhaustion.
- Corpus **36,319 -> 36,320**; American Samoa **0 -> 1**; IPCamLive **14 -> 15**; deterministic shards remain **49**; service-worker cache v33.

## v0.56.0 - 2026-07-12

- Expanded Hawaii from **13 to 37** accurately located cameras. Added **14** current, manually reviewed, public-domain USGS Hawaiian Volcano Observatory/NIMS images across Kilauea and Mauna Loa. Each curated camera uses official provider coordinates, a direct HTTPS JPEG, an explicit cadence, a fresh provider timestamp, and a fail-closed refresh contract that retains the complete last-known-good set on any partial verification failure.
- Searched **56** statewide, island, city, landmark, park, beach, harbor, airport, resort, weather, wildlife, volcano, surf, traffic, and operator YouTube families at up to 100 results per family. Added **11** exact-location public/embeddable streams across USGS HVO, Waikiki Aquarium, Explore.org, Maui resorts, Poipu Bay, Subaru Telescope, and CFHT; all passed immediate current-live metadata, playable HLS, segment-advancement, and embedding checks.
- Removed the existing `mLYWolyZxuM` Oahu tour because it rotates among Waikiki, North Shore, and Diamond Head views and therefore cannot support the single fixed Honolulu coordinate previously assigned to it. Deferred two ambiguous views, one embed-disabled live stream, one transient USGS stream, and the nonadvancing MEGA Lab HLS candidate; composite, mobile, recorded, music, commentary, and unauthorized relay results were also rejected.
- Resolved the current first-party GoAkamai inventory and audited all **361** coordinate-backed records. Although **280** unique camera identities were technically live, the controlling disclaimer prohibits publication, display, or distribution without written HDOT and Honolulu DTS permission, so every feed remains `licensing_restricted`. All 27 Maui cameras were disabled placeholders; the audit also found 78 placeholders and three duplicate/location-mismatched feeds.
- Corpus **36,295 -> 36,319**; Hawaii **13 -> 37**; YouTube **548 -> 558** after 11 additions and one composite removal; USGS **15 -> 29**; deterministic shards remain **49**; service-worker cache v32.

## v0.55.0 - 2026-07-12

- Expanded Minnesota from **9 to 1,723** accurately located cameras. Replaced both stale MnDOT fetch paths with the current first-party Minnesota 511 CARS inventory and its official coordinates, view IDs, timestamps, and HTTPS media. Of 1,527 public locations / 1,941 unique views, the shipped conservative intersection contains **1,084 advancing HLS streams** and **603 advancing JPEG views**; every accepted frame was manually reviewed across contact sheets.
- MnDOT verification now fails closed on truncated inventories, fetches current HLS segments, requires playlist advancement, retries only transient failures at lower concurrency, and probes still images across the provider's 15-minute cadence before accepting content changes. Held 165 HLS views (159 repeated playlist 404/503 and 6 current segment 404), 58 unchanged three-probe images, 15 no-media rows, 12 XML/403 image responses, and four independently advancing images that were not present in the transactional verifier's accepted intersection; all remain retryable and no partial snapshot can replace last-known-good rows.
- Added **12** current, manually reviewed USGS NIMS river cameras with official monitoring-site coordinates/counties and public-domain provenance. The provider contract requires real current JPEGs on repeated probes, retains the complete curated set on any partial failure, and records exact provider timestamps.
- Searched all **855 Minnesota Census places** at five-page-equivalent depth plus **32** statewide, operator, transportation, park, lake, rail, airport, harbor, wildlife, and weather families (**887 query families**). Added **13** freshly reverified public/embeddable YouTube cameras spanning Minnesota DNR, Lakeland PBS, International Wolf Center, Xcel Energy, Duluth Harbor, and BNSF rail views; the Aitkin candidate was removed after its immediate precommit recheck lost all video formats, while the other accepted IDs retained current live status and playable HLS media.
- Corrected three false locations: Western Harbor moved from Edinburgh to Lincoln Park Middle School in Duluth, Pier B moved to its Duluth waterfront facility, and Two Harbors Boat Launch moved from the same impossible shared Duluth point to the official Agate Bay access. Broad, sensitive, unsupported, reuse-restricted, stalled, archived, wrong-state, and transient candidates remain rejected or retryable.
- Corpus **34,583 -> 36,295**; Minnesota **9 -> 1,722**; YouTube **535 -> 548**; USGS **3 -> 15**; deterministic shards **47 -> 49**; service-worker cache v31.

## v0.54.0 - 2026-07-12

- Expanded Massachusetts from **7 to 49** accurately located cameras. Added all eight current one-minute Boston National Historical Park monument views and three current Boston Light directions after repeated provider-timestamp checks and manual frame review. Boston Light South was rejected because its embedded May 19 frame timestamp remained stale even while HTTP metadata appeared fresh.
- Added two advancing first-party Massachusetts Water Resources Authority HLS feeds at Deer Island and Cosgrove/Wachusett Reservoir. Quabbin's technically live feed remains excluded because the operator warns and visual review confirms that maintenance scaffolding obscures the view. Added the `mwra` schema, source filter, CSP, fail-closed provider contract, report, and browser coverage.
- Searched all **58 Massachusetts Census cities** at five-page-equivalent depth plus **26** statewide, operator, rail, weather, harbor, landmark, airport, wildlife, campus, and beach query families. Added **30** exact-location public/embeddable YouTube cameras spanning Massachusetts Maritime Academy, Chatham, UMass, Springfield/Chester/Ayer rail, Newburyport, Boston, Fitchburg, Beverly, Nahant, Turners Falls, Woods Hole, and Provincetown. Every accepted canonical ID was rechecked live with an advancing HLS playlist and available segments.
- Removed the June 18 Boston Logan storm recording after repeat yt-dlp and YouTube player evidence confirmed `was_live`, no HLS formats, `isLiveNow=false`, and a final end timestamp. The YouTube auditor now supports repeatable exact `--video VIDEO_ID` targeting while retaining transactional backup and rollback behavior.
- Mass511 research covered all **304** active rows: 147 currently return real images and 157 return identical temporary-unavailable placeholders. MassDOT explicitly directs third parties to coordinate a unique TrafficLand API feed, so the working images remain `licensing_restricted`; legacy TrafficLand tokens are `authentication_required`. Boston BTD, Springfield, Cambridge, Steamship Authority, airports, transit, ports, science, resort, and university families were also classified without inventing feeds or coordinates.
- Corpus **34,541 -> 34,583**; Massachusetts **7 -> 49**; YouTube **506 -> 535** after 30 additions and one archived removal; NPS **175 -> 186**; MWRA **0 -> 2**; provider embeds remain **459**; deterministic shards remain **47**; service-worker cache v30.

## v0.53.0 - 2026-07-12

- Expanded Tennessee from **6 to 677** accurately located cameras. Added **635** current TDOT SmartWay HLS views from the production public RoadwayCameras API after grouping probes by the five SkyVDN hosts, requiring advancing live playlists and segments, and manually reviewing every accepted frame. Rejected four duplicated legacy IDs, three maintenance/offline placeholders, two movable trailer cameras, one dead endpoint, and 22 transient rows that remain retryable.
- Added all **13** active City of Clarksville intersection cameras from its first-party traffic page. Each stable IPCamLive alias had to be available, domain-unlocked, exact-location matched, and backed by advancing HLS; the inactive 2nd/Riverside player was rejected. Franklin's 39 technically live cameras remain excluded because every player is domain-locked and direct HLS use would bypass that restriction.
- Replaced the stale Look Rock NPS page embed with its current public-domain 15-minute JPEG and added the current Kuwohi NPS still. Public-land research also held six temporarily stale NEON feeds and excluded inaccessible, ambiguous, or reuse-restricted aquarium, river, weather, and park candidates.
- Searched all **182 Tennessee Census cities** with five-page-equivalent YouTube result depth plus **36** statewide, operator, transportation, rail, landmark, weather, and wildlife query families. Added **21** exact-location fixed cameras, all rechecked live, public, embed-enabled, and backed by active HLS; 20 candidates were rejected for duplicates, composites, moving/mobile views, ambiguous/private or sensitive locations, and transient final playback.
- Corpus **33,871 -> 34,541**; Tennessee **6 -> 677**; DOT **32,920 -> 33,555**; YouTube **485 -> 506**; NPS **174 -> 175**; IPCamLive **1 -> 14**; provider embeds **447 -> 459**; deterministic shards **46 -> 47**; service-worker cache v29.

## v0.52.0 - 2026-07-12

- Expanded New Mexico from **6 to 199** accurately located cameras. The production NMRoads v5 inventory now uses its HTTPS image proxy and authoritative provider epochs; **174 of 183** enabled records passed repeated current-JPEG and 65-second advancement probes. Four empty feeds were classified `confirmed_dead`, two stale/reconnecting frames `placeholder`, and three non-advancing rows were withheld for retry.
- Added three five-minute NOAA/NWS Albuquerque views, three current public-domain USGS canyon/Rio Ruidoso views, the current Valles Caldera Cabin District NPS still, and the 15-second NRAO Very Large Array view. The VLA requires changed cache-busted frames; Valles replaced its stale page embed in place. NOAA, USGS, and NRAO now have schema/source filters and browser coverage.
- Searched all 37 New Mexico Census cities with two query forms and five-page-equivalent result depth plus 30 statewide, category, and operator query families. Added 11 canonical YouTube fixed cameras spanning Carlsbad Caverns wildlife, Belen/Gallup/Grants/Santa Fe/Las Vegas/Melrose railcams, Las Vegas street/plaza views, and downtown Roswell. All rechecked `is_live`, public, embed-enabled, and playable with active advancing HLS; the Carlsbad stream replaced its stale NPS embed, so the YouTube batch is +10 net.
- Held or rejected 13 public-land candidates (stale/daylight-paused USGS frames, a station/coordinate mismatch, five Taos HLS views without exact first-party mount/usage evidence, stale Elephant Butte, inaccessible/bad-coordinate El Morro, and a transiently rate-limited Carlsbad probe later recovered) and seven relevant live YouTube results (duplicate, wrong-state/country, ambiguous, or unofficial relays). The ABQRoads mirror was deduplicated against NMRoads; HTTP-only NMRoads HLS remains excluded.
- Corpus **33,680 -> 33,871**; DOT **32,746 -> 32,920**; YouTube **474 -> 485**; NPS **175 -> 174** after two embed replacements and one direct addition; NOAA **0 -> 3**; USGS **0 -> 3**; NRAO **0 -> 1**; provider embeds **449 -> 447**; deterministic shards **45 -> 46**; service-worker cache v28.

## v0.51.0 - 2026-07-12

### Verified Wyoming national-park, landmark, and downtown cameras
- Added seven current NPS still-image feeds at Yellowstone and Devils Tower plus Old Faithful's advancing first-party HLS stream. Five stale NPS page embeds were replaced in place with direct feeds, correcting blank state labels and the false Mount Washburn coordinate; all stills supplied current provider timestamps across repeated probes.
- Added the NPS-embedded Grand Teton Craig Thomas Visitor Center stream and Visit Laramie's Downtown Laramie camera. Both canonical YouTube IDs were rechecked live, public, embed-enabled, backed by active HLS formats, and written through exact first-party location overrides.
- Added bounded NPS snapshot freshness verification, Old Faithful HLS advancement verification, transactional source-page replacement, Pixelcaster CSP coverage, an ignored provider report, and regression coverage. SeeJH and Virtual Railfan feeds remain licensing-restricted; Afton Airport is not embeddable; other researched state-park, weather, wildlife, and mountain feeds were dead, seasonal, authenticated, transient, or location-ambiguous.
- WYDOT research recovered 228 exactly located sites and 757 advancing views from its current protobuf map inventory. Every frame is marked all-rights-reserved and no third-party hotlink/embed grant is published, so no WYDOT row was retained; the provider remains `licensing_restricted` pending written permission.
- Corpus **33,675 -> 33,680**; Wyoming **5 -> 15**; NPS **172 -> 175**; YouTube **472 -> 474**; provider embeds **454 -> 449**; service-worker cache bumped to v27.

## v0.50.0 - 2026-07-12

### +10 verified Arkansas rail, wildlife, river, weather, and lake cameras
- Added five exact-location YouTube feeds: Virtual Railfan at Russellville and Texarkana, SouthWest RailCams at the Decatur Depot, Calico Rock Trout Dock on the White River, and Estes Ace Harrison weather. Added four distinct Turpentine Creek Wildlife Refuge enclosure views using the intentionally public refuge location rather than inferring sensitive habitat coordinates.
- Added Cobblestone Resort's first-party Norfork Lake camera through its stable RTSP.me player. The verifier resolves but never stores the expiring HLS target, requires available segments and advancing media sequences, and re-resolves the token with bounded backoff after a single transient probe; the final accepted run advanced cleanly.
- Added the `rtspme` source, exact embed-host trust policy, CSP permission, source filter, transactional provider refresh, ignored attribution/location report, and regression/browser coverage. His Place Resort was initially live but withdrawn before commit because its JSON-LD coordinate conflicts with its mapped street address; Rogers and several weather/observatory feeds remain location-ambiguous or unsupported.
- ARDOT/iDriveArkansas publishes hundreds of live views but explicitly prohibits embedding, direct or indirect camera links, and third-party apps using its camera data; all 546 researched view records remain `licensing_restricted` and were not probed. Other rejects include two authentication-required rail companions, one dead stream, three non-fixed programs, one wrong-state feed, and a licensing-restricted airport camera.
- Corpus **33,665 -> 33,675**; Arkansas **1 -> 11**; YouTube **463 -> 472**; provider embeds **453 -> 454**; RTSP.me **0 -> 1**; service-worker cache bumped to v26.

## v0.49.0 - 2026-07-12

### +4 verified Washington, D.C. wildlife and landmark cameras
- Added three first-party Smithsonian National Zoo HLS cameras: two distinct Naked Mole-Rat views at the official Small Mammal House location and the Lion Cam at the official Great Cats exhibit. Every manifest lacked `#EXT-X-ENDLIST`, exposed available media segments, and advanced across repeated eight-second probes; replay-scheduled panda and elephant feeds were rejected outside their stated live hours.
- Added earthTV's fixed White House YouTube camera using the operator's exact Associated Press building coordinate. The canonical 11-character ID was independently verified live, public, embed-enabled, and backed by active HLS formats; StormScope stores only the YouTube ID and does not retain the direct media URL.
- Added a dedicated `smithsonian` schema/runtime source, source filter, exact Zoo media CSP allowlist, provider refresh with transactional retention, ignored attribution/license report, and regression/browser coverage. U.S. Senate Capitol and Union Station rail cameras remain `location_ambiguous`; EarthTV's direct player is licensing-restricted; DC EarthCam/NPS results were duplicates or dead.
- DDOT research covered 250 official location rows and 314 asset rows but found no public media URLs. Operational feeds are restricted, the old 2023 SkyVDN family produced 20/20 HTTP 404s with a mismatched TLS certificate, and the public DDOT app repeatedly returned HTTP 500; all remain excluded or retryable. Corpus **33,661 -> 33,665**; DC **5 -> 9**; YouTube **462 -> 463**; Smithsonian **0 -> 3**; service-worker cache bumped to v25.

## v0.48.0 - 2026-07-12

### Prevent Census-city false geocodes for state-name collisions
- Hardened the dedicated Census-city YouTube location gate so a city whose name is also a different state name must appear with its explicit target state in the verified title. This prevents `Washington, DC` from accepting live cameras in Leavenworth, Washington merely because their titles contain “Washington.”
- Added a focused regression proving Leavenworth, Washington is rejected for the District while an explicit Washington DC camera title remains eligible. Re-ran the District search through eight continuation pages: the three live Leavenworth streams that previously reached the location stage are now rejected before verification, with no dataset or checkpoint write.
- Corpus remains **33,661**; the ignored report preserves the five remaining candidates, zero verified-live accepts, and 193 content rejections for continued DC research.

## v0.47.0 - 2026-07-12

### +26 verified U.S. Virgin Islands destination cameras
- Added 25 fixed-location YouTube cameras from CamStreamer's current first-party USVI map inventory after manual title/channel review and independent live verification. Every accepted video reports live status, permits embedding, exposes an active HLS format, and was rechecked from its canonical 11-character ID; coverage spans St. Croix beaches and resorts plus St. John bays, villas, parks, town views, and destination venues.
- Added EarthCam's active Mountain Top Overlook on St. Thomas from its canonical page, which currently reports `cam_state=1`, `defaulttab=live`, and `liveon=true`. The bulk EarthCam inventory API returned HTTP 429 and remains retryable; the direct page was available and no media was copied or rehosted.
- Corrected the existing Beach Bar St. John stream from a false Antigua geocode to the first-party Cruz Bay coordinate, refined the Lime Out St. Thomas coordinate, and normalized all legacy territory labels to `U.S. Virgin Islands`. Rejected an unavailable Sapphire Beach stream, a Christiansted view colocated with the existing St. Croix EarthCam, three location-ambiguous feeds, and one archived recording.
- Corpus **33,635 -> 33,661**; U.S. Virgin Islands **4 -> 30**; YouTube **437 -> 462**; EarthCam **275 -> 276**; provider embeds **452 -> 453**; service-worker cache bumped to v24.

## v0.46.0 - 2026-07-12

### First verified Guam camera: Guam National Tennis Center
- Added the Guam National Tennis Federation's fixed Dededo court camera from its first-party homepage. The provider resolves the stable IPCamLive alias to the current rotating HLS stream, requires an available/domain-unlocked player, valid advancing media playlists and current segments, then stores only the stable authorized embed URL.
- Used the operator and Government of Guam venue evidence for the exact `13.509444, 144.826667` location. The record is classified as an `ipcamlive` sports/destination source rather than being mislabeled DOT, EarthCam, or YouTube.
- Added the `ipcamlive` schema/source contract, exact embed-host trust policy and CSP frame permission, while retaining the existing hostile-lookalike checks. The ignored report records source, location evidence, attribution, viewer terms, current resolved stream, and cadence.
- Pacific-territory research rejected Saipan EarthCam (provider offline and repeat HLS 404), Guam GCIC (offline/upcoming), American Samoa NPS weather station (offline/no camera), and 603 broad YouTube results that were archived, mobile, news/storm coverage, or not fixed live cameras. Corpus **33,634 → 33,635**; Guam **0 → 1**; provider embeds **451 → 452**; service-worker cache bumped to v23.

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
