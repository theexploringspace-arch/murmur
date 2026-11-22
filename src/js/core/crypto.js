// crypto.js — thin wrappers over the browser's WebCrypto (SubtleCrypto).
//
// Design rule: Murmur does NOT implement any cryptographic primitive itself.
// Every primitive below (P-256 ECDH/ECDSA, HKDF/HMAC-SHA-256, AES-256-GCM,
// PBKDF2) is executed by the browser's native, audited crypto library
// (BoringSSL in Chrome, CoreCrypto in Safari, NSS in Firefox).
// What Murmur *does* define is the protocol that composes them — see docs/PROTOCOL.md.

import { concat, utf8 } from './bytes.js';

const subtle = globalThis.crypto.subtle;
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', data));

// ---------- identity (signing) keys ----------
/** Generates an identity key pair. The private key is extractable ONLY so the
 *  vault can wrap it once; callers must drop the reference immediately. */
export const generateIdentityKeyPair = () => subtle.generateKey(CURVE, true, ['sign', 'verify']);

export const exportPublic = async (key) => new Uint8Array(await subtle.exportKey('raw', key));

export async function importIdentityPublic(raw) {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('bad identity key');
  return subtle.importKey('raw', raw, CURVE, true, ['verify']);
}

/** ECDSA P-256 / SHA-256. Signature is IEEE-P1363 (r||s, 64 bytes). */
export const sign = async (privateKey, data) =>
  new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data));

export async function verify(publicKey, sig, data) {
  if (sig.length !== 64) return false;
  try {
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, data);
  } catch { return false; }
}

// ---------- ephemeral ECDH ----------
export const generateEphemeral = () => subtle.generateKey(ECDH, false, ['deriveBits']);

export async function importEphemeralPublic(raw) {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('bad ephemeral key');
  // importKey validates the point is on the curve (invalid-curve attacks are rejected).
  return subtle.importKey('raw', raw, ECDH, true, []);
}

export async function ecdh(privateKey, publicKey) {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

// ---------- HKDF / HMAC ----------
export async function hkdf(ikm, salt, info, length) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? utf8(info) : info },
    k, length * 8);
  return new Uint8Array(bits);
}

export async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

// ---------- AES-256-GCM ----------
export const importAesKey = (raw, usages = ['encrypt', 'decrypt']) =>
  subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);

export async function aesGcmEncrypt(key, iv, plaintext, aad) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
}
/** Throws on authentication failure. */
export async function aesGcmDecrypt(key, iv, ciphertext, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext));
}

// ---------- passphrase KDF ----------
// PBKDF2 is the only memory-hardness-free password KDF in WebCrypto. We use
// OWASP's 2023+ recommendation of 600,000 iterations for PBKDF2-HMAC-SHA256.
export const PBKDF2_ITERATIONS = 600_000;

export async function passphraseKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export const generateDataKey = () =>
  subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);

export async function wrapKey(format, key, wrappingKey, iv, aad) {
  return new Uint8Array(await subtle.wrapKey(format, key, wrappingKey, { name: 'AES-GCM', iv, additionalData: aad }));
}
export async function unwrapKey(format, wrapped, wrappingKey, iv, aad, algo, usages) {
  return subtle.unwrapKey(format, wrapped, wrappingKey, { name: 'AES-GCM', iv, additionalData: aad },
    algo, false, usages);
}
export const ECDSA_ALGO = CURVE;
export const AES_ALGO = { name: 'AES-GCM', length: 256 };

/** Domain-separated hash helper: H(label || 0x00 || parts...) */
export const labeledHash = (label, ...parts) => sha256(concat(utf8(label), Uint8Array.of(0), ...parts));
