/*
  Iskry: the bonfire. The warm light everything else is lit by.
  OWNER: Opus worker "fire". Interface: CONTRACT.md (environment modules).

    import { createFire } from './scene/fire.js';
    const fire = createFire(ctx, { position: new THREE.Vector3(-3, 0, -2), scale: 1.3 });
    fire.update(t, dt); fire.resize(w, h); fire.intensity(); // 0..1
    fire.dispose();
  handle = { group, update, resize, dispose, light, fill, intensity() }

  Everything here sits in 3D space; nothing is a camera-facing sprite except the embers:
    light   PointLight inside the flames, inverse-square (decay 2) like a real source,
            layered-noise flicker, colour temperature rising with brightness (~1900-2500 K),
            its centre sways a few cm with the flames. `fill`: a weak, broad, higher warm
            PointLight standing in for the light bounced off the ground and the smoke, so
            things 10-30 m out still feel the fire.
    glow    light scattered by the warm air and smoke around the fire, computed in 3D:
            view-aligned slabs through a sphere around the fire; each slab integrates the
            in-scattering of the point light along the view ray in closed form
            (atan integral of 1/r^2), clipped to the sphere and to the ground, with the
            medium's density (ground haze falling off with height, a leaning smoke column,
            3D noise drifting with the wind) and a Henyey-Greenstein phase. Each slab is
            depth-tested at its own depth, so whatever stands in front of the fire hides
            the glow behind it while the haze in front of it stays. Additive.
    flame   a ray-marched volume in a small box: three tongues of 3D noise scrolling up,
            temperature ramp white-yellow core -> orange -> deep red -> transparent edge.
            Logs are intersected analytically (capsules) so they hide the flame behind
            them, with a soft fade where flame meets wood and ground.
    embers  GPU Points animated in the vertex shader, perspective-sized, fogged, soft.
    logs    seven displaced bark-covered logs (one merged mesh): a low star of lying logs
            and a collapsed teepee, charred ends with glowing cracks that breathe, lit
            by the flame in the shader. Writes depth.
    coals   a small mound of ash and glowing coals under the logs (premultiplied alpha,
            darkened where the logs touch it). The wider ground glow is real lighting
            (the PointLight on the foreground's ground cover) plus the scattering above.

  One 32^3 tileable noise texture feeds every shader. Draw calls: 5. No per-frame
  allocations: update() writes uniforms and moves the light.
  Colours from --fire, --fire-deep, --fire-core; flicker depth from --flicker-strength.
*/
import * as THREE from 'three';
import { FIRE } from './layout.js';

// ---------------------------------------------------------------- tuning knobs
const DEFAULTS = {
  position: null,          // THREE.Vector3 or {x,y,z}; default layout.FIRE
  scale: 1,                // uniform scale of the whole fire
  emberCount: 140,         // sparks (reducedMotion uses EMBER_COUNT_REDUCED)
  wind: 0.25,              // m/s mean wind to +x; embers, smoke and flames lean with it
  lightIntensity: 30,      // candela at full flicker (decay 2): a modest campfire for an eye adapted to the night
  lightDistance: 60,       // m, only a soft cut-off window far beyond the fog
  lightDecay: 2,           // inverse square
  lightHeight: 0.62,       // local, the luminous centre of the flames
  fillIntensity: 2.4,      // the broad bounce/smoke fill (decay 1, higher up)
  fillHeight: 2.6,         // local
  flameHeight: 1.75,       // local
  glow: 1,                 // multiplier for the scattered glow
  glowRadius: 3.4,         // local radius of the scattering volume
  logs: true,              // logs + coal bed
};
const EMBER_COUNT_REDUCED = 26;
const EMBER_WIND_GAIN = 2.2;   // embers are light: they ride the wind harder than words
const EMBER_LIFE = 5.2;        // s, mean life of an ember
const EMBER_RISE = 1.25;       // m/s initial rise speed (decelerates)
const FLICKER_AMOUNT = 0.32;   // 0..1 depth of the light flicker (scaled by --flicker-strength / 0.12)
const GLOW_SLICES = 6;         // depth slabs of the scattering volume
const FLAME_STEPS = 22;        // ray-march steps through the flame box
const NOISE_SIZE = 32;         // noise texture side (texels); 8 lattice cells per repeat

const COL_DEEP = '#b8481a';    // --fire-deep
const COL_FIRE = '#f0842c';    // --fire
const COL_CORE = '#ffb45a';    // --fire-core
const COL_LIGHT_WARM = 0xff8a3a;   // ~1900 K, light at its deepest
const COL_LIGHT_AMBER = 0xffae62;  // ~2500 K, light at its brightest

// ---------------------------------------------------------------- the logs (local units)
// [ax, ay, az, bx, by, bz, radius]; A is the hot (inner, burnt) end.
const LOGS = [
  // a low star of lying logs, inner ends in the coals, each a little raised over the last
  [0.10, 0.07, 0.03, 0.98, 0.085, 0.30, 0.085],
  [-0.06, 0.08, 0.10, -0.62, 0.08, 0.80, 0.08],
  [-0.09, 0.09, -0.05, -0.93, 0.075, -0.36, 0.078],
  [0.04, 0.12, -0.10, 0.36, 0.07, -0.90, 0.07],
  // a collapsed teepee leaning into the flames
  [0.08, 0.46, 0.05, 0.56, 0.055, 0.40, 0.055],
  [-0.10, 0.36, 0.0, -0.55, 0.05, 0.12, 0.05],
  [0.0, 0.40, -0.10, 0.20, 0.05, -0.56, 0.05],
];

// ---------------------------------------------------------------- shared GLSL
const GLSL_COMMON = /* glsl */`
  uniform sampler3D uNoise;
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// colour ramp in display (sRGB) space: 0 = deep red, 1 = white-hot
const GLSL_RAMP = /* glsl */`
  uniform vec3 uDeep, uFire, uCore;
  vec3 fireRamp(float h) {
    vec3 c = mix(vec3(0.30, 0.04, 0.01), uDeep, smoothstep(0.0, 0.25, h));
    c = mix(c, uFire, smoothstep(0.2, 0.5, h));
    c = mix(c, uCore, smoothstep(0.45, 0.78, h));
    c = mix(c, vec3(1.0, 0.94, 0.82), smoothstep(0.78, 1.0, h));
    return c;
  }
`;

// how much of an additive light survives the fog at view depth z (the same curve three uses)
const GLSL_FOG = /* glsl */`
  #ifdef USE_FOG
    uniform float fogNear, fogFar, fogDensity;
    float fogKeep(float z) {
      #ifdef FOG_EXP2
        return exp(-fogDensity * fogDensity * z * z);
      #else
        return 1.0 - smoothstep(fogNear, fogFar, z);
      #endif
    }
  #else
    float fogKeep(float z) { return 1.0; }
  #endif
`;

// ---------------------------------------------------------------- CPU noise
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable 3D gradient noise, two independent channels (RG8), smooth across the repeat.
function makeNoiseTexture() {
  const S = NOISE_SIZE, C = 8, rng = mulberry32(1931);
  const grads = [];
  for (let ch = 0; ch < 2; ch++) {
    const g = new Float32Array(C * C * C * 3);
    for (let i = 0; i < C * C * C; i++) {
      let x, y, z, l;
      do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.01);
      l = Math.sqrt(l); g[i * 3] = x / l; g[i * 3 + 1] = y / l; g[i * 3 + 2] = z / l;
    }
    grads.push(g);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const raw = new Float32Array(S * S * S * 2);
  let lo = [1e9, 1e9], hi = [-1e9, -1e9];
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x * C) / S, fy = (y * C) / S, fz = (z * C) / S;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const u = fade(tx), v = fade(ty), w = fade(tz);
    for (let ch = 0; ch < 2; ch++) {
      const g = grads[ch];
      let acc = 0;
      for (let k = 0; k < 8; k++) {
        const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
        const gi = (((ix + dx) % C) + ((iy + dy) % C) * C + ((iz + dz) % C) * C * C) * 3;
        const d = g[gi] * (tx - dx) + g[gi + 1] * (ty - dy) + g[gi + 2] * (tz - dz);
        acc += d * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
      }
      const idx = ((z * S + y) * S + x) * 2 + ch;
      raw[idx] = acc;
      if (acc < lo[ch]) lo[ch] = acc;
      if (acc > hi[ch]) hi[ch] = acc;
    }
  }
  const data = new Uint8Array(S * S * S * 2);
  for (let i = 0; i < data.length; i++) {
    const ch = i & 1;
    data[i] = Math.round(255 * (raw[i] - lo[ch]) / (hi[ch] - lo[ch]));
  }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- log geometry
// One merged mesh. Per vertex: aLog = (u along the log 0 hot end .. 1 cold end, radius,
// cap: 0 bark, 1 burnt hot end, 2 sawn cold end, seed), aBark = log-space (along, cross, cross).
function buildLogs(rng) {
  const RAD = 14, SEG = 16;
  const pos = [], nrm = [], logA = [], bark = [], idx = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), ax = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3();
  for (const L of LOGS) {
    A.set(L[0], L[1], L[2]); B.set(L[3], L[4], L[5]);
    const r0 = L[6], len = A.distanceTo(B), seed = rng();
    ax.subVectors(B, A).normalize();
    up.set(0, 1, 0);
    if (Math.abs(ax.y) > 0.9) up.set(1, 0, 0);
    e1.crossVectors(ax, up).normalize();
    e2.crossVectors(e1, ax).normalize();
    // per-log lumps (knots, a bent trunk) as a few random sines
    const ph = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];
    const radius = (u, th) => {
      const burn = 0.5 + 0.5 * THREE.MathUtils.smoothstep(u, 0.0, 0.32);       // the hot end is eaten away
      const ragged = 1 - (1 - THREE.MathUtils.smoothstep(u, 0.0, 0.3)) * 0.22 * (0.5 + 0.5 * Math.sin(th * 3 + ph[0] + u * 19));
      const lumps = 1 + 0.07 * Math.sin(u * len * 9 + ph[1]) * Math.sin(th * 2 + ph[2]) + 0.04 * Math.sin(th * 5 + u * 13 + ph[3]);
      const ridges = 1 + 0.035 * Math.sin(th * 9 + Math.sin(u * len * 6 + ph[0]) * 1.5);
      return r0 * burn * ragged * lumps * ridges;
    };
    const base = pos.length / 3;
    // side
    for (let j = 0; j <= SEG; j++) {
      const u = j / SEG;
      for (let i = 0; i <= RAD; i++) {
        const th = (i / RAD) * Math.PI * 2;
        const r = radius(u, th);
        const c = Math.cos(th), s = Math.sin(th);
        p.copy(A).addScaledVector(ax, u * len).addScaledVector(e1, c * r).addScaledVector(e2, s * r);
        // a lying log must not sink below the ground
        if (p.y < 0.004) p.y = 0.004;
        pos.push(p.x, p.y, p.z);
        nrm.push(0, 0, 0);
        logA.push(u, r0, 0, seed);
        bark.push(u * len, c * r, s * r);
      }
    }
    for (let j = 0; j < SEG; j++) for (let i = 0; i < RAD; i++) {
      const a = base + j * (RAD + 1) + i, b = a + RAD + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    // caps: own vertices (sharp edge), the hot end slightly domed (burnt to a point-ish end)
    for (let cap = 0; cap < 2; cap++) {
      const u = cap === 0 ? 0 : 1;
      const cbase = pos.length / 3;
      const dir = cap === 0 ? -1 : 1;
      p.copy(A).addScaledVector(ax, u * len + dir * (cap === 0 ? r0 * 0.25 : 0.0));
      pos.push(p.x, Math.max(p.y, 0.004), p.z); nrm.push(0, 0, 0);
      logA.push(u, r0, cap === 0 ? 1 : 2, seed); bark.push(u * len, 0, 0);
      for (let i = 0; i <= RAD; i++) {
        const th = (i / RAD) * Math.PI * 2;
        const r = radius(u, th);
        p.copy(A).addScaledVector(ax, u * len).addScaledVector(e1, Math.cos(th) * r).addScaledVector(e2, Math.sin(th) * r);
        pos.push(p.x, Math.max(p.y, 0.004), p.z); nrm.push(0, 0, 0);
        logA.push(u, r0, cap === 0 ? 1 : 2, seed); bark.push(u * len, Math.cos(th) * r, Math.sin(th) * r);
      }
      for (let i = 0; i < RAD; i++) {
        if (cap === 0) idx.push(cbase, cbase + 2 + i, cbase + 1 + i);
        else idx.push(cbase, cbase + 1 + i, cbase + 2 + i);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aLog', new THREE.Float32BufferAttribute(logA, 4));
  g.setAttribute('aBark', new THREE.Float32BufferAttribute(bark, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function toNumber(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
// a token colour as display (sRGB) components, for the additive shaders
function displayColor(v, fallback) {
  const c = new THREE.Color();
  try { c.setStyle(String(v || fallback), THREE.NoColorSpace); } catch (e) { c.setStyle(fallback, THREE.NoColorSpace); }
  return c;
}

// ================================================================== build
export function createFire(ctx, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const { scene, camera, renderer } = ctx;
  const reduced = !!ctx.reducedMotion;
  const read = typeof ctx.readToken === 'function' ? ctx.readToken : (_n, f) => f;
  const S = Math.max(0.05, toNumber(o.scale, 1));

  const colDeep = displayColor(read('--fire-deep', COL_DEEP), COL_DEEP);
  const colFire = displayColor(read('--fire', COL_FIRE), COL_FIRE);
  const colCore = displayColor(read('--fire-core', COL_CORE), COL_CORE);
  // --flicker-strength is 0.12 normally and 0 under reduced motion
  const flickerScale = Math.min(2, toNumber(read('--flicker-strength', 0.12), 0.12) / 0.12);
  const flickerDepth = reduced ? 0.05 : FLICKER_AMOUNT * flickerScale;
  const speed = reduced ? 0.18 : 1; // global animation tempo

  const group = new THREE.Group();
  group.name = 'fire';
  const p0 = o.position || FIRE;
  group.position.set(p0.x, p0.y, p0.z);
  group.scale.setScalar(S);
  scene.add(group);
  group.updateMatrixWorld(true);

  const disposables = [];
  const track = (x) => (disposables.push(x), x);
  const rng = mulberry32(4711);

  // ------------------------------------------------------------ shared uniforms
  const noiseTex = track(makeNoiseTexture());
  const uNoise = { value: noiseTex };
  const uTime = { value: 0 };
  const uFlicker = { value: 0.8 };          // 0..1 current fire brightness
  const uDeep = { value: colDeep }, uFire = { value: colFire }, uCore = { value: colCore };
  const uLightW = { value: new THREE.Vector3() };     // world position of the light
  const uLightLin = { value: new THREE.Color() };     // linear colour * intensity (cd)
  const uLightDisp = { value: new THREE.Color() };    // display colour of the light, 0..1
  const uFlameOff1 = { value: new THREE.Vector3() };  // noise scroll offsets (kept in 0..1)
  const uFlameOff2 = { value: new THREE.Vector3() };
  const uGlowOff = { value: new THREE.Vector3() };
  const uCoalOff = { value: new THREE.Vector3() };
  const uSway = { value: new THREE.Vector2() };       // flame tip offset (local)
  const fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

  const logA = [], logB = [];
  for (const L of LOGS) {
    logA.push(new THREE.Vector4(L[0], L[1], L[2], L[6] * 0.92));
    logB.push(new THREE.Vector3(L[3], L[4], L[5]));
  }
  const NLOG = o.logs ? LOGS.length : 0;

  // ------------------------------------------------------------ lights
  const light = new THREE.PointLight(COL_LIGHT_AMBER, o.lightIntensity, o.lightDistance, o.lightDecay);
  light.name = 'fire-light';
  light.position.set(0, o.lightHeight, 0);
  light.castShadow = false;
  group.add(light);
  let fill = null;
  if (o.fillIntensity > 0) {
    fill = new THREE.PointLight(COL_LIGHT_WARM, o.fillIntensity, o.lightDistance, 1);
    fill.name = 'fire-fill';
    fill.position.set(0, o.fillHeight, 0);
    fill.castShadow = false;
    group.add(fill);
  }
  const lightWarm = new THREE.Color(COL_LIGHT_WARM);
  const lightAmber = new THREE.Color(COL_LIGHT_AMBER);

  // ------------------------------------------------------------ glow: scattering in 3D
  const R = o.glowRadius;
  const glowCenterLocal = new THREE.Vector3(0, 1.0, 0);
  const glowCenterW = new THREE.Vector3().copy(glowCenterLocal).multiplyScalar(S).add(group.position);
  const glowGeo = track(new THREE.InstancedBufferGeometry());
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  glowGeo.setIndex([0, 1, 2, 0, 2, 3]);
  {
    const sl = new Float32Array(GLOW_SLICES);
    for (let i = 0; i < GLOW_SLICES; i++) sl[i] = i;
    glowGeo.setAttribute('aSlice', new THREE.InstancedBufferAttribute(sl, 1));
  }
  glowGeo.instanceCount = GLOW_SLICES;
  const glowMat = track(new THREE.ShaderMaterial({
    uniforms: Object.assign({
      uNoise, uLightW, uLightDisp, uGlowOff, uFlicker,
      uCenterW: { value: glowCenterW },
      uFireW: { value: group.position.clone() },
      uR: { value: R * S },
      uScale: { value: S },
      uFireY: { value: group.position.y },
      uCeil: { value: 3.7 * S },
      uNear: { value: 0.1 },
      uSlices: { value: GLOW_SLICES },
      uEps2: { value: (0.32 * S) * (0.32 * S) },
      uLean: { value: Math.min(1.2, o.wind * 1.6) },
      uGain: { value: 2.4 * o.glow },
    }, fogU),
    vertexShader: /* glsl */`
      attribute float aSlice;
      uniform vec3 uCenterW;
      uniform float uR, uNear, uSlices, uFireY, uCeil;
      varying vec3 vView;
      varying vec2 vSlab;
      void main() {
        vec3 c = (viewMatrix * vec4(uCenterW, 1.0)).xyz;
        float zc = -c.z;
        float z0 = max(zc - uR, uNear + 0.02);
        float z1 = zc + uR;
        float dz = (z1 - z0) / uSlices;
        if (dz <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vSlab = vec2(0.0); vView = vec3(0.0, 0.0, -1.0); return; }
        float za = z0 + aSlice * dz, zb = za + dz;
        float zq = 0.5 * (za + zb);
        // the widest cross-section of the sphere inside this slab, seen from the eye
        float dmin = (za <= zc && zc <= zb) ? 0.0 : min(abs(za - zc), abs(zb - zc));
        float rc = sqrt(max(uR * uR - dmin * dmin, 0.0));
        vec2 ctr = c.xy * zq * 0.5 * (1.0 / za + 1.0 / zb);
        float hs = rc * zq / za + length(c.xy) * zq * 0.5 * (1.0 / za - 1.0 / zb) + 0.02 * zq;
        vec2 lo = ctr - hs, hi = ctr + hs;
        // nothing below the ground: lift the quad's bottom edge to where this plane meets y = ground
        // (cameras here never roll, so that line is horizontal in view space)
        vec3 upV = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
        if (upV.y > 0.05) {
          float camY = cameraPosition.y - uFireY;
          float yg = (-camY + zq * upV.z) / upV.y;
          lo.y = clamp(yg - 0.01 * zq, lo.y, hi.y);
          float yt = (uCeil - camY + zq * upV.z) / upV.y;      // and nothing above the ceiling
          hi.y = clamp(yt + 0.01 * zq, lo.y, hi.y);
        }
        vec3 v = vec3(mix(lo, hi, position.xy * 0.5 + 0.5), -zq);
        vView = v;
        vSlab = vec2(za, zb);
        gl_Position = projectionMatrix * vec4(v, 1.0);
      }
    `,
    fragmentShader: GLSL_COMMON + GLSL_FOG + /* glsl */`
      uniform vec3 uLightW, uCenterW, uFireW, uLightDisp, uGlowOff;
      uniform float uR, uScale, uEps2, uLean, uGain, uFlicker;
      varying vec3 vView;
      varying vec2 vSlab;
      // the warm, smoky air around the fire (world position in, density out)
      float density(vec3 pw) {
        vec3 q = (pw - uFireW) / uScale;            // fire-local
        vec3 e = (pw - uCenterW) / uR;
        float env = clamp(1.0 - dot(e, e), 0.0, 1.0);
        env *= env;
        float y = max(q.y, 0.0);
        vec2 n = texture(uNoise, q * vec3(0.16, 0.11, 0.16) + uGlowOff).rg;
        // low haze over the ground: thickest at the ground, thin by head height
        float haze = exp(-y * 0.9) * (0.75 + 0.5 * n.y);
        // warm air and smoke rising and leaning downwind
        float cx = uLean * pow(max(y - 0.6, 0.0), 1.3);
        float w = 0.45 + 0.28 * y;
        vec2 dxz = vec2(q.x - cx, q.z) + (n - 0.5) * 0.8;
        float col = exp(-dot(dxz, dxz) / (w * w)) * smoothstep(0.4, 1.6, y) * exp(-y * 0.42) * (0.35 + 1.3 * n.x);
        return (0.55 * haze + 1.1 * col) * env * (1.0 - smoothstep(2.4, 3.7, q.y));
      }
      void main() {
        vec3 dv = normalize(vView);
        float cosv = -dv.z;
        vec3 d = normalize(dv * mat3(viewMatrix));           // view -> world direction
        vec3 o = cameraPosition;
        float ta = vSlab.x / cosv, tb = vSlab.y / cosv;
        vec3 oc = o - uCenterW;
        float b = dot(oc, d), cc = dot(oc, oc) - uR * uR;
        float disc = b * b - cc;
        if (disc <= 0.0) discard;
        float sq = sqrt(disc);
        ta = max(ta, -b - sq);
        tb = min(tb, -b + sq);
        if (d.y < -1e-5) tb = min(tb, (o.y - uFireW.y) / -d.y);   // the ground ends the ray
        if (tb <= ta) discard;
        // closed-form in-scattering of a point light along [ta, tb] (with a soft core)
        vec3 ol = uLightW - o;
        float tc = dot(ol, d);
        float h2 = max(dot(ol, ol) - tc * tc, 0.0) + uEps2;
        float h = sqrt(h2);
        float line = (atan((tb - tc) / h) - atan((ta - tc) / h)) / h;
        // the medium where the light is strongest along this piece of the ray
        float tm = clamp(tc, ta, tb);
        vec3 pm = o + d * tm;
        float rho = density(pm);
        // Henyey-Greenstein, g = 0.35: smoke scatters forward, toward the eye looking at the fire
        vec3 lp = pm - uLightW;
        float ct = dot(d, lp) * inversesqrt(dot(lp, lp) + 1e-4);
        float ph = 0.0681 / pow(1.1225 - 0.7 * ct, 1.5);
        float v = uGain * rho * ph * line * fogKeep(tm * cosv);
        gl_FragColor = vec4(uLightDisp * v, 1.0);
      }
    `,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: true,
  }));
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'fire-glow';
  glow.frustumCulled = false;
  glow.renderOrder = 6;
  group.add(glow);

  // ------------------------------------------------------------ flame: ray-marched volume
  const FH = o.flameHeight;
  const FB = new THREE.Vector3(0.78, FH * 1.12, 0.78);       // box half-x, height, half-z (local)
  const flameGeo = track(new THREE.BoxGeometry(FB.x * 2, FB.y, FB.z * 2));
  flameGeo.translate(0, FB.y / 2, 0);
  const uCamLocal = { value: new THREE.Vector3() };
  const flameMat = track(new THREE.ShaderMaterial({
    uniforms: Object.assign({
      uNoise, uFlicker, uDeep, uFire, uCore, uSway, uFlameOff1, uFlameOff2, uCamLocal,
      uBox: { value: FB },
      uH: { value: FH },
      uScale: { value: S },
      uGain: { value: 1.6 },
      uTurb: { value: reduced ? 0.7 : 1 },
      uLogA: { value: logA },
      uLogB: { value: logB },
    }, fogU),
    defines: { NLOG: Math.max(1, NLOG), USE_LOGS: NLOG > 0 ? 1 : 0, STEPS: reduced ? 16 : FLAME_STEPS },
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: GLSL_COMMON + GLSL_RAMP + GLSL_FOG + /* glsl */`
      uniform vec3 uCamLocal, uBox, uFlameOff1, uFlameOff2;
      uniform vec2 uSway;
      uniform float uH, uScale, uGain, uFlicker, uTurb;
      uniform vec4 uLogA[NLOG];
      uniform vec3 uLogB[NLOG];
      varying vec3 vPos;

      // iq's capsule intersection
      float capsule(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r) {
        vec3 ba = pb - pa, oa = ro - pa;
        float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa), oaoa = dot(oa, oa);
        float a = baba - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba;
        float h = b * b - a * c;
        if (h >= 0.0) {
          float t = (-b - sqrt(h)) / a;
          float y = baoa + t * bard;
          if (y > 0.0 && y < baba) return t;
          vec3 oc = (y <= 0.0) ? oa : ro - pb;
          b = dot(rd, oc); c = dot(oc, oc) - r * r;
          h = b * b - c;
          if (h > 0.0) return -b - sqrt(h);
        }
        return 1e9;
      }

      // one tongue: radius profile narrowing to a tip at height th (fraction of uH)
      float tongue(vec2 q, vec2 off, float h, float th, float r0) {
        float hh = h / th;
        float prof = r0 * pow(max(1.0 - hh, 0.0), 0.85) * (0.6 + 0.4 * smoothstep(-0.1, 0.25, hh));
        return (prof - length(q - off * (1.0 - hh))) / r0;
      }

      float flame(vec3 p, out float temp) {
        float h = p.y / uH;
        vec2 axis = uSway * h * h;
        vec2 w = texture(uNoise, p * vec3(0.30, 0.20, 0.30) + uFlameOff1).rg - 0.5;
        vec2 q = p.xz - axis - w * (0.12 + 0.7 * h);
        vec2 nn = texture(uNoise, p * vec3(0.62, 0.36, 0.62) + uFlameOff2).rg - 0.5;
        float n = (nn.x + 0.55 * (texture(uNoise, p * vec3(1.5, 0.9, 1.5) + uFlameOff2 * 2.0 + nn.y * 0.2).r - 0.5)) * 2.4;
        float d = tongue(q, vec2(0.0), h, 1.0, 0.42);
        d = max(d, tongue(q, vec2(0.24, 0.10), h, 0.68, 0.26));
        d = max(d, tongue(q, vec2(-0.20, -0.14), h, 0.6, 0.25));
        d = max(d, tongue(q, vec2(0.02, -0.26), h, 0.5, 0.22));
        d += n * uTurb * (0.2 + 0.95 * h) - 0.1 * h - 0.3 * h * h;
        temp = clamp(d * 1.4 + 0.4 * (1.0 - h) - 0.05, 0.0, 1.0);
        return smoothstep(0.0, 0.07, d);
      }

      void main() {
        vec3 ro = uCamLocal;
        vec3 rd = normalize(vPos - ro);
        // box [-x, x] x [0, h] x [-z, z]
        vec3 bmin = vec3(-uBox.x, 0.0, -uBox.z), bmax = vec3(uBox.x, uBox.y, uBox.z);
        vec3 inv = 1.0 / rd;
        vec3 t0s = (bmin - ro) * inv, t1s = (bmax - ro) * inv;
        vec3 tsm = min(t0s, t1s), tbg = max(t0s, t1s);
        float t0 = max(max(max(tsm.x, tsm.y), tsm.z), 0.0);
        float t1 = min(min(tbg.x, tbg.y), tbg.z);
        float tl = 1e9;
        #if USE_LOGS
          for (int i = 0; i < NLOG; i++) tl = min(tl, capsule(ro, rd, uLogA[i].xyz, uLogB[i], uLogA[i].w));
        #endif
        t1 = min(t1, tl);
        if (t1 <= t0) discard;
        float dt = (t1 - t0) / float(STEPS);
        float j = ign(gl_FragCoord.xy);
        float acc = 0.0, tw = 0.0;
        for (int i = 0; i < STEPS; i++) {
          float t = t0 + (float(i) + j) * dt;
          vec3 p = ro + rd * t;
          float rr = length(p.xz - uSway * 0.5);
          if (rr > 0.74) continue;
          float temp;
          float dens = flame(p, temp);
          if (dens <= 0.0) continue;
          dens *= smoothstep(0.0, 0.09, p.y) * smoothstep(0.0, 0.07, tl - t)    // soft where it meets coals and wood
                * (1.0 - smoothstep(0.56, 0.74, rr)) * (1.0 - smoothstep(0.78, 0.98, p.y / uBox.y));   // never the box
          float e = dens * (0.25 + 1.5 * temp * temp);
          acc += e;
          tw += e * temp;
        }
        float tAvg = tw / max(acc, 1e-4);
        acc *= dt * uGain * (0.82 + 0.25 * uFlicker);
        // brightness picks the colour (bright: white-yellow, dim: deep red), never grey
        float I = 1.0 - exp(-acc);
        vec3 col = fireRamp(clamp(0.72 * I + 0.38 * tAvg, 0.0, 1.0)) * min(1.0, I * 1.5);
        // view depth of the flame's middle, for the fog
        float z = length((ro + rd * 0.5 * (t0 + t1)) - ro) * uScale;
        gl_FragColor = vec4(col * fogKeep(z), 1.0);
      }
    `,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: true,
  }));
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.name = 'fire-flame';
  flame.frustumCulled = false;
  flame.renderOrder = 4;
  const camW = new THREE.Vector3();
  flame.onBeforeRender = (_r, _s, cam) => {
    camW.setFromMatrixPosition(cam.matrixWorld);
    uCamLocal.value.copy(camW);
    group.worldToLocal(uCamLocal.value);
    const c = uCamLocal.value;
    const inside = Math.abs(c.x) < FB.x && Math.abs(c.z) < FB.z && c.y > 0 && c.y < FB.y;
    flameMat.side = inside ? THREE.BackSide : THREE.FrontSide;
    glowMat.uniforms.uNear.value = cam.near || 0.1;
  };
  group.add(flame);

  // ------------------------------------------------------------ embers
  const emberCount = reduced ? EMBER_COUNT_REDUCED : Math.max(0, Math.round(o.emberCount));
  const emberGeo = track(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(emberCount * 3); // unused by the shader except as a carrier
    const seed = new Float32Array(emberCount * 4);
    for (let i = 0; i < emberCount; i++) {
      seed[i * 4] = rng();      // phase
      seed[i * 4 + 1] = rng();  // life / speed
      seed[i * 4 + 2] = rng();  // hash seed
      seed[i * 4 + 3] = rng();  // size / flicker rate
    }
    emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const emberMat = track(new THREE.ShaderMaterial({
    uniforms: Object.assign({
      uTime, uFlicker, uDeep, uFire, uCore,
      uLife: { value: EMBER_LIFE / (reduced ? 0.6 : 1) },
      uRise: { value: EMBER_RISE * (reduced ? 0.5 : 1) },
      uWind: { value: o.wind * EMBER_WIND_GAIN * (reduced ? 0.6 : 1) },
      uTurb: { value: reduced ? 0.25 : 1 },
      uTwinkle: { value: reduced ? 0.15 : 1 },
      uPxScale: { value: 500 },  // viewport height in device px / (2 tan(fov/2)); set in resize
      uSize: { value: 0.045 },   // world size (m, local) of a fresh ember
    }, fogU),
    vertexShader: GLSL_RAMP + /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uLife, uRise, uWind, uTurb, uTwinkle, uPxScale, uSize, uFlicker;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vDepth;
      float h1(float n) { return fract(sin(n * 91.345 + 47.853) * 43758.5453); }
      void main() {
        float life = uLife * mix(0.55, 1.35, aSeed.y);
        float k = uTime / life + aSeed.x;
        float age = fract(k);
        float cyc = mod(floor(k), 4096.0) + aSeed.z * 97.0;
        // a fresh random start and fate every cycle
        float r1 = h1(cyc * 1.7), r2 = h1(cyc * 3.1 + 5.0), r3 = h1(cyc * 0.7 + 11.0), r4 = h1(cyc * 2.3 + 19.0);
        float ang = r1 * 6.2832, rad = sqrt(r2) * 0.42;
        vec3 p = vec3(cos(ang) * rad, 0.3 + r3 * 0.6, sin(ang) * rad * 0.8);
        float tt = age * life;                          // seconds since birth
        float rise = uRise * mix(0.6, 1.25, r4);
        p.y += rise * tt * (1.0 - 0.32 * age);          // slows as it cools
        p.x += uWind * tt * age * 0.9;                  // the wind picks it up higher up
        // lazy curling turbulence that grows with age
        float ph = aSeed.z * 40.0;
        p.x += uTurb * age * (0.35 * sin(tt * 1.3 + ph) + 0.15 * sin(tt * 3.1 + ph * 1.7));
        p.z += uTurb * age * 0.3 * cos(tt * 1.1 + ph * 0.9);
        p.y += uTurb * 0.08 * sin(tt * 2.3 + ph);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vDepth = -mv.z;

        float fate = mix(0.35, 1.0, r1 * r1 * 0.4 + r3 * 0.6);   // some die early
        float a = age / fate;
        float tw = 0.55 + 0.45 * sin(uTime * mix(9.0, 23.0, aSeed.w) + ph);
        tw = mix(1.0, tw, uTwinkle);
        vAlpha = smoothstep(0.0, 0.05, a) * (1.0 - smoothstep(0.5, 1.0, a)) * step(a, 1.0) * tw;
        vColor = 1.1 * fireRamp(mix(1.0, 0.12, pow(clamp(a, 0.0, 1.0), 0.7)));
        // true size in metres, seen in perspective
        float s = uSize * length(modelMatrix[0].xyz) * mix(0.6, 1.4, aSeed.w) * (1.0 - 0.45 * clamp(a, 0.0, 1.0));
        float px = s * uPxScale / max(-mv.z, 0.1);
        // sparks smaller than a pixel keep a pixel and lose brightness instead (no shimmer)
        vAlpha *= clamp(px / 1.6, 0.2, 1.0);
        gl_PointSize = max(px, 1.6) * 3.0;  // the sprite holds a soft glow around the hot dot
      }
    `,
    fragmentShader: GLSL_FOG + /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      varying float vDepth;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d2 = dot(q, q);
        if (d2 > 1.0) discard;
        float core = exp(-d2 * 18.0);
        float halo = exp(-d2 * 4.0) * 0.22;
        gl_FragColor = vec4(vColor * (core * 1.3 + halo) * vAlpha * fogKeep(vDepth), 1.0);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.name = 'fire-embers';
  embers.frustumCulled = false;
  embers.renderOrder = 5;
  if (emberCount > 0) group.add(embers);

  // ------------------------------------------------------------ logs
  // lit by the flame in the shader (the same light as the PointLight, as an extended
  // source), linear maths, output through three's colour space + fog chunks
  const litU = {
    uNoise, uTime, uFlicker, uLightW, uLightLin, uCoalOff,
    uDeep: { value: new THREE.Color(COL_DEEP) },     // linear here (setStyle default)
    uCore: { value: new THREE.Color(COL_CORE) },
    uNight: { value: new THREE.Color('#110b08') },
  };
  litU.uDeep.value.set(read('--fire-deep', COL_DEEP));
  litU.uCore.value.set(read('--fire-core', COL_CORE));
  const LIT_COMMON = GLSL_COMMON + /* glsl */`
    uniform vec3 uLightW, uLightLin, uNight, uDeep, uCore, uCoalOff;
    uniform float uFlicker;
    // irradiance-based diffuse from the fire, treated as a source ~0.5 m across
    vec3 fireLight(vec3 pw, vec3 n, vec3 albedo) {
      vec3 l = uLightW - pw;
      float d2 = dot(l, l);
      float ndl = max(dot(n, l * inversesqrt(d2)), 0.0);
      ndl = 0.15 + 0.85 * ndl;                     // the flame is big: it wraps round a little
      return albedo * uLightLin * ndl / (3.14159 * (d2 + 0.12));
    }
    // glowing embers: a vein network that breathes slowly
    float embersAt(vec3 pl, float heat) {
      vec2 n = texture(uNoise, pl * 3.4).rg;
      float vein = 1.0 - smoothstep(0.0, 0.025 + 0.05 * heat, abs(n.x - 0.5));
      float cells = smoothstep(0.55, 0.8, n.y);
      float breathe = 0.55 + 0.75 * texture(uNoise, pl * 0.7 + uCoalOff).r;
      return clamp(vein * 0.85 + cells * heat * 0.6, 0.0, 1.5) * breathe;
    }
  `;
  let logs = null, coals = null;
  if (o.logs) {
    const logGeo = track(buildLogs(rng));
    const logMat = track(new THREE.ShaderMaterial({
      uniforms: Object.assign({}, litU, fogU),
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute vec4 aLog;
        attribute vec3 aBark;
        varying vec3 vW, vN, vL, vBark;
        varying vec4 vLog;
        void main() {
          vL = position;
          vLog = aLog;
          vBark = aBark;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: LIT_COMMON + /* glsl */`
        #include <fog_pars_fragment>
        varying vec3 vW, vN, vL, vBark;
        varying vec4 vLog;
        void main() {
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          float u = vLog.x, cap = vLog.z;
          float rxz = length(vL.xz);
          // heat: the burnt ends and whatever sits in the flames
          float heat = clamp(exp(-rxz * rxz / 0.09) * 1.15 + (1.0 - smoothstep(0.0, 0.3, u)) * 0.55, 0.0, 1.0);
          if (cap > 0.5 && cap < 1.5) heat = max(heat, 0.85);
          float charK = smoothstep(0.1, 0.45, heat + 0.35 * (1.0 - smoothstep(0.0, 0.6, u)));
          // bark: furrows along the log, a little moss-dark at the cold ends
          vec2 bn = texture(uNoise, vec3(vBark.x * 0.45, vBark.y * 3.2, vBark.z * 3.2) + vLog.w).rg;
          float furrow = smoothstep(0.25, 0.75, bn.x);
          vec3 barkCol = mix(vec3(0.008, 0.005, 0.0035), vec3(0.034, 0.022, 0.015), furrow) * (0.8 + 0.4 * bn.y);
          vec3 charCol = vec3(0.006, 0.005, 0.0045) * (0.6 + 0.8 * bn.y);
          vec3 albedo = mix(barkCol, charCol, charK);
          if (cap > 1.5) {                       // sawn cold end: pale wood with rings
            float rr = length(vBark.yz) / vLog.y;
            albedo = mix(vec3(0.16, 0.10, 0.06), vec3(0.09, 0.05, 0.03), 0.5 + 0.5 * sin(rr * 26.0 + bn.x * 4.0));
            albedo *= smoothstep(1.05, 0.75, rr) * 0.6 + 0.4;
          }
          // contact darkening near the ground and where the logs cross in the pile
          float ao = mix(0.35, 1.0, smoothstep(0.0, 0.1, vL.y)) * mix(0.6, 1.0, smoothstep(0.03, 0.3, rxz + 0.6 * vL.y));
          vec3 col = uNight * 0.18 + fireLight(vW, n, albedo) * ao;
          // embers glowing in the cracks of the char
          float e = embersAt(vL, heat) * heat * charK;
          vec3 emberCol = mix(uDeep * 0.5, uCore, smoothstep(0.4, 1.2, e * heat));
          col += emberCol * e * (0.9 + 0.35 * uFlicker) * 1.4;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
      fog: true, side: THREE.DoubleSide,
    }));
    logs = new THREE.Mesh(logGeo, logMat);
    logs.name = 'fire-logs';
    logs.frustumCulled = false;
    logs.renderOrder = 3;
    group.add(logs);

    // the coal and ash bed: a low lumpy mound under the logs
    const CR = 0.82;
    const coalGeo = track(new THREE.RingGeometry(0.0001, CR, 48, 10));
    coalGeo.rotateX(-Math.PI / 2);
    const coalMat = track(new THREE.ShaderMaterial({
      uniforms: Object.assign({}, litU, fogU, {
        uR: { value: CR },
        uLogA: { value: logA },
        uLogB: { value: logB },
      }),
      defines: { NLOG: Math.max(1, NLOG) },
      vertexShader: GLSL_COMMON + /* glsl */`
        #include <fog_pars_vertex>
        uniform float uR;
        varying vec3 vW, vL;
        void main() {
          vec3 p = position;
          float r = length(p.xz) / uR;
          float lump = texture(uNoise, vec3(p.xz * 2.4, 0.37)).r;
          p.y = 0.004 + (0.055 * (1.0 - r * r) + 0.03 * (lump - 0.5) * (1.0 - r)) ;
          vL = p;
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vW = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: LIT_COMMON + /* glsl */`
        #include <fog_pars_fragment>
        uniform float uR;
        uniform vec4 uLogA[NLOG];
        uniform vec3 uLogB[NLOG];
        varying vec3 vW, vL;
        float segDist(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a, ba = b - a;
          return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
        }
        void main() {
          vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
          if (n.y < 0.0) n = -n;
          float r = length(vL.xz) / uR;
          float alpha = 1.0 - smoothstep(0.55, 1.0, r);
          vec2 g = texture(uNoise, vL * 2.9 + vec3(0.0, 0.37, 0.0)).rg;
          float chunk = smoothstep(0.42, 0.58, g.x);                 // coal lumps, dark gaps between
          float crust = smoothstep(0.55, 0.8, g.y);                  // grey ash on the lumps
          vec3 ash = mix(vec3(0.006, 0.005, 0.004), mix(vec3(0.010, 0.008, 0.006), vec3(0.032, 0.029, 0.026), crust), chunk);
          // darker right under the logs (contact)
          float c = 1.0;
          for (int i = 0; i < NLOG; i++) c = min(c, smoothstep(0.0, 2.2 * uLogA[i].w, segDist(vL.xz, uLogA[i].xz, uLogB[i].xz)));
          vec3 col = uNight * 0.12 + fireLight(vW, n, ash) * mix(0.45, 1.0, c);
          float heat = 1.0 - smoothstep(0.1, 0.62, r);
          float breathe = 0.55 + 0.75 * texture(uNoise, vL * 0.9 + uCoalOff).r;
          float e = heat * chunk * (1.0 - 0.85 * crust) * breathe * mix(0.5, 1.0, c);
          col += mix(uDeep * 0.35, uCore, smoothstep(0.35, 1.1, e * heat)) * e * (0.85 + 0.35 * uFlicker) * 1.3;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
          #include <fog_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha);
        }
      `,
      transparent: true, depthWrite: false, premultipliedAlpha: true, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    coals = new THREE.Mesh(coalGeo, coalMat);
    coals.name = 'fire-coals';
    coals.frustumCulled = false;
    coals.renderOrder = 0;
    group.add(coals);
  }

  // ------------------------------------------------------------ flicker
  let current = 0.8;
  function sampleFlicker(t) {
    const ts = t * speed;
    // layered value noise, roughly 1/f: slow breathing, mid flutter, quick licks
    const f = 0.5 * noise1(ts * 0.55) + 0.3 * noise1(ts * 2.1 + 13.7) + 0.2 * noise1(ts * 6.3 + 41.3);
    return Math.min(1, Math.max(0, 0.78 + (f - 0.5) * 2 * flickerDepth * 1.6));
  }

  function resize(width, height) {
    const pr = renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const fov = camera && camera.fov ? camera.fov : 50;
    emberMat.uniforms.uPxScale.value = (height * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
  }
  {
    const v = new THREE.Vector2();
    if (renderer && renderer.getSize) renderer.getSize(v); else v.set(window.innerWidth, window.innerHeight);
    resize(v.x, v.y);
  }

  const fr = (x) => x - Math.floor(x);
  const lean = Math.min(0.35, o.wind * 0.5);
  function update(timeSec /*, dtSec */) {
    const t = timeSec * speed;
    uTime.value = timeSec;
    current = sampleFlicker(timeSec);
    uFlicker.value = current;

    // flames sway and lean downwind; the light's centre follows a little
    const sx = lean + (noise1(t * 0.45 + 3.0) - 0.5) * (reduced ? 0.12 : 0.32);
    const sz = (noise1(t * 0.38 + 21.0) - 0.5) * (reduced ? 0.08 : 0.24);
    uSway.value.set(sx, sz);
    uFlameOff1.value.set(fr(t * 0.013), fr(-t * 0.26), fr(t * 0.007));
    uFlameOff2.value.set(fr(-t * 0.021), fr(-t * 0.62), fr(t * 0.017));
    uGlowOff.value.set(fr(-t * 0.004 * (1 + o.wind)), fr(-t * 0.03), fr(t * 0.002));
    uCoalOff.value.set(fr(t * 0.011), fr(t * 0.023), fr(-t * 0.017));

    const jx = reduced ? 0 : (noise1(t * 3.1 + 5.0) - 0.5) * 0.06;
    const jz = reduced ? 0 : (noise1(t * 2.7 + 9.0) - 0.5) * 0.06;
    light.position.set(sx * 0.35 + jx, o.lightHeight + (current - 0.78) * 0.12, sz * 0.35 + jz);
    light.intensity = o.lightIntensity * (0.55 + 0.45 * current);
    // colour temperature: brighter flares burn a little whiter; drifts slower than the flicker
    const temp = Math.min(1, Math.max(0, 0.55 * current + 0.45 * noise1(t * 0.3 + 7.1)));
    light.color.copy(lightWarm).lerp(lightAmber, temp);
    if (fill) {
      fill.intensity = o.fillIntensity * (0.75 + 0.25 * current);
      fill.color.copy(light.color);
    }

    // the same light for the shaders
    uLightW.value.copy(light.position).multiplyScalar(S).add(group.position);
    uLightLin.value.copy(light.color).multiplyScalar(light.intensity);
    uLightDisp.value.copy(light.color).convertLinearToSRGB().multiplyScalar(light.intensity / o.lightIntensity * 1.25);
  }

  function dispose() {
    group.remove(light);
    if (light.dispose) light.dispose();
    if (fill) { group.remove(fill); if (fill.dispose) fill.dispose(); }
    for (const d of disposables) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  update(0, 0);

  return {
    group,
    light,
    fill,
    intensity: () => current,
    update,
    resize,
    dispose,
  };
}
