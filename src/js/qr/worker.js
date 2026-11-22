// worker.js — runs the pure-JS QR decoder off the main thread so the camera
// preview never stutters. Receives {id, width, height, buffer}, replies {id, text|null}.
import { decodeQR } from './decode.js';

self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  let text = null;
  try { text = decodeQR({ data: new Uint8ClampedArray(buffer), width, height })?.text ?? null; } catch { text = null; }
  self.postMessage({ id, text });
};
