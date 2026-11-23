// Call signaling validation and the receiver-side permission rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignal, callDecision, callButtons, formatDuration } from '../../src/js/core/call.js';

const ID = '0123456789abcdef0123456789abcdef';

test('call signals are strictly validated', () => {
  assert.deepEqual(readSignal({ t: 'call', id: ID, k: 'offer', sdp: 'v=0\r\n...', video: true }), { id: ID, k: 'offer', sdp: 'v=0\r\n...', video: true });
  assert.deepEqual(readSignal({ t: 'call', id: ID, k: 'end' }), { id: ID, k: 'end' });
  assert.equal(readSignal({ t: 'call', id: 'not-hex!', k: 'end' }), null);
  assert.equal(readSignal({ t: 'call', id: ID, k: 'teleport' }), null);
  assert.equal(readSignal({ t: 'call', id: ID, k: 'offer', sdp: '<script>' }), null, 'only real SDP');
  assert.equal(readSignal({ t: 'call', id: ID, k: 'answer', sdp: 'v=0' + 'x'.repeat(40_000) }), null, 'size-limited');
  assert.equal(readSignal({ t: 'call', id: ID, k: 'offer', sdp: 'v=0', video: 'yes' }).video, false);
});

test('the receiver decides whether a call rings — the caller\'s app can\'t override it', () => {
  const friend = { id: 'f' };
  assert.equal(callDecision({ settings: {}, contact: friend, video: true }), 'ring', 'calls on by default');
  assert.equal(callDecision({ settings: { calls: { video: false } }, contact: friend, video: true }), 'unavailable');
  assert.equal(callDecision({ settings: { calls: { video: false } }, contact: friend, video: false }), 'ring', 'voice still allowed');
  assert.equal(callDecision({ settings: { calls: { voice: false } }, contact: friend, video: false }), 'unavailable');
  assert.equal(callDecision({ settings: {}, contact: { ...friend, noCalls: true }, video: false }), 'unavailable', 'blocked person');
  assert.equal(callDecision({ settings: {}, contact: { ...friend, request: true }, video: false }), 'unavailable', 'strangers from an invite link can’t ring you');
  assert.equal(callDecision({ settings: {}, contact: undefined, video: false }), 'unavailable');
  assert.equal(callDecision({ settings: {}, contact: friend, video: false, busy: true }), 'busy');
});

test('call buttons follow what the contact said they accept', () => {
  assert.deepEqual(callButtons({ calls: { voice: true, video: false } }), { voice: true, video: false });
  assert.deepEqual(callButtons({}), { voice: true, video: true }, 'older app versions: assume yes (they still refuse on their side)');
  assert.deepEqual(callButtons({ request: true }), { voice: false, video: false });
});

test('durations', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(151_000), '2:31');
  assert.equal(formatDuration(3_725_000), '1:02:05');
});
