// sdp.js — squeeze a WebRTC data-channel SDP into ~70–150 bytes and back.
//
// Why: the full SDP (~700 bytes of text) makes a huge, hard-to-scan QR code.
// For a data-channel-only connection, only a handful of fields actually
// matter. We keep exactly those and rebuild a canonical SDP on the other
// side. Everything security-relevant — the DTLS certificate fingerprint —
// is carried bit-for-bit.
//
//   kept:    ice-ufrag, ice-pwd, DTLS fingerprint (sha-256), setup role,
//            host candidates (protocol, priority, address, port, tcptype)
//   dropped: session ids, extmap, msid-semantic, foundations (regenerated)

import { Writer, Reader, utf8, fromUtf8, toHex, fromHex } from './bytes.js';

const SETUP = ['actpass', 'active', 'passive'];
const MAX_CANDIDATES = 8;
const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseSdp(sdp) {
  const lines = sdp.split(/\r?\n/);
  const get = (p) => { const l = lines.find((x) => x.startsWith(p)); return l ? l.slice(p.length).trim() : null; };
  const ufrag = get('a=ice-ufrag:');
  const pwd = get('a=ice-pwd:');
  const fpLine = get('a=fingerprint:');
  const setup = get('a=setup:');
  if (!ufrag || !pwd || !fpLine || !setup) throw new Error('SDP missing ICE/DTLS fields');
  const [algo, fpHex] = fpLine.split(/\s+/);
  if (algo.toLowerCase() !== 'sha-256') throw new Error(`Unsupported fingerprint algorithm ${algo}`);
  const fingerprint = fromHex(fpHex.replace(/:/g, ''));
  if (fingerprint.length !== 32) throw new Error('bad fingerprint');
  if (!SETUP.includes(setup)) throw new Error('bad setup role');

  const candidates = [];
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    const t = l.slice(12).trim().split(/\s+/);
    // foundation component proto priority addr port "typ" type [k v]...
    if (t.length < 8 || t[6] !== 'typ') continue;
    if (t[1] !== '1' || t[7] !== 'host') continue; // data channels: rtcp-mux, host only (no servers exist)
    const proto = t[2].toLowerCase();
    if (proto !== 'udp' && proto !== 'tcp') continue;
    const c = { proto, priority: Number(t[3]) >>> 0, address: t[4], port: Number(t[5]) };
    const tt = t.indexOf('tcptype');
    if (proto === 'tcp') {
      c.tcptype = tt > 0 ? t[tt + 1] : 'passive';
      if (c.tcptype === 'active' || c.port === 9) continue; // active TCP candidates carry no listening port
    }
    candidates.push(c);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (!candidates.length) throw new Error('No host candidates — are you connected to a Wi-Fi network or hotspot?');
  return { ufrag, pwd, fingerprint, setup, candidates };
}

function writeAddr(w, a) {
  let m;
  if ((m = UUID_LOCAL.exec(a))) { w.u8(2).raw(fromHex(m.slice(1).join('').toLowerCase())); return; }
  if ((m = IPV4.exec(a))) { w.u8(0).raw(Uint8Array.from(m.slice(1).map(Number))); return; }
  if (a.includes(':')) { w.u8(1).raw(ipv6ToBytes(a)); return; }
  w.u8(3).lp8(utf8(a));
}
function readAddr(r) {
  const k = r.u8();
  if (k === 0) return [...r.raw(4)].join('.');
  if (k === 1) return bytesToIpv6(r.raw(16));
  if (k === 2) { const h = toHex(r.raw(16)); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`; }
  if (k === 3) return fromUtf8(r.lp8());
  throw new Error('bad address kind');
}

export function ipv6ToBytes(s) {
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) throw new Error('bad ipv6');
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { const v = parseInt(g, 16); out[i * 2] = v >> 8; out[i * 2 + 1] = v & 0xff; });
  return out;
}
export function bytesToIpv6(b) {
  const g = []; for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  return g.join(':');
}

export function compactSdp(sdp) {
  const p = parseSdp(sdp);
  const w = new Writer();
  w.u8(1); // codec version
  w.lp8(utf8(p.ufrag)).lp8(utf8(p.pwd)).raw(p.fingerprint).u8(SETUP.indexOf(p.setup));
  w.u8(p.candidates.length);
  for (const c of p.candidates) {
    const flags = (c.proto === 'tcp' ? 1 : 0) | (c.tcptype === 'so' ? 2 : 0);
    w.u8(flags).u32(c.priority);
    writeAddr(w, c.address);
    w.u16(c.port);
  }
  return w.done();
}

export function expandSdp(bytes, type) {
  const r = new Reader(bytes);
  if (r.u8() !== 1) throw new Error('unknown SDP codec');
  const ufrag = fromUtf8(r.lp8());
  const pwd = fromUtf8(r.lp8());
  const fingerprint = r.raw(32);
  const setup = SETUP[r.u8()];
  if (!setup) throw new Error('bad setup role');
  if (/[\s\r\n]/.test(ufrag + pwd)) throw new Error('bad ICE credentials');
  const n = r.u8();
  if (n < 1 || n > MAX_CANDIDATES) throw new Error('bad candidate count');
  const cands = [];
  for (let i = 0; i < n; i++) {
    const flags = r.u8();
    const priority = r.u32();
    const address = readAddr(r);
    const port = r.u16();
    if (/[\s\r\n]/.test(address)) throw new Error('bad address');
    const proto = flags & 1 ? 'tcp' : 'udp';
    let line = `a=candidate:${i + 1} 1 ${proto} ${priority} ${address} ${port} typ host`;
    if (proto === 'tcp') line += ` tcptype ${flags & 2 ? 'so' : 'passive'}`;
    cands.push(line);
  }
  r.end();
  const fp = [...fingerprint].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const sdp = [
    'v=0',
    `o=- ${type === 'offer' ? '1' : '2'} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...cands,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
  return { type, sdp };
}

/** The DTLS certificate fingerprint inside an SDP — bound into the handshake. */
export const sdpFingerprint = (sdp) => parseSdp(sdp).fingerprint;
