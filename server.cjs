const http = require("node:http");
const EcoleDirecte = require("node-ecole-directe");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;
const attempts = new Map();

const TASK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", maxItems: 40, items: {
    type: "object", additionalProperties: false,
    required: ["subject", "kind", "type", "date", "importance"],
    properties: {
      subject: { type: "string", minLength: 1, maxLength: 80 },
      kind: { type: "string", enum: ["devoir", "evaluation"] },
      type: { type: "string", enum: ["Devoir Maison", "Exercices", "Leçon à apprendre", "Rédaction", "Devoir Surveillé", "Contrôle", "Interro", "Oral", "Autre"] },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      importance: { type: "integer", minimum: 1, maximum: 3 }
    }
  } } }
};

function headers(extra = {}) {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra };
}
function send(res, status, body) {
  res.writeHead(status, headers({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(body));
}
function rateLimited(request) {
  const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now(), record = attempts.get(ip) || { started: now, count: 0 };
  if (now - record.started > RATE_WINDOW_MS) { record.started = now; record.count = 0; }
  record.count += 1; attempts.set(ip, record);
  return record.count > RATE_MAX;
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; if (raw.length > 15_000_000) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("invalid-json")); } });
    request.on("error", reject);
  });
}
function htmlToText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function flatten(value, depth = 0) {
  if (value === null || value === undefined || depth > 5) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return htmlToText(value);
  if (Array.isArray(value)) return value.map(item => flatten(item, depth + 1)).filter(Boolean).join(" | ");
  return Object.entries(value).map(([key, item]) => `${key}: ${flatten(item, depth + 1)}`).filter(line => !/:\s*$/.test(line)).join("; ");
}
function isISODate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || ""); }
function extractTime(value) {
  const match = String(value || "").match(/(?:T|\s)(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}
function extractDate(value) {
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
function normalizeSchedule(raw) {
  const events = Array.isArray(raw) ? raw : Object.values(raw || {}).flat();
  return events.map(event => {
    const startValue = event.start_date || event.dateDebut || event.date || event.debut;
    const endValue = event.end_date || event.dateFin || event.fin;
    const date = extractDate(startValue);
    const start = extractTime(startValue) || String(event.heureDebut || "").slice(0, 5);
    const end = extractTime(endValue) || String(event.heureFin || "").slice(0, 5);
    const subject = htmlToText(event.matiere || event.text || event.libelle || event.nom || "");
    if (!date || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || !subject) return null;
    const jsDay = new Date(`${date}T12:00:00`).getDay();
    return { day: (jsDay + 6) % 7, subject: subject.slice(0, 80), start, end };
  }).filter(Boolean);
}
function textFromResponse(response) {
  for (const item of response.output || []) for (const content of item.content || []) if (content.type === "output_text") return content.text || "";
  return "";
}
async function extractTasks(sourceText, today, fileData) {
  if (!OPENAI_API_KEY) throw new Error("missing-openai-key");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL, store: false,
      instructions: `Tu extrais les devoirs et évaluations d'un cahier de texte français. Date de référence : ${today}. Les blocs indiquent explicitement leur échéance. Ignore les cours, messages, signatures et toute donnée personnelle inutile. Évaluation = contrôle, interro, oral ou devoir surveillé. Ne crée aucun élément si matière ou échéance est incertaine.`,
      input: [{ role: "user", content: [
        { type: "input_text", text: (sourceText || "Lis ce PDF et extrais les devoirs et évaluations.").slice(0, 50_000) },
        ...(typeof fileData === "string" && /^data:application\/pdf;base64,/i.test(fileData) && fileData.length <= 14_000_000
          ? [{ type: "input_file", filename: "cahier-de-texte.pdf", file_data: fileData }] : [])
      ] }],
      text: { format: { type: "json_schema", name: "fred_tasks", strict: true, schema: TASK_SCHEMA }, verbosity: "low" }
    })
  });
  if (!response.ok) throw new Error("openai-failed");
  return JSON.parse(textFromResponse(await response.json())).items || [];
}
async function fetchEcoleDirecteCahier(username, password, studentIndex) {
  const session = new EcoleDirecte.Session();
  const account = await session.connexion(username, password);
  const students = account.eleves || [account];
  const student = students[studentIndex];
  if (!student) {
    const error = new Error("choose-student");
    error.students = students.map((entry, index) => ({ index, name: [entry.prenom, entry.nom].filter(Boolean).join(" ") || `Élève ${index + 1}`, className: entry.classe || "" }));
    throw error;
  }
  const calendar = await student.fetchCahierDeTexte();
  const days = calendar.map(entry => entry.day).filter(isISODate).filter(day => day >= new Date(Date.now() - 86400000).toISOString().slice(0, 10)).sort().slice(0, 45);
  const blocks = [];
  for (const day of days) {
    const entries = await student.fetchCahierDeTexteJour(day);
    const content = flatten(entries);
    if (content) blocks.push(`Échéance : ${day}\n${content}`);
  }
  const start = new Date();
  const end = new Date(Date.now() + 6 * 86400000);
  const timetable = await student.fetchEmploiDuTemps(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)).catch(() => []);
  return { name: [student.prenom, student.nom].filter(Boolean).join(" "), className: student.classe || "", text: blocks.join("\n\n"), schedule: normalizeSchedule(timetable) };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, headers()); response.end(); return; }
  if (request.method !== "POST") { send(response, 404, { error: "Route introuvable." }); return; }
  if (rateLimited(request)) { send(response, 429, { error: "Trop de tentatives. Réessaie dans quelques minutes." }); return; }
  try {
    const payload = await readBody(request);
    if (request.url === "/analyze") {
      const text = String(payload.text || "").trim(), fileData = payload.fileData;
      if (!text && !fileData) { send(response, 400, { error: "Aucun texte ou PDF reçu." }); return; }
      send(response, 200, { items: await extractTasks(text, payload.today || new Date().toISOString().slice(0, 10), fileData) });
      return;
    }
    if (request.url === "/ecole-directe/sync") {
      const username = String(payload.username || "").trim(), password = String(payload.password || "");
      if (!username || !password) { send(response, 400, { error: "Identifiant et mot de passe requis." }); return; }
      const cahier = await fetchEcoleDirecteCahier(username, password, Number.isInteger(payload.studentIndex) ? payload.studentIndex : 0);
      const items = await extractTasks(cahier.text, new Date().toISOString().slice(0, 10));
      send(response, 200, { items, schedule: cahier.schedule, account: { name: cahier.name, className: cahier.className } });
      return;
    }
    send(response, 404, { error: "Route introuvable." });
  } catch (error) {
    if (error.message === "choose-student") { send(response, 409, { error: "Choisis un élève.", students: error.students }); return; }
    if (error === "Invalid credentials" || error.message === "Invalid credentials") { send(response, 401, { error: "Identifiant ou mot de passe École Directe incorrect." }); return; }
    console.error("fred backend error", error.message);
    send(response, 502, { error: "La synchronisation est indisponible. Réessaie dans un instant." });
  }
});
server.listen(PORT, () => console.log(`fred backend listening on ${PORT}`));
