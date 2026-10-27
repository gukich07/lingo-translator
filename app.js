(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORAGE_HISTORY = "lingo-history-v1";
  const STORAGE_LANGS = "lingo-languages-v1";
  const STORAGE_THEME = "lingo-theme-v1";
  const API_URL = "https://api.mymemory.translated.net/get";
  const MAX_HISTORY = 100;
  const LANG_NAMES = { ru: "Русский", en: "English" };
  let sourceLang = "ru";
  let targetLang = "en";
  let lastTranslation = "";
  let toastTimer;
  let requestController = null;
  let recognition = null;

  const sourceText = $("source-text");
  const output = $("translated-text");
  const translateButton = $("translate-button");
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
  function setBusy(busy) {
    translateButton.disabled = busy;
    translateButton.querySelector("span").textContent = busy ? "Перевожу…" : "Перевести";
    $("translation-state").textContent = busy ? "Обработка…" : (lastTranslation ? "Переведено" : "Готов к переводу");
  }
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
    $("api-note-text").textContent = online ? "Перевод через онлайн-сервис" : "Офлайн: история и интерфейс доступны";
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
    output.textContent = oldInput || "Your translation will appear here.";
    output.classList.toggle("placeholder", !oldInput);
    lastTranslation = oldInput;
    updateLangUI();
    $("char-count").textContent = `${sourceText.value.length} / 5000`;
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
        $("char-count").textContent = `${sourceText.value.length} / 5000`;
        $("translation-state").textContent = "Из истории";
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
  async function translate() {
    const text = sourceText.value.trim();
    clearError();
    if (!text) { showError("Введите текст, который нужно перевести."); sourceText.focus(); return; }
    if (!navigator.onLine) {
      showError("Сейчас нет подключения к интернету. Интерфейс и сохранённая история работают офлайн, но новый перевод требует доступа к переводческому сервису.");
      return;
    }
    if (requestController) requestController.abort();
    requestController = new AbortController();
    setBusy(true);
    try {
      const detected = detectLanguage(text);
      if (detected !== sourceLang && /[a-zа-яё]/i.test(text)) {
        sourceLang = detected; targetLang = detected === "ru" ? "en" : "ru"; updateLangUI();
      }
      const params = new URLSearchParams({
        q: text,
        langpair: `${sourceLang}|${targetLang}`
      });
      const response = await fetch(`${API_URL}?${params.toString()}`, {
        method: "GET",
        signal: requestController.signal,
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error(response.status === 429 ? "Сервис временно ограничил запросы. Попробуйте немного позже." : `Сервис перевода ответил с кодом ${response.status}.`);
      const data = await response.json();
      if (data.responseStatus !== 200 || !data.responseData?.translatedText) {
        const details = data.responseDetails || "Сервис не вернул перевод.";
        throw new Error(details);
      }
      lastTranslation = decodeHtml(data.responseData.translatedText);
      output.textContent = lastTranslation;
      output.classList.remove("placeholder");
      $("translation-state").textContent = "Переведено";
      saveHistory({text, translation:lastTranslation, from:sourceLang, to:targetLang, time:Date.now()});
      toast("Перевод готов");
    } catch (err) {
      if (err.name === "AbortError") return;
      const message = err instanceof TypeError
        ? "Не удалось подключиться к сервису перевода. Проверьте интернет или попробуйте позже."
        : (err.message || "Не удалось выполнить перевод.");
      showError(message);
      $("translation-state").textContent = "Ошибка перевода";
    } finally {
      setBusy(false);
      requestController = null;
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
      $("char-count").textContent = `${sourceText.value.length} / 5000`;
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
  $("translate-button").addEventListener("click", translate);
  $("source-text").addEventListener("input", () => {
    $("char-count").textContent = `${sourceText.value.length} / 5000`;
    clearError();
  });
  $("source-text").addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") translate();
  });
  $("clear-text").addEventListener("click", () => {
    sourceText.value = ""; lastTranslation = ""; output.textContent = "Your translation will appear here.";
    output.classList.add("placeholder"); $("char-count").textContent = "0 / 5000";
    $("translation-state").textContent = "Готов к переводу"; clearError(); sourceText.focus();
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