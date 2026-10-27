const MAX_TEXT_LENGTH = 50000;
const GOOGLE_CHUNK_CHARS = 1900;
const MYMEMORY_MAX_CHARS = 4500;
const MYMEMORY_CHUNK_BYTES = 420;
const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL = "https://api.mymemory.translated.net/get";
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 25;

// Best-effort per-instance guard. Serverless instances do not share this counter.
const rateBuckets = globalThis.__lingoRateBuckets || (globalThis.__lingoRateBuckets = new Map());
function isRateLimited(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const existing = rateBuckets.get(ip);
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT;
}

function send(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(payload));
}

function decodeEntities(input) {
  return String(input).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const key = code.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    try {
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    } catch {}
    return entity;
  });
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Keep source whitespace (spaces and line breaks) outside translated pieces.
function splitText(text, maxChars = GOOGLE_CHUNK_CHARS) {
  const chars = Array.from(text);
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let preferredEnd = -1;
    let preferredNext = -1;
    const hardEnd = Math.min(chars.length, start + maxChars);
    while (end < hardEnd) {
      end++;
      const ch = chars[end - 1];
      if (/[.!?;:…]/.test(ch)) {
        preferredEnd = end;
        preferredNext = end;
        while (preferredNext < chars.length && /\s/.test(chars[preferredNext])) preferredNext++;
      } else if (/\s/.test(ch)) {
        preferredEnd = end - 1;
        preferredNext = end;
        while (preferredNext < chars.length && /\s/.test(chars[preferredNext])) preferredNext++;
      }
    }
    if (end >= chars.length) {
      const tail = chars.slice(start).join("");
      if (tail) chunks.push({ text: tail, separator: "" });
      break;
    }
    const cutEnd = preferredEnd > start + Math.floor((end - start) * 0.55) ? preferredEnd : end;
    let nextStart = cutEnd;
    let separator = "";
    if (cutEnd === preferredEnd && preferredNext >= cutEnd) {
      separator = chars.slice(cutEnd, preferredNext).join("");
      nextStart = preferredNext;
    }
    const safeCutEnd = cutEnd > start ? cutEnd : end;
    if (nextStart <= start) nextStart = end;
    const part = chars.slice(start, safeCutEnd).join("");
    if (part) chunks.push({ text: part, separator });
    start = nextStart;
  }
  return chunks;
}

async function translateWithGoogle(text, sourceLang, targetLang) {
  const chunks = splitText(text);
  const output = [];
  for (let i = 0; i < chunks.length; i++) {
    const query = new URLSearchParams({
      client: "gtx",
      sl: sourceLang,
      tl: targetLang,
      dt: "t",
      dj: "1",
      q: chunks[i].text
    });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${GOOGLE_URL}?${query.toString()}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Google Translate временно ответил кодом ${response.status}.`);
        }
        if (!response.ok) throw new Error(`Сервис перевода ответил кодом ${response.status}.`);
        const data = await response.json();
        const translated = Array.isArray(data.sentences)
          ? data.sentences.map(sentence => sentence.trans || "").join("")
          : "";
        if (!translated.trim()) throw new Error("Сервис не вернул текст перевода.");
        output.push(decodeEntities(translated), chunks[i].separator);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(300 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError) throw lastError;
    if (i < chunks.length - 1) await wait(100);
  }
  return output.join("");
}

function splitUtf8(text, maxBytes = MYMEMORY_CHUNK_BYTES) {
  const chars = Array.from(text);
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    let bestEnd = -1;
    let bestNext = -1;
    while (end < chars.length) {
      const size = Buffer.byteLength(chars[end], "utf8");
      if (bytes + size > maxBytes) break;
      bytes += size;
      end++;
      if (/[.!?;:…\s]/.test(chars[end - 1])) {
        bestEnd = /\s/.test(chars[end - 1]) ? end - 1 : end;
        bestNext = end;
        while (bestNext < chars.length && /\s/.test(chars[bestNext])) bestNext++;
      }
    }
    if (end >= chars.length) {
      chunks.push({ text: chars.slice(start).join(""), separator: "" });
      break;
    }
    const cut = bestEnd > start + 1 ? bestEnd : end;
    const next = bestNext > cut ? bestNext : cut;
    const separator = chars.slice(cut, next).join("");
    const part = chars.slice(start, cut).join("");
    if (part) chunks.push({ text: part, separator });
    start = next > start ? next : end;
  }
  return chunks;
}

async function translateWithMyMemory(text, sourceLang, targetLang) {
  if (text.length > MYMEMORY_MAX_CHARS) {
    throw new Error("Основной сервис перевода временно недоступен для такого длинного текста. Попробуйте ещё раз чуть позже.");
  }
  const chunks = splitUtf8(text);
  const output = [];
  for (let i = 0; i < chunks.length; i++) {
    const params = new URLSearchParams({ q: chunks[i].text, langpair: `${sourceLang}|${targetLang}` });
    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${MYMEMORY_URL}?${params.toString()}`, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.responseStatus === 200 && data.responseData?.translatedText) {
        output.push(decodeEntities(data.responseData.translatedText), chunks[i].separator);
        success = true;
        break;
      }
      if (attempt === 0 && (response.status === 429 || response.status >= 500 || data.responseStatus === 429 || data.responseStatus >= 500)) {
        await wait(400);
        continue;
      }
      throw new Error(String(data.responseDetails || "Резервный сервис перевода тоже недоступен."));
    }
    if (!success) throw new Error("Не удалось перевести текст резервным сервисом.");
    if (i < chunks.length - 1) await wait(180);
  }
  return output.join("");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Используйте POST-запрос." });
  }
  if (isRateLimited(req)) return send(res, 429, { error: "Слишком много запросов. Подождите минуту и попробуйте снова." });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = typeof body.text === "string" ? body.text : "";
  const sourceLang = body.sourceLang;
  const targetLang = body.targetLang;
  if (!text.trim()) return send(res, 400, { error: "Введите текст для перевода." });
  if (text.length > MAX_TEXT_LENGTH) return send(res, 413, { error: `Максимум ${MAX_TEXT_LENGTH.toLocaleString("ru-RU")} символов.` });
  if (!["ru", "en"].includes(sourceLang) || !["ru", "en"].includes(targetLang) || sourceLang === targetLang) {
    return send(res, 400, { error: "Неверно указано направление перевода." });
  }
  try {
    try {
      const translation = await translateWithGoogle(text, sourceLang, targetLang);
      return send(res, 200, { translation, provider: "Google Translate" });
    } catch (googleError) {
      // MyMemory is only a short-text fallback: its small request limit harms context on long documents.
      if (text.length <= MYMEMORY_MAX_CHARS) {
        const translation = await translateWithMyMemory(text, sourceLang, targetLang);
        return send(res, 200, { translation, provider: "MyMemory (резерв)" });
      }
      throw googleError;
    }
  } catch (error) {
    return send(res, 502, {
      error: error.name === "AbortError"
        ? "Сервис перевода отвечает слишком долго. Попробуйте ещё раз."
        : (error.message || "Не удалось выполнить перевод.")
    });
  }
};
