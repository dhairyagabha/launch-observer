import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const firefoxBackgroundUrl = new URL('../background/firefox-background.js', import.meta.url);

async function loadFirefoxPathResolver() {
  const source = await readFile(firefoxBackgroundUrl, 'utf8');
  const start = source.indexOf('function getValueAtPath');
  const end = source.indexOf('/**\n * Count request matches', start);

  assert.notEqual(start, -1, 'Firefox getValueAtPath implementation was not found');
  assert.notEqual(end, -1, 'Firefox path resolver boundary was not found');

  const context = {};
  const resolverSource = source.slice(start, end);
  vm.runInNewContext(`${resolverSource}\nthis.getValueAtPath = getValueAtPath;`, context);
  return context.getValueAtPath;
}

test('Firefox resolves bracket array indexes in payload paths', async () => {
  const getValueAtPath = await loadFirefoxPathResolver();
  const payload = {
    events: [
      {
        xdm: {
          web: {
            webInteraction: {
              name: 'Medallia Form Shown'
            }
          }
        }
      }
    ]
  };

  assert.equal(
    getValueAtPath(payload, 'events[0].xdm.web.webInteraction.name'),
    'Medallia Form Shown'
  );
});
