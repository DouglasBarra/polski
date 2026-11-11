/*
  Iskry · sky.js — the world around the fire.
  OWNER: Opus worker "sky". Interface: scratchpad scene-modules-spec.md.

  createSky(ctx, opts) -> { group, update, resize, dispose, fogColor, fogNear, fogFar }

  What it draws (5 draw calls, no textures):
    1. dome      gradient sky, horizon haze, fire/village glow, veiled crescent moon, faint Milky Way
    2. stars     a few hundred points, mostly faint, slow twinkle, fading into the haze
    3. land      ONE merged mesh: far ridge, rolling hills, pine/spruce treeline, near junipers and young pines
    4. ground    dark meadow disc with a faint warm pool under the fire
    5. mist      two low haze bands drifting left -> right with the wind

  All shaders are dithered in output (sRGB) space, so the dark gradients never band,
  whether the renderer draws to the canvas or to a linear render target.
  Nothing here sets scene.fog, background, tone mapping or renderer state.
*/
import * as THREE from 'three';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  horizonY: 0,          // world y of the ground plane / horizon
  radius: 90,           // sky dome radius (camera far plane must exceed it)
  center: { x: 0, z: 12 }, // xz the landscape arcs around (camera default)
  seed: 7,              // deterministic landscape
  starCount: 1100,       // reducedMotion uses ~60%
  moon: true,
  milkyWay: true,
  mist: true,
  // landscape distances from `center`, metres
  nearDistance: 36,
  treelineDistance: 53,
  hillsDistance: 74,
  ridgeDistance: 85,
  // the treeline dips behind the fire so the warm haze shows through
  gapWidth: 0.26,       // radians
  gapDepth: 0.42,       // 0..1 height reduction at the centre
  treeHeight: 7.2,      // metres, typical front-row treeline height
  firePosition: { x: -3, z: -2 }, // warm pool on the ground + warm side of the land
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

// Seeded 1D value noise + fbm (for ridgelines and treeline density).
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
  uniform vec3 uTop, uMid, uLow, uHaze, uGlow, uMoonCol, uMilky;
  uniform vec3 uMoonDir, uMoonRight, uMoonUp;
  uniform vec3 uBandN, uBandA, uBandB;
  uniform float uMoonOn, uMilkyOn, uMoonSize;
  uniform vec2 uVillage;      // azimuth (rad), strength
  uniform float uFireAz;
  varying vec3 vDir;
  ${GLSL_COMMON}
  void main() {
    vec3 dir = normalize(vDir);
    float e = dir.y;                                  // sine of elevation
    float az = atan(dir.x, -dir.z);                   // 0 = straight ahead (-z), + = right

    // vertical gradient: haze -> low -> mid -> top, eased so the warm band hugs the horizon
    float h = max(e, 0.0);
    vec3 col = mix(uHaze, uLow, smoothstep(0.0, 0.16, h));
    col = mix(col, uMid, smoothstep(0.06, 0.42, h));
    col = mix(col, uTop, smoothstep(0.30, 0.95, h));

    // warm glow of the fire and the low air ahead, and a far village to the right
    float ga = az - uFireAz * 0.6;
    float ahead = exp(-ga * ga / 0.55);
    col += uGlow * ahead * exp(-h * 9.0) * 0.55;
    float dv = az - uVillage.x;
    col += uGlow * uVillage.y * exp(-dv * dv / 0.035) * exp(-h * 26.0);

    // faint Milky Way: a soft, broken band, kept off the horizon haze
    if (uMilkyOn > 0.5) {
      float bd = dot(dir, uBandN);
      float mask = exp(-bd * bd / 0.018);
      if (mask > 0.01) {
        float phi = atan(dot(dir, uBandB), dot(dir, uBandA));
        vec2 q = vec2(phi * 7.0, bd * 26.0);
        float n = vnoise(q) * 0.55 + vnoise(q * 2.3 + 4.1) * 0.3 + vnoise(q * 5.1 + 9.7) * 0.15;
        float rift = 1.0 - 0.75 * exp(-pow((bd - 0.03) * 22.0, 2.0)) * smoothstep(0.45, 0.75, vnoise(q * 0.7 + 2.0));
        col += uMilky * mask * smoothstep(0.3, 0.85, n) * rift * smoothstep(0.12, 0.5, h);
      }
    }

    // a low crescent moon veiled by haze, with a wide soft halo
    if (uMoonOn > 0.5) {
      float cm = dot(dir, uMoonDir);
      float ang = sqrt(max(2.0 * (1.0 - cm), 0.0));
      float veil = mix(0.55, 1.0, smoothstep(0.05, 0.35, h));
      col += uMoonCol * (exp(-ang * 7.0) * 0.07 + exp(-ang * 30.0) * 0.10) * veil;
      if (ang < uMoonSize * 1.6 && cm > 0.0) {
        vec2 p = vec2(dot(dir, uMoonRight), dot(dir, uMoonUp)) / uMoonSize;
        float r = length(p);
        float aa = 0.06;
        float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
        float shadow = 1.0 - smoothstep(0.98 - aa, 0.98 + aa, length(p - vec2(-0.42, 0.16)));
        float lit = disc * (1.0 - shadow);
        float mottle = 0.86 + 0.14 * vnoise(p * 3.1 + 7.0);
        col += uMoonCol * (lit * 0.95 * mottle + disc * shadow * 0.035) * veil;
      }
    }

    gl_FragColor = ditheredOutput(col, 1.0);
  }
`;

// ------------------------------------------------------------------ stars
const STAR_VERT = /* glsl */ `
  attribute float aBright;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime, uPx, uTwinkle;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 d = normalize(position);
    float fade = smoothstep(0.04, 0.34, d.y);          // sink into the horizon haze
    float amp = uTwinkle * (0.18 + 0.32 * (1.0 - d.y)); // scintillate more when low
    float tw = 1.0 - amp * (0.5 + 0.5 * sin(uTime * (0.45 + aPhase * 0.9) + aPhase * 37.0))
                         * (0.6 + 0.4 * sin(uTime * 0.23 + aPhase * 91.0));
    vAlpha = aBright * fade * tw;
    vColor = aColor;
    gl_PointSize = (2.2 + 3.8 * aBright * aBright) * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const STAR_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 5.0) + 0.25 * exp(-r2 * 2.2) * smoothstep(1.0, 0.4, r2);
    vec3 c = vColor * core * vAlpha;
    gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
  }
`;

// ------------------------------------------------------------------- land
const LAND_VERT = /* glsl */ `
  attribute float aDepth;
  varying float vDepth;
  varying vec3 vLocal;
  void main() {
    vDepth = aDepth;
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const LAND_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uNear, uMid, uFar, uHaze, uWarm;
  uniform vec2 uCenter;
  uniform float uWarmK, uFireAz;
  varying float vDepth;
  varying vec3 vLocal;
  ${GLSL_COMMON}
  void main() {
    float d = vDepth;
    vec3 col = d < 0.5 ? mix(uNear, uMid, d * 2.0) : mix(uMid, uFar, (d - 0.5) * 2.0);
    // low air holds more haze: lift the bases of every layer, more so far away
    float y = vLocal.y;
    float lowHaze = (1.0 - smoothstep(-0.5, 2.5 + d * 5.0, y)) * (0.10 + 0.45 * d);
    col = mix(col, uHaze, lowHaze);
    // faint warmth on the layers facing the fire (strongest ahead and near)
    vec2 rel = vLocal.xz - uCenter;
    float az = atan(rel.x, -rel.y);
    float fa = az - uFireAz;
    float warm = exp(-fa * fa / 0.22) * (1.0 - d) * (1.0 - smoothstep(0.0, 7.0, y));
    col += uWarm * warm * uWarmK;
    gl_FragColor = ditheredOutput(col, 1.0);
  }
`;

// ----------------------------------------------------------------- ground
const GROUND_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uNear, uFar, uHaze, uWarm;
  uniform vec2 uCenter, uFire;
  uniform float uPool;
  varying vec3 vLocal;
  ${GLSL_COMMON}
  void main() {
    float dist = length(vLocal.xz - uCenter);
    float s = smoothstep(3.0, 70.0, dist);
    vec3 col = mix(uNear, uFar, pow(s, 0.8));
    col = mix(col, uHaze, smoothstep(6.0, 75.0, dist) * 0.8);
    // gentle unevenness so the meadow is not a flat sheet
    col *= 0.9 + 0.2 * vnoise(vLocal.xz * 0.35);
    float fd = length(vLocal.xz - uFire);
    col += uWarm * uPool * exp(-fd * fd / 30.0);
    gl_FragColor = ditheredOutput(col, 1.0);
  }
`;

// ------------------------------------------------------------------- mist
const MIST_VERT = /* glsl */ `
  attribute vec2 aMist;   // x: arc coordinate (m), y: 0..1 height in band
  attribute float aLayer;
  varying vec2 vMist;
  varying float vLayer;
  void main() {
    vMist = aMist; vLayer = aLayer;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MIST_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uTime, uOpacity;
  varying vec2 vMist;
  varying float vLayer;
  ${GLSL_COMMON}
  void main() {
    float speed = mix(0.32, 0.18, vLayer);            // m/s, wind left -> right
    vec2 q = vec2((vMist.x - uTime * speed) * 0.045, vMist.y * 1.3 + vLayer * 7.0);
    float n = vnoise(q) * 0.6 + vnoise(q * 2.7 + vec2(3.1, 1.7) - vec2(uTime * 0.004, 0.0)) * 0.4;
    float body = smoothstep(0.3, 0.8, n);
    float shape = smoothstep(0.05, 0.5, vMist.y) * (1.0 - smoothstep(0.4, 1.0, vMist.y));
    float a = body * shape * uOpacity * mix(1.0, 0.8, vLayer);
    gl_FragColor = ditheredOutput(uColor, a);
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

  // palette from tokens (strings), lightly shaped per layer
  const tNightDeep = colorFrom(ctx, '--night-deep', '#130d0a');
  const tNight = colorFrom(ctx, '--night', '#1a120d');
  const tNightWarm = colorFrom(ctx, '--night-warm', '#26180f');
  const tHaze = colorFrom(ctx, '--night-haze', '#3a2214');
  const tFire = colorFrom(ctx, '--fire', '#f0842c');
  const tCream = colorFrom(ctx, '--cream', '#f4e6d0');

  const top = tNightDeep.clone().lerp(new THREE.Color('#0f0a08'), 0.35);
  const mid = tNight.clone();
  const low = tNightWarm.clone();
  const haze = tHaze.clone().lerp(tNightWarm, 0.18);
  const glow = tFire.clone().multiplyScalar(0.022);

  const group = new THREE.Group();
  group.name = 'sky';
  group.position.y = o.horizonY;
  ctx.scene.add(group);

  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  // ---------------------------------------------------------------- dome
  const moonAz = -0.4, moonEl = 0.29;
  const moonDir = new THREE.Vector3(Math.sin(moonAz) * Math.cos(moonEl), Math.sin(moonEl), -Math.cos(moonAz) * Math.cos(moonEl));
  const moonRight = new THREE.Vector3(0, 1, 0).cross(moonDir).normalize().negate();
  const moonUp = moonDir.clone().cross(moonRight).normalize().negate();
  // tilt the crescent a little, as it is when low in the evening
  const tilt = 0.5;
  const mr = moonRight.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(moonUp, Math.sin(tilt));
  const mu = moonUp.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(moonRight, -Math.sin(tilt));

  const bandN = new THREE.Vector3(-0.4925, -0.495, -0.6825).normalize();
  const bandA = new THREE.Vector3(0, 1, 0).cross(bandN).normalize();
  const bandB = bandN.clone().cross(bandA).normalize();

  const domeMat = track(new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uTop: { value: top }, uMid: { value: mid }, uLow: { value: low }, uHaze: { value: haze },
      uGlow: { value: glow },
      uMoonCol: { value: tCream.clone().lerp(new THREE.Color('#ffe2b8'), 0.4).multiplyScalar(0.62) },
      uMilky: { value: tCream.clone().multiplyScalar(0.008) },
      uMoonDir: { value: moonDir }, uMoonRight: { value: mr }, uMoonUp: { value: mu },
      uBandN: { value: bandN }, uBandA: { value: bandA }, uBandB: { value: bandB },
      uMoonOn: { value: o.moon ? 1 : 0 }, uMilkyOn: { value: o.milkyWay ? 1 : 0 },
      uMoonSize: { value: 0.0145 },
      uVillage: { value: new THREE.Vector2(0.95, 0.35) },
      uFireAz: { value: fireAz },
    },
  }));
  const domeGeo = track(new THREE.SphereGeometry(o.radius, 48, 24));
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -100;
  dome.frustumCulled = false;
  dome.name = 'sky-dome';
  group.add(dome);

  // --------------------------------------------------------------- stars
  const starCount = Math.round(o.starCount * (reduced ? 0.6 : 1));
  const sPos = new Float32Array(starCount * 3);
  const sBright = new Float32Array(starCount);
  const sPhase = new Float32Array(starCount);
  const sCol = new Float32Array(starCount * 3);
  const starR = o.radius * 0.94;
  const warmWhite = new THREE.Color('#fff1dc');
  const amber = new THREE.Color('#ffd7a0');
  const paleBlue = new THREE.Color('#e4e8f0');
  const tmpC = new THREE.Color();
  for (let i = 0; i < starCount; i++) {
    // pdf ∝ y: denser overhead, sparse near the horizon
    const y = 0.03 + 0.97 * Math.pow(rng(), 0.62);
    const phi = rng() * Math.PI * 2;
    const rr = Math.sqrt(1 - y * y);
    sPos[i * 3] = Math.cos(phi) * rr * starR;
    sPos[i * 3 + 1] = y * starR;
    sPos[i * 3 + 2] = Math.sin(phi) * rr * starR;
    let b = 0.1 + 0.55 * Math.pow(rng(), 3.2);
    if (i < 14) b = 0.72 + 0.28 * rng();          // a handful of brighter ones
    sBright[i] = b;
    sPhase[i] = rng();
    const k = rng();
    tmpC.copy(k < 0.12 ? amber : k > 0.9 ? paleBlue : warmWhite);
    tmpC.multiplyScalar(0.9);
    sCol[i * 3] = tmpC.r; sCol[i * 3 + 1] = tmpC.g; sCol[i * 3 + 2] = tmpC.b;
  }
  const starGeo = track(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(sBright, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(sPhase, 1));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
  const starMat = track(new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uPx: { value: 1 },
      uTwinkle: { value: reduced ? 0 : 1 },
    },
  }));
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -90;
  stars.frustumCulled = false;
  stars.name = 'sky-stars';
  group.add(stars);

  // ---------------------------------------------------------------- land
  const pos = [];
  const dep = [];
  let curDepth = 0;
  // place a 2D silhouette (local x along the arc tangent, y up) at angle th, distance R
  let bx = 0, bz = 0, tx = 0, tz = 0;
  const setBase = (th, R) => {
    bx = C.x + Math.sin(th) * R; bz = C.z - Math.cos(th) * R;
    tx = Math.cos(th); tz = Math.sin(th);
  };
  const tri = (x1, y1, x2, y2, x3, y3) => {
    pos.push(bx + tx * x1, y1, bz + tz * x1, bx + tx * x2, y2, bz + tz * x2, bx + tx * x3, y3, bz + tz * x3);
    dep.push(curDepth, curDepth, curDepth);
  };
  const quad = (x1, y1, x2, y2, x3, y3, x4, y4) => { tri(x1, y1, x2, y2, x3, y3); tri(x1, y1, x3, y3, x4, y4); };

  // Norway spruce: stacked, drooping, ragged tiers with a thin leader
  function spruce(H) {
    const W = H * (0.2 + 0.07 * rng());
    const n = Math.floor(8 + Math.min(H, 16) * 0.45 + rng() * 3);
    const lean = (rng() - 0.5) * 0.04 * H;
    quad(-0.025 * H, -1, 0.025 * H, -1, 0.02 * H, H * 0.3, -0.02 * H, H * 0.3);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const yb = H * (0.1 + 0.8 * f) + (rng() - 0.5) * H * 0.02;
      const yt = yb + H * (0.12 + 0.07 * rng()) * (1 - 0.35 * f);
      const w = W * Math.pow(1 - f, 0.9) * (0.7 + 0.5 * rng()) + 0.03 * H;
      const cx = lean * f;
      const wl = w * (0.75 + 0.5 * rng());
      const wr = w * (0.75 + 0.5 * rng());
      const notch = yb + (yt - yb) * (0.2 + 0.2 * rng());
      tri(cx, yt, cx - wl, yb - H * 0.035 * rng(), cx, notch);
      tri(cx, yt, cx, notch, cx + wr, yb - H * 0.035 * rng());
      // an occasional stray branch tip breaking the outline
      if (rng() < 0.35) {
        const s = rng() < 0.5 ? -1 : 1;
        const bw = (s < 0 ? wl : wr);
        tri(cx + s * bw * 0.5, yb + (yt - yb) * 0.35, cx + s * bw * (1.12 + 0.25 * rng()), yb - H * 0.02, cx + s * bw * 0.55, yb + (yt - yb) * 0.05);
      }
    }
    tri(lean - 0.018 * H, H * 0.86, lean + 0.018 * H, H * 0.86, lean * 1.05 + (rng() - 0.5) * 0.01 * H, H * (1 + 0.03 * rng()));
  }

  // Scots pine: tall bare trunk, a few flat, ragged crown clumps on top
  function scotsPine(H) {
    const W = H * (0.2 + 0.1 * rng());
    const bend = (rng() - 0.5) * 0.08 * H;
    const tw = 0.02 * H + 0.06;
    const yTop = H * (0.62 + 0.08 * rng());
    quad(-tw, -1, tw, -1, bend * 0.4 + tw * 0.8, yTop * 0.5, bend * 0.4 - tw * 0.8, yTop * 0.5);
    quad(bend * 0.4 - tw * 0.8, yTop * 0.5, bend * 0.4 + tw * 0.8, yTop * 0.5, bend + tw * 0.55, yTop, bend - tw * 0.55, yTop);
    // crown: a dense, irregular mass of overlapping tufts, slightly flat-topped,
    // with one or two looser tufts hanging off the side
    const crownCy = yTop + (H - yTop) * 0.55;
    const crownCx = bend + (rng() - 0.5) * W * 0.25;
    const clumps = 6 + Math.floor(rng() * 4);
    for (let k = 0; k < clumps; k++) {
      const loose = k >= clumps - 2 && rng() < 0.6;
      const ang = rng() * Math.PI * 2;
      const rad = loose ? 0.75 + 0.3 * rng() : Math.sqrt(rng()) * 0.6;
      const cx = crownCx + Math.cos(ang) * rad * W * 0.62;
      const cy = Math.min(H * 0.93, crownCy + Math.sin(ang) * rad * (H - yTop) * 0.38);
      const rx = W * (loose ? 0.18 + 0.12 * rng() : 0.24 + 0.16 * rng());
      const ry = rx * (0.55 + 0.25 * rng());
      if (loose || rng() < 0.3) tri(bend, yTop - 0.04 * H, bend, yTop + 0.02 * H, cx, cy - ry * 0.3);
      const seg = 16;
      let px = 0, py = 0, fx = 0, fy = 0;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const sa = Math.sin(a);
        const jag = sa > -0.2 ? 0.62 + 0.55 * rng() : 0.9 + 0.15 * rng();
        const x = cx + Math.cos(a) * rx * jag;
        const y = cy + sa * ry * jag * (sa > 0 ? 1.0 : 0.65);
        if (s > 0) tri(cx, cy, px, py, x, y); else { fx = x; fy = y; }
        px = s === seg ? fx : x; py = s === seg ? fy : y;
      }
    }
  }

  // Columnar juniper, very Polish heath
  function juniper(H) {
    const W = H * (0.14 + 0.06 * rng());
    const n = 6;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const yb = H * f * 0.85 - 0.3;
      const yt = H * (f + 0.32) * 0.85;
      const w = W * (0.6 + 0.6 * Math.sin(Math.PI * (0.25 + 0.7 * f))) * (0.8 + 0.35 * rng());
      tri(-w, yb, w * (0.8 + 0.3 * rng()), yb, (rng() - 0.5) * W * 0.4, Math.min(yt, H));
    }
  }

  // ridgeline strip from y=-3 to profile(th) at distance R
  function ridge(R, thMin, thMax, segs, profile) {
    let prevTh = thMin, prevH = profile(thMin);
    for (let s = 1; s <= segs; s++) {
      const th = thMin + (thMax - thMin) * (s / segs);
      const h = profile(th);
      const x0 = C.x + Math.sin(prevTh) * R, z0 = C.z - Math.cos(prevTh) * R;
      const x1 = C.x + Math.sin(th) * R, z1 = C.z - Math.cos(th) * R;
      pos.push(x0, -3, z0, x1, -3, z1, x1, h, z1, x0, -3, z0, x1, h, z1, x0, prevH, z0);
      for (let k = 0; k < 6; k++) dep.push(curDepth);
      prevTh = th; prevH = h;
    }
  }

  const SPAN = 1.95; // radians each side of straight ahead
  const gap = (th) => 1 - o.gapDepth * Math.exp(-(th * th) / (o.gapWidth * o.gapWidth));

  // far ridge: very faint, long and low
  curDepth = 1.0;
  ridge(o.ridgeDistance, -SPAN - 0.1, SPAN + 0.1, 700, (th) =>
    3.2 + 5.5 * noise.fbm(th * 1.1 + 10, 4) - 1.2 + 0.18 * noise(th * 260));

  // rolling hills with a fuzz of distant forest on top
  curDepth = 0.78;
  ridge(o.hillsDistance, -SPAN - 0.1, SPAN + 0.1, 1600, (th) => {
    const base = 1.0 + 5.2 * Math.pow(noise.fbm(th * 1.7 + 3.3, 4), 1.4);
    const forest = noise.fbm(th * 9 + 40, 2) > 0.48 ? 0.9 + 0.5 * Math.abs(noise(th * 420) - 0.5) * 2 : 0.15;
    return base + forest * (0.5 + 0.35 * noise(th * 1300));
  });

  // the treeline: a forest edge of spruce and Scots pine, dipping behind the fire
  const TL = o.treelineDistance;
  curDepth = 0.45;
  // understory mass so no sky shows between trunks
  ridge(TL + 3, -SPAN, SPAN, 900, (th) => (2.6 + 2.2 * noise.fbm(th * 6 + 70, 3) + 0.4 * noise(th * 600)) * gap(th));
  for (let row = 0; row < 2; row++) {
    const R0 = TL + (row === 0 ? 4.5 : 0);
    let th = -SPAN;
    while (th < SPAN) {
      const dens = noise.fbm(th * 3.1 + 21 + row * 5, 3); // stands and thinner patches
      const g = gap(th);
      const stand = 0.65 + 0.7 * dens;
      const H = o.treeHeight * (row === 0 ? 1 : 0.82) * stand * g * (0.75 + 0.5 * rng());
      setBase(th, R0 + (rng() - 0.5) * 2.5);
      if (H > 2.5) {
        if (g > 0.85 && rng() < (row === 0 ? 0.3 : 0.15)) scotsPine(H * 1.05); else spruce(H);
      }
      const step = (0.9 + 1.6 * rng()) * (1.3 - 0.6 * dens) * (row === 0 ? 1 : 1.25);
      th += step / R0;
    }
  }

  // near layer: a few young pines, junipers and bushes, kept to the sides
  curDepth = 0.0;
  const ND = o.nearDistance;
  let th = -SPAN;
  while (th < SPAN) {
    const side = Math.abs(th);
    const clump = noise.fbm(th * 4 + 90, 2);
    const allowed = side > 0.42 && clump > 0.42;
    if (allowed) {
      setBase(th, ND + (rng() - 0.5) * 5);
      const k = rng();
      if (k < 0.35) spruce(2.4 + 4.2 * rng() * (0.6 + side * 0.4));
      else juniper(1.3 + 1.8 * rng());
      th += (1.0 + 2.4 * rng()) / ND;
    } else {
      th += (2.5 + 3.0 * rng()) / ND;
    }
  }

  const landGeo = track(new THREE.BufferGeometry());
  landGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  landGeo.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
  landGeo.computeBoundingSphere();

  const landNear = new THREE.Color('#0b0705');
  const landMid = new THREE.Color('#130c08');
  const landFar = haze.clone().lerp(low, 0.35).multiplyScalar(0.82);
  const landMat = track(new THREE.ShaderMaterial({
    vertexShader: LAND_VERT,
    fragmentShader: LAND_FRAG,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    uniforms: {
      uNear: { value: landNear }, uMid: { value: landMid }, uFar: { value: landFar },
      uHaze: { value: haze.clone() },
      uWarm: { value: tFire.clone().multiplyScalar(0.012) },
      uWarmK: { value: 1 },
      uFireAz: { value: fireAz },
      uCenter: { value: new THREE.Vector2(C.x, C.z) },
    },
  }));
  const land = new THREE.Mesh(landGeo, landMat);
  land.name = 'sky-land';
  land.renderOrder = -50;
  group.add(land);

  // -------------------------------------------------------------- ground
  const groundGeo = track(new THREE.CircleGeometry(o.radius - 1, 128));
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(C.x, 0, C.z);
  const groundMat = track(new THREE.ShaderMaterial({
    vertexShader: LAND_VERT.replace('attribute float aDepth;', 'float aDepth = 0.0;'),
    fragmentShader: GROUND_FRAG,
    fog: false,
    toneMapped: false,
    uniforms: {
      uNear: { value: new THREE.Color('#0a0604') },
      uFar: { value: new THREE.Color('#150d09') },
      uHaze: { value: haze.clone() },
      uWarm: { value: tFire.clone() },
      uPool: { value: 0.0045 },
      uCenter: { value: new THREE.Vector2(C.x, C.z) },
      uFire: { value: new THREE.Vector2(o.firePosition.x, o.firePosition.z) },
    },
  }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'sky-ground';
  ground.renderOrder = -60;
  group.add(ground);

  // ---------------------------------------------------------------- mist
  let mistMat = null;
  if (o.mist) {
    const mp = [], ma = [], ml = [];
    const band = (R, H, layer) => {
      const segs = 160;
      for (let s = 0; s < segs; s++) {
        const a0 = -SPAN + (2 * SPAN * s) / segs, a1 = -SPAN + (2 * SPAN * (s + 1)) / segs;
        const x0 = C.x + Math.sin(a0) * R, z0 = C.z - Math.cos(a0) * R;
        const x1 = C.x + Math.sin(a1) * R, z1 = C.z - Math.cos(a1) * R;
        const u0 = a0 * R, u1 = a1 * R;
        mp.push(x0, -0.2, z0, x1, -0.2, z1, x1, H, z1, x0, -0.2, z0, x1, H, z1, x0, H, z0);
        ma.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
        for (let k = 0; k < 6; k++) ml.push(layer);
      }
    };
    band((o.nearDistance + o.treelineDistance) / 2 + 2, 3.4, 0);
    band((o.treelineDistance + o.hillsDistance) / 2 + 2, 5.0, 1);
    const mistGeo = track(new THREE.BufferGeometry());
    mistGeo.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mistGeo.setAttribute('aMist', new THREE.Float32BufferAttribute(ma, 2));
    mistGeo.setAttribute('aLayer', new THREE.Float32BufferAttribute(ml, 1));
    mistMat = track(new THREE.ShaderMaterial({
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: haze.clone().lerp(tFire, 0.06) },
        uTime: { value: 0 },
        uOpacity: { value: 0.32 },
      },
    }));
    const mist = new THREE.Mesh(mistGeo, mistMat);
    mist.name = 'sky-mist';
    mist.renderOrder = -40;
    group.add(mist);
  }

  // ------------------------------------------------------------- handle
  const fogColor = haze.clone().lerp(low, 0.45);
  const fogNear = 14;
  const fogFar = 72;

  function resize(width, height) {
    const pr = ctx.renderer && ctx.renderer.getPixelRatio ? ctx.renderer.getPixelRatio() : 1;
    const h = height || (typeof window !== 'undefined' ? window.innerHeight : 1000);
    starMat.uniforms.uPx.value = pr * Math.min(1.25, Math.max(0.75, h / 1000));
  }
  resize(typeof window !== 'undefined' ? window.innerWidth : 1920, typeof window !== 'undefined' ? window.innerHeight : 1000);

  function update(timeSec /* , dtSec */) {
    // the sky sits at infinity: keep the dome and stars centred on the camera
    const cp = ctx.camera.position;
    dome.position.set(cp.x, cp.y - o.horizonY, cp.z);
    stars.position.copy(dome.position);
    if (!reduced) {
      starMat.uniforms.uTime.value = timeSec;
      if (mistMat) mistMat.uniforms.uTime.value = timeSec;
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  }

  return { group, update, resize, dispose, fogColor, fogNear, fogFar };
}

export default createSky;
