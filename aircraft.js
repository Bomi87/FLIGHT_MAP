const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

const OPENSKY_PROXY = "https://icy-dew-2558.sbyu.workers.dev";

let aircraftMarker = null;
let aircraftTrail = [];
let aircraftTrailLine = null;

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
  const altMeters = ac[13] ?? ac[7];

  if (altMeters == null || isNaN(altMeters)) return "";

  const ft = Math.round(Number(altMeters) * 3.28084);

  if (ft >= 18000) {
    return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  }

  return ft.toLocaleString() + " ft";
}

/* ------------------ LABEL ------------------ */

function formatLabel(ac) {
  const flight = (ac[1] || "").trim();
  const hex = (ac[0] || "").toLowerCase();
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
      <div>${flight || hex}</div>
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

function addTrailPoint(lat, lon) {
  if (lat == null || lon == null) return;

  const last = aircraftTrail[aircraftTrail.length - 1];

  if (last) {
    const sameEnough =
      Math.abs(last[0] - lat) < 0.00001 &&
      Math.abs(last[1] - lon) < 0.00001;

    if (sameEnough) return;
  }

  aircraftTrail.push([lat, lon]);

  if (aircraftTrail.length > 300) {
    aircraftTrail.shift();
  }

  if (!aircraftTrailLine) {
    aircraftTrailLine = L.polyline(aircraftTrail, {
      color: "#ff6600",
      weight: 4,
      opacity: 1,
      smoothFactor: 1
    }).addTo(map);
  } else {
    aircraftTrailLine.setLatLngs(aircraftTrail);
  }
}

/* ------------------ SAFE FETCH ------------------ */

async function fetchJsonSafely(url) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Proxy returned non JSON: " + text);
  }

  if (!res.ok || data.error) {
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail || data.error || data)
    );
  }

  return data;
}

/* ------------------ UPDATE AIRCRAFT ------------------ */

async function updateAircraft() {
  if (!targetHex) {
    console.log("No HEX parameter.");
    return;
  }

  try {
    const url = `${OPENSKY_PROXY}/?hex=${encodeURIComponent(targetHex)}`;
    console.log("Proxy request:", url);

    const data = await fetchJsonSafely(url);
    const list = Array.isArray(data.states) ? data.states : [];

    console.log("states length:", list.length);

    const ac = list.find(
      x => ((x[0] || "") + "").toLowerCase().trim() === targetHex
    );

    if (!ac) {
      console.log("Aircraft not found:", targetHex, list);
      showStatus(`Aircraft not found yet: ${targetHex}`, "#444");
      return;
    }

    const lon = Number(ac[5]);
    const lat = Number(ac[6]);
    const track = Number(ac[10] ?? 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.log("Aircraft found but invalid lat/lon:", ac);
      showStatus(`Aircraft found but no valid position yet: ${targetHex}`, "#444");
      return;
    }

    hideStatus();

    addTrailPoint(lat, lon);

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

updateAircraft();
setInterval(updateAircraft, 10000);
