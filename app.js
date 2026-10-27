(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORAGE_HISTORY = "lingo-history-v1";
  const STORAGE_LANGS = "lingo-languages-v1";
  const STORAGE_THEME = "lingo-theme-v1";
  const API_URL = "https://api.mymemory.translated.net/get";
  const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
  const MAX_HISTORY = 100;
  // MyMemory limits individual requests, so long texts are translated in smaller chunks.
  const MAX_TEXT_LENGTH = 50000;
  const MYMEMORY_CHUNK_BYTES = 120;
  const GOOGLE_CHUNK_CHARS = 1900;
  const MYMEMORY_MAX_CHARS = 4500;
  const LIVE_PREVIEW_MAX_CHARS = 1200;
  const LIVE_PREVIEW_INTERVAL_MS = 650;
  const FINAL_TRANSLATION_PAUSE_MS = 1450;
  const LANG_NAMES = { ru: "Русский", en: "English" };
  let sourceLang = "ru";
  let targetLang = "en";
  let lastTranslation = "";
  let toastTimer;
  let requestController = null;
  let recognition = null;
  let typingTimer = null;
  let translationSequence = 0;
  let lastCompletedText = null;
  let lastCompletedTranslation = "";
  let lastCompletedFrom = null;
  let lastCompletedTo = null;

  const sourceText = $("source-text");
  const output = $("translated-text");
  const errorBox = $("error-box");

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }
  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }
  function setBusy(_busy) { /* Статусные надписи убраны из интерфейса. */ }
  function applyTheme(theme) {
    const allowed = ["system", "light", "dark"].includes(theme) ? theme : "system";
    document.documentElement.dataset.theme = allowed;
    const select = $("theme-select");
    if (select && select.value !== allowed) select.value = allowed;
    try { localStorage.setItem(STORAGE_THEME, allowed); } catch {}
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = allowed === "dark" ? "#0b1018" : "#1769ff";
  }
  function initTheme() {
    let saved = "system";
    try { saved = localStorage.getItem(STORAGE_THEME) || "system"; } catch {}
    applyTheme(saved);
    $("theme-select").addEventListener("change", event => applyTheme(event.target.value));
  }
  function updateConnection() {
    const online = navigator.onLine;
    $("connection-label").textContent = online ? "Онлайн" : "Офлайн";
    document.querySelector(".status-pill").classList.toggle("offline", !online);
    $("api-note-text").textContent = online ? "Онлайн-перевод · нужен интернет" : "Офлайн: интерфейс и история доступны";
  }
  function updateLangUI() {
    $("source-language").dataset.lang = sourceLang;
    $("target-language").dataset.lang = targetLang;
    $("source-name").textContent = LANG_NAMES[sourceLang];
    $("target-name").textContent = LANG_NAMES[targetLang];
    $("source-language").querySelector(".lang-code").textContent = sourceLang.toUpperCase();
    $("target-language").querySelector(".lang-code").textContent = targetLang.toUpperCase();
    try { localStorage.setItem(STORAGE_LANGS, JSON.stringify({sourceLang,targetLang})); } catch {}
  }
  function swapLanguages() {
    [sourceLang, targetLang] = [targetLang, sourceLang];
    const oldInput = sourceText.value;
    sourceText.value = lastTranslation || "";
    output.textContent = oldInput || "Здесь появится перевод…";
    output.classList.toggle("placeholder", !oldInput);
    lastTranslation = oldInput;
    updateLangUI();
    $("char-count").textContent = `${sourceText.value.length} / ${MAX_TEXT_LENGTH}`;
    clearError();
  }
  function getHistory() {
    try {
      const val = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || "[]");
      return Array.isArray(val) ? val : [];
    } catch { return []; }
  }
  function saveHistory(item) {
    try {
      const items = getHistory();
      items.unshift(item);
      localStorage.setItem(STORAGE_HISTORY, JSON.stringify(items.slice(0, MAX_HISTORY)));
    } catch { toast("Не удалось сохранить историю: хранилище браузера недоступно."); }
  }
  function renderHistory() {
    const list = $("history-list");
    const items = getHistory();
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "Здесь появятся ваши недавние переводы. История хранится только в этом браузере.";
      list.append(empty);
      return;
    }
    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = "history-item";
      card.tabIndex = 0;
      const meta = document.createElement("div"); meta.className = "history-meta";
      const pair = document.createElement("span"); pair.textContent = `${item.from.toUpperCase()} → ${item.to.toUpperCase()}`;
      const date = document.createElement("time"); date.textContent = new Date(item.time).toLocaleString();
      meta.append(pair, date);
      const original = document.createElement("div"); original.className = "history-source"; original.textContent = item.text;
      const result = document.createElement("div"); result.className = "history-result"; result.textContent = item.translation;
      card.append(meta, original, result);
      const restore = () => {
        sourceLang = item.from; targetLang = item.to; updateLangUI();
        sourceText.value = item.text; lastTranslation = item.translation;
        output.textContent = item.translation; output.classList.remove("placeholder");
        $("char-count").textContent = `${sourceText.value.length} / ${MAX_TEXT_LENGTH}`;
        
        $("history-overlay").hidden = true;
        clearError(); window.scrollTo({top:0,behavior:"smooth"});
      };
      card.addEventListener("click", restore);
      card.addEventListener("keydown", e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); restore(); }});
      list.append(card);
    });
  }
  function detectLanguage(text) {
    const cyrillic = (text.match(/[а-яё]/gi) || []).length;
    const latin = (text.match(/[a-z]/gi) || []).length;
    if (cyrillic > latin) return "ru";
    if (latin > cyrillic) return "en";
    return sourceLang;
  }
  // MyMemory limits each request by UTF-8 bytes. Keep whitespace between segments intact.
  function splitForMyMemory(text, maxBytes = MYMEMORY_CHUNK_BYTES) {
    const chars = Array.from(text);
    const chunks = [];
    let start = 0;
    const bytesOf = (ch) => new TextEncoder().encode(ch).length;
    while (start < chars.length) {
      let end = start;
      let byteCount = 0;
      let preferredEnd = -1;
      let preferredNext = -1;
      while (end < chars.length) {
        const nextBytes = bytesOf(chars[end]);
        if (byteCount + nextBytes > maxBytes) break;
        byteCount += nextBytes;
        end += 1;
        const ch = chars[end - 1];
        if (/[.!?;:…]/.test(ch)) {
          preferredEnd = end;
          preferredNext = end;
          while (preferredNext < chars.length && /\s/.test(chars[preferredNext])) preferredNext++;
        } else if (/\s/.test(ch)) {
          // Keep the exact whitespace as a separator instead of asking the API to translate it.
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
      let cutEnd = preferredEnd > start + 1 && preferredEnd >= start + Math.floor((end - start) * 0.55)
        ? preferredEnd : end;
      let nextStart = cutEnd;
      let separator = "";
      if (cutEnd === preferredEnd && preferredNext >= cutEnd) {
        separator = chars.slice(cutEnd, preferredNext).join("");
        nextStart = preferredNext;
      }
      if (cutEnd <= start) { cutEnd = end; nextStart = end; separator = ""; }
      const part = chars.slice(start, cutEnd).join("");
      if (part) chunks.push({ text: part, separator });
      start = nextStart;
    }
    return chunks;
  }
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  async function translateWithMyMemory(text, from, to, signal, onProgress) {
    if (text.length > MYMEMORY_MAX_CHARS) {
      throw new Error(`Резервный сервис поддерживает только короткий текст (до ${MYMEMORY_MAX_CHARS.toLocaleString()} символов). Попробуйте основной сервис ещё раз.`);
    }
    const chunks = splitForMyMemory(text);
    const translatedParts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const params = new URLSearchParams({ q: chunks[i].text, langpair: `${from}|${to}` });
      let data;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${API_URL}?${params.toString()}`, {
          method: "GET", signal, headers: { "Accept": "application/json" }
        });
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 2) { await sleep(500 * (attempt + 1), signal); continue; }
        }
        if (!response.ok) {
          throw new Error(response.status === 429
            ? "Сервис временно ограничил запросы. Подождите и попробуйте снова."
            : `Сервис перевода ответил с кодом ${response.status}.`);
        }
        data = await response.json();
        if ((data.responseStatus === 429 || data.responseStatus >= 500) && attempt < 2) {
          await sleep(500 * (attempt + 1), signal); continue;
        }
        break;
      }
      if (!data || data.responseStatus !== 200 || !data.responseData?.translatedText) {
        const details = data?.responseDetails || "Сервис не вернул перевод.";
        if (/limit|quota|too many|daily/i.test(details)) {
          throw new Error("У резервного сервиса перевода закончился лимит. Попробуйте позже.");
        }
        throw new Error(details);
      }
      translatedParts.push(decodeHtml(data.responseData.translatedText));
      translatedParts.push(chunks[i].separator);
      if (onProgress) onProgress(translatedParts.join(""), i + 1, chunks.length);
      // Avoid hammering the public endpoint when a text has many chunks.
      if (i < chunks.length - 1) await sleep(180, signal);
    }
    return translatedParts.join("");
  }
  // Bigger chunks retain sentence context much better than the tiny fragments required by MyMemory.
  function splitForGoogle(text, maxChars = GOOGLE_CHUNK_CHARS) {
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
      const part = chars.slice(start, cutEnd > start ? cutEnd : end).join("");
      if (part) chunks.push({ text: part, separator });
      start = nextStart > start ? nextStart : end;
    }
    return chunks;
  }

  async function translateWithGoogle(text, from, to, signal, onProgress) {
    const chunks = splitForGoogle(text);
    const translatedParts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const params = new URLSearchParams({ client: "gtx", sl: from, tl: to, dt: "t", dj: "1", q: chunks[i].text });
      let data;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`${GOOGLE_URL}?${params.toString()}`, {
            method: "GET", signal, headers: { Accept: "application/json" }
          });
          if (response.status === 429 || response.status >= 500) throw new Error(`Сервис перевода временно ответил кодом ${response.status}.`);
          if (!response.ok) throw new Error(`Сервис перевода ответил кодом ${response.status}.`);
          data = await response.json();
          if (!Array.isArray(data.sentences)) throw new Error("Сервис не вернул перевод.");
          const translated = data.sentences.map(sentence => sentence.trans || "").join("");
          if (!translated.trim()) throw new Error("Сервис не вернул текст перевода.");
          translatedParts.push(decodeHtml(translated), chunks[i].separator);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error.name === "AbortError") throw error;
          if (attempt < 2) await sleep(350 * (attempt + 1), signal);
        }
      }
      if (lastError) throw lastError;
      if (onProgress) onProgress(translatedParts.join(""), i + 1, chunks.length);
      if (i < chunks.length - 1) await sleep(100, signal);
    }
    return translatedParts.join("");
  }

  async function requestTranslation(text, from, to, signal, onProgress) {
    // Vercel handles long texts server-side. Static/localhost preview can use the public endpoint directly.
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ text, sourceLang: from, targetLang: to }),
        signal
      });
      if (response.status !== 404 && response.status !== 405 && response.ok) {
        const data = await response.json().catch(() => ({}));
        if (typeof data.translation === "string" && data.translation.trim()) {
          return { translation: data.translation, provider: data.provider || "translation API" };
        }
      }
      // A function error does not block a browser-side attempt; the two routes can be rate-limited differently.
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }

    try {
      const translation = await translateWithGoogle(text, from, to, signal, onProgress);
      return { translation, provider: "Google Translate" };
    } catch (googleError) {
      if (googleError.name === "AbortError") throw googleError;
      if (text.length <= MYMEMORY_MAX_CHARS) {
        const translation = await translateWithMyMemory(text, from, to, signal, onProgress);
        return { translation, provider: "MyMemory (резерв)" };
      }
      throw new Error("Основной сервис перевода временно недоступен для такого длинного текста. Попробуйте ещё раз позже.");
    }
  }
  async function translate(finalize = false) {
    const text = sourceText.value;
    const meaningfulText = text.trim();
    const mySequence = ++translationSequence;
    clearError();
    if (!meaningfulText) {
      lastTranslation = "";
      output.textContent = "";
      output.classList.add("placeholder");
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      showError(`Максимум ${MAX_TEXT_LENGTH.toLocaleString()} символов за один перевод.`);
      return;
    }
    if (finalize && lastCompletedText === text && lastCompletedFrom === sourceLang && lastCompletedTo === targetLang && lastCompletedTranslation) {
      lastTranslation = lastCompletedTranslation;
      output.textContent = lastCompletedTranslation;
      output.classList.remove("placeholder");
      saveHistory({ text, translation: lastCompletedTranslation, from: sourceLang, to: targetLang, time: Date.now() });
      return;
    }
    if (!navigator.onLine) {
      if (finalize) showError("Для нового перевода нужно подключение к интернету.");
      return;
    }
    if (requestController) requestController.abort();
    requestController = new AbortController();
    try {
      const detected = detectLanguage(meaningfulText);
      if (detected !== sourceLang && /[a-zа-яё]/i.test(meaningfulText)) {
        sourceLang = detected;
        targetLang = detected === "ru" ? "en" : "ru";
        updateLangUI();
      }
      const result = await requestTranslation(text, sourceLang, targetLang, requestController.signal, (partial) => {
        if (mySequence === translationSequence && sourceText.value === text) {
          output.textContent = partial;
          output.classList.remove("placeholder");
        }
      });
      if (mySequence !== translationSequence || sourceText.value !== text) return;
      const translated = result.translation;
      if (typeof translated !== "string" || !translated.trim()) throw new Error("Сервис не вернул перевод.");
      lastTranslation = translated;
      lastCompletedText = text;
      lastCompletedTranslation = translated;
      lastCompletedFrom = sourceLang;
      lastCompletedTo = targetLang;
      output.textContent = translated;
      output.classList.remove("placeholder");
      if (finalize) saveHistory({ text, translation: translated, from: sourceLang, to: targetLang, time: Date.now() });
    } catch (err) {
      if (err.name === "AbortError" || mySequence !== translationSequence) return;
      if (finalize) showError(err instanceof TypeError ? "Не удалось подключиться к сервису перевода. Проверьте интернет." : (err.message || "Не удалось выполнить перевод."));
    } finally {
      if (mySequence === translationSequence) requestController = null;
    }
  }
  function decodeHtml(value) {
    const el = document.createElement("textarea");
    el.innerHTML = value;
    return el.value;
  }
  async function copyTranslation() {
    if (!lastTranslation) { toast("Сначала выполните перевод."); return; }
    try {
      await navigator.clipboard.writeText(lastTranslation);
      toast("Перевод скопирован");
    } catch {
      const el = document.createElement("textarea");
      el.value = lastTranslation; el.style.position = "fixed"; el.style.opacity = "0";
      document.body.append(el); el.select();
      const ok = document.execCommand("copy"); el.remove();
      toast(ok ? "Перевод скопирован" : "Не удалось скопировать текст");
    }
  }
  function speak(text, lang) {
    if (!text) { toast("Нет текста для озвучивания."); return; }
    if (!("speechSynthesis" in window)) { toast("Озвучивание не поддерживается этим браузером."); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === "ru" ? "ru-RU" : "en-US";
    utterance.rate = 0.95;
    utterance.onerror = () => toast("Не удалось озвучить текст на этом устройстве.");
    window.speechSynthesis.speak(utterance);
  }
  function startVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast("Голосовой ввод не поддерживается. Попробуйте Chrome или Edge.");
      return;
    }
    if (recognition) { recognition.stop(); recognition = null; $("voice-input").classList.remove("recording"); return; }
    recognition = new SpeechRecognition();
    recognition.lang = sourceLang === "ru" ? "ru-RU" : "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalTranscript = sourceText.value;
    recognition.onstart = () => { $("voice-input").classList.add("recording"); toast("Слушаю… Говорите сейчас."); };
    recognition.onresult = event => {
      let interim = "";
      for (let i=event.resultIndex; i<event.results.length; i++) {
        if (event.results[i].isFinal) finalTranscript += (finalTranscript ? " " : "") + event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      sourceText.value = finalTranscript + (interim ? (finalTranscript ? " " : "") + interim : "");
      $("char-count").textContent = `${sourceText.value.length} / ${MAX_TEXT_LENGTH}`;
    };
    recognition.onerror = event => {
      const msg = event.error === "not-allowed" ? "Разрешите доступ к микрофону в настройках браузера." : "Голосовой ввод завершился с ошибкой.";
      toast(msg);
    };
    recognition.onend = () => { $("voice-input").classList.remove("recording"); recognition = null; };
    try { recognition.start(); } catch { toast("Не удалось запустить микрофон. Попробуйте ещё раз."); }
  }

  $("swap-languages").addEventListener("click", swapLanguages);
  $("source-language").addEventListener("click", () => { toast("Язык исходного текста определяется автоматически. Используйте ↔, чтобы поменять направление."); });
  $("target-language").addEventListener("click", () => { toast("Доступны русский и английский. Используйте ↔, чтобы поменять направление."); });
  let lastWordRequest = "";
  let liveTimer = null;
  let lastLiveStart = 0;
  $("source-text").addEventListener("input", () => {
    $("char-count").textContent = `${sourceText.value.length} / ${MAX_TEXT_LENGTH}`;
    clearError();
    // Invalidate stale results, but don't abort on every keystroke: the API may already count it.
    translationSequence++;
    clearTimeout(typingTimer);
    const text = sourceText.value;
    const meaningfulText = text.trim();
    if (!meaningfulText) {
      clearTimeout(liveTimer); liveTimer = null;
      if (requestController) requestController.abort();
      lastTranslation = ""; lastWordRequest = "";
      output.textContent = ""; output.classList.add("placeholder");
      return;
    }
    // Live previews are throttled and kept to short inputs to avoid repeatedly submitting
    // a 50,000-character document for every word (and exhausting the provider quota).
    const wordBoundary = /[\s.,!?;:…]$/.test(text);
    if (wordBoundary && text.length <= LIVE_PREVIEW_MAX_CHARS && meaningfulText !== lastWordRequest && !liveTimer) {
      const wait = Math.max(180, LIVE_PREVIEW_INTERVAL_MS - (Date.now() - lastLiveStart));
      liveTimer = setTimeout(() => {
        liveTimer = null;
        const currentText = sourceText.value;
        const currentMeaningfulText = currentText.trim();
        if (!currentMeaningfulText || currentText.length > LIVE_PREVIEW_MAX_CHARS || !/[\s.,!?;:…]$/.test(currentText)) return;
        if (currentMeaningfulText === lastWordRequest) return;
        lastLiveStart = Date.now();
        lastWordRequest = currentMeaningfulText;
        translate(false);
      }, wait);
    }
    typingTimer = setTimeout(() => {
      lastWordRequest = meaningfulText;
      translate(true);
    }, FINAL_TRANSLATION_PAUSE_MS);
  });
  $("source-text").addEventListener("keydown", e => {
    // Перевод запускается автоматически после короткой паузы при вводе.
  });
  $("clear-text").addEventListener("click", () => {
    clearTimeout(typingTimer); translationSequence++; if (requestController) requestController.abort();
    sourceText.value = ""; lastTranslation = ""; output.textContent = "";
    output.classList.add("placeholder"); $("char-count").textContent = `0 / ${MAX_TEXT_LENGTH}`;
     clearError(); sourceText.focus();
  });

  $("brand-home").addEventListener("click", event => {
    event.preventDefault();
    sourceText.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("photo-input-button").addEventListener("click", () => $("photo-input").click());
  $("photo-input").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Выберите файл изображения."); return; }
    if (file.size > 12 * 1024 * 1024) { toast("Фото слишком большое. Максимум 12 МБ."); return; }
    toast("Распознаю текст на фото…");
    
    try {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          script.onload = resolve; script.onerror = () => reject(new Error("Не удалось загрузить распознавание текста. Проверьте интернет."));
          document.head.append(script);
        });
      }
      const result = await window.Tesseract.recognize(file, "eng+rus");
      const extracted = (result.data.text || "").trim();
      if (!extracted) { toast("Не удалось найти текст на фото.");  return; }
      sourceText.value = extracted.slice(0, MAX_TEXT_LENGTH);
      $("char-count").textContent = `${sourceText.value.length} / ${MAX_TEXT_LENGTH}`;
      clearError();
      toast("Текст с фото распознан");
      sourceText.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      showError(err.message || "Не удалось распознать текст на фото.");
      
    } finally { event.target.value = ""; }
  });
  $("copy-translation").addEventListener("click", copyTranslation);
  $("speak-translation").addEventListener("click", () => speak(lastTranslation, targetLang));
  $("voice-input").addEventListener("click", startVoiceInput);
  $("history-toggle").addEventListener("click", () => { renderHistory(); $("history-overlay").hidden = false; });
  $("close-history").addEventListener("click", () => $("history-overlay").hidden = true);
  $("history-overlay").addEventListener("click", e => { if (e.target === $("history-overlay")) $("history-overlay").hidden = true; });
  $("clear-history").addEventListener("click", () => {
    if (!getHistory().length) { toast("История уже пуста."); return; }
    if (confirm("Удалить всю историю переводов на этом устройстве?")) {
      localStorage.removeItem(STORAGE_HISTORY); renderHistory(); toast("История очищена");
    }
  });
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  window.addEventListener("keydown", e => { if (e.key === "Escape") $("history-overlay").hidden = true; });
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_LANGS) || "null");
    if (saved && ["ru","en"].includes(saved.sourceLang) && ["ru","en"].includes(saved.targetLang)) {
      sourceLang = saved.sourceLang; targetLang = saved.targetLang;
    }
  } catch {}
  initTheme();
  updateLangUI(); updateConnection();
  $("year").textContent = new Date().getFullYear();
  output.classList.add("placeholder");
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();