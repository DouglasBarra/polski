/*
  Iskry · road.js — the field road (polna droga): two damp wheel ruts with a worn grass crown.
  OWNER: Opus worker "road". Interface: CONTRACT.md (environment modules); path from js/scene/layout.js.

  createRoad(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), setTimeOfDay(tod), surface(x, z) }
  opts { firePosition = FIRE, wind = 0.25, renderOrder = -1, seed = 23 }

  Also exported, pure (no GPU), for the grass and ground agents:
    roadSurface(x, z) -> { lateral, s, y, turf, rut, puddle }   turf 0..1 (crown and verge cover),
                                                               rut 0..1 (bare wheel track), puddle 0|1
    roadProfileY(lateral, s) -> y of the road surface (m), never below ROAD_MIN_Y

  What it is
    One ribbon mesh along layout.ROAD (roadPoint), out to ROAD.fadeTo from ZONES.center, ~48 columns
    across 2 x 1.5 m. Geometry stays at y >= 0.016 (the ground is flat at 0.005 inside the road band):
    the ruts are the lowest part, the crown and verges are slightly raised. The real rut depth is
    carried by the shading: the cross-section (rut bowls, mud lips, crown, verges) is evaluated
    per pixel and bent into the normal as if the ruts were ~6 cm deep, and the low fire light is
    shadowed by the rut wall on the fire's side (analytic, no shadow map).
    Detail is baked once into a 256 x ~2100 RGBA8 texture in (lateral, arc length) space:
      R  detail height: clods, crumbly mud lips, tractor-lug tread, horseshoe, boot, deer and dog prints, pebbles
      G  wetness: damp earth (0..0.6), standing water above 0.65 (puddles in the ruts, wet hoof prints)
      B  turf cover: the worn grass crown and the verges
      A  litter: fallen leaves, needles and twigs (value = tint)
    Puddles: dark water with a Schlick fresnel, the horizon sky (the fog colour) and a soft mirror
    image of the flame column (closed-form ray / segment distance) plus wind ripples and glints
    from the fire's PointLight; damp earth gets a broad warm sheen. No extra render pass.
  Material: MeshLambertMaterial (per-pixel, lit by fire.light, fog: true), patched; transparent,
  depthWrite false, polygonOffset, renderOrder just above the ground (opaque, -44) so grass and props
  drawn in the opaque pass stand in front of it. The sky's low ground haze is mixed in exactly like
  sky.js; edges feather into the meadow and the far end fades between ROAD.fadeFrom and fadeTo.
  Plus a 512^2 fine tile (1 m, repeating): grain, crumb and small-stone slopes, read again at 1/7 and 1/53 scale for patches.
  Cost: 1 draw call, ~16k triangles, 6 texture taps per pixel (2 more on water), one light in the custom terms. ~0.22-0.26 ms
  GPU at DPR 2 measured in isolation (full road unoccluded); no per-frame allocations. Bake ~50 ms main + ~17 ms fine (node).
*/
import * as THREE from 'three';
import { FIRE, ROAD, ZONES, roadPoint, roadProject, distanceFromCenter } from './layout.js';

const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,
  seed: 23,
  renderOrder: -1,
  hazeColor: '#372013',       // sky.js's low ground haze (sRGB)
};

export const ROAD_MIN_Y = 0.016;       // lowest road surface (rut bottoms), above the ground layer
const SPAN_Y = 0.018;                   // geometry: rut bottom -> crown top is ~1.6 x this
const NORMAL_H = 0.05;                  // m: the depth the shading pretends the profile has
const EDGE = 1.5;                       // m: the ribbon reaches this far each side (feathered beyond halfWidth)
const TEX_W = 256;                      // texels across 2 x EDGE (1.2 cm)
const TEX_DS = 0.014;                   // m of arc length per texel row
const H_RANGE = 0.04;                   // m: R channel covers -0.02 .. +0.02

// ------------------------------------------------------------- shared profile (JS == GLSL)
// The ruts wander a little: both shift together (the vehicle's line) and breathe in spacing and width.
const wob = (s) => 0.045 * Math.sin(0.19 * s + 0.6) + 0.022 * Math.sin(0.53 * s + 2.2);
const wid = (s) => 0.02 * Math.sin(0.31 * s + 1.1);
const rhw = (s) => 0.15 + 0.025 * Math.sin(0.41 * s + 0.3);           // rut half width (rutWidth / 2)
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// cross-section in units of NORMAL_H: rut bottoms -1, meadow 0, crown about +0.3
function profile(q, ro, rh, lat) {
  const d = Math.min(Math.abs(q - ro), Math.abs(q + ro));
  const x = Math.min(1, d / rh), bowl = (1 - x * x) * (1 - x * x);
  const lip = Math.exp(-(((d - rh * 1.2) / 0.07) ** 2));
  const aq = Math.abs(q);
  const crown = 1 - sm(ROAD.crownHalfWidth - 0.06, ROAD.crownHalfWidth + 0.04, aq);
  const verge = sm(ro + rh + 0.06, ro + rh + 0.45, aq) * (1 - sm(1.2, EDGE, Math.abs(lat)));
  return -bowl + 0.22 * lip * (1 - 0.5 * crown) + 0.3 * crown + 0.28 * verge;
}
export function roadProfileY(lat, s) {
  const P = profile(lat - wob(s), ROAD.rutOffset + wid(s), rhw(s), lat);
  return ROAD_MIN_Y + SPAN_Y * (P + 1);
}

// ------------------------------------------------------------- deterministic helpers
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// arc length where the road has faded out
const ROAD_LEN = ROAD.length;
const S_END = (() => {
  for (let s = 0; s <= ROAD_LEN; s += 0.1) {
    const p = roadPoint(s / ROAD_LEN);
    if (distanceFromCenter(p.x, p.z) > ROAD.fadeTo + 0.3) return s;
  }
  return ROAD_LEN;
})();
const sAtZ = (z) => {                       // arc length where the centreline crosses z (road runs toward -z)
  for (let s = 0; s <= ROAD_LEN; s += 0.05) if (roadPoint(s / ROAD_LEN).z <= z) return s;
  return ROAD_LEN;
};

// ------------------------------------------------------------- the plan (stamps), pure
// Puddles and prints are planned here, once, so roadSurface() agrees with the baked texture.
let PLAN = null;
function plan(seed) {
  if (PLAN && PLAN.seed === seed) return PLAN;
  const rng = mulberry32(seed * 7907 + 101);
  const R = (a, b) => a + (b - a) * rng();
  const puddles = [];
  const addPuddle = (s, side, len, fill) => {
    const lat = wob(s) + side * (ROAD.rutOffset + wid(s));
    puddles.push({ s, lat, side, len, hw: rhw(s) * fill, seed: Math.floor(R(0, 1e6)) });
  };
  // a few placed where they catch the fire's light (left rut, beside the fire) ...
  addPuddle(sAtZ(2.2), -1, 1.5, 0.85);
  addPuddle(sAtZ(-1.6), -1, 2.3, 0.9);
  addPuddle(sAtZ(-0.2), 1, 0.9, 0.7);
  addPuddle(sAtZ(-5.4), 1, 1.7, 0.8);
  // ... the rest scattered along the ruts, fewer and smaller far away
  for (let s = 3; s < S_END - 2; s += R(1.6, 3.8)) {
    if (rng() < 0.4) continue;
    if (puddles.some((p) => Math.abs(p.s - s) < 1.4)) continue;
    addPuddle(s, rng() < 0.5 ? -1 : 1, R(0.45, 1.8), R(0.55, 0.85));
  }
  const prints = [];
  // a rider's horse walked away up the right rut: pairs every ~0.8 m, a few holding water
  for (let s = sAtZ(1.2), k = 0; s < sAtZ(-11); s += R(0.74, 0.86), k++) {
    const side = k & 1 ? 1 : -1;
    prints.push({ kind: 'hoof', s: s + R(-0.04, 0.04), lat: wob(s) + ROAD.rutOffset + wid(s) + side * 0.07 + R(-0.02, 0.02),
      ang: R(-0.12, 0.12), wet: rng() < 0.22 ? 1 : 0, depth: R(0.006, 0.009) });
  }
  // a walker came down the left rut's crown-side shoulder toward the fire (heading -s), a dog meandering beside
  {
    let s = sAtZ(-9.5), k = 0;
    while (s > sAtZ(4.0)) {
      const side = k & 1 ? 1 : -1;
      const line = wob(s) - ROAD.rutOffset - wid(s) + 0.12 + 0.05 * Math.sin(s * 0.7);
      prints.push({ kind: 'boot', s, lat: line + side * 0.085, ang: Math.PI + R(-0.12, 0.12) + side * 0.06, mirror: side, depth: R(0.004, 0.0065) });
      s -= R(0.68, 0.78); k++;
    }
    for (let s2 = sAtZ(-7.5); s2 > sAtZ(2.5); s2 -= R(0.28, 0.42)) {
      const lat = wob(s2) - 0.05 + 0.32 * Math.sin(s2 * 0.45 + 1.3) + R(-0.05, 0.05);
      prints.push({ kind: 'paw', s: s2, lat, ang: Math.PI + 0.35 * Math.cos(s2 * 0.45 + 1.3) + R(-0.2, 0.2), depth: 0.004 });
    }
  }
  // a roe deer crossed from the right verge to the left: pairs of slots
  {
    const s0 = sAtZ(-12.5), ang = -Math.PI / 2 + 0.35;      // heading toward -lat, slightly up the road
    for (let k = 0; k < 9; k++) {
      const u = -1.15 + k * 0.29 + R(-0.03, 0.03);
      prints.push({ kind: 'deer', s: s0 + 0.35 * u + (k & 1 ? 0.05 : -0.05), lat: -u, ang: ang + R(-0.2, 0.2), depth: R(0.005, 0.007) });
    }
  }
  PLAN = { seed, puddles, prints };
  return PLAN;
}

function puddleField(p, s, lat) {        // < 1 inside the puddle
  const du = (s - p.s) / (p.len * 0.5), dv = (lat - p.lat) / p.hw;
  const n = vnoise(s * 3.1 + p.seed * 0.001, lat * 3.1, p.seed & 1023) - 0.5;
  return du * du + dv * dv * (1 + 0.25 * du * du) + n * 0.5;
}

/** Pure: what the road is at a world point (for grass and ground). */
export function roadSurface(x, z, seed = DEFAULTS.seed) {
  const pr = roadProject(x, z);
  const s = pr.t * ROAD_LEN, lat = pr.lateral;
  const q = lat - wob(s), ro = ROAD.rutOffset + wid(s), rh = rhw(s);
  const d = Math.min(Math.abs(q - ro), Math.abs(q + ro));
  const aq = Math.abs(q);
  const rut = 1 - sm(rh * 0.8, rh * 1.25, d);
  const crown = 1 - sm(ROAD.crownHalfWidth - 0.04, ROAD.crownHalfWidth + 0.05, aq);
  const verge = sm(ro + rh + 0.05, ro + rh + 0.4, aq);
  let puddle = 0;
  if (Math.abs(lat) < 1) for (const p of plan(seed).puddles) {
    if (Math.abs(s - p.s) < p.len * 0.6 && puddleField(p, s, lat) < 1) { puddle = 1; break; }
  }
  const inside = Math.abs(lat) < EDGE && s > 0 && s < S_END;
  return {
    lateral: lat, s,
    y: inside ? roadProfileY(lat, s) : 0,
    turf: inside ? Math.max(crown * 0.85, verge) * (1 - puddle) : 1,
    rut: inside ? rut : 0,
    puddle,
  };
}

// ------------------------------------------------------------- the bake
function bakeTexture(seed) {
  const NX = TEX_W, NY = Math.ceil(S_END / TEX_DS);
  const dl = (2 * EDGE) / NX, ds = S_END / NY;
  const N = NX * NY;
  const H = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), A = new Float32Array(N);
  const P = plan(seed);
  const rng = mulberry32(seed * 3301 + 7);
  const R = (a, b) => a + (b - a) * rng();

  // ---- base fields, row by row
  for (let j = 0; j < NY; j++) {
    const s = (j + 0.5) * ds;
    const w = wob(s), ro = ROAD.rutOffset + wid(s), rh = rhw(s);
    const treadL = sm(0.5, 0.66, vnoise(s * 0.33, 3.7, seed)), treadR = sm(0.5, 0.66, vnoise(s * 0.33, 9.1, seed));
    const sWet = vnoise(s * 0.21, 1.3, seed + 5);
    for (let i = 0; i < NX; i++) {
      const lat = -EDGE + (i + 0.5) * dl, q = lat - w;
      const k = j * NX + i;
      const oR = q - ro, oL = q + ro, d = Math.min(Math.abs(oR), Math.abs(oL));
      const n1 = vnoise(lat * 6.5, s * 6.5, seed + 1);            // clods, patches (~15 cm)
      const n2 = vnoise(lat * 24, s * 24, seed + 2);              // crumbs (~4 cm)
      const inRut = 1 - sm(rh * 0.7, rh * 1.1, d);
      const lip = Math.exp(-(((d - rh * 1.18) / 0.055) ** 2));
      const aq = Math.abs(q);
      let h = (n1 - 0.5) * 0.004 + (n2 - 0.5) * 0.004 * (1 - 0.65 * inRut) + lip * (n2 - 0.3) * 0.006;
      // tractor lugs: chevrons in patches, mostly rained smooth
      if (inRut > 0.05) {
        const o = Math.abs(oR) < Math.abs(oL) ? oR : oL;
        const seg = Math.abs(oR) < Math.abs(oL) ? treadR : treadL;
        const a = Math.abs(o);
        if (seg > 0 && a < 0.14) {
          const ph = (s + a * 0.9) / 0.15;
          const f = ph - Math.floor(ph);
          const lug = sm(0.55, 0.64, f) * (1 - sm(0.82, 0.9, f));
          h -= 0.0035 * lug * seg * (1 - sm(0.1, 0.14, a)) * (0.6 + 0.4 * n1);
        }
      }
      H[k] = h;
      // damp: wetter in the ruts and on the mud lips, in long patches
      G[k] = Math.min(0.6, Math.max(0, 0.16 + 0.26 * inRut + 0.1 * lip + 0.3 * (n1 - 0.5) + 0.22 * (sWet - 0.5)));
      // turf: the crown (worn thin in patches), the verges thickening outward, a few tufts in the ruts
      const crown = (1 - sm(ROAD.crownHalfWidth - 0.05, ROAD.crownHalfWidth + 0.05, aq + (n1 - 0.5) * 0.14))
        * (0.55 + 0.45 * sm(0.25, 0.6, vnoise(lat * 3, s * 1.4, seed + 3)));
      const verge = sm(ro + rh + 0.04, ro + rh + 0.42, aq + (n1 - 0.5) * 0.2);
      const tuft = inRut < 0.5 ? 0 : sm(0.8, 0.9, vnoise(lat * 9, s * 5, seed + 4)) * 0.8;
      B[k] = Math.min(1, Math.max(crown, verge, tuft) * (0.85 + 0.3 * n2));
    }
  }

  // ---- stamping helper: (lat, s) centre, heading angle (0 = +s), bounding radius, fn(k, u along, v across)
  const stamp = (cl, cs, ang, rad, fn) => {
    const i0 = Math.max(0, Math.floor((cl - rad + EDGE) / dl)), i1 = Math.min(NX - 1, Math.ceil((cl + rad + EDGE) / dl));
    const j0 = Math.max(0, Math.floor((cs - rad) / ds)), j1 = Math.min(NY - 1, Math.ceil((cs + rad) / ds));
    const c = Math.cos(ang), sn = Math.sin(ang);
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * ds - cs;
      for (let i = i0; i <= i1; i++) {
        const dx = -EDGE + (i + 0.5) * dl - cl;
        fn(j * NX + i, dy * c + dx * sn, dx * c - dy * sn);
      }
    }
  };
  const aa = (dist) => Math.min(1, Math.max(0, 0.5 - dist / dl));   // coverage of a signed distance edge

  // ---- prints
  for (const p of P.prints) {
    const D = p.depth;
    if (p.kind === 'hoof') {
      stamp(p.lat, p.s, p.ang, 0.1, (k, u, v) => {
        const r = Math.hypot(v / 0.062, (u - 0.005) / 0.068);
        const sole = 1 - sm(0.88, 1.06, r);
        const shoe = (sm(0.66, 0.76, r) * (1 - sm(0.94, 1.04, r))) * sm(-0.045, -0.025, u);   // open at the heel
        const frog = Math.max(0, 1 - Math.hypot(v / 0.018, (u + 0.02) / 0.04)) * 0.6;
        const rim = Math.exp(-(((r - 1.12) / 0.1) ** 2)) * 0.25;
        H[k] += -D * (0.55 * sole + 0.45 * shoe - 0.4 * frog * sole) + D * rim;
        if (sole > 0.2) { G[k] = Math.max(G[k], p.wet ? 0.66 + 0.3 * sole : 0.5 + 0.1 * sole); B[k] *= 1 - 0.8 * sole; }
      });
    } else if (p.kind === 'boot') {
      stamp(p.lat, p.s, p.ang, 0.17, (k, u, v) => {
        const vv = v * p.mirror;
        const fore = Math.hypot((vv - 0.006) / 0.047, (u - 0.045) / 0.085);
        const heel = Math.hypot(vv / 0.04, (u + 0.09) / 0.042);
        const waist = Math.hypot(vv / 0.032, (u + 0.03) / 0.05);
        const f = Math.min(fore, heel, waist * 1.15);
        const inside = 1 - sm(0.9, 1.05, f);
        const lug = (Math.floor((u + 0.2) / 0.024) & 1) ? 1 : 0.55;           // chunky cross lugs
        const rim = Math.exp(-(((f - 1.18) / 0.14) ** 2)) * 0.3;
        H[k] += -D * inside * (heel < 1 ? 1 : 0.6 + 0.4 * lug) + D * rim;
        if (inside > 0.2) { G[k] = Math.max(G[k], 0.45 + 0.1 * inside); B[k] *= 1 - 0.7 * inside; }
      });
    } else if (p.kind === 'paw') {
      stamp(p.lat, p.s, p.ang, 0.05, (k, u, v) => {
        let c = 1 - sm(0.8, 1.1, Math.hypot(v / 0.017, (u + 0.008) / 0.014));
        c = Math.max(c, 1 - sm(0.7, 1.1, Math.hypot((Math.abs(v) - 0.018) / 0.008, (u - 0.014) / 0.01)));
        c = Math.max(c, 1 - sm(0.7, 1.1, Math.hypot((Math.abs(v) - 0.007) / 0.008, (u - 0.026) / 0.01)));
        H[k] -= p.depth * c;
      });
    } else if (p.kind === 'deer') {
      stamp(p.lat, p.s, p.ang, 0.05, (k, u, v) => {
        // two teardrop halves of a cloven hoof, pointed toward the heading
        const half = (Math.abs(v) - 0.013) / 0.011;
        const t = (u + 0.005) / 0.03;
        const drop = Math.hypot(half / Math.max(0.15, 1 - Math.max(0, t) * 0.75), t);
        const c = 1 - sm(0.85, 1.1, drop);
        H[k] -= p.depth * c;
        if (c > 0.3) B[k] *= 0.5;
      });
    }
  }

  // ---- puddles (after prints: water is flat)
  for (const p of P.puddles) {
    stamp(p.lat, p.s, 0, p.len * 0.6 + 0.1, (k, u, v) => {
      const f = puddleField(p, p.s + u, p.lat + v);
      if (f < 1.7) G[k] = Math.max(G[k], 0.56 + 0.04 * (1.7 - f));        // a wet dark margin
      if (f < 1.0) {
        const deep = sm(1.0, 0.45, f);
        G[k] = Math.max(G[k], 0.66 + 0.34 * deep);
        H[k] *= 1 - deep;
        B[k] *= 0.15;
      }
    });
  }

  // ---- pebbles and stones: shoved onto the rut shoulders and crown edges, sparse in the tracks
  const pebbleCount = Math.round(S_END * 150);
  for (let n = 0; n < pebbleCount; n++) {
    const s = R(0.2, S_END), lat = R(-1.45, 1.45);
    const q = lat - wob(s), ro = ROAD.rutOffset + wid(s), rh = rhw(s);
    const d = Math.min(Math.abs(q - ro), Math.abs(q + ro));
    const wgt = 0.12 + 0.9 * Math.exp(-(((d - rh * 1.15) / 0.08) ** 2)) + 0.35 * (1 - sm(rh * 0.6, rh, d))
      + 0.4 * Math.exp(-(((Math.abs(q) - ROAD.crownHalfWidth) / 0.06) ** 2)) - 0.1 * sm(1.0, 1.3, Math.abs(q));
    if (rng() > wgt * (0.6 + 0.8 * vnoise(s * 0.5, lat * 0.5, seed + 8))) continue;
    const big = rng() < 0.012;
    const r = big ? R(0.022, 0.045) : 0.005 + 0.013 * rng() ** 2.2;
    const ht = Math.min(0.012, r * R(0.45, 0.75));
    const ang = R(0, Math.PI), el = R(0.7, 1);
    stamp(lat, s, ang, r * 1.4 + dl, (k, u, v) => {
      const e = Math.hypot(u / r, v / (r * el));
      if (e >= 1.25 || G[k] > 0.64) return;
      const dome = e < 1 ? Math.sqrt(1 - e * e) : 0;
      H[k] = Math.max(H[k], ht * dome + (e < 1 ? 0.0036 : 0));               // sits proud of the soil
    });
  }

  // ---- litter: leaves blown into the ruts and against the crown, needles, a few twigs
  const litter = (n, fn) => {
    for (let c = 0; c < n; c++) {
      const s = R(0.3, S_END), lat = R(-1.4, 1.4);
      const q = lat - wob(s), ro = ROAD.rutOffset + wid(s), rh = rhw(s);
      const d = Math.min(Math.abs(q - ro), Math.abs(q + ro));
      // the wind (+x, roughly +lat here) piles them against the downwind wall of each rut
      const o = Math.abs(q - ro) < Math.abs(q + ro) ? q - ro : q + ro;
      const wgt = 0.15 + 0.9 * (1 - sm(rh * 0.5, rh * 1.1, d)) * (0.6 + 0.4 * sm(-rh, rh, o))
        + 0.5 * Math.exp(-(((Math.abs(q) - ROAD.crownHalfWidth) / 0.07) ** 2));
      if (rng() > wgt * (0.35 + 1.1 * sm(0.35, 0.8, vnoise(s * 0.6, lat * 0.8, seed + 9)))) continue;
      fn(s, lat);
    }
  };
  litter(Math.round(S_END * 30), (s, lat) => {          // leaves: oak, birch, maple-ish, 2.5-5 cm
    const hl = R(0.022, 0.048), hw = hl * R(0.38, 0.62), ang = R(0, Math.PI * 2);
    const val = 0.52 + 0.48 * rng();
    const curl = R(0, 0.5);
    stamp(lat, s, ang, hl + 0.02, (k, u, v) => {
      if (u < -hl - 0.012 || u > hl) return;
      const t = u / hl;
      const half = hw * Math.pow(Math.max(0, 1 - t * t), 0.75) * (1 + 0.18 * Math.sin(t * 9 + val * 20) * curl);
      const stem = u < -hl ? Math.max(0, 0.003 - Math.abs(v)) / 0.003 * 0.6 : 0;
      const cov = Math.max(aa(Math.abs(v) - half), stem);
      if (cov > 0.02) {
        A[k] = Math.max(A[k], val * cov);
        H[k] = Math.max(H[k] * (1 - cov), H[k] + 0.0012 * cov * (1 - Math.abs(t)));
      }
    });
  });
  litter(Math.round(S_END * 26), (s, lat) => {          // needles in little drifts
    const n = 1 + Math.floor(rng() * 4);
    for (let m = 0; m < n; m++) {
      const L = R(0.018, 0.05), ang = R(0, Math.PI * 2), val = R(0.5, 0.62);
      const cl = lat + R(-0.03, 0.03), cs = s + R(-0.03, 0.03);
      stamp(cl, cs, ang, L + dl, (k, u, v) => {
        if (Math.abs(u) > L * 0.5) return;
        const cov = aa(Math.abs(v) - 0.0012) * 0.8 + 0.25 * aa(Math.abs(v) - dl * 0.5);
        if (cov > 0.05) A[k] = Math.max(A[k], val * Math.min(1, cov));
      });
    }
  });
  litter(Math.round(S_END * 1.4), (s, lat) => {         // twigs
    const L = R(0.07, 0.2), ang = R(0, Math.PI * 2), r = R(0.002, 0.004);
    stamp(lat, s, ang, L + dl, (k, u, v) => {
      if (Math.abs(u) > L * 0.5) return;
      const bend = 0.01 * Math.sin(u / L * 3);
      const cov = aa(Math.abs(v - bend) - r);
      if (cov > 0.05) { A[k] = Math.max(A[k], 0.5 * cov + 0.02); H[k] = Math.max(H[k], 0.003 * cov); }
    });
  });

  // ---- pack
  const data = new Uint8Array(N * 4);
  for (let k = 0; k < N; k++) {
    const o = k * 4;
    data[o] = Math.max(0, Math.min(255, Math.round((H[k] / H_RANGE + 0.5) * 255)));
    data[o + 1] = Math.round(Math.max(0, Math.min(1, G[k])) * 255);
    data[o + 2] = Math.round(Math.max(0, Math.min(1, B[k])) * 255);
    data[o + 3] = Math.round(Math.max(0, Math.min(1, A[k])) * 255);
  }
  return { data, NX, NY };
}

// ------------------------------------------------------------- the fine tile (1 m, repeats)
// R grain (48 cycles/m; also read at 1/7 and 1/53 scale as soil and turf patches), GB slope of the
// fine height (crumbs + small stones, x and z, +-3), A stones: 0.5 + 0.5 * rank inside a stone (the
// shader shows a stone when rank beats a local density threshold; the rest stay as crumbs).
const FINE = 512, FINE_SLOPE = 3;
function bakeFine(seed) {
  const N = FINE, L = 48, data = new Uint8Array(N * N * 4);
  const gx = new Float32Array(N * N), gz = new Float32Array(N * N), cov = new Float32Array(N * N);
  const hp = (ix, iy) => hash2(((ix % L) + L) % L, ((iy % L) + L) % L, seed + 40);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * L, y = (j + 0.5) / N * L;
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), dx = 6 * fx * (1 - fx), dy = 6 * fy * (1 - fy);
      const a = hp(ix, iy), b = hp(ix + 1, iy), c = hp(ix, iy + 1), d = hp(ix + 1, iy + 1), k = a - b - c + d;
      const k0 = j * N + i;
      data[k0 * 4] = Math.round(Math.min(1, Math.max(0, a + (b - a) * ux + (c - a) * uy + k * ux * uy)) * 255);
      gx[k0] = dx * (b - a + k * uy) * L * 0.0016;      // d/dm of a 1.6 mm crumb relief
      gz[k0] = dy * (c - a + k * ux) * L * 0.0016;
    }
  }
  // small stones, one candidate per 4 cm cell (25 per tile, so the tile wraps cleanly)
  const C = 25, cell = 1 / C, px = 1 / N;
  for (let cy = 0; cy < C; cy++) for (let cx = 0; cx < C; cx++) {
    const h1 = hash2(cx, cy, seed + 51), h2 = hash2(cx, cy, seed + 52), h3 = hash2(cx, cy, seed + 53), h4 = hash2(cx, cy, seed + 54);
    const ox = (cx + 0.5 + (h1 - 0.5) * 0.45) * cell, oz = (cy + 0.5 + (h2 - 0.5) * 0.45) * cell;
    const rank = h4;
    if (rank < 0.42) continue;                                   // most cells hold no stone
    const r = (0.05 + 0.2 * h3 * h3) * cell, hgt = r * 0.55;
    const i0 = Math.floor((ox - r) / px) - 1, i1 = Math.ceil((ox + r) / px) + 1;
    const j0 = Math.floor((oz - r) / px) - 1, j1 = Math.ceil((oz + r) / px) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const wx = (i + 0.5) * px - ox, wz = (j + 0.5) * px - oz;
      const e = Math.hypot(wx, wz) / r;
      const k0 = (((j % N) + N) % N) * N + (((i % N) + N) % N);
      const cv = Math.min(1, Math.max(0, (1.05 - e) / (px / r)));
      if (cv <= 0) continue;
      if (e < 0.97) { const q = hgt / (r * r * Math.sqrt(1 - e * e)); gx[k0] = -wx * q * cv + gx[k0] * (1 - cv); gz[k0] = -wz * q * cv + gz[k0] * (1 - cv); }
      cov[k0] = Math.max(cov[k0], cv * (0.5 + 0.5 * rank));
    }
  }
  for (let k0 = 0; k0 < N * N; k0++) {
    data[k0 * 4 + 1] = Math.round(Math.min(1, Math.max(0, gx[k0] / (2 * FINE_SLOPE) + 0.5)) * 255);
    data[k0 * 4 + 2] = Math.round(Math.min(1, Math.max(0, gz[k0] / (2 * FINE_SLOPE) + 0.5)) * 255);
    data[k0 * 4 + 3] = Math.round(cov[k0] * 255);
  }
  return data;
}

// ------------------------------------------------------------- geometry
function buildGeometry() {
  const lats = [];
  for (const l of [-1.5, -1.38, -1.26, -1.15, -1.06]) lats.push(l);
  for (let l = -0.96; l <= 0.961; l += 0.06) lats.push(+l.toFixed(3));
  for (const l of [1.06, 1.15, 1.26, 1.38, 1.5]) lats.push(l);
  const NL = lats.length;
  const rows = [];
  for (let s = 0; s < S_END; s += 0.14) rows.push(s);
  rows.push(S_END);
  const NR = rows.length;
  const pos = new Float32Array(NR * NL * 3), nrm = new Float32Array(NR * NL * 3);
  const road = new Float32Array(NR * NL * 3), tan = new Float32Array(NR * NL * 2);
  let k = 0;
  for (let r = 0; r < NR; r++) {
    const s = rows[r];
    const p = roadPoint(s / ROAD_LEN);
    const D = distanceFromCenter(p.x, p.z);
    const along = (1 - sm(ROAD.fadeFrom, ROAD.fadeTo, D)) * sm(0, 0.6, s);
    for (let c = 0; c < NL; c++, k++) {
      const lat = lats[c];
      pos[k * 3] = p.x + p.rx * lat;
      pos[k * 3 + 1] = roadProfileY(lat, s);
      pos[k * 3 + 2] = p.z + p.rz * lat;
      nrm[k * 3 + 1] = 1;
      road[k * 3] = lat; road[k * 3 + 1] = s; road[k * 3 + 2] = along;
      tan[k * 2] = p.tx; tan[k * 2 + 1] = p.tz;
    }
  }
  const idx = [];
  for (let r = 0; r < NR - 1; r++) {
    for (let c = 0; c < NL - 1; c++) {
      const a = r * NL + c, b = a + 1, cc = a + NL, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);                        // counter-clockwise seen from above
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aRoad', new THREE.BufferAttribute(road, 3));
  g.setAttribute('aRoadTan', new THREE.BufferAttribute(tan, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------- shader patch
const VERT_PARS = /* glsl */ `
  attribute vec3 aRoad;
  attribute vec2 aRoadTan;
  varying vec3 vRoad;
  varying vec2 vRoadTan;
  varying vec3 vRoadW;
`;
const VERT_MAIN = /* glsl */ `
  #include <project_vertex>
  vRoad = aRoad;
  vRoadTan = aRoadTan;
  vRoadW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const FRAG_PARS = /* glsl */ `
  uniform sampler2D uRoadTex;
  uniform sampler2D uRoadFine;  // 1 m tile: grain, fine slope, small stones
  uniform vec4 uRoadDom;        // EDGE, S_END, 1 / NX, 1 / NY
  uniform vec3 uRoadP;          // rutOffset, crownHalfWidth, NORMAL_H
  uniform float uRoadTime;
  uniform vec3 uRoadAmb;        // sky light on the unlit road (linear)
  uniform vec3 uRoadHaze;
  uniform vec2 uRoadCenter;
  uniform vec3 uRoadFire;       // world, the fire's base
  uniform vec2 uRoadFlame;      // flame column height (m), image gain
  uniform vec2 uRoadWind;       // ripple speed, ripple strength
  uniform vec3 uRoadLightP;     // the fire's light: world position
  uniform vec3 uRoadLightC;     // and linear colour * intensity (cd)
  uniform vec3 uRoadSky;        // the night sky low over the land, as seen mirrored (linear)
  varying vec3 vRoad;
  varying vec2 vRoadTan;
  varying vec3 vRoadW;

  float rdWob( float s ) { return 0.045 * sin( 0.19 * s + 0.6 ) + 0.022 * sin( 0.53 * s + 2.2 ); }
  float rdWid( float s ) { return 0.02 * sin( 0.31 * s + 1.1 ); }
  float rdRh( float s ) { return 0.15 + 0.025 * sin( 0.41 * s + 0.3 ); }
  // smoothstep and its derivative
  vec2 rdSs( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return vec2( t * t * ( 3.0 - 2.0 * t ), 6.0 * t * ( 1.0 - t ) / ( b - a ) ); }
  // the cross-section (same as profile() in JS) and its slope d/dq, analytic: x = P, y = dP/dq
  vec2 rdProfile( float q, float ro, float rh, float lat ) {
    float oR = q - ro, oL = q + ro;
    bool nearR = abs( oR ) < abs( oL );
    float o = nearR ? oR : oL, d = abs( o ), sg = o < 0.0 ? -1.0 : 1.0;
    float x = min( 1.0, d / rh ), w = 1.0 - x * x;
    float bowl = w * w, dBowl = d < rh ? -4.0 * x * w / rh : 0.0;
    float lp = ( d - rh * 1.2 ) / 0.07;
    float lip = exp( - lp * lp ), dLip = lip * ( -2.0 * lp / 0.07 );
    float aq = abs( q ), sq = q < 0.0 ? -1.0 : 1.0;
    vec2 cr = rdSs( uRoadP.y - 0.06, uRoadP.y + 0.04, aq );
    float crown = 1.0 - cr.x, dCrown = - cr.y * sq;
    vec2 vg = rdSs( ro + rh + 0.06, ro + rh + 0.45, aq );
    vec2 ed = rdSs( 1.2, ${EDGE.toFixed(2)}, abs( lat ) );
    float verge = vg.x * ( 1.0 - ed.x );
    float dVerge = vg.y * sq * ( 1.0 - ed.x ) - vg.x * ed.y * ( lat < 0.0 ? -1.0 : 1.0 );
    float P = - bowl + 0.22 * lip * ( 1.0 - 0.5 * crown ) + 0.3 * crown + 0.28 * verge;
    float dP = - dBowl * sg + 0.22 * ( dLip * sg * ( 1.0 - 0.5 * crown ) - 0.5 * lip * dCrown ) + 0.3 * dCrown + 0.28 * dVerge;
    return vec2( P, dP );
  }
  float rdHash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
  float rdNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( rdHash( i ), rdHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( rdHash( i + vec2( 0.0, 1.0 ) ), rdHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
  }
  // sRGB-ish palette, converted to linear once per pixel by the compiler (constants)
  vec3 rdLin( vec3 c ) { return c * c * ( c * 0.305 + 0.682 ) + 0.0125 * c; }
`;
// the surface: albedo, alpha, world normal, masks. Replaces color_fragment.
const FRAG_SURFACE = /* glsl */ `
  float rdLat = vRoad.x, rdS = vRoad.y;
  vec2 rdT = normalize( vRoadTan );
  vec2 rdR = vec2( - rdT.y, rdT.x );                     // right of the road (+lateral)
  float rdW0 = rdWob( rdS ), rdRo = uRoadP.x + rdWid( rdS ), rdRhv = rdRh( rdS );
  float rdQ = rdLat - rdW0;
  // cross-section and its slope across the road
  float rdPx = rdProfile( rdQ, rdRo, rdRhv, rdLat ).y;
  float rdD = min( abs( rdQ - rdRo ), abs( rdQ + rdRo ) );
  float rdBowl = 1.0 - smoothstep( 0.0, rdRhv, rdD );
  float rdLq = ( rdD - rdRhv * 1.18 ) / 0.06;
  float rdLip = exp( - rdLq * rdLq );


  // baked detail
  vec2 rdUv = vec2( ( rdLat + uRoadDom.x ) / ( 2.0 * uRoadDom.x ), rdS / uRoadDom.y );
  vec4 rdTx = texture2D( uRoadTex, rdUv );
  float rdHx = texture2D( uRoadTex, rdUv + vec2( uRoadDom.z, 0.0 ) ).r;
  float rdHy = texture2D( uRoadTex, rdUv + vec2( 0.0, uRoadDom.w ) ).r;
  float rdHd = ( rdTx.r - 0.5 ) * ${H_RANGE.toFixed(3)};
  vec2 rdG = vec2( ( rdHx - rdTx.r ) / ( 2.0 * uRoadDom.x * uRoadDom.z ), ( rdHy - rdTx.r ) / ( uRoadDom.y * uRoadDom.w ) ) * ${H_RANGE.toFixed(3)};
  float rdWet = clamp( rdTx.g * 1.65, 0.0, 1.0 );
  float rdPud = smoothstep( 0.635, 0.69, rdTx.g );
  float rdDeep = smoothstep( 0.68, 0.95, rdTx.g );
  float rdTurf = rdTx.b;
  float rdLeaf = smoothstep( 0.1, 0.4, rdTx.a );
  float rdTint = clamp( ( rdTx.a - 0.5 ) * 2.1, 0.0, 1.0 );
  float rdPeb = smoothstep( 0.0028, 0.0055, rdHd ) * ( 1.0 - rdLeaf ) * ( 1.0 - rdPud );


  // fine grit that fades before it can shimmer
  float rdFw = length( fwidth( vRoadW.xz ) );
  vec4 rdFn = texture2D( uRoadFine, vRoadW.xz );
  float rdGrain = rdFn.r - 0.5;
  float rdGrainK = 1.0 - smoothstep( 0.006, 0.02, rdFw );
  float rdPatch = texture2D( uRoadFine, vRoadW.xz * ( 1.0 / 53.0 ) + 0.31 ).r;
  float rdTurfN = texture2D( uRoadFine, vRoadW.xz * ( 1.0 / 7.0 ) + 0.67 ).r;
  // small stones below the bake's resolution, close by only: denser on the mud lips and in the tracks
  float rdRank = clamp( ( rdFn.a - 0.5 ) * 2.0, 0.0, 1.0 );
  float rdGrit = smoothstep( 0.22, 0.48, rdFn.a ) * step( 0.8 - 0.3 * rdLip - 0.1 * rdBowl + 0.15 * rdPatch, rdRank )
               * ( 1.0 - smoothstep( 0.2, 0.6, rdTx.b ) ) * rdGrainK;
  float rdCh2 = fract( rdRank * 7.31 );


  // soil: pale sandy grey-brown in the tracks, loam elsewhere, darker and browner when damp, mud on the lips
  vec3 rdSand = rdLin( vec3( 0.47, 0.41, 0.33 ) ), rdLoam = rdLin( vec3( 0.36, 0.29, 0.22 ) ), rdMud = rdLin( vec3( 0.25, 0.19, 0.14 ) );
  vec3 rdSoil = mix( rdLoam, rdSand, clamp( rdBowl * 0.8 + ( rdPatch - 0.5 ) * 0.7, 0.0, 1.0 ) );
  rdSoil = mix( rdSoil, rdMud, clamp( rdLip * rdWet * 1.2 + rdWet * 0.25, 0.0, 1.0 ) );
  rdSoil *= mix( 1.0, 0.56, rdWet ) * ( 1.0 + rdGrain * 0.5 * rdGrainK );
  // worn turf: olive and straw, thin moss, soil showing through
  vec3 rdOlive = rdLin( vec3( 0.33, 0.32, 0.19 ) ), rdStraw = rdLin( vec3( 0.47, 0.42, 0.29 ) ), rdMoss = rdLin( vec3( 0.21, 0.24, 0.13 ) );
  vec3 rdTurfC = mix( rdOlive, rdStraw, smoothstep( 0.3, 0.8, rdTurfN ) );
  rdTurfC = mix( rdTurfC, rdMoss, smoothstep( 0.6, 0.9, rdPatch ) * 0.6 );
  rdTurfC *= 0.8 + 0.5 * rdGrainK * ( rdGrain + 0.1 );
  vec3 rdAlb = mix( rdSoil, rdTurfC, smoothstep( 0.15, 0.85, rdTurf ) );
  // pebbles: grey, ochre, the odd pale quartz
  float rdPh = rdHash( floor( vRoadW.xz * 60.0 ) );
  vec3 rdPebC = mix( rdLin( vec3( 0.46, 0.44, 0.40 ) ), rdLin( vec3( 0.52, 0.43, 0.32 ) ), step( 0.55, rdPh ) );
  rdPebC = mix( rdPebC, rdLin( vec3( 0.64, 0.61, 0.56 ) ), step( 0.9, rdPh ) );
  rdAlb = mix( rdAlb, rdPebC * mix( 1.0, 0.75, rdWet ), rdPeb );
  vec3 rdGritC = mix( rdLin( vec3( 0.42, 0.39, 0.34 ) ), rdLin( vec3( 0.55, 0.47, 0.36 ) ), rdCh2 ) * mix( 1.0, 0.7, rdWet );
  rdGritC = mix( rdGritC, rdSoil * 0.7, step( rdCh2, 0.45 ) );                  // half are just darker clods
  rdAlb = mix( rdAlb, rdGritC, rdGrit * 0.7 * ( 1.0 - rdLeaf ) * ( 1.0 - rdPud ) );
  // fallen leaves: brown, rust, ochre (and needles at the dark end)
  vec3 rdLeafC = mix( rdLin( vec3( 0.25, 0.16, 0.09 ) ), rdLin( vec3( 0.48, 0.27, 0.12 ) ), smoothstep( 0.0, 0.6, rdTint ) );
  rdLeafC = mix( rdLeafC, rdLin( vec3( 0.56, 0.42, 0.18 ) ), smoothstep( 0.6, 1.0, rdTint ) );
  rdAlb = mix( rdAlb, rdLeafC * mix( 1.0, 0.7, rdWet ), rdLeaf );
  // under water: the bottom darkens with depth
  rdAlb = mix( rdAlb, rdAlb * mix( 0.5, 0.22, rdDeep ), rdPud * ( 1.0 - rdLeaf ) );


  // normal (world): the exaggerated cross-section plus baked detail; water is flat with ripples
  vec2 rdGrad = rdR * ( rdPx * uRoadP.z ) + ( rdR * rdG.x + rdT * rdG.y ) * 1.4 * ( 1.0 - rdPud );
  // fine crumb bump and the grit domes (gone with distance, flat under water and leaves)
  float rdFine = rdGrainK * ( 1.0 - rdPud ) * ( 1.0 - rdLeaf );
  rdGrad += rdFine * ( rdFn.gb - 0.5 ) * ${(2 * FINE_SLOPE).toFixed(1)} * ( 1.0 - 0.6 * rdTx.b );
  vec3 rdNW = normalize( vec3( - rdGrad.x, 1.0, - rdGrad.y ) );
  if ( rdPud > 0.001 ) {                                 // wind ripples, only on the water
    vec2 rdRp = vRoadW.xz * vec2( 9.0, 6.5 );
    float rdTm = uRoadTime * uRoadWind.x;
    vec2 rdRip = vec2( cos( rdRp.x - rdTm * 2.1 + sin( rdRp.y * 0.7 ) ), cos( rdRp.y * 1.3 + rdRp.x * 0.4 - rdTm * 1.4 ) ) * uRoadWind.y
               + vec2( rdNoise( vRoadW.xz * 23.0 + vec2( - rdTm * 0.6, 0.0 ) ) - 0.5, rdNoise( vRoadW.xz * 23.0 + vec2( 4.0, rdTm * 0.4 ) ) - 0.5 ) * 0.05;
    rdNW = normalize( mix( rdNW, normalize( vec3( rdRip.x, 1.0, rdRip.y ) ), rdPud * ( 1.0 - rdLeaf ) ) );
  }

  // feathered edges and the far fade
  float rdEdge = 1.0 - smoothstep( 1.08, ${EDGE.toFixed(2)} - 0.03, abs( rdLat ) + ( rdPatch - 0.5 ) * 0.22 + rdGrain * 0.06 );
  diffuseColor.rgb = rdAlb;
  diffuseColor.a = rdEdge * vRoad.z;
  // occlusion for the sky light: rut bottoms and prints see less of the sky
  float rdAo = ( 1.0 - 0.3 * rdBowl ) * ( 1.0 - clamp( - rdHd * 60.0, 0.0, 0.35 ) );

`;
const FRAG_NORMAL = /* glsl */ `
  #include <normal_fragment_maps>
  normal = normalize( mat3( viewMatrix ) * rdNW );
`;
const FRAG_EMISSIVE = /* glsl */ `
  #include <emissivemap_fragment>
  totalEmissiveRadiance = rdAlb * uRoadAmb * rdAo;
`;
// the rut wall on the fire's side shades the rut bottom from the low fire light
const FRAG_LIGHTS_END = /* glsl */ `
  #include <lights_fragment_end>

  {
    vec3 rdL = uRoadFire + vec3( 0.0, 0.8, 0.0 ) - vRoadW;
    float rdLl = dot( rdL.xz, rdR );
    float rdK = abs( rdLl ) / max( rdL.y, 0.05 );
    float rdO = abs( rdQ - rdRo ) < abs( rdQ + rdRo ) ? rdQ - rdRo : rdQ + rdRo;
    float rdFromCrest = rdLl < 0.0 ? rdO + rdRhv * 1.1 : rdRhv * 1.1 - rdO;
    float rdShade = smoothstep( -0.02, 0.025, rdFromCrest - 0.028 * rdBowl * rdK );
    rdShade = mix( 1.0, rdShade, smoothstep( 0.0, 0.3, rdBowl ) * ( 1.0 - rdPud * 0.6 ) );
    reflectedLight.directDiffuse *= 0.3 + 0.7 * rdShade;
  }

`;
// damp sheen, puddle glints and the puddle's reflection of the sky and the flames
const FRAG_REFLECT = /* glsl */ `
  {
    // world space throughout; one light: the fire's (uRoadLightP / uRoadLightC, its flicker included)
    vec3 rdV = normalize( cameraPosition - vRoadW );
    float rdWaterK = rdPud * ( 1.0 - rdLeaf );
    float rdNoV = clamp( dot( rdNW, rdV ), 0.0, 1.0 );
    float rdF1 = 1.0 - rdNoV, rdF2 = rdF1 * rdF1;
    float rdF = 0.02 + 0.98 * rdF2 * rdF2 * rdF1;
    vec3 rdLv = uRoadLightP - vRoadW;
    float rdLd2 = dot( rdLv, rdLv );
    vec3 rdLn = rdLv * inversesqrt( rdLd2 );
    float rdNh = max( dot( rdNW, normalize( rdLn + rdV ) ), 0.0 );
    vec3 rdIrr = uRoadLightC * ( max( dot( rdNW, rdLn ), 0.0 ) / rdLd2 );
    // damp earth: a broad warm sheen; water: tight glints off the ripples
    float rdN2 = rdNh * rdNh, rdN4 = rdN2 * rdN2, rdN16 = rdN4 * rdN4; rdN16 *= rdN16;
    vec3 rdSpec = rdIrr * ( rdWet * ( 1.0 - rdWaterK ) * ( 0.04 + 0.5 * rdF ) * rdN16 * 0.5 );
    if ( rdWaterK > 0.001 ) {
      rdSpec += rdIrr * rdWaterK * ( 0.3 + rdF ) * pow( rdNh, 220.0 ) * 6.0;
      // mirror ray against the flame column: closest approach of the reflected ray to a vertical segment
      vec3 rdRf = reflect( - rdV, rdNW );
      vec3 rdWv = vRoadW - uRoadFire;
      float rdBb = rdRf.y, rdDd = dot( rdRf, rdWv ), rdEe = rdWv.y;
      float rdDen = max( 1.0 - rdBb * rdBb, 1e-4 );
      float rdU = clamp( ( rdEe - rdBb * rdDd ) / rdDen, 0.05, uRoadFlame.x );
      vec3 rdQp = uRoadFire + vec3( 0.0, rdU, 0.0 );
      float rdTt = max( dot( rdQp - vRoadW, rdRf ), 0.05 );
      float rdAng = length( vRoadW + rdRf * rdTt - rdQp ) / rdTt;
      float rdCol = 1.0 - 0.65 * rdU / uRoadFlame.x;
      float rdA1 = rdAng / 0.05, rdA2 = rdAng / 0.8;
      float rdImg = exp( - rdA1 * rdA1 ) * rdCol + 0.045 * exp( - rdA2 * rdA2 );
      vec3 rdRefl = uRoadSky + uRoadLightC * uRoadFlame.y * rdImg;
      // the far bank: at a grazing angle the rut wall beyond the water fills the mirror
      // (taps ahead along the view, as far as a ~3.5 cm bank shadows the reflected ray)
      vec3 rdVd = vRoadW - cameraPosition;
      float rdVh = max( length( rdVd.xz ), 1e-3 );
      vec2 rdHd = rdVd.xz / rdVh;
      float rdReach = min( 0.035 * rdVh / max( - rdVd.y, 1e-3 ), 0.7 );
      vec2 rdAhead = vec2( dot( rdHd, rdR ) / ( 2.0 * uRoadDom.x ), dot( rdHd, rdT ) / uRoadDom.y ) * rdReach;
      float rdBank = 1.0 - smoothstep( 0.6, 0.66, texture2D( uRoadTex, rdUv + rdAhead ).g );
      rdBank = max( rdBank, 0.6 * ( 1.0 - smoothstep( 0.6, 0.66, texture2D( uRoadTex, rdUv + rdAhead * 0.45 ).g ) ) );
      rdRefl = mix( rdRefl, outgoingLight * 0.6 + uRoadSky * 0.15, rdBank );
      outgoingLight = mix( outgoingLight, outgoingLight * ( 1.0 - rdF ) + rdRefl * rdF, rdWaterK );
    }
    outgoingLight += rdSpec;
  }
  #include <opaque_fragment>
  {
    // sky.js's low ground haze, in linear space, exactly as the sky mixes it into its ground
    float rdHzD = length( vRoadW.xz - uRoadCenter );
    float rdLow = 0.62 * ( 1.0 - exp( - max( rdHzD - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vRoadW.y ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uRoadHaze, rdLow );
  }
`;

// ------------------------------------------------------------- the module
export function createRoad(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fp = opts.firePosition || FIRE;
  const F = { x: +fp.x || 0, y: +fp.y || 0, z: +fp.z || 0 };
  const reduced = !!ctx.reducedMotion;
  const wind = Number.isFinite(+o.wind) ? Math.min(1.2, Math.max(0, +o.wind)) : DEFAULTS.wind;

  const group = new THREE.Group();
  group.name = 'road';
  ctx.scene.add(group);

  const t0 = performance.now();
  const { data, NX, NY } = bakeTexture(o.seed | 0);
  const tex = new THREE.DataTexture(data, NX, NY, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = ctx.renderer && ctx.renderer.capabilities ? Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()) : 1;
  tex.needsUpdate = true;
  const fine = new THREE.DataTexture(bakeFine(o.seed | 0), FINE, FINE, THREE.RGBAFormat, THREE.UnsignedByteType);
  fine.colorSpace = THREE.NoColorSpace;
  fine.wrapS = fine.wrapT = THREE.RepeatWrapping;
  fine.magFilter = THREE.LinearFilter;
  fine.minFilter = THREE.LinearMipmapLinearFilter;
  fine.generateMipmaps = true;
  fine.needsUpdate = true;
  const geo = buildGeometry();
  const bakeMs = performance.now() - t0;

  // the sky as the puddles mirror it: dark warm brown, a little lighter at dusk and dawn (never blue)
  const sky = { night: new THREE.Color(0.017, 0.0088, 0.0045), dusk: new THREE.Color(0.036, 0.018, 0.009), dawn: new THREE.Color(0.03, 0.017, 0.0105) };
  const amb = { night: new THREE.Color(0.024, 0.021, 0.021), dusk: new THREE.Color(0.042, 0.032, 0.03), dawn: new THREE.Color(0.03, 0.03, 0.036) };
  const uniforms = {
    uRoadTex: { value: tex },
    uRoadFine: { value: fine },
    uRoadDom: { value: new THREE.Vector4(EDGE, S_END, 1 / NX, 1 / NY) },
    uRoadP: { value: new THREE.Vector3(ROAD.rutOffset, ROAD.crownHalfWidth, NORMAL_H) },
    uRoadTime: { value: 0 },
    uRoadAmb: { value: amb.night.clone() },
    uRoadHaze: { value: new THREE.Color(o.hazeColor) },
    uRoadCenter: { value: new THREE.Vector2(ZONES.center.x, ZONES.center.z) },
    uRoadFire: { value: new THREE.Vector3(F.x, F.y, F.z) },
    uRoadFlame: { value: new THREE.Vector2(1.6, 1.2 / 30) },    // flame column height (m), its radiance per candela of the light
    uRoadSky: { value: sky.night.clone() },
    uRoadLightP: { value: new THREE.Vector3(F.x, F.y + 0.8, F.z) },
    uRoadLightC: { value: new THREE.Color(0, 0, 0) },
    uRoadWind: { value: new THREE.Vector2(reduced ? 0 : 0.6 + wind, 0.012 + 0.03 * wind) },
  };

  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff, transparent: true, depthWrite: false, depthTest: true, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_SURFACE)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <lights_fragment_end>', FRAG_LIGHTS_END)
      .replace('#include <opaque_fragment>', FRAG_REFLECT);
  };
  mat.customProgramCacheKey = () => 'iskry-road-v3';

  let fireLight = null, lookIn = 0;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'road-surface';
  mesh.renderOrder = Number.isFinite(+o.renderOrder) ? +o.renderOrder : DEFAULTS.renderOrder;
  group.add(mesh);

  return {
    group,
    bakeMs,
    uniforms,                     // for the dev bench
    surface: (x, z) => roadSurface(x, z, o.seed | 0),
    update(t) {
      if (!reduced) uniforms.uRoadTime.value = t;
      // the fire's PointLight (fire.js names it 'fire-light'); looked up again if the fire is rebuilt
      if (!fireLight || !fireLight.parent) {
        if (--lookIn <= 0) { lookIn = 30; fireLight = ctx.scene.getObjectByName('fire-light') || null; }
        if (!fireLight) { uniforms.uRoadLightC.value.setRGB(0, 0, 0); return; }
      }
      fireLight.getWorldPosition(uniforms.uRoadLightP.value);
      uniforms.uRoadLightC.value.copy(fireLight.color).multiplyScalar(fireLight.intensity);
    },
    resize() {},
    setTimeOfDay(tod) {
      if (!tod) return;
      const n = Math.max(0, +tod.night || 0), d = Math.max(0, +tod.dusk || 0), w = Math.max(0, +tod.dawn || 0);
      const sum = n + d + w || 1;
      const blend = (out, k) => {
        out.r = (k.night.r * n + k.dusk.r * d + k.dawn.r * w) / sum;
        out.g = (k.night.g * n + k.dusk.g * d + k.dawn.g * w) / sum;
        out.b = (k.night.b * n + k.dusk.b * d + k.dawn.b * w) / sum;
      };
      blend(uniforms.uRoadAmb.value, amb);
      blend(uniforms.uRoadSky.value, sky);
    },
    dispose() {
      ctx.scene.remove(group);
      geo.dispose(); mat.dispose(); tex.dispose(); fine.dispose();
    },
  };
}

