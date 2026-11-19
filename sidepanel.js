const HOME = "https://x.com/home";

let feed = document.getElementById("feed");
const status = document.getElementById("status");
const homeButton = document.getElementById("home");
const themeButton = document.getElementById("theme-toggle");
const zoomOutButton = document.getElementById("zoom-out");
const zoomResetButton = document.getElementById("zoom-reset");
const zoomInButton = document.getElementById("zoom-in");

let theme = localStorage.getItem("panel-theme") === "light" ? "light" : "dark";
let zoom = Number(localStorage.getItem("panel-zoom")) || 100;
let currentUrl = HOME;
let loadTimer = 0;
let navigationId = 0;

function setZoom(value) {
  zoom = Math.min(150, Math.max(50, Math.round(value / 10) * 10));
  document.documentElement.style.setProperty("--feed-scale", zoom / 100);
  zoomResetButton.textContent = `${zoom}%`;
  zoomOutButton.disabled = zoom <= 50;
  zoomInButton.disabled = zoom >= 150;
  localStorage.setItem("panel-zoom", String(zoom));
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const night = theme === "dark";
  themeButton.setAttribute("aria-checked", night ? "true" : "false");
  themeButton.title = t(night ? "themeToLightTitle" : "themeToDarkTitle");
  themeButton.setAttribute("aria-label", themeButton.title);
}

function ensureLanguageOptions() {
  const select = document.getElementById("language");
  if (!select || select.dataset.ready) return select;
  for (const language of X_LANGUAGES) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
  select.dataset.ready = "1";
  return select;
}

function applyChrome() {
  const presentation = languagePresentation();
  document.documentElement.lang = presentation.html;
  document.documentElement.dir = presentation.dir;
  document.getElementById("bar-nav")?.setAttribute("aria-label", t("nav"));
  homeButton.textContent = t("home");
  homeButton.title = t("homeTitle");
  const following = document.getElementById("relationships-toggle");
  if (following) {
    following.textContent = t("relationshipsNav");
    following.title = t("relationshipsTitle");
  }
  document.getElementById("zoom-controls")?.setAttribute("aria-label", t("zoom"));
  zoomOutButton.title = t("zoomOut");
  zoomOutButton.setAttribute("aria-label", t("zoomOut"));
  zoomResetButton.title = t("zoomReset");
  zoomResetButton.setAttribute("aria-label", t("zoomReset"));
  zoomInButton.title = t("zoomIn");
  zoomInButton.setAttribute("aria-label", t("zoomIn"));
  feed.setAttribute("title", t("feedTitle"));
  const select = ensureLanguageOptions();
  if (select) {
    select.setAttribute("aria-label", t("language"));
    if (select.value !== xLanguage()) select.value = xLanguage();
  }
  applyTheme();
}

function publishLanguage() {
  applyChrome();
  globalThis.applyPanelLanguage?.();
}

async function readXLanguage() {
  if (!chrome.cookies?.getAll) return "";
  const cookies = await chrome.cookies.getAll({ url: "https://x.com/", name: "lang" });
  const cookie = cookies.find((item) => !item.partitionKey) || cookies[0];
  return canonicalXLanguage(cookie?.value);
}

async function writeXLanguage(code) {
  if (!chrome.cookies?.set) return;
  const expirationDate = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  for (const domain of ["x.com", "twitter.com"]) {
    const cookie = {
      url: `https://${domain}/`,
      name: "lang",
      value: code,
      domain: `.${domain}`,
      path: "/",
      secure: true,
      sameSite: "no_restriction",
      expirationDate,
    };
    try {
      await chrome.cookies.set(cookie);
    } catch {
      delete cookie.sameSite;
      await chrome.cookies.set(cookie);
    }
  }
  try {
    await applyXAccountLanguage(code);
  } catch (error) {
    console.error(error);
  }
}

async function applyXAccountLanguage(code) {
  if (typeof fetch !== "function" || !chrome.cookies?.getAll) return;
  const cookies = await chrome.cookies.getAll({ url: "https://x.com/", name: "ct0" });
  const ct0 = (cookies.find((cookie) => !cookie.partitionKey) || cookies[0])?.value;
  if (!ct0) return;
  const response = await fetch("https://api.x.com/1.1/account/settings.json", {
    method: "POST",
    credentials: "include",
    headers: {
      authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
      "content-type": "application/x-www-form-urlencoded",
      "x-csrf-token": ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
    },
    body: new URLSearchParams({ lang: code }),
  });
  if (!response.ok) throw new Error(t("languageFailed"));
}

function watchXLanguage() {
  if (watchXLanguage.done || !chrome.cookies?.onChanged) return;
  watchXLanguage.done = true;
  chrome.cookies.onChanged.addListener((change) => {
    const cookie = change.cookie;
    if (change.removed || cookie?.name !== "lang" || cookie.partitionKey) return;
    if (cookie.domain?.replace(/^\./, "") !== "x.com") return;
    const code = canonicalXLanguage(cookie.value);
    if (!code || code === xLanguage()) return;
    setXLanguage(code);
    localStorage.setItem("panel-lang-choice", xLanguage());
    publishLanguage();
  });
}

async function boot() {
  watchXLanguage();
  const cookie = await readXLanguage();
  if (cookie !== xLanguage()) {
    try {
      await writeXLanguage(xLanguage());
    } catch (error) {
      console.error(error);
    }
  }
  openFeed(HOME);
}

function setStatus(message, isError) {
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
}

function clearStatus() {
  status.hidden = true;
  status.classList.remove("error");
}

async function prepare() {
  const response = await chrome.runtime.sendMessage({
    type: "prepare",
    theme,
    lang: languagePresentation().locale,
  });
  if (!response?.ok) {
    throw new Error(response?.error || t("panelNotReady"));
  }
}

async function openFeed(url) {
  const id = ++navigationId;
  window.clearTimeout(loadTimer);
  // 销毁旧 frame，释放仍受旧 Service Worker 控制的文档。
  const nextFeed = feed.cloneNode(false);
  nextFeed.removeAttribute("src");
  feed.replaceWith(nextFeed);
  feed = nextFeed;
  currentUrl = url;
  setStatus(t("opening"), false);

  try {
    await prepare();
  } catch (error) {
    if (id === navigationId) {
      setStatus(error.message || t("openFailed"), true);
    }
    return;
  }

  if (id !== navigationId) {
    return;
  }
  feed.src = url;
  loadTimer = window.setTimeout(() => {
    setStatus(t("loadFailed"), true);
  }, 12000);
}

window.addEventListener("message", (event) => {
  if (event.source !== feed.contentWindow || event.data?.type !== "x-panel-ready") {
    return;
  }
  let url;
  try {
    url = new URL(event.data.url);
  } catch (_error) {
    return;
  }
  const isX = ["x.com", "twitter.com"].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
  );
  if (url.protocol !== "https:" || !isX || event.origin !== url.origin) {
    return;
  }
  currentUrl = url.href;
  window.clearTimeout(loadTimer);
  clearStatus();
});

homeButton.addEventListener("click", () => {
  openFeed(HOME);
});

themeButton.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem("panel-theme", theme);
  applyTheme();
  openFeed(currentUrl);
});

document.getElementById("language")?.addEventListener("change", async () => {
  const select = document.getElementById("language");
  const code = canonicalXLanguage(select.value);
  if (!code || code === xLanguage()) return;
  setXLanguage(code);
  localStorage.setItem("panel-lang-choice", xLanguage());
  publishLanguage();
  try {
    await writeXLanguage(code);
  } catch (error) {
    setStatus(error?.message || t("languageFailed"), true);
  }
  openFeed(currentUrl);
});

zoomOutButton.addEventListener("click", () => setZoom(zoom - 10));
zoomResetButton.addEventListener("click", () => setZoom(100));
zoomInButton.addEventListener("click", () => setZoom(zoom + 10));

setZoom(zoom);
publishLanguage();
boot();
