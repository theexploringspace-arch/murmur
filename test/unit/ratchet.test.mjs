import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ratchet, RatchetError, generateDH, associatedData, MAX_SKIP } from '../../src/js/core/ratchet.js';
import { utf8, fromUtf8, random } from '../../src/js/core/bytes.js';

const AD = associatedData(random(65), random(65));
async function pair() {
  const sk = random(32);
  const bobKey = await generateDH();
  const alice = await Ratchet.initSender(sk, bobKey.pub, AD);   // knows Bob's published key
  const bob = Ratchet.initReceiver(sk, bobKey, AD);
  return { alice, bob };
}
const enc = async (r, s) => r.encrypt(utf8(s));
const dec = async (r, w) => fromUtf8(await r.decrypt(w));

test('ping-pong conversation across many DH ratchet steps', async () => {
  const { alice, bob } = await pair();
  assert.equal(bob.canSend, false, 'receiver cannot send before first message');
  for (let i = 0; i < 6; i++) {
    assert.equal(await dec(bob, await enc(alice, `a${i}`)), `a${i}`);
    assert.equal(await dec(alice, await enc(bob, `b${i}`)), `b${i}`);
  }
});

test('mailbox reality: out-of-order, delayed, and lost messages', async () => {
  const { alice, bob } = await pair();
  const w = [];
  for (let i = 0; i < 5; i++) w.push(await enc(alice, `m${i}`));
  assert.equal(await dec(bob, w[3]), 'm3');
  assert.equal(await dec(bob, w[0]), 'm0');
  // bob replies (new DH epoch), alice replies, and only then an OLD message shows up
  assert.equal(await dec(alice, await enc(bob, 'r')), 'r');
  const a2 = await enc(alice, 'new epoch');
  assert.equal(await dec(bob, a2), 'new epoch');
  assert.equal(await dec(bob, w[4]), 'm4');
  assert.equal(await dec(bob, w[1]), 'm1');
  // w[2] is "lost" forever: nothing breaks
  assert.equal(await dec(alice, await enc(bob, 'still fine')), 'still fine');
});

test('replay is rejected and leaves state usable', async () => {
  const { alice, bob } = await pair();
  const w = await enc(alice, 'once');
  await dec(bob, w);
  await assert.rejects(bob.decrypt(w), RatchetError);
  const w0 = await enc(alice, 'x'); const w1 = await enc(alice, 'y');
  await dec(bob, w1); await dec(bob, w0);           // w0 came from the skipped store
  await assert.rejects(bob.decrypt(w0), RatchetError); // skipped keys are single-use
  assert.equal(await dec(bob, await enc(alice, 'after')), 'after');
});

test('tampering anywhere (header, body, wrong conversation) fails without corrupting state', async () => {
  const { alice, bob } = await pair();
  const w = await enc(alice, 'secret');
  for (const i of [5, 70, w.length - 1]) {
    const bad = w.slice(); bad[i] ^= 1;
    await assert.rejects(bob.decrypt(bad));
  }
  const other = await pair();
  await assert.rejects(other.bob.decrypt(w));
  assert.equal(await dec(bob, w), 'secret', 'original still decrypts after failed attempts');
});

test('forward secrecy: a state captured now cannot read messages already received', async () => {
  const { alice, bob } = await pair();
  const old = await enc(alice, 'before the theft');
  await dec(bob, old);
  const stolen = Ratchet.fromJSON(JSON.parse(JSON.stringify(bob.toJSON())));
  await assert.rejects(stolen.decrypt(old));
});

test('state survives JSON round-trip (vault persistence) mid-conversation', async () => {
  let { alice, bob } = await pair();
  const reload = (r) => Ratchet.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
  const skipped = await enc(alice, 'skipped'); const seen = await enc(alice, 'seen');
  await dec(bob, seen);
  bob = reload(bob); alice = reload(alice);
  assert.equal(await dec(bob, skipped), 'skipped');
  assert.equal(await dec(alice, await enc(bob, 'reply')), 'reply');
});

test('absurd counter gaps are refused (DoS guard)', async () => {
  const { alice, bob } = await pair();
  const w = await enc(alice, 'x');
  const forged = w.slice(); new DataView(forged.buffer).setUint32(70, MAX_SKIP + 5);
  await assert.rejects(bob.decrypt(forged), /too many skipped/);
});

test('ciphertext length is padded (relay cannot tell "ok" from a paragraph)', async () => {
  const { alice } = await pair();
  const a = await enc(alice, 'ok'); const b = await enc(alice, 'x'.repeat(200));
  assert.equal(a.length, b.length);
});
