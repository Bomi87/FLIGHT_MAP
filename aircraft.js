const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

let aircraftMarker = null;

function formatAltitudeFromState(ac) {
  const alt = ac[13]; // baro altitude (meters in OpenSky)

  if (alt == null || isNaN(alt)) return "";

  const ft = Math.round(Number(alt) * 3.28084);

  if (ft >= 18000) {
    return "FL" + String(Math.round(ft / 100)).padStart(3, "0");
  }

  return ft.toLocaleString() + " ft";
}

function makeAircraftIcon(track = 0) {
  return L.divIcon({
    className: "aircraft-div-icon",
    html: `
      <div style="
        transform: rotate(${track}deg);
        font-size: 22px;
        line-height: 22px;
        color: white;
        text-shadow: 0 0 3px black;
      ">✈</div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
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
      ac = list.find(x => ((x[0] || "") + "").toLowerCase().trim() === targetHex);
    } else if (targetReg) {
      ac = list.find(x => ((x[1] || "") + "").toUpperCase().trim() === targetReg);
    }

    if (!ac) {
      console.log("Target aircraft not found:", { targetHex, targetReg });
      return;
    }

    const lon = ac[5];
    const lat = ac[6];
    const track = ac[10] ?? 0;
    const flight = (ac[1] || "").trim();
    const hex = (ac[0] || "").toLowerCase();
    const altitudeText = formatAltitudeFromState(ac);

    if (lat == null || lon == null) {
      console.log("Aircraft found but no lat/lon yet:", ac);
      return;
    }

    const labelText = `
      <div style="
        font-size:11px;
        color:white;
        font-weight:700;
        text-shadow:0 0 3px black;
        white-space:nowrap;
        text-align:center;
      ">
        ${flight || hex}
        ${altitudeText ? `<br>${altitudeText}` : ""}
      </div>
    `;

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
    aircraftMarker.bindTooltip(labelText, {
      permanent: true,
      direction: "top",
      offset: [0, -14],
      className: "aircraft-label",
      opacity: 1
    });

  } catch (e) {
    console.error("aircraft update failed:", e);
  }
}

updateAircraft();
setInterval(updateAircraft, 15000);
