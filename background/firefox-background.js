/**
 * Firefox MV2 entry point.
 *
 * Loaded as a module from firefox-background.html so it can share core.js
 * with the Chrome build instead of carrying its own copy of lib/.
 *
 * Firefox MV2 has no `scripting.executeScript` MAIN world, so page hooks are
 * injected only by the content script; there is nothing to do here.
 */
import { start } from './core.js';

const api = globalThis.browser || globalThis.chrome;

/**
 * Firefox background pages stay resident, so a plain interval is enough.
 * @param {Function} tick
 */
function startIdleTimer(tick) {
  setInterval(tick, 60 * 1000);
}

start({ api, startIdleTimer });
