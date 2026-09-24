import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

/**
 * In the light palette --c-inset, --c-surface and --c-raised are deliberately
 * the same value, so a `bg-raised` fill sitting on a `bg-surface` panel is
 * literally invisible. The storage meter's track hit exactly that: the rail
 * vanished into the Manage data dialog and only the few pixels of blue fill
 * showed. Anything that draws a track has to pick a token that still separates
 * from the surface underneath it, in every theme.
 */
const css = await readFile(new URL('../styles/tailwind.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../pages/app.html', import.meta.url), 'utf8');

/**
 * Pull the `--c-*` tokens out of one palette block.
 * @param {string} selector
 * @returns {Record<string, string>}
 */
function palette(selector) {
  const start = css.indexOf(selector);
  assert.ok(start !== -1, `palette block ${selector} exists`);
  const block = css.slice(start, css.indexOf('}', start));
  const tokens = {};
  for (const [, name, value] of block.matchAll(/--c-([\w-]+):\s*([\d\s]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const THEMES = {
  dark: palette(":root[data-theme='dark']"),
  light: palette(":root[data-theme='light']")
};

test('the storage meter track stays distinct from the dialog behind it', () => {
  const track = html.match(/<span class="([^"]*rounded-pill[^"]*)">\s*<span id="data-usage-bar"/);
  assert.ok(track, 'found the storage meter track');

  const token = track[1].match(/\bbg-([\w-]+)\b/)?.[1];
  assert.ok(token, 'the track paints itself with a bg-* utility');

  // .modal is `bg-surface`, so that is what the track sits on.
  for (const [theme, tokens] of Object.entries(THEMES)) {
    assert.ok(tokens[token], `${theme}: --c-${token} is defined`);
    assert.notEqual(
      tokens[token],
      tokens.surface,
      `${theme}: the track (bg-${token}) must not be the same colour as the dialog surface`
    );
  }
});

/**
 * The same collision, one component over: the sidebar is `bg-inset`, and the
 * selected session row used to fill with `bg-surface` — identical to
 * `--c-inset` in the light palette — so the active session was painted exactly
 * the colour behind it and could not be picked out. Its hover fill had the
 * same defect.
 */
const sessionsJs = await readFile(new URL('../pages/app/sessions.js', import.meta.url), 'utf8');

test('the selected session row stays distinct from the sidebar behind it', () => {
  const sidebar = html.match(/<aside id="sidebar" class="([^"]*)"/);
  assert.ok(sidebar, 'found the sidebar');
  assert.equal(sidebar[1].match(/\bbg-([\w-]+)\b/)?.[1], 'inset', 'the sidebar is still bg-inset');

  const row = sessionsJs.match(/<div class="group grid[^"]*"/);
  assert.ok(row, 'found the session row');
  const branch = row[0].match(/\$\{isSelected \? '([^']*)' : '([^']*)'\}/);
  assert.ok(branch, 'the row picks its fill from isSelected');

  const fills = {
    selected: branch[1].match(/\bbg-([\w-]+)/)?.[1],
    hover: branch[2].match(/hover:bg-([\w-]+)/)?.[1]
  };
  assert.ok(fills.selected, 'the selected row paints a bg-* utility');
  assert.ok(fills.hover, 'an unselected row still has a hover fill');

  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const [label, token] of Object.entries(fills)) {
      assert.ok(tokens[token], `${theme}: --c-${token} is defined`);
      assert.notEqual(
        tokens[token],
        tokens.inset,
        `${theme}: the ${label} session row (bg-${token}) must not be the same colour as the sidebar`
      );
    }
  }
});
