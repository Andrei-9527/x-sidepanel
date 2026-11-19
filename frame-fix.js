(() => {
  const panelOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
  if (window.location.ancestorOrigins[0] !== panelOrigin) {
    return;
  }

  const applyViewport = () => {
    const width = Math.max(
      window.innerWidth || 0,
      document.documentElement?.clientWidth || 0,
      360
    );
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      const root = document.head || document.documentElement;
      if (!root) {
        return;
      }
      root.appendChild(meta);
    }
    meta.setAttribute(
      "content",
      `width=${width}, initial-scale=1, viewport-fit=cover`
    );
  };

  const notifyPanel = () => {
    if (document.getElementById("react-root")) {
      window.parent.postMessage(
        { type: "x-panel-ready", url: window.location.href, lang: document.documentElement.lang },
        panelOrigin
      );
    }
  };

  applyViewport();
  window.addEventListener("resize", applyViewport);
  document.addEventListener("DOMContentLoaded", () => {
    applyViewport();
    notifyPanel();
  }, { once: true });
  // X 通过站内导航更新地址，切换主题时仍应留在正在看的页面。
  window.navigation?.addEventListener("navigatesuccess", notifyPanel);
})();
