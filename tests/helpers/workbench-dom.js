/**
 * Boots the real pages/app.html inside jsdom with the extension APIs stubbed,
 * then imports the real UI modules against it.
 *
 * This is the closest thing to driving the extension in a browser that runs in
 * CI: the markup, the stylesheet's class names, and every module under
 * pages/app/ are the shipped ones.
 */
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const APP_HTML = new URL('../../pages/app.html', import.meta.url);

/**
 * Build a canned extension state for the stubs to serve.
 * @returns {object}
 */
export function sampleState() {
  const now = Date.now();
  const payload = name => ({
    events: [{ xdm: { eventType: 'web.webpagedetails.pageViews', web: { webPageDetails: { name, URL: 'https://example.com/checkout' } } } }]
  });
  const results = fail => ([
    {
      id: 'a1', title: 'Datastream id is production', description: '', status: 'passed',
      applicable: true, scope: 'request', conditions: [],
      validations: [{ source: 'query', path: 'configId', operator: 'equals', expected: 'abc-123', actual: ['abc-123'], passed: true }],
      count: null
    },
    {
      id: 'a2', title: 'Page name is present', description: '', status: fail ? 'failed' : 'passed',
      applicable: true, scope: 'request', conditions: [],
      validations: [{ source: 'payload', path: 'events[0].xdm.web.webPageDetails.name', operator: 'exists', actual: fail ? [] : ['Checkout'], passed: !fail }],
      count: null
    }
  ]);
  const mk = (i, over = {}) => ({
    id: `r${i}:${now - i * 1000}`,
    requestId: `r${i}`,
    sessionId: 's1',
    tabId: 1,
    frameId: 0,
    method: 'POST',
    statusCode: 204,
    duration: 40,
    url: `https://edge.adobedc.net/ee/v2/interact?configId=abc-123&requestId=r${i}`,
    domain: 'edge.adobedc.net',
    serviceId: 'adobe-edge',
    path: '/ee/v2/interact',
    timeStamp: now - i * 1000,
    startTime: now - i * 1000,
    pageUrl: 'https://example.com/checkout',
    navId: 1,
    requestHeaders: [{ name: 'content-type', value: 'application/json' }],
    query: { raw: 'configId=abc-123', params: [{ key: 'configId', value: 'abc-123' }] },
    body: { type: 'json', contentType: 'application/json', raw: JSON.stringify(payload('Checkout')), parsed: payload('Checkout') },
    uat: { status: 'done', results: results(false) },
    ...over
  });

  const requests = [
    mk(1),
    mk(2, { uat: { status: 'done', results: results(true) } }),
    mk(3, { domain: 'www.google-analytics.com', serviceId: 'google-analytics', path: '/g/collect', uat: { status: 'done', results: [] } })
  ];
  const sessions = [
    { id: 's1', name: 'Checkout flow', site: 'Production', lockTabId: 1, paused: false, createdAt: now - 60000, uatEnabled: true },
    { id: 's2', name: 'Smoke test', site: 'Staging', lockTabId: null, paused: true, createdAt: now - 90000, uatEnabled: false }
  ];
  const settings = {
    allowlist: ['edge.adobedc.net', 'google-analytics.com'],
    capturePaused: false, maxEntries: 2000, selectedSessionId: 's1',
    enableHooks: true, debugHooks: false, serviceMappings: []
  };
  return {
    settings, requests, sessions,
    sites: ['Production', 'Staging'],
    currentSessionId: 's1',
    uatConfigs: { Production: { siteId: 'Production', global: null, assertions: [] } }
  };
}

/**
 * Load the app into jsdom and import the real modules against it.
 * @param {{ state?: object, storage?: object }} [options]
 * @returns {Promise<{ dom: object, document: Document, window: object, storage: object, cleanup: Function }>}
 */
export async function bootWorkbench(options = {}) {
  const state = options.state || sampleState();
  const storage = { ...(options.storage || {}) };
  const html = await readFile(APP_HTML, 'utf8');

  const dom = new JSDOM(html, { url: 'https://localhost/pages/app.html', pretendToBeVisual: true });
  const { window } = dom;

  window.chrome = {
    runtime: {
      lastError: null,
      getURL: p => p,
      sendMessage: (msg, cb) => {
        const reply = msg.type === 'getState'
          ? state
          : msg.type === 'getSettings' ? { settings: state.settings } : { ok: true };
        if (cb) cb(reply);
      },
      onMessage: { addListener: () => {} }
    },
    tabs: { query: (q, cb) => cb && cb([{ id: 1, title: 'Example', url: 'https://example.com' }]) },
    storage: {
      local: {
        get: (key, cb) => cb && cb(typeof key === 'string' ? { [key]: storage[key] } : storage),
        set: (value, cb) => { Object.assign(storage, value); if (cb) cb(); },
        getBytesInUse: (key, cb) => cb && cb(1024)
      }
    }
  };

  // Expose the DOM globals the UI modules reference bare (document,
  // HTMLInputElement, DOMParser, CSS, ...). Copying everything jsdom defines
  // avoids chasing them one ReferenceError at a time.
  const saved = new Map();
  const expose = key => {
    if (!saved.has(key)) saved.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, window[key]);
  };
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key === 'undefined' || key.startsWith('_')) continue;
    if (/^[A-Z]/.test(key) || ['document', 'navigator', 'localStorage', 'sessionStorage', 'getComputedStyle', 'matchMedia'].includes(key)) {
      try { expose(key); } catch {}
    }
  }
  expose('window');

  saved.set('requestAnimationFrame', globalThis.requestAnimationFrame);
  saved.set('cancelAnimationFrame', globalThis.cancelAnimationFrame);
  globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);

  // jsdom has no layout engine or dialog implementation.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };

  return {
    dom,
    window,
    document: window.document,
    storage,
    cleanup() {
      for (const [key, value] of saved) Reflect.set(globalThis, key, value);
      window.close();
    }
  };
}

/** Let queued microtasks and rAF callbacks run. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 20));
