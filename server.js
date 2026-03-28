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
const APP_VERSION = "fr24-reg-direct-v1";

const FETCH_TIMEOUT_MS = 12000;
const FRESH_CACHE_TTL_MS = 2 * 60 * 1000;    // 2분
const STALE_CACHE_TTL_MS = 30 * 60 * 1000;   // 30분
const BETWEEN_BATCH_DELAY_MS = 350;
const MAX_REGS_PER_REQUEST = 10;

const aircraftCache = new Map();

/* ------------------ FIXED HEX MAP ------------------ */


const HEX_TO_REG_MAP = {
  "71c550": "HL8550",
  "71c290": "HL8290",
  "71c299": "HL8299",
  "71ba27": "HL7227",
  "71c080": "HL8080",
  "71c372": "HL8372",
  "71c508": "HL8508",
  "71c230": "HL8230",
  "71c068": "HL8068",
  "71c222": "HL8222",
   "71c751": "HL8751"           
};

const REG_TO_HEX_MAP = Object.fromEntries(
  Object.entries(HEX_TO_REG_MAP).map(([hex, reg]) => [reg.toUpperCase(), hex])
);

/* ------------------ COMMON ------------------ */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeHex(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeReg(value) {
  return String(value || "").trim().toUpperCase();
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
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
  const hex = normalizeHex(aircraft?.hex);
  if (!hex) return;

  const now = Date.now();

  aircraftCache.set(hex, {
    savedAt: now,
    data: {
      ...aircraft,
      hex,
      reg: normalizeReg(aircraft?.reg),
      last_seen_iso: new Date(now).toISOString(),
      source_detail: meta.source_detail || "fr24:registration"
    }
  });
}

function getFreshCachedAircraft(hex) {
  const key = normalizeHex(hex);
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
  const key = normalizeHex(hex);
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

/* ------------------ FR24 ------------------ */

function buildFr24Headers() {
  return {
    "Accept": "application/json",
    "Accept-Version": "v1",
    "Authorization": `Bearer ${FR24_API_KEY}`
  };
}

async function fetchFr24ByRegistrations(registrations) {
  const regs = registrations
    .map(normalizeReg)
    .filter(Boolean);

  if (!regs.length) {
    return [];
  }

  const qs = new URLSearchParams();
  qs.set("registrations", regs.join(","));

  const url =
    `https://fr24api.flightradar24.com/api/live/flight-positions/full?${qs.toString()}`;

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: buildFr24Headers()
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`FR24 HTTP ${res.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`FR24 invalid JSON: ${text}`);
  }

  return pickArrayFromFr24Response(data);
}

function pickArrayFromFr24Response(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.aircraft)) return data.aircraft;
  return [];
}

function normalizeFr24Aircraft(raw) {
  const reg = normalizeReg(
    raw?.registration ??
    raw?.reg ??
    raw?.aircraftRegistration ??
    raw?.identification?.registration ??
    ""
  );

  const mappedHex = REG_TO_HEX_MAP[reg] || "";

  const hex = normalizeHex(
    raw?.hex ??
    raw?.aircraftHex ??
    raw?.transponder ??
    raw?.icao24 ??
    raw?.icao ??
    mappedHex
  );

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
    reg,
    registration: reg,
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

async function getFr24AircraftByHexes(hexes) {
  const uniqueHexes = [...new Set(hexes.map(normalizeHex).filter(Boolean))];

  const regTargets = [];
  const unknownHexes = [];

  for (const hex of uniqueHexes) {
    const reg = HEX_TO_REG_MAP[hex];
    if (reg) {
      regTargets.push(reg);
    } else {
      unknownHexes.push(hex);
    }
  }

  const foundMap = new Map();

  if (!FR24_API_KEY) {
    throw new Error("FR24_API_KEY missing");
  }

  const regBatches = chunkArray(regTargets, MAX_REGS_PER_REQUEST);

  for (const regs of regBatches) {
    try {
      const rows = await fetchFr24ByRegistrations(regs);

      for (const row of rows) {
        const normalized = normalizeFr24Aircraft(row);
        if (!normalized) continue;

        foundMap.set(normalized.hex, normalized);
        setCachedAircraft(normalized, {
          source_detail: `fr24:registrations:${regs.join(",")}`
        });
      }
    } catch (err) {
      console.error("FR24 registration batch failed:", regs, err.message || err);
    }

    await delay(BETWEEN_BATCH_DELAY_MS);
  }

  return {
    foundMap,
    unknownHexes
  };
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
    mappingCount: Object.keys(HEX_TO_REG_MAP).length,
    mode: "registration-direct-only"
  });
});

app.get("/api/mapping", (req, res) => {
  return res.json({
    version: APP_VERSION,
    mode: "registration-direct-only",
    mapping: Object.entries(HEX_TO_REG_MAP).map(([hex, reg]) => ({
      hex,
      reg
    }))
  });
});

app.get("/api/cache-debug", (req, res) => {
  cleanupCache();

  const rows = [];
  for (const [hex, entry] of aircraftCache.entries()) {
    rows.push({
      hex,
      reg: entry?.data?.reg || "",
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

app.get("/api/fr24-by-reg", async (req, res) => {
  try {
    const reg = normalizeReg(req.query.reg || "");

    if (!reg) {
      return res.status(400).json({
        version: APP_VERSION,
        error: "reg is required"
      });
    }

    const rows = await fetchFr24ByRegistrations([reg]);
    const aircraft = rows
      .map(normalizeFr24Aircraft)
      .filter(Boolean);

    for (const a of aircraft) {
      setCachedAircraft(a, { source_detail: `fr24:registrations:${reg}` });
    }

    return res.json({
      version: APP_VERSION,
      reg,
      count: aircraft.length,
      aircraft
    });
  } catch (err) {
    return res.status(500).json({
      version: APP_VERSION,
      error: String(err.message || err)
    });
  }
});

app.get("/api/fr24-hex-lookup", (req, res) => {
  const hex = normalizeHex(req.query.hex || "");
  const reg = HEX_TO_REG_MAP[hex] || "";

  return res.json({
    version: APP_VERSION,
    hex,
    reg,
    found: !!reg
  });
});

app.get("/api/fr24-fallback", async (req, res) => {
  try {
    cleanupCache();

    const hexes = String(req.query.hexes || "")
      .split(",")
      .map(normalizeHex)
      .filter(Boolean);

    if (!hexes.length) {
      return res.json({
        version: APP_VERSION,
        aircraft: [],
        unknown_hexes: []
      });
    }

    const results = [];
    const remainingHexes = [];

    for (const hex of hexes) {
      const fresh = getFreshCachedAircraft(hex);
      if (fresh) {
        results.push({
          ...fresh,
          mode: "fresh-cache"
        });
      } else {
        remainingHexes.push(hex);
      }
    }

    let foundMap = new Map();
    let unknownHexes = [];

    if (remainingHexes.length) {
      const liveResult = await getFr24AircraftByHexes(remainingHexes);
      foundMap = liveResult.foundMap;
      unknownHexes = liveResult.unknownHexes;
    }

    for (const hex of remainingHexes) {
      const live = foundMap.get(hex);
      if (live) {
        results.push({
          ...live,
          mode: "live"
        });
        continue;
      }

      const fresh = getFreshCachedAircraft(hex);
      if (fresh) {
        results.push({
          ...fresh,
          mode: "fresh-cache-after-live"
        });
        continue;
      }

      const stale = getStaleCachedAircraft(hex);
      if (stale) {
        results.push({
          ...stale,
          mode: "stale-cache"
        });
      }
    }

    const orderMap = new Map(hexes.map((hex, idx) => [hex, idx]));
    results.sort((a, b) => {
      return (orderMap.get(a.hex) ?? 9999) - (orderMap.get(b.hex) ?? 9999);
    });

    return res.json({
      version: APP_VERSION,
      aircraft: results,
      unknown_hexes: unknownHexes
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
