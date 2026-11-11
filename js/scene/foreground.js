/*
  Iskry · foreground.js — the near world, from the camera out to about 30 m.
  OWNER: Opus worker "foreground". Interface: CONTRACT.md (environment modules).

  createForeground(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose() }
  opts { firePosition = {x:-3, y:0, z:-2}, wind = 0.25 (m/s, mean, toward +x) }

  A Polish field edge at night, kept quiet (4 draw calls + 1 sprite, no per-frame work
  beyond a few uniforms):
    1. props    ONE merged mesh: a split-rail fence (płot z żerdzi) along a field road,
                a wooden roadside shrine (kapliczka) with a red votive candle (znicz),
                a white stork (bocian) asleep on its nest on an old pole,
                a log bench by the fire with a guitar leaning on it
    2. decals   the field road (polna droga: two dusty ruts with grass between) and
                soft contact shadows, cast away from the fire
    3. grass    instanced meadow tufts, dense and tall at the bottom corners of the frame,
                lit warm near the fire, swaying with the wind (still under reduced motion)
    4. flowers  instanced poppies (maki), cornflowers (chabry) and chamomile (rumianek)
    5. glow     the znicz's faint halo (additive sprite)

  Everything uses MeshLambertMaterial (lit by the fire's PointLight, fog: true), patched so
  that: the unlit side keeps a dim night tone (per-vertex emissive, a touch more on faces
  that look up at the sky); the low ground haze is mixed in exactly as sky.js mixes it
  into the ground (so bases melt into the meadow without outlines); grass and flowers sway
  in the vertex shader. Nothing sits below y = 0 (sky.js's ground does not write depth).
  No global side effects: no lights, fog, background or renderer state.
*/
import * as THREE from 'three';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: { x: -3, y: 0, z: -2 },
  wind: 0.25,                 // m/s to +x; grass lean and sway scale with it
  seed: 23,
  center: { x: 0, z: 12 },    // camera xz; sky.js measures its ground haze from here
  reach: 30,                  // m from center: nothing grows or stands beyond
  hazeColor: '#372013',       // sky.js's low ground haze (sRGB)
  nightTone: '#110b08',       // unlit faces (sRGB, before the sky-facing lift)
  // field road centreline (x, z), from under the camera off toward the village on the right
  path: [[0.9, 10], [0.55, 5], [0.75, 0.5], [1.55, -4.5], [3.0, -9.5], [5.0, -14.2], [7.9, -18.6], [10.8, -22.4]],
  fenceOffset: 2.45,          // m to the right of the road's centreline
  fenceFrom: 7.4,             // z where the fence starts (near the camera) ...
  fenceTo: -16.6,             // ... and where it ends
  shrine: { x: 4.35, z: -9.0, faceX: -1, faceZ: 0.75 },
  stork: { x: -9.4, z: -17.0, height: 6.4 },
  bench: { x: -1.6, z: -4.25, dirX: 1, dirZ: 0.35, length: 1.6 },   // just beyond the fire, facing it
  grassCount: 2600,
  flowerCount: 240,
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
  for (const k of ['shrine', 'stork', 'bench']) o[k] = { ...DEFAULTS[k], ...(opts[k] || {}) };   // partial overrides keep the rest
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

  // ---------------------------------------------------------- the road
  const curve = new THREE.CatmullRomCurve3(o.path.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const NP = 160;
  const road = curve.getSpacedPoints(NP);
  const roadRight = road.map((p, i) => {
    const t = curve.getTangentAt(i / NP);
    return new THREE.Vector3(-t.z, 0, t.x).normalize();
  });
  // signed lateral distance (right +) and nearest index, for planting
  function roadLateral(x, z) {
    let best = 1e9, bi = 0;
    for (let i = 0; i <= NP; i++) {
      const dx = x - road[i].x, dz = z - road[i].z, d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    const p = road[bi], r = roadRight[bi];
    return { lat: (x - p.x) * r.x + (z - p.z) * r.z, i: bi, d: Math.sqrt(best) };
  }

  // ------------------------------------------------------------- props
  const P = new Builder();
  P.emis = night;
  const jit = (c, j) => c.clone().multiplyScalar(1 + (rng() - 0.5) * j);

  // --- split-rail fence along the road's right side
  const WOOD = lin('#6e604f'), RAIL = lin('#7a6a55');
  const fenceLine = [];
  for (let i = 0; i <= NP; i++) {
    if (road[i].z > o.fenceFrom || road[i].z < o.fenceTo) continue;
    fenceLine.push(road[i].clone().addScaledVector(roadRight[i], o.fenceOffset));
  }
  const posts = [];
  {
    let acc = 0, next = 0;
    for (let i = 0; i < fenceLine.length; i++) {
      if (i > 0) acc += fenceLine[i].distanceTo(fenceLine[i - 1]);
      if (acc >= next || i === fenceLine.length - 1) {
        posts.push(fenceLine[i].clone());
        next = acc + R(2.35, 2.75);
      }
    }
  }
  // the shrine stands in a gap in the fence (a field entrance): no post or rail crowds it
  for (let k = posts.length - 1; k >= 0; k--) {
    if (Math.hypot(posts[k].x - o.shrine.x, posts[k].z - o.shrine.z) < 1.1) {
      if (k > 0) posts[k - 1].gapAfter = true;
      posts.splice(k, 1);
    }
  }
  const fenceInfo = [];
  posts.forEach((p, k) => {
    const h = R(1.12, 1.34);
    const lean = R(-0.05, 0.05), lean2 = R(-0.04, 0.04);
    const top = new THREE.Vector3(p.x + lean * h, h, p.z + lean2 * h);
    rod(P, new THREE.Vector3(p.x, 0.005, p.z), top, 0.062, 0.05, 6, jit(WOOD, 0.3));
    p.top = top; p.h = h;
    fenceInfo.push([+p.x.toFixed(2), +p.z.toFixed(2)]);
  });
  const broken = posts.length > 5 ? 3 : -1;     // one lower rail has come loose
  for (let k = 0; k < posts.length - 1; k++) {
    const a = posts[k], b = posts[k + 1];
    if (a.gapAfter) continue;
    for (const [hy, rr] of [[0.47, 0.036], [0.97, 0.04]]) {
      const ya = hy + R(-0.04, 0.04), yb = hy + R(-0.04, 0.04);
      const A = new THREE.Vector3(a.x, Math.min(ya, a.h - 0.08), a.z);
      const Bv = new THREE.Vector3(b.x, Math.min(yb, b.h - 0.08), b.z);
      if (k === broken && hy < 0.5) {
        // hangs from the far post, its near end in the grass
        A.set(a.x + (b.x - a.x) * 0.12, 0.05, a.z + (b.z - a.z) * 0.12);
      }
      const mid = A.clone().lerp(Bv, 0.5); mid.y -= R(0.02, 0.05);
      const col = jit(RAIL, 0.25);
      rod(P, A, mid, rr, rr * 0.95, 5, col);
      rod(P, mid, Bv, rr * 0.95, rr * 0.9, 5, col);
    }
  }

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

  // --- log bench by the fire, a guitar leaning on it
  const bn = o.bench;
  const bDir = new THREE.Vector3(bn.dirX, 0, bn.dirZ).normalize();
  const bFront = new THREE.Vector3(-bDir.z, 0, bDir.x);           // the side facing the camera
  if (bFront.z < 0) bFront.negate();
  const LR = 0.2;
  const LY = LR * 1.18;                                            // bark bumps included: nothing below y = 0
  const logA = new THREE.Vector3(bn.x, LY, bn.z).addScaledVector(bDir, -bn.length / 2);
  const logB = new THREE.Vector3(bn.x, LY, bn.z).addScaledVector(bDir, bn.length / 2);
  {
    const BARK = lin('#2f241b'), CUT = lin('#8a6c4c');
    const { m, len } = between(logA, logB);
    // rough bark: the radius wanders with the angle and along the log (a pure function of the
    // local position, so the caps and the sides still meet)
    const lg = new THREE.CylinderGeometry(LR, LR * 1.06, len, 16, 6, false);
    const la = lg.attributes.position;
    for (let i = 0; i < la.count; i++) {
      const x = la.getX(i), y = la.getY(i), z = la.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.05 * Math.sin(a * 7 + y * 3.1) + 0.035 * Math.sin(a * 13 - y * 7) + 0.03 * Math.sin(y * 4.3 + 1);
      la.setXYZ(i, x * k, y, z * k);
    }
    lg.computeVertexNormals();
    P.add(lg, m, BARK, {
      colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => {
        const r = Math.hypot(lx, lz) / LR;
        const cap = Math.abs(nx * bDir.x + nz * bDir.z) > 0.85 && Math.abs(ly) > len / 2 - 1e-4;
        if (cap) { out.copy(CUT).multiplyScalar(0.6 + 0.4 * (1 - r) + 0.15 * Math.sin(r * 26)); if (r > 0.9) out.copy(BARK).multiplyScalar(0.8); }
        else out.multiplyScalar(0.55 + 0.75 * Math.pow(Math.abs(Math.sin(Math.atan2(lz, lx) * 4.5 + ly * 2.2 + Math.sin(ly * 9))), 3));
      },
    });
    // a short stub of a cut branch
    const sb = new THREE.Vector3().copy(logA).lerp(logB, 0.68);
    rod(P, sb.clone().add(new THREE.Vector3(0, 0.12, 0)), sb.clone().add(new THREE.Vector3(0, 0.31, 0)).addScaledVector(bDir, 0.05), 0.04, 0.032, 6, BARK);
  }
  {
    // guitar (local: x right, y up the neck, +z out of the soundboard; base at the origin)
    // soundboard kept soft (about 60% of a honey spruce, desaturated) so it never competes with the flames
    const TOP = lin('#b4844f').lerp(new THREE.Color(0.17, 0.17, 0.17), 0.3).multiplyScalar(0.6), SIDE = lin('#5a301b'), NECK = lin('#4a2b18'), BOARD = lin('#1d130c');
    const rL = 0.185, cL = 0.19, rU = 0.14, cU = 0.42, D = 0.095;
    const yi = 0.3368, aL = Math.atan2(yi - cL, Math.sqrt(rL * rL - (yi - cL) ** 2)), aU = Math.atan2(yi - cU, Math.sqrt(rL * rL - (yi - cL) ** 2));
    const pts = [];
    const arc = (cx, cy, r, a0, a1, n) => { for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); } };
    arc(0, cL, rL, -Math.PI / 2, aL, 16);
    arc(0, cU, rU, aU, Math.PI / 2, 14);
    const right = pts.slice();
    for (let i = right.length - 2; i >= 1; i--) pts.push(new THREE.Vector2(-right[i].x, right[i].y));
    const shape = new THREE.Shape(pts);
    const lean = 0.45;                                               // rad back from vertical
    const face = bFront.clone().add(new THREE.Vector3(-0.25, 0, 0)).normalize();   // toward the fire and the camera
    const yaw = Math.atan2(face.x, face.z);
    const gBase = new THREE.Vector3(bn.x, 0.045, bn.z).addScaledVector(bDir, 0.3).addScaledVector(bFront, LR + 0.2);
    const gQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-lean, yaw, 0, 'YXZ'));
    const G0 = new THREE.Matrix4().compose(gBase, gQ, new THREE.Vector3(1, 1, 1));
    const faceW = new THREE.Vector3(0, 0, 1).applyQuaternion(gQ);
    const gAdd = (geo, m, col, oo) => P.add(geo, new THREE.Matrix4().multiplyMatrices(G0, m), col, oo);
    gAdd(new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 4 }), M(0, 0.012, -D), TOP, {
      colorFn: (x, y, z, nx, ny, nz, lx, ly, lz, out) => { if (nx * faceW.x + ny * faceW.y + nz * faceW.z < 0.8) out.copy(SIDE); },
    });
    gAdd(new THREE.CircleGeometry(0.044, 16), M(0, 0.372, 0.0015), lin('#070403'));                      // sound hole
    gAdd(new THREE.RingGeometry(0.047, 0.058, 20), M(0, 0.372, 0.001), lin('#dcc69a').multiplyScalar(0.55));   // rosette
    gAdd(new THREE.BoxGeometry(0.15, 0.026, 0.01), M(0, 0.15, 0.004), lin('#25150c'));                     // bridge
    gAdd(new THREE.BoxGeometry(0.052, 0.44, 0.036), M(0, 0.54 + 0.22, -0.02), NECK);                      // neck
    gAdd(new THREE.BoxGeometry(0.054, 0.51, 0.008), M(0, 0.47 + 0.255, 0.004), BOARD);                     // fretboard
    gAdd(new THREE.BoxGeometry(0.078, 0.18, 0.026), M(0, 0.98 + 0.085, -0.03, -0.22, 0, 0), lin('#2f1a0f')); // headstock
    // six strings as one pale strip each would shimmer at this distance; one faint band reads as strings
    gAdd(new THREE.BoxGeometry(0.03, 0.83, 0.002), M(0, 0.15 + 0.415, 0.0095), lin('#6e6256').multiplyScalar(0.7));
  }

  const propsGeo = track(P.build(), geometries);
  const propsMat = track(patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), uniforms, 'props', false), materials);
  const props = new THREE.Mesh(propsGeo, propsMat);
  props.name = 'foreground-props';
  group.add(props);

  // ------------------------------------------------------------ decals
  const Dk = new Builder(true);
  {
    // the road: lateral profile with two dusty ruts and a grassy crown
    const lats = [-1.35, -1.0, -0.8, -0.62, -0.42, -0.24, 0, 0.24, 0.42, 0.62, 0.8, 1.0, 1.35];
    const prof = (u) => {
      const au = Math.abs(u);
      const band = 0.4 * (1 - smooth(0.85, 1.35, au));          // the whole trodden band
      const rut = 0.55 * Math.exp(-((au - 0.6) ** 2) / (2 * 0.13 * 0.13));
      return Math.min(0.9, band + rut);
    };
    const DUST = lin('#8a7258'), DUSTE = lin('#2b1f16');
    const rows = [];
    for (let i = 0; i <= NP; i++) {
      const p = road[i], r = roadRight[i];
      const d = distC(p.x, p.z);
      const fade = (1 - smooth(23, o.reach + 0.5, d)) * (0.88 + 0.24 * Math.sin(i * 0.37) * Math.sin(i * 0.13 + 1));
      rows.push(lats.map((u) => {
        const x = p.x + r.x * u, z = p.z + r.z * u;
        return { pos: [x, 0.012, z], col: [DUST.r, DUST.g, DUST.b, prof(u) * fade], emi: [DUSTE.r, DUSTE.g, DUSTE.b] };
      }));
    }
    for (let i = 0; i < NP; i++) {
      for (let j = 0; j < lats.length - 1; j++) {
        const a = rows[i][j], b = rows[i][j + 1], c = rows[i + 1][j], d = rows[i + 1][j + 1];
        Dk.tri(a.pos, b.pos, c.pos, a.col, b.col, c.col, a.emi, b.emi, c.emi);    // counter-clockwise from above
        Dk.tri(b.pos, d.pos, c.pos, b.col, d.col, c.col, b.emi, d.emi, c.emi);
      }
    }
  }
  // soft contact shadows, stretched away from the fire
  const Z3 = [0, 0, 0];
  function blob(x, z, rx, rz, alpha, away = 0.35) {
    const dx = x - F.x, dz = z - F.z, dl = Math.hypot(dx, dz) || 1;
    const ux = dx / dl, uz = dz / dl;
    const cx = x + ux * rx * away * 0.5, cz = z + uz * rx * away * 0.5;
    const n = 18, y = 0.016;
    const ctr = [cx, y, cz], cc = [0, 0, 0, alpha], ce = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const pt = (k) => {
        const a = (k / n) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        // ellipse with its long axis away from the fire
        const along = ca * rx * (1 + away), across = sa * rz;
        return [cx + ux * along - uz * across, y, cz + uz * along + ux * across];
      };
      Dk.tri(ctr, pt(i + 1), pt(i), cc, ce, ce, Z3, Z3, Z3);
    }
  }
  const benchMid = new THREE.Vector3().addVectors(logA, logB).multiplyScalar(0.5);
  {
    // log: a few blobs along it
    for (let k = 0; k <= 4; k++) { const p = logA.clone().lerp(logB, k / 4); blob(p.x, p.z, 0.42, 0.36, 0.55, 0.6); }
    blob(shrine.x, shrine.z, 0.32, 0.3, 0.5);
    blob(st.x, st.z, 0.45, 0.4, 0.45, 0.2);
    for (const p of posts) blob(p.x, p.z, 0.16, 0.14, 0.35, 0.3);
  }
  const decalGeo = track(Dk.build(), geometries);
  const decalMat = track(patchMaterial(new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }), uniforms, 'decal', false), materials);
  const decals = new THREE.Mesh(decalGeo, decalMat);
  decals.name = 'foreground-decals';
  decals.renderOrder = -1;            // under fire.js's additive ground glow (renderOrder 0)
  group.add(decals);

  // ------------------------------------------------------------- planting
  // Keep-out and height shaping shared by grass and flowers.
  const benchSeg = (x, z) => {
    const ax = logB.x - logA.x, az = logB.z - logA.z;
    const t = THREE.MathUtils.clamp(((x - logA.x) * ax + (z - logA.z) * az) / (ax * ax + az * az), 0, 1);
    return Math.hypot(x - (logA.x + ax * t), z - (logA.z + az * t));
  };
  function site(x, z) {
    // returns a height multiplier (0 = nothing grows here)
    const df = Math.hypot(x - F.x, z - F.z);
    if (df < 1.75) return 0;
    let k = smooth(1.75, 3.2, df) * 0.6 + 0.4 * smooth(1.75, 2.2, df);
    const rl = roadLateral(x, z);
    const al = Math.abs(rl.lat);
    if (al < 1.15 && rl.d < 1.4) {
      if (al > 0.38 && al < 0.84) return 0;        // the ruts
      k *= al <= 0.38 ? 0.45 : 0.75;               // the crown and the verge are cropped short
    } else if (al < 1.9 && rl.d < 2.2) k *= 0.72;
    if (benchSeg(x, z) < LR + 0.12) return 0;
    if (Math.hypot(x - shrine.x, z - shrine.z) < 0.16) return 0;
    if (Math.hypot(x - st.x, z - st.z) < 0.2) return 0;
    return k;
  }
  // inside the (slightly widened) view, out to `reach`
  const inView = (x, z) => {
    const dz = C.z - z;
    if (dz < 3.6) return false;
    return Math.abs(x - C.x) < 0.74 * dz + 0.9 && distC(x, z) < o.reach;
  };

  // --- grass tuft geometry (indexed, unit height)
  function tuftGeometry(blades) {
    const pos = [], nor = [], col = [], idx = [];
    const S = 3;
    const tints = [lin('#8a7a4c'), lin('#66703c'), lin('#7c7444'), lin('#556238')];
    for (let b = 0; b < blades; b++) {
      const ang = R(0, TAU), dx = Math.cos(ang), dz = Math.sin(ang);
      const lean = R(0.12, 0.42), h = R(0.55, 1), w = R(0.016, 0.03);
      const ox = R(-0.07, 0.07), oz = R(-0.07, 0.07);
      const wx = -dz, wz = dx;
      const tint = tints[(rng() * tints.length) | 0];
      const base = pos.length / 3;
      for (let s = 0; s <= S; s++) {
        const t = s / S;
        const y = h * t;
        const off = lean * h * t * t;
        const cx = ox + dx * off, cz = oz + dz * off;
        const a = 2 * lean * h * t;
        let nx = -dx * h, ny = a + 0.6 * Math.hypot(h, a), nz = -dz * h;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const shade = 0.22 + 0.78 * Math.pow(t, 0.85);
        if (s < S) {
          const hw = w * (1 - 0.8 * t) * 0.5;
          pos.push(cx - wx * hw, y, cz - wz * hw, cx + wx * hw, y, cz + wz * hw);
          nor.push(nx, ny, nz, nx, ny, nz);
          col.push(tint.r * shade, tint.g * shade, tint.b * shade, tint.r * shade, tint.g * shade, tint.b * shade);
        } else {
          pos.push(cx, y, cz); nor.push(nx, ny, nz); col.push(tint.r * shade, tint.g * shade, tint.b * shade);
        }
      }
      for (let s = 0; s < S - 1; s++) {
        const i0 = base + s * 2;
        idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
      }
      const l = base + (S - 1) * 2;
      idx.push(l, l + 1, l + 2);
    }
    const n = pos.length / 3;
    const emi = new Float32Array(n * 3), glo = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = pos[i * 3 + 1];
      const k = 0.55 + 0.6 * t;
      emi[i * 3] = night.r * k; emi[i * 3 + 1] = night.g * k; emi[i * 3 + 2] = night.b * k;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aEmis', new THREE.BufferAttribute(emi, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glo, 3));
    g.setIndex(idx);
    return g;
  }

  const grassGeo = track(tuftGeometry(reduced ? 6 : 7), geometries);
  const swayMat = track(patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), uniforms, 'sway', true), materials);
  const grassCount = Math.max(0, o.grassCount | 0);
  const grass = new THREE.InstancedMesh(grassGeo, swayMat, Math.max(1, grassCount));
  grass.name = 'foreground-grass';
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3(), c4 = new THREE.Color();
  let gi = 0, tries = 0;
  while (gi < grassCount && tries < grassCount * 30) {
    tries++;
    // depth: denser close by (the bottom edge of the frame), thinning out to `reach`
    const u = rng();
    const dz = 3.8 + Math.pow(u, 1.9) * 31;
    const z = C.z - dz;
    const x = C.x + (rng() * 2 - 1) * (0.74 * dz + 0.9);
    if (!inView(x, z)) continue;
    const k = site(x, z);
    if (k <= 0) continue;
    const d = distC(x, z);
    const keep = 1 - smooth(o.reach - 7, o.reach, d);
    if (rng() > keep) continue;
    // height: tall in the near corners, meadow-height elsewhere, short by the fire's sightline
    const sx = (x - C.x) / (0.74 * dz);                         // -1..1 across the view
    let h = R(0.28, 0.55);
    if (dz < 8.5) h = R(0.35, 0.62) + 0.45 * smooth(0.25, 0.85, Math.abs(sx)) * (1 - smooth(5.5, 8.5, dz));
    const nearFire = Math.hypot(x - F.x, z - F.z);
    h *= k * (0.75 + 0.25 * smooth(2.5, 6, nearFire));
    if (h < 0.07) continue;
    p4.set(x, 0, z);
    q4.setFromAxisAngle(UP, R(0, TAU));
    const sxz = R(0.8, 1.25);
    s4.set(sxz, h, sxz);
    m4.compose(p4, q4, s4);
    grass.setMatrixAt(gi, m4);
    c4.setScalar(R(0.75, 1.15));
    grass.setColorAt(gi, c4);
    gi++;
  }
  grass.count = gi;
  grass.instanceMatrix.needsUpdate = true;
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  grass.computeBoundingSphere();
  group.add(grass);

  // --- flowers: poppies, cornflowers, chamomile (heads at the top of a thin stem)
  function flowerGeometry() {
    const B = new Builder();
    B.emis = night.clone().multiplyScalar(0.8);
    const STEM = lin('#1d2410');
    const hgt = 1;
    // a gently bowed stem (two crossed strips), the head nodding at its tip
    const bow = (t) => 0.09 * t * t;
    for (const rot of [0, Math.PI / 2]) {
      const sg = new THREE.PlaneGeometry(0.008, hgt, 1, 4);
      const sp = sg.attributes.position;
      for (let i = 0; i < sp.count; i++) { const t = sp.getY(i) / hgt + 0.5; sp.setXYZ(i, sp.getX(i) + (rot ? 0 : bow(t)), t * hgt, sp.getZ(i) + (rot ? bow(t) : 0)); }
      sg.computeVertexNormals();
      B.add(sg, M(0, 0, 0, 0, rot, 0), STEM);
    }
    const head = new THREE.IcosahedronGeometry(0.027, 0);
    B.add(head, M(bow(1), hgt, 0, 0, 0, 0.5, 1, 1.3, 1), new THREE.Color(1, 1, 1));
    const g = B.build();
    return g;
  }
  const flowerGeo = track(flowerGeometry(), geometries);
  const flowerCount = Math.max(0, o.flowerCount | 0);
  const flowers = new THREE.InstancedMesh(flowerGeo, swayMat, Math.max(1, flowerCount));
  flowers.name = 'foreground-flowers';
  const KINDS = [
    { c: lin('#b4271b'), w: 0.45, s: 1.0 },     // mak
    { c: lin('#3858b8'), w: 0.35, s: 0.8 },     // chaber
    { c: lin('#e3ddc8'), w: 0.2, s: 0.65 },     // rumianek
  ];
  const pickKind = () => { let r = rng(); for (const k of KINDS) { if ((r -= k.w) <= 0) return k; } return KINDS[0]; };
  let fi = 0; tries = 0;
  const plant = (x, z, hMul = 1) => {
    if (fi >= flowerCount || !inView(x, z)) return;
    if (C.z - z < 7.5 && rng() < 0.65) return;     // unlit heads close by read as dark dots: keep few
    if (z > F.z + 0.3 && Math.hypot(x - F.x, z - F.z) < 6.5) return;   // between us and the fire they are dark stalks
    const k = site(x, z);
    if (k <= 0.3) return;
    const kind = pickKind();
    const h = R(0.24, 0.5) * hMul;
    p4.set(x, 0, z);
    q4.setFromAxisAngle(UP, R(0, TAU));
    const hs = kind.s * R(0.85, 1.2);
    s4.set(hs, h, hs);
    m4.compose(p4, q4, s4);
    flowers.setMatrixAt(fi, m4);
    c4.copy(kind.c).multiplyScalar(R(0.7, 1.05));
    flowers.setColorAt(fi, c4);
    fi++;
  };
  // drifts of flowers along the road's verges, a handful at the shrine's foot, a few by the fire
  for (let i = 0; i < 12; i++) {
    const a = R(0, TAU), r = R(0.2, 0.55);
    plant(shrine.x + Math.cos(a) * r, shrine.z + Math.sin(a) * r, 0.9);
  }
  for (let i = 0; i < 18; i++) {
    // only beyond the fire, where their lit side faces the camera (in front they are dark stalks)
    const a = R(Math.PI * 1.05, Math.PI * 1.95), r = R(2.2, 5.5);
    plant(F.x + Math.cos(a) * r, F.z + Math.sin(a) * r);
  }
  while (fi < flowerCount && tries < flowerCount * 40) {
    tries++;
    const dz = 3.8 + Math.pow(rng(), 1.6) * 24;
    const z = C.z - dz;
    let x;
    if (rng() < 0.55) {
      // verge of the road
      const rl = roadLateral(C.x, z);
      const p = road[rl.i], r = roadRight[rl.i];
      const side = rng() < 0.5 ? -1 : 1;
      const off = side * R(1.05, 1.9);
      x = p.x + r.x * off;
      plant(x + R(-0.2, 0.2), p.z + r.z * off + R(-0.2, 0.2));
    } else {
      x = C.x + (rng() * 2 - 1) * (0.74 * dz + 0.9);
      // clustered: only where a slow noise says a patch grows
      const patch = 0.5 + 0.5 * Math.sin(x * 0.9 + 1.3) * Math.sin(z * 0.7 - 0.4);
      if (rng() < patch * patch) plant(x, z);
    }
  }
  flowers.count = fi;
  flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
  flowers.computeBoundingSphere();
  group.add(flowers);

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
  const layout = {
    road: o.path.slice(),
    fence: fenceInfo,
    shrine: [shrine.x, shrine.z],
    stork: [st.x, st.z, st.height],
    bench: [+benchMid.x.toFixed(2), +benchMid.z.toFixed(2)],
    grass: gi, flowers: fi,
  };

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
    grass.dispose(); flowers.dispose();
    geometries.length = materials.length = textures.length = 0;
  }

  return { group, update, resize, dispose, layout };
}
