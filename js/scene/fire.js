/*
  Iskry: the bonfire. The warm light everything else is lit by.

    import { createFire } from './scene/fire.js';
    const fire = createFire(ctx, { position: new THREE.Vector3(0, 0, -2), scale: 1 });
    fire.update(t, dt); fire.resize(w, h); fire.intensity(); // 0..1
    fire.dispose();

  Parts (one draw call each, 6 in total):
    light   PointLight with layered-noise flicker and a slight colour temperature drift.
    halo    big, very soft billboard glow around the flames.
    flame   billboarded shader quad: scrolling fbm, hot cream core to deep orange edges.
    embers  GPU Points; every particle animated in the vertex shader from per-particle seeds.
    smoke   a few faint, slow noise billboards drifting up and right (opts.smoke).
    ground  ground decal: warm light pool + a bed of glowing coals.
    logs    a few dark crossed logs (InstancedMesh) with ember cracks on their hot side.

  No per-frame allocations; per-frame CPU work is a handful of uniform writes.
*/
import * as THREE from 'three';

// ---------------------------------------------------------------- tuning knobs
const DEFAULTS = {
  position: null,          // THREE.Vector3 or {x,y,z}; default (0, 0, -2)
  scale: 1,                // uniform scale of the whole fire
  emberCount: 140,         // sparks (reducedMotion uses EMBER_COUNT_REDUCED)
  wind: 0.25,              // m/s mean wind to +x (the words' wind); embers ride it at EMBER_WIND_GAIN
  lightIntensity: 26,      // PointLight intensity at full flicker (physically based units)
  lightDistance: 40,       // PointLight range
  lightDecay: 1.35,        // gentler than physical 2 so the far words still feel the fire
  lightHeight: 0.9,        // light position above the fire base
  flameHeight: 1.9,        // flame quad height (m); width is FLAME_ASPECT * height
  glow: 1,                 // multiplier for the additive glows (halo, ground pool)
  smoke: true,             // faint smoke wisps
  logs: true,              // dark logs + coals
};
const EMBER_COUNT_REDUCED = 28;
const FLAME_ASPECT = 0.95;
const EMBER_WIND_GAIN = 2.2;   // embers are light: they ride the wind harder than words
const EMBER_LIFE = 5.2;        // s, mean life of an ember
const EMBER_RISE = 1.25;       // m/s initial rise speed (decelerates)
const FLICKER_AMOUNT = 0.32;   // 0..1 depth of the light flicker (scaled by --flicker-strength / 0.12)
const GROUND_SIZE = 9;         // m, side of the ground glow decal

const COL_DEEP = 0xb8481a;     // --fire-deep
const COL_FIRE = 0xf0842c;     // --fire
const COL_CORE = 0xffb45a;     // --fire-core
const COL_LIGHT_WARM = 0xff7a2e; // light at its deepest
const COL_LIGHT_AMBER = 0xffb060; // light at its brightest

// ---------------------------------------------------------------- shared GLSL
const GLSL_NOISE = /* glsl */`
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
    return s / 0.9375;
  }
`;

// cylindrical-ish billboard: quad stays upright, faces the camera
const BILLBOARD_VERT = /* glsl */`
  uniform vec2 uSize;     // width, height (m, before group scale)
  uniform vec3 uOffset;   // centre offset in group space
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float s = length(modelMatrix[0].xyz);
    vec4 mv = modelViewMatrix * vec4(uOffset, 1.0);
    mv.xy += position.xy * uSize * s;
    gl_Position = projectionMatrix * mv;
  }
`;

// colour ramp shared by flame and embers: 0 = deep red, 1 = white-hot
const GLSL_RAMP = /* glsl */`
  uniform vec3 uDeep, uFire, uCore;
  vec3 fireRamp(float h) {
    vec3 c = mix(vec3(0.32, 0.06, 0.02), uDeep, smoothstep(0.0, 0.25, h));
    c = mix(c, uFire, smoothstep(0.2, 0.5, h));
    c = mix(c, uCore, smoothstep(0.45, 0.78, h));
    c = mix(c, vec3(1.0, 0.93, 0.80), smoothstep(0.78, 1.0, h));
    return c;
  }
`;

// ---------------------------------------------------------------- CPU noise for the light
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

function toNumber(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createFire(ctx, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const { scene, camera, renderer } = ctx;
  const reduced = !!ctx.reducedMotion;
  const read = typeof ctx.readToken === 'function' ? ctx.readToken : (_n, f) => f;

  const colDeep = new THREE.Color(read('--fire-deep', '#b8481a') || COL_DEEP);
  const colFire = new THREE.Color(read('--fire', '#f0842c') || COL_FIRE);
  const colCore = new THREE.Color(read('--fire-core', '#ffb45a') || COL_CORE);
  // --flicker-strength is 0.12 normally and 0 under reduced motion
  const flickerScale = Math.min(2, toNumber(read('--flicker-strength', 0.12), 0.12) / 0.12);
  const flickerDepth = reduced ? 0.06 : FLICKER_AMOUNT * flickerScale;
  const speed = reduced ? 0.35 : 1; // global animation tempo

  const group = new THREE.Group();
  group.name = 'fire';
  const p = o.position || { x: 0, y: 0, z: -2 };
  group.position.set(p.x, p.y, p.z);
  group.scale.setScalar(o.scale);
  scene.add(group);

  const disposables = [];
  const track = (x) => (disposables.push(x), x);

  // shared uniforms (same objects referenced by every material)
  const uTime = { value: 0 };
  const uFlicker = { value: 0.8 };   // 0..1 current fire brightness
  const uDeep = { value: colDeep }, uFire = { value: colFire }, uCore = { value: colCore };
  const quad = track(new THREE.PlaneGeometry(1, 1));
  quad.translate(0, 0.5, 0); // origin at the bottom edge

  // ------------------------------------------------------------ light
  const light = new THREE.PointLight(COL_LIGHT_AMBER, o.lightIntensity, o.lightDistance, o.lightDecay);
  light.position.set(0, o.lightHeight, 0);
  light.castShadow = false;
  group.add(light);
  const lightWarm = new THREE.Color(COL_LIGHT_WARM);
  const lightAmber = new THREE.Color(COL_LIGHT_AMBER);

  // ------------------------------------------------------------ halo
  const haloMat = track(new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: new THREE.Vector2(7.5, 7.5) },
      uOffset: { value: new THREE.Vector3(0, -2.9, 0) },
      uFlicker, uFire, uCore,
      uGlow: { value: o.glow },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */`
      uniform float uFlicker, uGlow;
      uniform vec3 uFire, uCore;
      varying vec2 vUv;
      void main() {
        vec2 q = (vUv - vec2(0.5, 0.5)) * vec2(2.0, 2.0);
        q.y *= 1.15;
        float d = length(q);
        float g = exp(-d * d * 4.5) * 0.55 + exp(-d * d * 1.6) * 0.18;
        g *= smoothstep(1.0, 0.75, d);
        vec3 col = mix(uFire, uCore, exp(-d * d * 8.0));
        gl_FragColor = vec4(col * g * (0.55 + 0.45 * uFlicker) * uGlow * 0.55, 1.0);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const halo = new THREE.Mesh(quad, haloMat);
  halo.frustumCulled = false;
  halo.renderOrder = 2;
  group.add(halo);

  // ------------------------------------------------------------ flame
  const flameMat = track(new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: new THREE.Vector2(o.flameHeight * FLAME_ASPECT, o.flameHeight) },
      uOffset: { value: new THREE.Vector3(0, 0.02, 0) },
      uTime, uFlicker, uDeep, uFire, uCore,
      uSpeed: { value: speed },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: GLSL_NOISE + GLSL_RAMP + /* glsl */`
      uniform float uTime, uFlicker, uSpeed;
      varying vec2 vUv;
      void main() {
        float t = uTime * uSpeed;
        float y = vUv.y;
        float x = (vUv.x - 0.5) * 2.0;
        // large slow sway + finer licking turbulence, both stronger higher up
        float sway = (vnoise(vec2(t * 0.45, 3.0)) - 0.5) * 0.35 * y * y;
        float n1 = fbm(vec2(x * 1.6 + 3.1, y * 2.0 - t * 1.15));
        float n2 = fbm(vec2(x * 3.4 - 5.0, y * 3.6 - t * 2.1));
        float wob = (n1 - 0.5) * 0.55 * y;
        // three tongues: a tall middle one and two shorter, breathing side licks
        float body = -1.0;
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float off = (fi - 1.0) * 0.36;
          float h = (i == 1) ? 1.0 : 0.58 + 0.16 * vnoise(vec2(t * 0.7 + fi * 5.0, fi));
          float yy = y / h;
          float xd = x - off * (1.0 - 0.6 * yy) - sway - wob;
          float w = mix((i == 1) ? 0.72 : 0.42, 0.06, pow(clamp(yy, 0.0, 1.0), 0.65));
          float env = 1.0 - smoothstep(0.0, w, abs(xd));
          env = env * env * (3.0 - 2.0 * env);
          body = max(body, env * 1.4 - yy * 1.15);
        }
        body += (n2 - 0.5) * 1.1 * (0.3 + y);
        float heat = clamp(body, 0.0, 1.0);
        heat *= smoothstep(0.0, 0.10, y) * smoothstep(1.0, 0.8, y);          // soft bottom into the coals
        heat *= 0.78 + 0.28 * uFlicker;
        vec3 col = fireRamp(heat * 0.97);
        float a = smoothstep(0.02, 0.55, heat);
        gl_FragColor = vec4(col * a * 1.15, 1.0);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const flame = new THREE.Mesh(quad, flameMat);
  flame.frustumCulled = false;
  flame.renderOrder = 4;
  group.add(flame);

  // ------------------------------------------------------------ embers
  const emberCount = reduced ? EMBER_COUNT_REDUCED : Math.max(0, Math.round(o.emberCount));
  const emberGeo = track(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(emberCount * 3); // unused by the shader except as a carrier
    const seed = new Float32Array(emberCount * 4);
    for (let i = 0; i < emberCount; i++) {
      seed[i * 4] = Math.random();      // phase
      seed[i * 4 + 1] = Math.random();  // life / speed
      seed[i * 4 + 2] = Math.random();  // hash seed
      seed[i * 4 + 3] = Math.random();  // size / flicker rate
    }
    emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const emberMat = track(new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFlicker, uDeep, uFire, uCore,
      uLife: { value: EMBER_LIFE / (reduced ? 0.6 : 1) },
      uRise: { value: EMBER_RISE * (reduced ? 0.55 : 1) },
      uWind: { value: o.wind * EMBER_WIND_GAIN * (reduced ? 0.6 : 1) },
      uTurb: { value: reduced ? 0.25 : 1 },
      uTwinkle: { value: reduced ? 0.15 : 1 },
      uPxScale: { value: 500 },  // viewport height in px / (2 tan(fov/2)); set in resize
      uSize: { value: 0.05 },   // world size (m) of a fresh ember
    },
    vertexShader: GLSL_RAMP + /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uLife, uRise, uWind, uTurb, uTwinkle, uPxScale, uSize, uFlicker;
      varying vec3 vColor;
      varying float vAlpha;
      float h1(float n) { return fract(sin(n * 91.345 + 47.853) * 43758.5453); }
      void main() {
        float life = uLife * mix(0.55, 1.35, aSeed.y);
        float k = uTime / life + aSeed.x;
        float age = fract(k);
        float cyc = floor(k) + aSeed.z * 97.0;
        // a fresh random start and fate every cycle
        float r1 = h1(cyc * 1.7), r2 = h1(cyc * 3.1 + 5.0), r3 = h1(cyc * 0.7 + 11.0), r4 = h1(cyc * 2.3 + 19.0);
        float ang = r1 * 6.2832, rad = sqrt(r2) * 0.5;
        vec3 p = vec3(cos(ang) * rad, 0.35 + r3 * 0.55, sin(ang) * rad * 0.7);
        float tt = age * life;                          // seconds since birth
        float rise = uRise * mix(0.6, 1.25, r4);
        p.y += rise * tt * (1.0 - 0.32 * age);          // slows as it cools
        p.x += uWind * tt * age * 0.9;                  // wind picks it up higher up
        // lazy curling turbulence that grows with age
        float ph = aSeed.z * 40.0;
        p.x += uTurb * age * (0.35 * sin(tt * 1.3 + ph) + 0.15 * sin(tt * 3.1 + ph * 1.7));
        p.z += uTurb * age * 0.25 * cos(tt * 1.1 + ph * 0.9);
        p.y += uTurb * 0.08 * sin(tt * 2.3 + ph);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;

        float fate = mix(0.35, 1.0, r1 * r1 * 0.4 + r3 * 0.6);   // some die early
        float a = age / fate;
        float tw = 0.55 + 0.45 * sin(uTime * mix(9.0, 23.0, aSeed.w) + ph);
        tw = mix(1.0, tw, uTwinkle);
        vAlpha = smoothstep(0.0, 0.04, a) * (1.0 - smoothstep(0.55, 1.0, a)) * step(a, 1.0) * tw;
        vColor = 1.15 * fireRamp(mix(1.0, 0.12, pow(clamp(a, 0.0, 1.0), 0.7)));
        float s = uSize * mix(0.6, 1.4, aSeed.w) * (1.0 - 0.45 * clamp(a, 0.0, 1.0));
        float px = s * uPxScale / max(-mv.z, 0.1);
        // keep tiny sparks as crisp dim points instead of shimmering sub-pixels
        vAlpha *= clamp(px / 2.0, 0.25, 1.0);
        gl_PointSize = max(px, 2.2) * 2.4;  // sprite has a soft halo around the hot dot
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d2 = dot(q, q);
        if (d2 > 1.0) discard;
        float core = exp(-d2 * 14.0);
        float glow = exp(-d2 * 3.5) * 0.28;
        gl_FragColor = vec4(vColor * (core * 1.3 + glow) * vAlpha, 1.0);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  embers.renderOrder = 5;
  if (emberCount > 0) group.add(embers);

  // ------------------------------------------------------------ smoke
  let smoke = null;
  if (o.smoke) {
    const WISPS = reduced ? 3 : 5;
    const sGeo = track(new THREE.InstancedBufferGeometry());
    sGeo.index = quad.index;
    sGeo.setAttribute('position', quad.getAttribute('position'));
    sGeo.setAttribute('uv', quad.getAttribute('uv'));
    const sSeed = new Float32Array(WISPS * 2);
    for (let i = 0; i < WISPS; i++) { sSeed[i * 2] = i / WISPS; sSeed[i * 2 + 1] = Math.random(); }
    sGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sSeed, 2));
    sGeo.instanceCount = WISPS;
    const smokeMat = track(new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFlicker,
        uWind: { value: o.wind * EMBER_WIND_GAIN },
        uLife: { value: reduced ? 34 : 22 },
        uTint: { value: new THREE.Color(0x8a6a52) },
      },
      vertexShader: /* glsl */`
        attribute vec2 aSeed;
        uniform float uTime, uWind, uLife;
        varying vec2 vUv;
        varying float vAge;
        varying float vSeed;
        void main() {
          vUv = uv;
          float age = fract(uTime / uLife + aSeed.x);
          vAge = age; vSeed = aSeed.y;
          float tt = age * uLife;
          vec3 c = vec3(uWind * 0.5 * tt * age + (aSeed.y - 0.5) * 0.4, 1.4 + tt * 0.38, -0.2);
          float s = length(modelMatrix[0].xyz);
          float size = mix(1.4, 4.5, age);
          vec4 mv = modelViewMatrix * vec4(c, 1.0);
          mv.xy += (position.xy - vec2(0.0, 0.5)) * vec2(size, size * 1.3) * s;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: GLSL_NOISE + /* glsl */`
        uniform float uTime, uFlicker;
        uniform vec3 uTint;
        varying vec2 vUv;
        varying float vAge;
        varying float vSeed;
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float n = fbm(vUv * 2.2 + vec2(vSeed * 13.0, -uTime * 0.05 + vSeed * 7.0));
          float m = smoothstep(1.0, 0.1, length(q)) * smoothstep(0.38, 0.75, n);
          float a = m * smoothstep(0.0, 0.25, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
          // lit from below: warmer and brighter near the fire
          vec3 col = mix(uTint, vec3(0.95, 0.55, 0.28), (1.0 - vAge) * 0.5);
          gl_FragColor = vec4(col * (0.7 + 0.3 * uFlicker), a * 0.05);
        }
      `,
      transparent: true, depthWrite: false,
    }));
    smoke = new THREE.Mesh(sGeo, smokeMat);
    smoke.frustumCulled = false;
    smoke.renderOrder = 1;
    group.add(smoke);
  }

  // ------------------------------------------------------------ ground pool + coals
  const groundGeo = track(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE));
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = track(new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFlicker, uDeep, uFire, uCore,
      uGlow: { value: o.glow },
      uCoals: { value: o.logs ? 1 : 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: GLSL_NOISE + /* glsl */`
      uniform float uTime, uFlicker, uGlow, uCoals;
      uniform vec3 uDeep, uFire, uCore;
      varying vec2 vP;
      void main() {
        float d = length(vP);
        // wide warm light pool (falls off like light on the ground)
        float pool = 0.5 / (1.0 + d * d * 1.1) * smoothstep(${(GROUND_SIZE / 2).toFixed(1)}, 1.2, d);
        vec3 col = mix(uDeep, uFire, smoothstep(2.5, 0.0, d)) * pool * (0.55 + 0.45 * uFlicker) * 0.45 * uGlow;
        // coal bed: breathing, cracked hot spots in the heart of the fire
        float bed = smoothstep(0.75, 0.15, d) * uCoals;
        if (bed > 0.0) {
          float n = fbm(vP * 7.0 + vec2(0.0, uTime * 0.04));
          float b = vnoise(vP * 3.0 + uTime * 0.35);
          float hot = smoothstep(0.45, 0.85, n) * (0.55 + 0.45 * b) * bed;
          col += mix(uDeep, uCore, hot) * hot * (0.8 + 0.4 * uFlicker) + uDeep * bed * 0.12;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = 0.012;
  ground.renderOrder = 0;
  group.add(ground);

  // ------------------------------------------------------------ logs
  let logs = null;
  if (o.logs) {
    const logGeo = track(new THREE.CylinderGeometry(0.075, 0.085, 1.1, 10, 1));
    const logMat = track(new THREE.ShaderMaterial({
      uniforms: { uTime, uFlicker, uDeep, uFire, uCore },
      vertexShader: /* glsl */`
        varying vec3 vP;   // group-space position
        varying vec3 vN;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 lp = instanceMatrix * vec4(position, 1.0);
          vP = lp.xyz;
          vN = normalize(mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * lp;
        }
      `,
      fragmentShader: GLSL_NOISE + /* glsl */`
        uniform float uTime, uFlicker;
        uniform vec3 uDeep, uFire, uCore;
        varying vec3 vP;
        varying vec3 vN;
        varying vec2 vUv;
        void main() {
          vec3 L = normalize(vec3(0.0, 0.55, 0.0) - vP);
          float ndl = max(dot(normalize(vN), L), 0.0);
          float r = length(vP.xz);
          vec3 wood = vec3(0.075, 0.045, 0.03);
          vec3 col = wood * 0.35 + uFire * 0.35 * ndl * smoothstep(1.2, 0.2, r) * (0.6 + 0.4 * uFlicker);
          // ember cracks on the hot inner ends
          float n = fbm(vec2(vUv.x * 9.0, vUv.y * 14.0) + vec2(0.0, uTime * 0.03));
          float heat = smoothstep(0.55, 0.05, r) * (0.4 + 0.6 * ndl);
          float crack = smoothstep(0.5, 0.75, n) * heat;
          col += mix(uDeep, uCore, crack) * crack * 1.4 * (0.75 + 0.35 * uFlicker);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }));
    const LOGS = 4;
    logs = new THREE.InstancedMesh(logGeo, logMat, LOGS);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(1, 1, 1), t = new THREE.Vector3();
    // a low, loosely crossed pile: logs lie almost flat, each slightly raised over the last
    const ANG = [0.35, 1.95, 1.0, 2.75];
    const OFF = [0.13, -0.12, -0.15, 0.1];
    for (let i = 0; i < LOGS; i++) {
      const a = ANG[i];
      t.set(-Math.sin(a) * OFF[i], 0.08 + i * 0.045, Math.cos(a) * OFF[i] * 0.8);
      e.set(0.12 * (i % 2 ? 1 : -1), -a, Math.PI / 2 + 0.1 * (i % 2 ? -1 : 1), 'YXZ');
      q.setFromEuler(e);
      sc.set(1, 0.85 + (i % 3) * 0.12, 1);
      m.compose(t, q, sc);
      logs.setMatrixAt(i, m);
    }
    logs.instanceMatrix.needsUpdate = true;
    logs.frustumCulled = false;
    logs.renderOrder = 3;
    group.add(logs);
  }

  // ------------------------------------------------------------ flicker
  let current = 0.8;
  function sampleFlicker(t) {
    const ts = t * speed;
    // layered value noise: slow breathing, mid flutter, quick licks
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

  function update(timeSec /*, dtSec */) {
    uTime.value = timeSec;
    current = sampleFlicker(timeSec);
    uFlicker.value = current;
    light.intensity = o.lightIntensity * (0.55 + 0.45 * current);
    // colour temperature drifts between deep orange and amber, slower than the flicker
    const temp = Math.min(1, Math.max(0, 0.35 * current + 0.65 * noise1(timeSec * speed * 0.3 + 7.1)));
    light.color.copy(lightWarm).lerp(lightAmber, temp);
  }

  function dispose() {
    group.remove(light);
    if (light.dispose) light.dispose();
    if (logs && logs.dispose) logs.dispose();
    for (const d of disposables) d.dispose();
    if (group.parent) group.parent.remove(group);
  }

  update(0, 0);

  return {
    group,
    light,
    intensity: () => current,
    update,
    resize,
    dispose,
  };
}
