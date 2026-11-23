#!/usr/bin/env node
// build.mjs — src/ → dist/ with integrity manifest + build fingerprint.
// No bundler, no minifier, no dependencies: what you read in src/ is exactly
// what runs, so anyone can audit the deployed files against this repository.
//
//   node tools/build.mjs            → dist/
//   node tools/build.mjs --out DIR  → DIR/

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1] : join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rel = (f) => './' + relative(src, f).split(sep).join('/');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// --relay URL (tests/local dev only): point the app at another relay. Rewrites the
// relay origin in config.js and in index.html's CSP before hashing, so the
// integrity manifest still matches exactly what is served.
const PROD_RELAY = 'https://relay.princeisgenius.com';
const relayArg = process.argv.indexOf('--relay');
const relay = relayArg > 0 ? process.argv[relayArg + 1].replace(/\/$/, '') : null;
const retarget = (r, buf) => {
  if (!relay || !['./index.html', './js/config.js', './_headers'].includes(r)) return buf;
  const ws = relay.replace(/^http/, 'ws');
  return Buffer.from(buf.toString('utf8').replaceAll(PROD_RELAY, relay).replaceAll(PROD_RELAY.replace(/^https/, 'wss'), ws));
};
const files = {};
for (const f of walk(src).sort()) {
  const r = rel(f);
  if (r === './sw.template.js' || /(^|\/)\./.test(r.slice(2))) continue; // skip dotfiles
  mkdirSync(dirname(join(out, r)), { recursive: true });
  const content = retarget(r, readFileSync(f));
  writeFileSync(join(out, r), content);
  files[r] = sha(content);
}

// Host config files (Netlify/Cloudflare `_headers`) are consumed by the host and
// may not be served publicly; precaching one would make the service worker's
// install fail and silently disable offline mode. Copy them, never precache them.
const HOST_CONFIG = new Set(['./_headers', './_redirects']);
const precacheList = Object.keys(files).filter((p) => !HOST_CONFIG.has(p)).sort();
const swTemplate = readFileSync(join(src, 'sw.template.js'), 'utf8');

// Fingerprint = SHA-256 over the sorted "hash  path" list (like sha256sum output),
// PLUS the service-worker template and its precache list — so any change to the
// offline engine changes the fingerprint too (sw.js itself embeds the fingerprint,
// so it can't be hashed directly without a cycle).
const listing = Object.keys(files).sort().map((p) => `${files[p]}  ${p}`).join('\n') + '\n'
  + `${sha(swTemplate)}  sw.template.js\n`
  + `${sha(precacheList.join('\n'))}  sw-precache-list\n`;
const fp = sha(listing);
const fingerprint = fp.slice(0, 32).match(/.{4}/g).join('-');
const info = { name: pkg.name, version: pkg.version, fingerprint, sha256: fp, files };
const infoJson = JSON.stringify(info, null, 2) + '\n';
writeFileSync(join(out, 'build-info.json'), infoJson);
writeFileSync(join(out, 'SHA256SUMS'), listing);

const precache = Object.fromEntries(precacheList.map((p) => [p, files[p]]));
precache['./build-info.json'] = sha(infoJson);
const sw = swTemplate
  .replace("'__VERSION__'", JSON.stringify(`${pkg.version}-${fp.slice(0, 12)}`))
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
writeFileSync(join(out, 'sw.js'), sw);

console.log(`Built ${Object.keys(files).length} files → ${relative(process.cwd(), out) || '.'}`);
console.log(`Build fingerprint: ${fingerprint}`);
