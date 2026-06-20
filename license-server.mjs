/**
 * IMC Studio — License + Relay Server v1.2.0
 * Image Media Club (c) 2026
 *
 * Endpoints Licencias:
 *   POST /api/license/generate   POST /api/license/activate
 *   POST /api/license/validate   POST /api/license/revoke
 *   GET  /api/licenses           GET  /api/version   GET  /health
 *
 * Endpoints Relay (Now Playing):
 *   POST /api/relay/register                          registrar estacion
 *   POST /api/relay/push                              push Now Playing (X-Station-Key)
 *   GET  /api/relay/now-playing/:stationId            leer por ID (publico)
 *   GET  /api/relay/now-playing/by-name/:stationName  leer por nombre (publico, automatico)
 *   GET  /api/relay/widget.js?stationId=xxx           widget JS embebible
 */

import http from "http";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3900;
const DATA_FILE = path.join(__dirname, "data", "licenses.json");
const LOG_FILE  = path.join(__dirname, "data", "license-log.txt");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "imagemediaclub2026admin";

const CURRENT_VERSION = {
  version: "1.2.0",
  buildDate: "2026-06-20",
  changelog: "Relay by-name: conexion automatica sin configurar stationId.",
  downloadUrl: "https://imagemediaclub.com/download/imc-studio-1.2.0.exe"
};

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Station-Key"
  });
  res.end(JSON.stringify(data));
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
  try { await fs.mkdir(path.dirname(LOG_FILE), { recursive: true }); await fs.appendFile(LOG_FILE, line, "utf8"); } catch {}
}
function generateCode() {
  const part = () => crypto.randomBytes(4).toString("hex").toUpperCase();
  return "IMC-" + part() + "-" + part().slice(0,4) + "-" + part().slice(0,4);
}
function isExpired(lic) { return lic.expiresAt ? new Date(lic.expiresAt) < new Date() : false; }
function checkAdmin(req) { return (req.headers["authorization"] || "") === "Bearer " + ADMIN_SECRET; }

// ── RELAY ──────────────────────────────────────────────────────────────────────
const RELAY_FILE  = path.join(__dirname, "data", "relay.json");
const relayCache  = new Map();

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
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Station-Key" });
    return res.end();
  }

  // ── BASIC ──────────────────────────────────────────────────────────────────
  if (url.pathname === "/health") return json(res, 200, { ok: true, service: "IMC Studio Server", version: CURRENT_VERSION.version });
  if (url.pathname === "/api/version") return json(res, 200, CURRENT_VERSION);

  // ── LICENCIAS ──────────────────────────────────────────────────────────────
  if (url.pathname === "/api/license/generate" && req.method === "POST") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const body = await readBody(req);
    const code = generateCode();
    const licenses = await loadLicenses();
    const days = Number(body.days || 365);
    licenses[code] = { code, client: body.client || "Sin nombre", email: body.email || "", plan: body.plan || "Profesional", createdAt: new Date().toISOString(), expiresAt: body.noExpiry ? null : new Date(Date.now() + days * 86400000).toISOString(), status: "pendiente", installId: null, activatedAt: null, version: null, notes: body.notes || "" };
    await saveLicenses(licenses);
    await log("Licencia generada: " + code + " -> " + (body.client || "Sin nombre"));
    return json(res, 200, { ok: true, code, license: licenses[code] });
  }

  if (url.pathname === "/api/license/activate" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.code || !body.installId) return json(res, 400, { ok: false, error: "Faltan code e installId" });
    const licenses = await loadLicenses();
    const lic = licenses[body.code.toUpperCase()];
    if (!lic) return json(res, 404, { ok: false, error: "Codigo invalido" });
    if (isExpired(lic)) return json(res, 403, { ok: false, error: "Licencia vencida" });
    if (lic.installId && lic.installId !== body.installId) return json(res, 409, { ok: false, error: "Codigo ya activado en otra instalacion. Contacta soporte." });
    lic.status = "activa"; lic.installId = body.installId; lic.activatedAt = lic.activatedAt || new Date().toISOString();
    lic.version = body.version || lic.version; lic.stationName = body.stationName || lic.stationName; lic.lastSeen = new Date().toISOString();
    await saveLicenses(licenses);
    await log("Licencia activada: " + body.code + " -> " + lic.client);
    return json(res, 200, { ok: true, status: "activa", client: lic.client, plan: lic.plan, expiresAt: lic.expiresAt, code: body.code });
  }

  if (url.pathname === "/api/license/validate" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.code || !body.installId) return json(res, 400, { ok: false, error: "Faltan parametros" });
    const licenses = await loadLicenses();
    const lic = licenses[body.code.toUpperCase()];
    if (!lic) return json(res, 200, { ok: false, valid: false, reason: "not_found" });
    if (lic.status === "revocada") return json(res, 200, { ok: false, valid: false, reason: "revoked" });
    if (isExpired(lic)) return json(res, 200, { ok: false, valid: false, reason: "expired", expiresAt: lic.expiresAt });
    if (lic.installId && lic.installId !== body.installId) return json(res, 200, { ok: false, valid: false, reason: "wrong_install" });
    lic.lastSeen = new Date().toISOString(); if (body.version) lic.version = body.version;
    await saveLicenses(licenses);
    return json(res, 200, { ok: true, valid: true, status: lic.status, client: lic.client, plan: lic.plan, expiresAt: lic.expiresAt, daysLeft: lic.expiresAt ? Math.max(0, Math.ceil((new Date(lic.expiresAt) - new Date()) / 86400000)) : null, updateAvailable: CURRENT_VERSION.version !== body.version, latestVersion: CURRENT_VERSION.version });
  }

  if (url.pathname === "/api/license/revoke" && req.method === "POST") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const body = await readBody(req);
    const licenses = await loadLicenses();
    const lic = licenses[body.code?.toUpperCase()];
    if (!lic) return json(res, 404, { ok: false, error: "No encontrado" });
    lic.status = "revocada"; lic.revokedAt = new Date().toISOString(); lic.revokedReason = body.reason || "";
    await saveLicenses(licenses); await log("Licencia revocada: " + body.code);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/licenses" && req.method === "GET") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const licenses = await loadLicenses();
    const list = Object.values(licenses).map(l => ({ ...l, expired: isExpired(l), daysLeft: l.expiresAt ? Math.max(0, Math.ceil((new Date(l.expiresAt) - new Date()) / 86400000)) : null }));
    return json(res, 200, { ok: true, total: list.length, licenses: list });
  }

  // ── RELAY: REGISTRO ────────────────────────────────────────────────────────
  if (url.pathname === "/api/relay/register" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.stationName) return json(res, 400, { ok: false, error: "stationName requerido" });
    const relay = await loadRelay();
    const existing = Object.values(relay).find(s => s.name.toLowerCase() === body.stationName.toLowerCase() && s.licenseCode === (body.licenseCode || ""));
    if (existing) return json(res, 200, { ok: true, stationId: existing.stationId, apiKey: existing.apiKey, existing: true });
    const stationId = crypto.randomBytes(6).toString("hex");
    const apiKey    = crypto.randomBytes(16).toString("hex");
    relay[stationId] = { stationId, apiKey, name: body.stationName, licenseCode: body.licenseCode || "", registeredAt: new Date().toISOString(), nowPlaying: null };
    await saveRelay(relay);
    await log("Relay registrado: " + stationId + " - " + body.stationName);
    return json(res, 200, { ok: true, stationId, apiKey });
  }

  // ── RELAY: PUSH NOW PLAYING ────────────────────────────────────────────────
  if (url.pathname === "/api/relay/push" && req.method === "POST") {
    const body = await readBody(req);
    const key = req.headers["x-station-key"] || "";
    const sid = body.stationId || "";
    if (!sid || !key) return json(res, 400, { ok: false, error: "stationId y X-Station-Key requeridos" });
    const relay = await loadRelay();
    const station = relay[sid];
    if (!station) return json(res, 404, { ok: false, error: "Estacion no encontrada" });
    if (station.apiKey !== key) return json(res, 403, { ok: false, error: "API key invalida" });
    station.nowPlaying = { status: body.status || "on-air", updatedAt: new Date().toISOString(), item: { title: body.title || "", artist: body.artist || "", duration: Number(body.duration || 0), cover: body.cover || "", kind: body.kind || "music" }, next: body.next || null, listeners: Number(body.listeners || 0), station: station.name };
    await saveRelay(relay);
    return json(res, 200, { ok: true, updatedAt: station.nowPlaying.updatedAt });
  }

  // ── RELAY: GET BY ID ───────────────────────────────────────────────────────
  const npMatch = url.pathname.match(/^\/api\/relay\/now-playing\/(?!by-name\/)([a-f0-9]+)$/);
  if (npMatch && req.method === "GET") {
    const relay = await loadRelay();
    const station = relay[npMatch[1]];
    if (!station) return json(res, 404, { ok: false, error: "Estacion no encontrada" });
    return json(res, 200, station.nowPlaying || { status: "idle", item: { title: station.name, artist: "En vivo" }, station: station.name });
  }

  // ── RELAY: GET BY NAME (AUTOMATICO — sin configurar stationId) ─────────────
  // El portal solo necesita el nombre de la estacion, que ya esta en station-config.json.
  // IMC Studio se registra con ese nombre => la pagina web lo encuentra sola.
  const byNameMatch = url.pathname.match(/^\/api\/relay\/now-playing\/by-name\/(.+)$/);
  if (byNameMatch && req.method === "GET") {
    const relay = await loadRelay();
    const name = decodeURIComponent(byNameMatch[1]).toLowerCase().trim();
    const station = Object.values(relay).find(s => s.name.toLowerCase().trim() === name);
    if (!station) return json(res, 404, { ok: false, error: "Estacion no encontrada" });
    return json(res, 200, station.nowPlaying || { status: "idle", item: { title: station.name, artist: "En vivo" }, station: station.name });
  }

  // ── RELAY: WIDGET JS ───────────────────────────────────────────────────────
  if (url.pathname === "/api/relay/widget.js" && req.method === "GET") {
    const sid  = url.searchParams.get("stationId") || "";
    const name = url.searchParams.get("stationName") || "";
    const elId = url.searchParams.get("elementId") || "imc-now-playing";
    const base2 = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
    const apiUrl = sid ? base2 + "/api/relay/now-playing/" + sid : base2 + "/api/relay/now-playing/by-name/" + encodeURIComponent(name);
    const widgetJs = "(function(){ var A='" + apiUrl + "',E='" + elId + "'; function t(s,v){ var e=document.querySelector(s); if(e) e.textContent=v; } function u(){ fetch(A+'?ts='+Date.now()).then(function(r){return r.json();}).then(function(d){ var i=d.item||{}; t('#'+E+' .imc-title',i.title||d.station||''); t('#'+E+' .imc-artist',i.artist||''); var c=document.querySelector('#'+E+' .imc-cover'); if(c&&i.cover) c.src=i.cover; }).catch(function(){}); } u(); setInterval(u,10000); })();";
    res.writeHead(200, { "Content-Type": "application/javascript", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
    return res.end(widgetJs);
  }

  return json(res, 404, { ok: false, error: "Ruta no encontrada" });

}).listen(PORT, () => {
  console.log("\nIMC Studio License + Relay Server v" + CURRENT_VERSION.version);
  console.log("   Puerto : " + PORT);
  console.log("   Admin  : Authorization: Bearer " + ADMIN_SECRET);
  console.log("   Relay  : /api/relay/register | push | now-playing/:id | now-playing/by-name/:name\n");
});
