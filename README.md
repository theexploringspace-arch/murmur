# Murmur

**Offline, end-to-end encrypted messaging in the browser. No servers. No accounts. No cloud.**

Two phones on the same Wi-Fi — or one phone's hotspot with mobile data switched off — scan each
other's QR codes and talk directly. Messages and files are encrypted on the sender's phone and
decrypted only on the recipient's. Nothing is relayed, logged, synced or backed up anywhere.

```
 Alice's phone                                         Bob's phone
┌──────────────┐   ① Alice shows QR (signed invite)   ┌──────────────┐
│   Murmur     │ ───────────────────────────────────▶ │   Murmur     │
│  (PWA, keys  │   ② Bob shows QR (signed reply)      │  (PWA, keys  │
│   on device) │ ◀─────────────────────────────────── │   on device) │
│              │   ③ direct WebRTC link over the LAN  │              │
│              │ ◀═══ DTLS ═╦═ Murmur E2E (AES-GCM) ═▶ │              │
└──────────────┘            ║                         └──────────────┘
                   same Wi-Fi / hotspot — no internet, no server
```

| | |
|---|---|
| **Network** | WebRTC data channel with **zero** ICE servers → only local (host) candidates; works with no internet |
| **Signaling** | None. The QR codes *are* the signaling: compact SDP + identity key, ECDSA-signed |
| **Identity** | ECDSA P-256 key pair generated on the device; private key **non-extractable** |
| **Handshake** | Ephemeral ECDH P-256, signed by identity keys, bound to both DTLS certificate fingerprints |
| **Messages** | AES-256-GCM, a fresh key per message (HMAC hash ratchet), re-key with new ECDH every 100 msgs / 5 min |
| **Metadata** | Every message padded to a fixed size bucket (256 B / 1 KB / 4 KB / 16 KB) |
| **At rest** | Passphrase → PBKDF2-SHA256 (600k) → key-encryption key → data key → everything. History **off** by default |
| **Web hardening** | Strict CSP (`default-src 'none'`), Trusted Types, no `innerHTML`, zero third-party code, zero dependencies |
| **Offline app** | Service worker caches every file after verifying its SHA-256; airplane-mode capable |

![Welcome, invite QR, chat and safety-number screens](docs/screenshots.png)

> **Status: complete and tested, not independently audited.** Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
> before trusting it with anything that could hurt someone.

---

## Quick start (your computer)

Requires **Node.js 22+**. There is nothing to `npm install` for the app itself.

```powershell
cd murmur
npm test            # 47 unit tests: crypto, protocol, attacks, QR codec, build output
npm run build       # src/ → dist/  (prints the build fingerprint)
npm run serve       # http://localhost:8080
```

Open two **different** browser profiles (e.g. a normal and a private window) at
`http://localhost:8080`, create an identity in each, then *Show my code* in one and
*Scan a code* → *Paste code instead* in the other. The text code button is *Show as text*.

### Browser end-to-end tests (optional)

```powershell
npm i -D playwright
npx playwright install chromium
npm run test:e2e
```

Two isolated Chromium profiles onboard, pair, chat (including a 150-message burst across
re-keys), send files, lock/unlock, reload with the network **offline** from the service worker,
reconnect while **every HTTP request is blocked**, verify CSP/Trusted Types, and panic-wipe.
A second test feeds each "phone" the other's QR through Chrome's fake camera, so the real
scanning path is exercised. The camera test needs `python3` with `opencv-python` and `numpy`;
without them it is skipped.

---

## Put it on your phones

A web app has to be **downloaded once over HTTPS** (browsers only allow the camera and offline
install on secure origins). After that first load it runs with no network at all.

1. Push this folder to a GitHub repository.
2. In the repository: **Settings → Pages → Source: GitHub Actions**. The included workflow
   (`.github/workflows/pages.yml`) runs the tests, builds `dist/` and publishes it.
3. On each phone, open `https://<you>.github.io/<repo>/` once while online, then:
   - **iPhone (Safari):** Share → *Add to Home Screen*
   - **Android (Chrome):** ⋮ → *Install app* / *Add to Home screen*
4. Open it from the home screen. Settings shows "Installed — works with no network".

### Second host (recommended): Netlify

Some networks can't reach GitHub Pages' servers (`185.199.108–111.153`) at all — the page just
stalls. Publishing to a second provider gives friends a backup install link:

1. app.netlify.com → sign in with GitHub → import this repository.
2. **Build command:** `node tools/build.mjs` · **Publish directory:** `dist`
3. Deploy. `_headers` applies Murmur's security headers there automatically.

Both hosts serve byte-identical code — compare the **build fingerprint** in Settings.
Test whether a network can reach a host first: `curl.exe -4 -I --max-time 15 https://<site>`

### Using it with no internet

1. One person turns on their **phone hotspot** (mobile data can be **off**), the other joins it.
   Any shared Wi-Fi works too — *except* networks with "client isolation" (many hotels, cafés).
2. Alice: **Show my code**. Bob: **Scan a code** → point at Alice's screen.
3. Bob's phone now shows a reply code. Alice: **Scan with camera** → point at Bob's screen.
4. Connected 🔒. Compare the **safety number** (contact ⓘ) if you want to be thorough.

Each new session needs this exchange again. That's inherent to having no server: there is no
one to tell Alice's phone where Bob's phone is. Contacts are remembered, so a reconnect simply
recognises them (and refuses a code from a *different* key claiming to be them).

---

## Project layout

```
murmur/
├── src/                      ← the app, exactly as served (no bundler, no minifier)
│   ├── index.html            CSP + Trusted Types policy declaration
│   ├── sw.template.js        offline engine (build injects file hashes)
│   ├── css/app.css
│   └── js/
│       ├── app.js            UI controller & views
│       ├── core/             ← security-critical, UI-free, unit-tested in Node
│       │   ├── bytes.js        encoders (base64url, base45), binary reader/writer
│       │   ├── crypto.js       WebCrypto wrappers — no home-made primitives
│       │   ├── vault.js        passphrase → KEK → DEK → encrypted records
│       │   ├── storage.js      IndexedDB / in-memory stores
│       │   ├── identity.js     contact ids, 60-digit safety numbers
│       │   ├── sdp.js          SDP ⇄ ~70-byte compact form
│       │   ├── pairing.js      signed invite/reply codes
│       │   ├── session.js      handshake, ratchet, padding, re-key
│       │   ├── transport.js    serverless WebRTC data channel
│       │   └── conversation.js ties it together; text, typing, files
│       ├── qr/               ← QR encoder + camera decoder, written from the spec
│       │   ├── rs.js           Reed–Solomon over GF(256)
│       │   ├── qr.js           symbol structure (versions 1–40, masks, layout)
│       │   ├── encode.js       text → modules
│       │   ├── decode.js       camera frame → text (finder/alignment/homography/RS)
│       │   ├── worker.js       decoder off the main thread
│       │   └── scanner.js      camera loop; native BarcodeDetector when present
│       └── ui/               dom.js (safe element builder), trusted.js (TT policy)
├── tools/build.mjs           dist/ + SHA256SUMS + build fingerprint + sw.js
├── tools/serve.mjs           zero-dependency static server with security headers
├── test/unit/                node --test (no dependencies)
├── test/e2e/run.mjs          Playwright, two browsers, network guard, fake camera
└── docs/                     PROTOCOL · ARCHITECTURE · THREAT-MODEL · LEARNING
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces talk, why this design, what fails and how to debug it
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — byte-level specification of codes, handshake, frames, re-key
- **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)** — what Murmur defends against, and what it honestly can't
- **[docs/LEARNING.md](docs/LEARNING.md)** — guided tour + exercises (debugging, attacking, extending)

## Verified vs. not yet verified

| Verified here (automated) | Needs real-device testing |
|---|---|
| Crypto, handshake, ratchet, re-key under load, every tamper/replay/impostor case | iOS Safari and Firefox (SDP rebuild was verified against Chromium) |
| QR encoder ⇄ OpenCV in both directions; decoder under rotation, keystone, blur, noise | Phone cameras in poor light; very old phones' decode speed |
| Two-browser pairing, chat, files, offline reload, zero HTTP during use (Chromium) | Phone hotspots that block multicast DNS (`.local` candidates) |
| CSP + Trusted Types enforcement; data-at-rest is ciphertext | GitHub Pages workflow (action versions checked Nov 2026; not run from here) |

## License

MIT — see [LICENSE](LICENSE).
