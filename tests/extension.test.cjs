const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function panel(sendMessage = async () => ({ ok: true }), storage = new Map(), cookieJar = [], navigatorLanguage = "") {
  const elements = new Map();
  const timers = new Map();
  const listeners = new Map();
  const root = { dataset: {}, style: { setProperty() {} } };
  let timerId = 0;
  function element(id) {
    return {
      hidden: false,
      textContent: "",
      value: "",
      src: "",
      dataset: {},
      // 跨域异常同样可能来自 Chrome 的错误文档，不能当成加载成功。
      contentWindow: {
        get location() { throw new Error("Blocked a frame with origin"); },
      },
      classList: { toggle() {}, remove() {} },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
      append(child) { (this.options ??= []).push(child); },
      cloneNode() { return element(id); },
      removeAttribute(name) { delete this[name]; },
      replaceWith(next) { elements.set(id, next); },
    };
  }
  for (const id of ["feed", "status", "home", "theme-toggle", "zoom-out", "zoom-reset", "zoom-in", "language"]) {
    elements.set(id, element(id));
  }
  const context = vm.createContext({
    URL,
    document: {
      documentElement: root,
      getElementById: (id) => elements.get(id),
      createElement: () => element("option"),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    chrome: {
      runtime: { sendMessage },
      cookies: {
        getAll: async ({ name } = {}) => cookieJar.filter((cookie) => !name || cookie.name === name),
        set: async (config) => { cookieJar.push(config); },
        onChanged: { addListener(callback) { listeners.set("cookie", callback); } },
      },
    },
    navigator: { language: navigatorLanguage },
    window: {
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(type, callback) { listeners.set(type, callback); },
    },
  });
  vm.runInContext(source("i18n.js"), context);
  vm.runInContext(source("sidepanel.js"), context);
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
  await tick();
  const oldSource = p.elements.get("feed").contentWindow;
  p.listeners.get("home:click")();
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
  assert.equal(p.elements.get("theme-toggle")["aria-checked"], "true");
  p.listeners.get("theme-toggle:click")();
  await tick();
  assert.equal(p.root.dataset.theme, "light");
  assert.equal(p.elements.get("theme-toggle")["aria-checked"], "false");
  assert.equal(p.elements.get("theme-toggle").title, "切换到夜间模式");
  assert.equal(messages.at(-1).theme, "light");
  const reopened = panel(undefined, p.storage);
  await tick();
  assert.equal(reopened.root.dataset.theme, "light");
  p.listeners.get("theme-toggle:click")();
  await tick();
  assert.equal(p.root.dataset.theme, "dark");
  assert.equal(messages.at(-1).theme, "dark");
});

test("打开侧栏时把 X 设为系统语言，菜单仍可改 X 的语言", async () => {
  const jar = [{ name: "lang", domain: ".x.com", value: "zh-cn" }];
  const p = panel(async () => ({ ok: true }), new Map(), jar, "en-US");
  await tick();
  assert.equal(p.elements.get("theme-toggle").title, "Switch to light mode");
  assert.equal(p.elements.get("language").value, "en");
  assert.equal(p.root.lang, "en");
  assert.ok(jar.some((cookie) => cookie.name === "lang" && cookie.value === "en" && cookie.domain === ".x.com" && cookie.sameSite === "no_restriction"));
  assert.ok(jar.some((cookie) => cookie.name === "lang" && cookie.value === "en" && cookie.domain === ".twitter.com"));
  p.elements.get("language").value = "zh-cn";
  p.listeners.get("language:change")();
  await tick();
  assert.equal(p.elements.get("theme-toggle").title, "切换到日间模式");
  assert.equal(p.root.lang, "zh-CN");
  assert.equal(p.storage.get("panel-lang-choice"), "zh-cn");
  assert.equal(p.elements.get("feed").src, "https://x.com/home");
});

test("X 页面自报的语言不会盖过当前语言", async () => {
  const p = panel();
  await tick();
  const frame = p.elements.get("feed").contentWindow;
  p.listeners.get("message")({
    source: frame,
    origin: "https://x.com",
    data: { type: "x-panel-ready", url: "https://x.com/home", lang: "zh-Hant" },
  });
  assert.equal(p.elements.get("status").hidden, true);
  assert.equal(p.elements.get("language").value, "zh-cn");
  assert.equal(p.elements.get("home").textContent, "首页");
});

test("三种界面语言的文案键一致，其余 X 语言回退到英文", () => {
  const context = vm.createContext({ localStorage: { getItem: () => null } });
  vm.runInContext(source("i18n.js"), context);
  const keys = (code) => Object.keys(context.UI_MESSAGES[code]).sort();
  assert.deepEqual(keys("zh-tw"), keys("zh-cn"));
  assert.deepEqual(keys("en"), keys("zh-cn"));
  assert.equal(context.canonicalXLanguage("zh-CN"), "zh-cn");
  assert.equal(context.canonicalXLanguage("en-US"), "en");
  assert.equal(context.setXLanguage("ja"), "ja");
  assert.equal(context.messageLanguage(), "en");
  assert.equal(context.t("home"), "Home");
  assert.equal(context.languagePresentation().html, "ja");
});

function background(failRules = false) {
  const events = new Map();
  const calls = [];
  const storage = new Map();
  const extensionOrigin = "chrome-extension://test-extension";
  const getURL = (path) => extensionOrigin + "/" + path;
  const panelUrl = getURL("sidepanel.html");
  let now = Date.parse("2026-11-17T15:30:00Z");
  let accountId = "123";
  const event = (name) => ({ addListener: (callback) => events.set(name, callback) });
  const context = vm.createContext({
    console, clearTimeout, URL,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback); },
    chrome: {
      runtime: {
        id: "test-extension", getURL,
        onInstalled: event("installed"),
        onStartup: event("startup"),
        onMessage: event("message"),
        onConnect: event("connect"),
        sendMessage: async () => {},
      },
      webRequest: { onHeadersReceived: event("headers") },
      cookies: {
        getAll: async ({ name }) => name === "twid"
          ? accountId ? [{ domain: ".x.com", value: "u%3D" + accountId }] : []
          : [{ domain: ".x.com", value: "test-token" }],
        set: async (config) => calls.push({ type: "cookie", ...config }),
        onChanged: event("cookie"),
      },
      declarativeNetRequest: {
        updateDynamicRules: async (config) => {
          calls.push({ type: "rules", ...JSON.parse(JSON.stringify(config)) });
          if (failRules) throw new Error("Rule registration failed");
        },
      },
      browsingData: {
        remove: async (config, data) => calls.push({
          type: "remove", options: JSON.parse(JSON.stringify(config)),
          data: JSON.parse(JSON.stringify(data)),
        }),
      },
      sidePanel: { setPanelBehavior: async () => {} },
      storage: {
        local: {
          get: async (key) => ({ [key]: storage.get(key) }),
          set: async (entries) => {
            for (const [key, value] of Object.entries(entries)) {
              storage.set(key, JSON.parse(JSON.stringify(value)));
            }
          },
        },
      },
    },
  });
  context.importScripts = (...scripts) => {
    for (const script of scripts) vm.runInContext(source(script), context);
  };
  vm.runInContext(source("background.js"), context);
  const message = (payload) => new Promise((resolve) => {
    assert.equal(events.get("message")(payload, { url: panelUrl }, resolve), true);
  });
  return {
    calls, events, storage,
    prepare: (theme = "dark", lang = "") => message({ type: "prepare", theme, ...(lang ? { lang } : {}) }),
    relationshipStatus: async () => (await message({ type: "relationships-get" })).state,
    begin: () => message({ type: "relationships-begin" }),
    cancel: () => message({ type: "relationships-cancel" }),
    save: (lists) => message({ type: "relationships-save", startedAt: now, accountId: "123", handle: "Owner", ...lists }),
    setIgnored: (userId, ignored) => message({ type: "relationships-ignore", accountId: "123", userId, ignored }),
    setAccount: (id) => { accountId = id; },
    setTime: (iso) => { now = Date.parse(iso); },
  };
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

test("侧栏准备时把 X 文档请求的语言头设为所选语言", async () => {
  const b = background();
  assert.equal((await b.prepare("dark", "zh-CN")).ok, true);
  const rule = b.calls.filter((call) => call.type === "rules").at(-1).addRules[0];
  assert.deepEqual(rule.action.requestHeaders, [
    { header: "accept-language", operation: "set", value: "zh-CN" },
    { header: "x-twitter-client-language", operation: "set", value: "zh-cn" },
  ]);
  assert.deepEqual(rule.condition.requestDomains, ["x.com", "twitter.com", "api.x.com"]);
  assert.deepEqual(rule.condition.resourceTypes, ["sub_frame", "xmlhttprequest"]);
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

const relationshipKey = "x-api-relationships:123";
const alice = { id: "1", handle: "Alice" };
const bob = { id: "2", handle: "Bob" };

test("只读取同步页的名单响应，额度不足或 429 时按 X 响应头等待", () => {
  const b = background();
  const now = Date.parse("2026-11-17T15:30:00Z");
  const reset = now + 120000;
  const updates = [];
  let disconnect;
  b.events.get("connect")({
    name: "relationships-rate",
    sender: { documentId: "reader", url: "https://x.com/Owner/followers#x-relationships-11111111-1111-1111-1111-111111111111" },
    postMessage: ({ holdUntil }) => updates.push(holdUntil),
    onDisconnect: { addListener: (callback) => { disconnect = callback; } },
  });
  const response = {
    documentId: "reader", method: "GET", url: "https://api.x.com/graphql/fake/Followers", statusCode: 200,
    responseHeaders: [
      { name: "X-Rate-Limit-Remaining", value: "2" },
      { name: "x-rate-limit-reset", value: String(reset / 1000) },
    ],
  };
  const receive = b.events.get("headers");
  receive({ ...response, documentId: "normal-tab" });
  receive({ ...response, url: "https://api.x.com/graphql/fake/Following" });
  assert.deepEqual(updates, []);
  receive(response);
  receive({ ...response, statusCode: 429, responseHeaders: [{ name: "Retry-After", value: "30" }] });
  receive({ ...response, statusCode: 429, responseHeaders: [] });
  disconnect();
  receive(response);
  assert.deepEqual(updates, [reset + 1000, now + 31000, now + 60000]);
});

test("网页同步按 X 账号保存，失败或换号时保留已同步名单", async () => {
  const b = background();
  assert.equal((await b.relationshipStatus()).snapshot, undefined);
  assert.equal((await b.save({ following: [alice], followers: [bob] })).ok, true);
  const saved = b.storage.get(relationshipKey);
  assert.deepEqual(saved.snapshot.unreturned, [{ ...alice, since: saved.snapshot.day }]);

  assert.match((await b.save({ following: [alice, alice], followers: [] })).error, /incomplete-list/);
  assert.match((await b.save({ following: [], followers: [], startedAt: saved.snapshot.syncedAt - 1 })).error, /other-panel/);
  b.setAccount("999");
  assert.equal((await b.relationshipStatus()).snapshot, undefined);
  assert.match((await b.save({ following: [], followers: [] })).error, /account-changed/);
  b.setAccount(undefined);
  assert.equal((await b.relationshipStatus()).accountId, undefined);
  assert.equal(b.storage.get(relationshipKey), saved);
});

test("首次网页同步使用网页粉丝名单建立取关基线并保留已有未回关天数", async () => {
  const b = background();
  const earlierDay = Date.parse("2026-11-16T00:00:00Z") / 86400000;
  const previous = { day: earlierDay, following: 1, followers: 1, unreturned: 1 };
  b.storage.set(relationshipKey, {
    snapshot: { day: earlierDay, followerAccounts: [bob], unreturned: [{ ...alice, since: earlierDay }] },
    history: [previous],
  });
  await b.save({ following: [alice, { ...bob, followsYou: true }], followers: [] });
  const data = b.storage.get(relationshipKey);
  assert.deepEqual(data.snapshot.unreturned, [{ ...alice, since: earlierDay }]);
  assert.deepEqual(data.snapshot.unfollowed, []);
  assert.deepEqual(data.history[1], previous);
});

test("按粉丝 ID 记录取关日期，改名仍可匹配，重新关注后移出名单", async () => {
  const b = background();
  const renamedBob = { ...bob, handle: "BobNew" };
  await b.save({ following: [alice, bob], followers: [alice, bob] });
  const snapshot = () => b.storage.get(relationshipKey).snapshot;
  const day = snapshot().day;
  assert.deepEqual(snapshot().unfollowed, []);

  b.setTime("2026-11-17T16:05:00Z");
  await b.save({ following: [alice, renamedBob], followers: [renamedBob] });
  assert.deepEqual(snapshot().unfollowed, [{ ...alice, detectedDay: day + 1 }]);
  assert.deepEqual(snapshot().unreturned, [{ ...alice, since: day + 1 }]);

  b.setTime("2026-11-18T16:05:00Z");
  await b.save({ following: [alice, renamedBob], followers: [renamedBob] });
  assert.deepEqual(snapshot().unfollowed, [{ ...alice, detectedDay: day + 1 }]);
  await b.save({ following: [alice, renamedBob], followers: [alice, renamedBob] });
  assert.deepEqual(snapshot().unfollowed, []);

  const beforeEmpty = b.storage.get(relationshipKey);
  assert.match((await b.save({ following: [alice, renamedBob], followers: [] })).error, /incomplete-list/);
  assert.deepEqual(b.storage.get(relationshipKey).snapshot, beforeEmpty.snapshot);
  assert.equal(b.storage.get(relationshipKey).history.length, 3);
});

test("粉丝分页失败时保存实际读取人数，等完整同步再判断新增取关", async () => {
  const b = background();
  const cara = { id: "3", handle: "Cara" };
  await b.save({ following: [alice], followers: [alice, bob] });
  await b.save({ following: [{ ...alice, followsYou: true }], followers: [cara], partialFollowers: true });

  const partial = b.storage.get(relationshipKey);
  assert.equal(partial.history[0].followers, 1);
  assert.equal(partial.snapshot.partialFollowers, true);
  assert.deepEqual(partial.snapshot.unfollowed, []);
  assert.deepEqual(partial.snapshot.unreturned, []);
  assert.deepEqual(partial.snapshot.followerAccounts, [alice, bob, cara]);

  assert.match((await b.save({ following: [], followers: [], partialFollowers: true })).error, /incomplete-list/);
  assert.deepEqual(b.storage.get(relationshipKey), partial);
  await b.save({ following: [alice], followers: [bob, cara] });
  const completed = b.storage.get(relationshipKey);
  assert.equal(completed.snapshot.partialFollowers, false);
  assert.deepEqual(completed.snapshot.unfollowed, [{ ...alice, detectedDay: completed.snapshot.day }]);
});

test("按 X 账号保存忽略名单，同步和改名后可按原用户 ID 取消忽略", async () => {
  const b = background();
  assert.deepEqual(Array.from((await b.relationshipStatus()).ignored), []);
  await b.save({ following: [alice, bob], followers: [alice, bob] });
  await b.save({ following: [alice, bob], followers: [{ id: "9", handle: "Zed" }] });
  const recorded = b.storage.get(relationshipKey);

  const updates = await Promise.all([b.setIgnored(alice.id, true), b.setIgnored(bob.id, true)]);
  assert.ok(updates.every(({ ok }) => ok));
  assert.deepEqual((await b.relationshipStatus()).ignored, [alice, bob]);
  assert.deepEqual(b.storage.get(relationshipKey).snapshot, recorded.snapshot);
  assert.deepEqual(b.storage.get(relationshipKey).history, recorded.history);

  const renamed = { ...alice, handle: "AliceNew" };
  await b.save({ following: [renamed, bob], followers: [{ id: "9", handle: "Zed" }] });
  assert.deepEqual((await b.relationshipStatus()).ignored, [renamed, bob]);
  b.setAccount("999");
  assert.equal((await b.relationshipStatus()).ignored.length, 0);
  assert.match((await b.setIgnored(alice.id, false)).error, /account-changed/);

  b.setAccount("123");
  assert.equal((await b.setIgnored(alice.id, false)).ok, true);
  const restored = await b.relationshipStatus();
  assert.deepEqual(restored.ignored, [bob]);
  assert.ok(restored.snapshot.unreturned.some(({ id }) => id === alice.id));
  assert.ok(restored.snapshot.unfollowed.some(({ id }) => id === alice.id));
});

test("昵称随名单保存，取关后保留最近读到的昵称，旧记录允许只含用户名", async () => {
  const b = background();
  const named = { ...alice, displayName: "爱丽丝 🦊" };
  await b.save({ following: [bob], followers: [named] });
  assert.deepEqual(b.storage.get(relationshipKey).snapshot.followerAccounts, [named]);

  await b.save({ following: [alice, bob], followers: [{ id: "9", handle: "Zed" }] });
  let state = await b.relationshipStatus();
  assert.deepEqual(state.snapshot.unfollowed, [{ ...named, detectedDay: state.snapshot.day }]);
  assert.deepEqual(state.snapshot.unreturned, [
    { ...named, since: state.snapshot.day }, { ...bob, since: state.snapshot.day },
  ]);
  await b.setIgnored(alice.id, true);
  assert.deepEqual((await b.relationshipStatus()).ignored, [named]);

  const updated = { ...alice, handle: "AliceNew", displayName: "Alice · 更新" };
  await b.save({ following: [updated, bob], followers: [{ id: "9", handle: "Zed" }] });
  state = await b.relationshipStatus();
  assert.deepEqual(state.ignored, [updated]);
  assert.deepEqual(state.snapshot.unfollowed, [{ ...updated, detectedDay: state.snapshot.day }]);
});

test("同一账号两次同步至少间隔一小时", async () => {
  const b = background();
  assert.equal((await b.begin()).ok, true);
  assert.equal((await b.begin()).ok, true);
  assert.match((await b.save({ following: [alice, alice], followers: [] })).error, /incomplete-list/);
  assert.equal((await b.begin()).ok, true);

  assert.equal((await b.save({ following: [alice], followers: [bob], partialFollowers: true })).ok, true);
  assert.equal(b.storage.get(relationshipKey).lastCompleteSyncAt, undefined);
  assert.equal((await b.begin()).ok, true);

  assert.equal((await b.save({ following: [alice], followers: [bob] })).ok, true);
  const readyAt = (await b.relationshipStatus()).syncReadyAt;
  assert.equal(readyAt, b.storage.get(relationshipKey).lastCompleteSyncAt + 60 * 60 * 1000);
  assert.equal((await b.begin()).error, "sync-wait");
  assert.equal((await b.save({ following: [alice], followers: [bob], partialFollowers: true })).ok, true);
  assert.equal((await b.relationshipStatus()).syncReadyAt, readyAt);

  b.setTime("2026-11-17T16:30:00Z");
  assert.equal((await b.begin()).ok, true);

  const recent = background();
  recent.storage.set(relationshipKey, {
    snapshot: { syncedAt: Date.parse("2026-11-17T15:00:00Z"), followerAccounts: [bob], source: "web" },
    history: [{ day: 1, following: 1, followers: 1, unreturned: 0 }],
  });
  assert.equal((await recent.begin()).error, "sync-wait");
  assert.equal((await recent.cancel()).ok, true);
  assert.equal(recent.storage.get(relationshipKey).syncStartedAt, undefined);
  assert.equal((await recent.begin()).error, "sync-wait");

  const unread = background();
  unread.storage.set(relationshipKey, {
    snapshot: { syncedAt: Date.parse("2026-11-17T15:00:00Z"), followerAccounts: [], source: "web" },
    history: [{ day: 1, following: 1, followers: 0, unreturned: 0 }],
  });
  assert.equal((await unread.begin()).ok, true);
  recent.setAccount("");
  assert.equal((await recent.begin()).error, "sign-in");
});
