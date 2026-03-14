const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

/* ------------------ LIVE API ------------------ */
const ADSB_API_BASE = "https://api.adsb.one/v2";

let aircraftMarker = null;
let liveTrail = [];
let liveTrailLine = null;

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
    box.style.maxWidth = "260px";
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
  // adsb.one / adsbexchange 계열은 보통 feet 기반 alt_baro / alt_geom 사용
  let alt = ac.alt_geom ?? ac.alt_baro ?? ac.geo_altitude ?? ac.baro_altitude;

  if (alt == null || isNaN(alt)) return "";

  let ft = Number(alt);

  // 혹시 meters 형식으로 오면 보정
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
  if (lat == null || lon == null) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const newPoint = [lat, lon];
  const last = liveTrail[liveTrail.length - 1];

  if (last && isSamePoint(last, newPoint)) return;

  liveTrail.push(newPoint);

  if (liveTrail.length > 300) {
    liveTrail.shift();
  }

  redrawLiveTrail();
}

/* ------------------ FETCH ------------------ */

async function fetchJsonSafely(url) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("API returned non JSON: " + text);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return data;
}

/* ------------------ STATE NORMALIZE ------------------ */

function normalizeAircraft(raw) {
  if (!raw || typeof raw !== "object") return null;

  return {
    hex: (raw.hex || "").toLowerCase(),
    icao24: (raw.hex || raw.icao24 || "").toLowerCase(),
    callsign: (raw.flight || raw.callsign || "").trim(),
    flight: (raw.flight || raw.callsign || "").trim(),
    r: (raw.r || raw.reg || "").trim(),
    latitude: Number(raw.lat),
    longitude: Number(raw.lon),
    true_track: Number(raw.track ?? raw.true_track ?? 0),
    alt_baro: raw.alt_baro,
    alt_geom: raw.alt_geom,
    geo_altitude: raw.geo_altitude,
    baro_altitude: raw.baro_altitude
  };
}

/* ------------------ UPDATE AIRCRAFT ------------------ */

async function updateAircraft() {
  if (!targetHex) {
    console.log("No HEX parameter.");
    showStatus("No HEX parameter.", "#444");
    return;
  }

  try {
    const url = `${ADSB_API_BASE}/hex/${encodeURIComponent(targetHex)}`;
    console.log("Live request:", url);

    const data = await fetchJsonSafely(url);
    console.log("Live response:", data);

    let ac = null;

    // adsb.one 계열은 보통 {ac:[...]} 또는 {aircraft:[...]} 형태
    if (Array.isArray(data?.ac) && data.ac.length) {
      ac = normalizeAircraft(data.ac[0]);
    } else if (Array.isArray(data?.aircraft) && data.aircraft.length) {
      ac = normalizeAircraft(data.aircraft[0]);
    } else if (data?.hex || data?.lat || data?.lon) {
      ac = normalizeAircraft(data);
    }

    if (!ac) {
      showStatus(`Aircraft not found: ${targetHex}`, "#444");
      return;
    }

    const lon = Number(ac.longitude);
    const lat = Number(ac.latitude);
    const track = Number(ac.true_track ?? 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.log("Aircraft found but invalid lat/lon:", ac);
      showStatus(`Aircraft found but no valid position yet: ${targetHex}`, "#444");
      return;
    }

    hideStatus();

    addLiveTrailPoint(lat, lon);

    if (!aircraftMarker) {
      aircraftMarker = L.marker([lat, lon], {
        icon: makeAircraftIcon(track),
        zIndexOffset: 2000
      }).addTo(map);
    } else {
      aircraftMarker.setLatLng([lat, lon]);
      aircraftMarker.setIcon(makeAircraftIcon(track));
    }

    aircraftMarker.unbindTooltip();
    aircraftMarker.bindTooltip(formatLabel(ac), {
      permanent: true,
      direction: "top",
      offset: [0, -20],
      className: "aircraft-label",
      opacity: 1
    });

  } catch (e) {
    console.error("Aircraft update failed:", e);
    showStatus("Aircraft update failed: " + e.message, "red");
  }
}

/* ------------------ START ------------------ */

async function startAircraftTracking() {
  if (!targetHex) return;

  await updateAircraft();

  // 15초 폴링: 1 req/sec 제한보다 훨씬 여유 있음
  setInterval(updateAircraft, 15000);
}

startAircraftTracking();
