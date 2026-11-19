const relationshipReaders = new Map();

chrome.runtime.onConnect.addListener((port) => {
  const { documentId, url } = port.sender ?? {};
  const list = url?.match(/^https:\/\/x\.com\/\w{1,15}\/(followers|following)\/?#x-relationships-[0-9a-f-]{36}$/)?.[1];
  if (port.name !== "relationships-rate" || !documentId || !list) return;
  const reader = { port, list };
  relationshipReaders.set(documentId, reader);
  port.onDisconnect.addListener(() => {
    if (relationshipReaders.get(documentId) === reader) relationshipReaders.delete(documentId);
  });
});

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const reader = relationshipReaders.get(details.documentId);
  if (!reader || details.method !== "GET") return;
  const operation = new URL(details.url).pathname.split("/").at(-1)?.toLowerCase();
  if (operation !== reader.list) return;

  const headers = new Map((details.responseHeaders ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
  const limited = details.statusCode === 429;
  const now = Date.now();
  const reset = Number(headers.get("x-rate-limit-reset")) * 1000;
  const retryAfter = headers.get("retry-after") ?? "";
  const retryAt = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const resumeAt = Math.max(Number.isFinite(reset) ? reset : 0, limited && Number.isFinite(retryAt) ? retryAt : 0);
  const remaining = headers.get("x-rate-limit-remaining");
  const nearLimit = remaining != null && /^\d+$/.test(remaining) && Number(remaining) <= 2;
  let holdUntil = 0;
  if ((limited || nearLimit) && resumeAt > now) holdUntil = resumeAt + 1000;
  else if (limited) holdUntil = now + 60000;

  try {
    reader.port.postMessage({ holdUntil });
  } catch {
    relationshipReaders.delete(details.documentId);
  }
}, {
  urls: ["https://api.x.com/graphql/*", "https://x.com/i/api/graphql/*"],
  types: ["xmlhttprequest"],
}, ["responseHeaders"]);
