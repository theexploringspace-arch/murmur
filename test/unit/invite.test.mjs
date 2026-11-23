import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvite, parseInvite, acceptInvite, openJoin, isJoin, joinInviteId, inviteBytesFromText, inviteLink,
  inboxAddress, newInboxSecret, InviteError } from '../../src/js/core/invite.js';
import { generateIdentityKeyPair, exportPublic } from '../../src/js/core/crypto.js';
import { utf8, fromUtf8, toB64u } from '../../src/js/core/bytes.js';

async function person(name) {
  const kp = await generateIdentityKeyPair();
  return { name, identity: { privateKey: kp.privateKey, publicRaw: await exportPublic(kp.publicKey) }, inbox: await inboxAddress(newInboxSecret()) };
}

test('remote invite end-to-end: Bob joins, both ratchets talk, peers learned correctly', async () => {
  const alice = await person('Alice'), bob = await person('Bob');
  const inv = await createInvite({ identity: alice.identity, name: alice.name, inbox: alice.inbox });
  const parsed = await parseInvite(inviteBytesFromText(inviteLink('https://murmur.example', inv.bytes)));
  const b = await acceptInvite(parsed, bob);
  assert.ok(isJoin(b.join)); assert.equal(joinInviteId(b.join), inv.pending.id);
  assert.deepEqual(b.peer.inbox, alice.inbox);
  const a = await openJoin(b.join, inv.pending, { identity: alice.identity });
  assert.equal(a.peer.name, 'Bob'); assert.deepEqual(a.peer.identityPub, bob.identity.publicRaw); assert.deepEqual(a.peer.inbox, bob.inbox);
  const m = await b.ratchet.encrypt(utf8('hi from bob'));
  assert.equal(fromUtf8(await a.ratchet.decrypt(m)), 'hi from bob');
  assert.equal(fromUtf8(await b.ratchet.decrypt(await a.ratchet.encrypt(utf8('hi bob')))), 'hi bob');
});

test('the join reveals nothing about Bob to the relay (name/key/inbox not in the clear)', async () => {
  const alice = await person('Alice'), bob = await person('Bobby McSecret');
  const inv = await createInvite({ identity: alice.identity, name: 'Alice', inbox: alice.inbox });
  const { join } = await acceptInvite(await parseInvite(inv.bytes), bob);
  const hay = Buffer.from(join);
  assert.equal(hay.indexOf(Buffer.from('Bobby')), -1);
  assert.equal(hay.indexOf(Buffer.from(bob.identity.publicRaw.slice(1, 20))), -1);
  assert.equal(hay.indexOf(Buffer.from(bob.inbox.slice(0, 16))), -1);
});

test('altered, expired, future-dated, or own invites are refused', async () => {
  const alice = await person('Alice');
  const inv = await createInvite({ identity: alice.identity, name: 'Alice', inbox: alice.inbox });
  const bad = inv.bytes.slice(); bad[30] ^= 1;
  await assert.rejects(parseInvite(bad), /altered|invalid|damaged/);
  await assert.rejects(parseInvite(inv.bytes, { now: Date.now() + 8 * 864e5 }), /expired/);
  const fut = await createInvite({ identity: alice.identity, name: 'A', inbox: alice.inbox, now: Date.now() + 3600e3 });
  await assert.rejects(parseInvite(fut.bytes), /future/);
  await assert.rejects(acceptInvite(await parseInvite(inv.bytes), alice), /your own/);
  assert.throws(() => inviteBytesFromText('https://evil.example/hello'), InviteError);
});

test('a swapped invite (attacker re-signs with their key) is detectable: identity differs → safety number differs', async () => {
  const alice = await person('Alice'), mallory = await person('Alice');
  const real = await createInvite({ identity: alice.identity, name: 'Alice', inbox: alice.inbox });
  const fake = await createInvite({ identity: mallory.identity, name: 'Alice', inbox: mallory.inbox });
  const pr = await parseInvite(real.bytes), pf = await parseInvite(fake.bytes);
  assert.equal(pf.name, pr.name, 'names can be faked…');
  assert.notDeepEqual(pf.identityPub, pr.identityPub, '…keys cannot, which is what safety numbers compare');
});

test('join is bound to its invite: wrong invite, tampering, or expiry rejected', async () => {
  const alice = await person('Alice'), bob = await person('Bob');
  const inv1 = await createInvite({ identity: alice.identity, name: 'Alice', inbox: alice.inbox });
  const inv2 = await createInvite({ identity: alice.identity, name: 'Alice', inbox: alice.inbox });
  const { join } = await acceptInvite(await parseInvite(inv1.bytes), bob);
  await assert.rejects(openJoin(join, inv2.pending, { identity: alice.identity }), /different invite/);
  const t = join.slice(); t[t.length - 3] ^= 1;
  await assert.rejects(openJoin(t, inv1.pending, { identity: alice.identity }), /authentication/);
  await assert.rejects(openJoin(join, inv1.pending, { identity: alice.identity, now: Date.now() + 8 * 864e5 }), /expired/);
});

test('mailbox address is a one-way hash of the secret', async () => {
  const s = newInboxSecret();
  const a = await inboxAddress(s);
  assert.equal(a.length, 32); assert.notDeepEqual(a, s);
  assert.deepEqual(await inboxAddress(s), a);
  assert.equal(toB64u(a).length, 43);
});
