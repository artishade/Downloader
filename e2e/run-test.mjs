#!/usr/bin/env node
/**
 * End-to-end test for Universal Media Downloader.
 *
 * 1. Generate clip.webm (VP8) + tone.wav (PCM) fixtures via ffmpeg.
 * 2. Launch Chromium with the extension and a clean download dir.
 * 3. Serve e2e/test-page and open it.
 * 4. Open the extension popup (tab-navigated, per known MV3 testing approach).
 * 5. Assert the scan found media, select all, download.
 * 6. Verify every file landed on disk with correct content signatures.
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Allow testing a different copy of the extension, e.g. an extracted ZIP:
//   EXT_DIR=/tmp/extracted/universal-media-downloader node run-test.mjs
const EXT_DIR = process.env.EXT_DIR || ROOT;
const PAGE_DIR = path.join(__dirname, "test-page");
const DL_DIR = path.join(__dirname, "downloads");
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;

let step = 0;
const t0 = Date.now();
function log(msg) {
  console.log(`[e2e ${String(++step).padStart(2, "0")} | +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}
function fail(msg) {
  console.error(`\n[e2e FAIL] ${msg}`);
  process.exitCode = 1;
  process.exit(1);
}

/* ---------------- 1. Fixtures ---------------- */

/* Minimal 16-bit PCM WAV writer (ffmpeg build has no audio encoders). */
function writeWav(file, freq, seconds) {
  const rate = 44100;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/* Record a real VP8/WebM clip using Chromium's own MediaRecorder:
 * the bundled ffmpeg has no usable PNG/PCM decoders or audio encoders,
 * but Chromium itself is a perfectly good VP8 encoder. */
async function recordClip() {
  const rec = await context.newPage();
  await rec.setContent('<!DOCTYPE html><canvas id="c" width="160" height="120"></canvas>');
  const b64 = await rec.evaluate(async () => {
    const canvas = document.getElementById("c");
    const ctx2d = canvas.getContext("2d");
    const stream = canvas.captureStream(10);
    const chunks = [];
    const mr = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    mr.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((res) => (mr.onstop = res));
    mr.start(100);
    let flip = false;
    const t0 = performance.now();
    await new Promise((resolve) => {
      (function draw() {
        if (performance.now() - t0 > 1200) return resolve();
        flip = !flip;
        ctx2d.fillStyle = flip ? "rgb(30,136,229)" : "rgb(229,57,53)";
        ctx2d.fillRect(0, 0, 160, 120);
        requestAnimationFrame(draw);
      })();
    });
    mr.stop();
    await stopped;
    const blob = new Blob(chunks, { type: "video/webm" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
  fs.writeFileSync(path.join(PAGE_DIR, "clip.webm"), Buffer.from(b64, "base64"));
  await rec.close();
}

/* ---------------- 2. Static server with Range support ---------------- */

let server;
function startServer() {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".webm": "video/webm",
    ".wav": "audio/wav",
  };
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = path.join(PAGE_DIR, p);
      if (!file.startsWith(PAGE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const stat = fs.statSync(file);
      const mime = MIME[path.extname(file)] || "application/octet-stream";

      // Hotlink protection simulation: strict1.png rejects direct <img> loads
      // (the way Googleusercontent & co. do) but allows fetch() from the
      // extension service worker.
      if (p.endsWith("strict1.png") && req.headers["sec-fetch-dest"] === "image") {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("hotlinking blocked");
        return;
      }

      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (start > end || start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            "Content-Type": mime,
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

/* ---------------- 3. Browser + extension ---------------- */

let context, serviceWorker, popupPage, page;

async function launchBrowser() {
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  const userDataDir = path.join(__dirname, ".profile");
  fs.rmSync(userDataDir, { recursive: true, force: true });

  log(`launching Chromium with extension loaded from: ${EXT_DIR}`);
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-sandbox",
    ],
    downloadsPath: DL_DIR,
    acceptDownloads: true,
  });

  let [sw] = context.serviceWorkers().filter((w) => w.url().includes("background.js"));
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  serviceWorker = sw;
  log(`extension service worker up: ${sw.url()}`);

  // Playwright's downloadsPath uses Chromium's "allowAndName" behavior, which
  // replaces suggested filenames with GUIDs. Override it so downloads keep the
  // filenames the extension suggests (chrome.downloads.download filename param).
  const browser = context.browser();
  if (browser) {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DL_DIR,
      eventsEnabled: true,
    });
    log("download behavior set to 'allow' (keep suggested filenames)");
  } else {
    log("WARNING: no browser handle; downloads will be GUID-named by Playwright");
  }
}

/* ---------------- 4. Pages ---------------- */

async function openSamplePage() {
  page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  log(`sample page opened: ${page.url()}`);
}

async function openPopup() {
  const popupUrl = `chrome-extension://${serviceWorker.url().split("/")[2]}/popup.html`;
  popupPage = await context.newPage();
  popupPage.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      log(`popup console.${m.type()}: ${m.text()}`);
    }
  });
  popupPage.on("pageerror", (e) => log(`popup pageerror: ${e.message}`));
  await popupPage.goto(popupUrl);
  await popupPage.waitForTimeout(500);
  log(`popup opened as a tab: ${popupPage.url()}`);

  // Diagnostic: which state did the popup reach?
  const diag = await popupPage.evaluate(() => ({
    info: document.querySelector("#pageInfo")?.textContent,
    loadingHidden: document.querySelector("#loading")?.classList.contains("hidden"),
    emptyHidden: document.querySelector("#empty")?.classList.contains("hidden"),
    emptyH2: document.querySelector("#empty h2")?.textContent,
    cards: document.querySelectorAll("#grid .card").length,
  }));
  log(`popup state: ${JSON.stringify(diag)}`);
}

/* ---------------- 5. Main flow ---------------- */

async function main() {
  fs.mkdirSync(DL_DIR, { recursive: true });

  // PNG fixtures are tiny and committed; regenerate if missing (fresh clone).
  if (!fs.existsSync(path.join(PAGE_DIR, "red.png"))) {
    spawnSync("python3", [path.join(__dirname, "make-fixtures.py")], { stdio: "inherit" });
    log("PNG fixtures generated via make-fixtures.py");
  }
  writeWav(path.join(PAGE_DIR, "tone.wav"), 523, 1);

  await startServer();
  log(`static server on ${BASE}`);

  await launchBrowser();
  await recordClip();
  log("clip.webm recorded via Chromium MediaRecorder (real VP8 video)");
  await openSamplePage();
  await openPopup();

  // Wait for scan: loading indicator must hide (scan done), cards must render.
  await popupPage.waitForFunction(
    () => document.querySelector("#loading")?.classList.contains("hidden") === true,
    null,
    { timeout: 20000 }
  );
  await popupPage.waitForFunction(
    () => document.querySelectorAll("#grid .card").length > 0,
    null,
    { timeout: 20000 }
  );

  const cardCount = await popupPage.evaluate(
    () => document.querySelectorAll("#grid .card").length
  );
  log(`popup scanned the page: ${cardCount} media cards rendered`);

  const names = await popupPage.evaluate(() =>
    [...document.querySelectorAll("#grid .card .name")].map((n) => n.textContent)
  );
  log(`scanner found: ${names.join(", ")}`);

  const types = await popupPage.evaluate(() =>
    [...document.querySelectorAll("#grid .card .badge")].map((b) => b.textContent)
  );
  log(`media types: ${[...new Set(types)].join(", ")}`);

  // Cards display base names (extensions are added at download time).
  if (!names.includes("red")) fail("scanner did not find the red image");
  if (!names.includes("clip")) fail("scanner did not find the webm video");
  if (!names.includes("tone")) fail("scanner did not find the wav audio");
  if (!names.includes("bg-art")) fail("scanner did not find the CSS background image");
  if (!names.includes("strict1")) fail("scanner did not find the hotlink-protected image");

  // Thumbnail recovery: strict1.png blocks direct <img> loads (hotlink
  // protection), so its popup thumbnail must be recovered through the
  // service worker as a data URL.
  let strictRecovered = false;
  // Diagnostic: what state is the strict1 thumbnail in?
  const thumbDiag = await popupPage.evaluate(() => {
    const card = [...document.querySelectorAll("#grid .card")].find(
      (c) => c.querySelector(".name")?.textContent === "strict1"
    );
    if (!card) return "card missing";
    const img = card.querySelector(".thumb img");
    if (!img) return "img missing";
    return {
      srcPrefix: img.src.slice(0, 40),
      recovered: img.dataset.recovered || "0",
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      holderClass: img.parentElement?.className,
    };
  });
  log(`strict1 thumb state: ${JSON.stringify(thumbDiag)}`);
  try {
    await popupPage.waitForFunction(
      () => {
        const card = [...document.querySelectorAll("#grid .card")].find(
          (c) => c.querySelector(".name")?.textContent === "strict1"
        );
        if (!card) return false;
        const img = card.querySelector(".thumb img");
        return !!img && img.src.startsWith("data:image");
      },
      null,
      { timeout: 10000 }
    );
    strictRecovered = true;
  } catch {}
  const brokenThumbs = await popupPage.evaluate(
    () => document.querySelectorAll("#grid .thumb.broken").length
  );
  log(
    `thumbnail recovery: strict image ${strictRecovered ? "recovered via service worker (data URL)" : "NOT recovered"}; broken thumbs: ${brokenThumbs}`
  );
  if (!strictRecovered) {
    fail("service-worker thumbnail recovery failed for the hotlink-protected image");
  }
  if (brokenThumbs > 0) fail(`${brokenThumbs} thumbnails render as broken`);

  // Select all + download
  await popupPage.click("#selectAll");
  log('clicked "Select all"');
  await popupPage.waitForTimeout(300);

  const selectedCount = await popupPage.evaluate(() => selected.size);
  log(`selected ${selectedCount} items`);

  if (selectedCount < 3) fail(`expected >= 3 selections, got ${selectedCount}`);

  await popupPage.click("#downloadBtn");
  log('clicked "Download"');

  // Wait for progress to show completion.
  await popupPage.waitForFunction(
    (n) => {
      const el = document.querySelector("#doneN");
      return el && parseInt(el.textContent || "0", 10) >= n;
    },
    selectedCount,
    { timeout: 30000 }
  );
  const doneN = await popupPage.$eval("#doneN", (el) => el.textContent);
  const failN = await popupPage.$eval("#failN", (el) => el.textContent || "(none)");
  log(`download progress: ${doneN}/${selectedCount} downloaded, failures: ${failN}`);

  // Give chrome.downloads a moment to flush .crdownload files.
  await new Promise((r) => setTimeout(r, 1500));

  // Verify on disk.
  const got = fs.readdirSync(DL_DIR).filter((f) => !f.endsWith(".crdownload")).sort();
  log(`files on disk: ${got.join(", ")}`);

  const expected = [
    "red.png", "green.png", "blue.png", "lazy1.png", "lazy2.png",
    "bg-art.png", "video-poster.png", "strict1.png", "clip.webm", "tone.wav",
  ].sort();
  const missing = expected.filter((f) => !got.includes(f));
  if (missing.length) fail(`missing downloads: ${missing.join(", ")}`);

  // Content signature checks.
  for (const f of got) {
    const b = fs.readFileSync(path.join(DL_DIR, f));
    if (b.length === 0) fail(`${f} is empty`);
    if (f.endsWith(".png") && b.subarray(0, 4).toString("hex") !== "89504e47") {
      fail(`PNG magic missing in ${f}`);
    }
    if (f === "clip.webm" && b.subarray(0, 4).toString("hex") !== "1a45dfa3") {
      fail(`EBML magic missing in ${f} (got ${b.subarray(0, 4).toString("hex")})`);
    }
    if (f === "tone.wav" && b.subarray(0, 4).toString("hex") !== "52494646") {
      fail(`RIFF magic missing in ${f}`);
    }
  }
  log("content signatures verified (PNG/EBML/RIFF magic bytes correct)");

  // Byte-identity: every downloaded file must match its served source exactly.
  for (const f of got) {
    const src = fs.readFileSync(path.join(PAGE_DIR, f));
    const dl = fs.readFileSync(path.join(DL_DIR, f));
    if (!src.equals(dl)) fail(`content mismatch for ${f} (source vs downloaded)`);
  }
  log("byte-identity verified: all 9 downloads match their source files exactly");

  // Evidence screenshots.
  await popupPage.screenshot({ path: path.join(__dirname, "popup.png") });
  log("evidence: e2e/popup.png");
  await page.screenshot({ path: path.join(__dirname, "sample-page.png") });
  log("evidence: e2e/sample-page.png");

  console.log("\n[e2e PASS] extension installed, scanned media, selected, downloaded, verified on disk.\n");
  await context.close();
  server.close();
  process.exit(0);
}

main().catch((e) => fail(e?.stack || String(e)));
