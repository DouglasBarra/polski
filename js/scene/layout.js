/*
  Iskry · layout.js — where things stand in the near world (single source of truth).
  OWNER: director (written by the foreground agent at the split). Pure data and maths, no three.js,
  no side effects, so every scene module can import it cheaply.

  World: metres, ground y = 0, camera at CAMERA looking toward -z, wind toward +x.
  The near world (ground, grass, road, fence, log, shrine, stork) lives out to ZONES.nearReach from
  ZONES.center; sky.js owns everything from ZONES.skyFrom out. The 30-36 m ring is open meadow.

  Exports
    CAMERA, FIRE, ZONES                       positions and distance limits
    ROAD                                      control points, widths, rut spacing
    roadPoint(t)                              t 0..1 by arc length -> { x, z, tx, tz, rx, rz } (tangent, right normal)
    roadProject(x, z)                         -> { lateral, distance, t } (lateral: signed, + right of the road)
    roadDistance(x, z)                        signed distance to the centreline (+ right of the road)
    FENCE, fenceLine(step)                    fence spec and its centreline [[x, z], ...] (right of the road)
    SHRINE, STORK, BENCH, GUITAR              props
    KEEP_OUT, inKeepOut(x, z, pad)            circles and capsules that ground cover and grass must respect
    distanceFromCenter(x, z)                  distance from ZONES.center (sky.js's convention for haze)
*/

export const CAMERA = { x: 0, y: 1.6, z: 12 };
export const FIRE = { x: -3, y: 0, z: -2 };

export const ZONES = {
  center: { x: 0, z: 12 },   // sky.js measures its ground haze and its landscape distances from here
  nearReach: 30,             // m: near-world content fades out by here
  skyFrom: 36,               // m: sky.js's landscape starts here
};

// The field road (polna droga): two dusty ruts with a grass crown, from under the camera, past the
// fire on its right, bending right toward the village. Centripetal Catmull-Rom through POINTS.
export const ROAD = {
  points: [[0.9, 10], [0.55, 5], [0.75, 0.5], [1.55, -4.5], [3.0, -9.5], [5.0, -14.2], [7.9, -18.6], [10.8, -22.4]],
  halfWidth: 1.35,           // m, the whole trodden band each side of the centreline
  rutOffset: 0.6,            // m, rut centres at +-rutOffset (so ruts are 1.2 m apart)
  rutWidth: 0.3,             // m, about 2 sigma of a rut
  crownHalfWidth: 0.38,      // m, the grassy strip between the ruts
  fadeFrom: 23,              // m from ZONES.center: the road starts fading ...
  fadeTo: 30.5,              // ... and is gone here
};

export const FENCE = {
  side: 1,                   // +1: right of the road
  offset: 2.45,              // m from the road centreline
  fromZ: 7.4,                // z where it starts near the camera ...
  toZ: -16.6,                // ... and where it ends
  spacing: [2.35, 2.75],     // m between supports (random in range)
  height: [1.12, 1.34],      // m, post heights
  railHeights: [0.47, 0.97], // m
  gateGap: 1.1,              // m: no post within this of SHRINE (the shrine stands in a field gate)
  seed: 23,
};

export const SHRINE = { x: 3.3, z: -3.2, faceX: -1, faceZ: 0.6, postHeight: 1.42, keepOut: 0.3 };
export const STORK = { x: -16, z: -19, height: 6.4, keepOut: 0.3 };

// Log bench just beyond the fire, facing it; dir is the log's axis.
export const BENCH = { x: -1.6, z: -4.25, dirX: 1, dirZ: 0.35, length: 1.6, radius: 0.2 };
const bl = Math.hypot(BENCH.dirX, BENCH.dirZ);
const bdx = BENCH.dirX / bl, bdz = BENCH.dirZ / bl;
const bfx = bdz > 0 ? -bdz : bdz, bfz = bdz > 0 ? bdx : -bdx;           // the side facing the camera (+z)
// Guitar: base on the ground in front of the log, leaning back onto it, soundboard toward fire and camera.
export const GUITAR = {
  x: BENCH.x + bdx * 0.3 + bfx * (BENCH.radius + 0.12),
  z: BENCH.z + bdz * 0.3 + bfz * (BENCH.radius + 0.12),
  lean: 0.45,                // rad back from vertical
  faceX: bfx - 0.25, faceZ: bfz,
};

// ------------------------------------------------------------------ road maths
const P = ROAD.points;
const SAMPLES_PER_SPAN = 48;
const pts = [];                                              // dense polyline [x, z, s]
(function sampleRoad() {
  const n = P.length;
  const get = (i) => {
    if (i < 0) return [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]];
    if (i >= n) return [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]];
    return P[i];
  };
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => { let v = Math.pow((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, 0.25); return v < 1e-4 ? 1 : v; };
    let dt0 = d(p0, p1), dt1 = d(p1, p2), dt2 = d(p2, p3);
    if (dt1 < 1e-4) dt1 = 1; if (dt0 < 1e-4) dt0 = dt1; if (dt2 < 1e-4) dt2 = dt1;
    const c = [0, 1].map((k) => {
      let t1 = (p1[k] - p0[k]) / dt0 - (p2[k] - p0[k]) / (dt0 + dt1) + (p2[k] - p1[k]) / dt1;
      let t2 = (p2[k] - p1[k]) / dt1 - (p3[k] - p1[k]) / (dt1 + dt2) + (p3[k] - p2[k]) / dt2;
      t1 *= dt1; t2 *= dt1;
      return [p1[k], t1, -3 * p1[k] + 3 * p2[k] - 2 * t1 - t2, 2 * p1[k] - 2 * p2[k] + t1 + t2];
    });
    for (let j = 0; j < SAMPLES_PER_SPAN; j++) {
      const u = j / SAMPLES_PER_SPAN;
      pts.push([c[0][0] + u * (c[0][1] + u * (c[0][2] + u * c[0][3])), c[1][0] + u * (c[1][1] + u * (c[1][2] + u * c[1][3])), 0]);
    }
  }
  pts.push([P[n - 1][0], P[n - 1][1], 0]);
  for (let i = 1; i < pts.length; i++) pts[i][2] = pts[i - 1][2] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
})();
const ROAD_LENGTH = pts[pts.length - 1][2];
ROAD.length = ROAD_LENGTH;

export function roadPoint(t) {
  const s = Math.min(1, Math.max(0, t)) * ROAD_LENGTH;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][2] <= s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const seg = b[2] - a[2] || 1, u = (s - a[2]) / seg;
  const tx = (b[0] - a[0]) / seg, tz = (b[1] - a[1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, tx, tz, rx: -tz, rz: tx };
}

export function roadProject(x, z) {
  let best = Infinity, lat = 0, tt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
    const u = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
    const px = a[0] + ex * u, pz = a[1] + ez * u;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) {
      best = d2;
      const L = Math.sqrt(L2);
      lat = ((x - px) * (-ez / L) + (z - pz) * (ex / L)) >= 0 ? Math.sqrt(d2) : -Math.sqrt(d2);
      tt = (a[2] + (b[2] - a[2]) * u) / ROAD_LENGTH;
    }
  }
  return { lateral: lat, distance: Math.sqrt(best), t: tt };
}
export const roadDistance = (x, z) => roadProject(x, z).lateral;

export function fenceLine(step = 0.25) {
  const out = [];
  const n = Math.ceil(ROAD_LENGTH / step);
  for (let i = 0; i <= n; i++) {
    const p = roadPoint(i / n);
    if (p.z > FENCE.fromZ || p.z < FENCE.toZ) continue;
    out.push([p.x + p.rx * FENCE.offset * FENCE.side, p.z + p.rz * FENCE.offset * FENCE.side]);
  }
  return out;
}

// ------------------------------------------------------------------ keep-outs
const benchA = [BENCH.x - bdx * BENCH.length / 2, BENCH.z - bdz * BENCH.length / 2];
const benchB = [BENCH.x + bdx * BENCH.length / 2, BENCH.z + bdz * BENCH.length / 2];
export const KEEP_OUT = [
  { what: 'fire ring', x: FIRE.x, z: FIRE.z, r: 1.75 },                               // ash and stones; grass starts beyond
  { what: 'bench', a: benchA, b: benchB, r: BENCH.radius + 0.12 },                     // capsule along the log
  { what: 'guitar', x: GUITAR.x, z: GUITAR.z, r: 0.25 },
  { what: 'shrine post', x: SHRINE.x, z: SHRINE.z, r: SHRINE.keepOut },
  { what: 'stork pole', x: STORK.x, z: STORK.z, r: STORK.keepOut },
];
export function inKeepOut(x, z, pad = 0) {
  for (const k of KEEP_OUT) {
    let d;
    if (k.a) {
      const ex = k.b[0] - k.a[0], ez = k.b[1] - k.a[1];
      const u = Math.min(1, Math.max(0, ((x - k.a[0]) * ex + (z - k.a[1]) * ez) / (ex * ex + ez * ez)));
      d = Math.hypot(x - (k.a[0] + ex * u), z - (k.a[1] + ez * u));
    } else d = Math.hypot(x - k.x, z - k.z);
    if (d < k.r + pad) return true;
  }
  return false;
}

export const distanceFromCenter = (x, z) => Math.hypot(x - ZONES.center.x, z - ZONES.center.z);
