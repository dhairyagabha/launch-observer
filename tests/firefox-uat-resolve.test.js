import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getValueAtPath } from '../lib/uat/resolve.js';

const firefoxBackground = new URL('../background/firefox-background.js', import.meta.url);
const serviceWorker = new URL('../background/service-worker.js', import.meta.url);

/**
 * The Firefox background used to inline its own copy of lib/, which meant every
 * parser fix had to be written twice and silently drifted when it was not.
 * These tests pin the arrangement that makes that impossible.
 */
test('Firefox background shares core.js instead of inlining lib', async () => {
  const source = await readFile(firefoxBackground, 'utf8');
  assert.match(source, /import \{[^}]*start[^}]*\} from '\.\/core\.js'/);
  assert.doesNotMatch(source, /function getValueAtPath/);
  assert.doesNotMatch(source, /function parseRawBody/);
  assert.doesNotMatch(source, /const SERVICE_CATALOG/);
});

test('both background entry points delegate to the same core', async () => {
  const [firefox, chrome] = await Promise.all([
    readFile(firefoxBackground, 'utf8'),
    readFile(serviceWorker, 'utf8')
  ]);
  assert.match(firefox, /from '\.\/core\.js'/);
  assert.match(chrome, /from '\.\/core\.js'/);
});

test('resolves bracket array indexes in payload paths', () => {
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
