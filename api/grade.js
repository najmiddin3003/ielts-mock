// ==================================================================
// IELTS BAHOLASH PROXY — Vercel serverless funksiya (POST /api/grade)
//
// OpenAI kaliti FAQAT shu yerda, muhit o'zgaruvchisi orqali o'qiladi —
// HTML/JS ichida hech qachon bo'lmaydi. Brauzer bu manzilga faqat essay /
// transkript matnini yuboradi; prompt, model, token limiti — hammasi serverda.
//
// Muhit o'zgaruvchilari (Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY            (majburiy)  sk-... kalit
//   OPENAI_MODEL              (ixtiyoriy) default: gpt-4o
//   ALLOWED_ORIGINS           (ixtiyoriy) vergul bilan: https://ielts.uz,https://www.ielts.uz
//                                         bo'sh bo'lsa — faqat saytning o'z domeni qabul qilinadi
//   RATE_LIMIT_PER_HOUR       (ixtiyoriy) default: 20 — bir IP uchun soatiga baholashlar soni
//   UPSTASH_REDIS_REST_URL    (ixtiyoriy) doimiy rate-limit uchun (bepul Upstash Redis);
//   UPSTASH_REDIS_REST_TOKEN  (ixtiyoriy) berilmasa — funksiya xotirasidagi (instance bo'yicha) hisoblagich ishlaydi
// ==================================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";
const MAX_CHARS = 12000;                              // bitta so'rovdagi jami matn (~2000 so'z)
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKENS = { writing: 1000, speaking: 800 };  // avvalgi brauzer kodidagi qiymatlar
const TIMEOUT_MS = 25000;                             // vercel.json dagi maxDuration (30s) dan kichik
const RETRIABLE = [429, 500, 502, 503, 504];

// ---------------- PROMPTLAR (brauzerdan ko'chirildi — so'zma-so'z) ----------------
const PROMPTS = {
  writing: ({ task1, task2 }) => `You are an official IELTS Writing examiner. Grade the following two responses using the real IELTS Writing band descriptors (Task Achievement/Response, Coherence and Cohesion, Lexical Resource, Grammatical Range and Accuracy), each scored 1-9 in 0.5 increments.

TASK 1 (Academic, describe data, min 150 words):
"""${task1}"""

TASK 2 (Essay, min 250 words):
"""${task2}"""

Return ONLY valid JSON, no markdown, no preamble, in exactly this shape:
{"task1_band": number, "task2_band": number, "overall_writing_band": number, "task1_feedback": "short feedback in Uzbek, 2-3 sentences", "task2_feedback": "short feedback in Uzbek, 2-3 sentences", "strengths": "1 sentence in Uzbek", "improve": "1 sentence in Uzbek"}
overall_writing_band should be calculated as task1_band weighted 1/3 and task2_band weighted 2/3, rounded to the nearest 0.5.`,

  speaking: ({ part1, part2, part3 }) => `You are an official IELTS Speaking examiner. Grade this candidate's speaking transcript using the real IELTS Speaking band descriptors (Fluency and Coherence, Lexical Resource, Grammatical Range and Accuracy, Pronunciation — pronunciation should be estimated leniently since this is a text transcript), each 1-9 in 0.5 increments.

PART 1 (personal questions):
${part1}

PART 2 (cue card monologue):
${part2}

PART 3 (discussion):
${part3}

Return ONLY valid JSON, no markdown, no preamble, in exactly this shape:
{"overall_speaking_band": number, "fluency_feedback": "short feedback in Uzbek", "lexical_feedback": "short feedback in Uzbek", "grammar_feedback": "short feedback in Uzbek", "improve": "1-2 sentences in Uzbek on how to improve"}`
};

// Har bir tur uchun: qaysi maydonlar kelishi shart, va modeldan qaysi maydonlar qaytariladi.
// Modeldan kelgan JSON'dan faqat shu maydonlar brauzerga uzatiladi (ortiqcha narsa o'tmaydi).
const SCHEMA = {
  writing: {
    required: ["task1", "task2"],
    optional: [],
    numbers: ["task1_band", "task2_band", "overall_writing_band"],
    strings: ["task1_feedback", "task2_feedback", "strengths", "improve"]
  },
  speaking: {
    required: ["part2"],                       // Part 1/3 bo'sh bo'lishi mumkin (brauzer ham shunday tekshiradi)
    optional: ["part1", "part3"],
    numbers: ["overall_speaking_band"],
    strings: ["fluency_feedback", "lexical_feedback", "grammar_feedback", "improve"]
  }
};

export default async function handler(req, res) {
  // Vercel'da sayt va API bir domenda — CORS shart emas. ALLOWED_ORIGINS'da boshqa
  // domen ko'rsatilgan bo'lsa (masalan, alohida frontend), preflight'ga javob beramiz.
  const origin = req.headers.origin || "";
  const allowed = originAllowed(req, origin);
  if (req.method === "OPTIONS") {
    if (allowed) setCors(res, origin);
    res.statusCode = allowed ? 204 : 403;
    return res.end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return send(res, 405, { error: "Faqat POST so'rov qabul qilinadi." });
  }
  if (!allowed) {
    return send(res, 403, { error: "So'rov manbai ruxsat etilmagan (Origin)." });
  }
  setCors(res, origin);

  // --- kirish ma'lumotlari ---
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? "So'rov hajmi juda katta." : "So'rov tanasi JSON bo'lishi kerak." });
  }
  const type = body && body.type;
  const schema = SCHEMA[type];
  if (!schema) {
    return send(res, 400, { error: "Noto'g'ri baholash turi. 'writing' yoki 'speaking' bo'lishi kerak." });
  }

  const fields = {};
  let total = 0;
  for (const f of schema.required.concat(schema.optional)) {
    const v = body[f];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return send(res, 400, { error: "'" + f + "' maydoni matn bo'lishi kerak." });
    }
    fields[f] = (v || "").trim();
    total += fields[f].length;
    if (schema.required.includes(f) && !fields[f]) {
      return send(res, 400, { error: "'" + f + "' maydoni bo'sh bo'lmasligi kerak." });
    }
  }
  if (total > MAX_CHARS) {
    return send(res, 413, { error: "Matn juda uzun (" + total + " belgi). Maksimum " + MAX_CHARS + " belgi." });
  }

  // --- rate limit (bir IP uchun soatiga N ta baholash) ---
  const ip = clientIp(req);
  const rl = await rateLimit(ip);
  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return send(res, 429, {
      error: "Soatlik limitga yetdingiz (" + rl.limit + " ta baholash). Taxminan " + Math.ceil(rl.retryAfter / 60) + " daqiqadan keyin qayta urinib ko'ring."
    });
  }

  // --- OpenAI ---
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY muhit o'zgaruvchisi o'rnatilmagan");
    return send(res, 500, { error: "Server sozlanmagan: OPENAI_API_KEY o'rnatilmagan." });
  }

  try {
    const result = await gradeWithOpenAI(apiKey, type, fields);
    return send(res, 200, result);
  } catch (e) {
    console.error("grade " + type + " failed:", e.status || "", e.message);
    return send(res, e.status || 502, { error: e.publicMessage || "Baholashda xatolik yuz berdi. Qaytadan urinib ko'ring." });
  }
}

// ---------------- OpenAI chaqiruvi ----------------
async function gradeWithOpenAI(apiKey, type, fields) {
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const payload = {
    model,
    max_tokens: MAX_TOKENS[type],
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: PROMPTS[type](fields) }]
  };

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {       // vaqtinchalik xatoda bir marta qayta urinamiz
    try {
      return await openaiOnce(apiKey, type, payload);
    } catch (e) {
      lastErr = e;
      if (!e.retriable || attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function openaiOnce(apiKey, type, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
  } catch (netErr) {
    throw fail(504, "AI xizmati javob bermadi. Qaytadan urinib ko'ring.", netErr.message, true);
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    const detail = (data && data.error && data.error.message) || (resp.status + " " + resp.statusText);
    // Brauzerga OpenAI'ning ichki xabari chiqmaydi — faqat umumiy, o'zbekcha xabar. To'liq matn Vercel loglarida.
    if (resp.status === 401) throw fail(500, "Server sozlanmagan: OpenAI kaliti noto'g'ri.", detail);
    if (resp.status === 429) throw fail(503, "AI xizmati band yoki kredit tugagan. Birozdan keyin urinib ko'ring.", detail, true);
    if (resp.status === 400 || resp.status === 404) throw fail(500, "Server sozlanmagan: model yoki so'rov parametrlari noto'g'ri.", detail);
    throw fail(502, "AI xizmatida vaqtinchalik xatolik. Qaytadan urinib ko'ring.", detail, RETRIABLE.includes(resp.status));
  }

  const choice = data && data.choices && data.choices[0];
  const raw = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
  if (!raw.trim()) throw fail(502, "AI bo'sh javob qaytardi. Qaytadan urinib ko'ring.", "empty content, finish_reason=" + (choice && choice.finish_reason), true);

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    throw fail(502, "AI javobi noto'g'ri formatda keldi. Qaytadan urinib ko'ring.", "non-JSON: " + raw.slice(0, 200), true);
  }

  // faqat kutilgan maydonlar, to'g'ri turda; ball 0–9 oralig'ida bo'lishi shart
  const schema = SCHEMA[type];
  const out = {};
  for (const k of schema.numbers) {
    const n = Number(parsed[k]);
    if (!Number.isFinite(n) || n < 0 || n > 9) throw fail(502, "AI javobida ball noto'g'ri keldi. Qaytadan urinib ko'ring.", k + "=" + parsed[k], true);
    out[k] = Math.round(n * 2) / 2;
  }
  for (const k of schema.strings) {
    const v = parsed[k] === undefined || parsed[k] === null ? "" : String(parsed[k]);
    out[k] = v.replace(/[<>]/g, "").slice(0, 1500);   // innerHTML'ga boradi — teglarni olib tashlaymiz
  }
  return out;
}

// ---------------- Origin / CORS ----------------
// Faqat o'z saytimizdan (yoki ALLOWED_ORIGINS'dagi domenlardan) kelgan brauzer so'rovlari.
// Bu "devor" emas (Origin'ni qo'lda soxtalash mumkin) — lekin boshqa saytlar va oddiy
// skriptlar uchun to'siq; asosiy himoya — rate limit va OpenAI'dagi budjet limiti.
function originAllowed(req, origin) {
  if (!origin) return false;
  const env = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const self = [];
  if (host) {
    self.push("https://" + host);
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) self.push("http://" + host);   // faqat lokal ishlab chiqish
  }
  return env.concat(self).includes(origin);
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

// ---------------- Rate limit ----------------
// Upstash Redis sozlangan bo'lsa — barcha instansiyalar uchun umumiy, doimiy hisoblagich.
// Aks holda — shu instansiya xotirasida (Vercel funksiya "uyg'oq" turganda ishlaydi; bepul va
// sozlashsiz, lekin kafolatli emas — jiddiy trafik kutilsa Upstash'ni ulang).
const WINDOW_SEC = 3600;

async function rateLimit(ip) {
  const limit = Math.max(1, Number(process.env.RATE_LIMIT_PER_HOUR) || 20);
  const key = "ielts:rl:" + ip;

  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify([["SET", key, "0", "EX", WINDOW_SEC, "NX"], ["INCR", key], ["TTL", key]])
      });
      const data = await r.json();
      const count = data && data[1] && data[1].result;
      const ttl = (data && data[2] && data[2].result) || WINDOW_SEC;
      if (typeof count === "number") {
        return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfter: ttl > 0 ? ttl : WINDOW_SEC };
      }
    } catch (e) {
      console.warn("Upstash rate limit ishlamadi, xotiradagi hisoblagichga o'tildi:", e.message);
    }
  }

  const store = globalThis.__ieltsRateLimit || (globalThis.__ieltsRateLimit = new Map());
  const now = Date.now();
  let entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_SEC * 1000 };
    store.set(key, entry);
  }
  entry.count++;
  if (store.size > 5000) for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
  return { ok: entry.count <= limit, limit, remaining: Math.max(0, limit - entry.count), retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
}

// ---------------- yordamchilar ----------------
function clientIp(req) {
  // Vercel bu sarlavhalarni o'zi qo'yadi (mijoz yuborganini almashtiradi)
  const xff = req.headers["x-forwarded-for"];
  return req.headers["x-real-ip"] || (xff ? String(xff).split(",")[0].trim() : "") || (req.socket && req.socket.remoteAddress) || "unknown";
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {          // Vercel JSON tanani o'zi ajratib beradi
    if (typeof req.body === "object") return req.body;
    try { return JSON.parse(String(req.body)); } catch (e) { throw Object.assign(new Error("bad json"), { status: 400 }); }
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function fail(status, publicMessage, detail, retriable) {
  const e = new Error(detail || publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  e.retriable = !!retriable;
  return e;
}
