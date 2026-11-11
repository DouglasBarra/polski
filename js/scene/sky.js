/*
  Iskry · sky.js — the night and the land around the fire, beyond the trees.
  OWNER: Opus worker "sky". Interface: CONTRACT.md + scratchpad scene-modules-spec.md.

  createSky(ctx, opts) -> { group, update, resize, dispose, setMoon, setTimeOfDay,
                            fogColor, fogNear, fogFar }

  What it draws (5 draw calls, no textures):
    1. dome    sky gradient, horizon haze, fire glow ahead, village glow (+ optional moon-lit air)
    2. land    ONE merged mesh, all terrain beyond the tree row (trees.js owns every tree):
                 a low wooded rise behind the treeline (66 m, open in the valley window),
                 the village on the far lake shore (157 m), two forested hill ranges
                 (190 m, 250 m), Giewont, the "sleeping knight" (325 m), and the Tatras (360 m)
    3. ground  the meadow and valley floor, a ring at y = 0 from 28 m out (ground.js draws inside)
    4. lake    a calm lake in the valley (82-150 m), reflecting the sky and three village windows
    5. mist    one drifting veil of valley mist in front of the hills

  Stars, the Milky Way (stars.js) and the moon (moon.js) are other modules. A faint
  moon-lit brightening of the air is available through setMoon(direction, illumination).

  Aerial perspective: land, ground and lake share one tone function of world position.
  Far things fade toward the sky colour seen in the same direction (cooler with distance),
  and a warm low-lying haze, drifting with the wind, lifts the base of everything. Wherever
  two surfaces meet they evaluate the same point, so there is no seam.

  All shaders dither in output (sRGB) space, so the dark gradients never band.
  Nothing here sets scene.fog, background, tone mapping or renderer state.

  Draw order (opaque pass unless noted): dome -100 (no depth write), land -50 (writes depth),
  ground -45 (NO depth write, so fire.js glow billboards reaching below y = 0 leave no
  hard line), lake -44 (transparent pass, no depth write), mist -40 (transparent pass).
*/
import * as THREE from 'three';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  horizonY: 0,             // world y of the ground plane / horizon
  radius: 90,              // sky dome radius (drawn first without depth, so any size works)
  center: { x: 0, z: 12 }, // xz the landscape arcs around (camera default)
  seed: 7,                 // deterministic landscape
  mist: true,
  // the valley window: the rise behind the trees opens here, onto lake, village and mountains
  valleyAz: 0.17,          // radians, + = right of straight ahead
  valleyHalf: 0.3,
  // distances from `center`, metres
  groundInner: 28,         // m: ground.js owns the floor inside this (feather 28.6-30.4 m)
  riseDistance: 66,
  lakeNear: 72, lakeFar: 150,
  villageDistance: 157, villageAz: 0.24,
  hillsDistance: 190,
  hills2Distance: 250,
  giewontDistance: 290, giewontAz: 0.08,
  tatraDistance: 360,
  firePosition: { x: -3, z: -2 }, // warm side of the haze + warm pool on the ground
  // compass (shared with stars.js): the camera's -z faces bearing 120 deg (ESE).
  headingDeg: 120,
  // sunrise / sunset bearings (deg); null = computed for today's date at latitude 52 N
  sunriseBearingDeg: null,
  sunsetBearingDeg: null,
  date: null,
};

// Bearing of sunrise for a date at a latitude (sunset is 360 minus it). Cheap and
// good to a few degrees: solar declination from the day of the year.
function sunriseBearing(date, latDeg = 52) {
  const d = date instanceof Date ? date : new Date();
  const doy = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5;
  const decl = -23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365);
  const c = Math.sin((decl * Math.PI) / 180) / Math.cos((latDeg * Math.PI) / 180);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}
const SPAN = 1.2; // radians each side of straight ahead (32:9 screens see about +-0.9)

// --------------------------------------------------------------- utilities
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded 1D value noise + fbm (for ridgelines).
function makeNoise1D(rng) {
  const N = 512;
  const table = new Float32Array(N);
  for (let i = 0; i < N; i++) table[i] = rng();
  const smooth = (t) => t * t * (3 - 2 * t);
  const n1 = (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[((i % N) + N) % N];
    const b = table[(((i + 1) % N) + N) % N];
    return a + (b - a) * smooth(f);
  };
  n1.fbm = (x, oct = 4) => {
    let s = 0, amp = 0.5, fr = 1, norm = 0;
    for (let o = 0; o < oct; o++) { s += amp * n1(x * fr + o * 31.7); norm += amp; amp *= 0.5; fr *= 2.03; }
    return s / norm;
  };
  return n1;
}

function colorFrom(ctx, token, fallback) {
  let v = fallback;
  try { if (ctx && typeof ctx.readToken === 'function') v = ctx.readToken(token, fallback); } catch (e) { /* use fallback */ }
  const c = new THREE.Color();
  try { c.set(typeof v === 'string' ? v.trim() : v); } catch (e) { c.set(fallback); }
  return c;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// --------------------------------------------------------------- GLSL bits
const GLSL_COMMON = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 fromSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  // Triangular dither of one 8-bit step, applied in sRGB space, then handed back
  // to three's output conversion (sRGB canvas or linear render target alike).
  vec4 ditheredOutput(vec3 linearColor, float alpha) {
    vec2 fc = gl_FragCoord.xy;
    float d = hash12(fc) + hash12(fc + 71.13) - 1.0;
    vec3 s = toSRGB(linearColor) + d / 255.0;
    return linearToOutputTexel(vec4(fromSRGB(s), clamp(alpha + d / 255.0, 0.0, 1.0)));
  }
`;

// The sky's colour in a direction. The dome draws it; the land fades toward it.
const GLSL_SKY = /* glsl */ `
  uniform vec3 uTop, uMid, uLow, uHaze, uGlow, uMoonCol, uMoonDir;
  uniform vec2 uVillage;      // azimuth (rad), strength
  uniform float uFireAz, uMoonIllum;
  uniform vec3 uDuskCol, uDawnCol;
  uniform vec2 uDusk, uDawn;  // azimuth of the sunset / sunrise side (rad), amount 0..1
  vec3 skyColor(vec3 dir) {
    float h = max(dir.y, 0.0);                        // sine of elevation
    float az = atan(dir.x, -dir.z);                   // 0 = straight ahead (-z), + = right
    // vertical gradient: haze -> low -> mid -> top, eased so the warm band hugs the horizon
    vec3 col = mix(uHaze, uLow, smoothstep(0.0, 0.16, h));
    col = mix(col, uMid, smoothstep(0.06, 0.42, h));
    col = mix(col, uTop, smoothstep(0.30, 0.95, h));
    // warm glow of the fire and the low air ahead, and the village beyond the lake
    float ga = az - uFireAz * 0.6;
    col += uGlow * exp(-ga * ga / 0.55) * exp(-h * 9.0) * 0.55;
    float dv = az - uVillage.x;
    col += uGlow * uVillage.y * exp(-dv * dv / 0.012) * exp(-h * 30.0);
    // time of day: a low afterglow on the sunset side, a cool band on the sunrise side.
    // Both hug the horizon so the words' band above stays as dark as at night.
    if (uDusk.y > 0.0) {
      float ds = mod(az - uDusk.x + 3.14159265, 6.2831853) - 3.14159265;
      col += uDuskCol * uDusk.y * exp(-ds * ds / 1.6) * exp(-h * 24.0);   // wide: the sun may be behind us
    }
    if (uDawn.y > 0.0) {
      float dw = mod(az - uDawn.x + 3.14159265, 6.2831853) - 3.14159265;
      col += uDawnCol * uDawn.y * exp(-dw * dw / 0.9) * exp(-h * 20.0);
    }
    // optional moon-lit air (moon.js draws the moon itself)
    if (uMoonIllum > 0.0) {
      float ang = sqrt(max(2.0 * (1.0 - dot(dir, uMoonDir)), 0.0));
      col += uMoonCol * uMoonIllum * (exp(-ang * 2.5) * 0.03 + exp(-ang * 9.0) * 0.035);
    }
    return col;
  }
`;

// ------------------------------------------------------------------- dome
const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vDir = wp.xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const DOME_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  ${GLSL_COMMON}
  ${GLSL_SKY}
  void main() {
    gl_FragColor = ditheredOutput(skyColor(normalize(vDir)), 1.0);
  }
`;

// ------------------------------------------------------- world (land, ground, lake)
const GLSL_WORLD = /* glsl */ `
  uniform vec3 uGroundNear, uDark, uWarm, uCool, uWinCol;
  uniform vec2 uCenter;
  uniform float uTime, uMistK;
  varying vec3 vLocal;
  varying vec3 vWorld;
  // Tone of a surface of colour 'base' at local position p (world position wp).
  vec3 worldTone(vec3 p, vec3 wp, vec3 base, out float dist, out float aerial) {
    vec2 rel = p.xz - uCenter;
    dist = length(rel);
    // aerial perspective: fade toward the sky seen in the same direction, cooler far away
    vec3 sky = skyColor(normalize(wp - cameraPosition));
    aerial = 0.86 * pow(clamp((dist - 25.0) / 400.0, 0.0, 1.0), 0.8);  // even steps per layer
    vec3 air = sky * mix(vec3(1.0), uCool, smoothstep(150.0, 360.0, dist));
    vec3 col = mix(base, air, aerial);
    // warm low-lying haze, warmer toward the fire. It grows quickly close by and
    // saturates far away, so on screen the ground's gradient spreads over its whole
    // height instead of piling up at the treeline; it rises higher in the far valley.
    float fa = atan(rel.x, -rel.y) - uFireAz;
    vec3 haze = uHaze + uWarm * exp(-fa * fa / 0.3);
    float t = clamp((dist - 36.0) / 50.0, 0.0, 1.0);
    float lowK = 0.62 * (1.0 - exp(-max(dist - 6.0, 0.0) / 30.0));
    float low = lowK * (1.0 - smoothstep(-0.5, 2.2 + 5.5 * t, p.y));
    // slow drifting thickness (wind +x), low frequency in z so grazing views do not streak
    float n = vnoise(vec2((p.x - uTime * 0.25) * 0.05, p.z * 0.035 + p.y * 0.12));
    n = 0.6 * n + 0.4 * vnoise(vec2((p.x - uTime * 0.3) * 0.12 + 5.3, p.z * 0.07 - p.y * 0.2));
    low *= 1.0 + uMistK * (n - 0.5) * 0.9;
    return mix(col, haze, clamp(low, 0.0, 1.0));
  }
`;
const WORLD_VERT = /* glsl */ `
  attribute float aKind;
  varying vec3 vLocal;
  varying vec3 vWorld;
  varying float vKind;
  void main() {
    vLocal = position;
    vKind = aKind;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const LAND_FRAG = /* glsl */ `
  precision highp float;
  varying float vKind;
  ${GLSL_COMMON}
  ${GLSL_SKY}
  ${GLSL_WORLD}
  void main() {
    float dist, aerial;
    vec3 col = worldTone(vLocal, vWorld, uDark, dist, aerial);
    if (vKind > 0.5) col = mix(uWinCol, col, aerial * 0.45);   // a lit window, barely veiled
    gl_FragColor = ditheredOutput(col, 1.0);
  }
`;
const GROUND_FRAG = /* glsl */ `
  precision highp float;
  uniform vec2 uFire;
  uniform float uPool;
  ${GLSL_COMMON}
  ${GLSL_SKY}
  ${GLSL_WORLD}
  void main() {
    vec2 rel = vLocal.xz - uCenter;
    vec3 base = mix(uGroundNear, uDark, smoothstep(10.0, 40.0, length(rel)));
    float dist, aerial;
    vec3 col = worldTone(vLocal, vWorld, base, dist, aerial);
    // gentle unevenness close by, so the meadow is not a flat sheet (gone by 34 m)
    col *= 1.0 + (0.2 * vnoise(vLocal.xz * 0.35) - 0.1) * (1.0 - smoothstep(16.0, 34.0, dist));
    // a faint warm pool around the fire (fire.js adds the bright part)
    float fd = length(vLocal.xz - uFire);
    col += uWarm * uPool * exp(-fd * fd / 40.0);
    gl_FragColor = ditheredOutput(col, 1.0);
  }
`;
const LAKE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec2 uLakeR, uLakeAz;     // near/far shore distance, azimuth range
  uniform vec3 uWin[3];             // lit windows (world), mirrored in the water
  uniform float uWaterY;
  ${GLSL_COMMON}
  ${GLSL_SKY}
  ${GLSL_WORLD}
  void main() {
    vec2 rel = vLocal.xz - uCenter;
    float D = length(rel);
    float az = atan(rel.x, -rel.y);
    // an organic shoreline
    float nearS = uLakeR.x + 9.0 * vnoise(vec2(az * 13.0, 1.7));
    float farS = uLakeR.y - 7.0 * vnoise(vec2(az * 9.0, 8.3));
    float m = smoothstep(nearS, nearS + 5.0, D) * (1.0 - smoothstep(farS - 5.0, farS, D))
            * smoothstep(uLakeAz.x, uLakeAz.x + 0.08, az) * (1.0 - smoothstep(uLakeAz.y - 0.08, uLakeAz.y, az));
    if (m < 0.002) discard;
    vec3 v = normalize(vWorld - cameraPosition);
    float vaz = atan(v.x, -v.z);
    float vel = v.y / length(v.xz);
    // the sky mirrored, broken into long, slow ripples
    float rip = vnoise(vec2(D * 0.7 - uTime * 0.12, az * 60.0));
    vec3 col = skyColor(vec3(v.x, -v.y, v.z)) * (1.05 + 0.25 * rip);
    // village windows: little warm streaks, stretched toward us by the ripples
    float glow = 0.0;
    for (int i = 0; i < 3; i++) {
      vec3 w = uWin[i] - cameraPosition;
      w.y = 2.0 * uWaterY - uWin[i].y - cameraPosition.y;
      float dA = (vaz - atan(w.x, -w.z)) / 0.0024;
      float dE = vel - w.y / length(w.xz);
      float e = dE > 0.0 ? dE / 0.0012 : dE / 0.005;
      float shimmer = 0.5 + 0.5 * vnoise(vec2(D * 1.6 - uTime * 0.35, float(i) * 13.0 + vel * 900.0));
      glow += exp(-dA * dA - e * e) * shimmer;
    }
    col += uWinCol * glow * 0.45;
    // the same air as the land, a little less of the low haze so the water still reads
    float dist, aerial;
    vec3 hazed = worldTone(vLocal, vWorld, col, dist, aerial);
    col = mix(hazed, col, 0.3);
    gl_FragColor = ditheredOutput(col, m);
  }
`;

// ------------------------------------------------------------------- mist
const MIST_VERT = /* glsl */ `
  attribute vec2 aMist;   // x: arc coordinate (m), y: 0..1 height in band
  varying vec2 vMist;
  void main() {
    vMist = aMist;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MIST_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uTime, uOpacity;
  varying vec2 vMist;
  ${GLSL_COMMON}
  void main() {
    vec2 q = vec2((vMist.x - uTime * 0.3) * 0.03, vMist.y * 1.3 + 7.0);
    float n = vnoise(q) * 0.6 + vnoise(q * 2.7 + vec2(3.1, 1.7) - vec2(uTime * 0.004, 0.0)) * 0.4;
    float body = smoothstep(0.3, 0.8, n);
    // fades out at the ground and at the top: no edge where it meets anything
    float shape = smoothstep(0.0, 0.45, vMist.y) * (1.0 - smoothstep(0.35, 1.0, vMist.y));
    gl_FragColor = ditheredOutput(uColor, body * shape * uOpacity);
  }
`;

// =================================================================== build
export function createSky(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts, center: { ...DEFAULTS.center, ...(opts.center || {}) } };
  if (opts.firePosition) o.firePosition = { x: opts.firePosition.x, z: opts.firePosition.z };
  const reduced = !!ctx.reducedMotion;
  const rng = mulberry32(o.seed * 9301 + 49297);
  const noise = makeNoise1D(rng);
  const C = o.center;
  const fireAz = Math.atan2(o.firePosition.x - C.x, -(o.firePosition.z - C.z));

  // palette from tokens
  const tNightDeep = colorFrom(ctx, '--night-deep', '#130d0a');
  const tNight = colorFrom(ctx, '--night', '#1a120d');
  const tNightWarm = colorFrom(ctx, '--night-warm', '#26180f');
  const tHaze = colorFrom(ctx, '--night-haze', '#3a2214');
  const tFire = colorFrom(ctx, '--fire', '#f0842c');
  const tFireCore = colorFrom(ctx, '--fire-core', '#ffb45a');
  const tFireDeep = colorFrom(ctx, '--fire-deep', '#b8481a');
  // compass bearing (deg, 0 = north, 90 = east) -> our azimuth (rad, 0 = -z, + = right)
  const bearingToAz = (deg) => {
    let a = ((deg - o.headingDeg) * Math.PI) / 180;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return a;
  };
  const sunriseDeg = o.sunriseBearingDeg != null ? +o.sunriseBearingDeg : sunriseBearing(o.date);
  const sunsetDeg = o.sunsetBearingDeg != null ? +o.sunsetBearingDeg : 360 - sunriseBearing(o.date);
  const tCream = colorFrom(ctx, '--cream', '#f4e6d0');

  const top = tNightDeep.clone().lerp(new THREE.Color('#0f0a08'), 0.35);
  const mid = tNight.clone();
  const low = tNightWarm.clone();
  const haze = tHaze.clone().lerp(tNightWarm, 0.18);

  const group = new THREE.Group();
  group.name = 'sky';
  group.position.y = o.horizonY;
  ctx.scene.add(group);

  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  // Sky uniforms, shared (same objects) by every material that looks at the sky.
  const skyUniforms = {
    uTop: { value: top }, uMid: { value: mid }, uLow: { value: low }, uHaze: { value: haze },
    uGlow: { value: tFire.clone().multiplyScalar(0.022) },
    uVillage: { value: new THREE.Vector2(o.villageAz, 0.3) },
    uFireAz: { value: fireAz },
    uMoonCol: { value: tCream.clone().lerp(new THREE.Color('#ffe2b8'), 0.4).multiplyScalar(0.62) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonIllum: { value: 0 },
    uDuskCol: { value: tFire.clone().lerp(tFireDeep, 0.5).multiplyScalar(0.03) },
    uDawnCol: { value: new THREE.Color('#9aa8bf').multiplyScalar(0.022) },
    uDusk: { value: new THREE.Vector2(bearingToAz(sunsetDeg), 0) },
    uDawn: { value: new THREE.Vector2(bearingToAz(sunriseDeg), 0) },
  };

  // ---------------------------------------------------------------- dome
  const domeMat = track(new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: skyUniforms,
  }));
  const domeGeo = track(new THREE.SphereGeometry(o.radius, 48, 24));
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -100;
  dome.frustumCulled = false;
  dome.name = 'sky-dome';
  group.add(dome);

  // ---------------------------------------------------------------- land
  const pos = [];
  const kinds = [];
  let kind = 0;              // 0 land silhouette, 1 lit window
  // place a 2D silhouette (local x along the arc tangent, y up) at angle th, distance R
  let bx = 0, bz = 0, tx = 0, tz = 0;
  const setBase = (th, R) => {
    bx = C.x + Math.sin(th) * R; bz = C.z - Math.cos(th) * R;
    tx = Math.cos(th); tz = Math.sin(th);
  };
  const tri = (x1, y1, x2, y2, x3, y3) => {
    pos.push(bx + tx * x1, y1, bz + tz * x1, bx + tx * x2, y2, bz + tz * x2, bx + tx * x3, y3, bz + tz * x3);
    kinds.push(kind, kind, kind);
  };
  const quad = (x1, y1, x2, y2, x3, y3, x4, y4) => { tri(x1, y1, x2, y2, x3, y3); tri(x1, y1, x3, y3, x4, y4); };

  // a ridgeline strip from just below the ground up to profile(th), at distance R(th)
  const SKIRT = -0.6;
  function ridge(Rf, segs, profile) {
    const R = typeof Rf === 'function' ? Rf : () => Rf;
    let pTh = -SPAN, pH = profile(pTh), pR = R(pTh);
    for (let s = 1; s <= segs; s++) {
      const th = -SPAN + (2 * SPAN * s) / segs;
      const h = profile(th), r = R(th);
      const x0 = C.x + Math.sin(pTh) * pR, z0 = C.z - Math.cos(pTh) * pR;
      const x1 = C.x + Math.sin(th) * r, z1 = C.z - Math.cos(th) * r;
      if (h > SKIRT + 0.05 || pH > SKIRT + 0.05) {
        pos.push(x0, SKIRT, z0, x1, SKIRT, z1, x1, h, z1, x0, SKIRT, z0, x1, h, z1, x0, pH, z0);
        for (let k = 0; k < 6; k++) kinds.push(0);
      }
      pTh = th; pH = h; pR = r;
    }
  }

  // a far forest canopy: a saw of narrow, uneven spires (single trees are not
  // resolvable this far away), thinning out in patches of field and meadow
  const spire = new Float32Array(4096);
  for (let i = 0; i < spire.length; i++) spire[i] = rng();
  function canopy(th, R, spacing, hMin, hMax, cover) {
    if (cover <= 0) return 0;
    const u = (th + SPAN) * R / spacing;
    const k = Math.floor(u), f = u - k;
    const r = spire[k & 4095];
    const c = (f - 0.5 - (spire[(k + 7) & 4095] - 0.5) * 0.3) * 2;   // off-centre, narrow
    const cone = Math.pow(Math.max(0, 1 - Math.abs(c)), 2.4);
    return cover * (hMin + (hMax - hMin) * r) * (0.4 + 0.6 * cone);
  }
  // 1 inside the valley window, 0 outside, soft edges
  const valley = (th) => 1 - smoothstep(o.valleyHalf - 0.1, o.valleyHalf + 0.06, Math.abs(th - o.valleyAz));

  // Emitted near to far, so the depth test rejects hidden far fragments early.
  // piecewise-linear noise: angular, rocky facets instead of rounded bumps
  const plin = (x, salt) => {
    const k = Math.floor(x), f = x - k;
    const a = spire[(k * 7 + salt) & 4095], b = spire[((k + 1) * 7 + salt) & 4095];
    return a + (b - a) * f;
  };
  // --- the low wooded rise right behind the tree row: terrain for trees.js to stand
  // in front of. It sinks to nothing in the valley window so the lake shows.
  ridge((th) => o.riseDistance + 6 * noise(th * 6 + 21), 1200, (th) => {
    const keep = 1 - valley(th);
    if (keep <= 0.001) return -0.05;
    const base = 2.4 + 3.4 * noise.fbm(th * 3.4 + 11, 3);
    return keep * (base + canopy(th, o.riseDistance, 0.7, 0.2, 0.9, 1) + 0.4 * (plin(th * 400, 13) - 0.5));
  });

  // --- the village on the far shore: a wooden church with a steep shingled roof and an
  // onion-domed tower, a few cottages with steep Podhale roofs, lime trees, three lit windows
  const winPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let winCount = 0;
  const VR = o.villageDistance;
  const at = (offset, dr = 0) => setBase(o.villageAz + offset / VR, VR + dr);
  function windowAt(offset, dr, x, y) {
    at(offset, dr - 0.4);           // just in front of the wall
    kind = 1;
    quad(x - 0.32, y, x + 0.32, y, x + 0.32, y + 0.62, x - 0.32, y + 0.62);
    kind = 0;
    if (winCount < 3) winPos[winCount++].set(bx + tx * x, o.horizonY + y + 0.31, bz + tz * x);
  }
  function cottage(offset, dr, w, gable, lit) {
    at(offset, dr);
    const wall = 2.3 + 0.4 * rng();
    quad(-w / 2, -1, w / 2, -1, w / 2, wall, -w / 2, wall);
    const ov = 0.5, rh = gable ? w * 0.75 : w * 0.55;
    if (gable) tri(-w / 2 - ov, wall - 0.3, w / 2 + ov, wall - 0.3, 0, wall + rh);   // gable end facing us
    else quad(-w / 2 - ov, wall - 0.3, w / 2 + ov, wall - 0.3, w * 0.28, wall + rh, -w * 0.3, wall + rh);
    const cx = w * (0.15 + 0.15 * rng());
    quad(cx - 0.25, wall + rh * 0.4, cx + 0.25, wall + rh * 0.4, cx + 0.25, wall + rh * 0.85, cx - 0.25, wall + rh * 0.85);
    if (lit !== undefined) windowAt(offset, dr, lit * w, 1.0);
  }
  function church(offset, dr) {
    at(offset, dr);
    // nave with a steep shingled roof, a lower roof over the chancel
    quad(-4, -1, 4.5, -1, 4.5, 3.4, -4, 3.4);
    quad(-4.6, 3.1, 5.1, 3.1, 3.7, 8.4, -3.4, 8.4);
    quad(4.5, -1, 7.5, -1, 7.5, 2.8, 4.5, 2.8);
    quad(4.3, 2.6, 8.0, 2.6, 7.2, 6.0, 4.6, 6.6);
    // tower with sloping walls, a skirt of shingles, then the onion dome and a cross
    const x0 = -6.6, x1 = -3.6;
    quad(x0, -1, x1, -1, x1 - 0.35, 10.2, x0 + 0.35, 10.2);
    quad(x0 - 0.5, 9.2, x1 + 0.5, 9.2, x1 - 0.1, 10.6, x0 + 0.1, 10.6);
    const cx = (x0 + x1) / 2, y0 = 10.5, hb = 3.2, wb = 1.55;
    let pr = wb * 0.55, py = y0;
    for (let s = 1; s <= 10; s++) {
      const f = s / 10;
      const r = f < 0.45 ? wb * (0.55 + 0.45 * Math.sin((f / 0.45) * Math.PI / 2)) : wb * Math.pow((1 - f) / 0.55, 1.5);
      const y = y0 + hb * f;
      quad(cx - pr, py, cx + pr, py, cx + Math.max(r, 0.05), y, cx - Math.max(r, 0.05), y);
      pr = Math.max(r, 0.05); py = y;
    }
    quad(cx - 0.08, py, cx + 0.08, py, cx + 0.06, py + 1.6, cx - 0.06, py + 1.6);
    quad(cx - 0.45, py + 1.05, cx + 0.45, py + 1.05, cx + 0.45, py + 1.22, cx - 0.45, py + 1.22);
  }
  function limeTree(offset, dr, H) {
    at(offset, dr);
    quad(-0.18, -1, 0.18, -1, 0.14, H * 0.45, -0.14, H * 0.45);
    const cy = H * 0.62, rx = H * (0.32 + 0.08 * rng()), ry = H * 0.38, seg = 14;
    let px = 0, py = 0;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const j = s === seg ? 1 : 0.86 + 0.22 * rng();
      const x = Math.cos(a) * rx * j, y = cy + Math.sin(a) * ry * j;
      if (s > 0) tri(0, cy, px, py, x, y);
      px = x; py = y;
    }
  }
  limeTree(-27, 3, 6.5);
  cottage(-19, 2, 7.5, false, 0.22);
  cottage(-11, -1, 6.5, true);
  limeTree(-6.5, 4, 8);
  church(0, 0);
  cottage(11, 1, 6, true, -0.12);
  limeTree(17, 3, 7);
  cottage(22, -2, 8, false);
  cottage(30, 1, 6.5, true, 0.15);
  limeTree(36, 2, 5.5);

  // --- far forested hills, two ranges, with patches of field
  ridge((th) => o.hillsDistance + 15 * noise(th * 5 + 3), 2600, (th) => {
    const base = 3.5 + 9 * Math.pow(noise.fbm(th * 1.9 + 3.3, 4), 1.4);
    const cover = smoothstep(0.36, 0.48, noise.fbm(th * 9 + 40, 2));
    return base + canopy(th, o.hillsDistance, 1.2, 1.4, 3.4, cover);
  });

  ridge((th) => o.hills2Distance + 20 * noise(th * 4 + 9), 2600, (th) => {
    const base = 8 + 12 * Math.pow(noise.fbm(th * 1.6 + 7.7, 4), 1.3);
    const cover = smoothstep(0.38, 0.5, noise.fbm(th * 7 + 60, 2));
    return base + canopy(th, o.hills2Distance, 1.6, 1.8, 4.0, cover);
  });
  // --- Giewont, the sleeping knight: a long body lying on its back, feet to the left,
  // folded hands on the chest, the face turned to the sky with the summit as the brow,
  // and the steep drop of the back of the head. Stands in front of the main range.
  const knight = [
    [0.00, 0.05], [0.05, 0.30], [0.09, 0.38], [0.13, 0.33], [0.22, 0.46], [0.30, 0.42],
    [0.42, 0.56], [0.52, 0.58], [0.60, 0.50], [0.66, 0.63], [0.70, 0.59], [0.76, 0.85],
    [0.79, 0.70], [0.83, 0.92], [0.87, 0.88], [0.92, 0.62], [0.97, 0.30], [1.00, 0.08],
  ];
  const gW = 0.5, gH = 46;
  ridge(o.giewontDistance, 700, (th) => {
    const u = (th - (o.giewontAz - gW / 2)) / gW;
    if (u <= 0 || u >= 1) return -3;
    let i = 1;
    while (i < knight.length - 1 && knight[i][0] < u) i++;
    const [u0, h0] = knight[i - 1], [u1, h1] = knight[i];
    const f = (u - u0) / (u1 - u0);   // straight facets: rock, and a crisp profile
    const h = h0 + (h1 - h0) * f;
    return gH * h + 1.2 * (plin(th * 220, 5) - 0.5) + 0.5 * (plin(th * 700, 9) - 0.5);
  });

  // --- Tatras: a long, high wall of sharp granite peaks and saddles far away, tapering
  // at both ends, with a lower saddle where Giewont stands in front
  ridge((th) => o.tatraDistance + 12 * noise(th * 3 + 50), 1800, (th) => {
    const u = (th + 0.95) / 2.15;
    if (u <= 0 || u >= 1) return -3;
    const env = Math.pow(Math.sin(Math.PI * u), 0.45);
    const massif = 20 + 16 * noise.fbm(th * 2.2 + 30, 3);
    // sharp summits: ridged, then pinched to points
    const n = noise(th * 9 + 100);
    const peaks = Math.pow(1 - Math.abs(2 * n - 1), 3.0) * 26;
    const facets = (plin(th * 60, 3) - 0.5) * 5 + (plin(th * 190, 11) - 0.5) * 2.2;
    const dg = (th - o.giewontAz - 0.03) / 0.26;
    const saddle = 1 - 0.62 * Math.exp(-dg * dg * dg * dg);
    return env * saddle * (massif + peaks + facets) - 3 * (1 - env);
  });

  const landGeo = track(new THREE.BufferGeometry());
  landGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  landGeo.setAttribute('aKind', new THREE.Float32BufferAttribute(kinds, 1));
  landGeo.computeBoundingSphere();

  // One set of world uniforms (same objects) for land, ground and lake: they must agree.
  const worldUniforms = {
    ...skyUniforms,
    uGroundNear: { value: new THREE.Color('#0b0705') },
    uDark: { value: new THREE.Color('#110b08') },
    uWarm: { value: tFire.clone().multiplyScalar(0.016) },
    uCool: { value: new THREE.Vector3(0.84, 0.94, 1.16) },   // far air: a touch greyer and bluer
    uWinCol: { value: tFireCore.clone().multiplyScalar(0.55) },
    uCenter: { value: new THREE.Vector2(C.x, C.z) },
    uTime: { value: 0 },
    uMistK: { value: o.mist ? 1 : 0 },
  };
  const landMat = track(new THREE.ShaderMaterial({
    vertexShader: WORLD_VERT,
    fragmentShader: LAND_FRAG,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    uniforms: worldUniforms,
  }));
  const land = new THREE.Mesh(landGeo, landMat);
  land.name = 'sky-land';
  land.renderOrder = -50;
  land.frustumCulled = false;
  group.add(land);

  // -------------------------------------------------------------- ground
  // Drawn after the land and without depth writes: it still hides the land's buried
  // skirts, and glow billboards reaching below y = 0 leave no hard line on it.
  // A ring: inside ~30 m ground.js draws the lit floor (feathering into this one
  // between 28.6 and 30.4 m), so the disc starts at 28 m to avoid filling those pixels twice.
  const groundGeo = track(new THREE.RingGeometry(o.groundInner, 300, 192, 1));
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(C.x, 0, C.z);
  groundGeo.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(groundGeo.attributes.position.count), 1));
  const groundMat = track(new THREE.ShaderMaterial({
    vertexShader: WORLD_VERT,
    fragmentShader: GROUND_FRAG,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      ...worldUniforms,
      uPool: { value: 0.0045 / 0.016 },
      uFire: { value: new THREE.Vector2(o.firePosition.x, o.firePosition.z) },
    },
  }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'sky-ground';
  ground.renderOrder = -45;
  ground.frustumCulled = false;
  group.add(ground);

  // ---------------------------------------------------------------- lake
  const lakeAz0 = o.valleyAz - o.valleyHalf - 0.12, lakeAz1 = o.valleyAz + o.valleyHalf + 0.12;
  const lp = [];
  {
    const sa = 96, sr = 6, r0 = o.lakeNear - 1, r1 = o.lakeFar + 1;
    const P = (a, r) => [C.x + Math.sin(a) * r, 0.03, C.z - Math.cos(a) * r];
    for (let i = 0; i < sa; i++) {
      for (let j = 0; j < sr; j++) {
        const a0 = lakeAz0 + (lakeAz1 - lakeAz0) * (i / sa), a1 = lakeAz0 + (lakeAz1 - lakeAz0) * ((i + 1) / sa);
        const q0 = r0 + (r1 - r0) * (j / sr), q1 = r0 + (r1 - r0) * ((j + 1) / sr);
        lp.push(...P(a0, q0), ...P(a1, q0), ...P(a1, q1), ...P(a0, q0), ...P(a1, q1), ...P(a0, q1));
      }
    }
  }
  const lakeGeo = track(new THREE.BufferGeometry());
  lakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lakeGeo.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(lp.length / 3), 1));
  const lakeMat = track(new THREE.ShaderMaterial({
    vertexShader: WORLD_VERT,
    fragmentShader: LAKE_FRAG,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      ...worldUniforms,
      uLakeR: { value: new THREE.Vector2(o.lakeNear, o.lakeFar) },
      uLakeAz: { value: new THREE.Vector2(lakeAz0, lakeAz1) },
      uWin: { value: winPos },
      uWaterY: { value: o.horizonY + 0.03 },
    },
  }));
  const lake = new THREE.Mesh(lakeGeo, lakeMat);
  lake.name = 'sky-lake';
  lake.renderOrder = -44;
  lake.frustumCulled = false;
  group.add(lake);

  // ---------------------------------------------------------------- mist
  let mistMat = null;
  if (o.mist) {
    const mp = [], ma = [];
    const R = o.hillsDistance - 18, H = 11, segs = 120;
    for (let s = 0; s < segs; s++) {
      const a0 = -SPAN + (2 * SPAN * s) / segs, a1 = -SPAN + (2 * SPAN * (s + 1)) / segs;
      const x0 = C.x + Math.sin(a0) * R, z0 = C.z - Math.cos(a0) * R;
      const x1 = C.x + Math.sin(a1) * R, z1 = C.z - Math.cos(a1) * R;
      const u0 = a0 * R, u1 = a1 * R;
      mp.push(x0, 0, z0, x1, 0, z1, x1, H, z1, x0, 0, z0, x1, H, z1, x0, H, z0);
      ma.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
    }
    const mistGeo = track(new THREE.BufferGeometry());
    mistGeo.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mistGeo.setAttribute('aMist', new THREE.Float32BufferAttribute(ma, 2));
    mistMat = track(new THREE.ShaderMaterial({
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: haze.clone().lerp(tFire, 0.05) },
        uTime: { value: 0 },
        uOpacity: { value: 0.3 },
      },
    }));
    const mist = new THREE.Mesh(mistGeo, mistMat);
    mist.name = 'sky-mist';
    mist.renderOrder = -40;
    mist.frustumCulled = false;
    group.add(mist);
  }

  // ------------------------------------------------------------- handle
  const fogColor = haze.clone().lerp(low, 0.45);
  const fogNear = 14;
  const fogFar = 72;

  // Time of day: night is the look above; dusk and dawn are blended in, all in place.
  const mistCol = mistMat ? mistMat.uniforms.uColor.value : null;
  const base = { haze: haze.clone(), fog: fogColor.clone(), mist: mistCol ? mistCol.clone() : null };
  const duskHaze = base.haze.clone().lerp(tFire, 0.03).multiplyScalar(1.08);
  const dawnHaze = base.haze.clone().lerp(new THREE.Color('#5a5a62'), 0.12);
  const duskFog = base.fog.clone().lerp(tFire, 0.02).multiplyScalar(1.06);
  const dawnFog = base.fog.clone().lerp(new THREE.Color('#4a4c56'), 0.1);
  const blend3 = (out, a, b, c, wa, wb, wc) =>
    out.setRGB(a.r * wa + b.r * wb + c.r * wc, a.g * wa + b.g * wb + c.g * wc, a.b * wa + b.b * wb + c.b * wc);
  function setTimeOfDay(tod) {
    if (!tod) return;
    let d = Math.max(0, +tod.dusk || 0), w = Math.max(0, +tod.dawn || 0), n = Math.max(0, +tod.night || 0);
    const sum = d + w + n || 1; d /= sum; w /= sum; n /= sum;
    skyUniforms.uDusk.value.y = d;
    skyUniforms.uDawn.value.y = w;
    blend3(haze, base.haze, duskHaze, dawnHaze, n, d, w);
    blend3(fogColor, base.fog, duskFog, dawnFog, n, d, w);
    if (mistCol) mistCol.copy(haze).lerp(tFire, 0.05);
  }

  function resize(/* width, height */) { /* nothing depends on the viewport */ }

  function update(timeSec /* , dtSec */) {
    // the sky sits at infinity: keep the dome centred on the camera
    const cp = ctx.camera.position;
    dome.position.set(cp.x, cp.y - o.horizonY, cp.z);
    if (!reduced) {
      worldUniforms.uTime.value = timeSec;
      if (mistMat) mistMat.uniforms.uTime.value = timeSec;
    }
  }

  // Faint moon-lit air around the moon. direction: unit THREE.Vector3 toward the moon,
  // illumination 0..1 (0 = off, the default). Copies, never allocates.
  function setMoon(direction, illumination) {
    if (direction && direction.isVector3) skyUniforms.uMoonDir.value.copy(direction).normalize();
    skyUniforms.uMoonIllum.value = Math.min(1, Math.max(0, +illumination || 0));
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  }

  return { group, update, resize, dispose, setMoon, setTimeOfDay, fogColor, fogNear, fogFar, uniforms: skyUniforms };
}

export default createSky;
