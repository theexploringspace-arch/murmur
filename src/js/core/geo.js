// geo.js — location messages, worked out entirely on the phone (no map servers).
// GPS works without any network: the phone listens to satellites. What needs the
// internet is map *pictures*, so Murmur shows what matters off-grid instead:
// how far away your friend is and in which direction.

const R = 6371008.8; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

export function validLocation(m) {
  return m && Number.isFinite(m.lat) && Number.isFinite(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180
    && (m.acc == null || (Number.isFinite(m.acc) && m.acc >= 0 && m.acc < 1e6));
}

/** Great-circle distance in metres (haversine). */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, degrees clockwise from true north. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (deg) => POINTS[Math.round(deg / 22.5) % 16];

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "6.45000, 3.39000 (±12 m)" — 5 decimals ≈ 1 m. */
export const formatCoords = (p) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${p.acc != null ? ` (±${Math.round(p.acc)} m)` : ''}`;

/** Opening a map app tells that map company the location — the UI warns first. */
export function mapLinks(p) {
  const ll = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  return { apple: `https://maps.apple.com/?ll=${ll}&q=${ll}`, geo: `geo:${ll}?q=${ll}`, osm: `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lon.toFixed(6)}#map=16/${ll.replace(',', '/')}` };
}

/** Human summary: "1.2 km NE of you". */
export function relative(from, to) {
  if (!from || !validLocation(from)) return null;
  const d = distance(from, to);
  if (d < Math.max(10, (from.acc || 0) + (to.acc || 0))) return 'right next to you';
  return `${formatDistance(d)} ${cardinal(bearing(from, to))} of you`;
}
