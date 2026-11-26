// The Midnight Blue + Electric Teal theme, chat colours, wallpapers and text-status backgrounds:
// a WCAG contrast audit read straight from app.css, so the stylesheet can't drift from the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rgb, isHex, luminance, contrast, inkOn, mix, BUBBLES, WALLS, DEFAULT_LOOK, cleanLook, bubbleHex, bubbleVars, effectiveLook, INK_LIGHT, INK_DARK } from '../../src/js/core/color.js';
import { STATUS_BGS } from '../../src/js/core/status.js';

const css = readFileSync(new URL('../../src/css/app.css', import.meta.url), 'utf8');
/** Custom properties declared in the first block matching `selector {`. */
function vars(selector) {
  const i = css.indexOf(`${selector} {`); assert.ok(i >= 0, `no ${selector} block`);
  const body = css.slice(i, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map((m) => [m[1], m[2].length === 4 ? `#${[...m[2].slice(1)].map((c) => c + c).join('')}` : m[2]]));
}
const AA = 4.5, UI = 3; // WCAG 2.x: body text, and icons / large text / control boundaries

test('colour maths: known WCAG values', () => {
  assert.deepEqual(rgb('#43E6C1'), [0x43, 0xe6, 0xc1]);
  assert.deepEqual(rgb('#fff'), [255, 255, 255]);
  assert.throws(() => rgb('teal'));
  assert.equal(isHex('#101c2c'), true); assert.equal(isHex('#fff'), false); assert.equal(isHex('red'), false);
  assert.equal(luminance('#000000'), 0); assert.equal(luminance('#ffffff'), 1);
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
  assert.equal(contrast('#101c2c', '#ffffff'), contrast('#ffffff', '#101c2c'), 'symmetric');
  assert.equal(inkOn('#101c2c'), INK_LIGHT); assert.equal(inkOn('#a8f0dc'), INK_DARK);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('default theme is exactly the requested Midnight Blue + Electric Teal palette', () => {
  const d = vars(':root');
  assert.deepEqual(
    { bg: d.bg, bg2: d.bg2, accent: d.accent, fg: d.fg, fg2: d.fg2, in: d.in, out: d.out, danger: d.danger, ok: d.ok },
    { bg: '#101c2c', bg2: '#17263a', accent: '#43e6c1', fg: '#ffffff', fg2: '#b8c6d8', in: '#26364b', out: '#164e49', danger: '#ff5c70', ok: '#43e6c1' });
});

test('default theme: every text/background pair meets WCAG AA', () => {
  const d = vars(':root');
  const pairs = [
    ['text on background', d.fg, d.bg, AA], ['secondary text on background', d.fg2, d.bg, AA],
    ['secondary text on panels', d.fg2, d.bg2, AA], ['secondary text on controls', d.fg2, d.bg3, AA],
    ['text on received bubble', d.fg, d.in, AA], ['time on received bubble', d.fg2, d.in, AA],
    ['text on sent bubble', d['out-ink'], d.out, AA], ['time on sent bubble', d['out-ink2'], d.out, AA],
    ['read ticks on sent bubble', d['out-read'], d.out, UI],
    ['teal on background (interactive)', d.accent, d.bg, UI], ['teal on panels', d.accent, d.bg2, UI],
    ['teal as text on background', d.accent, d.bg, AA],
    ['label on a teal button', d['accent-ink'], d.accent, AA],
    ['error text on background', d.danger, d.bg, AA],
    ['error text inside a received bubble', d['danger-ink'], d.in, AA], ['error text inside a sent bubble', d['danger-ink'], d.out, AA],
  ];
  for (const [what, fg, bg, min] of pairs) assert.ok(contrast(fg, bg) >= min, `${what}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)} < ${min}`);
});

test('light theme is preserved and still readable', () => {
  const l = vars(':root[data-theme="light"]');
  assert.equal(l.bg, '#f6f7f9'); assert.equal(l.accent, '#0d9488'); // unchanged from before the new default
  for (const [what, fg, bg, min] of [['text', l.fg, l.bg, AA], ['secondary text', l.fg2, l.bg, AA], ['secondary on panels', l.fg2, l.bg2, AA],
    ['time on sent bubble', l['out-ink2'], l.out, AA], ['teal on background', l.accent, l.bg, UI], ['read ticks', l['out-read'], l.out, UI]]) {
    assert.ok(contrast(fg, bg) >= min, `light ${what}: ${contrast(fg, bg).toFixed(2)}`);
  }
  // "Match my phone" uses the same light values.
  const sys = css.slice(css.indexOf(':root[data-theme="system"]'));
  assert.match(sys, /--bg: #f6f7f9/);
});

test('every chat colour keeps text, time and ticks readable (text colour picked automatically)', () => {
  assert.ok(BUBBLES.length >= 10);
  assert.equal(new Set(BUBBLES.map((b) => b.id)).size, BUBBLES.length, 'unique ids');
  for (const b of BUBBLES) {
    const v = bubbleVars(b.id);
    assert.equal(v['--out'], b.hex);
    assert.ok(contrast(v['--out-ink'], b.hex) >= AA, `${b.id}: text ${contrast(v['--out-ink'], b.hex).toFixed(2)}`);
    assert.ok(contrast(v['--out-ink2'], b.hex) >= AA, `${b.id}: time ${contrast(v['--out-ink2'], b.hex).toFixed(2)}`);
    assert.ok(contrast(v['--out-read'], b.hex) >= UI, `${b.id}: read ticks ${contrast(v['--out-read'], b.hex).toFixed(2)}`);
  }
  assert.equal(BUBBLES[0].hex, vars(':root').out, 'the first choice is the theme’s own sent-bubble colour');
});

test('looks: stored values are validated; a chat overrides the default field by field', () => {
  assert.deepEqual(cleanLook(undefined), { ...DEFAULT_LOOK });
  assert.deepEqual(cleanLook({ bubble: 'nope', wall: '<script>', dim: 'yes' }), { bubble: 'teal', wall: 'murmur', dim: true });
  assert.equal(cleanLook({ bubble: '#123456' }).bubble, '#123456', 'a custom hex is allowed');
  assert.equal(cleanLook({ wall: 'photo' }).wall, 'photo');
  assert.equal(bubbleHex('nope'), BUBBLES[0].hex);
  const all = { bubble: 'violet', wall: 'aurora', dim: true };
  assert.deepEqual(effectiveLook(all, null), all);
  assert.deepEqual(effectiveLook(all, { bubble: 'rose' }), { bubble: 'rose', wall: 'aurora', dim: true });
  assert.deepEqual(effectiveLook(all, { bubble: 'default', wall: 'photo', dim: 'default' }), { bubble: 'violet', wall: 'photo', dim: true });
});

test('every wallpaper and text-status background has its CSS, and white text reads on every status background', () => {
  for (const w of WALLS) assert.match(css, new RegExp(`\\.wall-${w.id}\\s*\\{`), `.wall-${w.id} missing in app.css`);
  assert.match(css, /\.wall-photo\s*\{[^}]*--wall-img/, 'photo wallpaper uses --wall-img');
  assert.match(css, /\.wall-dim\s*\{/);
  for (const id of STATUS_BGS) {
    const m = new RegExp(`\\.stbg-${id}\\s*\\{[^}]*linear-gradient\\([^,]+,\\s*(#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i').exec(css);
    assert.ok(m, `.stbg-${id} missing or not a two-stop gradient`);
    for (const stop of [m[1], m[2]]) assert.ok(contrast('#ffffff', stop) >= AA, `status background ${id}: white on ${stop} = ${contrast('#ffffff', stop).toFixed(2)}`);
  }
});

test('default wallpaper: Murmur doodles, a seamless tile shipped as two SVGs, reproducible from tools/doodle.mjs', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { layout, svg } = await import('../../tools/doodle.mjs');
  assert.equal(DEFAULT_LOOK.wall, 'murmur');
  for (const f of ['dark', 'light']) assert.ok(existsSync(new URL(`../../src/img/doodle-${f}.svg`, import.meta.url)), f);
  // Same seed → byte-identical file (a hand edit would be overwritten on the next run, so catch it here).
  const dark = svg(layout(), { ink: '#b8c6d8', logoInk: '#43e6c1', inkOpacity: 0.11, logoOpacity: 0.17 });
  assert.equal(readFileSync(new URL('../../src/img/doodle-dark.svg', import.meta.url), 'utf8'), dark);
  // Quiet enough to sit behind text, and only paths: no scripts, no external references.
  assert.doesNotMatch(dark, /<script|href=|url\(/i);
  assert.match(css, /\.wall-murmur\s*\{[^}]*doodle-dark\.svg/);
  assert.match(css, /data-theme="light"\] \.wall-murmur\s*\{[^}]*doodle-light\.svg/);
  // Seamless: every doodle near an edge is also drawn on the opposite side.
  const placed = layout(); const W = 420;
  const near = placed.filter((p) => p.x - p.rad < 0);
  assert.ok(near.length > 0);
  for (const p of near) assert.match(dark, new RegExp(`translate\\(${(p.x + W).toFixed(1)} `), 'wrapped copy');
});
