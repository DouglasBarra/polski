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
  constructor(alpha = false, skin = false) {
    this.alpha = alpha; this.skin = skin;
    this.p = []; this.n = []; this.c = []; this.e = []; this.g = []; this.b = [];
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
      if (this.skin) this.b.push(o.bone | 0);
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
    if (this.skin) {
      // rigid skinning: every vertex follows exactly one bone
      const n = this.b.length, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = this.b[i]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    }
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
  // a blue mantle over a pale gown, a gilt halo behind the head
  sAdd(new THREE.ConeGeometry(0.075, 0.27, 10), M(0, by + 0.135, -0.05), SCREAM, {
    glow: figGlow, colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => { if (lz < 0.035 || ly > 0.07) out.copy(lin('#5a7398')); },
  });
  sAdd(new THREE.TorusGeometry(0.05, 0.005, 4, 16), M(0, by + 0.305, -0.075), lin('#c9a24a'), { glow: figGlow.clone().multiplyScalar(0.8) });
  sAdd(new THREE.SphereGeometry(0.036, 8, 6), M(0, by + 0.3, -0.05), SCREAM, { glow: figGlow });
  // znicz: red glass votive with a flame
  const zx = 0.12, zz = 0.08;
  sAdd(new THREE.CylinderGeometry(0.032, 0.028, 0.085, 8), M(zx, by + 0.0425, zz), lin('#7a1a10'), { glow: zniczGlow.clone().multiplyScalar(0.55) });
  sAdd(new THREE.OctahedronGeometry(0.014, 0), M(zx, by + 0.105, zz, 0, 0, 0, 0.8, 1.9, 0.8), lin('#ffd9a0'), { glow: lin('#ffc070').multiplyScalar(2.2) });
  const zniczWorld = new THREE.Vector3(zx, by + 0.08, zz).applyMatrix4(S0);
  // a lace cloth under the figure and a jar of dried flowers beside it
  sAdd(new THREE.BoxGeometry(BX - 0.1, 0.006, BD - 0.1), M(0, by + 0.003, 0), lin('#d9d0bf'), { glow: figGlow.clone().multiplyScalar(0.6) });
  sAdd(new THREE.CylinderGeometry(0.02, 0.017, 0.06, 7), M(-0.13, by + 0.03, 0.02), lin('#5c6f74'), { glow: figGlow.clone().multiplyScalar(0.4) });
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7, hx = -0.13 + Math.cos(a) * 0.018, hz = 0.02 + Math.sin(a) * 0.018;
    sAdd(new THREE.CylinderGeometry(0.002, 0.002, 0.1, 3), M(hx, by + 0.1, hz, Math.sin(a) * 0.2, 0, -Math.cos(a) * 0.2), lin('#4a4a2a'));
    sAdd(new THREE.IcosahedronGeometry(0.012, 0), M(hx - Math.cos(a) * 0.02, by + 0.15, hz + Math.sin(a) * 0.02), lin(['#8a3a24', '#b89a6a', '#7a5a8a', '#a0603a'][i]), { glow: figGlow.clone().multiplyScalar(0.5) });
  }
  // shingled roof: rows of thin boards (gont) over the slabs, each row a little proud of the last
  for (const sx of [-1, 1]) {
    for (let r = 0; r < 4; r++) {
      const along = half * (0.14 + r * 0.24);
      const cx = sx * (along * Math.cos(slope) - 0.02), cy = ry + 0.055 + (half - along) * Math.sin(slope) - 0.02 + 0.004 * r;
      sAdd(new THREE.BoxGeometry(0.11, 0.012, BD + 0.2), M(cx, cy, 0.03, 0, 0, -sx * (slope - 0.06)), jit(SROOF, 0.35));
    }
    // front bargeboard along the gable edge, slightly proud
    sAdd(new THREE.BoxGeometry(half + 0.02, 0.05, 0.02), M(sx * (half * 0.5 * Math.cos(slope) - 0.02), ry + 0.02 + half * 0.5 * Math.sin(slope) - 0.03, BD / 2 + 0.135, 0, 0, -sx * slope), SWOOD);
  }
  // carved fringe (lambrekin) under the front of the box top: a row of small hanging teeth
  {
    const tooth = new THREE.Shape([new THREE.Vector2(-0.022, 0), new THREE.Vector2(0.022, 0), new THREE.Vector2(0, -0.045)]);
    for (let i = 0; i < 9; i++) sAdd(new THREE.ShapeGeometry(tooth), M(-0.2 + i * 0.05, by + BH - 0.03, BD / 2 + 0.003), SWOOD);
  }
  // fieldstones round the foot of the post, and two zniczs left there (November: All Saints)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + R(-0.3, 0.3), r = R(0.17, 0.24), sz = R(0.06, 0.1);
    const sg = new THREE.IcosahedronGeometry(1, 0);
    sAdd(sg, M(Math.cos(a) * r, sz * 0.45, Math.sin(a) * r, R(0, 3), R(0, 3), R(0, 3), sz, sz * 0.55, sz * 0.8), jit(lin('#5d5852'), 0.35));
  }
  const footZ = [];
  for (const [fx, fz, col] of [[-0.11, 0.24, '#7a1a10'], [0.1, 0.27, '#8a5a12']]) {
    sAdd(new THREE.CylinderGeometry(0.038, 0.034, 0.11, 8), M(fx, 0.055, fz), lin(col), { glow: lin(col === '#7a1a10' ? '#ff5a24' : '#ffa040').multiplyScalar(0.5) });
    sAdd(new THREE.ConeGeometry(0.03, 0.035, 8), M(fx, 0.128, fz), lin('#8c7a52'));                     // pierced metal lid
    sAdd(new THREE.OctahedronGeometry(0.012, 0), M(fx, 0.085, fz, 0, 0, 0, 0.8, 1.8, 0.8), lin('#ffd9a0'), { glow: lin('#ffc070').multiplyScalar(1.6) });
    footZ.push(new THREE.Vector3(fx, 0.09, fz).applyMatrix4(S0));
  }

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
  // --- bocian: a rigged white stork that lives on the nest (one skinned mesh, rigid parts on bones)
  const stork = buildStork(new THREE.Vector3(poleTop.x - 0.05, sh + 0.47, poleTop.z + 0.05));

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
  for (const p of footZ) {                       // the two zniczs at the foot of the post
    const h2 = new THREE.Sprite(haloMat);
    h2.position.copy(p); h2.scale.setScalar(0.42); h2.renderOrder = 3; h2.name = 'foreground-znicz-halo-foot';
    group.add(h2);
  }

  // ------------------------------------------------------------- the stork's rig
  // A stork in profile, facing downwind (+x), built from rigid parts, each skinned to one bone:
  // body, chest (breathing), three neck segments, head, upper and lower bill, two-part wings,
  // tail, two-part legs. Calm idle life: breathing, looking around every few seconds, preening,
  // the bill-clatter with the head thrown back, shifting from one leg to the other, a lazy wing
  // stretch now and then, and every few minutes a short flight round the nest and back.
  // All motion eases (exponential approach to targets); nothing is allocated per frame.
  function buildStork(restWorld) {
    const NAMES = ['root', 'body', 'chest', 'neck1', 'neck2', 'neck3', 'head', 'billU', 'billL',
      'wingL1', 'wingL2', 'wingR1', 'wingR2', 'tail', 'legLU', 'legLL', 'legRU', 'legRL'];
    const PARENT = { body: 'root', chest: 'body', neck1: 'body', neck2: 'neck1', neck3: 'neck2', head: 'neck3',
      billU: 'head', billL: 'head', wingL1: 'body', wingL2: 'wingL1', wingR1: 'body', wingR2: 'wingR1',
      tail: 'body', legLU: 'body', legLL: 'legLU', legRU: 'body', legRL: 'legRU' };
    // joint positions at rest (mesh space: the feet at the origin, facing +x; L is the +z side)
    const J = {
      root: [0, 0, 0], body: [0.02, 0.41, 0], chest: [-0.01, 0.47, 0],
      neck1: [0.19, 0.52, 0], neck2: [0.245, 0.645, 0], neck3: [0.27, 0.77, 0], head: [0.258, 0.885, 0],
      billU: [0.302, 0.9, 0], billL: [0.302, 0.889, 0],
      wingL1: [0.13, 0.55, 0.105], wingL2: [-0.24, 0.505, 0.122], wingR1: [0.13, 0.55, -0.105], wingR2: [-0.24, 0.505, -0.122],
      tail: [-0.28, 0.47, 0],
      legLU: [0.02, 0.41, 0.045], legLL: [0.03, 0.19, 0.045], legRU: [0.02, 0.41, -0.045], legRL: [0.03, 0.19, -0.045],
    };
    const I = {}; NAMES.forEach((n, i) => { I[n] = i; });
    const bones = {};
    for (const n of NAMES) { bones[n] = new THREE.Bone(); bones[n].name = 'stork-' + n; }
    for (const n of NAMES) {
      if (n === 'root') continue;
      const pj = J[PARENT[n]], j = J[n];
      bones[PARENT[n]].add(bones[n]);
      bones[n].position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
    }
    bones.root.rotation.order = 'YXZ';
    bones.head.rotation.order = 'YXZ';

    // ---- geometry, every part on its bone
    const B = new Builder(false, true);
    B.emis = night;
    const WHITE = lin('#e4dfd5'), BLACK = lin('#141110'), RED = lin('#be4a2c'), BILL = lin('#c8562e');
    const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    const on = (bone) => ({ bone: I[bone] });
    const seg = (a, b, r0, r1, sides, col, bone) => rod(B, V(a), V(b), r0, r1, sides, col, on(bone));
    B.add(new THREE.SphereGeometry(1, 16, 12), M(-0.01, 0.47, 0, 0, 0, 0.1, 0.29, 0.145, 0.14), WHITE, on('chest'));
    seg([0.19, 0.52, 0], [0.245, 0.645, 0], 0.052, 0.042, 8, WHITE, 'neck1');
    B.add(new THREE.SphereGeometry(0.043, 8, 6), M(0.245, 0.645, 0), WHITE, on('neck2'));
    seg([0.245, 0.645, 0], [0.27, 0.77, 0], 0.042, 0.035, 8, WHITE, 'neck2');
    B.add(new THREE.SphereGeometry(0.036, 8, 6), M(0.27, 0.77, 0), WHITE, on('neck3'));
    seg([0.27, 0.77, 0], [0.258, 0.885, 0], 0.035, 0.03, 8, WHITE, 'neck3');
    B.add(new THREE.SphereGeometry(0.047, 10, 8), M(0.272, 0.895, 0, 0, 0, 0, 1.25, 0.95, 0.9), WHITE, on('head'));
    B.add(new THREE.SphereGeometry(0.008, 5, 4), M(0.292, 0.905, 0.038), BLACK, on('head'));
    B.add(new THREE.SphereGeometry(0.008, 5, 4), M(0.292, 0.905, -0.038), BLACK, on('head'));
    seg([0.302, 0.902, 0], [0.54, 0.838, 0], 0.019, 0.003, 7, BILL, 'billU');
    seg([0.302, 0.888, 0], [0.53, 0.832, 0], 0.013, 0.003, 6, BILL, 'billL');
    for (const side of [1, -1]) {
      const s1 = side > 0 ? 'wingL1' : 'wingR1', s2 = side > 0 ? 'wingL2' : 'wingR2';
      const j1 = J[s1], j2 = J[s2];
      // arm: white coverts above, black flight feathers along the trailing (lower) edge
      B.add(new THREE.SphereGeometry(1, 14, 8), M(j1[0] - 0.19, j1[1] - 0.035, j1[2] + side * 0.012, 0, 0, 0.12, 0.205, 0.085, 0.022), WHITE, {
        bone: I[s1], colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => { out.lerp(BLACK, smooth(-0.05, -0.35, ly)); },
      });
      // hand: the black primaries (shortened along the wing while folded)
      B.add(new THREE.SphereGeometry(1, 14, 8), M(j2[0] - 0.25, j2[1] - 0.045, j2[2] - side * 0.006, 0, 0, 0.2, 0.27, 0.052, 0.016), BLACK, on(s2));
    }
    B.add(new THREE.SphereGeometry(1, 10, 6), M(-0.33, 0.46, 0, 0, 0, 0.15, 0.1, 0.026, 0.075), WHITE, on('tail'));
    for (const side of [1, -1]) {
      const U = side > 0 ? 'legLU' : 'legRU', L = side > 0 ? 'legLL' : 'legRL', z = side * 0.045;
      seg([0.02, 0.41, z], [0.03, 0.19, z], 0.016, 0.012, 5, RED, U);
      seg([0.03, 0.19, z], [0.03, 0.012, z], 0.012, 0.01, 5, RED, L);
      seg([0.03, 0.008, z], [0.12, 0.006, z + side * 0.01], 0.006, 0.004, 3, RED, L);
      seg([0.03, 0.008, z], [-0.035, 0.006, z], 0.006, 0.004, 3, RED, L);
    }
    const geo = track(B.build(), geometries);
    const mat = track(patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), uniforms, 'stork', false), materials);
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.name = 'foreground-stork';
    mesh.frustumCulled = false;                 // it flies off its bind-pose bounds now and then
    mesh.position.copy(restWorld);
    mesh.add(bones.root);
    group.add(mesh);
    mesh.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(NAMES.map((n) => bones[n]));
    mesh.bind(skeleton);

    // ---- pose parameters (current, target, approach rate per second)
    const KEYS = ['pitch', 'crouch', 'yaw', 'n1', 'n2', 'n3', 'hYaw', 'hPitch', 'hRoll', 'bill',
      'wOpenL', 'wOpenR', 'wLiftL', 'wLiftR', 'tuckL', 'tuckR', 'legBack', 'trail', 'tail'];
    const cur = {}, tgt = {}, rate = {};
    for (const k of KEYS) { cur[k] = 0; tgt[k] = 0; rate[k] = 3; }
    cur.tuckL = tgt.tuckL = 1;                  // standing on its right leg
    const to = (k, v, r) => { tgt[k] = v; rate[k] = r; };
    const rest = (r = 2.2) => { for (const k of KEYS) if (k !== 'tuckL' && k !== 'tuckR' && k !== 'yaw') to(k, 0, r); };

    const QI = new THREE.Quaternion();
    // wing spread: the folded wing (length -x, chord -y) swings out to length +-z, chord -x
    const QSL = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)));
    const QSR = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
    const AX = new THREE.Vector3(1, 0, 0);
    const qOpen = new THREE.Quaternion(), qFlap = new THREE.Quaternion();
    let flap = 0, flapPhase = 0, flapAmp = 0, nib = 0, billOsc = 0;
    const fly = { x: 0, y: 0, z: 0, yaw: 0, bank: 0 };
    const FLIGHT_R = 4.6;

    function setWing(b1, b2, open, lift, side) {
      qOpen.copy(QI).slerp(side > 0 ? QSL : QSR, open);
      qFlap.setFromAxisAngle(AX, -side * (lift + flap * open));
      b1.quaternion.multiplyQuaternions(qFlap, qOpen);
      b2.scale.set(0.45 + 0.55 * open, 1, 1);
      b2.rotation.set(-side * flap * 0.35 * open, 0, 0);
    }
    function apply(t) {
      const br = Math.sin(t * TAU / 3.8);
      bones.root.position.set(fly.x, fly.y, fly.z);
      bones.root.rotation.set(fly.bank, fly.yaw + cur.yaw, 0);
      bones.body.position.y = J.body[1] - cur.crouch * 0.14;
      bones.body.rotation.z = cur.pitch + 0.012 * br;
      bones.chest.scale.set(1 + 0.01 * br, 1 + 0.03 * br, 1 + 0.03 * br);
      bones.neck1.rotation.z = cur.n1;
      bones.neck2.rotation.z = cur.n2;
      bones.neck3.rotation.set(0, cur.hYaw * 0.35, cur.n3 - 0.01 * br);
      bones.head.rotation.set(cur.hRoll, cur.hYaw * 0.65, cur.hPitch + nib);
      const bill = cur.bill + billOsc;
      bones.billU.rotation.z = bill * 0.3;
      bones.billL.rotation.z = -bill;
      setWing(bones.wingL1, bones.wingL2, cur.wOpenL, cur.wLiftL, 1);
      setWing(bones.wingR1, bones.wingR2, cur.wOpenR, cur.wLiftR, -1);
      bones.tail.rotation.z = cur.tail;
      const back = cur.legBack;
      bones.legLU.rotation.z = cur.tuckL * (1.15 - 2.0 * back) - cur.trail * 1.45;
      bones.legLL.rotation.z = -cur.tuckL * 2.3 * (1 - back) + cur.trail * 0.1;
      bones.legRU.rotation.z = cur.tuckR * (1.15 - 2.0 * back) - cur.trail * 1.45;
      bones.legRL.rotation.z = -cur.tuckR * 2.3 * (1 - back) + cur.trail * 0.12;
    }

    // ---- behaviours: each sets targets from its own clock `at`; rest() follows when it ends
    let action = null, at = 0, side = 1, variant = 0;
    const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (6 * x - 15) + 10); };
    const ACTIONS = {
      preen: { dur: 5, run(a) {
        if (a < this.dur - 1.1) {
          to('n1', 0.3, 2.4); to('n2', -1.2, 2.4); to('n3', -1.05, 2.4); to('hPitch', -0.45, 2.4);
          to('hYaw', side * 0.9, 2.4); to('hRoll', side * 0.35, 2.4); to('pitch', 0.06, 2);
          nib = 0.1 * Math.sin(a * 17) * Math.sin(a * 2.3) * smooth(0.9, 1.4, a);
        } else { nib = 0; rest(2.2); }
      } },
      clatter: { dur: 3.8, run(a) {
        if (a < 3.0) {
          to('n1', 0.42, 3.2); to('n2', 0.7, 3.2); to('n3', 0.55, 3.2); to('hPitch', 1.35, 3.2); to('pitch', 0.16, 2.5); to('hYaw', 0, 3);
          billOsc = a > 0.8 ? 0.2 * (0.5 + 0.5 * Math.sin(a * 46)) * smooth(0.8, 1.0, a) * (1 - smooth(2.7, 3.0, a)) : 0;
        } else { billOsc = 0; rest(2.4); }
      } },
      shift: { dur: 2.8, run(a) {
        const fromL = this.fromL;
        if (a < 1.1) { to('tuckL', 0, 3); to('tuckR', 0, 3); to('crouch', 0.06, 3); if (variant) to('yaw', this.yaw0 + variant * 0.35, 1.2); }
        else { to(fromL ? 'tuckR' : 'tuckL', 1, 2.4); to('crouch', 0, 2.5); }
      }, start() { this.fromL = cur.tuckL > 0.5; this.yaw0 = tgt.yaw; variant = rng() < 0.4 ? (Math.abs(tgt.yaw) > 0.3 ? -Math.sign(tgt.yaw) : (rng() < 0.5 ? -1 : 1)) : 0; } },
      stretch: { dur: 4.8, run(a) {
        if (a < 3.2) {
          if (variant === 0) {          // both wings raised half open, neck forward
            to('wOpenL', 0.5, 1.8); to('wOpenR', 0.5, 1.8); to('wLiftL', 0.55, 1.8); to('wLiftR', 0.55, 1.8);
            to('n1', -0.2, 2); to('hPitch', 0.2, 2); to('tail', 0.15, 2);
          } else {                     // one wing and the raised leg stretched back and down together
            to(side > 0 ? 'wOpenL' : 'wOpenR', 0.5, 1.8); to(side > 0 ? 'wLiftL' : 'wLiftR', -0.45, 1.8);
            to('legBack', 1, 1.8); to('pitch', -0.1, 1.8); to('n1', -0.15, 2);
          }
        } else rest(1.6);
      }, start() { variant = rng() < 0.6 ? 0 : 1; side = cur.tuckL > 0.5 ? 1 : -1; } },
      flight: { dur: 17.5, run(a, dt) {
        const T0 = 0.9, T1 = 15.4;
        if (a < T0) {                  // crouch, open the wings, both feet down
          to('crouch', 0.5, 4); to('wOpenL', 0.85, 3); to('wOpenR', 0.85, 3); to('tuckL', 0, 4); to('tuckR', 0, 4);
          to('n1', -0.5, 3); to('hPitch', 0.45, 3); to('pitch', -0.12, 3);
          flapAmp = 0.25;
        } else if (a < T1) {
          const s = ease((a - T0) / (T1 - T0)), ph = s * TAU;
          fly.x = FLIGHT_R * Math.sin(ph);
          fly.z = FLIGHT_R * Math.cos(ph) - FLIGHT_R;
          fly.y = 2.3 * Math.pow(Math.sin(Math.PI * s), 0.8) - 0.04 * Math.sin(flapPhase);
          fly.yaw = ph;
          fly.bank = -0.34 * Math.sin(Math.PI * s);
          to('crouch', 0, 5); to('wOpenL', 1, 3); to('wOpenR', 1, 3); to('trail', 1, 2.2);
          to('n1', -1.25, 2); to('n2', 0.15, 2); to('n3', 0.25, 2); to('hPitch', 0.95, 2); to('pitch', -0.28, 2); to('tail', 0.1, 2);
          const glide = smooth(-0.2, 0.4, Math.sin(a * 0.75 + 1.0));                  // stretches of gliding between flaps
          flapAmp = s < 0.16 || s > 0.86 ? 0.8 : 0.08 + 0.55 * (1 - glide);
        } else {                       // land, fold, settle on one leg
          fly.x = fly.y = fly.z = 0; fly.yaw = 0; fly.bank = 0;
          to('trail', 0, 4); to('crouch', a < T1 + 0.6 ? 0.35 : 0, 4);
          flapAmp = a < T1 + 0.7 ? 0.6 : 0;
          if (a > T1 + 0.7) { to('wOpenL', 0, 2.2); to('wOpenR', 0, 2.2); rest(2.2); }
          if (a > this.dur - 0.9) to('tuckL', 1, 2.2);
        }
        flapPhase += dt * TAU * 1.9;
        flap = flapAmp * Math.sin(flapPhase) + 0.1 * flapAmp;
      }, end() { flap = 0; flapAmp = 0; fly.x = fly.y = fly.z = fly.yaw = fly.bank = 0; } },
    };
    function start(name, now) {
      const A = ACTIONS[name];
      if (!A) return false;
      if (action && action.end) action.end();
      action = A; at = 0; side = rng() < 0.5 ? -1 : 1;
      nib = 0; billOsc = 0;
      if (A.start) A.start();
      if (name === 'stretch') tStretch = now + R(30, 60);
      if (name === 'flight') tFlight = now + R(240, 420);
      tMajor = now + A.dur + R(8, 18);
      return true;
    }
    function look() {
      if (rng() < 0.22) { to('hYaw', 0, 4); to('hPitch', 0, 4); to('hRoll', 0, 4); to('n3', 0, 4); }
      else {
        to('hYaw', (rng() < 0.5 ? -1 : 1) * R(0.25, 1.35), R(3.5, 6)); to('hPitch', R(-0.3, 0.15), 4);
        to('hRoll', R(-0.15, 0.15), 4); to('n3', R(-0.12, 0.1), 3); to('n1', R(-0.08, 0.06), 2);
      }
      tLook = clock + R(2.2, 6.5);
    }
    let clock = 0, tLook = 2.5, tMajor = R(10, 18), tStretch = R(30, 50), tFlight = R(150, 240);
    apply(0);
    return {
      update(t, dt) {
        dt = Math.min(dt, 0.1);
        clock = t;
        if (action) {
          at += dt;
          action.run(at, dt);
          if (at >= action.dur) { if (action.end) action.end(); action = null; rest(); tLook = t + R(0.8, 2.5); }
        } else if (t >= tFlight) start('flight', t);
        else if (t >= tStretch) start('stretch', t);
        else if (t >= tMajor) { const r = rng(); start(r < 0.4 ? 'preen' : r < 0.65 ? 'clatter' : 'shift', t); }
        else if (t >= tLook) look();
        for (let i = 0; i < KEYS.length; i++) { const k = KEYS[i]; cur[k] += (tgt[k] - cur[k]) * (1 - Math.exp(-dt * rate[k])); }
        apply(t);
      },
      play(name) { return start(name, clock); },
      get state() { return action ? Object.keys(ACTIONS).find((k) => ACTIONS[k] === action) + ' ' + at.toFixed(1) : 'idle'; },
      dispose() { skeleton.dispose(); },
    };
  }

  // ------------------------------------------------------------- handle
  const layout = { shrine: [shrine.x, shrine.z], stork: [st.x, st.z, st.height] };

  function update(t, dt) {
    if (!reduced) {
      uniforms.uFgTime.value = t;
      const f = 0.86 + 0.08 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2) + 0.06 * Math.sin(t * 13.7 + Math.sin(t * 1.9));
      uniforms.uFgCandle.value = f;
      haloMat.opacity = 0.42 * (0.85 + 0.15 * f);
      stork.update(t, dt);               // reduced motion: the stork stands still
    }
  }

  function resize() { /* nothing depends on the viewport */ }

  function dispose() {
    group.removeFromParent();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    stork.dispose();
    geometries.length = materials.length = textures.length = 0;
  }

  // stork.play(name) / stork.state: for the dev bench (preen, clatter, shift, stretch, flight)
  return { group, update, resize, dispose, layout, stork: { play: (n) => stork.play(n), get state() { return stork.state; } } };
}
