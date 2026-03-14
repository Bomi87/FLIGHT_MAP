const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

let aircraftMarker = null;
let aircraftTrail = [];
let aircraftTrailLine = null;

function formatAltitudeFromState(ac) {
  const altMeters = ac[13];

  if (altMeters == null || isNaN(altMeters)) return "";

  const ft = Math.round(Number(altMeters) * 3.28084);

  if (ft >= 18000) {
    return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  }

  return ft.toLocaleString() + " ft";
}

function formatLabel(ac) {
  const flight = (ac[1] || "").trim();
  const hex = (ac[0] || "").toLowerCase();
  const altitudeText = formatAltitudeFromState(ac);

  return `
    <div style="
      font-size: 11px;
      color: black;
      font-weight: 700;
      white-space: nowrap;
      text-align: center;
      line-height: 1.25;
    ">
      ${flight || hex}
      ${altitudeText ? `<br>${altitudeText}` : ""}
    </div>
  `;
}

function makeAircraftIcon(track = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: rotate(${track}deg);
        transform-origin: center center;
      ">
        <svg
          width="32"
          height="32"
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
        >
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

  console.log("trail point added:", lat, lon, "count:", aircraftTrail.length);
}

async function updateAircraft() {
  if (!targetReg && !targetHex) return;

  try {
    const res = await fetch("https://opensky-network.org/api/states/all");

    if (!res.ok) {
      console.error("OpenSky fetch failed:", res.status, res.statusText);
      return;
    }

    const data = await res.json();
    const list = data.states || [];

    let ac = null;

    if (targetHex) {
      ac = list.find(
        x => ((x[0] || "") + "").toLowerCase().trim() === targetHex
      );
    } else if (targetReg) {
      ac = list.find(
        x => ((x[1] || "") + "").toUpperCase().trim() === targetReg
      );
    }

    if (!ac) {
      console.log("Target aircraft not found:", { targetHex, targetReg });
      return;
    }

    const lon = ac[5];
    const lat = ac[6];
    const track = Number(ac[10] ?? 0);

    if (lat == null || lon == null) {
      console.log("Aircraft found but no lat/lon yet:", ac);
      return;
    }

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
      offset: [0, -16],
      className: "aircraft-label",
      opacity: 1
    });
  } catch (e) {
    console.error("aircraft update failed:", e);
  }
}

updateAircraft();
setInterval(updateAircraft, 5000);
