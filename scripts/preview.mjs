/**
 * Browser preview harness.
 *
 * jsdom has no layout or paint engine, so a whole class of bug survives a
 * green test run: a class that is structurally inert, a palette token that
 * collides with the surface behind it, a transform that pins a drawer
 * off-screen. This serves the real pages/app.html to a real browser with the
 * extension APIs faked, which is where those show up.
 *
 * Files are served straight out of the working tree — nothing is copied — so
 * editing pages/, styles/ or lib/ and reloading shows the change. Only
 * app.html is rewritten in flight, to inject the stub ahead of the app's
 * module entry point.
 *
 *   npm run preview            # http://127.0.0.1:8731/pages/app.html
 *   npm run preview -- 9000    # a different port
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sampleState } from '../tests/helpers/sample-state.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 8731;

/** Only the front-end the workbench actually loads is reachable. */
const SERVED_DIRS = ['pages', 'styles', 'lib', 'icons'];

const MODULE_TAG = '<script type="module" src="app/main.js"></script>';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

/**
 * Put the stub in front of the app's module entry point.
 *
 * Throws rather than serving a page that would boot against the real,
 * absent extension APIs and fail in a confusing way.
 * @param {string} html
 * @returns {string}
 */
export function injectStub(html) {
  if (!html.includes(MODULE_TAG)) {
    throw new Error(
      `preview: could not find ${MODULE_TAG} in pages/app.html — ` +
      'update MODULE_TAG in scripts/preview.mjs to match the entry point.'
    );
  }
  return html.replace(MODULE_TAG, `<script src="./stub.js"></script>\n  ${MODULE_TAG}`);
}

/**
 * The faked extension APIs, as a classic script so it runs before the module.
 *
 * chrome.storage.local is backed by localStorage: flags such as the tour's
 * "seen" marker have to survive a reload or the harness cannot tell you
 * whether the tour correctly stays closed.
 * @returns {string}
 */
export function stubSource() {
  return `/* Preview harness: fakes the extension APIs so pages/app.html boots in a tab. */
(function () {
  // Capture from the first tick so a reload keeps the record.
  window.__errs = [];
  window.__logs = [];
  addEventListener('error', function (e) {
    window.__errs.push('error: ' + (e.message || e.error) + ' @ ' + e.filename + ':' + e.lineno);
  });
  addEventListener('unhandledrejection', function (e) { window.__errs.push('rejection: ' + e.reason); });
  var _error = console.error.bind(console);
  console.error = function () {
    window.__errs.push('console.error: ' + [].slice.call(arguments).join(' '));
    _error.apply(null, arguments);
  };

  var req = new XMLHttpRequest();
  req.open('GET', './fixture.json', false);
  req.send(null);
  var state = JSON.parse(req.responseText);

  // The fixture's timestamps are frozen at build time; re-anchor them so the
  // relative-time labels read sensibly.
  var newest = Math.max.apply(null, state.requests.map(function (r) { return r.timeStamp; }));
  var skew = Date.now() - newest;
  state.requests.forEach(function (r) { r.timeStamp += skew; r.startTime += skew; });
  state.sessions.forEach(function (s) { s.createdAt += skew; });

  var STORE_KEY = 'lo-preview-storage';
  var storage = {};
  try { storage = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { storage = {}; }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(storage)); } catch (e) {}
  }

  window.__loStub = {
    state: state,
    storage: storage,
    /** Wipe persisted flags, e.g. to see the first-run tour again. */
    reset: function () { try { localStorage.clear(); } catch (e) {} location.reload(); }
  };

  window.chrome = {
    runtime: {
      lastError: null,
      id: 'preview-harness',
      getURL: function (p) { return p; },
      sendMessage: function (msg, cb) {
        var reply;
        if (msg.type === 'getState') reply = state;
        else if (msg.type === 'getSettings') reply = { settings: state.settings };
        else if (msg.type === 'setSettings') { state.settings = msg.settings; reply = { settings: state.settings }; }
        else reply = { ok: true };
        window.__logs.push('[stub] ' + msg.type);
        if (cb) setTimeout(function () { cb(reply); }, 0);
      },
      onMessage: { addListener: function () {}, removeListener: function () {} }
    },
    tabs: {
      query: function (q, cb) {
        if (cb) cb([{ id: 1, title: 'Example checkout', url: 'https://example.com/checkout' }]);
      }
    },
    storage: {
      local: {
        get: function (key, cb) {
          if (!cb) return;
          if (typeof key === 'string') { var o = {}; o[key] = storage[key]; cb(o); return; }
          cb(storage);
        },
        set: function (value, cb) {
          Object.keys(value).forEach(function (k) { storage[k] = value[k]; });
          persist();
          if (cb) cb();
        },
        remove: function (key, cb) { delete storage[key]; persist(); if (cb) cb(); },
        getBytesInUse: function (key, cb) { if (cb) cb(148 * 1024); }
      },
      onChanged: { addListener: function () {} }
    }
  };
  window.browser = window.chrome;
})();
`;
}

/**
 * Resolve a request path to a file inside the served directories.
 * @param {string} urlPath
 * @returns {string|null} absolute path, or null if out of bounds
 */
export function resolveServedPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const abs = path.resolve(ROOT, clean);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [top] = rel.split(path.sep);
  return SERVED_DIRS.includes(top) ? abs : null;
}

/** @returns {import('node:http').Server} */
export function createPreviewServer() {
  return createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/pages/app.html' : req.url;
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    try {
      if (urlPath.startsWith('/pages/stub.js')) {
        return send(200, TYPES['.js'], stubSource());
      }
      if (urlPath.startsWith('/pages/fixture.json')) {
        return send(200, TYPES['.json'], JSON.stringify(sampleState(), null, 2));
      }

      const file = resolveServedPath(urlPath);
      if (!file) return send(404, 'text/plain', 'Not found');

      if (file.endsWith(path.join('pages', 'app.html'))) {
        return send(200, TYPES['.html'], injectStub(await readFile(file, 'utf8')));
      }
      const body = await readFile(file);
      return send(200, TYPES[path.extname(file)] || 'application/octet-stream', body);
    } catch (error) {
      if (error?.code === 'ENOENT') return send(404, 'text/plain', 'Not found');
      console.error('[preview]', error.message);
      return send(500, 'text/plain', 'Preview error');
    }
  });
}

/** @param {number} port */
export function startPreview(port = DEFAULT_PORT) {
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/pages/app.html`;
    console.log(`Launch Observer preview  ->  ${url}`);
    console.log('Serving the working tree; reload after editing pages/, styles/ or lib/.');
    console.log('Run `npm run build:css` after changing Tailwind classes.');
    console.log('In the console: __loStub.reset() replays the first-run tour, __errs lists page errors.');
  });
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`preview: port ${port} is already in use — pass another, e.g. npm run preview -- ${port + 1}`);
      process.exit(1);
    }
    throw error;
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPreview(Number(process.argv[2]) || DEFAULT_PORT);
}
