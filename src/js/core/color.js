// color.js — colour maths for the theme, chat colours and wallpapers. Pure, unit-tested
// (test/unit/color.test.mjs), including a WCAG contrast audit of the whole default theme.

/** "#43E6C1" / "#4ec" → [r, g, b] 0..255. Throws on anything else (callers validate first). */
export function rgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a colour: ${hex}`);
  const s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
export const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

/** WCAG 2.x relative luminance. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1..21. Normal text needs ≥ 4.5 (AA), large text and icons ≥ 3. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#0a1622';
/** The text colour (white or near-black) that reads best on `bg`. */
export const inkOn = (bg) => (contrast(bg, INK_LIGHT) >= contrast(bg, INK_DARK) ? INK_LIGHT : INK_DARK);

/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a, b, t) {
  const [p, q] = [rgb(a), rgb(b)];
  return `#${p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------- chat colours & wallpapers
// Sent-bubble colours to choose from. Every one is checked in the unit test: its automatic text
// colour (inkOn) must reach 4.5:1, and its secondary text (time, ticks) 3:1.
export const BUBBLES = [
  { id: 'teal', name: 'Electric teal (default)', hex: '#164e49' },
  { id: 'ocean', name: 'Ocean', hex: '#1d4f7a' },
  { id: 'indigo', name: 'Indigo', hex: '#3a3f8f' },
  { id: 'violet', name: 'Violet', hex: '#5b3a8c' },
  { id: 'plum', name: 'Plum', hex: '#7a2f63' },
  { id: 'rose', name: 'Rose', hex: '#9b2f4a' },
  { id: 'ember', name: 'Ember', hex: '#9a4a1c' },
  { id: 'olive', name: 'Olive', hex: '#4c5d1f' },
  { id: 'forest', name: 'Forest', hex: '#1f5f3a' },
  { id: 'slate', name: 'Slate', hex: '#3b4a5e' },
  { id: 'mint', name: 'Mint (light)', hex: '#a8f0dc' },
  { id: 'sky', name: 'Sky (light)', hex: '#bfe3ff' },
];
// Wallpapers: `.wall-<id>` classes in app.css — drawn in CSS, except the default doodle tile (an SVG).
export const WALLS = [
  { id: 'murmur', name: 'Murmur (default)' }, // doodles from Murmur's own symbols: src/img/doodle-*.svg (tools/doodle.mjs)
  { id: 'none', name: 'None' },
  { id: 'dusk', name: 'Dusk' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'deep', name: 'Deep sea' },
  { id: 'grid', name: 'Blueprint' },
  { id: 'dots', name: 'Dots' },
  { id: 'ember', name: 'Ember' },
];
export const DEFAULT_LOOK = Object.freeze({ bubble: 'teal', wall: 'murmur', dim: false });

/**
 * Validate a stored look (it comes back from the vault or a backup): unknown values fall back to
 * the defaults instead of breaking the chat screen. `photo` = the chat uses its own image.
 */
export function cleanLook(look) {
  const l = look && typeof look === 'object' ? look : {};
  const bubble = BUBBLES.some((b) => b.id === l.bubble) || isHex(l.bubble) ? l.bubble : DEFAULT_LOOK.bubble;
  const wall = l.wall === 'photo' || WALLS.some((w) => w.id === l.wall) ? l.wall : DEFAULT_LOOK.wall;
  return { bubble, wall, dim: !!l.dim };
}
export const bubbleHex = (id) => (isHex(id) ? id : (BUBBLES.find((b) => b.id === id) || BUBBLES[0]).hex);

/** CSS custom properties for a chat's sent bubbles: colour, text, secondary text, read ticks. */
export function bubbleVars(id) {
  const bg = bubbleHex(id);
  const ink = inkOn(bg);
  const dark = ink === INK_LIGHT;
  return {
    '--out': bg,
    '--out-ink': ink,
    '--out-ink2': dark ? mix(bg, '#ffffff', 0.8) : mix(bg, '#000000', 0.62),
    '--out-read': dark ? '#7cd0ff' : '#0b5fae',
  };
}

/** A per-chat look overrides the default one field by field ("default" = inherit). */
export function effectiveLook(defaults, own) {
  const d = cleanLook(defaults);
  if (!own) return d;
  return cleanLook({ ...d, ...Object.fromEntries(Object.entries(own).filter(([, v]) => v !== 'default' && v != null)) });
}
