const params = new URLSearchParams(window.location.search);

/* ------------------ TARGET PARSE ------------------ */

function parseCsvParam(name) {
  return (params.get(name) || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

const singleHex = (params.get("hex") || "").toLowerCase().trim();

const multiHexes = [
  ...parseCsvParam("hexes"),
  ...parseCsvParam("hexs")
].map(x => x.toLowerCase());

let TARGETS = [];

if (multiHexes.length) {
  TARGETS = multiHexes.map(hex => ({
    key: `hex:${hex}`,
    hex
  }));
} else if (singleHex) {
  TARGETS = [{
    key: `hex:${singleHex}`,
    hex: singleHex
  }];
}

/* 최대 12대 */
TARGETS = TARGETS.slice(0, 12);

/* ------------------ HEX DESCRIPTION ------------------ */

const HEX_INFO_MAP = {
  "71c550": "현대(G650)",
  "71c290": "현대(BBJ)",
  "71c299": "LG(G650)",
  "71ba27": "한화(BBJ)",
  "71c080": "SK(ACJ)",
  "71c372": "SK(G650)",
  "71c508": "삼성(B788)",
  "71c230": "KE(GLEX)",
  "71c068": "KE(G650)",
  "71c222": "KE(BBJ)"
};

function getHexDescription(hex) {
  const normalized = String(hex || "").trim().toLowerCase();
  return HEX_INFO_MAP[normalized] || "";
}

/* ------------------ API / SETTINGS ------------------ */

const ADSB_PROVIDERS = [
  {
    id: "adsb_lol",
    base: "https://api.adsb.lol",
    hexPath: "v2/hex"
  },
  {
    id: "adsb_one",
    base: "https://api.adsb.one",
    hexPath: "v2/hex"
  },
  {
    id: "adsb_fi",
    base: "https://opendata.adsb.fi/api",
    hexPath: "v2/hex"
  },
  {
    id: "airplanes_live",
    base: "https://api.airplanes.live",
    hexPath: "hex"
  }
];

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwG1Hx2vA-TnVHRwfhEKrcLtOZLAwrevIeRPw_Rljtt8k-Q3lNVRSRNf2RKDb1axXVVQg/exec";

const POLL_INTERVAL_MS = 5000;
const ANIMATION_DURATION_MS = 4500;
const MAX_LIVE_TRAIL_POINTS = 500;
const FETCH_TIMEOUT_MS = 1800;

const AIRCRAFT_BOOT_CACHE_KEY = "aircraftBootCache_v1";
const AIRCRAFT_BOOT_CACHE_MAX_AGE_MS = 8000;

/* ------------------ GPS / USER SETTINGS ------------------ */

const USER_GPS_ZOOM_MIN = 10;
const AIRCRAFT_FOCUS_ZOOM_MAX = 6;
const FOLLOW_AIRCRAFT_ZOOM_MIN = 6;
const MAX_USER_TRAIL_POINTS = 1000;

const RUNNING_SPEED_MAX_KT = 8.0;
const COMPASS_HEADING_SMOOTHING = 0.18;
const USER_HEADING_CHANGE_MIN_DEG = 2;

/* --- GPS TRAIL SETTINGS --- */
const USER_TRAIL_MAX_ACCURACY_M = 120;
const USER_TRAIL_BASE_MAX_ACCURACY_M = 90;
const USER_TRAIL_JUMP_MAX_TIME_S = 5;
const USER_TRAIL_MAX_SPEED_MPS = 12;
const USER_TRAIL_MIN_MOVE_M = 2;

const USER_TRAIL_DASH_MAX_DIST_M = 180;
const USER_TRAIL_DASH_MAX_TIME_S = 30;

const USER_TRAIL_SMOOTHING_WINDOW = 3;
const USER_TRAIL_STORAGE_KEY = "userTrailState_v5";
const USER_TRAIL_STORAGE_LIMIT = 300;
const USER_TRAIL_STORAGE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/* ------------------ COLORS ------------------ */

const AIRCRAFT_COLORS = [
  "#ff8800",
  "#1e90ff",
  "#28a745",
  "#d63384",
  "#6f42c1",
  "#17a2b8",
  "#fd7e14",
  "#20c997",
  "#e83e8c",
  "#6610f2",
  "#ff4444",
  "#00c853"
];

/* ------------------ STATE ------------------ */

const aircraftStates = new Map();
/*
{
  marker,
  tooltipBound,
  liveTrail,
  liveTrailLine,
  lastAircraft,
  lastLatLng,
  animationFrameId,
  animationToken,
  color,
  buttonEl,
  isLive,
  staleCount,
  fixedLabel
}
*/

let lastGoodProviderId = null;
let activeFollowTargetKey = null;
let isPollingAircraft = false;

/* 상세정보 패널 상태 */
let selectedAircraftTargetKey = null;
let suppressNextMapClose = false;

/* ------------------ USER / GPS STATE ------------------ */

let lastUserLatLng = null;
let userMarker = null;
let userAccuracyCircle = null;
let userHeadingMarker = null;

let gpsWatchId = null;
let deviceCompassHeading = null;
let lastUserHeadingDeg = null;
let lastKnownSpeedKt = null;
let compassStarted = false;

let lastAcceptedUserPoint = null;
let pendingGapStartPoint = null;

let userTrailSolidSegments = [];
let userTrailDashedSegments = [];

let userTrailSolidLines = [];
let userTrailDashedLines = [];

let currentSolidSegment = null;
let currentSolidLine = null;

let recentAcceptedUserPoints = [];
let lastProcessedGpsTimestamp = null;

/* ------------------ TARGET INIT ------------------ */

function initAircraftStates() {
  TARGETS.forEach((target, idx) => {
    aircraftStates.set(target.key, {
      marker: null,
      tooltipBound: false,
      liveTrail: [],
      liveTrailLine: null,
      lastAircraft: null,
      lastLatLng: null,
      animationFrameId: null,
      animationToken: 0,
      color: AIRCRAFT_COLORS[idx % AIRCRAFT_COLORS.length],
      buttonEl: null,
      isLive: false,
      staleCount: 0,
      fixedLabel: getHexDescription(target.hex)
    });
  });
}

initAircraftStates();

/* ------------------ UTILS ------------------ */

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

function shortestAngleDiff(fromDeg, toDeg) {
  let diff = normalizeDeg(toDeg) - normalizeDeg(fromDeg);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function smoothHeading(prevDeg, nextDeg, smoothing) {
  if (prevDeg == null) return normalizeDeg(nextDeg);
  const diff = shortestAngleDiff(prevDeg, nextDeg);
  return normalizeDeg(prevDeg + diff * smoothing);
}

function metersPerSecondToKnots(ms) {
  return (Number(ms) || 0) * 1.943844;
}

function wrapLon180Local(lon) {
  let x = Number(lon);
  if (!isFinite(x)) return lon;

  while (x <= -180) x += 360;
  while (x > 180) x -= 360;

  return x;
}

function getMapCenterLonSafe() {
  try {
    if (map && typeof map.getCenter === "function") {
      const c = map.getCenter();
      if (c && isFinite(c.lng)) return Number(c.lng);
    }
  } catch (_) {}
  return 0;
}

function getRouteReferenceLonSafe() {
  const v = window.__ROUTE_RENDER_REFERENCE_LON;
  return Number.isFinite(v) ? Number(v) : NaN;
}

function shiftLonNearReferenceLocal(lon, referenceLon) {
  if (typeof window.__shiftLonNearReference === "function") {
    return window.__shiftLonNearReference(lon, referenceLon);
  }

  let x = wrapLon180Local(lon);
  if (!isFinite(referenceLon)) return x;

  while (x - referenceLon > 180) x -= 360;
  while (x - referenceLon < -180) x += 360;

  return x;
}

function getClosestWrappedLongitude(rawLon, referenceLon) {
  const lon = Number(rawLon);
  const ref = Number(referenceLon);

  if (!isFinite(lon)) return lon;
  if (!isFinite(ref)) return lon;

  const options = [lon - 720, lon - 360, lon, lon + 360, lon + 720];

  let best = options[0];
  let minDiff = Math.abs(options[0] - ref);

  for (let i = 1; i < options.length; i++) {
    const diff = Math.abs(options[i] - ref);
    if (diff < minDiff) {
      minDiff = diff;
      best = options[i];
    }
  }

  return best;
}

function getWrappedLonByMapOrPrev(rawLon, prevLon) {
  const referenceLon = isFinite(prevLon) ? Number(prevLon) : getMapCenterLonSafe();
  return getClosestWrappedLongitude(rawLon, referenceLon);
}

function getWrappedLonUsingRouteReference(rawLon, fallbackPrevLon) {
  const lon = Number(rawLon);
  if (!isFinite(lon)) return lon;

  const routeRef = getRouteReferenceLonSafe();

  if (isFinite(routeRef)) {
    return shiftLonNearReferenceLocal(lon, routeRef);
  }

  return getWrappedLonByMapOrPrev(lon, fallbackPrevLon);
}

function getSmallestLonDelta(lon1, lon2) {
  const a = Number(lon1);
  const b = Number(lon2);
  if (!isFinite(a) || !isFinite(b)) return 0;

  let diff = b - a;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

function metersBetweenLatLng(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(getSmallestLonDelta(lon1, lon2));

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function averagePoint(points) {
  if (!points || points.length === 0) return null;

  if (points.length === 1) {
    return {
      lat: points[0].lat,
      lng: points[0].lng
    };
  }

  const refLon = Number(points[0].lng);
  let latSum = 0;
  let lonSum = 0;

  for (const p of points) {
    latSum += p.lat;
    lonSum += getClosestWrappedLongitude(p.lng, refLon);
  }

  return {
    lat: latSum / points.length,
    lng: lonSum / points.length
  };
}

function clonePoint(p) {
  return {
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy ?? null,
    time: p.time
  };
}

function normalizeHex(v) {
  return String(v || "").trim().toLowerCase();
}

function saveBootAircraftCache(acList) {
  try {
    localStorage.setItem(AIRCRAFT_BOOT_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      ac: Array.isArray(acList) ? acList : []
    }));
  } catch (_) {}
}

function loadBootAircraftCache() {
  try {
    const raw = localStorage.getItem(AIRCRAFT_BOOT_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.ac)) return null;

    const ageMs = Date.now() - Number(parsed.savedAt || 0);
    if (ageMs > AIRCRAFT_BOOT_CACHE_MAX_AGE_MS) return null;

    return parsed.ac;
  } catch (_) {
    return null;
  }
}

function getAircraftCallsign(ac) {
  return String(ac?.flight || ac?.callsign || "").trim().toUpperCase();
}

async function fetchBatchAircraftData(isInitial = false) {
  const hexes = [...new Set(TARGETS.map(t => t.hex).filter(Boolean))];
  if (!hexes.length) return new Map();

  const url = `${SCRIPT_URL}?hexes=${encodeURIComponent(hexes.join(","))}&initial=${isInitial ? "1" : "0"}`;
  const data = await fetchJson(url);

  if (!data || !data.ok) {
    throw new Error(data?.error || "Apps Script fetch failed");
  }

  const aircraft = dedupeAircraftList(Array.isArray(data.ac) ? data.ac : []);
  saveBootAircraftCache(aircraft);

  const byHex = new Map();

  for (const ac of aircraft) {
    const hex = normalizeHex(ac.hex);
    if (hex && !byHex.has(hex)) {
      byHex.set(hex, ac);
    }
  }

  const resolvedMap = new Map();

  for (const target of TARGETS) {
    const ac = byHex.get(target.hex) || null;
    if (ac) {
      resolvedMap.set(target.key, ac);
    }
  }

  return resolvedMap;
}


function applyBootAircraftCache() {
  const cachedList = loadBootAircraftCache();
  if (!cachedList || !cachedList.length) return;

  const byHex = new Map();

  for (const ac of cachedList) {
    const hex = normalizeHex(ac.hex);
    if (hex && !byHex.has(hex)) {
      byHex.set(hex, ac);
    }
  }

  for (const target of TARGETS) {
    const ac = byHex.get(target.hex);
    if (!ac) continue;

    const state = aircraftStates.get(target.key);
    if (!state) continue;

    state.lastAircraft = ac;
    state.isLive = true;
    state.staleCount = 0;

    ensureAircraftMarker(target, ac);
    updateLiveTrail(target, ac);
  }

  refreshAircraftFollowButtons();
}

async function pollAircraft(isInitial = false) {
  if (!TARGETS.length || isPollingAircraft) return;

  isPollingAircraft = true;

  try {
    const resolvedMap = await fetchBatchAircraftData(isInitial);

    for (const target of TARGETS) {
      const state = aircraftStates.get(target.key);
      if (!state) continue;

      const ac = resolvedMap.get(target.key) || null;

      if (!ac) {
        state.isLive = false;
        state.staleCount = (state.staleCount || 0) + 1;
        continue;
      }

      state.isLive = true;
      state.staleCount = 0;

      if (!state.lastAircraft) {
        updateAircraftForTarget(target, ac);
      } else {
        animateAircraftIfNeeded(target, state.lastAircraft, ac);
      }
    }

    refreshAircraftFollowButtons();
  } catch (err) {
    console.error("pollAircraft error:", err);

    for (const target of TARGETS) {
      const state = aircraftStates.get(target.key);
      if (!state) continue;
      state.isLive = false;
      state.staleCount = (state.staleCount || 0) + 1;
    }

    refreshAircraftFollowButtons();
  } finally {
    isPollingAircraft = false;
  }
}

/* ------------------ COMPASS / GPS ------------------ */

function getHeadingArrowLatLng(baseLatLng, headingDeg) {
  const lat = baseLatLng[0];
  const lon = baseLatLng[1];

  const distanceMeters = 7;
  const rad = normalizeDeg(headingDeg) * Math.PI / 180;

  const dLat = (distanceMeters * Math.cos(rad)) / 111320;
  const dLon = (distanceMeters * Math.sin(rad)) / (111320 * Math.cos(lat * Math.PI / 180));

  return [lat + dLat, lon + dLon];
}

function createHeadingArrowIcon(headingDeg) {
  return L.divIcon({
    className: "user-heading-arrow",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: `
      <div style="
        width:14px;
        height:14px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform: rotate(${normalizeDeg(headingDeg)}deg);
        transform-origin:center center;
      ">
        <div style="
          width:0;
          height:0;
          border-left:4px solid transparent;
          border-right:4px solid transparent;
          border-bottom:10px solid red;
          filter: drop-shadow(0 0 0.6px rgba(0,0,0,0.45));
        "></div>
      </div>
    `
  });
}

function updateCompassArrowFromOrientation() {
  if (!lastUserLatLng) return;
  if (deviceCompassHeading == null || isNaN(deviceCompassHeading)) return;

  if (lastKnownSpeedKt != null && lastKnownSpeedKt > RUNNING_SPEED_MAX_KT) {
    if (userHeadingMarker) {
      map.removeLayer(userHeadingMarker);
      userHeadingMarker = null;
    }
    return;
  }

  let nextHeading = deviceCompassHeading;

  if (lastUserHeadingDeg != null) {
    const diff = Math.abs(shortestAngleDiff(lastUserHeadingDeg, deviceCompassHeading));
    if (diff < USER_HEADING_CHANGE_MIN_DEG) {
      nextHeading = lastUserHeadingDeg;
    } else {
      nextHeading = smoothHeading(
        lastUserHeadingDeg,
        deviceCompassHeading,
        COMPASS_HEADING_SMOOTHING
      );
    }
  }

  lastUserHeadingDeg = nextHeading;

  const arrowLatLng = getHeadingArrowLatLng(lastUserLatLng, nextHeading);
  const icon = createHeadingArrowIcon(nextHeading);

  if (!userHeadingMarker) {
    userHeadingMarker = L.marker(arrowLatLng, {
      icon,
      zIndexOffset: 1100,
      interactive: false
    }).addTo(map);
  } else {
    userHeadingMarker.setLatLng(arrowLatLng);
    userHeadingMarker.setIcon(icon);
  }
}

function handleDeviceOrientation(event) {
  let heading = null;

  if (typeof event.webkitCompassHeading === "number") {
    heading = event.webkitCompassHeading;
  } else if (event.absolute === true && typeof event.alpha === "number") {
    heading = 360 - event.alpha;
  } else if (typeof event.alpha === "number") {
    heading = 360 - event.alpha;
  }

  if (heading != null && !isNaN(heading)) {
    deviceCompassHeading = normalizeDeg(heading);
    updateCompassArrowFromOrientation();
  }
}

async function startDeviceCompass() {
  if (compassStarted) return;

  try {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        return;
      }
    }

    window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    compassStarted = true;
  } catch (err) {
    console.error("Compass start failed:", err);
  }
}

/* ------------------ USER TRAIL HELPERS ------------------ */

function createSolidTrailLine(initialPoint) {
  const line = L.polyline([[initialPoint.lat, initialPoint.lng]], {
    weight: 2.5,
    opacity: 0.5,
    color: "#2b8cff"
  }).addTo(map);

  userTrailSolidLines.push(line);
  return line;
}

function createDashedTrailLine(fromPoint, toPoint) {
  const line = L.polyline(
    [
      [fromPoint.lat, fromPoint.lng],
      [toPoint.lat, toPoint.lng]
    ],
    {
      weight: 2.5,
      opacity: 0.35,
      color: "#2b8cff",
      dashArray: "4,8"
    }
  ).addTo(map);

  userTrailDashedLines.push(line);
  userTrailDashedSegments.push([clonePoint(fromPoint), clonePoint(toPoint)]);
}

function trimOldestSolidTrailData() {
  let totalSolidPoints = userTrailSolidSegments.reduce((sum, seg) => sum + seg.length, 0);

  while (totalSolidPoints > MAX_USER_TRAIL_POINTS && userTrailSolidSegments.length > 0) {
    const firstSeg = userTrailSolidSegments[0];
    const firstLine = userTrailSolidLines[0];

    if (!firstSeg || !firstLine) break;

    if (firstSeg.length <= 2) {
      if (map.hasLayer(firstLine)) map.removeLayer(firstLine);
      userTrailSolidSegments.shift();
      userTrailSolidLines.shift();
      totalSolidPoints -= firstSeg.length;
      continue;
    }

    firstSeg.shift();
    firstLine.setLatLngs(firstSeg.map(p => [p.lat, p.lng]));
    totalSolidPoints -= 1;
  }
}

function trimOldestDashedTrailData() {
  const maxDashedSegments = Math.max(20, Math.floor(MAX_USER_TRAIL_POINTS / 10));

  while (userTrailDashedSegments.length > maxDashedSegments && userTrailDashedLines.length > 0) {
    const firstLine = userTrailDashedLines.shift();
    userTrailDashedSegments.shift();
    if (map.hasLayer(firstLine)) map.removeLayer(firstLine);
  }
}

function trimUserTrailData() {
  trimOldestSolidTrailData();
  trimOldestDashedTrailData();
}

function rememberAcceptedPoint(point) {
  recentAcceptedUserPoints.push(clonePoint(point));
  if (recentAcceptedUserPoints.length > USER_TRAIL_SMOOTHING_WINDOW) {
    recentAcceptedUserPoints.shift();
  }
}

function getReferencePointForValidation() {
  if (recentAcceptedUserPoints.length === 0) return lastAcceptedUserPoint;
  if (recentAcceptedUserPoints.length === 1) return recentAcceptedUserPoints[0];

  const avg = averagePoint(recentAcceptedUserPoints);
  return {
    lat: avg.lat,
    lng: avg.lng,
    accuracy: recentAcceptedUserPoints[recentAcceptedUserPoints.length - 1].accuracy,
    time: recentAcceptedUserPoints[recentAcceptedUserPoints.length - 1].time
  };
}

function getDynamicJumpAllowance(nextAccuracy) {
  const acc = Number(nextAccuracy) || 0;
  return Math.max(60, acc * 1.5);
}

function isReliableUserTrailPoint(prevPoint, nextPoint) {
  if (!nextPoint) return false;

  const nextAccuracy = Number(nextPoint.accuracy) || 0;

  if (nextAccuracy > USER_TRAIL_MAX_ACCURACY_M) {
    return false;
  }

  if (nextAccuracy > USER_TRAIL_BASE_MAX_ACCURACY_M && !prevPoint) {
    return false;
  }

  if (!prevPoint) return true;

  const dist = metersBetweenLatLng(
    prevPoint.lat, prevPoint.lng,
    nextPoint.lat, nextPoint.lng
  );

  const dt = (nextPoint.time - prevPoint.time) / 1000;
  if (dt <= 0) return false;

  const speedMps = dist / dt;

  if (dist < USER_TRAIL_MIN_MOVE_M) {
    return null;
  }

  const dynamicJumpAllowance = getDynamicJumpAllowance(nextAccuracy);

  if (dt <= USER_TRAIL_JUMP_MAX_TIME_S && dist > dynamicJumpAllowance) {
    return false;
  }

  if (speedMps > USER_TRAIL_MAX_SPEED_MPS) {
    return false;
  }

  if (nextAccuracy > USER_TRAIL_BASE_MAX_ACCURACY_M && dist > nextAccuracy) {
    return false;
  }

  return true;
}

function shouldCreateDashedReconnect(fromPoint, toPoint) {
  if (!fromPoint || !toPoint) return false;

  const dist = metersBetweenLatLng(
    fromPoint.lat, fromPoint.lng,
    toPoint.lat, toPoint.lng
  );

  const dt = (toPoint.time - fromPoint.time) / 1000;
  if (dt <= 0) return false;

  return dist <= USER_TRAIL_DASH_MAX_DIST_M && dt <= USER_TRAIL_DASH_MAX_TIME_S;
}

function getSmoothedAcceptedPoint(candidatePoint) {
  const windowPoints = recentAcceptedUserPoints.slice(-(USER_TRAIL_SMOOTHING_WINDOW - 1));
  const points = [...windowPoints, candidatePoint];

  if (points.length < 2) {
    return clonePoint(candidatePoint);
  }

  const avg = averagePoint(points);
  return {
    lat: avg.lat,
    lng: avg.lng,
    accuracy: candidatePoint.accuracy,
    time: candidatePoint.time
  };
}

function startNewSolidSegment(point) {
  currentSolidSegment = [clonePoint(point)];
  userTrailSolidSegments.push(currentSolidSegment);
  currentSolidLine = createSolidTrailLine(point);
}

function appendToCurrentSolidSegment(point) {
  if (!currentSolidSegment || !currentSolidLine) {
    startNewSolidSegment(point);
    return;
  }

  currentSolidSegment.push(clonePoint(point));
  currentSolidLine.addLatLng([point.lat, point.lng]);
}

function serializeTrailState() {
  try {
    const solidSegments = userTrailSolidSegments
      .map(seg => seg.map(clonePoint))
      .filter(seg => seg.length > 0);

    const dashedSegments = userTrailDashedSegments
      .map(seg => seg.map(clonePoint))
      .filter(seg => seg.length >= 2)
      .slice(-50);

    const allSolidPoints = solidSegments.flat();
    const trimmedSolidSegments = [];

    let remaining = USER_TRAIL_STORAGE_LIMIT;
    for (let i = solidSegments.length - 1; i >= 0; i--) {
      const seg = solidSegments[i];
      if (remaining <= 0) break;

      const takeSeg = seg.slice(-remaining);
      trimmedSolidSegments.unshift(takeSeg);
      remaining -= takeSeg.length;
    }

    const latestTime = allSolidPoints.length
      ? allSolidPoints[allSolidPoints.length - 1].time
      : Date.now();

    const payload = {
      savedAt: Date.now(),
      latestPointTime: latestTime,
      solidSegments: trimmedSolidSegments,
      dashedSegments
    };

    localStorage.setItem(USER_TRAIL_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Trail state save failed:", err);
  }
}

function restoreTrailState() {
  try {
    const raw = localStorage.getItem(USER_TRAIL_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    const savedAt = Number(parsed.savedAt) || 0;
    if (savedAt && Date.now() - savedAt > USER_TRAIL_STORAGE_MAX_AGE_MS) {
      localStorage.removeItem(USER_TRAIL_STORAGE_KEY);
      return;
    }

    const solidSegments = Array.isArray(parsed.solidSegments) ? parsed.solidSegments : [];
    const dashedSegments = Array.isArray(parsed.dashedSegments) ? parsed.dashedSegments : [];

    for (const seg of solidSegments) {
      if (!Array.isArray(seg) || seg.length === 0) continue;

      const clonedSeg = seg.map(clonePoint);
      userTrailSolidSegments.push(clonedSeg);

      const line = L.polyline(
        clonedSeg.map(p => [p.lat, p.lng]),
        {
          weight: 2.5,
          opacity: 0.5,
          color: "#2b8cff"
        }
      ).addTo(map);

      userTrailSolidLines.push(line);
    }

    if (userTrailSolidSegments.length > 0) {
      currentSolidSegment = userTrailSolidSegments[userTrailSolidSegments.length - 1];
      currentSolidLine = userTrailSolidLines[userTrailSolidLines.length - 1];

      lastAcceptedUserPoint = clonePoint(currentSolidSegment[currentSolidSegment.length - 1]);
      lastUserLatLng = [lastAcceptedUserPoint.lat, lastAcceptedUserPoint.lng];

      recentAcceptedUserPoints = currentSolidSegment
        .slice(-USER_TRAIL_SMOOTHING_WINDOW)
        .map(clonePoint);

      lastProcessedGpsTimestamp = lastAcceptedUserPoint.time || null;
    }

    for (const seg of dashedSegments) {
      if (!Array.isArray(seg) || seg.length < 2) continue;

      const fromPoint = clonePoint(seg[0]);
      const toPoint = clonePoint(seg[1]);

      const line = L.polyline(
        [
          [fromPoint.lat, fromPoint.lng],
          [toPoint.lat, toPoint.lng]
        ],
        {
          weight: 2.5,
          opacity: 0.35,
          color: "#2b8cff",
          dashArray: "4,8"
        }
      ).addTo(map);

      userTrailDashedLines.push(line);
      userTrailDashedSegments.push([fromPoint, toPoint]);
    }

    trimUserTrailData();
  } catch (err) {
    console.warn("Trail state restore failed:", err);
  }
}

function appendUserTrailPoint(lat, lng, accuracy, timestamp) {
  const rawPoint = {
    lat,
    lng,
    accuracy: typeof accuracy === "number" ? accuracy : null,
    time: timestamp || Date.now()
  };

  const validationBase = getReferencePointForValidation() || lastAcceptedUserPoint;
  const reliability = isReliableUserTrailPoint(validationBase, rawPoint);

  if (!lastAcceptedUserPoint && reliability === false) {
    return;
  }

  if (!lastAcceptedUserPoint) {
    startNewSolidSegment(rawPoint);
    lastAcceptedUserPoint = clonePoint(rawPoint);
    rememberAcceptedPoint(rawPoint);
    trimUserTrailData();
    serializeTrailState();
    return;
  }

  if (reliability === null) {
    return;
  }

  if (reliability === false) {
    if (!pendingGapStartPoint) {
      pendingGapStartPoint = clonePoint(lastAcceptedUserPoint);
    }
    return;
  }

  const smoothedPoint = getSmoothedAcceptedPoint(rawPoint);

  if (pendingGapStartPoint) {
    if (shouldCreateDashedReconnect(pendingGapStartPoint, smoothedPoint)) {
      createDashedTrailLine(pendingGapStartPoint, smoothedPoint);
    }

    startNewSolidSegment(smoothedPoint);
    pendingGapStartPoint = null;
    lastAcceptedUserPoint = clonePoint(smoothedPoint);
    rememberAcceptedPoint(smoothedPoint);

    trimUserTrailData();
    serializeTrailState();
    return;
  }

  appendToCurrentSolidSegment(smoothedPoint);
  lastAcceptedUserPoint = clonePoint(smoothedPoint);
  rememberAcceptedPoint(smoothedPoint);

  trimUserTrailData();
  serializeTrailState();
}

function getWrappedUserLon(rawLon) {
  const prevLon = lastUserLatLng ? Number(lastUserLatLng[1]) : NaN;
  return getWrappedLonUsingRouteReference(rawLon, prevLon);
}

function updateUserLocation(position) {
  const lat = position.coords.latitude;
  const rawLon = position.coords.longitude;
  const lon = getWrappedUserLon(rawLon);

  const accuracy = position.coords.accuracy || 0;
  const speedKt = metersPerSecondToKnots(position.coords.speed);
  const gpsTimestamp = Number(position.timestamp) || Date.now();

  if (lastProcessedGpsTimestamp != null && gpsTimestamp <= lastProcessedGpsTimestamp) {
    lastUserLatLng = [lat, lon];
  } else {
    lastProcessedGpsTimestamp = gpsTimestamp;
    lastUserLatLng = [lat, lon];
    appendUserTrailPoint(lat, lon, accuracy, gpsTimestamp);
  }

  lastKnownSpeedKt = speedKt;

  if (!userMarker) {
    userMarker = L.circleMarker(lastUserLatLng, {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: "#2b8cff",
      fillOpacity: 1,
      opacity: 1
    }).addTo(map);
  } else {
    userMarker.setLatLng(lastUserLatLng);
  }

  const clampedAccuracy = Math.max(8, Math.min(accuracy, 35));

  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(lastUserLatLng, {
      radius: clampedAccuracy,
      color: "#2b8cff",
      weight: 1,
      opacity: 0.22,
      fillColor: "#2b8cff",
      fillOpacity: 0.04
    }).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(lastUserLatLng);
    userAccuracyCircle.setRadius(clampedAccuracy);
  }

  if (speedKt > RUNNING_SPEED_MAX_KT) {
    if (userHeadingMarker) {
      map.removeLayer(userHeadingMarker);
      userHeadingMarker = null;
    }
    return;
  }

  updateCompassArrowFromOrientation();
}

function startGpsTracking() {
  if (!navigator.geolocation) {
    console.warn("Geolocation not supported");
    return;
  }

  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    updateUserLocation,
    err => {
      console.error("GPS error:", err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    }
  );
}

/* ------------------ INIT ------------------ */

function initAircraftTracking() {
  injectAircraftUiCss();

  if (map && map.zoomControl) {
    map.removeControl(map.zoomControl);
  }

  createToggleButton();
  applyBootAircraftCache();

  if (TARGETS.length > 0) {
    pollAircraft(true);
    setInterval(() => pollAircraft(false), POLL_INTERVAL_MS);
  }

  restoreTrailState();
  startGpsTracking();

  if (map && typeof map.on === "function") {
    map.on("dragstart", () => {
      if (activeFollowTargetKey) {
        activeFollowTargetKey = null;
        refreshAircraftFollowButtons();
      }
      if (!suppressNextMapClose) {
        hideAircraftDetailPanel();
      }
    });

    map.on("click", () => {
      if (suppressNextMapClose) return;
      hideAircraftDetailPanel();
    });
  }
}

initAircraftTracking();
