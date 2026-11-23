# Murmur Protocol v1

Byte-level specification. Integers are big-endian. `‖` is concatenation. `H(label, a, b, …)` is
`SHA-256(utf8(label) ‖ 0x00 ‖ a ‖ b ‖ …)`. All primitives are executed by the platform's WebCrypto.

| Primitive | Use |
|---|---|
| ECDSA P-256 / SHA-256, IEEE-P1363 signatures (64 B) | identity keys; signing codes and handshake |
| ECDH P-256 (raw 65-byte uncompressed points) | ephemeral key agreement |
| HKDF-SHA-256, HMAC-SHA-256 | key derivation, hash ratchet |
| AES-256-GCM, 96-bit IV, 128-bit tag | messages, vault records, key wrapping |
| PBKDF2-HMAC-SHA-256, 600 000 iterations | passphrase → key-encryption key |

## 1. Identity

Each device generates one ECDSA P-256 key pair at setup. The **public key (65 bytes) is the
identity**; display names are unauthenticated labels.

- `contactId = hex(H("murmur/fp", pub)[0..16])`
- `safetyNumber(a, b)`: sort the two public keys bytewise; for each, `h = H("murmur/safety/v1", pub)`;
  six 5-byte chunks → `uint40 mod 100000` → 5 digits each → 30 digits. Concatenate → 60 digits,
  shown in 12 groups. Identical on both phones.

## 2. Compact SDP (inside pairing codes)

Only the fields a data channel needs. `lp8` = 1-byte length + bytes.

```
u8   codec version = 1
lp8  ice-ufrag (UTF-8, no whitespace)
lp8  ice-pwd   (UTF-8, no whitespace)
32B  DTLS certificate fingerprint (SHA-256)          ← security-critical
u8   setup role: 0 actpass | 1 active | 2 passive
u8   N candidates (1..8), each:
       u8  flags: bit0 = TCP (else UDP), bit1 = tcptype so (else passive)
       u32 priority
       u8  address kind: 0 IPv4(4B) | 1 IPv6(16B) | 2 mDNS UUID(16B, "<uuid>.local") | 3 lp8 string
       ..  address
       u16 port
```

Only `typ host`, component 1 candidates are kept (there are no servers, so nothing else exists);
TCP `active` candidates are dropped (no listening port). The receiver rebuilds a canonical
data-channel SDP (`m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `a=mid:0`,
`a=sctp-port:5000`). Fields containing whitespace/newlines are rejected (SDP injection).

## 3. Pairing codes

```
u8   version = 1
u8   kind: 1 offer (invite) | 2 answer (reply)
u32  created, unix seconds
65B  identity public key
lp8  display name (UTF-8, ≤ 40 bytes, control chars stripped)
lp16 compact SDP (§2)
8B   [answer only] SHA-256(offer code bytes)[0..8]     ← binds a reply to one invite
64B  ECDSA signature over utf8("murmur/pair/v1") ‖ all preceding bytes
```

Verification order: structure → key is a valid curve point → signature → expected kind →
age ≤ 15 min and ≤ 5 min in the future → (answer) offer hash matches → SDP expands.

Text encodings: QR `"MUR1:" ‖ base45(bytes)` (RFC 9285; QR alphanumeric mode),
paste `"mur1." ‖ base64url(bytes)`. A typical invite is 232 bytes → 353 QR chars → QR version 11-M.

**What the signature does and doesn't do.** It proves the code was produced by the holder of
the enclosed key and wasn't altered. It does *not* prove who that key belongs to — that comes
from scanning the code off the person's own screen, in person (and optionally the safety number).
Contacts are keyed by public key; a known name with a new key triggers an explicit warning.

## 4. Session handshake

Runs inside the WebRTC data channel (`negotiated: true, id: 0, ordered, reliable`), after DTLS.

```
Both sides, immediately:   HELLO = 0x01 ‖ 0x01(version) ‖ eph_pub(65) ‖ nonce(32)

T = H("murmur/hs/v1",
      id_offerer, id_answerer,
      dtls_fp_offerer, dtls_fp_answerer,      ← from the two SDPs exchanged by QR
      eph_offerer, eph_answerer,
      nonce_offerer, nonce_answerer)

On receiving peer HELLO:   AUTH  = 0x02 ‖ Sign(id_priv, "murmur/auth/v1" ‖ role ‖ T)
                           role = 0x01 offerer | 0x02 answerer

On receiving peer AUTH:    verify with the identity key from the peer's pairing code
                           ss  = ECDH(eph_priv, eph_peer)          (eph_priv then discarded)
                           okm = HKDF(ikm=ss, salt=T, info="murmur/keys/v1", L=96)
                           root = okm[0..32]
                           ck_o→a = okm[32..64], ck_a→o = okm[64..96]
```

Properties:
- **Mutual authentication**: each side signs a transcript containing both fresh ephemerals and nonces.
- **Channel binding**: both DTLS fingerprints are in `T`. A relay that terminates DTLS with its own
  certificate produces a different `T` → signature verification fails.
- **Forward secrecy**: ephemeral private keys are non-extractable and dropped after `ss` is derived.
- **Role signing** prevents reflecting a party's own AUTH back to it.
- Ephemeral points are imported through WebCrypto, which rejects off-curve points.

## 5. Data frames and ratchet

```
DATA   = 0x03 ‖ epoch(u8) ‖ seq(u32) ‖ AES-256-GCM(key, iv, pad(utf8(JSON)), aad = first 6 bytes)

KDF_CK(ck):  mk = HMAC(ck, 0x01);  ck' = HMAC(ck, 0x02);  ck is zeroed
msg keys:    okm = HKDF(mk, salt=0³², info="murmur/msg/v1", 44) → key = okm[0..32], iv = okm[32..44]
```

- Each direction has its own chain; `seq` starts at 0 per epoch and must arrive **exactly** in order
  (the channel is ordered and reliable, so any gap, replay or reorder is an attack → session killed).
- `pad`: `u32 length ‖ data ‖ zeros` to the smallest of 256 / 1024 / 4096 / 16384 B, else a multiple of 16384.
- Max frame accepted: 64 KiB.

### Re-key (DH ratchet step)

Initiated **only by the offerer** (removes simultaneous-initiation races), after 100 messages or
5 minutes:

```
offerer:  new eph E_o; send {t:"rekey", eph:E_o} under the current chain; then PAUSE sending
answerer: on rekey → new eph E_a; derive next epoch; switch RECEIVE chain;
          send {t:"rekey-ack", eph:E_a} under the OLD send chain; then switch SEND chain
offerer:  on rekey-ack → derive next epoch; switch both chains; resume sending

epoch' = epoch + 1 (mod 256)
okm    = HKDF(ikm = ECDH(E_mine, E_peer), salt = root, info = "murmur/rekey/v1" ‖ epoch', L = 96)
         → new root ‖ ck_o→a ‖ ck_a→o        (old root zeroed)
```

Ordering argument: the offerer sends nothing between `rekey` and `rekey-ack`, so everything the
answerer receives after `rekey` is new-epoch. The answerer's `rekey-ack` is its last old-epoch
frame, so everything the offerer receives after it is new-epoch. Tested with interleaved
bidirectional bursts (`test/unit/core.test.mjs`, 150-message E2E burst).

## 6. Application messages (JSON inside DATA)

| `t` | fields | notes |
|---|---|---|
| `hello` | `name`, `app` | first message each way |
| `msg` | `id`, `ts`, `text` (≤ 8000), `ttl` (s) | receiver replies `ack` |
| `ack` | `id` | delivery receipt (✓✓) |
| `typing` | `on` | |
| `file` | `id`, `ts`, `name`, `mime`, `size` (≤ 25 MiB), `sha` (b64url SHA-256), `chunks`, `ttl` | then `chunks` × `chunk` |
| `chunk` | `id`, `i`, `d` (b64url, 8 KiB raw) | strictly sequential; size & hash verified |
| `rekey`, `rekey-ack` | `eph` | session-internal (§5) |
| `bye` | | graceful close |

Unknown `t` values are ignored (forward compatibility). `ttl > 0` → both sides delete the message
`ttl` seconds after it was sent/received; such messages are never written to storage.

## 7. Vault (storage at rest)

```
salt(16) random;  KEK = PBKDF2-SHA256(NFKC(passphrase), salt, 600000) → AES-256-GCM, non-extractable
DEK  = random AES-256 key, stored wrapped:  AES-GCM(KEK, iv, raw DEK, aad="murmur/v1/dek")
IDK  = identity private key, stored wrapped: AES-GCM(DEK, iv, PKCS#8, aad="murmur/v1/identity")
record r = AES-GCM(DEK, iv, utf8(JSON), aad="murmur/v1/rec/<name>")     (AAD stops record swapping)
```

Unwrapped DEK and IDK are **non-extractable** `CryptoKey`s. A wrong passphrase is detected by the
GCM tag on the DEK. An optional failure counter wipes the store after N failures (see threat model
for why this is a speed bump, not a wall).

## 8. Internet mode (relay) — `ratchet.js`, `invite.js`, `remote.js`, `relay/`

Live sessions (§4–5) need both phones online at once. Internet mode adds an
**asynchronous** channel through an untrusted relay, so a message can be
written now and read days later.

### 8.1 Mailboxes
- Each phone has a random 32-byte **inbox secret** (vault record `remote`).
- **Address** = `SHA-256("murmur/inbox/v1" ‖ 0x00 ‖ secret)`, sent to contacts.
- Relay API (`relay/src/router.js`):
  - `POST /v1/inbox/<address>`: deposit opaque bytes (≤ 1 MiB). Anyone with the address can do this.
  - `GET /v1/inbox/<address>` (WebSocket): the owner sends `{"t":"auth","secret":…}`. The relay checks it against the address, then streams `id(16) ‖ data` frames and `{"t":"synced"}`. The client sends `{"t":"ack","ids":[…]}`, and the relay **deletes** those rows.
  - `ping`/`pong` text frames are used for liveness.
- Rows unclaimed for **30 days** are deleted by a Durable Object alarm.

### 8.2 Invites (remote first contact)
```
invite = v=1 ‖ kind=3 ‖ created u32 ‖ expires u32 ‖ inviteId[16] ‖ lp8(name)
         ‖ identityPub[65] ‖ prekeyPub[65] ‖ inbox[32] ‖ sig[64]
sig    = ECDSA_identity("murmur/invite/v1" ‖ body)      expires = created + 7 days
link   = <app origin>/#i=<base64url(invite)>             (fragment: never sent to any server)
```
The joiner (Bob) works out the shared key and builds the join message:
```
SK      = HKDF(ECDH(bobEph, alicePrekey), salt=H(invite), "murmur/x3dh/v1", 32)
joinKey = HKDF(…, "murmur/join/key/v1", 44)                  (key ‖ iv, used once)
join    = 1 ‖ 4 ‖ inviteId ‖ bobEphPub ‖ AES-GCM(joinKey, body, AAD = those 83 bytes)
body    = lp8(name) ‖ identityPub ‖ inbox ‖ created ‖ ECDSA_bob("murmur/join/v1" ‖ H(invite) ‖ ephPub ‖ identityPub ‖ inbox ‖ name ‖ 0 ‖ created)
```
- **The prekey is single use.** Alice deletes it after the first valid join, so a replayed or leaked invite gets no answer.
- **Swapping the invite isn't prevented by cryptography.** Someone who replaces the invite in transit gets a different identity key. Safety-number comparison catches this, which is why remote contacts start **unverified**.

### 8.3 Double Ratchet
This follows Signal's specification, using P-256 ECDH, HKDF-SHA-256, HMAC chain keys and AES-256-GCM.
```
KDF_RK(rk, dh) = HKDF(dh, salt=rk, "murmur/dr/rk/v1", 64) → (rk', ck)
KDF_CK(ck)     = (HMAC(ck, 0x02), HMAC(ck, 0x01))         → (ck', mk)
key ‖ iv       = HKDF(mk, 0³², "murmur/dr/mk/v1", 44)
header         = 1 ‖ dhPub[65] ‖ pn u32 ‖ n u32
wire           = header ‖ AES-GCM(key, iv, pad(plaintext), AAD = AD ‖ header)
AD             = "murmur/dr/ad/v1" ‖ inviterIdentity ‖ joinerIdentity
```
- Skipped keys are kept for late or reordered messages: at most 1000 per chain and 2000 in total.
- Decryption is **transactional**: the state only changes if authentication succeeds.
- Ratchet state is stored in the vault (`remote/peers`). It is **saved before the message is posted**, and **acknowledged only after it is saved**.

### 8.4 Envelope
```
envelope = 1 ‖ kind=5 ‖ day u32 ‖ tag[16] ‖ wire
tag      = SHA-256("murmur/route/v1" ‖ 0 ‖ senderIdentity ‖ recipientIdentity ‖ day)[0..16]
```
The tag lets the recipient find the right ratchet without trying each contact. It changes every day, and the relay can't link it to identities it never sees.

### 8.5 Face-to-face bootstrap
When a live session (§4) connects:
- If one side has no internet link yet, the inviter sends `r-invite` (an invite with a 15-minute lifetime) inside the **authenticated live session**. The answerer replies `r-join {join, first ratchet message}`.
- Both sides check the identity in the bundle against the live peer's key, so the result is **verified**.
- If one side lacks the link, it asks with `r-need`.
- An existing link is never re-keyed this way, because that would strand messages already waiting on the relay.

### 8.6 App messages over the relay
These are the same JSON types as §6 (`hello`, `msg`, `ack`, `file`, `chunk`). Over the relay, file chunks are 192 KiB.

## 9. Location, SOS and groups (app messages, live or relay)

These are carried exactly like `msg`. They go over the live session when one is connected, and otherwise over the relay. Unknown types are ignored, for forward compatibility.

| Type | Fields | Receiver checks |
|---|---|---|
| `loc` | `id, ts, lat, lon, acc, [lid, until], [gid], [fwd]` | finite, \|lat\| ≤ 90, \|lon\| ≤ 180, acc ≥ 0; a live update with a known `lid` replaces the earlier card; acks |
| `sos` | `id, ts, text ≤ 500, [loc]` | ignored from unaccepted ("request") contacts; shows an alarm; acks |
| `ginv` | `gid(32 hex), name, admin, members[{cid,name}] (2–20), v` | sender must be `admin`; the admin can never change; `v` must increase (no replay); a removed member sees "no longer in this group" |
| `gmsg` | `gid, id, ts, text, [fwd]` | sender must be a member. If `fwd` is set, the sender must be the admin and `fwd` a member. The admin forwards non-forwarded messages to the other members |
| `gleave` | `gid, id` | sender must be a member; the admin publishes a new roster |
| `file` meta | `+ gid?, kind?='voice'` | group files must come from members; voice clips are shown as audio only if the content sniffs as audio/video |

Group delivery is **pairwise fan-out**: each copy is encrypted separately over that member's 1:1 link. There is no group key and no group server.

## 10. Media sanitising (`media.js`), applied before sending

| Format | Removed | Kept |
|---|---|---|
| JPEG | APP1 (EXIF and XMP), APP2 except ICC, APP3–APP15 (incl. APP13 IPTC), COM | JFIF, Adobe APP14, ICC, all image data (byte-identical); a minimal EXIF with **only Orientation** is re-added |
| PNG | tEXt, iTXt, zTXt, eXIf, tIME | everything else |
| WebP | EXIF, XMP chunks; their VP8X flags are cleared; RIFF size is fixed | everything else |
| MP4/MOV | `moov/udta`, `moov/meta`, `trak/udta`, `trak/meta` → zero-filled `free` boxes (same size, so all offsets stay valid) | all media |
| HEIC (in the browser) | re-drawn to JPEG, which drops everything | pixels |

A damaged file throws `MediaError` and isn't sent: it's never half-cleaned.

## 11. Edits, profiles and calls (app messages, live or relay)

Same transport as §9. Unknown fields are ignored.

| Type | Fields | Receiver checks (`edits.js`, `profile.js`, `call.js`) |
|---|---|---|
| `edit` | `ref, text ≤ 8000, ts, [gid], [fwd]` | `ref` is a message **we received** from that sender (in groups: from the real author, never the forwarder). Text messages only; not deleted; age ≤ 15 min + 5 min clock grace. Shown "edited" |
| `del` | `ref, ts, [gid], [fwd]` | same author rule; age ≤ 60 min + 5 min grace. Content wiped (files' blob URLs revoked); "This message was deleted" remains |
| `profile` | `v, name ≤ 60, [user], [pic], calls{voice,video}` | `v` must not go backwards; `user` matches `^[a-z0-9][a-z0-9_.]{2,19}$`; `pic` is base64url of a **JPEG** (magic bytes checked) ≤ 36 KB (fits one 64 KiB nearby frame); bidi-override characters stripped from `name`. Each contact gets its own version (`calls` is false for a blocked contact); re-sent when it changes or when the contact becomes reachable; never sent to unaccepted invite-link contacts |
| `call` | `id(16–32 hex), k ∈ {offer, answer, end, decline, busy, unavailable}, [sdp], [video]` | `sdp` starts with `v=0`, ≤ 40 000 chars. An `offer` rings only if `callDecision()` says so (receiver's settings + per-contact block + not a stranger + not busy); otherwise answered `unavailable`/`busy` |

**Calls.** Non-trickle ICE: each side gathers for ≤ 3 s, then sends one SDP. The SDP's DTLS
fingerprint is authenticated by the ratchet, so the media (DTLS-SRTP) is end-to-end between the
two phones even through TURN. ICE servers come from `GET /v1/turn` on the relay
(`{ iceServers, turn }`): Cloudflare STUN always, TURN credentials (TTL 1 h, port-53 URLs removed)
when the relay holds a TURN key. "Hide my IP" sets `iceTransportPolicy: 'relay'` on internet
calls (never nearby). If TURN is unavailable the person is asked before a direct call. Glare (both
call at once): the phone with the smaller contact id keeps its call. Ring timeout 45 s; a dropped
connection gets 10 s to recover.

**Relay chunks** are now 512 KiB of file bytes per message (≈ 700 KB envelope, under the relay's
1 MiB limit); receivers still accept 192 KiB chunks from older senders.

## 12. Local login and the second vault slot

`login` (shared store key, outside both vault slots): `{ salt, h = SHA-256(salt ‖ username) , [user] }`.
`user` (plain) exists only if "remember my username" is on. A wrong username counts as one wrong
attempt on the shared counter, exactly like a wrong passphrase. Slot B (`b:` keys) is the duress
decoy or an unopenable placeholder — see THREAT-MODEL "Duress passcode".
