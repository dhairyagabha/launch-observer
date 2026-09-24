/**
 * Chrome / Edge MV3 entry point.
 *
 * All capture logic lives in core.js, which the Firefox build shares.
 * Only MAIN-world injection and alarm scheduling differ here.
 */
import { start, shouldInjectForTab, markInjected, debugHookLog } from './core.js';

const api = globalThis.chrome || globalThis.browser;
const IDLE_CHECK_ALARM = 'idle-check';

/**
 * Check whether a URL is eligible for script injection.
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Inject the page hook in the MAIN world (Chrome/Edge only).
 * @param {number} tabId
 * @param {string} [url='']
 * @param {string} [reason='']
 * @returns {Promise<void>}
 */
async function injectHooks(tabId, url = '', reason = '') {
  if (!api.scripting?.executeScript) return;
  if (!shouldInjectForTab(tabId)) return;
  let targetUrl = url;
  if (!targetUrl) {
    try {
      const tab = await api.tabs.get(tabId);
      targetUrl = tab?.url || '';
    } catch {
      return;
    }
  }
  if (!isHttpUrl(targetUrl)) return;
  if (!markInjected(tabId, targetUrl)) return;
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/inject.js'],
      world: 'MAIN'
    });
    debugHookLog('inject: main world', { tabId, url: targetUrl, reason });
  } catch (error) {
    debugHookLog('inject: failed', { tabId, url: targetUrl, reason, error: String(error) });
  }
}

/**
 * Drive the idle check from an alarm so it survives worker restarts.
 * @param {Function} tick
 */
function startIdleTimer(tick) {
  api.alarms?.create?.(IDLE_CHECK_ALARM, { periodInMinutes: 1 });
  api.alarms?.onAlarm?.addListener(alarm => {
    if (alarm?.name === IDLE_CHECK_ALARM) tick();
  });
}

start({ api, injectHooks, startIdleTimer });
