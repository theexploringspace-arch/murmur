// decode.js — camera frame → QR text. Pure JS, no WASM, no dependencies.
//
// Pipeline (same shape as ZXing/jsQR, written from the ISO spec):
//   1. luminance + adaptive (Bradley integral-image) binarisation
//   2. finder-pattern search: 1:1:3:1:1 run ratios, cross-checked V/H/diagonal
//   3. choose the 3 finders forming the best right-isosceles triangle
//   4. estimate version; locate bottom-right alignment pattern (v ≥ 2)
//   5. homography from 4 point pairs → sample every module centre
//   6. format info (BCH, nearest of 32) → version info (v ≥ 7) → unmask
//   7. de-interleave, Reed–Solomon correct every block, parse segments
// Tries the inverted image and the mirrored (transposed) matrix on failure.

import {
  sizeOf, functionGrid, alignmentPositions, dataOrder, deinterleave, MASKS, ALL_FORMATS, versionBits, formatCoords, versionCoords,
  dataCodewords, ECL_BY_BITS,
} from './qr.js';
import { rsDecode } from './rs.js';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// ---------- 1. binarise ----------
export function toLuminance(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

export function binarize(lum, w, h) {
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += lum[y * w + x]; integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row; }
  }
  const s = Math.max(8, Math.floor(Math.min(w, h) / 8)) >> 1;
  const bits = new Uint8Array(w * h); // 1 = dark
  // Global floor: a near-uniform window shouldn't flip noise into "dark".
  let min = 255, max = 0; for (const v of lum) { if (v < min) min = v; if (v > max) max = v; }
  const contrastFloor = Math.max(12, (max - min) * 0.08);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - s), y1 = Math.min(h, y + s + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - s), x1 = Math.min(w, x + s + 1);
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = lum[y * w + x];
      bits[y * w + x] = v < mean * 0.85 && mean - v > contrastFloor * 0.5 ? 1 : 0;
    }
  }
  return bits;
}

// ---------- 2. finder patterns ----------
function ratioOk(c, total) {
  if (total < 7) return false;
  const mod = total / 7, v = mod * 0.5;
  return Math.abs(mod - c[0]) < v && Math.abs(mod - c[1]) < v && Math.abs(3 * mod - c[2]) < 3 * v
    && Math.abs(mod - c[3]) < v && Math.abs(mod - c[4]) < v;
}

/** Walk from (cx,cy) along (dx,dy) measuring the 5 runs; returns center offset & total, or null. */
function crossCheck(img, w, h, cx, cy, dx, dy, maxCount) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? img[y * w + x] : -1);
  const c = [0, 0, 0, 0, 0];
  let x = cx, y = cy;
  if (at(x, y) !== 1) return null;
  // backwards
  while (at(x, y) === 1) { c[2]++; x -= dx; y -= dy; }
  while (at(x, y) === 0 && c[1] <= maxCount) { c[1]++; x -= dx; y -= dy; }
  if (at(x, y) === -1 || c[1] > maxCount) return null;
  while (at(x, y) === 1 && c[0] <= maxCount) { c[0]++; x -= dx; y -= dy; }
  if (c[0] > maxCount) return null;
  // forwards
  x = cx + dx; y = cy + dy;
  while (at(x, y) === 1) { c[2]++; x += dx; y += dy; }
  while (at(x, y) === 0 && c[3] <= maxCount) { c[3]++; x += dx; y += dy; }
  if (at(x, y) === -1 || c[3] > maxCount) return null;
  while (at(x, y) === 1 && c[4] <= maxCount) { c[4]++; x += dx; y += dy; }
  if (c[4] > maxCount) return null;
  const total = c.reduce((a, b) => a + b, 0);
  if (!ratioOk(c, total)) return null;
  // Centre of the middle run along this axis (first pixel after it, minus half its length).
  return { offset: dx ? (x - dx * (c[4] + c[3]) - c[2] / 2) : (y - dy * (c[4] + c[3]) - c[2] / 2), total };
}

function findFinders(img, w, h) {
  const found = [];
  const step = Math.max(1, Math.floor(h / 240));
  for (let y = 0; y < h; y += step) {
    const c = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? img[y * w + x] : 0;
      if (v === 1) {
        if (state & 1) state++;
        c[state]++;
      } else if (!(state & 1)) {
        if (state === 4) {
          const total = c.reduce((a, b) => a + b, 0);
          if (ratioOk(c, total)) {
            const cx = Math.floor(x - c[4] - c[3] - c[2] / 2);
            const vert = crossCheck(img, w, h, cx, y, 0, 1, c[2] * 2);
            if (vert) {
              const cy = Math.floor(vert.offset);
              const hor = crossCheck(img, w, h, cx, cy, 1, 0, c[2] * 2);
              if (hor) {
                const fx = hor.offset;
                // Re-measure vertically through the refined x for a sub-pixel y (continuous coords).
                const vert2 = crossCheck(img, w, h, Math.floor(fx), cy, 0, 1, c[2] * 2) || vert;
                addCandidate(found, fx, vert2.offset, (vert2.total + hor.total) / 14);
              }
            }
            c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0; state = 3;
            continue;
          }
          c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0; state = 3;
        } else { state++; c[state]++; }
      } else c[state]++;
    }
  }
  return found.filter((f) => f.count >= 2 || found.length <= 3);
}

function addCandidate(list, x, y, size) {
  for (const f of list) {
    if (Math.abs(f.x - x) <= size * 2 && Math.abs(f.y - y) <= size * 2 && Math.abs(f.size - size) <= Math.max(1, f.size * 0.5)) {
      const n = f.count;
      f.x = (f.x * n + x) / (n + 1); f.y = (f.y * n + y) / (n + 1); f.size = (f.size * n + size) / (n + 1);
      f.count++;
      return;
    }
  }
  list.push({ x, y, size, count: 1 });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- 3. pick the triangle ----------
function orderedTriples(cands) {
  const c = cands.slice().sort((a, b) => b.count - a.count).slice(0, 10);
  const out = [];
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) {
    const t = [c[i], c[j], c[k]];
    const sizes = t.map((p) => p.size);
    const sz = Math.max(...sizes) / Math.min(...sizes);
    if (sz > 1.6) continue;
    const d = [[dist(t[1], t[2]), 0], [dist(t[0], t[2]), 1], [dist(t[0], t[1]), 2]].sort((a, b) => b[0] - a[0]);
    const tl = t[d[0][1]];
    let [p, q] = t.filter((x) => x !== tl);
    // hypotenuse/leg ≈ √2, legs ≈ equal
    const legs = [dist(tl, p), dist(tl, q)];
    const legRatio = Math.max(...legs) / Math.min(...legs);
    const hyp = d[0][0] / Math.sqrt(legs[0] * legs[1]);
    if (legRatio > 1.6 || Math.abs(hyp - Math.SQRT2) > 0.45) continue;
    if (Math.min(...legs) < 7 * Math.min(...sizes)) continue;
    // Cross product decides which is top-right vs bottom-left (y grows downward).
    const cross = (p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x);
    if (cross < 0) [p, q] = [q, p];
    const score = Math.abs(hyp - Math.SQRT2) + (legRatio - 1) + (sz - 1) - (t[0].count + t[1].count + t[2].count) * 0.01;
    out.push({ tl, tr: p, bl: q, score });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 4);
}

// ---------- 5. geometry ----------
/** Homography mapping src[i] → dst[i]; exact for 4 pairs, least-squares for more. */
function homography(srcIn, dstIn) {
  // Hartley normalisation: centre each point set and scale to mean distance √2.
  // Without this the normal equations are hopelessly ill-conditioned (pixel² ≈ 1e10).
  const norm = (pts) => {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const md = pts.reduce((a, p) => a + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1;
    const k = Math.SQRT2 / md;
    return { k, mx, my, pts: pts.map(([x, y]) => [(x - mx) * k, (y - my) * k]) };
  };
  const S = norm(srcIn), D = norm(dstIn);
  const src = S.pts, dst = D.pts;
  // Normal equations (AᵀA)h = Aᵀb for the 8 unknowns of a projective transform.
  const M = Array.from({ length: 8 }, () => new Float64Array(8)), r = new Float64Array(8);
  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
      for (let j = 0; j < 8; j++) { r[j] += row[j] * rhs; for (let k = 0; k < 8; k++) M[j][k] += row[j] * row[k]; }
    }
  }
  for (let i = 0; i < 8; i++) {
    let p = i; for (let q = i + 1; q < 8; q++) if (Math.abs(M[q][i]) > Math.abs(M[p][i])) p = q;
    [M[i], M[p]] = [M[p], M[i]]; [r[i], r[p]] = [r[p], r[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let q = 0; q < 8; q++) if (q !== i) {
      const f = M[q][i] / M[i][i];
      for (let c = i; c < 8; c++) M[q][c] -= f * M[i][c];
      r[q] -= f * r[i];
    }
  }
  const h = Array.from(r, (v, i) => v / M[i][i]);
  return (x0, y0) => {
    const x = (x0 - S.mx) * S.k, y = (y0 - S.my) * S.k;
    const d = h[6] * x + h[7] * y + 1;
    return [((h[0] * x + h[1] * y + h[2]) / d) / D.k + D.mx, ((h[3] * x + h[4] * y + h[5]) / d) / D.k + D.my];
  };
}

function findAlignment(img, w, h, ex, ey, mod, radius, max = 1) {
  // An alignment pattern is dark(1) light(1) dark(1) rings around a dark centre.
  // We check run-length RATIOS along both axes (scale-free, so perspective-
  // stretched patterns still match), then pick the candidate nearest the estimate.
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? img[y * w + x] : -1);
  const runs = (x, y, dx, dy) => {
    let c = 0, X = x, Y = y;
    while (at(X, Y) === 1) { c++; X += dx; Y += dy; }
    let l = 0; while (at(X, Y) === 0 && l < mod * 3) { l++; X += dx; Y += dy; }
    let d = 0; while (at(X, Y) === 1 && d < mod * 3) { d++; X += dx; Y += dy; }
    return { c, l, d };
  };
  const axis = (x, y, dx, dy) => {
    const f = runs(x, y, dx, dy), b = runs(x - dx, y - dy, -dx, -dy);
    const C = f.c + b.c;
    if (C < mod * 0.55 || C > mod * 1.7) return null;
    for (const v of [f.l, b.l]) if (v < C * 0.5 || v > C * 1.6) return null;
    for (const v of [f.d, b.d]) if (v < C * 0.5) return null;
    return { center: (f.c - b.c) / 2, C };
  };
  const found = [];
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(ex + dx), y = Math.round(ey + dy);
    if (at(x, y) !== 1) continue;
    const hx = axis(x, y, 1, 0); if (!hx) continue;
    const cx = Math.round(x + hx.center);
    const vy = axis(cx, y, 0, 1); if (!vy) continue;
    const cy = Math.round(y + vy.center);
    const hx2 = axis(cx, cy, 1, 0); if (!hx2) continue; // must also pass horizontally through the centre
    const px = cx + hx2.center + 0.5, py = cy + 0.5;
    if (found.some((f) => Math.abs(f.x - px) < mod && Math.abs(f.y - py) < mod)) continue;
    found.push({ x: px, y: py, d: (px - ex) ** 2 + (py - ey) ** 2 });
  }
  return found.sort((a, b) => a.d - b.d).slice(0, max);
}

/** Distance from a finder centre, walking toward `to`, until we leave its outer dark ring
 *  (dark → light → dark → light). That distance is 3.5 modules regardless of rotation. */
function runToEdge(img, w, h, from, to) {
  const L = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = (to.x - from.x) / L, uy = (to.y - from.y) / L;
  let state = 0; // 0 centre-dark, 1 light ring, 2 outer dark
  for (let t = 0; t < L / 2; t += 0.5) {
    const x = Math.floor(from.x + ux * t), y = Math.floor(from.y + uy * t);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const v = img[y * w + x];
    if (state === 0 && !v) state = 1;
    else if (state === 1 && v) state = 2;
    else if (state === 2 && !v) return t;
  }
  return null;
}

function moduleSize(img, w, h, tri) {
  const { tl, tr, bl } = tri;
  const runs = [[tl, tr], [tr, tl], [tl, bl], [bl, tl]].map(([a, b]) => runToEdge(img, w, h, a, b)).filter((x) => x);
  if (!runs.length) return (tl.size + tr.size + bl.size) / 3;
  return runs.reduce((a, b) => a + b, 0) / runs.length / 3.5;
}

function sampleGrid(img, w, h, tri, dim, useAlign = true) {
  const { tl, tr, bl } = tri;
  const mod = tri.mod;
  const ver = (dim - 17) / 4;
  const src3 = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5]];
  const dst3 = [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y]];
  // Hypotheses for the 4th anchor: up to 3 alignment-pattern candidates, then the parallelogram corner.
  const hyps = [];
  if (ver >= 2 && useAlign) {
    const corr = 1 - 3 / (dim - 7);
    const ex = tl.x + corr * (tr.x - tl.x + bl.x - tl.x);
    const ey = tl.y + corr * (tr.y - tl.y + bl.y - tl.y);
    // perspective: the bottom-right module size extrapolates from the finders
    const brMod = Math.max(mod * 0.6, Math.min(mod * 1.6, tr.size + bl.size - tl.size));
    for (const f of findAlignment(img, w, h, ex, ey, brMod, mod * 12, 3)) hyps.push([[dim - 6.5, dim - 6.5], [f.x, f.y]]);
  }
  hyps.push([[dim - 3.5, dim - 3.5], [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y]]);
  const grids = [];
  for (const [s4, d4] of hyps) grids.push(...sampleWith(img, w, h, mod, ver, dim, useAlign, [...src3, s4], [...dst3, d4]));
  return grids;
}

function sampleWith(img, w, h, mod, ver, dim, useAlign, src, dst) {
  const H0 = homography(src, dst);
  if (!H0) return [];
  const Hs = [H0];
  // Refinement: predict every alignment pattern through H, find each one
  // locally, reject outliers (> 1.2 modules from prediction), and re-fit H by
  // least squares over all inliers. Reed–Solomon later tells us which grid is right.
  if (ver >= 2 && useAlign) {
    const ap = alignmentPositions(ver), last = ap.length - 1;
    let H = H0;
    for (let iter = 0; iter < 2; iter++) {
      const s2 = src.slice(0, 3), d2 = dst.slice(0, 3);
      for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        const [px, py] = H(ap[i] + 0.5, ap[j] + 0.5);
        const f = findAlignment(img, w, h, px, py, mod, mod * 2)[0];
        if (f && Math.hypot(f.x - px, f.y - py) <= mod * 1.2) { s2.push([ap[i] + 0.5, ap[j] + 0.5]); d2.push([f.x, f.y]); }
      }
      if (s2.length < 5) break;
      const H2 = homography(s2, d2);
      if (!H2) break;
      H = H2; Hs.push(H2);
    }
  }
  const grids = [];
  for (const H of Hs.reverse()) {
    const grid = Array.from({ length: dim }, () => new Uint8Array(dim));
    let ok = true;
    for (let y = 0; y < dim && ok; y++) for (let x = 0; x < dim; x++) {
      const [px, py] = H(x + 0.5, y + 0.5);
      const ix = Math.floor(px), iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) { ok = false; break; }
      grid[y][x] = img[iy * w + ix];
    }
    if (ok) grids.push(grid);
  }
  return grids;
}

// ---------- 6/7. read matrix ----------
const popcount = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

function readFormat(g, n) {
  const [a, b] = formatCoords(n);
  let best = null;
  for (const coords of [a, b]) {
    let bits = 0;
    coords.forEach(([x, y], i) => { if (g[y][x]) bits |= 1 << i; });
    for (const f of ALL_FORMATS) {
      const d = popcount(f.bits ^ bits);
      if (!best || d < best.d) best = { ...f, d };
    }
  }
  return best && best.d <= 3 ? best : null;
}

function readVersion(g, n) {
  const coords = versionCoords(n);
  let best = null;
  for (const which of [0, 1]) {
    let bits = 0;
    coords.forEach((pair, i) => { const [x, y] = pair[which]; if (g[y][x]) bits |= 1 << i; });
    for (let v = 7; v <= 40; v++) {
      const d = popcount(versionBits(v) ^ bits);
      if (!best || d < best.d) best = { v, d };
    }
  }
  return best && best.d <= 3 ? best.v : null;
}

export function decodeMatrix(g) {
  const n = g.length;
  if ((n - 17) % 4 || n < 21 || n > 177) throw new Error('bad dimension');
  let ver = (n - 17) / 4;
  if (ver >= 7) { const v = readVersion(g, n); if (!v) throw new Error('version info unreadable'); if (v !== ver) throw new Error(`version mismatch:${v}`); }
  const fmt = readFormat(g, n);
  if (!fmt) throw new Error('format info unreadable');
  const { fn } = functionGrid(ver);
  const total = Math.floor(Array.from(dataOrder(fn, n)).length / 8);
  const cw = new Uint8Array(total);
  let i = 0;
  for (const [x, y] of dataOrder(fn, n)) {
    if (i >= total * 8) break;
    const bit = g[y][x] ^ (MASKS[fmt.mask](x, y) ? 1 : 0);
    if (bit) cw[i >>> 3] |= 1 << (7 - (i & 7));
    i++;
  }
  const { blocks, ecc, dlen } = deinterleave(cw, ver, fmt.ecl);
  const data = [];
  let corrected = 0;
  blocks.forEach((blk, j) => { corrected += rsDecode(blk, ecc); for (let k = 0; k < dlen(j); k++) data.push(blk[k]); });
  if (data.length !== dataCodewords(ver, fmt.ecl)) throw new Error('codeword count mismatch');
  return { text: parseSegments(data, ver), version: ver, ecl: fmt.ecl, corrected };
}

function parseSegments(data, ver) {
  let pos = 0;
  const total = data.length * 8;
  const read = (n) => {
    if (pos + n > total) throw new Error('truncated segment');
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >>> 3] >>> (7 - (pos & 7))) & 1);
    return v;
  };
  const vi = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
  let out = '';
  const bytes = [];
  const flush = () => { if (bytes.length) { out += new TextDecoder().decode(Uint8Array.from(bytes)); bytes.length = 0; } };
  while (pos + 4 <= total) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode === 1) {
      flush();
      let cnt = read([10, 12, 14][vi]);
      while (cnt >= 3) { out += String(read(10)).padStart(3, '0'); cnt -= 3; }
      if (cnt === 2) out += String(read(7)).padStart(2, '0'); else if (cnt === 1) out += String(read(4));
    } else if (mode === 2) {
      flush();
      let cnt = read([9, 11, 13][vi]);
      while (cnt >= 2) { const v = read(11); out += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; cnt -= 2; }
      if (cnt) out += ALNUM[read(6)];
    } else if (mode === 4) {
      const cnt = read([8, 16, 16][vi]);
      for (let i = 0; i < cnt; i++) bytes.push(read(8));
    } else if (mode === 7) { read(8); // ECI designator (single byte form); assume UTF-8
    } else throw new Error(`unsupported mode ${mode}`);
  }
  flush();
  return out;
}

const transpose = (g) => g.map((r, y) => r.map((_, x) => g[x][y]));

function tryDecode(img, w, h) {
  const cands = findFinders(img, w, h);
  if (cands.length < 3) return null;
  for (const tri of orderedTriples(cands)) {
    const mod = tri.mod = moduleSize(img, w, h, tri);
    let dim = Math.round((dist(tri.tl, tri.tr) + dist(tri.tl, tri.bl)) / 2 / mod) + 7;
    switch (dim & 3) { case 0: dim++; break; case 2: dim--; break; case 3: dim -= 2; break; }
    const dims = [dim, dim + 4, dim - 4].filter((d) => d >= 21 && d <= 177);
    for (let attempt = 0; attempt < dims.length; attempt++) {
      let d = dims[attempt];
      for (const useAlign of [true, false]) {
        for (let pass = 0; pass < 2; pass++) {
          const grids = sampleGrid(img, w, h, tri, d, useAlign);
          if (!grids.length) break;
          for (const g of grids.flatMap((g0) => [g0, transpose(g0)])) {
            try { return decodeMatrix(g); }
            catch (e) {
              const m = /version mismatch:(\d+)/.exec(e.message);
              if (m && pass === 0) { d = sizeOf(Number(m[1])); }
            }
          }
          if (d === dims[attempt]) break; // no version correction to retry with
        }
      }
    }
  }
  return null;
}

/**
 * Decode a QR code from RGBA pixels (ImageData) or a luminance buffer.
 * @returns {{text:string, version:number, ecl:string, corrected:number} | null}
 */
export function decodeQR({ data, width, height, luminance = false }) {
  const lum = luminance ? data : toLuminance(data, width, height);
  const bin = binarize(lum, width, height);
  const r = tryDecode(bin, width, height);
  if (r) return r;
  for (let i = 0; i < bin.length; i++) bin[i] ^= 1; // light-on-dark (inverted) codes
  return tryDecode(bin, width, height);
}

export { ECL_BY_BITS };
