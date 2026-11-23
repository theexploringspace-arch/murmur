// Voice-message waveform maths: bar heights, live mic level, clock text, speeds, seeking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peaks, normalize, level, clock, nextSpeed, seekFraction, SPEEDS, BARS, MIN_BAR } from '../../src/js/core/waveform.js';

test('peaks: always exactly n bars, each within [MIN_BAR, 1]', () => {
  for (const len of [0, 1, 7, 35, 36, 37, 44100 * 3]) {
    const s = Float32Array.from({ length: len }, (_, i) => Math.sin(i / 10) * 0.5);
    const p = peaks(s);
    assert.equal(p.length, BARS, `len ${len}`);
    assert.ok(p.every((v) => v >= MIN_BAR && v <= 1), `len ${len}: ${p}`);
  }
});

test('peaks: loud part of a clip draws tall bars, silent part draws dots', () => {
  const s = new Float32Array(36_000);
  for (let i = 18_000; i < 36_000; i++) s[i] = Math.sin(i / 7) * 0.8; // silent first half, speech second half
  const p = peaks(s, 36);
  assert.ok(p.slice(0, 18).every((v) => v === MIN_BAR), 'silence = dots');
  assert.ok(p.slice(18).every((v) => v > 0.9), 'speech = tall bars');
});

test('peaks: a whisper is scaled up so it still fills the bubble', () => {
  const s = Float32Array.from({ length: 9000 }, (_, i) => Math.sin(i / 5) * 0.01);
  assert.ok(Math.max(...peaks(s)) === 1);
});

test('peaks: total silence and garbage input never throw or produce NaN', () => {
  assert.deepEqual(peaks(new Float32Array(1000)), new Array(BARS).fill(MIN_BAR));
  assert.deepEqual(peaks(null), new Array(BARS).fill(MIN_BAR));
  assert.ok(normalize([NaN, Infinity, 0.5]).every(Number.isFinite));
});

test('level: 128 is silence, a full-scale wave reaches the top', () => {
  assert.equal(level(new Uint8Array(512).fill(128)), 0);
  assert.equal(level(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0))), 1);
  const talk = Uint8Array.from({ length: 512 }, (_, i) => 128 + Math.round(Math.sin(i / 4) * 30));
  const v = level(talk); assert.ok(v > 0.3 && v < 1, `normal speech is visible but not clipped (${v})`);
  assert.equal(level(new Uint8Array(0)), 0);
});

test('clock: WhatsApp-style durations; Infinity (Chrome WebM) and NaN show 0:00', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(9.4), '0:09');
  assert.equal(clock(59.99), '0:59');
  assert.equal(clock(75), '1:15');
  assert.equal(clock(3725), '1:02:05');
  for (const bad of [NaN, Infinity, -3, undefined]) assert.equal(clock(bad), '0:00');
});

test('speed button cycles 1× → 1.5× → 2× → 1×, and recovers from odd rates', () => {
  assert.deepEqual(SPEEDS, [1, 1.5, 2]);
  assert.equal(nextSpeed(1), 1.5); assert.equal(nextSpeed(1.5), 2); assert.equal(nextSpeed(2), 1);
  assert.equal(nextSpeed(0.75), 1);
});

test('seekFraction: taps map onto 0..1 and are clamped at both ends', () => {
  assert.equal(seekFraction(150, 100, 200), 0.25);
  assert.equal(seekFraction(50, 100, 200), 0);
  assert.equal(seekFraction(400, 100, 200), 1);
  assert.equal(seekFraction(150, 100, 0), 0);
});
