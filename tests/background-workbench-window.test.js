import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The toolbar button opens the workbench in its own detached popup window
 * rather than a tab, and focuses an existing one instead of opening a second.
 *
 * `windows.create({ type: 'popup' })` only really exists inside a loaded
 * extension, so these cover the call *contract* — that the click reaches
 * windows.create with the right shape, that a second click focuses instead of
 * duplicating, and that the tab fallback is used only when windows is absent.
 * Whether Chrome honours type:'popup' is the browser's side of the bargain.
 */

const WORKBENCH_URL = 'chrome-extension://test/pages/app.html';

/**
 * Extension-API stand-in with a controllable window/tab population.
 * @param {{ openTabs?: Array<object>, withWindows?: boolean }} [options]
 */
function createFakeApi({ openTabs = [], withWindows = true } = {}) {
  const listeners = new Map();
  const event = name => ({
    addListener: fn => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    }
  });
  const calls = { windowsCreate: [], windowsUpdate: [], tabsCreate: [], tabsUpdate: [], queries: [] };
  let data = {};

  const api = {
    runtime: {
      onInstalled: event('runtime.onInstalled'),
      onStartup: event('runtime.onStartup'),
      onSuspend: event('runtime.onSuspend'),
      onMessage: event('runtime.onMessage'),
      sendMessage: (m, cb) => { if (cb) cb(); },
      lastError: null,
      getURL: p => `chrome-extension://test/${p}`
    },
    action: { onClicked: event('action.onClicked') },
    storage: {
      local: {
        get: async () => JSON.parse(JSON.stringify(data)),
        set: async value => { data = { ...data, ...JSON.parse(JSON.stringify(value)) }; }
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
      query: async query => { calls.queries.push(query); return openTabs.slice(); },
      get: async () => ({ url: 'https://example.com' }),
      update: async (id, info) => { calls.tabsUpdate.push({ id, info }); },
      create: async info => { calls.tabsCreate.push(info); }
    },
    alarms: { create: () => {}, onAlarm: event('alarms.onAlarm') }
  };

  if (withWindows) {
    api.windows = {
      create: async info => { calls.windowsCreate.push(info); },
      update: async (id, info) => { calls.windowsUpdate.push({ id, info }); }
    };
  }

  return { api, calls, fire: (name, ...a) => (listeners.get(name) || []).forEach(fn => fn(...a)) };
}

let counter = 0;
/** core.js holds module-level state, so each test gets its own copy. */
const loadCore = () => import(`../background/core.js?w=${counter += 1}`);

/** Click the toolbar button and let the async handler settle. */
async function clickToolbar(fake) {
  fake.fire('action.onClicked');
  await new Promise(r => setTimeout(r, 50));
}

test('the toolbar button opens the workbench in its own popup window, not a tab', async () => {
  const fake = createFakeApi({ openTabs: [] });
  const { start } = await loadCore();
  await start({ api: fake.api, startIdleTimer: () => {} });

  await clickToolbar(fake);

  assert.equal(fake.calls.windowsCreate.length, 1, 'opened exactly one window');
  const created = fake.calls.windowsCreate[0];
  assert.equal(created.type, 'popup', 'a detached popup, not a normal browser window');
  assert.equal(created.url, WORKBENCH_URL);
  assert.equal(created.width, 1280);
  assert.equal(created.height, 820);
  assert.equal(fake.calls.tabsCreate.length, 0, 'must not also open a tab');
});

test('clicking again focuses the open workbench instead of opening a second one', async () => {
  // A workbench window is already open on window 7.
  const fake = createFakeApi({ openTabs: [{ id: 42, windowId: 7, url: WORKBENCH_URL }] });
  const { start } = await loadCore();
  await start({ api: fake.api, startIdleTimer: () => {} });

  await clickToolbar(fake);

  assert.equal(fake.calls.windowsCreate.length, 0, 'no second window');
  assert.equal(fake.calls.tabsCreate.length, 0, 'no second tab');
  assert.deepEqual(fake.calls.windowsUpdate, [{ id: 7, info: { focused: true } }], 'focused the existing window');
  assert.deepEqual(fake.calls.tabsUpdate, [{ id: 42, info: { active: true } }], 'activated the workbench tab');
  assert.ok(
    fake.calls.queries.some(q => q.url === WORKBENCH_URL),
    'looked the workbench up by its own URL'
  );
});

test('falls back to a tab only where popup windows are unavailable', async () => {
  const fake = createFakeApi({ openTabs: [], withWindows: false });
  const { start } = await loadCore();
  await start({ api: fake.api, startIdleTimer: () => {} });

  await clickToolbar(fake);

  assert.equal(fake.calls.tabsCreate.length, 1, 'fell back to a tab');
  assert.equal(fake.calls.tabsCreate[0].url, WORKBENCH_URL);
});
