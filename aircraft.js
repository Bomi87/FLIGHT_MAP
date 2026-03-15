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
const MAX_USER_TRAIL_POINTS = 1000;

const RUNNING_SPEED_MAX_KT = 8.0;
const COMPASS_HEADING_SMOOTHING = 0.18;
const USER_HEADING_CHANGE_MIN_DEG = 2;

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
let userTrail = [];
let userTrailLine = null;

let gpsWatchId = null;
let deviceCompassHeading = null;
let lastUserHeadingDeg = null;
let lastKnownSpeedKt = null;
let compassStarted = false;

/* ------------------ TOGGLE BUTTON ------------------ */

let focusToggleMode = "aircraft";   // 현재 기준 위치

function createToggleButton() {
  let wrap = document.getElementById("custom-follow-controls");
  if (wrap) return;

  wrap = document.createElement("div");
  wrap.id = "custom-follow-controls";
  wrap.style.position = "fixed";
  wrap.style.top = "115px";   
  wrap.style.right = "10px";
  wrap.style.zIndex = "99999";

  const btn = document.createElement("button");
  btn.id = "toggle-focus-btn";
  btn.type = "button";
  btn.textContent = "A/C";

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

  btn.onclick = async () => {
    if (focusToggleMode === "aircraft") {
      // 현재 항공기 → GPS로 전환
      await startDeviceCompass();

      if (lastUserLatLng) {
        const targetZoom = Math.max(map.getZoom(), USER_GPS_ZOOM_MIN);
        map.flyTo(lastUserLatLng, targetZoom, {
          animate: true,
          duration: 0.8
        });
      }

      focusToggleMode = "gps";
      btn.textContent = "GPS";
    } else {
      // 현재 GPS → 항공기로 전환
      if (lastAircraftLatLng) {
        const targetZoom = Math.max(map.getZoom(), 9);
        map.flyTo(lastAircraftLatLng, targetZoom, {
          animate: true,
          duration: 0.8
        });
      }

      focusToggleMode = "aircraft";
      btn.textContent = "A/C";
    }
  };

  wrap.appendChild(btn);
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
    return "M." + String(Number(ac.mach).toFixed(2)).replace(/^0/, "");
  }

  const gs = Number(ac.gs);
  if (!isNaN(gs) && gs > 0) {
    const altFt = Number(ac.alt_baro ?? ac.alt_geom ?? 0);
    let soundKt = 661;

    if (altFt >= 35000) soundKt = 573;
    else if (altFt >= 30000) soundKt = 590;
    else if (altFt >= 25000) soundKt = 610;
    else if (altFt >= 20000) soundKt = 630;
    else if (altFt >= 10000) soundKt = 650;

    const mach = gs / soundKt;
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

function formatAircraftLabelHtml(ac) {
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

/* ------------------ AIRCRAFT ICON ------------------ */

function buildAircraftIcon(trackDeg = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    html: `
      <div style="
        width:38px;
        height:38px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform: rotate(${normalizeDeg(trackDeg)}deg);
        transform-origin:center center;
      ">
        <svg width="32" height="32" viewBox="0 0 64 64" aria-hidden="true">
          <path
            d="M34 4
               L40 24
               L58 29
               L58 35
               L40 36
               L42 58
               L36 60
               L32 42
               L28 60
               L22 58
               L24 36
               L6 35
               L6 29
               L24 24
               L30 4
               Z"
            fill="#ff9c4a"
            stroke="#b76522"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
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
      const foundByHex = data.ac.find(x => String(x.hex || "").toLowerCase() === targetHex);
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

  userTrail.push(lastUserLatLng);
  if (userTrail.length > MAX_USER_TRAIL_POINTS) {
    userTrail.shift();
  }

  if (!userTrailLine) {
    userTrailLine = L.polyline(userTrail, {
      weight: 2.5,
      opacity: 0.5,
      color: "#2b8cff"
    }).addTo(map);
  } else {
    userTrailLine.setLatLngs(userTrail);
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
  createToggleButton();
  startGpsTracking();

  pollAircraft();
  setInterval(pollAircraft, POLL_INTERVAL_MS);
}

initAircraftTracking();
