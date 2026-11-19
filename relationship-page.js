(() => {
  const panelOrigin = chrome.runtime.getURL("").slice(0, -1);
  const job = location.hash.match(/^#x-relationships-([0-9a-f-]{36})$/)?.[1];
  if (!job || location.ancestorOrigins[0] !== panelOrigin) return;

  const retryDelays = [1500, 3500, 7000];
  function pageError(code, extra = {}) {
    const error = new Error(code);
    error.i18nCode = code;
    if (extra.count != null) error.i18nCount = extra.count;
    if (extra.cause) error.cause = extra.cause;
    return error;
  }
  const primary = () => document.querySelector('[data-testid="primaryColumn"]');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (data) => parent.postMessage({ type: "x-relationships-page", job, ...data }, panelOrigin);

  function profileHandle(href) {
    if (!href) return undefined;
    const url = new URL(href, location.origin);
    return url.origin === location.origin ? url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1] : undefined;
  }

  function checkSignIn() {
    if (/^\/(?:login|account\/access|i\/flow\/)/.test(location.pathname)) throw pageError("sign-in");
  }

  function findRetry(area) {
    return [...(area?.querySelectorAll('button, [role="button"]') ?? [])].find((button) =>
      !button.closest('[data-testid="UserCell"]') &&
      /^(retry|try again|重试|再试一次|重試|再試一次)$/i.test(button.textContent.trim())
    );
  }

  async function waitForPage(read) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      checkSignIn();
      const result = read();
      if (result) return result;
      const area = primary();
      if (findRetry(area) || area?.querySelector('[data-testid="error-detail"]')) {
        throw pageError("page-load-failed");
      }
      await wait(200);
    }
    throw pageError("page-not-ready");
  }

  function readDisplayName(cell, handle) {
    const identity = cell.querySelector('[data-testid="User-Name"]');
    const username = handle.toLowerCase();
    const links = identity?.matches('a[href]') ? [identity] : (identity ?? cell).querySelectorAll('a[href]');
    for (const link of links) {
      if (link.origin !== location.origin || link.pathname.replace(/\/$/, "").toLowerCase() !== `/${username}`) continue;
      const label = link.querySelector('span') ?? link;
      let text = label.textContent;
      if ((identity || label !== link) && label.querySelector('img[alt]')) {
        const copy = label.cloneNode(true);
        for (const img of copy.querySelectorAll('img[alt]')) img.replaceWith(img.alt);
        text = copy.textContent;
      }
      const name = text.replace(/\s+/g, " ").trim();
      if (name && name.toLowerCase() !== `@${username}`) return name;
    }
  }

  function readUser(cell) {
    const button = cell.querySelector('button[data-testid$="-follow"], button[data-testid$="-unfollow"], [role="button"][data-testid$="-follow"], [role="button"][data-testid$="-unfollow"]');
    const id = button?.dataset.testid.match(/^(\d{1,20})-(?:un)?follow$/)?.[1];
    const handle = button?.getAttribute("aria-label")?.match(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)?.at(-1).slice(1)
      || [...cell.querySelectorAll('a[href^="/"]')].map((link) => profileHandle(link.getAttribute("href"))).find(Boolean);
    if (!id || !handle) return undefined;
    const followsYou = Boolean(cell.querySelector('[data-testid="userFollowIndicator"]'));
    return { id, handle, followsYou, displayName: readDisplayName(cell, handle) };
  }

  async function readList() {
    const users = new Map();
    const startedAt = Date.now();
    let lastProgress = startedAt;
    let bottomSince;
    let emptySince;
    let previousHeight;
    let retries = 0;
    let pausedMs = 0;
    let holdUntil = 0;
    let nextScrollAt = 0;
    let ratePort;
    function connectRateReader() {
      if (ratePort) return;
      ratePort = chrome.runtime.connect({ name: "relationships-rate" });
      ratePort.onMessage.addListener((message) => {
        holdUntil = Math.max(holdUntil, message.holdUntil);
        nextScrollAt = Date.now() + 900;
      });
      ratePort.onDisconnect.addListener(() => { ratePort = undefined; });
    }

    while (Date.now() - startedAt - pausedMs < 480000) {
      checkSignIn();
      connectRateReader();
      const area = primary();
      const timeline = area?.querySelector('section[role="region"], [role="region"]') ?? area;
      const scroller = document.scrollingElement;
      const cells = [...(timeline?.querySelectorAll('[data-testid="UserCell"]') ?? [])];
      const before = users.size;
      let unreadable = false;
      for (const cell of cells) {
        const user = readUser(cell);
        if (user) {
          user.displayName ??= users.get(user.id)?.displayName;
          users.set(user.id, user);
        }
        else unreadable = true;
      }
      const now = Date.now();
      if (users.size !== before) {
        retries = 0;
        send({ count: users.size });
      }
      if (users.size !== before || previousHeight !== scroller?.scrollHeight) {
        lastProgress = now;
        bottomSince = undefined;
        previousHeight = scroller?.scrollHeight;
      }
      if (holdUntil > now) {
        send({ count: users.size, holdUntil });
        await wait(holdUntil - now);
        lastProgress = Date.now();
        pausedMs += lastProgress - now;
        bottomSince = undefined;
        if (holdUntil <= lastProgress) send({ count: users.size });
        continue;
      }
      const retry = findRetry(area);
      if (retry || area?.querySelector('[data-testid="error-detail"]')) {
        bottomSince = undefined;
        if (retries === retryDelays.length) {
          throw pageError("list-load-failed", { count: users.size, cause: "list-load" });
        }
        await wait(retryDelays[retries]);
        checkSignIn();
        if (holdUntil > Date.now()) continue;
        const currentArea = primary();
        const currentRetry = findRetry(currentArea);
        if (currentRetry || currentArea?.querySelector('[data-testid="error-detail"]')) {
          retries++;
          const checkpoint = /\/followers\/?$/.test(location.pathname) ? [...users.values()] : undefined;
          send({ count: users.size, retry: retries, checkpoint });
          if (currentRetry) currentRetry.click();
          else location.reload();
          await wait(800);
        }
        lastProgress = Date.now();
        continue;
      }
      const loading = area?.querySelector('[role="progressbar"], [aria-busy="true"]');
      const empty = !cells.length && !users.size && area?.querySelector('[data-testid^="emptyState"], [data-testid^="empty_state_"]');
      // 页面刚打开时可能先出现空状态，停几秒再确认，避免没读粉丝就结束。
      if (empty && !loading) {
        emptySince ??= now;
        if (now - emptySince >= 6500) return [];
      } else {
        emptySince = undefined;
      }
      if (scroller && users.size && !unreadable) {
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 3;
        if (atBottom && !loading) {
          bottomSince ??= now;
          if (now - bottomSince >= 6500) return [...users.values()];
        } else if (now >= nextScrollAt) {
          bottomSince = undefined;
          const top = scroller.scrollTop;
          window.scrollBy({ top: Math.max(100, Math.floor(scroller.clientHeight * 0.75)), behavior: "instant" });
          if (scroller.scrollTop !== top) lastProgress = now;
        }
      }
      if (now - lastProgress >= 15000) {
        throw pageError(unreadable ? "unreadable-card" : "list-timeout", { count: users.size });
      }
      await wait(180);
    }
    throw pageError("list-too-long");
  }

  async function read() {
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/home") {
      return waitForPage(() => profileHandle(document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href")));
    }
    if (/^\/[A-Za-z0-9_]{1,15}\/(?:following|followers)$/.test(path)) return readList();
    checkSignIn();
    throw pageError("unexpected-page");
  }

  send({ ready: true });
  read().then((value) => send({ value }), (error) => send({
    error: error.i18nCode || error.message,
    count: error.i18nCount,
    listLoadFailed: error.cause === "list-load",
  }));
})();
