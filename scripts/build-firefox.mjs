import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const root = path.resolve(process.cwd());
const distDir = path.join(root, 'dist', 'firefox');
const zipPath = path.join(root, 'dist', 'firefox.zip');

const copies = [
  'background',
  'content',
  'icons',
  'lib',
  'pages',
  'styles',
  'manifest.firefox.json'
];

// Chrome-only entry points and the Tailwind source must not ship to AMO.
const excluded = new Set([
  path.join(root, 'background', 'service-worker.js'),
  path.join(root, 'styles', 'tailwind.css')
]);

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

for (const item of copies) {
  const src = path.join(root, item);
  const destName = item === 'manifest.firefox.json' ? 'manifest.json' : item;
  const dest = path.join(distDir, destName);
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.cp(src, dest, { recursive: true, filter: source => !excluded.has(source) });
  } else {
    await fs.copyFile(src, dest);
  }
}

await fs.rm(zipPath, { force: true });
try {
  await exec('zip', ['-r', zipPath, '.', '-x', '__MACOSX/*'], { cwd: distDir });
  console.log('Firefox build ready in dist/firefox');
  console.log('Firefox zip ready at dist/firefox.zip');
} catch (error) {
  console.log('Firefox build ready in dist/firefox');
  console.log('Zip creation failed. Ensure the zip utility is installed.');
}
