const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

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
const MAX_USER_TRAIL_POINTS = 1000;

const RUNNING_SPEED_MAX_KT = 8.0;
const COMPASS_HEADING_SMOOTHING = 0.18;
const USER_HEADING_CHANGE_MIN_DEG = 2;

/* --- 100점 GPS TRAIL SETTINGS --- */
const USER_TRAIL_MAX_ACCURACY_M = 55;       // 완전 컷 기준
const USER_TRAIL_BASE_MAX_ACCURACY_M = 45;  // 정상 허용 기준
const USER_TRAIL_JUMP_MAX_TIME_S = 5;
const USER_TRAIL_MAX_SPEED_MPS = 8;
const USER_TRAIL_MIN_MOVE_M = 5;

const USER_TRAIL_DASH_MAX_DIST_M = 120;     // 너무 긴 점선 금지
const USER_TRAIL_DASH_MAX_TIME_S = 25;

const USER_TRAIL_SMOOTHING_WINDOW = 3;      // 최근 3점 기반
const USER_TRAIL_STORAGE_KEY = "userTrailState_v1";
const USER_TRAIL_STORAGE_LIMIT = 300;

/* ------------------ STATE ------------------ */

let aircraftMarker = null;
let aircraftTooltipBound = false;
let liveTrail = [];
let liveTrailLine = null;

let lastAircraft = null;
let lastGoodApiBase = null;
let trackingStarted = false;

let animationFrameId = null;
let animationToken = 0;

let lastAircraftLatLng = null;
let lastUserLatLng = null;

/* ------------------ USER / GPS STATE ------------------ */

let userMarker = null;
let userAccuracyCircle = null;
let userHeadingMarker = null;

let gpsWatchId = null;
let deviceCompassHeading = null;
let lastUserHeadingDeg = null;
let lastKnownSpeedKt = null;
let compassStarted = false;

/* --- improved user trail state --- */
let lastAcceptedUserPoint = null;
let pendingGapStartPoint = null;

let userTrailSolidSegments = [];
let userTrailDashedSegments = [];

let userTrailSolidLines = [];
let userTrailDashedLines = [];

let currentSolidSegment = null;
let currentSolidLine = null;

let recentAcceptedUserPoints = [];

/* ------------------ BUTTONS ------------------ */

function applyControlButtonStyle(btn) {
  btn.style.width = "54px";
  btn.style.height = "34px";
  btn.style.border = "1px solid rgba(0,0,0,0.2)";
  btn.style.borderRadius = "8px";
  btn.style.background = "rgba(255,255,255,0.95)";
  btn.style.color = "#111";
  btn.style.fontSize = "12px";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";
  btn.style.backdropFilter = "blur(4px)";
}

function createToggleButton() {
  let wrap = document.getElementById("custom-follow-controls");
  if (wrap) return;

  wrap = document.createElement("div");
  wrap.id = "custom-follow-controls";
  wrap.style.position = "fixed";
  wrap.style.top = "108px";
  wrap.style.right = "10px";
  wrap.style.zIndex = "99999";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "6px";

  const acBtn = document.createElement("button");
  acBtn.id = "focus-aircraft-btn";
  acBtn.type = "button";
  acBtn.textContent = "A/C";
  applyControlButtonStyle(acBtn);

  acBtn.onclick = () => {
    if (!lastAircraftLatLng) return;

    const targetZoom = Math.min(map.getZoom(), AIRCRAFT_FOCUS_ZOOM_MAX);

    map.flyTo(lastAircraftLatLng, targetZoom, {
      animate: true,
      duration: 0.8
    });
  };

  const gpsBtn = document.createElement("button");
  gpsBtn.id = "focus-gps-btn";
  gpsBtn.type = "button";
  gpsBtn.textContent = "GPS";
  applyControlButtonStyle(gpsBtn);

  gpsBtn.onclick = async () => {
    await startDeviceCompass();

    if (!lastUserLatLng) return;

    const targetZoom = Math.max(map.getZoom(), USER_GPS_ZOOM_MIN);

    map.flyTo(lastUserLatLng, targetZoom, {
      animate: true,
      duration: 0.8
    });
  };

  wrap.appendChild(acBtn);
  wrap.appendChild(gpsBtn);
  document.body.appendChild(wrap);
}

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

function formatAircraftLabelHtml(ac) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const reg = (ac.r || ac.reg || "").trim();
  const type = (ac.t || ac.type || "").trim();
  const altitudeText = formatAltitudeText(ac);
  const machText = formatMachText(ac);
  const speedLines = formatSpeedLines(ac);

  const line1 = [flight, reg ? `(${reg})` : ""].filter(Boolean).join(" ");
  const line2 = [type, altitudeText].filter(Boolean).join(" ");

  return `
    <div style="
      font-size:11px;
      color:#000;
      font-weight:700;
      white-space:nowrap;
      text-align:center;
      line-height:1.2;
      text-shadow:
        -1px -1px 0 #fff,
         1px -1px 0 #fff,
        -1px  1px 0 #fff,
         1px  1px 0 #fff;
    ">
      ${line1 ? `<div>${escapeHtml(line1)}</div>` : ""}
      ${line2 ? `<div>${escapeHtml(line2)}</div>` : ""}
      ${machText ? `<div>${escapeHtml(machText)}</div>` : ""}
      ${speedLines.map(x => `<div>${escapeHtml(x)}</div>`).join("")}
    </div>
  `;
}

/* ------------------ AIRCRAFT ICON ------------------ */

function buildAircraftIcon(trackDeg = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        width:36px;
        height:36px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${trackDeg}deg);
        transform-origin:center center;
      ">
        <svg width="32" height="32" viewBox="0 0 100 100">
          <g
            fill="#ff8800"
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
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

/* ------------------ AIRCRAFT DRAW ------------------ */

function ensureAircraftMarker(ac) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  const track = Number(ac.track || ac.true_heading || ac.mag_heading || 0);

  if (isNaN(lat) || isNaN(lon)) return;

  const newLatLng = [lat, lon];
  lastAircraftLatLng = newLatLng;

  const icon = buildAircraftIcon(track);
  const labelHtml = formatAircraftLabelHtml(ac);

  if (!aircraftMarker) {
    aircraftMarker = L.marker(newLatLng, {
      icon,
      zIndexOffset: 1000
    }).addTo(map);

    aircraftMarker.bindTooltip(labelHtml, {
      permanent: true,
      direction: "top",
      offset: [0, -12],
      className: "aircraft-label-tooltip",
      opacity: 1
    });
    aircraftTooltipBound = true;
  } else {
    aircraftMarker.setLatLng(newLatLng);
    aircraftMarker.setIcon(icon);

    if (aircraftTooltipBound && aircraftMarker.getTooltip()) {
      aircraftMarker.setTooltipContent(labelHtml);
    } else {
      aircraftMarker.bindTooltip(labelHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "aircraft-label-tooltip",
        opacity: 1
      });
      aircraftTooltipBound = true;
    }
  }
}

function updateLiveTrail(ac) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (isNaN(lat) || isNaN(lon)) return;

  const point = [lat, lon];
  const prev = liveTrail[liveTrail.length - 1];

  if (prev) {
    const dLat = Math.abs(prev[0] - point[0]);
    const dLon = Math.abs(prev[1] - point[1]);
    if (dLat < 0.00002 && dLon < 0.00002) return;
  }

  liveTrail.push(point);

  if (liveTrail.length > MAX_LIVE_TRAIL_POINTS) {
    liveTrail.shift();
  }

  if (!liveTrailLine) {
    liveTrailLine = L.polyline(liveTrail, {
      color: "#ff9c4a",
      weight: 3,
      opacity: 0.75,
      dashArray: "6,6",
      smoothFactor: 1
    }).addTo(map);
  } else {
    liveTrailLine.setLatLngs(liveTrail);
  }
}

function updateAircraft(ac) {
  if (!ac) return;
  lastAircraft = ac;
  ensureAircraftMarker(ac);
  updateLiveTrail(ac);
}

/* ------------------ AIRCRAFT ANIMATION ------------------ */

function animateAircraftIfNeeded(prevAc, nextAc) {
  if (!aircraftMarker || !prevAc || !nextAc) {
    updateAircraft(nextAc);
    return;
  }

  const fromLat = Number(prevAc.lat);
  const fromLon = Number(prevAc.lon);
  const toLat = Number(nextAc.lat);
  const toLon = Number(nextAc.lon);

  if ([fromLat, fromLon, toLat, toLon].some(v => isNaN(v))) {
    updateAircraft(nextAc);
    return;
  }

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  const track = Number(nextAc.track || nextAc.true_heading || nextAc.mag_heading || 0);
  const labelHtml = formatAircraftLabelHtml(nextAc);
  const icon = buildAircraftIcon(track);

  const start = performance.now();
  const token = ++animationToken;

  function step(now) {
    if (token !== animationToken) return;

    const t = Math.min(1, (now - start) / ANIMATION_DURATION_MS);
    const lat = fromLat + (toLat - fromLat) * t;
    const lon = fromLon + (toLon - fromLon) * t;

    lastAircraftLatLng = [lat, lon];

    if (!aircraftMarker) {
      aircraftMarker = L.marker([lat, lon], {
        icon,
        zIndexOffset: 1000
      }).addTo(map);

      aircraftMarker.bindTooltip(labelHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "aircraft-label-tooltip",
        opacity: 1
      });
      aircraftTooltipBound = true;
    } else {
      aircraftMarker.setLatLng([lat, lon]);
      aircraftMarker.setIcon(icon);

      if (aircraftTooltipBound && aircraftMarker.getTooltip()) {
        aircraftMarker.setTooltipContent(labelHtml);
      }
    }

    if (t < 1) {
      animationFrameId = requestAnimationFrame(step);
    } else {
      animationFrameId = null;
      updateAircraft(nextAc);
    }
  }

  animationFrameId = requestAnimationFrame(step);
}

/* ------------------ ADS-B FETCH ------------------ */

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

function pickAircraftFromResponse(data) {
  if (!data) return null;

  if (Array.isArray(data.ac) && data.ac.length > 0) {
    if (targetHex) {
      const foundByHex = data.ac.find(
        x => String(x.hex || "").toLowerCase() === targetHex
      );
      if (foundByHex) return foundByHex;
    }

    if (targetReg) {
      const foundByReg = data.ac.find(
        x => String(x.r || x.reg || "").toUpperCase() === targetReg
      );
      if (foundByReg) return foundByReg;
    }

    return data.ac[0];
  }

  if (data.hex || data.lat || data.lon) return data;
  return null;
}

async function fetchAircraftData() {
  const bases = lastGoodApiBase
    ? [lastGoodApiBase, ...ADSB_API_BASES.filter(x => x !== lastGoodApiBase)]
    : [...ADSB_API_BASES];

  const pathCandidates = [];

  if (targetHex) {
    pathCandidates.push(`/v2/hex/${encodeURIComponent(targetHex)}`);
    pathCandidates.push(`/v2/icao/${encodeURIComponent(targetHex)}`);
    pathCandidates.push(`/v2/aircraft/${encodeURIComponent(targetHex)}`);
  }

  if (targetReg) {
    pathCandidates.push(`/v2/reg/${encodeURIComponent(targetReg)}`);
    pathCandidates.push(`/v2/registration/${encodeURIComponent(targetReg)}`);
  }

  let lastError = null;

  for (const base of bases) {
    for (const path of pathCandidates) {
      try {
        const data = await fetchJson(base + path);
        const ac = pickAircraftFromResponse(data);
        if (ac) {
          lastGoodApiBase = base;
          return ac;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error("Aircraft not found");
}

async function pollAircraft() {
  try {
    const ac = await fetchAircraftData();

    if (!trackingStarted) {
      updateAircraft(ac);
      trackingStarted = true;
    } else {
      animateAircraftIfNeeded(lastAircraft, ac);
    }
  } catch (err) {
    console.error("pollAircraft error:", err);
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
  return Math.max(USER_TRAIL_JUMP_MAX_DIST_M, acc * 1.5);
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
    const solidPointsFlat = userTrailSolidSegments.flat().slice(-USER_TRAIL_STORAGE_LIMIT);
    const dashedFlat = userTrailDashedSegments.slice(-50);

    const payload = {
      solidPoints: solidPointsFlat,
      dashedSegments: dashedFlat
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
    const solidPoints = Array.isArray(parsed.solidPoints) ? parsed.solidPoints : [];
    const dashedSegments = Array.isArray(parsed.dashedSegments) ? parsed.dashedSegments : [];

    if (solidPoints.length > 0) {
      userTrailSolidSegments = [solidPoints.map(clonePoint)];
      currentSolidSegment = userTrailSolidSegments[0];

      const line = L.polyline(
        currentSolidSegment.map(p => [p.lat, p.lng]),
        {
          weight: 2.5,
          opacity: 0.5,
          color: "#2b8cff"
        }
      ).addTo(map);

      userTrailSolidLines = [line];
      currentSolidLine = line;

      lastAcceptedUserPoint = clonePoint(currentSolidSegment[currentSolidSegment.length - 1]);
      lastUserLatLng = [lastAcceptedUserPoint.lat, lastAcceptedUserPoint.lng];

      recentAcceptedUserPoints = currentSolidSegment
        .slice(-USER_TRAIL_SMOOTHING_WINDOW)
        .map(clonePoint);
    }

    for (const seg of dashedSegments) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const fromPoint = clonePoint(seg[0]);
      const toPoint = clonePoint(seg[1]);
      createDashedTrailLine(fromPoint, toPoint);
    }

    trimUserTrailData();
  } catch (err) {
    console.warn("Trail state restore failed:", err);
  }
}

function appendUserTrailPoint(lat, lng, accuracy) {
  const rawPoint = {
    lat,
    lng,
    accuracy: typeof accuracy === "number" ? accuracy : null,
    time: Date.now()
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

  lastUserLatLng = [lat, lon];
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

  appendUserTrailPoint(lat, lon, accuracy);

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
  createToggleButton();
  restoreTrailState();
  startGpsTracking();

  pollAircraft();
  setInterval(pollAircraft, POLL_INTERVAL_MS);
}

initAircraftTracking();
