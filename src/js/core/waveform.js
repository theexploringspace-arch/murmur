// waveform.js — the maths behind voice-message waveforms. Pure functions, no DOM,
// no audio APIs, so they are unit-tested in Node (test/unit/waveform.test.mjs).
//
// Where the numbers come from:
//   • a RECEIVED or REVIEWED clip is decoded on this phone (decodeAudioData), and
//     `peaks()` squeezes its samples into a fixed number of bars;
//   • a clip being RECORDED is measured live (AnalyserNode), one `level()` per tick.
// Nothing about the waveform is sent over the network: the bars are recomputed from the
// encrypted audio itself, so a sender can't make a clip *look* different from what it is.

export const BARS = 40;         // thin 2px bars, 2px apart — fills a bubble like WhatsApp
export const MIN_BAR = 0.08;    // silence still draws a visible dot, like WhatsApp

/**
 * Squeeze mono samples (-1..1) into `n` bar heights (0..1).
 * Each bar is the RMS of its slice (RMS tracks loudness better than the raw max, which
 * a single click would dominate), then the whole set is scaled so the loudest bar is 1:
 * a quiet whisper still fills the bubble instead of looking like a flat line.
 */
export function peaks(samples, n = BARS) {
  const out = new Array(n).fill(MIN_BAR);
  const len = samples?.length | 0;
  if (!len || n < 1) return out;
  const raw = new Array(n);
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * len) / n), to = Math.max(from + 1, Math.floor(((b + 1) * len) / n));
    let sum = 0;
    for (let i = from; i < to && i < len; i++) { const v = samples[i]; sum += v * v; }
    raw[b] = Math.sqrt(sum / (to - from));
  }
  return normalize(raw);
}

/** Scale bars so the loudest is 1, with a floor; all-silent input stays at the floor. */
export function normalize(bars) {
  const max = Math.max(0, ...bars.filter(Number.isFinite));
  return bars.map((v) => (max > 0 && Number.isFinite(v) ? Math.max(MIN_BAR, Math.min(1, v / max)) : MIN_BAR));
}

/** Loudness (0..1) of one live microphone frame from AnalyserNode.getByteTimeDomainData (128 = silence). */
export function level(bytes) {
  const len = bytes?.length | 0;
  if (!len) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
  // Speech RMS rarely passes ~0.3; stretch it so normal talking reaches the top of the bar.
  return Math.min(1, Math.sqrt(sum / len) * 3.2);
}

/** 9.4 → "0:09", 75 → "1:15", 3725 → "1:02:05". Bad input (NaN, Infinity, negative) → "0:00". */
export function clock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** Playback speeds a voice bubble cycles through, WhatsApp-style. */
export const SPEEDS = [1, 1.5, 2];
export const nextSpeed = (cur) => SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length] || 1;

/** Where a tap at clientX lands on a bar strip spanning [left, left+width], as 0..1. */
export function seekFraction(clientX, left, width) {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width));
}
