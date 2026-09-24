const api = window.chrome || window.browser;

// Messages are exchanged with the page's own world, so they are only trusted
// when they originate from this window. Without that check any page script or
// cross-origin iframe could forge captures and poison the session.
const TARGET_ORIGIN = window.location.origin && window.location.origin !== 'null'
  ? window.location.origin
  : '*';

/**
 * Post allowlist settings to the page context.
 * @param {Array<string>} allowlist
 * @param {boolean} enableHooks
 */
function postAllowlist(allowlist, enableHooks) {
  window.postMessage({
    source: 'launch-observer',
    type: 'allowlist',
    allowlist,
    enableHooks: !!enableHooks
  }, TARGET_ORIGIN);
}

/**
 * Fetch settings from the background script.
 * @returns {Promise<object|null>}
 */
async function getSettings() {
  return new Promise(resolve => {
    try {
      api.runtime.sendMessage({ type: 'getSettings' }, response => {
        void api.runtime.lastError;
        resolve(response?.settings || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Send a message to the background script, ignoring a missing receiver.
 * @param {object} message
 */
function sendToBackground(message) {
  try {
    api.runtime.sendMessage(message, () => {
      void api.runtime.lastError;
    });
  } catch {}
}

/**
 * Inject the page hook script.
 */
function injectScript() {
  const script = document.createElement('script');
  script.src = api.runtime.getURL('content/inject.js');
  script.type = 'text/javascript';
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

window.addEventListener('message', event => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'launch-observer-page') return;
  if (event.data.type === 'capturedPayload') {
    sendToBackground({
      type: 'capturedPayload',
      requestId: event.data.requestId,
      url: event.data.url || '',
      payload: event.data.payload,
      hookId: event.data.hookId || '',
      hookTs: event.data.hookTs || 0,
      pageUrl: event.data.pageUrl || ''
    });
  }
  if (event.data.type === 'hookReady') {
    sendToBackground({ type: 'hookReady' });
  }
  if (event.data.type === 'hookCall') {
    sendToBackground({
      type: 'hookCall',
      kind: event.data.kind || '',
      url: event.data.url || ''
    });
  }
  if (event.data.type === 'capturedWebsdk') {
    sendToBackground({
      type: 'capturedWebsdk',
      payload: event.data.payload,
      hookId: event.data.hookId || '',
      hookTs: event.data.hookTs || 0,
      pageUrl: event.data.pageUrl || ''
    });
  }
  if (event.data.type === 'pageContext') {
    sendToBackground({
      type: 'pageContext',
      requestId: event.data.requestId,
      url: event.data.url || '',
      hookId: event.data.hookId || '',
      hookTs: event.data.hookTs || 0,
      pageUrl: event.data.pageUrl || ''
    });
  }
  if (event.data.type === 'requestAllowlist') {
    getSettings().then(settings => {
      postAllowlist(settings?.allowlist || [], settings?.enableHooks);
    });
  }
});

api.runtime.onMessage.addListener(message => {
  if (message?.type === 'settingsUpdated') {
    postAllowlist(message.settings?.allowlist || [], message.settings?.enableHooks);
  }
});

(async () => {
  injectScript();
  const settings = await getSettings();
  postAllowlist(settings?.allowlist || [], settings?.enableHooks);
})();
