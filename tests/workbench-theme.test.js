import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWorkbench, settle } from './helpers/workbench-dom.js';

const app = await bootWorkbench({ storage: { tourCompleted: true } });
await import('../pages/app/main.js');
await settle();
const { document, window } = app;
const toggle = document.getElementById('theme-toggle');
const click = () => toggle.dispatchEvent(new window.Event('click', { bubbles: true }));

test.after(() => app.cleanup());

test('cycles system -> light -> dark -> system', () => {
  const root = document.documentElement;
  assert.equal(root.getAttribute('data-theme'), null, 'starts on system');

  click();
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(window.localStorage.getItem('lo-theme'), 'light');
  assert.ok(!document.getElementById('theme-icon-light').classList.contains('hidden'));
  assert.ok(document.getElementById('theme-icon-dark').classList.contains('hidden'));

  click();
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(window.localStorage.getItem('lo-theme'), 'dark');
  assert.ok(!document.getElementById('theme-icon-dark').classList.contains('hidden'));

  click();
  assert.equal(root.getAttribute('data-theme'), null, 'back to system');
  assert.equal(window.localStorage.getItem('lo-theme'), null, 'system clears the override');
  assert.ok(!document.getElementById('theme-icon-system').classList.contains('hidden'));
});

test('the toggle describes the current theme', () => {
  click();
  assert.match(toggle.getAttribute('aria-label'), /light/);
});
