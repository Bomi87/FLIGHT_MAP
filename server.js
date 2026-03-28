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

/*
  FR24 live positions는 geographic bounds 기반 조회 흐름으로 사용.
  중국 보완을 위해 3단계 bounds로 탐색:
  1) 중국 중심
  2) 동아시아 확장
  3) 아시아 광역
*/
const FR24_BOUNDS_LIST = [
  "18,55,73,135",
  "5,60,60,150",
  "-10,70,40,170"
];

async function fetchFr24LiveByBounds(bounds) {
  const url =
    `https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=${encodeURIComponent(bounds)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${FR24_API_KEY}`
    }
  });

  if (!res.ok) {
    throw new Error(`FR24 HTTP ${res.status}`);
  }

  return await res.json();
}

function pickArrayFromFr24Response(data) {
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
      ""
    ).trim().toLowerCase();

  if (!hex) return null;

  const lat = Number(raw?.lat ?? raw?.latitude);
  const lon = Number(raw?.lon ?? raw?.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const flight =
    String(raw?.flight ?? raw?.callsign ?? raw?.identification?.callsign ?? "").trim();

  const callsign =
    String(raw?.callsign ?? raw?.flight ?? raw?.identification?.callsign ?? "").trim();

  const type =
    String(raw?.type ?? raw?.aircraftType ?? raw?.aircraft?.model?.code ?? "").trim();

  const altitude =
    raw?.altitude ??
    raw?.alt_baro ??
    raw?.alt_geom ??
    raw?.barometricAltitude ??
    null;

  const groundSpeed =
    raw?.groundSpeed ??
    raw?.gs ??
    raw?.speed ??
    null;

  const verticalSpeed =
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

  for (const bounds of FR24_BOUNDS_LIST) {
    try {
      const data = await fetchFr24LiveByBounds(bounds);
      const list = pickArrayFromFr24Response(data);

      if (!list.length) {
        continue;
      }

      const found = list.find(item => {
        const itemHex = String(
          item?.hex ??
          item?.aircraftHex ??
          item?.transponder ??
          ""
        ).trim().toLowerCase();

        return itemHex === targetHex;
      });

      if (found) {
        return normalizeFr24Aircraft(found);
      }
    } catch (err) {
      console.error(`FR24 bounds fetch failed (${bounds}):`, err.message);
    }
  }

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

app.listen(PORT, () => {
  console.log(`FR24 proxy server running on port ${PORT}`);
});
