/**
 * Ciudad Radio — Servidor de Licencias
 * Image Media Club © 2026
 *
 * Hosteá este archivo en cualquier VPS o Hostinger Node.js.
 * Puerto por defecto: 3900
 *
 * Endpoints:
 *   POST /api/license/generate   → genera un código nuevo (requiere ADMIN_SECRET)
 *   POST /api/license/activate   → activa una instalación con su código
 *   POST /api/license/validate   → valida si una licencia sigue activa
 *   POST /api/license/revoke     → revoca una licencia (requiere ADMIN_SECRET)
 *   GET  /api/licenses           → lista todas las licencias (requiere ADMIN_SECRET)
 *   GET  /api/version            → versión actual del software
 *   GET  /health                 → health check
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

// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────────
// Cambiá este secreto antes de deployar — nunca lo compartas
const ADMIN_SECRET = process.env.ADMIN_SECRET || "imagemediaclub2026admin";

// Versión actual del software (actualizá al lanzar nueva versión)
const CURRENT_VERSION = {
  version: "1.0.0",
  buildDate: "2026-06-14",
  changelog: "Primera versión comercial con AutoDJ, TV visual, Locutor IA, Multistream, Portal y Podcasts.",
  downloadUrl: "https://imagemediaclub.com/download/ciudad-radio-1.0.0.exe"
};
// ─────────────────────────────────────────────────────────────────────────────

// Helpers
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
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
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveLicenses(data) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.appendFile(LOG_FILE, line, "utf8");
  } catch {}
}

function generateCode() {
  const part = () => crypto.randomBytes(4).toString("hex").toUpperCase();
  return `CR-${part()}-${part().slice(0,4)}-${part().slice(0,4)}`;
}

function isExpired(license) {
  if (!license.expiresAt) return false;
  return new Date(license.expiresAt) < new Date();
}

function checkAdmin(req) {
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${ADMIN_SECRET}`;
}

// ── SERVIDOR ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
    return res.end();
  }

  // Health check
  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, service: "Ciudad Radio License Server", version: CURRENT_VERSION.version });
  }

  // Version / update check
  if (url.pathname === "/api/version") {
    return json(res, 200, CURRENT_VERSION);
  }

  // ── GENERAR LICENCIA (solo admin) ─────────────────────────────────────────
  if (url.pathname === "/api/license/generate" && req.method === "POST") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const body = await readBody(req);
    const code = generateCode();
    const licenses = await loadLicenses();

    const daysValid = Number(body.days || 365);
    const expiresAt = body.noExpiry ? null : new Date(Date.now() + daysValid * 86400000).toISOString();

    licenses[code] = {
      code,
      client: body.client || "Sin nombre",
      email: body.email || "",
      plan: body.plan || "Profesional",
      createdAt: new Date().toISOString(),
      expiresAt,
      status: "pendiente",        // pendiente → activa (al activar)
      installId: null,
      activatedAt: null,
      version: null,
      notes: body.notes || ""
    };

    await saveLicenses(licenses);
    await log(`Licencia generada: ${code} → ${body.client || "Sin nombre"}`);
    return json(res, 200, { ok: true, code, license: licenses[code] });
  }

  // ── ACTIVAR LICENCIA ──────────────────────────────────────────────────────
  if (url.pathname === "/api/license/activate" && req.method === "POST") {
    const body = await readBody(req);
    const { code, installId, version, stationName } = body;

    if (!code || !installId) return json(res, 400, { ok: false, error: "Faltan code e installId" });

    const licenses = await loadLicenses();
    const license = licenses[code.toUpperCase()];

    if (!license) return json(res, 404, { ok: false, error: "Código inválido" });
    if (isExpired(license)) return json(res, 403, { ok: false, error: "Licencia vencida" });

    // Si ya está activada en otra instalación
    if (license.installId && license.installId !== installId) {
      await log(`ALERTA: intento de activar ${code} en segunda instalación ${installId} (original: ${license.installId})`);
      return json(res, 409, { ok: false, error: "Código ya activado en otra instalación. Contactá soporte." });
    }

    license.status = "activa";
    license.installId = installId;
    license.activatedAt = license.activatedAt || new Date().toISOString();
    license.version = version || license.version;
    license.stationName = stationName || license.stationName;
    license.lastSeen = new Date().toISOString();

    await saveLicenses(licenses);
    await log(`Licencia activada: ${code} → ${license.client} / ${stationName || ''} / ID ${installId}`);

    return json(res, 200, {
      ok: true,
      status: "activa",
      client: license.client,
      plan: license.plan,
      expiresAt: license.expiresAt,
      code
    });
  }

  // ── VALIDAR LICENCIA (llamado periódico desde el software) ─────────────────
  if (url.pathname === "/api/license/validate" && req.method === "POST") {
    const body = await readBody(req);
    const { code, installId, version } = body;

    if (!code || !installId) return json(res, 400, { ok: false, error: "Faltan parámetros" });

    const licenses = await loadLicenses();
    const license = licenses[code.toUpperCase()];

    if (!license) return json(res, 200, { ok: false, valid: false, reason: "not_found" });
    if (license.status === "revocada") return json(res, 200, { ok: false, valid: false, reason: "revoked" });
    if (isExpired(license)) return json(res, 200, { ok: false, valid: false, reason: "expired", expiresAt: license.expiresAt });
    if (license.installId && license.installId !== installId) return json(res, 200, { ok: false, valid: false, reason: "wrong_install" });

    // Update last seen
    license.lastSeen = new Date().toISOString();
    if (version) license.version = version;
    await saveLicenses(licenses);

    return json(res, 200, {
      ok: true,
      valid: true,
      status: license.status,
      client: license.client,
      plan: license.plan,
      expiresAt: license.expiresAt,
      daysLeft: license.expiresAt
        ? Math.max(0, Math.ceil((new Date(license.expiresAt) - new Date()) / 86400000))
        : null,
      updateAvailable: CURRENT_VERSION.version !== version,
      latestVersion: CURRENT_VERSION.version,
      changelog: CURRENT_VERSION.version !== version ? CURRENT_VERSION.changelog : null,
      downloadUrl: CURRENT_VERSION.version !== version ? CURRENT_VERSION.downloadUrl : null
    });
  }

  // ── REVOCAR LICENCIA (solo admin) ─────────────────────────────────────────
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
    await log(`Licencia revocada: ${body.code} → ${license.client}`);
    return json(res, 200, { ok: true });
  }

  // ── LISTAR LICENCIAS (solo admin) ─────────────────────────────────────────
  if (url.pathname === "/api/licenses" && req.method === "GET") {
    if (!checkAdmin(req)) return json(res, 401, { ok: false, error: "No autorizado" });
    const licenses = await loadLicenses();
    const list = Object.values(licenses).map(lic => ({
      ...lic,
      expired: isExpired(lic),
      daysLeft: lic.expiresAt
        ? Math.max(0, Math.ceil((new Date(lic.expiresAt) - new Date()) / 86400000))
        : null
    }));
    return json(res, 200, { ok: true, total: list.length, licenses: list });
  }

  return json(res, 404, { ok: false, error: "Ruta no encontrada" });
});

server.listen(PORT, () => {
  console.log(`\n🔑 Ciudad Radio License Server`);
  console.log(`   Puerto: ${PORT}`);
  console.log(`   Datos:  ${DATA_FILE}`);
  console.log(`   Admin:  Authorization: Bearer ${ADMIN_SECRET}\n`);
});
