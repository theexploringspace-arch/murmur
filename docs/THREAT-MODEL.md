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
- **No dependencies, no build step** — the deployed files equal the audited source.

If your adversary can compromise your hosting, a native app (or a pinned, locally-sideloaded copy)
is the better choice.

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
