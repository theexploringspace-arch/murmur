# Security review — November 2026

A full read of the code that protects users, in order of risk: the relay, the encryption core, storage
and accounts, then the page itself. Each finding below was reproduced with a test **before** fixing, and
each fix was checked by re-running that test with the fix switched off (it must fail).

## Findings

| # | Severity | Where | What could happen | Fix | Test |
|---|---|---|---|---|---|
| 1 | **High** | relay `inbox.js` — PIN check | The PIN check awaits a hash; meanwhile the runtime delivers other sockets' messages. 20 guesses sent **at once** all read "0 wrong tries" before any wrote "1" — the wrong-PIN limit counted a burst as about one try. With enough parallel sockets, the security PIN gave little protection. | PIN checks run **one at a time per mailbox** (a promise queue on the Durable Object, which is a single instance per mailbox). | `relay.test.mjs` "20 PIN guesses sent AT ONCE still only get 4 real tries" — failed with 5 when the queue was disabled. |
| 2 | Medium | relay `inbox.js` — sockets | `AUTH_TIMEOUT_MS` was defined but never enforced. A socket that never authenticates stayed open forever (the runtime answers its pings), so anyone could park thousands on one mailbox. | Sockets not authenticated within 10 s are closed (4008) whenever the mailbox is touched. | "a socket that never authenticates is closed after AUTH_TIMEOUT_MS" |
| 3 | Low | `backup.js` — `openSealed` | A backup file states its own PBKDF2 round count. A crafted file claiming ~4 billion rounds froze the page until reload. | Refuse more than 10,000,000 rounds (real backups use 600,000). | "a crafted backup claiming billions of PBKDF2 rounds is refused instantly" |
| 4 | Low | `app.js` — incoming messages | Messages carry the sender's timestamp unchecked: a contact could date one 2099 to keep it pinned at the bottom of the chat. | Incoming timestamps are clamped to "now" (late is fine; future isn't). | covered by the e2e chat tests (ordering) |

Earlier in the same week (found while building, fixed before release, listed for the record): a correct
PIN reset the wrong-try ladder (an attacker would get a fresh ladder after every daily backup); the
online-backup package carried the *previous* backup settings; an old copy of an account could delete
the new device's messages (see `docs/ARCHITECTURE.md`, lessons).

## Checked and sound (no change needed)

- **Double Ratchet** (`ratchet.js`): state is changed only after a message authenticates (copy-on-write);
  replays and duplicates are refused; skipped keys are single-use and bounded (`MAX_SKIP` 1,000 per chain);
  header public keys are validated by WebCrypto's import; associated data binds both identity keys.
- **Invites and joins** (`invite.js`, `remote.js`): invites are signed and expire; joins are AES-GCM
  under a prekey ECDH and **signed by the joiner's identity key over this invite**, so nobody can join as
  an existing contact; invites are single-use. Renewals are accepted only from the identity key already
  stored for that contact, never create contacts, and refuse replays.
- **Vault** (`vault.js`): PBKDF2-SHA256 600k → key-encryption key → data key → identity key (non-extractable);
  every record is AES-GCM with the record's name in the associated data (records can't be swapped);
  escalating lockout; erase-after-N is opt-in.
- **Online backup**: mailbox from username + passphrase, key also from the PIN token; the relay stores
  only SHA-256(token); wrong PINs counted per backup (now race-free, finding 1); never wipes.
- **Devices** (`devices.js`): rows sealed under a key from the inbox secret; ordered by the relay, not
  clocks; only the active device can sign others out.
- **Page**: no HTML from strings anywhere, enforced by Trusted Types (`createHTML` throws); strict CSP
  (`script-src 'self'`, no inline, no eval); links open only for http/https after the scam check;
  `javascript:`/`data:`/`intent:` etc. are blocked; updates are verified file-by-file before use.
- **Groups**: only the admin may relay a message "from" another member; edits/deletes are checked
  against the original author.

## Accepted risks (documented, by design)

- Someone who knows your **passphrase** holds a working copy of your identity once they log in (with the
  PIN). Devices shows it; a sign-out is honoured by Murmur but not enforced by a server. Real lock-out
  needs identity-key rotation — not built.
- The relay sees timing, sizes and IP addresses (not names, keys or content). "Hide my IP" covers calls.
- The scam/impostor checks are nudges (word patterns, lookalike names). Safety numbers are the proof.
- A group admin can make a message appear to come from another member of that group.

## What to re-check when code changes

Anything that `await`s inside a check-then-update on the relay (finding 1 is the pattern), any new field
a contact can send (validate type, length, range — finding 4), and any number read from a file or the
network that controls how much work we do (finding 3).
