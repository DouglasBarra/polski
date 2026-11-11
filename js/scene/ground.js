/*
  Iskry · ground.js: the floor of the near world, out to 30 m. A November field at night.
  OWNER: Opus worker "ground". Interface: CONTRACT.md (environment modules).

  createGround(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), setTimeOfDay(tod) }
  opts { firePosition = FIRE, wind = 0.25, seed = 31 }
  Also exports groundHeight(x, z): the surface height (m) of the floor mesh, for anyone who
  wants to stand things on it (the floor is never below 0.005 m, nor above about 0.09 m).

  What it draws (2 draw calls):
    floor  one mesh, a polar fan around the camera's xz out to ZONES.nearReach. Gentle
           undulation (the geometry only rises: 0.005 m, flat along the road, up to a few cm
           of hummocks, two molehills, a slight rise toward the side stands), and a
           procedural MeshStandardMaterial (lit by the fire's PointLight, no baked glow):
             macro maps (3 DataTextures over x -30..30, z -19..9 at ~8 cm, baked at init):
               the road's footprint (darker, compacted; the road module draws the ruts),
               worn and trampled ground (around the fire, the bench, the approach from the road),
               the ash ring (radial, noisy edge: ash, charcoal, fire-reddened earth around it),
               moss, leaf litter (birch near the birches, oak elsewhere), fir needles under the
               side stands, contact shading, hue variation, the slope (normals), and grass.js's
               cover recomputed from the same layout inputs: under standing grass the floor is
               darker and matte (only a faint dew sheen), bare soil, road and ash keep theirs;
             detail maps (2 tileable 512^2 DataTextures, 2 m period, baked at init): matted
               dead-grass thatch, soil crumbs, birch and oak leaves, needles and twigs, pebbles,
               each feature with a rank, so the macro amounts decide which ones show and the
               tile never repeats the same picture. The detail fades out by distance (its mean
               takes over), so there is no tiling at the far end.
           Dew: low roughness on wet thatch and leaves catches the firelight at grazing angles;
           dried out near the fire. The unlit tone and the low haze are exactly sky.js's
           ground (same formula, same noise and time), and the floor's colour blends into it
           over the last metres and its alpha feathers out, so there is no edge.
    props  one merged mesh: a loose ring of soot-stained field stones at the fire, half-burnt
           sticks and charcoal in the ash, scattered field stones, a few twigs.

  Draw order: floor -44 in the OPAQUE pass (transparent: false, so it is drawn right after
  sky.js's ground at -45), writes depth, CustomBlending only so its outer rim feathers
  into the sky's ground. Props are ordinary opaque meshes (renderOrder 0).
  No global side effects (no lights, fog, background, renderer state); no per-frame allocations.
*/
import * as THREE from 'three';
import { FIRE, ZONES, ROAD, FENCE, BENCH, GUITAR, SHRINE, STORK, KEEP_OUT, roadProject, inKeepOut } from './layout.js';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,
  seed: 31,
  initBudgetMs: 45,        // bake time spent inside createGround ...
  frameBudgetMs: 9,        // ... and per frame after it, until the maps are done
};
const BASE_Y = 0.005;                    // floor height where it is flat (road, fire ring, props)
const RECT = { x0: -30, x1: 30, z0: -19, z1: 9 };   // macro maps cover this
const MW = 640, MH = 300;                // macro map size (texels), ~9.4 cm each
const DN = 512, DPERIOD = 2.0;           // detail tile: texels, metres
const DROT = 0.41;                       // detail tile rotation (rad), so it never lines up with the road
const DETAIL_FADE = [6.5, 15];             // m from the camera: full detail ... mean only
const EDGE = [21, 29.5];                 // m from ZONES.center: the colour becomes sky.js's ground
const ALPHA_EDGE = [28.6, 30.4];         // and the alpha feathers out
const REACH = 30.6;                      // the mesh ends here

// November palette (sRGB). Albedos stay physical: soil ~5%, thatch ~15-20%, ash ~25%.
const PAL = {
  soilDark: '#2b2119', soil: '#3e3024', soilWorn: '#433628', road: '#261e17', fresh: '#231a13',
  strawGrey: '#7b705f', strawOchre: '#8a744d', strawDark: '#51473a',
  moss: '#4c582c', mossDark: '#343f22',
  birchY: '#a8873e', birchB: '#7e5a30', oakL: '#7a5a38', oakD: '#4c331f',
  needle: '#74502f', needleD: '#4a3727', twig: '#4c4238',
  pebG: '#7f7a71', pebO: '#8d7c66', pebP: '#8c7570',
  ashPale: '#7f7a73', ashGrey: '#45413d', char: '#141110', redEarth: '#5e3a26',
};

// --------------------------------------------------------------- utilities
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hyp = (a, b) => Math.sqrt(a * a + b * b);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function hash3(ix, iy, s) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// value noise; p > 0 makes it periodic with p cells (for the tileable detail)
function vnoise(x, y, s, p = 0) {
  let ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  let ix1 = ix + 1, iy1 = iy + 1;
  if (p) { ix = ((ix % p) + p) % p; ix1 = ((ix1 % p) + p) % p; iy = ((iy % p) + p) % p; iy1 = ((iy1 % p) + p) % p; }
  const a = hash3(ix, iy, s), b = hash3(ix1, iy, s), c = hash3(ix, iy1, s), d = hash3(ix1, iy1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, oct, s, p = 0) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(x * f, y * f, s + o * 101, p ? p * f : 0);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
function segDist(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const u = clamp(((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1), 0, 1);
  return hyp(px - (ax + ex * u), pz - (az + ez * u));
}
function polyDist(px, pz, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return d;
}

// ------------------------------------------------------- the shared field
// Everything that depends only on (x, z): used by the mesh, the bake and the props.
const C = ZONES.center;
const bl = hyp(BENCH.dirX, BENCH.dirZ);
const BDX = BENCH.dirX / bl, BDZ = BENCH.dirZ / bl;
const BFX = BDZ > 0 ? -BDZ : BDZ, BFZ = BDZ > 0 ? BDX : -BDX;          // bench side facing +z (the fire)
const BA = [BENCH.x - BDX * BENCH.length / 2, BENCH.z - BDZ * BENCH.length / 2];
const BB = [BENCH.x + BDX * BENCH.length / 2, BENCH.z + BDZ * BENCH.length / 2];
const FEET = 0.62;                                                      // m in front of the log axis
const FA = [BA[0] + BFX * FEET, BA[1] + BFZ * FEET], FB = [BB[0] + BFX * FEET, BB[1] + BFZ * FEET];
// the approach: a worn line from the road's verge to the fire ring (the same desire path grass.js
// crops: from the ring's road side, angled toward us), and on round to the bench
const FIRE_KO = KEEP_OUT.find((k) => k.what === 'fire ring') || { x: FIRE.x, z: FIRE.z, r: 1.75 };
let APPROACH = null;
function buildApproach() {
  const side = roadProject(FIRE_KO.x, FIRE_KO.z).lateral < 0 ? 1 : -1;
  let bx = FIRE_KO.x;
  for (let i = 0; i < 600 && Math.abs(roadProject(bx, FIRE_KO.z + 0.9).lateral) > ROAD.halfWidth; i++) bx += 0.05 * side;
  APPROACH = [[FIRE_KO.x + side * (FIRE_KO.r + 0.1), FIRE_KO.z + 0.35], [bx, FIRE_KO.z + 0.9]];
}
const AROUND = [[-1.15, -1.0], [-0.75, -1.9], [-0.55, -3.1], [-0.95, -3.85]];
// molehills (kretowiska), clear of the road, fence, fire and bench
const MOLES = [[-5.6, 2.9, 0.26, 0.085], [7.4, -5.2, 0.24, 0.075], [-9.6, -3.4, 0.3, 0.09]];
// where trees.js stands its birches (soft: a moved birch still reads); leaves drift downwind (+x)
const BIRCH_LITTER = [[-6.2, -6.4, 4.5, 3.6], [7.2, 1.9, 4.0, 3.2]];

// road lateral on a coarse grid (roadProject is a polyline search), bilinear in between
const LG = 0.5, LNX = Math.round((RECT.x1 - RECT.x0) / LG) + 1, LNZ = Math.round((RECT.z1 - RECT.z0) / LG) + 1;
let latGrid = null;
function buildLatGrid() {
  if (latGrid) return;
  buildApproach();
  latGrid = new Float32Array(LNX * LNZ);
  for (let j = 0; j < LNZ; j++) for (let i = 0; i < LNX; i++) {
    const x = RECT.x0 + i * LG, z = RECT.z0 + j * LG;
    // far from the road the exact value does not matter; skip the search
    const p = roadProject(x, z);
    latGrid[j * LNX + i] = p.lateral;
  }
  buildSmoothGrids();
}
// smooth fields on a 0.25 m grid (they vary over metres), bilinear in between:
// n1, n2 (patch noises), the floor's rise above BASE_Y without molehills, the flat mask,
// distances to the trodden lines and the log, the birch-litter weight, |azimuth|
const SG = {};
const SG_KEYS = ['n1', 'n2', 'rise', 'flat', 'feet', 'appr', 'arnd', 'bench', 'birch', 'az'];
function buildSmoothGrids() {
  if (SG.n1) return;
  const G = 0.25, NX = Math.round((RECT.x1 - RECT.x0) / G) + 1, NZ = Math.round((RECT.z1 - RECT.z0) / G) + 1;
  SG.G = G; SG.NX = NX; SG.NZ = NZ;
  for (const key of SG_KEYS) SG[key] = new Float32Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = RECT.x0 + i * G, z = RECT.z0 + j * G, k = j * NX + i;
    const D = hyp(x - C.x, z - C.z);
    const az = Math.abs(Math.atan2(x - C.x, -(z - C.z)));
    const flat = flatAt(x, z, latAt(x, z));
    const hum = 0.026 * clamp((fbm(x * 0.42, z * 0.42, 3, 5) - 0.28) / 0.44, 0, 1);
    const rise = 0.055 * smooth(0.42, 0.9, az) * smooth(9, 24, D) + 0.012 * smooth(14, 28, D);
    let birchK = 0;
    for (const [bx, bz, sx, sz] of BIRCH_LITTER) birchK += Math.exp(-((x - bx) ** 2) / (2 * sx * sx) - ((z - bz) ** 2) / (2 * sz * sz));
    SG.n1[k] = fbm(x * 0.16, z * 0.16, 3, 11);
    SG.n2[k] = fbm(x * 0.55, z * 0.55, 3, 23);
    SG.rise[k] = flat * (hum + rise);
    SG.flat[k] = flat;
    SG.feet[k] = segDist(x, z, FA[0], FA[1], FB[0], FB[1]);
    SG.appr[k] = polyDist(x, z, APPROACH);
    SG.arnd[k] = polyDist(x, z, AROUND);
    SG.bench[k] = segDist(x, z, BA[0], BA[1], BB[0], BB[1]);
    SG.birch[k] = birchK;
    SG.az[k] = az;
  }
}
function gridAt(grid, x, z) {
  const G = SG.G, NX = SG.NX, NZ = SG.NZ;
  const fx = clamp((x - RECT.x0) / G, 0, NX - 1.001), fz = clamp((z - RECT.z0) / G, 0, NZ - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = grid[j * NX + i], b = grid[j * NX + i + 1], c = grid[(j + 1) * NX + i], d = grid[(j + 1) * NX + i + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function latAt(x, z) {
  const fx = clamp((x - RECT.x0) / LG, 0, LNX - 1.001), fz = clamp((z - RECT.z0) / LG, 0, LNZ - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = latGrid[j * LNX + i], b = latGrid[j * LNX + i + 1], c = latGrid[(j + 1) * LNX + i], d = latGrid[(j + 1) * LNX + i + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function moleAt(x, z) {
  let m = 0;
  for (let i = 0; i < MOLES.length; i++) {
    const M = MOLES[i], r = M[2], dx = x - M[0], dz = z - M[1];
    if (dx > r || dx < -r || dz > r || dz < -r) continue;
    const q = (dx * dx + dz * dz) / (r * r);
    if (q < 1) m = Math.max(m, M[3] * Math.pow(1 - q, 1.3) * (0.82 + 0.36 * vnoise(x * 16, z * 16, 77)));
  }
  return m;
}
// how much the floor may rise here (0 along the road, at the fire, under the bench and props)
function flatAt(x, z, lat) {
  const df = hyp(x - FIRE.x, z - FIRE.z);
  const bd = segDist(x, z, BA[0], BA[1], BB[0], BB[1]);
  let k = smooth(ROAD.halfWidth + 0.3, ROAD.halfWidth + 0.9, Math.abs(lat));
  k *= smooth(1.95, 2.8, df);
  k *= smooth(BENCH.radius + 0.1, BENCH.radius + 0.75, bd);
  k *= smooth(0.3, 0.7, hyp(x - GUITAR.x, z - GUITAR.z));
  k *= smooth(SHRINE.keepOut, SHRINE.keepOut + 0.5, hyp(x - SHRINE.x, z - SHRINE.z));
  k *= smooth(STORK.keepOut, STORK.keepOut + 0.5, hyp(x - STORK.x, z - STORK.z));
  return k;
}
function heightAt(x, z) {
  return BASE_Y + gridAt(SG.rise, x, z) + gridAt(SG.flat, x, z) * moleAt(x, z);
}
/** Surface height (m) of the floor at world (x, z). */
export function groundHeight(x, z) {
  buildLatGrid();
  return heightAt(x, z);
}

// ------------------------------------------------------------ props layout
function planProps(rng) {
  const R = (a, b) => a + (b - a) * rng();
  // half-burnt sticks pushed out of the fire, lying in the ash between the fire's logs
  // (fire.js logs point at about 0.30, 0.62, 2.23, 2.93, -2.77, -1.19, -1.23 rad)
  const sticks = [];   // [ax, az, bx, bz, r, charFrom (0..1 along from a, a = inner end)]
  const stickAz = [1.32, 1.72, -0.42, -1.95, 2.58, 0.98];
  for (const a0 of stickAz) {
    const a = a0 + R(-0.1, 0.1);
    const r0 = R(1.02, 1.25), len = R(0.3, 0.55), tw = R(-0.5, 0.5);
    const ax = FIRE.x + Math.cos(a) * r0, az = FIRE.z + Math.sin(a) * r0;
    const ex = Math.cos(a + tw), ez = Math.sin(a + tw);
    sticks.push([ax, az, ax + ex * len, az + ez * len, R(0.014, 0.028), R(0.45, 0.8)]);
  }
  const stones = [];   // [x, z, rx, ry, rz, rotY, kind] kind 0 field, 1 fire ring
  // a loose ring of field stones at the edge of the ash, sooted on the inner side; gaps
  // where people step in to feed the fire (toward the bench and the approach)
  const ringN = 11;
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2 + R(-0.18, 0.18);
    const x0 = FIRE.x + Math.cos(a) * R(1.55, 1.85), z0 = FIRE.z + Math.sin(a) * R(1.55, 1.85);
    if (segDist(x0, z0, BA[0], BA[1], BB[0], BB[1]) < BENCH.radius + 0.55) continue;
    if (polyDist(x0, z0, APPROACH) < 0.35) continue;
    const s = R(0.08, 0.15);
    if (sticks.some((k) => segDist(x0, z0, k[0], k[1], k[2], k[3]) < s * 2.1 + k[4] + 0.06)) continue;
    stones.push([x0, z0, s * R(1.0, 1.5), s * R(0.55, 0.8), s * R(0.8, 1.15), R(0, 6.3), 1]);
  }
  // scattered field stones (glacial erratics in a Polish field), most of them small
  let tries = 0;
  while (stones.length < 26 && tries++ < 3000) {
    const x = R(-17, 17), z = R(-15, 6.5);
    const D = hyp(x - C.x, z - C.z);
    if (D > 23 || C.z - z < 4.5 || Math.abs(x - C.x) > 0.72 * (C.z - z) + 2) continue;
    const lat = latAt(x, z);
    if (Math.abs(lat) < ROAD.halfWidth - 0.15) continue;
    if (Math.abs(lat - FENCE.offset * FENCE.side) < 0.4 && z < FENCE.fromZ + 0.5 && z > FENCE.toZ - 0.5) continue;
    if (hyp(x - FIRE.x, z - FIRE.z) < 2.3) continue;
    if (segDist(x, z, BA[0], BA[1], BB[0], BB[1]) < BENCH.radius + 0.5) continue;
    if (hyp(x - GUITAR.x, z - GUITAR.z) < 0.6 || hyp(x - SHRINE.x, z - SHRINE.z) < 0.7 || hyp(x - STORK.x, z - STORK.z) < 0.7) continue;
    if (moleAt(x, z) > 0) continue;
    const s = rng() < 0.9 ? R(0.025, 0.06) : R(0.07, 0.12);
    stones.push([x, z, s * R(1.0, 1.4), s * R(0.45, 0.75), s * R(0.75, 1.1), R(0, 6.3), 0]);
  }
  // charcoal lumps in the ash
  const coals = [];
  for (let i = 0; i < 26; i++) {
    const a = R(0, 6.283), r = R(1.08, 1.65);
    coals.push([FIRE.x + Math.cos(a) * r, FIRE.z + Math.sin(a) * r, R(0.012, 0.03)]);
  }
  // twigs: near the bench and the trampled ground (where they were dropped), under the birch
  const twigs = [];    // [x, z, angle, length, radius]
  const twigSpots = [[-1.2, -3.2, 1.2], [-4.6, -0.2, 1.4], [-0.6, -1.2, 1.0], [-5.8, 2.2, 1.6], [5.6, 2.6, 1.4], [-2.4, 1.0, 1.4]];
  for (const [sx, sz, sr] of twigSpots) {
    for (let k = 0; k < 2; k++) {
      const x = sx + R(-sr, sr), z = sz + R(-sr, sr);
      if (Math.abs(latAt(x, z)) < ROAD.halfWidth || hyp(x - FIRE.x, z - FIRE.z) < 1.9) continue;
      if (segDist(x, z, BA[0], BA[1], BB[0], BB[1]) < BENCH.radius + 0.15) continue;
      twigs.push([x, z, R(0, 6.3), R(0.16, 0.42), R(0.004, 0.008)]);
    }
  }
  return { stones, sticks, coals, twigs };
}

// ------------------------------------------------------------- macro bake
// A: road, worn, burn, moss   B: slope x, slope z, leaf litter, variation   C: needles, grass cover, birch, ao
function* bakeMacro(props) {
  const A = new Uint8Array(MW * MH * 4), B = new Uint8Array(MW * MH * 4), Cc = new Uint8Array(MW * MH * 4);
  const hs = new Float32Array(MW * MH);
  const dx = (RECT.x1 - RECT.x0) / MW, dz = (RECT.z1 - RECT.z0) / MH;
  const hw = ROAD.halfWidth;
  const fenceSide = FENCE.offset * FENCE.side;
  const to8 = (v) => Math.round(clamp(v, 0, 1) * 255);
  for (let j = 0; j < MH; j++) {
    if ((j & 7) === 7) yield;
    const z = RECT.z0 + (j + 0.5) * dz;
    for (let i = 0; i < MW; i++) {
      const x = RECT.x0 + (i + 0.5) * dx;
      const k = j * MW + i, k4 = k * 4;
      // one set of bilinear weights for all the smooth grids
      const gfx = clamp((x - RECT.x0) / SG.G, 0, SG.NX - 1.001), gfz = clamp((z - RECT.z0) / SG.G, 0, SG.NZ - 1.001);
      const gi = Math.floor(gfx), gj = Math.floor(gfz), gu = gfx - gi, gv = gfz - gj;
      const g00 = gj * SG.NX + gi, g10 = g00 + 1, g01 = g00 + SG.NX, g11 = g01 + 1;
      const w00 = (1 - gu) * (1 - gv), w10 = gu * (1 - gv), w01 = (1 - gu) * gv, w11 = gu * gv;
      const D = hyp(x - C.x, z - C.z);
      const aaz = (SG.az[g00] * w00 + SG.az[g10] * w10 + SG.az[g01] * w01 + SG.az[g11] * w11);
      const df = hyp(x - FIRE.x, z - FIRE.z);
      const lat = latAt(x, z), alat = Math.abs(lat);
      const n1 = (SG.n1[g00] * w00 + SG.n1[g10] * w10 + SG.n1[g01] * w01 + SG.n1[g11] * w11);
      const n2 = (SG.n2[g00] * w00 + SG.n2[g10] * w10 + SG.n2[g01] * w01 + SG.n2[g11] * w11);
      const n3 = vnoise(x * 2.1, z * 2.1, 37);
      const n4 = vnoise(x * 5.3, z * 5.3, 41);
      // the road's footprint (darker, compacted); fades where the road module fades it
      const roadFade = 1 - smooth(ROAD.fadeFrom, ROAD.fadeTo, D);
      const road = (1 - smooth(hw - 0.3, hw + 0.3, alat + (n2 - 0.5) * 0.4 + (n3 - 0.5) * 0.16)) * roadFade;
      // worn and trampled: a ring round the fire, the bench, the approach
      const wob = (n3 - 0.5) * 0.25;
      const ringW = smooth(1.2, 1.9, df) * (1 - smooth(2.2 + 1.1 * n2, 3.6 + 1.0 * n2, df + wob));
      const feet = 1 - smooth(0.28, 0.85, (SG.feet[g00] * w00 + SG.feet[g10] * w10 + SG.feet[g01] * w01 + SG.feet[g11] * w11) + wob);
      const appr = 0.78 * (1 - smooth(0.16, 0.55, (SG.appr[g00] * w00 + SG.appr[g10] * w10 + SG.appr[g01] * w01 + SG.appr[g11] * w11) + wob));
      const arnd = 0.62 * (1 - smooth(0.14, 0.5, (SG.arnd[g00] * w00 + SG.arnd[g10] * w10 + SG.arnd[g01] * w01 + SG.arnd[g11] * w11) + wob));
      const mole = moleAt(x, z);
      let worn = Math.max(ringW * 0.8, feet * 0.95, appr, arnd);
      worn = clamp(worn * (0.68 + 0.64 * n3) + (mole > 0 ? 1 : 0), 0, 1);
      // the ash ring, by radius from the fire with a ragged edge
      const fa = Math.atan2(z - FIRE.z, x - FIRE.x);
      const rr = df + (n3 - 0.5) * 0.34 + (n2 - 0.5) * 0.7 + (n4 - 0.5) * 0.14 + 0.16 * Math.sin(fa * 3 + 1.3) + 0.1 * Math.sin(fa * 5 + 0.4);
      const burn = 1 - smooth(0.75, 2.3, rr);
      // moss: big patches, more in the shade of the side stands and along the fence
      const shadeEdge = smooth(0.4, 0.78, aaz) * smooth(7, 14, D);
      const fenceStrip = (1 - smooth(0.22, 0.85, Math.abs(lat - fenceSide))) * smooth(FENCE.toZ - 1, FENCE.toZ + 1, z) * (1 - smooth(FENCE.fromZ - 1, FENCE.fromZ + 1, z));
      let moss = smooth(0.5, 0.7, n1 * 0.62 + n3 * 0.38 + 0.14 * shadeEdge + 0.12 * fenceStrip);
      moss *= (1 - worn) * (1 - road) * (1 - smooth(0.04, 0.3, burn)) * 0.92;
      // leaf litter: blown against the fence and into the side stands, under the birches
      const birchK = (SG.birch[g00] * w00 + SG.birch[g10] * w10 + SG.birch[g01] * w01 + SG.birch[g11] * w11);
      let litter = 0.14 + 0.42 * (n2 - 0.3) + 0.4 * fenceStrip + 0.22 * shadeEdge + 0.38 * birchK + 0.12 * (n4 - 0.5);
      litter *= (1 - 0.55 * road) * (1 - 0.5 * worn) * (1 - smooth(0.06, 0.3, burn)) * (mole > 0 ? 0 : 1);
      // needles under the side stands
      const needles = clamp(smooth(0.4, 0.72, aaz) * smooth(6, 13, D) * (0.45 + 0.6 * n2) + 0.1 * (n1 - 0.4), 0, 1) * (1 - 0.7 * road) * (1 - burn);
      // pebbles where the soil shows
      // grass cover: how much of the meadow (grass.js) stands here; under it the floor is in the
      // blades' shade, dark and matte. Same inputs as grass.js's site(): trampled near the fire
      // ring, the bench, the guitar, the shrine's foot and the desire path; cropped on the road's
      // crown and verges; bare in the ruts and the keep-outs.
      let T = 0.92 * (1 - smooth(FIRE_KO.r, FIRE_KO.r + 1.6, df));
      T = Math.max(T, 0.88 * (1 - smooth(BENCH.radius + 0.12, BENCH.radius + 1.22, (SG.bench[g00] * w00 + SG.bench[g10] * w10 + SG.bench[g01] * w01 + SG.bench[g11] * w11))));
      T = Math.max(T, 0.8 * (1 - smooth(0.25, 0.65, hyp(x - GUITAR.x, z - GUITAR.z))));
      T = Math.max(T, 0.55 * (1 - smooth(0.35, 0.95, hyp(x - SHRINE.x, z - SHRINE.z))));
      T = Math.max(T, 0.62 * (1 - smooth(0.22, 0.7, (SG.appr[g00] * w00 + SG.appr[g10] * w10 + SG.appr[g01] * w01 + SG.appr[g11] * w11))));
      let bare = inKeepOut(x, z, 0.04) ? 1 : 0;
      if (roadFade > 0.02 && alat < hw + 0.8) {
        const rutIn = ROAD.crownHalfWidth, rutOut = ROAD.rutOffset + ROAD.rutWidth * 0.75;
        if (alat > rutIn && alat < rutOut && roadFade > 0.35) bare = 1;
        const tr = alat <= rutIn ? 0.62 : alat < hw ? 0.85 + (0.5 - 0.85) * smooth(rutOut, hw, alat) : 0.5 * (1 - smooth(hw, hw + 0.8, alat));
        T = Math.max(T, tr * roadFade);
      }
      const cover = (1 - 0.8 * T) * (1 - bare) * (1 - smooth(ZONES.nearReach - 4, ZONES.nearReach, D));
      const birch = clamp(0.25 + 0.9 * birchK + 0.25 * (n1 - 0.5), 0, 1);
      // contact shading: the log, the guitar, the shrine post, the stork pole
      const bd = (SG.bench[g00] * w00 + SG.bench[g10] * w10 + SG.bench[g01] * w01 + SG.bench[g11] * w11);
      let ao = 1 - 0.55 * (1 - smooth(BENCH.radius * 0.45, BENCH.radius + 0.32, bd));
      ao *= 1 - 0.35 * (1 - smooth(0.04, 0.3, hyp(x - GUITAR.x, z - GUITAR.z)));
      ao *= 1 - 0.45 * (1 - smooth(0.04, 0.32, hyp(x - SHRINE.x, z - SHRINE.z)));
      ao *= 1 - 0.45 * (1 - smooth(0.04, 0.32, hyp(x - STORK.x, z - STORK.z)));
      const variation = clamp(0.5 + (n2 - 0.5) * 1.3 + (n4 - 0.5) * 0.45 - (mole > 0 ? 0.6 : 0), 0, 1);
      // height for shading: the mesh's undulation plus finer lumps
      const lumps = (0.014 * n4 + 0.005 * n3) * (1 - 0.6 * road) * (1 - 0.7 * smooth(0.5, 0.9, burn));
      hs[k] = BASE_Y + (SG.rise[g00] * w00 + SG.rise[g10] * w10 + SG.rise[g01] * w01 + SG.rise[g11] * w11) + (SG.flat[g00] * w00 + SG.flat[g10] * w10 + SG.flat[g01] * w01 + SG.flat[g11] * w11) * mole + lumps;
      A[k4] = to8(road); A[k4 + 1] = to8(worn); A[k4 + 2] = to8(burn); A[k4 + 3] = to8(moss);
      B[k4 + 2] = to8(litter); B[k4 + 3] = to8(variation);
      Cc[k4] = to8(needles); Cc[k4 + 1] = to8(cover); Cc[k4 + 2] = to8(birch); Cc[k4 + 3] = to8(ao);
    }
  }
  // contact shading under the props' stones
  for (const [sx, sz, rx, , rz] of props.stones) {
    const r = Math.max(rx, rz) * 1.7;
    const i0 = Math.floor((sx - r - RECT.x0) / dx), i1 = Math.ceil((sx + r - RECT.x0) / dx);
    const j0 = Math.floor((sz - r - RECT.z0) / dz), j1 = Math.ceil((sz + r - RECT.z0) / dz);
    for (let j = Math.max(0, j0); j <= Math.min(MH - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(MW - 1, i1); i++) {
      const x = RECT.x0 + (i + 0.5) * dx, z = RECT.z0 + (j + 0.5) * dz;
      const d = hyp(x - sx, z - sz) / r;
      if (d >= 1) continue;
      const k4 = (j * MW + i) * 4;
      Cc[k4 + 3] = Math.round(Cc[k4 + 3] * (1 - 0.35 * (1 - d * d)));
    }
  }
  // slopes (central differences)
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const k = j * MW + i;
    const xm = hs[j * MW + Math.max(0, i - 1)], xp = hs[j * MW + Math.min(MW - 1, i + 1)];
    const zm = hs[Math.max(0, j - 1) * MW + i], zp = hs[Math.min(MH - 1, j + 1) * MW + i];
    const sx = (xp - xm) / (2 * dx), sz = (zp - zm) / (2 * dz);
    B[k * 4] = Math.round(clamp(0.5 + 0.5 * sx, 0, 1) * 255);
    B[k * 4 + 1] = Math.round(clamp(0.5 + 0.5 * sz, 0, 1) * 255);
  }
  return { A, B, C: Cc };
}

// ------------------------------------------------------------ detail bake
// A: thatch fibre (0 = gap), leaf rank (1 = none), tone of the top feature, needle/twig rank
// B: slope x, slope z (tile metres), pebble rank (1 = none), crumb/cavity (0 dark .. 1 open)
function* bakeDetail(seed) {
  const N = DN, px = DPERIOD / N;                  // metres per texel
  const rng = mulberry32(seed * 977 + 5);
  const R = (a, b) => a + (b - a) * rng();
  const fib = new Float32Array(N * N), leaf = new Float32Array(N * N).fill(1), tone = new Float32Array(N * N);
  const ndl = new Float32Array(N * N).fill(1), peb = new Float32Array(N * N).fill(1), h = new Float32Array(N * N);
  const cav = new Float32Array(N * N);
  const wrap = (v) => ((v % N) + N) % N;
  // soil crumbs and the bumps of the soil, tileable
  const CQ = 128, cg = new Float32Array(CQ * CQ);          // the soft part at quarter resolution
  for (let j = 0; j < CQ; j++) for (let i = 0; i < CQ; i++) cg[j * CQ + i] = fbm(i / CQ * 24, j / CQ * 24, 3, 301, 24);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N, v = j / N;
    const gx = i / 4, gy = j / 4, i0 = Math.floor(gx), j0 = Math.floor(gy), fu = gx - i0, fv = gy - j0;
    const i1 = (i0 + 1) % CQ, j1 = (j0 + 1) % CQ;
    const c1 = (cg[j0 * CQ + i0] * (1 - fu) + cg[j0 * CQ + i1] * fu) * (1 - fv) + (cg[j1 * CQ + i0] * (1 - fu) + cg[j1 * CQ + i1] * fu) * fv;
    const c2 = vnoise(u * 96, v * 96, 307, 96);
    const k = j * N + i;
    h[k] = 0.0022 * c1 + 0.0009 * c2;
    cav[k] = clamp(0.25 + 1.1 * (c1 - 0.5) + 0.5 * (c2 - 0.5) + 0.5, 0, 1);
  }
  // stamp a segment with anti-aliased coverage; fn(k, cover, t, dist)
  function stampSeg(x0, y0, x1, y1, w, fn) {
    const minx = Math.floor(Math.min(x0, x1) - w - 1), maxx = Math.ceil(Math.max(x0, x1) + w + 1);
    const miny = Math.floor(Math.min(y0, y1) - w - 1), maxy = Math.ceil(Math.max(y0, y1) + w + 1);
    const ex = x1 - x0, ey = y1 - y0, L2 = ex * ex + ey * ey || 1;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const t = clamp(((cx - x0) * ex + (cy - y0) * ey) / L2, 0, 1);
      const d = hyp(cx - (x0 + ex * t), cy - (y0 + ey * t));
      const cover = clamp(w * 0.5 + 0.5 - d, 0, 1);
      if (cover > 0) fn(wrap(y) * N + wrap(x), cover, t, d);
    }
  }
  yield;
  // 1. matted dead grass: blades lying in clumps, flattened mostly one way per clump
  const nFib = 7000;
  for (let n = 0; n < nFib; n++) {
    if ((n & 511) === 511) yield;
    const x = R(0, N), y = R(0, N);
    const clump = vnoise(x / N * 6, y / N * 6, 311, 6);
    const ang = clump * 5.5 + R(-0.45, 0.45);
    const len = R(0.05, 0.18) / px, w = R(0.002, 0.0038) / px;
    const br = R(0.35, 1.0);
    const bend = R(-0.3, 0.3);
    const segs = 3;
    let ax = x, ay = y, a = ang;
    const hw = w * 0.5 + 0.5;
    for (let s = 0; s < segs; s++) {
      const bx = ax + Math.cos(a) * len / segs, by = ay + Math.sin(a) * len / segs;
      // inlined stampSeg: anti-aliased coverage of the segment, the blade fading to its tip
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1;
      const minx = Math.floor(Math.min(ax, bx) - hw), maxx = Math.ceil(Math.max(ax, bx) + hw);
      const miny = Math.floor(Math.min(ay, by) - hw), maxy = Math.ceil(Math.max(ay, by) + hw);
      for (let yy = miny; yy <= maxy; yy++) {
        const row = (((yy % N) + N) % N) * N, cy = yy + 0.5 - ay;
        for (let xx = minx; xx <= maxx; xx++) {
          const cx = xx + 0.5 - ax;
          let t = (cx * ex + cy * ey) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = cx - ex * t, qy = cy - ey * t;
          const cov = hw - Math.sqrt(qx * qx + qy * qy);
          if (cov <= 0) continue;
          const c = cov > 1 ? 1 : cov;
          const k = row + (((xx % N) + N) % N);
          const v = br * (1 - 0.25 * (s + t) / segs) * c;
          if (v > fib[k]) fib[k] = v;
          h[k] += 0.0015 * c;
        }
      }
      ax = bx; ay = by; a += bend;
    }
  }
  yield;
  // 2. pebbles (sorted so the lowest ranks lie on top)
  const pebs = [];
  for (let n = 0; n < 300; n++) pebs.push([R(0, N), R(0, N), (rng() < 0.8 ? R(0.005, 0.01) : R(0.011, 0.02)) / px, R(0.55, 1), R(0, 3.14), rng(), rng()]);
  pebs.sort((p, q) => q[5] - p[5]);
  for (const [x, y, r, e, a, rank, tn] of pebs) {
    const ca = Math.cos(a), sa = Math.sin(a), rr = Math.ceil(r + 1);
    for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++) {
      const lx = (xx * ca + yy * sa) / r, ly = (-xx * sa + yy * ca) / (r * e);
      const d2 = lx * lx + ly * ly;
      if (d2 >= 1) continue;
      const k = wrap(Math.floor(y) + yy) * N + wrap(Math.floor(x) + xx);
      peb[k] = rank; tone[k] = tn;
      h[k] += r * px * e * 0.7 * Math.sqrt(1 - d2);
      cav[k] = 1;
    }
  }
  // 3. needles and twigs (one rank channel)
  const ndls = [];
  for (let n = 0; n < 1700; n++) ndls.push([0, R(0, N), R(0, N), R(0, 6.28), R(0.015, 0.028) / px, 0.0016 / px, rng(), rng() * 0.5]);
  for (let n = 0; n < 26; n++) ndls.push([1, R(0, N), R(0, N), R(0, 6.28), R(0.06, 0.2) / px, R(0.0025, 0.005) / px, rng(), 0.6 + rng() * 0.4]);
  ndls.sort((p, q) => q[6] - p[6]);
  for (const [kind, x, y, a, len, w, rank, tn] of ndls) {
    const draw = (x0, y0, ang, L, W) => {
      stampSeg(x0, y0, x0 + Math.cos(ang) * L, y0 + Math.sin(ang) * L, W, (k, cov) => {
        if (cov > 0.35) { ndl[k] = Math.min(ndl[k], rank); tone[k] = tn; }
        h[k] += W * px * 0.5 * cov;
      });
    };
    draw(x, y, a, len, w);
    if (kind === 1) {         // a twig forks once
      const t = R(0.35, 0.7), fx = x + Math.cos(a) * len * t, fy = y + Math.sin(a) * len * t;
      draw(fx, fy, a + R(0.4, 0.8) * (rng() < 0.5 ? -1 : 1), len * R(0.25, 0.45), w * 0.7);
    }
  }
  // 4. leaves: birch (small, ovate, serrated) and oak (larger, lobed), lowest rank on top
  const leaves = [];
  for (let n = 0; n < 760; n++) leaves.push([0, R(0, N), R(0, N), R(0, 6.28), R(0.03, 0.05) / px, rng(), rng()]);
  for (let n = 0; n < 300; n++) leaves.push([1, R(0, N), R(0, N), R(0, 6.28), R(0.07, 0.11) / px, rng(), rng()]);
  leaves.sort((p, q) => q[5] - p[5]);
  let leafN = 0;
  for (const [kind, x, y, a, L, rank, tn] of leaves) {
    if ((++leafN & 127) === 0) yield;
    const ca = Math.cos(a), sa = Math.sin(a);
    const W = kind ? L * 0.34 : L * 0.36;
    const curl = R(0.3, 1);
    const rr = Math.ceil(L * 0.65 + 2);
    const cxp = x + ca * L * 0.5, cyp = y + sa * L * 0.5;      // leaf centre (the stem is at x, y)
    for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++) {
      const qx = Math.floor(cxp) + xx + 0.5 - x, qy = Math.floor(cyp) + yy + 0.5 - y;
      const u = (qx * ca + qy * sa) / L, v = (-qx * sa + qy * ca);
      let hwid;
      if (u < -0.12 || u > 1) continue;
      if (u < 0) hwid = 0.6;                                    // the stalk
      else if (kind === 0) hwid = W * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 0.9) * (1 + 0.07 * Math.sin(u * 46));
      else hwid = W * (0.3 + 0.7 * Math.sin(Math.PI * u)) * (0.62 + 0.38 * Math.abs(Math.sin(u * Math.PI * 4.5 + 0.4))) * smooth(0, 0.12, u);
      const cover = clamp(hwid - Math.abs(v) + 0.5, 0, 1);
      if (cover < 0.5) continue;
      const k = wrap(Math.floor(cyp) + yy) * N + wrap(Math.floor(cxp) + xx);
      const across = hwid > 0 ? Math.abs(v) / hwid : 0;
      const rib = Math.exp(-(v * v) / 0.6);                    // the midrib, a pixel wide
      const vein = 0.5 + 0.5 * Math.sin((u * 9 - across * 2.2) * Math.PI);
      const shade = clamp((0.86 + 0.14 * vein) * (1 - 0.3 * rib) * (1 - 0.2 * across * across), 0, 1);
      leaf[k] = rank;
      // tone: birch 0..0.48, oak 0.52..1; within it the leaf's own colour times its shading
      const t = clamp(tn * 0.75 + (1 - shade) * 0.25, 0, 1);
      tone[k] = kind ? 0.52 + 0.48 * t : 0.48 * t;
      h[k] += 0.0012 * curl * across * across - 0.0003 * rib;
      cav[k] = Math.max(cav[k], 0.85);
    }
  }
  yield;
  // slopes of the detail height
  const A = new Uint8Array(N * N * 4), B = new Uint8Array(N * N * 4);
  let fibCov = 0, fibBr = 0;
  const leafHist = new Float32Array(33);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, k4 = k * 4;
    const sx = (h[j * N + wrap(i + 1)] - h[j * N + wrap(i - 1)]) / (2 * px);
    const sz = (h[wrap(j + 1) * N + i] - h[wrap(j - 1) * N + i]) / (2 * px);
    A[k4] = Math.round(clamp(fib[k], 0, 1) * 255);
    A[k4 + 1] = Math.round(leaf[k] * 255);
    A[k4 + 2] = Math.round(tone[k] * 255);
    A[k4 + 3] = Math.round(ndl[k] * 255);
    B[k4] = Math.round(clamp(0.5 + 0.25 * sx, 0, 1) * 255);
    B[k4 + 1] = Math.round(clamp(0.5 + 0.25 * sz, 0, 1) * 255);
    B[k4 + 2] = Math.round(peb[k] * 255);
    B[k4 + 3] = Math.round(cav[k] * 255);
    const c = smooth(0.04, 0.3, fib[k]);
    fibCov += c; fibBr += fib[k];
    if (leaf[k] < 1) leafHist[Math.min(32, Math.floor(leaf[k] * 32))] += 1;
  }
  const total = N * N;
  // coverage of the ranked layers as a function of the level (for the distance fade):
  // leaves: fraction of texels with rank < L, fitted as a*L + b*L^2
  let cum = 0; const cumAt = [];
  for (let b = 0; b <= 32; b++) { cum += leafHist[b]; cumAt.push(cum / total); }
  const c50 = cumAt[16], c100 = cumAt[31];
  const la = 4 * c50 - c100, lb = 2 * c100 - 4 * c50;
  return { A, B, fibMean: [fibCov / total, fibBr / total], leafFit: [la, lb] };
}

// ------------------------------------------------------------------ GLSL
const lin = (hex) => new THREE.Color(hex);
const v3 = (hex) => { const c = lin(hex); return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`; };

// sky.js's GLSL_COMMON noise, verbatim, so the haze drifts exactly as on its ground
const GLSL_NOISE = /* glsl */ `
  float gHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float gNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash12(i), gHash12(i + vec2(1.0, 0.0)), u.x),
               mix(gHash12(i + vec2(0.0, 1.0)), gHash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;
// sky.js's ground, in linear space: tone of the meadow at xz (as if at y = 0), with its low haze.
// Returns the haze amount in `low` and the haze colour in `hz` so lit surfaces can share them.
const GLSL_SKYGROUND = /* glsl */ `
  uniform vec3 uGHaze, uGWarm, uGNear, uGDark;
  uniform vec2 uGCenter, uGFire;
  uniform float uGFireAz, uGTime, uGMistK, uGPool;
  vec3 gSkyBase(float D) { return mix(uGNear, uGDark, smoothstep(10.0, 40.0, D)); }
  void gHazeAt(vec2 xz, float y, out float D, out float low, out vec3 hz, out float aerial, out float uneven) {
    vec2 rel = xz - uGCenter;
    D = length(rel);
    aerial = 0.86 * pow(clamp((D - 25.0) / 400.0, 0.0, 1.0), 0.8);
    float fa = atan(rel.x, -rel.y) - uGFireAz;
    hz = uGHaze + uGWarm * exp(-fa * fa / 0.3);
    float lowK = 0.62 * (1.0 - exp(-max(D - 6.0, 0.0) / 30.0));
    low = lowK * (1.0 - smoothstep(-0.5, 2.2, y));
    float n = gNoise(vec2((xz.x - uGTime * 0.25) * 0.05, xz.y * 0.035 + y * 0.12));
    n = 0.6 * n + 0.4 * gNoise(vec2((xz.x - uGTime * 0.3) * 0.12 + 5.3, xz.y * 0.07 - y * 0.2));
    low = clamp(low * (1.0 + uGMistK * (n - 0.5) * 0.9), 0.0, 1.0);
    uneven = 1.0 + (0.2 * gNoise(xz * 0.35) - 0.1) * (1.0 - smoothstep(16.0, 34.0, D));
  }
  vec3 gApplyHaze(vec3 col, float low, vec3 hz, float aerial, float uneven) {
    col = mix(col, uGHaze, aerial);
    return mix(col, hz, low) * uneven;
  }
  vec3 gSkyGround(vec2 xz, float D, float low, vec3 hz, float aerial, float uneven) {
    vec3 col = gApplyHaze(gSkyBase(D), low, hz, aerial, uneven);
    float fd = length(xz - uGFire);
    return col + uGWarm * uGPool * exp(-fd * fd / 40.0);
  }
`;

// The haze, the sky's ground tone, the rim and the detail weight vary over metres: per vertex.
const FLOOR_VERT_PARS = /* glsl */ `
  varying vec3 vGW;
  varying vec4 vGH;            // haze amount, aerial, unevenness, rim (colour -> sky.js's ground)
  varying vec3 vGHz;           // haze colour (warmer toward the fire)
  varying vec3 vGSky;          // sky.js's ground here, hazed
  varying vec3 vGBase;         // sky.js's ground tone before the haze (the unlit tone)
  varying vec2 vGX;            // alpha, detail weight
  uniform vec2 uDetFade;
  uniform vec2 uEdge, uAlphaEdge;
  ${GLSL_NOISE}
  ${GLSL_SKYGROUND}
`;
const FLOOR_VERT_POS = /* glsl */ `
  #include <project_vertex>
  vGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  {
    float hD, hLow, hAer, hUn; vec3 hHz;
    gHazeAt( vGW.xz, 0.0, hD, hLow, hHz, hAer, hUn );
    vGH = vec4( hLow, hAer, hUn, smoothstep( uEdge.x, uEdge.y, hD ) );
    vGHz = hHz;
    vGSky = gSkyGround( vGW.xz, hD, hLow, hHz, hAer, hUn );
    vGBase = gSkyBase( hD );
    vGX = vec2( 1.0 - smoothstep( uAlphaEdge.x, uAlphaEdge.y, hD ),
                1.0 - smoothstep( uDetFade.x, uDetFade.y, length( vGW - cameraPosition ) ) );
  }
`;

const FLOOR_FRAG_PARS = /* glsl */ `
  varying vec3 vGW;
  varying vec4 vGH;
  varying vec3 vGHz, vGSky, vGBase;
  varying vec2 vGX;
  uniform sampler2D uMacA, uMacB, uMacC, uDetA, uDetB;
  uniform vec4 uRect;          // x0, z0, 1/w, 1/d
  uniform vec2 uDetRot;        // cos, sin
  uniform float uDetScale;
  uniform vec2 uFibMean;       // tile mean coverage, mean brightness
  uniform vec2 uLeafFit;       // leaf coverage(L) = a L + b L^2
  uniform vec2 uFireXZ;
  uniform float uDew;
  uniform vec3 uSkyLight;      // faint cool / warm light from the sky at dawn and dusk
  uniform vec3 uGHaze;
  float gVis(float rank, float level) {
    float w = fwidth(rank) * 0.5 + 0.012;
    return 1.0 - smoothstep(level - w, level + w, rank);
  }
  vec3 gBirch(float t) { return mix(${v3(PAL.birchY)}, ${v3(PAL.birchB)}, t); }
  vec3 gOak(float t) { return mix(${v3(PAL.oakL)}, ${v3(PAL.oakD)}, t); }
  vec3 gPeb(float t) { return t < 0.5 ? mix(${v3(PAL.pebG)}, ${v3(PAL.pebO)}, t * 2.0) : mix(${v3(PAL.pebO)}, ${v3(PAL.pebP)}, t * 2.0 - 1.0); }
`;

// Albedo, roughness, normal and the unlit tone, computed once at the top of main().
const FLOOR_FRAG_MAIN = /* glsl */ `
  vec2 gxz = vGW.xz;
  vec2 muv = ( gxz - uRect.xy ) * uRect.zw;
  vec4 mA = texture2D( uMacA, muv );   // road, worn, burn, moss
  vec4 mB = texture2D( uMacB, muv );   // slope x, slope z, litter, variation
  vec4 mC = texture2D( uMacC, muv );   // needles, grass cover, birch, ao
  float road = mA.r, worn = mA.g, burn = mA.b, moss = mA.a;
  float litter = mB.b, gvar = mB.a;
  float needles = mC.r, cover = mC.g, birch = mC.b, gao = mC.a;
  float pebK = clamp( 0.1 + 0.5 * worn + 0.55 * road + 0.35 * ( gvar - 0.5 ), 0.0, 1.0 );

  mat2 dRot = mat2( uDetRot.x, uDetRot.y, -uDetRot.y, uDetRot.x );
  vec2 duv = dRot * gxz * uDetScale;
  vec2 duvX = dFdx( duv ), duvY = dFdy( duv );
  float detW = vGX.y;
  vec4 dA = vec4( uFibMean.y, 1.0, 0.5, 1.0 );   // fibre, leaf rank, tone, needle rank
  vec4 dB = vec4( 0.5, 0.5, 1.0, 0.6 );          // slope x, slope z, pebble rank, cavity
  if ( detW > 0.0 ) {                            // far off only the means are used
    dA = textureGrad( uDetA, duv, duvX, duvY );
    dB = textureGrad( uDetB, duv, duvX, duvY );
  }

  float ashK = smoothstep( 0.42, 0.74, burn );
  float redK = smoothstep( 0.1, 0.3, burn ) * ( 1.0 - smoothstep( 0.46, 0.76, burn ) );
  float scorch = 1.0 - smoothstep( 0.05, 0.3, burn );

  // damp soil, darker where the cart wheels pressed it, a little lighter where trodden dry
  vec3 col = mix( ${v3(PAL.soilDark)}, ${v3(PAL.soil)}, gvar );
  col = mix( col, ${v3(PAL.fresh)}, step( 0.999, worn ) * ( 1.0 - gvar ) );
  col = mix( col, ${v3(PAL.soilWorn)}, worn * 0.6 * ( 1.0 - road ) );
  col = mix( col, ${v3(PAL.road)}, road );
  col *= mix( 0.92, 0.7 + 0.45 * dB.a, detW );

  // the matted dead grass (thatch): the floor the meadow grows from
  float th = ( 1.0 - worn * 0.82 ) * ( 1.0 - road * 0.92 ) * scorch * ( 0.62 + 0.38 * gvar );
  float fcov = mix( uFibMean.x, smoothstep( 0.04, 0.3, dA.r ), detW );
  float fbr = mix( uFibMean.y, dA.r, detW );
  vec3 straw = mix( ${v3(PAL.strawGrey)}, ${v3(PAL.strawOchre)}, smoothstep( 0.3, 0.8, gvar ) );
  straw = mix( straw, ${v3(PAL.strawDark)}, 0.35 + 0.4 * worn );        // damp, trodden flat
  col = mix( col, straw * ( 0.5 + 0.62 * fbr ), th * fcov );

  // moss cushions, settled in the hollows
  float mo = moss * mix( 0.85, clamp( 0.35 + 0.9 * ( 1.0 - dB.a ) + 0.4 * ( 1.0 - dA.r ), 0.0, 1.0 ), detW );
  col = mix( col, mix( ${v3(PAL.mossDark)}, ${v3(PAL.moss)}, gvar ) * mix( 1.0, 0.8 + 0.4 * dB.a, detW ), clamp( mo, 0.0, 1.0 ) );

  // pebbles where the soil shows; in the ash the same shapes are charcoal
  float pLevel = pebK * 0.75;
  float pv = mix( pLevel * 0.08, gVis( dB.b, pLevel ), detW );
  col = mix( col, gPeb( dA.b ) * mix( 0.8, 0.75 + 0.35 * dB.a, detW ), pv * ( 1.0 - ashK ) );

  // fir needles and twigs
  float nLevel = needles * 0.9 * scorch;
  float nv = mix( nLevel * 0.1, gVis( dA.a, nLevel ), detW );
  vec3 needleC = dA.b > 0.55 ? ${v3(PAL.twig)} : mix( ${v3(PAL.needle)}, ${v3(PAL.needleD)}, dA.b * 2.0 );
  col = mix( col, needleC, nv );

  // fallen leaves: birch yellow near the birches, oak brown elsewhere
  float isOak = step( 0.5, dA.b );
  float lLevel = litter * scorch * mix( 0.3 + 0.95 * birch, 1.25 - 0.9 * birch, isOak ) * 0.8;
  float lvFar = clamp( uLeafFit.x * litter + uLeafFit.y * litter * litter, 0.0, 1.0 ) * scorch * 0.8;
  float lv = mix( lvFar, gVis( dA.g, min( lLevel, 0.97 ) ), detW );
  vec3 leafC = isOak > 0.5 ? gOak( dA.b * 2.0 - 1.0 ) : gBirch( dA.b * 2.0 );
  vec3 leafFar = mix( gOak( 0.45 ), gBirch( 0.5 ), birch );
  col = mix( col, mix( leafFar, leafC, detW ), lv );

  // the fire: reddened earth at the edge of the burn, then ash with charcoal, sooty at the heart
  float redP = smoothstep( 0.25, 0.75, gvar + 0.35 * ( mix( 0.5, dB.a, detW ) - 0.5 ) );
  col = mix( col, ${v3(PAL.redEarth)} * ( 0.8 + 0.4 * gvar ), redK * ( 0.2 + 0.4 * redP ) );
  vec3 ash = mix( ${v3(PAL.ashGrey)}, ${v3(PAL.ashPale)}, smoothstep( 0.25, 0.85, mix( 0.5, dB.a, detW ) * 0.7 + 0.6 * ( gvar - 0.5 ) + 0.15 ) );
  float charV = mix( 0.22, gVis( dB.b, 0.5 ) + 0.35 * smoothstep( 0.45, 0.1, dB.a ), detW );
  ash = mix( ash, ${v3(PAL.char)}, clamp( charV, 0.0, 1.0 ) * 0.85 );
  ash = mix( ash, ${v3(PAL.char)} * 1.6, smoothstep( 0.82, 1.0, burn ) * 0.6 );
  col = mix( col, ash, ashK );
  col *= gao;
  // under the standing grass the floor is in the blades' shade (and seen through them)
  float canopy = cover * ( 1.0 - ashK );
  col *= 1.0 - 0.45 * canopy;

  // dew: wet thatch and leaves catch the firelight at grazing angles; dried out near the fire
  float dfire = length( gxz - uFireXZ );
  float wet = uDew * smoothstep( 1.8, 4.5, dfire ) * ( 0.65 + 0.35 * gvar );
  float gRough = 0.9;
  gRough = mix( gRough, 0.72, road * 0.7 + worn * 0.25 );
  gRough = mix( gRough, mix( 0.86, 0.58, wet ), th * fcov );
  gRough = mix( gRough, 0.78, clamp( mo, 0.0, 1.0 ) );
  gRough = mix( gRough, mix( 0.74, 0.55, wet ), pv * ( 1.0 - ashK ) );
  gRough = mix( gRough, mix( 0.8, 0.58, wet ), lv );
  gRough = mix( gRough, 0.97, ashK );
  gRough = max( gRough, mix( 0.7, 0.45, detW ) );     // no sub-pixel sparkle far off
  // specular strength: dew on the thatch and the leaves glints; soil, moss and ash barely
  float gSpec = 0.25 + 0.75 * wet * clamp( th * fcov * 0.7 + lv, 0.0, 1.0 );
  gSpec += 0.35 * wet * clamp( road + 0.6 * worn, 0.0, 1.0 );   // damp bare soil and the road's footprint
  gSpec *= 1.0 - 0.6 * ashK;
  gSpec *= 1.0 - 0.85 * canopy;                       // only a faint grazing dew sheen under the grass
  gRough = mix( gRough, max( gRough, 0.82 ), canopy );

  // slopes: the macro relief plus the detail (rotated back into world xz)
  vec2 sM = mB.rg * 2.0 - 1.0;
  vec2 sDt = ( dB.rg * 2.0 - 1.0 ) * 2.0;
  vec2 sD = vec2( dot( vec2( dRot[0][0], dRot[0][1] ), sDt ), dot( vec2( dRot[1][0], dRot[1][1] ), sDt ) );
  vec2 sl = sM + sD * detW * 0.45 * ( 1.0 - 0.4 * ashK );
  vec3 gNW = normalize( vec3( -sl.x, 1.0, -sl.y ) );

  // the unlit tone: sky.js's ground, varied by what lies here
  float gLum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 gEmis = vGBase * clamp( sqrt( gLum / 0.06 ), 0.55, 1.5 ) * ( 0.85 + 0.15 * gao ) * ( 0.8 + 0.2 * gNW.y );
  gEmis += col * uSkyLight * gNW.y;
`;

function patchFloor(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + FLOOR_VERT_PARS)
      .replace('#include <project_vertex>', FLOOR_VERT_POS);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FLOOR_FRAG_PARS)
      .replace('#include <map_fragment>', FLOOR_FRAG_MAIN + '\n  diffuseColor.rgb = col;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( gNW, 0.0 ) ).xyz );')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = gEmis;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n  reflectedLight.directSpecular *= gSpec;')
      .replace('#include <opaque_fragment>', /* glsl */ `
        #include <opaque_fragment>
        {
          vec3 lit = mix( mix( gl_FragColor.rgb, uGHaze, vGH.y ), vGHz, vGH.x ) * vGH.z;
          gl_FragColor.rgb = mix( lit, vGSky, vGH.w );
          gl_FragColor.a = vGX.x;
          #ifdef GROUND_DEBUG
            if ( GROUND_DEBUG == 1 ) gl_FragColor = vec4( col, 1.0 );
            if ( GROUND_DEBUG == 2 ) gl_FragColor = vec4( gNW * 0.5 + 0.5, 1.0 );
            if ( GROUND_DEBUG == 3 ) gl_FragColor = vec4( vec3( gRough ), 1.0 );
            if ( GROUND_DEBUG == 4 ) gl_FragColor = vec4( mA.rgb, 1.0 );
            if ( GROUND_DEBUG == 5 ) gl_FragColor = vec4( mB.rgb, 1.0 );
            if ( GROUND_DEBUG == 6 ) gl_FragColor = vec4( dA.rgb, 1.0 );
            if ( GROUND_DEBUG == 7 ) gl_FragColor = vec4( gEmis * 20.0, 1.0 );
          #endif
        }`);
  };
  mat.customProgramCacheKey = () => 'iskry-ground-floor' + (mat.defines && mat.defines.GROUND_DEBUG ? mat.defines.GROUND_DEBUG : '');
  return mat;
}

// props: vertex colours, a dim night tone on the unlit side, the same low haze
const PROP_VERT_PARS = /* glsl */ `
  varying vec3 vGW;
  varying vec3 vGUp;
`;
const PROP_VERT_POS = /* glsl */ `
  #include <project_vertex>
  vGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vGUp = normalize( mat3( modelMatrix ) * objectNormal );
`;
const PROP_FRAG_PARS = /* glsl */ `
  varying vec3 vGW;
  varying vec3 vGUp;
  ${GLSL_NOISE}
  ${GLSL_SKYGROUND}
`;
function patchProps(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + PROP_VERT_PARS)
      .replace('#include <project_vertex>', PROP_VERT_POS);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PROP_FRAG_PARS)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        {
          float pD = length( vGW.xz - uGCenter );
          float pl = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          totalEmissiveRadiance = gSkyBase( pD ) * clamp( pow( pl / 0.075, 0.5 ), 0.5, 1.4 ) * ( 0.72 + 0.28 * max( vGUp.y, 0.0 ) );
        }`)
      .replace('#include <opaque_fragment>', /* glsl */ `
        #include <opaque_fragment>
        {
          float hD, hLow, hAer, hUn; vec3 hHz;
          gHazeAt( vGW.xz, vGW.y, hD, hLow, hHz, hAer, hUn );
          gl_FragColor.rgb = gApplyHaze( gl_FragColor.rgb, hLow, hHz, hAer, hUn );
        }`);
  };
  mat.customProgramCacheKey = () => 'iskry-ground-props';
  return mat;
}

// --------------------------------------------------------- props geometry
function buildPropsGeometry(plan, rng) {
  const R = (a, b) => a + (b - a) * rng();
  const pos = [], nor = [], col = [];
  const c = new THREE.Color(), tmp = new THREE.Color();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  function push(geo, matrix, colorFn) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const pa = g.attributes.position, na = g.attributes.normal;
    nm.getNormalMatrix(matrix);
    for (let i = 0; i < pa.count; i++) {
      const lx = pa.getX(i), ly = pa.getY(i), lz = pa.getZ(i);
      P.set(lx, ly, lz).applyMatrix4(matrix);
      N.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(nm).normalize();
      pos.push(P.x, Math.max(P.y, 0.0), P.z); nor.push(N.x, N.y, N.z);
      colorFn(lx, ly, lz, P, N, c);
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  }
  const GRANITE = [lin('#5f5c57'), lin('#6a5f56'), lin('#55534f'), lin('#6e6359')];
  const SOOT = lin('#1a1613'), SOIL = lin('#2e241b'), LICHEN = lin('#8f8f78');
  // stones: a jittered, flattened icosahedron, a third of it below the floor
  for (const [x, z, rx, ry, rz, ry0, kind] of plan.stones) {
    const geo = new THREE.IcosahedronGeometry(1, kind ? 2 : 1);
    const pa = geo.attributes.position;
    const sd = Math.floor(rng() * 1e6);
    geo.setAttribute('normal', pa.clone());          // smooth: the unit sphere's normals (non-uniform scale is handled by the normal matrix)
    for (let i = 0; i < pa.count; i++) {
      const vx = pa.getX(i), vy = pa.getY(i), vz = pa.getZ(i);
      const k = 1 + 0.3 * (vnoise(vx * 1.7 + sd, vz * 1.7 + vy, 401) - 0.5) + 0.1 * (vnoise(vx * 4.1 + vy * 3, vz * 4.1 + sd, 409) - 0.5);
      pa.setXYZ(i, vx * k, vy > 0 ? vy * k : vy * k * 0.5, vz * k);
    }
    const base = GRANITE[Math.floor(rng() * GRANITE.length)].clone().multiplyScalar(R(0.85, 1.12));
    const bury = R(0.3, 0.5);
    m.compose(t.set(x, ry * (1 - bury), z), q.setFromEuler(e.set(R(-0.12, 0.12), ry0, R(-0.12, 0.12))), s.set(rx, ry, rz));
    const fx = FIRE.x, fz = FIRE.z;
    push(geo, m, (lx, ly, lz, p, n, out) => {
      out.copy(base);
      // mottled grain, pale lichen on the top of the field stones, soil stain near the ground
      out.multiplyScalar(0.86 + 0.28 * vnoise(lx * 6 + sd, lz * 6 + ly * 6, 419));
      if (!kind && n.y > 0.6 && vnoise(lx * 3 + sd, lz * 3, 421) > 0.62) out.lerp(LICHEN, 0.35);
      out.lerp(SOIL, smooth(0.05, 0.0, p.y - BASE_Y) * 0.6);
      if (kind) {
        // soot on the side facing the fire, heaviest low down
        const tx = fx - p.x, tz = fz - p.z, tl = hyp(tx, tz) || 1;
        const facing = clamp((n.x * tx + n.z * tz) / tl, 0, 1);
        out.lerp(SOOT, clamp(0.45 + 0.6 * facing, 0, 0.94));
      }
    });
  }
  // half-burnt sticks: charred black at the fire end with a pale ash crust, bark outward
  const BARK = lin('#4a3c30'), CHAR = lin('#121010'), ASHC = lin('#8a857e');
  for (const [ax, az, bx, bz, r, charTo] of plan.sticks) {
    const len = hyp(bx - ax, bz - az);
    const geo = new THREE.CylinderGeometry(r * 0.75, r, len, 7, 6, false);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const y = pa.getY(i);
      const k = 1 + 0.18 * (vnoise(y * 9, pa.getX(i) * 40, 431) - 0.5);
      pa.setX(i, pa.getX(i) * k); pa.setZ(i, pa.getZ(i) * k);
    }
    geo.computeVertexNormals();
    const ang = Math.atan2(bz - az, bx - ax);
    // lie along a->b, resting on the floor; the cylinder's +y end is b (outer)
    m.compose(t.set((ax + bx) / 2, BASE_Y + r * 0.8, (az + bz) / 2), q.setFromEuler(e.set(0, -ang, -Math.PI / 2, 'YXZ')), s.set(1, 1, 1));
    push(geo, m, (lx, ly, lz, p, n, out) => {
      const u = ly / len + 0.5;                       // 0 at the inner end, 1 outer
      const ch = 1 - smooth(charTo - 0.12, charTo + 0.08, u);
      out.copy(BARK).multiplyScalar(0.8 + 0.4 * vnoise(u * 12, lx * 50, 433));
      tmp.copy(CHAR).lerp(ASHC, smooth(0.5, 0.95, vnoise(u * 30, lz * 80, 437)) * 0.6 * smooth(0.25, 0.0, u));
      out.lerp(tmp, ch);
    });
  }
  // charcoal lumps
  for (const [x, z, r] of plan.coals) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    m.compose(t.set(x, BASE_Y + r * 0.3, z), q.setFromEuler(e.set(R(0, 3), R(0, 3), R(0, 3))), s.set(r * R(1, 1.6), r * R(0.5, 0.8), r));
    push(geo, m, (lx, ly, lz, p, n, out) => { out.copy(CHAR).lerp(ASHC, rng() < 0.2 ? 0.35 : 0.04); });
  }
  // twigs: thin, slightly bent, one fork
  const TWIG = lin('#4e4337'), TWIGD = lin('#3a3129');
  for (const [x, z, a, len, r] of plan.twigs) {
    const segs = [[0, len, r, a]];
    const fk = R(0.35, 0.65);
    segs.push([len * fk, len * R(0.3, 0.5), r * 0.7, a + R(0.45, 0.85) * (rng() < 0.5 ? -1 : 1)]);
    for (const [off, L, rad, ang] of segs) {
      const ox = x + Math.cos(a) * off, oz = z + Math.sin(a) * off;
      const geo = new THREE.CylinderGeometry(rad * 0.6, rad, L, 4, 1, false);
      m.compose(t.set(ox + Math.cos(ang) * L / 2, BASE_Y + rad + 0.002, oz + Math.sin(ang) * L / 2), q.setFromEuler(e.set(0, -ang, -Math.PI / 2, 'YXZ')), s.set(1, 1, 1));
      const tone = R(0, 1);
      push(geo, m, (lx, ly, lz, p, n, out) => { out.copy(TWIG).lerp(TWIGD, tone); });
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------ floor mesh
// A polar fan around the camera's xz: rings closer together near the camera.
function buildFloorGeometry() {
  const AZ = 1.25, NA = 220, NR = 84, R0 = 2.2;
  const pos = [], nor = [], idx = [];
  for (let j = 0; j <= NR; j++) {
    const r = R0 * Math.pow(REACH / R0, j / NR);
    for (let i = 0; i <= NA; i++) {
      const a = -AZ + (2 * AZ * i) / NA;
      const x = C.x + Math.sin(a) * r, z = C.z - Math.cos(a) * r;
      pos.push(x, heightAt(x, z), z);
      nor.push(0, 1, 0);
    }
  }
  const W = NA + 1;
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, b, c, b, d, c);         // counter-clockwise seen from above
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function dataTexture(data, w, h, aniso, wrap) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function colorFrom(ctx, token, fallback) {
  let v = fallback;
  try { if (ctx && typeof ctx.readToken === 'function') v = ctx.readToken(token, fallback); } catch (e) { /* fallback */ }
  const c = new THREE.Color();
  try { c.set(typeof v === 'string' ? v.trim() : v); } catch (e) { c.set(fallback); }
  return c;
}

// ================================================================== build
export function createGround(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const F = opts.firePosition ? { x: +opts.firePosition.x || 0, z: +opts.firePosition.z || 0 } : FIRE;
  const reduced = !!ctx.reducedMotion;
  const t0 = performance.now();
  buildLatGrid();

  const group = new THREE.Group();
  group.name = 'ground';
  ctx.scene.add(group);
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  const rng = mulberry32((o.seed | 0) * 7919 + 13);
  const plan = planProps(rng);
  const aniso = ctx.renderer && ctx.renderer.capabilities ? Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy()) : 1;
  const W = RECT.x1 - RECT.x0, Dz = RECT.z1 - RECT.z0;
  // The maps are baked in slices: some now, the rest over the next frames (a few ms each), so
  // loading never blocks for long. The floor shows when they are done (sky.js's ground until then).
  const blank = track(dataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1, THREE.ClampToEdgeWrapping));
  const jobs = [bakeMacro(plan), bakeDetail(o.seed | 0)], results = [];
  let jobAt = 0, bakeMs = 0;
  // sky.js's ground and haze, from the same tokens (see its GROUND_FRAG / GLSL_WORLD)
  const tHaze = colorFrom(ctx, '--night-haze', '#3a2214');
  const tNightWarm = colorFrom(ctx, '--night-warm', '#26180f');
  const tFire = colorFrom(ctx, '--fire', '#f0842c');
  const haze = tHaze.clone().lerp(tNightWarm, 0.18);
  const baseHaze = haze.clone();
  const duskHaze = baseHaze.clone().lerp(tFire, 0.03).multiplyScalar(1.08);
  const dawnHaze = baseHaze.clone().lerp(new THREE.Color('#5a5a62'), 0.12);
  const fireAz = Math.atan2(F.x - C.x, -(F.z - C.z));
  const sky = {
    uGHaze: { value: haze },
    uGWarm: { value: tFire.clone().multiplyScalar(0.016) },
    uGNear: { value: new THREE.Color('#0b0705') },
    uGDark: { value: new THREE.Color('#110b08') },
    uGCenter: { value: new THREE.Vector2(C.x, C.z) },
    uGFire: { value: new THREE.Vector2(F.x, F.z) },
    uGFireAz: { value: fireAz },
    uGTime: { value: 0 },
    uGMistK: { value: 1 },
    uGPool: { value: 0.0045 / 0.016 },
  };
  const skyLight = new THREE.Color(0, 0, 0);
  const floorUniforms = {
    ...sky,
    uMacA: { value: blank }, uMacB: { value: blank }, uMacC: { value: blank },
    uDetA: { value: blank }, uDetB: { value: blank },
    uRect: { value: new THREE.Vector4(RECT.x0, RECT.z0, 1 / W, 1 / Dz) },
    uDetRot: { value: new THREE.Vector2(Math.cos(DROT), Math.sin(DROT)) },
    uDetScale: { value: 1 / DPERIOD },
    uDetFade: { value: new THREE.Vector2(DETAIL_FADE[0], DETAIL_FADE[1]) },
    uFibMean: { value: new THREE.Vector2(0.5, 0.5) },
    uLeafFit: { value: new THREE.Vector2(0, 0) },
    uFireXZ: { value: new THREE.Vector2(F.x, F.z) },
    uDew: { value: 0.8 },
    uSkyLight: { value: skyLight },
    uEdge: { value: new THREE.Vector2(EDGE[0], EDGE[1]) },
    uAlphaEdge: { value: new THREE.Vector2(ALPHA_EDGE[0], ALPHA_EDGE[1]) },
  };

  // ------------------------------------------------------------- floor
  const floorGeo = track(buildFloorGeometry());
  const floorMat = track(patchFloor(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0, fog: false, dithering: true,
    transparent: false,               // stays in the opaque pass ...
    blending: THREE.CustomBlending,   // ... but its rim feathers into sky.js's ground
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }), floorUniforms));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.name = 'ground-floor';
  floor.renderOrder = -44;
  floor.frustumCulled = false;
  floor.visible = false;
  group.add(floor);

  // ------------------------------------------------------------- props
  const propsGeo = track(buildPropsGeometry(plan, rng));
  const propsMat = track(patchProps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, fog: false }), sky));
  const props = new THREE.Mesh(propsGeo, propsMat);
  props.name = 'ground-props';
  group.add(props);

  const stats = {
    initMs: 0, bakeMs: 0, readyAfterFrames: 0,
    floorTriangles: floorGeo.index.count / 3,
    propTriangles: propsGeo.attributes.position.count / 3,
    stones: plan.stones.length, sticks: plan.sticks.length, twigs: plan.twigs.length,
  };
  function finish() {
    const [mac, det] = results;
    const tex = (data, w, h, wrap) => track(dataTexture(data, w, h, aniso, wrap));
    floorUniforms.uMacA.value = tex(mac.A, MW, MH, THREE.ClampToEdgeWrapping);
    floorUniforms.uMacB.value = tex(mac.B, MW, MH, THREE.ClampToEdgeWrapping);
    floorUniforms.uMacC.value = tex(mac.C, MW, MH, THREE.ClampToEdgeWrapping);
    floorUniforms.uDetA.value = tex(det.A, DN, DN, THREE.RepeatWrapping);
    floorUniforms.uDetB.value = tex(det.B, DN, DN, THREE.RepeatWrapping);
    floorUniforms.uFibMean.value.set(det.fibMean[0], det.fibMean[1]);
    floorUniforms.uLeafFit.value.set(det.leafFit[0], det.leafFit[1]);
    floor.visible = true;
    stats.bakeMs = Math.round(bakeMs);
  }
  // run the bake for up to `budget` ms; true when everything is done
  function pump(budget) {
    if (jobAt >= jobs.length) return true;
    const t = performance.now();
    while (jobAt < jobs.length) {
      const r = jobs[jobAt].next();
      if (r.done) { results[jobAt] = r.value; jobAt++; }
      if (performance.now() - t > budget) break;
    }
    bakeMs += performance.now() - t;
    if (jobAt >= jobs.length) { finish(); return true; }
    stats.readyAfterFrames++;
    return false;
  }
  pump(o.initBudgetMs);
  stats.initMs = Math.round(performance.now() - t0);

  // ------------------------------------------------------- time of day
  const DAWN_SKY = new THREE.Color('#9aa8bf').multiplyScalar(0.012);
  const DUSK_SKY = tFire.clone().multiplyScalar(0.006);
  function setTimeOfDay(tod) {
    if (!tod) return;
    let d = Math.max(0, +tod.dusk || 0), w = Math.max(0, +tod.dawn || 0), n = Math.max(0, +tod.night || 0);
    const sum = d + w + n || 1; d /= sum; w /= sum; n /= sum;
    haze.setRGB(
      baseHaze.r * n + duskHaze.r * d + dawnHaze.r * w,
      baseHaze.g * n + duskHaze.g * d + dawnHaze.g * w,
      baseHaze.b * n + duskHaze.b * d + dawnHaze.b * w);
    skyLight.setRGB(DAWN_SKY.r * w + DUSK_SKY.r * d, DAWN_SKY.g * w + DUSK_SKY.g * d, DAWN_SKY.b * w + DUSK_SKY.b * d);
    floorUniforms.uDew.value = 0.8 * n + 0.6 * d + 1.0 * w;    // heaviest before dawn
  }

  function update(timeSec /* , dtSec */) {
    if (jobAt < jobs.length) pump(o.frameBudgetMs);
    if (!reduced) sky.uGTime.value = timeSec;     // sky.js holds its mist still under reduced motion too
  }
  function resize(/* w, h */) { /* nothing depends on the viewport */ }
  function dispose() {
    jobAt = jobs.length;              // a bake still running stops here
    group.removeFromParent();
    for (const x of disposables) x.dispose();
    disposables.length = 0;
  }

  return { group, update, resize, dispose, setTimeOfDay, stats, uniforms: floorUniforms };
}

export default createGround;
