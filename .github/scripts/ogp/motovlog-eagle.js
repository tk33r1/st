/* The LIBERTY MOTOVLOG eagle, as SVG.
 *
 * Traced off images/contents/motovlog-logo.webp. The badge's wing is two
 * separate things: a thin leading-edge arc sweeping up off the neck and,
 * hanging below it with open air between, a block of long layered primaries
 * swept back toward the body. Drawn as one mass it stops being an eagle, so
 * they are kept apart here.
 *
 * 64x64 box, span 62, centred on x=32; the bird is 1.6:1 wide, which is the
 * proportion the badge has. The feathers are generated so the rows stay even —
 * hand-editing 100 paths is not a thing anyone should have to do — while the
 * head, breast and legs are drawn.
 *
 * Exports buildEagleSvg({ adaptive }):
 *   adaptive true  -> flips with prefers-color-scheme (what ships as the .svg)
 *   adaptive false -> cream, fixed (for the PNGs and the OGP card, which sit on
 *                     a known dark ground and cannot run a media query)
 */
'use strict';

const n = (v) => (Math.round(v * 100) / 100).toString();
const D = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const qp = (p0, p1, p2, t) => [
  (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
  (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
];

/* One feather: square at the root, drawn to a point, with a little camber so a
 * row reads as plumage and not as a comb. */
function feather(root, ang, len, halfW, camber) {
  const [rx, ry] = root;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const nx = -dy, ny = dx;
  const tip = [rx + dx * len + nx * camber, ry + dy * len + ny * camber];
  const a = [rx + nx * halfW, ry + ny * halfW];
  const b = [rx - nx * halfW, ry - ny * halfW];
  const ca = [rx + dx * len * .5 + nx * (halfW * 1.02 + camber * .45),
              ry + dy * len * .5 + ny * (halfW * 1.02 + camber * .45)];
  const cb = [rx + dx * len * .6 - nx * (halfW * .5 - camber * .45),
              ry + dy * len * .6 - ny * (halfW * .5 - camber * .45)];
  return `M${n(a[0])} ${n(a[1])}Q${n(ca[0])} ${n(ca[1])} ${n(tip[0])} ${n(tip[1])}` +
         `Q${n(cb[0])} ${n(cb[1])} ${n(b[0])} ${n(b[1])}Z`;
}

/* Leading edge of the right wing: off the neck, over the top, out to a long tip. */
const L0 = [33.2, 22.2], L1 = [48.6, 10.2], L2 = [62.8, 16.2];
/* Where the primaries start — the same sweep, dropped, so air shows between. */
const F0 = [34.2, 23.6], F1 = [47.5, 17.0], F2 = [61.0, 18.0];

function wing() {
  const out = [];

  const top = [], bot = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const [x, y] = qp(L0, L1, L2, t);
    const w = lerp(4.0, .75, t ** .75);
    top.push([x, y - w * .5]);
    bot.push([x, y + w * .5]);
  }
  out.push('M' + top.map(([x, y]) => `${n(x)} ${n(y)}`).join('L') +
           'L' + bot.reverse().map(([x, y]) => `${n(x)} ${n(y)}`).join('L') + 'Z');

  /* Four rows of primaries. 96 degrees near the shoulder to 143 at the tip
   * (0 is +x, 90 straight down) — the sweep back toward the body. */
  const angAt = (t) => lerp(92, 146, t ** .75) * D;
  const lenAt = (t, row) => lerp(2.6, 13.0, t ** .62) * lerp(.52, 1.42, row / 3);
  const ROWS = [
    { count: 8, t0: .04, t1: 1.00, row: 0, hw: 1.25, camber: .5 },
    { count: 7, t0: .10, t1: .975, row: 1, hw: 1.35, camber: .8 },
    { count: 6, t0: .18, t1: .94, row: 2, hw: 1.45, camber: 1.0 },
    { count: 5, t0: .28, t1: .88, row: 3, hw: 1.5, camber: 1.3 },
  ];
  for (const r of ROWS) {
    for (let i = 0; i < r.count; i++) {
      const t = lerp(r.t0, r.t1, i / (r.count - 1));
      const [ax, ay] = qp(F0, F1, F2, t);
      const ang = angAt(t);
      let off = 0;                       // sit below whatever rows are above
      for (let k = 0; k < r.row; k++) off += lenAt(t, k) * .70;
      out.push(feather([ax + Math.cos(ang) * off, ay + Math.sin(ang) * off],
                       ang, lenAt(t, r.row), r.hw, r.camber));
    }
  }
  return out;
}

/* Head facing right: domed crown, brow over the eye, hooked beak, and the
 * ragged collar the badge's head sits in. */
/* Head facing right, traced off the badge: nape at x27.5, beak tip at x40.9
 * y19.3 — the tip well below the eye, which is what makes it an eagle. The
 * head is NOT mirrored; only the wings are. */
const HEAD = 'M27.5 16.2C27.7 13.5 29.3 11.8 31.5 11.8C33.6 11.8 34.7 13.1 35.0 14.7L36.4 15.2C38.3 15.9 40.1 17.2 40.9 19.3C40.4 18.5 39.5 18.1 38.2 17.9L36.9 17.8L37.9 19.5 L36.4 19.7 L36.6 21.7L35.8 24.6 L34.8 21.7 L33.7 25.1 L32.6 22.0 L31.4 25.0L30.4 21.8 L29.2 23.9 L28.5 20.6 L27.4 21.6L27.3 18.4 Z';
const EYE = 'M32.3 14.7Q33.9 13.3 35.9 13.4Q36.3 14.1 35.6 14.6Q34.0 15.2 32.3 14.7Z';

function body() {
  const out = [];

  // Breast: kept narrow. The badge hides this behind its shield, so anything
  // wider reads as a blob rather than as a bird.
  out.push('M30.0 21.6h4.0l.8 5.6c.35 2.4.15 4.8-.6 7.1h-4.4c-.75-2.3-.95-4.7-.6-7.1Z');

  // Tail: a compact rounded fan, widest down the middle
  for (let i = -2; i <= 2; i++) {
    const deg = i * 15;
    out.push(feather([32 + i * .5, 30.6], (90 + deg) * D, 13.8 - Math.abs(i) * 1.2,
                     2.8 - Math.abs(i) * .3, deg * .05));
  }

  // Legs out to the sides above the tail, three curling talons each
  for (const s of [-1, 1]) {
    const hip = 32 + s * 2.6;
    out.push(`M${n(hip - s * 1.4)} 30.6q${n(s * 1.5)} -.5 ${n(s * 3.0)} 0` +
             `l${n(s * 2.7)} 4.4-${n(s * 2.6)} 1.1Z`);
    for (let k = 0; k < 3; k++) {
      const a = (64 - k * 30) * D;
      out.push(feather([hip + s * (3.6 + k * .45), 35.4],
                       s > 0 ? a : Math.PI - a, 4.6 - k * .45, .6, s * -1.9));
    }
  }
  return out;
}

const mirror = (d) => `<path d="${d}" transform="translate(64,0) scale(-1,1)"/>`;

function buildEagleSvg({ adaptive = true } = {}) {
  const parts = [];
  for (const d of wing()) parts.push(`<path d="${d}"/>`, mirror(d));
  for (const d of body()) parts.push(`<path d="${d}"/>`);
  parts.push(`<path d="${HEAD}"/>`);          // the head faces right and is not mirrored

  const style = adaptive
    ? `    /* There is no plate behind the mark, so it has to hold on either tab
       colour: cream on dark browser chrome, ink on light. */
    .q { fill: #11141b }
    .eye { fill: #faf7ef }
    @media (prefers-color-scheme: dark) {
      .q { fill: #faf7ef }
      .eye { fill: #11141b }
    }`
    : `    .q { fill: #faf7ef }
    .eye { fill: #11141b }`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="LIBERTY MOTOVLOG">
  <style>
${style}
  </style>
  <g class="q">
${parts.map((p) => '    ' + p).join('\n')}
  </g>
  <path class="eye" d="${EYE}"/>
</svg>
`;
}

module.exports = { buildEagleSvg };
