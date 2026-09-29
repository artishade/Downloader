# Universal Media Downloader — Chrome Extension

A Manifest V3 Chrome extension that scans any website for media (images, videos, audio), shows a visual picker, and downloads the selected files in one click.

## Repo layout

```
.
├── extension/                        # The loadable Chrome extension
│   ├── manifest.json                 # MV3 manifest (popup + service worker)
│   ├── popup.html / popup.js / popup.css
│   ├── background.js                 # Download handling (chrome.downloads)
│   ├── icons/                        # Generated icons (16/48/128)
│   └── universal-media-downloader.zip  # Ready-to-install package
├── index.html                        # Landing page: download link + install guide
└── build_extension.py                # Regenerates icons and re-zips the extension
```

## Install (Chrome, Edge, Brave, Opera)

1. Unzip `extension/universal-media-downloader.zip`.
2. Open `chrome://extensions` in the address bar.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose the extracted folder.
5. (Optional) Pin the icon via the puzzle-piece menu for quick access.

## Use it

1. Open any website and scroll it fully (lazy-loaded media appears as you scroll).
2. Click the extension icon — it scans the page and shows every image, video and audio file it finds.
3. Use the **Images / Videos / Audio** filters and click cards to select, or hit **Select all**.
4. Press **Download** — every selected file is saved with its original filename.

## Rebuild

Edit files in `extension/`, then run:

```bash
python3 build_extension.py
```

That regenerates the icons and refreshes `extension/universal-media-downloader.zip`.

## Automated end-to-end test

`e2e/run-test.mjs` installs the extension in real headless Chromium (Playwright),
serves a sample page with images (incl. CSS-background + lazy-load), a VP8 video
and a WAV audio file, opens the popup, selects all media, clicks Download, then
verifies every file lands on disk with the correct name and byte-identical content.

```bash
cd e2e
bun install            # one-time: Playwright
bunx playwright install --with-deps chromium   # one-time: browser
node run-test.mjs      # prints step-by-step evidence, saves popup.png + sample-page.png
```

Latest run: `e2e/evidence.log` — 9/9 media items scanned, selected, downloaded
and verified (PNG/EBML/RIFF magic bytes + byte-identity against the source files).

## Notes & limits

- Browser pages (chrome://, Web Store, etc.) can't be scanned by design.
- Sites that stream media via DRM or segmented streams can't be saved as a single file by any extension.
- Scan results include iframes when the site allows it; otherwise only the main frame is scanned.
- Respect each website's terms of service and copyright when downloading media.
