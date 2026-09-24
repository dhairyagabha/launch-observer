import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

/**
 * The idle prompt is the only safeguard against a session recording forever,
 * so it gets its own boot: the tests here drive it from the background
 * broadcast that raises it through to the message the page sends back.
 */
const app = await bootWorkbench({ storage: { tourCompleted: true } });
await import('../pages/app/main.js');
await settle();
const { document, window, sent, emit } = app;

const dialog = document.getElementById('session-idle-dialog');
const extend = document.getElementById('session-idle-extend');
const stop = document.getElementById('session-idle-stop');
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

test.after(() => app.cleanup());

test('a sessionIdle broadcast raises the prompt', () => {
  assert.equal(dialog.hasAttribute('open'), false);
  emit({ type: 'sessionIdle', sessionId: 's1' });
  assert.ok(dialog.hasAttribute('open'), 'the idle dialog is showing');
});

test('the recommended action is to keep recording, not to stop', () => {
  // btn-primary is the affirmative solid button in this design system, so it
  // belongs on the action that continues the session. Stopping is terminal and
  // reads as danger, the same way the confirm dialog treats clearing data.
  assert.ok(extend.classList.contains('btn-primary'), 'extend is the primary action');
  assert.ok(stop.classList.contains('btn-danger'), 'stop is styled as destructive');
  assert.equal(stop.classList.contains('btn-primary'), false);

  // The footer is right-aligned, so the recommended action is the last child.
  const foot = extend.parentElement;
  assert.equal(foot.lastElementChild, extend, 'extend sits in the primary slot');
});

test('the prompt uses the shared modal chrome', () => {
  assert.ok(dialog.classList.contains('modal'));
  assert.ok(dialog.querySelector('.modal-head .modal-title'));
  assert.ok(dialog.querySelector('.modal-head .field-hint'), 'head carries a subtitle');
  assert.ok(dialog.querySelector('.modal-body'));
  assert.ok(dialog.querySelector('.modal-foot'));
});

test('dismissing with Esc re-arms the idle check', () => {
  sent.length = 0;
  // `cancel` is what a real <dialog> fires for Esc; jsdom's stubbed close()
  // does not, which is exactly why the buttons must not go through this path.
  dialog.dispatchEvent(new window.Event('cancel'));
  assert.deepEqual(sent.map(m => m.type), ['idleExtend'],
    'an unanswered prompt still tells the background to keep watching');
});

test('choosing an action does not also send the dismissal message', async () => {
  emit({ type: 'sessionIdle', sessionId: 's1' });
  sent.length = 0;
  click(stop);
  await settle();
  assert.deepEqual(sent.map(m => m.type), ['idleStop']);

  emit({ type: 'sessionIdle', sessionId: 's1' });
  sent.length = 0;
  click(extend);
  await settle();
  assert.deepEqual(sent.map(m => m.type), ['idleExtend']);
});
