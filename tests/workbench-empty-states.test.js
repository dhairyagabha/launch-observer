import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

/**
 * The details pane has two placeholders — "Select a request…" and
 * "Observing for calls…" — and both centre their text with
 * `flex items-center justify-center`.
 *
 * #observing-state used to carry only the centring classes and relied on each
 * reveal site remembering to add `flex` too. Two of the four forgot, so the
 * placeholder rendered as a plain block and the text sat against the top of
 * the pane. jsdom has no layout engine, so these assert the class contract
 * that produces the centring rather than the painted position.
 */
const app = await bootWorkbench({ storage: { tourCompleted: true } });
await import('../pages/app/main.js');
await settle();
const { document, window } = app;
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

const observing = () => document.getElementById('observing-state');
const shown = el => !el.classList.contains('hidden');

/** A revealed placeholder must be a flex box, or the centring classes are inert. */
const assertCentres = (el, when) => {
  assert.ok(shown(el), `${when}: placeholder is visible`);
  assert.ok(el.classList.contains('flex'), `${when}: placeholder is display:flex so it centres`);
  assert.ok(el.classList.contains('items-center'), `${when}: vertically centred`);
  assert.ok(el.classList.contains('justify-center'), `${when}: horizontally centred`);
};

test.after(() => app.cleanup());

test('both details placeholders declare the same centring classes', async () => {
  const html = await readFile(new URL('../pages/app.html', import.meta.url), 'utf8');
  for (const id of ['empty-state', 'observing-state']) {
    const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(tag, `${id} exists in the markup`);
    for (const cls of ['flex', 'items-center', 'justify-center', 'h-full']) {
      assert.ok(
        new RegExp(`class="[^"]*\\b${cls}\\b`).test(tag[0]),
        `${id} carries ${cls} in the markup`
      );
    }
  }
});

test('the observing placeholder is centred when the session refresh reveals it', () => {
  // Boot with a selected session and nothing selected in the list: this is
  // the refresh() path in main.js that used to reveal it without `flex`.
  assertCentres(observing(), 'after initial refresh');
  assert.ok(!shown(document.getElementById('empty-state')), 'the other placeholder is hidden');
});

test('selecting a request hides it, and switching sessions brings it back centred', async () => {
  click(document.querySelector('#request-list button[data-request-id]'));
  await settle();
  assert.ok(!shown(observing()), 'selecting a request hides the placeholder');
  assert.ok(!document.getElementById('details').classList.contains('hidden'), 'details took over');

  const other = [...document.querySelectorAll('#session-list [data-session-id]')]
    .find(el => el.getAttribute('data-session-id') !== 's1');
  assert.ok(other, 'found a second session to switch to');
  click(other);
  await settle();
  assertCentres(observing(), 'after switching sessions');
});
