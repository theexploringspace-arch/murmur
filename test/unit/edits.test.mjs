// Edit within 15 min, delete for everyone within 1 h — enforced by sender AND receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, canDeleteForEveryone, acceptChange, minutesLeft, EDIT_WINDOW, DELETE_WINDOW, SKEW } from '../../src/js/core/edits.js';

const T = 1_700_000_000_000;
const mine = (ago, extra = {}) => ({ id: 'm1', dir: 'out', ts: T - ago, text: 'hi', ...extra });
const theirs = (ago, extra = {}) => ({ id: 'm1', dir: 'in', ts: T - ago, text: 'hi', ...extra });

test('sender side: windows and what can be edited', () => {
  assert.equal(canEdit(mine(14 * 60_000), T), true);
  assert.equal(canEdit(mine(16 * 60_000), T), false, 'after 15 min');
  assert.equal(canEdit(mine(0, { file: {} }), T), false, 'photos/files are not editable');
  assert.equal(canEdit(mine(0, { loc: {} }), T), false);
  assert.equal(canEdit(theirs(0), T), false, 'only your own');
  assert.equal(canDeleteForEveryone(mine(59 * 60_000, { file: {} }), T), true, 'files can be deleted for everyone');
  assert.equal(canDeleteForEveryone(mine(61 * 60_000), T), false, 'after 1 hour');
  assert.equal(canDeleteForEveryone(theirs(0), T), false);
  assert.equal(minutesLeft(mine(10 * 60_000), EDIT_WINDOW, T), 5);
});

test('receiver side: accepts only the author, only in time, only sane edits', () => {
  assert.equal(acceptChange(theirs(60_000), { t: 'edit', text: 'hello' }, 'alice', false, T), 'edit');
  assert.equal(acceptChange(theirs(EDIT_WINDOW + SKEW + 1), { t: 'edit', text: 'x' }, 'alice', false, T), null, 'too late');
  assert.equal(acceptChange(theirs(EDIT_WINDOW + 60_000), { t: 'edit', text: 'x' }, 'alice', false, T), 'edit', 'small clock skew tolerated');
  assert.equal(acceptChange(theirs(DELETE_WINDOW), { t: 'del' }, 'alice', false, T), 'del');
  assert.equal(acceptChange(theirs(DELETE_WINDOW + SKEW + 1), { t: 'del' }, 'alice', false, T), null);
  assert.equal(acceptChange(mine(0), { t: 'del' }, 'alice', false, T), null, 'nobody can delete MY message on my phone');
  assert.equal(acceptChange(undefined, { t: 'del' }, 'alice', false, T), null);
  assert.equal(acceptChange(theirs(0, { file: {} }), { t: 'edit', text: 'x' }, 'alice', false, T), null, 'a photo can’t be turned into text');
  assert.equal(acceptChange(theirs(0), { t: 'edit', text: '   ' }, 'alice', false, T), null);
  assert.equal(acceptChange(theirs(0), { t: 'edit', text: 'x'.repeat(8001) }, 'alice', false, T), null);
  assert.equal(acceptChange(theirs(0, { deleted: true }), { t: 'edit', text: 'back' }, 'alice', false, T), null, 'deleted stays deleted');
});

test('groups: another member (or the forwarding admin) can\'t change someone else\'s message', () => {
  const g = theirs(0, { from: 'bob' });
  assert.equal(acceptChange(g, { t: 'del' }, 'bob', true, T), 'del');
  assert.equal(acceptChange(g, { t: 'del' }, 'carol', true, T), null);
  assert.equal(acceptChange(g, { t: 'edit', text: 'fake' }, 'admin', true, T), null);
});
