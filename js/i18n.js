/* StormScope locale catalog, formatting, and document translation. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DEFAULT_LOCALE = 'en';
  var STORAGE_KEY = 'stormscope-locale';
  var catalogs = {
    en: {
      'app.title': 'StormScope — Live Weather Radar & Webcams',
      'language.label': 'Language', 'language.en': 'English', 'language.es': 'Spanish',
      'map.label': 'Weather radar and camera map', 'header.search': 'Find cameras', 'header.layers': 'Toggle layers panel',
      'connection.online': 'Online', 'connection.offline': 'Offline',
      'update.ready': 'A StormScope update is ready.', 'update.apply': 'Apply update', 'update.updating': 'Updating…',
      'layers.heading': 'Layers', 'layers.radar': 'Weather Radar', 'layers.cameras': 'Live Cameras',
      'layers.coverage': 'Radar Coverage', 'layers.alerts': 'NWS Alerts', 'layers.opacity': 'Radar Opacity',
      'layers.lightning': 'Lightning Density', 'layers.wildfires': 'Current Wildfire Perimeters',
      'layers.mapLabel': 'Map layers', 'layers.opacityAria': 'Radar opacity',
      'units.label': 'Weather units', 'units.us': 'US (°F, mph)', 'units.metric': 'Metric (°C, km/h)',
      'radar.playback': 'Radar playback', 'radar.manual': 'Manual only', 'radar.half': '0.5× speed',
      'radar.normal': '1× speed', 'radar.double': '2× speed', 'radar.presentation': 'Radar presentation',
      'radar.standard': 'Standard', 'radar.colorblind': 'Color-vision friendly', 'radar.contrast': 'High contrast',
      'alerts.minimum': 'Minimum alert severity', 'alerts.all': 'All alerts', 'alerts.minor': 'Minor+',
      'alerts.moderate': 'Moderate+', 'alerts.severe': 'Severe+', 'alerts.extreme': 'Extreme only',
      'radar.pending': 'Radar provider pending…', 'radar.intensity.light': 'Light',
      'radar.intensity.moderate': 'Moderate', 'radar.intensity.heavy': 'Heavy',
      'radar.legend.standard': 'Standard radar precipitation intensity scale: light, moderate, heavy',
      'radar.legend.colorblind': 'Color-vision-friendly blue to red precipitation intensity scale: light, moderate, heavy',
      'radar.legend.contrast': 'High-contrast precipitation intensity scale: light, moderate, heavy',
      'cache.checking': 'Checking offline cache…', 'cache.clear': 'Clear cached data',
      'cache.requiresHttp': 'Offline cache requires HTTP or HTTPS.', 'cache.clearing': 'Clearing cached data…',
      'cache.usage': 'Offline cache: {bytes} in {count} items',
      'cache.full': 'Offline cache is full. Clear cached data and retry.',
      'cache.writeFailed': 'Offline cache could not save new data.', 'cache.unavailable': 'Offline cache unavailable: {error}',
      'views.name': 'Saved view name', 'views.placeholder': 'e.g. Gulf storms', 'views.save': 'Save',
      'views.saved': 'Saved views', 'views.choose': 'Choose a view', 'views.load': 'Load', 'views.delete': 'Delete',
      'views.export': 'Export', 'views.import': 'Import', 'views.savedStatus': 'View saved locally.',
      'views.saveError': 'Unable to save view: {error}', 'views.loaded': 'Loaded “{name}”.',
      'views.deleted': 'Deleted “{name}”.', 'views.exported': 'Saved state exported.',
      'views.imported': 'Saved state imported and validated.', 'views.importRejected': 'Import rejected: {error}',
      'views.importReadError': 'Import failed while reading the file.',
      'views.lastSaveError': 'Last view could not be saved: {error}',
      'views.recovered': 'Recovered saved state from the last valid backup.',
      'views.corrupt': 'Saved state was corrupt and was safely reset.',
      'views.sessionOnly': 'Browser storage is unavailable; changes last only for this session.',
      'search.heading': 'Find cameras', 'search.loadingIndex': 'Loading camera index…',
      'search.field': 'Name, road, state, or county', 'search.placeholder': 'Search 34,541 cameras',
      'search.state': 'State or country', 'search.all': 'All', 'search.source': 'Source', 'search.feedType': 'Feed type',
      'search.image': 'Image', 'search.hls': 'HLS video', 'search.mjpeg': 'MJPEG', 'search.embed': 'Embed',
      'search.sort': 'Sort', 'search.sortName': 'Name', 'search.sortDistance': 'Distance from map center',
      'search.healthy': 'Healthy only', 'search.favorites': 'Favorites only',
      'search.resultsLabel': 'Camera search results', 'search.indexPending': 'Camera index is still loading.',
      'search.favoriteError': 'Unable to save favorite: {error}',
      'search.results': '{count} {label}{map}', 'search.resultOne': 'result', 'search.resultMany': 'results',
      'search.shownOnMap': ' shown on map', 'search.loaded': '{count} loaded',
      'search.shards': '{loaded}/{total} shards', 'search.loadFailed': 'Camera loading failed',
      'monitor.selection': '{count} of 4 selected', 'monitor.maximum': 'You can monitor up to four cameras.',
      'monitor.bandwidth': 'Multiple live feeds can use significant bandwidth.', 'monitor.start': 'Start monitor',
      'monitor.startCount': 'Start monitor ({count})', 'monitor.add': 'Add {name} to monitor',
      'monitor.remove': 'Remove {name} from monitor', 'monitor.heading': 'Multi-camera monitor',
      'monitor.subtitle': 'Only visible feeds stay active.', 'monitor.close': 'Close multi-camera monitor',
      'monitor.unsupported': 'This provider cannot be embedded safely in multi-camera view.',
      'monitor.openSource': 'Open camera source', 'monitor.loadError': 'This feed could not be started.',
      'camera.loadingCount': 'Loading camera index…', 'camera.countProgress': '{loaded} of {total} cameras',
      'camera.count': '{count} cameras', 'camera.failed': 'Failed to load cameras',
      'camera.firstBatch': '{count} loaded • first batch {milliseconds} ms',
      'camera.feedLabel': '{name} — {health} feed', 'camera.favoriteAdd': 'Add {name} to favorites',
      'camera.favoriteRemove': 'Remove {name} from favorites', 'camera.favorite': '☆ Favorite',
      'camera.favorited': '★ Favorited', 'camera.health.healthy': 'Verified healthy',
      'camera.health.degraded': 'Degraded', 'camera.health.offline': 'Offline',
      'camera.health.unknown': 'Not yet verified', 'camera.lastVerified': 'Last verified {time}',
      'camera.dataUnavailable': 'Camera data unavailable', 'camera.offlineCache': 'Offline cache • {time}',
      'camera.stale': 'Stale cameras • {time}', 'camera.fresh': 'Cameras • {time}',
      'camera.feedLoading': 'Loading camera feed…', 'camera.weatherLoading': 'Fetching weather…',
      'camera.feedRetry': 'Retry feed', 'camera.retrying': 'Retrying camera feed…',
      'camera.openSource': 'Open source', 'camera.reload': 'Reload feed',
      'camera.paused': 'Feed paused while this tab is hidden.',
      'camera.autoRefresh': 'Auto-refreshes every 15s',
      'camera.liveStream': 'Live stream', 'camera.liveMjpeg': 'Live MJPEG stream', 'camera.youtubeLive': 'YouTube live stream',
      'feed.embedTimeout': 'The embedded feed did not finish loading.',
      'feed.streamUnavailable': 'Stream unavailable. The camera may be offline or blocked by CORS.',
      'feed.hlsUnsupported': 'HLS playback is not supported in this browser.',
      'feed.cameraUnavailable': 'Camera feed unavailable. The camera may be offline.',
      'feed.untrusted': 'This embed source is not trusted.',
      'feed.embedUnavailable': 'Embed unavailable. The camera page may be offline.',
      'feed.imageUnavailable': 'Camera image unavailable. The camera may be offline.',
      'weather.unavailable': 'Weather data unavailable for this location.', 'weather.temperature': 'Temperature',
      'weather.conditions': 'Conditions', 'weather.wind': 'Wind', 'weather.humidity': 'Humidity',
      'weather.forecastIssued': 'Forecast issued', 'weather.forecastValid': 'Forecast valid',
      'weather.observed': 'Observed', 'weather.source': 'Source', 'weather.notAvailable': 'N/A',
      'weather.openMeteo': 'Open-Meteo', 'weather.openMeteoFallback': 'Open-Meteo fallback',
      'weather.unknown': 'Unknown', 'weather.code.unknown': 'Unknown', 'weather.code.clear': 'Clear sky',
      'weather.code.mainlyClear': 'Mainly clear', 'weather.code.partlyCloudy': 'Partly cloudy', 'weather.code.overcast': 'Overcast',
      'weather.code.fog': 'Fog', 'weather.code.rimeFog': 'Rime fog', 'weather.code.lightDrizzle': 'Light drizzle',
      'weather.code.moderateDrizzle': 'Moderate drizzle', 'weather.code.denseDrizzle': 'Dense drizzle',
      'weather.code.slightRain': 'Slight rain', 'weather.code.moderateRain': 'Moderate rain', 'weather.code.heavyRain': 'Heavy rain',
      'weather.code.slightSnow': 'Slight snow', 'weather.code.moderateSnow': 'Moderate snow', 'weather.code.heavySnow': 'Heavy snow',
      'weather.code.snowGrains': 'Snow grains', 'weather.code.slightShowers': 'Slight showers',
      'weather.code.moderateShowers': 'Moderate showers', 'weather.code.violentShowers': 'Violent showers',
      'weather.code.slightSnowShowers': 'Slight snow showers', 'weather.code.heavySnowShowers': 'Heavy snow showers',
      'weather.code.thunderstorm': 'Thunderstorm', 'weather.code.slightHail': 'Thunderstorm with slight hail',
      'weather.code.heavyHail': 'Thunderstorm with heavy hail',
      'alerts.heading': 'Active NWS alerts', 'alerts.loading': 'Loading…', 'alerts.refreshing': 'Refreshing…',
      'alerts.unavailable': 'Unavailable', 'alerts.retryScheduled': 'Unavailable • retry scheduled',
      'alerts.none': 'No active alerts in view', 'alerts.countOne': '1 alert', 'alerts.countMany': '{count} alerts',
      'alerts.expiresSummary': '{severity} • expires {time}', 'alerts.area': 'Area', 'alerts.effective': 'Effective',
      'alerts.expires': 'Expires', 'alerts.severity': 'Severity', 'alerts.details': 'Details',
      'alerts.instructions': 'Instructions', 'alerts.officialSource': 'Official alert source',
      'alerts.hideDetail': 'Hide alert details',
      'alerts.disclaimer': 'Informational only. Follow instructions from weather.gov and local authorities.',
      'alerts.disclaimerBefore': 'Informational only. Follow instructions from', 'alerts.disclaimerAfter': 'and local authorities.',
      'severity.extreme': 'Extreme', 'severity.severe': 'Severe', 'severity.moderate': 'Moderate',
      'severity.minor': 'Minor', 'severity.unknown': 'Unknown',
      'modal.source': 'Source', 'modal.close': 'Close camera viewer',
      'radar.controls': 'Past radar timeline', 'radar.frameControls': 'Radar frame controls',
      'radar.previous': 'Previous radar frame', 'radar.playPause': 'Play or pause radar animation',
      'radar.next': 'Next radar frame', 'radar.loading': 'Loading radar…', 'radar.retry': 'Retry',
      'radar.previousTitle': 'Previous frame', 'radar.playTitle': 'Play/Pause', 'radar.nextTitle': 'Next frame',
      'modal.closeTitle': 'Close',
      'radar.loadingPast': 'Loading past radar…', 'radar.unavailable': 'Past radar is unavailable.',
      'radar.providersUnavailable': 'RainViewer and NOAA/MRMS unavailable • {error}',
      'radar.tileFallback': 'RainViewer tiles failed • trying NOAA/NWS MRMS…',
      'radar.tilesUnavailable': 'Radar tiles are unavailable.', 'radar.framePosition': 'Frame {current} of {total}',
      'radar.fallbackSuffix': ' (fallback)', 'radar.resolution.rainviewer': 'Public tile pyramid through zoom 7',
      'radar.resolution.noaa-mrms': 'Quality-controlled 1 km composite', 'radar.degraded': 'degraded: {reason}',
      'radar.pastFrame': '{time} • Past radar • {age}', 'radar.state.clear': 'Clear at map center • {age}',
      'radar.state.noCoverage': 'No radar coverage at this location • {age}',
      'radar.state.stale': 'Radar data is stale • {age}', 'radar.ageUnknown': 'age unknown',
      'radar.ageNow': 'just now', 'radar.ageOne': '1 minute old', 'radar.ageMany': '{count} minutes old',
      'context.lightningOff': 'Lightning off', 'context.wildfiresOff': 'Wildfires off',
      'context.loading': 'Loading official data…', 'context.unavailable': 'Official data unavailable; retry scheduled',
      'context.refreshFailed': 'Refresh failed • showing previous official data',
      'context.fresh': 'fresh', 'context.stale': 'stale',
      'context.lightningStatus': '15 min density • {freshness} • {time}',
      'context.wildfireStatus': '{count} wildfire perimeters • {freshness} • {time}',
      'context.wildfireName': 'Unnamed wildfire', 'context.acres': '{count} acres',
      'context.contained': '{count}% contained', 'context.nifcSource': 'Open official NIFC record'
    },
    es: {
      'app.title': 'StormScope — Radar meteorológico y cámaras web en vivo',
      'language.label': 'Idioma', 'language.en': 'Inglés', 'language.es': 'Español',
      'map.label': 'Mapa de radar meteorológico y cámaras', 'header.search': 'Buscar cámaras', 'header.layers': 'Mostrar panel de capas',
      'connection.online': 'En línea', 'connection.offline': 'Sin conexión',
      'update.ready': 'Hay una actualización de StormScope disponible.', 'update.apply': 'Aplicar actualización', 'update.updating': 'Actualizando…',
      'layers.heading': 'Capas', 'layers.radar': 'Radar meteorológico', 'layers.cameras': 'Cámaras en vivo',
      'layers.coverage': 'Cobertura de radar', 'layers.alerts': 'Alertas del NWS', 'layers.opacity': 'Opacidad del radar',
      'layers.lightning': 'Densidad de rayos', 'layers.wildfires': 'Perímetros actuales de incendios',
      'layers.mapLabel': 'Capas del mapa', 'layers.opacityAria': 'Opacidad del radar',
      'units.label': 'Unidades meteorológicas', 'units.us': 'EE. UU. (°F, mph)', 'units.metric': 'Métricas (°C, km/h)',
      'radar.playback': 'Reproducción del radar', 'radar.manual': 'Solo manual', 'radar.half': 'Velocidad 0,5×',
      'radar.normal': 'Velocidad 1×', 'radar.double': 'Velocidad 2×', 'radar.presentation': 'Presentación del radar',
      'radar.standard': 'Estándar', 'radar.colorblind': 'Apta para daltonismo', 'radar.contrast': 'Alto contraste',
      'alerts.minimum': 'Severidad mínima de alerta', 'alerts.all': 'Todas las alertas', 'alerts.minor': 'Menor+',
      'alerts.moderate': 'Moderada+', 'alerts.severe': 'Severa+', 'alerts.extreme': 'Solo extrema',
      'radar.pending': 'Proveedor de radar pendiente…', 'radar.intensity.light': 'Ligera',
      'radar.intensity.moderate': 'Moderada', 'radar.intensity.heavy': 'Intensa',
      'radar.legend.standard': 'Escala estándar de intensidad de precipitación: ligera, moderada, intensa',
      'radar.legend.colorblind': 'Escala azul-roja apta para daltonismo: ligera, moderada, intensa',
      'radar.legend.contrast': 'Escala de precipitación de alto contraste: ligera, moderada, intensa',
      'cache.checking': 'Comprobando caché sin conexión…', 'cache.clear': 'Borrar datos en caché',
      'cache.requiresHttp': 'La caché sin conexión requiere HTTP o HTTPS.', 'cache.clearing': 'Borrando datos en caché…',
      'cache.usage': 'Caché sin conexión: {bytes} en {count} elementos',
      'cache.full': 'La caché sin conexión está llena. Borre los datos y vuelva a intentarlo.',
      'cache.writeFailed': 'La caché sin conexión no pudo guardar los datos nuevos.', 'cache.unavailable': 'Caché sin conexión no disponible: {error}',
      'views.name': 'Nombre de vista guardada', 'views.placeholder': 'p. ej., tormentas del Golfo', 'views.save': 'Guardar',
      'views.saved': 'Vistas guardadas', 'views.choose': 'Elegir una vista', 'views.load': 'Cargar', 'views.delete': 'Eliminar',
      'views.export': 'Exportar', 'views.import': 'Importar', 'views.savedStatus': 'Vista guardada localmente.',
      'views.saveError': 'No se pudo guardar la vista: {error}', 'views.loaded': 'Se cargó “{name}”.',
      'views.deleted': 'Se eliminó “{name}”.', 'views.exported': 'Estado guardado exportado.',
      'views.imported': 'Estado guardado importado y validado.', 'views.importRejected': 'Importación rechazada: {error}',
      'views.importReadError': 'No se pudo leer el archivo importado.',
      'views.lastSaveError': 'No se pudo guardar la última vista: {error}',
      'views.recovered': 'Se recuperó el estado desde la última copia válida.',
      'views.corrupt': 'El estado guardado estaba dañado y se restableció de forma segura.',
      'views.sessionOnly': 'El almacenamiento del navegador no está disponible; los cambios duran solo esta sesión.',
      'search.heading': 'Buscar cámaras', 'search.loadingIndex': 'Cargando índice de cámaras…',
      'search.field': 'Nombre, carretera, estado o condado', 'search.placeholder': 'Buscar en 34.541 cámaras',
      'search.state': 'Estado o país', 'search.all': 'Todos', 'search.source': 'Fuente', 'search.feedType': 'Tipo de señal',
      'search.image': 'Imagen', 'search.hls': 'Video HLS', 'search.mjpeg': 'MJPEG', 'search.embed': 'Incrustada',
      'search.sort': 'Ordenar', 'search.sortName': 'Nombre', 'search.sortDistance': 'Distancia al centro del mapa',
      'search.healthy': 'Solo disponibles', 'search.favorites': 'Solo favoritas',
      'search.resultsLabel': 'Resultados de búsqueda de cámaras', 'search.indexPending': 'El índice de cámaras aún se está cargando.',
      'search.favoriteError': 'No se pudo guardar la favorita: {error}',
      'search.results': '{count} {label}{map}', 'search.resultOne': 'resultado', 'search.resultMany': 'resultados',
      'search.shownOnMap': ' mostrados en el mapa', 'search.loaded': '{count} cargadas',
      'search.shards': '{loaded}/{total} fragmentos', 'search.loadFailed': 'Falló la carga de cámaras',
      'monitor.selection': '{count} de 4 seleccionadas', 'monitor.maximum': 'Puede supervisar hasta cuatro cámaras.',
      'monitor.bandwidth': 'Varias señales en vivo pueden consumir mucho ancho de banda.', 'monitor.start': 'Iniciar monitor',
      'monitor.startCount': 'Iniciar monitor ({count})', 'monitor.add': 'Añadir {name} al monitor',
      'monitor.remove': 'Quitar {name} del monitor', 'monitor.heading': 'Monitor multicámara',
      'monitor.subtitle': 'Solo las señales visibles permanecen activas.', 'monitor.close': 'Cerrar monitor multicámara',
      'monitor.unsupported': 'Este proveedor no se puede incrustar de forma segura en la vista multicámara.',
      'monitor.openSource': 'Abrir fuente de la cámara', 'monitor.loadError': 'No se pudo iniciar esta señal.',
      'camera.loadingCount': 'Cargando índice de cámaras…', 'camera.countProgress': '{loaded} de {total} cámaras',
      'camera.count': '{count} cámaras', 'camera.failed': 'No se pudieron cargar las cámaras',
      'camera.firstBatch': '{count} cargadas • primer lote {milliseconds} ms',
      'camera.feedLabel': '{name} — señal {health}', 'camera.favoriteAdd': 'Añadir {name} a favoritas',
      'camera.favoriteRemove': 'Quitar {name} de favoritas', 'camera.favorite': '☆ Favorita',
      'camera.favorited': '★ Favorita', 'camera.health.healthy': 'Verificada y disponible',
      'camera.health.degraded': 'Degradada', 'camera.health.offline': 'Sin conexión',
      'camera.health.unknown': 'Aún no verificada', 'camera.lastVerified': 'Última verificación: {time}',
      'camera.dataUnavailable': 'Datos de cámaras no disponibles', 'camera.offlineCache': 'Caché sin conexión • {time}',
      'camera.stale': 'Cámaras desactualizadas • {time}', 'camera.fresh': 'Cámaras • {time}',
      'camera.feedLoading': 'Cargando señal de cámara…', 'camera.weatherLoading': 'Consultando el tiempo…',
      'camera.feedRetry': 'Reintentar señal', 'camera.retrying': 'Reintentando señal de cámara…',
      'camera.openSource': 'Abrir fuente', 'camera.reload': 'Recargar señal',
      'camera.paused': 'Se pausó la señal mientras esta pestaña está oculta.',
      'camera.autoRefresh': 'Se actualiza automáticamente cada 15 s',
      'camera.liveStream': 'Transmisión en vivo', 'camera.liveMjpeg': 'Transmisión MJPEG en vivo', 'camera.youtubeLive': 'Transmisión de YouTube en vivo',
      'feed.embedTimeout': 'La señal incrustada no terminó de cargar.',
      'feed.streamUnavailable': 'Señal no disponible. La cámara puede estar desconectada o bloqueada por CORS.',
      'feed.hlsUnsupported': 'Este navegador no admite reproducción HLS.',
      'feed.cameraUnavailable': 'Señal de cámara no disponible. La cámara puede estar desconectada.',
      'feed.untrusted': 'La fuente incrustada no es de confianza.',
      'feed.embedUnavailable': 'Contenido incrustado no disponible. La página puede estar desconectada.',
      'feed.imageUnavailable': 'Imagen de cámara no disponible. La cámara puede estar desconectada.',
      'weather.unavailable': 'No hay datos meteorológicos para esta ubicación.', 'weather.temperature': 'Temperatura',
      'weather.conditions': 'Condiciones', 'weather.wind': 'Viento', 'weather.humidity': 'Humedad',
      'weather.forecastIssued': 'Pronóstico emitido', 'weather.forecastValid': 'Pronóstico válido',
      'weather.observed': 'Observado', 'weather.source': 'Fuente', 'weather.notAvailable': 'N/D',
      'weather.openMeteo': 'Open-Meteo', 'weather.openMeteoFallback': 'Respaldo Open-Meteo',
      'weather.unknown': 'Desconocido', 'weather.code.unknown': 'Desconocido', 'weather.code.clear': 'Cielo despejado',
      'weather.code.mainlyClear': 'Mayormente despejado', 'weather.code.partlyCloudy': 'Parcialmente nublado', 'weather.code.overcast': 'Cubierto',
      'weather.code.fog': 'Niebla', 'weather.code.rimeFog': 'Niebla con escarcha', 'weather.code.lightDrizzle': 'Llovizna ligera',
      'weather.code.moderateDrizzle': 'Llovizna moderada', 'weather.code.denseDrizzle': 'Llovizna intensa',
      'weather.code.slightRain': 'Lluvia ligera', 'weather.code.moderateRain': 'Lluvia moderada', 'weather.code.heavyRain': 'Lluvia intensa',
      'weather.code.slightSnow': 'Nieve ligera', 'weather.code.moderateSnow': 'Nieve moderada', 'weather.code.heavySnow': 'Nieve intensa',
      'weather.code.snowGrains': 'Granos de nieve', 'weather.code.slightShowers': 'Chubascos ligeros',
      'weather.code.moderateShowers': 'Chubascos moderados', 'weather.code.violentShowers': 'Chubascos violentos',
      'weather.code.slightSnowShowers': 'Chubascos de nieve ligeros', 'weather.code.heavySnowShowers': 'Chubascos de nieve intensos',
      'weather.code.thunderstorm': 'Tormenta eléctrica', 'weather.code.slightHail': 'Tormenta con granizo ligero',
      'weather.code.heavyHail': 'Tormenta con granizo intenso',
      'alerts.heading': 'Alertas activas del NWS', 'alerts.loading': 'Cargando…', 'alerts.refreshing': 'Actualizando…',
      'alerts.unavailable': 'No disponible', 'alerts.retryScheduled': 'No disponible • reintento programado',
      'alerts.none': 'No hay alertas activas en la vista', 'alerts.countOne': '1 alerta', 'alerts.countMany': '{count} alertas',
      'alerts.expiresSummary': '{severity} • vence {time}', 'alerts.area': 'Zona', 'alerts.effective': 'Vigente',
      'alerts.expires': 'Vence', 'alerts.severity': 'Severidad', 'alerts.details': 'Detalles',
      'alerts.instructions': 'Instrucciones', 'alerts.officialSource': 'Fuente oficial de la alerta',
      'alerts.hideDetail': 'Ocultar detalles de la alerta',
      'alerts.disclaimer': 'Solo informativo. Siga las indicaciones de weather.gov y las autoridades locales.',
      'alerts.disclaimerBefore': 'Solo informativo. Siga las indicaciones de', 'alerts.disclaimerAfter': 'y las autoridades locales.',
      'severity.extreme': 'Extrema', 'severity.severe': 'Severa', 'severity.moderate': 'Moderada',
      'severity.minor': 'Menor', 'severity.unknown': 'Desconocida',
      'modal.source': 'Fuente', 'modal.close': 'Cerrar visor de cámara',
      'radar.controls': 'Cronología de radar pasado', 'radar.frameControls': 'Controles de fotogramas del radar',
      'radar.previous': 'Fotograma anterior', 'radar.playPause': 'Reproducir o pausar la animación del radar',
      'radar.next': 'Fotograma siguiente', 'radar.loading': 'Cargando radar…', 'radar.retry': 'Reintentar',
      'radar.previousTitle': 'Fotograma anterior', 'radar.playTitle': 'Reproducir/Pausar', 'radar.nextTitle': 'Fotograma siguiente',
      'modal.closeTitle': 'Cerrar',
      'radar.loadingPast': 'Cargando radar pasado…', 'radar.unavailable': 'El radar pasado no está disponible.',
      'radar.providersUnavailable': 'RainViewer y NOAA/MRMS no disponibles • {error}',
      'radar.tileFallback': 'Fallaron los mosaicos de RainViewer • probando NOAA/NWS MRMS…',
      'radar.tilesUnavailable': 'Los mosaicos de radar no están disponibles.', 'radar.framePosition': 'Fotograma {current} de {total}',
      'radar.fallbackSuffix': ' (respaldo)', 'radar.resolution.rainviewer': 'Pirámide pública de mosaicos hasta zoom 7',
      'radar.resolution.noaa-mrms': 'Compuesto de 1 km con control de calidad', 'radar.degraded': 'degradado: {reason}',
      'radar.pastFrame': '{time} • Radar pasado • {age}', 'radar.state.clear': 'Despejado en el centro del mapa • {age}',
      'radar.state.noCoverage': 'Sin cobertura de radar en esta ubicación • {age}',
      'radar.state.stale': 'Los datos de radar están desactualizados • {age}', 'radar.ageUnknown': 'edad desconocida',
      'radar.ageNow': 'ahora mismo', 'radar.ageOne': 'hace 1 minuto', 'radar.ageMany': 'hace {count} minutos',
      'context.lightningOff': 'Rayos desactivados', 'context.wildfiresOff': 'Incendios desactivados',
      'context.loading': 'Cargando datos oficiales…', 'context.unavailable': 'Datos oficiales no disponibles; reintento programado',
      'context.refreshFailed': 'Falló la actualización • mostrando datos oficiales anteriores',
      'context.fresh': 'actualizados', 'context.stale': 'desactualizados',
      'context.lightningStatus': 'Densidad de 15 min • {freshness} • {time}',
      'context.wildfireStatus': '{count} perímetros de incendios • {freshness} • {time}',
      'context.wildfireName': 'Incendio sin nombre', 'context.acres': '{count} acres',
      'context.contained': '{count}% contenido', 'context.nifcSource': 'Abrir registro oficial del NIFC'
    }
  };

  var currentLocale = DEFAULT_LOCALE;

  function normalizeLocale(value) {
    var language = String(value || '').toLowerCase().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(catalogs, language) ? language : DEFAULT_LOCALE;
  }

  function interpolate(value, variables) {
    return String(value).replace(/\{([A-Za-z0-9_]+)\}/g, function (_match, key) {
      return variables && variables[key] != null ? String(variables[key]) : '{' + key + '}';
    });
  }

  function t(key, variables, locale) {
    var language = normalizeLocale(locale || currentLocale);
    var value = catalogs[language][key];
    if (value == null) value = catalogs[DEFAULT_LOCALE][key];
    return interpolate(value == null ? key : value, variables);
  }

  function formatNumber(value, options, locale) {
    return new Intl.NumberFormat(normalizeLocale(locale || currentLocale), options || {}).format(value);
  }

  function formatDateTime(value, options, locale) {
    var date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return t('radar.ageUnknown', null, locale);
    return new Intl.DateTimeFormat(normalizeLocale(locale || currentLocale), options || {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(date);
  }

  function formatAge(ageMinutes, locale) {
    var minutes = Number(ageMinutes);
    if (!Number.isFinite(minutes)) return t('radar.ageUnknown', null, locale);
    minutes = Math.max(0, Math.floor(minutes));
    if (minutes === 0) return t('radar.ageNow', null, locale);
    if (minutes === 1) return t('radar.ageOne', null, locale);
    return t('radar.ageMany', { count: formatNumber(minutes, null, locale) }, locale);
  }

  function sourceKeyMap() {
    var map = Object.create(null);
    Object.keys(catalogs.en).forEach(function (key) {
      var value = catalogs.en[key];
      if (typeof value === 'string' && value.indexOf('{') === -1 && !map[value]) map[value] = key;
    });
    return map;
  }

  function localizeDocument(root) {
    if (!root || !root.ownerDocument && !root.createTreeWalker) return;
    var document = root.ownerDocument || root;
    var sources = sourceKeyMap();
    var walker = document.createTreeWalker(root, 4);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || /^(SCRIPT|STYLE)$/.test(node.parentElement.tagName)) continue;
      var source = node.__stormscopeI18nSource || node.nodeValue.trim();
      var key = node.__stormscopeI18nKey || sources[source];
      if (!key) continue;
      if (!node.__stormscopeI18nSource) node.__stormscopeI18nSource = source;
      node.__stormscopeI18nKey = key;
      var leading = node.nodeValue.match(/^\s*/)[0];
      var trailing = node.nodeValue.match(/\s*$/)[0];
      node.nodeValue = leading + t(key) + trailing;
    }
    root.querySelectorAll('*').forEach(function (element) {
      ['aria-label', 'title', 'placeholder'].forEach(function (attribute) {
        if (!element.hasAttribute(attribute)) return;
        var dataName = 'i18n' + attribute.replace(/(^|-)([a-z])/g, function (_match, _dash, letter) { return letter.toUpperCase(); }) + 'Key';
        var key = element.dataset[dataName] || sources[element.getAttribute(attribute)];
        if (!key) return;
        element.dataset[dataName] = key;
        element.setAttribute(attribute, t(key));
      });
    });
    document.documentElement.lang = currentLocale;
  }

  function setLocale(locale) {
    currentLocale = normalizeLocale(locale);
    return currentLocale;
  }

  return Object.freeze({
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    STORAGE_KEY: STORAGE_KEY,
    supportedLocales: Object.freeze(['en', 'es']),
    catalogs: catalogs,
    normalizeLocale: normalizeLocale,
    setLocale: setLocale,
    getLocale: function () { return currentLocale; },
    t: t,
    formatAge: formatAge,
    formatDateTime: formatDateTime,
    formatNumber: formatNumber,
    localizeDocument: localizeDocument
  });
});
