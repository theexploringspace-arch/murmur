// media.js — remove hidden personal data from photos and videos BEFORE they are sent.
//
// A phone photo usually carries EXIF data: GPS position (often to within a few
// metres of your home), the exact time, phone make/model/serial and editing
// software. Videos carry the same in QuickTime metadata. Sending that is
// a classic way people get located. Murmur strips it by default.
//
// HOW (byte-level, no re-encoding, so quality is untouched):
//   JPEG  drop APP1 (EXIF/XMP), APP3–APP15, APP13 (IPTC), COM and the APP2 MPF
//         (embedded extra images). Keep JFIF, Adobe and the ICC colour profile.
//         Re-add a tiny EXIF containing ONLY the orientation, so photos aren't sideways.
//   PNG   drop tEXt/iTXt/zTXt (text), eXIf (EXIF) and tIME chunks.
//   WebP  drop EXIF and XMP chunks; clear their flags in VP8X; fix the RIFF size.
//   MP4/MOV  turn moov/udta, moov/meta, trak/udta, trak/meta (where GPS, dates and
//         device names live) into zero-filled "free" boxes: players skip "free", the
//         bytes are gone, and because no size changes every offset stays valid.
// Anything else is returned unchanged with stripped=false so the app can warn.

const td = new TextDecoder('latin1');
const fourcc = (b, o) => td.decode(b.subarray(o, o + 4));
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export class MediaError extends Error {}

/** @returns {{bytes: Uint8Array, stripped: boolean, removed: string[], format: string}} */
export function stripMetadata(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new MediaError('expected bytes');
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: 'jpeg', ...stripJpeg(bytes) };
    if (bytes.length > 8 && be32(bytes, 0) === 0x89504e47) return { format: 'png', ...stripPng(bytes) };
    if (fourcc(bytes, 0) === 'RIFF' && fourcc(bytes, 8) === 'WEBP') return { format: 'webp', ...stripWebp(bytes) };
    if (fourcc(bytes, 4) === 'ftyp' && !/^(heic|heix|mif1|msf1|avif)/.test(fourcc(bytes, 8))) return { format: 'mp4', ...stripMp4(bytes) };
  } catch (e) {
    // Malformed file: never send half-cleaned data silently.
    throw new MediaError(`could not read this file safely (${e.message})`);
  }
  return { format: 'other', bytes, stripped: false, removed: [] };
}

// ------------------------------------------------------------------ JPEG
function jpegOrientation(app1) {
  // app1 = segment payload after the length: "Exif\0\0" + TIFF
  if (td.decode(app1.subarray(0, 6)) !== 'Exif\0\0') return 1;
  const t = app1.subarray(6);
  const le = t[0] === 0x49; // "II" little-endian, "MM" big-endian
  const u16 = (o) => (le ? t[o] | (t[o + 1] << 8) : be16(t, o));
  const u32 = (o) => (le ? le32(t, o) : be32(t, o));
  const ifd = u32(4);
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}
function minimalExif(orientation) {
  // "Exif\0\0" + big-endian TIFF with a single IFD0 entry: Orientation (SHORT) = n
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const payload = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 255, ...payload]);
}
function stripJpeg(b) {
  const out = [b.subarray(0, 2)]; const removed = []; let o = 2; let orientation = 1;
  while (o < b.length) {
    if (b[o] !== 0xff) throw new Error('bad marker');
    let m = b[o + 1];
    if (m === 0xff) { o++; continue; }                       // fill byte
    if (m === 0xd9) { out.push(b.subarray(o)); break; }       // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(o, o + 2)); o += 2; continue; }
    const len = be16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) throw new Error('truncated segment');
    const seg = b.subarray(o, o + 2 + len), payload = b.subarray(o + 4, o + 2 + len);
    if (m === 0xda) { out.push(b.subarray(o)); break; }       // SOS: image data to the end, copied verbatim
    let drop = false;
    if (m === 0xe1) { const o2 = jpegOrientation(payload); if (o2 !== 1) orientation = o2; drop = true; removed.push(td.decode(payload.subarray(0, 4)) === 'Exif' ? 'EXIF (GPS, time, camera)' : 'XMP'); }
    else if (m === 0xe2) { if (td.decode(payload.subarray(0, 11)) !== 'ICC_PROFILE') { drop = true; removed.push('APP2 extra data'); } }
    else if (m >= 0xe3 && m <= 0xef && m !== 0xee) { drop = true; removed.push(m === 0xed ? 'IPTC' : `APP${m - 0xe0}`); }
    else if (m === 0xfe) { drop = true; removed.push('comment'); }
    if (!drop) out.push(seg);
    o += 2 + len;
  }
  if (orientation !== 1) out.splice(1, 0, minimalExif(orientation));
  return { bytes: concatAll(out), stripped: true, removed: [...new Set(removed)] };
}

// ------------------------------------------------------------------ PNG
const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
function stripPng(b) {
  const out = [b.subarray(0, 8)]; const removed = []; let o = 8;
  while (o + 12 <= b.length) {
    const len = be32(b, o), type = fourcc(b, o + 4), end = o + 12 + len;
    if (end > b.length) throw new Error('truncated chunk');
    if (PNG_DROP.has(type)) removed.push(type); else out.push(b.subarray(o, end));
    o = end;
    if (type === 'IEND') break;
  }
  return { bytes: concatAll(out), stripped: true, removed: [...new Set(removed)] };
}

// ------------------------------------------------------------------ WebP
function stripWebp(b) {
  const parts = []; const removed = []; let o = 12;
  while (o + 8 <= b.length) {
    const type = fourcc(b, o), size = le32(b, o + 4), padded = size + (size & 1), end = o + 8 + padded;
    if (o + 8 + size > b.length) throw new Error('truncated chunk');
    if (type === 'EXIF' || type === 'XMP ') removed.push(type.trim());
    else {
      const chunk = b.slice(o, Math.min(end, b.length));
      if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // clear EXIF + XMP present flags
      parts.push(chunk);
    }
    o = end;
  }
  const body = concatAll(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(new TextEncoder().encode('RIFF')); new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(new TextEncoder().encode('WEBP'), 8); out.set(body, 12);
  return { bytes: out, stripped: true, removed: [...new Set(removed)] };
}

// ------------------------------------------------------------------ MP4 / MOV
const CONTAINERS = new Set(['moov', 'trak']);
function stripMp4(src) {
  const b = src.slice(); const removed = [];
  const walk = (start, end, parent) => {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(b, o); const type = fourcc(b, o + 4); let header = 8;
      if (size === 1) { size = Number(new DataView(b.buffer, b.byteOffset + o + 8, 8).getBigUint64(0)); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) throw new Error('bad box');
      if (CONTAINERS.has(parent) && (type === 'udta' || type === 'meta')) {
        b.set([0x66, 0x72, 0x65, 0x65], o + 4); // 'free'
        b.fill(0, o + header, o + size);        // and ERASE the contents: renaming alone leaves the GPS bytes readable
        removed.push(`${parent}/${type}`);
      } else if (CONTAINERS.has(type)) walk(o + header, o + size, type);
      o += size;
    }
  };
  walk(0, b.length, '');
  return { bytes: b, stripped: true, removed: [...new Set(removed)] };
}

function concatAll(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
