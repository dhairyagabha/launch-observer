# Launch Observer

Browser extension for observing analytics network calls with fully decoded payloads.

## Features
- Allowlist-based capture (default: Adobe Edge).
- Sessions grouped by site with optional tab locking.
- Full request details: domain, URL, method, status, timing, headers, payload.
- Decoded query parameters and request bodies without altering key/value casing.
- JSON payload tree with search, copy path/value, and expand controls.
- URL-encoded payloads displayed as key/value tables.
- Popular services allowlist with custom domain mapping to services.
- UAT assertions per site with pass/fail status, assertions viewer, and PDF-ready report export.

## Load in Chrome / Edge (Unpacked)
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `launch-observer`.

## Build Chrome / Edge ZIP
```
npm run build:chrome
```

This generates `dist/chrome.zip` for Chrome Web Store or Edge Add-ons.

## Load in Firefox (Stable)
Firefox Stable requires a Manifest V2 build.

```
npm run build:firefox
```

Then load the generated build:
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `dist/firefox/manifest.json`.

If you plan to publish to AMO, set a permanent add-on ID in `manifest.firefox.json` under `browser_specific_settings.gecko.id`.

For manual AMO upload, use the generated zip at `dist/firefox.zip` (manifest at zip root).

### Firefox limitations
- Firefox (MV2) does not support `scripting.executeScript` into the MAIN world.
- Some sites with strict CSP can block hook injection, which may prevent capturing `sendBeacon`/204 payload bodies.
- For the most reliable payload capture (especially Adobe WebSDK), use the Chrome/Edge build.

## Build CSS (Tailwind)
```
npm install
npm run build:css
```

## Code Layout
UI code is modularized under `pages/app/`:
- `main.js` — wiring, event listeners, runtime messages
- `state.js` — shared state + DOM element refs
- `allowlist.js` — allowlist UI + services
- `requests.js` — request list + details
- `sessions.js` — sessions UI + behavior
- `payload.js` — JSON rendering + parsing helpers
- `ui.js` — tabs, sidebar, toasts
- `utils.js` — formatting + helpers

Background and content scripts:
- `background/core.js` — all capture, session, and UAT logic, shared by both builds
- `background/service-worker.js` — Chrome/Edge MV3 entry (MAIN-world injection, alarms)
- `background/firefox-background.js` — Firefox MV2 entry, loaded as a module from
  `background/firefox-background.html`
- `content/content.js`
- `content/inject.js`

Both browser entry points are thin adapters over `background/core.js`, so capture
logic is written once. `tests/firefox-uat-resolve.test.js` enforces that the
Firefox entry never grows its own copy of `lib/`.

## Notes
- Requests are stored in `chrome.storage.local` and capped by `maxEntries` (default: 2000).
- Writes to storage are debounced, so capture bursts do not rewrite the whole
  request list per network event. If a write still exceeds the storage quota,
  the oldest half is dropped and the UI is notified.
- Page hooks only stay installed while **Enable hooks** is on. On every other
  page the injected script removes its `fetch`/`XHR`/`sendBeacon` wrappers as
  soon as settings arrive.
- Captured payloads are only handed from the page to the extension when the
  request URL matches the allowlist; nothing else leaves the page context.
- Allowlist matches exact domain or any subdomain.
- The UI entrypoint is `pages/app/main.js` (loaded as an ES module).
- Hook debug logging can be toggled from the extension page console:
  - `LaunchObserverDebug.enableHookLogging(true)`
  - `LaunchObserverDebug.disableHookLogging()`
  - `LaunchObserverDebug.isHookLoggingEnabled()`
- Sessions will prompt to end after 5 minutes of inactivity (no captured requests).

## Recent Updates
- Stabilized WebSDK payload capture by re-wrapping network hooks if page scripts overwrite them.
- Added a resilient `window.alloy` hook to ensure WebSDK `sendEvent` payloads are captured reliably.

## UAT Assertions
- Import one JSON file per site via the **UAT Assertions** dialog.
- Enable **Perform UAT validations** when starting a session.
- Use **See Assertions** to view and download the current assertion config.
- UAT results appear in request details and in the session UAT report.
 - WebSDK payloads are captured via page hooks (when enabled) to cover requests sent outside the page context.

### UAT Schema Notes
- `siteId` (required): string identifier for the site.
- `siteName` (optional): human-friendly site label (string).
- `global` (optional): global gates for UAT applicability.
- `global.includeServices` (optional): service IDs to include.
- `global.excludeServices` (optional): service IDs to exclude.
- `global.includeConditions` (optional): conditions that must all pass to run UAT.
- `global.excludeConditions` (optional): conditions that skip UAT when matched.
- `assertions` (required): array of assertion objects.
- `assertion.id` (required): unique string.
- `assertion.title` (optional): string shown in the UI.
- `assertion.description` (optional): string shown in the UI.
- `assertion.conditionsLogic` (optional): `all` or `any` for applicability (default: `all`).
- `assertion.scope` (optional): `request` or `page` (default: `request`).
- `assertion.conditions` (optional): array of applicability condition objects.
- `assertion.validations` (required): array of validation objects (all must pass).
- Validations always use `all` logic (no override).
- `assertion.count` (required only for `scope=page`): `exactly`, `at_least`, or `at_most`.
- `assertion.value` (required only for `scope=page`): number.
- `condition.source` (optional): `payload`, `query`, `headers`, or `raw` (default: `payload`).
- `condition.path` (required unless `source=raw`): string path.
- `condition.operator` (required): string operator.
- `condition.expected` (required for comparison operators): string, number, or array.

### Service Catalog (IDs)
- `adobe-edge` — Adobe Edge
- `adobe-analytics` — Adobe Analytics
- `google-analytics` — Google Analytics
- `google-ads` — Google Ads
- `meta` — Meta Pixel
- `tiktok` — TikTok Pixel
- `linkedin` — LinkedIn Insight
- `pinterest` — Pinterest Tag
- `snapchat` — Snapchat Pixel
- `x` — X Ads
- `microsoft-ads` — Microsoft Ads (Bing)
- `baidu` — Baidu Tongji
- `demandbase` — Demandbase
- `hotjar` — Hotjar
- `segment` — Segment
- `mixpanel` — Mixpanel
- `amplitude` — Amplitude

## Documentation Site
The GitHub Pages site lives in `docs/` with the landing page at `docs/index.html`
and the privacy policy at `docs/privacy.html`.
