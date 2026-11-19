importScripts("relationship-sync.js", "relationship-rate.js");

const FRAME_DOMAINS = ["x.com", "twitter.com"];
const FRAME_RULE_ID = 1;
const NAV_RULE_ID = 2;
const FETCH_SITE_RULE_ID = 3;
const API_SITE_RULE_ID = 4;
const CSRF_RULE_ID = 1000;
const LANG_RULE_ID = 5;

function frameRule() {
  return {
    id: FRAME_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
        { header: "cross-origin-resource-policy", operation: "remove" },
        { header: "cross-origin-opener-policy", operation: "remove" },
        { header: "cross-origin-embedder-policy", operation: "remove" },
      ],
    },
    condition: {
      topDomains: [chrome.runtime.id],
      requestDomains: FRAME_DOMAINS,
      resourceTypes: ["sub_frame"],
    },
  };
}

function navigationRule() {
  return {
    id: NAV_RULE_ID,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "sec-fetch-dest", operation: "set", value: "document" },
        { header: "sec-fetch-mode", operation: "set", value: "navigate" },
        { header: "sec-fetch-site", operation: "set", value: "none" },
        { header: "sec-fetch-user", operation: "set", value: "?1" },
      ],
    },
    condition: {
      topDomains: [chrome.runtime.id],
      requestDomains: FRAME_DOMAINS,
      resourceTypes: ["sub_frame"],
    },
  };
}

function panelFetchRule(id, requestDomains, site, excludedRequestDomains) {
  const condition = {
    topDomains: [chrome.runtime.id],
    excludedInitiatorDomains: [chrome.runtime.id],
    requestDomains,
    resourceTypes: ["xmlhttprequest"],
  };
  if (excludedRequestDomains) {
    condition.excludedRequestDomains = excludedRequestDomains;
  }
  return {
    id,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "sec-fetch-dest", operation: "set", value: "empty" },
        { header: "sec-fetch-mode", operation: "set", value: "cors" },
        { header: "sec-fetch-site", operation: "set", value: site },
      ],
    },
    condition,
  };
}

async function readCt0() {
  const all = await chrome.cookies.getAll({ name: "ct0", domain: "x.com" });
  const matches = all.filter((cookie) => cookie.domain.replace(/^\./, "") === "x.com");
  const primary = matches.find((cookie) => !cookie.partitionKey) || matches[0];
  return primary?.value || "";
}

async function registerFrameRules() {
  const ids = [FRAME_RULE_ID, NAV_RULE_ID, FETCH_SITE_RULE_ID, API_SITE_RULE_ID];
  const rules = [
    frameRule(),
    navigationRule(),
    panelFetchRule(FETCH_SITE_RULE_ID, FRAME_DOMAINS, "same-origin", ["api.x.com"]),
    panelFetchRule(API_SITE_RULE_ID, ["api.x.com"], "same-site"),
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ids,
    addRules: rules,
  });
}

async function registerCsrfRule() {
  const ct0 = await readCt0();
  if (!ct0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CSRF_RULE_ID],
    });
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CSRF_RULE_ID],
    addRules: [
      {
        id: CSRF_RULE_ID,
        priority: 3,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "x-csrf-token", operation: "set", value: ct0 }],
        },
        condition: {
          topDomains: [chrome.runtime.id],
          excludedInitiatorDomains: [chrome.runtime.id],
          requestDomains: ["x.com"],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  });
}

let pending = Promise.resolve();

function enqueue(task) {
  pending = pending.then(task, task);
  return pending;
}

async function applySiteTheme(theme) {
  // X 使用 night_mode=0/2 分别表示原生日间/纯黑夜间主题。
  for (const domain of FRAME_DOMAINS) {
    await chrome.cookies.set({
      url: `https://${domain}/`,
      name: "night_mode",
      value: theme === "light" ? "0" : "2",
      domain: `.${domain}`,
      path: "/",
      secure: true,
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
  }
}

function removeSiteWorkerRegistrations(origins) {
  // Service Worker 缓存返回的响应不会经过 DNR。
  return chrome.browsingData.remove(
    { origins, originTypes: { unprotectedWeb: true, protectedWeb: true } },
    { serviceWorkers: true }
  );
}

function languageRule(locale) {
  return {
    id: LANG_RULE_ID,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "accept-language", operation: "set", value: locale },
        { header: "x-twitter-client-language", operation: "set", value: locale.toLowerCase() },
      ],
    },
    condition: {
      topDomains: [chrome.runtime.id],
      requestDomains: ["x.com", "twitter.com", "api.x.com"],
      resourceTypes: ["sub_frame", "xmlhttprequest"],
    },
  };
}

async function registerLanguageRule(locale) {
  if (!locale) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [LANG_RULE_ID],
    addRules: [languageRule(locale)],
  });
}

function prepare(forPanel = false, theme = "dark", locale = "") {
  return enqueue(async () => {
    await registerFrameRules();
    await registerCsrfRule();
    await registerLanguageRule(locale);
    if (forPanel) {
      await applySiteTheme(theme);
      await removeSiteWorkerRegistrations(FRAME_DOMAINS.map((domain) => `https://${domain}`));
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  prepare().catch((error) => console.error(error));
});

chrome.runtime.onStartup.addListener(() => {
  prepare().catch((error) => console.error(error));
});

let csrfTimer = 0;
chrome.cookies.onChanged.addListener((change) => {
  const domain = change.cookie?.domain || "";
  if (domain.replace(/^\./, "") !== "x.com" || change.cookie?.name !== "ct0") {
    return;
  }
  clearTimeout(csrfTimer);
  csrfTimer = setTimeout(() => {
    enqueue(registerCsrfRule).catch((error) => console.error(error));
  }, 300);
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.url === chrome.runtime.getURL("sidepanel.html")) {
    if (message?.type === "relationships-get") {
      relationshipStatus()
        .then((state) => sendResponse({ ok: true, state }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "relationships-begin") {
      enqueue(() => beginRelationshipSync())
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "relationships-cancel") {
      enqueue(() => cancelRelationshipSync())
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "relationships-save") {
      enqueue(() => saveRelationships(message))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "relationships-ignore") {
      enqueue(() => setRelationshipIgnored(message))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  }
  if (message?.type !== "prepare") {
    return undefined;
  }

  prepare(true, message.theme, message.lang || "")
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
