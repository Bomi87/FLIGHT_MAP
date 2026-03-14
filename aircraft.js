const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

/* ------------------ API / SETTINGS ------------------ */

const ADSB_API_BASES = [
  "https://api.adsb.lol",
  "https://api.adsb.one"
];

const POLL_INTERVAL_MS = 5000;        // 5초
const ANIMATION_DURATION_MS = 4500;   // 다음 갱신 전까지 부드럽게 이동
const POINT_RADIUS_NM = 80;           // 마지막 위치 주변 point feed 조회 반경
const MAX_LIVE_TRAIL_POINTS = 500;

let aircraftMarker = null;
let liveTrail = [];
let liveTrailLine = null;

let lastAircraft = null;
let lastGoodApiBase = null;
let trackingStarted = false;

let animationFrameId = null;
let animationToken = 0;

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
    box.style.color = "#333";
    box.style.padding = "6px 10px";
    box.style.fontSize = "12px";
    box.style.lineHeight = "1.35";
    box.style.border = "1px solid #999";
    box.style.borderRadius = "6px";
    box.style.maxWidth = "320px";
    box.style.wordBreak = "break-word";
    box.style.boxShadow = "0 1px 4px rgba(0,0,0,0.15)";
    document.body.appendChild(box);
  }

  return box;
}

function showStatus(message, color = "#333") {
  const box = getStatusBox();
  box.style.display = "block";
  box.style.color = color;
  box.textContent = message;
}

function hideStatus() {
  const box = document.getElementById("aircraft-status");
  if (box) box.style.display = "none";
}

/* ------------------ ALTITUDE FORMAT ------------------ */

function formatAltitudeFromState(ac) {
  let alt = ac.alt_geom ?? ac.alt_baro ?? ac.geo_altitude ?? ac.baro_altitude;

  if (alt == null || isNaN(alt)) return "";

  let ft = Number(alt);

  // meters일 가능성 보정
  if (ft > -2000 && ft < 20000) {
    ft = Math.round(ft * 3.28084);
  } else {
    ft = Math.round(ft);
  }

  if (ft >= 18000) {
    return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  }

  return ft.toLocaleString() + " ft";
}

/* ------------------ LABEL ------------------ */

function formatLabel(ac) {
  const flight = (ac.flight || ac.callsign || "").trim();
  const reg = (ac.r || ac.reg || "").trim();
  const hex = (ac.hex || ac.icao24 || "").toLowerCase();
  const altitudeText = formatAltitudeFromState(ac);

  return `
    <div style="
      display:inline-block;
      font-size:11px;
      color:black;
      font-weight:700;
      white-space:normal;
      text-align:center;
      line-height:1.2;
      padding:2px 4px;
      background:rgba(255,255,255,0.85);
      border-radius:4px;
    ">
      <div>${flight || reg || hex}</div>
      ${reg && reg !== flight ? `<div>${reg}</div>` : ""}
      ${altitudeText ? `<div>${altitudeText}</div>` : ""}
    </div>
  `;
}

/* ------------------ ICON ------------------ */

function makeAircraftIcon(track = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        width:36px;
        height:36px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${track}deg);
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
              L52 78
              L52 96
              L48 96
              L48 78
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

/* ------------------ TRAIL ------------------ */

function isSamePoint(a, b) {
  return (
    Math.abs(a[0] - b[0]) < 0.00001 &&
    Math.abs(a[1] - b[1]) < 0.00001
  );
}

function redrawLiveTrail() {
  if (!liveTrail.length) return;

  if (!liveTrailLine) {
    liveTrailLine = L.polyline(liveTrail, {
      color: "#ff4d00",
      weight: 4,
      opacity: 0.95,
      dashArray: "6 6",
      smoothFactor: 1
    }).addTo(map);
  } else {
    liveTrailLine.setLatLngs(liveTrail);
  }
}

function addLiveTrailPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const newPoint = [lat, lon];
  const last = liveTrail[liveTrail.length - 1];

  if (last && isSamePoint(last, newPoint)) return;

  liveTrail.push(newPoint);

  if (liveTrail.length > MAX_LIVE_TRAIL_POINTS) {
    liveTrail.shift();
  }

  redrawLiveTrail();
}

/* ------------------ FETCH / FALLBACK ------------------ */

async function fetchJsonFromFallbacks(path) {
  const bases = [...ADSB_API_BASES];

  // 마지막 성공 API를 우선 시도
  if (lastGoodApiBase) {
    const idx = bases.indexOf(lastGoodApiBase);
    if (idx > 0) {
      bases.splice(idx, 1);
      bases.unshift(lastGoodApiBase);
    }
  }

  let lastError = null;

  for (const base of bases) {
    const url = `${base}${path}`;

    try {
      console.log("Trying API:", url);

      const res = await fetch(url, { cache: "no-store" });
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${base}: ${text.slice(0, 200)}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${base}: ${text.slice(0, 200)}`);
      }

      lastGoodApiBase = base;
      return { data, base };
    } catch (err) {
      console.warn("API failed:", base, err);
      lastError = err;
    }
  }

  throw lastError || new Error("All ADS-B APIs failed");
}

/* ------------------ NORMALIZE ------------------ */

function normalizeAircraft(raw) {
  if (!raw || typeof raw !== "object") return null;

  const ac = {
    hex: (raw.hex || raw.icao24 || "").toLowerCase(),
    icao24: (raw.hex || raw.icao24 || "").toLowerCase(),
    callsign: String(raw.flight || raw.callsign || "").trim(),
    flight: String(raw.flight || raw.callsign || "").trim(),
    r: String(raw.r || raw.reg || "").trim(),
    reg: String(raw.r || raw.reg || "").trim(),
    latitude: Number(raw.lat ?? raw.latitude),
    longitude: Number(raw.lon ?? raw.longitude),
    true_track: Number(raw.track ?? raw.true_track ?? 0),
    gs: Number(raw.gs ?? raw.groundspeed ?? raw.speed ?? 0),
    alt_baro: raw.alt_baro,
    alt_geom: raw.alt_geom,
    geo_altitude: raw.geo_altitude,
    baro_altitude: raw.baro_altitude,
    seen: raw.seen,
    seen_pos: raw.seen_pos,
    sourceBase: ""
  };

  return ac;
}

function pickAircraftFromResponse(data) {
  if (Array.isArray(data?.ac) && data.ac.length) {
    return data.ac.map(normalizeAircraft).filter(Boolean);
  }

  if (Array.isArray(data?.aircraft) && data.aircraft.length) {
    return data.aircraft.map(normalizeAircraft).filter(Boolean);
  }

  if (data?.hex || data?.lat || data?.lon || data?.latitude || data?.longitude) {
    const one = normalizeAircraft(data);
    return one ? [one] : [];
  }

  return [];
}

function isTargetAircraft(ac) {
  if (!ac) return false;

  const hex = (ac.hex || ac.icao24 || "").toLowerCase();
  const reg = (ac.r || ac.reg || "").toUpperCase().trim();
  const callsign = (ac.flight || ac.callsign || "").toUpperCase().trim();

  if (targetHex && hex === targetHex) return true;
  if (targetReg && reg && reg === targetReg) return true;
  if (targetReg && callsign && callsign === targetReg) return true;

  return false;
}

/* ------------------ SEARCH METHODS ------------------ */

async function fetchAircraftByHex() {
  if (!targetHex) return null;

  const { data, base } = await fetchJsonFromFallbacks(
    `/v2/hex/${encodeURIComponent(targetHex)}`
  );

  const list = pickAircraftFromResponse(data);
  const ac = list.find(isTargetAircraft) || list[0] || null;

  if (ac) ac.sourceBase = base;
  return ac;
}

async function fetchAircraftByReg() {
  if (!targetReg) return null;

  const { data, base } = await fetchJsonFromFallbacks(
    `/v2/reg/${encodeURIComponent(targetReg)}`
  );

  const list = pickAircraftFromResponse(data);
  const ac = list.find(isTargetAircraft) || list[0] || null;

  if (ac) ac.sourceBase = base;
  return ac;
}

async function fetchAircraftFromPoint(lat, lon, radiusNm = POINT_RADIUS_NM) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const { data, base } = await fetchJsonFromFallbacks(
    `/v2/point/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}/${encodeURIComponent(radiusNm)}`
  );

  const list = pickAircraftFromResponse(data);
  const ac = list.find(isTargetAircraft) || null;

  if (ac) ac.sourceBase = base;
  return ac;
}

/* ------------------ ANIMATION ------------------ */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeAngle(angle) {
  let a = angle % 360;
  if (a < 0) a += 360;
  return a;
}

function shortestAngleDelta(from, to) {
  let delta = normalizeAngle(to) - normalizeAngle(from);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function animateMarkerTo(lat, lon, track, ac) {
  if (!aircraftMarker) {
    aircraftMarker = L.marker([lat, lon], {
      icon: makeAircraftIcon(track),
      zIndexOffset: 2000
    }).addTo(map);

    aircraftMarker.bindTooltip(formatLabel(ac), {
      permanent: true,
      direction: "top",
      offset: [0, -20],
      className: "aircraft-label",
      opacity: 1
    });

    return;
  }

  const startLatLng = aircraftMarker.getLatLng();
  const startLat = startLatLng.lat;
  const startLon = startLatLng.lng;

  const startTrack = Number(lastAircraft?.true_track ?? track ?? 0);
  const endTrack = Number(track ?? 0);

  aircraftMarker.unbindTooltip();
  aircraftMarker.bindTooltip(formatLabel(ac), {
    permanent: true,
    direction: "top",
    offset: [0, -20],
    className: "aircraft-label",
    opacity: 1
  });

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  const myToken = ++animationToken;
  const startTime = performance.now();
  const angleDelta = shortestAngleDelta(startTrack, endTrack);

  function frame(now) {
    if (myToken !== animationToken) return;

    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / ANIMATION_DURATION_MS);

    // easeInOut
    const eased = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const curLat = lerp(startLat, lat, eased);
    const curLon = lerp(startLon, lon, eased);
    const curTrack = normalizeAngle(startTrack + angleDelta * eased);

    aircraftMarker.setLatLng([curLat, curLon]);
    aircraftMarker.setIcon(makeAircraftIcon(curTrack));

    if (t < 1) {
      animationFrameId = requestAnimationFrame(frame);
    } else {
      animationFrameId = null;
      aircraftMarker.setLatLng([lat, lon]);
      aircraftMarker.setIcon(makeAircraftIcon(endTrack));
    }
  }

  animationFrameId = requestAnimationFrame(frame);
}

/* ------------------ UPDATE AIRCRAFT ------------------ */

async function updateAircraft() {
  if (!targetHex && !targetReg) {
    showStatus("No HEX or REG parameter.", "#444");
    return;
  }

  try {
    let ac = null;

    // 1) 이미 위치를 알고 있으면 point feed로 먼저 탐색
    if (lastAircraft &&
        Number.isFinite(lastAircraft.latitude) &&
        Number.isFinite(lastAircraft.longitude)) {
      try {
        ac = await fetchAircraftFromPoint(
          lastAircraft.latitude,
          lastAircraft.longitude,
          POINT_RADIUS_NM
        );
      } catch (e) {
        console.warn("Point search failed, fallback to exact lookup:", e);
      }
    }

    // 2) 못 찾으면 hex exact
    if (!ac && targetHex) {
      ac = await fetchAircraftByHex();
    }

    // 3) 그래도 없고 reg가 있으면 reg exact
    if (!ac && targetReg) {
      ac = await fetchAircraftByReg();
    }

    if (!ac) {
      showStatus(
        `Aircraft not found` +
        `${targetHex ? `: ${targetHex}` : ""}` +
        `${targetReg ? ` / ${targetReg}` : ""}`,
        "#444"
      );
      return;
    }

    const lon = Number(ac.longitude);
    const lat = Number(ac.latitude);
    const track = Number(ac.true_track ?? 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      showStatus("Aircraft found but no valid position yet.", "#444");
      return;
    }

    hideStatus();

    addLiveTrailPoint(lat, lon);
    animateMarkerTo(lat, lon, track, ac);

    // 첫 위치 잡히면 한 번만 화면 맞춤
    if (!trackingStarted) {
      trackingStarted = true;

      try {
        map.setView([lat, lon], Math.max(map.getZoom?.() || 8, 8), {
          animate: true
        });
      } catch {
        // map 상태에 따라 무시
      }
    }

    lastAircraft = {
      ...ac,
      latitude: lat,
      longitude: lon,
      true_track: track
    };

    console.log("Tracking source:", ac.sourceBase || lastGoodApiBase, ac);

  } catch (e) {
    console.error("Aircraft update failed:", e);
    showStatus("Aircraft update failed: " + e.message, "red");
  }
}

/* ------------------ START ------------------ */

async function startAircraftTracking() {
  if (!targetHex && !targetReg) return;

  showStatus("Starting aircraft tracking...", "#444");
  await updateAircraft();
  setInterval(updateAircraft, POLL_INTERVAL_MS);
}

startAircraftTracking();
