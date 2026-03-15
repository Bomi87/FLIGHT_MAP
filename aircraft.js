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
const POINT_RADIUS_NM = 80;
const VERTICAL_RATE_THRESHOLD = 300;

/* ------------------ GPS / USER SETTINGS ------------------ */

const USER_GPS_ZOOM_MIN = 10;
const MAX_USER_TRAIL_POINTS = 1000;

const USER_HEADING_MIN_SPEED_KT = 2.0;     // 이 이상이면 GPS heading 우선
const GPS_HEADING_SMOOTHING = 0.35;        // 이동 중 GPS heading smoothing
const COMPASS_HEADING_SMOOTHING = 0.18;    // 정지/저속 시 compass smoothing
const USER_HEADING_CHANGE_MIN_DEG = 2;

/* ------------------ STATE ------------------ */

let aircraftMarker = null;
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
let userTrail = [];
let userTrailLine = null;

let gpsWatchId = null;
let deviceCompassHeading = null;
let lastUserHeadingDeg = null;

/* ------------------ STATUS BOX ------------------ */

function getStatusBox() {
  let box = document.getElementById("aircraft-status");

  if (!box) {
    box = document.createElement("div");
    box.id = "aircraft-status";
    box.style.position = "fixed";
    box.style.top = "10px";
    box.style.left = "10px";
    box.style.zIndex = "99999";
    box.style.background = "rgba(255,255,255,0.92)";
    box.style.color = "#222";
    box.style.padding = "6px 8px";
    box.style.fontSize = "11px";
    box.style.lineHeight = "1.35";
    box.style.border = "1px solid rgba(0,0,0,0.18)";
    box.style.borderRadius = "8px";
    box.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)";
    box.style.maxWidth = "220px";
    document.body.appendChild(box);
  }

  return box;
}

function setStatus(text) {
  getStatusBox().innerHTML = text;
}

/* ------------------ CONTROL BUTTONS ------------------ */

function createControlButtons() {
  let wrap = document.getElementById("custom-follow-controls");
  if (wrap) return;

  wrap = document.createElement("div");
  wrap.id = "custom-follow-controls";
  wrap.style.position = "fixed";
  wrap.style.top = "52px";
  wrap.style.right = "10px";
  wrap.style.zIndex = "99999";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "6px";

  function makeBtn(label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
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
    return btn;
  }

  const acBtn = makeBtn("A/C");
  const gpsBtn = makeBtn("GPS");

  acBtn.onclick = () => {
    focusAircraftNow();
  };

  gpsBtn.onclick = async () => {
    await startDeviceCompass();
    focusUserNow();
  };

  wrap.appendChild(acBtn);
  wrap.appendChild(gpsBtn);
  document.body.appendChild(wrap);
}

/* ------------------ MAP FOCUS (ONE-SHOT ONLY) ------------------ */

function focusAircraftNow() {
  if (!lastAircraftLatLng) return;
  const targetZoom = Math.max(map.getZoom(), 9);
  map.flyTo(lastAircraftLatLng, targetZoom, {
    animate: true,
    duration: 0.8
  });
}

function focusUserNow() {
  if (!lastUserLatLng) return;
  const targetZoom = Math.max(map.getZoom(), USER_GPS_ZOOM_MIN);
  map.flyTo(lastUserLatLng, targetZoom, {
    animate: true,
    duration: 0.8
  });
}

/* ------------------ UTILS ------------------ */

function formatNumber(value, digits = 0) {
  if (value == null || isNaN(value)) return "";
  return Number(value).toFixed(digits);
}

function metersToFeet(m) {
  return Number(m) * 3.28084;
}

function metersPerSecondToKnots(ms) {
  return (Number(ms) || 0) * 1.943844;
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

function getDistanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = Math.PI / 180;

  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* ------------------ AIRCRAFT FORMATTERS ------------------ */

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
    return "M." + String(Number(ac.mach).toFixed(2)).replace(/^0/, "");
  }

  const gs = Number(ac.gs);
  if (!isNaN(gs) && gs > 0) {
    const altFt = Number(ac.alt_baro ?? ac.alt_geom ?? 0);
    const tasApprox = gs;
    let soundKt = 661;

    if (altFt >= 35000) soundKt = 573;
    else if (altFt >= 30000) soundKt = 590;
    else if (altFt >= 25000) soundKt = 610;
    else if (altFt >= 20000) soundKt = 630;
    else if (altFt >= 10000) soundKt = 650;

    const mach = tasApprox / soundKt;
    if (mach > 0.2) {
      return "M." + String(mach.toFixed(2)).replace(/^0/, "");
    }
  }

  return "";
}

function formatIasText(ac) {
  if (ac.ias != null && !isNaN(ac.ias)) {
    return Math.round(Number(ac.ias)) + "KT";
  }

  if (ac.gs != null && !isNaN(ac.gs)) {
    return Math.round(Number(ac.gs)) + "KT";
  }

  return "";
}

function formatLabelHtml(ac) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const reg = (ac.r || ac.reg || "").trim();
  const type = (ac.t || ac.type || "").trim();
  const altitudeText = formatAltitudeText(ac);
  const machText = formatMachText(ac);
  const iasText = formatIasText(ac);

  const line1 = [flight, reg ? `(${reg})` : ""].filter(Boolean).join(" ");
  const line2 = [type, altitudeText].filter(Boolean).join(" ");
  const line3 = [machText, iasText].filter(Boolean).join(" / ");

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
      ${line3 ? `<div>${escapeHtml(line3)}</div>` : ""}
    </div>
  `;
}

function buildAircraftIcon(trackDeg = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `
      <div style="
        width:30px;
        height:30px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform: rotate(${normalizeDeg(trackDeg)}deg);
        transform-origin:center center;
      ">
        <div style="
          width:0;
          height:0;
          border-left:8px solid transparent;
          border-right:8px solid transparent;
          border-bottom:20px solid #111;
          filter: drop-shadow(0 0 1px rgba(255,255,255,0.8));
        "></div>
      </div>
    `
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
  const labelHtml = formatLabelHtml(ac);

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
  } else {
    aircraftMarker.setLatLng(newLatLng);
    aircraftMarker.setIcon(icon);

    if (aircraftMarker.getTooltip()) {
      aircraftMarker.setTooltipContent(labelHtml);
    } else {
      aircraftMarker.bindTooltip(labelHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "aircraft-label-tooltip",
        opacity: 1
      });
    }
  }
}

function updateLiveTrail(ac) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (isNaN(lat) || isNaN(lon)) return;

  const point = [lat, lon];

  if (liveTrail.length > 0) {
    const prev = liveTrail[liveTrail.length - 1];
    const dNm = getDistanceNm(prev[0], prev[1], point[0], point[1]);

    if (dNm < 0.01) return;
    if (dNm > POINT_RADIUS_NM) {
      liveTrail.push(point);
    } else {
      liveTrail.push(point);
    }
  } else {
    liveTrail.push(point);
  }

  if (liveTrail.length > MAX_LIVE_TRAIL_POINTS) {
    liveTrail.shift();
  }

  if (!liveTrailLine) {
    liveTrailLine = L.polyline(liveTrail, {
      color: "#111",
      weight: 3,
      opacity: 0.65,
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

  const reg = ac.r || ac.reg || "-";
  const flight = ac.flight || ac.callsign || "-";
  const type = ac.t || ac.type || "-";
  const alt = formatAltitudeText(ac) || "-";
  const mach = formatMachText(ac) || "-";
  const ias = formatIasText(ac) || "-";

  setStatus(`
    <div><b>${escapeHtml(flight)}</b> ${reg ? `(${escapeHtml(reg)})` : ""}</div>
    <div>${escapeHtml(type)}</div>
    <div>${escapeHtml(alt)}</div>
    <div>${escapeHtml(mach)} / ${escapeHtml(ias)}</div>
  `);
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
  const labelHtml = formatLabelHtml(nextAc);
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
        opacity: 1
      });
    } else {
      aircraftMarker.setLatLng([lat, lon]);
      aircraftMarker.setIcon(icon);

      if (aircraftMarker.getTooltip()) {
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
      const foundByHex = data.ac.find(x => String(x.hex || "").toLowerCase() === targetHex);
      if (foundByHex) return foundByHex;
    }

    if (targetReg) {
      const foundByReg = data.ac.find(x =>
        String(x.r || x.reg || "").toUpperCase() === targetReg
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
    setStatus(`Aircraft not found / API error`);
  }
}

/* ------------------ GPS / COMPASS ------------------ */

function createHeadingArrowIcon(headingDeg) {
  return L.divIcon({
    className: "user-heading-arrow",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `
      <div style="
        width:28px;
        height:28px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform: rotate(${normalizeDeg(headingDeg)}deg);
        transform-origin:center center;
      ">
        <div style="
          width:0;
          height:0;
          border-left:7px solid transparent;
          border-right:7px solid transparent;
          border-bottom:18px solid red;
          filter: drop-shadow(0 0 1px rgba(0,0,0,0.6));
        "></div>
      </div>
    `
  });
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

    if (
      lastUserLatLng &&
      userHeadingMarker &&
      lastUserHeadingDeg != null &&
      (lastKnownSpeedKt == null || lastKnownSpeedKt < USER_HEADING_MIN_SPEED_KT)
    ) {
      const diff = Math.abs(shortestAngleDiff(lastUserHeadingDeg, deviceCompassHeading));
      let nextHeading = lastUserHeadingDeg;

      if (diff >= USER_HEADING_CHANGE_MIN_DEG) {
        nextHeading = smoothHeading(
          lastUserHeadingDeg,
          deviceCompassHeading,
          COMPASS_HEADING_SMOOTHING
        );
      }

      lastUserHeadingDeg = nextHeading;
      userHeadingMarker.setLatLng(lastUserLatLng);
      userHeadingMarker.setIcon(createHeadingArrowIcon(nextHeading));
    }
  }
}

let compassStarted = false;
async function startDeviceCompass() {
  if (compassStarted) return;

  try {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        console.warn("Device orientation permission denied");
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

let lastKnownSpeedKt = null;

function updateUserLocation(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = position.coords.accuracy || 0;
  const gpsHeading = position.coords.heading;
  const speedKt = metersPerSecondToKnots(position.coords.speed);

  lastKnownSpeedKt = speedKt;
  lastUserLatLng = [lat, lon];

  /* 파란 점 */
  if (!userMarker) {
    userMarker = L.circleMarker(lastUserLatLng, {
      radius: 4,
      color: "#ffffff",
      weight: 2,
      fillColor: "#2b8cff",
      fillOpacity: 1,
      opacity: 1
    }).addTo(map);
  } else {
    userMarker.setLatLng(lastUserLatLng);
  }

  /* 정확도 원 - 작게 */
  const clampedAccuracy = Math.max(5, Math.min(accuracy, 18));

  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(lastUserLatLng, {
      radius: clampedAccuracy,
      color: "#2b8cff",
      weight: 1,
      opacity: 0.25,
      fillColor: "#2b8cff",
      fillOpacity: 0.05
    }).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(lastUserLatLng);
    userAccuracyCircle.setRadius(clampedAccuracy);
  }

  /* 이동 궤적 */
  userTrail.push(lastUserLatLng);
  if (userTrail.length > MAX_USER_TRAIL_POINTS) {
    userTrail.shift();
  }

  if (!userTrailLine) {
    userTrailLine = L.polyline(userTrail, {
      weight: 3,
      opacity: 0.7,
      color: "#2b8cff"
    }).addTo(map);
  } else {
    userTrailLine.setLatLngs(userTrail);
  }

  /* 방향 결정
     - 이동 중: GPS heading + smoothing 0.35
     - 정지/저속: compass heading + smoothing 0.18
  */
  let rawHeading = null;
  let smoothing = GPS_HEADING_SMOOTHING;

  const gpsHeadingValid =
    gpsHeading != null &&
    !isNaN(gpsHeading) &&
    speedKt >= USER_HEADING_MIN_SPEED_KT;

  if (gpsHeadingValid) {
    rawHeading = normalizeDeg(gpsHeading);
    smoothing = GPS_HEADING_SMOOTHING;
  } else if (deviceCompassHeading != null && !isNaN(deviceCompassHeading)) {
    rawHeading = normalizeDeg(deviceCompassHeading);
    smoothing = COMPASS_HEADING_SMOOTHING;
  }

  if (rawHeading != null) {
    let nextHeading = rawHeading;

    if (lastUserHeadingDeg != null) {
      const diff = Math.abs(shortestAngleDiff(lastUserHeadingDeg, rawHeading));

      if (diff < USER_HEADING_CHANGE_MIN_DEG) {
        nextHeading = lastUserHeadingDeg;
      } else {
        nextHeading = smoothHeading(lastUserHeadingDeg, rawHeading, smoothing);
      }
    }

    lastUserHeadingDeg = nextHeading;

    const headingIcon = createHeadingArrowIcon(nextHeading);

    if (!userHeadingMarker) {
      userHeadingMarker = L.marker(lastUserLatLng, {
        icon: headingIcon,
        zIndexOffset: 1100,
        interactive: false
      }).addTo(map);
    } else {
      userHeadingMarker.setLatLng(lastUserLatLng);
      userHeadingMarker.setIcon(headingIcon);
    }
  }
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
    (err) => {
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
  createControlButtons();
  startGpsTracking();

  pollAircraft();
  setInterval(pollAircraft, POLL_INTERVAL_MS);
}

initAircraftTracking();
