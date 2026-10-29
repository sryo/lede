// Rasterizes a hatch glyph's path, to measure how much of its tile it inks. Copied from the hatch library
// (https://github.com/sryo/hatch, test/raster.mjs), which Lede's strip textures come from; only what the tests use.
// Covers M L H V C S A Z, absolute and relative; arcs are circular (rx = ry, no rotation). Under evenodd, a path that
// starts with the whole tile (M0 0h8v8H0z) cuts the rest out of it.
export function raster(g, n = 128) {
  const evenodd = typeof g === 'object' && g.invert, d = typeof g === 'object' ? (evenodd ? `M0 0h8v8H0z${g.d}` : g.d) : g;
  const T = 8, px = new Uint8Array(n * n), edges = [];
  for (const p of flatten(d)) for (let k = 0; k < p.length; k++) {
    const [x0, y0] = p[k], [x1, y1] = p[(k + 1) % p.length];
    if (y0 !== y1) edges.push(x0, y0, x1, y1);
  }
  // A scanline fill: each row finds where the edges cross it, then walks the pixel centers left to right. A center's
  // winding is the sum of the directions of the crossings to its right, as a ray cast to the right would count.
  const hits = [];
  for (let j = 0; j < n; j++) {
    const y = (j + .5) * T / n;
    hits.length = 0;
    let w = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const x0 = edges[e], y0 = edges[e + 1], x1 = edges[e + 2], y1 = edges[e + 3];
      if (y0 <= y ? y1 > y : y1 <= y) {
        const dir = y0 <= y ? 1 : -1;
        hits.push([x0 + (y - y0) / (y1 - y0) * (x1 - x0), dir]);
        w += dir;
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (let i = 0, h = 0; i < n; i++) {
      const x = (i + .5) * T / n;
      while (h < hits.length && hits[h][0] <= x) w -= hits[h++][1];
      px[j * n + i] = (evenodd ? w % 2 : w) ? 1 : 0;
    }
  }
  return px;
}

export const cover = (d, n = 128) => raster(d, n).reduce((a, b) => a + b, 0) / n / n;

function flatten(d) {
  const t = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [], polys = [];
  let i = 0, cmd, x = 0, y = 0, sx = 0, sy = 0, cx2 = 0, cy2 = 0, poly = null;
  const num = () => +t[i++], start = () => { poly = [[x, y]]; polys.push(poly); };
  const cubic = (x1, y1, x2, y2, ex, ey) => {
    for (let s = 1; s <= 16; s++) {
      const u = s / 16, v = 1 - u;
      poly.push([v ** 3 * x + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u ** 3 * ex, v ** 3 * y + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u ** 3 * ey]);
    }
    cx2 = x2; cy2 = y2; x = ex; y = ey;
  };
  while (i < t.length) {
    if (/[a-zA-Z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { x = sx; y = sy; poly = null; continue; }
    if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; start(); cmd = rel ? 'l' : 'L'; continue; }
    if (!poly) start();
    if (C === 'L') { x = ox + num(); y = oy + num(); poly.push([x, y]); }
    else if (C === 'H') { x = ox + num(); poly.push([x, y]); }
    else if (C === 'V') { y = oy + num(); poly.push([x, y]); }
    else if (C === 'C') cubic(ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num());
    else if (C === 'S') cubic(2 * x - cx2, 2 * y - cy2, ox + num(), oy + num(), ox + num(), oy + num());
    else if (C === 'A') {
      const r = num(); num(); num(); const large = num(), sweep = num(), ex = ox + num(), ey = oy + num();
      const mx = (x - ex) / 2, my = (y - ey) / 2, h = Math.sqrt(Math.max(0, r * r / (mx * mx + my * my) - 1)) * (large === sweep ? -1 : 1);
      const cx = (x + ex) / 2 + h * my, cy = (y + ey) / 2 - h * mx;
      let a0 = Math.atan2(y - cy, x - cx), da = Math.atan2(ey - cy, ex - cx) - a0;
      if (sweep && da < 0) da += 2 * Math.PI; if (!sweep && da > 0) da -= 2 * Math.PI;
      for (let s = 1; s <= 16; s++) poly.push([cx + r * Math.cos(a0 + da * s / 16), cy + r * Math.sin(a0 + da * s / 16)]);
      x = ex; y = ey;
    }
  }
  return polys;
}
