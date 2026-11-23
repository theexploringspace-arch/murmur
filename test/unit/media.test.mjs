// Real files made by PIL/ffmpeg carrying GPS, camera model, comments and titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripMetadata, MediaError } from '../../src/js/core/media.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'media');
const load = (f) => new Uint8Array(readFileSync(join(dir, f)));
const has = (b, s) => Buffer.from(b).includes(Buffer.from(s));
let havePy = true; try { execFileSync('python3', ['-c', 'import PIL, numpy']); } catch { havePy = false; }
let haveProbe = true; try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { haveProbe = false; }
const tmp = mkdtempSync(join(tmpdir(), 'murmur-media-'));

for (const [file, secrets] of [
  ['photo-gps.jpg', ['SECRETMAKE', 'SECRETMODEL', 'SECRETCOMMENT']], // GPS itself is numeric: checked by decoding below
  ['photo-text.png', ['SECRETPLACE', 'SECRETAUTHOR', 'SECRETMAKE']],
  ['photo-exif.webp', ['SECRETMAKE', 'EXIF']],
  ['video-gps.mp4', ['SECRETTITLE', '06.4500']],
]) {
  test(`${file}: every hidden secret is removed`, () => {
    const src = load(file);
    for (const s of secrets) assert.ok(has(src, s), `fixture really contains ${s}`);
    const r = stripMetadata(src);
    assert.equal(r.stripped, true);
    for (const s of secrets) assert.ok(!has(r.bytes, s), `${s} removed`);
    assert.ok(r.removed.length > 0);
    assert.deepEqual(stripMetadata(r.bytes).bytes, r.bytes, 'stripping is idempotent');
  });
}

test('JPEG keeps orientation (photos are not turned sideways) and the image data is byte-identical', () => {
  const src = load('photo-gps.jpg'); const r = stripMetadata(src);
  const sos = (b) => Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]));
  assert.deepEqual(Buffer.from(r.bytes.subarray(sos(r.bytes))), Buffer.from(src.subarray(sos(src))), 'compressed pixels untouched');
  assert.ok(has(r.bytes, 'Exif'), 'minimal EXIF re-added for orientation');
});

test('stripped files still decode to identical pixels; orientation still 6', { skip: !havePy && 'python3+PIL not installed' }, () => {
  for (const f of ['photo-gps.jpg', 'photo-text.png', 'photo-exif.webp']) {
    const out = join(tmp, 'clean-' + f); writeFileSync(out, stripMetadata(load(f)).bytes);
    const res = execFileSync('python3', ['-I', '-c', `
import sys, numpy as np
from PIL import Image
a, b = Image.open(sys.argv[1]), Image.open(sys.argv[2])
same = np.array_equal(np.asarray(a.convert('RGB')), np.asarray(b.convert('RGB')))
o = b.getexif().get(0x0112); g = b.getexif().get(0x8825)
print(same, o, g)`, join(dir, f), out]).toString().trim();
    const [same, orient, gps] = res.split(' ');
    assert.equal(same, 'True', `${f} pixels identical`);
    if (f.endsWith('.jpg')) assert.equal(orient, '6', 'orientation kept');
    assert.equal(gps, 'None', `${f} has no GPS`);
  }
});

test('stripped MP4 still plays and reports no location', { skip: !haveProbe && 'ffprobe not installed' }, () => {
  const out = join(tmp, 'clean.mp4'); writeFileSync(out, stripMetadata(load('video-gps.mp4')).bytes);
  const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', out]).toString();
  assert.ok(!/location|SECRET/i.test(tags), tags);
  const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).toString().trim();
  assert.equal(frames, '10', 'all 10 frames still decode');
});

test('unknown formats pass through unchanged (app warns); malformed media is refused, not half-cleaned', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 hello');
  assert.deepEqual(stripMetadata(pdf), { format: 'other', bytes: pdf, stripped: false, removed: [] });
  const bad = load('photo-gps.jpg').slice(0, 30);
  assert.throws(() => stripMetadata(bad), MediaError);
});
