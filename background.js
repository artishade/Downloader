/* Universal Media Downloader — background service worker (MV3) */

/* Guard against duplicate installs (MV3 workers can double-load). */
if (self.__umdLoaded) {
  throw new Error("already loaded");
}
self.__umdLoaded = true;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "download") {
    (async () => {
      try {
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error("download timeout")), 20000)
        );
        await Promise.race([
          chrome.downloads.download({ url: msg.url, filename: sanitize(msg.filename) }),
          timeout,
        ]);
        sendResponse({ ok: true });
      } catch (e) {
        console.warn("download failed:", e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open for async response
  }
});

function sanitize(name) {
  let s = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  if (!s) s = "media-file";
  return s;
}
