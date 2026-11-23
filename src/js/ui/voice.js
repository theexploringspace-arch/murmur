// voice.js — voice messages, WhatsApp-style.
//
//   voicePlayer()   the bubble: ▶ · waveform you can tap/drag to seek · 0:09 · 1×/1.5×/2×.
//                   No file name, no size, no Save button: a voice note is a message, not a file.
//   voiceRecorder() the mic button + the bar that takes over the composer while you record:
//
//     holding   ● 0:03 ▁▃▅▂▇▃  ‹ Slide away to cancel          [mic held]
//     locked    🗑  ● 0:05 ▁▃▅▂▇▃                    ⏸  ➤       (after a quick tap on the mic)
//     review    🗑  ▶ ▁▃▅▂▇▃▂▅ 0:07                       ➤       (listen first — no pop-up)
//
// Gestures (unchanged from the version that fixed iPhone recording — see ARCHITECTURE.md):
//   hold, talk, lift   → review bar (or sent at once in walkie-talkie mode)
//   quick tap          → locked: hands-free; ⏸ stops and lets you listen, ➤ sends, 🗑 deletes
//   hold, slide away   → cancelled
// Cancel is decided by DISTANCE with pointer capture, never by pointerleave: touchscreens fire
// pointerleave right after pointerup, which used to throw every iPhone clip away.

import { h, clear, icon, toast } from './dom.js';
import { peaks, level, clock, nextSpeed, seekFraction, BARS, MIN_BAR } from '../core/waveform.js';

// ---------------------------------------------------------------- decoding (waveform + true length)
// decodeAudioData gives the real duration even where <audio> can't (Chrome reports Infinity for
// MediaRecorder WebM). One decode at a time: opening a chat full of voice notes must not decode
// twenty clips at once on a phone.
const DECODED = new WeakMap();
let queue = Promise.resolve();
export function decodeClip(blob) {
  if (!DECODED.has(blob)) {
    const job = queue.then(async () => {
      try {
        const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
        if (!Ctx) throw new Error('no audio decoder');
        const ctx = new Ctx(1, 1, 44100);
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        return { bars: peaks(buf.getChannelData(0), BARS), duration: buf.duration };
      } catch { return { bars: new Array(BARS).fill(MIN_BAR * 2), duration: NaN }; } // still playable, just flat
    });
    queue = job.catch(() => {});
    DECODED.set(blob, job);
  }
  return DECODED.get(blob);
}

// Only one voice note plays at a time, across the whole app.
let nowPlaying = null;
/** Called when the screen changes: a detached <audio> would otherwise keep talking in the background. */
export function stopAllVoice() { nowPlaying?.pause(); nowPlaying = null; }

function bars(n = BARS) {
  return h('div.vwave', { 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('span', { style: { height: `${MIN_BAR * 200}%` } })));
}
function drawBars(wave, heights) {
  [...wave.children].forEach((b, i) => { b.style.height = `${Math.round(Math.max(MIN_BAR, heights[i] ?? MIN_BAR) * 100)}%`; });
}

/**
 * The voice-note player used in bubbles, the review bar and the Shared → Docs list.
 * @param {{blob: Blob, url: string, testid?: string, compact?: boolean}} o
 */
export function voicePlayer({ blob, url, testid = 'voice-clip', compact = false }) {
  const audio = h('audio', { src: url, preload: 'metadata', 'data-testid': 'voice-audio' });
  const playIcon = h('span.vicon', icon('play', 20));
  const play = h('button.vplay', { type: 'button', 'aria-label': 'Play voice message', 'data-testid': 'voice-play' }, playIcon);
  const wave = bars();
  const time = h('span.vtime', { 'data-testid': 'voice-time' }, '0:00');
  const speed = h('button.vspeed', { type: 'button', hidden: true, 'aria-label': 'Playback speed', 'data-testid': 'voice-speed' }, '1×');
  const el = h(`div.voice${compact ? '.compact' : ''}`, { 'data-testid': testid, 'data-state': 'paused' },
    play, h('div.vmid', wave, time), speed, audio);
  let duration = NaN, raf = 0, dragging = false;

  const total = () => (Number.isFinite(duration) && duration > 0 ? duration : Number.isFinite(audio.duration) ? audio.duration : NaN);
  const paint = () => {
    const d = total(); const frac = d > 0 ? Math.min(1, audio.currentTime / d) : 0;
    const lit = Math.round(frac * BARS);
    [...wave.children].forEach((b, i) => b.classList.toggle('on', i < lit));
    // WhatsApp: total length while idle, elapsed while playing or part-way through.
    // A clip's LENGTH rounds (0.98 s is "0:01", never "0:00"); elapsed time counts up like a stopwatch.
    time.textContent = audio.paused && audio.currentTime === 0 ? clock(d > 0 ? Math.max(1, Math.round(d)) : d) : clock(audio.currentTime);
  };
  const loop = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(loop); };
  const setIcon = (name, label) => { clear(playIcon).append(icon(name, 20)); play.setAttribute('aria-label', label); };

  decodeClip(blob).then((r) => {
    drawBars(wave, r.bars);
    if (Number.isFinite(r.duration)) { duration = r.duration; el.dataset.duration = r.duration.toFixed(2); }
    paint();
  });
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('play', () => {
    if (nowPlaying && nowPlaying !== audio) nowPlaying.pause();
    nowPlaying = audio; el.dataset.state = 'playing'; speed.hidden = false;
    setIcon('pause', 'Pause voice message'); cancelAnimationFrame(raf); loop();
  });
  audio.addEventListener('pause', () => {
    if (nowPlaying === audio) nowPlaying = null;
    el.dataset.state = 'paused'; setIcon('play', 'Play voice message'); cancelAnimationFrame(raf); paint();
    if (audio.playbackRate === 1) speed.hidden = audio.currentTime === 0;
  });
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  play.addEventListener('click', () => {
    if (audio.paused) audio.play().catch((e) => toast(`Can’t play this voice message: ${e.message}`, 'error'));
    else audio.pause();
  });
  speed.addEventListener('click', () => {
    audio.playbackRate = nextSpeed(audio.playbackRate);
    speed.textContent = `${audio.playbackRate}×`;
  });

  // Tap or drag on the waveform to jump. touch-action: pan-y (CSS) keeps vertical scrolling working.
  const seek = (e) => {
    const d = total(); if (!(d > 0)) return;
    const r = wave.getBoundingClientRect();
    audio.currentTime = seekFraction(e.clientX, r.left, r.width) * d; paint();
  };
  wave.addEventListener('pointerdown', (e) => { dragging = true; try { wave.setPointerCapture(e.pointerId); } catch { /* synthetic */ } seek(e); });
  wave.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
  wave.addEventListener('pointerup', () => { dragging = false; });
  wave.addEventListener('pointercancel', () => { dragging = false; });

  // Leaving the screen (element removed) must not keep audio playing in the background.
  el.stop = () => { audio.pause(); cancelAnimationFrame(raf); };
  return el;
}

// ---------------------------------------------------------------- recording
const LOCK_MS = 600, CANCEL_PX = 90, MAX_MS = 120_000;
const MIME = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/**
 * @param {{
 *   disabled?: boolean,
 *   reviewFirst: () => boolean,         // false = walkie-talkie: lift to send
 *   onSend: (file: File) => Promise<void>,
 *   onState?: (state: 'idle'|'holding'|'locked'|'review') => void,
 * }} o
 * @returns {{ button: HTMLButtonElement, bar: HTMLElement, discard: () => void, state: () => string }}
 */
export function voiceRecorder({ disabled, reviewFirst, onSend, onState = () => {} }) {
  const button = h('button.icon.mic', { type: 'button', disabled, 'aria-label': 'Hold to record a voice message, or tap to record hands-free', 'data-testid': 'voice', title: 'Hold to talk · tap for hands-free' }, icon('mic'));
  const timer = h('span.vtimer', { 'data-testid': 'voice-timer' }, '0:00');
  const live = bars();
  const hint = h('span.vhint', '‹ Slide away to cancel');
  const trash = h('button.icon.vtrash', { type: 'button', 'aria-label': 'Delete voice message', 'data-testid': 'voice-trash' }, icon('trash'));
  const stopBtn = h('button.icon.vstop', { type: 'button', 'aria-label': 'Stop and listen', 'data-testid': 'voice-stop' }, icon('pause'));
  const sendBtn = h('button.icon.vsend', { type: 'button', 'aria-label': 'Send voice message', 'data-testid': 'voice-send-now' }, icon('send'));
  const slot = h('div.vslot'); // the review player goes here
  const recRow = h('div.vrec', h('span.vdot'), timer, live);
  const bar = h('div.voicebar', { 'data-testid': 'voice-bar', hidden: true }, trash, recRow, slot, hint, stopBtn, sendBtn);

  let state = 'idle', rec = null, stream = null, ctx = null, held = false, intent = 'review', started = 0;
  let maxTimer = 0, tick = 0, busy = false, sx = 0, sy = 0, review = null; const levels = [];

  const setState = (s) => {
    state = s; bar.dataset.state = s; bar.hidden = s === 'idle';
    button.classList.toggle('rec', s === 'holding'); button.hidden = s === 'locked' || s === 'review';
    onState(s);
  };
  // Every way out (stop, cancel, error, exception) goes through here, so nothing can get stuck.
  const release = () => {
    clearTimeout(maxTimer); clearInterval(tick);
    stream?.getTracks().forEach((t) => t.stop()); ctx?.close?.().catch(() => {});
    rec = null; stream = null; ctx = null; busy = false;
  };
  const stop = (why) => { intent = why; clearTimeout(maxTimer); if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { release(); setState('idle'); } } };
  const cancel = () => { if (rec) toast('Voice message cancelled'); held = false; stop('cancel'); };
  const discard = () => {
    if (rec) { stop('cancel'); return; }
    review?.player.stop(); if (review) URL.revokeObjectURL(review.url); review = null; clear(slot); setState('idle');
  };

  // Live meter: an AnalyserNode on the mic stream. Purely cosmetic — if the browser refuses an
  // AudioContext, the bars just breathe gently; the RECORDING never depends on it.
  const startMeter = () => {
    levels.length = 0; drawBars(live, []);
    let an = null, buf = null;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      ctx = new AC(); ctx.resume?.().catch(() => {});
      an = ctx.createAnalyser(); an.fftSize = 1024; buf = new Uint8Array(an.fftSize);
      ctx.createMediaStreamSource(stream).connect(an); // NOT connected to the speaker: no echo
    } catch { an = null; }
    tick = setInterval(() => {
      const ms = Date.now() - started;
      timer.textContent = clock(ms / 1000);
      let v = 0.25 + 0.2 * Math.sin(ms / 180);
      if (an) { an.getByteTimeDomainData(buf); v = level(buf); }
      levels.push(v); if (levels.length > BARS) levels.shift();
      drawBars(live, [...new Array(BARS - levels.length).fill(MIN_BAR), ...levels]);
    }, 100);
  };

  const finished = async (file) => {
    if (intent === 'send' || (intent === 'lift' && !reviewFirst())) {
      setState('idle'); await onSend(file); return;
    }
    // Review IN the composer: listen, then 🗑 or ➤. No pop-up covering the chat.
    const url = URL.createObjectURL(file);
    const player = voicePlayer({ blob: file, url, testid: 'voice-review', compact: true });
    review = { file, url, player };
    clear(slot).append(player); setState('review');
  };

  button.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); if (button.disabled || busy || state !== 'idle') return;
    busy = true; held = true; intent = 'lift'; sx = e.clientX; sy = e.clientY;
    try { button.setPointerCapture?.(e.pointerId); } catch { /* synthetic or already released */ }
    try {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { toast('Microphone access is off for Murmur (allow it in Settings → Safari/browser)', 'error', 6000); release(); return; }
      const type = MIME.find((t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) || '';
      const chunks = [];
      // Deliberately NO bitrate option and NO timeslice: WebKit ignores bitrates, and Safari 26 emits
      // EMPTY chunks for short timeslices (WebKit bug 301507). One blob at stop() works everywhere.
      const r = rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      r.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
      r.onerror = (ev) => { toast(`Recording failed: ${ev.error?.message || 'unknown error'}`, 'error', 6000); intent = 'cancel'; };
      r.onstop = () => {
        const mime = (r.mimeType || type || 'audio/webm').split(';')[0];
        const dur = Date.now() - started; const bytes = chunks.reduce((n, c) => n + c.size, 0);
        release();
        if (intent === 'cancel') { setState('idle'); return; }
        if (dur <= 500) { setState('idle'); toast('Too short — hold the mic while you talk, or tap it once for hands-free'); return; }
        if (!bytes) { setState('idle'); toast('Your phone gave Murmur no sound. Close other apps using the microphone and try again.', 'error', 7000); return; }
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        finished(new File(chunks, `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { type: mime }))
          .catch((err) => toast(err.message, 'error'));
      };
      started = Date.now(); r.start(); startMeter();
      setState(held ? 'holding' : 'locked'); // finger already lifted (first-time permission prompt): hands-free
      maxTimer = setTimeout(() => { toast('Voice messages stop at 2 minutes'); stop(state === 'locked' ? 'review' : 'lift'); }, MAX_MS);
    } catch (err) {
      toast(`Couldn’t start recording: ${err.message}`, 'error', 6000); release(); setState('idle');
    }
  });
  button.addEventListener('pointermove', (e) => {
    if (held && rec && state === 'holding' && Math.hypot(e.clientX - sx, e.clientY - sy) > CANCEL_PX) cancel();
  });
  button.addEventListener('pointerup', (e) => {
    if (!held) return;
    held = false;
    if (!rec) return; // still starting: the start code goes hands-free
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > CANCEL_PX) { cancel(); return; }
    if (Date.now() - started < LOCK_MS) { setState('locked'); return; } // a tap, not a hold
    stop('lift');
  });
  // The system took the touch (call, notification, gesture): keep what was said and let them review it.
  button.addEventListener('pointercancel', () => { if (held && rec && state === 'holding') { held = false; stop('review'); } });
  button.addEventListener('contextmenu', (e) => e.preventDefault());

  trash.addEventListener('click', () => { const had = state === 'review'; discard(); if (had) toast('Voice message deleted'); });
  stopBtn.addEventListener('click', () => stop('review'));
  sendBtn.addEventListener('click', async () => {
    if (state === 'locked') { stop('send'); return; } // WhatsApp: ➤ while recording sends straight away
    if (state !== 'review' || !review) return;
    const { file, url, player } = review; review = null;
    player.stop(); clear(slot); setState('idle'); URL.revokeObjectURL(url);
    await onSend(file);
  });

  return { button, bar, discard, state: () => state };
}
