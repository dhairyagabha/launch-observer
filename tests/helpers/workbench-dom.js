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
import { sampleState } from './sample-state.js';

export { sampleState };

const APP_HTML = new URL('../../pages/app.html', import.meta.url);

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

  // Every message the UI sends to the background, in order, so tests can assert
  // on what the page asked for. Background broadcasts are replayed via `emit`.
  const sent = [];
  const listeners = [];

  window.chrome = {
    runtime: {
      lastError: null,
      getURL: p => p,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const reply = msg.type === 'getState'
          ? state
          : msg.type === 'getSettings' ? { settings: state.settings } : { ok: true };
        if (cb) cb(reply);
      },
      onMessage: { addListener: fn => listeners.push(fn) }
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
    sent,
    /**
     * Replay a background broadcast to the page's runtime.onMessage listeners.
     * @param {object} message
     */
    emit(message) {
      listeners.forEach(fn => fn(message, {}, () => {}));
    },
    cleanup() {
      for (const [key, value] of saved) Reflect.set(globalThis, key, value);
      window.close();
    }
  };
}

/** Let queued microtasks and rAF callbacks run. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 20));
