/* Universal Media Downloader — popup logic (Manifest V3) */

const $ = (sel) => document.querySelector(sel);

const grid = $("#grid");
const empty = $("#empty");
const loading = $("#loading");
const toolbar = $("#toolbar");
const selectAllBtn = $("#selectAll");
const downloadBtn = $("#downloadBtn");
const countPill = $("#countPill");
const pageInfo = $("#pageInfo");

let allItems = []; // { id, type, url, name, ext }
let selected = new Set();
let activeFilter = "all";
let hostname = "";

/* ---------------- Scanning ---------------- */

/* Resolve the tab to scan.
 *
 * Normally that is the active tab of the current window. When the popup is
 * opened as a tab (or the active tab is a browser page), fall back to the
 * most recently accessed http(s) tab so there is always a sensible target.
 */
async function resolveTargetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id && /^https?:/i.test(tab.url || "")) return tab;
  const httpTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  httpTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return httpTabs[0] || tab;
}

async function scanPage() {
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  grid.innerHTML = "";
  allItems = [];
  selected.clear();
  updateDownloadBtn();

  let tab;
  try {
    tab = await resolveTargetTab();
  } catch {
    showErrorState();
    return;
  }

  if (!tab || !tab.id || /^chrome|^edge|^about:|^chrome-extension:/.test(tab.url || "")) {
    pageInfo.textContent = "Browser page (not scannable)";
    showErrorState();
    return;
  }

  hostname = safeHost(tab.url);
  pageInfo.textContent = hostname;
  pageInfo.title = tab.url;

  let results;
  try {
    // Try all frames (iframes) first; falls back to the main frame.
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectMedia,
    });
  } catch {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectMedia,
    });
  }

  // Merge results from every frame, dedupe by type|url, re-number ids.
  const merged = [];
  const seen = new Set();
  for (const frame of results || []) {
    for (const item of frame?.result || []) {
      const key = item.type + "|" + item.url;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  merged.forEach((it, idx) => (it.id = idx + 1));

  allItems = merged;

  if (allItems.length === 0) {
    showEmptyState();
  } else {
    render();
  }

  loading.classList.add("hidden");
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "this page";
  }
}

function showErrorState() {
  loading.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.querySelector("h2").textContent = "Can't scan this page";
  empty.querySelector("p").textContent =
    "Open a normal website tab (http/https), scroll to load media, then reopen this extension.";
  empty.querySelector("#rescan").textContent = "Try again";
}

function showEmptyState() {
  loading.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.querySelector("h2").textContent = "No media found";
  empty.querySelector("p").textContent =
    "This page has no images, videos or audio yet. Try scrolling the page, then reopen the extension.";
  empty.querySelector("#rescan").textContent = "Rescan page";
}

/* Injected into the page (runs in page context, not popup). */
function collectMedia() {
  const found = new Map();
  let id = 0;

  const push = (type, url, el) => {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;
    url = url.trim();
    if (url.startsWith("//")) url = location.protocol + url;
    if (!/^https?:/i.test(url)) return;
    const key = type + "|" + url;
    if (found.has(key)) {
      // keep first element ref for dimension probing
      return;
    }
    found.set(key, {
      id: ++id,
      type,
      url,
      el: el || null,
      w: null,
      h: null,
    });
  };

  // 1. <img>
  document.querySelectorAll("img").forEach((img) => {
    const src = img.currentSrc || img.src;
    if (src) push("image", src, img);
    // data-src / lazy-load variants
    for (const attr of ["data-src", "data-original", "data-lazy-src", "data-echo"]) {
      const v = img.getAttribute(attr);
      if (v) push("image", v, img);
    }
    if (img.srcset) {
      img.srcset
        .split(",")
        .map((s) => s.trim().split(/\s+/)[0])
        .forEach((u) => push("image", u, img));
    }
  });

  // 2. <video> + <source>
  document.querySelectorAll("video").forEach((v) => {
    const src = v.currentSrc || v.src || (v.querySelector("source") || {}).src;
    if (src) push("video", src, v);
    v.querySelectorAll("source").forEach((s) => push("video", s.src, v));
    if (v.poster) push("image", v.poster, v);
  });

  // 3. <audio>
  document.querySelectorAll("audio").forEach((a) => {
    const src = a.currentSrc || a.src || (a.querySelector("source") || {}).src;
    if (src) push("audio", src, a);
    a.querySelectorAll("source").forEach((s) => push("audio", s.src, a));
  });

  // 4. <source> outside media tags
  document.querySelectorAll("source").forEach((s) => {
    if (!s.closest("video, audio") && s.src) {
      const t = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(s.src) ? "video" : "audio";
      push(t, s.src, s);
    }
  });

  // 5. CSS background images (inline styles + stylesheets)
  document.querySelectorAll("*").forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) push("image", m[2], el);
    }
  });

  // 6. <a> that directly links to a media file
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (!href) return;
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(href)) push("image", href, a);
    else if (/\.(mp4|webm|mov|m4v|mkv|avi|flv|wmv|ogv)(\?|$)/i.test(href)) push("video", href, a);
    else if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|wma)(\?|$)/i.test(href)) push("audio", href, a);
  });

  // 7. <embed> / <object>
  document.querySelectorAll("embed, object[data]").forEach((el) => {
    const src = el.src || el.data;
    if (!src) return;
    const t = /\.(mp4|webm|mov|mp3|wav|ogg)(\?|$)/i.test(src) ? "video" : "image";
    push(t, src, el);
  });

  // Strip element refs (they can't be cloned back to the popup) but keep dims.
  return Array.from(found.values()).map((item) => {
    if (item.el) {
      try {
        if (item.type === "image") {
          item.w = item.el.naturalWidth || item.el.width || null;
          item.h = item.el.naturalHeight || item.el.height || null;
        } else if (item.type === "video") {
          item.w = item.el.videoWidth || null;
          item.h = item.el.videoHeight || null;
        }
      } catch {}
    }
    delete item.el;
    return { id: item.id, type: item.type, url: item.url, w: item.w, h: item.h };
  });
}

/* ---------------- Item naming ---------------- */

function extFromUrl(url, type) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
    if (m) return m[1].toLowerCase();
  } catch {}
  return type === "video" ? "mp4" : type === "audio" ? "mp3" : "jpg";
}

function baseName(url, type) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(u.pathname.split("/").pop() || "");
    name = name.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
    name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    if (name && name.length <= 80) return name;
    return `${type}-${u.hostname.replace(/^www\./, "")}`;
  } catch {
    return `${type}-file`;
  }
}

/* ---------------- Rendering ---------------- */

function visibleItems() {
  return activeFilter === "all" ? allItems : allItems.filter((i) => i.type === activeFilter);
}

function render() {

  const items = visibleItems();
  toolbar.classList.remove("hidden");

  countPill.textContent = allItems.length;
  countPill.classList.remove("hidden");

  grid.innerHTML = "";

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(item.id) ? " is-selected" : "");
    card.dataset.id = item.id;

    const thumb = document.createElement(item.type === "image" ? "img" : "div");
    if (item.type === "image") {
      thumb.className = "thumb";
      thumb.loading = "lazy";
      thumb.referrerPolicy = "no-referrer";
      thumb.src = item.url;
      thumb.onerror = () => {
        const fb = document.createElement("div");
        fb.className = "icon-thumb";
        fb.textContent = "🖼️";
        thumb.replaceWith(fb);
      };
    } else if (item.type === "video") {
      thumb.className = "icon-thumb";
      thumb.textContent = "🎬";
    } else {
      thumb.className = "icon-thumb";
      thumb.textContent = "🎵";
    }
    card.appendChild(thumb);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.type;
    card.appendChild(badge);

    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    card.appendChild(tick);

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = baseName(item.url, item.type);
    name.title = item.url;
    const dim = document.createElement("div");
    dim.className = "dim";
    dim.textContent = item.w && item.h ? `${item.w}×${item.h}` : extFromUrl(item.url, item.type).toUpperCase();
    meta.append(name, dim);
    card.appendChild(meta);

    const dl = document.createElement("button");
    dl.className = "dl";
    dl.type = "button";
    dl.title = "Download this item";
    dl.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3v10.6l-3.3-3.3L7.3 11.7 12 16.4l4.7-4.7-1.4-1.4-3.3 3.3V3h-2ZM5 19h14v2H5z"/></svg>';
    dl.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "download", url: item.url, filename: suggestedFilename(item) });
    });
    card.appendChild(dl);

    card.addEventListener("click", () => toggleSelect(item.id));
    grid.appendChild(card);
  });

  updateDownloadBtn();
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const card = grid.querySelector(`[data-id="${id}"]`);
  if (card) card.classList.toggle("is-selected", selected.has(id));
  updateDownloadBtn();
}

/* ---------------- Selection helpers ---------------- */

function updateDownloadBtn() {
  const n = selected.size;
  downloadBtn.disabled = n === 0;
  downloadBtn.querySelector("span").textContent = n ? `Download (${n})` : "Download";
}

function selectAllVisible() {
  const items = visibleItems();
  const everySelected = items.length > 0 && items.every((i) => selected.has(i.id));
  items.forEach((i) => (everySelected ? selected.delete(i.id) : selected.add(i.id)));
  [...grid.children].forEach((c) => {
    const id = Number(c.dataset.id);
    if (Number.isFinite(id)) c.classList.toggle("is-selected", selected.has(id));
  });
  selectAllBtn.textContent = everySelected ? "Select all" : "Deselect all";
  updateDownloadBtn();
}

/* ---------------- Filters ---------------- */

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    activeFilter = chip.dataset.filter;
    selectAllBtn.textContent = "Select all";
    render();
  });
});

/* ---------------- Download ---------------- */

function suggestedFilename(item) {
  const ext = extFromUrl(item.url, item.type);
  const base = baseName(item.url, item.type) || `${item.type}-${item.id}`;
  return `${base}.${ext}`;
}

async function downloadSelected() {
  if (selected.size === 0) return;

  const items = allItems.filter((i) => selected.has(i.id));

  // Progress UI
  const wrap = document.createElement("div");
  wrap.className = "progress-wrap";
  wrap.innerHTML = `
    <div class="progress-top">
      <span><strong id="doneN">0</strong> / ${items.length} downloaded</span>
      <span id="failN" style="color: var(--bad)"></span>
    </div>
    <div class="bar"><div class="bar-fill" id="barFill"></div></div>
  `;
  toolbar.after(wrap);
  const doneN = wrap.querySelector("#doneN");
  const failN = wrap.querySelector("#failN");
  const barFill = wrap.querySelector("#barFill");

  downloadBtn.disabled = true;
  let done = 0;
  let failed = 0;

  for (const item of items) {
    try {
      await chrome.runtime.sendMessage({
        type: "download",
        url: item.url,
        filename: suggestedFilename(item),
      });
    } catch {
      failed++;
    }
    done++;
    doneN.textContent = done - failed;
    failN.textContent = failed ? `${failed} failed` : "";
    barFill.style.width = `${Math.round((done / items.length) * 100)}%`;
  }

  setTimeout(() => wrap.remove(), 3500);
  downloadBtn.disabled = false;
  updateDownloadBtn();
}

/* ---------------- Wire up ---------------- */

selectAllBtn.addEventListener("click", selectAllVisible);
downloadBtn.addEventListener("click", downloadSelected);
$("#rescan").addEventListener("click", scanPage);

scanPage();
