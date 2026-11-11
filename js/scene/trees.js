/*
  Iskry · trees.js: the forest around the fire. Douglas-firs (Pseudotsuga menziesii) and a
  few silver birches (Betula pendula, brzoza) near the sides.
  OWNER: Opus worker "trees". Interface: scratchpad scene-modules-spec.md (+ the UPDATE section).

  Model (independent of the scene; seeded and deterministic):
    buildDouglasFir(params, rng) -> THREE.BufferGeometry
    buildBirch(params, rng)      -> THREE.BufferGeometry
    makeTreeAtlas(seed)          -> { texture, tiles }   procedural needle / twig atlas
    createTreeMaterial(opts)     -> { material, uniforms, atlas, dispose }
  Every geometry carries position, normal, uv and aInfo = (kind, ao, sway, aux):
    kind 0 fir bark, 1 needle card, 2 birch bark, 3 birch twig card, 4 dead wood, 5 cone.
    For bark aux = N + furrow (N ridges around the stem, furrow 0..0.99 depth);
    for cards aux = flutter phase.

  Scene:
    createTrees(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), stats }
    opts { firePosition = {x:-3,y:0,z:-2}, wind = 0.25 (m/s, +x), seed = 7 }
  It places a Douglas-fir treeline ~50-57 m from the camera's xz (0, 12) that dips behind the
  fire, a few nearer stands framing the left and right edges, and two birches.

  Draw calls: one InstancedMesh per (species, LOD, variant), all sharing ONE material
  (one program, one atlas): about 12. LOD is chosen by distance at placement (the camera only
  translates by ~0.3 m), LOD0 full needle sprays, LOD1 hanging branch curtains, LOD2 a few
  big curtains. No per-frame allocations: update() only writes two uniforms.

  Shading: MeshLambertMaterial patched in onBeforeCompile. It answers the fire's PointLight
  (wrap-lit, translucent-ish needle cards with crown-shaped normals, a warm rim), procedural
  bark (furrowed Douglas-fir plates, birch lenticels and diamonds) with bump, a baked fake AO,
  the same low warm haze the sky uses at the bases, and scene.fog scaled by fogAmount so the
  treeline stays a dark silhouette. Wind sway in the vertex shader; reducedMotion: still.
  Every trunk starts at y = 0 and flares; nothing goes below the ground.
  No scene.fog, background, tone mapping or renderer state is touched.
*/
import * as THREE from 'three';
import { STORK, SHRINE, BENCH, ROAD, FENCE, roadDistance } from './layout.js';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: { x: -3, y: 0, z: -2 },
  wind: 0.25,              // m/s mean wind toward +x
  seed: 7,
  center: { x: 0, z: 12 }, // xz the treeline arcs around (camera default)
  span: 1.08,              // radians each side of straight ahead
  treeHeight: 8.2,         // m, typical treeline fir (the scene is scaled; ~200 px tall on screen)
  rows: [                  // treeline rows: distance, lod, height factor, spacing range (m)
    { R: 50.0, lod: 1, h: 0.86, step: [1.5, 2.9], clear: 0.55 },
    { R: 52.6, lod: 1, h: 1.0, step: [1.3, 2.5], clear: 0.35, emergent: 0.07 },
    { R: 55.2, lod: 2, h: 1.06, step: [1.2, 2.3], clear: 0.15, emergent: 0.05 },
    { R: 57.8, lod: 2, h: 1.1, step: [1.1, 2.1], clear: 0.0 },
  ],
  gapWidth: 0.26,          // radians: the treeline dips behind the fire...
  gapDepth: 0.42,          // ...by this much at the fire's azimuth
  // the valley clearing (azimuth = atan2(x, -(z - 12)), + is right): the lake, the village and
  // the Tatras show through. Nothing stands inside; the edges thin out over `clearingFeather`.
  clearing: [-0.03, 0.37],
  clearingFeather: [0.16, 0.12],   // radians of thinning, shortening stand on the left / right
  // keep the firs behind the foreground stork pole low and sparse, so it reads against the haze
  stork: { x: STORK.x, z: STORK.z, width: 0.07, depth: 0.55 },   // from layout.js
  understory: true,        // young firs between the rows so the stand reads as a forest
  near: true,              // the framing stands at the left and right edges
  birches: 2,              // 0..3
  fogAmount: 0.4,          // share of scene.fog the trees take (they stay darker than the haze)
  haze: 1,                 // low warm haze at the bases (matches the sky's ground)
};

const KIND_BARK = 0, KIND_NEEDLE = 1, KIND_BIRCH = 2, KIND_TWIG = 3, KIND_DEAD = 4, KIND_CONE = 5;

// --------------------------------------------------------------- utilities
export function mulberry32(a) {
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
const rr = (rng, a, b) => a + (b - a) * rng();
const TAU = Math.PI * 2;

function makeNoise1D(rng) {
  const N = 256, table = new Float32Array(N);
  for (let i = 0; i < N; i++) table[i] = rng();
  const n1 = (x) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return table[((i % N) + N) % N] * (1 - u) + table[(((i + 1) % N) + N) % N] * u;
  };
  n1.fbm = (x, oct = 3) => {
    let s = 0, amp = 0.5, fr = 1, norm = 0;
    for (let o = 0; o < oct; o++) { s += amp * n1(x * fr + o * 17.3); norm += amp; amp *= 0.5; fr *= 2.07; }
    return s / norm;
  };
  return n1;
}

// The main Douglas-fir ridge pattern, shared by the CPU displacement and the bark shader
// (the shader adds the interlacing second set, cross-checks and fine texture).
// a: 0..N around the stem (N ridges), v: metres along it. Returns 0 (furrow) .. 1 (plate).
function firRidge(a, v, N) {
  const k = TAU / N;
  const w = 0.30 * Math.sin(v * 1.9 + a * k * 2) + 0.21 * Math.sin(v * 0.71 + a * k * 3 + 1.3) +
            0.11 * Math.sin(v * 4.3 + a * k * 5 + 2.1);
  let p = a + w; p -= Math.floor(p);
  return smooth(0.02, 0.3, p) * (1 - smooth(0.6, 0.97, p));
}

// ----------------------------------------------------------- geometry builder
class GeoBuilder {
  constructor(vCap = 4096) {
    this.pos = new Float32Array(vCap * 3);
    this.nor = new Float32Array(vCap * 3);
    this.uv = new Float32Array(vCap * 2);
    this.info = new Float32Array(vCap * 4);
    this.idx = new Uint32Array(vCap * 2);
    this.nv = 0; this.ni = 0;
  }
  reserve(nv, ni) {
    let cap = this.pos.length / 3;
    if (this.nv + nv > cap) {
      while (cap < this.nv + nv) cap *= 2;
      this.pos = grow(this.pos, cap * 3); this.nor = grow(this.nor, cap * 3);
      this.uv = grow(this.uv, cap * 2); this.info = grow(this.info, cap * 4);
    }
    let ic = this.idx.length;
    if (this.ni + ni > ic) { while (ic < this.ni + ni) ic *= 2; this.idx = grow(this.idx, ic); }
  }
  vert(x, y, z, nx, ny, nz, u, v, kind, ao, sway, aux) {
    const i = this.nv++;
    const i3 = i * 3, i2 = i * 2, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.nor[i3] = nx; this.nor[i3 + 1] = ny; this.nor[i3 + 2] = nz;
    this.uv[i2] = u; this.uv[i2 + 1] = v;
    this.info[i4] = kind; this.info[i4 + 1] = ao; this.info[i4 + 2] = sway; this.info[i4 + 3] = aux;
    return i;
  }
  tri(a, b, c) { const k = this.ni; this.idx[k] = a; this.idx[k + 1] = b; this.idx[k + 2] = c; this.ni += 3; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.nv * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.nv * 2), 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(this.info.slice(0, this.nv * 4), 4));
    // wood triangles first, then foliage cards: two groups, drawn by the wood and the foliage
    // material (each shader only carries its own code, which keeps the cards cheap)
    const nt = this.ni / 3, src = this.idx, info = this.info;
    const idx = this.nv > 65535 ? new Uint32Array(this.ni) : new Uint16Array(this.ni);
    let w = 0, f = this.ni;
    for (let t = 0; t < nt; t++) {
      const k = info[src[t * 3] * 4];
      const fol = (k > 0.5 && k < 1.5) || (k > 2.5 && k < 3.5);
      if (!fol) { idx[w] = src[t * 3]; idx[w + 1] = src[t * 3 + 1]; idx[w + 2] = src[t * 3 + 2]; w += 3; }
    }
    f = w;
    for (let t = 0; t < nt; t++) {
      const k = info[src[t * 3] * 4];
      const fol = (k > 0.5 && k < 1.5) || (k > 2.5 && k < 3.5);
      if (fol) { idx[f] = src[t * 3]; idx[f + 1] = src[t * 3 + 1]; idx[f + 2] = src[t * 3 + 2]; f += 3; }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.addGroup(0, w, 0);
    g.addGroup(w, this.ni - w, 1);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
function grow(a, n) { const b = new a.constructor(n); b.set(a); return b; }

// A generalised cylinder along a polyline, parallel-transport frames, seam duplicated.
// pts: [x,y,z,...] n points; rad, vv (bark v, m), ao, sway, furrow: per ring.
// N: ridges around (uv.x = 0..N); disp: CPU ridge displacement (fraction of radius).
// lobes: optional fn(ring, angle) -> radius factor (root buttresses).
function tube(B, pts, n, rad, vv, ao, sway, furrow, sides, kind, N, disp, lobes) {
  B.reserve(n * (sides + 1), (n - 1) * sides * 6);
  const base = B.nv;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1) * 3, i1 = Math.min(n - 1, i + 1) * 3;
    let tx = pts[i1] - pts[i0], ty = pts[i1 + 1] - pts[i0 + 1], tz = pts[i1 + 2] - pts[i0 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    if (i === 0) {
      // first normal: perpendicular to the tangent, from a reference axis
      let rx = 0, ry = 1, rz = 0;
      if (Math.abs(ty) > 0.9) { rx = 1; ry = 0; }
      nx = ty * rz - tz * ry; ny = tz * rx - tx * rz; nz = tx * ry - ty * rx;
    } else {
      const d = nx * tx + ny * ty + nz * tz;
      nx -= tx * d; ny -= ty * d; nz -= tz * d;
    }
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const px = pts[i * 3], py = pts[i * 3 + 1], pz = pts[i * 3 + 2];
    const fu = furrow ? furrow[i] : 0;
    const aux = N + Math.min(fu, 0.99);
    for (let j = 0; j <= sides; j++) {
      const ph = (j / sides) * TAU, c = Math.cos(ph), s = Math.sin(ph);
      const dx = nx * c + bx * s, dy = ny * c + by * s, dz = nz * c + bz * s;
      const a = (j / sides) * N;
      let r = rad[i];
      if (disp > 0 && fu > 0) r *= 1 + disp * fu * (firRidge(a, vv[i], N) - 0.55);
      if (lobes) r *= lobes(i, ph);
      // bases never sink below the ground: the ground does not write depth
      const y = Math.max(0, py + dy * r);
      B.vert(px + dx * r, y, pz + dz * r, dx, dy, dz, a, vv[i], kind, ao[i], sway[i], aux);
    }
  }
  const S = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * S + j, b = a + 1, c = a + S, d = c + 1;
      B.tri(a, b, d); B.tri(a, d, c);
    }
  }
}

// A card bent along its length (drooping tip). o: base; d: unit direction; w: unit width
// axis; cn: crown-outward unit normal blended into the card normal (volumetric shading).
const _cn = new Float32Array(3);
function card(B, ox, oy, oz, dx, dy, dz, wx, wy, wz, len, wid, droop, tile, ao0, ao1, sw0, sw1, phase, cnx, cny, cnz, kind, segs = 3) {
  // card normal = d x w, flipped to face up, blended with the crown normal
  let qx = dy * wz - dz * wy, qy = dz * wx - dx * wz, qz = dx * wy - dy * wx;
  if (qy < 0) { qx = -qx; qy = -qy; qz = -qz; }
  let mx = qx * 0.4 + cnx * 0.6, my = qy * 0.4 + cny * 0.6 + 0.15, mz = qz * 0.4 + cnz * 0.6;
  const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
  B.reserve((segs + 1) * 2, segs * 6);
  const base = B.nv, hw = wid * 0.5;
  for (let k = 0; k <= segs; k++) {
    const s = k / segs;
    const px = ox + dx * len * s, py = oy + dy * len * s - droop * len * s * s, pz = oz + dz * len * s;
    const u = lerp(tile[0], tile[2], s);
    const ao = lerp(ao0, ao1, s), sw = lerp(sw0, sw1, s);
    B.vert(px - wx * hw, py - wy * hw, pz - wz * hw, mx, my, mz, u, tile[1], kind, ao, sw, phase);
    B.vert(px + wx * hw, py + wy * hw, pz + wz * hw, mx, my, mz, u, tile[3], kind, ao, sw, phase);
  }
  for (let k = 0; k < segs; k++) {
    const a = base + k * 2;
    B.tri(a, a + 1, a + 3); B.tri(a, a + 3, a + 2);
  }
}

// A strip between a top and a bottom polyline (hanging curtains). top/bot: [x,y,z]*m.
function strip(B, top, bot, m, tile, aoT, aoB, swT, swB, phase, nrm, kind) {
  B.reserve(m * 2, (m - 1) * 6);
  const base = B.nv;
  for (let k = 0; k < m; k++) {
    const s = m > 1 ? k / (m - 1) : 0;
    const u = lerp(tile[0], tile[2], s);
    const k3 = k * 3;
    B.vert(top[k3], top[k3 + 1], top[k3 + 2], nrm[k3], nrm[k3 + 1], nrm[k3 + 2], u, tile[1], kind, aoT[k], swT[k], phase);
    B.vert(bot[k3], Math.max(0.02, bot[k3 + 1]), bot[k3 + 2], nrm[k3], nrm[k3 + 1], nrm[k3 + 2], u, tile[3], kind, aoB[k], swB[k], phase);
  }
  for (let k = 0; k < m - 1; k++) {
    const a = base + k * 2;
    B.tri(a, a + 1, a + 3); B.tri(a, a + 3, a + 2);
  }
}

// ------------------------------------------------------------- the atlas
// 1024² RGBA, painted once with Canvas2D, uploaded as a DataTexture (transparent texels get a
// dark foliage colour so the mip chain does not bleed black into the needles).
const ATLAS = 1024;
const TILE = {
  sprayA: [0, 0, 0.5, 0.25],         // u0, v0, u1, v1 (v = canvas y / size): base -> tip along u
  sprayB: [0, 0.25, 0.5, 0.5],
  curtainA: [0.5, 0, 1, 0.5],        // branch axis along the top (v0), branchlets hang to v1
  curtainB: [0.5, 0.5, 1, 1],
  birch: [0, 0.5, 0.5, 1],           // birch limb along the top, weeping twigs hang down
};

function needleStroke(path, x, y, ang, len, bend) {
  const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
  const cx = x + Math.cos(ang) * len * 0.5 - Math.sin(ang) * bend, cy = y + Math.sin(ang) * len * 0.5 + Math.cos(ang) * bend;
  path.moveTo(x, y); path.quadraticCurveTo(cx, cy, ex, ey);
}

// One flat Douglas-fir spray: a twig with alternate side twigs, every axis clothed in soft,
// forward-pointing needles; sharp chestnut buds at the tips.
function paintSpray(g, rng, X, Y, W, Hh) {
  g.save(); g.beginPath(); g.rect(X, Y, W, Hh); g.clip();
  const cy = Y + Hh * 0.5;
  const twigs = [];
  // main axis, a gentle curve from base (left) to tip (right)
  const ax0 = X + 4, ay0 = cy + rr(rng, -5, 5), ax1 = X + W - 10, ay1 = cy + rr(rng, -10, 10);
  const acx = (ax0 + ax1) / 2, acy = cy + rr(rng, -14, 14);
  const axis = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, u = 1 - t;
    axis.push(u * u * ax0 + 2 * u * t * acx + t * t * ax1, u * u * ay0 + 2 * u * t * acy + t * t * ay1);
  }
  twigs.push({ pts: axis, w: 2.6, main: true });
  const nSide = 6 + Math.floor(rng() * 3);
  for (let k = 0; k < nSide; k++) {
    const t = 0.1 + 0.68 * (k + rng() * 0.5) / nSide;
    const side = k % 2 ? 1 : -1;
    const i = Math.floor(t * 40), px = axis[i * 2], py = axis[i * 2 + 1];
    const tdx = axis[i * 2 + 2] - axis[i * 2], tdy = axis[i * 2 + 3] - axis[i * 2 + 1];
    const ta = Math.atan2(tdy, tdx);
    const ang = ta + side * rr(rng, 0.55, 0.8);
    let len = W * (0.4 - 0.33 * t) * rr(rng, 0.8, 1.15);
    len = Math.min(len, (Hh * 0.5 - 16) / Math.max(0.3, Math.abs(Math.sin(ang))));
    const pts = [];
    const bend = side * rr(rng, -0.25, 0.05);
    for (let j = 0; j <= 14; j++) {
      const s = j / 14, a2 = ang + bend * s;
      pts.push(px + Math.cos(a2) * len * s, py + Math.sin(a2) * len * s);
    }
    twigs.push({ pts, w: 1.7, main: false });
  }
  // twigs
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const tw of twigs) {
    g.strokeStyle = tw.main ? '#4b3a28' : '#56432e';
    g.lineWidth = tw.w;
    g.beginPath(); g.moveTo(tw.pts[0], tw.pts[1]);
    for (let i = 2; i < tw.pts.length; i += 2) g.lineTo(tw.pts[i], tw.pts[i + 1]);
    g.stroke();
  }
  // needles in three shades (one path each, one stroke each)
  const shades = ['#283a22', '#33482a', '#3f5733'];
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  const tipPath = new Path2D();
  const scale = Hh / 256;
  for (const tw of twigs) {
    const p = tw.pts, n = p.length / 2;
    let acc = 0;
    const spacing = (tw.main ? 3.0 : 3.4) * scale;
    for (let i = 0; i < n - 1; i++) {
      const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[i * 2 + 2], y1 = p[i * 2 + 3];
      const sl = Math.hypot(x1 - x0, y1 - y0); const ta = Math.atan2(y1 - y0, x1 - x0);
      while (acc < sl) {
        const f = acc / sl, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
        const tt = (i + f) / (n - 1);
        const taper = 0.5 + 0.5 * Math.min(1, (1 - tt) * 3.2);
        const nl = rr(rng, 19, 27) * scale * taper * (tw.main ? 1 : 0.9);
        for (let sd = -1; sd <= 1; sd += 2) {
          const ang = ta + sd * rr(rng, 0.85, 1.3);
          needleStroke(paths[Math.floor(rng() * 3)], x, y, ang, nl, sd * rr(rng, -1.5, 2.5) * scale);
        }
        if (rng() < 0.45) needleStroke(paths[2], x, y, ta + rr(rng, -0.5, 0.5), nl * 0.62, rr(rng, -1, 1));
        acc += spacing * rr(rng, 0.8, 1.2);
      }
      acc -= sl;
    }
    // the bud at the tip: spindle-shaped, pointed, chestnut
    const ex = p[p.length - 2], ey = p[p.length - 1];
    const ea = Math.atan2(ey - p[p.length - 3], ex - p[p.length - 4]);
    tipPath.moveTo(ex - Math.cos(ea) * 2, ey - Math.sin(ea) * 2);
    tipPath.ellipse(ex + Math.cos(ea) * 2.5 * scale, ey + Math.sin(ea) * 2.5 * scale, 3.8 * scale, 1.4 * scale, ea, 0, TAU);
  }
  g.lineWidth = 2.1 * scale + 0.3;
  for (let s = 0; s < 3; s++) { g.strokeStyle = shades[s]; g.stroke(paths[s]); }
  g.fillStyle = '#5e3a20'; g.fill(tipPath);
  g.restore();
}

// A whole branch seen from the side: an axis along the top with branchlets hanging from it,
// clothed in needle tufts, a ragged lower edge, shorter toward the tip.
function paintCurtain(g, rng, X, Y, W, Hh) {
  g.save(); g.beginPath(); g.rect(X, Y, W, Hh); g.clip();
  g.lineCap = 'round'; g.lineJoin = 'round';
  const axY = (x) => Y + 10 + 20 * Math.sin(Math.PI * x / W * 0.8) - 18 * Math.pow(x / W, 3);
  const shades = ['#24341e', '#2e4127', '#3a5131'];
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  const twigP = new Path2D();
  let x = 6;
  while (x < W - 8) {
    const fx = x / W;
    const len = Hh * rr(rng, 0.4, 0.95) * (1 - 0.5 * fx) * (rng() < 0.12 ? 0.45 : 1);
    const x0 = X + x, y0 = axY(x);
    const fwd = rr(rng, 4, 36), sway = rr(rng, -12, 12);
    // a branchlet: down and a little forward, the tip turning forward
    const pts = [];
    for (let j = 0; j <= 18; j++) {
      const s = j / 18;
      pts.push(x0 + fwd * s * s + sway * Math.sin(s * 3), y0 + len * s - 8 * s * s * s);
    }
    twigP.moveTo(pts[0], pts[1]);
    for (let j = 2; j < pts.length; j += 2) twigP.lineTo(pts[j], pts[j + 1]);
    for (let j = 0; j < 18; j++) {
      const ax = pts[j * 2], ay = pts[j * 2 + 1], bx = pts[j * 2 + 2], by = pts[j * 2 + 3];
      const ta = Math.atan2(by - ay, bx - ax);
      const steps = 4;
      for (let q = 0; q < steps; q++) {
        const f = (q + rng()) / steps;
        const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
        const s = (j + f) / 18;
        const nl = rr(rng, 7, 12) * (0.6 + 0.4 * (1 - s));
        for (let sd = -1; sd <= 1; sd += 2) {
          needleStroke(paths[Math.floor(rng() * 3)], px, py, ta + sd * rr(rng, 0.9, 1.4) - 0.25, nl, sd * rr(rng, 0, 2));
        }
      }
      // short side sprays off the branchlet
      if (j > 2 && j < 15 && rng() < 0.16) {
        const sd = rng() < 0.5 ? -1 : 1, sa = ta + sd * rr(rng, 0.5, 0.9), sl = rr(rng, 14, 34);
        twigP.moveTo(ax, ay); twigP.lineTo(ax + Math.cos(sa) * sl, ay + Math.sin(sa) * sl);
        for (let q = 0; q < sl; q += 3) {
          const px = ax + Math.cos(sa) * q, py = ay + Math.sin(sa) * q;
          for (let s2 = -1; s2 <= 1; s2 += 2) needleStroke(paths[Math.floor(rng() * 3)], px, py, sa + s2 * rr(rng, 0.9, 1.3), rr(rng, 6, 9), 0);
        }
      }
    }
    x += rr(rng, 7, 13);
  }
  g.strokeStyle = '#3f3122'; g.lineWidth = 1.6; g.stroke(twigP);
  g.lineWidth = 1.9;
  for (let s = 0; s < 3; s++) { g.strokeStyle = shades[s]; g.stroke(paths[s]); }
  // the branch itself along the top
  g.strokeStyle = '#3a2c1f'; g.lineWidth = 5;
  g.beginPath(); g.moveTo(X, axY(0));
  for (let xx = 8; xx <= W; xx += 8) { g.lineWidth = 5 - 3.5 * xx / W; g.lineTo(X + xx, axY(xx)); }
  g.stroke();
  g.restore();
}

// Silver birch: a limb along the top with fine weeping twigs, a few late yellow leaves and
// catkins (autumn-thinned).
function paintBirch(g, rng, X, Y, W, Hh) {
  g.save(); g.beginPath(); g.rect(X, Y, W, Hh); g.clip();
  g.lineCap = 'round'; g.lineJoin = 'round';
  const leaves = [];
  // twigs spring from a few points on the limb, arch out and then weep straight down, so the
  // card reads as a rounded fountain of twigs, never as a rectangle
  const roots = [];
  const nr = 4 + Math.floor(rng() * 3);
  for (let r = 0; r < nr; r++) roots.push(X + W * (0.22 + 0.56 * (r + rng() * 0.7) / nr));
  const n = 38;
  for (let k = 0; k < n; k++) {
    const x0 = roots[Math.floor(rng() * nr)], y0 = Y + 4 + rng() * 10;
    const side = rng() < 0.5 ? -1 : 1;
    const spread = side * rr(rng, 10, 70) * (1 - Math.abs(x0 - X - W / 2) / W);
    const len = Hh * rr(rng, 0.35, 0.95) * (1 - 0.5 * Math.abs(spread) / 80);
    const wob = rr(rng, -6, 6);
    const pts = [];
    for (let j = 0; j <= 20; j++) {
      const s = j / 20;
      pts.push(x0 + spread * (1 - Math.pow(1 - s, 3)) + wob * Math.sin(s * 5 + k), y0 + len * Math.pow(s, 1.25));
    }
    for (let j = 0; j < 20; j++) {
      g.strokeStyle = j < 7 ? '#3d2a20' : '#46342a';
      g.lineWidth = lerp(2.0, 0.9, j / 20);
      g.beginPath(); g.moveTo(pts[j * 2], pts[j * 2 + 1]); g.lineTo(pts[j * 2 + 2], pts[j * 2 + 3]); g.stroke();
      // tiny side twiglets
      if (rng() < 0.18) {
        const sd = rng() < 0.5 ? -1 : 1, l2 = rr(rng, 10, 26);
        g.lineWidth = 0.8; g.beginPath(); g.moveTo(pts[j * 2], pts[j * 2 + 1]);
        g.quadraticCurveTo(pts[j * 2] + sd * l2 * 0.6, pts[j * 2 + 1] + l2 * 0.2, pts[j * 2] + sd * l2 * 0.7, pts[j * 2 + 1] + l2);
        g.stroke();
      }
      if (rng() < 0.2) leaves.push(pts[j * 2], pts[j * 2 + 1], j / 20);
    }
    if (rng() < 0.3) leaves.push(-1, pts[40], pts[41]); // catkin marker
  }
  // leaves: small, ovate-triangular with a toothed outline (approximated), hanging on petioles
  const cols = ['#8c7032', '#7a5c26', '#9a8040', '#62582a', '#734e22'];
  for (let i = 0; i < leaves.length; i += 3) {
    if (leaves[i] === -1) {
      const x = leaves[i + 1], y = leaves[i + 2];
      g.strokeStyle = '#3a2618'; g.lineWidth = 3.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 1, y + 14); g.stroke();
      continue;
    }
    const x = leaves[i], y = leaves[i + 1];
    const sz = rr(rng, 6, 10), a = Math.PI * 0.5 + rr(rng, -0.7, 0.7);
    const px = x + Math.cos(a) * 4, py = y + Math.sin(a) * 4;
    g.strokeStyle = '#4a3a24'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(px, py); g.stroke();
    g.fillStyle = cols[Math.floor(rng() * cols.length)];
    g.beginPath();
    const ca = Math.cos(a), sa = Math.sin(a);
    const tip = [px + ca * sz * 1.5, py + sa * sz * 1.5];
    g.moveTo(px, py);
    g.quadraticCurveTo(px + ca * sz * 0.5 - sa * sz * 0.85, py + sa * sz * 0.5 + ca * sz * 0.85, tip[0], tip[1]);
    g.quadraticCurveTo(px + ca * sz * 0.5 + sa * sz * 0.85, py + sa * sz * 0.5 - ca * sz * 0.85, px, py);
    g.fill();
  }
  g.restore();
}

export function makeTreeAtlas(seed = 7) {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(ATLAS, ATLAS) : Object.assign(document.createElement('canvas'), { width: ATLAS, height: ATLAS });
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32((seed * 7919 + 13) >>> 0);
  const h = ATLAS / 4, w = ATLAS / 2;
  paintSpray(g, rng, 0, 0, w, h);
  paintSpray(g, rng, 0, h, w, h);
  paintCurtain(g, rng, w, 0, w, w);
  paintCurtain(g, rng, w, w, w, w);
  paintBirch(g, rng, 0, w, w, w);
  const img = g.getImageData(0, 0, ATLAS, ATLAS);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) { d[i] = 34; d[i + 1] = 44; d[i + 2] = 28; d[i + 3] = 0; }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), ATLAS, ATLAS, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, tiles: TILE };
}

// ----------------------------------------------------------- Douglas-fir
// params: height (m), age 0 young (full to the ground, even cone) .. 1 old (clear trunk with dead
// stubs, long sweeping lower boughs, thinner lopsided top), lod 0|1|2, crown (width factor),
// cones (bool). Returns ONE BufferGeometry (bark, needles, dead wood and cones by aInfo.kind).
export function buildDouglasFir(params = {}, rng) {
  const p = Object.assign({ height: 16, age: 0.7, lod: 0, crown: 1, cones: true, seed: 1 }, params);
  if (typeof rng !== 'function') rng = mulberry32(p.seed);
  const H = p.height, A = clamp(p.age, 0, 1), L = p.lod | 0;
  const B = new GeoBuilder(L === 0 ? 32768 : 2048);

  const crownBase = H * lerp(0.012, 0.4, smooth(0.25, 1.0, A)) * rr(rng, 0.85, 1.15);
  const Rmax = H * lerp(0.25, 0.175, A) * p.crown;
  const r0 = H * lerp(0.013, 0.0175, A);
  const ph1 = rng() * TAU, ph2 = rng() * TAU;
  const leanX = rr(rng, -1, 1) * 0.004 * H, leanZ = rr(rng, -1, 1) * 0.004 * H;
  const bendX = A > 0.55 ? rr(rng, -1, 1) * 0.03 * H : 0, bendZ = A > 0.55 ? rr(rng, -1, 1) * 0.02 * H : 0;
  const tX = (y) => leanX * (y / H) + 0.003 * H * Math.sin(y * 0.41 + ph1) * (y / H) + bendX * Math.pow(Math.max(0, (y - 0.84 * H) / (0.16 * H)), 2);
  const tZ = (y) => leanZ * (y / H) + 0.003 * H * Math.sin(y * 0.37 + ph2) * (y / H) + bendZ * Math.pow(Math.max(0, (y - 0.84 * H) / (0.16 * H)), 2);
  const tR = (y) => r0 * Math.max(0.02, Math.pow(Math.max(0, 1 - y / H), 0.92)) * (1 + 0.55 * Math.exp(-y / (0.25 + 0.025 * H)));
  const swayTop = 0.0028 * H;
  const swayAt = (y) => swayTop * Math.pow(Math.max(0, y) / H, 2);
  // the crown envelope (0 = crown base, 1 = top): widest low on young trees, a quarter of the
  // way up on old ones, then a slightly convex taper to a narrow spire
  const fw = lerp(0.05, 0.22, A);
  const env = (f) => (f < fw ? lerp(0.78, 1, f / fw) : Math.pow(Math.max(0, (1 - f) / (1 - fw)), lerp(1.0, 0.8, A)));
  const reachAt = (y) => Rmax * env(clamp((y - crownBase) / (H - crownBase), 0, 1));

  // ---------------------------------------------------------- trunk
  {
    const ys = [];
    if (L === 0) ys.push(0, 0.05, 0.13, 0.25, 0.42, 0.65);
    else if (L === 1) ys.push(0, 0.25);
    else ys.push(0);
    const step = L === 0 ? 0.24 : L === 1 ? 0.8 : 2.4;
    let y = ys[ys.length - 1] + step;
    while (y < H * 0.985) { ys.push(y); y += step * (y > H * 0.85 && L === 0 ? 0.6 : 1); }
    ys.push(H * 0.995);
    const n = ys.length;
    const pts = new Float32Array(n * 3), rad = new Float32Array(n), vv = new Float32Array(n);
    const ao = new Float32Array(n), sw = new Float32Array(n), fu = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const yy = ys[i];
      pts[i * 3] = tX(yy); pts[i * 3 + 1] = yy; pts[i * 3 + 2] = tZ(yy);
      rad[i] = i === n - 1 ? 0.002 : tR(yy);
      vv[i] = yy;
      ao[i] = yy < crownBase ? lerp(0.95, 0.8, yy / Math.max(1, crownBase)) : lerp(0.6, 0.85, (yy - crownBase) / (H - crownBase));
      sw[i] = swayAt(yy);
      // furrows: deep at the base of old trees, smoother up the stem and on young trees
      fu[i] = clamp(lerp(0.12, 1.0, smooth(0.15, 0.9, A)) * (1 - 0.8 * smooth(0.25 * H, 0.8 * H, yy)), 0, 0.99);
    }
    const N = Math.round(lerp(8, 15, A));
    const sides = L === 0 ? Math.max(14, N * 3) : L === 1 ? 6 : 4;
    const lobePh = rng() * TAU, lobeN = 5 + Math.floor(rng() * 2);
    const lobes = L === 0 ? (i, phA) => {
      const yy = ys[i];
      const k = 0.5 * Math.exp(-yy / 0.32) * (0.4 + 0.6 * A);
      return 1 + k * (Math.pow(0.5 + 0.5 * Math.cos(lobeN * phA + lobePh + 0.6 * Math.sin(2 * phA)), 3) - 0.25);
    } : null;
    tube(B, pts, n, rad, vv, ao, sw, fu, sides, KIND_BARK, N, L === 0 ? 0.16 : 0, lobes);
  }

  // dead stubs on the clear stem of old trees
  if (L === 0 && crownBase > 1.4) {
    let y = 1.1 + rng() * 0.4;
    while (y < crownBase) {
      if (rng() < 0.7) {
        const az = rng() * TAU, len = rr(rng, 0.05, 0.5) * (0.4 + 0.6 * y / crownBase), al = rr(rng, -0.55, -0.1);
        const rs = tR(y) * rr(rng, 0.12, 0.22);
        const ca = Math.cos(az), sa = Math.sin(az), r = tR(y) * 0.8;
        const pts = new Float32Array([tX(y) + ca * r, y, tZ(y) + sa * r,
          tX(y) + ca * (r + len * 0.5 * Math.cos(al)), y + len * 0.5 * Math.sin(al), tZ(y) + sa * (r + len * 0.5 * Math.cos(al)),
          tX(y) + ca * (r + len * Math.cos(al)), y + len * Math.sin(al) - len * 0.08, tZ(y) + sa * (r + len * Math.cos(al))]);
        const s0 = swayAt(y);
        tube(B, pts, 3, new Float32Array([rs, rs * 0.75, rs * 0.35]), new Float32Array([0, len * 0.5, len]),
          new Float32Array([0.7, 0.75, 0.8]), new Float32Array([s0, s0, s0]), null, 4, KIND_DEAD, 2, 0, null);
      }
      y += rr(rng, 0.22, 0.6);
    }
  }

  // ---------------------------------------------------------- branches
  const cardLen = clamp(0.032 * H, 0.3, 0.62);
  const sp2 = Math.max(0.1, 0.0085 * H);
  const tmpTop = new Float32Array(64 * 3), tmpBot = new Float32Array(64 * 3), tmpN = new Float32Array(64 * 3);
  const aoT = new Float32Array(64), aoB = new Float32Array(64), swT = new Float32Array(64), swB = new Float32Array(64);
  const M = L === 0 ? 7 : L === 1 ? 4 : 2;
  const bp = new Float32Array((M + 1) * 3), brad = new Float32Array(M + 1), bv = new Float32Array(M + 1);
  const bao = new Float32Array(M + 1), bsw = new Float32Array(M + 1);

  const addBranch = (y, az, sizeK, forceDead) => {
    const f = clamp((y - crownBase) / (H - crownBase), 0, 1);
    const thinTop = A > 0.55 && f > 0.78;
    if (rng() < (thinTop ? 0.3 : lerp(0.04, 0.09, A))) return;     // a missing branch: a gap
    let reach = reachAt(y) * (L === 0 ? rr(rng, 0.72, 1.15) : rr(rng, 0.6, 1.25)) * sizeK;
    if (thinTop) reach *= rr(rng, 0.65, 1.1);
    if (reach < 0.12) return;
    const dead = forceDead || (A > 0.5 && f < 0.1 && rng() < 0.3);
    if (dead) reach *= rr(rng, 0.35, 0.7);
    // elevation along the branch: lower boughs leave the stem slightly down, sweep further
    // down and turn up at the tips; upper ones climb
    const a0 = lerp(lerp(-0.12, -0.3, A), 0.82, Math.pow(f, 1.25)) + rr(rng, -0.12, 0.12);
    const dn = lerp(L === 0 ? 0.36 : 0.46, 0.08, f) * lerp(0.55, 1.1, A) * rr(rng, 0.8, 1.2);
    const up = lerp(0.7, 0.12, f) * lerp(0.75, 1.0, A) * rr(rng, 0.75, 1.2);
    const yawD = rr(rng, -0.22, 0.22);
    const arc = reach * 1.08;
    const r1 = tR(y);
    let x = tX(y) + Math.cos(az) * r1 * 0.7, yy = y, z = tZ(y) + Math.sin(az) * r1 * 0.7;
    const ds = arc / M;
    for (let m = 0; m <= M; m++) {
      const s = m / M;
      bp[m * 3] = x; bp[m * 3 + 1] = yy; bp[m * 3 + 2] = z;
      bv[m] = s * arc;
      bao[m] = lerp(0.45, 0.9, s);
      bsw[m] = swayAt(y) + 0.012 * arc * Math.pow(s, 1.5);
      const al = a0 - dn * smooth(0, 0.6, s) * 1.0 + up * smooth(0.5, 1.0, s);
      const yw = az + yawD * s;
      x += Math.cos(al) * Math.cos(yw) * ds; yy += Math.sin(al) * ds; z += Math.cos(al) * Math.sin(yw) * ds;
    }
    for (let m = 0; m <= M; m++) if (bp[m * 3 + 1] < 0.05) bp[m * 3 + 1] = 0.05;
    const rb0 = Math.min(r1 * 0.5, 0.01 + 0.011 * arc) * (dead ? 0.8 : 1);
    for (let m = 0; m <= M; m++) brad[m] = rb0 * lerp(1, 0.14, m / M);
    if (L === 0) tube(B, bp, M + 1, brad, bv, bao, bsw, null, 5, dead ? KIND_DEAD : KIND_BARK, 3, 0, null);
    else if (L === 1 && rb0 > 0.025) tube(B, bp, M + 1, brad, bv, bao, bsw, null, 3, KIND_BARK, 3, 0, null);
    if (dead) {
      if (L === 0) { // a few bare, broken twigs
        for (let k = 0; k < 3; k++) {
          const m = 1 + Math.floor(rng() * (M - 1));
          const sx = bp[m * 3], sy = bp[m * 3 + 1], sz = bp[m * 3 + 2];
          const ta = az + (rng() < 0.5 ? -1 : 1) * rr(rng, 0.6, 1.1), tl = rr(rng, 0.08, 0.3) * arc;
          const tw = new Float32Array([sx, sy, sz, sx + Math.cos(ta) * tl, sy - tl * 0.2, sz + Math.sin(ta) * tl]);
          tube(B, tw, 2, new Float32Array([brad[m] * 0.5, 0.002]), new Float32Array([0, tl]), new Float32Array([0.6, 0.7]),
            new Float32Array([bsw[m], bsw[m] * 1.2]), null, 3, KIND_DEAD, 2, 0, null);
        }
      }
      return;
    }
    // crown-outward normal for the foliage of this branch
    const cnx = Math.cos(az) * 0.85, cny = lerp(0.1, 0.55, f), cnz = Math.sin(az) * 0.85;
    const radialAO = (px, py, pz) => {
      const rx = px - tX(py), rz = pz - tZ(py);
      const rr2 = Math.hypot(rx, rz) / Math.max(0.2, reachAt(py) + 0.15);
      return clamp((0.28 + 0.72 * smooth(0.05, 0.95, rr2)) * lerp(0.72, 1.0, f), 0.15, 1);
    };

    if (L === 0) {
      // secondary branchlets, alternating, hanging more on the low boughs, each one a spray
      const nSec = Math.max(2, Math.round(arc * 0.88 / sp2));
      for (let i = 0; i < nSec; i++) {
        const s = 0.1 + 0.86 * (i + rng() * 0.45) / nSec;
        const mf = s * M, m0 = Math.min(M - 1, Math.floor(mf)), fr = mf - m0;
        const px = lerp(bp[m0 * 3], bp[m0 * 3 + 3], fr), py = lerp(bp[m0 * 3 + 1], bp[m0 * 3 + 4], fr), pz = lerp(bp[m0 * 3 + 2], bp[m0 * 3 + 5], fr);
        let Tx = bp[m0 * 3 + 3] - bp[m0 * 3], Ty = bp[m0 * 3 + 4] - bp[m0 * 3 + 1], Tz = bp[m0 * 3 + 5] - bp[m0 * 3 + 2];
        const tl = Math.hypot(Tx, Ty, Tz) || 1; Tx /= tl; Ty /= tl; Tz /= tl;
        const side = i % 2 ? 1 : -1;
        // horizontal perpendicular
        let Sx = -Tz, Sz = Tx; const sl = Math.hypot(Sx, Sz) || 1; Sx = Sx / sl * side; Sz = Sz / sl * side;
        const beta = rr(rng, 0.7, 1.1), pend = lerp(0.6, 0.1, f) * lerp(0.6, 1.15, A) * rr(rng, 0.55, 1.35);
        let dx = Tx * Math.cos(beta) + Sx * Math.sin(beta), dy = Ty * Math.cos(beta) - Math.sin(pend), dz = Tz * Math.cos(beta) + Sz * Math.sin(beta);
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        const l2 = arc * 0.38 * Math.pow(1 - s, 0.6) * rr(rng, 0.75, 1.25) + cardLen * 0.5;
        const sw0 = bsw[m0] + (bsw[m0 + 1] - bsw[m0]) * fr;
        const droop2 = l2 * rr(rng, 0.12, 0.3);
        // only a long branchlet shows a short bare stub before its sprays
        if (l2 > cardLen * 1.3) {
          const r2 = Math.min(0.007, Math.max(0.003, brad[m0] * 0.4)), ls = l2 * 0.35;
          const tw = new Float32Array([px, py, pz, px + dx * ls, py + dy * ls - droop2 * 0.1, pz + dz * ls]);
          tube(B, tw, 2, new Float32Array([r2, r2 * 0.7]), new Float32Array([0, ls]),
            new Float32Array([0.5, 0.6]), new Float32Array([sw0, sw0 + 0.004 * ls]), null, 3, KIND_BARK, 2, 0, null);
        }
        // sprays along it, overlapping, the first from the bough itself, alternately splayed,
        // tips drooping; the outer ones a little smaller
        const nc = Math.max(1, Math.ceil((l2 - cardLen * 0.3) / (cardLen * 0.62)));
        for (let c = 0; c < nc; c++) {
          const t = nc === 1 ? 0 : (c / nc) * (1 - cardLen * 0.55 / l2);
          const len = cardLen * rr(rng, 0.82, 1.12) * (1 - 0.15 * c / nc);
          const qx = px + dx * l2 * t, qy = py + dy * l2 * t - droop2 * t * t, qz = pz + dz * l2 * t;
          const splay = c === 0 ? 0 : (c % 2 ? 1 : -1) * rr(rng, 0.1, 0.4);
          const cs = Math.cos(splay), sn = Math.sin(splay);
          let cx = dx * cs - dz * sn, cz = dx * sn + dz * cs, cyy = dy * 0.75 - 0.08 * c;
          const cl = Math.hypot(cx, cyy, cz); cx /= cl; cz /= cl; cyy /= cl;
          // width axis: horizontal perpendicular, rolled
          const roll = rr(rng, -0.5, 0.5);
          let wx = -cz, wz = cx; const wl = Math.hypot(wx, wz) || 1; wx /= wl; wz /= wl;
          const wy = Math.sin(roll); wx *= Math.cos(roll); wz *= Math.cos(roll);
          const ao0 = radialAO(qx, qy, qz) * 0.85, ao1 = radialAO(qx + cx * len, qy + cyy * len, qz + cz * len);
          const sw1 = sw0 + 0.012 * l2 + 0.006;
          card(B, qx, qy, qz, cx, cyy, cz, wx, wy, wz, len, len * 0.52, rr(rng, 0.1, 0.26),
            rng() < 0.5 ? TILE.sprayA : TILE.sprayB, ao0, ao1, sw0, sw1, rng(), cnx, cny, cnz, KIND_NEEDLE, 2);
        }
        // on the lower boughs, curtains of branchlets hang below (Douglas-fir's soft fringe)
        if (f < 0.65 && rng() < lerp(0.65, 0.15, f / 0.65) * lerp(0.6, 1, A)) {
          const len = cardLen * rr(rng, 0.8, 1.05);
          const hy = -rr(rng, 0.65, 0.95);
          let hx = dx * 0.5, hz = dz * 0.5; const hl = Math.hypot(hx, hy, hz); hx /= hl; hz /= hl;
          let wx = -dz, wz = dx; const wl = Math.hypot(wx, wz) || 1; wx /= wl; wz /= wl;
          card(B, px + dx * 0.05, py - 0.02, pz + dz * 0.05, hx, hy / hl, hz, wx, 0, wz, len, len * 0.5, 0.05,
            rng() < 0.5 ? TILE.sprayA : TILE.sprayB, radialAO(px, py, pz) * 0.8, radialAO(px, py - len, pz), sw0, sw0 + 0.012, rng(), cnx, cny * 0.5, cnz, KIND_NEEDLE, 2);
        }
      }
      // the leading spray at the tip of the bough, pointing on along it
      {
        const ex = bp[M * 3], ey = bp[M * 3 + 1], ez = bp[M * 3 + 2];
        let dx = ex - bp[M * 3 - 3], dy = ey - bp[M * 3 - 2], dz = ez - bp[M * 3 - 1];
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        let wx = -dz, wz = dx; const wl = Math.hypot(wx, wz) || 1; wx /= wl; wz /= wl;
        const len = cardLen * rr(rng, 1.0, 1.3);
        card(B, ex - dx * len * 0.35, ey - dy * len * 0.35, ez - dz * len * 0.35, dx, dy, dz, wx, 0, wz, len, len * 0.5, 0.12,
          TILE.sprayA, radialAO(ex, ey, ez), 1, bsw[M], bsw[M] + 0.01, rng(), cnx, cny, cnz, KIND_NEEDLE);
      }
      // pendant cones (Pseudotsuga's hang down; true firs' stand up)
      if (p.cones && A > 0.35 && f > 0.42 && f < 0.95 && rng() < 0.38) {
        const nCone = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < nCone; k++) {
          const s = rr(rng, 0.55, 0.95), m0 = Math.min(M - 1, Math.floor(s * M));
          const cx = bp[m0 * 3] + rr(rng, -0.08, 0.08), cy = bp[m0 * 3 + 1] - 0.02, cz = bp[m0 * 3 + 2] + rr(rng, -0.08, 0.08);
          const cl = rr(rng, 0.075, 0.1), cr = cl * 0.24;
          const nr = 6, cp = new Float32Array(nr * 3), crd = new Float32Array(nr), cv2 = new Float32Array(nr);
          const cao = new Float32Array(nr).fill(0.7), csw = new Float32Array(nr).fill(bsw[m0] + 0.01);
          const tilt = rr(rng, -0.25, 0.25);
          for (let q = 0; q < nr; q++) {
            const t = q / (nr - 1);
            cp[q * 3] = cx + Math.sin(tilt) * cl * t; cp[q * 3 + 1] = cy - cl * t; cp[q * 3 + 2] = cz;
            crd[q] = q === 0 ? cr * 0.25 : cr * Math.pow(Math.sin(Math.PI * (0.12 + 0.8 * t)), 0.7) * (q === nr - 1 ? 0.3 : 1);
            cv2[q] = t;
          }
          tube(B, cp, nr, crd, cv2, cao, csw, null, 6, KIND_CONE, 6, 0, null);
        }
      }
    } else {
      // LOD1/LOD2: the bough as hanging curtains (a shallow V tent under the branch) that read
      // as a Douglas-fir bough at any azimuth; the curtain texture carries the branchlets.
      const nRib = 2;
      const tile = rng() < 0.5 ? TILE.curtainA : TILE.curtainB;
      const dropK = rr(rng, 0.75, 1.25);
      const m = M + 1;
      for (let rIdx = 0; rIdx < nRib; rIdx++) {
        const tiltS = (rIdx === 0 ? 1 : -1) * rr(rng, 0.35, 0.7);
        const sN = -Math.sin(az), cN = Math.cos(az);   // horizontal perpendicular to the bough
        for (let k = 0; k < m; k++) {
          const s = k / (m - 1);
          const sx = s * 0.92 + 0.06;
          const mf = sx * M, m0 = Math.min(M - 1, Math.floor(mf)), fr = mf - m0;
          const px = lerp(bp[m0 * 3], bp[m0 * 3 + 3], fr), py = lerp(bp[m0 * 3 + 1], bp[m0 * 3 + 4], fr), pz = lerp(bp[m0 * 3 + 2], bp[m0 * 3 + 5], fr);
          const drop = arc * lerp(0.56, 0.26, f) * (0.45 + 0.55 * Math.sin(Math.PI * (0.18 + 0.72 * s))) * lerp(0.8, 1.15, A) * dropK;
          tmpTop[k * 3] = px; tmpTop[k * 3 + 1] = py + 0.04 * arc; tmpTop[k * 3 + 2] = pz;
          const hx = sN * Math.sin(tiltS) * drop, hz = cN * Math.sin(tiltS) * drop;
          tmpBot[k * 3] = px + hx - Math.cos(az) * drop * 0.12; tmpBot[k * 3 + 1] = py - Math.cos(tiltS) * drop; tmpBot[k * 3 + 2] = pz + hz - Math.sin(az) * drop * 0.12;
          let nx = Math.cos(az) * 0.8 + sN * Math.sign(tiltS) * 0.4, ny = 0.35, nz = Math.sin(az) * 0.8 + cN * Math.sign(tiltS) * 0.4;
          const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
          tmpN[k * 3] = nx; tmpN[k * 3 + 1] = ny; tmpN[k * 3 + 2] = nz;
          aoT[k] = radialAO(px, py, pz); aoB[k] = aoT[k] * 0.75;
          const swv = bsw[m0] + (bsw[m0 + 1] - bsw[m0]) * fr;
          swT[k] = swv; swB[k] = swv + 0.01 * drop;
        }
        // map the bough's length to the texture's branch axis
        strip(B, tmpTop, tmpBot, m, tile, aoT, aoB, swT, swB, rng(), tmpN, KIND_NEEDLE);
      }
    }
  };

  // whorls with irregular spacing, plus smaller internodal branches between them
  const whorlStep = H * lerp(0.045, 0.036, A) * (L === 2 ? 1.75 : L === 1 ? 1.15 : 0.88);
  let y = Math.max(0.12, crownBase) + rng() * whorlStep * 0.5;
  let wi = 0;
  while (y < H * 0.965) {
    const f = (y - crownBase) / (H - crownBase);
    const count = L === 2 ? 3 : (L === 0 ? 4 : 3) + Math.floor(rng() * (f > 0.8 ? 2 : 3));
    const off = wi * 2.39996 + rng() * 0.8;
    const vigour = rr(rng, 0.78, 1.15);
    for (let k = 0; k < count; k++) addBranch(y + rr(rng, -0.04, 0.04) * whorlStep, off + (k / count) * TAU + rr(rng, -0.4, 0.4), vigour, false);
    if (L === 0) {
      const mInt = Math.floor(rr(rng, 0, f > 0.85 ? 1.5 : 2.8));
      for (let k = 0; k < mInt; k++) addBranch(y + whorlStep * rr(rng, 0.25, 0.8), rng() * TAU, rr(rng, 0.35, 0.65), false);
    } else if (L === 1) {
      const mInt = rng() < 0.8 ? 1 + Math.floor(rng() * 1.6) : 0;
      for (let k = 0; k < mInt; k++) addBranch(y + whorlStep * rr(rng, 0.3, 0.7), rng() * TAU, rr(rng, 0.4, 0.75), false);
    }
    y += whorlStep * rr(rng, 0.7, 1.35) * (f > 0.85 ? 0.75 : 1);
    wi++;
  }
  // dead lower branches still hanging on, just below the live crown of old trees
  if (L === 0 && A > 0.5) {
    for (let k = 0; k < 4; k++) addBranch(crownBase * rr(rng, 0.75, 0.98), rng() * TAU, 0.8, true);
  }

  // the leader: the topmost shoot, with a few upward sprays around it
  {
    const yt = H * 0.94, xt = tX(yt), zt = tZ(yt);
    if (L === 0) {
      for (let k = 0; k < 4; k++) {
        const az = k * 1.7 + rng(), el = rr(rng, 0.9, 1.25);
        const dx = Math.cos(az) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(az) * Math.cos(el);
        let wx = -Math.sin(az), wz = Math.cos(az);
        const len = cardLen * rr(rng, 0.8, 1.1);
        card(B, xt, yt + rr(rng, -0.25, 0.2), zt, dx, dy, dz, wx, 0, wz, len, len * 0.45, 0.05, TILE.sprayB, 0.85, 1,
          swayAt(yt), swayAt(H) + 0.01, rng(), dx, 0.6, dz, KIND_NEEDLE, 2);
      }
    } else {
      for (let k = 0; k < 2; k++) {
        const az = k * Math.PI * 0.5 + rng() * 0.5, sN = -Math.sin(az), cN = Math.cos(az);
        const hw = H * 0.028;
        for (let q = 0; q < 2; q++) {
          const yy = q === 0 ? H * 0.88 : H * 1.005;
          tmpTop[q * 3] = tX(yy) + sN * hw * (1 - q); tmpTop[q * 3 + 1] = yy; tmpTop[q * 3 + 2] = tZ(yy) + cN * hw * (1 - q);
          tmpBot[q * 3] = tX(yy) - sN * hw * (1 - q); tmpBot[q * 3 + 1] = yy; tmpBot[q * 3 + 2] = tZ(yy) - cN * hw * (1 - q);
          tmpN[q * 3] = cN; tmpN[q * 3 + 1] = 0.6; tmpN[q * 3 + 2] = -sN;
          aoT[q] = aoB[q] = 0.9; swT[q] = swB[q] = swayAt(yy);
        }
        strip(B, tmpTop, tmpBot, 2, [0.5, 0.25, 1.0, 0.5], aoT, aoB, swT, swB, rng(), tmpN, KIND_NEEDLE);
      }
    }
  }

  const geo = B.build();
  geo.userData = { species: 'douglas-fir', height: H, age: A, lod: L, crownBase, crownRadius: Rmax, vertices: B.nv, triangles: B.ni / 3 };
  return geo;
}

// ----------------------------------------------------------- silver birch
// params: height (m), stems 1..3, lean (rad), leanAz (rad), lod (0 only, the birches stand near).
export function buildBirch(params = {}, rng) {
  const p = Object.assign({ height: 12, stems: 1, lean: 0.05, leanAz: 0, seed: 3 }, params);
  if (typeof rng !== 'function') rng = mulberry32(p.seed);
  const H = p.height, B = new GeoBuilder(16384);
  const stems = clamp(p.stems | 0, 1, 3);
  const tmpTop = new Float32Array(3 * 3), tmpBot = new Float32Array(3 * 3), tmpN = new Float32Array(3 * 3);
  const aoT = new Float32Array(3), aoB = new Float32Array(3), swT = new Float32Array(3), swB = new Float32Array(3);
  const swayTop = 0.004 * H;

  for (let st = 0; st < stems; st++) {
    const Hs = H * (st === 0 ? 1 : rr(rng, 0.72, 0.9));
    const la = p.lean + (st === 0 ? 0 : rr(rng, 0.08, 0.16));
    const laz = p.leanAz + (st === 0 ? 0 : (st === 1 ? 1 : -1) * rr(rng, 1.2, 2.2));
    const bx0 = st === 0 ? 0 : Math.cos(laz) * 0.08, bz0 = st === 0 ? 0 : Math.sin(laz) * 0.08;
    const curvePh = rng() * TAU, curveA = rr(rng, 0.01, 0.025) * Hs;
    const sX = (y) => bx0 + Math.cos(laz) * Math.tan(la) * y * (1 - 0.25 * y / Hs) + curveA * Math.sin(Math.PI * y / Hs + curvePh) * Math.cos(laz + 1.5) - curveA * Math.sin(curvePh) * Math.cos(laz + 1.5);
    const sZ = (y) => bz0 + Math.sin(laz) * Math.tan(la) * y * (1 - 0.25 * y / Hs) + curveA * Math.sin(Math.PI * y / Hs + curvePh) * Math.sin(laz + 1.5) - curveA * Math.sin(curvePh) * Math.sin(laz + 1.5);
    const r0 = Hs * 0.0115 * (st === 0 ? 1 : 0.8);
    const sR = (y) => r0 * Math.max(0.03, Math.pow(1 - y / Hs, 0.85)) * (1 + 0.35 * Math.exp(-y / 0.3));
    const swayAt = (y) => swayTop * Math.pow(y / H, 2);
    // stem
    const ys = [0, 0.06, 0.15, 0.3];
    for (let y = 0.5; y < Hs * 0.98; y += 0.28) ys.push(y);
    ys.push(Hs);
    const n = ys.length;
    const pts = new Float32Array(n * 3), rad = new Float32Array(n), vv = new Float32Array(n);
    const ao = new Float32Array(n), sw = new Float32Array(n), fu = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = ys[i];
      pts[i * 3] = sX(y); pts[i * 3 + 1] = y; pts[i * 3 + 2] = sZ(y);
      rad[i] = i === n - 1 ? 0.002 : sR(y); vv[i] = y; ao[i] = lerp(0.95, 0.75, y / Hs); sw[i] = swayAt(y);
      fu[i] = 0.99 - 0.8 * smooth(0.55, 1.0, y / Hs);   // whiteness: white stem, darker thin top
    }
    let N = Math.round((TAU * r0) / 0.035); N = Math.max(6, N + (N % 2));   // even, for the lenticel grid
    tube(B, pts, n, rad, vv, ao, sw, fu, 12, KIND_BIRCH, N, 0, null);

    // limbs: ascending, arching out and down at their ends; the twigs weep from them
    const nl = Math.round(rr(rng, 20, 27) * (st === 0 ? 1 : 0.65));
    for (let k = 0; k < nl; k++) {
      const fy = lerp(0.36, 0.95, Math.pow((k + rng() * 0.6) / nl, 0.85));
      const y = fy * Hs, az = k * 2.2 + rr(rng, -0.5, 0.5) + laz * 0.3;
      const len = Hs * 0.24 * (1 - 0.65 * smooth(0.4, 1.0, fy)) * rr(rng, 0.7, 1.2) + 0.35;
      const a0 = rr(rng, 0.55, 1.0), M = 5;
      const bp = new Float32Array((M + 1) * 3), br = new Float32Array(M + 1), bvv = new Float32Array(M + 1);
      const bao = new Float32Array(M + 1), bsw = new Float32Array(M + 1), bfu = new Float32Array(M + 1);
      let x = sX(y), yy = y, z = sZ(y);
      const ds = len / M;
      const rb0 = Math.min(sR(y) * 0.55, 0.035);
      for (let m = 0; m <= M; m++) {
        const s = m / M;
        bp[m * 3] = x; bp[m * 3 + 1] = yy; bp[m * 3 + 2] = z;
        br[m] = lerp(rb0, 0.004, s); bvv[m] = s * len; bao[m] = lerp(0.7, 0.85, s);
        bsw[m] = swayAt(y) + 0.02 * len * s * s; bfu[m] = lerp(0.95, 0.15, smooth(0.15, 1.0, s));
        const al = a0 - 1.25 * Math.pow(s, 1.4);
        x += Math.cos(al) * Math.cos(az) * ds; yy += Math.sin(al) * ds; z += Math.cos(al) * Math.sin(az) * ds;
      }
      tube(B, bp, M + 1, br, bvv, bao, bsw, bfu, 5, KIND_BIRCH, 4, 0, null);
      // weeping twig curtains along the outer part of the limb
      const nCur = 5 + Math.floor(rng() * 5);
      for (let c = 0; c < nCur; c++) {
        const s = rr(rng, 0.3, 1.0), m0 = Math.min(M - 1, Math.floor(s * M)), fr = s * M - m0;
        const px = lerp(bp[m0 * 3], bp[m0 * 3 + 3], fr), py = lerp(bp[m0 * 3 + 1], bp[m0 * 3 + 4], fr), pz = lerp(bp[m0 * 3 + 2], bp[m0 * 3 + 5], fr);
        const hl = rr(rng, 0.7, 1.7) * (0.6 + 0.4 * fy), hw = hl * rr(rng, 0.6, 0.85);
        const ca = rng() * TAU, cx = Math.cos(ca), cz = Math.sin(ca);
        const sw0 = bsw[m0];
        for (let q = 0; q < 2; q++) {
          const ox = (q === 0 ? -1 : 1) * hw * 0.5;
          tmpTop[q * 3] = px + cx * ox; tmpTop[q * 3 + 1] = py; tmpTop[q * 3 + 2] = pz + cz * ox;
          tmpBot[q * 3] = px + cx * ox * 1.2 + Math.cos(az) * hl * 0.12; tmpBot[q * 3 + 1] = py - hl; tmpBot[q * 3 + 2] = pz + cz * ox * 1.2 + Math.sin(az) * hl * 0.12;
          tmpN[q * 3] = Math.cos(az) * 0.8; tmpN[q * 3 + 1] = 0.4; tmpN[q * 3 + 2] = Math.sin(az) * 0.8;
          aoT[q] = 0.7; aoB[q] = 0.95; swT[q] = sw0; swB[q] = sw0 + 0.05 * hl;
        }
        const t = TILE.birch;
        const u0 = lerp(t[0], t[2], rr(rng, 0, 0.45)), u1 = u0 + (t[2] - t[0]) * rr(rng, 0.4, 0.55);
        strip(B, tmpTop, tmpBot, 2, [u0, t[1], Math.min(t[2], u1), t[3]], aoT, aoB, swT, swB, rng(), tmpN, KIND_TWIG);
      }
    }
  }
  const geo = B.build();
  geo.userData = { species: 'silver-birch', height: H, stems, vertices: B.nv, triangles: B.ni / 3 };
  return geo;
}

// ----------------------------------------------------------- material
const GLSL_NOISE = /* glsl */ `
  float tHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 tHash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash12(i), tHash12(i + vec2(1.0, 0.0)), u.x), mix(tHash12(i + vec2(0.0, 1.0)), tHash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // value noise periodic in x with period per (an integer), so the bark wraps without a seam
  float tPNoise(vec2 p, float per) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);
    return mix(mix(tHash12(vec2(x0, i.y)), tHash12(vec2(x1, i.y)), u.x), mix(tHash12(vec2(x0, i.y + 1.0)), tHash12(vec2(x1, i.y + 1.0)), u.x), u.y);
  }
`;

const VERT_HEAD = /* glsl */ `
  attribute vec4 aInfo;
  varying vec4 vInfo;
  varying vec3 vWorld;
  uniform float uTime, uWindK;
`;
const VERT_PROJECT = /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  float tScale = 1.0; vec2 tOrg = vec2(0.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
    tScale = length(instanceMatrix[1].xyz);
    tOrg = instanceMatrix[3].xz;
  #endif
  vec4 wPos = modelMatrix * mvPosition;
  {
    // wind toward +x: a mean bend plus two slow sways, crowns more than trunks (aInfo.z grows
    // with height and along the boughs); needle and twig cards flutter a little on top
    float sw = aInfo.z * tScale * uWindK;
    float ph = dot(tOrg, vec2(0.131, 0.093));
    float g = 0.55 + 0.3 * sin(uTime * 0.43 + ph) + 0.15 * sin(uTime * 1.07 + ph * 1.9 + wPos.y * 0.15);
    wPos.x += sw * g;
    wPos.z += sw * 0.3 * sin(uTime * 0.61 + ph * 1.3);
    float k = aInfo.x;
    if ((k > 0.5 && k < 1.5) || (k > 2.5 && k < 3.5)) {
      float fl = sin(uTime * 2.6 + aInfo.w * 6.2832 + wPos.x * 0.7) * (0.6 + 0.4 * sin(uTime * 0.37 + aInfo.w * 11.0));
      float amp = k > 2.5 ? 0.5 : 0.22;
      wPos.y += fl * sw * amp;
      wPos.x += fl * sw * amp * 0.5;
    }
  }
  vWorld = wPos.xyz;
  vInfo = aInfo;
  mvPosition = viewMatrix * wPos;
  gl_Position = projectionMatrix * mvPosition;
`;

const FRAG_HEAD = /* glsl */ `
  varying vec4 vInfo;
  varying vec3 vWorld;
  uniform sampler2D uAtlas;
  uniform float uTime, uFogK, uHazeK, uMistK, uRim, uFireAz, uBumpK, uAlbedoK, uLeafK;
  uniform vec3 uDark, uHaze, uWarm;
  uniform vec2 uCenter;
  uniform vec3 uFirRidge, uFirCork, uFirFurrow, uFirSmooth, uBirchW, uBirchD, uBirchTwig, uDeadW, uConeC, uLeafTint;
  float gWrap = 0.0;
  float gRim = 1.0;
  ${GLSL_NOISE}

#ifndef TREE_FOLIAGE
  // Douglas-fir bark: broad, corky, interlacing plates split by deep V furrows, cinnamon cork in
  // the furrow walls; smooth grey with resin blisters on young stems and high up.
  vec3 firBark(vec2 uv, float N, float furrow, float detail, out float h) {
    vec3 avgC = mix(mix(uFirCork, uFirRidge, 0.6) * 0.9, uFirSmooth, 1.0 - furrow);
    h = 0.0;
    if (detail < 0.02) return avgC;            // far away: one averaged tone, no noise
    float a = uv.x, v = uv.y;
    if (furrow < 0.06) {                       // boughs, twigs, young smooth stems: one noise
      float fb = tPNoise(vec2(a * 6.0, v * 2.5), N * 6.0);
      h = fb * 0.15 * detail;
      return mix(avgC, uFirSmooth * (0.8 + 0.35 * fb), detail);
    }
    float k = 6.2831853 / N;
    float w = 0.30 * sin(v * 1.9 + a * k * 2.0) + 0.21 * sin(v * 0.71 + a * k * 3.0 + 1.3) + 0.11 * sin(v * 4.3 + a * k * 5.0 + 2.1);
    // interlacing plates: an elongated cellular pattern around the stem (periodic in a), the
    // cell borders are the furrows, so they split and merge like real Douglas-fir bark
    vec2 q = vec2(a + w * 0.7, v * 2.3);
    vec2 qi = floor(q), qf = fract(q);
    float f1 = 8.0, f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = qi + vec2(float(i), float(j));
        vec2 rnd = tHash22(vec2(mod(c.x, N), c.y));
        vec2 d = vec2(float(i), float(j)) + 0.5 + 0.38 * (rnd - 0.5) * vec2(1.0, 1.6) - qf;
        d.y *= 0.55;                                 // plates are longer than they are wide
        float dd = dot(d, d);
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) { f2 = dd; }
      }
    }
    float edge = sqrt(f2) - sqrt(f1);
    float ridge = smoothstep(0.02, 0.32, edge);
    float m = tPNoise(vec2(a, v * 0.55), N);
    ridge *= 0.8 + 0.2 * m;
    // corky plates: fibrous vertical striation and thin horizontal layers
    float fib = tPNoise(vec2(a * 16.0, v * 2.2), N * 16.0);
    float lay = tPNoise(vec2(a * 3.0, v * 26.0), N * 3.0);
    float rough = mix(0.5, 0.55 * fib + 0.45 * lay, detail);
    vec3 col = mix(uFirFurrow, uFirCork, smoothstep(0.02, 0.3, ridge));
    col = mix(col, uFirRidge, smoothstep(0.35, 0.8, ridge));
    col = mix(col, uFirRidge * 1.25, smoothstep(0.6, 0.9, fib) * smoothstep(0.6, 1.0, ridge) * 0.6);   // weathered grey
    col *= 0.7 + 0.6 * rough;
    // young, smooth grey bark with resin blisters
    float bl = smoothstep(0.8, 0.93, lay) * smoothstep(0.35, 0.7, fib);
    vec3 sm = uFirSmooth * (0.82 + 0.3 * fib);
    sm = mix(sm, uFirCork * 1.2, bl * 0.5);
    col = mix(sm, col, furrow);
    h = mix(bl * 0.25, ridge * 0.8 + rough * 0.2, furrow) * detail;
    return mix(avgC, col, detail);
  }

  // Silver birch: chalk-white with dark horizontal lenticels, black diamonds below old branch
  // scars, a creamy-pink tone under peeling strips, and a black fissured base.
  vec3 birchBark(vec2 uv, float N, float white, float detail, out float h) {
    float a = uv.x, v = uv.y;
    h = 0.0;
    if (detail < 0.02) return mix(uBirchTwig, mix(uBirchD, uBirchW * 0.9, smoothstep(0.6, 1.4, v)), smoothstep(0.1, 0.8, white));
    vec3 col = uBirchW * (0.86 + 0.14 * tPNoise(vec2(a * 0.5, v * 2.5), N * 0.5));
    col = mix(col, col * vec3(1.0, 0.9, 0.82), smoothstep(0.6, 0.85, tPNoise(vec2(a * 1.0, v * 7.0), N)) * 0.6);
    vec2 gq = vec2(a * 0.5, v * 15.0);
    vec2 ci = floor(gq); vec2 cf = fract(gq);
    float rnd = tHash12(vec2(mod(ci.x, N * 0.5), ci.y));
    float len = 0.35 + 0.6 * tHash12(vec2(mod(ci.x, N * 0.5) + 7.0, ci.y));
    float cx = 0.5 + (tHash12(vec2(mod(ci.x, N * 0.5), ci.y + 3.0)) - 0.5) * 0.4;
    float dash = (1.0 - smoothstep(len * 0.5 - 0.06, len * 0.5, abs(cf.x - cx))) * (1.0 - smoothstep(0.05, 0.13, abs(cf.y - 0.5)));
    dash *= step(0.58, rnd) * detail;
    col = mix(col, uBirchD, dash * 0.85);
    vec2 dq = vec2(a * 3.0 / N, v * 1.1);
    vec2 di = floor(dq); vec2 df = fract(dq) - 0.5;
    float dr = tHash12(vec2(mod(di.x, 3.0), di.y) + 11.0);
    float dia = 1.0 - smoothstep(0.75, 1.0, abs(df.x) / 0.16 + abs(df.y) / 0.3);
    dia *= step(0.6, dr) * step(1.6, v);
    col = mix(col, uBirchD * 0.5, dia);
    // black, fissured base
    float baseH = 0.7 + 0.7 * tPNoise(vec2(a * 0.4, 0.5), max(1.0, floor(N * 0.4)));
    float base = 1.0 - smoothstep(baseH - 0.35, baseH + 0.3, v);
    float k = 6.2831853 / N;
    float fp = fract(a * 0.5 + 0.25 * sin(v * 3.0 + a * k * 2.0));
    float fis = smoothstep(0.05, 0.3, fp) * (1.0 - smoothstep(0.55, 0.95, fp));
    vec3 bc = mix(uBirchD * 0.6, uBirchD * 1.6, fis);
    col = mix(col, bc, base);
    // thin limbs and twigs are dark
    col = mix(uBirchTwig, col, smoothstep(0.1, 0.8, white));
    h = (-dash * 0.4 - dia * 0.5) * white + base * fis * 0.8;
    return col;
  }
#endif
`;

const FRAG_MAP = /* glsl */ `
  float tAO = vInfo.y;
  float tDarkK = 1.0;
  float tH = 0.0;
#ifdef TREE_FOLIAGE
  // atlas, with coverage kept up the mip chain and the alpha edge sharpened (alpha to coverage)
  vec4 tTex = texture2D(uAtlas, vUv);
  vec2 tUvPx = vUv * ${ATLAS.toFixed(1)};
  vec2 tDx = dFdx(tUvPx), tDy = dFdy(tUvPx);
  float tLod = 0.5 * log2(max(max(dot(tDx, tDx), dot(tDy, tDy)), 1e-8));
  float tA = tTex.a * (1.0 + max(tLod, 0.0) * 0.2);
  tA = (tA - 0.5) / max(fwidth(tA), 1e-4) + 0.5;
  diffuseColor.a = clamp(tA, 0.0, 1.0);
  if (diffuseColor.a <= 0.0) discard;
  diffuseColor.rgb *= tTex.rgb * uLeafTint * uLeafK * tAO;
  gWrap = 0.55;
  tDarkK = 0.85;
#else
  float tKind = vInfo.x;
  // bark detail fades out where a ridge is only a few pixels wide (no shimmer far away)
  float tDetail = 1.0 - smoothstep(0.18, 0.6, max(fwidth(vUv.x), fwidth(vUv.y) * 2.0));
  float tN = floor(vInfo.w), tF = fract(vInfo.w);
  vec3 tAlb;
  diffuseColor.a = 1.0;
  if (tKind < 0.5) {
    tAlb = firBark(vUv, max(tN, 1.0), tF, tDetail, tH);
  } else if (tKind < 2.5) {
    tAlb = birchBark(vUv, max(tN, 2.0), tF, tDetail, tH);
    tDarkK = mix(1.0, 1.7, tF);
  } else if (tKind < 4.5) {
    float g = tNoise(vec2(vUv.x * 3.0, vUv.y * 14.0));
    tAlb = uDeadW * (0.75 + 0.5 * g);
    tH = g * 0.4 * tDetail;
  } else {
    // cone: overlapping scales spiralling round
    float sc = fract(vUv.x * 1.0 + vUv.y * 9.0);
    float sc2 = fract(vUv.x * 1.0 - vUv.y * 6.0);
    float scale = smoothstep(0.0, 0.5, sc) * smoothstep(0.0, 0.5, sc2);
    tAlb = uConeC * (0.55 + 0.6 * scale);
    tH = scale * 0.6;
  }
  diffuseColor.rgb *= tAlb * uAlbedoK * tAO;
#endif
`;

const FRAG_NORMAL_BEGIN = /* glsl */ `
  float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
  vec3 normal = normalize(vNormal);
  vec3 nonPerturbedNormal = normal;
`;
const FRAG_NORMAL_MAPS = /* glsl */ `
#ifndef TREE_FOLIAGE
  {
    // bump from the procedural bark height (perturbNormalArb, Mikkelsen)
    vec2 dHdxy = vec2(dFdx(tH), dFdy(tH)) * uBumpK;
    vec3 vSigmaX = dFdx(-vViewPosition), vSigmaY = dFdy(-vViewPosition);
    vec3 R1 = cross(vSigmaY, normal), R2 = cross(normal, vSigmaX);
    float fDet = dot(vSigmaX, R1);
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    normal = normalize(abs(fDet) * normal - vGrad);
  }
#endif
`;
const FRAG_LAMBERT_PARS = /* glsl */ `
  varying vec3 vViewPosition;
  struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
  void RE_Direct_Lambert(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
    float nl = dot(geometryNormal, directLight.direction);
    float dotNL = saturate((nl + gWrap) / (1.0 + gWrap));
    // a warm rim where the surface turns away from the eye on the fire side
    float rim = 1.0 + uRim * gRim * pow(1.0 - saturate(abs(dot(geometryNormal, geometryViewDir))), 3.0) * saturate(nl + 0.3);
    reflectedLight.directDiffuse += dotNL * rim * directLight.color * BRDF_Lambert(material.diffuseColor);
  }
  void RE_IndirectDiffuse_Lambert(const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
    reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
  }
  #define RE_Direct RE_Direct_Lambert
  #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
`;
const FRAG_EMISSIVE = /* glsl */ `
  // the night's own dark tone (no ambient light in the scene): darker in the crown interior
  totalEmissiveRadiance = uDark * tDarkK * mix(0.55, 1.0, tAO);
`;
const FRAG_OPAQUE = /* glsl */ `
  {
    // the same low warm haze the sky lays on the ground, so trunks meet it without a seam
    vec2 rel = vWorld.xz - uCenter;
    float dist = length(rel);
    float t = clamp((dist - 36.0) / 49.0, 0.0, 1.0);
    float lowK = 0.62 * (1.0 - exp(-max(dist - 6.0, 0.0) / 30.0));
    float low = lowK * (1.0 - smoothstep(-0.5, 2.2 + 5.5 * t, vWorld.y));
    if (low > 0.002) {
      float n = tNoise(vec2((vWorld.x - uTime * 0.25) * 0.05, vWorld.z * 0.035 + vWorld.y * 0.12));
      n = 0.6 * n + 0.4 * tNoise(vec2((vWorld.x - uTime * 0.3) * 0.12 + 5.3, vWorld.z * 0.07 - vWorld.y * 0.2));
      low *= 1.0 + uMistK * (n - 0.5) * 0.9;
      float fa = atan(rel.x, -rel.y) - uFireAz;
      vec3 haze = uHaze + uWarm * exp(-fa * fa / 0.3);
      outgoingLight = mix(outgoingLight, haze, clamp(low, 0.0, 1.0) * uHazeK);
    }
  }
  #include <opaque_fragment>
`;
const FRAG_FOG = /* glsl */ `
  #ifdef USE_FOG
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth) * uFogK;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
  #endif
`;

function col(ctx, token, fallback) {
  let v = fallback;
  try { if (ctx && typeof ctx.readToken === 'function') v = ctx.readToken(token, fallback); } catch (e) { /* fallback */ }
  const c = new THREE.Color();
  try { c.set(typeof v === 'string' ? v.trim() : v); } catch (e) { c.set(fallback); }
  return c;
}

// opts: { ctx, center {x,z}, fireAz, fogAmount, haze, seed, atlas (reuse) }
export function createTreeMaterial(opts = {}) {
  const ctx = opts.ctx;
  const atlas = opts.atlas || makeTreeAtlas(opts.seed == null ? 7 : opts.seed);
  const hazeC = col(ctx, '--night-haze', '#3a2214').lerp(col(ctx, '--night-warm', '#26180f'), 0.18);
  const uniforms = {
    uAtlas: { value: atlas.texture },
    uTime: { value: 0 },
    uWindK: { value: 1 },
    uFogK: { value: opts.fogAmount == null ? DEFAULTS.fogAmount : opts.fogAmount },
    uHazeK: { value: opts.haze == null ? 1 : opts.haze },
    uMistK: { value: 1 },
    uRim: { value: 1.6 },
    uBumpK: { value: 0.06 },
    uAlbedoK: { value: 1.35 },          // bark
    uLeafK: { value: 1.5 },             // needles and twigs
    uFireAz: { value: opts.fireAz || 0 },
    uCenter: { value: new THREE.Vector2(opts.center ? opts.center.x : 0, opts.center ? opts.center.z : 12) },
    uDark: { value: new THREE.Color('#0b0705').multiplyScalar(0.95) },
    uHaze: { value: hazeC },
    uWarm: { value: col(ctx, '--fire', '#f0842c').multiplyScalar(0.016) },
    uFirRidge: { value: new THREE.Color('#544a43') },    // weathered grey-brown plate faces
    uFirCork: { value: new THREE.Color('#4f3022') },     // cinnamon cork in the furrow walls
    uFirFurrow: { value: new THREE.Color('#160d09') },   // the deep furrow bottoms
    uFirSmooth: { value: new THREE.Color('#5e5650') },   // young smooth grey bark
    uBirchW: { value: new THREE.Color('#d6d0c4').multiplyScalar(0.62) },
    uBirchD: { value: new THREE.Color('#1a1512') },
    uBirchTwig: { value: new THREE.Color('#3a2a22') },
    uDeadW: { value: new THREE.Color('#4e4740') },
    uConeC: { value: new THREE.Color('#7a5232') },
    uLeafTint: { value: new THREE.Color('#ffffff') },
  };
  const patch = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <project_vertex>', VERT_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <alphatest_fragment>', '')
      .replace('#include <normal_fragment_begin>', FRAG_NORMAL_BEGIN)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL_MAPS)
      .replace('#include <lights_lambert_pars_fragment>', FRAG_LAMBERT_PARS)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <opaque_fragment>', FRAG_OPAQUE)
      .replace('#include <fog_fragment>', FRAG_FOG);
  };
  // wood: opaque, front faces only (tubes are closed enough), procedural bark with bump
  const wood = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.FrontSide, fog: true, dithering: true });
  wood.defines = { USE_UV: '', TREE_WOOD: '' };
  wood.onBeforeCompile = patch;
  wood.customProgramCacheKey = () => 'iskry-trees-wood-1';
  // foliage: needle sprays and birch twigs, two-sided cards, alpha to coverage
  const foliage = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: true, dithering: true });
  foliage.alphaToCoverage = true;
  foliage.defines = { USE_UV: '', TREE_FOLIAGE: '' };
  foliage.onBeforeCompile = patch;
  foliage.customProgramCacheKey = () => 'iskry-trees-foliage-1';
  const material = [wood, foliage];
  const dispose = () => { wood.dispose(); foliage.dispose(); if (!opts.atlas) atlas.texture.dispose(); };
  return { material, uniforms, atlas, dispose };
}

// ----------------------------------------------------------- the scene
export function createTrees(ctx, opts = {}) {
  const t0 = performance.now();
  const o = Object.assign({}, DEFAULTS, opts || {});
  const fp = o.firePosition || DEFAULTS.firePosition;
  const C = o.center || DEFAULTS.center;
  const seed = (o.seed == null ? 7 : o.seed) | 0;
  const rng = mulberry32(seed * 2654435761 + 17);
  const noise = makeNoise1D(mulberry32(seed + 101));
  const fireAz = Math.atan2(fp.x - C.x, -(fp.z - C.z));

  const group = new THREE.Group();
  group.name = 'trees';
  const geos = [];
  const matH = createTreeMaterial({ ctx, center: C, fireAz, fogAmount: o.fogAmount, haze: o.haze, seed });
  const U = matH.uniforms;
  U.uWindK.value = clamp((o.wind == null ? 0.25 : o.wind) / 0.25, 0, 4);
  if (ctx && ctx.reducedMotion) U.uMistK.value = 1;

  // ------------------------------------------------------- variants (built once)
  const tb = performance.now();
  const V = {
    fir0: [
      { height: 7.5, age: 0.15, lod: 0, crown: 1.0, seed: seed * 13 + 1 },   // young, full to the ground
      { height: 14, age: 0.55, lod: 0, crown: 1.0, seed: seed * 13 + 2 },    // middle-aged
      { height: 19, age: 0.9, lod: 0, crown: 0.95, seed: seed * 13 + 3 },    // mature: clear stem, stubs
      { height: 20, age: 0.74, lod: 0, crown: 1.0, seed: seed * 13 + 4 },    // the nearest: furrowed stem, low boughs
    ],
    fir1: [
      { height: 8, age: 0.72, lod: 1, crown: 1.0, seed: seed * 17 + 1 },
      { height: 8, age: 0.55, lod: 1, crown: 1.12, seed: seed * 17 + 2 },
      { height: 7, age: 0.25, lod: 1, crown: 1.0, seed: seed * 17 + 3 },
      { height: 12, age: 0.95, lod: 1, crown: 0.82, seed: seed * 17 + 4 },  // emergent: tall, narrow, thin top
      { height: 8, age: 0.85, lod: 1, crown: 0.92, seed: seed * 17 + 5 },
    ],
    fir2: [
      { height: 8, age: 0.75, lod: 2, crown: 1.0, seed: seed * 19 + 1 },
      { height: 8, age: 0.45, lod: 2, crown: 1.1, seed: seed * 19 + 2 },
      { height: 12, age: 0.95, lod: 2, crown: 0.85, seed: seed * 19 + 3 },
      { height: 4, age: 0.1, lod: 2, crown: 1.0, seed: seed * 19 + 4 },      // young, for the understory
    ],
  };
  const built = {};
  for (const key in V) built[key] = V[key].map((pp) => { const g = buildDouglasFir(pp); geos.push(g); return g; });
  const birchGeos = [];
  const nBirch = clamp(o.birches | 0, 0, 3);
  if (nBirch > 0) {
    const bp = [
      { height: 12.5, stems: 1, lean: 0.07, leanAz: Math.PI * 0.85, seed: seed * 23 + 1 },
      { height: 11, stems: 2, lean: 0.05, leanAz: 0.2, seed: seed * 23 + 2 },
      { height: 10, stems: 1, lean: 0.1, leanAz: 0.1, seed: seed * 23 + 3 },
    ];
    for (let i = 0; i < nBirch; i++) { const g = buildBirch(bp[i]); geos.push(g); birchGeos.push(g); }
  }
  const buildMs = performance.now() - tb;

  // ------------------------------------------------------- placement
  // per variant: list of [x, z, rotY, sx, sy, dist]
  const lists = { fir0: V.fir0.map(() => []), fir1: V.fir1.map(() => []), fir2: V.fir2.map(() => []), birch: birchGeos.map(() => []) };
  const gap = (th) => 1 - o.gapDepth * Math.exp(-((th - fireAz) * (th - fireAz)) / (o.gapWidth * o.gapWidth));
  // 0 inside the valley clearing, easing to 1 over the feathered edges
  const cl = o.clearing, cf = o.clearingFeather || [0.15, 0.12];
  const open = (th) => {
    if (!cl) return 1;
    if (th > cl[0] && th < cl[1]) return 0;
    return th <= cl[0] ? smooth(0, 1, (cl[0] - th) / cf[0]) : smooth(0, 1, (th - cl[1]) / cf[1]);
  };
  const storkAz = o.stork ? Math.atan2(o.stork.x - C.x, -(o.stork.z - C.z)) : 0;
  const stork = (th) => (o.stork ? 1 - o.stork.depth * Math.exp(-((th - storkAz) * (th - storkAz)) / (o.stork.width * o.stork.width)) : 1);
  const hK = (th) => gap(th) * open(th) * stork(th);
  // nothing stands on the road, the fence line or a prop (layout.js is the source of truth)
  const blocked = (x, z) => {
    const rd = roadDistance(x, z);
    if (z < FENCE.fromZ + 2 && z > FENCE.toZ - 4 && rd > -(ROAD.halfWidth + 1.2) && rd < FENCE.offset + 1.5) return true;
    for (const p of [STORK, SHRINE, BENCH]) if (Math.hypot(x - p.x, z - p.z) < 2.2) return true;
    return false;
  };
  const place = (key, vi, x, z, H, widthK) => {
    if (blocked(x, z)) return;
    const vh = (key === 'birch' ? birchGeos[vi].userData.height : V[key][vi].height);
    const sy = H / vh, sx = sy * (widthK || 1);
    const d = Math.hypot(x - C.x, z - C.z);
    lists[key][vi].push([x, z, rng() * TAU, sx, sy, d]);
  };
  const atArc = (th, R) => [C.x + Math.sin(th) * R, C.z - Math.cos(th) * R];

  // the treeline
  for (let ri = 0; ri < o.rows.length; ri++) {
    const row = o.rows[ri];
    let th = -o.span + rng() * 0.02;
    while (th < o.span) {
      const dens = noise.fbm(th * 3.1 + 21 + ri * 5.3, 3);
      const k = hK(th), op = open(th);
      const stand = 0.62 + 0.8 * dens;
      let H = o.treeHeight * row.h * stand * k * rr(rng, 0.72, 1.22);
      const emergent = row.emergent && k > 0.8 && rng() < row.emergent;
      if (emergent) H = o.treeHeight * rr(rng, 1.45, 1.85) * k;
      // clearings in the stand, and a thinning stand toward the valley: lone firs at its edge
      const clearing = (!emergent && dens < 0.36 && rng() < row.clear) || rng() > Math.pow(op, 0.6);
      if (!clearing && H > 2.4) {
        const [x, z] = atArc(th, row.R + rr(rng, -1.2, 1.2));
        const key = row.lod === 1 ? 'fir1' : 'fir2';
        let vi;
        if (emergent) vi = key === 'fir1' ? 3 : 2;
        else if (key === 'fir1') vi = H < 6 ? 2 : [0, 1, 4, 0, 1][Math.floor(rng() * 5)];
        else vi = H < 5 ? 3 : rng() < 0.6 ? 0 : 1;
        place(key, vi, x, z, H, rr(rng, 0.85, 1.12) * lerp(0.8, 1, op));
      }
      const step = rr(rng, row.step[0], row.step[1]) * (1.3 - 0.55 * dens);
      th += step / row.R;
    }
  }
  // young firs between the rows, so the stand reads as a forest and not a fence of trunks
  if (o.understory) {
    for (const R of [51.3, 53.9, 56.5, 59.5]) {
      let th = -o.span + rng() * 0.03;
      while (th < o.span) {
        const k = hK(th), op = open(th);
        const H = rr(rng, 2.6, 4.8) * Math.sqrt(k) * (0.7 + 0.5 * noise.fbm(th * 5 + R, 2));
        if (rng() < Math.pow(op, 1.5) && H > 1.8) {
          const [x, z] = atArc(th, R + rr(rng, -1, 1));
          place('fir2', 3, x, z, H, rr(rng, 0.9, 1.2));
        }
        th += rr(rng, 1.2, 2.6) / R;
      }
    }
  }

  // the framing stands, near enough that bark and needle sprays read: on the left, beside the
  // fire, a big fir whose trunk and lowest boughs fill the edge, catching the firelight on its
  // fire side; on the right, beyond the fence and the road, a younger one with boughs to the
  // ground. All of them stay outside the middle of the words' band (x 25%-75%), clear of the
  // stork's pole, the shrine, the bench, the road and the fence.
  if (o.near) {
    const near = [
      // [theta, dist, fir0 variant, height]
      [-0.56, 12.5, 3, 20, 0.78], [-0.73, 17, 1, 14.5, 1], [-0.65, 23, 2, 19.5, 0.9],
      [0.58, 13, 1, 14, 0.85], [0.73, 20, 2, 20.5, 1], [0.5, 24, 0, 7, 1],
    ];
    // [.., crown width]: the nearest two are kept a little narrow so their boughs stop short of
    // the middle of the words' band
    for (const [th, d, vi, H, wk] of near) {
      const [x, z] = atArc(th, d);
      place('fir0', vi, x, z, H * rr(rng, 0.97, 1.03), wk * rr(rng, 0.97, 1.03));
    }
    // a few LOD1 firs bridging the stands into the treeline (clear of the stork and the valley)
    const mid = [[-0.66, 36, 10.5], [-0.6, 41, 7.5], [-0.7, 45, 9], [-0.9, 38, 10], [0.53, 42, 8], [0.62, 46, 9.5], [0.78, 39, 11], [-0.64, 48, 6.5], [0.5, 48, 7]];
    for (const [th, d, H] of mid) {
      const [x, z] = atArc(th + rr(rng, -0.015, 0.015), d);
      place('fir1', [0, 1, 4][Math.floor(rng() * 3)], x, z, H * rr(rng, 0.9, 1.1), rr(rng, 0.9, 1.1));
    }
  }
  const birchSpots = [[-0.41, 20, 12.5], [0.5, 11.5, 11.5], [0.68, 28, 10]];
  for (let i = 0; i < birchGeos.length; i++) {
    const [th, d, H] = birchSpots[i];
    const [x, z] = atArc(th, d);
    place('birch', i, x, z, H, 1);
  }

  // ------------------------------------------------------- instanced meshes
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let drawCalls = 0, instances = 0, verts = 0;
  const addSet = (key, geoList) => {
    for (let vi = 0; vi < geoList.length; vi++) {
      const L = lists[key][vi];
      if (!L.length) continue;
      L.sort((a, b) => a[5] - b[5]);                      // front to back
      const mesh = new THREE.InstancedMesh(geoList[vi], matH.material, L.length);
      for (let i = 0; i < L.length; i++) {
        const [x, z, ry, sx, sy] = L[i];
        q.setFromAxisAngle(up, key === 'birch' ? 0 : ry);
        pos.set(x, 0, z); scl.set(sx, sy, sx);
        m4.compose(pos, q, scl);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = `trees-${key}-${vi}`;
      // near first: the cards discard, so the GPU cannot hide what is drawn later behind them;
      // drawing front to back lets the depth test reject the far crowns behind the near ones
      mesh.renderOrder = key === 'fir0' || key === 'birch' ? 1 : key === 'fir1' ? 2 : 3;
      group.add(mesh);
      drawCalls++; instances += L.length; verts += geoList[vi].userData.vertices * L.length;
    }
  };
  addSet('fir0', built.fir0);
  addSet('fir1', built.fir1);
  addSet('fir2', built.fir2);
  addSet('birch', birchGeos);
  ctx.scene.add(group);

  const stats = { initMs: performance.now() - t0, buildMs, drawCalls, instances, vertices: verts };

  function update(t /* , dt */) {
    U.uTime.value = ctx.reducedMotion ? 0 : t;
  }
  function resize() { /* nothing depends on the viewport */ }
  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (const ch of group.children) if (ch.dispose) ch.dispose();
    for (const g of geos) g.dispose();
    matH.dispose();
  }
  return { group, update, resize, dispose, stats, uniforms: U };
}
