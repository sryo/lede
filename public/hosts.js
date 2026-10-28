// Browsers and the URL API store a hostname with accents in its ASCII form (meñique.com.ar is
// xn--meique-xwa.com.ar). People read the original, so every hostname on screen goes through here.

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700;

function adapt(delta, points, first) {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - TMIN));
  return k + Math.floor((BASE - TMIN + 1) * delta / (delta + SKEW));
}

const digit = c => c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : BASE;

// RFC 3492 decoding of one label without its "xn--"; null when the input isn't valid punycode.
function decodeLabel(input) {
  const cut = input.lastIndexOf('-');
  const out = cut > 0 ? [...input.slice(0, cut)].map(c => c.codePointAt(0)) : [];
  if (out.some(c => c >= 128)) return null;
  let n = 128, i = 0, bias = 72;
  for (let pos = cut > 0 ? cut + 1 : 0; pos < input.length;) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (pos >= input.length) return null;
      const d = digit(input.charCodeAt(pos++));
      if (d >= BASE) return null;
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return out.length ? String.fromCodePoint(...out) : null;
}

export function displayHost(host) {
  return String(host || '').split('.').map(label => {
    if (!/^xn--/i.test(label)) return label;
    return decodeLabel(label.slice(4).toLowerCase()) ?? label;
  }).join('.');
}
