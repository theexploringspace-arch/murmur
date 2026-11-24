// sheet.js — a panel that slides up from the bottom (Status "Viewed by", and anything that
// belongs to what's on screen rather than interrupting it). Unlike a centred dialog it keeps the
// thing you were looking at visible above it, and it's where a thumb already is.
//
//   const close = openSheet({ title, body, label, onClose, testid });
//
// Closes on: a downward drag of the handle/header past 80 px (or a quick flick), a tap on the
// dimmed area, Escape, or the Close button. Focus moves into the sheet and back afterwards, so
// it works with a keyboard and screen readers. Only one sheet at a time.
import { h, icon } from './dom.js';

let current = null;

export function openSheet({ title, body = [], label = title, onClose = () => {}, testid = 'sheet' }) {
  current?.close(true);
  const before = document.activeElement;
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label, 'data-testid': testid, tabindex: '-1' },
    h('div.sheet-grab', { 'aria-hidden': 'true' }, h('span')),
    h('div.sheet-head', h('h2', title), h('button.icon.small', { type: 'button', 'aria-label': 'Close', 'data-testid': `${testid}-close`, onclick: () => close() }, icon('close', 18))),
    h('div.sheet-body', body));
  const scrim = h('div.sheet-scrim', { 'data-testid': `${testid}-scrim`, onclick: () => close() });
  const root = h('div.sheet-root', scrim, panel);
  let closed = false;

  function close(immediate = false) {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', keys, true);
    if (current?.root === root) current = null;
    const done = () => { root.remove(); onClose(); try { before?.focus?.({ preventScroll: true }); } catch { /* gone */ } };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    root.classList.remove('open'); panel.style.transform = '';
    setTimeout(done, 220);
  }
  function keys(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key === 'Tab') { // keep focus inside the sheet
      const f = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  // Drag down to dismiss (from the handle or header — the list itself still scrolls normally).
  let y0 = 0, t0 = 0, dy = 0, dragging = false;
  const grabArea = [panel.querySelector('.sheet-grab'), panel.querySelector('.sheet-head')];
  for (const el of grabArea) {
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; dragging = true; y0 = e.clientY; t0 = Date.now(); dy = 0; panel.classList.add('dragging'); try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ } });
    el.addEventListener('pointermove', (e) => { if (!dragging) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; });
    const end = () => {
      if (!dragging) return; dragging = false; panel.classList.remove('dragging');
      const flick = dy > 30 && Date.now() - t0 < 250;
      if (dy > 80 || flick) close(); else panel.style.transform = '';
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }

  document.body.append(root);
  document.addEventListener('keydown', keys, true);
  requestAnimationFrame(() => { root.classList.add('open'); panel.focus({ preventScroll: true }); });
  current = { root, close };
  return close;
}

export const closeSheet = () => current?.close(true);
