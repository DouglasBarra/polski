/*
  Iskry · stars.js — the real night sky over Poland, as a quiet long-exposure photograph.
  OWNER: Opus worker "stars". Interface: CONTRACT.md / scene-modules-spec.md (environment module).

  createStars(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(),
                              facingAzDeg, horizonToWorld(altDeg, azDeg, out), equatorialToWorld(raDeg, decDeg, out),
                              skyTimeMs(), lstDeg(), setLines(on), setTimeOfDay(tod) }
    opts { date = new Date(), latitudeDeg = 52.2, longitudeDeg = 21.0 (Warsaw), radius = 88,
           facingAzDeg = 'auto' | number (compass azimuth of world -z: 0 N, 90 E, 180 S, 270 W),
           wallClock = true, timeZone = 'Europe/Warsaw' (the date's local wall-clock time is read as that
             wall-clock time in Warsaw, so 21:00 for the visitor shows 21:00 by a Polish fire; false = the
             absolute instant),
           timeScale = 1 (dev only), lines = false (debug constellation figures) }

  What it draws (2 draw calls; a 3rd only when the debug constellation lines are on):
    1. milky way  a sphere just inside the sky dome. Its texture is baked ONCE at init on the GPU
                  (2048x512, galactic longitude x latitude): a thin + thick disc with star clouds,
                  the Great Rift and filamentary dust lanes, and faint glows at their real places
                  (M42 and Barnard's Loop, the Lambda Orionis ring, the California Nebula, the Rosette,
                  the North America Nebula, IC 1396, the Heart and Soul, the Pleiades' blue haze, M31...).
    2. stars      ONE Points cloud: the 15 598 real stars to V 7.0 (HYG v4.1, js/scene/stars-data.js)
                  plus ~90 000 fainter procedural stars (V 7-9.8) crowding the galactic plane, thinned
                  by the same dust as the Milky Way. Each star is a point-spread function: a tight core
                  that bloats with brightness, a soft halo on the bright ones, real B-V colours (slightly
                  saturated, as in photographs), faint 4-point diffraction spikes on the brightest few.

  The sky is real: J2000 positions, precessed to the date, turned by the local sidereal time of
  opts.date at opts.longitudeDeg and tilted for opts.latitudeDeg, so it is exactly the sky above
  Warsaw at that moment. It then turns with the real sky (sidereal rate; frozen under reduced motion).
  Atmospheric extinction by airmass (per channel, so stars dim and redden toward the horizon), and a
  final fade into the treeline haze. Gentle scintillation only on the brighter low stars.

  WHICH WAY WE FACE: world -z is compass azimuth 120 deg (ESE), so +x (right) is 210 (SSW) and +z
  (behind) is 300 (WNW). A compass azimuth A is the world direction (sin(A-120), 0, -cos(A-120)).
  The camera looks along -z pitched up 6.5 deg with a 40 deg vertical fov, so only altitudes from the
  treeline (~5 deg) to ~26 deg are on screen: a low band of sky. Scoring every facing by the bright
  stars inside that band on evenings 20-23 h across the year, 120 deg wins for September to February
  and peaks in November and December: Orion rising left of centre with Gemini and Procyon to its
  left, Taurus above it, and later Sirius rising almost dead ahead (it rises at azimuth ~118 deg).
  facingAzDeg 'auto' instead picks, at creation, the facing whose low band holds the brightest stars
  over the next hour (exported as facingAzimuthFor); other modules must then read handle.facingAzDeg.

  TIME: opts.date at creation, then the real clock; setTimeOfDay(tod) (called by the core every 20 s
  with { hour, dusk, night, dawn }) re-anchors the sky to tod.hour on today's date and fades the faint
  stars and the Milky Way by (dusk + dawn) * 0.6. If the same hour arrives twice the clock is pinned
  (?hour=5.5): the sky then holds still at that hour.

  Layering: drawn in the OPAQUE pass (transparent false) with additive blending, depthWrite off,
  depthTest on, fog off, inside the sky dome (radius 90). renderOrder: milky way -91, stars -90,
  debug lines -89: after sky.js's dome (-100) and the moon disc (-95, which writes depth at 80 m and
  so hides the stars behind it), before the land (-50) and ground (-45), which then paint over them
  at any distance (the Tatras are 369 m away). Nothing is drawn below ~2 deg altitude (the ground
  writes no depth) and everything fades into the horizon haze over the lowest ~10 deg.

  Data: js/scene/stars-data.js is generated (see its header for sources and licences) by
  python3 -I build_data.py <hygdata_v41.csv> <constellations.lines.json> js/scene/stars-data.js 7.0
  (script kept outside the repo; the encoding is documented in the data file).
*/
import * as THREE from 'three';
import { STAR_COUNT, STARS_B64, LINES } from './stars-data.js';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ tunables
const DEFAULTS = {
  date: null,              // Date | ms | ISO string; default now
  latitudeDeg: 52.2,       // Warsaw
  longitudeDeg: 21.0,
  radius: 88,              // points sphere; the milky way sits at radius * 1.01 (dome is 90)
  facingAzDeg: 120,        // ESE; 'auto' picks the brightest low band at creation (see header)
  wallClock: true,         // read the date's local wall-clock time as the same wall-clock time in timeZone
  timeZone: 'Europe/Warsaw',
  timeScale: 1,
  lines: false,
  proceduralCount: 90000,  // faint fill stars (reduced motion: 70%)
  seed: 11,
};

const LOOK = {
  gain: 0.30,          // display-space peak of a V 6 star at the zenith
  gamma: 0.34,          // peak ~ flux^gamma: the photographic squeeze of the dynamic range
  maxPeak: 0.62,        // no star is brighter than the words (cream text ~0.9)
  extK: [0.08, 0.13, 0.24], // extinction, magnitudes per airmass, R G B (rural haze, so a bit high)
  saturation: 1.35,     // star colours, photographs push them a little
  twinkle: 0.11,        // max scintillation amplitude (bright, low stars only)
  spikes: 0.10,         // diffraction spikes, relative to the core peak
  milkyGain: 0.62,     // display-space brightness of the brightest milky way
};

// --------------------------------------------------------------- astronomy
const julianDate = (ms) => ms / 86400000 + 2440587.5;
function gmstRad(ms) {
  const d = julianDate(ms) - 2451545.0;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
  return (((deg % 360) + 360) % 360) * D2R;
}
// IAU 1976 precession J2000 -> mean equator of date, row-major 3x3.
function precessionMatrix(ms, out) {
  const T = (julianDate(ms) - 2451545.0) / 36525;
  const as = D2R / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
  const cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
  out[0] = cz * ct * cZ - sz * sZ; out[1] = -sz * ct * cZ - cz * sZ; out[2] = -st * cZ;
  out[3] = cz * ct * sZ + sz * cZ; out[4] = -sz * ct * sZ + cz * cZ; out[5] = -st * sZ;
  out[6] = cz * st;                out[7] = -sz * st;                out[8] = ct;
  return out;
}
// J2000 equatorial -> galactic (rows), and its transpose.
const EQ2GAL = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
];
function eqVec(raDeg, decDeg, out, o = 0) {
  const a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
  out[o] = cd * Math.cos(a); out[o + 1] = cd * Math.sin(a); out[o + 2] = Math.sin(d);
  return out;
}
function mul3v(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[1] * y + m[2] * z;
  out[o + 1] = m[3] * x + m[4] * y + m[5] * z;
  out[o + 2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

// World matrix (row-major 3x3): J2000 vector -> world direction, for sidereal angle lst.
// Hour-angle frame: rotate by -LST about the pole; then tilt for latitude into (north, east, up);
// then map the horizon onto the scene: world -z = azimuth A0, +x = A0 + 90 deg, +y = up.
function skyMatrix(P, lst, latRad, facingRad, out) {
  const cL = Math.cos(lst), sL = Math.sin(lst), cp = Math.cos(latRad), sp = Math.sin(latRad);
  const cA = Math.cos(facingRad), sA = Math.sin(facingRad);
  for (let j = 0; j < 3; j++) {
    // column j of P = image of the J2000 basis vector j in the equator of date
    const x = P[j], y = P[3 + j], z = P[6 + j];
    const hx = cL * x + sL * y, hy = -sL * x + cL * y, hz = z;
    const up = hx * cp + hz * sp, north = -hx * sp + hz * cp, east = hy;
    out[j] = -north * sA + east * cA;          // world x
    out[3 + j] = up;                           // world y
    out[6 + j] = -(north * cA + east * sA);    // world z
  }
  return out;
}

const parseDate = (d) => {
  if (d == null) return Date.now();
  if (d instanceof Date) return d.getTime();
  const ms = typeof d === 'number' ? d : Date.parse(String(d));
  return Number.isFinite(ms) ? ms : Date.now();
};

// The instant at which `timeZone` shows the same wall-clock time as `ms` does in the browser's zone.
// (Someone sitting down at 21:00 wherever they are gets the sky of 21:00 by a fire in Poland.)
function wallClockIn(ms, timeZone) {
  const d = new Date(ms);
  const wall = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const offsetAt = (t) => {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
        day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      const p = {};
      for (const x of f.formatToParts(new Date(t))) p[x.type] = +x.value;
      return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
    } catch (e) {
      return 3600e3;   // CET
    }
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);          // settle across a DST change
  return t;
}

// ---------------------------------------------------------------- catalogue
let catalogue = null; // { n, ra, dec (rad, J2000), mag, bv } decoded once per page
function decodeCatalogue() {
  if (catalogue) return catalogue;
  const bin = atob(STARS_B64);
  const n = Math.min(STAR_COUNT, Math.floor(bin.length / 6));
  const ra = new Float32Array(n), dec = new Float32Array(n), mag = new Float32Array(n), bv = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 6) {
    const r = bin.charCodeAt(p) | (bin.charCodeAt(p + 1) << 8);
    const d = bin.charCodeAt(p + 2) | (bin.charCodeAt(p + 3) << 8);
    ra[i] = (r / 65536) * TAU;
    dec[i] = (d / 65535 - 0.5) * Math.PI;
    mag[i] = bin.charCodeAt(p + 4) / 25 - 2;
    bv[i] = bin.charCodeAt(p + 5) / 100 - 0.5;
  }
  catalogue = { n, ra, dec, mag, bv };
  return catalogue;
}

// Pick the compass direction (deg) whose visible low band holds the brightest stars soon.
let facingCache = null;
export function facingAzimuthFor(date, latitudeDeg = 52.2, longitudeDeg = 21.0) {
  const ms = parseDate(date);
  if (facingCache && facingCache.lat === latitudeDeg && facingCache.lon === longitudeDeg &&
      Math.abs(facingCache.ms - ms) < 3 * 3600e3) return facingCache.az;
  const cat = decodeCatalogue();
  const P = precessionMatrix(ms, new Float64Array(9));
  const M = new Float64Array(9);
  const bins = new Float64Array(72);
  const v = new Float64Array(3), w = new Float64Array(3);
  const lat = latitudeDeg * D2R;
  for (let k = 0; k < 3; k++) {                     // now, +30 min, +60 min
    const t = ms + k * 1800e3;
    skyMatrix(P, gmstRad(t) + longitudeDeg * D2R, lat, 0, M);   // facing north: az = atan2(x, -z)
    for (let i = 0; i < cat.n; i++) {
      const m = cat.mag[i];
      if (m > 4.5) break;                            // sorted brightest first
      eqVec(cat.ra[i] / D2R, cat.dec[i] / D2R, v);
      mul3v(M, v[0], v[1], v[2], w);
      const alt = Math.asin(Math.max(-1, Math.min(1, w[1]))) / D2R;
      if (alt < 7 || alt > 25) continue;
      const az = Math.atan2(w[0], -w[2]) / D2R;
      const X = 1 / (Math.sin(alt * D2R) + 0.50572 * Math.pow(alt + 6.07995, -1.6364));
      const f = Math.pow(10, -0.4 * (m + 0.21 * X)) * (alt < 10 ? (alt - 7) / 3 : 1);
      const b0 = Math.round((((az % 360) + 360) % 360) / 5);
      for (let d = -6; d <= 6; d++) bins[(b0 + d + 72) % 72] += f * (1 - Math.abs(d) / 9);
    }
  }
  let best = 0, bestS = -1;
  for (let b = 0; b < 72; b++) {
    const az = b * 5;
    const s = bins[b] * (1 + 0.18 * Math.cos((az - 115) * D2R));    // mild preference for the east / south-east
    if (s > bestS) { bestS = s; best = az; }
  }
  facingCache = { ms, lat: latitudeDeg, lon: longitudeDeg, az: best };
  return best;
}

// B-V -> display colour (normalised, saturated a little), via temperature (Ballesteros 2012)
// and a blackbody fit (Helland) with its white point near 6600 K.
function bvColour(bv, sat, out, o) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  r = Math.max(0, Math.min(255, r)) / 255; g = Math.max(0, Math.min(255, g)) / 255; b = Math.max(0, Math.min(255, b)) / 255;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const mx = Math.max(r, g, b), l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = 1 / (0.55 * mx + 0.45 * l2 + 1e-6);      // between max- and luma-normalised
  out[o] = Math.min(1.25, r * k); out[o + 1] = Math.min(1.25, g * k); out[o + 2] = Math.min(1.25, b * k);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------- GLSL
const GLSL_UTIL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 fromSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  // Atmospheric transmission per channel for sine-of-altitude s (Kasten & Young airmass).
  vec3 transmission(float s, vec3 k) {
    float alt = degrees(asin(clamp(s, 0.0, 1.0)));
    float X = 1.0 / (max(s, 0.0) + 0.50572 * pow(alt + 6.07995, -1.6364));
    return pow(vec3(10.0), -0.4 * k * X);
  }
  vec2 galUV(vec3 g) {
    float l = atan(g.y, g.x);
    float b = asin(clamp(g.z, -1.0, 1.0));
    return vec2(l / 6.2831853 + 0.5, 0.5 + b / 1.5707963);   // b in [-45, 45] deg
  }
`;

// Milky Way bake: equirectangular in galactic coordinates (u: l from -180 to 180, v: b from -45 to 45).
// Output rgb = sqrt(colour) (0..1 relative), a = sqrt(faint-star density after dust).
const NEB_N = 20;
const BAKE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const BAKE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec4 uNebA[${NEB_N}];   // centre (galactic unit vector), sigma (rad)
  uniform vec4 uNebB[${NEB_N}];   // amplitude, minor/major ratio, type (0 emission, 1 reflection, 2 galaxy, 3 ring), ring radius (rad)
  uniform vec4 uNebC[${NEB_N}];   // major axis (galactic tangent unit vector), half-ring bias (0 = full ring)
  uniform vec4 uDust[6];          // dark clouds: centre, sigma
  uniform float uDustAmp[6];
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                   mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                   mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
  }
  float fbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int o = 0; o < 5; o++) { s += a * vnoise3(p); p = p * 2.03 + vec3(17.1, 5.3, 9.7); a *= 0.5; }
    return s / 0.96875;
  }
  float g1(float x, float s) { return exp(-0.5 * x * x / (s * s)); }
  void main() {
    float l = (vUv.x - 0.5) * 6.2831853;
    float b = (vUv.y - 0.5) * 1.5707963;
    vec3 g = vec3(cos(b) * cos(l), cos(b) * sin(l), sin(b));
    float ld = degrees(l), bd = degrees(b);

    // --- the stellar disc: bright toward the centre, the Cygnus and Scutum clouds, a bulge
    float env = 0.30 + 0.80 * g1(ld, 38.0)
              + 0.42 * g1(ld - 76.0, 13.0) + 0.22 * g1(ld - 27.0, 6.0)
              + 0.12 * g1(ld - 128.0, 28.0) + 0.30 * g1(ld + 70.0, 22.0);
    float thick = 3.0 + 4.5 * g1(ld, 16.0);
    float band = env * (0.6 * g1(bd, thick) + 0.4 * g1(bd, thick * 1.8 + 3.5));

    // --- star clouds: clumpy brightness on three scales
    float n1 = fbm(g * 5.0 + 1.3);
    float n2 = fbm(g * 16.0 + 3.1);
    float n3 = fbm(g * 44.0 + 7.7);
    float clouds = 0.30 + 1.25 * smoothstep(0.30, 0.80, n1) * (0.55 + 0.9 * n2) + 0.35 * n3;
    float starsL = band * clouds;

    // --- dust: the Great Rift (Cygnus to Sagittarius), filaments, patchy lanes, dark clouds
    float riftL = smoothstep(92.0, 68.0, ld) * smoothstep(-40.0, -12.0, ld);
    float riftB = 0.8 + 2.0 * sin(radians(ld * 2.6 + 20.0)) + 3.0 * (n1 - 0.5);
    float rift = riftL * g1(bd - riftB, 1.6 + 2.4 * n2) * smoothstep(0.2, 0.6, fbm(g * 7.0 + 5.0));
    float ridge = 1.0 - abs(2.0 * fbm(g * 13.0 + 11.0) - 1.0);
    float patchy = smoothstep(0.48, 0.72, fbm(g * 3.0 + 40.0));
    float fil = pow(ridge, 10.0) * patchy * g1(bd, 6.0) * 0.8;
    float lanes = smoothstep(0.52, 0.78, fbm(g * 8.0 + 21.0)) * g1(bd, 4.0) * 0.5;
    float dark = 0.0;
    for (int i = 0; i < 6; i++) {
      float c = dot(g, uDust[i].xyz);
      float a = acos(clamp(c, -1.0, 1.0));
      dark += uDustAmp[i] * g1(a, uDust[i].w) * (0.5 + 0.7 * n2);
    }
    float dust = clamp(rift * 0.92 + fil + lanes + dark, 0.0, 0.94);

    // colour: warm bulge, cooler star clouds, reddened at the dust edges
    vec3 col = mix(vec3(0.86, 0.90, 1.00), vec3(1.00, 0.87, 0.70), g1(ld, 30.0) * g1(bd, 12.0) * 0.9 + 0.15);
    col *= mix(vec3(1.0), vec3(1.0, 0.72, 0.52), clamp(dust * 1.4, 0.0, 1.0) * 0.55);
    vec3 c = col * starsL * (1.0 - dust);
    float density = starsL * (1.0 - dust);

    // --- nebulae and galaxies at their real places
    for (int i = 0; i < ${NEB_N}; i++) {
      vec4 A = uNebA[i]; vec4 B = uNebB[i]; vec4 C = uNebC[i];
      if (B.x <= 0.0) continue;
      vec3 o = g - A.xyz * dot(g, A.xyz);          // tangent offset (radians, small angle)
      if (dot(g, A.xyz) < 0.8) continue;
      vec3 minorAx = cross(A.xyz, C.xyz);
      float x = dot(o, C.xyz), y = dot(o, minorAx);
      float wisp = 0.45 + 0.9 * fbm(g * 70.0 + float(i) * 3.7);
      float v;
      if (B.z > 2.5) {             // ring / arc
        float r = length(vec2(x, y));
        v = g1(r - B.w, A.w);
        if (C.w > 0.0) v *= smoothstep(-0.25, 0.75, x / max(r, 1e-4));
        v *= wisp * smoothstep(0.25, 0.75, fbm(g * 25.0 + float(i)));
      } else {
        v = exp(-0.5 * (x * x + y * y / (B.y * B.y)) / (A.w * A.w));
        if (B.z < 0.5) v *= wisp;
        if (B.z > 1.5) v += 0.6 * exp(-0.5 * (x * x + y * y / (B.y * B.y)) / (A.w * A.w * 0.03));  // galaxy core
      }
      vec3 nc = B.z < 0.5 ? vec3(1.0, 0.36, 0.44) : (B.z < 1.5 ? vec3(0.55, 0.70, 1.0) : (B.z < 2.5 ? vec3(1.0, 0.88, 0.74) : vec3(1.0, 0.34, 0.42)));
      c += nc * v * B.x;
    }
    gl_FragColor = vec4(sqrt(clamp(c, 0.0, 1.0)), sqrt(clamp(density, 0.0, 1.0)));
  }
`;

// Values are designed in display (sRGB) space; hand three the linear equivalent (fragment only).
const GLSL_OUT = /* glsl */ `
  vec4 displayOut(vec3 c) { return linearToOutputTexel(vec4(fromSRGB(c), 1.0)); }
`;

const MW_VERT = /* glsl */ `
  uniform vec3 uExtK;
  varying vec3 vLocal;
  varying vec3 vTrans;      // atmospheric transmission x horizon fade (smooth in altitude: per vertex)
  ${GLSL_UTIL}
  void main() {
    vLocal = position;
    float s = normalize(mat3(modelMatrix) * position).y;
    vTrans = transmission(s, uExtK) * smoothstep(0.035, 0.17, s);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MW_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uMW;
  uniform mat3 uGal;
  uniform float uGain;
  varying vec3 vLocal;
  varying vec3 vTrans;
  ${GLSL_UTIL}
  ${GLSL_OUT}
  void main() {
    vec3 g = uGal * normalize(vLocal);
    vec4 t = texture2D(uMW, galUV(g));
    vec3 c = t.rgb * t.rgb * uGain * max(vTrans, 0.0);
    // dither one 8-bit step so the faint band never posterises
    vec2 fc = gl_FragCoord.xy;
    c += (hash12(fc) + hash12(fc + 71.13) - 1.0) / 255.0;
    gl_FragColor = displayOut(c);
  }
`;

const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;    // display colour, normalised
  attribute vec3 aStar;     // V magnitude, twinkle phase 0..1, milky-way-modulated (1) or not (0)
  uniform float uPx, uTime, uTwinkle, uGain, uGamma, uMaxPeak, uSpike, uTwilight;
  uniform vec3 uExtK;
  uniform mat3 uGal;
  uniform sampler2D uMW;
  varying vec3 vCore, vHalo;
  varying vec4 vShape;      // core sigma, halo scale, spike strength, sprite size (css px)
  varying float vHaloAmp;
  ${GLSL_UTIL}
  void main() {
    vec3 dir = normalize(mat3(modelMatrix) * position);
    float s = dir.y;
    if (s < 0.035) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }   // below ~2 deg
    vec3 tr = transmission(s, uExtK);
    float fade = smoothstep(0.035, 0.17, s);                  // into the horizon haze over the lowest ~10 deg
    float m = aStar.x;
    float f = exp2(-1.3287712 * (m - 6.0)) * tr.g * fade;     // 10^(-0.4 (m - 6))
    f *= 1.0 - uTwilight * smoothstep(1.5, 4.5, m);          // twilight washes out the faint ones
    if (aStar.z > 0.5) {
      vec4 t = texture2D(uMW, galUV(uGal * normalize(position)));
      f *= 0.12 + 2.2 * t.a * t.a;                             // crowd the star clouds, empty the dust lanes
    }
    if (uTwinkle > 0.0 && m < 3.2) {
      float low = clamp((1.0 / max(s, 0.05) - 2.0) / 8.0, 0.0, 1.0);
      float amp = uTwinkle * smoothstep(3.2, 1.0, m) * low;
      float ph = aStar.y * 61.0;
      float n = 0.5 * sin(uTime * 2.1 + ph) + 0.3 * sin(uTime * 3.7 + ph * 1.7) + 0.2 * sin(uTime * 5.3 + ph * 2.9);
      f *= 1.0 + amp * n;
    }
    float lf = log2(max(f, 1e-6)) * 0.30103;                   // log10 flux, 0 at V 6
    float peak = min(uGain * pow(f, uGamma), uMaxPeak);
    float sig = 0.72 + 0.62 * max(lf, 0.0) * max(lf, 0.0) * 0.45;
    float haloAmp = 0.20 * smoothstep(0.3, 2.4, lf);
    float haloS = 1.8 + 2.6 * max(lf, 0.0);
    float spike = uSpike * smoothstep(1.9, 2.8, lf);
    float spikeL = 5.0 + 8.0 * max(lf - 1.9, 0.0);
    // sprite radius: where the brightest component falls below ~1/400
    float rc = sig * sqrt(2.0 * log(max(400.0 * peak, 1.01)));
    float rh = haloAmp > 0.0 ? haloS * log(max(400.0 * peak * haloAmp, 1.01)) : 0.0;
    float rs = spike > 0.0 ? spikeL * log(max(400.0 * peak * spike, 1.01)) : 0.0;
    float R = clamp(max(rc, max(rh, rs)) + 0.75, 1.6, 60.0);
    if (peak < 0.0025) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

    // reddening: colour ratio of the per-channel transmission
    vec3 red = tr / tr.g;
    vec3 col = aColor * red;
    float whiteCore = 0.25 + 0.45 * smoothstep(0.8, 2.6, lf);
    vCore = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), whiteCore) * peak;
    vHalo = col * peak;
    vHaloAmp = haloAmp;
    vShape = vec4(sig, haloS, spike, 2.0 * R);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 2.0 * R * uPx;
  }
`;
const STAR_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vCore, vHalo;
  varying vec4 vShape;
  varying float vHaloAmp;
  ${GLSL_UTIL}
  ${GLSL_OUT}
  void main() {
    vec2 p = (gl_PointCoord - 0.5) * vShape.w;     // css px from the star centre
    float r2 = dot(p, p);
    float R = 0.5 * vShape.w;
    float win = 1.0 - smoothstep(R * 0.7, R, sqrt(r2));
    float core = exp(-0.5 * r2 / (vShape.x * vShape.x));
    vec3 c = vCore * core;
    if (vHaloAmp > 0.0) {
      float r = sqrt(r2);
      c += vHalo * vHaloAmp * (exp(-r / vShape.y) + 0.35 * exp(-r / (vShape.y * 3.0)));
    }
    if (vShape.z > 0.0) {
      vec2 a = abs(p);
      float L = R * 0.42;
      float sp = exp(-a.x / 0.55) * exp(-a.y / L) + exp(-a.y / 0.55) * exp(-a.x / L);
      c += vHalo * vShape.z * sp;
    }
    c *= win;
    if (max(c.r, max(c.g, c.b)) < 0.0008) discard;
    gl_FragColor = displayOut(c);
  }
`;

// Nebulae: [raDeg, decDeg, sigmaDeg, amp, minor/major, type, ringRadiusDeg, PAdeg, halfRing]
//   type 0 emission (pink), 1 reflection (blue), 2 galaxy (warm, with a core), 3 emission ring/arc
const NEBULAE = [
  [83.82, -5.39, 0.55, 1.0, 0.8, 0, 0, 0, 0],          // M42 Orion Nebula
  [83.9, -4.2, 2.6, 0.10, 0.6, 0, 0, 20, 0],           // the Orion molecular cloud glow around it
  [85.4, -2.3, 0.85, 0.24, 0.5, 3, 7.4, 90, 1],        // Barnard's Loop (the eastern arc)
  [83.8, 9.9, 1.3, 0.07, 1, 3, 4.0, 0, 0],             // Lambda Orionis ring
  [85.25, -2.45, 0.35, 0.20, 0.4, 0, 0, 0, 0],         // IC 434 / Flame region
  [60.2, 36.4, 0.38, 0.32, 0.26, 0, 0, 120, 0],        // California Nebula NGC 1499 (elongated)
  [56.75, 24.12, 0.55, 0.42, 0.9, 1, 0, 0, 0],         // Pleiades reflection haze
  [97.98, 4.95, 0.55, 0.30, 1, 0, 0, 0, 0],            // Rosette
  [100.2, 9.9, 0.6, 0.13, 0.7, 0, 0, 0, 0],            // NGC 2264 / Cone
  [79.1, 34.3, 0.45, 0.14, 0.8, 0, 0, 0, 0],           // Flaming Star IC 405
  [314.7, 44.3, 0.95, 0.46, 0.8, 0, 0, 0, 0],          // North America + Pelican
  [305.6, 40.3, 1.8, 0.24, 0.7, 0, 0, 30, 0],          // Sadr region IC 1318
  [324.7, 57.5, 1.3, 0.26, 0.9, 0, 0, 0, 0],           // IC 1396
  [38.2, 61.45, 0.6, 0.26, 0.9, 0, 0, 0, 0],           // Heart IC 1805
  [42.8, 60.4, 0.6, 0.22, 0.8, 0, 0, 0, 0],            // Soul IC 1848
  [10.68, 41.27, 1.05, 0.30, 0.30, 2, 0, 35, 0],       // Andromeda Galaxy M31
  [23.46, 30.66, 0.28, 0.08, 0.6, 2, 0, 23, 0],        // Triangulum M33
  [270.9, -24.4, 0.45, 0.65, 0.7, 0, 0, 0, 0],         // Lagoon M8
  [275.2, -16.2, 0.3, 0.35, 0.8, 0, 0, 0, 0],          // M17 Omega
  [84.0, -1.2, 0.5, 0.08, 1, 1, 0, 0, 0],              // M78 region reflection
];
// Dark clouds: [raDeg, decDeg, sigmaDeg, amp]
const DARK = [
  [68.0, 26.0, 4.5, 0.55],    // Taurus molecular clouds
  [56.0, 32.0, 3.0, 0.35],    // Perseus clouds
  [247.0, -24.0, 4.0, 0.6],   // Rho Ophiuchi
  [313.0, 40.0, 2.0, 0.35],   // Cygnus rift north end
  [338.0, 60.0, 3.0, 0.25],   // Cepheus dust
  [84.5, -6.0, 1.5, 0.25],    // Orion A edges
];

// --------------------------------------------------------------- the module
export function createStars(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const reduced = !!ctx.reducedMotion;
  const date0 = o.wallClock ? wallClockIn(parseDate(o.date), o.timeZone) : parseDate(o.date);
  const lat = o.latitudeDeg * D2R;
  const facingDeg = typeof o.facingAzDeg === 'number' && Number.isFinite(o.facingAzDeg)
    ? ((o.facingAzDeg % 360) + 360) % 360
    : facingAzimuthFor(date0, o.latitudeDeg, o.longitudeDeg);
  const facing = facingDeg * D2R;
  const R = o.radius;
  const renderer = ctx.renderer;
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  const group = new THREE.Group();
  group.name = 'stars';
  ctx.scene.add(group);
  // The celestial frame: local coordinates are J2000 equatorial; its matrix turns them onto the sky.
  const celestial = new THREE.Object3D();
  celestial.name = 'stars-celestial';
  celestial.matrixAutoUpdate = false;
  group.add(celestial);

  const P = precessionMatrix(date0, new Float64Array(9));
  const M = new Float64Array(9);
  const gal = new THREE.Matrix3().set(...EQ2GAL);
  const extK = new THREE.Vector3(...LOOK.extK);

  // ------------------------------------------------ milky way: bake once on the GPU
  const tmpA = new Float64Array(3), tmpB = new Float64Array(3);
  const toGal = (v, out) => mul3v(EQ2GAL, v[0], v[1], v[2], out);
  const nebA = [], nebB = [], nebC = [];
  for (let i = 0; i < NEB_N; i++) {
    const n = NEBULAE[i];
    if (!n) { nebA.push(new THREE.Vector4()); nebB.push(new THREE.Vector4()); nebC.push(new THREE.Vector4()); continue; }
    const [ra, dec, sig, amp, ratio, type, ring, pa, half] = n;
    toGal(eqVec(ra, dec, tmpA), tmpB);
    const cg = new THREE.Vector3(tmpB[0], tmpB[1], tmpB[2]);
    // major axis: position angle from north through east, as a galactic tangent vector
    const a = ra * D2R, d = dec * D2R, p = pa * D2R;
    const nx = -Math.sin(d) * Math.cos(a), ny = -Math.sin(d) * Math.sin(a), nz = Math.cos(d);
    const ex = -Math.sin(a), ey = Math.cos(a);
    const ax = [nx * Math.cos(p) + ex * Math.sin(p), ny * Math.cos(p) + ey * Math.sin(p), nz * Math.cos(p)];
    toGal(ax, tmpA);
    const axg = new THREE.Vector3(tmpA[0], tmpA[1], tmpA[2]).normalize();
    nebA.push(new THREE.Vector4(cg.x, cg.y, cg.z, sig * D2R));
    nebB.push(new THREE.Vector4(amp, ratio, type, ring * D2R));
    nebC.push(new THREE.Vector4(axg.x, axg.y, axg.z, half));
  }
  const dustV = [], dustAmp = [];
  for (const [ra, dec, sig, amp] of DARK) {
    toGal(eqVec(ra, dec, tmpA), tmpB);
    dustV.push(new THREE.Vector4(tmpB[0], tmpB[1], tmpB[2], sig * D2R));
    dustAmp.push(amp);
  }

  const mwRT = track(new THREE.WebGLRenderTarget(2048, 512, {
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, type: THREE.UnsignedByteType,
  }));
  {
    const bakeMat = new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uNebA: { value: nebA }, uNebB: { value: nebB }, uNebC: { value: nebC },
        uDust: { value: dustV }, uDustAmp: { value: dustAmp },
      },
    });
    const bakeGeo = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(bakeGeo, bakeMat);
    quad.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(quad);
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(mwRT);
    renderer.render(bakeScene, new THREE.Camera());
    renderer.setRenderTarget(prevRT);
    bakeGeo.dispose(); bakeMat.dispose();
  }
  const mwTex = mwRT.texture;

  const mwMat = track(new THREE.ShaderMaterial({
    vertexShader: MW_VERT, fragmentShader: MW_FRAG,
    side: THREE.BackSide, transparent: false, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    uniforms: {
      uMW: { value: mwTex }, uGal: { value: gal }, uGain: { value: LOOK.milkyGain }, uExtK: { value: extK },
    },
  }));
  const mwGeo = track(new THREE.SphereGeometry(R * 1.01, 96, 48));
  const milky = new THREE.Mesh(mwGeo, mwMat);
  milky.name = 'stars-milkyway';
  milky.renderOrder = -91;
  milky.frustumCulled = false;
  celestial.add(milky);

  // ------------------------------------------------ stars: real + procedural, one Points
  const cat = decodeCatalogue();
  const nProc = Math.round(o.proceduralCount * (reduced ? 0.7 : 1));
  const N = cat.n + nProc;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), info = new Float32Array(N * 3);
  const rng = mulberry32(o.seed * 7919 + 17);
  for (let i = 0; i < cat.n; i++) {
    const a = cat.ra[i], d = cat.dec[i], cd = Math.cos(d);
    pos[i * 3] = cd * Math.cos(a) * R; pos[i * 3 + 1] = cd * Math.sin(a) * R; pos[i * 3 + 2] = Math.sin(d) * R;
    bvColour(cat.bv[i], LOOK.saturation, col, i * 3);
    info[i * 3] = cat.mag[i]; info[i * 3 + 1] = rng(); info[i * 3 + 2] = 0;
  }
  const kExp = 0.4 * Math.LN10, span = Math.exp(kExp * 2.8) - 1;
  for (let j = 0; j < nProc; j++) {
    const i = cat.n + j;
    let gx, gy, gz, disc;
    if (rng() < 0.62) {                           // in the disc: galactic latitude ~ Laplace(4.5 deg)
      const l = rng() * TAU;
      const u = rng() - 0.5;
      const b = -Math.sign(u) * Math.log(1 - 2 * Math.abs(u)) * 4.5 * D2R;
      gx = Math.cos(b) * Math.cos(l); gy = Math.cos(b) * Math.sin(l); gz = Math.sin(b); disc = 1;
    } else {                                      // the rest uniform over the sphere
      const z = 2 * rng() - 1, ph = rng() * TAU, rr = Math.sqrt(1 - z * z);
      gx = rr * Math.cos(ph); gy = rr * Math.sin(ph); gz = z; disc = 0;
    }
    // galactic -> J2000: transpose of EQ2GAL
    const ex = EQ2GAL[0] * gx + EQ2GAL[3] * gy + EQ2GAL[6] * gz;
    const ey = EQ2GAL[1] * gx + EQ2GAL[4] * gy + EQ2GAL[7] * gz;
    const ez = EQ2GAL[2] * gx + EQ2GAL[5] * gy + EQ2GAL[8] * gz;
    pos[i * 3] = ex * R; pos[i * 3 + 1] = ey * R; pos[i * 3 + 2] = ez * R;
    // magnitude: counts grow ~10^(0.4 m) from V 7.0 to 9.8
    info[i * 3] = 7.0 + Math.log(1 + rng() * span) / kExp;
    info[i * 3 + 1] = rng();
    info[i * 3 + 2] = disc;
    let bv = 0.72 + 0.36 * (rng() + rng() + rng() - 1.5) * 1.4;
    bvColour(bv, LOOK.saturation * 0.85, col, i * 3);
  }
  const starGeo = track(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  starGeo.setAttribute('aStar', new THREE.BufferAttribute(info, 3));
  const starMat = track(new THREE.ShaderMaterial({
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: false, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    uniforms: {
      uPx: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: reduced ? 0 : LOOK.twinkle },
      uGain: { value: LOOK.gain }, uGamma: { value: LOOK.gamma }, uMaxPeak: { value: LOOK.maxPeak },
      uSpike: { value: LOOK.spikes }, uTwilight: { value: 0 }, uExtK: { value: extK }, uGal: { value: gal }, uMW: { value: mwTex },
    },
  }));
  const points = new THREE.Points(starGeo, starMat);
  points.name = 'stars-points';
  points.renderOrder = -90;
  points.frustumCulled = false;
  celestial.add(points);

  // ------------------------------------------------ debug: constellation figures
  let lines = null;
  function setLines(on) {
    if (on && !lines) {
      const n = Math.floor(LINES.length / 4);
      const lp = new Float32Array(n * 6);
      const v = new Float64Array(3), rr = R * 0.998;
      for (let s = 0; s < n; s++) {
        for (let e = 0; e < 2; e++) {
          eqVec(LINES[s * 4 + e * 2] / 10, LINES[s * 4 + e * 2 + 1] / 10, v);
          lp[s * 6 + e * 3] = v[0] * rr; lp[s * 6 + e * 3 + 1] = v[1] * rr; lp[s * 6 + e * 3 + 2] = v[2] * rr;
        }
      }
      const lg = track(new THREE.BufferGeometry());
      lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      const lm = track(new THREE.ShaderMaterial({
        vertexShader: 'varying float vUp; void main() { vUp = (mat3(modelMatrix) * position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying float vUp; void main() { if (vUp < 0.035) discard; gl_FragColor = vec4(0.11, 0.15, 0.22, 1.0); }',
        transparent: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      lines = new THREE.LineSegments(lg, lm);
      lines.name = 'stars-lines';
      lines.renderOrder = -89;
      lines.frustumCulled = false;
      celestial.add(lines);
    }
    if (lines) lines.visible = !!on;
  }
  if (o.lines) setLines(true);

  // ------------------------------------------------ the turning sky
  let date0Run = date0;
  let tStart = null;
  let skyMs = date0;
  let pinned = false, lastHour = null;
  let lst = 0;
  const E = celestial.matrix.elements;
  function place() {
    lst = gmstRad(skyMs) + o.longitudeDeg * D2R;
    skyMatrix(P, lst, lat, facing, M);
    // THREE.Matrix4 is column-major
    E[0] = M[0]; E[1] = M[3]; E[2] = M[6]; E[3] = 0;
    E[4] = M[1]; E[5] = M[4]; E[6] = M[7]; E[7] = 0;
    E[8] = M[2]; E[9] = M[5]; E[10] = M[8]; E[11] = 0;
    const cp = ctx.camera.position;              // the sky sits at infinity: centred on the eye
    E[12] = cp.x; E[13] = cp.y; E[14] = cp.z; E[15] = 1;
    celestial.matrixWorldNeedsUpdate = true;
  }
  place();

  function update(timeSec /* , dtSec */) {
    if (!reduced && !pinned) {
      if (tStart === null) tStart = timeSec;
      skyMs = date0Run + (timeSec - tStart) * 1000 * o.timeScale;
    }
    if (!reduced) starMat.uniforms.uTime.value = timeSec;
    place();
  }

  function resize(width, height) {
    const pr = renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const h = height || (typeof window !== 'undefined' ? window.innerHeight : 1000);
    starMat.uniforms.uPx.value = pr * Math.min(1.3, Math.max(0.8, h / 1000));
  }
  resize(typeof window !== 'undefined' ? window.innerWidth : 1920, typeof window !== 'undefined' ? window.innerHeight : 1000);

  // Helpers for others (the moon): compass alt/az or J2000 RA/Dec -> world direction (unit vector).
  function horizonToWorld(altDeg, azDeg, out = new THREE.Vector3()) {
    const h = altDeg * D2R, rel = azDeg * D2R - facing;
    return out.set(Math.cos(h) * Math.sin(rel), Math.sin(h), -Math.cos(h) * Math.cos(rel));
  }
  function equatorialToWorld(raDeg, decDeg, out = new THREE.Vector3()) {
    eqVec(raDeg, decDeg, tmpA);
    mul3v(M, tmpA[0], tmpA[1], tmpA[2], tmpB);
    return out.set(tmpB[0], tmpB[1], tmpB[2]);
  }

  // tod = { hour, dusk, night, dawn } from the visitor's local clock (dusk + night + dawn = 1).
  function setTimeOfDay(tod) {
    if (!tod) return;
    const tw = Math.max(0, Math.min(1, (+tod.dusk || 0) + (+tod.dawn || 0))) * 0.6;
    starMat.uniforms.uTwilight.value = tw;
    mwMat.uniforms.uGain.value = LOOK.milkyGain * (1 - tw);
    const hour = +tod.hour;
    if (!Number.isFinite(hour)) return;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const local = d.getTime() + hour * 3600e3;
    const target = o.wallClock ? wallClockIn(local, o.timeZone) : local;
    pinned = lastHour !== null && Math.abs(hour - lastHour) < 1e-9;
    lastHour = hour;
    // re-anchor only on a real jump, so the turning sky never stutters (reduced motion: in 15 min steps)
    if (pinned || Math.abs(target - skyMs) > (reduced ? 15 * 60e3 : 60e3)) {
      date0Run = target; skyMs = target; tStart = null;
      place();
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  }

  return {
    group, update, resize, dispose,
    facingAzDeg: facingDeg,
    horizonToWorld, equatorialToWorld, setLines, setTimeOfDay,
    skyTimeMs: () => skyMs,
    debug: { starUniforms: starMat.uniforms, milkyUniforms: mwMat.uniforms, milkyTarget: mwRT },
    lstDeg: () => ((((lst / D2R) % 360) + 360) % 360),
  };
}

export default createStars;
