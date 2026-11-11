/*
  OWNER: Opus worker "strings". Spec: scene-modules-spec.md (createStrings).

  createStrings(ctx, opts) -> handle
    opts.count         number of strings (default 5, max 12; the core passes --strings-count)
    opts.extents       drift volume {xMin,xMax,yMin,yMax,zMin,zMax}
    opts.firePosition  THREE.Vector3, where the firelight comes from (default (-3, 0.7, -2))
    opts.seed          layout seed (default 7)

  handle = { group, update, resize, dispose, touch, pluckNearest, nearestPoint }
           (+ strings, tune, applyTune, state: for tuning only)

  LOOK
    One draw call. Every string is a camera-facing ribbon expanded in SCREEN space in the
    vertex shader, so its width is set in pixels: a hairline core (anti-aliased, sub-pixel
    strings dim instead of thinning) plus a soft gaussian halo. Strings are lit by the fire
    (brighter and more amber near it), fade with distance and dissolve at their ends.

  PHYSICS
    Each string is a damped vibrating string: 8 standing-wave modes, each a damped harmonic
    oscillator integrated exactly on the CPU (count x 8 oscillators, trivial). The waves run
    between two nodes placed just outside the view (recomputed on resize), so a pluck reads
    as a standing wave across the screen. A pluck at p is a velocity impulse giving mode n an
    amplitude proportional to sin(n*pi*p)/n^2, so the string swells from rest rather than
    jumping. Modes too fast to follow at 60 fps only blur. While it moves, the string draws
    the band it sweeps (brighter at its edges, like a long exposure), and a warm bloom
    spreads from the pluck point and fades over ~1.5 s.

  TOUCH AND PLUCK (as seen from the camera; words are drawn over the strings, so what
    matters is what the eye sees)
    touch(prev, pos): a word crosses a string when it changes side of the plane through the
      camera and the string. That string then shivers softly at the crossing point and
      ignores touches for TUNE.touchCooldown s. Returns true on a touch. Allocation-free.
    pluckNearest(pos, strength): plucks the string that looks nearest to pos, at the point
      that looks nearest.
    nearestPoint(pos): the nearest rest point in 3D (shared vector, copy it).

  REDUCED MOTION: still strings. touch and pluckNearest do nothing; no glints or shimmer.
*/
import * as THREE from 'three';

const MAX_STRINGS = 12;
const MODES = 8;
const SEGMENTS = 220;

// Look and motion knobs that are not design tokens.
export const TUNE = {
  span: 1.55,          // strings extend this many times past the drift volume in x
  f1Min: 4.2,          // Hz, fundamental range (visual, not audible): fast enough to read
  f1Max: 5.4,          //   as a vibrating string, slow enough to follow at 60 fps
  maxVisibleHz: 24,    // modes above this only blur the string (no displacement): no aliasing
  inharmonic: 0.003,   // f_n = n f1 (1 + k n^2): a little stiffness, less mechanical
  tau1: 0.62,          // s, amplitude decay time of the fundamental
  tauHigh: 0.45,       // higher modes decay faster: tau_n = tau1 / (1 + tauHigh (n-1))
  pluckAngle: 0.009,   // rad, peak displacement seen from the camera for pluckNearest(…, 1)
  touchAngle: 0.0028,  // rad, a word drifting across a string
  touchStrength: 0.4,  // bloom strength of a touch
  touchCooldown: 1.1,  // s, per string
  coreWidth: 0.6,      // px (CSS), half-width of the bright filament at the near end
  haloWidth: 4.0,      // px (CSS), gaussian radius of the glow
  envBlur: 0.12,       // px of extra halo per px of vibration envelope
  restCore: 0.15,      // core intensity at rest
  restHalo: 0.02,       // halo intensity at rest
  bloomCore: 1.3,      // extra core intensity at full bloom
  bloomHalo: 0.04,     // extra halo intensity at full bloom
  fireRadius: 11,      // m, falloff of firelight on the strings
  fireBoost: 0.9,      // how much brighter the strings are near the fire
  glint: 0.35,         // travelling highlights from the firelight (0 = off)
  shimmer: 0.06,       // idle brightness shimmer
  fadeNear: 10,        // m from camera: full brightness
  fadeFar: 42,         // m from camera: faded to fadeMin
  fadeMin: 0.18,
  endFade: 0.16,       // fraction of the length over which each end dissolves
  nodeMargin: 0.06,    // vibration nodes sit this fraction of the visible length past each edge
  ghost: 0.6,         // brightness of the swept band of a vibrating string (vs the core)
};

function parseColor(str, fbHex, fbAlpha) {
  const c = new THREE.Color(fbHex);
  let a = fbAlpha;
  if (typeof str === 'string') {
    const s = str.trim();
    const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/i);
    if (m) {
      c.setRGB(+m[1] / 255, +m[2] / 255, +m[3] / 255, THREE.SRGBColorSpace);
      if (m[4] !== undefined) a = +m[4];
    } else if (s[0] === '#') {
      try { c.set(s); } catch (e) { /* keep fallback */ }
    }
  }
  return { color: c, alpha: a };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const vertexShader = /* glsl */ `
#define MAXS ${MAX_STRINGS}
#define PI 3.141592653589793
uniform vec4 uA[MAXS];      // xyz start, w length
uniform vec4 uB[MAXS];      // xyz end, w near-ness 0..1 (width/brightness scale)
uniform vec3 uDir[MAXS];    // displacement direction (unit, mostly up)
uniform vec4 uQa[MAXS];     // mode displacements 1..4 (m)
uniform vec4 uQb[MAXS];     // mode displacements 5..8
uniform vec4 uEa[MAXS];     // mode amplitude envelopes 1..4 (m)
uniform vec4 uEb[MAXS];
uniform vec4 uPluck[MAXS];  // x: u0, y: age s, z: strength, w: string seed
uniform vec2 uNode[MAXS];   // u of the two vibration nodes (just outside the view)
uniform vec2 uRes;          // drawing buffer px
uniform float uPR;          // pixel ratio
uniform float uTime;
uniform float uMotion;      // 0 under reduced motion
uniform vec3 uFire;
uniform vec4 uTune0;        // coreWidth, haloWidth, envBlur, fireRadius
uniform vec4 uTune1;        // restCore, restHalo, bloomCore, bloomHalo
uniform vec4 uTune2;        // fireBoost, glint, shimmer, endFade
uniform float uGhost;       // brightness of the swept band of a vibrating string
uniform vec3 uFade;         // near, far, min

attribute float aSide;

varying float vPx;          // signed distance from the centre line, px
varying float vCoreW;
varying float vHaloW;
varying float vCoreI;
varying float vHaloI;
varying float vBloom;
varying float vFire;
varying float vOff;         // px, displaced centre minus rest line, along the ribbon normal
varying float vEnv;         // px, vibration envelope (half-width of the swept band)
varying float vGhostI;

void modeSines(float u, out vec4 a, out vec4 b) {
  float x = PI * u;
  a = vec4(sin(x), sin(2.0 * x), sin(3.0 * x), sin(4.0 * x));
  b = vec4(sin(5.0 * x), sin(6.0 * x), sin(7.0 * x), sin(8.0 * x));
}

vec3 stringPos(int i, float u, out float env) {
  vec4 sa, sb;
  // Standing waves between the nodes; outside them the string stays still.
  float uv = clamp((u - uNode[i].x) / (uNode[i].y - uNode[i].x), 0.0, 1.0);
  modeSines(uv, sa, sb);
  float y = dot(uQa[i], sa) + dot(uQb[i], sb);
  env = dot(uEa[i], abs(sa)) + dot(uEb[i], abs(sb));
  return mix(uA[i].xyz, uB[i].xyz, u) + uDir[i] * (y * uMotion);
}

void main() {
  int i = int(position.z + 0.5);
  float u = position.x;
  float L = uA[i].w;
  float nearness = uB[i].w;

  float env, envN;
  vec3 p0 = stringPos(i, u, env);
  float du = u < 0.995 ? 0.004 : -0.004;
  vec3 p1 = stringPos(i, u + du, envN);

  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vec4 vp = viewMatrix * wp;
  vec4 c0 = projectionMatrix * vp;
  vec4 c1 = projectionMatrix * viewMatrix * modelMatrix * vec4(p1, 1.0);

  vec2 halfRes = 0.5 * uRes;
  vec2 s0 = c0.xy / c0.w * halfRes;
  vec2 s1 = c1.xy / c1.w * halfRes;
  vec2 t = s1 - s0;
  t = length(t) > 1e-5 ? normalize(t) : vec2(1.0, 0.0);
  if (du < 0.0) t = -t;
  vec2 n = vec2(-t.y, t.x);

  // Envelope in px: world metres -> px at this depth.
  float pxPerM = projectionMatrix[1][1] * halfRes.y / max(-vp.z, 0.1);
  float envPx = env * pxPerM * uMotion;

  // Firelight, glints, shimmer, pluck bloom.
  float df = distance(wp.xyz, uFire);
  float fireT = exp(-(df * df) / (uTune0.w * uTune0.w));
  float fire = 1.0 + uTune2.x * fireT;
  vFire = fireT;
  float seed = uPluck[i].w;
  float s = u * L;
  float g1 = pow(0.5 + 0.5 * sin(s * 0.21 - uTime * 0.23 + seed * 6.1), 28.0);
  float g2 = pow(0.5 + 0.5 * sin(s * 0.13 + uTime * 0.17 + seed * 2.3), 36.0);
  float glint = uTune2.y * (g1 + 0.7 * g2) * fire;
  float shimmer = 1.0 + uTune2.z * sin(uTime * 0.9 + s * 0.7 + seed * 11.0) * sin(uTime * 0.37 + s * 0.23);

  float age = uPluck[i].y;
  float spread = 0.8 + age * 9.0;           // the bloom widens along the string, in m
  float ds = (u - uPluck[i].x) * L;
  float bloom = uPluck[i].z * exp(-age / 0.75) * exp(-(ds * ds) / (spread * spread));
  float envGlow = clamp(env / 0.08, 0.0, 1.0); // bright where it is moving
  bloom = clamp(bloom + 0.3 * envGlow, 0.0, 1.4);

  // Distance fade and end fade.
  float dist = -vp.z;
  float fade = mix(1.0, uFade.z, smoothstep(uFade.x, uFade.y, dist));
  float ends = smoothstep(0.0, uTune2.w, u) * (1.0 - smoothstep(1.0 - uTune2.w, 1.0, u));
  fade *= ends;

  // Widths in px. Sub-pixel cores keep 0.7 px and dim instead.
  float coreW = uTune0.x * uPR * mix(0.55, 1.0, nearness);
  float coreDim = 1.0;
  if (coreW < 0.7 * uPR) { coreDim = coreW / (0.7 * uPR); coreW = 0.7 * uPR; }
  float haloW = uTune0.y * uPR * mix(0.6, 1.0, nearness) + min(envPx * uTune0.z, 6.0 * uPR) + bloom * 1.0 * uPR;

  vCoreW = coreW;
  vHaloW = haloW;
  float lum = fade * fire * shimmer;
  vCoreI = (uTune1.x * lum + uTune1.z * bloom * fade + glint * fade) * coreDim
         // a blurred, vibrating core spreads its light: keep energy roughly constant
         / (1.0 + 0.08 * envPx / uPR);
  vHaloI = uTune1.y * lum + uTune1.w * bloom * fade + 0.25 * glint * fade;
  vBloom = bloom;

  // The swept band: where the string has been this cycle, like a long exposure.
  vec4 cr = projectionMatrix * viewMatrix * modelMatrix * vec4(mix(uA[i].xyz, uB[i].xyz, u), 1.0);
  vec2 sr = cr.xy / cr.w * halfRes;
  vOff = dot(s0 - sr, n);
  vEnv = envPx;
  float envCss = envPx / uPR;
  vGhostI = uGhost * (uTune1.x * lum + uTune1.z * bloom * fade) * smoothstep(0.8, 3.0, envCss)
          * 3.0 / (3.0 + envCss);

  float extent = max(haloW * 2.6 + coreW + 1.5, abs(vOff) + envPx + 2.0 * uPR);
  vPx = aSide * extent;
  c0.xy += n * (aSide * extent) / halfRes * c0.w;
  gl_Position = c0;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uHaloColor;
uniform vec3 uBloomColor;
uniform vec3 uFireColor;
varying float vPx;
varying float vCoreW;
varying float vHaloW;
varying float vCoreI;
varying float vHaloI;
varying float vBloom;
varying float vFire;
varying float vOff;
varying float vEnv;
varying float vGhostI;

void main() {
  float d = abs(vPx);
  float core = 1.0 - smoothstep(vCoreW - 0.6, vCoreW + 0.6, d);
  float x = d / max(vHaloW, 0.5);
  float halo = exp(-x * x);
  // Near the fire the strings take on its colour; a pluck blooms toward warm cream.
  vec3 coreCol = mix(uCoreColor, uFireColor, 0.55 * vFire);
  vec3 haloCol = mix(mix(uHaloColor, uFireColor, 0.5 * vFire), uBloomColor, clamp(vBloom, 0.0, 1.0));
  vec3 col = coreCol * core * vCoreI + haloCol * halo * vHaloI;
  if (vGhostI > 0.0) {
    // A vibrating string lingers at its extremes, so the band is brighter at its edges.
    float dr = abs(vPx + vOff);
    float band = 1.0 - smoothstep(vEnv - 1.5, vEnv + 1.0, dr);
    float g = clamp(dr / max(vEnv, 1.0), 0.0, 1.0);
    g *= g;
    col += mix(uHaloColor, uFireColor, 0.5) * band * (0.1 + 0.9 * g * g) * vGhostI;
  }
  gl_FragColor = vec4(col, clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

// The most recent live handle, for tuning from the console of the real site:
//   (await import('/js/scene/strings.js')).debugHandle()
// Module scoped, so it is not a global side effect.
let lastHandle = null;
export function debugHandle() { return lastHandle; }

export function createStrings(ctx, opts = {}) {
  const { scene, camera, renderer } = ctx;
  const readToken = ctx.readToken || ((n, fb) => fb);
  const reducedMotion = !!ctx.reducedMotion;
  const count = Math.max(1, Math.min(MAX_STRINGS, opts.count ?? 5));
  const ext = Object.assign({ xMin: -16, xMax: 16, yMin: 0.8, yMax: 6.5, zMin: -22, zMax: 2 }, opts.extents || {});
  const firePos = new THREE.Vector3().copy(opts.firePosition || new THREE.Vector3(-3, 0.7, -2));
  const rand = mulberry32(opts.seed ?? 7);

  const group = new THREE.Group();
  group.name = 'strings';

  // ---- Layout: a guitar neck seen in perspective, fanning slightly to the right. ----
  const A = [], B = [], D = [], NUP = [], NDEP = [], LEN = new Float32Array(count);
  // The neck: every string runs from low and near on the left (upwind) to high and far on
  // the right, so the set converges in perspective like a neck seen from the headstock side.
  // Spacing opens slightly toward the far end (the fan); small jitter keeps it hand-strung.
  const cx = (ext.xMin + ext.xMax) / 2, hw = (ext.xMax - ext.xMin) / 2 * TUNE.span;
  const ySpan = ext.yMax - ext.yMin;
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    const j = (rand() - 0.5) * 0.35;
    const yl = ext.yMin + ySpan * (0.02 + 0.5 * f) + j + (rand() - 0.5) * 0.25;
    const yr = ext.yMin + ySpan * (0.92 + 0.5 * f) + j * 1.6 + (rand() - 0.5) * 0.4;
    const zl = ext.zMax - 0.5 - 2.2 * f - rand() * 0.8;
    const zr = ext.zMin - 3 - 5 * f - rand() * 2;
    const a = new THREE.Vector3(cx - hw, yl, zl);
    const b = new THREE.Vector3(cx + hw, yr, zr);
    A.push(a); B.push(b);
    const d = new THREE.Vector3().subVectors(b, a);
    LEN[i] = d.length();
    d.normalize();
    D.push(d);
    const up = new THREE.Vector3(0, 1, 0);
    up.addScaledVector(d, -up.dot(d)).normalize();
    NUP.push(up);
    NDEP.push(new THREE.Vector3().crossVectors(d, up).normalize());
  }

  // ---- Physics state ----
  const N = count * MODES;
  const NODE = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { NODE[i * 2] = 0.2; NODE[i * 2 + 1] = 0.8; }
  const vis = new Float32Array(N);
  const q = new Float32Array(N), v = new Float32Array(N), w = new Float32Array(N), gam = new Float32Array(N), wdamp = new Float32Array(N);
  const pluckU = new Float32Array(count), pluckAge = new Float32Array(count).fill(99), pluckStr = new Float32Array(count);
  const lastTouch = new Float32Array(count).fill(-99);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = rand();
    const f1 = TUNE.f1Min + (TUNE.f1Max - TUNE.f1Min) * (count === 1 ? 0.5 : (count - 1 - i) / (count - 1));
    for (let n = 1; n <= MODES; n++) {
      const k = i * MODES + n - 1;
      w[k] = 2 * Math.PI * f1 * n * (1 + TUNE.inharmonic * n * n);
      gam[k] = (1 + TUNE.tauHigh * (n - 1)) / TUNE.tau1;
      wdamp[k] = Math.sqrt(Math.max(w[k] * w[k] - gam[k] * gam[k], 1));
      // Modes faster than the eye can follow at 60 fps only widen the blur.
      vis[k] = Math.min(1, Math.max(0, (TUNE.maxVisibleHz - w[k] / (2 * Math.PI)) / 4));
    }
  }
  let now = 0;

  // Camera position (the camera only translates; refreshed every update) and, per string,
  // the normal of the plane through the camera and the string: a word crosses the string
  // on screen exactly when it changes side of that plane.
  const cam = new THREE.Vector3();
  camera.updateMatrixWorld();
  cam.setFromMatrixPosition(camera.matrixWorld);
  const PN = new Float32Array(count * 3);
  function updatePlanes() {
    for (let i = 0; i < count; i++) {
      const a = A[i], d = D[i];
      const ax = a.x - cam.x, ay = a.y - cam.y, az = a.z - cam.z;
      let nx = ay * d.z - az * d.y, ny = az * d.x - ax * d.z, nz = ax * d.y - ay * d.x;
      const l = Math.hypot(nx, ny, nz) || 1;
      PN[i * 3] = nx / l; PN[i * 3 + 1] = ny / l; PN[i * 3 + 2] = nz / l;
    }
  }
  updatePlanes();

  // ---- Colours from tokens ----
  const rest = parseColor(readToken('--string', 'rgba(244, 230, 208, 0.10)'), 0xf4e6d0, 0.1);
  const bright = parseColor(readToken('--string-bright', 'rgba(255, 217, 160, 0.38)'), 0xffd9a0, 0.38);
  const ember = parseColor(readToken('--fire', '#f0842c'), 0xf0842c, 1);
  const coreColor = rest.color.clone().lerp(bright.color, 0.35);
  const haloColor = ember.color.clone().lerp(bright.color, 0.45);
  const bloomColor = bright.color.clone();
  const fireColor = ember.color.clone().lerp(bright.color, 0.25);

  // ---- Geometry: (SEGMENTS+1) x 2 vertices per string, merged. ----
  const vpS = (SEGMENTS + 1) * 2;
  const pos = new Float32Array(count * vpS * 3);
  const side = new Float32Array(count * vpS);
  const idx = new Uint32Array(count * SEGMENTS * 6);
  let pi = 0, si = 0, ii = 0;
  for (let i = 0; i < count; i++) {
    const base = i * vpS;
    for (let j = 0; j <= SEGMENTS; j++) {
      const u = j / SEGMENTS;
      for (let s = -1; s <= 1; s += 2) {
        pos[pi++] = u; pos[pi++] = 0; pos[pi++] = i;
        side[si++] = s;
      }
      if (j < SEGMENTS) {
        const a = base + j * 2;
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
        idx[ii++] = a + 1; idx[ii++] = a + 3; idx[ii++] = a + 2;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));

  const vec4s = () => Array.from({ length: MAX_STRINGS }, () => new THREE.Vector4());
  const uniforms = {
    uA: { value: vec4s() }, uB: { value: vec4s() },
    uDir: { value: Array.from({ length: MAX_STRINGS }, () => new THREE.Vector3(0, 1, 0)) },
    uQa: { value: vec4s() }, uQb: { value: vec4s() }, uEa: { value: vec4s() }, uEb: { value: vec4s() },
    uPluck: { value: vec4s() },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPR: { value: 1 },
    uTime: { value: 0 },
    uMotion: { value: reducedMotion ? 0 : 1 },
    uFire: { value: firePos },
    uTune0: { value: new THREE.Vector4() }, uTune1: { value: new THREE.Vector4() }, uTune2: { value: new THREE.Vector4() },
    uFade: { value: new THREE.Vector3() },
    uGhost: { value: 0 },
    uNode: { value: Array.from({ length: MAX_STRINGS }, () => new THREE.Vector2(0, 1)) },
    uCoreColor: { value: coreColor }, uHaloColor: { value: haloColor }, uBloomColor: { value: bloomColor }, uFireColor: { value: fireColor },
  };
  for (let i = 0; i < count; i++) {
    uniforms.uA.value[i].set(A[i].x, A[i].y, A[i].z, LEN[i]);
    // Near-ness from the midpoint's distance to the camera.
    const mx = (A[i].x + B[i].x) / 2, my = (A[i].y + B[i].y) / 2, mz = (A[i].z + B[i].z) / 2;
    const dist = Math.hypot(mx - cam.x, my - cam.y, mz - cam.z);
    uniforms.uB.value[i].set(B[i].x, B[i].y, B[i].z, THREE.MathUtils.clamp(1 - (dist - 12) / 24, 0, 1));
    // Mostly vertical, with a little depth so the motion is slightly elliptical in perspective.
    uniforms.uDir.value[i].copy(NUP[i]).addScaledVector(NDEP[i], 0.25).normalize();
    uniforms.uPluck.value[i].set(0.5, 99, 0, seeds[i]);
  }
  function applyTune() {
    uniforms.uTune0.value.set(TUNE.coreWidth, TUNE.haloWidth, TUNE.envBlur, TUNE.fireRadius);
    uniforms.uTune1.value.set(TUNE.restCore, TUNE.restHalo, TUNE.bloomCore, TUNE.bloomHalo);
    uniforms.uTune2.value.set(TUNE.fireBoost, reducedMotion ? 0 : TUNE.glint, reducedMotion ? 0 : TUNE.shimmer, TUNE.endFade);
    uniforms.uFade.value.set(TUNE.fadeNear, TUNE.fadeFar, TUNE.fadeMin);
    uniforms.uGhost.value = TUNE.ghost;
  }
  applyTune();

  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    // Additive light that also works on an alpha:true (premultiplied) canvas: colour adds,
    // alpha grows with the light so the CSS backdrop is not over-brightened.
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  group.add(mesh);
  scene.add(group);

  // ---- Excitation ----
  // Displacement caps (m), from each string's distance at mid-length, so repeated plucks
  // never grow past ~1.6 times a full pluck seen from the camera.
  const capM = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const mx = (A[i].x + B[i].x) / 2 - cam.x, my = (A[i].y + B[i].y) / 2 - cam.y, mz = (A[i].z + B[i].z) / 2 - cam.z;
    capM[i] = 1.6 * TUNE.pluckAngle * Math.hypot(mx, my, mz);
  }
  function excite(i, uFull, amp, glow) {
    if (reducedMotion) return;      // still strings: no vibration, no bloom
    const lo = NODE[i * 2], hi = NODE[i * 2 + 1];
    const u = Math.min(0.96, Math.max(0.04, (uFull - lo) / (hi - lo)));
    // displacement of the summed shape at the pluck point, to normalise
    let dAt = 0;
    for (let n = 1; n <= MODES; n++) { const s = Math.sin(n * Math.PI * u); dAt += s * s / (n * n); }
    const scale = amp / Math.max(dAt, 0.2);
    for (let n = 1; n <= MODES; n++) {
      const k = i * MODES + n - 1;
      const a = scale * Math.sin(n * Math.PI * u) / (n * n);
      v[k] += w[k] * a;
      // keep total amplitude bounded under repeated excitation
      const e = Math.hypot(q[k], v[k] / w[k]);
      const cap = capM[i] / n;
      if (e > cap) { const r = cap / e; q[k] *= r; v[k] *= r; }
    }
    // bloom: restart at the new point unless an older bloom is still stronger
    const cur = pluckStr[i] * Math.exp(-pluckAge[i] / 0.75);
    if (glow >= cur) { pluckU[i] = uFull; pluckAge[i] = 0; pluckStr[i] = glow; }
  }

  // Closest point on string i's rest segment to (x,y,z): returns u in [0,1].
  function closestU(i, x, y, z) {
    const a = A[i], d = D[i];
    const s = (x - a.x) * d.x + (y - a.y) * d.y + (z - a.z) * d.z;
    return Math.min(1, Math.max(0, s / LEN[i]));
  }

  // Nearest in 3D (nearestPoint).
  const _near = new THREE.Vector3();
  function findNearest(p) {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const u = closestU(i, p.x, p.y, p.z);
      const a = A[i], b = B[i];
      const x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u, z = a.z + (b.z - a.z) * u;
      const d2 = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2;
      if (d2 < best) { best = d2; _near.set(x, y, z); }
    }
    return _near;
  }

  // Nearest as seen from the camera: the string that looks closest to p on screen.
  // Sets _viewI (string), _viewS (m along it) and _viewD (its distance from the camera there).
  let _viewI = 0, _viewS = 0, _viewD = 1;
  function viewRay(p, i) {
    // Closest points between the view ray C + t r and string i, a + s d.
    let rx = p.x - cam.x, ry = p.y - cam.y, rz = p.z - cam.z;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const a = A[i], d = D[i];
    const wx = cam.x - a.x, wy = cam.y - a.y, wz = cam.z - a.z;
    const b = rx * d.x + ry * d.y + rz * d.z;
    const dr = rx * wx + ry * wy + rz * wz, ed = d.x * wx + d.y * wy + d.z * wz;
    const den = 1 - b * b;
    let s = den > 1e-6 ? (ed - dr * b) / den : 0;
    s = Math.min(LEN[i], Math.max(0, s));
    // Angle between the ray and the direction to that string point.
    const qx = a.x + d.x * s - cam.x, qy = a.y + d.y * s - cam.y, qz = a.z + d.z * s - cam.z;
    const t = qx * rx + qy * ry + qz * rz;
    const ex = qx - rx * t, ey = qy - ry * t, ez = qz - rz * t;
    _viewS = s; _viewD = Math.max(t, 0.5);
    return Math.hypot(ex, ey, ez) / _viewD;
  }
  function findViewNearest(p) {
    let best = Infinity, bi = 0, bs = 0, bd = 1;
    for (let i = 0; i < count; i++) {
      const ang = viewRay(p, i);
      if (ang < best) { best = ang; bi = i; bs = _viewS; bd = _viewD; }
    }
    _viewI = bi; _viewS = bs; _viewD = bd;
  }

  // ---- Public API ----
  // A word drifting across a string on screen makes it shiver softly.
  function touch(prev, p) {
    if (reducedMotion) return false;
    let hit = false;
    for (let i = 0; i < count; i++) {
      const o = i * 3, a = A[i];
      const s1 = (p.x - a.x) * PN[o] + (p.y - a.y) * PN[o + 1] + (p.z - a.z) * PN[o + 2];
      const s0 = (prev.x - a.x) * PN[o] + (prev.y - a.y) * PN[o + 1] + (prev.z - a.z) * PN[o + 2];
      if ((s0 > 0) === (s1 > 0)) continue;
      if (now - lastTouch[i] < TUNE.touchCooldown) continue;
      viewRay(p, i);
      const u = _viewS / LEN[i];
      if (u <= NODE[i * 2] || u >= NODE[i * 2 + 1]) continue;   // outside the vibrating span
      lastTouch[i] = now;
      // A word near the string's depth touches it more firmly than one far in front of it.
      const dw = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      const k = 1 - 0.45 * Math.min(1, Math.abs(dw - _viewD) / 12);
      excite(i, u, TUNE.touchAngle * _viewD * k, TUNE.touchStrength * k);
      hit = true;
    }
    return hit;
  }

  // Plucks the string that looks nearest to worldPos, at the point that looks nearest.
  function pluckNearest(p, strength = 1) {
    if (reducedMotion) return;
    findViewNearest(p);
    const st = Math.min(1, Math.max(0, strength));
    excite(_viewI, _viewS / LEN[_viewI], TUNE.pluckAngle * _viewD * (0.5 + 0.5 * st), 0.45 + 0.55 * st);
    lastTouch[_viewI] = now;
  }

  function nearestPoint(p) { return findNearest(p); }

  function e(k) { return Math.hypot(q[k], v[k] / w[k]); }

  function update(t, dt) {
    now = t;
    camera.updateMatrixWorld();
    const cx = camera.matrixWorld.elements[12], cy = camera.matrixWorld.elements[13], cz = camera.matrixWorld.elements[14];
    if (cx !== cam.x || cy !== cam.y || cz !== cam.z) { cam.set(cx, cy, cz); updatePlanes(); }
    const h = Math.min(Math.max(dt || 0, 0), 1 / 15);
    const Qa = uniforms.uQa.value, Qb = uniforms.uQb.value, Ea = uniforms.uEa.value, Eb = uniforms.uEb.value;
    for (let i = 0; i < count; i++) {
      for (let n = 0; n < MODES; n++) {
        const k = i * MODES + n;
        const q0 = q[k], v0 = v[k];
        if (q0 === 0 && v0 === 0) continue;
        // Exact damped-oscillator step: stable at any frame rate.
        const g = gam[k], wd = wdamp[k];
        const ex = Math.exp(-g * h), c = Math.cos(wd * h), sn = Math.sin(wd * h);
        let qq = ex * (q0 * c + ((v0 + g * q0) / wd) * sn);
        let vv = ex * (v0 * c - ((wd * wd + g * g) * q0 + g * v0) / wd * sn);
        if (Math.abs(qq) < 1e-6 && Math.abs(vv) < 1e-5) { qq = 0; vv = 0; }
        q[k] = qq; v[k] = vv;
      }
      const o = i * MODES;
      Qa[i].set(q[o] * vis[o], q[o + 1] * vis[o + 1], q[o + 2] * vis[o + 2], q[o + 3] * vis[o + 3]);
      Qb[i].set(q[o + 4] * vis[o + 4], q[o + 5] * vis[o + 5], q[o + 6] * vis[o + 6], q[o + 7] * vis[o + 7]);
      Ea[i].set(e(o), e(o + 1), e(o + 2), e(o + 3));
      Eb[i].set(e(o + 4), e(o + 5), e(o + 6), e(o + 7));
      pluckAge[i] += dt || 0;
      uniforms.uPluck.value[i].set(pluckU[i], pluckAge[i], pluckStr[i], seeds[i]);
    }
    uniforms.uTime.value = t;
  }

  // The vibrating span of each string ends just outside the view, so a pluck reads as a
  // standing wave across the screen (the strings themselves run on, still, past the edges).
  const _p = new THREE.Vector3();
  function placeNodes() {
    camera.updateMatrixWorld();
    for (let i = 0; i < count; i++) {
      let first = -1, last = -1;
      for (let j = 0; j <= 200; j++) {
        const u = j / 200;
        _p.lerpVectors(A[i], B[i], u).project(camera);
        if (_p.z < 1 && Math.abs(_p.x) <= 1 && Math.abs(_p.y) <= 1.2) { if (first < 0) first = u; last = u; }
      }
      if (first < 0) { first = 0.25; last = 0.75; }
      const m = TUNE.nodeMargin * (last - first);
      const lo = Math.max(0.02, first - m), hi = Math.min(0.98, last + m);
      NODE[i * 2] = lo; NODE[i * 2 + 1] = hi;
      uniforms.uNode.value[i].set(lo, hi);
    }
  }

  function resize(width, height) {
    const pr = renderer.getPixelRatio();
    uniforms.uRes.value.set(width * pr, height * pr);
    uniforms.uPR.value = pr;
    placeNodes();
  }
  {
    const s = new THREE.Vector2();
    renderer.getSize(s);
    resize(s.x || 1, s.y || 1);
  }

  function dispose() {
    scene.remove(group);
    group.remove(mesh);
    geometry.dispose();
    material.dispose();
    if (lastHandle === handle) lastHandle = null;
  }

  const handle = {
    group, update, resize, dispose, touch, pluckNearest, nearestPoint,
    /** For debugging and tuning: rest endpoints and the live knobs. */
    strings: { A, B, count }, tune: TUNE, applyTune, state: { q, v, pluckAge },
  };
  lastHandle = handle;
  return handle;
}
