/*
  Iskry · moon.js — the moon over the fire.
  OWNER: Opus worker "moon". Interface: scratchpad scene-modules-spec.md (+ the moon brief).

  createMoon(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), setTimeOfDay(tod),
                             direction, phase, illumination, placement, sunDirection, radius, distance }
    direction     unit Vector3 toward the moon (world, from the camera). The SAME object is updated
                  in place whenever the moon glides or moves, so others may keep a reference.
    phase         0 new .. 0.25 first quarter .. 0.5 full .. 0.75 last quarter (real, or opts.phase)
    illumination  lit fraction 0..1 of what is shown
    placement     'real' (at its true alt/az) or 'artistic' (the composed spot), see PLACEMENT

  opts {
    date = new Date(),      // first reading of the real sky; then setTimeOfDay(tod) re-reads it
    phase,                  // optional fixed phase (bench, art direction); disables the real sky
    latitudeDeg = 52.2, longitudeDeg = 21.0,   // where the visitor stands (stars.js defaults)
    facingAzDeg = 120,      // compass azimuth of world -z; pass stars.facingAzDeg
    azimuthDeg = 21, altitudeDeg = 18.5,       // the artistic spot, relative to the view (0 = -z, + right)
    angularSizeDeg = 2.2,   // about 4x the real 0.52 deg, for drama
    distance = 80,          // metres; inside the sky dome (90) and the stars (88); camera far is 400
    tiltDeg,                // force lunar north's tilt from screen up (else the real one)
    followRealSky = true, minAltitudeDeg = 12,
    textureHeight = 768,    // baked surface map is (4/3 h) x h; the close-up bench uses 1536
    followCamera = true,    // the moon is at infinity: it keeps its offset from the camera
  }

  PLACEMENT (re-decided on load, on resize and on every setTimeOfDay tick, ~20 s):
    The moon sits at its REAL alt/az (Meeus low-precision ephemeris for the date and the visitor's
    hour, in the compass frame shared with stars.js) whenever that place is well framed: at least
    minAltitudeDeg (12 deg) high, so clear of the treeline and the Tatras (land tops out near 10 deg),
    and inside the frame with a margin of ~1.5 moon diameters + 4 % at the sides and the top.
    Otherwise it hangs at the ARTISTIC spot (upper right, 21 deg right of centre, 18.5 deg up,
    balancing the fire at the lower left; pulled inward on narrow viewports).
    Small moves glide (6 s time constant); a jump of more than 2.5 deg cross-fades (out 1.6 s, in 2.4 s).
    Facing ESE (120 deg) the real moon is framed only for an hour or two on some days (e.g. a
    first-quarter moon low in the SE at dusk, a waning moon rising in the E after midnight), so
    the artistic spot is what most visits see.
    The bright limb always faces the real sun: at the real place it is lit by the real sun
    direction; at the artistic spot it keeps the real elongation (phase) and the real bright-limb
    angle (measured against the local vertical at its true place), except that the limb is kept
    pointing at least a little downward there, because the drawn sky has the sun below the horizon.
    Lunar north is tilted as the real moon's is (ecliptic pole projected at its true place).

  What it draws (2 draw calls, one baked texture):
    1. disc   a real sphere, procedurally textured near side: maria in their places, highlands,
              craters of many sizes with rims, the ray systems of Tycho, Copernicus, Kepler...
              Lit by its OWN sun uniform (no scene light): Lommel-Seeliger with a little Lambert
              (flat full moon, some limb darkening), a soft terminator, bump relief, cast
              shadows near the terminator (a short height-map ray march), earthshine (strong for
              a thin crescent, gone by the quarter).
    2. halo   a camera-facing quad: a tight aureole + a wide faint haze, warmer when low.

  Draw order: both in the OPAQUE pass, additive. disc renderOrder -80 (after the sky dome -100,
  before the land -50, which covers it), depthWrite on while visible, so the stars (transparent
  pass, radius 88, depth-tested) are hidden behind it. halo -79, no depth write. fog off.
  The moon is never placed where land could overlap it (min altitude 12 deg), so its depth never
  wrongly cuts a ridge.

  The surface map is baked ONCE on the GPU at init (~10-25 ms) into a half-float render target
  (albedo, height, d/deast, d/dnorth; mipmapped). No external textures. The bake restores the
  renderer's render target at once; nothing here sets scene.fog, background, tone mapping or
  renderer state. Per frame: a few vector ops, no allocations. reducedMotion: no libration,
  no glide (moves snap; jumps still cross-fade).
*/
import * as THREE from 'three';

const DEFAULTS = {
  date: null,
  phase: undefined,
  azimuthDeg: 21,
  altitudeDeg: 18.5,
  angularSizeDeg: 2.2,
  distance: 80,
  tiltDeg: -14,
  textureHeight: 768,
  followCamera: true,
  eclipticDeg: 32,       // bench / override only: how steeply the bright limb points down
  latitudeDeg: 52.2,     // where the visitor stands (stars.js uses the same defaults: Warsaw)
  longitudeDeg: 21.0,
  facingAzDeg: 120,      // compass azimuth of world -z (stars.js: ESE)
  followRealSky: true,   // use the real alt/az whenever it is well framed
  minAltitudeDeg: 12,    // ... and at least this high (the land tops out near 10 deg)
  relief: 1.4,           // vertical exaggeration of the baked heights
  halo: true,
};

const DEG = Math.PI / 180;
const LON_SPAN = 220 * DEG;   // the baked map covers longitudes -110..110 (the near side + libration)
const H_ENC = 30;             // height (moon radii) -> 0.5 + h * H_ENC
const G_ENC = 0.18;           // slope           -> 0.5 + g * G_ENC
const A_ENC = 1 / 1.6;        // albedo          -> a * A_ENC

// ------------------------------------------------------------ the real phase
// Mean phase from a known new moon (2000-01-06 18:14 UTC) and the synodic month,
// refined with the main periodic terms of the moon's and sun's longitudes (Meeus ch. 47/49),
// good to about an hour.
export function moonPhase(date) {
  const ms = date instanceof Date ? date.getTime() : Date.now();
  const jd = ms / 86400000 + 2440587.5;
  const SYNODIC = 29.530588853;
  const mean = (((jd - 2451550.1) / SYNODIC) % 1 + 1) % 1;
  const T = (jd - 2451545.0) / 36525;
  const M = (357.5291092 + 35999.0502909 * T) * DEG;      // sun mean anomaly
  const Mp = (134.9633964 + 477198.8675055 * T) * DEG;    // moon mean anomaly
  const D = mean * 360 * DEG;                              // mean elongation
  const corr = 6.289 * Math.sin(Mp) - 2.100 * Math.sin(M) + 1.274 * Math.sin(2 * D - Mp)
             + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mp) - 0.020 * Math.sin(2 * M);
  const phase = ((mean + corr / 360) % 1 + 1) % 1;
  return { phase, illumination: (1 - Math.cos(phase * 2 * Math.PI)) / 2, ageDays: phase * SYNODIC };
}

// ------------------------------------------------- the near side, by hand
// Maria: lat, lon (deg), radius (deg of arc), darkness 0..1, basin ring height (moon radii).
// Large irregular ones (Procellarum, Frigoris, Tranquillitatis, Fecunditatis) are several blobs.
const MARIA = [
  // Imbrium and its ring (Apennines, Carpathians, Alps)
  [33.5, -16.5, 17.0, 0.55, 0.0032], [40.0, -24.0, 9.0, 0.55, 0],
  // Serenitatis (lighter middle), Tranquillitatis (darkest), Crisium, Fecunditatis, Nectaris
  [27.5, 17.5, 10.5, 0.45, 0.0022],
  [8.0, 28.0, 9.5, 0.85, 0], [12.0, 37.0, 7.0, 0.85, 0], [3.0, 22.0, 6.0, 0.8, 0], [15.0, 25.0, 5.0, 0.8, 0],
  [17.0, 59.0, 8.6, 0.7, 0.0022],
  [-5.0, 50.5, 8.5, 0.65, 0], [-13.0, 53.0, 6.0, 0.65, 0], [2.0, 55.0, 4.5, 0.6, 0],
  [-15.2, 35.0, 5.4, 0.6, 0.0016],
  // Nubium, Humorum, Cognitum, Insularum, Vaporum, Sinus Medii, Sinus Aestuum
  [-21.0, -16.0, 9.5, 0.3, 0], [-24.4, -38.6, 6.2, 0.65, 0.0016],
  [-10.0, -23.0, 5.5, 0.4, 0], [7.5, -31.0, 8.0, 0.55, 0], [13.3, 4.5, 3.0, 0.3, 0],
  [11.5, -7.0, 2.3, 0.4, 0], [21.0, -1.0, 2.6, 0.3, 0],
  // Oceanus Procellarum: a broad sprawl down the west
  [30.0, -55.0, 12.0, 0.7, 0], [18.0, -58.0, 13.0, 0.7, 0], [5.0, -55.0, 12.0, 0.65, 0],
  [-5.0, -48.0, 10.0, 0.6, 0], [-12.0, -42.0, 6.5, 0.55, 0], [10.0, -70.0, 8.0, 0.6, 0],
  [42.0, -55.0, 9.0, 0.6, 0], [22.0, -44.0, 10.0, 0.7, 0], [52.0, -62.0, 6.0, 0.55, 0],
  [10.0, -42.0, 10.0, 0.65, 0], [33.0, -40.0, 8.0, 0.65, 0], [25.0, -66.0, 10.0, 0.6, 0],
  [-2.0, -38.0, 7.0, 0.55, 0], [16.0, -30.0, 6.0, 0.55, 0],
  // Mare Frigoris: the long thin band in the north
  [57.0, -35.0, 5.0, 0.45, 0], [57.5, -18.0, 5.0, 0.45, 0], [57.0, -2.0, 5.0, 0.45, 0],
  [56.0, 14.0, 4.8, 0.45, 0], [55.0, 30.0, 4.0, 0.45, 0], [60.0, -48.0, 4.0, 0.4, 0],
  // Lacus Somniorum, Mare Vaporum north, the eastern limb (Marginis, Smythii, Australe), Grimaldi floor
  [37.0, 30.0, 4.5, 0.35, 0], [13.0, 86.0, 4.5, 0.5, 0], [1.5, 87.0, 5.5, 0.55, 0],
  [-40.0, 88.0, 6.0, 0.45, 0], [-5.2, -68.6, 2.6, 0.9, 0], [56.8, 81.5, 3.5, 0.5, 0],
];

// Named craters: lat, lon (deg), radius (deg of arc), then
// fresh 0..1 (bright walls and ejecta), rays (length of the ray system, deg of arc; 0 = none),
// floor 0..1 (flat floor fraction), dark floor 0..1 (lava-flooded floors like Plato).
const CRATERS = [
  [-43.3, -11.2, 1.40, 1.0, 34, 0.55, 0],    // Tycho
  [9.6, -20.1, 1.53, 0.85, 17, 0.55, 0],     // Copernicus
  [8.1, -38.0, 0.52, 0.8, 8, 0.2, 0],        // Kepler
  [23.7, -47.4, 0.66, 1.0, 5, 0.3, 0],       // Aristarchus
  [16.1, 46.8, 0.46, 0.8, 7, 0.1, 0],        // Proclus
  [51.6, -9.4, 1.67, 0.0, 0, 0.85, 0.75],    // Plato
  [29.7, -4.0, 1.34, 0.1, 0, 0.85, 0.35],    // Archimedes
  [-58.4, -14.4, 3.70, 0.0, 0, 0.8, 0],      // Clavius
  [-9.3, -1.9, 2.52, 0.0, 0, 0.85, 0.2],     // Ptolemaeus
  [-13.4, -3.2, 1.78, 0.1, 0, 0.6, 0],       // Alphonsus
  [-18.2, -1.9, 1.58, 0.2, 0, 0.5, 0],       // Arzachel
  [-11.4, 26.4, 1.65, 0.45, 0, 0.45, 0],     // Theophilus
  [-13.2, 24.0, 1.62, 0.05, 0, 0.6, 0],      // Cyrillus
  [-18.1, 23.6, 1.65, 0.0, 0, 0.65, 0],      // Catharina
  [-8.9, 61.1, 2.18, 0.4, 0, 0.5, 0],        // Langrenus
  [-25.1, 60.4, 2.92, 0.15, 0, 0.6, 0],      // Petavius
  [14.5, -11.3, 0.96, 0.3, 0, 0.35, 0],      // Eratosthenes
  [50.2, 17.4, 1.43, 0.25, 0, 0.5, 0],       // Aristoteles
  [44.3, 16.3, 1.10, 0.25, 0, 0.4, 0],       // Eudoxus
  [31.8, 29.9, 1.57, 0.0, 0, 0.8, 0.1],      // Posidonius
  [-50.0, -6.2, 3.20, 0.0, 0, 0.75, 0],      // Maginus
  [-49.6, -21.7, 2.40, 0.0, 0, 0.7, 0],      // Longomontanus
  [-44.3, -54.6, 3.40, 0.0, 0, 0.85, 0.3],   // Schickard
  [-5.1, 5.2, 2.28, 0.0, 0, 0.8, 0],         // Hipparchus
  [-11.2, 4.0, 1.88, 0.0, 0, 0.7, 0],        // Albategnius
  [-33.1, 1.0, 2.10, 0.0, 0, 0.75, 0],       // Walther
  [-36.0, 60.6, 2.06, 0.0, 0, 0.7, 0],       // Furnerius
  [-17.5, -40.1, 1.80, 0.05, 0, 0.75, 0.15], // Gassendi
  [-20.7, -22.2, 1.00, 0.4, 0, 0.35, 0],     // Bullialdus
  [14.5, 9.1, 0.64, 0.7, 2.5, 0.2, 0],       // Manilius
  [16.3, 16.0, 0.45, 0.8, 2.5, 0.1, 0],      // Menelaus
  [-41.1, 6.0, 2.08, 0.0, 0, 0.8, 0],        // Stoefler
  [-44.9, 41.0, 3.30, 0.0, 0, 0.7, 0],       // Janssen
  [-41.8, 14.0, 1.88, 0.0, 0, 0.6, 0],       // Maurolycus
  [-29.7, 32.2, 1.45, 0.15, 0, 0.5, 0],      // Piccolomini
  [27.6, 55.5, 2.06, 0.0, 0, 0.75, 0.2],     // Cleomedes
  [53.9, 57.0, 2.03, 0.0, 0, 0.8, 0.6],      // Endymion
  [46.7, 44.4, 1.43, 0.1, 0, 0.6, 0],        // Atlas
  [46.7, 39.1, 1.14, 0.1, 0, 0.55, 0.2],     // Hercules
  [63.5, -63.0, 2.40, 0.05, 0, 0.6, 0],      // Pythagoras
  [-5.2, -68.6, 2.85, 0.0, 0, 0.9, 0.5],     // Grimaldi
  [-0.3, -1.4, 0.30, 0.6, 0, 0.1, 0],        // a few small bright ones in Sinus Medii
  [-21.0, -6.0, 0.35, 0.9, 3, 0.1, 0],       // (Birt-like) small rayed
  [21.0, 40.0, 0.25, 0.9, 2, 0.1, 0],
  [-31.0, -38.0, 0.30, 0.9, 3, 0.1, 0],
];

// --------------------------------------------------------------- GLSL bits
const GLSL_NOISE = /* glsl */ `
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x);
    float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
    float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x);
    float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
  }
  float fbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s / 0.96875;
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Pass 1: albedo, height (moon radii) and nothing else, per (lon, lat) texel of the near side.
const BAKE_FRAG = /* glsl */ `
  precision highp float;
  #define NM ${MARIA.length}
  #define NC ${CRATERS.length}
  #define PI 3.14159265
  varying vec2 vUv;
  uniform vec4 uMaria[NM];   // lat, lon, radius (rad), darkness
  uniform float uRing[NM];   // basin ring height
  uniform vec4 uCrA[NC];     // lat, lon, radius (rad), fresh
  uniform vec4 uCrB[NC];     // rays (rad), floor, dark floor, seed
  uniform float uLonSpan, uTexel;
  ${GLSL_NOISE}

  vec3 dirOf(float lat, float lon) { return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)); }

  // Crater profile in radii rho: bowl (with an optional flat floor), sharp raised rim,
  // ejecta apron falling off outside. Returns height in units of the crater's depth.
  float profile(float rho, float flatFloor, float rimK) {
    if (rho < 1.0) {
      float bowl = rho * rho - 1.0;
      float fl = -1.0 + flatFloor;                    // floor level
      float k = 0.12;                                 // smooth max with the floor
      float hh = clamp(0.5 + 0.5 * (bowl - fl) / k, 0.0, 1.0);
      bowl = mix(fl, bowl, hh) + k * hh * (1.0 - hh);
      return bowl + rimK * pow(rho, 4.0);
    }
    float e = rho - 1.0;
    return rimK * exp(-e * 3.2) * (1.0 - smoothstep(1.0, 1.6, e));
  }

  void main() {
    float lon = (vUv.x - 0.5) * uLonSpan;
    float lat = (vUv.y - 0.5) * PI;
    vec3 p = dirOf(lat, lon);

    // ---- maria: metaballs (so neighbours merge into one sea), a warped domain, a noisy threshold
    vec3 pw = normalize(p + 0.07 * (vec3(fbm(p * 3.0 + 1.0), fbm(p * 3.0 + 7.0), fbm(p * 3.0 + 13.0)) - 0.5));
    pw = normalize(pw + 0.045 * (vec3(fbm(p * 7.0 + 2.0), fbm(p * 7.0 + 5.0), fbm(p * 7.0 + 9.0)) - 0.5));
    pw = normalize(pw + 0.02 * (vec3(vnoise(p * 19.0 + 2.0), vnoise(p * 19.0 + 5.0), vnoise(p * 19.0 + 9.0)) - 0.5));
    float edgeN = fbm(p * 6.0 + 3.0) - 0.5;
    float edgeN2 = fbm(p * 17.0 + 11.0) - 0.5;
    float edgeN3 = vnoise(p * 55.0 + 5.0) - 0.5;
    float field = 0.0, fmax = 0.0, darkSum = 0.0, wSum = 0.0, ring = 0.0;
    float nRel = edgeN * 0.62 + edgeN2 * 0.30 + edgeN3 * 0.07;
    for (int i = 0; i < NM; i++) {
      vec4 m = uMaria[i];
      vec3 c = dirOf(m.x, m.y);
      float d0 = acos(clamp(dot(pw, c), -1.0, 1.0)) / m.z;
      float d = max(d0 + nRel * mix(1.0, 0.6, smoothstep(4.0, 12.0, m.z * 57.3)), 0.0);
      float d2 = d * d;
      float k = 1.0 / (1.0 + d2 * d2 * d2 * d2);       // 0.5 at the nominal radius
      field += k; fmax = max(fmax, k);
      darkSum += k * m.w; wSum += k;
      if (uRing[i] > 0.0) {
        float rr = (d0 - 1.08) / 0.11;
        float mtn = fbm(p * 42.0 + float(i)) ;
        ring += uRing[i] * exp(-rr * rr) * smoothstep(0.35, 0.75, mtn) * (0.6 + 0.8 * mtn);
      }
    }
    float dark = wSum > 0.0 ? darkSum / wSum : 0.0;
    field = fmax + 0.25 * (field - fmax);                // neighbours merge a little, not into one ocean
    float shore = 0.36 * (fbm(p * 30.0 + 21.0) - 0.5) + 0.2 * (vnoise(p * 95.0 + 3.0) - 0.5);
    float mare = smoothstep(0.2, 0.74, field + shore);

    // ---- base terrain: rolling highlands, flat maria a little lower with faint wrinkle ridges
    float hl = (fbm(p * 5.0) - 0.5) * 0.0050 + (fbm(p * 23.0 + 5.0) - 0.5) * 0.0026 + (vnoise(p * 90.0) - 0.5) * 0.0005;
    float wr = 1.0 - abs(fbm(p * 14.0 + 2.0) * 2.0 - 1.0);
    float mh = -0.0012 + 0.00016 * pow(wr, 3.0) + (vnoise(p * 60.0) - 0.5) * 0.00008;
    float h = mix(hl, mh, mare) + ring * (1.0 - mare * 0.85);

    // ---- albedo: highlands bright and mottled, maria dark and varied
    float aHigh = 0.95 + 0.36 * (fbm(p * 4.0 + 1.7) - 0.5) + 0.22 * (fbm(p * 16.0 + 4.0) - 0.5) + 0.10 * (vnoise(p * 90.0) - 0.5);
    aHigh *= 1.0 - 0.18 * smoothstep(0.15, 0.4, field) * (1.0 - mare);   // darker 'mantled' shores
    float flows = (fbm(p * 3.5 + 8.0) - 0.5) + 0.6 * (fbm(p * 9.0 + 4.0) - 0.5);   // lava flows of different ages
    float aMare = mix(0.56, 0.28, clamp(dark + flows * 1.6, 0.0, 1.0))
                * (0.9 + 0.34 * (fbm(p * 22.0 + 2.0) - 0.5) + 0.08 * (vnoise(p * 80.0) - 0.5));
    // a darker rim just inside the shore (as round Serenitatis and Crisium show)
    aMare *= 1.0 - 0.12 * smoothstep(0.55, 0.75, mare) * (1.0 - smoothstep(0.85, 1.6, field));
    float alb = mix(aHigh, aMare, mare);

    // ---- random craters, seven octaves, in 3D cells on the sphere (no seam, no pinching)
    float freq = 8.0;
    for (int o = 0; o < 8; o++) {
      float cellR = 1.0 / freq;
      if (cellR * 0.3 < uTexel * 1.6) break;          // smaller than the map can show
      // big old craters are buried in the maria; small young ones are everywhere
      float dens = mix(0.5, 0.95, float(o) / 7.0);
      float inMare = mix(0.04, 0.4, float(o) / 7.0);
      vec3 q = p * freq;
      vec3 b = floor(q);
      for (int z = -1; z <= 1; z++)
      for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 cell = b + vec3(float(x), float(y), float(z));
        vec3 r3 = hash33(cell + float(o) * 19.3);
        vec3 cc = cell + r3;
        float lc = length(cc);
        if (abs(lc - freq) > 0.5) continue;            // keep only cells in a one-cell shell
        float pick = hash13(cell * 1.37 + float(o) * 7.7);
        if (pick > dens * mix(1.0, inMare, mare)) continue;
        vec3 cd = cc / lc;
        float rad = cellR * mix(0.10, 0.36, pow(hash13(cell + 41.0 + float(o)), 1.6));
        float dd = length(p - cd);
        float rho = dd / rad;
        if (rho > 2.6) continue;
        float fresh = pow(hash13(cell * 2.1 + 3.3), 14.0);
        float age = pow(hash13(cell * 3.7 + 9.1), 2.5);  // 1 young and crisp, 0 old and worn
        // depth / radius: ~0.4 for small bowls, shallower for big complex craters; most are worn down
        float dr = mix(0.28, 0.12, smoothstep(0.002, 0.03, rad)) * mix(0.12, 1.0, age);
        float fl = mix(0.0, 0.55, smoothstep(0.006, 0.03, rad));
        float soft = mix(1.6, 1.0, age);                 // worn rims are broad and low
        h += rad * dr * profile(pow(rho, 1.0 / soft), fl, mix(0.06, 0.28, age));
        // fresh craters: bright walls and a bright apron
        alb += fresh * 0.55 * (1.0 - smoothstep(0.3, 2.2, rho));
      }
      freq *= 1.72;
    }

    // ---- named craters on top (they are younger than the maria they sit in)
    float rays = 0.0;
    for (int i = 0; i < NC; i++) {
      vec4 a = uCrA[i]; vec4 bb = uCrB[i];
      vec3 c = dirOf(a.x, a.y);
      float d = acos(clamp(dot(p, c), -1.0, 1.0));
      float rho = d / a.z;
      if (rho < 2.8) {
        float dr = mix(0.13, 0.09, smoothstep(0.02, 0.05, a.z)) * mix(0.55, 1.0, a.w);
        float pr = profile(rho, bb.y, mix(0.16, 0.32, a.w));
        float peak = (1.0 - bb.z) * 0.32 * exp(-rho * rho * 30.0) * smoothstep(0.012, 0.02, a.z);
        float rough = 0.35 * (fbm(p * 400.0 + float(i)) - 0.5) * (1.0 - smoothstep(0.9, 2.0, rho));
        h += a.z * dr * (pr + peak + rough * mix(0.3, 1.0, a.w));
        float floorM = 1.0 - smoothstep(0.75 * bb.y, 0.95, rho);
        alb = mix(alb, mix(alb, 0.42, bb.z), floorM);
        alb += a.w * 0.7 * (1.0 - smoothstep(0.8, 2.2, rho));
      }
      if (bb.x > 0.0 && d < bb.x * 3.0) {
        // ray system: sparse streaks in angle, broken along their length, fading with distance
        vec3 e1 = normalize(cross(vec3(0.0, 1.0, 0.0), c));
        vec3 e2 = cross(c, e1);
        float ang = atan(dot(p, e2), dot(p, e1));
        // rays wander and feather as they run out
        ang += 0.22 * (vnoise(vec3(d * 7.0 / max(bb.x, 0.02), ang * 3.0, bb.w)) - 0.5) * smoothstep(0.0, bb.x * 0.6, d);
        vec2 a2 = vec2(cos(ang), sin(ang));
        float s1 = pow(vnoise(vec3(a2 * 6.0, bb.w)), 3.5);
        float s2 = pow(vnoise(vec3(a2 * 17.0, bb.w + 5.0)), 5.0);
        float along = 0.35 + 0.85 * fbm(vec3(a2 * 9.0, d * 9.0 / max(bb.x, 0.02) + bb.w));
        float fall = exp(-d / (bb.x * 0.5)) * smoothstep(a.z * 0.9, a.z * 2.4, d);
        float nimbus = exp(-max(d - a.z, 0.0) / (a.z * 1.4)) * smoothstep(a.z * 0.8, a.z * 1.2, d);
        rays += (s1 * 0.9 + s2 * 0.8) * along * fall * 1.2 + nimbus * 0.35 * a.w;
      }
    }
    alb += rays * mix(0.7, 1.0, mare);
    alb = clamp(alb, 0.12, 1.55);

    gl_FragColor = vec4(alb * ${A_ENC.toFixed(6)}, 0.5 + h * ${H_ENC.toFixed(1)}, 0.0, 1.0);
  }
`;

// Pass 2: slopes (d height / d arc, east and north) next to albedo and height.
const SLOPE_FRAG = /* glsl */ `
  precision highp float;
  #define PI 3.14159265
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform vec2 uPx;          // one texel in uv
  uniform float uLonSpan;
  float H(vec2 uv) { return (texture2D(uSrc, uv).g - 0.5) / ${H_ENC.toFixed(1)}; }
  void main() {
    vec4 s = texture2D(uSrc, vUv);
    float lat = (vUv.y - 0.5) * PI;
    float cl = max(cos(lat), 0.04);
    float gE = (H(vUv + vec2(uPx.x, 0.0)) - H(vUv - vec2(uPx.x, 0.0))) / (2.0 * uPx.x * uLonSpan * cl);
    float gN = (H(vUv + vec2(0.0, uPx.y)) - H(vUv - vec2(0.0, uPx.y))) / (2.0 * uPx.y * PI);
    gl_FragColor = vec4(s.r, s.g, 0.5 + gE * ${G_ENC.toFixed(3)}, 0.5 + gN * ${G_ENC.toFixed(3)});
  }
`;

// ----------------------------------------------------------- the moon itself
const MOON_VERT = /* glsl */ `
  varying vec3 vN;
  void main() {
    vN = normal;                                    // object space: the moon's own frame
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MOON_FRAG = /* glsl */ `
  precision highp float;
  #define PI 3.14159265
  varying vec3 vN;
  uniform sampler2D uMap;
  uniform vec3 uSun, uView;          // unit vectors in the moon's frame
  uniform vec3 uTint, uEarthTint;
  uniform float uGain, uEarth, uLonSpan, uRelief, uStep, uDebug, uFade;
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    vec3 n = normalize(vN);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(n.x, n.z);
    vec2 uv = vec2(lon / uLonSpan + 0.5, lat / PI + 0.5);
    vec4 t = texture2D(uMap, uv);
    float alb = t.r / ${A_ENC.toFixed(6)};
    float h = (t.g - 0.5) / ${H_ENC.toFixed(1)} * uRelief;
    vec2 g = (t.ba - 0.5) / ${G_ENC.toFixed(3)} * uRelief;

    float cl = max(length(vec2(n.x, n.z)), 0.04);
    vec3 E = vec3(n.z, 0.0, -n.x) / cl;            // east
    vec3 No = cross(n, E);                          // north
    vec3 nb = normalize(n - g.x * E - g.y * No);

    float mu0g = dot(n, uSun);                      // geometric sun height
    float mu0 = max(dot(nb, uSun), 0.0);
    float mu = max(dot(n, uView), 0.03);
    // Lommel-Seeliger (the flat, bright full moon) with a little Lambert (limb darkening)
    float ls = mu0 / (mu0 + mu + 1e-4);
    float lit = mix(2.0 * ls, mu0, 0.35);

    // cast shadows: march toward the sun over the height map, near the terminator only.
    // Gradients are taken here, outside the branch, so the mip choice stays sane at its edge.
    vec2 gdx = dFdx(uv), gdy = dFdy(uv);
    float shadow = 1.0;
    if (mu0g > -0.09 && mu0g < 0.32) {
      vec3 sT = uSun - n * mu0g;
      float sl = length(sT);
      vec2 duv = vec2(dot(sT, E) / (cl * uLonSpan), dot(sT, No) / PI) / max(sl, 1e-4);
      float tanA = mu0g / max(sl, 1e-4);
      for (int k = 1; k <= 14; k++) {
        float fk = float(k);
        float s = uStep * fk * (1.0 + 0.22 * fk);
        float hs = (textureGrad(uMap, uv + duv * s, gdx, gdy).g - 0.5) / ${H_ENC.toFixed(1)} * uRelief;
        float ray = h + s * tanA + 0.5 * s * s;     // the sphere falls away under the ray
        float soft = 0.0002 + 0.0047 * s;           // the sun is half a degree wide
        shadow = min(shadow, smoothstep(-soft, soft, ray - hs));
      }
    }
    float term = smoothstep(-0.035, 0.012, mu0g);   // peaks catch a little light past the terminator
    float day = lit * shadow * term;

    // maria a touch cooler, highlands a touch warmer: still one warm ivory
    vec3 tint = uTint * mix(vec3(0.94, 0.97, 1.03), vec3(1.02, 1.0, 0.97), smoothstep(0.45, 0.95, alb));
    vec3 col = tint * uGain * alb * day;
    col += uEarthTint * uEarth * alb * (1.0 - smoothstep(-0.05, 0.1, mu0g) * 0.7);

    if (uDebug > 0.5) col = uDebug < 1.5 ? vec3(alb * 0.5) : uDebug < 2.5 ? vec3(0.5 + h * 60.0) : uDebug < 3.5 ? vec3(0.5 + g * 0.5, 0.5) : uDebug < 4.5 ? vec3(day * 0.5) : uDebug < 5.5 ? vec3(lit * 0.5) : uDebug < 6.5 ? vec3(shadow * 0.5) : uDebug < 7.5 ? vec3(term * 0.5) : uDebug < 8.5 ? n * 0.5 + 0.5 : vec3(0.5 + 0.5 * mu0g);
    // a hair of dither so the faint earthshine never bands
    col = col * uFade + (hash12(gl_FragCoord.xy) - 0.5) / 900.0 * uFade;
    float a = clamp(dot(col, vec3(0.3, 0.5, 0.2)) * 3.0, 0.0, 1.0);
    gl_FragColor = linearToOutputTexel(vec4(max(col, 0.0), a));
  }
`;

const HALO_VERT = /* glsl */ `
  varying vec2 vP;
  uniform float uScale;   // quad half-size in moon radii
  void main() {
    vP = (uv - 0.5) * 2.0 * uScale;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const HALO_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vP;
  uniform vec3 uCol, uWarm;
  uniform float uTight, uWide, uScale;
  uniform vec2 uDown;      // screen-ish "toward the horizon" in quad space
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    float r = length(vP);
    float e = max(r - 1.0, 0.0);
    // the aureole is scattering in our own air, so it lies over the disc too (continuous at the limb)
    float tight = exp(-e * 2.6) * uTight;
    float wide = exp(-r * 0.42) * uWide;
    float edge = 1.0 - smoothstep(uScale * 0.7, uScale, r);
    // warmer and a little denser toward the horizon
    float down = clamp(dot(vP / max(r, 1e-3), uDown) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uCol, uWarm, down * 0.6) * (tight + wide * (0.8 + 0.4 * down)) * edge;
    // dither in output space, so the faint glow never rings
    vec4 o = linearToOutputTexel(vec4(col, 1.0));
    float d = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.13) - 1.0;
    o.rgb = max(o.rgb + d / 255.0 * step(0.0005, tight + wide), 0.0);
    gl_FragColor = vec4(o.rgb, 0.0);
  }
`;

function colorFrom(ctx, token, fallback) {
  let v = fallback;
  try { if (ctx && typeof ctx.readToken === 'function') v = ctx.readToken(token, fallback); } catch (e) { /* use fallback */ }
  if (v === undefined || v === null || v === '') v = fallback;
  const c = new THREE.Color();
  try { c.set(typeof v === 'string' ? v.trim() : v); } catch (e) { c.set(fallback); }
  return c;
}

// --------------------------------------------------------------- the bake
function bakeSurface(renderer, height) {
  const w = Math.round(height * 4 / 3), h = height;
  const caps = renderer.capabilities;
  const ext = renderer.extensions;
  const half = caps.isWebGL2 !== false && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
  const type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const rt1 = new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  const rt2 = new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
  });
  rt1.texture.wrapS = rt1.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt2.texture.wrapS = rt2.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt2.texture.anisotropy = Math.min(4, caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1);

  const maria = MARIA.map((m) => new THREE.Vector4(m[0] * DEG, m[1] * DEG, m[2] * DEG, m[3]));
  const ring = MARIA.map((m) => m[4]);
  const crA = CRATERS.map((c) => new THREE.Vector4(c[0] * DEG, c[1] * DEG, c[2] * DEG, c[3]));
  const crB = CRATERS.map((c, i) => new THREE.Vector4(c[4] * DEG, c[5], c[6], 3.7 + i * 1.913));

  const geo = new THREE.PlaneGeometry(2, 2);
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uMaria: { value: maria }, uRing: { value: ring }, uCrA: { value: crA }, uCrB: { value: crB },
      uLonSpan: { value: LON_SPAN }, uTexel: { value: Math.PI / h },
    },
  });
  const slopeMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: SLOPE_FRAG, depthTest: false, depthWrite: false,
    uniforms: { uSrc: { value: rt1.texture }, uPx: { value: new THREE.Vector2(1 / w, 1 / h) }, uLonSpan: { value: LON_SPAN } },
  });
  const quad = new THREE.Mesh(geo, bakeMat);
  quad.frustumCulled = false;
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const cam = new THREE.Camera();

  const prevTarget = renderer.getRenderTarget();
  const prevXR = renderer.xr ? renderer.xr.enabled : false;
  if (renderer.xr) renderer.xr.enabled = false;
  try {
    renderer.setRenderTarget(rt1);
    renderer.render(bakeScene, cam);
    quad.material = slopeMat;
    renderer.setRenderTarget(rt2);
    renderer.render(bakeScene, cam);
  } finally {
    renderer.setRenderTarget(prevTarget);
    if (renderer.xr) renderer.xr.enabled = prevXR;
  }
  geo.dispose(); bakeMat.dispose(); slopeMat.dispose(); rt1.dispose();
  return { target: rt2, width: w, height: h };
}

// ------------------------------------------------------- where things are
// Low-precision sun and moon positions (Meeus, ch. 25/47 main terms; ~0.3 deg), and the
// ecliptic north pole (≈ the moon's spin axis), as horizon alt/az in radians (az from north, east +).
function eclToHor(lam, bet, eps, lst, lat, out) {
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
  const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
  return eqToHor(ra, dec, lst, lat, out);
}
function eqToHor(ra, dec, lst, lat, out) {
  const H = lst - ra;
  out.alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  out.az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.cos(H) * Math.sin(lat));
  return out;
}
export function skyPositions(date, latitudeDeg, longitudeDeg) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0, T = d / 36525;
  const r = (x) => (x % 360) * DEG;
  const M = r(357.5291092 + 35999.0502909 * T);
  const lamS = r(280.46646 + 36000.76983 * T) + (1.914602 * Math.sin(M) + 0.019993 * Math.sin(2 * M)) * DEG;
  const Lp = r(218.3164477 + 481267.88123421 * T);
  const D = r(297.8501921 + 445267.1114034 * T);
  const Mp = r(134.9633964 + 477198.8675055 * T);
  const F = r(93.2720950 + 483202.0175233 * T);
  const lamM = Lp + (6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp) + 0.658 * Math.sin(2 * D)
             + 0.214 * Math.sin(2 * Mp) - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F)) * DEG;
  const betM = (5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F) + 0.278 * Math.sin(Mp - F) + 0.173 * Math.sin(2 * D - F)) * DEG;
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  const lst = r(280.46061837 + 360.98564736629 * d + longitudeDeg);
  const lat = latitudeDeg * DEG;
  const sun = eclToHor(lamS, 0, eps, lst, lat, {});
  const moon = eclToHor(lamM, betM, eps, lst, lat, {});
  moon.alt -= 0.95 * DEG * Math.cos(moon.alt);                 // parallax: the moon is near
  const pole = eqToHor(-Math.PI / 2, Math.PI / 2 - eps, lst, lat, {});
  return { sun, moon, pole };
}

// ------------------------------------------------------------- the module
export function createMoon(ctx, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const reduced = !!(ctx && ctx.reducedMotion);
  let override = Number.isFinite(o.phase);
  const tiltFixed = Number.isFinite(opts && opts.tiltDeg);

  const group = new THREE.Group();
  group.name = 'moon';
  ctx.scene.add(group);

  const D = o.distance;
  const R = D * Math.tan((o.angularSizeDeg * DEG) / 2);
  const UP = new THREE.Vector3(0, 1, 0);

  // compass frame shared with stars.js: world -z faces azimuth `facingAzDeg`
  const facing = o.facingAzDeg * DEG;
  const horToWorld = (alt, az, out) => {
    const a = az - facing;
    return out.set(Math.sin(a) * Math.cos(alt), Math.sin(alt), -Math.cos(a) * Math.cos(alt));
  };
  // screen-relative direction (0 = straight ahead, + = right), for the artistic spot
  const viewToWorld = (altDeg, azDeg, out) => {
    const a = azDeg * DEG, e = altDeg * DEG;
    return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
  };
  // the screen basis at a direction: right, up (as the viewer sees it)
  const basis = (dir, right, up) => {
    right.crossVectors(UP, up.copy(dir).negate()).normalize();
    up.crossVectors(tmpZ.copy(dir).negate(), right);
  };
  const tmpZ = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

  // ---------------------------------------------------------------- state
  // what the real sky says (recomputed by setTimeOfDay), and what is shown
  const sky = {
    phase: 0, illum: 0, elong: 0,   // elongation 0..PI
    lx: 1, ly: -0.5, tilt: 0,       // bright-limb direction and lunar-north tilt, in the moon's screen frame
    real: new THREE.Vector3(), realAlt: -1, ok: false,
  };
  const target = { dir: new THREE.Vector3(), placement: 'artistic' };
  const cur = { dir: new THREE.Vector3(), lx: 1, ly: -0.5, tilt: 0, elong: 0, illum: 0 };
  let fade = 1, swapping = false;
  const pend = { lx: 1, ly: -0.5, tilt: 0, elong: 0, illum: 0 };

  const direction = cur.dir;                    // shared with the handle; updated in place
  const sunWorld = new THREE.Vector3();
  const viewWorld = new THREE.Vector3();
  const xL = new THREE.Vector3(), yL = new THREE.Vector3(), zL = new THREE.Vector3();
  const xT = new THREE.Vector3(), yT = new THREE.Vector3();
  const mBasis = new THREE.Matrix4();
  const qBase = new THREE.Quaternion();

  function readSky(date) {
    const ph = moonPhase(date);
    sky.phase = override ? ((o.phase % 1) + 1) % 1 : ph.phase;
    sky.elong = sky.phase <= 0.5 ? sky.phase * 2 * Math.PI : (1 - sky.phase) * 2 * Math.PI;
    sky.illum = (1 - Math.cos(sky.elong)) / 2;
    if (override) {
      // the bench: the set sun lower right while waxing, lower left while waning
      const beta = o.eclipticDeg * DEG;
      sky.lx = (sky.phase <= 0.5 ? 1 : -1) * Math.cos(beta); sky.ly = -Math.sin(beta);
      sky.tilt = (tiltFixed ? o.tiltDeg : DEFAULTS.tiltDeg) * DEG;
      sky.ok = false;
      return;
    }
    const pos = skyPositions(date, o.latitudeDeg, o.longitudeDeg);
    horToWorld(pos.moon.alt, pos.moon.az, sky.real);
    sky.realAlt = pos.moon.alt;
    // bright limb: toward the real sun, measured in the real moon's own screen frame
    basis(sky.real, xL, yL);
    horToWorld(pos.sun.alt, pos.sun.az, tmpA);
    tmpA.addScaledVector(sky.real, -tmpA.dot(sky.real));
    if (tmpA.lengthSq() < 1e-10) tmpA.copy(xL);
    tmpA.normalize();
    sky.lx = tmpA.dot(xL); sky.ly = tmpA.dot(yL);
    // lunar north ≈ the ecliptic pole, projected at the moon
    horToWorld(pos.pole.alt, pos.pole.az, tmpB);
    tmpB.addScaledVector(sky.real, -tmpB.dot(sky.real));
    sky.tilt = tiltFixed ? o.tiltDeg * DEG : Math.atan2(-tmpB.dot(xL), tmpB.dot(yL));
    sky.ok = true;
  }

  // Is a direction a good place to show the moon? On screen with a margin, clear of the
  // treeline and the Tatras (land tops out near 10 deg), below the top edge.
  const camQInv = new THREE.Quaternion();
  let aspect = 16 / 9;
  function framed(dir) {
    const cam = ctx.camera;
    if (!cam || !cam.isPerspectiveCamera) return false;
    if (Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) < o.minAltitudeDeg * DEG) return false;
    camQInv.copy(cam.quaternion).invert();
    tmpA.copy(dir).applyQuaternion(camQInv);
    if (tmpA.z > -0.1) return false;
    const ty = Math.tan((cam.fov * DEG) / 2), tx = ty * (aspect || cam.aspect || 1);
    const x = tmpA.x / -tmpA.z / tx, y = tmpA.y / -tmpA.z / ty;
    const rr = Math.tan((o.angularSizeDeg * DEG) / 2);
    return Math.abs(x) < 1 - (rr * 3) / tx - 0.04 && y < 1 - (rr * 3) / ty - 0.04;
  }

  // the artistic spot: composed with the fire (left of centre) and the treeline; kept inside
  // narrow viewports too
  function artisticDir(out) {
    const cam = ctx.camera;
    let az = o.azimuthDeg;
    if (cam && cam.isPerspectiveCamera) {
      const half = Math.atan(Math.tan((cam.fov * DEG) / 2) * (aspect || cam.aspect || 1)) / DEG;
      az = Math.sign(az) * Math.min(Math.abs(az), Math.max(0, half - o.angularSizeDeg * 2 - 4));
    }
    return viewToWorld(o.altitudeDeg, az, out);
  }

  // choose: the real place when it is well framed, else the artistic spot (see the header)
  function retarget(instant) {
    const realOK = sky.ok && o.followRealSky && framed(sky.real);
    if (realOK) { target.dir.copy(sky.real); target.placement = 'real'; } else { artisticDir(target.dir); target.placement = 'artistic'; }
    handle.placement = target.placement;
    pend.elong = sky.elong; pend.illum = sky.illum; pend.tilt = sky.tilt;
    pend.lx = sky.lx; pend.ly = sky.ly;
    if (!realOK) {
      // off its real place the drawn sky has the sun below the horizon: keep the lit limb low
      pend.ly = Math.min(pend.ly, -0.25);
      if (Math.abs(pend.lx) < 0.05) pend.lx = sky.phase <= 0.5 ? 0.05 : -0.05;
      const n = Math.hypot(pend.lx, pend.ly); pend.lx /= n; pend.ly /= n;
    }
    const far = cur.dir.lengthSq() < 0.5 || cur.dir.angleTo(target.dir) > 2.5 * DEG;
    if (instant || cur.dir.lengthSq() < 0.5) {
      cur.dir.copy(target.dir); commit(); fade = 1; swapping = false;
    } else if (far) {
      swapping = true;                         // fade out here, fade in there
    } else {
      commit();                                // tiny steps: glide (or snap under reduced motion)
      if (reduced) cur.dir.copy(target.dir);
    }
  }
  function commit() {
    cur.elong = pend.elong; cur.illum = pend.illum; cur.tilt = pend.tilt; cur.lx = pend.lx; cur.ly = pend.ly;
    handle.phase = sky.phase; handle.illumination = cur.illum;
    moonMat.uniforms.uEarth.value = earthFor(cur.illum);
    if (haloMat) setHalo(cur.illum);
  }

  // colour: warm ivory from the cream token, warmer and dimmer when low (extinction)
  const cream = colorFrom(ctx, '--cream', '#f4e6d0');
  const fireCore = colorFrom(ctx, '--fire-core', '#ffb45a');
  const ivory = cream.clone().lerp(new THREE.Color('#fff3df'), 0.25);
  const haloBase = cream.clone();
  let low = 0;
  // earthshine: the earth seen from the moon is nearly full when the moon is a thin crescent
  const earthFor = (k) => 0.0003 + 0.011 * Math.pow(1 - k, 3.0);

  // ---- surface map (once)
  const baked = bakeSurface(ctx.renderer, Math.max(256, Math.min(2048, Math.round(o.textureHeight))));

  const moonMat = new THREE.ShaderMaterial({
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    transparent: false,                // opaque pass, after the dome; the land (later) covers it
    depthTest: true,
    depthWrite: true,                  // so the stars (transparent pass, r = 88) are hidden behind it
    fog: false,
    toneMapped: false,
    uniforms: {
      uMap: { value: baked.target.texture },
      uSun: { value: new THREE.Vector3() },
      uView: { value: new THREE.Vector3() },
      uTint: { value: ivory.clone() },
      uEarthTint: { value: cream.clone().lerp(new THREE.Color('#c9cfd6'), 0.35) },
      uGain: { value: 0.66 },
      uEarth: { value: 0 },
      uFade: { value: 1 },
      uLonSpan: { value: LON_SPAN },
      uRelief: { value: o.relief },
      uStep: { value: (Math.PI / baked.height) * 1.1 },
      uDebug: { value: 0 },          // bench only: 1 albedo, 2 height, 3 slopes, 4 lighting
    },
  });
  const moonGeo = new THREE.SphereGeometry(R, 96, 64);
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.name = 'moon-disc';
  moon.renderOrder = -80;              // after the sky dome (-100), before the land (-50)
  moon.frustumCulled = false;
  group.add(moon);

  // ---- halo: tight aureole + wide haze, scaled by how much of the moon is lit
  let haloMat = null, haloGeo = null, halo = null, setHalo = null;
  const haloK = { tight: 0, wide: 0 };
  if (o.halo) {
    const scale = 12;                   // quad half-size in moon radii
    haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: false,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCol: { value: haloBase },
        uWarm: { value: fireCore.clone().lerp(colorFrom(ctx, '--fire', '#f0842c'), 0.5) },
        uTight: { value: 0 },
        uWide: { value: 0 },
        uScale: { value: scale },
        uDown: { value: new THREE.Vector2(0, -1) },
      },
    });
    setHalo = (k) => {
      const lit = Math.pow(k, 0.75);
      haloK.tight = (0.008 + 0.022 * lit);
      haloK.wide = (0.0015 + 0.0050 * lit);
    };
    haloGeo = new THREE.PlaneGeometry(2 * scale * R, 2 * scale * R);
    halo = new THREE.Mesh(haloGeo, haloMat);
    halo.name = 'moon-halo';
    halo.renderOrder = -79;
    halo.frustumCulled = false;
    group.add(halo);
  }

  // ---- placing it: position, tidal lock, the sun's direction in the moon's frame
  const qLib = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const down = new THREE.Vector3();
  const uSun = moonMat.uniforms.uSun.value, uView = moonMat.uniforms.uView.value;
  let libT = 0;
  function place() {
    const dir = cur.dir;
    moon.position.copy(dir).multiplyScalar(D);
    basis(dir, xL, yL);
    zL.copy(dir).negate();
    const c = Math.cos(cur.tilt), s = Math.sin(cur.tilt);
    xT.copy(xL).multiplyScalar(c).addScaledVector(yL, s);
    yT.copy(yL).multiplyScalar(c).addScaledVector(xL, -s);
    qBase.setFromRotationMatrix(mBasis.makeBasis(xT, yT, zL));
    // the sun, `elong` away from the moon, toward the bright-limb direction
    sunWorld.copy(dir).multiplyScalar(Math.cos(cur.elong))
      .addScaledVector(xL, cur.lx * Math.sin(cur.elong)).addScaledVector(yL, cur.ly * Math.sin(cur.elong)).normalize();
    viewWorld.copy(dir).negate();
    // dimmer and warmer when low
    const altDeg = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / DEG;
    low = 1 - THREE.MathUtils.smoothstep(altDeg, 2, 40);
    moonMat.uniforms.uTint.value.copy(ivory).lerp(fireCore, 0.28 * low);
    moonMat.uniforms.uGain.value = 0.66 * (1 - 0.35 * low);
    if (halo) {
      halo.position.copy(dir).multiplyScalar(D - 1.4 * R);   // just in front of the disc
      halo.quaternion.copy(qBase);
      haloBase.copy(cream).lerp(fireCore, 0.22 + 0.4 * low);
      down.set(0, -1, 0).applyQuaternion(qInv.copy(qBase).invert());
      haloMat.uniforms.uDown.value.set(down.x, down.y).normalize();
    }
    orient();
  }
  function orient() {
    if (reduced) {
      moon.quaternion.copy(qBase);
    } else {
      // ~±1.5 deg over many minutes: you would only notice by coming back later
      eul.set(1.2 * DEG * Math.sin(libT * 0.0081 + 1.0), 1.5 * DEG * Math.sin(libT * 0.0067), 0);
      qLib.setFromEuler(eul);
      moon.quaternion.multiplyQuaternions(qBase, qLib);
    }
    qInv.copy(moon.quaternion).invert();
    uSun.copy(sunWorld).applyQuaternion(qInv);
    uView.copy(viewWorld).applyQuaternion(qInv);
  }
  function applyFade() {
    const f = fade * fade * (3 - 2 * fade);
    moonMat.uniforms.uFade.value = f;
    moonMat.depthWrite = f > 0.5;
    if (haloMat) {
      haloMat.uniforms.uTight.value = haloK.tight * (1 - 0.3 * low) * f;
      haloMat.uniforms.uWide.value = haloK.wide * (1 - 0.2 * low) * f;
    }
  }

  const handle = {
    group, update, resize, dispose, setTimeOfDay,
    direction,                 // unit vector toward the moon (world, from the camera); updated in place
    phase: 0, illumination: 0, placement: 'artistic',
    sunDirection: sunWorld, radius: R, distance: D,
  };

  // ---- per frame: follow the camera (it is at infinity), glide or cross-fade, libration
  function update(timeSec, dtSec) {
    const dt = Math.min(0.1, Math.max(0, +dtSec || 0));
    if (o.followCamera && ctx.camera) group.position.copy(ctx.camera.position);
    libT = timeSec || 0;
    let moved = false;
    if (swapping) {
      fade = Math.max(0, fade - dt / 1.6);
      if (fade <= 0) { cur.dir.copy(target.dir); commit(); swapping = false; moved = true; }
    } else if (fade < 1) {
      fade = Math.min(1, fade + dt / 2.4);
    } else if (!reduced && cur.dir.distanceToSquared(target.dir) > 1e-12) {
      cur.dir.lerp(target.dir, 1 - Math.exp(-dt / 6)).normalize();
      moved = true;
    }
    applyFade();
    if (moved) place();
    else if (!reduced) orient();
  }

  // The core calls this on load and every 20 s: { hour, dusk, night, dawn }. The moon re-reads
  // the real sky for today at that local hour (the visitor's clock, or a pinned ?hour=).
  function setTimeOfDay(tod) {
    if (!tod || !Number.isFinite(+tod.hour)) return;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    readSky(new Date(d.getTime() + (((+tod.hour % 24) + 24) % 24) * 3600000));
    retarget(false);
    if (!swapping) place();
  }

  function resize(width, height) {
    if (width > 0 && height > 0) aspect = width / height;
    retarget(false);
    if (!swapping) place();
  }

  function dispose() {
    group.removeFromParent();
    moonGeo.dispose(); moonMat.dispose();
    if (haloGeo) haloGeo.dispose();
    if (haloMat) haloMat.dispose();
    baked.target.dispose();
  }

  // for the bench: show the sky of any moment (setTimeOfDay always uses today)
  handle.setDate = (date) => {
    if (!(date instanceof Date) || isNaN(date)) return;
    readSky(date); retarget(false);
    if (!swapping) place();
  };
  // for the bench: change the phase without rebaking
  handle.setPhase = (p) => {
    o.phase = p; override = true;
    readSky(new Date());
    retarget(true); place(); applyFade();
  };

  // first placement
  if (ctx.camera && ctx.camera.isPerspectiveCamera) aspect = ctx.camera.aspect || aspect;
  readSky(o.date instanceof Date ? o.date : new Date());
  retarget(true);
  if (o.followCamera && ctx.camera) group.position.copy(ctx.camera.position);
  place(); applyFade();

  return handle;
}

export default createMoon;
