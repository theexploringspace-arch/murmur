// QR encoder/decoder tests.
//  • RS fuzzing
//  • encode → render with camera-like distortions → decode (self-consistency)
//  • cross-validation against OpenCV in BOTH directions (skipped if python3+cv2 absent)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeQR } from '../../src/js/qr/encode.js';
import { decodeQR, decodeMatrix } from '../../src/js/qr/decode.js';
import { rsEncode, rsDecode } from '../../src/js/qr/rs.js';
import { B45, random, toB45 } from '../../src/js/core/bytes.js';

// ---------- synthetic "camera" ----------
function render(qr, { scale = 6, quiet = 4 } = {}) {
  const n = qr.size + quiet * 2, W = n * scale;
  const lum = new Uint8Array(W * W).fill(255);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x])
    for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) lum[((y + quiet) * scale + a) * W + (x + quiet) * scale + b] = 0;
  return { lum, w: W, h: W };
}

/** Warp src into a (outW×outH) frame with rotation, perspective skew, blur, noise, lighting gradient. */
function camera(src, { outW = 640, outH = 480, angle = 0, persp = 0, fill = 0.6, noise = 0, blur = 0, gradient = 0, invert = false, mirror = false, seed = 1 } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Uint8Array(outW * outH);
  const cx = outW / 2, cy = outH / 2;
  const k = (Math.min(outW, outH) * fill) / src.w;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    // inverse map: output pixel → source pixel
    let dx = (x - cx) / k, dy = (y - cy) / k;
    // true projective keystone (a homography — what a tilted camera actually produces)
    const pz = 1 + persp * (dx / src.w);
    dx /= pz; dy /= pz;
    let sx = cos * dx + sin * dy + src.w / 2, sy = -sin * dx + cos * dy + src.h / 2;
    if (mirror) sx = src.w - 1 - sx;
    let v = 255;
    const ix = Math.floor(sx), iy = Math.floor(sy);
    if (ix >= 0 && iy >= 0 && ix < src.w && iy < src.h) v = src.lum[iy * src.w + ix];
    if (invert) v = 255 - v;
    v = v * (1 - gradient * (x / outW)) + 40 * gradient;
    if (noise) v += (rnd() - 0.5) * 2 * noise;
    out[y * outW + x] = Math.max(0, Math.min(255, v));
  }
  if (blur) {
    const t = out.slice();
    for (let y = 1; y < outH - 1; y++) for (let x = 1; x < outW - 1; x++) {
      let sum = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) sum += t[(y + a) * outW + x + b];
      out[y * outW + x] = sum / 9;
    }
  }
  return { data: out, width: outW, height: outH, luminance: true };
}

const rndText = (n, al) => Array.from({ length: n }, () => al[Math.floor(Math.random() * al.length)]).join('');

describe('reed-solomon', () => {
  test('corrects up to ⌊ecc/2⌋ random byte errors, rejects beyond', () => {
    for (let t = 0; t < 1500; t++) {
      const k = 1 + Math.floor(Math.random() * 120), e = [7, 10, 16, 22, 26, 30][t % 6];
      const d = random(k), blk = new Uint8Array([...d, ...rsEncode(d, e)]), orig = blk.slice();
      const ne = Math.floor(Math.random() * (Math.floor(e / 2) + 1));
      const pos = new Set(); while (pos.size < ne) pos.add(Math.floor(Math.random() * blk.length));
      for (const p of pos) blk[p] ^= 1 + Math.floor(Math.random() * 255);
      assert.equal(rsDecode(blk, e), ne);
      assert.deepEqual(blk, orig);
    }
  });
});

describe('QR self-consistency', () => {
  test('matrix round-trip: every version 1–40, every ECC level, all modes', () => {
    for (let v = 1; v <= 40; v += 1) for (const ecl of 'LMQH') {
      // choose a text that lands in version v
      const t = v === 1 ? 'MUR1:' : rndText(Math.floor(v * v * 1.6), B45);
      let q; try { q = encodeQR(t, { ecl, minVersion: v }); } catch { continue; }
      assert.equal(decodeMatrix(q.modules).text, t, `v${q.version} ${q.ecl}`);
    }
    for (const t of ['0123456789012', 'hello, wörld ✓ 你好', '']) assert.equal(decodeMatrix(encodeQR(t).modules).text, t);
  });

  test('matrix survives burst damage within ECC budget', () => {
    const t = 'MUR1:' + toB45(random(300));
    const q = encodeQR(t, { ecl: 'M' });
    const m = q.modules.map((r) => r.slice());
    // scribble a 5×5 square in the data area (bottom-right quadrant, away from function patterns)
    for (let y = q.size - 14; y < q.size - 9; y++) for (let x = q.size - 14; x < q.size - 9; x++) m[y][x] ^= 1;
    const r = decodeMatrix(m);
    assert.equal(r.text, t);
    assert.ok(r.corrected > 0);
  });

  test('camera-like frames: rotation, keystone, blur, noise, lighting, inverted, mirrored', () => {
    // Real pairing payload size: ~260 bytes of binary → ~390 base45 chars
    const t = 'MUR1:' + toB45(random(260));
    const qr = encodeQR(t, { ecl: 'M' });
    const src = render(qr);
    const scenes = [
      {}, { angle: 0.3 }, { angle: Math.PI / 2 + 0.1 }, { angle: Math.PI }, { angle: -0.7 },
      { persp: 0.25 }, { persp: -0.2, angle: 0.15 }, { blur: 1 }, { noise: 40 }, { gradient: 0.6 },
      { invert: true }, { mirror: true }, { fill: 0.85 }, { fill: 0.45, outW: 1280, outH: 720 },
      { angle: 0.2, noise: 25, blur: 1, gradient: 0.3 },
    ];
    const fails = [];
    scenes.forEach((sc, i) => {
      const r = decodeQR(camera(src, { ...sc, seed: i + 1 }));
      if (!r || r.text !== t) fails.push(JSON.stringify(sc));
    });
    assert.deepEqual(fails, [], `failed scenes (v${qr.version}): ${fails.join(' ')}`);
  });

  test('frames with no code return null quickly', () => {
    const w = 320, h = 240, data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
    const t0 = Date.now();
    assert.equal(decodeQR({ data, width: w, height: h, luminance: true }), null);
    assert.ok(Date.now() - t0 < 1000);
  });
});

// ---------- independent cross-validation with OpenCV ----------
let haveCv = false;
try { execFileSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' }); haveCv = true; } catch {}

describe('QR cross-validation with OpenCV', { skip: !haveCv && 'python3 + opencv not installed' }, () => {
  const writePgm = (f, { lum, w, h }) => writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(lum)]));
  const readPgm = (f) => {
    const b = readFileSync(f); let o = 0; const tok = [];
    while (tok.length < 4) { while (b[o] === 0x20 || b[o] === 0x0a) o++; let s = ''; while (b[o] !== 0x20 && b[o] !== 0x0a) s += String.fromCharCode(b[o++]); tok.push(s); }
    o++; return { w: +tok[1], h: +tok[2], lum: b.subarray(o) };
  };

  test('OpenCV decodes codes made by our encoder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-qr-'));
    const texts = [];
    for (let i = 0; i < 24; i++) {
      const t = i % 3 === 0 ? 'MUR1:' + toB45(random(40 + i * 15)) : i % 3 === 1 ? rndText(20 + i * 10, 'abcxyz!?{}') : rndText(10 + i * 30, '0123456789');
      const q = encodeQR(t, { ecl: 'LMQH'[i % 4] });
      writePgm(join(dir, `${i}.pgm`), render(q, { scale: 5 }));
      texts.push(t);
    }
    const out = execFileSync('python3', ['-I', '-c', `
import cv2, sys, json, os
d=sys.argv[1]; det=cv2.QRCodeDetectorAruco() if hasattr(cv2,'QRCodeDetectorAruco') else cv2.QRCodeDetector()
res=[det.detectAndDecode(cv2.imread(os.path.join(d,f"{i}.pgm"),0))[0] for i in range(int(sys.argv[2]))]
print(json.dumps(res))`, dir, String(texts.length)]).toString();
    assert.deepEqual(JSON.parse(out), texts);
  });

  test('our decoder reads codes made by OpenCV\'s encoder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-qr-'));
    const texts = [];
    for (let i = 0; i < 16; i++) texts.push(i % 2 ? 'MUR1:' + toB45(random(30 + i * 20)) : rndText(15 + i * 12, 'Hello world 123'));
    writeFileSync(join(dir, 'texts.json'), JSON.stringify(texts));
    execFileSync('python3', ['-I', '-c', `
import cv2, sys, json, os, numpy as np
d=sys.argv[1]; texts=json.load(open(os.path.join(d,'texts.json')))
for i,t in enumerate(texts):
    p=cv2.QRCodeEncoder_Params(); p.correction_level=[cv2.QRCodeEncoder_CORRECT_LEVEL_L,cv2.QRCodeEncoder_CORRECT_LEVEL_M,cv2.QRCodeEncoder_CORRECT_LEVEL_Q,cv2.QRCodeEncoder_CORRECT_LEVEL_H][i%4]
    img=cv2.QRCodeEncoder_create(p).encode(t)
    img=cv2.resize(img,None,fx=6,fy=6,interpolation=cv2.INTER_NEAREST)
    img=cv2.copyMakeBorder(img,30,30,30,30,cv2.BORDER_CONSTANT,value=255)
    cv2.imwrite(os.path.join(d,f"{i}.pgm"),img)`, dir]);
    const got = texts.map((_, i) => { const p = readPgm(join(dir, `${i}.pgm`)); return decodeQR({ data: p.lum, width: p.w, height: p.h, luminance: true })?.text; });
    assert.deepEqual(got, texts);
  });
});
