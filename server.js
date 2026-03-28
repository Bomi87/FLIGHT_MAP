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
  중국/주변 위주 bounds
  너무 많으면 느려지고, 너무 적으면 못 잡음
*/
const FR24_BOUNDS_LIST = [
  "45,35,105,125", // 중국 북부/베이징
  "40,28,112,124", // 동부/상하이
  "32,20,105,122", // 남부/광저우-선전
  "35,22,95,112",  // 내륙/청두-충칭
  "50,35,85,110",  // 서북부
  "55,15,73,135"   // 중국+주변 fallback
];

/*
  fresh cache: 최근 성공값
  stale cache: 오래됐더라도 마지막 성공값
*/
const FRESH_CACHE_TTL_MS = 2 * 60 * 1000;   // 2분
const STALE_CACHE_TTL_MS = 30 * 60 * 1000;  // 30분

const aircraftCache = new Map();

/* ------------------ FR24 FETCH ------------------ */

async function fetchFr24LiveByBounds(bounds) {
  const url =
    `https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=${encodeURIComponent(bounds)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Version": "v1",
      Authorization: `Bearer ${FR24_API_KEY}`
    },
    timeout: 15000
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
  const hex = String(
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

  const flight = String(
    raw?.flight ??
    raw?.callsign ??
    raw?.identification?.callsign ??
    ""
  ).trim();

  const callsign = String(
    raw?.callsign ??
    raw?.flight ??
    raw?.identification?.callsign ??
    ""
  ).trim();

  const type = String(
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

/* ------------------ CACHE ------------------ */

function setCachedAircraft(aircraft, meta = {}) {
  if (!aircraft?.hex) return;

  const now = Date.now();

  aircraftCache.set(aircraft.hex, {
    savedAt: now,
    lastSuccessAt: now,
    data: {
      ...aircraft,
      cache_status: "live",
      last_seen_iso: new Date(now).toISOString(),
      source_detail: meta.source_detail || "fr24"
    }
  });
}

function getFreshCachedAircraft(hex) {
  const key = String(hex || "").trim().toLowerCase();
  if (!key) return null;

  const cached = aircraftCache.get(key);
  if (!cached) return null;

  const ageMs = Date.now() - cached.savedAt;
  if (ageMs > FRESH_CACHE_TTL_MS) return null;

  return {
    ...cached.data,
    cache_status: "fresh-cache",
    cache_age_ms: ageMs
  };
}

function getStaleCachedAircraft(hex) {
  const key = String(hex || "").trim().toLowerCase();
  if (!key) return null;

  const cached = aircraftCache.get(key);
  if (!cached) return null;

  const ageMs = Date.now() - cached.savedAt;
  if (ageMs > STALE_CACHE_TTL_MS) {
    aircraftCache.delete(key);
    return null;
  }

  return {
    ...cached.data,
    cache_status: "stale-cache",
    cache_age_ms: ageMs
  };
}

function cleanupCache() {
  const now = Date.now();

  for (const [hex, entry] of aircraftCache.entries()) {
    if (now - entry.savedAt > STALE_CACHE_TTL_MS) {
      aircraftCache.delete(hex);
    }
  }
}

/* ------------------ SEARCH ------------------ */

async function searchHexInBounds(targetHex, bounds) {
  const data = await fetchFr24LiveByBounds(bounds);
  const list = pickArrayFromFr24Response(data);

  console.log(`bounds=${bounds}, list.length=${list.length}`);

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

  return found ? normalizeFr24Aircraft(found) : null;
}

async function getFr24AircraftByHex(hex) {
  const targetHex = String(hex || "").trim().toLowerCase();
  if (!targetHex || !FR24_API_KEY) return null;

  console.log(`search hex=${targetHex}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    for (const bounds of FR24_BOUNDS_LIST) {
      try {
        const found = await searchHexInBounds(targetHex, bounds);

        if (found) {
          console.log(`found ${targetHex} in bounds=${bounds}, attempt=${attempt + 1}`);
          setCachedAircraft(found, { source_detail: `fr24:${bounds}` });
          return found;
        }
      } catch (err) {
        console.error(
          `FR24 bounds fetch failed (${bounds}) attempt=${attempt + 1}:`,
          err.message || err
        );
      }
    }
  }

  console.log(`not found in FR24: ${targetHex}`);
  return null;
}

/* ------------------ API ROUTES ------------------ */

app.get("/api/fr24-fallback", async (req, res) => {
  try {
    cleanupCache();

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
        const live = await getFr24AircraftByHex(hex);

        if (live) {
          results.push({
            ...live,
            result_mode: "live"
          });
          continue;
        }

        const fresh = getFreshCachedAircraft(hex);
        if (fresh) {
          console.log(`fresh cache hit: ${hex}`);
          results.push({
            ...fresh,
            result_mode: "fresh-cache"
          });
          continue;
        }

        const stale = getStaleCachedAircraft(hex);
        if (stale) {
          console.log(`stale cache hit: ${hex}`);
          results.push({
            ...stale,
            result_mode: "stale-cache"
          });
          continue;
        }

        console.log(`no live/cache result: ${hex}`);
      } catch (innerErr) {
        console.error(`FR24 fetch failed for ${hex}:`, innerErr.message || innerErr);

        const fresh = getFreshCachedAircraft(hex);
        if (fresh) {
          console.log(`fresh cache fallback after error: ${hex}`);
          results.push({
            ...fresh,
            result_mode: "fresh-cache-error-fallback"
          });
          continue;
        }

        const stale = getStaleCachedAircraft(hex);
        if (stale) {
          console.log(`stale cache fallback after error: ${hex}`);
          results.push({
            ...stale,
            result_mode: "stale-cache-error-fallback"
          });
        }
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

app.get("/api/cache-debug", (req, res) => {
  cleanupCache();

  const rows = [];
  for (const [hex, entry] of aircraftCache.entries()) {
    rows.push({
      hex,
      savedAt: new Date(entry.savedAt).toISOString(),
      ageMs: Date.now() - entry.savedAt,
      flight: entry?.data?.flight || "",
      callsign: entry?.data?.callsign || "",
      lat: entry?.data?.lat ?? null,
      lon: entry?.data?.lon ?? null,
      cache_status: entry?.data?.cache_status || "live"
    });
  }

  return res.json({
    count: rows.length,
    aircraft: rows
  });
});

app.get("/", (req, res) => {
  res.send("FR24 proxy server is running");
});

/* ------------------ START ------------------ */

app.listen(PORT, () => {
  console.log(`FR24 proxy server running on port ${PORT}`);
});
