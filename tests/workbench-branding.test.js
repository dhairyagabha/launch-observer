import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

/**
 * The header drew its own mark — an aperture glyph — while the product logo in
 * icons/ was a wireframe globe, so the app shipped two different logos. The
 * header mark is redrawn in currentColor rather than embedding the asset (the
 * logo carries its own navy tile, which would nest inside the header's themed
 * chip), so nothing enforces the match except this.
 */
const html = await readFile(new URL('../pages/app.html', import.meta.url), 'utf8');
const logo = await readFile(new URL('../icons/logo.svg', import.meta.url), 'utf8');
const favicon = await readFile(new URL('../icons/favicon.svg', import.meta.url), 'utf8');

/** Every `d` attribute in a chunk of SVG markup, whitespace-normalised. */
const paths = svg => [...svg.matchAll(/\sd="([^"]+)"/g)].map(m => m[1].replace(/\s+/g, ' ').trim());

test('the header mark is the product logo', () => {
  const { document } = new JSDOM(html).window;
  const header = document.querySelector('header');
  const mark = header.querySelector('svg');
  assert.ok(mark, 'the header opens with a mark');

  const logoPaths = paths(logo);
  assert.equal(logoPaths.length, 1, 'the logo is a single path');
  assert.deepEqual(
    paths(mark.outerHTML),
    logoPaths,
    'the header mark must be the same geometry as icons/logo.svg'
  );
  assert.equal(mark.getAttribute('viewBox'), '0 0 24 24', 'the logo path is authored in a 24x24 space');
});

test('the header mark follows the theme rather than carrying the logo tile', () => {
  const { document } = new JSDOM(html).window;
  const mark = document.querySelector('header svg');
  assert.equal(mark.getAttribute('stroke'), 'currentColor', 'inherits the theme foreground');
  assert.ok(!/fill="#|stroke="#/.test(mark.outerHTML), 'no hard-coded brand colours in the header');
  assert.ok(!mark.querySelector('rect'), 'the logo background tile is left to the header chip');
});

test('the icon set does not drift apart', () => {
  assert.deepEqual(paths(favicon), paths(logo), 'favicon.svg and logo.svg are the same mark');
});
