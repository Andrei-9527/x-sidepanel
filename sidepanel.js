const HOME = "https://x.com/home";

let feed = document.getElementById("feed");
const status = document.getElementById("status");
const reloadButton = document.getElementById("reload");
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
  const nextMode = theme === "dark" ? "日间" : "夜间";
  themeButton.textContent = nextMode;
  themeButton.title = `切换到${nextMode}模式`;
  themeButton.setAttribute("aria-label", themeButton.title);
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
  const response = await chrome.runtime.sendMessage({ type: "prepare", theme });
  if (!response?.ok) {
    throw new Error(response?.error || "侧栏还没准备好");
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
  setStatus("正在打开时间线…", false);

  try {
    await prepare();
  } catch (error) {
    if (id === navigationId) {
      setStatus(error.message || "打不开侧栏", true);
    }
    return;
  }

  if (id !== navigationId) {
    return;
  }
  feed.src = url;
  loadTimer = window.setTimeout(() => {
    setStatus("未能加载 X。请在浏览器打开 x.com 检查网络或完成登录，再回来刷新。", true);
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

reloadButton.addEventListener("click", () => {
  openFeed(currentUrl);
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

zoomOutButton.addEventListener("click", () => setZoom(zoom - 10));
zoomResetButton.addEventListener("click", () => setZoom(100));
zoomInButton.addEventListener("click", () => setZoom(zoom + 10));

setZoom(zoom);
applyTheme();
openFeed(HOME);
