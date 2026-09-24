import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { injectStub, resolveServedPath, stubSource, createPreviewServer } from '../scripts/preview.mjs';
import { sampleState } from './helpers/sample-state.js';

/**
 * The preview harness is how the visual bugs jsdom cannot see get found, so
 * it has to keep booting. The failure mode worth guarding is silent: rename
 * the app's entry point and the stub stops being injected, leaving a page
 * that boots against absent extension APIs.
 */

test('the stub is injected ahead of the app entry point', async () => {
  const html = await readFile(new URL('../pages/app.html', import.meta.url), 'utf8');
  const out = injectStub(html);
  assert.ok(out.includes('<script src="./stub.js"></script>'), 'stub tag present');
  assert.ok(
    out.indexOf('./stub.js') < out.indexOf('app/main.js'),
    'the stub must run before the module, or the app boots with no chrome APIs'
  );
});

test('a renamed entry point fails loudly instead of serving a broken page', () => {
  assert.throws(
    () => injectStub('<html><script type="module" src="app/index.js"></script></html>'),
    /could not find .* in pages\/app\.html/,
    'points at the constant that needs updating'
  );
});

test('only the front-end directories are reachable', () => {
  for (const ok of ['/pages/app.html', '/styles/app.css', '/lib/uat.js', '/icons/favicon.svg']) {
    assert.ok(resolveServedPath(ok), `${ok} is served`);
  }
  // The background pages and anything above the repo are not the harness's job.
  for (const blocked of ['/background/core.js', '/manifest.json', '/../../etc/passwd', '/%2e%2e/package.json']) {
    assert.equal(resolveServedPath(blocked), null, `${blocked} is refused`);
  }
});

test('the stub serves the same fixture the jsdom tests use', () => {
  const state = sampleState();
  assert.equal(state.sessions.length, 2);
  assert.equal(state.requests.length, 3);
  assert.ok(
    state.requests.some(r => r.uat?.results?.some(x => x.status === 'failed')),
    'the fixture still contains the failing request the UI checks are built around'
  );
  const stub = stubSource();
  for (const api of ['window.chrome', 'sendMessage', 'getBytesInUse', 'onMessage', 'localStorage']) {
    assert.ok(stub.includes(api), `stub defines ${api}`);
  }
  assert.ok(/storage:\s*\{/.test(stub), 'stub defines chrome.storage');
  assert.ok(/tabs:\s*\{/.test(stub), 'stub defines chrome.tabs');
});

test('the server returns a bootable page, the stub and the fixture', async () => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/pages/app.html`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('./stub.js'), 'served page carries the stub');

    const stub = await fetch(`${base}/pages/stub.js`);
    assert.equal(stub.status, 200);
    assert.match(stub.headers.get('content-type'), /javascript/);

    const fixture = await fetch(`${base}/pages/fixture.json`);
    assert.equal(fixture.status, 200);
    assert.equal((await fixture.json()).requests.length, 3);

    assert.equal((await fetch(`${base}/background/core.js`)).status, 404, 'out-of-bounds path refused');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
