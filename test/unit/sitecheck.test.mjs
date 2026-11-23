// tools/site-check.mjs must pass on an honest host and FAIL on one that injects a script.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execFileSync(process.execPath, [join(root, 'tools/build.mjs')], { stdio: 'ignore' });
const servers = [];
const serve = async (port, ...flags) => {
  const p = spawn(process.execPath, [join(root, 'tools/serve.mjs'), '--port', String(port), ...flags], { stdio: 'pipe' });
  servers.push(p); await new Promise((r) => p.stdout.once('data', r));
};
after(() => servers.forEach((p) => p.kill()));
const check = (url) => { try { return { code: 0, out: execFileSync(process.execPath, [join(root, 'tools/site-check.mjs'), url]).toString() }; } catch (e) { return { code: e.status, out: e.stdout.toString() }; } };

test('honest host: ALL GOOD', async () => {
  await serve(8471);
  const r = check('http://localhost:8471');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /ALL GOOD/);
});
test('host that injects a script into the page: detected and named', async () => {
  await serve(8472, '--imitate-host-injection');
  const r = check('http://localhost:8472');
  assert.equal(r.code, 1); assert.match(r.out, /index\.html was CHANGED by the host — injected: <script async src="\/\.host\/badge\.js">/);
});
