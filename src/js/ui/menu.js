// menu.js — the message "spotlight" menu.
//
// Long-press (or right-click) a message: the chat dims and blurs, the message lifts out in place
// so you can see exactly what you're acting on, and a compact card of actions appears beside it —
// on the message's own side, never a full-width dialog. Destructive actions sit below a divider in
// red. Tap anywhere else, swipe it away or press Escape to close.
//
// Accessible as a real menu: role="menu"/"menuitem", focus moves into it, ↑/↓/Home/End move,
// Enter activates, Escape closes and focus returns to the message.

import { h, icon } from './dom.js';

/**
 * @param {HTMLElement} anchor  the message bubble
 * @param {{ items: Array<{value: string, label: string, icon?: string, hint?: string, danger?: boolean, divider?: boolean}>,
 *           note?: string, side?: 'left'|'right' }} o
 * @returns {Promise<string|false>} the chosen value, or false when dismissed
 */
export function spotlightMenu(anchor, { items, note, side }) {
  return new Promise((resolve) => {
    document.querySelector('.spot')?.remove();
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    side ||= r.left + r.width / 2 > vw / 2 ? 'right' : 'left';

    // A lifted copy of the message, exactly where the original is (inert: not interactive, hidden from AT).
    const lifted = anchor.cloneNode(true);
    lifted.removeAttribute('data-testid'); lifted.querySelectorAll('[data-testid]').forEach((e) => e.removeAttribute('data-testid'));
    lifted.classList.add('spot-lifted'); lifted.setAttribute('aria-hidden', 'true'); lifted.inert = true;
    Object.assign(lifted.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, maxWidth: 'none' });
    // The copy lives outside the chat screen, so it would lose that chat's own colours (Settings →
    // chat colour): carry them over, or a violet message would lift out teal.
    const cs = getComputedStyle(anchor);
    for (const v of ['--out', '--out-ink', '--out-ink2', '--out-read', '--in']) { const val = cs.getPropertyValue(v).trim(); if (val) lifted.style.setProperty(v, val); }

    let done = false;
    const close = (v) => {
      if (done) return; done = true;
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
      document.removeEventListener('keydown', keys, true);
      anchor.focus?.({ preventScroll: true });
      resolve(v);
    };
    const rows = [];
    const card = h('div.spot-card', { role: 'menu', 'aria-label': 'Message actions', 'data-testid': 'message-menu' },
      items.map((it) => {
        const row = h(`button.spot-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem', tabindex: '-1', 'data-testid': `menu-${it.value}`, onclick: () => close(it.value) },
          it.icon ? icon(it.icon, 19) : h('span.spot-noicon'), h('span.spot-label', it.label), it.hint ? h('small.spot-hint', it.hint) : null);
        rows.push(row);
        return it.divider ? [h('div.spot-sep', { role: 'separator' }), row] : row;
      }),
      note ? h('p.spot-note', note) : null);
    // Only a tap that STARTS on the backdrop closes it: lifting the long-press finger over the
    // backdrop (some phones turn that into a click) must not close the menu it just opened.
    let downOnBg = false;
    const backdrop = h('div.spot-backdrop', { 'data-testid': 'menu-backdrop', onpointerdown: () => { downOnBg = true; }, onclick: () => { if (downOnBg) close(false); } });
    const wrap = h('div.spot', { 'data-side': side }, backdrop, lifted, card);
    document.body.append(wrap);

    // Place the card beside the message: below if it fits, else above, else pinned to the bottom.
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 8, pad = 12;
    let top = r.bottom + gap;
    if (top + ch > vh - pad) top = r.top - gap - ch >= pad ? r.top - gap - ch : Math.max(pad, vh - pad - ch);
    const left = side === 'right' ? Math.min(vw - pad - cw, Math.max(pad, r.right - cw)) : Math.max(pad, Math.min(r.left, vw - pad - cw));
    Object.assign(card.style, { top: `${top}px`, left: `${left}px`, transformOrigin: `${side === 'right' ? 'right' : 'left'} ${top > r.top ? 'top' : 'bottom'}` });

    const move = (d) => { const i = rows.indexOf(document.activeElement); rows[(i + d + rows.length) % rows.length].focus(); };
    function keys(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Home') { e.preventDefault(); rows[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); rows[rows.length - 1].focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
    }
    document.addEventListener('keydown', keys, true);
    rows[0]?.focus({ preventScroll: true });
    navigator.vibrate?.(8);
  });
}
