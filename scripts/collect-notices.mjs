import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reproducible build metadata: copy installed package notices without editing them.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const records = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev || entry.optional) continue;
  const directory = resolve(root, path);
  let pkg, files;
  try { pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')); files = await readdir(directory); }
  catch { continue; }
  const target = resolve(root, 'notices', `${pkg.name.replaceAll('/', '__')}@${pkg.version}`);
  await mkdir(target, { recursive: true });
  const names = ['package.json', ...files.filter(name => /^(license|licence|copying|notice|authors)(\.|$)/i.test(name))];
  // poseidon-lite publishes its license grant in README and package metadata.
  if (pkg.name === 'poseidon-lite') names.push('README.md');
  for (const name of names) await copyFile(resolve(directory, name), resolve(target, name));
  records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, source: entry.resolved, integrity: entry.integrity, retained: names });
}
await mkdir(resolve(root, 'notices'), { recursive: true });
await writeFile(resolve(root, 'notices', 'manifest.json'), JSON.stringify(records, null, 2) + '\n');
console.log(`Retained notices for ${records.length} installed runtime dependency packages.`);
