// rs.js — GF(256) arithmetic and Reed–Solomon encode/decode as used by QR
// (primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11D, generator roots α^0..α^(n-1)).
//
// Polynomials of codewords use "QR order": array index 0 is the HIGHEST degree
// coefficient. Locator/evaluator polynomials use ascending order (index = power).

export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export const div = (a, b) => { if (!b) throw new Error('div by 0'); return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0; };
export const inv = (a) => div(1, a);
const pow = (a, n) => (a ? EXP[(LOG[a] * n) % 255] : 0);

const divisorCache = new Map();
/** Generator polynomial coefficients (degree n, leading 1 omitted), QR order. */
export function generator(n) {
  if (divisorCache.has(n)) return divisorCache.get(n);
  const r = new Uint8Array(n); r[n - 1] = 1;
  let root = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) { r[j] = mul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; }
    root = mul(root, 2);
  }
  divisorCache.set(n, r);
  return r;
}

/** Returns the n ECC bytes for data. */
export function rsEncode(data, n) {
  const g = generator(n);
  const r = new Uint8Array(n);
  for (const b of data) {
    const f = b ^ r[0];
    r.copyWithin(0, 1); r[n - 1] = 0;
    for (let i = 0; i < n; i++) r[i] ^= mul(g[i], f);
  }
  return r;
}

/** Evaluate QR-order polynomial at x (Horner). */
function evalQR(c, x) { let y = 0; for (const v of c) y = mul(y, x) ^ v; return y; }
/** Evaluate ascending-order polynomial at x. */
function evalAsc(p, x) { let y = 0; for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i]; return y; }

/**
 * Correct a received block in place (data ‖ ecc, length N, nEcc ECC bytes).
 * Returns the number of corrected bytes, or throws if uncorrectable.
 */
export function rsDecode(block, nEcc) {
  const N = block.length;
  const S = new Uint8Array(nEcc);
  let any = 0;
  for (let j = 0; j < nEcc; j++) { S[j] = evalQR(block, EXP[j]); any |= S[j]; }
  if (!any) return 0;

  // Berlekamp–Massey → Λ(x) ascending
  let L = 0, m = 1, b = 1;
  let C = new Uint8Array(nEcc + 1); C[0] = 1;
  let Bp = new Uint8Array(nEcc + 1); Bp[0] = 1;
  for (let n = 0; n < nEcc; n++) {
    let d = S[n];
    for (let i = 1; i <= L; i++) d ^= mul(C[i], S[n - i]);
    if (d === 0) { m++; continue; }
    const coef = div(d, b);
    const T = C.slice();
    for (let i = 0; i + m <= nEcc; i++) C[i + m] ^= mul(coef, Bp[i]);
    if (2 * L <= n) { L = n + 1 - L; Bp = T; b = d; m = 1; } else m++;
  }
  if (2 * L > nEcc) throw new Error('too many errors');
  const lambda = C.slice(0, L + 1);

  // Chien search: roots of Λ are X^-1 where X = α^p, p = power position (N-1-index)
  const positions = [];
  for (let p = 0; p < N; p++) {
    const Xinv = EXP[(255 - p) % 255];
    if (evalAsc(lambda, Xinv) === 0) positions.push(p);
  }
  if (positions.length !== L) throw new Error('uncorrectable (locator mismatch)');

  // Ω(x) = S(x)Λ(x) mod x^nEcc
  const omega = new Uint8Array(nEcc);
  for (let i = 0; i < nEcc; i++) {
    let v = 0;
    for (let j = 0; j <= Math.min(i, L); j++) v ^= mul(lambda[j], S[i - j]);
    omega[i] = v;
  }
  // Λ'(x): formal derivative (char 2 → only odd terms)
  const dl = new Uint8Array(Math.max(1, L));
  for (let i = 1; i <= L; i += 2) dl[i - 1] = lambda[i];

  for (const p of positions) {
    const X = EXP[p % 255], Xinv = EXP[(255 - p) % 255];
    const den = evalAsc(dl, Xinv);
    if (!den) throw new Error('uncorrectable (forney)');
    const e = mul(X, div(evalAsc(omega, Xinv), den)); // first consecutive root α^0
    block[N - 1 - p] ^= e;
  }
  // Verify
  for (let j = 0; j < nEcc; j++) if (evalQR(block, EXP[j])) throw new Error('uncorrectable (verify)');
  return L;
}

export { pow as _pow };
