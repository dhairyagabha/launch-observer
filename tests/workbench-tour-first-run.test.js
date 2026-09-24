import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

// Fresh profile: no tourCompleted flag.
const app = await bootWorkbench({ storage: {} });
await import('../pages/app/main.js');
await settle();

test.after(() => app.cleanup());

test('the tour auto-starts on a fresh profile', () => {
  assert.ok(!app.document.getElementById('tour-overlay').classList.contains('hidden'));
});

test('it records itself as seen immediately, not only on finish', () => {
  // The bug: persisting only on Skip/Finish meant closing the window
  // mid-tour left the flag unset, so it reappeared on every reload.
  assert.equal(app.storage.tourCompleted, true);
});
