/*
  Iskry · foreground.js — the kapliczka (wayside shrine) and the stork on its nest.
  OWNER: Opus worker "foreground". Interface: CONTRACT.md (environment modules).
  Placement comes from js/scene/layout.js (SHRINE, STORK, FIRE, ZONES); opts may override it.

  createForeground(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose() }
  opts { firePosition = FIRE, wind = 0.25, shrine = SHRINE, stork = STORK }

  The ground, grass, road, fence and log bench live in their own modules
  (ground.js, grass.js, road.js, fence.js, log.js).

  Materials: MeshLambertMaterial (lit by the fire's PointLight, fog: true), patched so the unlit side
  keeps a dim night tone (per-vertex emissive, a touch more on faces that look up at the sky) and the
  low ground haze is mixed in exactly as sky.js mixes it into the ground. Nothing sits below y = 0.
  No global side effects: no lights, fog, background or renderer state.
*/
import * as THREE from 'three';
import { FIRE, SHRINE, STORK, ZONES } from './layout.js';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,
  seed: 23,
  center: ZONES.center,        // sky.js measures its ground haze from here
  hazeColor: '#372013',        // sky.js's low ground haze (sRGB)
  nightTone: '#110b08',        // unlit faces (sRGB, before the sky-facing lift)
  shrine: SHRINE,
  stork: STORK,
};
const TAU = Math.PI * 2;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lin = (hex) => new THREE.Color(hex);          // sRGB hex -> linear working colour
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------ shader patch
// Shared by every material here. Adds per-vertex night tone (aEmis) and glow (aGlow),
// the ground haze, and (FG_SWAY) wind sway for grass and flowers.
const VERT_PARS = /* glsl */ `
  attribute vec3 aEmis;
  attribute vec3 aGlow;
  varying vec3 vFgEmis;
  varying vec3 vFgGlow;
  varying vec3 vFgW;
  uniform float uFgTime;
  uniform float uFgWind;
`;
const VERT_PROJECT = /* glsl */ `
  vFgEmis = aEmis;
  vFgGlow = aGlow;
  vec4 fgW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fgW = instanceMatrix * fgW;
  #endif
  fgW = modelMatrix * fgW;
  #ifdef FG_SWAY
    // bend grows with the square of the height; waves travel downwind (+x)
    float fgK = clamp( position.y, 0.0, 1.0 ) * max( fgW.y, 0.0 );
    float fgPh = fgW.x * 0.55 + fgW.z * 0.33;
    float fgWave = 0.6 * sin( uFgTime * 1.6 - fgPh ) + 0.4 * sin( uFgTime * 2.7 - fgPh * 1.9 + 1.3 );
    float fgGust = 0.55 + 0.45 * sin( uFgTime * 0.21 - fgW.x * 0.07 + fgW.z * 0.05 );
    float fgB = fgK * uFgWind;
    fgW.x += fgB * ( 0.55 + fgGust * ( 0.45 + 0.35 * fgWave ) );
    fgW.z += fgB * 0.18 * fgWave;
    fgW.y -= fgB * 0.25 * fgGust;
  #endif
  vFgW = fgW.xyz;
  vec4 mvPosition = viewMatrix * fgW;
  gl_Position = projectionMatrix * mvPosition;
`;
const FRAG_PARS = /* glsl */ `
  varying vec3 vFgEmis;
  varying vec3 vFgGlow;
  varying vec3 vFgW;
  uniform float uFgCandle;
  uniform vec3 uFgHaze;
  uniform vec2 uFgCenter;
`;
const FRAG_EMISSIVE = /* glsl */ `
  #include <emissivemap_fragment>
  {
    vec3 fgUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    totalEmissiveRadiance = vFgEmis * ( 0.62 + 0.38 * max( dot( normal, fgUp ), 0.0 ) ) + vFgGlow * uFgCandle;
  }
`;
// sky.js GLSL_WORLD: low = 0.62 (1 - exp(-(D - 6) / 30)) (1 - smoothstep(-0.5, 2.2, y)), in linear space
const FRAG_HAZE = /* glsl */ `
  #include <opaque_fragment>
  {
    float fgD = length( vFgW.xz - uFgCenter );
    float fgLow = 0.62 * ( 1.0 - exp( -max( fgD - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vFgW.y ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFgHaze, fgLow );
  }
`;

function patchMaterial(mat, uniforms, key, sway) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', VERT_PROJECT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <opaque_fragment>', FRAG_HAZE);
  };
  mat.customProgramCacheKey = () => 'iskry-foreground-' + key;
  if (sway) mat.defines = Object.assign(mat.defines || {}, { FG_SWAY: '' });
  return mat;
}

// ---------------------------------------------------------- geometry kit
// Accumulates non-indexed triangles with position, normal, color, aEmis, aGlow.
class Builder {
  constructor(alpha = false) {
    this.alpha = alpha;
    this.p = []; this.n = []; this.c = []; this.e = []; this.g = [];
  }
  // geo: any BufferGeometry (consumed). m: Matrix4. color: linear Color.
  // o.emis / o.glow: linear Color (default night tone / none). o.colorFn(x,y,z,nx,ny,nz,lx,ly,lz,out)
  add(geo, m, color, o = {}) {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const P = src.attributes.position;
    if (!src.attributes.normal) src.computeVertexNormals();
    const local = o.colorFn ? P.array.slice() : null;
    src.applyMatrix4(m);
    const N = src.attributes.normal;
    const emis = o.emis || this.emis, glow = o.glow || null;
    const out = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
      this.p.push(x, y, z); this.n.push(nx, ny, nz);
      out.copy(color);
      if (o.colorFn) o.colorFn(x, y, z, nx, ny, nz, local[i * 3], local[i * 3 + 1], local[i * 3 + 2], out);
      this.c.push(out.r, out.g, out.b);
      this.e.push(emis.r, emis.g, emis.b);
      if (glow && (!o.glowFn || o.glowFn(nx, ny, nz))) this.g.push(glow.r, glow.g, glow.b); else this.g.push(0, 0, 0);
    }
    if (src !== geo) src.dispose();
    geo.dispose();
  }
  // raw triangle soup (decals): arrays of [x,y,z], [r,g,b,a], [er,eg,eb]
  tri(a, b, c, ca, cb, cc, ea, eb, ec) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    this.c.push(...ca, ...cb, ...cc);
    this.e.push(...ea, ...eb, ...ec);
    this.g.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, this.alpha ? 4 : 3));
    g.setAttribute('aEmis', new THREE.Float32BufferAttribute(this.e, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.g, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
function M(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, order = 'XYZ') {
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, order)), _s.set(sx, sy, sz));
}
// matrix that places a Y-axis geometry of height |b - a| centred on the origin between a and b
function between(a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(len));
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return { m: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), len };
}
function rod(B, a, b, r0, r1, sides, color, o) {
  const { m, len } = between(a, b);
  B.add(new THREE.CylinderGeometry(r1, r0, len, sides, 1, false), m, color, o);
}

// ================================================================== build
export function createForeground(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (const k of ['shrine', 'stork']) o[k] = { ...DEFAULTS[k], ...(opts[k] || {}) };   // partial overrides keep the rest
  if (opts.firePosition) o.firePosition = { x: +opts.firePosition.x || 0, y: +opts.firePosition.y || 0, z: +opts.firePosition.z || 0 };
  if (!Number.isFinite(o.wind)) o.wind = DEFAULTS.wind;
  const reduced = !!ctx.reducedMotion;
  const rng = mulberry32(o.seed * 7919 + 17);
  const R = (a, b) => a + (b - a) * rng();
  const F = o.firePosition;
  const C = o.center;

  const group = new THREE.Group();
  group.name = 'foreground';
  ctx.scene.add(group);

  const geometries = [], materials = [], textures = [];
  const track = (x, list) => { list.push(x); return x; };

  const uniforms = {
    uFgTime: { value: 0 },
    uFgWind: { value: THREE.MathUtils.clamp(o.wind, 0, 1.2) * 0.36 },
    uFgCandle: { value: 1 },
    uFgHaze: { value: lin(o.hazeColor) },
    uFgCenter: { value: new THREE.Vector2(C.x, C.z) },
  };
  const night = lin(o.nightTone);
  const distC = (x, z) => Math.hypot(x - C.x, z - C.z);

  // ------------------------------------------------------------- props
  const P = new Builder();
  P.emis = night;
  const jit = (c, j) => c.clone().multiplyScalar(1 + (rng() - 0.5) * j);

  // --- kapliczka: a wooden box shrine on a post, gable to the road, a znicz inside
  const shrine = o.shrine;
  const shrineYaw = Math.atan2(shrine.faceX, shrine.faceZ);
  const S0 = new THREE.Matrix4().compose(new THREE.Vector3(shrine.x, 0, shrine.z), new THREE.Quaternion().setFromAxisAngle(UP, shrineYaw), new THREE.Vector3(1, 1, 1));
  const sAdd = (geo, m, col, oo) => P.add(geo, new THREE.Matrix4().multiplyMatrices(S0, m), col, oo);
  const SWOOD = lin('#5f4c3b'), SROOF = lin('#3b2f26'), SBLUE = lin('#6f86a6'), SCREAM = lin('#e4d8c2');
  const zniczGlow = lin('#ff6a2a').multiplyScalar(0.9);
  const innerGlow = lin('#ff9a4a').multiplyScalar(0.05);
  const PH = 1.42;                                   // post height
  sAdd(new THREE.BoxGeometry(0.13, PH, 0.13), M(0, PH / 2, 0), SWOOD);
  sAdd(new THREE.BoxGeometry(0.28, 0.05, 0.05), M(0, PH - 0.12, 0.0, 0, 0, 0), SWOOD);  // little bracket
  sAdd(new THREE.BoxGeometry(0.52, 0.04, 0.38), M(0, PH + 0.02, 0), SWOOD);              // floor
  const BX = 0.5, BH = 0.56, BD = 0.34, by = PH + 0.04;
  sAdd(new THREE.BoxGeometry(BX, BH, 0.03), M(0, by + BH / 2, -BD / 2), SWOOD);           // back
  for (const sx of [-1, 1]) sAdd(new THREE.BoxGeometry(0.03, BH, BD), M(sx * (BX / 2 - 0.015), by + BH / 2, 0), SWOOD);
  // the inside, painted Marian blue, faintly warmed by the znicz (glow on the inner faces only)
  sAdd(new THREE.PlaneGeometry(BX - 0.06, BH - 0.04), M(0, by + BH / 2, -BD / 2 + 0.016), SBLUE, { glow: innerGlow });
  for (const sx of [-1, 1]) sAdd(new THREE.PlaneGeometry(BD - 0.04, BH - 0.04), M(sx * (BX / 2 - 0.031), by + BH / 2, 0, 0, -sx * Math.PI / 2, 0), SBLUE, { glow: innerGlow.clone().multiplyScalar(0.5) });
  sAdd(new THREE.BoxGeometry(BX, 0.03, BD), M(0, by + BH - 0.015, 0), SWOOD);
  sAdd(new THREE.BoxGeometry(BX, 0.05, 0.03), M(0, by + 0.025, BD / 2), SWOOD);         // front sill
  // gable roof with an overhang, ridge running front to back
  const ry = by + BH, slope = 0.72, half = 0.4;
  for (const sx of [-1, 1]) {
    sAdd(new THREE.BoxGeometry(half, 0.035, BD + 0.2), M(sx * (half * 0.5 * Math.cos(slope) - 0.02), ry + 0.035 + half * 0.5 * Math.sin(slope) - 0.02, 0.03, 0, 0, -sx * slope), SROOF);
  }
  const gable = new THREE.Shape([new THREE.Vector2(-BX / 2, 0), new THREE.Vector2(BX / 2, 0), new THREE.Vector2(0, (BX / 2) * Math.tan(slope))]);
  for (const sz of [-1, 1]) sAdd(new THREE.ExtrudeGeometry(gable, { depth: 0.025, bevelEnabled: false }), M(0, ry, sz * (BD / 2) - 0.0125), SWOOD);
  const ridgeY = ry + 0.035 + half * Math.sin(slope) - 0.03;
  sAdd(new THREE.BoxGeometry(0.022, 0.22, 0.022), M(0, ridgeY + 0.1, BD / 2 + 0.07), lin('#2a221c'));   // cross
  sAdd(new THREE.BoxGeometry(0.12, 0.022, 0.022), M(0, ridgeY + 0.14, BD / 2 + 0.07), lin('#2a221c'));
  // Madonna figure, pale, in the candlelight
  const figGlow = lin('#ff9c55').multiplyScalar(0.16);
  sAdd(new THREE.ConeGeometry(0.075, 0.27, 8), M(0, by + 0.135, -0.05), SCREAM, { glow: figGlow });
  sAdd(new THREE.SphereGeometry(0.036, 8, 6), M(0, by + 0.3, -0.05), SCREAM, { glow: figGlow });
  // znicz: red glass votive with a flame
  const zx = 0.12, zz = 0.08;
  sAdd(new THREE.CylinderGeometry(0.032, 0.028, 0.085, 8), M(zx, by + 0.0425, zz), lin('#7a1a10'), { glow: zniczGlow.clone().multiplyScalar(0.55) });
  sAdd(new THREE.OctahedronGeometry(0.014, 0), M(zx, by + 0.105, zz, 0, 0, 0, 0.8, 1.9, 0.8), lin('#ffd9a0'), { glow: lin('#ffc070').multiplyScalar(2.2) });
  const zniczWorld = new THREE.Vector3(zx, by + 0.08, zz).applyMatrix4(S0);

  // --- the stork's pole: an old wooden pole, a cart-wheel platform, the nest and a sleeping stork
  const st = o.stork;
  const POLE = lin('#4e4033'), NEST = lin('#3d2e21'), STICK = lin('#4b3a2a');
  const sh = st.height;
  const poleTop = new THREE.Vector3(st.x + 0.12, sh, st.z - 0.05);
  rod(P, new THREE.Vector3(st.x, 0.004, st.z), poleTop, 0.12, 0.09, 7, POLE);
  rod(P, new THREE.Vector3(st.x - 0.55, sh - 0.55, st.z), new THREE.Vector3(st.x + 0.12, sh - 0.02, st.z - 0.05), 0.035, 0.03, 5, POLE); // braces
  rod(P, new THREE.Vector3(st.x + 0.75, sh - 0.6, st.z - 0.05), new THREE.Vector3(st.x + 0.12, sh - 0.02, st.z - 0.05), 0.035, 0.03, 5, POLE);
  P.add(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 12), M(poleTop.x, sh + 0.03, poleTop.z), lin('#3a2d22'));
  {
    // nest: a squat, ragged drum of sticks, wider at the top
    const ng = new THREE.CylinderGeometry(0.82, 0.55, 0.44, 18, 3, false);
    const pa = ng.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.08 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 11 + y * 9);
      pa.setXYZ(i, x * k, y + (0.05 * Math.sin(a * 7) + 0.03 * Math.sin(a * 17 + 2)) * (y > 0 ? 1 : 0.4), z * k);
    }
    ng.computeVertexNormals();
    P.add(ng, M(poleTop.x, sh + 0.27, poleTop.z), NEST, { colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => out.multiplyScalar(0.7 + 0.6 * Math.abs(Math.sin(Math.atan2(lz, lx) * 9 + ly * 20))) });
    for (let i = 0; i < 44; i++) {
      const a = R(0, TAU), r0 = R(0.55, 0.78), len = R(0.3, 0.75);
      const y0 = sh + R(0.08, 0.5);
      const A = new THREE.Vector3(poleTop.x + Math.cos(a) * r0, y0, poleTop.z + Math.sin(a) * r0);
      const out = R(0.15, 0.45);
      const Bv = new THREE.Vector3(poleTop.x + Math.cos(a + R(-0.5, 0.5)) * (r0 + out), y0 + R(-0.15, 0.18), poleTop.z + Math.sin(a + R(-0.5, 0.5)) * (r0 + out));
      Bv.sub(A).setLength(len).add(A);
      rod(P, A, Bv, 0.014, 0.008, 3, jit(STICK, 0.4));
    }
  }
  {
    // bocian in profile, facing downwind, standing on one leg, head held up
    const WHITE = lin('#e2ddd3'), BLACK = lin('#151110'), RED = lin('#b8462a');
    const bx = poleTop.x - 0.05, bz = poleTop.z + 0.05, bY = sh + 0.5;
    const body = new THREE.SphereGeometry(1, 14, 10);
    P.add(body, M(bx, bY + 0.42, bz, 0, 0, -0.32, 0.3, 0.15, 0.15), WHITE, {
      // the folded black flight feathers: rear and lower part of the body
      colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => {
        const k = smooth(0.05, -0.45, lx + 0.35 * ly);
        out.lerp(BLACK, k);
      },
    });
    P.add(new THREE.ConeGeometry(0.08, 0.2, 6), M(bx - 0.3, bY + 0.32, bz, 0, 0, 1.75), BLACK);         // tail / wing tips
    const neck0 = new THREE.Vector3(bx + 0.22, bY + 0.5, bz), neck1 = new THREE.Vector3(bx + 0.27, bY + 0.74, bz), neck2 = new THREE.Vector3(bx + 0.24, bY + 0.9, bz);
    rod(P, neck0, neck1, 0.055, 0.04, 7, WHITE);
    rod(P, neck1, neck2, 0.04, 0.035, 7, WHITE);
    P.add(new THREE.SphereGeometry(0.052, 10, 8), M(neck2.x + 0.02, neck2.y + 0.02, bz, 0, 0, 0, 1.2, 0.9, 0.9), WHITE);
    const beakA = new THREE.Vector3(neck2.x + 0.07, neck2.y + 0.01, bz), beakB = new THREE.Vector3(neck2.x + 0.3, neck2.y - 0.07, bz);
    rod(P, beakA, beakB, 0.022, 0.004, 6, RED);
    rod(P, new THREE.Vector3(bx + 0.02, bY + 0.32, bz), new THREE.Vector3(bx + 0.03, bY - 0.12, bz), 0.012, 0.011, 4, RED);   // the standing leg
    rod(P, new THREE.Vector3(bx - 0.02, bY + 0.32, bz + 0.03), new THREE.Vector3(bx + 0.08, bY + 0.14, bz + 0.03), 0.011, 0.01, 4, RED); // the tucked one
  }

  const propsGeo = track(P.build(), geometries);
  const propsMat = track(patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), uniforms, 'props', false), materials);
  const props = new THREE.Mesh(propsGeo, propsMat);
  props.name = 'foreground-props';
  group.add(props);

  // ------------------------------------------------------------- znicz halo
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,190,120,1)'); rg.addColorStop(0.18, 'rgba(255,130,60,0.45)'); rg.addColorStop(1, 'rgba(200,60,20,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  track(glowTex, textures);
  const haloMat = track(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffffff, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.42, fog: true,
  }), materials);
  const halo = new THREE.Sprite(haloMat);
  halo.position.copy(zniczWorld);
  halo.scale.setScalar(0.62);
  halo.renderOrder = 3;
  halo.name = 'foreground-znicz-halo';
  group.add(halo);

  // ------------------------------------------------------------- handle
  const layout = { shrine: [shrine.x, shrine.z], stork: [st.x, st.z, st.height] };

  function update(t, dt) {
    if (!reduced) {
      uniforms.uFgTime.value = t;
      const f = 0.86 + 0.08 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2) + 0.06 * Math.sin(t * 13.7 + Math.sin(t * 1.9));
      uniforms.uFgCandle.value = f;
      haloMat.opacity = 0.42 * (0.85 + 0.15 * f);
    }
  }

  function resize() { /* nothing depends on the viewport */ }

  function dispose() {
    group.removeFromParent();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    geometries.length = materials.length = textures.length = 0;
  }

  return { group, update, resize, dispose, layout };
}
