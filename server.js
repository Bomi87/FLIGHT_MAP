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
const APP_VERSION = "fr24-cn-stable-v2";

/*
  너무 많이 쪼개면 429가 나서 오히려 역효과
  그래서 중국 위주 핵심 구역만 12개로 압축
*/
const FR24_BOUNDS_LIST = [
  "47,41,121,131", // 동북
  "44,38,117,125", // 랴오닝/허베이 동부
  "42,38,113,120", // 베이징/톈진
  "39,35,108,115", // 산시/허베이 서부
  "38,34,118,123", // 산둥 북부
  "36,32,118,123", // 산둥/장쑤 북부
  "34,30,111,117", // 허난/후베이
  "33,29,118,123", // 장쑤/상하이
  "28,24,117,122", // 푸젠/저장 남부
  "25,21,110,116", // 광둥/광시
  "33,29,103,109", // 쓰촨/충칭
  "55,15,73,135"   // 마지막 fallback
];

const FRESH_CACHE_TTL_MS = 2 * 60 * 1000;   // 2분
const STALE_CACHE_TTL_MS = 30 * 60 * 1000;  // 30분
const FETCH_TIMEOUT_MS = 12000;
const BETWEEN_BOUNDS_DELAY_MS = 350;

const aircraftCache = new Map();

/* ------------------ COMMON ------------------ */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function cleanupCache() {
  const now = Date.now();

  for (const [hex, entry] of aircraftCache.entries()) {
    if (now - entry.savedAt > STALE_CACHE_TTL_MS) {
      aircraftCache.delete(hex);
    }
  }
}

function setCachedAircraft(aircraft, meta = {}) {
  if (!aircraft?.hex) return;

  const now = Date.now();

  aircraftCache.set(aircraft.hex, {
    savedAt: now,
    data: {
      ...aircraft,
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
    cache_age_ms: ageMs
  };
}

/* ------------------ FR24 FETCH ------------------ */

async function fetchFr24LiveByBounds(bounds) {
  const url =
    `https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=${encodeURIComponent(bounds)}`;

  const res = await fetchWithTimeout(url, {
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

  if (!found) return null;
  return normalizeFr24Aircraft(found);
}

async function getFr24AircraftByHex(hex) {
  const targetHex = String(hex || "").trim().toLowerCase();
  if (!targetHex) return null;

  if (!FR24_API_KEY) {
    console.error("FR24_API_KEY missing");
    return null;
  }

  console.log(`search hex=${targetHex}`);

  // 429 방지를 위해 재시도는 1회만
  for (let attempt = 0; attempt < 1; attempt++) {
    for (const bounds of FR24_BOUNDS_LIST) {
      try {
        const found = await searchHexInBounds(targetHex, bounds);

        if (found) {
          console.log(`found ${targetHex} in bounds=${bounds}`);
          setCachedAircraft(found, { source_detail: `fr24:${bounds}` });
          return found;
        }
      } catch (err) {
        const msg = String(err.message || err);
        console.error(`FR24 bounds fetch failed (${bounds}):`, msg);

        if (msg.includes("429")) {
          console.error("FR24 rate limited, aborting search early");
          return null;
        }
      }

      await delay(BETWEEN_BOUNDS_DELAY_MS);
    }
  }

  console.log(`not found in FR24: ${targetHex}`);
  return null;
}

/* ------------------ ROUTES ------------------ */

app.get("/", (req, res) => {
  res.send(`FR24 proxy server is running - ${APP_VERSION}`);
});

app.get("/healthz", (req, res) => {
  cleanupCache();

  return res.json({
    ok: true,
    version: APP_VERSION,
    hasApiKey: !!FR24_API_KEY,
    cacheCount: aircraftCache.size,
    boundsCount: FR24_BOUNDS_LIST.length
  });
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
      source_detail: entry?.data?.source_detail || ""
    });
  }

  return res.json({
    version: APP_VERSION,
    count: rows.length,
    aircraft: rows
  });
});

app.get("/api/fr24-debug", async (req, res) => {
  try {
    const bounds = req.query.bounds || "55,15,73,135";
    const data = await fetchFr24LiveByBounds(bounds);
    const list = pickArrayFromFr24Response(data);

    return res.json({
      version: APP_VERSION,
      bounds,
      count: list.length,
      data
    });
  } catch (err) {
    return res.status(500).json({
      version: APP_VERSION,
      error: String(err.message || err)
    });
  }
});

app.get("/api/fr24-find", async (req, res) => {
  try {
    const hex = String(req.query.hex || "").trim().toLowerCase();

    if (!hex) {
      return res.status(400).json({
        version: APP_VERSION,
        error: "hex is required"
      });
    }

    const checks = [];

    for (const bounds of FR24_BOUNDS_LIST) {
      try {
        const data = await fetchFr24LiveByBounds(bounds);
        const list = pickArrayFromFr24Response(data);

        const found = list.find(item => {
          const itemHex = String(
            item?.hex ??
            item?.aircraftHex ??
            item?.transponder ??
            item?.icao24 ??
            item?.icao ??
            ""
          ).trim().toLowerCase();

          return itemHex === hex;
        });

        checks.push({
          bounds,
          count: list.length,
          found: !!found,
          aircraft: found ? normalizeFr24Aircraft(found) : null
        });

        if (found) {
          return res.json({
            version: APP_VERSION,
            hex,
            found: true,
            checks
          });
        }
      } catch (err) {
        const msg = String(err.message || err);

        checks.push({
          bounds,
          error: msg,
          found: false
        });

        if (msg.includes("429")) {
          return res.json({
            version: APP_VERSION,
            hex,
            found: false,
            stoppedReason: "rate_limited",
            checks
          });
        }
      }

      await delay(BETWEEN_BOUNDS_DELAY_MS);
    }

    return res.json({
      version: APP_VERSION,
      hex,
      found: false,
      checks
    });
  } catch (err) {
    return res.status(500).json({
      version: APP_VERSION,
      error: String(err.message || err)
    });
  }
});

app.get("/api/fr24-fallback", async (req, res) => {
  try {
    cleanupCache();

    const hexes = String(req.query.hexes || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (!hexes.length) {
      return res.json({
        version: APP_VERSION,
        aircraft: []
      });
    }

    const results = [];

    for (const hex of hexes) {
      try {
        const live = await getFr24AircraftByHex(hex);

        if (live) {
          results.push({
            ...live,
            mode: "live"
          });
          continue;
        }

        const fresh = getFreshCachedAircraft(hex);
        if (fresh) {
          console.log(`fresh cache hit: ${hex}`);
          results.push({
            ...fresh,
            mode: "fresh-cache"
          });
          continue;
        }

        const stale = getStaleCachedAircraft(hex);
        if (stale) {
          console.log(`stale cache hit: ${hex}`);
          results.push({
            ...stale,
            mode: "stale-cache"
          });
          continue;
        }

        console.log(`no result: ${hex}`);
      } catch (err) {
        console.error(`FR24 fetch failed for ${hex}:`, err.message || err);

        const fresh = getFreshCachedAircraft(hex);
        if (fresh) {
          results.push({
            ...fresh,
            mode: "fresh-cache-error-fallback"
          });
          continue;
        }

        const stale = getStaleCachedAircraft(hex);
        if (stale) {
          results.push({
            ...stale,
            mode: "stale-cache-error-fallback"
          });
        }
      }

      await delay(200);
    }

    return res.json({
      version: APP_VERSION,
      aircraft: results
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      version: APP_VERSION,
      aircraft: [],
      error: String(err.message || err)
    });
  }
});

/* ------------------ START ------------------ */

app.listen(PORT, () => {
  console.log(`FR24 proxy server running on port ${PORT} - ${APP_VERSION}`);
});
