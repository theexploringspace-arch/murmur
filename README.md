# Murmur

**End-to-end encrypted messaging in the browser — nearby with no internet at all, or far away through a relay that can't read anything. No accounts, no phone numbers, no cloud backups.**

Two phones on the same Wi-Fi — or one phone's hotspot with mobile data switched off — scan each
other's QR codes and talk directly. Friends who are far away join with an invite link, and their
messages wait (encrypted, unreadable) on a relay for up to 30 days until delivered.

**What you can do:** text · photos & videos with hidden GPS/camera data removed · hold-to-talk
voice clips (walkie-talkie) · share your location once or live, with distance and direction ·
emergency SOS to chosen contacts · small private groups · disappearing messages — with on-device
protection against phishing links, disguised files and impersonators.

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
| **Far away** | Double Ratchet (Signal's design) over an untrusted relay; relay stores only ciphertext, deletes on delivery, 30-day cap |
| **Media privacy** | EXIF/XMP/GPS stripped from JPEG/PNG/WebP and QuickTime metadata zeroed in MP4/MOV — byte-level, no quality loss |
| **Groups** | Pairwise fan-out over each member's own E2E link; only the creator can change membership |

![Welcome, invite QR, chat and safety-number screens](docs/screenshots.png)

> **Status: complete and tested, not independently audited.** Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
> before trusting it with anything that could hurt someone.

---

## Quick start (your computer)

Requires **Node.js 22+**. There is nothing to `npm install` for the app itself.

```powershell
cd murmur
npm test            # 166 unit tests: crypto, protocol, ratchet, relay (+TURN), duress, profiles, edits, calls, voice waveforms, replies/forwards/receipts, status, theme contrast audit, CSS coverage, scam checks, media, groups, QR, build
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

### Second host (recommended): Cloudflare Pages

Some networks can't reach GitHub Pages' servers (`185.199.108–111.153`) at all — the page just
stalls. Publish to a second provider that **serves the files unmodified**:

1. dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** →
   **Connect to Git** (or *Import an existing Git repository*) → pick this repository.
2. **Framework preset:** None · **Build command:** `node tools/build.mjs` · **Build output directory:** `dist`
3. Deploy. `_headers` applies Murmur's security headers there automatically.

Cloudflare redirects `/index.html` to `/`. The service worker therefore downloads the page from
`./` (which every host serves) and still refuses any redirect it didn't expect. The local dev
server copies Cloudflare's redirect so the offline e2e test covers it.

**Updates.** After you deploy, each phone downloads the new build in the background, checks
every file's hash, and then shows **"Restart to update"** with the new fingerprint (home screen,
lock screen and Settings → *Check for update*). Nothing changes until that tap — so two friends
can compare fingerprints first.

**Avoid hosts that inject into your pages.** Netlify's free plan adds a "Powered by Netlify"
script to every HTML page and only lets paid plans turn it off. Murmur's service worker sees
that `index.html` no longer matches its build hash and **refuses to install** — so offline
mode never turns on (Settings and a red banner say so). That refusal is the security feature
working: an injected script runs with Murmur's full permissions.

Both hosts serve byte-identical code — compare the **build fingerprint** in Settings.
Test whether a network can reach a host first: `curl.exe -4 -I --max-time 15 https://<site>`
Test whether a host alters the page: `curl.exe -s https://<site>/index.html | Select-String -Pattern "<script" -SimpleMatch`
— Murmur's own page has exactly one line with `<script`.

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

## Internet mode: friends who are far away

Nearby phones talk directly over the same Wi‑Fi or hotspot, with no server involved. For friends
somewhere else, Murmur uses a small relay that **can't read anything**:

- Messages are encrypted on the phone with the **Double Ratchet** (the design Signal uses).
- The relay stores only unreadable data. It **deletes each message once delivered**, and anything unclaimed **after 30 days**.
- If you write while offline, the message is encrypted immediately, waits on your phone, and sends itself when you're back online.
- **Invite by link:** send it by text, WhatsApp or email. It works once and expires after 7 days. Remote contacts show **not verified** until you compare safety numbers on a call.
- **Scam protection** runs on the phone:
  - links are never one-tap, and lookalike and fake-brand domains are flagged
  - files are checked by their real contents, and disguised programs are caught
  - names imitating your contacts are flagged
  - strangers who use your invite arrive as a **request**, with links and files locked

### Deploy the relay (Cloudflare, free plan)
The relay code is in `relay/`. It runs on Workers with Durable Objects (SQLite).
1. dash.cloudflare.com → **Workers & Pages** → **Create application** → **Workers** → **Import a repository** → pick this repo.
2. **Project name:** `murmur-relay`. It must match `name` in `relay/wrangler.jsonc`.
3. **Root directory** (advanced): `relay` · **Build command:** *(empty)* · **Deploy command:** `npx wrangler deploy`
4. Deploy. `wrangler.jsonc` attaches **relay.princeisgenius.com** as a custom domain and only accepts requests from `https://murmur.princeisgenius.com`.
5. Check it: `curl.exe -s https://relay.princeisgenius.com/v1/health` → `ok`

To use another domain, change `routes` and `ALLOWED_ORIGINS` in `relay/wrangler.jsonc`, and `RELAY_URL` in
`src/js/config.js` together with the relay origin in the CSP in `src/index.html`.

### Calls: switch on the TURN relay (recommended)
Calls connect phone-to-phone. On the same Wi-Fi/hotspot that always works. Across the internet,
two phones on **mobile data** often can't reach each other directly (carriers put them behind
shared addresses), and **"Hide my IP address on calls"** needs a relay in the middle. Cloudflare's
TURN service does both; the first 1,000 GB a month are free (≈ 2,000+ hours of video calls).
1. Cloudflare dashboard → search **TURN** (it's under *Realtime*) → **Create** a TURN key. Copy the
   **Token ID** and the **API token** (shown once).
2. **Workers & Pages** → **murmur-relay** → **Settings** → **Variables and Secrets** → **Add**, type **Secret**:
   `TURN_KEY_ID` = the Token ID, then `TURN_KEY_API_TOKEN` = the API token. Deploy.
3. Check: `node tools/relay-smoke.mjs https://relay.princeisgenius.com` → step 7 says **TURN ON**.

The key never leaves the relay: phones get credentials that expire after an hour, at most 20 per
minute per IP address (`ratelimits` in `wrangler.jsonc`). Without TURN, calls still work nearby and on
many networks, and Murmur *asks* before a call would reveal your IP — it never falls back silently.

Run it locally: `node relay/node/server.mjs --port 8787 --origin http://localhost:8080`, then
`node tools/build.mjs --relay http://127.0.0.1:8787` and `npm run serve`.

## Features in detail

| Feature | Nearby (no internet) | Far away (relay) | Notes |
|---|---|---|---|
| Text, receipts, disappearing | ✅ | ✅ | ✓ sent · grey ✓✓ delivered · **blue ✓✓ read**. Read receipts: Settings → *Messages* (everyone) and contact info (one person). Reciprocal like WhatsApp: off means you neither send nor see them. Groups show delivery only |
| Reply | ✅ | ✅ | **Swipe a bubble right** (or long-press → Reply, or Reply in the photo viewer). The quote shows who wrote it and a preview (photo thumbnail, “Voice message”, file name…); tap it to jump to the original. Works for text, photos, voice, files, in groups too |
| Forward | ✅ | ✅ | Long-press → Forward (or from the photo viewer) to up to **5** chats or groups. Sent as a fresh encrypted copy marked *Forwarded* (*Forwarded many times* after 5 hops) — never who it came from |
| Status (24 h) | ✅ | ✅ | **Status** tab: post a **text** update (8 backgrounds, 4 type faces) or a **photo** with caption. Contacts see a ring around your photo (teal = new); tap to view — progress bars, tap right/left to move, hold to pause, reply privately. Swipe up (or tap 👁) on yours for **Viewed by**, a sheet that slides up from the bottom — it also lists anyone it hasn't **reached yet**. Each phone **confirms** receipt; yours re-sends to anyone who hasn't confirmed (when they come online, and every 5 minutes) until it expires — so a phone that was closed, offline, or on an older Murmur still gets it. Who can see it: Settings → Privacy → *My contacts / except… / only…*. Sent end-to-end encrypted to each person, never posted anywhere; every phone deletes it after **24 hours**; deleting yours removes it from theirs. Add one from the round **camera** / **pencil** buttons |
| Launch screen & floating message bar | — | — | Opening Murmur shows its logo with **from Prince Is Genius** for under a second (plain HTML, so it paints before any script; removed after the first screen, no animation with *reduce motion*). In a chat the message bar **floats** over the wallpaper — round frosted buttons and a pill text box, messages scrolling behind it, a ⌄ button to jump to the latest |
| Chat colour & wallpaper | — | — | Settings → Appearance (all chats), or a chat's info → *Chat colour & wallpaper* (just that chat). 12 colours, each checked for readable text; 7 drawn wallpapers or **your own photo** (downscaled, metadata removed, stored encrypted on the phone); a *Dim* switch. Only you see it — nothing is sent |
| Chat screen | — | — | Fills the screen like WhatsApp: the wallpaper runs behind a frosted header and composer; how you're connected (and the disappearing-message timer, when on) shows under the contact's name; the nearby prompt is one slim line with an ✕. Disappearing messages: contact info |
| Message menu | — | — | Long-press (or right-click) a message: it lifts out over a blurred chat and a compact card of actions appears beside it — Reply, Forward, Copy, Open, Edit (time left), and Delete in red below a line. Works with the keyboard (↑/↓/Enter/Esc) and screen readers |
| Devices | — | needs internet mode | Settings → *Devices*: every phone that used your account in the last 30 days — name (rename yours), how it got the account (created, logged in, restored, moved), active / replaced / signed out, last seen. Your account is **active on one phone at a time**: log in elsewhere and the old phone stops receiving messages and says where the account went (*Use Murmur on this phone* takes it back). **Sign out** a phone you don't recognise — it erases its copy next time it's online. The list is end-to-end encrypted on the relay |
| Settings | — | — | Organised into plain sections — **Account · Devices · Appearance · Chats · Privacy · Security · Calls · Backups & new phone · Internet mode · Help & about** — each row says what's inside, and **Search settings** finds things by everyday words (“blue ticks”, “backup”, “lock”) |
| Theme | — | — | **Midnight Blue + Electric Teal** by default (#101C2C · #43E6C1), every text colour checked against WCAG AA in a unit test. **Light** and **Match my phone** in Settings → Appearance |
| Photos & videos | ✅ | ✅ (512 KiB chunks) | WhatsApp-style bubbles: just the picture with the time on its corner — no file name, size or Save button. **Tap** → full screen with what it really is (*JPEG · 199 KB · 1600×1200*, from the file's bytes, not its name) and **Reply · Forward · Save** (Save opens the share sheet → Save Image). Documents get a compact card (type badge, name, *PDF · size*). Photos go at **standard size** (longest side 1600 px) with an **Original quality** switch; hidden location/camera data removed; you preview and tap **Send** first |
| Voice messages | ✅ | ✅ | WhatsApp-style. **Hold** the mic, talk, lift; **tap once** for hands-free (⏸ stop and listen · ➤ send now · 🗑 delete); slide far away to cancel (2 min max). The listen-first step happens **inside the composer bar** — no pop-up. Bubbles show ▶, a thin WhatsApp-style waveform you can tap or drag to seek, the length, and 1× / 1.5× / 2× — no file name, size or Save button. Settings → *Voice messages* switches to instant send-on-release. Needs microphone permission |
| Voice & video calls | ✅ | ✅ | Peer-to-peer, end-to-end encrypted (DTLS-SRTP keyed through the authenticated chat). Mute, camera off, flip camera. **Hide my IP** (default on) routes internet calls through TURN. Rings only while Murmur is open on their phone. One-to-one only |
| Call permissions | ✅ | ✅ | Settings → *Calls*: allow voice / video. Contact info: block calls from one person. Their phone hides the buttons **and** yours refuses the call anyway |
| Edit & delete | ✅ | ✅ | Long-press (or right-click) a message. Edit your text for **15 min**; **delete for everyone** within **1 hour**; delete for me any time. Receivers enforce the same rules and only accept changes from the real author |
| Profile | ✅ | ✅ | Photo (256×256, re-drawn so no metadata), display name and **@username** — sent only to your contacts, encrypted. Strangers who used your invite link don't get your photo until you accept them |
| History & shared media | ✅ | ✅ | On by default for new contacts: text, **photos, voice notes, files**, locations and call logs are kept on the phone, encrypted with your passphrase (disappearing messages never). Tap the contact's photo at the top of a chat → **Media, links and docs** |
| Backup & new phone | ✅ | needs internet for online/move | Settings → *Backup & new phone*: **backup file** (sealed with your passphrase; keep it anywhere), **online backup** (opt-in, strong passphrase required; then on any phone: *I already have an account → Log in* with username + passphrase), **move to a new phone** (scan a code; the old phone erases itself). Restoring an older backup renews each secure link automatically |
| Wrong-passphrase protection | — | — | After 4 wrong tries you must wait (30 s → 1 h), like an iPhone. Erasing after N tries is **opt-in** — by default nobody can wipe your phone just by typing wrong |
| Username login | — | — | Unlock with **username + passphrase** (username optionally remembered). The username is stored only as a salted hash on the phone; there is no account server. Logging in on another phone works only through **online backup** (opt-in), and shows up in *Devices* |
| Location | ✅ | ✅ | Once, or live for 15 min / 1 h (updates every 30 s while Murmur is open). Shows distance & direction — no map server. "Map" opens your map app only after a warning |
| SOS | ✅ | ✅ (queued if no signal) | Hold 1.5 s. Sends your message + GPS to chosen contacts. **Cannot call emergency services** |
| Groups | ✅ | ✅ | Up to 20. The creator forwards text and location to members who aren't each other's contacts ("via group"); files go to your direct contacts in the group |
| Scam protection | ✅ | ✅ | Links never open in one tap; lookalike/brand-fake domains, hidden destinations and disguised files are flagged |
| Duress passcode | ✅ | ✅ | Settings → *Duress passcode*. Typed instead of your passphrase, it opens a separate, ordinary-looking Murmur (its own contacts) — never your real chats. Optional: silently erase the real chats when it's used |

### Checking a deployment
- `node tools/site-check.mjs https://murmur.princeisgenius.com` — fetches every file like a phone would and proves it's **byte-for-byte the tested build** (catches CDN/host injection), and checks the security headers.
- `node tools/relay-smoke.mjs https://relay.princeisgenius.com` — acts like a phone against the relay: health, WebSocket, mailbox login, keep-alive, delivery, deletion, and whether TURN (calls) is on.

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
| Calls in two browsers with fake camera/mic: nearby and via the relay, media both ways, mute, decline, permissions | Calls between two iPhones on mobile data (needs TURN switched on); earpiece vs. speaker can't be chosen by a web app on iPhone |
| Edit/delete, profile photo, username login, duress passcode | Real iPhone voice recording after the recorder fix (WebKit bugs 301507/234784) |
| Replies (menu, swipe, photo), forwarding to another person, read receipts on/off (global, per contact, reciprocal, over nearby and relay), photo/document bubbles and viewer — three browsers | How swipe-to-reply feels under a real thumb; share-sheet Save from the new viewer on iPhone |
| Status text + photo between three browsers (audience *only…* proven to exclude), seen-by, reply-to-status, delete propagating, 24 h expiry; theme default/light/remembered; every Settings section + search; chat colour + per-chat photo wallpaper; compact menu position, focus and keyboard | How Status, the menu and wallpapers feel on a real iPhone |

## License

MIT — see [LICENSE](LICENSE).
