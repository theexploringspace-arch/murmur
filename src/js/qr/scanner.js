// scanner.js — camera → QR text, entirely on-device.
//
// Strategy: the platform's BarcodeDetector where it exists (Chrome on Android
// and macOS — hardware-accelerated), otherwise Murmur's own decoder in a Web
// Worker (iOS Safari, Firefox, desktop Chrome on Windows/Linux). Both are
// tried in parallel-safe fashion: if the native detector exists but keeps
// missing, the worker still gets frames.

import { scriptUrl } from '../ui/trusted.js';

const MAX_W = 800;

async function nativeDetector() {
  try {
    if (!('BarcodeDetector' in globalThis)) return null;
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  } catch { return null; }
}

let workerSingleton = null;
function getWorker() {
  if (!workerSingleton) workerSingleton = new Worker(scriptUrl('./js/qr/worker.js'), { type: 'module' });
  return workerSingleton;
}

/** Decode a single image (ImageData) with the worker. */
export function decodeImageData(img) {
  const w = getWorker();
  const id = Math.random();
  return new Promise((resolve) => {
    const on = (e) => { if (e.data.id === id) { w.removeEventListener('message', on); resolve(e.data.text); } };
    w.addEventListener('message', on);
    const buf = img.data.buffer.slice(0);
    w.postMessage({ id, width: img.width, height: img.height, buffer: buf }, [buf]);
  });
}

/** Decode a QR from an image File (photo / screenshot fallback). */
export async function decodeImageFile(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const det = await nativeDetector();
  if (det) { try { const r = await det.detect(c); if (r[0]?.rawValue) return r[0].rawValue; } catch {} }
  return decodeImageData(ctx.getImageData(0, 0, c.width, c.height));
}

export class Scanner {
  /** @param {HTMLVideoElement} video */
  constructor(video) { this.video = video; this.stream = null; this.running = false; }

  async start(onText) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access. Use "Paste code" instead.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this.native = await nativeDetector();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let busy = false, frame = 0;
    const tick = async () => {
      if (!this.running) return;
      if (!busy && this.video.readyState >= 2 && this.video.videoWidth) {
        busy = true;
        try {
          const s = Math.min(1, MAX_W / this.video.videoWidth);
          canvas.width = Math.round(this.video.videoWidth * s);
          canvas.height = Math.round(this.video.videoHeight * s);
          ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
          let text = null;
          if (this.native) { try { text = (await this.native.detect(canvas))[0]?.rawValue || null; } catch { this.native = null; } }
          if (!text && (!this.native || frame++ % 3 === 0)) text = await decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (text && this.running) { const keep = onText(text); if (keep === false) this.stop(); }
        } finally { busy = false; }
      }
      if (this.running) setTimeout(tick, 90);
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
