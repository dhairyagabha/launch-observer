/**
 * Shared background logic for both the MV3 service worker and the MV2
 * Firefox background page.
 *
 * Everything platform-specific is passed in through `start()`. Keeping one
 * copy of this logic is what stops the two builds from drifting apart.
 */
import {
  parseQueryString,
  parseRawBody,
  getDomainFromUrl,
  getPathFromUrl
} from '../lib/parse.js';
import { resolveServiceIdForDomain } from '../lib/services.js';
import { normalizeUatConfig, evaluateAssertionsForRequest } from '../lib/uat.js';

const DEFAULT_ALLOWLIST = [
  'edge.adobedc.net'
];

const DEFAULT_SETTINGS = {
  allowlist: DEFAULT_ALLOWLIST,
  capturePaused: false,
  maxEntries: 2000,
  selectedSessionId: null,
  enableHooks: false,
  debugHooks: false,
  serviceMappings: []
};

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PAYLOAD_TTL_MS = 2 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_DELAY_MS = 2000;
const BROADCAST_DEBOUNCE_MS = 100;
const MAX_DEFERRED_EVENTS = 500;

let api = null;
let platform = {
  injectHooks: async () => {},
  startIdleTimer: () => {}
};

let settings = { ...DEFAULT_SETTINGS };
let requests = [];
let requestIndex = new Map();
let sessions = [];
let sites = [];
let currentSessionId = null;
let uatConfigs = {};
let lastRequestAt = Date.now();
let idlePrompted = false;

const navState = new Map();
const tabUrlCache = new Map();
const lastInjectByTab = new Map();
const payloadCacheByUrlTab = new Map();
const payloadCache = new Map();
const hookQueueByTabUrl = new Map();
const hookQueueByUrl = new Map();

/* ------------------------------------------------------------------ *
 * Readiness
 *
 * Listeners are registered synchronously so the worker never misses an
 * event, but state loads asynchronously. Anything arriving before the load
 * finishes is deferred rather than run against defaults — running it early
 * used to persist an empty `requests` array over the stored one.
 * ------------------------------------------------------------------ */

let stateReady = false;
let readyPromise = null;
const deferredEvents = [];

/**
 * Run a callback once persisted state is available.
 * @param {Function} fn
 */
function whenReady(fn) {
  if (stateReady) {
    fn();
    return;
  }
  if (deferredEvents.length >= MAX_DEFERRED_EVENTS) return;
  deferredEvents.push(fn);
}

function drainDeferred() {
  stateReady = true;
  const queued = deferredEvents.splice(0);
  queued.forEach(fn => {
    try {
      fn();
    } catch (error) {
      console.error('[Launch Observer] deferred event failed', error);
    }
  });
}

function debugHookLog(...args) {
  if (!settings?.debugHooks) return;
  console.log('[Launch Observer Hooks]', ...args);
}

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

/**
 * Broadcast to the extension UI, ignoring the common "no receiver" case.
 * @param {object} message
 */
function broadcast(message) {
  try {
    const result = api.runtime.sendMessage(message, () => {
      void api.runtime.lastError;
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {}
}

const pendingAdded = new Map();
const pendingUpdated = new Map();
let broadcastTimer = null;

/**
 * Coalesce per-request notifications into one message per tick.
 *
 * A single navigation can fire hundreds of request/header/status events; the
 * UI only needs the net result, and re-rendering per event is what made the
 * list feel slow.
 * @param {object} entry
 * @param {boolean} isNew
 */
function queueRequestChange(entry, isNew) {
  if (isNew) {
    pendingAdded.set(entry.id, entry);
  } else if (!pendingAdded.has(entry.id)) {
    pendingUpdated.set(entry.id, entry);
  }
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(flushRequestChanges, BROADCAST_DEBOUNCE_MS);
}

function flushRequestChanges() {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  if (!pendingAdded.size && !pendingUpdated.size) return;
  const added = Array.from(pendingAdded.values());
  const updated = Array.from(pendingUpdated.values());
  pendingAdded.clear();
  pendingUpdated.clear();
  broadcast({ type: 'requestsChanged', added, updated });
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

let metaDirty = false;
let requestsDirty = false;
let saveTimer = null;
let saveDeadline = 0;
let quotaWarned = false;

/**
 * Mark state dirty and schedule a write.
 *
 * The captured request list can be tens of megabytes; writing all of it on
 * every network event was the single largest cost in the capture path.
 * @param {{ meta?: boolean, requests?: boolean }} [what]
 */
function scheduleSave(what = {}) {
  if (what.meta !== false) metaDirty = true;
  if (what.requests !== false) requestsDirty = true;
  const now = Date.now();
  if (!saveDeadline) saveDeadline = now + SAVE_MAX_DELAY_MS;
  if (saveTimer) clearTimeout(saveTimer);
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, saveDeadline - now));
  saveTimer = setTimeout(() => { void flushSave(); }, delay);
}

/** Mark everything dirty. */
function saveState() {
  scheduleSave({ meta: true, requests: true });
}

/** Mark only the request list dirty. */
function saveRequests() {
  scheduleSave({ meta: false, requests: true });
}

/**
 * Write pending state to storage.
 * @returns {Promise<void>}
 */
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveDeadline = 0;
  if (!metaDirty && !requestsDirty) return;
  const payload = {};
  if (metaDirty) {
    payload.settings = settings;
    payload.sessions = sessions;
    payload.sites = sites;
    payload.currentSessionId = currentSessionId;
    payload.uatConfigs = uatConfigs;
    payload.lastRequestAt = lastRequestAt;
    payload.idlePrompted = idlePrompted;
  }
  if (requestsDirty) payload.requests = requests;
  metaDirty = false;
  requestsDirty = false;
  try {
    await api.storage.local.set(payload);
  } catch (error) {
    await handleSaveFailure(error, payload);
  }
}

/**
 * Recover from a failed write, most commonly a storage quota overflow.
 * @param {any} error
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function handleSaveFailure(error, payload) {
  console.error('[Launch Observer] storage write failed', error);
  if (!payload.requests) return;
  // Drop the oldest half and retry once so capture can continue rather than
  // silently losing every subsequent write.
  const keep = Math.max(1, Math.floor(requests.length / 2));
  const removed = requests.splice(0, requests.length - keep);
  removed.forEach(entry => {
    if (requestIndex.get(entry.requestId) === entry) requestIndex.delete(entry.requestId);
  });
  invalidateSessionRequests();
  try {
    await api.storage.local.set({ requests });
    if (!quotaWarned) {
      quotaWarned = true;
      broadcast({ type: 'storageTrimmed', kept: requests.length });
    }
  } catch (retryError) {
    console.error('[Launch Observer] storage write failed after trim', retryError);
  }
}

/**
 * Load persisted extension state from storage.
 * @returns {Promise<void>}
 */
async function loadState() {
  try {
    const stored = await api.storage.local.get([
      'settings', 'requests', 'sessions', 'sites', 'currentSessionId', 'uatConfigs', 'lastRequestAt', 'idlePrompted'
    ]);
    if (stored.settings) settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    if (Array.isArray(stored.requests)) {
      requests = stored.requests;
      requestIndex = new Map(requests.map(r => [r.requestId, r]));
    }
    if (Array.isArray(stored.sessions)) sessions = stored.sessions;
    if (Array.isArray(stored.sites)) sites = stored.sites;
    if (stored.currentSessionId) currentSessionId = stored.currentSessionId;
    if (stored.uatConfigs && typeof stored.uatConfigs === 'object') {
      uatConfigs = Object.fromEntries(
        Object.entries(stored.uatConfigs).map(([key, value]) => [key, normalizeUatConfig(value)])
      );
    }
    if (stored.lastRequestAt) lastRequestAt = stored.lastRequestAt;
    if (stored.idlePrompted !== undefined) idlePrompted = !!stored.idlePrompted;
    if (!currentSessionId) currentSessionId = sessions[0]?.id || null;
    if (!settings.selectedSessionId) settings.selectedSessionId = currentSessionId;
  } catch (error) {
    console.error('[Launch Observer] failed to load state', error);
  } finally {
    invalidateSessionRequests();
  }
}

/* ------------------------------------------------------------------ *
 * Request bookkeeping
 * ------------------------------------------------------------------ */

const sessionRequestsCache = new Map();

function invalidateSessionRequests() {
  sessionRequestsCache.clear();
}

/**
 * Requests belonging to a session, cached between structural changes.
 * @param {string} sessionId
 * @returns {Array<object>}
 */
function getSessionRequests(sessionId) {
  let list = sessionRequestsCache.get(sessionId);
  if (!list) {
    list = requests.filter(r => r.sessionId === sessionId);
    sessionRequestsCache.set(sessionId, list);
  }
  return list;
}

/**
 * Whether a config needs the full session history to evaluate.
 *
 * Only page-scope counting assertions look beyond the current request, so
 * request-scope configs skip building the session list entirely.
 * @param {object} config
 * @returns {boolean}
 */
function configNeedsSessionHistory(config) {
  if (!config || !Array.isArray(config.assertions)) return false;
  if (config.__needsHistory === undefined) {
    Object.defineProperty(config, '__needsHistory', {
      value: config.assertions.some(a => a.scope === 'page' && a.count && a.value != null),
      enumerable: false,
      configurable: true
    });
  }
  return config.__needsHistory;
}

/**
 * Check whether a URL matches the allowlist.
 * @param {string} url
 * @returns {boolean}
 */
function isAllowed(url) {
  try {
    const domain = getDomainFromUrl(url);
    return settings.allowlist.some(entry => {
      const trimmed = entry.trim();
      if (!trimmed) return false;
      if (domain === trimmed) return true;
      return domain.endsWith(`.${trimmed}`);
    });
  } catch {
    return false;
  }
}

/**
 * Trim request list to max entries.
 */
function trimRequests() {
  const max = settings.maxEntries || DEFAULT_SETTINGS.maxEntries;
  if (requests.length <= max) return;
  const removed = requests.splice(0, requests.length - max);
  removed.forEach(entry => {
    if (requestIndex.get(entry.requestId) === entry) requestIndex.delete(entry.requestId);
  });
  invalidateSessionRequests();
}

/**
 * Create a new request entry from webRequest details.
 * @param {object} details
 */
function addRequest(details) {
  const sessionId = currentSessionId || settings.selectedSessionId;
  const nav = navState.get(details.tabId) || {};
  const cachedUrl = tabUrlCache.get(details.tabId);
  const requestId = getRequestIdFromUrl(details.url);
  const cachedPayload = requestId ? pullCachedPayload(requestId) : pullCachedPayloadByUrl(details.tabId, details.url, details.timeStamp);
  const hookMatch = pullHookPayload(details.tabId, details.url, details.timeStamp)
    || pullHookPayloadByUrl(details.url, details.timeStamp);
  const cachedBody = hookMatch?.payload || cachedPayload?.payload || null;
  const cachedPageUrl = hookMatch?.pageUrl || cachedPayload?.pageUrl || '';
  const pageUrl = nav.pageUrl
    || nav.pendingUrl
    || cachedUrl
    || details.documentUrl
    || details.initiator
    || cachedPageUrl
    || extractPageUrlFromRequest(details.url)
    || null;
  const session = sessions.find(s => s.id === sessionId);
  const uatConfig = session?.site ? uatConfigs[session.site] : null;
  const domain = safeDomain(details.url);
  const entry = {
    id: `${details.requestId}:${details.timeStamp}`,
    requestId: details.requestId,
    sessionId,
    tabId: details.tabId,
    frameId: details.frameId,
    method: details.method,
    url: details.url,
    documentUrl: details.documentUrl || null,
    initiator: details.initiator || null,
    domain,
    serviceId: resolveServiceIdForDomain(domain, settings.serviceMappings || []),
    path: safePath(details.url),
    timeStamp: details.timeStamp,
    startTime: details.timeStamp,
    statusCode: null,
    statusLine: null,
    duration: null,
    requestHeaders: [],
    query: parseQueryString(details.url),
    body: cachedBody,
    pageUrl,
    navId: nav.navId || null,
    uat: session?.uatEnabled && uatConfig ? { status: 'pending', results: [] } : null
  };

  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  requests.push(entry);
  requestIndex.set(details.requestId, entry);
  const cached = sessionRequestsCache.get(entry.sessionId);
  if (cached) cached.push(entry);
  lastRequestAt = Date.now();
  idlePrompted = false;
  trimRequests();
  saveState();
  queueRequestChange(entry, true);
}

/**
 * Update a request entry and broadcast changes.
 * @param {string} requestId
 * @param {object} patch
 */
function updateRequest(requestId, patch) {
  const entry = requestIndex.get(requestId);
  if (!entry) return;
  Object.assign(entry, patch);
  if (!entry.pageUrl && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveRequests();
  queueRequestChange(entry, false);
}

/**
 * Hostname for a URL, or an empty string when it cannot be parsed.
 * @param {string} url
 * @returns {string}
 */
function safeDomain(url) {
  try {
    return getDomainFromUrl(url);
  } catch {
    return '';
  }
}

/**
 * Pathname for a URL, or "/" when it cannot be parsed.
 * @param {string} url
 * @returns {string}
 */
function safePath(url) {
  try {
    return getPathFromUrl(url);
  } catch {
    return '/';
  }
}

/**
 * Check whether a request entry looks like WebSDK.
 * @param {object} entry
 * @returns {boolean}
 */
function isWebsdkRequest(entry) {
  if (!entry) return false;
  const params = entry.query?.params || [];
  return params.some(param => String(param.key).toLowerCase() === 'configid');
}

/**
 * Attach a WebSDK hook payload to the most recent matching request.
 * @param {number} tabId
 * @param {object} payload
 * @param {string} pageUrl
 * @param {number} hookTs
 */
function attachWebsdkPayloadToRecent(tabId, payload, pageUrl, hookTs) {
  if (!payload) return;
  const now = Date.now();
  let entry = null;
  // Requests are appended in arrival order, so walking backwards finds the
  // most recent match first — the same entry the previous full scan picked.
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const item = requests[i];
    if (item.tabId !== tabId) continue;
    if (!isWebsdkRequest(item)) continue;
    if (Math.abs((hookTs || now) - (item.timeStamp || now)) >= 20000) continue;
    entry = item;
    break;
  }
  if (!entry) return;
  if (!shouldReplaceBody(entry.body, payload)) return;
  debugHookLog('attach: websdk recent', { tabId, id: entry.id, hookTs });
  entry.body = payload;
  if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveRequests();
  queueRequestChange(entry, false);
}

/**
 * Evaluate UAT assertions for a request entry.
 * @param {object} entry
 */
function evaluateUatForRequest(entry) {
  if (!entry) return;
  const session = sessions.find(s => s.id === entry.sessionId);
  if (!session || !session.uatEnabled) {
    entry.uat = null;
    return;
  }
  const config = session.site ? uatConfigs[session.site] : null;
  if (!config || !Array.isArray(config.assertions)) {
    entry.uat = { status: 'not-applicable', results: [] };
    return;
  }
  const sessionRequests = configNeedsSessionHistory(config) ? getSessionRequests(entry.sessionId) : [];
  const results = evaluateAssertionsForRequest(entry, config.assertions, sessionRequests, {
    global: config.global || null,
    serviceId: entry.serviceId || null
  });
  if (!results.length) {
    entry.uat = { status: 'not-applicable', results: [] };
    return;
  }
  entry.uat = {
    status: 'done',
    results
  };
}

/**
 * Stop the active session due to idle timeout.
 * @param {string} [reason='idle']
 */
function stopActiveSession(reason = 'idle') {
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return;
  const session = sessions.find(s => s.id === sessionId);
  if (session) session.paused = true;
  settings.selectedSessionId = null;
  currentSessionId = null;
  settings.capturePaused = true;
  idlePrompted = false;
  saveState();
  broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
  broadcast({ type: 'settingsUpdated', settings });
  broadcast({ type: 'sessionStopped', reason, sessionId });
}

/**
 * Trigger idle modal if no requests were captured recently.
 */
function checkForIdleSession() {
  if (!stateReady) return;
  if (settings.capturePaused) return;
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return;
  if (idlePrompted) return;
  if (Date.now() - lastRequestAt < IDLE_TIMEOUT_MS) return;
  idlePrompted = true;
  saveState();
  broadcast({ type: 'sessionIdle', sessionId });
}

const WORKBENCH_WIDTH = 1280;
const WORKBENCH_HEIGHT = 820;

/**
 * Open the workbench in its own window.
 *
 * A detached popup (rather than a tab) keeps the inspector beside the page
 * being tested, the way Adobe's Experience Debugger works. If one is already
 * open it is focused instead of duplicated.
 * @returns {Promise<void>}
 */
async function openWorkbench() {
  const url = api.runtime.getURL('pages/app.html');
  try {
    const existing = await api.tabs.query({ url });
    if (existing.length) {
      const tab = existing[0];
      if (tab.windowId !== undefined && api.windows?.update) {
        await api.windows.update(tab.windowId, { focused: true });
      }
      await api.tabs.update(tab.id, { active: true });
      return;
    }
  } catch {}

  if (api.windows?.create) {
    try {
      await api.windows.create({ url, type: 'popup', width: WORKBENCH_WIDTH, height: WORKBENCH_HEIGHT });
      return;
    } catch (error) {
      console.error('[Launch Observer] could not open the workbench window', error);
    }
  }
  // Fall back to a tab where popup windows are unavailable.
  try {
    await api.tabs.create({ url });
  } catch (error) {
    console.error('[Launch Observer] could not open the workbench', error);
  }
}

/**
 * End active session if the app window is closed.
 * @returns {Promise<void>}
 */
async function endActiveSessionIfClosed() {
  try {
    const url = api.runtime.getURL('pages/app.html');
    const tabs = await api.tabs.query({ url });
    if (tabs.length) return;
    stopActiveSession('ui-closed');
  } catch {}
}

/* ------------------------------------------------------------------ *
 * Payload correlation caches
 * ------------------------------------------------------------------ */

/**
 * Cache payload by requestId.
 * @param {string} requestId
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function cachePayload(requestId, payload, pageUrl = '') {
  const existing = payloadCache.get(requestId);
  payloadCache.set(requestId, {
    payload,
    pageUrl: pageUrl || existing?.pageUrl || '',
    ts: Date.now()
  });
  prunePayloadCache();
}

/**
 * Cache page context by requestId without a payload.
 * @param {string} requestId
 * @param {string} pageUrl
 */
function cachePageContext(requestId, pageUrl = '') {
  if (!requestId || !pageUrl) return;
  const existing = payloadCache.get(requestId);
  if (existing?.payload) return;
  payloadCache.set(requestId, { payload: null, pageUrl, ts: Date.now() });
  prunePayloadCache();
}

/**
 * Pull cached payload by requestId (one-time).
 * @param {string} requestId
 * @returns {object|null}
 */
function pullCachedPayload(requestId) {
  const entry = payloadCache.get(requestId);
  if (!entry) return null;
  payloadCache.delete(requestId);
  if (Date.now() - entry.ts > PAYLOAD_TTL_MS) return null;
  return entry;
}

/**
 * Prune expired payload entries.
 */
function prunePayloadCache() {
  const now = Date.now();
  for (const [key, value] of payloadCache.entries()) {
    if (now - value.ts > PAYLOAD_TTL_MS) payloadCache.delete(key);
  }
}

/**
 * Cache payload by tab + URL.
 * @param {number} tabId
 * @param {string} url
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function cachePayloadByUrl(tabId, url, payload, pageUrl = '') {
  if (tabId === undefined || !url) return;
  const list = payloadCacheByUrlTab.get(tabId) || [];
  list.push({ url, payload, pageUrl, ts: Date.now() });
  payloadCacheByUrlTab.set(tabId, list);
  prunePayloadCacheByUrl(tabId);
}

function cacheHookPayload(tabId, url, payload, pageUrl = '', hookTs = 0) {
  if (tabId === undefined || !url) return;
  const key = `${tabId}::${url}`;
  const list = hookQueueByTabUrl.get(key) || [];
  list.push({ payload, pageUrl, ts: hookTs || Date.now() });
  hookQueueByTabUrl.set(key, list);
  pruneHookQueue(key);

  const urlList = hookQueueByUrl.get(url) || [];
  urlList.push({ payload, pageUrl, ts: hookTs || Date.now() });
  hookQueueByUrl.set(url, urlList);
  pruneHookQueueByUrl(url);
}

function pullHookPayload(tabId, url, timeStamp) {
  if (tabId === undefined || !url) return null;
  const key = `${tabId}::${url}`;
  const list = hookQueueByTabUrl.get(key);
  if (!list || !list.length) return null;
  const now = Date.now();
  const matchIndex = list.findIndex(entry => Math.abs((timeStamp || now) - entry.ts) < 20000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  if (!list.length) hookQueueByTabUrl.delete(key);
  debugHookLog('pull: hookQueue tab+url', { url, tabId, hookTs: entry.ts });
  return entry;
}

function pruneHookQueue(key) {
  const list = hookQueueByTabUrl.get(key);
  if (!list) return;
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  if (filtered.length) {
    hookQueueByTabUrl.set(key, filtered);
  } else {
    hookQueueByTabUrl.delete(key);
  }
}

function pullHookPayloadByUrl(url, timeStamp) {
  if (!url) return null;
  const list = hookQueueByUrl.get(url);
  if (!list || !list.length) return null;
  const now = Date.now();
  const matchIndex = list.findIndex(entry => Math.abs((timeStamp || now) - entry.ts) < 20000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  if (!list.length) hookQueueByUrl.delete(url);
  debugHookLog('pull: hookQueue url', { url, hookTs: entry.ts });
  return entry;
}

function pruneHookQueueByUrl(url) {
  const list = hookQueueByUrl.get(url);
  if (!list) return;
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  if (filtered.length) {
    hookQueueByUrl.set(url, filtered);
  } else {
    hookQueueByUrl.delete(url);
  }
}

/**
 * Drop correlation state that can no longer be matched.
 *
 * These maps are keyed by URL rather than tab, so tab close alone never
 * cleared them and they grew for the lifetime of the background script.
 */
function pruneAllCaches() {
  const now = Date.now();
  prunePayloadCache();
  for (const key of Array.from(hookQueueByTabUrl.keys())) pruneHookQueue(key);
  for (const url of Array.from(hookQueueByUrl.keys())) pruneHookQueueByUrl(url);
  for (const [tabId, list] of Array.from(payloadCacheByUrlTab.entries())) {
    const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
    if (filtered.length) {
      payloadCacheByUrlTab.set(tabId, filtered);
    } else {
      payloadCacheByUrlTab.delete(tabId);
    }
  }
}

/**
 * Cache page context by tab + URL without a payload.
 * @param {number} tabId
 * @param {string} url
 * @param {string} pageUrl
 */
function cachePageContextByUrl(tabId, url, pageUrl = '') {
  if (tabId === undefined || !url || !pageUrl) return;
  const list = payloadCacheByUrlTab.get(tabId) || [];
  const existing = list.find(entry => entry.url === url && entry.payload);
  if (existing) return;
  list.push({ url, payload: null, pageUrl, ts: Date.now() });
  payloadCacheByUrlTab.set(tabId, list);
  prunePayloadCacheByUrl(tabId);
}

/**
 * Pull cached payload for a tab + URL near a timestamp.
 * @param {number} tabId
 * @param {string} url
 * @param {number} timeStamp
 * @returns {object|null}
 */
function pullCachedPayloadByUrl(tabId, url, timeStamp) {
  if (tabId === undefined || !url) return null;
  const list = payloadCacheByUrlTab.get(tabId);
  if (!list || !list.length) return null;
  const now = Date.now();
  const matchIndex = list.findIndex(entry => entry.url === url && Math.abs((timeStamp || now) - entry.ts) < 15000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  if (!list.length) payloadCacheByUrlTab.delete(tabId);
  return entry || null;
}

/**
 * Prune expired payload cache entries for a tab.
 * @param {number} tabId
 */
function prunePayloadCacheByUrl(tabId) {
  const list = payloadCacheByUrlTab.get(tabId);
  if (!list) return;
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  if (filtered.length) {
    payloadCacheByUrlTab.set(tabId, filtered);
  } else {
    payloadCacheByUrlTab.delete(tabId);
  }
}

/**
 * Extract requestId query param from URL.
 * @param {string} url
 * @returns {string|null}
 */
function getRequestIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('requestId');
  } catch {
    return null;
  }
}

/**
 * Attempt to infer a page URL from known query params.
 * @param {string} url
 * @returns {string|null}
 */
function extractPageUrlFromRequest(url) {
  try {
    const parsed = new URL(url);
    const candidates = [
      'dl',
      'documentLocation',
      'document_location',
      'page_location',
      'pageLocation',
      'u',
      'url'
    ];
    for (const key of candidates) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith('http')) return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to infer a page URL from a request payload.
 * @param {object} body
 * @returns {string|null}
 */
function extractPageUrlFromPayload(body) {
  if (!body) return null;
  const payload = body.parsed && typeof body.parsed === 'object' ? body.parsed : null;
  if (!payload) return null;
  const candidates = [
    payload?.events?.[0]?.web?.webPageDetails?.URL,
    payload?.events?.[0]?.xdm?.web?.webPageDetails?.URL,
    payload?.xdm?.web?.webPageDetails?.URL,
    payload?.web?.webPageDetails?.URL
  ];
  const found = candidates.find(value => typeof value === 'string' && value.startsWith('http'));
  return found || null;
}

/**
 * Attach cached payload to matching requests by requestId.
 * @param {string} requestId
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function attachPayloadToRequests(requestId, payload, pageUrl = '') {
  if (!requestId) return;
  let updated = false;
  requests.forEach(entry => {
    if (!shouldReplaceBody(entry.body, payload)) return;
    const idInUrl = getRequestIdFromUrl(entry.url);
    if (idInUrl && idInUrl === requestId) {
      debugHookLog('attach: requestId match', { requestId, url: entry.url, id: entry.id });
      entry.body = payload;
      if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
      if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
        entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
      }
      evaluateUatForRequest(entry);
      updated = true;
      queueRequestChange(entry, false);
    }
  });
  if (updated) saveRequests();
}

/**
 * Attach cached payload to matching requests by tab and URL.
 * @param {number} tabId
 * @param {string} url
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function attachPayloadToRequestsByUrl(tabId, url, payload, pageUrl = '') {
  if (tabId === undefined || !url) return;
  let updated = false;
  requests.forEach(entry => {
    if (entry.tabId !== tabId) return;
    if (entry.url !== url) return;
    if (!shouldReplaceBody(entry.body, payload)) return;
    debugHookLog('attach: tab+url match', { url, tabId, id: entry.id });
    entry.body = payload;
    if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
    if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
      entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
    }
    evaluateUatForRequest(entry);
    updated = true;
    queueRequestChange(entry, false);
  });
  if (updated) saveRequests();
}

/**
 * Attach page URL context to requests by requestId.
 * @param {string} requestId
 * @param {string} pageUrl
 */
function attachPageContextToRequests(requestId, pageUrl = '') {
  if (!requestId || !pageUrl) return;
  let updated = false;
  requests.forEach(entry => {
    if (entry.pageUrl && entry.pageUrl !== '/') return;
    const idInUrl = getRequestIdFromUrl(entry.url);
    if (idInUrl && idInUrl === requestId) {
      entry.pageUrl = pageUrl;
      updated = true;
      queueRequestChange(entry, false);
    }
  });
  if (updated) saveRequests();
}

/**
 * Attach page URL context to requests by tab and URL.
 * @param {number} tabId
 * @param {string} url
 * @param {string} pageUrl
 */
function attachPageContextToRequestsByUrl(tabId, url, pageUrl = '') {
  if (tabId === undefined || !url || !pageUrl) return;
  let updated = false;
  requests.forEach(entry => {
    if (entry.pageUrl && entry.pageUrl !== '/') return;
    if (entry.tabId !== tabId) return;
    if (entry.url !== url) return;
    entry.pageUrl = pageUrl;
    updated = true;
    queueRequestChange(entry, false);
  });
  if (updated) saveRequests();
}

function attachHookPayloadToRecent(url, tabId, payload, pageUrl, hookTs) {
  if (!url || !payload) return;
  const now = Date.now();
  let entry = null;
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const item = requests[i];
    if (item.url !== url) continue;
    if (tabId !== undefined && item.tabId !== tabId) continue;
    if (Math.abs((hookTs || now) - (item.timeStamp || now)) >= 20000) continue;
    entry = item;
    break;
  }
  if (!entry) return;
  if (!shouldReplaceBody(entry.body, payload)) return;
  debugHookLog('attach: recent url match', { url, tabId, id: entry.id, hookTs });
  entry.body = payload;
  if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveRequests();
  queueRequestChange(entry, false);
}

/**
 * Check whether a request body is empty.
 * @param {object|null} body
 * @returns {boolean}
 */
function isBodyEmpty(body) {
  if (!body) return true;
  if (body.parsed) {
    if (Array.isArray(body.parsed?.params)) return body.parsed.params.length === 0;
    if (typeof body.parsed === 'object') return Object.keys(body.parsed).length === 0;
    return false;
  }
  if (typeof body.raw === 'string') return body.raw.length === 0;
  return false;
}

/**
 * Decide whether to replace an existing body with a hook payload.
 * @param {object|null} existing
 * @param {object|null} incoming
 * @returns {boolean}
 */
function shouldReplaceBody(existing, incoming) {
  if (!incoming) return false;
  if (isBodyEmpty(existing)) return true;
  if (!existing) return true;
  const incomingParsed = incoming.parsed && typeof incoming.parsed === 'object' ? incoming.parsed : null;
  const existingParsed = existing?.parsed && typeof existing.parsed === 'object' ? existing.parsed : null;
  if (!incomingParsed) return false;
  const incomingHasEvents = !!(incomingParsed.events || incomingParsed.xdm || incomingParsed._experience || incomingParsed.data);
  if (!incomingHasEvents) return false;
  const existingHasEvents = !!(existingParsed?.events || existingParsed?.xdm || existingParsed?._experience || existingParsed?.data);
  if (!existingHasEvents) return true;
  const existingRawLen = typeof existing?.raw === 'string' ? existing.raw.length : 0;
  const incomingRawLen = typeof incoming?.raw === 'string' ? incoming.raw.length : 0;
  return incomingRawLen > existingRawLen && incomingHasEvents;
}

/**
 * Create a new session object.
 * @param {string} name
 * @param {string} site
 * @param {number|null} lockTabId
 * @param {boolean} uatEnabled
 * @returns {object}
 */
function createSession(name, site, lockTabId, uatEnabled) {
  return {
    id: `session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name,
    site,
    lockTabId: lockTabId ?? null,
    paused: false,
    createdAt: Date.now(),
    uatEnabled: !!uatEnabled
  };
}

/* ------------------------------------------------------------------ *
 * Message handling
 * ------------------------------------------------------------------ */

/**
 * Handle a runtime message once state is ready.
 * @param {object} message
 * @param {object} sender
 * @param {Function} sendResponse
 */
function handleMessage(message, sender, sendResponse) {
  if (message.type === 'getSettings') {
    sendResponse({ settings });
    return;
  }
  if (message.type === 'getState') {
    sendResponse({ settings, requests, sessions, sites, currentSessionId, uatConfigs });
    return;
  }
  if (message.type === 'setSettings') {
    const prevEnableHooks = settings.enableHooks;
    settings = { ...settings, ...message.settings };
    saveState();
    broadcast({ type: 'settingsUpdated', settings });
    if (!prevEnableHooks && settings.enableHooks) {
      const sessionId = settings.selectedSessionId || currentSessionId;
      const session = sessions.find(s => s.id === sessionId);
      if (session?.lockTabId !== null && session?.lockTabId !== undefined) {
        platform.injectHooks(session.lockTabId, '', 'enable-hooks');
      }
    }
    sendResponse({ ok: true, settings });
    return;
  }
  if (message.type === 'idleExtend') {
    lastRequestAt = Date.now();
    idlePrompted = false;
    saveState();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'idleStop') {
    stopActiveSession('idle');
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'setUatConfig') {
    const site = (message.site || '').trim();
    if (!site || !message.config) {
      sendResponse({ ok: false });
      return;
    }
    if (!sites.includes(site)) sites.unshift(site);
    uatConfigs = { ...uatConfigs, [site]: normalizeUatConfig(message.config) };
    requests.forEach(entry => {
      const session = sessions.find(s => s.id === entry.sessionId);
      if (!session || !session.uatEnabled) return;
      if (session.site !== site) return;
      evaluateUatForRequest(entry);
      queueRequestChange(entry, false);
    });
    saveState();
    broadcast({ type: 'sitesUpdated', sites });
    broadcast({ type: 'uatConfigsUpdated', uatConfigs });
    sendResponse({ ok: true, uatConfigs });
    return;
  }
  if (message.type === 'clearRequests') {
    const targetSession = settings.selectedSessionId || currentSessionId;
    if (targetSession) {
      requests = requests.filter(r => r.sessionId !== targetSession);
    } else {
      requests = [];
    }
    requestIndex = new Map(requests.map(r => [r.requestId, r]));
    invalidateSessionRequests();
    saveState();
    broadcast({ type: 'requestsCleared' });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'startSession') {
    const site = (message.site || '').trim();
    if (!site) {
      sendResponse({ ok: false, error: 'site_required' });
      return;
    }
    const name = (message.name || '').trim() || `Session ${sessions.length + 1}`;
    const previousId = settings.selectedSessionId || currentSessionId;
    if (previousId) {
      const previous = sessions.find(s => s.id === previousId);
      if (previous) previous.paused = true;
    }
    const session = createSession(name, site, message.lockTabId || null, !!message.uatEnabled);
    sessions.unshift(session);
    if (!sites.includes(site)) sites.unshift(site);
    currentSessionId = session.id;
    settings.selectedSessionId = session.id;
    settings.capturePaused = false;
    lastRequestAt = Date.now();
    idlePrompted = false;
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    broadcast({ type: 'settingsUpdated', settings });
    broadcast({ type: 'sitesUpdated', sites });
    if (session.lockTabId !== null && session.lockTabId !== undefined) {
      platform.injectHooks(session.lockTabId, '', 'session-start');
    }
    sendResponse({ ok: true, session });
    return;
  }
  if (message.type === 'renameSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) session.name = message.name || session.name;
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'updateSession') {
    const session = sessions.find(s => s.id === message.id);
    if (!session) {
      sendResponse({ ok: false });
      return;
    }
    const previousLockTabId = session.lockTabId;
    if (message.name !== undefined) session.name = message.name || session.name;
    if (message.site) session.site = message.site;
    if (message.lockTabId !== undefined) session.lockTabId = message.lockTabId;
    if (message.uatEnabled !== undefined) session.uatEnabled = !!message.uatEnabled;
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    if (message.lockTabId !== undefined && session.lockTabId !== previousLockTabId) {
      if (session.lockTabId !== null && session.lockTabId !== undefined) {
        platform.injectHooks(session.lockTabId, '', 'session-update');
      }
    }
    sendResponse({ ok: true, session });
    return;
  }
  if (message.type === 'selectSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) {
      settings.selectedSessionId = message.id;
      settings.capturePaused = !!session.paused;
      saveState();
      broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
      broadcast({ type: 'settingsUpdated', settings });
      if (!session.paused && session.lockTabId !== null && session.lockTabId !== undefined) {
        platform.injectHooks(session.lockTabId, '', 'select-session');
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'pauseSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) {
      settings.selectedSessionId = session.id;
      currentSessionId = session.id;
      session.paused = true;
      settings.capturePaused = true;
      idlePrompted = false;
      saveState();
      broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
      broadcast({ type: 'settingsUpdated', settings });
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'deleteSession') {
    const id = message.id;
    if (!id) {
      sendResponse({ ok: false });
      return;
    }
    sessions = sessions.filter(s => s.id !== id);
    requests = requests.filter(r => r.sessionId !== id);
    requestIndex = new Map(requests.map(r => [r.requestId, r]));
    invalidateSessionRequests();
    if (settings.selectedSessionId === id) {
      settings.selectedSessionId = sessions[0]?.id || null;
    }
    if (currentSessionId === id) {
      currentSessionId = settings.selectedSessionId || null;
    }
    idlePrompted = false;
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'clearSessions') {
    sessions = [];
    requests = [];
    requestIndex = new Map();
    invalidateSessionRequests();
    currentSessionId = null;
    settings.selectedSessionId = null;
    idlePrompted = false;
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'clearAllData') {
    sessions = [];
    requests = [];
    requestIndex = new Map();
    invalidateSessionRequests();
    sites = [];
    uatConfigs = {};
    currentSessionId = null;
    settings.selectedSessionId = null;
    settings.capturePaused = true;
    idlePrompted = false;
    payloadCache.clear();
    payloadCacheByUrlTab.clear();
    hookQueueByTabUrl.clear();
    hookQueueByUrl.clear();
    saveState();
    broadcast({ type: 'sessionsUpdated', sessions, currentSessionId });
    broadcast({ type: 'sitesUpdated', sites });
    broadcast({ type: 'uatConfigsUpdated', uatConfigs });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'capturedPayload') {
    if (!message.payload) {
      sendResponse({ ok: false });
      return;
    }
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return;
    }
    if (!message.url || !isAllowed(message.url)) {
      debugHookLog('drop: url not allowed', { url: message.url });
      sendResponse({ ok: false });
      return;
    }
    debugHookLog('capturedPayload', {
      url: message.url,
      requestId: message.requestId,
      hookTs: message.hookTs,
      tabId: sender?.tab?.id,
      pageUrl: message.pageUrl
    });
    if (message.requestId) cachePayload(message.requestId, message.payload, message.pageUrl || '');
    if (sender?.tab?.id !== undefined) {
      cachePayloadByUrl(sender.tab.id, message.url, message.payload, message.pageUrl || '');
      cacheHookPayload(sender.tab.id, message.url, message.payload, message.pageUrl || '', message.hookTs || 0);
    }
    if (message.requestId) attachPayloadToRequests(message.requestId, message.payload, message.pageUrl || '');
    if (sender?.tab?.id !== undefined) {
      attachPayloadToRequestsByUrl(sender.tab.id, message.url, message.payload, message.pageUrl || '');
    }
    attachHookPayloadToRecent(message.url, sender?.tab?.id, message.payload, message.pageUrl || '', message.hookTs || 0);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'pageContext') {
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session (pageContext)', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled (pageContext)', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return;
    }
    if (!message.url || !isAllowed(message.url)) {
      debugHookLog('drop: url not allowed (pageContext)', { url: message.url });
      sendResponse({ ok: false });
      return;
    }
    debugHookLog('pageContext', {
      url: message.url,
      requestId: message.requestId,
      hookTs: message.hookTs,
      tabId: sender?.tab?.id,
      pageUrl: message.pageUrl
    });
    if (message.requestId) cachePageContext(message.requestId, message.pageUrl || '');
    if (sender?.tab?.id !== undefined) {
      cachePageContextByUrl(sender.tab.id, message.url, message.pageUrl || '');
    }
    if (message.requestId) attachPageContextToRequests(message.requestId, message.pageUrl || '');
    if (sender?.tab?.id !== undefined) {
      attachPageContextToRequestsByUrl(sender.tab.id, message.url, message.pageUrl || '');
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'hookReady') {
    debugHookLog('hook: ready', { tabId: sender?.tab?.id });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'hookCall') {
    debugHookLog('hook: call', { tabId: sender?.tab?.id, kind: message.kind, url: message.url });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'capturedWebsdk') {
    if (!message.payload) {
      sendResponse({ ok: false });
      return;
    }
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session (websdk)', { tabId: sender?.tab?.id });
      sendResponse({ ok: false });
      return;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled (websdk)', { tabId: sender?.tab?.id });
      sendResponse({ ok: false });
      return;
    }
    debugHookLog('capturedWebsdk', { tabId: sender?.tab?.id, hookTs: message.hookTs });
    const tabId = sender?.tab?.id;
    if (tabId !== undefined) {
      attachWebsdkPayloadToRecent(tabId, message.payload, message.pageUrl || '', message.hookTs || 0);
    }
    sendResponse({ ok: true });
    return;
  }
  sendResponse({ ok: false });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Register all listeners and begin loading state.
 * @param {{ api: object, injectHooks?: Function, startIdleTimer?: Function }} options
 * @returns {Promise<void>}
 */
export function start(options) {
  api = options.api;
  platform = {
    injectHooks: options.injectHooks || (async () => {}),
    startIdleTimer: options.startIdleTimer || (() => {})
  };
  const action = api.action || api.browserAction;

  api.runtime.onInstalled?.addListener(() => { void ensureLoaded(); });
  api.runtime.onStartup?.addListener(() => { void ensureLoaded(); });
  api.runtime.onSuspend?.addListener(() => {
    flushRequestChanges();
    void flushSave();
  });

  action?.onClicked.addListener(() => { void openWorkbench(); });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;
    whenReady(() => {
      try {
        handleMessage(message, sender, sendResponse);
      } catch (error) {
        console.error('[Launch Observer] message handler failed', message.type, error);
        try {
          sendResponse({ ok: false, error: 'handler_failed' });
        } catch {}
      }
    });
    return true;
  });

  api.webRequest.onBeforeRequest.addListener(
    details => {
      whenReady(() => onBeforeRequest(details));
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
  );

  api.webRequest.onBeforeSendHeaders.addListener(
    details => {
      whenReady(() => {
        if (settings.capturePaused) return;
        if (!isAllowed(details.url)) return;
        const headers = (details.requestHeaders || []).map(h => ({
          name: h.name,
          value: h.value
        }));
        const contentTypeHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
        const contentType = contentTypeHeader ? contentTypeHeader.value : '';
        const entry = requestIndex.get(details.requestId);
        if (entry && entry.body && entry.body.contentType === '') entry.body.contentType = contentType;
        updateRequest(details.requestId, { requestHeaders: headers });
      });
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );

  api.webRequest.onCompleted.addListener(
    details => {
      whenReady(() => {
        if (!isAllowed(details.url)) return;
        const entry = requestIndex.get(details.requestId);
        if (!entry) return;
        const duration = details.timeStamp - entry.startTime;
        updateRequest(details.requestId, {
          statusCode: details.statusCode,
          statusLine: details.statusLine || null,
          duration
        });
      });
    },
    { urls: ['<all_urls>'] }
  );

  api.webRequest.onErrorOccurred.addListener(
    details => {
      whenReady(() => {
        if (!isAllowed(details.url)) return;
        updateRequest(details.requestId, {
          statusCode: null,
          statusLine: details.error || 'error'
        });
      });
    },
    { urls: ['<all_urls>'] }
  );

  api.webNavigation.onCommitted.addListener(details => {
    if (details.frameId !== 0) return;
    whenReady(() => {
      const existing = navState.get(details.tabId) || { navId: 0, pageUrl: null };
      navState.set(details.tabId, {
        navId: (existing.navId || 0) + 1,
        pageUrl: existing.pageUrl || null,
        pendingUrl: details.url,
        pendingAt: details.timeStamp || Date.now()
      });
      tabUrlCache.set(details.tabId, details.url);
      platform.injectHooks(details.tabId, details.url, 'nav-committed');
    });
  });

  api.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return;
    whenReady(() => platform.injectHooks(details.tabId, details.url, 'nav-before'));
  });

  api.webNavigation.onCompleted.addListener(details => {
    if (details.frameId !== 0) return;
    whenReady(() => {
      const existing = navState.get(details.tabId) || { navId: 0 };
      navState.set(details.tabId, {
        navId: existing.navId || 0,
        pageUrl: existing.pendingUrl || details.url,
        pendingUrl: null,
        pendingAt: null
      });
      tabUrlCache.set(details.tabId, details.url);
    });
  });

  api.webNavigation.onHistoryStateUpdated.addListener(details => {
    if (details.frameId !== 0) return;
    whenReady(() => {
      navState.set(details.tabId, {
        navId: ((navState.get(details.tabId)?.navId) || 0) + 1,
        pageUrl: details.url,
        pendingUrl: null,
        pendingAt: null
      });
      tabUrlCache.set(details.tabId, details.url);
    });
  });

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    whenReady(() => {
      if (changeInfo.url) tabUrlCache.set(tabId, changeInfo.url);
      if (changeInfo.status === 'loading') {
        const targetUrl = changeInfo.url || tab?.url || '';
        if (targetUrl) platform.injectHooks(tabId, targetUrl, 'tab-loading');
      }
      if (changeInfo.status === 'complete') {
        if (tab?.url) tabUrlCache.set(tabId, tab.url);
        void endActiveSessionIfClosed();
      }
    });
  });

  api.tabs.onRemoved.addListener(tabId => {
    whenReady(() => {
      tabUrlCache.delete(tabId);
      navState.delete(tabId);
      lastInjectByTab.delete(tabId);
      payloadCacheByUrlTab.delete(tabId);
      for (const key of Array.from(hookQueueByTabUrl.keys())) {
        if (key.startsWith(`${tabId}::`)) hookQueueByTabUrl.delete(key);
      }
      pruneAllCaches();
      void endActiveSessionIfClosed();
    });
  });

  platform.startIdleTimer(() => {
    debugHookLog('idle-check', { lastRequestAt, idlePrompted });
    pruneAllCaches();
    checkForIdleSession();
  });

  return ensureLoaded();
}

/**
 * Load state once, and release anything that arrived while loading.
 * @returns {Promise<void>}
 */
function ensureLoaded() {
  if (!readyPromise) {
    readyPromise = loadState().then(drainDeferred);
  }
  return readyPromise;
}

/**
 * Handle a captured network request.
 * @param {object} details
 */
function onBeforeRequest(details) {
  if (settings.capturePaused) return;
  if (!isAllowed(details.url)) return;
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return;
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;
  if (session.lockTabId !== null && session.lockTabId !== undefined) {
    if (details.tabId !== session.lockTabId) return;
  }
  addRequest(details);
  if (settings.debugHooks) {
    debugHookLog('webRequest', {
      url: details.url,
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      type: details.type,
      documentUrl: details.documentUrl,
      initiator: details.initiator
    });
  }

  if (details.requestBody) {
    const entry = requestIndex.get(details.requestId);
    if (entry) {
      const parsedBody = parseRawBody(details.requestBody, '');
      if (parsedBody) {
        entry.body = parsedBody;
        if (!entry.pageUrl) {
          entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
        }
      }
      if (settings.debugHooks && (!entry.body || !entry.body.parsed)) {
        debugHookLog('body missing after parse', {
          url: entry.url,
          requestId: entry.requestId,
          tabId: entry.tabId,
          documentUrl: entry.documentUrl,
          initiator: entry.initiator
        });
      }
      evaluateUatForRequest(entry);
      saveRequests();
      queueRequestChange(entry, false);
    }
  }
}

/**
 * Whether the given tab should currently receive page hooks.
 *
 * Shared by the platform adapters so injection rules stay identical.
 * @param {number} tabId
 * @returns {boolean}
 */
export function shouldInjectForTab(tabId) {
  if (!settings.enableHooks) return false;
  if (settings.capturePaused) return false;
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return false;
  const session = sessions.find(s => s.id === sessionId);
  if (!session || session.paused) return false;
  if (session.lockTabId !== null && session.lockTabId !== undefined && session.lockTabId !== tabId) return false;
  return true;
}

/**
 * Debounce repeat injections into the same tab and URL.
 * @param {number} tabId
 * @param {string} url
 * @returns {boolean}
 */
export function markInjected(tabId, url) {
  const last = lastInjectByTab.get(tabId) || {};
  const now = Date.now();
  if (last.url === url && now - (last.ts || 0) < 1000) return false;
  lastInjectByTab.set(tabId, { url, ts: now });
  return true;
}

export { debugHookLog };
