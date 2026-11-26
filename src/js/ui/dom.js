// dom.js — the only way Murmur builds UI: createElement + textContent.
// No innerHTML anywhere, so message text can never be interpreted as markup.

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * h('button.primary#go', {onclick, disabled:true, 'aria-label':'Go'}, 'Go', childNode, [more])
 */
export function h(tag, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props != null) children.unshift(props);
    props = {};
  }
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  if (!m) throw new Error(`bad tag ${tag}`);
  const svg = ['svg', 'path', 'circle', 'rect', 'g', 'polyline', 'line'].includes(m[1]);
  const el = svg ? document.createElementNS(SVGNS, m[1]) : document.createElement(m[1]);
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    const dataish = k.startsWith('data-') || k.startsWith('aria-');
    if (v == null || (v === false && !dataish)) continue;
    if (dataish) { el.setAttribute(k, String(v)); continue; } // data-online="false" must exist
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') { if ('defaultValue' in el && el.tagName !== 'SELECT') el.defaultValue = v; el.value = v; } // defaultValue = what the screen drew (render() tells typing apart from it)
    else if (k === 'checked' || k === 'srcObject') el[k] = v;
    else if (k === 'text') el.textContent = v;
    else if (/^(href|src)$/.test(k) && !/^(blob:|#|\.\/)/.test(String(v))) throw new Error(`refusing ${k}=${v}`);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

/** Tiny inline icon set (stroke icons, 24×24). */
const ICONS = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  back: 'M15 18l-6-6 6-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 18h2M18 14h3',
  scan: 'M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M3 12h18',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  check: 'M20 6L9 17l-5-5',
  timer: 'M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5l3 2M9 2h6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h0',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  x: 'M18 6L6 18M6 6l12 12',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  share: 'M4 12v8h16v-8M16 6l-4-4-4 4M12 2v14',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  paste: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  pin: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  alert: 'M12 3l10 18H2zM12 10v4M12 18h0',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  // Rounded camera, per Prince's design: soft body + rounded lens (call buttons, call screen).
  video: 'M4.5 6h8.5a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H4.5A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4.5 6zM15.5 10.2l4.3-3.1a.85.85 0 0 1 1.35.69v8.42a.85.85 0 0 1-1.35.69l-4.3-3.1',
  hangup: 'M3 15.5c5-4.7 13-4.7 18 0l-2.4 2.4-3.6-1.5v-3a12 12 0 0 0-6 0v3l-3.6 1.5z',
  micoff: 'M2 2l20 20M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.7M17 16.9A7 7 0 0 1 5 11M19 11a7 7 0 0 1-.1 1.2M12 18v3',
  devices: 'M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2zM11 18.5h2',
  videooff: 'M4.5 6h8.5a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H4.5A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4.5 6zM15.5 10.2l4.3-3.1a.85.85 0 0 1 1.35.69v8.42a.85.85 0 0 1-1.35.69l-4.3-3.1M3 3l18 18',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1 .2-2.2 1.3-2.2H17a4 4 0 0 0 4-4c0-5-4-10-9-10zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  cloud: 'M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7zM12 11v5M9.5 13.5 12 11l2.5 2.5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  chevron: 'M9 6l6 6-6 6',
  status: 'M12 3a9 9 0 0 1 9 9M21 12a9 9 0 0 1-9 9M12 21a9 9 0 0 1-9-9M3 12a9 9 0 0 1 9-9M12 8v4l2.5 2.5',
  plus: 'M12 5v14M5 12h14',
  text: 'M5 6h14M12 6v13M9 19h6',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4',
  forward: 'M14 6l6 6-6 6M20 12H10a6 6 0 0 0-6 6v1',
  reply: 'M10 6l-6 6 6 6M4 12h10a6 6 0 0 1 6 6v1',
  close: 'M6 6l12 12M18 6L6 18',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  play: 'M7 4.5v15l12.5-7.5z',
  pause: 'M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z',
  flip: 'M20 7h-4l-2-3h-4L8 7H4v13h16zM9 13a3 3 0 0 0 5.2 2M15 13a3 3 0 0 0-5.2-2M14 15h1v1M10 11H9v-1',
};
export function icon(name, size = 22) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
  return s;
}

/** QR as an SVG element (no strings parsed as markup). */
export function qrSvg(qr, label) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${qr.size + 8} ${qr.size + 8}`);
  s.setAttribute('shape-rendering', 'crispEdges');
  s.setAttribute('role', 'img'); s.setAttribute('aria-label', label);
  s.classList.add('qr');
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', qr.size + 8); bg.setAttribute('height', qr.size + 8); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(SVGNS, 'path');
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let e = x; while (e < qr.size && qr.modules[y][e]) e++;
      d += `M${x + 4} ${y + 4}h${e - x}v1h-${e - x}z`;
      x = e;
    }
  }
  p.setAttribute('d', d); p.setAttribute('fill', '#000');
  s.append(bg, p);
  return s;
}

export function toast(msg, kind = 'info', ms = 3500) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div#toasts', { 'aria-live': 'polite' }); document.body.append(host); }
  const t = h(`div.toast.${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, msg);
  // Never a wall of notices: an identical one is replaced, and at most 3 show at once —
  // the oldest non-error goes first, so an error is never pushed off by small talk.
  for (const old of [...host.children]) if (old.textContent === t.textContent) old.remove();
  while (host.children.length >= 3) ([...host.children].find((x) => !x.classList.contains('error')) || host.firstElementChild).remove();
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
