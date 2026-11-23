import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, cardinal, formatDistance, relative, validLocation, mapLinks } from '../../src/js/core/geo.js';
import { createGroup, applyInvite, inviteMessage, isMember, withoutMember, recipients, GroupError } from '../../src/js/core/groups.js';

const lagos = { lat: 6.5244, lon: 3.3792 }, abuja = { lat: 9.0765, lon: 7.3986 };
test('distance and direction match known values', () => {
  const d = distance(lagos, abuja);
  assert.ok(Math.abs(d - 524_000) < 6_000, `Lagos→Abuja ≈ 524 km, got ${d}`);
  assert.equal(cardinal(bearing(lagos, abuja)), 'ENE'); assert.ok(Math.abs(bearing(lagos, abuja) - 57.3) < 1);
  assert.equal(Math.round(distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })), 111195);
  assert.equal(cardinal(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })), 'N');
  assert.equal(cardinal(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })), 'W');
  assert.equal(formatDistance(850), '850 m'); assert.equal(formatDistance(1234), '1.2 km'); assert.equal(formatDistance(523_900), '524 km');
  assert.equal(relative({ ...lagos, acc: 20 }, { ...lagos, acc: 15 }), 'right next to you');
  assert.match(relative(lagos, abuja), /^52[0-9] km ENE of you$/);
  assert.equal(relative(null, abuja), null);
});
test('location messages are validated (no NaN, no impossible coordinates)', () => {
  assert.ok(validLocation({ lat: 6.5, lon: 3.3, acc: 10 }));
  for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: '6', lon: 3 }, { lat: 1, lon: 1, acc: -5 }, null]) assert.ok(!validLocation(bad), JSON.stringify(bad));
  assert.match(mapLinks(lagos).apple, /^https:\/\/maps\.apple\.com\/\?ll=6\.524400,3\.379200/);
});

const hex = (n) => Array.from({ length: n }, (_, i) => ((i * 7 + n) % 16).toString(16)).join('');
const A = { cid: 'a'.repeat(32), name: 'Ada' }, B = { cid: 'b'.repeat(32), name: 'Bola' }, C = { cid: 'c'.repeat(32), name: 'Chidi' };
import { webcrypto } from 'node:crypto';
const realHex = (bytes) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(bytes))).toString('hex'); // same as the app
const mk = () => createGroup({ name: 'Hike crew', me: A, members: [B, C], randomHex: realHex });

test('only the creator can define or change a group; members are checked on every update', () => {
  const g = mk();
  const atB = applyInvite(null, inviteMessage(g), A.cid, B.cid);
  assert.deepEqual(atB.members.map((m) => m.cid), [A.cid, B.cid, C.cid]);
  assert.ok(isMember(atB, C.cid)); assert.deepEqual(recipients(atB, B.cid), [A.cid, C.cid]);
  assert.throws(() => applyInvite(atB, { ...inviteMessage(g), v: 2, name: 'Hijacked' }, C.cid, B.cid), /only the group creator/);
  assert.throws(() => applyInvite(atB, inviteMessage(g), A.cid, B.cid), /old group update/, 'replayed roster refused');
  const g2 = withoutMember(g, C.cid);
  const atB2 = applyInvite(atB, inviteMessage(g2), A.cid, B.cid);
  assert.ok(!isMember(atB2, C.cid));
  const atC = applyInvite({ ...atB, removed: false }, inviteMessage(g2), A.cid, C.cid);
  assert.equal(atC.removed, true, 'a removed member learns they were removed and stops sending');
});
test('malformed groups are refused', () => {
  assert.throws(() => createGroup({ name: '', me: A, members: [B], randomHex: () => hex(32) }), GroupError);
  assert.throws(() => createGroup({ name: 'x', me: A, members: [], randomHex: () => hex(32) }), /2–20/);
  const g = mk();
  for (const bad of [{ gid: 'zz' }, { members: [{ cid: A.cid }] }, { members: [A, A] }, { members: 'nope' }, { name: '‮' }])
    assert.throws(() => applyInvite(null, { ...inviteMessage(g), ...bad }, A.cid, B.cid), GroupError, JSON.stringify(bad));
  assert.throws(() => applyInvite(null, { ...inviteMessage(g), admin: C.cid }, A.cid, B.cid), /only the group creator/);
});

test('group ids from the real generator are valid on the receiving side; a broken generator is caught at creation', () => {
  const g = mk();
  assert.match(g.id, /^[0-9a-f]{32}$/);
  assert.doesNotThrow(() => applyInvite(null, inviteMessage(g), A.cid, B.cid));
  assert.throws(() => createGroup({ name: 'x', me: A, members: [B], randomHex: () => 'abc' }), /bad group id generator/);
});
