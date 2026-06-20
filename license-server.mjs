/**
 * IMC Studio — License + Relay Server
 * Image Media Club (c) 2026
 *
 * Endpoints de Licencias:
 *   POST /api/license/generate   generar codigo (requiere ADMIN_SECRET)
 *   POST /api/license/activate   activar instalacion
 *   POST /api/license/validate   validar licencia
 *   POST /api/license/revoke     revocar licencia (requiere ADMIN_SECRET)
 *   GET  /api/licenses           listar licencias (requiere ADMIN_SECRET)
 *   GET  /api/version            version actual del software
 *   GET  /health                 health check
 *
 * Endpoints de Relay (Now Playing):
 *   POST /api/relay/register     registrar estacion, devuelve stationId + apiKey
 *   POST /api/relay/push         push Now Playing desde IMC Studio (X-Station-Key)
 *   GET  /api/relay/now-playing/:stationId   leer Now Playing (publico)
 *   GET  /api/relay/widget.js?stationId=xxx  widget JS embebible
 */

import http from "http";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3900;
const DATA_FILE = path.join(__dirname, "data", "licenses.json");
const LOG_FILE = path.join(__dirname, "data", "license-log.txt");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "imagemediaclub2026admin";

const CURRENT_VERSION = {
  version: "1.1.0",
  buildDate: "2026-06-20",
  changelog: "Relay Now Playing en tiempo real. AutoDJ, TV visual, Locutor IA, Multistream, Portal y Podcasts.",
  downloadUrl: "https://imagemediaclub.com/download/imc-studio-1.1.0.exe"
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Station-Key"
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > 65536) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

async function loadLicenses() {
  try { return JSON.parse(await fs.readFile(DATA_FILE, "utf8")); }
  catch { return {}; }
}

async function saveLicenses(data) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg + "\n";
  console.log(msg);
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.appendFile(LOG_FILE, line, "utf8");
  } catch {}
}

function generateCode() {
  const part = () => crypto.randomBytes(4).toString("hex").toUpperCase();
  return "CR-" + part() + "-" + part().slice(0,4) + "-" + part().slice(0,4);
}

function isExpired(license) {
  if (!license.expiresAt) return false;
  return new Date(license.expiresAt) < new Date();
}

function checkAdmin(req) {
  const auth = req.headers["authorization"] || "";
  return auth === "Bearer " + ADMIN_SECRET;
}

// ── RELAY DATA ─────────────────────────────────────────────────────────────────
const RELAY_FILE = path.join(__dirname, "data", "relay.json");
const relayCache = new Map();

async function loadRelay() {
  try {
    const disk = JSON.parse(await fs.readFile(RELAY_FILE, "utf8"));
    for (const [k, v] of Object.entries(disk)) relayCache.set(k, v);
    return disk;
  } catch { return Object.fromEntries(relayCache); }
}

async function saveRelay(data) {
  for (const [k, v] of Object.entries(data)) relayCache.set(k, v);
  await fs.mkdir(path.dirname(RELAY_FILE), { recursive: true });
  await fs.writeFile(RELAY_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ── SERVER ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Station-Key"
    });
    return res.end();
  }

  if (url.pathname === "/health") return json(res, 200, { ok: true, service: "IMC Studio Server", version: CURRENT_VERSION.version });
  if (url.pathname === "/api/version") return json(res, 200, CURRENT_VERSION);

  // ── LICENCIAS ──────────────────────────────────────────────────────────────
  if (url.pathname === "/api/license/generate" && req.method === "POST") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const body = await readBody(req);
    const code = generateCode();
    const licenses = await loadLicenses();
    const daysValid = Number(body.days || 365);
    const expiresAt = body.noExpiry ? null : new Date(Date.now() + daysValid * 86400000).toISOString();
    licenses[code] = {
      code, client: body.client || "Sin nombre", email: body.email || "",
      plan: body.plan || "Profesional", createdAt: new Date().toISOString(),
      expiresAt, status: "pendiente", installId: null, activatedAt: null,
      version: null, notes: body.notes || ""
    };
    await saveLicenses(licenses);
    await log("Licencia generada: " + code + " -> " + (body.client || "Sin nombre"));
    return json(res, 200, { ok: true, code, license: licenses[code] });
  }

  if (url.pathname === "/api/license/activate" && req.method === "POST") {
    const body = await readBody(req);
    const { code, installId, version, stationName } = body;
    if (!code || !installId) return json(res, 400, { ok: false, error: "Faltan code e installId" });
    const licenses = await loadLicenses();
    const license = licenses[code.toUpperCase()];
    if (!license) return json(res, 404, { ok: false, error: "Codigo invalido" });
    if (isExpired(license)) return json(res, 403, { ok: false, error: "Licencia vencida" });
    if (license.installId && license.installId !== installId) {
      await log("ALERTA: intento de activar " + code + " en segunda instalacion " + installId);
      return json(res, 409, { ok: false, error: "Codigo ya activado en otra instalacion. Contacta soporte." });
    }
    license.status = "activa";
    license.installId = installId;
    license.activatedAt = license.activatedAt || new Date().toISOString();
    license.version = version || license.version;
    license.stationName = stationName || license.stationName;
    license.lastSeen = new Date().toISOString();
    await saveLicenses(licenses);
    await log("Licencia activada: " + code + " -> " + license.client);
    return json(res, 200, { ok: true, status: "activa", client: license.client, plan: license.plan, expiresAt: license.expiresAt, code });
  }

  if (url.pathname === "/api/license/validate" && req.method === "POST") {
    const body = await readBody(req);
    const { code, installId, version } = body;
    if (!code || !installId) return json(res, 400, { ok: false, error: "Faltan parametros" });
    const licenses = await loadLicenses();
    const license = licenses[code.toUpperCase()];
    if (!license) return json(res, 200, { ok: false, valid: false, reason: "not_found" });
    if (license.status === "revocada") return json(res, 200, { ok: false, valid: false, reason: "revoked" });
    if (isExpired(license)) return json(res, 200, { ok: false, valid: false, reason: "expired", expiresAt: license.expiresAt });
    if (license.installId && license.installId !== installId) return json(res, 200, { ok: false, valid: false, reason: "wrong_install" });
    license.lastSeen = new Date().toISOString();
    if (version) license.version = version;
    await saveLicenses(licenses);
    return json(res, 200, {
      ok: true, valid: true, status: license.status,
      client: license.client, plan: license.plan, expiresAt: license.expiresAt,
      daysLeft: license.expiresAt ? Math.max(0, Math.ceil((new Date(license.expiresAt) - new Date()) / 86400000)) : null,
      updateAvailable: CURRENT_VERSION.version !== version,
      latestVersion: CURRENT_VERSION.version
    });
  }

  if (url.pathname === "/api/license/revoke" && req.method === "POST") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const body = await readBody(req);
    const licenses = await loadLicenses();
    const license = licenses[body.code?.toUpperCase()];
    if (!license) return json(res, 404, { ok: false, error: "No encontrado" });
    license.status = "revocada";
    license.revokedAt = new Date().toISOString();
    license.revokedReason = body.reason || "";
    await saveLicenses(licenses);
    await log("Licencia revocada: " + body.code);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/licenses" && req.method === "GET") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const licenses = await loadLicenses();
    const list = Object.values(licenses).map(lic => ({
      ...lic,
      expired: isExpired(lic),
      daysLeft: lic.expiresAt ? Math.max(0, Math.ceil((new Date(lic.expiresAt) - new Date()) / 86400000)) : null
    }));
    return json(res, 200, { ok: true, total: list.length, licenses: list });
  }

  // ── RELAY: NOW PLAYING ────────────────────────────────────────────────────
  if (url.pathname === "/api/relay/register" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.stationName) return json(res, 400, { ok: false, error: "stationName requerido" });
    const relay = await loadRelay();
    const existing = Object.values(relay).find(s => s.name === body.stationName && s.licenseCode === (body.licenseCode || ""));
    if (existing) return json(res, 200, { ok: true, stationId: existing.stationId, apiKey: existing.apiKey, existing: true });
    const stationId = crypto.randomBytes(6).toString("hex");
    const apiKey    = crypto.randomBytes(16).toString("hex");
    relay[stationId] = {
      stationId, apiKey, name: body.stationName,
      licenseCode: body.licenseCode || "",
      registeredAt: new Date().toISOString(),
      nowPlaying: null
    };
    await saveRelay(relay);
    await log("Relay registrado: " + stationId + " - " + body.stationName);
    return json(res, 200, { ok: true, stationId, apiKey });
  }

  if (url.pathname === "/api/relay/push" && req.method === "POST") {
    const body = await readBody(req);
    const key = req.headers["x-station-key"] || "";
    const sid = body.stationId || "";
    if (!sid || !key) return json(res, 400, { ok: false, error: "stationId y X-Station-Key requeridos" });
    const relay = await loadRelay();
    const station = relay[sid];
    if (!station) return json(res, 404, { ok: false, error: "Estacion no encontrada" });
    if (station.apiKey !== key) return json(res, 403, { ok: false, error: "API key invalida" });
    station.nowPlaying = {
      status: body.status || "on-air",
      updatedAt: new Date().toISOString(),
      item: {
        title: body.title || "",
        artist: body.artist || "",
        duration: Number(body.duration || 0),
        cover: body.cover || "",
        kind: body.kind || "music"
      },
      next: body.next || null,
      listeners: Number(body.listeners || 0),
      station: station.name
    };
    await saveRelay(relay);
    return json(res, 200, { ok: true, updatedAt: station.nowPlaying.updatedAt });
  }

  const npMatch = url.pathname.match(/^\/api\/relay\/now-playing\/([a-f0-9]+)$/);
  if (npMatch && req.method === "GET") {
    const relay = await loadRelay();
    const station = relay[npMatch[1]];
    if (!station) return json(res, 404, { ok: false, error: "Estacion no encontrada" });
    return json(res, 200, station.nowPlaying || { status: "idle", item: { title: station.name, artist: "En vivo" } });
  }

  if (url.pathname === "/api/relay/widget.js" && req.method === "GET") {
    const sid  = url.searchParams.get("stationId") || "";
    const elId = url.searchParams.get("elementId") || "imc-now-playing";
    const base = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
    const widgetJs = `(function(){
  var S='${sid}',E='${elId}',A='${base}/api/relay/now-playing/${sid}';
  function t(s,v){ var e=document.querySelector(s); if(e) e.textContent=v; }
  function u(){
    fetch(A+'?ts='+Date.now()).then(function(r){return r.json();}).then(function(d){
      var i=d.item||{};
      t('#'+E+' .imc-title', i.title||d.station||'En vivo');
      t('#'+E+' .imc-artist', i.artist||'');
      var c=document.querySelector('#'+E+' .imc-cover');
      if(c&&i.cover) c.src=i.cover;
    }).catch(function(){});
  }
  u(); setInterval(u,10000);
})();`;
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    return res.end(widgetJs);
  }

  return json(res, 404, { ok: false, error: "Ruta no encontrada" });
});

server.listen(PORT, () => {
  console.log("\nIMC Studio - License + Relay Server");
  console.log("   Puerto: " + PORT);
  console.log("   Admin:  Authorization: Bearer " + ADMIN_SECRET);
  console.log("   Relay:  POST /api/relay/register | push | GET /api/relay/now-playing/:id\n");
});
