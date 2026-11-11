/*
  OWNER: Opus worker "strings". Spec: scene-modules-spec.md (createStrings).

  createStrings(ctx, opts) -> handle
    opts.count        number of strings (default 5, max 12)
    opts.extents      drift volume {xMin,xMax,yMin,yMax,zMin,zMax}
    opts.touchRadius  m, how close (across the string, vertically) a word must pass (default 0.16)
    opts.touchDepth   m, depth tolerance along the camera axis for a touch (default 1.6)
    opts.seed         layout seed (default 7)

  handle = { group, update, resize, dispose, touch, pluckNearest, nearestPoint, strings }

  LOOK
    One draw call. Every string is a camera-facing ribbon expanded in SCREEN space in the
    vertex shader, so its width is set in pixels: a hairline core (anti-aliased, sub-pixel
    strings dim instead of thinning) plus a soft gaussian halo. Strings are lit by the fire
    (brighter near it), fade with distance and dissolve at their ends.

  PHYSICS
    Each string is a damped vibrating string: 8 standing-wave modes, each a damped harmonic
    oscillator integrated on the CPU (count x 8 oscillators, trivial). The shader sums
    q_n * sin(n*pi*u). A pluck at p is a velocity impulse giving mode n an amplitude
    proportional to sin(n*pi*p)/n^2, so the string swells from rest rather than jumping.
    The halo widens with each mode's amplitude envelope (reads like motion blur) and a
    warm bloom spreads from the pluck point and fades over ~1.5 s.

  TOUCH (3D, string-local frame)
    For each string: s = along, h = across in the vertical plane, d = across in depth.
    A word touches a string when, inside its length, |d| < touchDepth and h changes sign
    between prevPos and pos, or |h| enters touchRadius. Each string then ignores touches for
    TUNE.touchCooldown s. Allocation-free.
*/
import * as THREE from 'three';

const MAX_STRINGS = 12;
const MODES = 8;
const SEGMENTS = 220;

// Look and motion knobs that are not design tokens.
export const TUNE = {
  span: 1.55,          // strings extend this many times past the drift volume in x
  f1Min: 1.5,          // Hz, fundamental range (visual, not audible)
  f1Max: 2.0,
  inharmonic: 0.003,   // f_n = n f1 (1 + k n^2): a little stiffness, less mechanical
  tau1: 0.62,          // s, amplitude decay time of the fundamental
  tauHigh: 0.45,       // higher modes decay faster: tau_n = tau1 / (1 + tauHigh (n-1))
  pluckAmp: 0.3,       // m, peak displacement for pluckNearest(…, 1)
  touchAmp: 0.05,      // m, a word passing through
  touchStrength: 0.45, // bloom strength of a touch
  touchCooldown: 0.9,  // s, per string
  coreWidth: 0.6,      // px (CSS), half-width of the bright filament at the near end
  haloWidth: 4.0,      // px (CSS), gaussian radius of the glow
  envBlur: 0.2,        // px of extra halo per px of vibration envelope
  restCore: 0.15,      // core intensity at rest
  restHalo: 0.02,       // halo intensity at rest
  bloomCore: 1.3,      // extra core intensity at full bloom
  bloomHalo: 0.09,     // extra halo intensity at full bloom
  fireRadius: 11,      // m, falloff of firelight on the strings
  fireBoost: 0.9,      // how much brighter the strings are near the fire
  glint: 0.35,         // travelling highlights from the firelight (0 = off)
  shimmer: 0.06,       // idle brightness shimmer
  fadeNear: 10,        // m from camera: full brightness
  fadeFar: 42,         // m from camera: faded to fadeMin
  fadeMin: 0.18,
  endFade: 0.16,       // fraction of the length over which each end dissolves
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
uniform vec2 uRes;          // drawing buffer px
uniform float uPR;          // pixel ratio
uniform float uTime;
uniform float uMotion;      // 0 under reduced motion
uniform vec3 uFire;
uniform vec4 uTune0;        // coreWidth, haloWidth, envBlur, fireRadius
uniform vec4 uTune1;        // restCore, restHalo, bloomCore, bloomHalo
uniform vec4 uTune2;        // fireBoost, glint, shimmer, endFade
uniform vec3 uFade;         // near, far, min

attribute float aSide;

varying float vPx;          // signed distance from the centre line, px
varying float vCoreW;
varying float vHaloW;
varying float vCoreI;
varying float vHaloI;
varying float vBloom;

void modeSines(float u, out vec4 a, out vec4 b) {
  float x = PI * u;
  a = vec4(sin(x), sin(2.0 * x), sin(3.0 * x), sin(4.0 * x));
  b = vec4(sin(5.0 * x), sin(6.0 * x), sin(7.0 * x), sin(8.0 * x));
}

vec3 stringPos(int i, float u, out float env) {
  vec4 sa, sb;
  modeSines(u, sa, sb);
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
  float fire = 1.0 + uTune2.x * exp(-(df * df) / (uTune0.w * uTune0.w));
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

  float extent = haloW * 2.6 + coreW + 1.5;
  vPx = aSide * extent;
  c0.xy += n * (aSide * extent) / halfRes * c0.w;
  gl_Position = c0;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uHaloColor;
uniform vec3 uBloomColor;
varying float vPx;
varying float vCoreW;
varying float vHaloW;
varying float vCoreI;
varying float vHaloI;
varying float vBloom;

void main() {
  float d = abs(vPx);
  float core = 1.0 - smoothstep(vCoreW - 0.6, vCoreW + 0.6, d);
  float x = d / max(vHaloW, 0.5);
  float halo = exp(-x * x);
  vec3 haloCol = mix(uHaloColor, uBloomColor, clamp(vBloom, 0.0, 1.0));
  vec3 col = uCoreColor * core * vCoreI + haloCol * halo * vHaloI;
  gl_FragColor = vec4(col, clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

export function createStrings(ctx, opts = {}) {
  const { scene, camera, renderer } = ctx;
  const readToken = ctx.readToken || ((n, fb) => fb);
  const reducedMotion = !!ctx.reducedMotion;
  const count = Math.max(1, Math.min(MAX_STRINGS, opts.count ?? 5));
  const ext = Object.assign({ xMin: -16, xMax: 16, yMin: 0.8, yMax: 6.5, zMin: -22, zMax: 2 }, opts.extents || {});
  const touchRadius = opts.touchRadius ?? 0.16;
  const touchDepth = opts.touchDepth ?? 1.6;
  const firePos = new THREE.Vector3().copy(opts.firePosition || new THREE.Vector3(0, 0.6, -2));
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
    }
  }
  let now = 0;

  // ---- Colours from tokens ----
  const rest = parseColor(readToken('--string', 'rgba(244, 230, 208, 0.10)'), 0xf4e6d0, 0.1);
  const bright = parseColor(readToken('--string-bright', 'rgba(255, 217, 160, 0.38)'), 0xffd9a0, 0.38);
  const ember = parseColor(readToken('--fire', '#f0842c'), 0xf0842c, 1);
  const coreColor = rest.color.clone().lerp(bright.color, 0.35);
  const haloColor = ember.color.clone().lerp(bright.color, 0.45);
  const bloomColor = bright.color.clone();

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
    uCoreColor: { value: coreColor }, uHaloColor: { value: haloColor }, uBloomColor: { value: bloomColor },
  };
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  for (let i = 0; i < count; i++) {
    uniforms.uA.value[i].set(A[i].x, A[i].y, A[i].z, LEN[i]);
    // Near-ness from the midpoint's distance to the camera.
    const mx = (A[i].x + B[i].x) / 2, my = (A[i].y + B[i].y) / 2, mz = (A[i].z + B[i].z) / 2;
    const dist = Math.hypot(mx - camPos.x, my - camPos.y, mz - camPos.z);
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
  function excite(i, u, amp, glow) {
    u = Math.min(0.97, Math.max(0.03, u));
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
      const cap = 1.6 * TUNE.pluckAmp / n;
      if (e > cap) { const r = cap / e; q[k] *= r; v[k] *= r; }
    }
    // bloom: restart at the new point unless an older bloom is still stronger
    const cur = pluckStr[i] * Math.exp(-pluckAge[i] / 0.75);
    if (glow >= cur) { pluckU[i] = u; pluckAge[i] = 0; pluckStr[i] = glow; }
  }

  // Closest point on string i's rest segment to (x,y,z): returns u in [0,1].
  function closestU(i, x, y, z) {
    const a = A[i], d = D[i];
    const s = (x - a.x) * d.x + (y - a.y) * d.y + (z - a.z) * d.z;
    return Math.min(1, Math.max(0, s / LEN[i]));
  }

  const _near = new THREE.Vector3();
  let _nearI = 0, _nearU = 0.5;
  function findNearest(p) {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const u = closestU(i, p.x, p.y, p.z);
      const a = A[i], b = B[i];
      const x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u, z = a.z + (b.z - a.z) * u;
      const d2 = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2;
      if (d2 < best) { best = d2; _nearI = i; _nearU = u; _near.set(x, y, z); }
    }
    return _near;
  }

  // ---- Public API ----
  function touch(prev, p) {
    let hit = false;
    for (let i = 0; i < count; i++) {
      const a = A[i], d = D[i], up = NUP[i], dp = NDEP[i];
      const rx = p.x - a.x, ry = p.y - a.y, rz = p.z - a.z;
      const s = rx * d.x + ry * d.y + rz * d.z;
      if (s < 0 || s > LEN[i]) continue;
      const dd = rx * dp.x + ry * dp.y + rz * dp.z;
      if (dd > touchDepth || dd < -touchDepth) continue;
      const h = rx * up.x + ry * up.y + rz * up.z;
      const px = prev.x - a.x, py = prev.y - a.y, pz = prev.z - a.z;
      const h0 = px * up.x + py * up.y + pz * up.z;
      const crossed = (h0 > 0) !== (h > 0);
      const entered = Math.abs(h) < touchRadius && Math.abs(h0) >= touchRadius;
      if (!crossed && !entered) continue;
      if (now - lastTouch[i] < TUNE.touchCooldown) continue;
      lastTouch[i] = now;
      // closer in depth = a firmer touch
      const k = 1 - 0.5 * Math.abs(dd) / touchDepth;
      excite(i, s / LEN[i], TUNE.touchAmp * k, TUNE.touchStrength * k);
      hit = true;
    }
    return hit;
  }

  function pluckNearest(p, strength = 1) {
    findNearest(p);
    const st = Math.min(1, Math.max(0, strength));
    excite(_nearI, _nearU, TUNE.pluckAmp * st, 0.35 + 0.65 * st);
    lastTouch[_nearI] = now;
  }

  function nearestPoint(p) { return findNearest(p); }

  function e(k) { return Math.hypot(q[k], v[k] / w[k]); }

  function update(t, dt) {
    now = t;
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
      Qa[i].set(q[o], q[o + 1], q[o + 2], q[o + 3]);
      Qb[i].set(q[o + 4], q[o + 5], q[o + 6], q[o + 7]);
      Ea[i].set(e(o), e(o + 1), e(o + 2), e(o + 3));
      Eb[i].set(e(o + 4), e(o + 5), e(o + 6), e(o + 7));
      pluckAge[i] += dt || 0;
      uniforms.uPluck.value[i].set(pluckU[i], pluckAge[i], pluckStr[i], seeds[i]);
    }
    uniforms.uTime.value = t;
  }

  function resize(width, height) {
    const pr = renderer.getPixelRatio();
    uniforms.uRes.value.set(width * pr, height * pr);
    uniforms.uPR.value = pr;
  }
  {
    const s = new THREE.Vector2();
    renderer.getSize(s);
    resize(s.x || 1, s.y || 1);
  }

  function dispose() {
    scene.remove(group);
    geometry.dispose();
    material.dispose();
  }

  return {
    group, update, resize, dispose, touch, pluckNearest, nearestPoint,
    /** For debugging and tuning: rest endpoints and the live knobs. */
    strings: { A, B, count }, tune: TUNE, applyTune,
  };
}
