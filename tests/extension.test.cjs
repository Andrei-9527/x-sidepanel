const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function panel(sendMessage = async () => ({ ok: true }), storage = new Map()) {
  const elements = new Map();
  const timers = new Map();
  const listeners = new Map();
  const root = { dataset: {}, style: { setProperty() {} } };
  let timerId = 0;
  function element(id) {
    return {
      hidden: false,
      textContent: "",
      src: "",
      // 跨域异常同样可能来自 Chrome 的错误文档，不能当成加载成功。
      contentWindow: {
        get location() { throw new Error("Blocked a frame with origin"); },
      },
      classList: { toggle() {}, remove() {} },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
      cloneNode() { return element(id); },
      removeAttribute(name) { delete this[name]; },
      replaceWith(next) { elements.set(id, next); },
    };
  }
  for (const id of ["feed", "status", "reload", "home", "theme-toggle", "zoom-out", "zoom-reset", "zoom-in"]) {
    elements.set(id, element(id));
  }
  vm.runInNewContext(source("sidepanel.js"), {
    URL,
    document: { documentElement: root, getElementById: (id) => elements.get(id) },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    chrome: {
      runtime: { sendMessage },
    },
    window: {
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(type, callback) { listeners.set(type, callback); },
    },
  });
  return { elements, timers, listeners, root, storage };
}

test("拒绝连接时不能因跨域异常隐藏错误提示", async () => {
  const p = panel();
  await tick();
  p.listeners.get("feed:load")?.();
  assert.equal(p.elements.get("status").hidden, false);
  for (const callback of p.timers.values()) callback();
  assert.match(p.elements.get("status").textContent, /未能加载 X/);
  assert.equal(p.elements.get("status").hidden, false);
});

test("只接受当前 iframe 中 X 页面发来的就绪消息", async () => {
  const p = panel();
  await tick();
  const source = p.elements.get("feed").contentWindow;
  const message = {
    source,
    origin: "https://x.com",
    data: { type: "x-panel-ready", url: "https://x.com/home" },
  };
  const receive = p.listeners.get("message");
  receive({ ...message, source: {} });
  receive({ ...message, origin: "https://example.com" });
  receive({ ...message, origin: "https://x.com.evil.test", data: {
    type: "x-panel-ready", url: "https://x.com.evil.test/home",
  } });
  assert.equal(p.elements.get("status").hidden, false);
  receive(message);
  assert.equal(p.elements.get("status").hidden, true);
  assert.equal(p.timers.size, 0);
});

test("快速刷新时丢弃过期的准备结果和旧 iframe 消息", async () => {
  const responses = [];
  const p = panel(() => new Promise((resolve) => responses.push(resolve)));
  const oldSource = p.elements.get("feed").contentWindow;
  p.listeners.get("reload:click")();
  responses[1]({ ok: true });
  await tick();
  responses[0]({ ok: false, error: "old failure" });
  await tick();
  assert.equal(p.elements.get("feed").src, "https://x.com/home");
  assert.equal(p.timers.size, 1);
  assert.doesNotMatch(p.elements.get("status").textContent, /old failure/);
  p.listeners.get("message")({
    source: oldSource, origin: "https://x.com",
    data: { type: "x-panel-ready", url: "https://x.com/home" },
  });
  assert.equal(p.elements.get("status").hidden, false);
});

test("准备失败时显示具体原因", async () => {
  const p = panel(async () => ({ ok: false, error: "Missing host permission" }));
  await tick();
  assert.match(p.elements.get("status").textContent, /Missing host permission/);
  assert.equal(p.elements.get("feed").src, undefined);
});

test("切换模式会重新准备 X 的原生主题，重开侧栏后保留选择", async () => {
  const messages = [];
  const p = panel(async (message) => { messages.push(message); return { ok: true }; });
  await tick();
  assert.equal(p.root.dataset.theme, "dark");
  assert.equal(p.elements.get("theme-toggle").textContent, "日间");
  p.listeners.get("theme-toggle:click")();
  await tick();
  assert.equal(p.root.dataset.theme, "light");
  assert.equal(p.elements.get("theme-toggle").textContent, "夜间");
  assert.equal(messages.at(-1).theme, "light");
  const reopened = panel(undefined, p.storage);
  await tick();
  assert.equal(reopened.root.dataset.theme, "light");
  p.listeners.get("theme-toggle:click")();
  await tick();
  assert.equal(p.root.dataset.theme, "dark");
  assert.equal(messages.at(-1).theme, "dark");
});

function background(failRules = false) {
  const events = new Map();
  const calls = [];
  const event = (name) => ({ addListener: (callback) => events.set(name, callback) });
  vm.runInNewContext(source("background.js"), {
    console, setTimeout, clearTimeout,
    chrome: {
      runtime: {
        id: "test-extension",
        onInstalled: event("installed"),
        onStartup: event("startup"),
        onMessage: event("message"),
      },
      cookies: {
        getAll: async () => [{ domain: ".x.com", value: "test-token" }],
        set: async (options) => calls.push({ type: "cookie", ...options }),
        onChanged: event("cookie"),
      },
      declarativeNetRequest: {
        updateDynamicRules: async (options) => {
          calls.push({ type: "rules", ...JSON.parse(JSON.stringify(options)) });
          if (failRules) throw new Error("Rule registration failed");
        },
      },
      browsingData: {
        remove: async (options, data) => calls.push({
          type: "remove", options: JSON.parse(JSON.stringify(options)),
          data: JSON.parse(JSON.stringify(data)),
        }),
      },
      sidePanel: { setPanelBehavior: async () => {} },
    },
  });
  const prepare = (theme = "dark") => new Promise((resolve) => {
    assert.equal(events.get("message")({ type: "prepare", theme }, {}, resolve), true);
  });
  return { events, calls, prepare };
}

test("先注册规则，再只解除 X/Twitter 的 Service Worker 注册", async () => {
  const b = background();
  assert.equal((await b.prepare()).ok, true);
  assert.deepEqual(b.calls.map((call) => call.type), ["rules", "rules", "cookie", "cookie", "remove"]);
  const removal = b.calls[4];
  assert.deepEqual(removal.options.origins, ["https://x.com", "https://twitter.com"]);
  assert.deepEqual(removal.data, { serviceWorkers: true });
  assert.deepEqual(removal.options.originTypes, { unprotectedWeb: true, protectedWeb: true });
  for (const call of b.calls.filter((call) => call.type === "rules")) {
    for (const rule of call.addRules) {
      assert.deepEqual(rule.condition.topDomains, ["test-extension"]);
    }
  }
  assert.deepEqual(b.calls[1].addRules[0].condition.requestDomains, ["x.com"]);
});

test("日间和夜间写入 X 原生主题 Cookie，保留登录 Cookie", async () => {
  const b = background();
  await b.prepare("light");
  const cookies = b.calls.filter((call) => call.type === "cookie");
  assert.deepEqual(cookies.map((cookie) => cookie.domain), [".x.com", ".twitter.com"]);
  assert.equal(cookies.every((cookie) => cookie.name === "night_mode" && cookie.value === "0"), true);
  b.calls.length = 0;
  await b.prepare("dark");
  assert.equal(b.calls.filter((call) => call.type === "cookie").every((cookie) => cookie.value === "2"), true);
});

test("规则注册失败必须回报失败，不能悄悄降级为成功", async () => {
  const b = background(true);
  const result = await b.prepare();
  assert.equal(result.ok, false);
  assert.match(result.error, /Rule registration failed/);
  assert.equal(b.calls.length, 1);
});

test("浏览器启动时只更新规则，不清理站点注册", async () => {
  const b = background();
  b.events.get("startup")();
  await tick();
  assert.equal(b.calls.some((call) => call.type === "remove"), false);
});
