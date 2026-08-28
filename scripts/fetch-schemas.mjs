// Fetch the pinned hostproto-semantics bundles and verify every digest.
// The schemas are never copied into this repository; `schemas/` is
// gitignored and rebuilt from the lock file. A digest mismatch is fatal.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const lock = JSON.parse(await fs.readFile(new URL('../hostproto-semantics.lock.json', import.meta.url), 'utf8'));
const out = new URL('../schemas/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const raw = lock.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/');
const local = process.env.HOSTPROTO_SEMANTICS_DIR; // offline: a checkout at the pinned commit
let failures = 0;
for (const [name, expected] of Object.entries(lock.sha256)) {
  let text;
  if (local) text = await fs.readFile(path.join(local, lock.path, `${name}.json`), 'utf8');
  else {
    const response = await fetch(`${raw}/${lock.commit}/${lock.path}/${name}.json`);
    if (!response.ok) { console.error(`${name}: HTTP ${response.status}`); failures++; continue; }
    text = await response.text();
  }
  const digest = createHash('sha256').update(text).digest('hex');
  if (digest !== expected) { console.error(`${name}: digest ${digest} != pinned ${expected}`); failures++; continue; }
  await fs.writeFile(new URL(`${name}.json`, out), text);
  console.log(`${name}: ok ${digest.slice(0, 12)}`);
}
if (failures) process.exit(1);
