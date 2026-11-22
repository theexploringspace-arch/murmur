// identity.js — human-checkable identity fingerprints.
//
// A contact IS their 65-byte P-256 identity public key. Names are just labels.
// contactId:     first 16 bytes of H("murmur/fp", pub), hex  — internal key
// safetyNumber:  60 digits derived from BOTH keys, identical on both phones.
//                If two people read the same 60 digits, nobody is in the middle.

import { labeledHash } from './crypto.js';
import { toHex } from './bytes.js';

export async function contactId(pubRaw) {
  return toHex((await labeledHash('murmur/fp', pubRaw)).slice(0, 16));
}

async function digits30(pubRaw) {
  const h = await labeledHash('murmur/safety/v1', pubRaw);
  let s = '';
  for (let i = 0; i < 6; i++) {
    // 5 bytes -> 40-bit integer -> 5 decimal digits (bias < 2^-23, negligible)
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
    s += String(n % 100000).padStart(5, '0');
  }
  return s;
}

function cmp(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Order-independent: safetyNumber(a,b) === safetyNumber(b,a). */
export async function safetyNumber(pubA, pubB) {
  const [x, y] = cmp(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const s = (await digits30(x)) + (await digits30(y));
  return s.match(/.{5}/g).join(' ');
}
