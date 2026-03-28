import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FR24_API_KEY = process.env.FR24_API_KEY || "";

const FR24_BOUNDS_LIST = [
  "46,38,116,129", // 동북 1
  "44,36,124,132", // 동북 2 / 랴오닝-동해안
  "42,34,112,121", // 화북
  "40,32,118,126", // 베이징-보하이-산둥 북부
  "38,30,108,118", // 산시-허난
  "36,28,118,123", // 산둥-장쑤 북부
  "34,26,112,121", // 중동부
  "32,24,118,123", // 상하이-저장-동중국해
  "30,22,110,118", // 화중-장시
  "28,20,110,117", // 화남 내륙
  "26,18,108,116", // 광시-광둥 서부
  "25,19,116,123", // 푸젠-광둥 동부-대만해협
  "36,26,98,110",  // 쓰촨-충칭-후베이 서부
  "40,30,90,105",  // 서북 1
  "45,35,80,98",   // 서북 2 / 신장 일부
  "50,20,73,135"   // 마지막 fallback
];

async function fetchFr24LiveByBounds(bounds) {
  const url =
    `https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=${encodeURIComponent(bounds)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Version": "v1",
      Authorization: `Bearer ${FR24_API_KEY}`
    }
  });

  if (!res.ok) {
    throw new Error(`FR24 HTTP ${res.status}`);
  }

  return await res.json();
}

function pickArrayFromFr24Response(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.aircraft)) return data.aircraft;
  return [];
}

function normalizeFr24Aircraft(raw) {
  const hex =
    String(
      raw?.hex ??
      raw?.aircraftHex ??
      raw?.transponder ??
      raw?.icao24 ??
      raw?.icao ??
      ""
    ).trim().toLowerCase();

  if (!hex) return null;

  const lat = Number(raw?.lat ?? raw?.latitude);
  const lon = Number(raw?.lon ?? raw?.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const flight =
    String(
      raw?.flight ??
      raw?.callsign ??
      raw?.identification?.callsign ??
      ""
    ).trim();

  const callsign =
    String(
      raw?.callsign ??
      raw?.flight ??
      raw?.identification?.callsign ??
      ""
    ).trim();

  const type =
    String(
      raw?.type ??
      raw?.aircraftType ??
      raw?.aircraft?.model?.code ??
      ""
    ).trim();

  const altitude =
    raw?.alt ??
    raw?.altitude ??
    raw?.alt_baro ??
    raw?.alt_geom ??
    raw?.barometricAltitude ??
    null;

  const groundSpeed =
    raw?.gspeed ??
    raw?.groundSpeed ??
    raw?.gs ??
    raw?.speed ??
    null;

  const verticalSpeed =
    raw?.vspeed ??
    raw?.verticalSpeed ??
    raw?.vert_rate ??
    raw?.baro_rate ??
    null;

  return {
    hex,
    flight,
    callsign,
    lat,
    lon,
    track: Number(raw?.track ?? raw?.heading ?? raw?.trueTrack ?? 0),
    alt_baro: altitude,
    alt_geom: altitude,
    gs: groundSpeed,
    ias: raw?.ias ?? null,
    mach: raw?.mach ?? null,
    vert_rate: verticalSpeed,
    baro_rate: verticalSpeed,
    t: type,
    type
  };
}

async function getFr24AircraftByHex(hex) {
  const targetHex = String(hex || "").trim().toLowerCase();
  if (!targetHex || !FR24_API_KEY) return null;

  console.log(`search hex=${targetHex}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    for (const bounds of FR24_BOUNDS_LIST) {
      try {
        const data = await fetchFr24LiveByBounds(bounds);
        const list = pickArrayFromFr24Response(data);

        console.log(
          `attempt=${attempt + 1}, bounds=${bounds}, list.length=${list.length}`
        );

        const found = list.find(item => {
          const itemHex = String(
            item?.hex ??
            item?.aircraftHex ??
            item?.transponder ??
            item?.icao24 ??
            item?.icao ??
            ""
          ).trim().toLowerCase();

          return itemHex === targetHex;
        });

        if (found) {
          console.log(`found ${targetHex} in bounds=${bounds}`);
          return normalizeFr24Aircraft(found);
        }
      } catch (err) {
        console.error(`FR24 bounds fetch failed (${bounds}):`, err.message);
      }
    }
  }

  console.log(`not found: ${targetHex}`);
  return null;
}

app.get("/api/fr24-fallback", async (req, res) => {
  try {
    const hexes = String(req.query.hexes || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (!hexes.length) {
      return res.json({ aircraft: [] });
    }

    const results = [];

    for (const hex of hexes) {
      try {
        const ac = await getFr24AircraftByHex(hex);
        if (ac) {
          results.push(ac);
        }
      } catch (innerErr) {
        console.error(`FR24 fetch failed for ${hex}:`, innerErr);
      }
    }

    return res.json({ aircraft: results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ aircraft: [] });
  }
});

app.get("/api/fr24-debug", async (req, res) => {
  try {
    const bounds = req.query.bounds || "55,15,73,135";
    const data = await fetchFr24LiveByBounds(bounds);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`FR24 proxy server running on port ${PORT}`);
});
