import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

/**
 * Drives the real pages/app.html and the real pages/app modules, covering the
 * wiring that unit tests over lib/ cannot reach.
 *
 * One boot per file: Node caches the shared module graph, so a second import
 * in the same process would bind to the first document.
 */
const app = await bootWorkbench({ storage: { tourCompleted: true } });
await import('../pages/app/main.js');
await settle();
const { document, window } = app;
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

test.after(() => app.cleanup());

test('renders every captured request, grouped by page', () => {
  assert.equal(document.querySelectorAll('#request-list button[data-request-id]').length, 3);
  assert.ok(document.querySelectorAll('#request-list button[data-group-key]').length >= 1);
  assert.match(document.getElementById('request-count').textContent, /3 requests/);
});

test('a failing request is flagged in the row and the group header', () => {
  assert.equal(document.querySelectorAll('#request-list svg[aria-label="Validation failed"]').length, 1);
  const pill = document.querySelector('#request-list .pill-fail');
  assert.ok(pill, 'group header shows a failing pill');
  assert.match(pill.textContent, /1 failing/);
  assert.equal(document.getElementById('failing-only-count').textContent, '1');
});

test('selecting a failing request opens a reachable results drawer', async () => {
  const failing = [...document.querySelectorAll('#request-list button[data-request-id]')]
    .find(r => r.querySelector('svg[aria-label="Validation failed"]'));
  assert.ok(failing, 'found the failing row');
  click(failing);
  await settle();

  const pill = document.getElementById('uat-pill');
  assert.ok(!pill.classList.contains('hidden'));
  assert.equal(pill.className, 'pill-solid-fail');

  const openBtn = document.getElementById('uat-open-drawer');
  assert.ok(!openBtn.classList.contains('hidden'), '"See results" is offered');

  const drawer = document.getElementById('uat-drawer');
  assert.ok(drawer.classList.contains('translate-x-full'), 'starts off-screen');
  click(openBtn);
  await settle();

  // Regression guard: the transform was baked into the .drawer component
  // class, so removing the utility could never reveal it.
  assert.ok(!drawer.classList.contains('translate-x-full'), 'drawer slides in');
  assert.ok(!document.getElementById('uat-drawer-overlay').classList.contains('hidden'));
  assert.match(drawer.textContent, /Page name is present/, 'names the failing rule');
  click(document.getElementById('uat-close-drawer'));
  await settle();
});

test('the detail pane fills in the meta bar and tabs', () => {
  assert.match(document.getElementById('detail-meta').textContent, /POST/);
  assert.match(document.getElementById('detail-meta').textContent, /edge\.adobedc\.net/);
  assert.ok(document.getElementById('detail-url'), 'the URL cell is rendered into the meta bar');
  assert.ok(document.querySelectorAll('#detail-query .panel').length >= 1, 'query params render');
});

test('the failing-only filter narrows and restores the list', async () => {
  click(document.getElementById('failing-only'));
  await settle();
  assert.equal(document.querySelectorAll('#request-list button[data-request-id]').length, 1);
  click(document.getElementById('failing-only'));
  await settle();
  assert.equal(document.querySelectorAll('#request-list button[data-request-id]').length, 3);
});

test('the filter box matches on domain', async () => {
  const search = document.getElementById('search');
  search.value = 'google-analytics';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  assert.equal(document.querySelectorAll('#request-list button[data-request-id]').length, 1);
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  assert.equal(document.querySelectorAll('#request-list button[data-request-id]').length, 3);
});

test('the service filter lists only services seen in the session', async () => {
  click(document.getElementById('service-filter-toggle'));
  await settle();
  const options = document.querySelectorAll('#service-filter-options button[data-service-key]');
  assert.equal(options.length, 2, 'Adobe Edge and Google Analytics');
  click(options[0]);
  await settle();
  assert.match(document.getElementById('service-filter-label').textContent, /1 service/);
  click(document.getElementById('service-filter-clear'));
  await settle();
  assert.equal(document.getElementById('service-filter-label').textContent, 'All services');
  click(document.getElementById('service-filter-backdrop'));
});

test('every help tab reveals exactly one populated panel', () => {
  const tabs = [...document.querySelectorAll('.help-tab')];
  assert.equal(tabs.length, 6);
  for (const tab of tabs) {
    click(tab);
    const visible = [...document.querySelectorAll('.help-panel')].filter(p => !p.classList.contains('hidden'));
    assert.equal(visible.length, 1, `one panel for ${tab.dataset.helpTab}`);
    assert.equal(visible[0].id, tab.dataset.helpTab);
    assert.ok(visible[0].textContent.trim().length > 200, 'panel has real content');
  }
});

test('the sessions sidebar groups by site', () => {
  assert.equal(document.querySelectorAll('#session-list button[data-session-id]').length, 2);
  assert.match(document.getElementById('session-count').textContent, /2 sessions/);
  const text = document.getElementById('session-list').textContent;
  assert.match(text, /Production/);
  assert.match(text, /Staging/);
});

test('header readouts reflect the active session', () => {
  assert.equal(document.getElementById('capture-state-label').textContent, 'Recording');
  assert.equal(document.getElementById('allowlist-count').textContent, '2');
  assert.match(document.getElementById('uat-bar-count').textContent, /^\d+\/\d+$/);
});

test('the allowlist dialog renders services and custom domains', async () => {
  click(document.getElementById('manage-allowlist'));
  await settle();
  assert.ok(document.querySelectorAll('#allowlist-services input[data-service-id]').length > 5);
  assert.ok(document.querySelectorAll('#allowlist-fields input[data-domain]').length >= 1);
  assert.match(document.getElementById('allowlist-service-summary').textContent, /of \d+ enabled/);

  // The services search is wired to the input that actually exists.
  const search = document.getElementById('allowlist-service-search');
  search.value = 'hotjar';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  const names = [...document.querySelectorAll('#allowlist-services label')].map(l => l.textContent).join(' ');
  assert.match(names, /Hotjar/);
  assert.ok(!/Mixpanel/.test(names), 'non-matching services are filtered out');
  click(document.getElementById('allowlist-cancel'));
});

test('no user-facing copy still says UAT', () => {
  const visible = document.body.textContent.replace(/\s+/g, ' ');
  const hit = visible.match(/.{0,60}\bUAT\b.{0,60}/);
  assert.equal(hit, null, `found: ${hit && hit[0]}`);
});
