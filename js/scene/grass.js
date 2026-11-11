/*
  Iskry · grass.js — the meadow: a November field in Poland at night, by the fire.
  OWNER: Opus worker "grass". Interface: CONTRACT.md (environment modules) + NEAR.md.

  createGrass(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), setTimeOfDay(tod), stats }
  opts { firePosition = FIRE, wind = 0.25 (m/s, +x), seed = 11, density = 1 }
  Placement comes from js/scene/layout.js (FIRE, ROAD + road maths, FENCE, SHRINE, BENCH, KEEP_OUT,
  ZONES); nothing here hard-codes a position that layout.js provides.

  What grows
    Instanced tussocks of individually modelled blades (curved, tapered, twisted, a few vertices
    each), live olive-green ones mixed with straw, grey-dead, bent and broken ones:
      turf    fine short turf patches (near)                         1 draw
      near    meadow tussocks + rank tussocks (fence line, corners)    2 draws
      mid     fewer, wider blades, 2 segments (12-20 m)              1 draw
      far     single-triangle blade cards, shrinking to nothing by 30 m 1 draw
    One merged mesh (world space) for the sparse species: timothy, cocksfoot and wild oat with
    their seed heads and awns, broken stalks, clover and plantain rosettes (ribwort with dark
    seed spikes), dandelion rosettes, low leafy forbs, dead rust bracken at the forest-side edges,
    a few male-fern shuttlecocks, dead spear thistles with pale pappus, docks with rusty seed
    spikes, nettle clumps along the fence and by the shrine, dry umbellifer skeletons (wild
    carrot "bird's nests"), and two surviving flowers (a yarrow, a dandelion).    1 draw
  Density and height come from slow noise patches shaped by layout.js: trampled short around the
  fire ring, the bench, the shrine foot, a desire path from the road to the fire and the road's
  crown and verges; bare on the ruts; tall and thick along the fence line and in the bottom
  corners; thinning and shrinking with distance; nothing beyond ZONES.nearReach.

  Shading: one MeshLambertMaterial (fog: true), patched. Wrap-lit by the fire's PointLights, with
  thin-leaf transmission and forward scattering so blades between us and the fire glow at their
  edges, dark silhouettes away from it; darker at the base (baked AO); per-instance colour
  variation; a dim night tone for unlit sides; a dew sheen and sparse droplet glints at grazing
  angles; the sky's low ground haze (same formula as sky.js) and scene.fog.
  Wind (vertex shader): bend grows with the square of the height; gust waves travel across the
  field in +x; stalks sway slower than blades; a small flutter. Reduced motion: still (lean only).
  No per-frame allocations: update() writes two uniforms. No global side effects.
*/
import * as THREE from 'three';
import {
  CAMERA, FIRE, ZONES, ROAD, FENCE, SHRINE, KEEP_OUT, inKeepOut, roadPoint, distanceFromCenter,
} from './layout.js';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,              // m/s toward +x
  seed: 11,
  density: 1,              // multiplies every instance count (0.5 for weak GPUs)
  hazeColor: '#372013',    // sky.js's low ground haze (sRGB)
  nightTone: '#0f0a07',    // unlit grass (sRGB) before AO and the sky-facing lift
  lodNear: 12.5,           // m from ZONES.center: full tussocks ...
  lodMid: 20,              // ... then 2-segment blades, then single-triangle cards
  fireNear: 5.5,           // m: full detail this close to the fire whatever the distance
};
const TAU = Math.PI * 2;

// --------------------------------------------------------------- utilities
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // sRGB hex -> linear
const mixC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mulC = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

// cheap 2D value noise for the planting patches (CPU)
function hash2(ix, iz, s) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s), c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}
const fbm = (x, z, s) => 0.62 * vnoise(x, z, s) + 0.38 * vnoise(x * 2.07 + 3.1, z * 2.07 - 1.7, s + 7);

// November palette (sRGB in, linear out)
const PAL = {
  live: C('#4c5728'), olive: C('#6b6b3a'), oliveD: C('#3f4722'), sage: C('#66703c'),
  ochre: C('#8c7440'), straw: C('#9a8a68'), strawP: C('#ab9c78'), grey: C('#7d7464'),
  rust: C('#7a5a34'), umber: C('#5a4630'), umberD: C('#3c2e20'),
  bracken: C('#7a4a2a'), brackenD: C('#553420'), brackenP: C('#8e6438'),
  dock: C('#6e3018'), dockD: C('#4e2312'), dockR: C('#84401d'),
  fluff: C('#cbbf9f'), headD: C('#3a2b1d'), timothy: C('#7e6d49'),
  clover: C('#3b4a23'), cloverP: C('#69764f'), nettle: C('#35411f'), nettleL: C('#4b5529'),
  yarrow: C('#d6cfbb'), dandel: C('#d9a223'), dandelC: C('#b77d12'),
};

// ------------------------------------------------------------ geometry kit
// Growable typed arrays: position, normal, color, aWind (flex, phase, freq, ao), aMat (u, v, trans, dew).
class Geo {
  constructor(cap = 8192) {
    this.n = 0; this.cap = cap;
    this.pos = new Float32Array(cap * 3); this.nor = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.wnd = new Float32Array(cap * 4); this.mat = new Float32Array(cap * 4);
    this.idx = new Uint32Array(cap * 2); this.ni = 0;
    // per-element state
    this.flex = 1; this.phase = 0; this.freq = 1; this.trans = 1; this.dew = 1;
    this.aoH = 0.3; this.aoMin = 0.3; this.aoY0 = 0;
  }
  _grow() {
    const g = (a, k) => { const b = new a.constructor(this.cap * 2 * k); b.set(a); return b; };
    this.pos = g(this.pos, 3); this.nor = g(this.nor, 3); this.col = g(this.col, 3);
    this.wnd = g(this.wnd, 4); this.mat = g(this.mat, 4);
    this.cap *= 2;
  }
  v(x, y, z, nx, ny, nz, c, u, t) {
    if (this.n >= this.cap) this._grow();
    const i = this.n++, i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    this.nor[i3] = nx / nl; this.nor[i3 + 1] = ny / nl; this.nor[i3 + 2] = nz / nl;
    this.col[i3] = c[0]; this.col[i3 + 1] = c[1]; this.col[i3 + 2] = c[2];
    const ao = this.aoMin + (1 - this.aoMin) * Math.pow(smooth(this.aoY0, this.aoY0 + this.aoH, y), 0.8);
    this.wnd[i4] = this.flex; this.wnd[i4 + 1] = this.phase; this.wnd[i4 + 2] = this.freq; this.wnd[i4 + 3] = ao;
    this.mat[i4] = u; this.mat[i4 + 1] = t; this.mat[i4 + 2] = this.trans; this.mat[i4 + 3] = this.dew;
    return i;
  }
  t(a, b, c) {
    if (this.ni + 3 > this.idx.length) { const b2 = new Uint32Array(this.idx.length * 2); b2.set(this.idx); this.idx = b2; }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  get tris() { return this.ni / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    g.setAttribute('aWind', new THREE.BufferAttribute(this.wnd.slice(0, n * 4), 4));
    g.setAttribute('aMat', new THREE.BufferAttribute(this.mat.slice(0, n * 4), 4));
    const idx = n < 65536 ? new Uint16Array(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// A curve integrated from its tilt: th(s) = th + kap*s + kap2*s^2 (+ kinkBy past kinkAt), from
// vertical, leaning toward heading psi. Returns levels [x, y, z, tx, ty, tz, nx, ny, nz, sx, sy, sz]
// (tangent, face normal and side, with the twist applied). Never dips below y = 0.004.
function curve(o) {
  const seg = o.seg, L = o.len, ds = L / seg;
  const cp = Math.cos(o.psi), sp = Math.sin(o.psi);
  const kap = o.kap || 0, kap2 = o.kap2 || 0, tw = o.twist || 0;
  const kinkAt = o.kinkAt === undefined ? 2 : o.kinkAt, kinkBy = o.kinkBy || 0;
  const theta = (s) => o.th + kap * s + kap2 * s * s + (s / L > kinkAt ? kinkBy : 0);
  let x = o.x, y = o.y || 0, z = o.z;
  const out = [];
  for (let i = 0; i <= seg; i++) {
    const s = i * ds;
    if (i > 0) {
      const tm = theta(s - ds * 0.5), st = Math.sin(tm), ct = Math.cos(tm);
      x += st * cp * ds; y += ct * ds; z += st * sp * ds;
      if (y < 0.004) y = 0.004;
    }
    const th = theta(s), st = Math.sin(th), ct = Math.cos(th);
    let tx = st * cp, ty = ct, tz = st * sp;
    // face normal in the bending plane (points up when the curve lies flat) and the side
    let nx = -ct * cp, ny = st, nz = -ct * sp;
    let sx = -sp, sy = 0, sz = cp;
    const ph = tw * (i / seg);
    if (ph !== 0) {
      const c = Math.cos(ph), s2 = Math.sin(ph);
      const ax = sx * c + nx * s2, ay = sy * c + ny * s2, az = sz * c + nz * s2;
      const bx = nx * c - sx * s2, by = ny * c - sy * s2, bz = nz * c - sz * s2;
      sx = ax; sy = ay; sz = az; nx = bx; ny = by; nz = bz;
    }
    out.push([x, y, z, tx, ty, tz, nx, ny, nz, sx, sy, sz]);
  }
  return out;
}

// A flat ribbon along a curve: blades, leaves, pinnae, awns, rays.
// hw(t, i) is the half width (0 at the last level makes a pointed tip). col(t) or cA -> cB.
// tilt bends the edge normals outward (reads as a rounded or folded leaf). mid adds a midrib vertex.
function ribbon(B, pts, hw, o) {
  const seg = pts.length - 1;
  const tilt = o.tilt === undefined ? 0.5 : o.tilt;
  const mid = !!o.mid, crease = o.crease || 0;
  const cA = o.cA, cB = o.cB || o.cA, cP = o.cPow || 1, midC = o.midC || 1;
  let prevL = -1, prevM = -1, prevR = -1;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, p = pts[i];
    const w = hw(t, i);
    const c = o.col ? o.col(t, i) : mixC(cA, cB, Math.pow(t, cP));
    const nx = p[6], ny = p[7], nz = p[8], sx = p[9], sy = p[10], sz = p[11];
    if (w <= 0 && i === seg) {
      const tip = B.v(p[0], p[1], p[2], nx, ny, nz, c, 0, t);
      if (prevL >= 0) {
        if (mid) { B.t(prevL, prevM, tip); B.t(prevM, prevR, tip); }
        else B.t(prevL, prevR, tip);
      }
      break;
    }
    const l = B.v(p[0] - sx * w, p[1] - sy * w, p[2] - sz * w, nx - sx * tilt, ny - sy * tilt, nz - sz * tilt, c, -1, t);
    let m = -1;
    if (mid) {
      const cm = mulC(c, midC);
      m = B.v(p[0] + nx * w * crease, p[1] + ny * w * crease, p[2] + nz * w * crease, nx, ny, nz, cm, 0, t);
    }
    const r = B.v(p[0] + sx * w, p[1] + sy * w, p[2] + sz * w, nx + sx * tilt, ny + sy * tilt, nz + sz * tilt, c, 1, t);
    if (prevL >= 0) {
      if (mid) { B.t(prevL, prevM, l); B.t(prevM, m, l); B.t(prevM, prevR, m); B.t(prevR, r, m); }
      else { B.t(prevL, prevR, l); B.t(prevR, r, l); }
    }
    prevL = l; prevM = m; prevR = r;
  }
}

// A round stalk or spike along a curve: n-sided rings with radial normals. r(t, i) radius.
// jit roughens the radius per vertex (seed heads). capTip closes the end to a point.
function prism(B, pts, r, n, o) {
  const seg = pts.length - 1;
  const cA = o.cA, cB = o.cB || o.cA;
  const jit = o.jit || 0, rng = o.rng;
  let prev = -1;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, p = pts[i];
    const c = o.col ? o.col(t, i) : mixC(cA, cB, t);
    const nx = p[6], ny = p[7], nz = p[8], sx = p[9], sy = p[10], sz = p[11];
    let rad = r(t, i);
    if (o.capTip && i === seg) {
      const tip = B.v(p[0], p[1], p[2], p[3], p[4], p[5], c, 0, t);
      if (prev >= 0) for (let k = 0; k < n; k++) B.t(prev + k, prev + ((k + 1) % n), tip);
      break;
    }
    const base = B.n;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + (i & 1 ? Math.PI / n : 0) * (o.twistRings ? 1 : 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      const rx = sx * ca + nx * sa, ry = sy * ca + ny * sa, rz = sz * ca + nz * sa;
      const rr = rad * (1 + (jit ? (rng() * 2 - 1) * jit : 0));
      B.v(p[0] + rx * rr, p[1] + ry * rr, p[2] + rz * rr, rx, ry, rz, c, ca, t);
    }
    if (prev >= 0) {
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        B.t(prev + k, prev + k1, base + k); B.t(prev + k1, base + k1, base + k);
      }
    }
    prev = base;
  }
}

// A small closed lump (octahedron): florets, fruit clusters, involucres. Axis (ax, ay, az).
function blob(B, x, y, z, rAx, rSide, ax, ay, az, c, rng, jit = 0.25) {
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  // a side vector not parallel to the axis
  let sx = -az, sy = 0, sz = ax;
  if (Math.abs(ax) < 0.1 && Math.abs(az) < 0.1) { sx = 1; sy = 0; sz = 0; }
  const sl = Math.hypot(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
  const bx = ay * sz - az * sy, by = az * sx - ax * sz, bz = ax * sy - ay * sx;
  const j = () => 1 + (rng() * 2 - 1) * jit;
  const d = [[ax * rAx, ay * rAx, az * rAx], [-ax * rAx * 0.8, -ay * rAx * 0.8, -az * rAx * 0.8],
    [sx * rSide, sy * rSide, sz * rSide], [-sx * rSide, -sy * rSide, -sz * rSide],
    [bx * rSide, by * rSide, bz * rSide], [-bx * rSide, -by * rSide, -bz * rSide]];
  const base = B.n;
  for (let k = 0; k < 6; k++) {
    const q = j();
    B.v(x + d[k][0] * q, Math.max(0.003, y + d[k][1] * q), z + d[k][2] * q, d[k][0], d[k][1], d[k][2], c, 0, k === 0 ? 1 : 0.5);
  }
  const T = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]];
  for (const f of T) B.t(base + f[0], base + f[1], base + f[2]);
}

// a straight curve from a point along a direction (for heads and branches continuing a stalk)
function curveFrom(p, th, psi, len, seg, kap = 0, extra) {
  return curve(Object.assign({ x: p[0], y: p[1], z: p[2], psi, th, len, seg, kap }, extra));
}
// tilt and heading of a tangent
const tiltOf = (p) => Math.acos(clamp(p[4], -1, 1));
const headOf = (p) => Math.atan2(p[5], p[3]);

// width profiles (half widths)
const W = {
  blade: (w) => (t) => (t >= 1 ? 0 : w * (0.72 + 0.28 * Math.min(1, t * 5)) * Math.pow(Math.min(1, (1 - t) / 0.55), 0.85)),
  needle: (w) => (t) => (t >= 1 ? 0 : w * (1 - t)),
  lance: (w) => (t) => (t >= 1 ? 0 : w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.8) + w * 0.08 * (1 - t)),
  ovate: (w) => (t) => (t >= 1 ? 0 : w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.6)), 0.7)),
  tooth: (w, k = 0.45) => (t, i) => (t >= 1 ? 0 : w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.6) * (i & 1 ? 1 : k)),
  pinna: (w) => (t, i) => (t >= 1 ? 0 : w * Math.pow(1 - t, 0.5) * (i & 1 ? 1 : 0.3)),
  const: (w) => () => w,
};

// --------------------------------------------------------------- species
// Every builder plants at (x, z) in the current Geo frame (local for instanced tussocks, world for the
// merged sparse mesh) and sets the per-element wind / material state itself.

// One grass blade: live (olive green, tip drying), dry (straw), dead (grey, bent over or broken).
function grassBlade(B, rng, x, z, psi, h, w, kind, seg, extra = 0) {
  const R = (a, b) => a + (b - a) * rng();
  let th, kap, kap2 = 0, kinkAt, kinkBy = 0, cA, cB, cPow = 1.4;
  if (kind === 0) {               // live
    th = R(0.04, 0.32); kap = R(0.3, 1.5) / Math.max(0.15, h) * 0.45;
    cA = mixC(PAL.oliveD, PAL.live, rng()); cB = rng() < 0.55 ? mixC(PAL.olive, PAL.ochre, R(0.2, 0.9)) : mixC(PAL.sage, PAL.olive, rng());
    B.trans = 1.0; B.dew = 1;
  } else if (kind === 1) {        // dry straw, still standing, arching
    th = R(0.1, 0.45); kap = R(0.8, 2.2) / Math.max(0.15, h) * 0.45;
    cA = mixC(PAL.umber, PAL.rust, rng()); cB = mixC(PAL.straw, PAL.strawP, rng()); cPow = 0.8;
    B.trans = 0.8; B.dew = 0.9;
  } else {                        // dead: bent over to the ground or broken half way
    th = R(0.15, 0.6);
    if (rng() < 0.5) { kap = R(2.4, 4.2) / Math.max(0.15, h) * 0.5; kap2 = R(0, 2) / (h * h); }
    else { kap = R(0.2, 0.8); kinkAt = R(0.3, 0.65); kinkBy = R(1.0, 2.1); }
    cA = mixC(PAL.umberD, PAL.umber, rng()); cB = mixC(PAL.grey, PAL.straw, R(0, 0.6)); cPow = 0.7;
    B.trans = 0.55; B.dew = 0.7;
  }
  th += extra;
  B.flex = R(0.9, 1.5); B.phase = rng() * TAU; B.freq = R(0.8, 1.2);
  const pts = curve({ x, z, psi, th, kap, kap2, kinkAt, kinkBy, len: h, seg, twist: R(-1.1, 1.1) });
  ribbon(B, pts, W.blade(w * 0.5), { cA, cB, cPow, tilt: 0.55 });
}

// Tussock (local frame, origin at the root): blades leaning outward from a crowded crown.
function tussock(rng, p) {
  const R = (a, b) => a + (b - a) * rng();
  const B = new Geo(p.blades * (p.seg * 2 + 2) + 16);
  B.aoH = p.hRef * 0.75; B.aoMin = p.aoMin;
  for (let b = 0; b < p.blades; b++) {
    const r = p.spread * Math.sqrt(rng()), a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const u = rng();
    const kind = u < p.live ? 0 : u < p.live + p.dry ? 1 : 2;
    // outer blades lean out more, inner ones stand up: a tussock, not a broom
    const out = r / Math.max(1e-3, p.spread);
    const psi = a + R(-0.7, 0.7);
    const h = p.hRef * R(p.hMin, 1) * (1 - 0.25 * out * rng());
    const w = R(p.wMin, p.wMax) * p.widen;
    grassBlade(B, rng, x, z, psi, h, w, kind, p.seg, out * p.splay);
  }
  return B;
}

// Seed-head grasses
function stalkBase(B, rng, x, z, H, o = {}) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = o.flex || R(0.55, 0.8); B.phase = rng() * TAU; B.freq = R(0.35, 0.55); B.trans = 0.45; B.dew = 0.5;
  const psi = rng() * TAU;
  const pts = curve({ x, z, psi, th: R(0.02, 0.16), kap: R(-0.15, 0.35), len: H, seg: o.seg || 4,
    kinkAt: o.kinkAt, kinkBy: o.kinkBy || 0 });
  const wv = o.widen || 1;
  const cA = o.cA || mixC(PAL.umber, PAL.rust, rng()), cB = o.cB || mixC(PAL.straw, PAL.ochre, rng());
  prism(B, pts, (t) => (0.0016 - 0.0006 * t) * wv, 3, { cA, cB });
  // one or two leaves sheathing the stalk low down, arching out
  const nl = rng() < 0.6 ? 2 : 1;
  for (let k = 0; k < nl; k++) {
    const p = pts[1 + k];
    B.flex = 1.1; B.trans = 0.75;
    const lp = curve({ x: p[0], y: p[1], z: p[2], psi: psi + R(1.5, 4.7), th: R(0.4, 0.9), kap: R(4, 9), len: R(0.1, 0.22), seg: 3, twist: R(-0.8, 0.8) });
    ribbon(B, lp, W.blade(0.003 * wv), { cA: mixC(PAL.rust, PAL.straw, rng()), cB: mixC(PAL.grey, PAL.strawP, rng()), tilt: 0.5 });
  }
  B.flex = o.flex || 0.7; B.trans = 0.45;
  return pts;
}

function timothy(B, rng, x, z, H, wv) {
  const R = (a, b) => a + (b - a) * rng();
  const broken = rng() < 0.12;
  const pts = stalkBase(B, rng, x, z, H, { widen: wv, kinkAt: broken ? R(0.55, 0.8) : undefined, kinkBy: broken ? R(1.6, 2.4) : 0 });
  const top = pts[pts.length - 1];
  const len = R(0.05, 0.1), rad = R(0.0032, 0.0042) * Math.min(1.8, wv);
  const hp = curveFrom(top, tiltOf(top), headOf(top), len, 4, 0);
  const cH = mixC(PAL.timothy, PAL.umber, R(0, 0.6));
  B.trans = 0.35; B.dew = 0.8;
  prism(B, hp, (t) => rad * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.35), 5, { cA: mulC(cH, 0.85), cB: cH, jit: 0.22, rng, capTip: true });
}

function cocksfoot(B, rng, x, z, H, wv) {
  const R = (a, b) => a + (b - a) * rng();
  const pts = stalkBase(B, rng, x, z, H, { widen: wv });
  const top = pts[pts.length - 1];
  const side = rng() * TAU;
  const cH = mixC(PAL.rust, PAL.umber, rng()), cH2 = mixC(PAL.straw, PAL.rust, R(0.3, 0.8));
  B.trans = 0.35; B.dew = 0.6;
  // dense clusters on stiff one-sided branches; the lowest the longest
  const nC = 3 + ((rng() * 3) | 0);
  for (let k = 0; k < nC; k++) {
    const f = k / nC;
    const base = [top[0] + top[3] * f * 0.06, top[1] + top[4] * f * 0.06, top[2] + top[5] * f * 0.06];
    const bl = k === nC - 1 ? 0.002 : R(0.012, 0.05) * (1 - f * 0.7);
    const bp = curve({ x: base[0], y: base[1], z: base[2], psi: side + R(-0.8, 0.8), th: R(0.45, 0.9) * (1 - f * 0.6), len: bl, seg: 1 });
    if (bl > 0.004) ribbon(B, bp, W.const(0.0006 * wv), { cA: cH2, tilt: 0.9 });
    const e = bp[bp.length - 1];
    // a dense knot of flattened spikelets, mostly pointing up and out
    const sz = R(0.007, 0.011) * Math.min(1.5, wv), cc = mixC(cH, cH2, rng());
    const nk = 4;
    for (let q = 0; q < nk; q++) {
      const sp = curve({ x: e[0], y: e[1], z: e[2], psi: rng() * TAU, th: R(0.1, 1.1), kap: R(-8, 8), len: sz * R(0.8, 1.3), seg: 2, twist: R(-1, 1) });
      ribbon(B, sp, W.lance(sz * 0.32), { cA: mulC(cc, 0.8), cB: mixC(cc, PAL.straw, 0.25), tilt: 0.4 });
    }
  }
}

function wildOat(B, rng, x, z, H, wv) {
  const R = (a, b) => a + (b - a) * rng();
  const pts = stalkBase(B, rng, x, z, H, { widen: wv, seg: 6 });
  const n = pts.length - 1;
  B.trans = 0.6; B.dew = 0.6;
  const cS = mixC(PAL.strawP, PAL.straw, rng()), cA = mixC(PAL.rust, PAL.umber, rng());
  // whorls of thin branches on the top quarter, each with a nodding spikelet and a bent awn
  for (let wl = 0; wl < 3; wl++) {
    const p = pts[n - wl];
    const nb = 2 + ((rng() * 2) | 0) - (wl === 0 ? 1 : 0);
    for (let k = 0; k < nb; k++) {
      const psi = rng() * TAU;
      const bp = curve({ x: p[0], y: p[1], z: p[2], psi, th: R(0.7, 1.25), kap: R(4, 9), len: R(0.03, 0.07), seg: 2 });
      ribbon(B, bp, W.const(0.0005 * wv), { cA: cS, tilt: 0.9 });
      const e = bp[bp.length - 1];
      // spikelet: two crossed narrow husks hanging down
      const sl = R(0.018, 0.026);
      for (const tw of [0, Math.PI / 2]) {
        const sp = curve({ x: e[0], y: e[1], z: e[2], psi: psi + tw * 0.3, th: Math.PI - R(0.15, 0.45), len: sl, seg: 2, twist: tw });
        ribbon(B, sp, W.lance(0.0028 * Math.min(1.5, wv)), { cA: cS, cB: mixC(cS, PAL.fluff, 0.3), tilt: 0.3 });
      }
      // the awn: from the husk's back, bent at a knee
      const a0 = curve({ x: e[0], y: e[1] - sl * 0.4, z: e[2], psi: psi + Math.PI, th: R(0.3, 0.9), len: R(0.025, 0.035), seg: 2, kinkAt: 0.45, kinkBy: R(0.6, 1.1) });
      ribbon(B, a0, W.needle(0.0005 * wv), { cA, tilt: 0.9 });
    }
  }
}

// dried bent-grass panicle: a fine reddish haze of tiny branchlets
function bentGrass(B, rng, x, z, H, wv) {
  const R = (a, b) => a + (b - a) * rng();
  const pts = stalkBase(B, rng, x, z, H * 0.85, { widen: wv });
  const n = pts.length - 1;
  B.trans = 0.7; B.dew = 0.5;
  const c = mixC(PAL.rust, PAL.dock, R(0.1, 0.5));
  for (let k = 0; k < 9; k++) {
    const p = pts[n - (k % 2)];
    const bp = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(0.3, 1.0), kap: R(-3, 3), len: R(0.02, 0.06), seg: 1 });
    ribbon(B, bp, W.needle(0.0011 * wv), { cA: c, cB: mixC(c, PAL.straw, 0.4), tilt: 0.9 });
  }
}

// rosettes and low forbs ------------------------------------------------
function plantain(B, rng, x, z, wv, broad) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.35; B.phase = rng() * TAU; B.freq = 0.9; B.trans = 0.9; B.dew = 1;
  B.aoH = 0.05; B.aoMin = 0.45;
  const nL = broad ? 4 + ((rng() * 4) | 0) : 5 + ((rng() * 6) | 0);
  const g0 = rng() * TAU;
  for (let k = 0; k < nL; k++) {
    const psi = g0 + k * 2.39996 + R(-0.2, 0.2);
    const len = broad ? R(0.08, 0.15) : R(0.1, 0.22);
    const pts = curve({ x, z, psi, th: broad ? R(1.25, 1.5) : R(0.8, 1.3), kap: broad ? R(-2, -0.5) : R(-1.8, 0.4), len, seg: 4, twist: R(-0.3, 0.3) });
    const c = rng() < 0.25 ? mixC(PAL.olive, PAL.rust, R(0.3, 0.9)) : mixC(PAL.oliveD, PAL.live, rng());
    ribbon(B, pts, broad ? W.ovate(len * 0.33) : W.lance(R(0.006, 0.009)), { cA: mulC(c, 0.8), cB: c, mid: true, crease: 0.12, midC: 1.25, tilt: 0.25 });
  }
  if (!broad) {
    // ribwort's dark seed spikes on thin furrowed stalks
    const nS = (rng() * 3.2) | 0;
    for (let k = 0; k < nS; k++) {
      B.flex = 0.6; B.freq = 0.5; B.trans = 0.4;
      const sp = curve({ x, z, psi: rng() * TAU, th: R(0.1, 0.45), kap: R(-0.5, 1.2), len: R(0.15, 0.32), seg: 3 });
      prism(B, sp, () => 0.0011 * wv, 3, { cA: PAL.umber, cB: PAL.straw });
      const e = sp[sp.length - 1];
      const hp = curveFrom(e, tiltOf(e), headOf(e), R(0.015, 0.028), 3);
      prism(B, hp, (t) => 0.0042 * Math.min(1.6, wv) * Math.pow(Math.sin(Math.PI * (0.1 + 0.8 * t)), 0.4), 5, { cA: PAL.headD, cB: mixC(PAL.headD, PAL.umber, 0.5), jit: 0.15, rng, capTip: true });
    }
  }
}

function clover(B, rng, x, z) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.5; B.phase = rng() * TAU; B.freq = 1.1; B.trans = 1; B.dew = 1;
  B.aoH = 0.06; B.aoMin = 0.4;
  const nL = 5 + ((rng() * 6) | 0);
  for (let k = 0; k < nL; k++) {
    const a = rng() * TAU, r = R(0, 0.11);
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    const pet = curve({ x: px, z: pz, psi: rng() * TAU, th: R(0.15, 0.6), kap: R(-2, 4), len: R(0.035, 0.08), seg: 2 });
    ribbon(B, pet, W.const(0.0006), { cA: PAL.oliveD, tilt: 0.9 });
    const e = pet[2];
    const g = rng() * TAU, ls = R(0.8, 1.2);
    const c = rng() < 0.2 ? mixC(PAL.clover, PAL.rust, 0.5) : PAL.clover;
    for (let l = 0; l < 3; l++) {
      const lp = curve({ x: e[0], y: e[1], z: e[2], psi: g + l * TAU / 3, th: R(1.2, 1.55), kap: R(-6, 2), len: 0.012 * ls, seg: 2 });
      ribbon(B, lp, W.ovate(0.0065 * ls), { cA: c, cB: c, mid: true, crease: 0.1, midC: 1.0, tilt: 0.25,
        col: (t) => mixC(c, PAL.cloverP, t > 0.2 && t < 0.7 ? 0.25 : 0) });
    }
  }
}

function dandelionRosette(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.3; B.phase = rng() * TAU; B.freq = 0.8; B.trans = 0.9; B.dew = 1;
  B.aoH = 0.05; B.aoMin = 0.45;
  const nL = 6 + ((rng() * 4) | 0), g0 = rng() * TAU;
  for (let k = 0; k < nL; k++) {
    const len = R(0.09, 0.2);
    const pts = curve({ x, z, psi: g0 + k * 2.39996, th: R(1.1, 1.42), kap: R(-1.5, -0.2), len, seg: 7 });
    const c = rng() < 0.3 ? mixC(PAL.olive, PAL.umber, R(0.2, 0.8)) : mixC(PAL.oliveD, PAL.sage, rng() * 0.6);
    ribbon(B, pts, W.tooth(R(0.012, 0.02), 0.4), { cA: c, mid: true, crease: 0.1, midC: 1.3, tilt: 0.2 });
  }
}

function lowForb(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.8; B.phase = rng() * TAU; B.freq = 1.0; B.trans = 0.95; B.dew = 1;
  B.aoH = 0.12; B.aoMin = 0.35;
  const nS = 2 + ((rng() * 3) | 0);
  const yellow = rng() < 0.35;
  for (let s = 0; s < nS; s++) {
    const st = curve({ x: x + R(-0.05, 0.05), z: z + R(-0.05, 0.05), psi: rng() * TAU, th: R(0.3, 0.9), kap: R(0.5, 3), len: R(0.08, 0.2), seg: 3 });
    prism(B, st, () => 0.0012 * wv, 3, { cA: PAL.oliveD, cB: PAL.live });
    for (let k = 1; k < st.length; k++) {
      const p = st[k];
      for (const sgn of [-1, 1]) {
        const lp = curve({ x: p[0], y: p[1], z: p[2], psi: headOf(p) + sgn * R(1.2, 1.9), th: R(1.0, 1.5), kap: R(2, 8), len: R(0.016, 0.03), seg: 2 });
        const c = yellow ? mixC(PAL.olive, PAL.ochre, R(0.2, 0.8)) : mixC(PAL.oliveD, PAL.sage, rng());
        ribbon(B, lp, W.ovate(R(0.008, 0.013)), { cA: c, mid: true, crease: 0.15, midC: 1.15, tilt: 0.3 });
      }
    }
  }
}

// edges of the forest ---------------------------------------------------
function bracken(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.45; B.phase = rng() * TAU; B.freq = 0.35; B.trans = 0.65; B.dew = 0.5;
  B.aoH = 0.5; B.aoMin = 0.3;
  const psi = rng() * TAU;
  const collapsed = rng() < 0.35;
  const stipe = curve({ x, z, psi, th: R(0.08, 0.3), kap: R(0.3, 1.2) + (collapsed ? 1.6 : 0), len: R(0.3, 0.65), seg: 3 });
  const dead = rng() < 0.82;
  const cS = dead ? mixC(PAL.brackenD, PAL.umber, rng()) : PAL.oliveD;
  prism(B, stipe, (t) => (0.003 - 0.0012 * t) * wv, 3, { cA: PAL.umberD, cB: cS });
  const e = stipe[stipe.length - 1];
  const rl = R(0.45, 0.85);
  const rach = curve({ x: e[0], y: e[1], z: e[2], psi, th: tiltOf(e), kap: R(1.2, 2.4) + (collapsed ? 1.2 : 0), len: rl, seg: 8 });
  ribbon(B, rach, W.needle(0.0018 * wv), { cA: cS, tilt: 0.9 });
  const nP = 7;
  for (let k = 1; k < rach.length - 1 && k <= nP; k++) {
    const p = rach[k], f = k / rach.length;
    const pl = rl * 0.42 * Math.pow(1 - f, 0.9) * R(0.85, 1.1);
    for (const sgn of [-1, 1]) {
      const c = dead ? mixC(PAL.bracken, rng() < 0.5 ? PAL.brackenP : PAL.brackenD, rng()) : mixC(PAL.olive, PAL.bracken, R(0.2, 0.7));
      const pp = curve({ x: p[0], y: p[1], z: p[2], psi: headOf(p) + sgn * R(1.05, 1.3), th: Math.PI / 2 + R(-0.15, 0.3) + (collapsed ? 0.3 : 0), kap: R(0.5, 2.5), len: pl, seg: 6, twist: sgn * R(0, 0.5) });
      ribbon(B, pp, W.pinna(R(0.009, 0.013) * Math.min(1.4, wv)), { cA: mulC(c, 0.85), cB: c, tilt: 0.45 });
    }
  }
}

function maleFern(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.5; B.phase = rng() * TAU; B.freq = 0.4; B.trans = 0.85; B.dew = 0.8;
  B.aoH = 0.45; B.aoMin = 0.25;
  const nF = 5 + ((rng() * 4) | 0), g0 = rng() * TAU;
  for (let f = 0; f < nF; f++) {
    const psi = g0 + f * TAU / nF + R(-0.3, 0.3);
    const L = R(0.45, 0.8);
    const rach = curve({ x: x + Math.cos(psi) * 0.03, z: z + Math.sin(psi) * 0.03, psi, th: R(0.3, 0.6), kap: R(1.4, 2.4), len: L, seg: 10 });
    const brown = rng() < 0.4;
    const cR = brown ? PAL.rust : PAL.oliveD;
    ribbon(B, rach, W.needle(0.0022 * wv), { cA: PAL.umberD, cB: cR, tilt: 0.9 });
    for (let k = 1; k < rach.length - 1; k++) {
      const p = rach[k], u = k / rach.length;
      const pl = L * 0.2 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 0.8);
      for (const sgn of [-1, 1]) {
        const c = brown ? mixC(PAL.rust, PAL.ochre, rng()) : mixC(PAL.live, u > 0.7 ? PAL.ochre : PAL.olive, rng() * 0.6);
        const pp = curve({ x: p[0], y: p[1], z: p[2], psi: headOf(p) + sgn * 1.25, th: Math.PI / 2 + R(0, 0.35), kap: R(1, 4), len: pl, seg: 2 });
        ribbon(B, pp, W.lance(0.008 * Math.min(1.3, wv)), { cA: c, mid: true, crease: 0.15, midC: 0.85, tilt: 0.3 });
      }
    }
  }
}

// tall forbs --------------------------------------------------------------
function thistle(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.4; B.phase = rng() * TAU; B.freq = 0.4; B.trans = 0.4; B.dew = 0.5;
  B.aoH = 0.5; B.aoMin = 0.3;
  const H = R(0.7, 1.2), psi = rng() * TAU;
  const stem = curve({ x, z, psi, th: R(0.03, 0.15), kap: R(-0.2, 0.3), len: H, seg: 6 });
  const cSt = mixC(PAL.umberD, PAL.umber, rng());
  prism(B, stem, (t) => (0.0045 - 0.0025 * t) * wv, 4, { cA: PAL.umberD, cB: cSt });
  const heads = [stem[stem.length - 1]];
  const nB = 2 + ((rng() * 3) | 0);
  for (let k = 0; k < nB; k++) {
    const p = stem[4 + (k % 2)];
    const br = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(0.45, 0.8), kap: R(-2.5, -0.8), len: R(0.1, 0.25), seg: 3 });
    prism(B, br, () => 0.002 * wv, 3, { cA: cSt });
    heads.push(br[br.length - 1]);
  }
  // spiny leaves, dead and drooping
  for (let k = 1; k <= 4; k++) {
    const p = stem[k];
    const lp = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(1.1, 1.6), kap: R(3, 8), len: R(0.1, 0.2), seg: 7, twist: R(-0.6, 0.6) });
    ribbon(B, lp, W.tooth(R(0.012, 0.02), 0.3), { cA: PAL.umberD, cB: mixC(PAL.umber, PAL.rust, rng()), mid: true, crease: 0.2, midC: 1.2, tilt: 0.3 });
  }
  for (const h of heads) {
    const r = R(0.009, 0.013) * Math.min(1.5, wv);
    B.trans = 0.3;
    // the involucre: an egg of spiny bracts, a little ragged
    const hp = curve({ x: h[0], y: h[1] - r * 0.3, z: h[2], psi: headOf(h), th: tiltOf(h) * 0.5, len: r * 2.0, seg: 3 });
    const cI = mixC(PAL.headD, PAL.umberD, rng());
    prism(B, hp, (t) => r * (0.35 + 0.75 * Math.sin(Math.PI * (0.15 + 0.7 * t))), 6, { cA: mulC(cI, 0.8), cB: cI, jit: 0.18, rng, twistRings: true });
    // the pappus: pale silky hairs spilling out of the top, they catch the fire
    B.trans = 1.25; B.dew = 0.2; B.flex = 0.7;
    const nh = 12;
    for (let k = 0; k < nh; k++) {
      const pp = curve({ x: hp[3][0], y: hp[3][1], z: hp[3][2], psi: (k / nh) * TAU + R(-0.2, 0.2), th: R(0.2, 1.1), kap: R(4, 14), len: R(0.012, 0.024), seg: 2 });
      ribbon(B, pp, W.needle(0.0016 * Math.min(1.5, wv)), { cA: mixC(PAL.fluff, PAL.straw, 0.4), cB: PAL.fluff, tilt: 0.7 });
    }
    B.flex = 0.4; B.trans = 0.4; B.dew = 0.5;
  }
}

function dock(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.32; B.phase = rng() * TAU; B.freq = 0.32; B.trans = 0.3; B.dew = 0.4;
  B.aoH = 0.4; B.aoMin = 0.3;
  const H = R(0.65, 1.1), psi = rng() * TAU;
  const stem = curve({ x, z, psi, th: R(0.03, 0.12), kap: R(-0.1, 0.25), len: H, seg: 8 });
  const cSt = mixC(PAL.dockD, PAL.dock, rng());
  prism(B, stem, (t) => (0.004 - 0.0022 * t) * wv, 4, { cA: PAL.umberD, cB: cSt });
  const spikes = [stem.slice(4)];
  const nB = 3 + ((rng() * 3) | 0);
  for (let k = 0; k < nB; k++) {
    const p = stem[4 + (k % 3)];
    const br = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(0.35, 0.65), kap: R(-2.2, -0.6), len: R(0.12, 0.3), seg: 4 });
    prism(B, br, () => 0.0018 * wv, 3, { cA: cSt });
    spikes.push(br.slice(1));
  }
  // whorls of three-winged fruits, rust to dark brown
  const cf = [PAL.dock, PAL.dockR, PAL.dockD];
  for (const sp of spikes) {
    for (let k = 0; k < sp.length - 1; k++) {
      const a = sp[k], b = sp[k + 1];
      const segL = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const nW = Math.max(1, Math.round(segL / 0.03));
      for (let w = 0; w < nW; w++) {
        const f = (w + rng() * 0.5) / nW;
        const px = lerp(a[0], b[0], f), py = lerp(a[1], b[1], f), pz = lerp(a[2], b[2], f);
        for (let q = 0; q < 2; q++) {
          const ang = rng() * TAU, rr = 0.0035 * Math.min(1.5, wv);
          blob(B, px + Math.cos(ang) * rr, py, pz + Math.sin(ang) * rr, rr * 1.1, rr * 0.9, 0, 1, 0, mixC(cf[(rng() * 3) | 0], PAL.dockD, rng() * 0.4), rng, 0.3);
        }
      }
    }
  }
  // the big basal leaves, dead, lying
  B.trans = 0.6; B.flex = 0.2;
  for (let k = 0; k < 3; k++) {
    const len = R(0.18, 0.3);
    const lp = curve({ x, z, psi: rng() * TAU, th: R(1.0, 1.4), kap: R(0.5, 3), len, seg: 5, twist: R(-0.5, 0.5) });
    ribbon(B, lp, W.ovate(len * 0.22), { cA: PAL.umberD, cB: mixC(PAL.dockD, PAL.umber, rng()), mid: true, crease: 0.1, midC: 1.3, tilt: 0.25 });
  }
}

function nettles(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.aoH = 0.55; B.aoMin = 0.22;
  const nS = 5 + ((rng() * 5) | 0);
  for (let s = 0; s < nS; s++) {
    B.flex = 0.5; B.phase = rng() * TAU; B.freq = 0.55; B.trans = 0.5; B.dew = 0.7;
    const a = rng() * TAU, r = R(0, 0.3);
    const H = R(0.45, 0.95);
    const psi = rng() * TAU;
    const stem = curve({ x: x + Math.cos(a) * r, z: z + Math.sin(a) * r, psi, th: R(0.04, 0.25), kap: R(0, 0.6), len: H, seg: 6 });
    prism(B, stem, (t) => (0.0028 - 0.0014 * t) * wv, 4, { cA: PAL.umberD, cB: PAL.nettle });
    for (let k = 2; k <= 6; k++) {
      const p = stem[k];
      const sz = 1 - (k - 2) / 6;
      const rot = (k & 1) * Math.PI / 2 + R(-0.2, 0.2);
      const yellow = k < 4 && rng() < 0.5;
      for (const sgn of [0, Math.PI]) {
        B.trans = 0.95; B.flex = 0.7;
        const len = R(0.05, 0.09) * (0.6 + 0.4 * sz);
        const lp = curve({ x: p[0], y: p[1], z: p[2], psi: psi + rot + sgn, th: R(0.9, 1.3), kap: R(9, 18), len, seg: 4, twist: R(-0.3, 0.3) });
        const c = yellow ? mixC(PAL.olive, PAL.ochre, R(0.3, 0.9)) : mixC(PAL.nettle, PAL.nettleL, rng());
        ribbon(B, lp, W.tooth(len * 0.36, 0.78), { cA: mulC(c, 0.85), cB: c, mid: true, crease: 0.18, midC: 0.85, tilt: 0.25 });
      }
      if (k >= 4 && rng() < 0.6) {
        // hanging seed tassels
        B.trans = 0.5;
        const tp = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(2.3, 2.8), kap: R(-3, 3), len: R(0.04, 0.07), seg: 2 });
        ribbon(B, tp, W.needle(0.0017 * Math.min(1.5, wv)), { cA: mixC(PAL.olive, PAL.umber, 0.5), tilt: 0.8 });
      }
    }
  }
}

function umbel(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.45; B.phase = rng() * TAU; B.freq = 0.42; B.trans = 0.35; B.dew = 0.3;
  B.aoH = 0.5; B.aoMin = 0.3;
  const H = R(0.6, 1.2), psi = rng() * TAU;
  const cS = mixC(PAL.umber, PAL.grey, R(0.2, 0.7));
  const stem = curve({ x, z, psi, th: R(0.03, 0.14), kap: R(-0.2, 0.3), len: H, seg: 6 });
  prism(B, stem, (t) => (0.0035 - 0.0015 * t) * wv, 4, { cA: PAL.umberD, cB: cS });
  const tops = [stem[stem.length - 1]];
  if (rng() < 0.6) {
    const p = stem[4];
    const br = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(0.4, 0.7), kap: R(-2, -0.8), len: R(0.15, 0.3), seg: 3 });
    prism(B, br, () => 0.0017 * wv, 3, { cA: cS });
    tops.push(br[br.length - 1]);
  }
  const fine = wv < 1.6;
  for (let u = 0; u < tops.length; u++) {
    const h = tops[u];
    const nest = rng() < 0.65;               // wild carrot curls into a "bird's nest"; others stay flat
    const nR = 14 + ((rng() * 8) | 0);
    const rl = R(0.035, 0.06) * (u ? 0.7 : 1);
    for (let k = 0; k < nR; k++) {
      const ring = rng();
      const rp = curve({ x: h[0], y: h[1], z: h[2], psi: (k / nR) * TAU + R(-0.15, 0.15), th: nest ? R(0.5, 1.0) * (0.5 + ring) : R(0.7, 1.15) * (0.4 + 0.6 * ring), kap: nest ? R(-22, -12) : R(-6, 0), len: rl * (0.6 + 0.4 * ring), seg: 2 });
      ribbon(B, rp, W.const(0.00075 * wv), { cA: cS, cB: mixC(cS, PAL.straw, 0.3), tilt: 0.9 });
      if (fine) {
        const e = rp[2];
        for (let q = 0; q < 4; q++) {
          const lp = curve({ x: e[0], y: e[1], z: e[2], psi: rng() * TAU, th: R(0.1, 0.6), len: R(0.006, 0.012), seg: 1 });
          ribbon(B, lp, W.needle(0.0006 * wv), { cA: mixC(cS, PAL.headD, 0.4), tilt: 0.9 });
        }
      }
    }
  }
}

function yarrow(B, rng, x, z, wv) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.6; B.phase = rng() * TAU; B.freq = 0.6; B.trans = 0.5; B.dew = 0.6;
  B.aoH = 0.3; B.aoMin = 0.35;
  const stem = curve({ x, z, psi: rng() * TAU, th: R(0.05, 0.2), kap: R(0, 0.5), len: R(0.32, 0.45), seg: 4 });
  prism(B, stem, () => 0.0016 * wv, 3, { cA: PAL.oliveD, cB: PAL.olive });
  for (let k = 1; k <= 2; k++) {
    const p = stem[k];
    const lp = curve({ x: p[0], y: p[1], z: p[2], psi: rng() * TAU, th: R(0.6, 1.1), kap: R(2, 5), len: R(0.05, 0.08), seg: 6 });
    ribbon(B, lp, W.tooth(0.005, 0.25), { cA: PAL.oliveD, cB: PAL.olive, tilt: 0.4 });
  }
  const top = stem[stem.length - 1];
  B.trans = 0.9; B.dew = 0.5;
  for (let k = 0; k < 22; k++) {
    const a = rng() * TAU, r = 0.024 * Math.sqrt(rng());
    blob(B, top[0] + Math.cos(a) * r, top[1] + 0.006 - r * r * 6, top[2] + Math.sin(a) * r, 0.0018, 0.0026, 0, 1, 0, mulC(PAL.yarrow, R(0.8, 1.0)), rng, 0.2);
  }
}

function dandelionFlower(B, rng, x, z) {
  const R = (a, b) => a + (b - a) * rng();
  B.flex = 0.6; B.phase = rng() * TAU; B.freq = 0.7; B.trans = 0.9; B.dew = 0.5;
  const sc = curve({ x, z, psi: rng() * TAU, th: R(0.2, 0.5), kap: R(1, 3), len: R(0.09, 0.15), seg: 3 });
  prism(B, sc, () => 0.0018, 3, { cA: PAL.olive, cB: PAL.sage });
  const e = sc[3];
  for (let k = 0; k < 16; k++) {
    const rp = curve({ x: e[0], y: e[1] + 0.004, z: e[2], psi: (k / 16) * TAU, th: R(1.0, 1.35), kap: R(-6, 0), len: R(0.011, 0.015), seg: 2 });
    ribbon(B, rp, W.const(0.0016), { cA: PAL.dandelC, cB: PAL.dandel, tilt: 0.4 });
  }
  blob(B, e[0], e[1] + 0.005, e[2], 0.004, 0.006, 0, 1, 0, PAL.dandelC, rng, 0.1);
}

// ------------------------------------------------------------------ shader
const VERT_HEAD = /* glsl */ `
  attribute vec4 aWind;     // flex, phase, freq, ao
  attribute vec4 aMat;      // across, along, translucency, dew
  uniform float uGTime;
  uniform float uGWind;
  uniform float uGMotion;
  varying vec3 vGW;
  varying vec3 vGRest;
  varying vec4 vGMat;
  varying float vGAO;
  float gHash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
  float gNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;
const VERT_PROJECT = /* glsl */ `
  vec4 gW = vec4( transformed, 1.0 );
  float gPh = aWind.y;
  #ifdef USE_INSTANCING
    gW = instanceMatrix * gW;
    gPh += gHash( instanceMatrix[3].xz * 3.17 + 1.3 ) * 6.2832;
  #endif
  gW = modelMatrix * gW;
  vGRest = gW.xyz;
  {
    float gH = max( gW.y, 0.0 );
    // gusts: noise bands sweeping across the field downwind (+x), over a slow swell
    vec2 gq = vec2( gW.x - uGTime * 1.35, gW.z * 1.4 ) * 0.16;
    float gGust = smoothstep( 0.22, 0.86, 0.65 * gNoise( gq ) + 0.35 * gNoise( gq * 2.7 + 4.1 ) );
    float gSwell = 0.5 + 0.5 * sin( uGTime * 0.11 + gW.x * 0.015 );
    float gF = aWind.z;
    float gSw = sin( uGTime * ( 0.7 + 1.5 * gF ) + gPh - gW.x * 0.45 );
    float gFl = sin( uGTime * ( 4.0 + 7.0 * gF ) + gPh * 2.3 ) * gF;
    float gB = aWind.x * gH * gH * uGWind;      // bend grows with the square of the height
    float gDx = gB * ( 0.6 + 1.25 * gGust + 0.35 * gSwell + uGMotion * ( 0.32 * gSw * ( 0.45 + gGust ) + 0.1 * gFl ) );
    float gDz = gB * uGMotion * ( 0.2 * gSw * ( 0.3 + gGust ) + 0.1 * gFl );
    gW.x += gDx; gW.z += gDz;
    gW.y = max( gW.y - 0.5 * ( gDx * gDx + gDz * gDz ) / max( gH, 0.05 ), 0.002 );
  }
  vGW = gW.xyz;
  vGMat = aMat;
  vGAO = aWind.w;
  vec4 mvPosition = viewMatrix * gW;
  gl_Position = projectionMatrix * mvPosition;
`;
const FRAG_HEAD = /* glsl */ `
  varying vec3 vGW;
  varying vec3 vGRest;
  varying vec4 vGMat;
  varying float vGAO;
  uniform vec3 uGNight;
  uniform vec3 uGHaze;
  uniform vec2 uGCenter;
  uniform float uGDew;
  float gTrans;
  vec3 gTransCol;
  float gDewK;
  float gSpark;
  vec3 gUpV;
  float gHash3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
`;
const FRAG_LAMBERT_PARS = /* glsl */ `
  varying vec3 vViewPosition;
  struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
  void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
    vec3 L = directLight.direction;
    float nl = dot( geometryNormal, L );
    float front = saturate( ( nl + 0.45 ) / 1.45 );                       // wrapped: thin, soft leaves
    float back = saturate( 0.15 - nl );                                    // light arriving behind the leaf
    float vl = saturate( dot( - geometryViewDir, L ) );                    // the fire behind the leaf, seen through it
    float fwd = vl * vl; fwd *= fwd; fwd *= vl;
    float nv = abs( dot( geometryNormal, geometryViewDir ) );
    float rim = 1.0 - nv;
    float tr = gTrans * ( 0.5 * back + fwd * ( 0.35 + 2.2 * rim * rim ) );
    // dew: a soft sheen at grazing angles and a few droplets that catch the fire
    vec3 Hh = normalize( L + geometryViewDir );
    float nh = saturate( dot( geometryNormal, Hh ) );
    float sheen = pow( nh, 24.0 ) * rim * rim;
    float lum = dot( directLight.color, vec3( 0.3, 0.6, 0.1 ) );
    float dew = gDewK * ( 0.55 * sheen + gSpark * smoothstep( 0.04, 0.4, lum ) * ( 0.3 + 0.7 * pow( nh, 3.0 ) ) );
    reflectedLight.directDiffuse += directLight.color * ( BRDF_Lambert( material.diffuseColor ) * front + BRDF_Lambert( gTransCol ) * tr + vec3( 0.95, 0.97, 1.0 ) * dew );
  }
  void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
    reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
  }
  #define RE_Direct RE_Direct_Grass
  #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
`;
const FRAG_COLOR = /* glsl */ `
  #include <color_fragment>
  diffuseColor.rgb *= vGAO;
`;
const FRAG_NORMAL = /* glsl */ `
  #include <normal_fragment_maps>
  {
    gUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    normal = normalize( normal + gUpV * 0.3 );                             // a field of blades, not a mirror
    gTrans = vGMat.z;
    // light through a leaf is more saturated and warmer than off it
    gTransCol = pow( max( diffuseColor.rgb, vec3( 1e-4 ) ), vec3( 0.85 ) ) * vec3( 1.25, 1.1, 0.6 );
    gDewK = vGMat.w * uGDew;
    vec3 gc = vGRest * 70.0;
    float gd = length( fract( gc ) - 0.5 );
    gSpark = step( 0.988, gHash3( floor( gc ) ) ) * ( 1.0 - smoothstep( 0.18, 0.32, gd ) ) * 2.5;
  }
`;
const FRAG_EMISSIVE = /* glsl */ `
  #include <emissivemap_fragment>
  totalEmissiveRadiance = uGNight * vGAO * ( 0.72 + 0.28 * max( dot( normal, gUpV ), 0.0 ) );
`;
const FRAG_OPAQUE = /* glsl */ `
  #include <opaque_fragment>
  {
    // sky.js's low ground haze, in linear space, so the meadow meets the sky's ground without a seam
    float gD = length( vGW.xz - uGCenter );
    float gLow = 0.62 * ( 1.0 - exp( - max( gD - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vGW.y ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uGHaze, gLow );
  }
`;

function grassMaterial(uniforms) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <project_vertex>', VERT_PROJECT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <lights_lambert_pars_fragment>', FRAG_LAMBERT_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <opaque_fragment>', FRAG_OPAQUE);
  };
  mat.customProgramCacheKey = () => 'iskry-grass-1';
  return mat;
}

// ------------------------------------------------------------------- site
// Fast road lateral from layout.roadPoint samples (the road runs monotonically toward -z).
function makeRoadQuery() {
  const N = 640;
  const X = new Float64Array(N), Z = new Float64Array(N);
  for (let i = 0; i < N; i++) { const p = roadPoint(i / (N - 1)); X[i] = p.x; Z[i] = p.z; }
  const res = { lat: 0, dist: 0, beyond: false };
  return function (x, z) {
    let lo = 0, hi = N - 1;
    if (z >= Z[0]) hi = 1; else if (z <= Z[N - 1]) lo = N - 2;
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Z[m] > z) lo = m; else hi = m; }
    let best = Infinity, lat = 0, beyond = false;
    const a0 = Math.max(0, lo - 48), a1 = Math.min(N - 2, lo + 48);
    for (let i = a0; i <= a1; i++) {
      const ex = X[i + 1] - X[i], ez = Z[i + 1] - Z[i], L2 = ex * ex + ez * ez || 1;
      let u = ((x - X[i]) * ex + (z - Z[i]) * ez) / L2;
      const out = (i === 0 && u < 0) || (i === N - 2 && u > 1);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = X[i] + ex * u, pz = Z[i] + ez * u;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < best) {
        best = d2;
        const L = Math.sqrt(L2);
        lat = ((x - px) * (-ez / L) + (z - pz) * (ex / L)) >= 0 ? Math.sqrt(d2) : -Math.sqrt(d2);
        beyond = out;
      }
    }
    res.lat = lat; res.dist = Math.sqrt(best); res.beyond = beyond;
    return res;
  };
}

function makeSite(F) {
  const road = makeRoadQuery();
  const ko = (w) => KEEP_OUT.find((k) => k.what === w);
  const fireK = ko('fire ring') || { x: F.x, z: F.z, r: 1.75 };
  const benchK = ko('bench'), guitarK = ko('guitar'), shrineK = ko('shrine post');
  const capsule = (k, x, z) => {
    if (!k) return 99;
    if (!k.a) return Math.hypot(x - k.x, z - k.z);
    const ex = k.b[0] - k.a[0], ez = k.b[1] - k.a[1];
    const u = clamp(((x - k.a[0]) * ex + (z - k.a[1]) * ez) / (ex * ex + ez * ez), 0, 1);
    return Math.hypot(x - (k.a[0] + ex * u), z - (k.a[1] + ez * u));
  };
  // a desire path from the fire ring to the road's verge, angled toward us (people come from the road)
  let bx = fireK.x;
  const side = road(fireK.x, fireK.z).lat < 0 ? 1 : -1;      // which way the road lies along x
  for (let i = 0; i < 600 && Math.abs(road(bx, fireK.z + 0.9).lat) > ROAD.halfWidth; i++) bx += 0.05 * side;
  const pathA = [fireK.x + side * (fireK.r + 0.1), fireK.z + 0.35];
  const pathB = [bx, fireK.z + 0.9];
  const segD = (x, z, a, b) => {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const u = clamp(((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1), 0, 1);
    return Math.hypot(x - (a[0] + ex * u), z - (a[1] + ez * u));
  };
  const fenceLat = FENCE.offset * FENCE.side;
  const S = { T: 0, tall: 0, D: 0, dz: 0, sx: 0, df: 0, lat: 0, fd: 99, road: 0, rut: false, beyondFence: false };
  S.fire = fireK; S.path = [pathA, pathB];
  S.at = function (x, z) {
    S.D = distanceFromCenter(x, z);
    S.dz = CAMERA.z - z;
    S.sx = (x - CAMERA.x) / (0.693 * Math.max(0.5, S.dz));
    S.df = Math.hypot(x - fireK.x, z - fireK.z);
    S.rut = false;
    if (inKeepOut(x, z, 0.04)) return false;
    let T = 0, tall = 0;
    T = Math.max(T, 0.92 * (1 - smooth(fireK.r, fireK.r + 1.6, S.df)));
    if (benchK) T = Math.max(T, 0.88 * (1 - smooth(benchK.r, benchK.r + 1.1, capsule(benchK, x, z))));
    if (guitarK) T = Math.max(T, 0.8 * (1 - smooth(guitarK.r, guitarK.r + 0.4, capsule(guitarK, x, z))));
    const dsh = shrineK ? capsule(shrineK, x, z) : 99;
    T = Math.max(T, 0.55 * (1 - smooth(0.35, 0.95, dsh)));
    T = Math.max(T, 0.62 * (1 - smooth(0.22, 0.7, segD(x, z, pathA, pathB))));
    const q = road(x, z);
    S.lat = q.lat;
    const roadK = q.beyond ? 0 : 1 - smooth(ROAD.fadeFrom, ROAD.fadeTo, S.D);
    S.road = roadK;
    const al = Math.abs(q.lat);
    if (roadK > 0.02 && al < ROAD.halfWidth + 0.8) {
      const rutIn = ROAD.crownHalfWidth, rutOut = ROAD.rutOffset + ROAD.rutWidth * 0.75;
      if (al > rutIn && al < rutOut && roadK > 0.35) { S.rut = true; return false; }   // the ruts: bare earth
      let tr;
      if (al <= rutIn) tr = 0.62;                                                 // the crown, cropped short
      else if (al < ROAD.halfWidth) tr = lerp(0.85, 0.5, smooth(rutOut, ROAD.halfWidth, al));
      else tr = 0.5 * (1 - smooth(ROAD.halfWidth, ROAD.halfWidth + 0.8, al));
      T = Math.max(T, tr * roadK);
    }
    // the fence line (an offset of the road), tall and thick, except in the shrine's gate
    let fd = 99;
    if (z <= FENCE.fromZ + 0.4 && z >= FENCE.toZ - 0.4) fd = Math.abs(q.lat - fenceLat);
    const gate = Math.hypot(x - SHRINE.x, z - SHRINE.z) < FENCE.gateGap * 0.5 + 0.35;
    if (gate) { fd = 99; T = Math.max(T, 0.5); }
    S.fd = fd;
    S.beyondFence = fd < 99 && (q.lat - fenceLat) * FENCE.side > 0.3;
    tall = Math.max(tall, 1 - smooth(0.25, 1.0, fd));
    // the bottom corners of the frame
    tall = Math.max(tall, smooth(0.38, 0.9, Math.abs(S.sx)) * (1 - smooth(6.0, 9.5, S.dz)));
    S.T = T; S.tall = tall * (1 - T);
    return true;
  };
  return S;
}

// ================================================================== build
export function createGrass(ctx, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const o = { ...DEFAULTS, ...opts };
  if (opts.firePosition) o.firePosition = { x: +opts.firePosition.x || 0, y: +opts.firePosition.y || 0, z: +opts.firePosition.z || 0 };
  if (!Number.isFinite(o.wind)) o.wind = DEFAULTS.wind;
  const reduced = !!ctx.reducedMotion;
  const rng = mulberry32((o.seed | 0) * 7919 + 101);
  const R = (a, b) => a + (b - a) * rng();
  const F = o.firePosition;
  const reach = ZONES.nearReach;
  const dens = clamp(+o.density || 1, 0.1, 3);

  const group = new THREE.Group();
  group.name = 'grass';
  ctx.scene.add(group);
  const geometries = [], meshes = [];

  const uniforms = {
    uGTime: { value: 0 },
    uGWind: { value: clamp(o.wind, 0, 1.2) * 0.55 },
    uGMotion: { value: reduced ? 0 : 1 },
    uGNight: { value: new THREE.Color(o.nightTone) },
    uGHaze: { value: new THREE.Color(o.hazeColor) },
    uGCenter: { value: new THREE.Vector2(ZONES.center.x, ZONES.center.z) },
    uGDew: { value: 1 },
  };
  const nightBase = new THREE.Color(o.nightTone);
  const material = grassMaterial(uniforms);

  const site = makeSite(F);

  // ------------------------------------------------ tussock geometries (local frames)
  const VAR = {
    turf: { blades: 9, seg: 2, hRef: 0.09, hMin: 0.35, spread: 0.15, wMin: 0.0018, wMax: 0.0034, widen: 1, live: 0.62, dry: 0.28, splay: 0.5, aoMin: 0.42 },
    meadow: { blades: 9, seg: 3, hRef: 0.42, hMin: 0.4, spread: 0.09, wMin: 0.004, wMax: 0.011, widen: 1, live: 0.5, dry: 0.3, splay: 0.35, aoMin: 0.2 },
    rank: { blades: 13, seg: 4, hRef: 0.8, hMin: 0.35, spread: 0.11, wMin: 0.004, wMax: 0.009, widen: 1, live: 0.36, dry: 0.36, splay: 0.45, aoMin: 0.16 },
    mid: { blades: 7, seg: 2, hRef: 0.42, hMin: 0.45, spread: 0.1, wMin: 0.005, wMax: 0.009, widen: 1.5, live: 0.45, dry: 0.35, splay: 0.35, aoMin: 0.25 },
    far: { blades: 6, seg: 1, hRef: 0.42, hMin: 0.5, spread: 0.13, wMin: 0.007, wMax: 0.012, widen: 2.0, live: 0.45, dry: 0.4, splay: 0.3, aoMin: 0.35 },
  };
  const geoms = {};
  for (const k in VAR) { geoms[k] = tussock(rng, VAR[k]).build(); geometries.push(geoms[k]); }

  // ------------------------------------------------ planting the tussocks
  const lists = { turf: [], meadow: [], rank: [], mid: [], far: [] };
  const TINT = [
    [1, 1, 1], [0.86, 1.04, 0.8], [1.14, 1.02, 0.82], [0.78, 0.8, 0.76], [1.05, 0.96, 0.9], [0.95, 1.0, 0.86],
  ];
  const cell = 0.17;
  const zNear = CAMERA.z - 3.0, zFar = CAMERA.z - reach - 1;
  const tanDown = Math.tan((13.5 - 1.2) * Math.PI / 180);     // the bottom edge of the frame (with parallax slack)
  for (let z = zNear; z > zFar; z -= cell) {
    const dz = CAMERA.z - z;
    const halfW = 0.71 * dz + 0.7;
    for (let x = CAMERA.x - halfW; x < CAMERA.x + halfW; x += cell) {
      const px = x + (rng() - 0.5) * cell * 1.2, pz = z + (rng() - 0.5) * cell * 1.2;
      // which LOD band (dithered edges), and how sparse it samples (accept prob vs the fine cell)
      const D = distanceFromCenter(px, pz);
      if (D > reach) continue;
      const df = Math.hypot(px - F.x, pz - F.z);
      const nearK = Math.max(1 - smooth(o.lodNear - 1, o.lodNear + 1, D), 1 - smooth(o.fireNear - 1, o.fireNear + 1, df));
      const band = rng() < nearK ? 0 : (rng() < 1 - smooth(o.lodMid - 1.5, o.lodMid + 1.5, D) ? 1 : 2);
      const keepP = band === 0 ? 0.62 : band === 1 ? 0.32 : 0.16;
      // patchy meadow: slow noise decides where the grass is thick
      const n1 = fbm(px * 0.33, pz * 0.33, 3), n2 = vnoise(px * 1.1 + 9, pz * 1.1, 5);
      const turfFirst = band === 0 && D < 14.5;
      if (!site.at(px, pz)) continue;
      const T = site.T, tall = site.tall;
      // height
      let h = lerp(0.22, 0.55, n1) * (0.85 + 0.3 * n2);
      if (site.beyondFence) h *= 0.85;
      h *= 1 - 0.78 * T;
      h *= 1 + 1.1 * tall;
      h *= 1 - smooth(reach - 7, reach, D);
      // only what reaches above the bottom edge of the frame is worth drawing so close
      const yEdge = CAMERA.y - dz * tanDown;
      const visible = h > yEdge;
      // turf carpet (near): everywhere, denser where trampled
      if (turfFirst && dz > 6.2 && D < 16 && rng() < (0.24 + 0.36 * (1 - smooth(5, 10, df)) + 0.45 * smooth(0.2, 0.6, T)) * (1 - 0.5 * tall) * dens) {
        const s = R(0.8, 1.3);
        lists.turf.push(px + R(-0.05, 0.05), pz + R(-0.05, 0.05), rng() * TAU, s, R(0.5, 1.1) * (1 - 0.4 * T) * (1 - smooth(13, 15, D)) + 0.25, s, (rng() * TINT.length) | 0);
      }
      if (!visible) continue;
      const lit = 1 - smooth(4, 10, df);     // where the fire shows it, the meadow is fuller
      const p = (0.42 + 0.58 * smooth(0.25, 0.6, n1)) * (1 - 0.55 * T) * (1 + 0.8 * tall) * (0.85 + 0.45 * lit) * keepP * dens;
      if (rng() > p) continue;
      if (h < 0.05) continue;
      let kind;
      if (band === 0) kind = (h > 0.55 || tall > 0.4) ? 'rank' : 'meadow';
      else kind = band === 1 ? 'mid' : 'far';
      const ref = VAR[kind].hRef;
      const sxz = R(0.8, 1.25) * (kind === 'rank' ? 1 + 0.4 * tall : 1);
      // dry patches: strawier tint by a slow noise field
      const dry = vnoise(px * 0.2 + 3, pz * 0.2 - 2, 9);
      let ti = (rng() * TINT.length) | 0;
      if (dry > 0.62 && rng() < 0.7) ti = 2;
      lists[kind].push(px, pz, rng() * TAU, sxz, h / ref, sxz, ti);
    }
  }

  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3(), c4 = new THREE.Color();
  const UP = new THREE.Vector3(0, 1, 0);
  const stats = { instances: {}, triangles: 0, drawCalls: 0, buildMs: 0 };
  for (const k of ['turf', 'meadow', 'rank', 'mid', 'far']) {
    const L = lists[k], n = L.length / 7;
    if (n < 1) continue;
    const mesh = new THREE.InstancedMesh(geoms[k], material, n);
    mesh.name = 'grass-' + k;
    for (let i = 0; i < n; i++) {
      const j = i * 7;
      p4.set(L[j], 0, L[j + 1]);
      q4.setFromAxisAngle(UP, L[j + 2]);
      s4.set(L[j + 3], L[j + 4], L[j + 5]);
      m4.compose(p4, q4, s4);
      mesh.setMatrixAt(i, m4);
      const tc = TINT[L[j + 6]], v = R(0.82, 1.12);
      c4.setRGB(tc[0] * v, tc[1] * v, tc[2] * v);
      mesh.setColorAt(i, c4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    group.add(mesh); meshes.push(mesh);
    stats.instances[k] = n;
    stats.triangles += n * (geoms[k].index.count / 3);
    stats.drawCalls++;
  }

  // ------------------------------------------------ the sparse species: one merged world-space mesh
  const B = new Geo(1 << 16);
  const counts = {};
  const triBy = {};
  let lastTris = 0;
  const count = (k) => { counts[k] = (counts[k] || 0) + 1; triBy[k] = (triBy[k] || 0) + B.tris - lastTris; lastTris = B.tris; };
  const widenAt = (x, z) => Math.max(1, Math.pow(distanceFromCenter(x, z) / 8.5, 0.85));
  // random points in the view out to `maxD`, weighted by `w(x, z)` (0..1), rejecting keep-outs and ruts
  const sample = (n, maxD, w, minDz = 4.5, tries = 60) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < tries; k++) {
        const dz = minDz + Math.pow(rng(), 0.85) * (maxD - minDz);
        const z = CAMERA.z - dz;
        const x = CAMERA.x + (rng() * 2 - 1) * (0.71 * dz + 0.6);
        if (distanceFromCenter(x, z) > maxD) continue;
        if (!site.at(x, z)) continue;
        if (rng() > w(x, z)) continue;
        out.push([x, z]);
        break;
      }
    }
    return out;
  };
  const yEdgeAt = (z) => CAMERA.y - (CAMERA.z - z) * tanDown;

  // seed-head grasses: thick along the fence and in the corners, a scatter in the meadow,
  // none on the trodden ground
  const nSeed = Math.round(330 * dens);
  for (const [x, z] of sample(nSeed, 24, (x, z) => (0.12 + 0.88 * Math.max(site.tall, 0.3 * smooth(0.45, 0.8, fbm(x * 0.3, z * 0.3, 4)))) * Math.pow(1 - site.T, 2.5), 4.0)) {
    const wv = widenAt(x, z);
    const H = R(0.45, 0.85) * (1 + 0.45 * site.tall) * (1 - smooth(20, 24, site.D) * 0.4);
    if (H < yEdgeAt(z)) continue;
    const u = rng();
    B.aoH = 0.4; B.aoMin = 0.3;
    if (u < 0.34) { timothy(B, rng, x, z, H, wv); count('timothy'); }
    else if (u < 0.6) { cocksfoot(B, rng, x, z, H, wv); count('cocksfoot'); }
    else if (u < 0.76) { wildOat(B, rng, x, z, H * 1.1, wv); count('wild oat'); }
    else { bentGrass(B, rng, x, z, H, wv); count('bent grass'); }
  }
  // a stand of seed heads just in front of the fire (silhouettes against its glow) and a few beside it
  for (let i = 0; i < 26; i++) {
    const a = R(0.15, Math.PI - 0.15), r = R(2.0, 4.2);
    const x = F.x + Math.cos(a) * r * 1.2, z = F.z + Math.sin(a) * r;
    if (!site.at(x, z) || site.T > 0.75) continue;
    const wv = widenAt(x, z), H = R(0.45, 0.8);
    const u = rng();
    if (u < 0.4) timothy(B, rng, x, z, H, wv); else if (u < 0.7) wildOat(B, rng, x, z, H, wv); else cocksfoot(B, rng, x, z, H, wv);
    count('fire stand');
  }

  // rosettes on trodden ground: plantain loves the road's crown and the path, clover the verges
  for (const [x, z] of sample(Math.round(70 * dens), 17, () => 0.1 + 0.9 * smooth(0.25, 0.6, site.T) * (1 - smooth(0.85, 0.95, site.T)), 6.2)) {
    const wv = widenAt(x, z);
    if (rng() < 0.55) { plantain(B, rng, x, z, wv, rng() < 0.4); count('plantain'); }
    else { clover(B, rng, x, z); count('clover'); }
  }
  for (const [x, z] of sample(Math.round(30 * dens), 16, () => 0.3 + 0.7 * site.T, 6.2)) {
    if (rng() < 0.5) { dandelionRosette(B, rng, x, z, widenAt(x, z)); count('dandelion rosette'); }
    else { lowForb(B, rng, x, z, widenAt(x, z)); count('low forb'); }
  }
  // the meadow's low leafy forbs
  for (const [x, z] of sample(Math.round(22 * dens), 15, () => 0.6 * (1 - site.T), 6.2)) { lowForb(B, rng, x, z, widenAt(x, z)); count('low forb'); }

  // dead bracken and a few ferns where the forest edges come down to the field (frame edges)
  for (const [x, z] of sample(Math.round(20 * dens), 29, (x, z) => smooth(0.55, 0.85, Math.abs(site.sx)) * smooth(9, 12, site.D) * smooth(0.35, 0.65, fbm(x * 0.25, z * 0.25, 13)) * (1 - site.T), 6)) {
    const n = 2 + ((rng() * 3) | 0);
    for (let k = 0; k < n; k++) { bracken(B, rng, x + R(-0.4, 0.4), z + R(-0.4, 0.4), widenAt(x, z)); count('bracken'); }
  }
  for (const [x, z] of sample(Math.round(6 * dens), 22, () => smooth(0.6, 0.85, Math.abs(site.sx)) * smooth(8, 11, site.D) * (1 - site.T), 6)) { maleFern(B, rng, x, z, widenAt(x, z)); count('male fern'); }

  // tall forbs
  for (const [x, z] of sample(Math.round(11 * dens), 22, () => (0.4 + 0.6 * site.tall) * (1 - site.T), 7)) { thistle(B, rng, x, z, widenAt(x, z)); count('thistle'); }
  for (const [x, z] of sample(Math.round(9 * dens), 22, () => (0.5 + 0.5 * site.tall) * (1 - site.T) * (Math.abs(site.lat) < 3.5 ? 1 : 0.5), 7)) { dock(B, rng, x, z, widenAt(x, z)); count('dock'); }
  for (const [x, z] of sample(Math.round(15 * dens), 23, () => (0.35 + 0.65 * site.tall) * (1 - site.T), 7)) { umbel(B, rng, x, z, widenAt(x, z)); count('umbellifer'); }
  // nettles crowd the fence line and the shrine's foot (nitrogen-rich, undisturbed)
  for (const [x, z] of sample(Math.round(4 * dens), 20, () => (site.fd < 0.6 ? 1 : 0) * (1 - site.T), 6)) { nettles(B, rng, x, z, widenAt(x, z)); count('nettles'); }
  {
    const a = Math.atan2(SHRINE.faceZ, SHRINE.faceX) + Math.PI * 0.75;   // behind and to one side of the post
    const x = SHRINE.x + Math.cos(a) * 0.75, z = SHRINE.z + Math.sin(a) * 0.75;
    if (site.at(x, z)) { nettles(B, rng, x, z, widenAt(x, z)); count('nettles'); }
  }
  // two surviving flowers, beyond the fire where its light falls on the side we see
  {
    const fl = [[0.55, 2.6, yarrow], [-0.6, 2.3, dandelionFlower]];
    for (const [a, r, fn] of fl) {
      const ang = -Math.PI / 2 + a;     // -z side of the fire (beyond it), lit face toward us
      let x = F.x + Math.cos(ang) * r, z = F.z + Math.sin(ang) * r;
      for (let k = 0; k < 12 && !site.at(x, z); k++) { x += R(-0.3, 0.3); z += R(-0.3, 0.3); }
      if (fn === dandelionFlower) { dandelionRosette(B, rng, x, z, 1); fn(B, rng, x + 0.02, z + 0.01); }
      else fn(B, rng, x, z, widenAt(x, z));
      count('flower');
    }
  }
  const sparseGeo = B.build();
  geometries.push(sparseGeo);
  const sparse = new THREE.Mesh(sparseGeo, material);
  sparse.name = 'grass-plants';
  sparse.matrixAutoUpdate = false; sparse.updateMatrix();
  group.add(sparse); meshes.push(sparse);
  stats.instances.plants = counts;
  stats.plantTris = triBy;
  stats.triangles += B.tris;
  stats.drawCalls++;
  stats.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  // ------------------------------------------------ frame
  let time = 0;
  function update(t, dt) {
    if (reduced) return;                  // still: the lean stays, nothing moves
    time += clamp(dt || 0, 0, 0.1);
    uniforms.uGTime.value = time;
  }
  function resize() {}
  function setTimeOfDay(tod) {
    if (!tod) return;
    // dusk and dawn lift the unlit grass a little; the dew comes down through the night
    const k = 1 + 0.9 * (tod.dusk || 0) + 0.6 * (tod.dawn || 0);
    uniforms.uGNight.value.copy(nightBase).multiplyScalar(k);
    uniforms.uGDew.value = 0.55 + 0.45 * (tod.night || 0) + 0.5 * (tod.dawn || 0);
  }
  function dispose() {
    ctx.scene.remove(group);
    for (const m of meshes) if (m.isInstancedMesh) m.dispose();
    for (const g of geometries) g.dispose();
    material.dispose();
    meshes.length = 0; geometries.length = 0;
  }
  return { group, update, resize, dispose, setTimeOfDay, stats, uniforms, site };
}
