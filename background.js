/* Universal Media Downloader — background service worker (MV3) */

/* Guard against duplicate installs (MV3 workers can double-load). */
if (self.__umdLoaded) {
  throw new Error("already loaded");
}
self.__umdLoaded = true;

const THUMB_TIMEOUT_MS = 8000;
const MAX_THUMB_BYTES = 6 * 1024 * 1024; // hard cap for raw image bytes

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

  if (msg.type === "thumb") {
    fetchThumb(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

function sanitize(name) {
  let s = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  if (!s) s = "media-file";
  return s;
}

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/*                                                                     */
/* Some hosts (Google apps among them) refuse direct cross-site        */
/* <img> loads from extension pages. The service worker, however, has  */
/* host permissions for <all_urls> and can fetch the bytes; a data URL */
/* always renders in the popup.                                        */
/* ------------------------------------------------------------------ */

/* Ask Google usercontent hosts for a small preview variant instead of
 * the full-size original (the download always uses the original URL). */
function smallImageVariant(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)googleusercontent\.com$/i.test(u.hostname)) return url;
    if (/=[^/]*$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/=[^/]*$/, "=s256-c");
    } else {
      u.pathname += "=s256";
    }
    return u.toString();
  } catch {
    return url;
  }
}

function toDataUrl(buf, mime) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || "image/png"};base64,${btoa(bin)}`;
}

/* Big images are downscaled to <=512px so the popup stays snappy. */
async function blobToThumbDataUrl(blob) {
  if (blob.size <= 400 * 1024) {
    return toDataUrl(await blob.arrayBuffer(), blob.type);
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const small = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return toDataUrl(await small.arrayBuffer(), "image/jpeg");
  } catch {
    if (blob.size > MAX_THUMB_BYTES) return null;
    return toDataUrl(await blob.arrayBuffer(), blob.type);
  }
}

async function fetchThumb(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), THUMB_TIMEOUT_MS);
  try {
    const res = await fetch(smallImageVariant(url), {
      credentials: "include",
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const blob = await res.blob();
    if (!/^image\//i.test(blob.type)) return { ok: false, error: "not an image" };
    const dataUrl = await blobToThumbDataUrl(blob);
    if (!dataUrl) return { ok: false, error: "image too large" };
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
