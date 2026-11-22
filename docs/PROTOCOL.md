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
