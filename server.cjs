const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const ECOLE_DIRECTE_BASE = "https://api.ecoledirecte.com/v3";
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
function cleanChatHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).map(item => ({
    role: item && item.role === "assistant" ? "Fred" : "Élève",
    content: String((item && item.content) || "").replace(/\s+/g, " ").trim().slice(0, 2_000)
  })).filter(item => item.content);
}
async function askFred(message, history) {
  if (!OPENAI_API_KEY) throw new Error("missing-openai-key");
  const transcript = cleanChatHistory(history).map(item => `${item.role} : ${item.content}`).join("\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        store: false,
        max_output_tokens: 650,
        instructions: "Tu es Fred, assistant scolaire français, calme et encourageant. Aide l'élève à comprendre et s'organiser. Ne fais jamais un devoir ou exercice noté à sa place : explique la méthode, donne des indices progressifs et un exemple différent si utile. Ne demande jamais de mot de passe, identifiant, code de connexion ou autre secret. Réponds en français simple et court.",
        input: [{ role: "user", content: [{ type: "input_text", text: `${transcript ? `Historique récent :\n${transcript}\n\n` : ""}Nouvelle question de l'élève :\n${message}`.slice(0, 45_000) }] }]
      })
    });
    if (!response.ok) throw new Error(`openai-failed-${response.status}`);
    const reply = textFromResponse(await response.json()).trim();
    if (!reply) throw new Error("openai-empty-response");
    return reply;
  } finally {
    clearTimeout(timeout);
  }
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isRetryableEcoleDirecteError(error) {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|timeout|temporarily/i.test(String(error && (error.code || error.message || error)));
}
async function ecoleDirectePost(path, payload, token) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const data = { ...payload, ...(token ? { token } : {}) };
      const response = await fetch(ECOLE_DIRECTE_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "fred-school-planner/1.0" },
        body: "data=" + encodeURIComponent(JSON.stringify(data)),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`ecole-directe-http-${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isRetryableEcoleDirecteError(error)) break;
      await wait(450 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  const error = new Error("ecole-directe-unavailable");
  error.cause = lastError;
  throw error;
}
function studentFromEcoleDirecteData(entry) {
  return {
    id: entry.id,
    prenom: entry.prenom || "",
    nom: entry.nom || "",
    classe: entry.profile && entry.profile.classe ? entry.profile.classe.libelle : (entry.classe && entry.classe.libelle) || ""
  };
}
async function fetchEcoleDirecteCahier(username, password, studentIndex) {
  const login = await ecoleDirectePost("/login.awp", { identifiant: username, motdepasse: password });
  if (!login || !login.token || !login.data || !Array.isArray(login.data.accounts)) throw new Error("invalid-credentials");
  const account = login.data.accounts[0];
  const rawStudents = (account.typeCompte === "1" || account.typeCompte === "2")
    ? (((account.profile || {}).eleves) || [])
    : [account];
  const students = rawStudents.map(studentFromEcoleDirecteData).filter(student => student.id);
  const student = students[studentIndex];
  if (!student) {
    const error = new Error("choose-student");
    error.students = students.map((entry, index) => ({ index, name: [entry.prenom, entry.nom].filter(Boolean).join(" ") || `Élève ${index + 1}`, className: entry.classe || "" }));
    throw error;
  }
  let token = login.token;
  if (account.typeCompte === "1" || account.typeCompte === "2") {
    const contact = await ecoleDirectePost("/contactetablissement.awp?verbe=get&", {}, token).catch(() => null);
    if (contact && contact.token) token = contact.token;
  }
  const calendarResponse = await ecoleDirectePost(`/Eleves/${student.id}/cahierdetexte.awp?verbe=get&`, {}, token);
  const days = Object.keys((calendarResponse && calendarResponse.data) || {}).filter(isISODate)
    .filter(day => day >= new Date(Date.now() - 86400000).toISOString().slice(0, 10)).sort().slice(0, 45);
  const blocks = [];
  for (const day of days) {
    const dayResponse = await ecoleDirectePost(`/Eleves/${student.id}/cahierdetexte/${day}.awp?verbe=get&`, {}, token);
    const content = flatten((dayResponse && dayResponse.data && dayResponse.data.matieres) || {});
    if (content) blocks.push(`Échéance : ${day}\n${content}`);
  }
  const start = new Date();
  const end = new Date(Date.now() + 6 * 86400000);
  const timetableResponse = await ecoleDirectePost(`/E/${student.id}/emploidutemps.awp?verbe=get&`, { dateDebut: start.toISOString().slice(0, 10), dateFin: end.toISOString().slice(0, 10) }, token).catch(() => ({ data: [] }));
  const timetable = timetableResponse.data || [];
  return { name: [student.prenom, student.nom].filter(Boolean).join(" "), className: student.classe || "", text: blocks.join("\n\n"), schedule: normalizeSchedule(timetable) };
}


const TIMETABLE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["courses", "assessments"],
  properties: {
    courses: { type: "array", maxItems: 80, items: { type: "object", additionalProperties: false, required: ["day", "subject", "start", "end", "rule", "room"], properties: {
      day: { type: "integer", minimum: 1, maximum: 7 },
      subject: { type: "string", minLength: 1, maxLength: 80 },
      start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
      end: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
      rule: { type: "string", enum: ["every", "a", "b"] },
      room: { type: "string", maxLength: 80 }
    } } },
    assessments: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["subject", "dateText", "details"], properties: {
      subject: { type: "string", minLength: 1, maxLength: 80 },
      dateText: { type: "string", minLength: 1, maxLength: 80 },
      details: { type: "string", maxLength: 180 }
    } } }
  }
};
function validTimetableImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 12) return false;
  let total = 0;
  return images.every(image => {
    if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/i.test(image)) return false;
    total += image.length;
    return image.length <= 1_500_000 && total <= 9_500_000;
  });
}
async function analyseTimetable(images, kind) {
  if (!OPENAI_API_KEY) throw new Error("missing-openai-key");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const prompt = kind === "assessments"
      ? "Lis uniquement le planning de devoirs surveillés ou contrôles. Retourne chaque DS dans assessments, avec matière, date affichée telle qu'elle est écrite et détail éventuel. Ne remplis pas courses. N'invente jamais une date ou matière absente."
      : "Lis uniquement les grilles d'emploi du temps. Retourne chaque cours dans courses. day : lundi=1 à dimanche=7. start/end au format HH:mm. rule vaut every, a ou b. Utilise a ou b seulement si l'image l'indique clairement ; sinon every. Ne devine jamais un cours, une salle ou une alternance. Ne remplis pas assessments.";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL, store: false, max_output_tokens: 2200,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images.map(image_url => ({ type: "input_image", image_url, detail: "high" }))] }],
        text: { format: { type: "json_schema", name: "fred_timetable", strict: true, schema: TIMETABLE_SCHEMA }, verbosity: "low" }
      })
    });
    if (!response.ok) throw new Error(`openai-failed-${response.status}`);
    const parsed = JSON.parse(textFromResponse(await response.json()));
    return { courses: Array.isArray(parsed.courses) ? parsed.courses : [], assessments: Array.isArray(parsed.assessments) ? parsed.assessments : [] };
  } finally { clearTimeout(timeout); }
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
    if (request.url === "/timetable/analyze") {
      if (!validTimetableImages(payload.images)) { send(response, 400, { error: "Choisis entre une et douze images de taille raisonnable." }); return; }
      const analysis = await analyseTimetable(payload.images, payload.kind === "assessments" ? "assessments" : "timetable");
      send(response, 200, analysis);
      return;
    }
    if (request.url === "/chat") {
      const message = String(payload.message || "").trim();
      if (!message) { send(response, 400, { error: "Écris une question pour Fred." }); return; }
      if (message.length > 8_000) { send(response, 413, { error: "Le message est trop long." }); return; }
      send(response, 200, { reply: await askFred(message, payload.history) });
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
    if (error === "Invalid credentials" || error.message === "Invalid credentials" || error.message === "invalid-credentials") { send(response, 401, { error: "Identifiant ou mot de passe École Directe incorrect." }); return; }
    if (error.message === "ecole-directe-unavailable") { send(response, 503, { error: "École Directe ne répond pas pour le moment. Réessaie dans une minute." }); return; }
    if (error.message === "Unexpected end of JSON input") { send(response, 422, { error: "Photo illisible. Essaie avec une photo nette." }); return; }
    if (error.message === "missing-openai-key") { send(response, 503, { error: "La clé du service IA manque sur le serveur." }); return; }
    console.error("fred backend error", error.message);
    send(response, 502, { error: "La synchronisation est indisponible. Réessaie dans un instant." });
  }
});
server.listen(PORT, () => console.log(`fred backend listening on ${PORT}`));
