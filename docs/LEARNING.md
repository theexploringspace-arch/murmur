# Learning with Murmur

A guided tour for reading this codebase like a security engineer, plus exercises. Do them without
AI first; each has a hint and a way to check yourself.

## Reading order (≈ 2 hours)

1. `src/js/core/bytes.js` — how bytes move. Note `Reader.end()`: parsers that ignore trailing
   bytes are a classic source of signature-bypass bugs.
2. `src/js/core/crypto.js` — the *only* place primitives are called. Ask of every function: what
   happens on bad input?
3. `src/js/core/pairing.js` — read `parsePairingCode` top to bottom. Why is the signature checked
   **before** the kind/expiry checks, and why is that order safe?
4. `src/js/core/session.js` — the heart. Trace one message: `sendMessage → #encryptAndSend →
   rawSend → (wire) → receive → #handle → #onData`. Then trace `rekey()` with both queues in mind.
5. `src/js/core/vault.js` — key hierarchy. Why wrap the identity key with the DEK and not directly
   with the passphrase key? (Answer: changing the passphrase re-wraps one 32-byte key, not everything.)
6. `test/unit/core.test.mjs` — every attack test is a claim about the code. Find the line of code
   each one depends on.
7. `src/js/qr/decode.js` — computer vision without a library: binarize → find → fit → sample → correct.

## Exercises

### 1. Break it on purpose (debugging)
In `session.js`, change `if (seq !== chain.seq)` to `if (seq < chain.seq)`.
Run `npm test`. **Which test fails, and what error message does it now report instead of "missing message"?**
Why is the session still killed even though the sequence check no longer catches the gap?
What does this teach about defence in depth — and about misleading error messages when debugging?
*Hint:* the receiver's chain key is still at step 0 when frame 1 arrives.
*Check:* revert, and confirm 42/42.

### 2. Threat-model question
Murmur puts **both DTLS fingerprints** into the transcript `T`. Remove them (pass empty arrays)
and reason: who could now sit in the middle, and what would they still be unable to do?
Write your answer as an attack sequence diagram before running the "fingerprint mismatch" test.

### 3. Find the boundary
Someone reports: "We both scanned, it says *Connecting…* forever." List the layers from
ARCHITECTURE.md's debugging table in order. For each, name **one observation** that would
rule it in or out (e.g. `chrome://webrtc-internals` → ICE candidate pair state).

### 4. Implement: safety-number QR
Today users compare 60 digits by eye. Add a button on the contact screen that shows the safety
number as a QR, and a "verify by scanning" flow that marks the contact `verified: true` when the
scanned number equals the computed one. Write the unit test first (`identity.js` is pure).
*Constraint:* the stored `verified` flag must reset if the contact's key ever changes.

### 5. Implement: per-message expiry enforcement on the sender's history
`persistHistory` in `app.js` already skips `ttl` messages — but nothing tests it, because it lives in
the UI layer. Move the filtering into a pure function in `core/` (e.g. `historyToStore(msgs)`), call it
from `app.js`, and write a test proving a disappearing message is **never** written to the vault, even
with history on. (Use `MemoryStore` + `Vault` directly — no browser required.) Spotting untested
security logic in the UI layer and pulling it into a testable core is the real lesson.

### 6. Attack the QR decoder (fuzzing)
Write a test that feeds `decodeMatrix` 10,000 random 21×21…57×57 matrices and asserts it never
throws anything except `Error` and never hangs > 50 ms. What's the worst-case path through
`rsDecode`? Is there any input that makes `tryDecode` loop excessively?

### 7. Threat-model question
The vault wipes after N wrong passphrases. Describe precisely the attacker for whom this
helps, and the attacker for whom it does nothing. Then: what would *actually* stop the second
attacker? (Consider: hardware-backed keys, WebAuthn PRF, memory-hard KDFs.)

### 8. Port the protocol (stretch)
PROTOCOL.md is transport-agnostic. Implement `SecureSession` in Kotlin with
`java.security` (ECDH/ECDSA P-256, HKDF via HMAC, AES/GCM) and make it interoperate with the JS
version over a local WebSocket. The unit tests' handshake vectors are your conformance suite.
This is the first step toward a native Android client with Wi-Fi Direct — no shared network needed.

### 9. Bug hunt (it really happened)
Internet mode passed every test, yet failed on every real phone. The browser console said:
*Connecting to 'wss://relay…' violates … "connect-src 'self' blob:"*. `index.html` allowed the relay.
Why was it still blocked, and why didn't the tests see it? Hint: count how many places a CSP can come from. Then
read `build.test.mjs` → "the CSP header and the <meta> CSP allow exactly the same things".

### 10. Threat-model question: groups
Dave and Emma are in Carol's group but have never met. Emma sees "Dave (via group): send me the code".
Who could have written that message? What would Emma have to do to be sure it was Dave?
(Answer: Carol, or Dave. Only Carol's forwarding links them. Emma should pair with Dave and compare safety numbers.)

### 11. Implement: per-member delivery details
Group bubbles show `✓ 1/2`. Add a tap-to-see list of who has received the message (`m.acks` already holds the ids).

## Exercise 12 — calls and trust
1. A call's media is encrypted with keys negotiated by DTLS. Why would the call be wide open to the
   relay if the SDP (which carries the DTLS fingerprint) travelled unauthenticated? Find the line
   in `core/call.js` that sends the SDP, and trace which encryption protects it.
2. "Hide my IP" uses `iceTransportPolicy: 'relay'`. Why must the **answering** phone also use it?
   (Hint: peer-reflexive candidates.) Find where the app fetches ICE servers before accepting.
3. Threat-model it: what can Cloudflare TURN learn about a call, and what can't it?

## Exercise 13 — replies, forwards and receipts
1. Open `core/meta.js` → `resolveQuote()`. Write down an attack that would work if the quote were
   drawn from the sender's preview `t` instead of your own copy. Then find the unit test that
   proves it can't happen.
2. Why is `re.by` a contact id and not "me"/"you"? (Hint: draw a 3-person group and ask what "you"
   means on each phone.)
3. Read receipts are reciprocal. Argue both sides: what does reciprocity protect, and what does it
   cost someone who just wants privacy for themselves?
4. Debugging task: a message shows grey ✓✓ forever even though the other phone opened the chat.
   List three places in the code you'd look, in order (hint: `confirmReads`, `receiptsOn`, the
   `read` case in `onAppMessage`).

## Exercise 14 — status, looks and "code that was never run"
1. Open `core/status.js` → `readStatus`. Why is a status dated 10 minutes in the future refused,
   when a message dated in the future is fine? (Hint: what decides when it disappears?)
2. "Seen by" is reciprocal, like read receipts. Trace a `status-seen` from the viewer's phone to
   the author's: find the two places `receiptsOn` is checked, and say what each one protects.
3. Debugging task: a feature works over the relay but not nearby. Using `app-types.test.mjs` as a
   hint, name the most likely cause and the one line you'd check first.
4. Put a bug back on purpose: delete `.tabbar` from `app.css` and run `npm test`. Read the failure.
   Then write down one other class of mistake a test like this could catch for you.

## Exercise 15 — "sent" vs "received"
1. In `core/status.js`, read `needsSend`. Why does the receiver confirm *duplicates* too? Describe the
   exact sequence of lost messages that would make the author re-send forever if it didn't.
2. Find one other place in Murmur where the sender decides something is "done" on its own. Is it a
   problem there? (Hint: message ticks — what does ✓ mean versus ✓✓?)
3. Threat model: the relay can't read statuses, but it can count envelopes. What can it learn from a
   re-send every 5 minutes, and why does the 24-hour expiry bound that?

## Exercise 16 — one account, two phones
1. In `core/devices.js`, `deviceState` orders rows by the relay's order, not by `at`. Write the
   attack (or the honest accident) that ordering by timestamps would allow. Which unit test covers it?
2. Why is this phone's id kept in `localStorage` and not in the vault? What would break on a phone
   restored from a backup if it were in the vault?
3. `accountMovedHere` used to reuse any answer younger than 5 s. Draw the timeline that lost a
   message (old phone checks → new phone takes over → message arrives). Then explain why "a check
   that started after the message" is the right rule.
4. Threat model: someone knows your username and passphrase and runs a *modified* Murmur that
   ignores sign-outs. What does the device list still give you? What would it take to really lock
   them out (hint: what do they hold that a new passphrase doesn't change)?
5. Debugging drill: the browser e2e suite takes ~8 minutes. How did we prove the new device test
   would catch the bug, without waiting for a real user to lose a message?

## Exercise 17 — PINs, rate limits and impostors
1. Compute it: a 6-digit PIN mixed only into the key (no relay counter), PBKDF2 100k rounds, an attacker
   who knows your passphrase and does 20,000 guesses/s on a GPU. How long to try all 10⁶? Now with the
   relay's schedule (`pinWait`). Which one did we build, and why does the order "gate, then upload" matter?
2. Why does the PIN change the **key** but not the **mailbox address**? What would break if it changed both?
3. The relay never wipes after wrong PINs. Write down who could abuse a wipe, and what they'd need to know.
4. `riskyAsk` is a word list. Write three scam messages that slip past it, then decide: add patterns, or
   accept it as a nudge? (Hint: what is the real check, and where does the app send you for it?)
5. Threat model: your contacts list has "Ada" and a stranger joins as "Ade". Why does Murmur not flag it,
   but flags "Adaeze" vs "Adaize"? What's the cost of flagging short names?

