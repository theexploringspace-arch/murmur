// safety.js — on-device protection against phishing links, disguised files and
// impersonation. Runs AFTER decryption, entirely on the phone: nothing is sent
// to any server (no Safe Browsing lookups — those would reveal what people share).
//
// HONEST LIMITS: this catches the common tricks (lookalike letters, fake brand
// domains, hidden destinations, disguised programs). It cannot know that a
// brand-new, normal-looking website is a scam. So the design also removes the
// easy path: links are never one-tap; you always see the REAL destination first.

// ---------------------------------------------------------------- links
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'intent:', 'ms-msdt:', 'search-ms:', 'ms-officecmd:', 'jar:', 'chrome:', 'about:']);
export const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 's.id', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in', 'v.gd', 'bl.ink', 't.ly', 'shorte.st', 'adf.ly', 'qrco.de', 'u.to', 'x.co']);
const FILENAME_TLDS = new Set(['zip', 'mov']);
const ABUSED_TLDS = new Set(['top', 'xyz', 'click', 'country', 'gq', 'tk', 'ml', 'cf', 'ga', 'work', 'support', 'rest', 'cam', 'icu', 'buzz', 'cyou', 'sbs', 'lol', 'quest']);
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.ng', 'org.ng', 'gov.ng', 'edu.ng', 'com.au', 'net.au', 'co.za', 'com.br', 'co.jp', 'co.in', 'com.gh', 'co.ke', 'com.mx', 'com.tr', 'co.nz', 'com.sg', 'com.cn']);

// Brands phishers copy most, with the domains they really use.
export const BRANDS = {
  apple: ['apple.com', 'icloud.com'], icloud: ['icloud.com', 'apple.com'], paypal: ['paypal.com', 'paypal.me'], google: ['google.com', 'goo.gl', 'youtube.com', 'gmail.com'],
  gmail: ['gmail.com', 'google.com'], microsoft: ['microsoft.com', 'live.com', 'office.com', 'outlook.com'], outlook: ['outlook.com', 'live.com', 'microsoft.com'], office: ['office.com', 'microsoft.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.in', 'amzn.to'], facebook: ['facebook.com', 'fb.com', 'fb.me'], instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com', 'wa.me'], netflix: ['netflix.com'], linkedin: ['linkedin.com', 'lnkd.in'], coinbase: ['coinbase.com'], binance: ['binance.com'],
  chase: ['chase.com'], wellsfargo: ['wellsfargo.com'], bankofamerica: ['bankofamerica.com'], citibank: ['citi.com', 'citibank.com'], dhl: ['dhl.com'], fedex: ['fedex.com'],
  ups: ['ups.com'], usps: ['usps.com'], irs: ['irs.gov'], steam: ['steampowered.com', 'steamcommunity.com'], telegram: ['telegram.org', 't.me'], tiktok: ['tiktok.com'],
  twitter: ['twitter.com', 'x.com', 't.co'], gtbank: ['gtbank.com'], firstbank: ['firstbanknigeria.com'], zenithbank: ['zenithbank.com'], accessbank: ['accessbankplc.com'],
  opay: ['opayweb.com'], palmpay: ['palmpay.com'], moniepoint: ['moniepoint.com'], kuda: ['kuda.com'], cashapp: ['cash.app'], venmo: ['venmo.com'], zelle: ['zellepay.com'],
  murmur: ['princeisgenius.com'],
};

// Characters from other alphabets that look like Latin letters (subset of Unicode
// confusables.txt) + common digit/letter swaps.
const CONFUSABLE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ѕ': 's', 'ɡ': 'g', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b', 'п': 'n',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'ι': 'i', 'κ': 'k', 'χ': 'x', 'υ': 'u', 'ε': 'e', 'β': 'b', 'η': 'n', 'μ': 'u',
  'ı': 'i', 'ł': 'l', 'ß': 'ss', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŀ': 'l', 'ǀ': 'l',
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a', '|': 'l', '!': 'i',
};
/** "Skeleton": what a string looks like to a human, ignoring lookalike tricks. */
export function skeleton(s) {
  let t = String(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  t = [...t].map((c) => CONFUSABLE[c] ?? c).join('');
  return t.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd').replace(/[^a-z]/g, '');
}

// ---- RFC 3492 Punycode decoding (to show what xn-- hosts really look like) ----
export function punycodeToUnicode(label) {
  if (!/^xn--/i.test(label)) return label;
  const input = label.slice(4).toLowerCase();
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  let n = 128, i = 0, bias = 72;
  const d = input.lastIndexOf('-');
  const out = d > 0 ? [...input.slice(0, d)] : [];
  const adapt = (delta, num, first) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / num);
    let k = 0; while (delta > ((base - tMin) * tMax) >> 1) { delta = Math.floor(delta / (base - tMin)); k += base; }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  for (let idx = d > 0 ? d + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (idx >= input.length) throw new Error('bad punycode');
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) throw new Error('bad punycode');
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1)); i %= out.length + 1;
    out.splice(i++, 0, String.fromCodePoint(n));
  }
  return out.join('');
}
const unicodeHost = (h) => h.split('.').map((l) => { try { return punycodeToUnicode(l); } catch { return l; } }).join('.');

export function registrableDomain(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

const scriptOf = (ch) => (/\p{Script=Latin}/u.test(ch) ? 'latin' : /\p{Script=Cyrillic}/u.test(ch) ? 'cyrillic' : /\p{Script=Greek}/u.test(ch) ? 'greek' : /[0-9-]/.test(ch) ? 'common' : 'other');

/**
 * @returns {{ok:boolean, href:string|null, host:string, unicodeHost:string, domain:string,
 *            risk:'blocked'|'high'|'medium'|'low', reasons:string[]}}
 */
export function analyzeUrl(raw) {
  const reasons = []; let risk = 'low';
  const bump = (r, why) => { const order = ['low', 'medium', 'high', 'blocked']; if (order.indexOf(r) > order.indexOf(risk)) risk = r; reasons.push(why); };
  let text = String(raw).trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && DANGEROUS_SCHEMES.has(scheme + ':')) return { ok: false, href: null, host: '', unicodeHost: '', domain: '', risk: 'blocked', reasons: [`“${scheme}:” links can run code or open hidden content. Murmur never opens them.`] };
  if (scheme && !['http', 'https'].includes(scheme)) return { ok: false, href: null, host: '', unicodeHost: '', domain: '', risk: 'blocked', reasons: [`Murmur only opens web links (http/https), not “${scheme}:”.`] };
  if (!scheme) text = 'https://' + text;
  let u;
  try { u = new URL(text); } catch { return { ok: false, href: null, host: '', unicodeHost: '', domain: '', risk: 'blocked', reasons: ['This is not a valid web address.'] }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const uni = unicodeHost(host);
  const domain = registrableDomain(host);
  const uniDomain = registrableDomain(uni);
  const tld = host.split('.').pop();

  if (u.protocol === 'http:') bump('medium', 'Not encrypted (http): anyone on the network can see or change this page.');
  if (u.username || u.password) bump('high', `The “${decodeURIComponent(u.username)}@” part is a trick: this link really goes to ${uni}.`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) bump('high', 'Goes to a raw IP address instead of a website name — common in scams.');
  if (uni !== host) {
    const scripts = new Set([...uniDomain.replace(/\./g, '')].map(scriptOf).filter((s) => s !== 'common'));
    if (scripts.size > 1) bump('high', `Mixes letters from different alphabets (${[...scripts].join(' + ')}) to imitate another website.`);
    else if ([...scripts][0] !== 'latin') bump('medium', 'Uses non-Latin letters. Real for some local websites, but also used to imitate famous ones.');
    else bump('medium', 'Uses accented or special letters in the website name.');
  }
  // Brand impersonation: the name LOOKS like a brand, but it's not that brand's domain.
  // Compare every word of the host (split on dots and hyphens) with each brand.
  const words = uni.split(/[.-]/).map(skeleton).filter(Boolean);
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (domains.some((d) => domain === d || domain === registrableDomain(d))) continue;
    const b = skeleton(brand);
    const hit = words.some((w) => w === b || (b.length >= 6 && editDistance(w, b) === 1));
    if (hit) { bump('high', `Looks like ${brand[0].toUpperCase() + brand.slice(1)}, but it is NOT ${domains[0]}.`); break; }
  }
  if (SHORTENERS.has(domain) || SHORTENERS.has(host)) bump('medium', 'A link shortener: it hides the real destination. Ask the sender for the full link.');
  if (FILENAME_TLDS.has(tld)) bump('high', `“.${tld}” looks like a file name but is a website — a known trick.`);
  else if (ABUSED_TLDS.has(tld)) bump('medium', `“.${tld}” websites are frequently used for scams.`);
  if (host.split('.').length > 5) bump('medium', 'Unusually long website name — often used to hide the real domain at the end.');
  if (/login|verify|secure|account|update|wallet|unlock|bonus|prize|gift/.test(u.pathname.toLowerCase() + host) && risk !== 'low') reasons.push('Asks you to log in or verify something: never type passwords after following a link.');
  return { ok: true, href: u.href, host, unicodeHost: uni, domain: uniDomain, risk, reasons };
}

export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Things that look like links: explicit schemes (incl. dangerous ones), www., or bare domain.tld/…
const LINK_RE = /\b((?:https?|javascript|data|vbscript|file|blob|intent|ms-msdt|search-ms):[^\s<>"'`]+|www\.[^\s<>"'`]+|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+)(?::\d{2,5})?(?:\/[^\s<>"'`]*)?)/giu;
const TRAIL = /[.,;:!?)\]}'"»”’]+$/u;

/** Splits message text into plain text and link segments (each link analyzed). */
export function linkify(text) {
  const out = []; let last = 0;
  for (const m of String(text).matchAll(LINK_RE)) {
    let s = m[0]; const trail = TRAIL.exec(s)?.[0] || '';
    if (trail && !/^[a-z]+:$/i.test(s.slice(0, -trail.length))) s = s.slice(0, s.length - trail.length);
    // bare "word.word" must have a plausible TLD to count (avoid "e.g" / "file.txt")
    if (!/:/.test(s.split('/')[0]) && !/^www\./i.test(s)) {
      const host = s.split(/[/:?#]/)[0]; const tld = host.split('.').pop().toLowerCase();
      if (!isLikelyTld(tld)) continue;
    }
    if (m.index > 0 && text[m.index - 1] === '@') continue; // e-mail address, not a link
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'link', text: s, analysis: analyzeUrl(s) });
    last = m.index + s.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
const COMMON_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'me', 'app', 'dev', 'info', 'biz', 'gov', 'edu', 'ng', 'uk', 'us', 'ca', 'de', 'fr', 'ru', 'cn', 'in', 'br', 'au', 'za', 'gh', 'ke', 'ly', 'to', 'gl', 'gd', 'ai', 'tv', 'site', 'online', 'shop', 'store', 'live', 'link', 'page', 'xn--p1ai']);
const isLikelyTld = (t) => COMMON_TLDS.has(t) || FILENAME_TLDS.has(t) || ABUSED_TLDS.has(t) || t.startsWith('xn--');

// ---------------------------------------------------------------- files
const EXEC_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'cpl', 'jar', 'apk', 'xapk', 'aab', 'ipa', 'dmg', 'pkg', 'app', 'deb', 'rpm', 'sh', 'bash', 'command', 'lnk', 'reg', 'iso', 'img', 'vhd', 'vhdx', 'appx', 'msix', 'msixbundle', 'scf', 'url', 'desktop', 'run', 'bin', 'gadget', 'inf', 'chm', 'dll', 'sys', 'xll', 'workflow', 'action', 'mobileconfig']);
const ACTIVE_DOC_EXT = new Set(['html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'xml', 'pdf.html']);
const MACRO_EXT = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm']);
const OLD_OFFICE_EXT = new Set(['doc', 'xls', 'ppt', 'dot', 'xlt', 'pot', 'rtf']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'arj', 'ace']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp']);

const startsWith = (b, sig, off = 0) => sig.every((x, i) => x === null || b[off + i] === x);
/** Identify a file by its CONTENT (magic bytes), not by its name. */
export function sniff(b) {
  if (!b || b.length < 4) return 'unknown';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x41, 0x56, 0x45], 8)) return 'audio/wav';
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^(heic|heix|mif1|msf1|avif)/.test(brand)) return 'image/heic';
    if (/^(M4A |M4B )/.test(brand)) return 'audio/mp4';
    if (/^qt  /.test(brand)) return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (startsWith(b, [0x49, 0x44, 0x33]) || startsWith(b, [0xff, 0xfb]) || startsWith(b, [0xff, 0xf3])) return 'audio/mpeg';
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (startsWith(b, [0x52, 0x61, 0x72, 0x21])) return 'application/x-rar';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf])) return 'application/x-7z';
  if (startsWith(b, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'application/x-ole'; // old Office (can hold macros)
  if (startsWith(b, [0x4d, 0x5a])) return 'application/x-msdownload';      // Windows program
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  if (startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return 'application/x-mach-o';
  if (startsWith(b, [0x64, 0x65, 0x78, 0x0a])) return 'application/x-dex';
  if (startsWith(b, [0x23, 0x21])) return 'text/x-script';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (/^(<!doctype html|<html|<head|<body|<script|<iframe)/.test(head)) return 'text/html';
  if (/^(<\?xml[^>]*>\s*)?(<!doctype svg[^>]*>\s*)?<svg/.test(head)) return 'image/svg+xml';
  if (head.startsWith('{\\rtf')) return 'application/rtf';
  return 'unknown';
}
const EXEC_TYPES = new Set(['application/x-msdownload', 'application/x-elf', 'application/x-mach-o', 'application/x-dex', 'text/x-script']);
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Strips direction-override and invisible characters that disguise file names. */
export function cleanFileName(name) {
  const tricks = /[‪-‮⁦-⁩​-‏؜﻿]/g;
  return { name: String(name || 'file').replace(tricks, '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').slice(0, 120) || 'file', disguised: tricks.test(String(name)) };
}

/**
 * @returns {{verdict:'ok'|'warn'|'danger', realType:string, name:string, inline:boolean, reasons:string[]}}
 * inline = safe to DISPLAY inside Murmur (only verified raster images).
 */
export function inspectFile(name, declaredMime, bytes) {
  const reasons = []; let verdict = 'ok';
  const up = (v, why) => { if (['ok', 'warn', 'danger'].indexOf(v) > ['ok', 'warn', 'danger'].indexOf(verdict)) verdict = v; reasons.push(why); };
  const c = cleanFileName(name);
  if (c.disguised) up('danger', 'The file name contains hidden characters that reverse or hide part of it — a classic disguise.');
  const exts = c.name.toLowerCase().split('.').slice(1);
  const ext = exts[exts.length - 1] || '';
  const realType = sniff(bytes);

  if (EXEC_TYPES.has(realType)) up('danger', ext && !EXEC_EXT.has(ext) ? `Disguised program: it is named “.${ext}” but is actually an app/program.` : 'This is a program/app. Programs from chats are the #1 way phones and computers get infected.');
  else if (EXEC_EXT.has(ext)) up('danger', `“.${ext}” files are apps or scripts that run code. Only open if you were expecting it from this person.`);
  if (exts.length >= 2 && EXEC_EXT.has(ext) && /^(pdf|jpe?g|png|docx?|xlsx?|txt|mp4|mp3)$/.test(exts[exts.length - 2])) up('danger', `Double extension “.${exts.slice(-2).join('.')}”: made to look like a document.`);
  if (MACRO_EXT.has(ext)) up('danger', 'Office file with macros: macros can take over your computer.');
  else if (OLD_OFFICE_EXT.has(ext) || realType === 'application/x-ole' || realType === 'application/rtf') up('warn', 'Old-style Office/RTF document: these can carry macros or exploits. Do not enable editing or macros.');
  if (ACTIVE_DOC_EXT.has(ext) || realType === 'text/html' || realType === 'image/svg+xml') up('warn', 'Web page / SVG file: can run scripts or show a fake login page when opened in a browser. Murmur won’t display it.');
  if (ARCHIVE_EXT.has(ext) || ['application/zip', 'application/x-rar', 'application/x-7z', 'application/gzip'].includes(realType)) {
    if (!['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(ext) && !EXEC_EXT.has(ext)) up('warn', 'Compressed archive: check what is inside before opening anything from it.');
  }
  if (IMAGE_EXT.has(ext) || /^image\//.test(declaredMime || '')) {
    if (realType !== 'unknown' && !realType.startsWith('image/')) up('danger', `Pretends to be a picture, but it is really “${realType}”.`);
  }
  return { verdict, realType, name: c.name, inline: INLINE_IMAGE_TYPES.has(realType) && verdict === 'ok', reasons };
}

// ---------------------------------------------------------------- names
/** Returns existing names that a new contact's name imitates. */
export function lookalikeNames(newName, existingNames) {
  const a = skeleton(newName);
  if (!a) return [];
  return existingNames.filter((n) => {
    const b = skeleton(n);
    if (!b) return false;
    return a === b || (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1);
  });
}
