import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';

/**
 * styles/app.css is a committed build artifact, and nothing else notices when
 * it falls behind its inputs. A forgotten `npm run build:css` ships a
 * stylesheet with a class silently missing — the markup keeps the class, the
 * rule never exists, and the element renders at some inherited size or with
 * the utility simply inert. That failure is invisible to every other test
 * here, because they read styles/tailwind.css (the source) rather than the
 * built file.
 *
 * Rebuild to a scratch file and compare.
 */
const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');

test('styles/app.css is up to date with its inputs', async t => {
  const out = path.join(tmpdir(), `lo-app-css-${process.pid}.css`);
  t.after(() => rm(out, { force: true }));

  await exec(BIN, ['-i', path.join(ROOT, 'styles', 'tailwind.css'), '-o', out, '--minify'], { cwd: ROOT });

  const [committed, fresh] = await Promise.all([
    readFile(path.join(ROOT, 'styles', 'app.css'), 'utf8'),
    readFile(out, 'utf8')
  ]);

  assert.equal(
    committed,
    fresh,
    'styles/app.css does not match a fresh build — run `npm run build:css` and commit the result'
  );
});
