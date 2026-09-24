import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

// Returning user: the flag the first run wrote.
const app = await bootWorkbench({ storage: { tourCompleted: true } });
await import('../pages/app/main.js');
await settle();

test.after(() => app.cleanup());

test('the tour stays closed once it has been seen', () => {
  assert.ok(app.document.getElementById('tour-overlay').classList.contains('hidden'));
});

test('it can still be started manually from Help', async () => {
  app.document.getElementById('start-tour')
    .dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(!app.document.getElementById('tour-overlay').classList.contains('hidden'));
});
