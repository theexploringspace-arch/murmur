# Threat model

Honest about both halves: what Murmur defends, and where it can't.

## Assets

1. Message and file contents
2. Identity private keys (impersonation if stolen)
3. Who talks to whom (contact list, metadata)
4. Stored history (if the user enables it)

## Adversaries and outcomes

| # | Adversary | Can they… | Why / why not |
|---|---|---|---|
| A1 | Anyone on the same Wi-Fi (passive) | read messages? **No** | DTLS + Murmur AES-256-GCM. They **can** see that two devices exchanged traffic, roughly how much and when |
| A2 | Active attacker on the Wi-Fi (MITM) | intercept or impersonate? **No** | Endpoints are learned by scanning screens in person; codes are signed; the handshake binds identity keys **and** both DTLS fingerprints |
| A3 | Someone who relays/edits a *pasted* code | swap in their own connection? **No** — they can only offer *their own* identity | Edits break the signature. A whole substitute code carries a different key → a new contact, flagged if the name matches an existing one. Verify safety numbers when codes travel over other channels |
| A4 | Thief with the phone, app locked | read data? **Only by guessing the passphrase** | All data is AES-GCM under a key derived with PBKDF2 (600k). A **strong passphrase** is the real protection; the wipe-after-N-attempts setting only stops on-device guessing, because an attacker who copies the browser profile can guess offline |
| A5 | Thief with the phone, app **unlocked** | read what's on screen and in memory? **Yes** | Mitigations: auto-lock (default 5 min, also when backgrounded), history off by default, disappearing messages, panic wipe |
| A5b | Someone **forcing you** to unlock ("open it and show me") | see your real chats? **No, if you use the duress passcode** | It opens a decoy vault (slot B) that looks like a normal Murmur. See "Duress passcode" below for exactly what it does and doesn't hide |
| A6 | Later compromise of a device | decrypt earlier recorded traffic? **No** | Ephemeral ECDH per session + per-message hash ratchet; old keys are erased. Re-key every 100 msgs / 5 min limits exposure inside a long session |
| A7 | Malicious message content | run code in the app? **Designed out** | No `innerHTML`; Trusted Types (Chromium) makes HTML/script sinks throw; strict CSP; `href`/`src` restricted to `blob:`; strict JSON field validation; size limits |
| A8 | Malicious peer (valid contact) | crash/exhaust the app? **Bounded** | Frame ≤ 64 KiB, text ≤ 8000 chars, files ≤ 25 MiB, ≤ 4 concurrent incoming files, chunk order/size/hash enforced |
| A9 | Whoever hosts the web app | ship a backdoored version? **Yes — the core weakness of web apps** | See below |
| A10 | Compromised OS, browser or extension | anything? **Yes** | Out of scope for any app. Use a clean browser profile without extensions |
| A11 | Browser vendor background services | learn Murmur content? **No**, but the *browser* itself may contact its vendor when internet exists | Murmur makes zero requests after install (tested). For maximum privacy keep mobile data off — the app doesn't need it |

## The web-delivery problem (A9), stated plainly

A native app is signed once and reviewed by a store; a web app is re-downloadable by design.
Whoever controls the origin that served Murmur could publish modified JavaScript. Mitigations:

- **Self-host.** Deploy from your own GitHub repo; you control what's published.
- **Service worker pinning.** After install, the cached copy is used. A new build installs only as a
  new cache and activates after all Murmur tabs close.
- **Integrity at install.** The service worker verifies each file's SHA-256 against the build manifest
  and refuses to install on mismatch (protects against corrupted/partial CDN responses — not against
  an attacker who also changes `sw.js`).
- **Build fingerprint.** Settings shows a fingerprint of all files. Two people comparing fingerprints
  confirm they run identical code; it changes on any update.
- **Host injection is refused, loudly.** Some hosts rewrite HTML (Netlify's free-plan badge adds a
  same-origin `<script>` — which `script-src 'self'` and our Trusted Types policy *cannot* tell apart
  from Murmur's own code). The integrity check catches the altered `index.html`, the install fails, and
  the service worker posts `murmur-offline-error` so the app shows "Offline mode is OFF: the website
  hosting Murmur altered ./index.html". Tested in `test/e2e/run.mjs` via `serve.mjs --imitate-host-injection`.
  Residual risk: while *online and uninstalled*, the injected script still runs. Use a host that
  serves files byte-for-byte (GitHub Pages, Cloudflare Pages).
- **Updates are announced, never silent.** A new build downloads in the background and must pass the
  same per-file integrity check before it can even wait. Murmur then shows "Restart to update" with the
  *new* fingerprint; the running code changes only when the person taps it (or closes every Murmur
  window). Before this existed, phones kept running an old build for days with no hint — which is how a
  stale copy with an outdated CSP made the relay look "unreachable". The tap does not add trust (whoever
  controls the host still controls `sw.js`); it adds *visibility*: you can compare the new fingerprint
  with a friend's before restarting. Tested in `test/e2e/run.mjs` ("updates: …").
- **No dependencies, no build step** — the deployed files equal the audited source.

If your adversary can compromise your hosting, a native app (or a pinned, locally-sideloaded copy)
is the better choice.


## Internet mode (relay) — added threats

| Adversary | Can | Cannot |
|---|---|---|
| **Relay operator / Cloudflare** | See IP addresses, when you're online, your inbox address, envelope sizes (padded) and timing. Drop, delay or reorder envelopes. Refuse service. | Read messages, names or files. Forge or inject messages (AES-GCM, with the AD bound to both identities). Replay them (ratchet counters and single-use skipped keys). Read a mailbox without its secret. |
| **Network attacker** (no internet mode) | Everything the relay operator can, if TLS is broken | Same as the relay operator |
| **Whoever relays the invite link** (SMS, WhatsApp…) | Swap the invite for their own and become "Alice" to Bob | Stay hidden if Bob compares safety numbers on a call. Remote contacts are labelled **not verified** until he does. |
| **Someone who gets hold of a used invite** | Nothing. The prekey was deleted on first use, and Alice's app drops the join. | — |
| **Someone who gets hold of an unused invite** (posted publicly) | Join first | Send links or files that open without Alice's approval. They arrive as a **request**, with links and files locked until she taps Accept. |
| **Stolen, unlocked phone later** | Read messages in the vault (if history is on) | Decrypt past relay traffic captured earlier (forward secrecy) |

Metadata is the honest limit. A relay can't hide **that** two devices exchange
messages, or when. Rotating routing tags and padding reduce what can be
inferred, but only a mix network or Tor could hide it. That isn't available
to a web app.

## Scam protection (safety.js) — scope and limits
- **Catches:**
  - links that run code (`javascript:` and similar)
  - lookalike letters from other alphabets and digit swaps (`paypa1`)
  - brand names on domains that don't belong to the brand
  - `user@host` tricks, raw IP addresses, shorteners, `.zip`/`.mov` domains
  - programs disguised as photos (checked by content, not name), double extensions, hidden right-to-left characters in file names
  - Office files with macros
  - names that imitate an existing contact
- **Doesn't catch:** a brand-new phishing site with an ordinary name, or social engineering in plain text. That's why links are **never one-tap**: the real destination is always shown first, with a reminder never to type passwords after following a link.
- **No cloud lookups (e.g. Safe Browsing).** They would tell a third party what people share.

## Location, SOS, groups and media — added threats

- **Photos leaking where you live.** This is handled: EXIF GPS, camera serials and comments are stripped from JPEG/PNG/WebP, and video metadata is zeroed. It's tested on real files, and the image data stays byte-identical. What it **doesn't** cover: what's *visible* in the picture (street signs, landmarks), and file types other than JPEG/PNG/WebP/MP4/MOV/HEIC, which are sent unchanged. HEIC is converted on the device: this path is implemented but hasn't been verified on a real iPhone. iPhones usually hand Safari a JPEG anyway.
- **Location messages** are as private as any message: end-to-end encrypted. Live sharing stops on its own and stops on lock. The "Map" button warns first, because opening a map app tells that map company where the person is.
- **SOS** reaches only your Murmur contacts, and only when a path exists: nearby, or relay plus internet. Otherwise it's queued. **It can't contact emergency services and must not be relied on as the only lifeline.** The app says so on the SOS screen. A "request" contact (a stranger who used your invite) can't trigger alarms.
- **Groups.** Each member's copy is protected by their own 1:1 link, so there's no group key to steal.
  - The creator is trusted for: the member list, and the names of members you don't know.
  - Forwarded messages (labelled "(via group)") are only as authentic as the creator is honest. A malicious creator could make up such a message. Messages from people who are your own verified contacts can't be faked.
  - Removing a member stops *future* messages to them. It can't erase what they already received.
- **Host/CDN rewriting pages.** Cloudflare Web Analytics, or a free-plan badge, can be injected at the edge. Defences:
  1. Strict CSP blocks the injected script from running.
  2. The service worker refuses an altered copy, so offline mode stays off and the user is warned.
  3. `Cache-Control: no-transform` asks the CDN not to rewrite pages.
  4. `tools/site-check.mjs` proves the live site matches the build byte for byte.

## Duress passcode — what it hides and what it can't

**How it works.** Storage holds two vault slots on every install. Slot A is your real vault.
Slot B is either your decoy or, if you never set one up, a placeholder locked with a random
passphrase that was thrown away. Unlocking always derives both keys (equal work for real,
duress and wrong passphrases). Real passphrase → slot A; duress passcode → slot B; anything
else → one wrong attempt (shared counter; past the limit both slots are erased). Using the
duress passcode never counts as a wrong attempt.

**Hidden from someone looking at the screen:** which passcode you typed (same screens, same
name, same timing); that a duress passcode exists (the decoy's own Settings shows it *off*);
that the real chats were erased, if you chose that option (no message, no toast).

**Hidden from someone inspecting raw storage:** whether a decoy is set up, and whether the
erase option is on. Both cases produce the same record names (names are plaintext, so the
erase flag lives *inside* the decoy's encrypted settings; a test found and fixed an earlier
version that leaked it as a record name). Tested in `test/unit/duress.test.mjs`.

**Not hidden:**
- That Murmur *has* this feature. Every install has two slots, and this document says so.
  Someone who knows can demand "the other passcode". Only the erase option defeats that,
  because after one use there is nothing left to reveal.
- A copy of the storage taken *before* you unlock. If the erase option is off, the real vault
  is still in that copy, protected only by your passphrase's strength.
- Contacts and the relay. Your real contacts' messages keep arriving at your real relay inbox,
  where they wait unread. If the erase option is on, they expire there after 30 days.
- Size. A real vault full of history is larger than a fresh decoy. Fill the decoy with ordinary
  chats so it looks lived in.

**Safety rails:** only the real vault can set or replace the duress passcode. Inside the decoy
the same screen appears and "succeeds", but it can't touch slot A. The duress passcode must
differ from the real passphrase, and changing either passphrase to match the other is refused.

## Known limitations (by design)

- **Proximity required**: both devices on the same LAN at the same time. No store-and-forward, no mesh.
- **Networks with client isolation** (hotels, many cafés) block device-to-device traffic.
- **mDNS dependence**: browsers hide local IPs behind random `*.local` names; a network that blocks
  multicast DNS prevents those from resolving.
- **No group chats**: 1:1 sessions only (several can be open at once).
- **PBKDF2 isn't memory-hard**: it's what every browser offers natively. Prefer passphrases of 4+ random words.
- **No independent audit**. The primitives are standard; the composition (PROTOCOL.md) is ours.

## STRIDE summary

| | Threat | Primary control |
|---|---|---|
| **S**poofing | fake contact | identity keys from in-person QR, pinning, same-name warning, safety numbers |
| **T**ampering | altered codes/frames | ECDSA on codes, AES-GCM with header AAD, transcript signatures |
| **R**epudiation | — | messages are authenticated with shared symmetric keys, not signed, so a transcript doesn't prove who wrote a given message. (The handshake signatures *do* prove two identities held a session.) |
| **I**nformation disclosure | traffic, storage | DTLS + E2E, padding, encrypted vault, history off by default |
| **D**enial of service | flood, oversize | size limits, strict sequencing, session kill on anomaly |
| **E**levation of privilege | script injection | CSP `default-src 'none'`, Trusted Types, no HTML string APIs |
