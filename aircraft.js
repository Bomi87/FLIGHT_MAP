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

/* 최대 15대 */
TARGETS = TARGETS.slice(0, 15);

/* ------------------ HEX DESCRIPTION ------------------ */

const HEX_INFO_MAP = {
  "71c550": "현대(G650)",
  "71c290": "현대(BBJ)",
  "71c551": "현대(B38M)",
  "71c299": "LG(G650)",
  "71ba27": "한화(BBJ)",
  "71c080": "SK(ACJ)",
  "71c372": "SK(G650)",
  "71c508": "삼성(B788)",
  "71c230": "KE(GLEX)",
  "71c068": "KE(G650)",
  "71c222": "KE(BBJ)",
  "71c229": "KE(GLEX)",
  "71be43": "CD1(B748)",
  "71c566": "CD2(B38M)",
  "4076e5": "G-KELT(A320)"
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

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbza0ZkypGKes-TkOFJDk4lOScMzJ1NzzLrCGRpekQvS4QaGlBG7rjD46XswYQkVJEMPhg/exec";

const POLL_INTERVAL_MS = 4000;
const ANIMATION_DURATION_MS = 3500;
const FETCH_TIMEOUT_MS = 6500;
const MAX_LIVE_TRAIL_POINTS = 120;
const AIRCRAFT_STALE_REMOVE_MS = 15 * 60 * 1000; // 15분 미수신 시 삭제

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
  fixedLabel,
  lastSeenAt
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
      fixedLabel: getHexDescription(target.hex),
      lastSeenAt: null
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
  return Number.isFinite(v) ? v : NaN;
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

function getAircraftCallsign(ac) {
  return String(ac?.flight || ac?.callsign || "").trim().toUpperCase();
}

function getOrderedProviders() {
  if (!lastGoodProviderId) return [...ADSB_PROVIDERS];

  const preferred = ADSB_PROVIDERS.find(p => p.id === lastGoodProviderId);
  const others = ADSB_PROVIDERS.filter(p => p.id !== lastGoodProviderId);

  return preferred ? [preferred, ...others] : [...ADSB_PROVIDERS];
}

function buildProviderUrl(provider, joinedValue) {
  return `${provider.base}/${provider.hexPath}/${encodeURIComponent(joinedValue)}`;
}

function dedupeAircraftList(list) {
  const result = [];
  const seen = new Set();

  for (const ac of list || []) {
    const hex = normalizeHex(ac.hex);
    const key = hex ? `hex:${hex}` : "";

    if (!key) {
      result.push(ac);
      continue;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ac);
  }

  return result;
}

function resolveAircraftForTargets(targets, byHex) {
  const found = new Map();
  const missingTargets = [];

  for (const target of targets) {
    const ac = byHex.get(target.hex) || null;

    if (ac) {
      found.set(target.key, ac);
    } else {
      missingTargets.push(target);
    }
  }

  return { found, missingTargets };
}

function injectAircraftUiCss() {
  if (document.getElementById("aircraft-ui-css")) return;

  const style = document.createElement("style");
  style.id = "aircraft-ui-css";
  style.textContent = `
    .aircraft-label-tooltip {
      pointer-events: none !important;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
    }
    .aircraft-label-tooltip::before {
      display: none !important;
    }
    .aircraft-div-icon {
      background: transparent !important;
      border: none !important;
    }
  `;
  document.head.appendChild(style);
}

/* ------------------ BUTTON LABEL ------------------ */

function getAircraftButtonLabel(ac, target) {
  const state = aircraftStates.get(target.key);

  if (state?.fixedLabel) {
    return state.fixedLabel;
  }

  const callsign = (ac?.flight || ac?.callsign || "").trim();
  const hex = (ac?.hex || target?.hex || "").toUpperCase();

  if (callsign && hex) return `${callsign} (${hex})`;
  if (callsign) return callsign;
  if (hex) return `HEX:${hex}`;
  return "UNKNOWN";
}

/* ------------------ AIRCRAFT FORMAT ------------------ */

function formatAltitudeText(ac) {
  const altBaro = ac.alt_baro;
  const altGeom = ac.alt_geom;
  const altFtRaw = altBaro ?? altGeom;

  if (altFtRaw == null || isNaN(altFtRaw)) return "";

  const altFt = Math.round(Number(altFtRaw));
  const gs = Number(ac.gs);
  const vr = Number(ac.vert_rate ?? ac.baro_rate ?? 0);

  const hasReliableGroundClues =
    !isNaN(gs) &&
    !isNaN(vr);

  const looksGround =
    hasReliableGroundClues &&
    gs <= 25 &&
    altFt <= 1000 &&
    Math.abs(vr) <= 200;

  if (looksGround) {
    return "GND";
  }

  if (altFt >= 18000) {
    return "FL" + String(Math.round(altFt / 100)).padStart(3, "0");
  }

  return altFt.toLocaleString() + " ft";
}

function formatMachText(ac) {
  if (ac.mach != null && !isNaN(ac.mach)) {
    return "M" + String(Number(ac.mach).toFixed(2)).replace(/^0/, "");
  }
  return "";
}

function getVerticalRate(ac) {
  if (ac?.vert_rate != null && ac.vert_rate !== "") {
    const vr = Number(ac.vert_rate);
    if (!isNaN(vr)) return vr;
  }

  if (ac?.baro_rate != null && ac.baro_rate !== "") {
    const br = Number(ac.baro_rate);
    if (!isNaN(br)) return br;
  }

  return null;
}

function formatVerticalRateText(ac) {
  const vr = getVerticalRate(ac);

  if (vr == null) return "-";
  if (vr === 0) return "0 FPM";

  return `${vr > 0 ? "+" : ""}${Math.round(vr)} FPM`;
}

function getVerticalState(ac) {
  const vr = getVerticalRate(ac);

  if (vr == null) return null;

  if (vr > 200) {
    return { arrow: "▲", color: "#ff3b30" };
  }

  if (vr < -200) {
    return { arrow: "▼", color: "#007aff" };
  }

  return { arrow: "→", color: "#ffffff" };
}

function formatAircraftLabelHtml(ac, color) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const altitudeText = formatAltitudeText(ac);

  const verticalState = getVerticalState(ac);
  const vertical = verticalState ? { ...verticalState } : null;

  if (vertical && vertical.arrow === "→") {
    vertical.color = "#000000";
  }

  const smallLine1 = flight || String(ac.hex || "").toUpperCase() || "UNKNOWN";
  const smallLine2 = altitudeText || "";

  return `
    <div style="
      display:inline-block;
      background:#ffffff;
      border:1px solid rgba(0,0,0,0.22);
      border-radius:4px;
      box-shadow:0 1px 3px rgba(0,0,0,0.22);
      padding:2px 5px 3px 5px;
      min-width:46px;
      white-space:nowrap;
      text-align:center;
      line-height:1.0;
      user-select:none;
      -webkit-user-select:none;
    ">
      <div style="
        width:100%;
        height:2px;
        background:${escapeHtml(color)};
        margin:0 0 2px 0;
        border-radius:2px;
      "></div>

      ${vertical ? `
        <div style="
          font-size:10px;
          font-weight:900;
          color:${vertical.color};
          line-height:1;
          margin:0 0 1px 0;
        ">${vertical.arrow}</div>
      ` : ""}

      <div style="
        font-size:10px;
        font-weight:800;
        color:#000000;
        line-height:1.05;
        margin:0;
      ">${escapeHtml(smallLine1)}</div>

      ${smallLine2 ? `
        <div style="
          font-size:10px;
          font-weight:800;
          color:#000000;
          line-height:1.05;
          margin:1px 0 0 0;
        ">${escapeHtml(smallLine2)}</div>
      ` : ""}
    </div>
  `;
}

/* ------------------ 상세정보 패널 ------------------ */

function ensureAircraftDetailPanel() {
  let panel = document.getElementById("aircraft-detail-panel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "aircraft-detail-panel";
  panel.style.position = "fixed";
  panel.style.top = "46px";
  panel.style.left = "12px";
  panel.style.zIndex = "99999";
  panel.style.display = "none";
  panel.style.maxWidth = "240px";
  panel.style.padding = "6px 8px";
  panel.style.borderRadius = "8px";
  panel.style.background = "rgba(0,0,0,0.18)";
  panel.style.color = "#ffffff";
  panel.style.fontSize = "12px";
  panel.style.lineHeight = "1.35";
  panel.style.fontWeight = "700";
  panel.style.pointerEvents = "none";
  panel.style.textShadow = "0 0 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.85)";

  document.body.appendChild(panel);
  return panel;
}

function buildDetailRow(label, value, valueColor = "#ffffff") {
  const isVs = label === "V/S";
  return `
    <div style="display:grid;grid-template-columns:44px auto;column-gap:8px;margin-bottom:2px;">
      <div style="opacity:0.9;">${escapeHtml(label)}</div>
      <div style="
        color:${valueColor};
        text-shadow:${isVs ? "0 0 1px rgba(0,0,0,0.55)" : "0 0 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.85)"};
        font-weight:${isVs ? "900" : "700"};
      ">${escapeHtml(value)}</div>
    </div>
  `;
}

function formatAircraftDetailPanelHtml(ac, color) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const type = (ac.t || ac.type || "").trim();
  const altitudeText = formatAltitudeText(ac) || "-";
  const machText = formatMachText(ac) || "-";
  const vertical = getVerticalState(ac);
  const vrText = formatVerticalRateText(ac);
  const hex = (ac.hex || "").toUpperCase();
  const hexDesc = getHexDescription(ac.hex);

  const reg = (ac.r || ac.reg || ac.registration || "").toUpperCase();

  let gsText = "-";
  let iasText = "-";

  if (ac.gs != null && !isNaN(ac.gs)) {
    gsText = `${Math.round(Number(ac.gs))} KT`;
  }
  if (ac.ias != null && !isNaN(ac.ias)) {
    iasText = `${Math.round(Number(ac.ias))} KT`;
  }

  const vsDisplay = vertical ? `${vertical.arrow} ${vrText}` : "-";
  const vsColor = vertical ? vertical.color : "#ffffff";

  return `
    <div style="margin-bottom:4px;color:${escapeHtml(color)};font-size:13px;font-weight:900;">
      ${escapeHtml(flight || hex || "AIRCRAFT")}
    </div>
    ${type ? `<div style="margin-bottom:6px;">${escapeHtml(type)}</div>` : ""}
    ${buildDetailRow("ALT", altitudeText)}
    ${buildDetailRow("MACH", machText)}
    ${buildDetailRow("IAS", iasText)}
    ${buildDetailRow("G/S", gsText)}
    ${buildDetailRow("V/S", vsDisplay, vsColor)}
    ${hex ? buildDetailRow("HEX", hex) : ""}
    ${reg ? buildDetailRow("REG", reg) : ""}
    ${hexDesc ? buildDetailRow("INFO", hexDesc) : ""}
  `;
}

function showAircraftDetailPanel(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state || !ac) return;

  const panel = ensureAircraftDetailPanel();
  panel.innerHTML = formatAircraftDetailPanelHtml(ac, state.color);
  panel.style.display = "block";
  selectedAircraftTargetKey = target.key;
}

function hideAircraftDetailPanel() {
  const panel = ensureAircraftDetailPanel();
  panel.style.display = "none";
  panel.innerHTML = "";
  selectedAircraftTargetKey = null;
}

function updateAircraftDetailPanelIfSelected(target, ac) {
  if (selectedAircraftTargetKey !== target.key) return;
  showAircraftDetailPanel(target, ac);
}

/* ------------------ AIRCRAFT SIZE ------------------ */

function getAircraftIconSize(typeCodeRaw) {
  const typeCode = String(typeCodeRaw || "").toUpperCase().trim();

  if (!typeCode) return 36;

  if (
    typeCode.startsWith("A388") ||
    typeCode.startsWith("A380") ||
    typeCode.startsWith("B748") ||
    typeCode.startsWith("B744")
  ) {
    return 46;
  }

  if (
    typeCode.startsWith("B77") ||
    typeCode.startsWith("B78") ||
    typeCode.startsWith("A35") ||
    typeCode.startsWith("A33") ||
    typeCode.startsWith("A34") ||
    typeCode.startsWith("B76")
  ) {
    return 42;
  }

  if (
    typeCode.startsWith("A32") ||
    typeCode.startsWith("B73") ||
    typeCode.startsWith("B38") ||
    typeCode.startsWith("E19") ||
    typeCode.startsWith("E17") ||
    typeCode.startsWith("CRJ")
  ) {
    return 36;
  }

  if (
    typeCode.startsWith("C17") ||
    typeCode.startsWith("C18") ||
    typeCode.startsWith("SR2") ||
    typeCode.startsWith("PC12") ||
    typeCode.startsWith("BE2") ||
    typeCode.startsWith("LJ")
  ) {
    return 28;
  }

  return 34;
}

/* ------------------ AIRCRAFT ICON ------------------ */

function buildAircraftIcon(trackDeg = 0, color = "#ff8800", sizePx = 36) {
  const svgSize = Math.max(24, sizePx - 4);
  const hitSize = Math.max(sizePx, 52);
  const anchor = Math.round(hitSize / 2);

  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        width:${hitSize}px;
        height:${hitSize}px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${trackDeg}deg);
        transform-origin:center center;
        touch-action:none;
      ">
        <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 100 100">
          <g
            fill="${escapeHtml(color)}"
            stroke="black"
            stroke-width="3"
            stroke-linejoin="round"
          >
            <path d="
              M50 2
              L56 26
              L88 36
              L88 44
              L56 42
              L54 70
              L68 82
              L64 86
              L50 76
              L36 86
              L32 82
              L46 70
              L44 42
              L12 44
              L12 36
              L44 26
              Z
            "/>
          </g>
        </svg>
      </div>
    `,
    iconSize: [hitSize, hitSize],
    iconAnchor: [anchor, anchor]
  });
}

function bindAircraftMarkerEvents(marker, target, getAircraft) {
  const openPanel = (e) => {
    if (e?.originalEvent?.preventDefault) e.originalEvent.preventDefault();
    if (e?.originalEvent?.stopPropagation) e.originalEvent.stopPropagation();

    suppressNextMapClose = true;
    const ac = getAircraft();
    if (ac) showAircraftDetailPanel(target, ac);

    setTimeout(() => {
      suppressNextMapClose = false;
    }, 250);
  };

  marker.on("click", openPanel);
  marker.on("touchstart", openPanel);
}

/* ------------------ FOLLOW / CONTROL BUTTONS ------------------ */

function applyControlButtonStyle(btn) {
  btn.style.height = "28px";
  btn.style.border = "1px solid rgba(0,0,0,0.18)";
  btn.style.borderRadius = "8px";
  btn.style.background = "rgba(255,255,255,0.94)";
  btn.style.color = "#111";
  btn.style.fontSize = "10px";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 1px 4px rgba(0,0,0,0.14)";
  btn.style.backdropFilter = "blur(3px)";
  btn.style.padding = "0 6px";
  btn.style.whiteSpace = "nowrap";
  btn.style.boxSizing = "border-box";
}

function applyAircraftFollowButtonStyle(btn, color, isActive, isLive) {
  applyControlButtonStyle(btn);
  btn.style.width = "92px";
  btn.style.minWidth = "92px";
  btn.style.maxWidth = "92px";
  btn.style.flex = "0 0 92px";
  btn.style.height = "24px";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "flex-start";
  btn.style.gap = "4px";
  btn.style.textAlign = "left";
  btn.style.padding = "0 5px";
  btn.style.fontSize = "10px";
  btn.style.opacity = isLive ? "1" : "0.42";
  btn.style.filter = isLive ? "none" : "grayscale(35%)";
  btn.style.border = isActive
    ? `2px solid ${color}`
    : "1px solid rgba(0,0,0,0.18)";
  btn.style.boxShadow = isActive
    ? `0 0 0 1px ${color}33, 0 1px 4px rgba(0,0,0,0.14)`
    : "0 1px 4px rgba(0,0,0,0.14)";
  btn.style.boxSizing = "border-box";
  btn.style.overflow = "hidden";
}

function buildAircraftButtonInnerHtml(label, color) {
  return `
    <span style="
      width:6px;
      height:6px;
      min-width:6px;
      border-radius:999px;
      background:${escapeHtml(color)};
      border:1px solid rgba(0,0,0,0.35);
      display:inline-block;
      box-sizing:border-box;
    "></span>
    <span class="aircraft-btn-text" style="
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      min-width:0;
      flex:1;
      display:inline-block;
      font-size:10px;
      line-height:1;
      ${label.startsWith("HEX:") ? "font-family:Consolas, Monaco, monospace;" : ""}
    ">${escapeHtml(label)}</span>
  `;
}

function fitAircraftButtonText(btn) {
  const textEl = btn.querySelector(".aircraft-btn-text");
  if (!textEl) return;

  let fontSize = 10;
  textEl.style.fontSize = fontSize + "px";

  while (fontSize > 7 && textEl.scrollWidth > textEl.clientWidth) {
    fontSize -= 0.5;
    textEl.style.fontSize = fontSize + "px";
  }
}

function focusAllAircraft() {
  activeFollowTargetKey = null;
  refreshAircraftFollowButtons();

  const points = [];

  for (const state of aircraftStates.values()) {
    if (state.lastLatLng) points.push(state.lastLatLng);
  }

  if (points.length === 0) return;

  if (points.length === 1) {
    const targetZoom = Math.min(map.getZoom(), AIRCRAFT_FOCUS_ZOOM_MAX);
    map.flyTo(points[0], targetZoom, {
      animate: true,
      duration: 0.8
    });
    return;
  }

  const bounds = L.latLngBounds(points);
  map.flyToBounds(bounds, {
    padding: [40, 40],
    maxZoom: AIRCRAFT_FOCUS_ZOOM_MAX,
    animate: true,
    duration: 0.8
  });
}

function focusAircraftTarget(targetKey, enableFollow = true) {
  const state = aircraftStates.get(targetKey);
  if (!state) return;

  activeFollowTargetKey = enableFollow ? targetKey : null;
  refreshAircraftFollowButtons();

  if (!state.lastLatLng) return;

  const targetZoom = Math.max(map.getZoom(), FOLLOW_AIRCRAFT_ZOOM_MIN);
  map.flyTo(state.lastLatLng, targetZoom, {
    animate: true,
    duration: 0.8
  });
}

function refreshAircraftFollowButtons() {
  const list = document.getElementById("aircraft-follow-list");
  if (!list) return;

  list.innerHTML = "";

  TARGETS.forEach(target => {
    const state = aircraftStates.get(target.key);
    if (!state) return;

    const btn = document.createElement("button");
    btn.type = "button";

    const label = getAircraftButtonLabel(state.lastAircraft, target);
    const isActive = activeFollowTargetKey === target.key;
    const isLive = !!state.isLive;

    applyAircraftFollowButtonStyle(btn, state.color, isActive, isLive);
    btn.innerHTML = buildAircraftButtonInnerHtml(label, state.color);
    fitAircraftButtonText(btn);
    btn.title = isLive ? label : `${label} (NOT LIVE)`;

    btn.onclick = () => {
      const latestState = aircraftStates.get(target.key);
      if (!latestState) return;

      if (latestState.lastAircraft) {
        showAircraftDetailPanel(target, latestState.lastAircraft);
      }

      focusAircraftTarget(target.key, true);
    };

    state.buttonEl = btn;
    list.appendChild(btn);
  });
}

function createToggleButton() {
  if (!document.getElementById("custom-gps-control")) {
    const gpsWrap = document.createElement("div");
    gpsWrap.id = "custom-gps-control";
    gpsWrap.style.position = "fixed";
    gpsWrap.style.top = "10px";
    gpsWrap.style.left = "10px";
    gpsWrap.style.zIndex = "99999";

    const gpsBtn = document.createElement("button");
    gpsBtn.id = "focus-gps-btn";
    gpsBtn.type = "button";
    gpsBtn.textContent = "GPS";
    gpsBtn.style.width = "50px";
    applyControlButtonStyle(gpsBtn);
    gpsBtn.onclick = async () => {
      activeFollowTargetKey = null;
      refreshAircraftFollowButtons();
      hideAircraftDetailPanel();

      await startDeviceCompass();

      if (!lastUserLatLng) return;

      const targetZoom = Math.max(map.getZoom(), USER_GPS_ZOOM_MIN);

      map.flyTo(lastUserLatLng, targetZoom, {
        animate: true,
        duration: 0.8
      });
    };

    gpsWrap.appendChild(gpsBtn);
    document.body.appendChild(gpsWrap);
  }

  let wrap = document.getElementById("custom-follow-controls");
  if (wrap) return;

  wrap = document.createElement("div");
  wrap.id = "custom-follow-controls";
  wrap.style.position = "fixed";
  wrap.style.left = "8px";
  wrap.style.bottom = "14px";
  wrap.style.zIndex = "99999";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "6px";
  wrap.style.width = "auto";
  wrap.style.maxWidth = "calc(100vw - 16px)";
  wrap.style.boxSizing = "border-box";

  const acBtn = document.createElement("button");
  acBtn.id = "focus-aircraft-btn";
  acBtn.type = "button";
  acBtn.textContent = "AC ALL";
  acBtn.style.width = "104px";
  applyControlButtonStyle(acBtn);
  acBtn.onclick = () => {
    hideAircraftDetailPanel();
    focusAllAircraft();
  };

  const aircraftList = document.createElement("div");
  aircraftList.id = "aircraft-follow-list";
  aircraftList.style.display = "flex";
  aircraftList.style.flexWrap = "wrap";
  aircraftList.style.gap = "4px";
  aircraftList.style.alignItems = "flex-start";
  aircraftList.style.justifyContent = "flex-start";
  aircraftList.style.width = "auto";
  aircraftList.style.maxWidth = "calc(100vw - 16px)";
  aircraftList.style.boxSizing = "border-box";

  wrap.appendChild(acBtn);
  wrap.appendChild(aircraftList);
  document.body.appendChild(wrap);

  ensureAircraftDetailPanel();
  refreshAircraftFollowButtons();
}

function syncFollowView(target) {
  if (activeFollowTargetKey !== target.key) return;

  const state = aircraftStates.get(target.key);
  if (!state || !state.lastLatLng) return;

  const targetZoom = Math.max(map.getZoom(), FOLLOW_AIRCRAFT_ZOOM_MIN);
  map.flyTo(state.lastLatLng, targetZoom, {
    animate: true,
    duration: 0.8
  });
}

/* ------------------ AIRCRAFT DRAW ------------------ */

function getWrappedAircraftLatLng(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state) return null;

  const lat = Number(ac.lat);
  const rawLon = Number(ac.lon);

  if (!isFinite(lat) || !isFinite(rawLon)) return null;

  const prevLon = state.lastLatLng ? Number(state.lastLatLng[1]) : NaN;
  const wrappedLon = getWrappedLonUsingRouteReference(rawLon, prevLon);

  return [lat, wrappedLon];
}

function ensureAircraftMarker(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state) return;

  const newLatLng = getWrappedAircraftLatLng(target, ac);
  if (!newLatLng) return;

  const track = Number(ac.track || ac.true_heading || ac.mag_heading || 0);

  state.lastLatLng = newLatLng;

  const typeCode = ac.t || ac.type || "";
  const sizePx = getAircraftIconSize(typeCode);
  const icon = buildAircraftIcon(track, state.color, sizePx);
  const labelHtml = formatAircraftLabelHtml(ac, state.color);

  if (!state.marker) {
    state.marker = L.marker(newLatLng, {
      icon,
      zIndexOffset: 1000
    }).addTo(map);

    state.marker.bindTooltip(labelHtml, {
      permanent: true,
      direction: "top",
      offset: [0, -12],
      className: "aircraft-label-tooltip",
      opacity: 1
    });
    state.tooltipBound = true;

    bindAircraftMarkerEvents(state.marker, target, () => state.lastAircraft || ac);
  } else {
    state.marker.setLatLng(newLatLng);
    state.marker.setIcon(icon);

    if (state.tooltipBound && state.marker.getTooltip()) {
      state.marker.setTooltipContent(labelHtml);
    } else {
      state.marker.bindTooltip(labelHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "aircraft-label-tooltip",
        opacity: 1
      });
      state.tooltipBound = true;
    }
  }

  updateAircraftDetailPanelIfSelected(target, ac);
}

function updateLiveTrail(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state) return;

  const point = getWrappedAircraftLatLng(target, ac);
  if (!point) return;

  const prev = state.liveTrail[state.liveTrail.length - 1];

  if (prev) {
    const dLat = Math.abs(prev[0] - point[0]);
    const dLon = Math.abs(prev[1] - point[1]);
    if (dLat < 0.00002 && dLon < 0.00002) return;
  }

  state.liveTrail.push(point);

  if (state.liveTrail.length > MAX_LIVE_TRAIL_POINTS) {
    state.liveTrail.shift();
  }

  if (!state.liveTrailLine) {
    state.liveTrailLine = L.polyline(state.liveTrail, {
      color: state.color,
      weight: 3,
      opacity: 0.7,
      dashArray: "6,6",
      smoothFactor: 1
    }).addTo(map);
  } else {
    state.liveTrailLine.setLatLngs(state.liveTrail);
  }
}

function updateAircraftForTarget(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state || !ac) return;

  state.lastAircraft = ac;
  state.staleCount = 0;
  state.lastSeenAt = Date.now();

  ensureAircraftMarker(target, ac);
  updateLiveTrail(target, ac);
  refreshAircraftFollowButtons();
  syncFollowView(target);
}

function clearAircraftFromMap(targetKey) {
  const state = aircraftStates.get(targetKey);
  if (!state) return;

  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }

  if (state.marker && map.hasLayer(state.marker)) {
    map.removeLayer(state.marker);
  }
  state.marker = null;
  state.tooltipBound = false;

  if (state.liveTrailLine && map.hasLayer(state.liveTrailLine)) {
    map.removeLayer(state.liveTrailLine);
  }
  state.liveTrailLine = null;
  state.liveTrail = [];

 
  state.lastLatLng = null;
  state.isLive = false;
  state.staleCount = 0;

  if (activeFollowTargetKey === targetKey) {
    activeFollowTargetKey = null;
  }

  if (selectedAircraftTargetKey === targetKey) {
    hideAircraftDetailPanel();
  }
}

/* ------------------ AIRCRAFT ANIMATION ------------------ */

function animateAircraftIfNeeded(target, prevAc, nextAc) {
  const state = aircraftStates.get(target.key);
  if (!state) return;

  if (!state.marker || !prevAc || !nextAc) {
    updateAircraftForTarget(target, nextAc);
    return;
  }

  const fromLat = Number(prevAc.lat);
  const fromRawLon = Number(prevAc.lon);
  const toLat = Number(nextAc.lat);
  const toRawLon = Number(nextAc.lon);

  if ([fromLat, fromRawLon, toLat, toRawLon].some(v => !isFinite(v))) {
    updateAircraftForTarget(target, nextAc);
    return;
  }

  const referenceLon = state.lastLatLng ? Number(state.lastLatLng[1]) : getRouteReferenceLonSafe();
  const fromLon = getWrappedLonUsingRouteReference(fromRawLon, referenceLon);
  const toLon = getWrappedLonUsingRouteReference(toRawLon, fromLon);

  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }

  const track = Number(nextAc.track || nextAc.true_heading || nextAc.mag_heading || 0);
  const typeCode = nextAc.t || nextAc.type || "";
  const sizePx = getAircraftIconSize(typeCode);
  const icon = buildAircraftIcon(track, state.color, sizePx);
  const labelHtml = formatAircraftLabelHtml(nextAc, state.color);

  const start = performance.now();
  const token = ++state.animationToken;

  function step(now) {
    if (token !== state.animationToken) return;

    const t = Math.min(1, (now - start) / ANIMATION_DURATION_MS);
    const lat = fromLat + (toLat - fromLat) * t;
    const lon = fromLon + (toLon - fromLon) * t;

    state.lastLatLng = [lat, lon];

    if (!state.marker) {
      state.marker = L.marker([lat, lon], {
        icon,
        zIndexOffset: 1000
      }).addTo(map);

      state.marker.bindTooltip(labelHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "aircraft-label-tooltip",
        opacity: 1
      });
      state.tooltipBound = true;

      bindAircraftMarkerEvents(state.marker, target, () => state.lastAircraft || nextAc);
    } else {
      state.marker.setLatLng([lat, lon]);
      state.marker.setIcon(icon);

      if (state.tooltipBound && state.marker.getTooltip()) {
        state.marker.setTooltipContent(labelHtml);
      }
    }

    updateAircraftDetailPanelIfSelected(target, nextAc);

    if (t < 1) {
      state.animationFrameId = requestAnimationFrame(step);
    } else {
      state.animationFrameId = null;
      updateAircraftForTarget(target, nextAc);
    }
  }

  state.animationFrameId = requestAnimationFrame(step);
}

/* ------------------ ADS-B FETCH ------------------ */

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function indexAircraftList(aircraftList) {
  const byHex = new Map();

  for (const ac of aircraftList || []) {
    const hex = normalizeHex(ac.hex);
    if (hex && !byHex.has(hex)) byHex.set(hex, ac);
  }

  return { byHex };
}

async function fetchProviderByHex(provider, targets) {
  const hexes = [...new Set(targets.map(t => t.hex).filter(Boolean))];
  if (hexes.length === 0) return [];

  const url = buildProviderUrl(provider, hexes.join(","));
  const data = await fetchJson(url);
  return Array.isArray(data.ac) ? data.ac : [];
}

async function fetchBatchAircraftData() {
  const hexes = [...new Set(TARGETS.map(t => t.hex).filter(Boolean))];
  if (!hexes.length) return new Map();

  const url = `${SCRIPT_URL}?hexes=${encodeURIComponent(hexes.join(","))}`;
  const data = await fetchJson(url);

  if (!data || !data.ok) {
    throw new Error(data?.error || "Apps Script fetch failed");
  }

  const aircraft = dedupeAircraftList(Array.isArray(data.ac) ? data.ac : []);
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

async function pollAircraft() {
  if (!TARGETS.length || isPollingAircraft) return;

  isPollingAircraft = true;

  try {
    const resolvedMap = await fetchBatchAircraftData();
    const now = Date.now();

    for (const target of TARGETS) {
      const state = aircraftStates.get(target.key);
      if (!state) continue;

      const ac = resolvedMap.get(target.key) || null;

      if (!ac) {
        state.staleCount = (state.staleCount || 0) + 1;

        if (state.staleCount >= 6) {
          state.isLive = false;
        }

        if (state.lastSeenAt && (now - state.lastSeenAt >= AIRCRAFT_STALE_REMOVE_MS)) {
          clearAircraftFromMap(target.key);
        }

        continue;
      }

      state.isLive = true;
      state.staleCount = 0;
      state.lastSeenAt = now;

      if (!state.lastAircraft) {
        updateAircraftForTarget(target, ac);
      } else {
        animateAircraftIfNeeded(target, state.lastAircraft, ac);
      }
    }

    refreshAircraftFollowButtons();
  } catch (err) {
    console.error("pollAircraft error:", err);

    const now = Date.now();

    for (const target of TARGETS) {
      const state = aircraftStates.get(target.key);
      if (!state) continue;

      state.staleCount = (state.staleCount || 0) + 1;

      if (state.staleCount >= 6) {
        state.isLive = false;
      }

      if (state.lastSeenAt && (now - state.lastSeenAt >= AIRCRAFT_STALE_REMOVE_MS)) {
        clearAircraftFromMap(target.key);
      }
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
   // appendUserTrailPoint(lat, lon, accuracy, gpsTimestamp);
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

  if (TARGETS.length > 0) {
    pollAircraft();
    setInterval(pollAircraft, POLL_INTERVAL_MS);
  }
}

initAircraftTracking();
