(() => {
  const get = (id) => document.getElementById(id);
  const panel = get("relationships");
  const toggle = get("relationships-toggle");
  const home = get("home");
  const sync = get("relationships-sync");
  const status = get("relationships-status");
  const error = get("relationships-error");
  const results = get("relationships-results");
  const minimumDays = get("relationships-days");
  const filter = get("relationships-filter");
  const empty = get("relationships-empty");
  const users = get("relationships-users");
  const history = get("relationships-history");
  const listButtons = panel.querySelectorAll("button[data-list]");
  const listLabels = { unreturned: "notFollowingBack", unfollowed: "unfollowed", ignored: "ignored" };
  const xOrigin = "https://x.com";

  function formatSyncedAt(timestamp) {
    return new Intl.DateTimeFormat(languagePresentation().locale, {
      timeZone: "Asia/Shanghai",
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    }).format(timestamp);
  }

  function dayLabel(days) {
    return t(messageLanguage() === "en" && days === 1 ? "dayCount" : "daysCount", { days });
  }

  function applyStatic() {
    get("relationships-title").textContent = t("relationshipsTitle");
    get("relationships-days-prefix").textContent = t("daysPrefix");
    get("relationships-days-suffix").textContent = t("daysSuffix");
    get("relationships-days-hint").textContent = t("daysHint");
    get("relationships-history-summary").textContent = t("dailyRecords");
    get("relationships-history-table").setAttribute("aria-label", t("dailyTable"));
    get("relationships-col-date").textContent = t("colDate");
    get("relationships-col-following").textContent = t("following");
    get("relationships-col-followers").textContent = t("followers");
    get("relationships-col-unreturned").textContent = t("notFollowingBack");
    get("relationships-counts").setAttribute("aria-label", t("userLists"));
    users.setAttribute("aria-label", t("users"));
    for (const button of listButtons) {
      button.querySelector(".list-label").textContent = t(listLabels[button.dataset.list]);
    }
  }

  let state;
  let list = "unreturned";
  let requestId = 0;
  let action = "";
  let requestError = "";
  let cooldownTimer = 0;

  function formatDay(day) {
    return new Date(day * 86400000).toISOString().slice(0, 10);
  }

  function visibleUsers(key) {
    const ignored = state.ignored ?? [];
    if (key === "ignored") return ignored;
    const ignoredIds = new Set(ignored.map(({ id }) => id));
    return (state.snapshot?.[key] ?? []).filter(({ id }) => !ignoredIds.has(id));
  }

  function renderUsers(snapshot) {
    const isUnreturned = list === "unreturned";
    const isIgnored = list === "ignored";
    const accountId = state.accountId;
    const minDays = Math.max(0, Math.ceil(minimumDays.valueAsNumber || 0));
    filter.hidden = !isUnreturned;
    const rows = document.createDocumentFragment();
    for (const user of visibleUsers(list)) {
      const days = isUnreturned ? snapshot.day - user.since : 0;
      if (isUnreturned && days < minDays) continue;

      const row = document.createElement("li");
      const identity = document.createElement("div");
      identity.className = "relationship-user-identity";
      const link = document.createElement("a");
      link.href = `https://x.com/${encodeURIComponent(user.handle)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = user.displayName || `@${user.handle}`;
      identity.append(link);
      const metadata = document.createElement("div");
      metadata.className = "relationship-user-meta";
      if (user.displayName) {
        const handle = document.createElement("span");
        handle.textContent = `@${user.handle}`;
        metadata.append(handle);
      }
      if (!isIgnored) {
        const detail = document.createElement("span");
        detail.textContent = isUnreturned ? dayLabel(days) : t("foundOn", { date: formatDay(user.detectedDay) });
        metadata.append(detail);
      }
      if (metadata.childElementCount) identity.append(metadata);

      const ignoreButton = document.createElement("button");
      ignoreButton.type = "button";
      ignoreButton.className = "relationship-user-action";
      ignoreButton.textContent = t(isIgnored ? "unignore" : "ignore");
      ignoreButton.setAttribute("aria-label", t("ignoreHandle", { action: ignoreButton.textContent, handle: user.handle }));
      ignoreButton.addEventListener("click", () => changeIgnored(accountId, user.id, !isIgnored, ignoreButton));
      row.append(identity, ignoreButton);
      rows.append(row);
    }
    empty.hidden = rows.childElementCount > 0;
    empty.textContent = t({
      unreturned: "emptyUnreturned",
      unfollowed: "emptyUnfollowed",
      ignored: "emptyIgnored",
    }[list]);
    users.replaceChildren(rows);
  }

  function scheduleCooldown(readyAt) {
    clearTimeout(cooldownTimer);
    const remaining = readyAt - Date.now();
    if (remaining <= 0 || panel.hidden) return;
    const untilNextMinute = remaining % 60000 || 60000;
    cooldownTimer = setTimeout(() => {
      if (!panel.hidden) render();
    }, Math.min(remaining, untilNextMinute));
  }

  function render() {
    const snapshot = state?.snapshot;
    const readyAt = state?.syncReadyAt || 0;
    const cooling = readyAt > Date.now();
    sync.disabled = !state || Boolean(action) || cooling;
    sync.textContent = action ? t("syncing") : cooling
      ? t("syncWait", { minutes: Math.max(1, Math.ceil((readyAt - Date.now()) / 60000)) })
      : t("sync");
    sync.title = cooling ? t("syncWaitTitle") : "";
    if (cooling) scheduleCooldown(readyAt);
    else clearTimeout(cooldownTimer);
    error.textContent = action ? "" : (requestError ? t(requestError) : "");
    error.hidden = !error.textContent;
    results.hidden = !snapshot;

    if (snapshot) {
      const partial = snapshot.partialFollowers ? t("partialNote") : "";
      status.textContent = action || t("lastSync", {
        handle: snapshot.handle,
        time: formatSyncedAt(snapshot.syncedAt),
        partial,
      });
      for (const button of listButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.list === list));
        button.querySelector("b").textContent = visibleUsers(button.dataset.list).length;
      }
      const rows = document.createDocumentFragment();
      for (const record of state.history) {
        const row = document.createElement("tr");
        const dateCell = document.createElement("th");
        dateCell.scope = "row";
        dateCell.textContent = formatDay(record.day);
        row.append(dateCell);
        for (const key of ["following", "followers", "unreturned"]) {
          const cell = document.createElement("td");
          cell.textContent = record[key];
          row.append(cell);
        }
        rows.append(row);
      }
      history.replaceChildren(rows);
      renderUsers(snapshot);
    } else if (action) {
      status.textContent = action;
    } else if (state?.accountId) {
      status.textContent = t("syncPrompt");
    } else if (state) {
      status.textContent = t("signInPrompt");
    } else {
      status.textContent = requestError ? "" : t("readingHistory");
    }
  }

  async function refresh() {
    const id = ++requestId;
    try {
      const response = await chrome.runtime.sendMessage({ type: "relationships-get" });
      if (id !== requestId || panel.hidden) return;
      if (!response?.ok) throw new Error(response?.error || "history-failed");
      state = response.state;
    } catch (cause) {
      if (id !== requestId || panel.hidden) return;
      state = undefined;
      requestError = cause.message;
    }
    render();
  }

  async function changeIgnored(accountId, userId, ignored, button) {
    button.disabled = true;
    requestError = "";
    try {
      const response = await chrome.runtime.sendMessage({ type: "relationships-ignore", accountId, userId, ignored });
      if (!response?.ok) throw new Error(response?.error || "ignore-failed");
    } catch (cause) {
      requestError = cause.message;
    }
    if (!panel.hidden) refresh();
  }

  function show(visible) {
    panel.hidden = !visible;
    get("stage").hidden = visible;
    toggle.setAttribute("aria-pressed", String(visible));
    if (visible) home.removeAttribute("aria-current");
    else home.setAttribute("aria-current", "page");
    document.body.classList.toggle("showing-relationships", visible);
    if (visible) {
      state = undefined;
      requestError = "";
      render();
      refresh();
    }
  }

  toggle.addEventListener("click", () => show(panel.hidden));
  home.addEventListener("click", () => {
    if (!panel.hidden) show(false);
  });
  function readPage(path, label, onCount, allowPartial = false) {
    return new Promise((resolve, reject) => {
      const job = crypto.randomUUID();
      const frame = document.createElement("iframe");
      frame.className = "relationships-scan-frame";
      frame.title = t("readingFrame", { label });
      frame.tabIndex = -1;
      frame.inert = true;
      frame.setAttribute("aria-hidden", "true");
      let receivedReady = false;
      let maxCount = 0;
      let retries = 0;
      let checkpoint = [];
      let deadline = Date.now() + 20000;
      let reportedHoldUntil = 0;
      const finish = (callback, value) => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        frame.remove();
        callback(value);
      };
      const fail = (message, canUseCheckpoint) => {
        if (allowPartial && canUseCheckpoint && checkpoint.length) {
          finish(resolve, { value: checkpoint, partial: true });
        } else {
          finish(reject, new Error(`${label} · ${message}`));
        }
      };
      const receive = (event) => {
        const data = event.data;
        if (event.source !== frame.contentWindow || event.origin !== xOrigin
            || data?.type !== "x-relationships-page" || data.job !== job) return;
        if (data.ready === true) {
          if (!receivedReady && onCount) {
            clearTimeout(timer);
            deadline = Date.now() + 500000;
            timer = setTimeout(timeout, 500000);
          }
          receivedReady = true;
        } else if (typeof data.error === "string") {
          fail(t(data.error, { count: data.count ?? maxCount }), data.listLoadFailed === true);
        }
        else if (Object.hasOwn(data, "value")) finish(resolve, { value: data.value });
        else if (Number.isSafeInteger(data.count)) {
          // X 的重试按钮也可能重载整个 iframe，重试次数随同步任务保留。
          if (data.count > maxCount) {
            maxCount = data.count;
            retries = 0;
          }
          if (allowPartial && Array.isArray(data.checkpoint) && data.checkpoint.length >= checkpoint.length) {
            checkpoint = data.checkpoint;
          }
          const now = Date.now();
          if (Number.isSafeInteger(data.holdUntil) && data.holdUntil > now) {
            const addedWait = data.holdUntil - Math.max(now, reportedHoldUntil);
            if (addedWait > 0) {
              deadline += addedWait;
              reportedHoldUntil = data.holdUntil;
              clearTimeout(timer);
              timer = setTimeout(timeout, deadline - now);
            }
            onCount?.(data.count, undefined, data.holdUntil);
            return;
          }
          if (data.retry && ++retries > 3) {
            fail(t("list-load-failed", { count: maxCount }), true);
          } else {
            onCount?.(data.count, data.retry ? retries : undefined);
          }
        }
      };
      const timeout = () => {
        finish(reject, new Error(`${label} · ${t("page-timeout")}`));
      };
      let timer = setTimeout(timeout, 20000);
      window.addEventListener("message", receive);
      frame.src = `${xOrigin}${path}#x-relationships-${job}`;
      document.body.append(frame);
    });
  }

  async function runSync() {
    if (action || (state?.syncReadyAt || 0) > Date.now()) return;
    action = t("openingPage");
    requestError = "";
    render();
    const startedAt = Date.now();
    let saved = false;
    try {
      const started = await chrome.runtime.sendMessage({ type: "relationships-begin" });
      if (!started?.ok) throw new Error(started?.error || "account-unknown");
      state = { ...(state || {}), accountId: started.accountId };
      const { accountId } = state;
      await prepare();
      const { value: handle } = await readPage("/home", t("loginAccount"));
      if (typeof handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        throw new Error("handle-unknown");
      }
      const path = `/${handle}`;
      const lists = { partialFollowers: false };
      for (const [kind, labelKey] of [["followers", "followers"], ["following", "following"]]) {
        const label = t(labelKey);
        const showCount = (count, retry, holdUntil) => {
          action = holdUntil
            ? t("waitingReset", { label, count, time: formatSyncedAt(holdUntil) })
            : retry
            ? t("retryingList", { label, count, retry })
            : t("readingList", { label, count });
          status.textContent = action;
        };
        showCount(0);
        const { value: entries, partial } = await readPage(`${path}/${kind}`, label, showCount, kind === "followers");
        if (!Array.isArray(entries)) throw new Error(t("listFailed", { label }));
        lists[kind] = entries;
        if (partial) lists.partialFollowers = true;
      }
      const response = await chrome.runtime.sendMessage({
        type: "relationships-save", accountId, startedAt, handle, ...lists,
      });
      if (!response?.ok) throw new Error(response?.error || "save-failed");
      saved = true;
    } catch (cause) {
      requestError = cause.message === "sync-wait" ? "" : cause.message;
    } finally {
      action = "";
      if (!saved) await chrome.runtime.sendMessage({ type: "relationships-cancel" }).catch(() => {});
      if (!panel.hidden) await refresh();
    }
  }
  sync.addEventListener("click", runSync);
  for (const button of listButtons) {
    button.addEventListener("click", () => {
      list = button.dataset.list;
      render();
    });
  }
  minimumDays.addEventListener("input", () => {
    if (state?.snapshot) renderUsers(state.snapshot);
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (!panel.hidden && message?.type === "relationships-updated") {
      refresh();
    }
  });

  function applyPanelLanguage() {
    applyStatic();
    render();
  }
  globalThis.applyPanelLanguage = applyPanelLanguage;
  applyPanelLanguage();
})();
