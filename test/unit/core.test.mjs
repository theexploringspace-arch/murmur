// Unit tests for Murmur's core: bytes, SDP codec, identity, pairing, vault, session.
// Run: node --test test/unit
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../../src/js/core/bytes.js';
import { compactSdp, expandSdp, parseSdp, ipv6ToBytes, bytesToIpv6 } from '../../src/js/core/sdp.js';
import { safetyNumber, contactId } from '../../src/js/core/identity.js';
import * as P from '../../src/js/core/pairing.js';
import { Vault, WrongPassphraseError, VaultWipedError } from '../../src/js/core/vault.js';
import { MemoryStore } from '../../src/js/core/storage.js';
import { SecureSession, pad, unpad, SessionError } from '../../src/js/core/session.js';
import * as C from '../../src/js/core/crypto.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
const FAST = { iterations: 1000 }; // PBKDF2 cost lowered ONLY in tests

async function makeIdentity() {
  const kp = await C.generateIdentityKeyPair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicRaw: await C.exportPublic(kp.publicKey) };
}

describe('bytes', () => {
  test('base45 matches RFC 9285 vectors', () => {
    assert.equal(B.toB45(B.utf8('AB')), 'BB8');
    assert.equal(B.toB45(B.utf8('Hello!!')), '%69 VD92EX0');
    assert.equal(B.toB45(B.utf8('base-45')), 'UJCLQE7W581');
    assert.equal(B.fromUtf8(B.fromB45('QED8WEX0')), 'ietf!');
    assert.throws(() => B.fromB45('GGW'), /triple/); // 65536+ is invalid
    assert.throws(() => B.fromB45('a'), /char/);
  });
  test('base45/base64url round-trip random data', () => {
    for (let n = 0; n < 300; n++) {
      const b = B.random(n);
      assert.deepEqual(B.fromB45(B.toB45(b)), b);
      assert.deepEqual(B.fromB64u(B.toB64u(b)), b);
    }
  });
  test('Reader rejects truncation and trailing bytes', () => {
    const w = new B.Writer().u8(1).lp8(B.utf8('hi')).done();
    assert.throws(() => new B.Reader(w.slice(0, 2)).raw(5), /truncated/);
    const r = new B.Reader(B.concat(w, Uint8Array.of(9))); r.u8(); r.lp8();
    assert.throws(() => r.end(), /trailing/);
  });
  test('constant-time equal', () => {
    assert.ok(B.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 2)));
    assert.ok(!B.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 3)));
    assert.ok(!B.equal(Uint8Array.of(1), Uint8Array.of(1, 2)));
  });
});

describe('SDP compaction', () => {
  test('real Chrome offer round-trips every security-relevant field', () => {
    const sdp = fixture('chrome-offer.sdp');
    const c = compactSdp(sdp);
    assert.ok(c.length < 100, `compact size ${c.length}`);
    const back = expandSdp(c, 'offer');
    const a = parseSdp(sdp), b = parseSdp(back.sdp);
    assert.deepEqual(b.fingerprint, a.fingerprint);
    assert.equal(b.ufrag, a.ufrag); assert.equal(b.pwd, a.pwd); assert.equal(b.setup, a.setup);
    assert.deepEqual(b.candidates, a.candidates);
  });
  test('IPv4, IPv6, TCP-passive kept; TCP-active and srflx dropped', () => {
    const a = parseSdp(fixture('multi-offer.sdp'));
    const kinds = a.candidates.map((c) => `${c.proto}:${c.address}`);
    assert.deepEqual(kinds, ['udp:f6b282a8-e433-4413-b413-95d9d2d43e2b.local', 'udp:192.168.43.17',
      'udp:fe80::1c2b:3aff:fe4d:5e6f%wlan0', 'tcp:192.168.43.17']);
    const b = parseSdp(expandSdp(compactSdp(fixture('multi-offer.sdp')), 'offer').sdp);
    assert.equal(b.candidates[2].address, 'fe80:0:0:0:1c2b:3aff:fe4d:5e6f'); // sender's zone id is meaningless to the receiver
    assert.equal(b.candidates[3].tcptype, 'passive');
    assert.equal(b.candidates[3].port, 54000);
  });
  test('ipv6 codec', () => {
    assert.equal(bytesToIpv6(ipv6ToBytes('::1')), '0:0:0:0:0:0:0:1');
    assert.equal(bytesToIpv6(ipv6ToBytes('2001:db8::8:800:200c:417a')), '2001:db8:0:0:8:800:200c:417a');
  });
  test('rejects SDP without candidates or with non-sha-256 fingerprint', () => {
    const s = fixture('chrome-offer.sdp');
    assert.throws(() => parseSdp(s.replace(/a=candidate.*\r\n/, '')), /No host candidates/);
    assert.throws(() => parseSdp(s.replace('sha-256', 'sha-1')), /Unsupported/);
  });
  test('expand rejects injected newlines (SDP injection)', () => {
    const c = compactSdp(fixture('chrome-offer.sdp'));
    // ufrag is at offset 2 after version + len; overwrite one char with '\n'
    const evil = c.slice(); evil[3] = 0x0a;
    assert.throws(() => expandSdp(evil, 'offer'), /ICE credentials/);
  });
});

describe('identity', () => {
  test('safety number is symmetric, 60 digits, differs per pair', async () => {
    const a = await makeIdentity(), b = await makeIdentity(), c = await makeIdentity();
    const ab = await safetyNumber(a.publicRaw, b.publicRaw);
    assert.equal(ab, await safetyNumber(b.publicRaw, a.publicRaw));
    assert.match(ab, /^(\d{5} ){11}\d{5}$/);
    assert.notEqual(ab, await safetyNumber(a.publicRaw, c.publicRaw));
    assert.match(await contactId(a.publicRaw), /^[0-9a-f]{32}$/);
  });
});

describe('pairing codes', () => {
  const sdp = fixture('chrome-offer.sdp');
  test('offer → answer round-trip, both text forms', async () => {
    const alice = await makeIdentity(), bob = await makeIdentity();
    const offer = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'Alice 🌙', sdp });
    for (const txt of [P.toQrText(offer), P.toPasteText(offer)]) {
      const parsed = await P.parsePairingCode(P.fromText(txt), { expectKind: 'offer' });
      assert.equal(parsed.name, 'Alice 🌙');
      assert.deepEqual(parsed.publicRaw, alice.publicRaw);
      assert.ok(parsed.description.sdp.includes('a=fingerprint:sha-256 AA:33'));
    }
    assert.ok(P.toQrText(offer).length < 450, `QR text ${P.toQrText(offer).length} chars`);
    const answer = await P.createPairingCode({ kind: 'answer', identity: bob, name: 'Bob', sdp, offerBytes: offer });
    const pa = await P.parsePairingCode(answer, { expectKind: 'answer', offerBytes: offer });
    assert.equal(pa.name, 'Bob');
  });
  test('paste text survives wrapping/quoting by chat apps', async () => {
    const alice = await makeIdentity();
    const offer = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp });
    const t = P.toPasteText(offer);
    const mangled = `Here's my code: "${t.slice(0, 30)}\n${t.slice(30)}" `;
    assert.deepEqual(P.fromText(mangled), offer);
  });
  test('every single-bit flip is rejected', async () => {
    const alice = await makeIdentity();
    const offer = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp });
    for (let i = 0; i < offer.length; i += 7) {
      const evil = offer.slice(); evil[i] ^= 0x01;
      await assert.rejects(P.parsePairingCode(evil), P.PairingError, `byte ${i}`);
    }
  });
  test('swapping in an attacker key with a valid attacker signature changes identity (caught by pinning)', async () => {
    const alice = await makeIdentity(), mallory = await makeIdentity();
    const forged = await P.createPairingCode({ kind: 'offer', identity: mallory, name: 'Alice', sdp });
    const p = await P.parsePairingCode(forged);
    assert.notDeepEqual(p.publicRaw, alice.publicRaw); // UI keys contacts by public key, never by name
  });
  test('answer bound to its offer; wrong kind; expiry; future', async () => {
    const alice = await makeIdentity(), bob = await makeIdentity();
    const offer1 = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp });
    const offer2 = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp });
    const ans = await P.createPairingCode({ kind: 'answer', identity: bob, name: 'B', sdp, offerBytes: offer1 });
    await assert.rejects(P.parsePairingCode(ans, { expectKind: 'answer', offerBytes: offer2 }), /different invite/);
    await assert.rejects(P.parsePairingCode(offer1, { expectKind: 'answer', offerBytes: offer1 }), /invite code/);
    const old = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp, now: Date.now() - 16 * 60e3 });
    await assert.rejects(P.parsePairingCode(old), /expired/);
    const fut = await P.createPairingCode({ kind: 'offer', identity: alice, name: 'A', sdp, now: Date.now() + 10 * 60e3 });
    await assert.rejects(P.parsePairingCode(fut), /future/);
  });
  test('garbage text', () => {
    assert.throws(() => P.fromText('hello'), P.PairingError);
    assert.throws(() => P.fromText('MUR1:abc'), P.PairingError);
  });
  test('names are clamped and stripped of control characters', () => {
    assert.equal(P.clampName(' a\u0000b\nc '), 'abc');
    assert.ok(B.utf8(P.clampName('😀'.repeat(30))).length <= 40);
  });
});

describe('vault', () => {
  test('create, unlock, records encrypted at rest, keys non-extractable', async () => {
    const store = new MemoryStore();
    const v = await Vault.create(store, 'correct horse battery', FAST);
    assert.equal(v.identity.privateKey.extractable, false);
    assert.equal(v.dek.extractable, false);
    await v.putRecord('contacts', [{ name: 'Secret Sam' }]);
    // nothing in the raw store contains the plaintext
    for (const k of await store.keys()) {
      const raw = JSON.stringify(await store.get(k), (_, x) => (x instanceof Uint8Array ? B.toHex(x) : x));
      assert.ok(!raw.includes('Secret') && !raw.includes(B.toHex(B.utf8('Secret'))), k);
    }
    const v2 = await Vault.unlock(store, 'correct horse battery');
    assert.deepEqual(await v2.getRecord('contacts'), [{ name: 'Secret Sam' }]);
    assert.deepEqual(v2.identity.publicRaw, v.identity.publicRaw);
    // same identity: a signature from v verifies with v2's public key
    const sig = await C.sign(v.identity.privateKey, B.utf8('x'));
    assert.ok(await C.verify(v2.identity.publicKey, sig, B.utf8('x')));
  });
  test('wrong passphrase counts down then wipes', async () => {
    const store = new MemoryStore();
    await Vault.create(store, 'correct horse battery', { ...FAST, wipeAfter: 3 });
    await assert.rejects(Vault.unlock(store, 'nope nope nope'), (e) => e instanceof WrongPassphraseError && e.attemptsLeft === 2);
    await assert.rejects(Vault.unlock(store, 'nope nope nope'), (e) => e.attemptsLeft === 1);
    await assert.rejects(Vault.unlock(store, 'nope nope nope'), VaultWipedError);
    assert.equal(await Vault.exists(store), false);
  });
  test('successful unlock resets the failure counter', async () => {
    const store = new MemoryStore();
    await Vault.create(store, 'correct horse battery', { ...FAST, wipeAfter: 2 });
    await assert.rejects(Vault.unlock(store, 'wrong wrong wrong'));
    await Vault.unlock(store, 'correct horse battery');
    await assert.rejects(Vault.unlock(store, 'wrong wrong wrong'), WrongPassphraseError);
    assert.ok(await Vault.exists(store));
  });
  test('record swap is detected (AAD binds record name)', async () => {
    const store = new MemoryStore();
    const v = await Vault.create(store, 'correct horse battery', FAST);
    await v.putRecord('a', 1); await v.putRecord('b', 2);
    await store.put('rec/a', await store.get('rec/b'));
    await assert.rejects(v.getRecord('a'));
  });
  test('change passphrase', async () => {
    const store = new MemoryStore();
    const v = await Vault.create(store, 'correct horse battery', FAST);
    await v.putRecord('x', 'kept');
    await assert.rejects(v.changePassphrase('not it at all', 'new passphrase!!'), WrongPassphraseError);
    await v.changePassphrase('correct horse battery', 'new passphrase!!');
    await assert.rejects(Vault.unlock(store, 'correct horse battery'), WrongPassphraseError);
    assert.equal(await (await Vault.unlock(store, 'new passphrase!!')).getRecord('x'), 'kept');
  });
  test('short passphrase rejected; locked vault refuses access', async () => {
    await assert.rejects(Vault.create(new MemoryStore(), 'short'), /at least/);
    const v = await Vault.create(new MemoryStore(), 'correct horse battery', FAST);
    v.lock();
    await assert.rejects(v.getRecord('x'), /locked/);
  });
});

// ---------- session ----------
const FP_A = B.random(32), FP_B = B.random(32);

/** Wire two sessions together through an in-memory, ordered "channel". */
async function pair({ tap, rekeyEveryMessages = 1000, aliceId, bobId, bobExpects, aliceFps, bobFps } = {}) {
  const alice = aliceId || await makeIdentity();
  const bob = bobId || await makeIdentity();
  let A, Bs;
  const deliver = (to, from) => (bytes) => {
    let b = bytes;
    if (tap) b = tap(b, from);
    if (b) setTimeout(() => to().receive(b), 0);
  };
  A = new SecureSession({ role: 'offerer', identity: alice, peerIdentityRaw: bob.publicRaw,
    localFingerprint: (aliceFps || [FP_A, FP_B])[0], remoteFingerprint: (aliceFps || [FP_A, FP_B])[1],
    send: deliver(() => Bs, 'A'), rekeyEveryMessages });
  Bs = new SecureSession({ role: 'answerer', identity: bob, peerIdentityRaw: (bobExpects || alice).publicRaw,
    localFingerprint: (bobFps || [FP_B, FP_A])[0], remoteFingerprint: (bobFps || [FP_B, FP_A])[1],
    send: deliver(() => A, 'B'), rekeyEveryMessages });
  const inbox = { A: [], B: [] }, errors = { A: [], B: [] };
  A.onmessage = (m) => inbox.A.push(m); Bs.onmessage = (m) => inbox.B.push(m);
  A.onerror = (e) => errors.A.push(e); Bs.onerror = (e) => errors.B.push(e);
  const ready = Promise.all([new Promise((r) => (A.onready = r)), new Promise((r) => (Bs.onready = r))]);
  await Promise.all([A.start(), Bs.start()]);
  return { A, B: Bs, inbox, errors, ready };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await settle(5); } };

describe('secure session', () => {
  test('handshake and bidirectional messaging', async () => {
    const s = await pair();
    await s.ready;
    await s.A.sendMessage({ t: 'msg', text: 'hi bob' });
    await s.B.sendMessage({ t: 'msg', text: 'hi alice' });
    await until(() => s.inbox.A.length && s.inbox.B.length);
    assert.equal(s.inbox.B[0].text, 'hi bob');
    assert.equal(s.inbox.A[0].text, 'hi alice');
  });

  test('wire never contains plaintext; ciphertext length is padded to a bucket', async () => {
    const frames = [];
    const s = await pair({ tap: (b) => { frames.push(b); return b; } });
    await s.ready;
    await s.A.sendMessage({ t: 'msg', text: 'ATTACK AT DAWN' });
    await s.A.sendMessage({ t: 'msg', text: 'x' });
    await until(() => s.inbox.B.length === 2);
    const data = frames.filter((f) => f[0] === 3);
    for (const f of data) assert.ok(!Buffer.from(f).toString('latin1').includes('ATTACK'));
    assert.equal(data[0].length, data[1].length, 'different message sizes must look identical on the wire');
  });

  test('impostor: peer with a different identity key is rejected', async () => {
    const alice = await makeIdentity(), mallory = await makeIdentity();
    // Bob believes he is talking to alice, but mallory runs the offerer side.
    const s = await pair({ aliceId: mallory, bobExpects: alice });
    await until(() => s.errors.B.length);
    assert.match(s.errors.B[0].message, /prove its identity/);
    assert.ok(!s.B.ready);
  });

  test('DTLS fingerprint mismatch (transport swapped / relayed) is rejected', async () => {
    const s = await pair({ aliceFps: [FP_A, FP_B], bobFps: [FP_B, B.random(32)] });
    await until(() => s.errors.A.length || s.errors.B.length);
    assert.ok(![...s.errors.A, ...s.errors.B].length === false);
    assert.ok(!(s.A.ready && s.B.ready));
  });

  test('tampered ciphertext kills the session', async () => {
    let flip = false;
    const s = await pair({ tap: (b) => { if (flip && b[0] === 3) { b = b.slice(); b[b.length - 1] ^= 1; } return b; } });
    await s.ready; flip = true;
    await s.A.sendMessage({ t: 'msg', text: 'x' });
    await until(() => s.errors.B.length);
    assert.match(s.errors.B[0].message, /tampered/);
  });

  test('replayed frame is rejected', async () => {
    let captured = null, replay = false;
    const s = await pair({ tap: (b, from) => { if (from === 'A' && b[0] === 3 && !captured) captured = b; return b; } });
    await s.ready;
    await s.A.sendMessage({ t: 'msg', text: 'pay 5' });
    await until(() => s.inbox.B.length === 1);
    s.B.receive(captured);
    await until(() => s.errors.B.length);
    assert.match(s.errors.B[0].message, /replayed/);
  });

  test('dropped frame (gap) is detected', async () => {
    let n = 0;
    const s = await pair({ tap: (b, from) => (from === 'A' && b[0] === 3 && n++ === 0 ? null : b) });
    await s.ready;
    await s.A.sendMessage({ t: 'msg', text: '1' });
    await s.A.sendMessage({ t: 'msg', text: '2' });
    await until(() => s.errors.B.length);
    assert.match(s.errors.B[0].message, /missing/);
  });

  test('data before handshake is rejected', async () => {
    const s = await pair();
    await s.ready;
    const alice = await makeIdentity(), bob = await makeIdentity();
    const lone = new SecureSession({ role: 'answerer', identity: bob, peerIdentityRaw: alice.publicRaw,
      localFingerprint: FP_B, remoteFingerprint: FP_A, send: () => {} });
    const errs = []; lone.onerror = (e) => errs.push(e);
    await lone.start();
    lone.receive(Uint8Array.of(3, 0, 0, 0, 0, 0, 1, 2, 3));
    await until(() => errs.length);
    assert.match(errs[0].message, /before handshake/);
  });

  test('off-curve ephemeral key in HELLO is rejected', async () => {
    const alice = await makeIdentity(), bob = await makeIdentity();
    const s = new SecureSession({ role: 'answerer', identity: bob, peerIdentityRaw: alice.publicRaw,
      localFingerprint: FP_B, remoteFingerprint: FP_A, send: () => {} });
    const errs = []; s.onerror = (e) => errs.push(e);
    await s.start();
    const bad = new Uint8Array(65); bad[0] = 4; bad.fill(7, 1);
    s.receive(B.concat(Uint8Array.of(1, 1), bad, B.random(32)));
    await until(() => errs.length);
  });

  test('re-keying under heavy concurrent traffic in both directions loses nothing', async () => {
    const s = await pair({ rekeyEveryMessages: 7 });
    let rekeys = 0; s.A.onrekey = () => rekeys++;
    await s.ready;
    const N = 120;
    // Bursts of 4 per side, both directions in flight at once, so re-keys
    // interleave with live traffic (including B messages crossing a REKEY).
    for (let i = 0; i < N; i += 4) {
      const burst = [];
      for (let j = i; j < i + 4; j++) {
        burst.push(s.A.sendMessage({ t: 'msg', i: j, from: 'A' }));
        burst.push(s.B.sendMessage({ t: 'msg', i: j, from: 'B' }));
      }
      await Promise.all(burst);
      await settle(2);
    }
    await until(() => s.inbox.A.length === N && s.inbox.B.length === N, 10000);
    assert.deepEqual(s.inbox.B.map((m) => m.i), [...Array(N).keys()]);
    assert.deepEqual(s.inbox.A.map((m) => m.i), [...Array(N).keys()]);
    assert.deepEqual([...s.errors.A, ...s.errors.B], []);
    assert.ok(rekeys >= 5, `expected several re-keys, got ${rekeys}`);
    assert.equal(s.A.epoch, s.B.epoch);
  });

  test('forward secrecy: old chain keys are erased after use', async () => {
    const s = await pair();
    await s.ready;
    const ck0 = s.A.send.ck;
    await s.A.sendMessage({ t: 'msg' });
    assert.ok(ck0.every((x) => x === 0), 'previous chain key must be zeroed');
    assert.equal(s.A.eph, null, 'handshake ephemeral private key must be dropped');
  });
});

describe('padding', () => {
  test('pad/unpad round-trip and buckets', () => {
    for (const n of [0, 1, 251, 252, 253, 1000, 5000, 20000, 40000]) {
      const d = B.random(n);
      const p = pad(d);
      assert.ok([256, 1024, 4096, 16384].includes(p.length) || p.length % 16384 === 0);
      assert.deepEqual(unpad(p), d);
    }
    assert.throws(() => unpad(Uint8Array.of(0, 0, 1, 0)), SessionError);
  });
});
