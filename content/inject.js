(() => {
  if (window.__launchObserverHookInstalled) return;
  window.__launchObserverHookInstalled = true;
  let allowlist = [];
  let enableHooks = false;
  let allowlistReady = false;
  let hookCounter = 0;
  const pendingPayloads = [];
  const pendingPageContext = [];
  const pendingWebsdk = [];
  const MAX_PENDING = 50;
  let hookReadySent = false;
  let alloyWrapped = false;
  let alloySetterInstalled = false;
  let watchdog = null;
  let alloyTimer = null;
  let hooksInstalled = false;

  // This script runs in the page's own world, so every postMessage is visible
  // to any other script on the page. Nothing leaves this file unless it both
  // matches the user's allowlist and belongs to a session they started.
  const TARGET_ORIGIN = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : '*';

  /**
   * Post a message to the content script listener.
   * @param {object} message
   */
  function emit(message) {
    window.postMessage(message, TARGET_ORIGIN);
  }

  /**
   * Check URL against the allowlist.
   * @param {string} url
   * @returns {boolean}
   */
  function matchesAllowlist(url) {
    // Until the allowlist is known, nothing is publishable. Callers queue
    // instead, and the queue is filtered once settings arrive.
    if (!allowlistReady) return false;
    try {
      const domain = new URL(url, window.location.href).hostname;
      return allowlist.some(entry => {
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
   * Check whether captured data may be published yet.
   * @returns {boolean}
   */
  function canPublish() {
    return allowlistReady && enableHooks;
  }

  /**
   * Whether hooks should be installed right now.
   *
   * True before settings arrive (so document_start requests are not missed),
   * and afterwards only while the user has page hooks enabled.
   * @returns {boolean}
   */
  function hooksShouldRun() {
    return !allowlistReady || enableHooks;
  }

  /**
   * Extract requestId query param from URL.
   * @param {string} url
   * @returns {string|null}
   */
  function getRequestId(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.searchParams.get('requestId');
    } catch {
      return null;
    }
  }

  /**
   * Queue a payload captured before settings were known.
   * @param {string} url
   * @param {string} body
   * @param {string} [contentType='']
   */
  function enqueuePayload(url, body, contentType = '') {
    if (pendingPayloads.length >= MAX_PENDING) pendingPayloads.shift();
    pendingPayloads.push({ url, body, contentType });
  }

  function enqueuePageContext(url) {
    if (pendingPageContext.length >= MAX_PENDING) pendingPageContext.shift();
    pendingPageContext.push({ url });
  }

  function enqueueWebsdk(payload) {
    if (pendingWebsdk.length >= MAX_PENDING) pendingWebsdk.shift();
    pendingWebsdk.push(payload);
  }

  function clearPending() {
    pendingPayloads.length = 0;
    pendingPageContext.length = 0;
    pendingWebsdk.length = 0;
  }

  function flushPending() {
    if (!canPublish()) {
      clearPending();
      return;
    }
    pendingPayloads.splice(0).forEach(item => {
      postPayload(item.url, item.body, item.contentType);
    });
    pendingPageContext.splice(0).forEach(item => {
      postPageContext(item.url);
    });
    pendingWebsdk.splice(0).forEach(payload => {
      postWebsdkPayload(payload);
    });
  }

  function postPayload(url, body, contentType = '') {
    if (!allowlistReady) {
      enqueuePayload(url, body, contentType);
      return;
    }
    if (!canPublish()) return;
    if (!matchesAllowlist(url)) return;
    const requestId = getRequestId(url);
    const hookId = `${Date.now()}-${hookCounter++}`;
    const parsed = tryParseJson(body);
    const payload = {
      type: parsed ? 'json' : 'text',
      contentType: contentType || '',
      raw: body,
      parsed
    };
    emit({
      source: 'launch-observer-page',
      type: 'capturedPayload',
      requestId,
      url,
      payload,
      hookId,
      hookTs: Date.now(),
      pageUrl: window.location.href
    });
  }

  function postPageContext(url) {
    if (!allowlistReady) {
      enqueuePageContext(url);
      return;
    }
    if (!canPublish()) return;
    if (!matchesAllowlist(url)) return;
    const requestId = getRequestId(url);
    const hookId = `${Date.now()}-${hookCounter++}`;
    emit({
      source: 'launch-observer-page',
      type: 'pageContext',
      requestId,
      url,
      hookId,
      hookTs: Date.now(),
      pageUrl: window.location.href
    });
  }

  function postWebsdkPayload(payload) {
    if (!allowlistReady) {
      enqueueWebsdk(payload);
      return;
    }
    // WebSDK sendEvent is intercepted before a URL exists, so there is nothing
    // to match against the allowlist. It stays gated on the user having
    // explicitly enabled page hooks, and the background drops it unless a
    // session is active.
    if (!canPublish()) return;
    let raw = '';
    try {
      raw = JSON.stringify(payload || {});
    } catch {
      raw = '';
    }
    const parsed = tryParseJson(raw) || (payload && typeof payload === 'object' ? payload : null);
    const hookId = `${Date.now()}-${hookCounter++}`;
    emit({
      source: 'launch-observer-page',
      type: 'capturedWebsdk',
      payload: {
        type: 'json',
        contentType: 'application/json',
        raw,
        parsed
      },
      hookId,
      hookTs: Date.now(),
      pageUrl: window.location.href
    });
  }

  function postHookReady() {
    if (hookReadySent) return;
    hookReadySent = true;
    emit({ source: 'launch-observer-page', type: 'hookReady' });
  }

  function postHookCall(kind, url) {
    if (!canPublish()) return;
    if (!matchesAllowlist(url)) return;
    emit({
      source: 'launch-observer-page',
      type: 'hookCall',
      kind,
      url
    });
  }

  function wrapAlloy() {
    if (alloyWrapped) return;
    if (!hooksShouldRun()) return;
    const original = window.alloy;
    if (typeof original !== 'function') return;
    if (original.__launchObserverWrapped) {
      alloyWrapped = true;
      return;
    }
    const wrapped = function(...args) {
      try {
        const command = args[0];
        if (command === 'sendEvent' && args[1] && typeof args[1] === 'object') {
          postWebsdkPayload(args[1]);
        }
      } catch {}
      return original.apply(this, args);
    };
    wrapped.__launchObserverWrapped = true;
    wrapped.__launchObserverOriginal = original;
    try {
      Object.defineProperty(wrapped, 'name', { value: 'alloy', configurable: true });
    } catch {}
    window.alloy = wrapped;
    alloyWrapped = true;
  }

  function installAlloySetter() {
    if (alloySetterInstalled) return;
    if (!hooksShouldRun()) return;
    let current = window.alloy;
    try {
      Object.defineProperty(window, 'alloy', {
        configurable: true,
        get() {
          return current;
        },
        set(value) {
          current = value;
          alloyWrapped = false;
          wrapAlloy();
        }
      });
      alloySetterInstalled = true;
      if (current) {
        alloyWrapped = false;
        wrapAlloy();
      }
    } catch {
      alloySetterInstalled = true;
    }
  }

  /**
   * Convert request body into text when possible.
   * @param {any} body
   * @returns {Promise<string>}
   */
  function bodyToText(body) {
    if (body == null) return Promise.resolve('');
    if (typeof body === 'string') return Promise.resolve(body);
    if (body instanceof URLSearchParams) return Promise.resolve(body.toString());
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        params.append(key, typeof value === 'string' ? value : '[file]');
      }
      return Promise.resolve(params.toString());
    }
    if (body instanceof Blob) {
      return body.text();
    }
    if (body instanceof ArrayBuffer) {
      return Promise.resolve(new TextDecoder().decode(new Uint8Array(body)));
    }
    if (ArrayBuffer.isView(body)) {
      return Promise.resolve(new TextDecoder().decode(new Uint8Array(body.buffer)));
    }
    if (body instanceof ReadableStream) {
      try {
        return new Response(body).text();
      } catch {
        return Promise.resolve('');
      }
    }
    try {
      return Promise.resolve(JSON.stringify(body));
    } catch {
      return Promise.resolve('');
    }
  }

  /**
   * Attempt to parse JSON safely.
   * @param {string} text
   * @returns {object|null}
   */
  function tryParseJson(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function wrapFetch() {
    if (!hooksShouldRun()) return;
    const current = window.fetch;
    if (typeof current !== 'function') return;
    if (current.__launchObserverWrapped) return;
    const originalFetch = current;
    const wrapped = function(input, init = {}) {
      try {
        const request = input instanceof Request ? input : null;
        const url = request ? request.url : String(input);
        // Resolve the allowlist before touching the body: cloning and decoding
        // a request we will never publish is pure overhead on every page.
        if (allowlistReady && !matchesAllowlist(url)) {
          return originalFetch.apply(this, arguments);
        }
        postHookCall('fetch', url);
        const initHeaders = init && init.headers ? init.headers : null;
        const headerLookup = headerObj => {
          if (!headerObj) return '';
          if (headerObj instanceof Headers) return headerObj.get('content-type') || '';
          if (Array.isArray(headerObj)) {
            const found = headerObj.find(([k]) => String(k).toLowerCase() === 'content-type');
            return found ? found[1] : '';
          }
          return headerObj['Content-Type'] || headerObj['content-type'] || '';
        };
        const contentType = headerLookup(initHeaders) || (request ? request.headers.get('content-type') : '');
        let body = (init && init.body !== undefined) ? init.body : null;
        if (body instanceof ReadableStream && typeof body.tee === 'function') {
          const [streamA, streamB] = body.tee();
          body = streamA;
          init.body = streamB;
        }
        if (body) {
          bodyToText(body).then(text => {
            if (text) {
              postPayload(url, text, contentType);
            } else {
              postPageContext(url);
            }
          });
        } else if (request) {
          try {
            request.clone().text().then(text => {
              if (text) {
                postPayload(url, text, contentType);
              } else {
                postPageContext(url);
              }
            });
          } catch {}
        } else {
          postPageContext(url);
        }
      } catch {}
      return originalFetch.apply(this, arguments);
    };
    wrapped.__launchObserverWrapped = true;
    wrapped.__launchObserverOriginal = originalFetch;
    window.fetch = wrapped;
  }

  function wrapBeacon() {
    if (!hooksShouldRun()) return;
    const originalSendBeacon = navigator.sendBeacon;
    if (typeof originalSendBeacon !== 'function') return;
    if (originalSendBeacon.__launchObserverWrapped) return;
    const wrapped = function(url, data) {
      try {
        if (!allowlistReady || matchesAllowlist(url)) {
          postHookCall('beacon', url);
          bodyToText(data).then(text => {
            if (text) {
              postPayload(url, text, '');
            } else {
              postPageContext(url);
            }
          });
        }
      } catch {}
      return originalSendBeacon.apply(navigator, arguments);
    };
    wrapped.__launchObserverWrapped = true;
    wrapped.__launchObserverOriginal = originalSendBeacon;
    try {
      navigator.sendBeacon = wrapped;
    } catch {}
  }

  function wrapXhr() {
    if (!hooksShouldRun()) return;
    const proto = XMLHttpRequest.prototype;
    if (proto.send && proto.send.__launchObserverWrapped) return;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;
    const wrappedOpen = function(method, url) {
      this.__lo_url = url;
      this.__lo_headers = {};
      return originalOpen.apply(this, arguments);
    };
    wrappedOpen.__launchObserverWrapped = true;
    wrappedOpen.__launchObserverOriginal = originalOpen;
    const wrappedSetHeader = function(name, value) {
      try {
        this.__lo_headers[name.toLowerCase()] = value;
      } catch {}
      return originalSetHeader.apply(this, arguments);
    };
    wrappedSetHeader.__launchObserverWrapped = true;
    wrappedSetHeader.__launchObserverOriginal = originalSetHeader;
    const wrappedSend = function(body) {
      try {
        if (this.__lo_url && (!allowlistReady || matchesAllowlist(this.__lo_url))) {
          if (body) {
            postHookCall('xhr', this.__lo_url);
            bodyToText(body).then(text => {
              const contentType = this.__lo_headers?.['content-type'] || '';
              if (text) {
                postPayload(this.__lo_url, text, contentType);
              } else {
                postPageContext(this.__lo_url);
              }
            });
          } else {
            postHookCall('xhr', this.__lo_url);
            postPageContext(this.__lo_url);
          }
        }
      } catch {}
      return originalSend.apply(this, arguments);
    };
    wrappedSend.__launchObserverWrapped = true;
    wrappedSend.__launchObserverOriginal = originalSend;
    proto.open = wrappedOpen;
    proto.setRequestHeader = wrappedSetHeader;
    proto.send = wrappedSend;
  }

  function installHooks() {
    wrapFetch();
    wrapBeacon();
    wrapXhr();
    installAlloySetter();
    wrapAlloy();
    hooksInstalled = true;
    if (!watchdog) {
      // Page scripts sometimes replace fetch/XHR after we wrap them.
      watchdog = setInterval(() => {
        wrapFetch();
        wrapBeacon();
        wrapXhr();
        wrapAlloy();
        installAlloySetter();
      }, 1500);
    }
    if (!alloyTimer && !alloyWrapped) {
      let alloyChecks = 0;
      alloyTimer = setInterval(() => {
        if (alloyWrapped || alloyChecks > 40) {
          clearInterval(alloyTimer);
          alloyTimer = null;
          return;
        }
        wrapAlloy();
        alloyChecks += 1;
      }, 500);
    }
  }

  /**
   * Restore a wrapped function if it is still ours.
   * @param {any} holder
   * @param {string} key
   */
  function restore(holder, key) {
    try {
      const current = holder[key];
      if (current && current.__launchObserverWrapped && current.__launchObserverOriginal) {
        holder[key] = current.__launchObserverOriginal;
      }
    } catch {}
  }

  /**
   * Remove hooks and stop all timers when capture is not enabled.
   *
   * Without this the extension keeps a 1500 ms watchdog and patched
   * fetch/XHR/sendBeacon alive in every frame of every page the user visits,
   * whether or not they are capturing anything.
   */
  function uninstallHooks() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    if (alloyTimer) {
      clearInterval(alloyTimer);
      alloyTimer = null;
    }
    clearPending();
    if (!hooksInstalled) return;
    restore(window, 'fetch');
    restore(navigator, 'sendBeacon');
    restore(XMLHttpRequest.prototype, 'open');
    restore(XMLHttpRequest.prototype, 'setRequestHeader');
    restore(XMLHttpRequest.prototype, 'send');
    restoreAlloy();
    alloyWrapped = false;
    hooksInstalled = false;
  }

  /**
   * Unwrap alloy and drop the accessor installed over it.
   */
  function restoreAlloy() {
    try {
      const current = window.alloy;
      const original = (current && current.__launchObserverWrapped && current.__launchObserverOriginal)
        ? current.__launchObserverOriginal
        : current;
      if (alloySetterInstalled) {
        delete window.alloy;
        if (original !== undefined) window.alloy = original;
        alloySetterInstalled = false;
      } else if (original !== current) {
        window.alloy = original;
      }
    } catch {}
  }

  window.addEventListener('message', event => {
    // Only accept configuration from this window's own content script.
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'launch-observer' || event.data.type !== 'allowlist') return;
    allowlist = Array.isArray(event.data.allowlist) ? event.data.allowlist : [];
    enableHooks = !!event.data.enableHooks;
    allowlistReady = true;
    if (enableHooks) {
      installHooks();
      flushPending();
    } else {
      uninstallHooks();
    }
  });

  // Hooks go in at document_start so nothing is missed while settings load;
  // captures queue unpublished until the allowlist arrives, and the hooks come
  // straight back out if the user is not capturing.
  installHooks();
  emit({ source: 'launch-observer-page', type: 'requestAllowlist' });
  postHookReady();
})();
