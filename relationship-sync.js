const RELATIONSHIP_DAY_MS = 86400000;
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

function relationshipDay(timestamp) {
  return Math.floor((timestamp + 8 * 60 * 60 * 1000) / RELATIONSHIP_DAY_MS);
}

function relationshipKey(accountId) {
  // Reuse the account-specific snapshots saved by the earlier API version.
  return "x-api-relationships:" + accountId;
}

async function readRelationships(accountId) {
  const key = relationshipKey(accountId);
  return (await chrome.storage.local.get(key))[key] || {};
}

async function relationshipAccountId() {
  const cookies = await chrome.cookies.getAll({ url: "https://x.com/", name: "twid" });
  const value = cookies.find((cookie) => !cookie.partitionKey)?.value;
  return value?.match(/^u(?:=|%3d)(\d{1,20})$/i)?.[1];
}

function knownFollowerCount(data) {
  return Math.max(data?.history?.[0]?.followers || 0, data?.snapshot?.followerAccounts?.length || 0);
}

function syncReadyAt(data) {
  const completed = Number(data?.lastCompleteSyncAt);
  if (Number.isFinite(completed) && completed > 0) return completed + SYNC_INTERVAL_MS;
  // 旧记录没有完成时间。只对确实读到粉丝的完整同步计冷却，失败或半成品不算。
  if (data?.snapshot?.partialFollowers || knownFollowerCount(data) === 0) return 0;
  const synced = Number(data?.snapshot?.syncedAt);
  return Number.isFinite(synced) && synced > 0 ? synced + SYNC_INTERVAL_MS : 0;
}

async function relationshipStatus() {
  const accountId = await relationshipAccountId();
  const data = accountId ? await readRelationships(accountId) : {};
  return {
    accountId,
    snapshot: data.snapshot,
    history: data.history,
    ignored: data.ignored ?? [],
    syncReadyAt: syncReadyAt(data),
  };
}

async function beginRelationshipSync() {
  const accountId = await relationshipAccountId();
  if (!accountId) throw new Error("sign-in");
  const data = await readRelationships(accountId);
  if (syncReadyAt(data) > Date.now()) throw new Error("sync-wait");
  return { accountId, syncReadyAt: syncReadyAt(data) };
}

async function cancelRelationshipSync() {
  const accountId = await relationshipAccountId();
  if (!accountId) return;
  const data = await readRelationships(accountId);
  if (!Object.hasOwn(data, "syncStartedAt")) return;
  delete data.syncStartedAt;
  await chrome.storage.local.set({ [relationshipKey(accountId)]: data });
}

function relationshipProfile({ id, handle, displayName }, previousName) {
  const name = (typeof displayName === "string" && displayName.trim()) || previousName;
  return name ? { id, handle, displayName: name } : { id, handle };
}

async function setRelationshipIgnored({ accountId, userId, ignored }) {
  if (!accountId || accountId !== await relationshipAccountId()) {
    throw new Error("account-changed");
  }
  if (typeof userId !== "string" || !/^\d{1,20}$/.test(userId) || typeof ignored !== "boolean") {
    throw new Error("unknown-user");
  }

  const data = await readRelationships(accountId);
  const users = new Map((data.ignored ?? []).map((user) => [user.id, user]));
  if (ignored) {
    const user = data.snapshot?.unreturned?.find(({ id }) => id === userId)
      ?? data.snapshot?.unfollowed?.find(({ id }) => id === userId)
      ?? users.get(userId);
    if (!user) throw new Error("user-missing");
    users.set(userId, relationshipProfile(user, users.get(userId)?.displayName));
  } else {
    users.delete(userId);
  }

  await chrome.storage.local.set({ [relationshipKey(accountId)]: { ...data, ignored: [...users.values()] } });
  chrome.runtime.sendMessage({ type: "relationships-updated" }).catch(() => {});
}

function buildRelationshipSnapshot(previous, lists, syncedAt) {
  const day = relationshipDay(syncedAt);
  const { handle, following, followers, partialFollowers } = lists;
  const followerIds = new Set(followers.map((user) => user.id));
  for (const user of following) {
    if (user.followsYou) followerIds.add(user.id);
  }
  const previousSnapshot = previous.snapshot;
  const previousFollowers = previousSnapshot?.source === "web" ? previousSnapshot.followerAccounts ?? [] : [];
  const profiles = new Map();
  for (const group of [previousSnapshot?.unfollowed, previousFollowers, previous.ignored, previousSnapshot?.unreturned, followers, following]) {
    for (const user of group ?? []) {
      profiles.set(user.id, relationshipProfile(user, profiles.get(user.id)?.displayName));
    }
  }
  const previousSince = new Map(
    (previousSnapshot?.unreturned ?? []).map((user) => [user.id, user.since])
  );
  const unreturned = following
    .filter((user) => !followerIds.has(user.id))
    .map(({ id }) => ({
      ...profiles.get(id),
      since: previousSince.get(id) ?? day,
    }))
    .sort((a, b) => a.since - b.since || a.handle.localeCompare(b.handle));
  const unfollowed = [
    ...(previousSnapshot?.unfollowed ?? []).filter((user) => !followerIds.has(user.id)),
    ...(partialFollowers ? [] : previousFollowers)
      .filter((user) => !followerIds.has(user.id))
      .map(({ id }) => ({ id, detectedDay: day })),
  ].map(({ id, detectedDay }) => ({ ...profiles.get(id), detectedDay }))
    .sort((a, b) => b.detectedDay - a.detectedDay || a.handle.localeCompare(b.handle));
  // Retain confirmed followers across incomplete scans for the next complete comparison.
  const knownFollowers = new Set((partialFollowers ? previousFollowers : []).map(({ id }) => id));
  for (const { id } of followers) knownFollowers.add(id);
  const record = { day, following: following.length, followers: followers.length, unreturned: unreturned.length };
  return {
    ignored: (previous.ignored ?? []).map(({ id }) => profiles.get(id)),
    snapshot: {
      day, syncedAt, handle, unreturned, unfollowed, partialFollowers, source: "web",
      followerAccounts: Array.from(knownFollowers, (id) => profiles.get(id)),
    },
    history: [record, ...(previous.history || []).filter((entry) => entry.day !== day)],
  };
}

async function saveRelationships({ accountId, startedAt, handle, following, followers, partialFollowers = false }) {
  if (!accountId || accountId !== await relationshipAccountId()) {
    throw new Error("account-changed-sync");
  }
  const isHandle = (value) => typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value);
  const isList = (list) => Array.isArray(list) && list.every((user) =>
    typeof user?.id === "string" && /^\d{1,20}$/.test(user.id) && isHandle(user.handle)
  ) && new Set(list.map((user) => user.id)).size === list.length;
  if (!Number.isFinite(startedAt) || !isHandle(handle) || !isList(following) || !isList(followers)
      || typeof partialFollowers !== "boolean" || (partialFollowers && !followers.length)) {
    throw new Error("incomplete-list");
  }
  const previous = await readRelationships(accountId);
  if (previous.snapshot?.syncedAt > startedAt) {
    throw new Error("other-panel");
  }
  const previousFollowers = previous.snapshot?.source === "web" ? previous.snapshot.followerAccounts ?? [] : [];
  if (!partialFollowers && followers.length === 0 && previousFollowers.length > 0) {
    throw new Error("incomplete-list");
  }
  const data = buildRelationshipSnapshot(previous, { handle, following, followers, partialFollowers }, Date.now());
  if (previous.lastCompleteSyncAt) data.lastCompleteSyncAt = previous.lastCompleteSyncAt;
  if (!partialFollowers) data.lastCompleteSyncAt = Date.now();
  await chrome.storage.local.set({ [relationshipKey(accountId)]: data });
  chrome.runtime.sendMessage({ type: "relationships-updated" }).catch(() => {});
}
