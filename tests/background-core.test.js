import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal stand-in for the extension APIs core.js touches.
 *
 * `storageDelay` defers the initial read so tests can fire events into the
 * window where persisted state has not loaded yet.
 */
function createFakeApi({ stored = {}, storageDelay = 0 } = {}) {
  const listeners = new Map();
  const event = name => ({
    addListener: fn => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    }
  });
  const writes = [];
  let data = JSON.parse(JSON.stringify(stored));

  const api = {
    runtime: {
      onInstalled: event('runtime.onInstalled'),
      onStartup: event('runtime.onStartup'),
      onSuspend: event('runtime.onSuspend'),
      onMessage: event('runtime.onMessage'),
      sendMessage: (message, cb) => { if (cb) cb(); },
      lastError: null,
      getURL: p => `chrome-extension://test/${p}`
    },
    action: { onClicked: event('action.onClicked') },
    storage: {
      local: {
        get: async () => {
          if (storageDelay) await new Promise(r => setTimeout(r, storageDelay));
          return JSON.parse(JSON.stringify(data));
        },
        set: async value => {
          writes.push(JSON.parse(JSON.stringify(value)));
          data = { ...data, ...JSON.parse(JSON.stringify(value)) };
        }
      }
    },
    webRequest: {
      onBeforeRequest: event('webRequest.onBeforeRequest'),
      onBeforeSendHeaders: event('webRequest.onBeforeSendHeaders'),
      onCompleted: event('webRequest.onCompleted'),
      onErrorOccurred: event('webRequest.onErrorOccurred')
    },
    webNavigation: {
      onCommitted: event('webNavigation.onCommitted'),
      onBeforeNavigate: event('webNavigation.onBeforeNavigate'),
      onCompleted: event('webNavigation.onCompleted'),
      onHistoryStateUpdated: event('webNavigation.onHistoryStateUpdated')
    },
    tabs: {
      onUpdated: event('tabs.onUpdated'),
      onRemoved: event('tabs.onRemoved'),
      query: async () => [{ id: 1 }],
      get: async () => ({ url: 'https://example.com' }),
      update: async () => {},
      create: async () => {}
    },
    alarms: { create: () => {}, onAlarm: event('alarms.onAlarm') }
  };

  return {
    api,
    writes,
    current: () => data,
    fire: (name, ...args) => (listeners.get(name) || []).forEach(fn => fn(...args))
  };
}

const SESSION = { id: 's1', name: 'Session 1', site: 'example', lockTabId: null, paused: false, createdAt: 1, uatEnabled: false };

const STORED = {
  settings: { allowlist: ['edge.adobedc.net'], capturePaused: false, maxEntries: 2000, selectedSessionId: 's1', enableHooks: false, debugHooks: false, serviceMappings: [] },
  sessions: [SESSION],
  sites: ['example'],
  currentSessionId: 's1',
  requests: [{ id: 'old:1', requestId: 'old', sessionId: 's1', url: 'https://edge.adobedc.net/ee/v1', timeStamp: 1 }],
  uatConfigs: {}
};

const requestDetails = (requestId, timeStamp) => ({
  requestId,
  timeStamp,
  tabId: 1,
  frameId: 0,
  method: 'POST',
  url: 'https://edge.adobedc.net/ee/v1/interact',
  type: 'xmlhttprequest'
});

const wait = ms => new Promise(r => setTimeout(r, ms));

let moduleCounter = 0;
/** Load a fresh copy of core.js, since it holds module-level state. */
function loadCore() {
  moduleCounter += 1;
  return import(`../background/core.js?t=${moduleCounter}`);
}

test('a request arriving before state loads does not erase stored data', async () => {
  const fake = createFakeApi({ stored: STORED, storageDelay: 40 });
  const { start } = await loadCore();
  const ready = start({ api: fake.api, startIdleTimer: () => {} });

  // Fires while loadState() is still pending — the case that used to persist
  // an empty request list over the stored one.
  fake.fire('webRequest.onBeforeRequest', requestDetails('new', 2));

  await ready;
  await wait(700);

  const stored = fake.current();
  assert.equal(stored.sessions.length, 1, 'sessions must survive');
  assert.ok(stored.requests.length >= 2, 'the stored request must survive alongside the new one');
  assert.ok(stored.requests.some(r => r.requestId === 'old'), 'pre-existing request was erased');
  assert.ok(stored.requests.some(r => r.requestId === 'new'), 'deferred request was dropped');
});

test('capture bursts are coalesced into few storage writes', async () => {
  const fake = createFakeApi({ stored: STORED });
  const { start } = await loadCore();
  await start({ api: fake.api, startIdleTimer: () => {} });

  for (let i = 0; i < 100; i += 1) {
    fake.fire('webRequest.onBeforeRequest', requestDetails(`r${i}`, 100 + i));
  }
  await wait(700);

  assert.ok(fake.writes.length <= 2, `expected a debounced write, saw ${fake.writes.length}`);
  const last = fake.writes[fake.writes.length - 1];
  assert.equal(last.requests.filter(r => r.requestId.startsWith('r')).length, 100);
});

test('requests outside the allowlist are ignored', async () => {
  const fake = createFakeApi({ stored: STORED });
  const { start } = await loadCore();
  await start({ api: fake.api, startIdleTimer: () => {} });

  fake.fire('webRequest.onBeforeRequest', {
    ...requestDetails('x', 5),
    url: 'https://bank.example.com/login'
  });
  await wait(700);

  const captured = (fake.writes[fake.writes.length - 1]?.requests) || fake.current().requests;
  assert.ok(!captured.some(r => r.requestId === 'x'), 'non-allowlisted request was captured');
});
