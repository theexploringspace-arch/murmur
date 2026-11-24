// The nearby link only passes message types on its allow-list (APP_TYPES); anything else is
// dropped. When Status was added, its three types were handled by the app but missing from the
// list — so over a nearby connection every status, delete and "seen" vanished silently. This test
// ties the two together: every `case 'x':` the app handles must be allowed, and vice versa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_TYPES } from '../../src/js/core/conversation.js';

const app = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8');

test('every app message type the app handles is allowed through the nearby link, and nothing more', () => {
  const start = app.indexOf('async function onAppMessage(');
  assert.ok(start > 0, 'onAppMessage exists');
  const body = app.slice(start, app.indexOf('\n}\n', start));
  const handled = new Set([...body.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  assert.ok(handled.size >= 10, `found ${handled.size} handled types`);
  assert.deepEqual([...handled].filter((t) => !APP_TYPES.has(t)).sort(), [], 'handled by the app but dropped by the nearby link');
  assert.deepEqual([...APP_TYPES].filter((t) => !handled.has(t)).sort(), [], 'allowed through but never handled');
});
