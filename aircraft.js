const params = new URLSearchParams(window.location.search);

/* ------------------ TARGET PARSE ------------------ */

function parseCsvParam(name) {
  return (params.get(name) || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

const singleReg = (params.get("reg") || "").toUpperCase().trim();
const singleHex = (params.get("hex") || "").toLowerCase().trim();

const multiRegs = parseCsvParam("regs").map(x => x.toUpperCase());
const multiHexes = [
  ...parseCsvParam("hexes"),
  ...parseCsvParam("hexs")
].map(x => x.toLowerCase());

let TARGETS = [];

if (multiRegs.length || multiHexes.length) {
  TARGETS = [
    ...multiRegs.map(reg => ({ key: `reg:${reg}`, reg, hex: "" })),
    ...multiHexes.map(hex => ({ key: `hex:${hex}`, reg: "", hex }))
  ];
} else if (singleReg || singleHex) {
  TARGETS = [{
    key: singleReg ? `reg:${singleReg}` : `hex:${singleHex}`,
    reg: singleReg,
    hex: singleHex
  }];
}

TARGETS = TARGETS.slice(0, 5);

/* ------------------ API / SETTINGS ------------------ */

const ADSB_API_BASES = [
  "https://api.adsb.lol",
  "https://api.adsb.one"
];

const POLL_INTERVAL_MS = 5000;
const ANIMATION_DURATION_MS = 4500;
const MAX_LIVE_TRAIL_POINTS = 500;

/* ------------------ GPS / USER SETTINGS ------------------ */

const USER_GPS_ZOOM_MIN = 10;
const AIRCRAFT_FOCUS_ZOOM_MAX = 8;
const FOLLOW_AIRCRAFT_ZOOM_MIN = 9;
const MAX_USER_TRAIL_POINTS = 1000;

const RUNNING_SPEED_MAX_KT = 8.0;
const COMPASS_HEADING_SMOOTHING = 0.18;
const USER_HEADING_CHANGE_MIN_DEG = 2;

/* --- GPS TRAIL SETTINGS --- */
const USER_TRAIL_MAX_ACCURACY_M = 55;
const USER_TRAIL_BASE_MAX_ACCURACY_M = 50;
const USER_TRAIL_JUMP_MAX_TIME_S = 5;
const USER_TRAIL_MAX_SPEED_MPS = 8;
const USER_TRAIL_MIN_MOVE_M = 5;

const USER_TRAIL_DASH_MAX_DIST_M = 120;
const USER_TRAIL_DASH_MAX_TIME_S = 25;

const USER_TRAIL_SMOOTHING_WINDOW = 3;
const USER_TRAIL_STORAGE_KEY = "userTrailState_v3";
const USER_TRAIL_STORAGE_LIMIT = 300;
const USER_TRAIL_STORAGE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/* ------------------ COLORS ------------------ */

const AIRCRAFT_COLORS = [
  "#ff8800",
  "#1e90ff",
  "#28a745",
  "#d63384",
  "#6f42c1"
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
  isLive
}
*/

let lastGoodApiBase = null;
let activeFollowTargetKey = null;

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
      isLive: false
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

function metersBetweenLatLng(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function averagePoint(points) {
  if (!points || points.length === 0) return null;
  const sum = points.reduce(
    (acc, p) => {
      acc.lat += p.lat;
      acc.lng += p.lng;
      return acc;
    },
    { lat: 0, lng: 0 }
  );
  return {
    lat: sum.lat / points.length,
    lng: sum.lng / points.length
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

function normalizeReg(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeHex(v) {
  return String(v || "").trim().toLowerCase();
}

/* ------------------ BUTTON LABEL ------------------ */

function getAircraftButtonLabel(ac, target) {
  const callsign = (ac?.flight || ac?.callsign || "").trim();
  const reg = (ac?.r || ac?.reg || target?.reg || "").trim();
  const hex = (ac?.hex || target?.hex || "").toUpperCase();

  if (callsign && reg) return `${callsign} (${reg})`;
  if (callsign) return callsign;
  if (reg) return reg;
  if (hex) return `HEX: ${hex}`;
  return "UNKNOWN";
}

/* ------------------ AIRCRAFT FORMAT ------------------ */

function formatAltitudeText(ac) {
  const altBaro = ac.alt_baro;
  const altGeom = ac.alt_geom;
  const altFt = altBaro ?? altGeom;

  if (altFt == null || isNaN(altFt)) return "";

  const ft = Math.round(Number(altFt));

  if (ft >= 18000) {
    return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  }

  return ft.toLocaleString() + " ft";
}

function formatMachText(ac) {
  if (ac.mach != null && !isNaN(ac.mach)) {
    return "M" + String(Number(ac.mach).toFixed(2)).replace(/^0/, "");
  }
  return "";
}

function formatSpeedLines(ac) {
  const lines = [];

  if (ac.ias != null && !isNaN(ac.ias)) {
    lines.push("IAS " + Math.round(Number(ac.ias)) + "KT");
  }

  if (ac.gs != null && !isNaN(ac.gs)) {
    lines.push("GS " + Math.round(Number(ac.gs)) + "KT");
  }

  return lines;
}

function formatVerticalRateText(ac) {
  const vr = Number(ac.vert_rate);
  if (isNaN(vr) || vr === 0) return "0 FPM";
  return `${vr > 0 ? "+" : ""}${Math.round(vr)} FPM`;
}

function getVerticalState(ac) {
  const vr = Number(ac.vert_rate);

  if (isNaN(vr)) {
    return { arrow: "→", color: "#111111" };
  }

  if (vr > 300) {
    return { arrow: "▲", color: "#d60000" };
  }

  if (vr < -300) {
    return { arrow: "▼", color: "#0066ff" };
  }

  return { arrow: "→", color: "#111111" };
}

/* 항상 보이는 작은 라벨 */
function formatAircraftLabelHtml(ac, color) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const reg = (ac.r || ac.reg || "").trim();
  const altitudeText = formatAltitudeText(ac);
  const vertical = getVerticalState(ac);

  const smallLine1 = flight || reg || "UNKNOWN";
  const smallLine2 = altitudeText || "";

  return `
    <div style="
      font-size:10px;
      color:#000;
      font-weight:800;
      white-space:nowrap;
      text-align:center;
      line-height:1.1;
      text-shadow:
        -1px -1px 0 #fff,
         1px -1px 0 #fff,
        -1px  1px 0 #fff,
         1px  1px 0 #fff;
      border-top:2px solid ${escapeHtml(color)};
      padding-top:2px;
      min-width:42px;
    ">
      <div style="
        font-size:11px;
        font-weight:900;
        color:${vertical.color};
        margin-bottom:1px;
      ">${vertical.arrow}</div>
      <div>${escapeHtml(smallLine1)}</div>
      ${smallLine2 ? `<div>${escapeHtml(smallLine2)}</div>` : ""}
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
  panel.style.maxWidth = "220px";
  panel.style.padding = "6px 8px";
  panel.style.borderRadius = "8px";

  /* 핵심: 아주 약한 검정 그라데이션 */
  panel.style.background = "linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.12) 100%)";

  panel.style.color = "#ffffff";
  panel.style.fontSize = "12px";
  panel.style.lineHeight = "1.35";
  panel.style.fontWeight = "700";
  panel.style.pointerEvents = "none";

  panel.style.textShadow = `
    -1px -1px 2px rgba(0,0,0,0.95),
     1px -1px 2px rgba(0,0,0,0.95),
    -1px  1px 2px rgba(0,0,0,0.95),
     1px  1px 2px rgba(0,0,0,0.95),
     0px  0px 5px rgba(0,0,0,0.9)
  `;

  document.body.appendChild(panel);
  return panel;
}
function buildDetailRow(label, value, valueColor = "#ffffff") {
  return `
    <div style="display:grid;grid-template-columns:44px auto;column-gap:8px;margin-bottom:2px;">
      <div style="opacity:0.9;">${escapeHtml(label)}</div>
      <div style="color:${valueColor};">${escapeHtml(value)}</div>
    </div>
  `;
}

function formatAircraftDetailPanelHtml(ac, color) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const reg = (ac.r || ac.reg || "").trim();
  const type = (ac.t || ac.type || "").trim();
  const altitudeText = formatAltitudeText(ac) || "-";
  const machText = formatMachText(ac) || "-";
  const vertical = getVerticalState(ac);
  const vrText = formatVerticalRateText(ac);
  const hex = (ac.hex || "").toUpperCase();

  let gsText = "-";
  let iasText = "-";

  if (ac.gs != null && !isNaN(ac.gs)) {
    gsText = `${Math.round(Number(ac.gs))}KT`;
  }
  if (ac.ias != null && !isNaN(ac.ias)) {
    iasText = `${Math.round(Number(ac.ias))}KT`;
  }

  return `
    <div style="margin-bottom:4px;color:${escapeHtml(color)};font-size:13px;font-weight:900;">
      ${escapeHtml(flight || reg || hex || "AIRCRAFT")}
    </div>
    ${reg ? `<div style="margin-bottom:4px;">${escapeHtml(reg)}</div>` : ""}
    ${type ? `<div style="margin-bottom:6px;">${escapeHtml(type)}</div>` : ""}
    ${buildDetailRow("ALT", altitudeText)}
    ${buildDetailRow("SPD", gsText)}
    ${buildDetailRow("IAS", iasText)}
    ${buildDetailRow("MACH", machText)}
    ${buildDetailRow("V/S", `${vertical.arrow} ${vrText}`, vertical.color)}
    ${hex ? buildDetailRow("HEX", hex) : ""}
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
  const anchor = Math.round(sizePx / 2);

  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        width:${sizePx}px;
        height:${sizePx}px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${trackDeg}deg);
        transform-origin:center center;
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
    iconSize: [sizePx, sizePx],
    iconAnchor: [anchor, anchor]
  });
}

/* ------------------ FOLLOW / CONTROL BUTTONS ------------------ */

function applyControlButtonStyle(btn) {
  btn.style.height = "28px";
  btn.style.border = "1px solid rgba(0,0,0,0.18)";
  btn.style.borderRadius = "8px";
  btn.style.background = "rgba(255,255,255,0.94)";
  btn.style.color = "#111";
  btn.style.fontSize = "11px";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 1px 4px rgba(0,0,0,0.14)";
  btn.style.backdropFilter = "blur(3px)";
  btn.style.padding = "0 8px";
  btn.style.whiteSpace = "nowrap";
}

function applyAircraftFollowButtonStyle(btn, color, isActive, isLive) {
  applyControlButtonStyle(btn);
  btn.style.width = "auto";
  btn.style.minWidth = "104px";
  btn.style.maxWidth = "168px";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "flex-start";
  btn.style.gap = "6px";
  btn.style.textAlign = "left";
  btn.style.opacity = isLive ? "1" : "0.42";
  btn.style.filter = isLive ? "none" : "grayscale(35%)";
  btn.style.border = isActive
    ? `2px solid ${color}`
    : "1px solid rgba(0,0,0,0.18)";
  btn.style.boxShadow = isActive
    ? `0 0 0 1px ${color}33, 0 1px 4px rgba(0,0,0,0.14)`
    : "0 1px 4px rgba(0,0,0,0.14)";
}

function buildAircraftButtonInnerHtml(label, color) {
  return `
    <span style="
      width:8px;
      height:8px;
      min-width:8px;
      border-radius:999px;
      background:${escapeHtml(color)};
      border:1px solid rgba(0,0,0,0.35);
      display:inline-block;
    "></span>
    <span style="
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      max-width:136px;
      display:inline-block;
      font-size:11px;
      ${label.startsWith("HEX:") ? "font-family:Consolas, Monaco, monospace;" : ""}
    ">${escapeHtml(label)}</span>
  `;
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
    btn.title = isLive ? label : `${label} (NOT LIVE)`;

    btn.onclick = () => {
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
    gpsBtn.style.width = "104px";
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
  wrap.style.maxWidth = "calc(100vw - 16px)";

  const acBtn = document.createElement("button");
  acBtn.id = "focus-aircraft-btn";
  acBtn.type = "button";
  acBtn.textContent = "AC ALL";
  acBtn.style.width = "104px";
  applyControlButtonStyle(acBtn);
  acBtn.onclick = () => {
    focusAllAircraft();
  };

  const aircraftList = document.createElement("div");
  aircraftList.id = "aircraft-follow-list";
  aircraftList.style.display = "grid";
  aircraftList.style.gridTemplateColumns = "repeat(3, max-content)";
  aircraftList.style.gridAutoRows = "max-content";
  aircraftList.style.gap = "6px";
  aircraftList.style.alignItems = "start";
  aircraftList.style.justifyContent = "start";
  aircraftList.style.maxWidth = "calc(100vw - 16px)";

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

function ensureAircraftMarker(target, ac) {
  const state = aircraftStates.get(target.key);
  if (!state) return;

  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  const track = Number(ac.track || ac.true_heading || ac.mag_heading || 0);

  if (isNaN(lat) || isNaN(lon)) return;

  const newLatLng = [lat, lon];
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

    state.marker.on("click", () => {
      suppressNextMapClose = true;
      showAircraftDetailPanel(target, ac);
      setTimeout(() => {
        suppressNextMapClose = false;
      }, 120);
    });
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

  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (isNaN(lat) || isNaN(lon)) return;

  const point = [lat, lon];
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
  ensureAircraftMarker(target, ac);
  updateLiveTrail(target, ac);
  refreshAircraftFollowButtons();
  syncFollowView(target);
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
  const fromLon = Number(prevAc.lon);
  const toLat = Number(nextAc.lat);
  const toLon = Number(nextAc.lon);

  if ([fromLat, fromLon, toLat, toLon].some(v => isNaN(v))) {
    updateAircraftForTarget(target, nextAc);
    return;
  }

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

      state.marker.on("click", () => {
        suppressNextMapClose = true;
        showAircraftDetailPanel(target, nextAc);
        setTimeout(() => {
          suppressNextMapClose = false;
        }, 120);
      });
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

/* ------------------ ADS-B FETCH (BATCH) ------------------ */

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

function indexAircraftList(aircraftList) {
  const byHex = new Map();
  const byReg = new Map();

  for (const ac of aircraftList || []) {
    const hex = normalizeHex(ac.hex);
    const reg = normalizeReg(ac.r || ac.reg);

    if (hex && !byHex.has(hex)) byHex.set(hex, ac);
    if (reg && !byReg.has(reg)) byReg.set(reg, ac);
  }

  return { byHex, byReg };
}

async function fetchBatchAircraftData() {
  const bases = lastGoodApiBase
    ? [lastGoodApiBase, ...ADSB_API_BASES.filter(x => x !== lastGoodApiBase)]
    : [...ADSB_API_BASES];

  const regs = [...new Set(TARGETS.map(t => t.reg).filter(Boolean))];
  const hexes = [...new Set(TARGETS.map(t => t.hex).filter(Boolean))];

  let lastError = null;

  for (const base of bases) {
    try {
      let aircraft = [];

      if (hexes.length > 0) {
        const url = `${base}/v2/hex/${encodeURIComponent(hexes.join(","))}`;
        const data = await fetchJson(url);
        if (Array.isArray(data.ac)) aircraft.push(...data.ac);
      }

      if (regs.length > 0) {
        const url = `${base}/v2/reg/${encodeURIComponent(regs.join(","))}`;
        const data = await fetchJson(url);
        if (Array.isArray(data.ac)) aircraft.push(...data.ac);
      }

      lastGoodApiBase = base;
      return aircraft;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Aircraft batch fetch failed");
}

async function pollAircraft() {
  if (!TARGETS.length) return;

  try {
    const aircraft = await fetchBatchAircraftData();
    const { byHex, byReg } = indexAircraftList(aircraft);

    for (const target of TARGETS) {
      const state = aircraftStates.get(target.key);
      if (!state) continue;

      let ac = null;

      if (target.hex) ac = byHex.get(target.hex) || null;
      if (!ac && target.reg) ac = byReg.get(target.reg) || null;

      if (!ac) {
        state.isLive = false;
        continue;
      }

      state.isLive = true;

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
    }

    refreshAircraftFollowButtons();
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

function updateUserLocation(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
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
