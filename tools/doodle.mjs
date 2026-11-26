// doodle.mjs — draws Murmur's default chat wallpaper: a seamless tile of thin line doodles built from
// Murmur's own symbols (the logo's shield + sound waves, whispers, locks, keys, signal arcs…).
// Original drawings — nothing traced from another app. Deterministic (seeded), so re-running gives the
// same files:   node tools/doodle.mjs      → src/img/doodle-dark.svg, src/img/doodle-light.svg
//
// HOW IT TILES: icons are scattered with a minimum spacing measured on a torus (distance wraps around
// the edges), and any icon near an edge is ALSO drawn shifted by ±W/±H — so the right edge continues
// the left edge exactly, and the repeat is invisible.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 420, H = 420;

// 24×24 line icons (stroke only). `logo` ones are drawn in the accent colour.
const ICONS = {
  shield: { logo: true, d: 'M12 2.5l7 2.6v5.5c0 4.8-3.2 8-7 9.9-3.8-1.9-7-5.1-7-9.9V5.1zM9 10q1.5-1.7 3 0t3 0M9 13.4q1.5-1.7 3 0t3 0' },
  bubble: { d: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v8a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V16h-2A1.5 1.5 0 0 1 3 14.5v-8A1.5 1.5 0 0 1 4.5 5zM8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01' },
  whisper: { d: 'M5 6h11a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3h-5l-4 3v-3H5zM8.5 10.5q1.2-1.4 2.4 0t2.4 0' },
  lock: { d: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2.5' },
  key: { d: 'M8 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10.8 12.2L19 4M15.5 7.5l2 2M13.5 9.5l1.5 1.5' },
  bars: { d: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2' },
  plane: { d: 'M3 11l18-7-6 17-3.2-7.2zM11.8 13.8L21 4' },
  moon: { d: 'M19.5 14.5A8 8 0 1 1 9.5 4.5a6.4 6.4 0 0 0 10 10z' },
  star: { d: 'M12 3.5c.8 4.4 4.1 7.7 8.5 8.5-4.4.8-7.7 4.1-8.5 8.5-.8-4.4-4.1-7.7-8.5-8.5 4.4-.8 7.7-4.1 8.5-8.5z' },
  heart: { d: 'M12 19.5s-7-4.3-7-9.7A3.9 3.9 0 0 1 12 7.4a3.9 3.9 0 0 1 7 2.4c0 5.4-7 9.7-7 9.7z' },
  qr: { d: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1zM14 14h2.2v2.2H14zM17.8 17.8H20V20h-2.2zM18 14h2M14 18v2' },
  hotspot: { d: 'M2.5 9.5a14 14 0 0 1 19 0M5.5 13a9.5 9.5 0 0 1 13 0M8.6 16.4a5 5 0 0 1 6.8 0M12 19.6h.01' },
  mic: { d: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V20M9 20h6' },
  envelope: { d: 'M3.5 6h17v12h-17zM3.5 6.5l8.5 6.5 8.5-6.5' },
  eyeoff: { d: 'M3 12s3.3-5.5 9-5.5 9 5.5 9 5.5-3.3 5.5-9 5.5S3 12 3 12zM12 9.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM4.5 4.5l15 15' },
  pin: { d: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zM12 7.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z' },
  camera: { d: 'M4 8.5h3.2l1.8-2.5h6l1.8 2.5H20V19H4zM12 10.5a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z' },
  wave: { d: 'M2 12c1.7-5 3.3 5 5 0s3.3 5 5 0 3.3 5 5 0 3.3 5 5 0' },
  clock: { d: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2' },
  phone: { d: 'M6 3.5h3l1.8 4.6-2.3 1.4a10.5 10.5 0 0 0 6 6l1.4-2.3 4.6 1.8v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4 5.5a2 2 0 0 1 2-2z' },
};
const FILLERS = {
  dot: 'M12 12h.01',
  plus: 'M12 8v8M8 12h8',
  ring: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  tick: 'M8 12.5l2.5 2.5L16 9.5',
  arc: 'M7 14a5 5 0 0 1 10 0',
};

// Small seeded PRNG (mulberry32): same seed → same wallpaper, so the build is reproducible.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Distance on the torus (wrapping both edges) — what makes the spacing seamless. */
function tdist(a, b) { const dx = Math.min(Math.abs(a.x - b.x), W - Math.abs(a.x - b.x)); const dy = Math.min(Math.abs(a.y - b.y), H - Math.abs(a.y - b.y)); return Math.hypot(dx, dy); }

export function layout(seed = 20261126) {
  const r = rng(seed), placed = [];
  const names = Object.keys(ICONS);
  // Big doodles: dart-throwing with a minimum gap; cycle through the icon list so each appears ~evenly.
  let i = 0;
  for (let tries = 0; tries < 20000 && placed.length < 72; tries++) {
    const size = 30 + r() * 14;
    const p = { x: r() * W, y: r() * H, size, rad: size * 0.62 };
    if (placed.some((q) => tdist(p, q) < p.rad + q.rad + 3)) continue;
    p.name = names[i++ % names.length]; p.rot = (r() - 0.5) * 50; p.kind = 'icon';
    placed.push(p);
  }
  // Fillers in the gaps, like the confetti between WhatsApp-style doodles — small and sparse.
  const fnames = Object.keys(FILLERS);
  for (let tries = 0; tries < 20000 && placed.length < 190; tries++) {
    const size = 9 + r() * 5;
    const p = { x: r() * W, y: r() * H, size, rad: size * 0.6 };
    if (placed.some((q) => tdist(p, q) < p.rad + q.rad + 3)) continue;
    p.name = fnames[Math.floor(r() * fnames.length)]; p.rot = r() * 360; p.kind = 'filler';
    placed.push(p);
  }
  return placed;
}

export function svg(placed, { ink, logoInk, inkOpacity, logoOpacity }) {
  const uses = [];
  for (const p of placed) {
    const d = p.kind === 'icon' ? ICONS[p.name].d : FILLERS[p.name];
    const logo = p.kind === 'icon' && ICONS[p.name].logo;
    // Draw it again across any edge it touches, so the tile wraps without a seam.
    for (const ox of [0, -W, W]) for (const oy of [0, -H, H]) {
      const x = p.x + ox, y = p.y + oy;
      if (x + p.rad < 0 || x - p.rad > W || y + p.rad < 0 || y - p.rad > H) continue;
      const s = (p.size / 24).toFixed(3);
      uses.push(`<path${logo ? ' class="l"' : ''} transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${p.rot.toFixed(1)}) scale(${s}) translate(-12 -12)" d="${d}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<!-- Murmur default chat wallpaper — generated by tools/doodle.mjs (do not edit by hand) -->
<style>path{fill:none;stroke:${ink};stroke-opacity:${inkOpacity};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.l{stroke:${logoInk};stroke-opacity:${logoOpacity}}</style>
${uses.join('\n')}
</svg>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'src/img'); mkdirSync(out, { recursive: true });
  const placed = layout();
  // Quiet on purpose: a wallpaper sits behind text, so it stays well under the bubbles' contrast.
  writeFileSync(join(out, 'doodle-dark.svg'), svg(placed, { ink: '#b8c6d8', logoInk: '#43e6c1', inkOpacity: 0.11, logoOpacity: 0.17 }));
  writeFileSync(join(out, 'doodle-light.svg'), svg(placed, { ink: '#1e293b', logoInk: '#0d9488', inkOpacity: 0.09, logoOpacity: 0.14 }));
  console.log(`doodle: ${placed.filter((p) => p.kind === 'icon').length} doodles + ${placed.filter((p) => p.kind === 'filler').length} fillers → src/img/doodle-{dark,light}.svg`);
}
