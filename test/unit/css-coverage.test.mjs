// Every CSS class the app's JavaScript creates must be styled in app.css (or be listed below as a
// deliberate no-style hook). This exists because it went wrong once: the Settings hub, tab bar,
// Status screens and wallpapers shipped in code with no CSS at all, and would have rendered as
// unstyled stacked boxes on a phone. A missing style now fails `npm test`, not a user's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../src/', import.meta.url);
const css = readFileSync(new URL('css/app.css', root), 'utf8');
const js = ['js/app.js', ...readdirSync(new URL('js/ui/', root)).map((f) => `js/ui/${f}`)].map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n');

// Classes that intentionally have no rule of their own: wrappers that exist only so code or
// tests can find them, or whose look comes entirely from their children / a parent rule.
const HOOKS = new Set([
  'backup', 'duress', 'inputs', 'settings', 'scanarea', 'text', 'review-preview', // section wrappers
  'fwdlist', 'voicelist', // lists styled by .picklist / .doclist
  'vicon', // play/pause icon holder inside .vplay
]);

test('every class created in JS is styled in app.css', () => {
  const classes = new Set();
  for (const m of js.matchAll(/\bh\(\s*[`'"][a-z0-9]*((?:\.[a-zA-Z0-9_-]+)+)/g)) for (const c of m[1].split('.').filter(Boolean)) classes.add(c);
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([a-z0-9-]+)'/g)) classes.add(m[1]);
  assert.ok(classes.size > 100, `found ${classes.size} classes — the scanner works`);
  // `stbg-${id}` / `wall-${id}` are prefixes: at least one variant must be styled (color.test.mjs
  // checks every variant of those two individually).
  const styled = (c) => (c.endsWith('-') ? new RegExp(`\\.${c}[a-z0-9]`).test(css) : new RegExp(`\\.${c}(?![a-zA-Z0-9_-])`).test(css));
  const unstyled = [...classes].filter((c) => !HOOKS.has(c) && !styled(c));
  assert.deepEqual(unstyled, [], `classes used in JS but never styled: ${unstyled.join(', ')}`);
});

test('the no-style list stays honest (every hook is still used somewhere)', () => {
  for (const c of HOOKS) assert.match(js, new RegExp(`[.'"\`]${c}\\b`), `hook "${c}" is no longer used — remove it from the list`);
});
