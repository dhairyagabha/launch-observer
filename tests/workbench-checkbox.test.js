import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

/**
 * Tailwind compiles `peer-<state>:<utility>` to `.peer:<state> ~ .peer-…`,
 * a *general sibling* selector. It reaches siblings that follow the peer and
 * nothing else — not descendants of those siblings.
 *
 * Both custom checkboxes put the tick svg inside the `.checkbox` span and
 * marked it `peer-checked:block`. The span is a sibling of the input so the
 * box turned blue, but the svg is a grandchild of the input's parent, so the
 * variant never matched and `hidden` always won: a checkbox that highlighted
 * without ever showing a tick.
 */
const html = await readFile(new URL('../pages/app.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles/tailwind.css', import.meta.url), 'utf8');
const { document } = new JSDOM(html).window;

/** Elements that visually precede `el` under the same parent. */
const precedingSiblings = el => {
  const out = [];
  for (let n = el.previousElementSibling; n; n = n.previousElementSibling) out.push(n);
  return out;
};

test('every peer-* utility in the markup has a peer sibling that can reach it', () => {
  const dead = [];
  for (const el of document.querySelectorAll('[class*="peer-"]')) {
    const variants = [...el.classList].filter(c => /^peer-[a-z-]+:/.test(c));
    if (!variants.length) continue;
    const hasPeer = precedingSiblings(el).some(sib => sib.classList.contains('peer'));
    if (!hasPeer) {
      dead.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class')}">`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    'these elements carry peer-* variants but are not a following sibling of any .peer, so the variants are inert'
  );
});

test('a checked checkbox reveals its tick through a rule that reaches the svg', () => {
  const boxes = [...document.querySelectorAll('.checkbox')].filter(b => b.querySelector('svg'));
  assert.ok(boxes.length >= 2, 'found the custom checkboxes');

  for (const box of boxes) {
    const svg = box.querySelector('svg');
    assert.ok(
      svg.classList.contains('hidden'),
      'the tick starts hidden, so something must switch it on when checked'
    );
    // The peer input drives it from outside .checkbox, so the reveal has to be
    // a descendant rule in the stylesheet rather than a peer-* utility.
    assert.ok(
      precedingSiblings(box).some(sib => sib.classList.contains('peer')),
      'the box follows its peer input'
    );
  }

  assert.match(
    css,
    /\.peer:checked\s*~\s*\.checkbox\s+svg\s*\{/,
    'stylesheet reveals the tick via a descendant rule under the checked peer'
  );
});
