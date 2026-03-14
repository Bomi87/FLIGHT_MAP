const params = new URLSearchParams(window.location.search);
const targetReg = (params.get("reg") || "").toUpperCase().trim();
const targetHex = (params.get("hex") || "").toLowerCase().trim();

let aircraftMarker = null;

function formatAltitude(ac) {
  const alt =
    ac.alt_baro ??
    ac.altitude ??
    ac.baro_altitude ??
    ac.geo_altitude ??
    null;

  if (alt == null || isNaN(alt)) return "";

  const ft = Math.round(Number(alt));

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
    const res = await fetch("YOUR_API_URL");
    const data = await res.json();

    const list = data.aircraft || data.ac || data.states || [];
    let ac = null;

    if (targetHex) {
      ac = list.find(x =>
        ((x.hex || x.icao24 || "") + "").toLowerCase() === targetHex
      );
    } else if (targetReg) {
      ac = list.find(x =>
        ((x.r || x.registration || x.reg || "") + "")
          .toUpperCase()
          .trim() === targetReg
      );
    }

    if (!ac) return;

    const lat = ac.lat ?? ac.latitude ?? ac[6];
    const lon = ac.lon ?? ac.longitude ?? ac[5];
    const track = ac.track ?? ac.true_track ?? ac.heading ?? ac[10] ?? 0;
    const reg = ac.r || ac.registration || ac.reg || targetReg || "";
    const flight = (ac.flight || ac.callsign || ac[1] || "").trim();
    const hex = ac.hex || ac.icao24 || targetHex || "";
    const altitudeText = formatAltitude(ac);

    if (lat == null || lon == null) return;

    const labelText = `
      <div style="
        font-size:11px;
        color:white;
        font-weight:700;
        text-shadow:0 0 3px black;
        white-space:nowrap;
        text-align:center;
      ">
        ${reg || flight || hex}
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
