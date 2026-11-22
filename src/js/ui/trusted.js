// trusted.js — the app's ONLY Trusted Types policy.
//
// The page's CSP says `require-trusted-types-for 'script'; trusted-types murmur`.
// In browsers that enforce it (Chromium), that means no string can ever become
// HTML or a script URL unless it passes through this policy — so an injected
// "<img onerror=…>" in a message is inert by construction, not by care.
// Murmur never creates HTML from strings at all (createHTML always throws);
// the policy only allows our own same-origin worker/service-worker scripts.

const ALLOWED = new Set(['./sw.js', './js/qr/worker.js']);

const policy = globalThis.trustedTypes?.createPolicy
  ? globalThis.trustedTypes.createPolicy('murmur', {
    createHTML: () => { throw new TypeError('Murmur never builds HTML from strings'); },
    createScript: () => { throw new TypeError('Murmur never evaluates strings'); },
    createScriptURL: (u) => { if (!ALLOWED.has(u)) throw new TypeError(`script URL not allowed: ${u}`); return u; },
  })
  : null;

export const scriptUrl = (u) => {
  if (!ALLOWED.has(u)) throw new TypeError(`script URL not allowed: ${u}`);
  return policy ? policy.createScriptURL(u) : u;
};
