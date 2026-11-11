/*
  Iskry · fence.js — the old split-rail fence (płot z żerdzi) along the field road.
  OWNER: Opus worker "fence". Interface: CONTRACT.md (environment modules).
  Placement from js/scene/layout.js (FENCE, fenceLine, SHRINE, ZONES); opts may override it.

  createFence(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose(), setTimeOfDay(tod), layout }
  opts { firePosition = FIRE, wind = 0.25, fence = FENCE, shrine = SHRINE, seed = FENCE.seed }

  What stands there
    posts     hand-split and round-ish timbers (round, half-split, quarter-split, axe-hewn), uneven,
              each leaning its own way, tops sawn flat, sawn at a slant, axe-pointed or rotting.
              The two posts of the field gate at the shrine are stouter; no post within gateGap of it.
    rails     żerdzie: long thin poles, tapering, bowed and sagging, one or two spans long, overlapping
              at the posts and fastened with wire, nails or wooden pegs; rails stop short at the gate.
    oddities  one support where a rotten post was replaced by a pair of stakes bound with withies,
              an X-braced span, one rail hanging loose with its end in the grass, one fallen in the
              grass in front of the fence (with its broken wire left on the posts), a gate pole leaning
              on the far gate post.

  Rendering: ONE merged indexed mesh (real cross-sections, built once) with one MeshStandardMaterial,
  patched with a procedural wood shader: grain along the length (and around knots), checks and
  cracks, knots, bark remnants, end grain with rings and radial checks on cut faces, rot, moss on the
  north faces and at the damp base, lichen, rusty wire; bump from analytic height via derivatives,
  roughness and metalness per texel. Lit by the fire's PointLight (warm highlights on the fire side),
  a dim night tone on the unlit side, sky.js's low ground haze, the ground tone by 30 m, and fog.
  A second, tiny transparent mesh draws the soft contact shadows on the ground (the ground writes no
  depth, so nothing here goes below y = 0). Two draw calls. No per-frame work.
*/
import * as THREE from 'three';
import { FIRE, FENCE, SHRINE, ZONES, fenceLine } from './layout.js';

const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,
  fence: FENCE,
  shrine: SHRINE,
  center: ZONES.center,        // sky.js measures its ground haze from here
  hazeColor: '#372013',        // sky.js's low ground haze (sRGB)
  groundTone: '#0c0806',       // sky.js's ground tone near 30 m (sRGB): the fence fades to it
  // dim sky light on the unlit side: albedo x this (linear), a little more on faces that look up
  night: [0.026, 0.019, 0.015],
};

// sRGB palette (converted to linear for the shader)
const PALETTE = {
  uSilver: '#8e8a83',          // old weathered wood, silver-grey
  uBrown: '#6b5848',           // the brown under the grey (less weathered wood, grooves)
  uEnd: '#6f675d',             // end grain on cut faces
  uBark: '#463a30',            // bark remnants, knots
  uRot: '#2c2118',             // rotten wood
  uMoss: '#4c5728',            // moss (reads olive-brown in the firelight)
  uLichen: '#959986',          // pale grey-green lichen
  uIron: '#33261f',            // wire and nail heads
  uRust: '#7a3f1f',
};

const TAU = Math.PI * 2;
const NORTH = [-0.866, 0, 0.5];   // compass azimuth 0 in world space (CONTRACT.md: A -> (sin(A-120), 0, -cos(A-120)))

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lin = (hex) => new THREE.Color(hex);   // sRGB hex -> linear working colour

// ------------------------------------------------------------------ shader
const VERT_PARS = /* glsl */ `
  attribute vec4 aWood;      // u along (m), v around (m), piece seed, kind
  attribute vec2 aFx;        // rot, weathering
  varying vec4 vWood;
  varying vec2 vFx;
  varying vec3 vFW;
  varying vec3 vFWN;
`;
const VERT_MAIN = /* glsl */ `
  #include <worldpos_vertex>
  vWood = aWood;
  vFx = aFx;
  vFW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vFWN = normalize( mat3( modelMatrix ) * objectNormal );
`;
const FRAG_PARS = /* glsl */ `
  varying vec4 vWood;
  varying vec2 vFx;
  varying vec3 vFW;
  varying vec3 vFWN;
  uniform vec3 uSilver, uBrown, uEnd, uBark, uRot, uMoss, uLichen, uIron, uRust;
  uniform vec3 uNight, uHaze, uGround;
  uniform vec2 uCenter;
  float fH( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float fN( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 w = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( fH( i ), fH( i + vec2( 1.0, 0.0 ) ), w.x ), mix( fH( i + vec2( 0.0, 1.0 ) ), fH( i + vec2( 1.0, 1.0 ) ), w.x ), w.y );
  }
  // bump from a height in metres (screen-space derivatives, unnormalised so the slope is physical)
  vec3 fBump( vec3 p, vec3 n, float h ) {
    vec3 dpx = dFdx( p ), dpy = dFdy( p );
    vec3 r1 = cross( dpy, n ), r2 = cross( n, dpx );
    float det = dot( dpx, r1 );
    vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
    return normalize( abs( det ) * n - grad );
  }
`;
// the wood itself: albedo, height (m), roughness, metalness, contact AO
const FRAG_WOOD = /* glsl */ `
  #include <color_fragment>
  float fh = 0.0, fRough = 0.88, fMetal = 0.0;
  {
    float u = vWood.x, v = vWood.y, sd = vWood.z, kind = vWood.w;
    vec3 wn = normalize( vFWN );
    float y = vFW.y;
    float north = dot( wn, vec3( ${NORTH[0]}, ${NORTH[1].toFixed(1)}, ${NORTH[2]} ) );
    // the damp band at the base (wicks up from the wet grass), with a ragged top edge
    float lowF = y < 0.45 ? 1.0 - smoothstep( 0.03, 0.38, y + 0.1 * ( fN( vec2( u * 2.5, v * 9.0 + sd * 3.0 ) ) - 0.5 ) ) : 0.0;
    vec3 alb;
    if ( kind > 2.5 && kind < 3.5 ) {
      // iron: wire and nail heads, mostly rust
      float r = fN( vec2( u * 45.0, v * 70.0 + sd ) ) * 0.6 + fN( vec2( u * 9.0, sd ) ) * 0.4;
      alb = mix( uIron, uRust, smoothstep( 0.3, 0.75, r ) );
      fRough = 0.45 + 0.4 * r;
      fMetal = 0.5 * ( 1.0 - smoothstep( 0.3, 0.6, r ) );
      fh = 0.0002 * r;
      lowF *= 0.4;
    } else if ( kind > 3.5 && kind < 4.5 ) {
      // withy (a twisted willow band): bark with a spiral of strands
      float tw = fract( u * 22.0 + v * 140.0 );
      float st = smoothstep( 0.05, 0.3, tw ) * ( 1.0 - smoothstep( 0.7, 0.95, tw ) );
      alb = uBark * ( 0.8 + 0.5 * fN( vec2( u * 10.0, v * 30.0 + sd ) ) ) * ( 0.75 + 0.35 * st );
      fh = 0.0012 * st;
      fRough = 0.8;
    } else if ( kind > 1.5 ) {
      // cut faces: end grain (2) or a rotten top (5); (u, v) are offsets from the pith in metres
      vec2 q = vec2( u, v );
      float r = length( q );
      float ringC = r * 115.0 + 1.6 * fN( q * 28.0 + sd * 7.0 ) + 0.5 * fN( q * 90.0 );
      float rAA = 1.0 - smoothstep( 0.3, 0.8, fwidth( ringC ) );
      float late = smoothstep( 0.6, 0.92, fract( ringC ) ) * rAA;
      float ang = atan( q.y, q.x ) / 6.28318 + 0.5;
      float ck = ang * 9.0 + 0.35 * fN( q * 25.0 + sd );
      float cOn = step( 0.45, fH( vec2( floor( ck ), sd * 3.1 ) ) ) * smoothstep( 0.006, 0.025, r );
      float cW = 0.025 + 0.05 * smoothstep( 0.0, 0.09, r );
      float chk = cOn * ( 1.0 - smoothstep( cW, cW + fwidth( ck ) * 1.5, abs( fract( ck ) - 0.5 ) ) );
      alb = uEnd * ( 0.8 + 0.28 * late ) * ( 0.8 + 0.35 * fN( q * 14.0 + sd * 5.0 ) );
      alb = mix( alb, alb * vec3( 0.7, 0.8, 0.62 ), smoothstep( 0.5, 0.8, fN( q * 9.0 + sd ) ) );   // algae stains
      alb = mix( alb, alb * 0.2, chk );
      alb *= 1.0 - 0.45 * ( 1.0 - smoothstep( 0.002, 0.007, r ) );                                 // the pith
      fh = 0.0003 * late - 0.003 * chk;
      fRough = 0.93;
      if ( kind > 4.5 ) {
        float cr = fN( q * 55.0 + sd ) * 0.6 + fN( q * 170.0 ) * 0.4;
        alb = mix( uRot, uMoss * 0.6, smoothstep( 0.55, 0.78, fN( q * 22.0 + 3.0 ) ) ) * ( 0.6 + 0.7 * cr );
        fh = 0.005 * cr;
        fRough = 0.97;
      }
    } else {
      // the long faces: split heartwood (0) or the round outside of the pole (1)
      float rotA = vFx.x, weather = vFx.y;
      // knots: at most one per 0.43 m cell along the piece, the grain flows round them
      float kc = floor( u * 2.3 );
      float kOn = step( 0.5, fH( vec2( kc, sd * 17.0 + 1.3 ) ) );
      float kU = ( kc + 0.25 + 0.5 * fH( vec2( kc, sd + 4.1 ) ) ) / 2.3;
      float kV = 0.02 + 0.3 * fH( vec2( kc, sd + 8.7 ) );
      float kR = 0.007 + 0.014 * fH( vec2( kc, sd + 2.9 ) );
      vec2 kd = vec2( ( u - kU ) * 0.7, v - kV );
      float kDist = length( kd );
      float kInf = kOn * exp( -( kDist * kDist ) / ( kR * kR * 7.0 ) );
      float vg = v + sign( kd.y ) * kR * 1.4 * kInf;
      vg += 0.004 * sin( u * 1.7 + sd * 9.0 ) + 0.014 * ( fN( vec2( u * 0.6, sd * 3.0 ) ) - 0.5 );
      // grain: broad streaks and fine raised late-wood ridges, faded where they would alias
      float c1 = vg * 55.0, c2 = vg * 170.0;
      float a1 = 1.0 - smoothstep( 0.3, 0.9, fwidth( c1 ) );
      float a2 = 1.0 - smoothstep( 0.3, 0.9, fwidth( c2 ) );
      float g1 = mix( 0.5, fN( vec2( u * 1.4, c1 ) ), a1 );
      float g2 = a2 > 0.0 ? mix( 0.5, fN( vec2( u * 4.5, c2 ) ), a2 ) : 0.5;
      float grain = smoothstep( 0.15, 0.85, g1 * 0.6 + g2 * 0.4 );
      // eroded early wood: thin dark grooves between the raised late-wood ridges
      float c3 = vg * 95.0 + 0.6 * fN( vec2( u * 0.9, sd ) );
      float a3 = 1.0 - smoothstep( 0.25, 0.8, fwidth( c3 ) );
      float groove = 0.0;
      if ( a3 > 0.0 ) { float gr = 1.0 - abs( 2.0 * fN( vec2( u * 2.2, c3 ) ) - 1.0 ); groove = pow( gr, 7.0 ) * a3; }
      // checks: long thin splits along the grain that open and close
      float split = kind < 0.5 ? 1.0 : 0.0;
      float cc = vg * mix( 16.0, 24.0, split ) + 0.9 * fN( vec2( u * 0.8, sd * 7.0 ) );
      float cI = floor( cc );
      float cOn = step( mix( 0.5, 0.3, split ), fH( vec2( cI, sd * 5.3 ) ) );
      float fwc = fwidth( cc );
      float crack = 0.0;
      if ( cOn > 0.0 && abs( fract( cc ) - 0.5 ) < 0.1 + fwc * 1.3 ) {
        cOn *= smoothstep( 0.4, 0.62, fN( vec2( u * ( 0.5 + 0.6 * fH( vec2( cI, 1.7 ) ) ) + cI * 5.1, cI * 1.3 ) ) );
        float cW = 0.05 * cOn * ( 0.5 + 0.8 * fN( vec2( u * 3.0, cI ) ) );
        crack = cOn * ( 1.0 - smoothstep( cW, cW + fwc * 1.3, abs( fract( cc ) - 0.5 ) ) );
      }
      // colour: grey where the weather has had it, brown in the grooves and on younger wood
      vec3 wood = mix( uBrown, uSilver, clamp( weather * ( 0.7 + 0.6 * grain ), 0.0, 1.0 ) );
      wood *= 0.58 + 0.62 * grain;
      wood *= 1.0 - 0.45 * groove;
      wood *= 0.9 + 0.2 * fN( vec2( u * 0.5, v * 6.0 + sd * 2.0 ) );
      // weathering streaks running down from the top (rain), darker toward the north side
      wood *= 0.9 + 0.1 * smoothstep( -0.6, 0.6, -north );
      float kCore = kOn * ( 1.0 - smoothstep( kR * 0.55, kR, kDist ) );
      float kRim = kOn * smoothstep( kR * 0.45, kR, kDist ) * ( 1.0 - smoothstep( kR, kR * 1.6, kDist ) );
      wood = mix( wood, uBark * 0.75, kCore * 0.9 );
      wood *= 1.0 - 0.22 * kRim;
      wood = mix( wood, wood * 0.16, crack );
      fh = 0.0005 * grain - 0.0007 * groove - 0.003 * crack + 0.0012 * kRim - 0.0008 * kCore;
      fRough = 0.84 + 0.1 * grain;
      float barkM = 0.0;
      // bark remnants on some round poles, with their fissures
      if ( kind > 0.5 && fH( vec2( sd, 9.2 ) ) < 0.45 ) {
        // long strips along the grain with torn, fibrous edges
        float bn = fN( vec2( u * 0.6, v * 15.0 ) + sd * 11.0 ) * 0.66 + fN( vec2( u * 2.5, v * 40.0 ) ) * 0.24 + fN( vec2( u * 14.0, v * 110.0 ) ) * 0.1;
        float bark = smoothstep( 0.69, 0.72, bn );
        barkM = bark;
        float fiss = fN( vec2( u * 3.0, v * 42.0 + sd ) );
        float fA = 1.0 - smoothstep( 0.3, 0.9, fwidth( v * 42.0 ) );
        wood = mix( wood, mix( uBark, wood, 0.25 ) * ( 0.6 + 0.6 * mix( 0.5, fiss, fA ) ), bark );
        wood *= 1.0 - 0.3 * ( smoothstep( 0.66, 0.69, bn ) - bark );   // the torn edge (bast fibres)
        fh += bark * ( 0.0015 + 0.0016 * fiss * fA );
        fRough = mix( fRough, 0.95, bark );
      }
      alb = wood;
      // lichen: pale rosettes, mostly on the north and on faces that look up
      float lzone = smoothstep( 0.45, 0.7, fN( vec2( u * 1.3, v * 2.0 ) + sd * 1.7 ) ) * smoothstep( 0.7, 0.95, weather );
      if ( lzone > 0.0 ) {
        float lf = fN( vec2( u * 55.0, v * 60.0 ) );
        float ln = fN( vec2( u * 28.0, v * 42.0 ) + sd * 3.3 ) * 0.6 + lf * 0.4;
        float lich = smoothstep( 0.66, 0.71, ln ) * lzone * ( 0.3 + 0.7 * smoothstep( -0.2, 0.6, max( north, wn.y ) ) );
        lich *= ( 0.45 + 0.55 * smoothstep( 0.35, 0.75, lf ) ) * ( 1.0 - 0.6 * barkM );   // a crust, not a flat stain
        alb = mix( alb, uLichen * ( 0.75 + 0.3 * ln ), lich * 0.45 );
        fh += lich * 0.0005;
      }
      // moss: on the north faces, at the damp base, a little on the tops of rails
      float mossF = smoothstep( 0.2, 0.9, north ) * 0.45 + lowF * 0.85 + smoothstep( 0.6, 0.95, wn.y ) * 0.25 + rotA * 0.4;
      if ( mossF > 0.68 ) {
        float mn = fN( vec2( u * 2.5, v * 8.0 ) + sd * 5.0 ) * 0.7 + fN( vec2( u * 11.0, v * 30.0 ) + sd ) * 0.3;
        float moss = smoothstep( 0.74, 0.86, mossF * ( 0.35 + 0.75 * mn ) );
        if ( moss > 0.0 ) {
          float mm = fN( vec2( u * 30.0, v * 30.0 ) + sd );
          alb = mix( alb, uMoss * ( 0.55 + 0.6 * mm ), moss );
          fh += moss * 0.0016 * mm;
          fRough = mix( fRough, 0.95, moss );
        }
      }
      // rot creeping down from a rotten top
      if ( rotA > 0.0 ) {
        alb = mix( alb, uRot, rotA * 0.85 * smoothstep( 0.25, 0.65, fN( vec2( u * 6.0, v * 10.0 + sd ) ) ) );
        fh += rotA * 0.002 * fN( vec2( u * 40.0, v * 40.0 ) );
      }
    }
    // damp: darker, browner, a touch of sheen
    alb = mix( alb, alb * vec3( 0.5, 0.44, 0.38 ), lowF );
    fRough = mix( fRough, 0.62, lowF * 0.75 );
    // contact AO: the grass and the ground close round the base; undersides near the ground
    float ao = mix( 0.32, 1.0, smoothstep( 0.0, 0.32, y ) );
    ao *= 1.0 - 0.45 * max( -wn.y, 0.0 ) * ( 1.0 - smoothstep( 0.0, 0.25, y ) );
    diffuseColor.rgb *= alb * ao;
  }
`;
const FRAG_ROUGH = /* glsl */ `float roughnessFactor = fRough;`;
const FRAG_METAL = /* glsl */ `float metalnessFactor = fMetal;`;
const FRAG_NORMAL = /* glsl */ `
  #include <normal_fragment_maps>
  normal = fBump( - vViewPosition, normal, fh );
`;
const FRAG_EMISSIVE = /* glsl */ `
  {
    vec3 fUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    totalEmissiveRadiance = diffuseColor.rgb * uNight * ( 0.55 + 0.45 * max( dot( normal, fUp ), 0.0 ) );
  }
`;
// the ground tone by 30 m, then sky.js's low haze, in linear space (fog follows in fog_fragment)
const FRAG_HAZE = /* glsl */ `
  #include <opaque_fragment>
  {
    float fD = length( vFW.xz - uCenter );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uGround, smoothstep( 24.0, 31.0, fD ) );
    float fLow = 0.62 * ( 1.0 - exp( -max( fD - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vFW.y ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uHaze, fLow );
  }
`;

// ------------------------------------------------------------------ geometry kit
// One indexed triangle soup with position, normal, color (piece tint), aWood, aFx.
class Soup {
  constructor() { this.P = []; this.N = []; this.C = []; this.W = []; this.X = []; this.I = []; this.n = 0; }
  v(p, n, pc, u, v, kind, rot = 0) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]);
    this.C.push(pc.col[0], pc.col[1], pc.col[2]);
    this.W.push(u, v, pc.seed, kind); this.X.push(rot, pc.weather);
    return this.n++;
  }
  t(a, b, c) { this.I.push(a, b, c); }
  build() {
    for (let i = 1; i < this.P.length; i += 3) if (this.P[i] < 0.0015) this.P[i] = 0.0015;   // nothing below the ground
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aWood', new THREE.Float32BufferAttribute(this.W, 4));
    g.setAttribute('aFx', new THREE.Float32BufferAttribute(this.X, 2));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// small vector helpers on [x, y, z] arrays (init only)
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const UPV = [0, 1, 0];

// Cross-sections at unit size: pts CCW, per-point smooth normals, per-edge flat flags, the pith.
function makeProfile(type, rng) {
  const pts = [], sn = [], flat = [];
  let pith = [0, 0];
  const R = (a, b) => a + (b - a) * rng();
  if (type === 'round') {
    const K = 9, ph = rng() * TAU, ph2 = rng() * TAU;
    for (let i = 0; i < K; i++) {
      const a = (i / K) * TAU;
      const r = 1 + 0.07 * Math.sin(a * 2 + ph) + 0.04 * Math.sin(a * 3 + ph2) + R(-0.03, 0.03);
      pts.push([Math.cos(a) * r, Math.sin(a) * r]); sn.push([Math.cos(a), Math.sin(a)]); flat.push(false);
    }
    pith = [R(-0.12, 0.12), R(-0.12, 0.12)];
  } else if (type === 'half') {
    // a log split through the pith: the round back and one split face (a little uneven)
    const Rr = 1.35, K = 7;
    for (let i = 0; i < K; i++) {
      const a = (i / (K - 1)) * Math.PI;
      const r = Rr * (1 + R(-0.04, 0.04));
      pts.push([Math.cos(a) * r, Math.sin(a) * r]); sn.push([Math.cos(a), Math.sin(a)]);
      flat.push(i < K - 1 ? false : true);
    }
    pts.push([-Rr * 0.35, R(-0.08, 0.04)]); sn.push([0, -1]); flat.push(true);
    pts.push([Rr * 0.3, R(-0.04, 0.08)]); sn.push([0, -1]); flat.push(true);
    pith = [R(-0.1, 0.1), 0.02];
  } else if (type === 'quarter') {
    // a quarter of a bigger log: two split faces meeting at the pith, the round outside
    const Rr = 1.8, K = 5;
    pts.push([0, 0]); sn.push([-0.7, -0.7]); flat.push(true);
    pts.push([Rr * 0.5, R(-0.05, 0.03)]); sn.push([0, -1]); flat.push(true);
    for (let i = 0; i < K; i++) {
      const a = (i / (K - 1)) * Math.PI / 2;
      const r = Rr * (1 + R(-0.04, 0.04));
      pts.push([Math.cos(a) * r, Math.sin(a) * r]); sn.push([Math.cos(a), Math.sin(a)]);
      flat.push(i < K - 1 ? false : true);
    }
    pts.push([R(-0.03, 0.05), Rr * 0.5]); sn.push([-1, 0]); flat.push(true);
    pith = [0.03, 0.03];
  } else {
    // axe-hewn: a log squared off roughly, six or seven uneven flats
    const K = rng() < 0.5 ? 6 : 7, ph = rng() * TAU;
    for (let i = 0; i < K; i++) {
      const a = ph + (i / K) * TAU + R(-0.15, 0.15);
      const r = 1.05 * (1 + R(-0.12, 0.12));
      pts.push([Math.cos(a) * r, Math.sin(a) * r]); sn.push([Math.cos(a), Math.sin(a)]); flat.push(true);
    }
    pith = [R(-0.1, 0.1), R(-0.1, 0.1)];
  }
  // centre on the centroid (area-weighted), so the axis runs through the middle of the wood
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], c = p[0] * q[1] - q[0] * p[1];
    A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  A *= 0.5; cx /= 6 * A; cy /= 6 * A;
  for (const p of pts) { p[0] -= cx; p[1] -= cy; }
  pith = [pith[0] - cx, pith[1] - cy];
  // perimeter positions
  const per = [0];
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i - 1], q = pts[i % pts.length];
    per.push(per[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  return { pts, sn, flat, pith, per };
}
const PROF_WIRE = (() => {
  const pts = [], sn = [], flat = [];
  for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + 0.4; pts.push([Math.cos(a), Math.sin(a)]); sn.push([Math.cos(a), Math.sin(a)]); flat.push(false); }
  const per = [0]; for (let i = 1; i <= 4; i++) per.push(per[i - 1] + Math.SQRT2);
  return { pts, sn, flat, pith: [0, 0], per };
})();
const PROF_ROD = (() => {
  const pts = [], sn = [], flat = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; pts.push([Math.cos(a), Math.sin(a)]); sn.push([Math.cos(a), Math.sin(a)]); flat.push(false); }
  const per = [0]; for (let i = 1; i <= 6; i++) per.push(per[i - 1] + 1);
  return { pts, sn, flat, pith: [0.05, 0], per };
})();

// Sweep a profile along a spine. spine: [{ p:[x,y,z], r }]. Caps at either end are fans with flat
// normals; o.endDisp(j) pushes the last ring along the axis (slanted cuts, ragged rot), o.endTip
// raises (or sinks) the cap's centre. Closed loops (wire) reuse the first frame at the end.
function sweep(G, spine, prof, pc, o = {}) {
  const n = spine.length, K = prof.pts.length;
  const T = [], Nf = [], Bf = [], U = [0];
  for (let i = 1; i < n; i++) U.push(U[i - 1] + len(sub(spine[i].p, spine[i - 1].p)));
  for (let i = 0; i < n; i++) {
    let a, b;
    if (o.closed) { a = spine[(i - 1 + n - 1) % (n - 1)].p; b = spine[(i + 1) % (n - 1)].p; }
    else { a = spine[Math.max(0, i - 1)].p; b = spine[Math.min(n - 1, i + 1)].p; }
    T.push(norm(sub(b, a)));
  }
  let ref = o.ref || UPV;
  if (Math.abs(dot(ref, T[0])) > 0.95) ref = [1, 0, 0];
  let prev = ref;
  for (let i = 0; i < n; i++) {
    const t = T[i];
    let nn = sub(prev, mul(t, dot(prev, t)));
    if (len(nn) < 1e-5) nn = Math.abs(t[0]) < 0.9 ? cross(t, [1, 0, 0]) : cross(t, [0, 0, 1]);
    nn = norm(nn);
    Nf.push(nn); Bf.push(cross(t, nn)); prev = nn;
  }
  const u0 = o.u0 || 0, rot0 = o.rot0 || 0, twist = o.twist || 0, L = U[n - 1] || 1;
  const kindFlat = o.kindFlat ?? 0, kindRound = o.kindRound ?? 1;
  const rings = [];
  for (let i = 0; i < n; i++) {
    const tw = rot0 + twist * (U[i] / L), c = Math.cos(tw), s = Math.sin(tw);
    const sc = spine[i].r, ring = [];
    const rot = o.rotFn ? o.rotFn(i, n) : 0;
    for (let j = 0; j < K; j++) {
      const [x, y] = prof.pts[j];
      const lx = (x * c - y * s) * sc, ly = (x * s + y * c) * sc;
      let p = add(spine[i].p, add(mul(Nf[i], lx), mul(Bf[i], ly)));
      if (i === n - 1 && o.endDisp) p = madd(p, T[i], o.endDisp(j));
      if (i === 0 && o.startDisp) p = madd(p, T[i], -o.startDisp(j));
      ring.push(p);
    }
    const idx = [];
    for (let e = 0; e < K; e++) {
      const j0 = e, j1 = (e + 1) % K;
      let n0, n1;
      if (prof.flat[e]) {
        const p0 = prof.pts[j0], p1 = prof.pts[j1];
        const ex = p1[0] - p0[0], ey = p1[1] - p0[1], el = Math.hypot(ex, ey) || 1;
        n0 = n1 = [ey / el, -ex / el];
      } else { n0 = prof.sn[j0]; n1 = prof.sn[j1]; }
      const w = (nv) => norm(add(mul(Nf[i], nv[0] * c - nv[1] * s), mul(Bf[i], nv[0] * s + nv[1] * c)));
      const kind = prof.flat[e] ? kindFlat : kindRound;
      const vv0 = prof.per[e] * sc, vv1 = prof.per[e + 1] * sc;
      idx.push(G.v(ring[j0], w(n0), pc, u0 + U[i], vv0, kind, rot), G.v(ring[j1], w(n1), pc, u0 + U[i], vv1, kind, rot));
    }
    rings.push({ ring, idx, c, s, sc });
  }
  for (let i = 0; i < n - 1; i++) {
    const A = rings[i].idx, B = rings[i + 1].idx;
    for (let e = 0; e < K; e++) {
      const a = A[e * 2], b = A[e * 2 + 1], cc = B[e * 2 + 1], d = B[e * 2];
      G.t(a, b, cc); G.t(a, cc, d);
    }
  }
  const cap = (i, sign, tip, kind) => {
    const { ring, c, s, sc } = rings[i];
    let ctr = [0, 0, 0];
    for (const p of ring) ctr = add(ctr, p);
    ctr = madd(mul(ctr, 1 / K), T[i], sign * (tip || 0));
    const local = prof.pts.map(([x, y]) => [(x - prof.pith[0]) * sc, (y - prof.pith[1]) * sc]);
    const lc = [-prof.pith[0] * sc, -prof.pith[1] * sc];
    for (let j = 0; j < K; j++) {
      const j1 = (j + 1) % K;
      const a = sign > 0 ? ring[j] : ring[j1], b = sign > 0 ? ring[j1] : ring[j];
      const la = sign > 0 ? local[j] : local[j1], lb = sign > 0 ? local[j1] : local[j];
      let fn = norm(cross(sub(a, ctr), sub(b, ctr)));
      if (dot(fn, T[i]) * sign < 0) fn = mul(fn, -1);
      G.t(G.v(ctr, fn, pc, lc[0], lc[1], kind), G.v(a, fn, pc, la[0], la[1], kind), G.v(b, fn, pc, lb[0], lb[1], kind));
    }
  };
  if (o.capEnd) cap(n - 1, 1, o.endTip, o.capEndKind ?? 2);
  if (o.capStart) cap(0, -1, o.startTip, o.capStartKind ?? 2);
  return { T, U };
}

// ================================================================== build
export function createFence(ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  o.fence = { ...FENCE, ...(opts.fence || {}) };
  o.shrine = { ...SHRINE, ...(opts.shrine || {}) };
  const FS = o.fence;
  const seed = Number.isFinite(opts.seed) ? opts.seed : FS.seed;
  const rng = mulberry32((seed | 0) * 7919 + 101);
  const R = (a, b) => a + (b - a) * rng();
  const C = o.center;

  const group = new THREE.Group();
  group.name = 'fence';
  ctx.scene.add(group);
  const geometries = [], materials = [];

  // ------------------------------------------------------------- the line
  const line = fenceLine(0.05);
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const L = cum[cum.length - 1] || 0;
  const side = FS.side >= 0 ? 1 : -1;
  // point on the line at arc length s: position, horizontal tangent F (away from the camera end), toward the road
  function at(s) {
    s = Math.min(L, Math.max(0, s));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const a = line[lo], b = line[hi], seg = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / seg;
    const tx = (b[0] - a[0]) / seg, tz = (b[1] - a[1]) / seg;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, F: [tx, 0, tz], S: [tz * side, 0, -tx * side] };
  }
  const atX = (s) => {   // also beyond the ends (rail overhangs, the fallen rail)
    if (s >= 0 && s <= L) return at(s);
    const e = at(s < 0 ? 0 : L), d = s < 0 ? s : s - L;
    return { x: e.x + e.F[0] * d, z: e.z + e.F[2] * d, F: e.F, S: e.S };
  };

  // shrine on the line
  let s0 = -1, dS = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((o.shrine.x - a[0]) * ex + (o.shrine.z - a[1]) * ez) / l2));
    const d = Math.hypot(o.shrine.x - a[0] - ex * t, o.shrine.z - a[1] - ez * t);
    if (d < dS) { dS = d; s0 = cum[i] + (cum[i + 1] - cum[i]) * t; }
  }
  const sp = FS.spacing, gapR = FS.gateGap;
  const hasGate = L > 8 && dS < gapR + 0.5 && s0 > sp[0] + 1.6 && s0 < L - sp[0] - 1.6;

  // ------------------------------------------------------------- posts
  // supports in runs (split by the field gate): run A from the near end to the gate, run B on to the far end
  const sList = [];   // { s, run, gate }
  const fill = (a, b, run, gateEnd, nForce) => {
    const ln = b - a;
    if (ln <= 0.3) return;
    const n = nForce || Math.max(1, Math.floor(ln / sp[0] + 1e-6));
    const d = ln / n;
    const j = Math.max(0, Math.min(0.12, (d - sp[0]) * 0.5, (sp[1] - d) * 0.5));
    for (let i = 0; i <= n; i++) sList.push({ s: a + i * d + (i > 0 && i < n ? R(-j, j) : 0), run, gate: gateEnd && i === n });
  };
  if (hasGate) {
    // the gate posts stand at least gateGap (plus a hand) from the shrine; the gate is about 2.6-3 m wide
    const ghMin = Math.sqrt(Math.max(0, (gapR + 0.06) ** 2 - dS * dS)) + 0.02;
    const gh = Math.max(1.3, ghMin);
    // near side: equal spans from the near end (each within the spacing range); pick the gate-post
    // position nearest the ideal that both keeps the spacing and keeps clear of the shrine
    // (the first post may stand up to 0.35 m before the nominal start, off screen)
    let b = s0 - gh, best = null, bestN = 0;
    for (let n = 1; n * sp[0] - 0.35 <= s0 - ghMin; n++) {
      const lo = n * sp[0] - 0.35, hi = Math.min(n * sp[1], s0 - ghMin);
      const c = Math.min(hi, Math.max(lo, b));
      if (best == null || Math.abs(c - b) < Math.abs(best - b)) { best = c; bestN = n; }
    }
    let a = 0;
    if (best != null) { b = best; a = Math.min(0, b - bestN * sp[0]); }
    fill(a, b, 0, true, bestN || 0);
    // far side: random spans from the gate on to the far end (the far gate post keeps the gate ~2.7 m)
    let s = s0 + Math.max(ghMin, 2.7 - (s0 - b));
    sList.push({ s, run: 1, gate: true });
    for (;;) { s += R(sp[0], sp[1]); if (s > L + 0.05) break; sList.push({ s: Math.min(s, L), run: 1, gate: false }); }
  } else fill(0, L, 0, false);

  const TYPES = ['round', 'round', 'round', 'half', 'half', 'quarter', 'quarter', 'hewn', 'hewn'];
  const TOPS = ['angled', 'angled', 'angled', 'flat', 'pyramid', 'pyramid', 'rot', 'rot'];
  const posts = sList.map((e, k) => {
    const pt = atX(e.s);
    const gate = e.gate;
    const type = gate ? 'round' : TYPES[(rng() * TYPES.length) | 0];
    const r = gate ? R(0.085, 0.098) : R(0.058, 0.08);
    const h = gate ? R(FS.height[1] - 0.03, FS.height[1]) : R(FS.height[0], FS.height[1]);
    const la = rng() * TAU, lm = (k % 4 === 2 ? R(0.04, 0.075) : R(0.006, 0.04)) * (gate ? 0.5 : 1);
    const ba = rng() * TAU, bm = R(0.003, 0.016);
    return {
      k, s: e.s, run: e.run, gate, x: pt.x, z: pt.z, F: pt.F, S: pt.S, type, r, h,
      lean: [Math.cos(la) * lm, Math.sin(la) * lm], bow: [Math.cos(ba) * bm, Math.sin(ba) * bm],
      top: gate ? (rng() < 0.5 ? 'pyramid' : 'flat') : TOPS[(rng() * TOPS.length) | 0],
      fix: gate ? 'wire' : (rng() < 0.5 ? 'wire' : rng() < 0.6 ? 'nail' : 'peg'),
      paired: false, att: [],
    };
  });
  const NP = posts.length;
  const gN = hasGate ? posts.findIndex((p) => p.gate && p.run === 0) : -1;
  const gF = hasGate ? posts.findIndex((p) => p.gate && p.run === 1) : -1;
  const runs = hasGate ? [[0, gN], [gF, NP - 1]] : [[0, NP - 1]];
  // the oddities, each on its own span (k = the span's near post)
  const okSpan = (k, run) => k >= run[0] && k + 1 <= run[1];
  const looseK = hasGate && okSpan(gN - 1, runs[0]) && gN - 1 > 1 ? gN - 1 : -1;   // lower rail hanging, by the gate, nearest the fire
  const fallenK = okSpan(1, runs[0]) && 1 !== looseK ? 1 : -1;                       // upper rail in the grass, near the camera
  const xK = hasGate && okSpan(gF + 1, runs[1]) ? gF + 1 : -1;              // X-braced span past the shrine
  const pairedK = hasGate && gF + 3 < NP - 1 ? gF + 3 : (NP > 4 ? NP - 2 : -1);   // a rotten post replaced by two stakes
  if (pairedK >= 0) posts[pairedK].paired = true;

  // post axis point at height y (lean and a slight bow)
  const axis = (p, y) => {
    const t = Math.min(1, Math.max(0, y / p.h)), b = Math.sin(Math.PI * t);
    return [p.x + p.lean[0] * y + p.bow[0] * b, y, p.z + p.lean[1] * y + p.bow[1] * b];
  };
  const postR = (p, y) => p.r * (1.04 - 0.12 * Math.min(1, y / p.h));

  const G = new Soup();
  let pieceNo = 0;
  const piece = (weather = R(0.75, 1.0), bright = R(0.88, 1.1)) => {
    const warm = R(-0.04, 0.04);
    return { col: [bright * (1 + warm), bright, bright * (1 - warm)], seed: (pieceNo++ * 0.6180339 % 1) * 40 + R(0, 1), weather };
  };
  const shadows = [];   // contact shadow blobs: [ax, az, bx, bz, r, alpha]

  // ------------------------------------------------------------- build posts
  for (const p of posts) {
    if (p.paired) continue;
    const prof = makeProfile(p.type, rng);
    const pc = piece(R(0.8, 1.0), R(0.85, 1.08));
    const ts = [0, 0.04, 0.14, 0.3, 0.48, 0.66, 0.82, 0.93, 1];
    const ring = ts.map((t, i) => ({ p: axis(p, t * p.h), r: postR(p, t * p.h) * (1 + (i === 0 ? 0.03 : R(-0.035, 0.035))) }));
    const top = p.top;
    let endDisp = null, endTip = 0, capKind = 2, rotFn = null;
    if (top === 'angled') {
      const ca = rng() * TAU, ta = Math.tan(R(0.25, 0.45)), cx = Math.cos(ca), cy = Math.sin(ca);
      endDisp = (j) => -ta * Math.max(-1.2, Math.min(1.2, (prof.pts[j][0] * cx + prof.pts[j][1] * cy))) * ring[ring.length - 1].r * 0.85;
    } else if (top === 'flat') {
      const ca = rng() * TAU, ta = Math.tan(R(0.02, 0.08));
      endDisp = (j) => ta * (prof.pts[j][0] * Math.cos(ca) + prof.pts[j][1] * Math.sin(ca)) * ring[ring.length - 1].r;
    } else if (top === 'pyramid') {
      endTip = R(0.45, 0.7) * p.r;
      const ch = R(0.01, 0.025);
      endDisp = () => -ch;
    } else {   // rotting: a ragged, sunken, crumbling top, rot creeping down the sides
      const dj = prof.pts.map(() => -R(0.005, 0.05));
      endDisp = (j) => dj[j];
      endTip = -R(0.01, 0.03);
      capKind = 5;
      rotFn = (i, n) => (i >= n - 2 ? 1 : i === n - 3 ? 0.45 : 0);
    }
    sweep(G, ring, prof, pc, { ref: p.S, rot0: rng() * TAU, twist: R(-0.5, 0.5), u0: R(0, 3), capEnd: true, endDisp, endTip, capEndKind: capKind, rotFn });
    shadows.push([p.x, p.z, p.x, p.z, p.r * 2.8 + 0.06, 0.55]);
    p.prof = prof;
  }

  // ------------------------------------------------------------- rails
  const rows = [FS.railHeights[0], FS.railHeights[1]];
  // where a rail touches support k at height y, on side sd (+1 road side, -1 field side)
  function contact(k, y, sd, rr, row) {
    const p = posts[k];
    if (p.paired) {
      // between the two stakes; a second rail lies on top of the first
      const n = p.att.filter((a) => a.row === row).length;
      const yy = y + n * rr * 1.8;
      p.att.push({ row, y: yy, sd: 0, off: 0, rr });
      return { pos: [p.x, yy, p.z], y: yy };
    }
    const n = p.att.filter((a) => a.row === row && a.sd === sd).length;
    const off = postR(p, y) * 0.9 + rr * 0.92 + n * rr * 1.78;
    const c = axis(p, y);
    p.att.push({ row, y, sd, off, rr, n });
    return { pos: [c[0] + p.S[0] * sd * off, y, c[2] + p.S[2] * sd * off], y };
  }

  // a rail over supports k0..k1 (inclusive), sagging and bowing between them
  function rail(row, k0, k1, special) {
    const r0 = (row === 0 ? R(0.033, 0.043) : R(0.03, 0.039)), r1 = r0 * R(0.62, 0.8);
    const thickFirst = rng() < 0.5;
    const sd = (k0 <= xK && xK < k1) ? 1 : rng() < 0.78 ? 1 : -1;   // keep clear of the X-brace on the field side
    const ys = [];
    for (let k = k0; k <= k1; k++) ys.push(Math.min(rows[row] + R(-0.035, 0.035), posts[k].h - 0.08));
    const rMid = (r0 + r1) / 2;
    const cs = [];
    for (let i = 0; i <= k1 - k0; i++) cs.push(contact(k0 + i, ys[i], sd, rMid, row).pos);
    // overhangs: short at the gate, longer at the ends of the fence and where rails overlap
    const ovA = posts[k0].gate ? R(0.07, 0.11) : k0 === 0 ? R(0.2, 0.35) : R(0.16, 0.34);
    const ovB = posts[k1].gate ? R(0.07, 0.11) : k1 === NP - 1 ? R(0.15, 0.3) : R(0.16, 0.34);
    const pts = [];
    const dirA = norm([cs[0][0] - cs[1][0], 0, cs[0][2] - cs[1][2]]);
    const dirB = norm([cs[cs.length - 1][0] - cs[cs.length - 2][0], 0, cs[cs.length - 1][2] - cs[cs.length - 2][2]]);
    const slA = (cs[0][1] - cs[1][1]) / Math.max(0.5, Math.hypot(cs[0][0] - cs[1][0], cs[0][2] - cs[1][2]));
    const slB = (cs[cs.length - 1][1] - cs[cs.length - 2][1]) / Math.max(0.5, Math.hypot(cs[cs.length - 1][0] - cs[cs.length - 2][0], cs[cs.length - 1][2] - cs[cs.length - 2][2]));
    for (const f of [1, 0.5]) pts.push(add(madd(cs[0], dirA, ovA * f), [0, (slA * 0.6 - 0.02 * f) * ovA * f, 0]));
    const ph = rng() * TAU, ph2 = rng() * TAU;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = cs[i], b = cs[i + 1], sl = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const sag = R(0.018, 0.05) * (sl / 2.5) ** 2 * (0.036 / rMid);
      const bow = R(-0.035, 0.035);
      const lat = norm([-(b[2] - a[2]), 0, b[0] - a[0]]);
      const M = 9;
      for (let j = 0; j < M; j++) {
        const t = j / M, sn = Math.sin(Math.PI * t);
        let q = lerp3(a, b, t);
        q = madd(q, UPV, -sag * sn + 0.004 * Math.sin((i + t) * 4.1 + ph) * sn);
        q = madd(q, lat, bow * sn + 0.005 * Math.sin((i + t) * 5.3 + ph2) * sn);
        pts.push(q);
      }
    }
    pts.push(cs[cs.length - 1]);
    for (const f of [0.5, 1]) pts.push(add(madd(cs[cs.length - 1], dirB, ovB * f), [0, (slB * 0.6 - 0.02 * f) * ovB * f, 0]));
    return sweepRail(pts, r0, r1, thickFirst, special);
  }
  function sweepRail(pts, r0, r1, thickFirst, special = {}) {
    const U = [0];
    for (let i = 1; i < pts.length; i++) U.push(U[i - 1] + len(sub(pts[i], pts[i - 1])));
    const Lr = U[U.length - 1] || 1, ph = rng() * TAU;
    const spine = pts.map((p, i) => {
      const t = U[i] / Lr, tt = thickFirst ? t : 1 - t;
      return { p, r: (r0 + (r1 - r0) * tt) * (1 + 0.05 * Math.sin(t * 9 + ph)) };
    });
    if (special.ground) for (const q of spine) q.p[1] = Math.max(q.p[1], q.r * 0.93 + 0.003);
    const prof = makeProfile(rng() < 0.75 ? 'round' : 'half', rng);
    const pc = special.fresh ? piece(R(0.5, 0.65), R(1.0, 1.12)) : piece(R(0.6, 1.0), R(0.85, 1.12));
    const cutA = Math.tan(R(0, 0.4)), cutB = Math.tan(R(0, 0.4)), ca = rng() * TAU, cb = rng() * TAU;
    sweep(G, spine, prof, pc, {
      ref: UPV, rot0: rng() * TAU, twist: R(-0.8, 0.8), u0: R(0, 4), capStart: true, capEnd: true,
      startDisp: (j) => cutA * (prof.pts[j][0] * Math.cos(ca) + prof.pts[j][1] * Math.sin(ca)) * spine[0].r,
      endDisp: (j) => cutB * (prof.pts[j][0] * Math.cos(cb) + prof.pts[j][1] * Math.sin(cb)) * spine[spine.length - 1].r,
    });
    return spine;
  }

  for (const run of runs) {
    for (let row = 0; row < 2; row++) {
      let k = run[0];
      while (k < run[1]) {
        if (row === 1 && k === fallenK) { k++; continue; }
        if (row === 0 && k === looseK) { k++; continue; }
        const blocked = (kk) => (row === 1 && kk === fallenK) || (row === 0 && kk === looseK);
        const span = k + 2 <= run[1] && !blocked(k + 1) && rng() < 0.45 ? 2 : 1;
        rail(row, k, k + span, { fresh: rng() < 0.15 });
        k += span;
      }
    }
  }

  // the loose rail: still wired at the far post, its near end dropped into the grass
  const hangWires = [];   // broken lashings left on posts: [k, y]
  if (looseK >= 0) {
    const pA = posts[looseK], pB = posts[looseK + 1];
    const r0 = R(0.034, 0.04), r1 = r0 * 0.72;
    const y = Math.min(rows[0] + R(-0.02, 0.03), pB.h - 0.08);
    const c1 = contact(looseK + 1, y, 1, (r0 + r1) / 2, 0).pos;
    const span = Math.hypot(pB.x - pA.x, pB.z - pA.z);
    const Lr = span + R(0.2, 0.3);
    const dh = Math.sqrt(Math.max(0.1, Lr * Lr - (y - r1) ** 2));
    const F = norm([pA.x - pB.x, 0, pA.z - pB.z]);
    const e = madd(madd([c1[0], 0, c1[2]], F, dh), pA.S, 0.16);
    e[1] = r1 + 0.004;
    const pts = [];
    const ov = R(0.18, 0.26), dir = norm(sub(c1, e));
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const q = lerp3(e, c1, t);
      q[1] -= 0.04 * Math.sin(Math.PI * t) * (1 - t);   // a little bent by its own weight near the ground
      pts.push(q);
    }
    pts.push(madd(c1, dir, ov * 0.5), madd(c1, dir, ov));
    sweepRail(pts, r1, r0, true, { ground: true });
    shadows.push([e[0], e[2], e[0] - F[0] * 0.25, e[2] - F[2] * 0.25, 0.11, 0.5]);
    hangWires.push([looseK, rows[0] + 0.01]);
  }
  // the fallen rail: in the grass in front of its span, its wires left on the posts
  if (fallenK >= 0) {
    const pA = posts[fallenK], pB = posts[fallenK + 1];
    const a = atX(pA.s - R(0.05, 0.25)), b = atX(pB.s + R(0.1, 0.3));
    const oa = R(0.32, 0.45), ob = R(0.55, 0.8);
    const A = [a.x + a.S[0] * oa, 0, a.z + a.S[2] * oa], B = [b.x + b.S[0] * ob, 0, b.z + b.S[2] * ob];
    const lat = norm([-(B[2] - A[2]), 0, B[0] - A[0]]), bow = R(0.03, 0.06);
    const pts = [];
    for (let i = 0; i <= 14; i++) { const t = i / 14; pts.push(madd(lerp3(A, B, t), lat, bow * Math.sin(Math.PI * t))); }
    const r0 = R(0.03, 0.037);
    sweepRail(pts, r0, r0 * 0.7, rng() < 0.5, { ground: true });
    shadows.push([A[0], A[2], B[0], B[2], 0.085, 0.5]);
    hangWires.push([fallenK, rows[1]], [fallenK + 1, rows[1]]);
  }

  // ------------------------------------------------------------- X-braced span (field side)
  if (xK >= 0) {
    const pA = posts[xK], pB = posts[xK + 1];
    const rd = R(0.03, 0.036);
    const mk = (p0, p1, extra) => {
      const offA = postR(p0, 0.1) * 0.9 + rd * 0.92 + extra, offB = postR(p1, p1.h) * 0.9 + rd * 0.92 + extra;
      const b0 = atX(p0.s - Math.sign(p1.s - p0.s) * 0.12);
      const lo = [b0.x - b0.S[0] * offA, rd + 0.005, b0.z - b0.S[2] * offA];
      const yT = p1.h - R(0.1, 0.16), cT = axis(p1, yT);
      const hi = [cT[0] - p1.S[0] * offB, yT, cT[2] - p1.S[2] * offB];
      const d = norm(sub(hi, lo)), pts = [];
      for (let i = 0; i <= 10; i++) pts.push(lerp3(lo, hi, i / 10));
      pts.push(madd(hi, d, 0.06), madd(hi, d, 0.12));
      sweepRail(pts, rd, rd * 0.75, true, { ground: true });
      shadows.push([lo[0], lo[2], lo[0] + d[0] * 0.2, lo[2] + d[2] * 0.2, 0.08, 0.45]);
      return { lo, hi };
    };
    const d1 = mk(pA, pB, 0), d2 = mk(pB, pA, rd * 1.75);
    // lash the crossing (where the two cross in plan view)
    const mid = lerp3(lerp3(d1.lo, d1.hi, 0.5), lerp3(d2.lo, d2.hi, 0.5), 0.5);
    const S = pA.S, F = pA.F;
    for (let turn = 0; turn < 3; turn++) {
      const tilt = (turn - 1) * 0.35, pts = [];
      const as = rd * 1.8 + 0.006, ay = rd * 1.25 + 0.004;
      for (let i = 0; i <= 18; i++) {
        const ph = (i / 18) * TAU, cs = Math.cos(ph), sn = Math.sin(ph);
        const sx = Math.sign(cs) * Math.abs(cs) ** 0.75, sy = Math.sign(sn) * Math.abs(sn) ** 0.75;
        pts.push(madd(madd(madd(mid, S, -sx * as), UPV, sy * ay), F, tilt * sy * ay + (turn - 1) * 0.006));
      }
      sweep(G, pts.map((p) => ({ p, r: 0.0022 })), PROF_WIRE, piece(1, 1), { closed: true, kindFlat: 3, kindRound: 3, u0: turn });
    }
  }

  // ------------------------------------------------------------- paired stakes (a replaced post)
  if (pairedK >= 0) {
    const p = posts[pairedK];
    const rs = R(0.036, 0.044);
    const rails = p.att;
    const maxR = rails.reduce((m, a) => Math.max(m, a.rr), 0.035);
    const d = maxR + rs + 0.004;
    for (const sd of [1, -1]) {
      const prof = makeProfile('round', rng);
      const base = [p.x + p.S[0] * sd * (d + 0.02) + p.F[0] * sd * 0.02, 0, p.z + p.S[2] * sd * (d + 0.02) + p.F[2] * sd * 0.02];
      const hh = p.h - R(0.0, 0.08);
      const topP = [p.x + p.S[0] * sd * (d - 0.012) + p.F[0] * sd * 0.03, hh, p.z + p.S[2] * sd * (d - 0.012) + p.F[2] * sd * 0.03];
      const spine = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; spine.push({ p: lerp3(base, topP, t), r: rs * (1.05 - 0.15 * t) }); }
      const pc = piece(R(0.6, 0.85), R(0.9, 1.05));
      sweep(G, spine, prof, pc, { ref: p.S, rot0: rng() * TAU, twist: R(-0.4, 0.4), u0: R(0, 3), capEnd: true, endTip: rs * R(0.6, 1.1) });
      shadows.push([base[0], base[2], base[0], base[2], 0.12, 0.5]);
    }
    // withies binding the stakes above each rail stack
    for (let row = 0; row < 2; row++) {
      const here = rails.filter((a) => a.row === row);
      if (!here.length) continue;
      const yTop = Math.max(...here.map((a) => a.y + a.rr)) + 0.012;
      const ctr = [p.x, yTop, p.z];
      for (let turn = 0; turn < 2; turn++) {
        const pts = [], as = d + rs + 0.006, af = rs + 0.007;
        for (let i = 0; i <= 18; i++) {
          const ph = (i / 18) * TAU, cs = Math.cos(ph), sn = Math.sin(ph);
          const sx = Math.sign(cs) * Math.abs(cs) ** 0.7, sy = Math.sign(sn) * Math.abs(sn) ** 0.7;
          pts.push(madd(madd(madd(ctr, p.S, sx * as), p.F, sy * af), UPV, turn * 0.011 + 0.006 * sy));
        }
        sweep(G, pts.map((q) => ({ p: q, r: 0.0055 })), PROF_ROD, piece(0.3, R(0.9, 1.1)), { closed: true, kindFlat: 4, kindRound: 4, u0: R(0, 2) });
      }
    }
  }

  // ------------------------------------------------------------- fastenings at the posts
  const wireLoop = (p, y, sMin, sMax, tilt, yOff, loose) => {
    const pts = [], c = axis(p, y);
    const cs0 = (sMin + sMax) / 2, as = (sMax - sMin) / 2, af = postR(p, y) * 1.02 + 0.003;
    for (let i = 0; i <= 20; i++) {
      const ph = (i / 20) * TAU, cs = Math.cos(ph), sn = Math.sin(ph);
      const sx = Math.sign(cs) * Math.abs(cs) ** 0.78, sy = Math.sign(sn) * Math.abs(sn) ** 0.78;
      const dropY = loose ? -0.05 * (1 - cs) * 0.5 : 0;   // a slack, broken loop hangs on its front
      pts.push(madd(madd(madd(c, p.S, cs0 + as * sx), p.F, af * sy), UPV, yOff + tilt * af * sy + dropY));
    }
    sweep(G, pts.map((q) => ({ p: q, r: 0.0023 })), PROF_WIRE, piece(1, R(0.85, 1.1)), { closed: true, kindFlat: 3, kindRound: 3, u0: R(0, 3) });
  };
  for (const p of posts) {
    if (p.paired) continue;
    for (let row = 0; row < 2; row++) {
      for (const sd of [1, -1]) {
        const here = p.att.filter((a) => a.row === row && a.sd === sd);
        if (!here.length) continue;
        const y = here.reduce((m, a) => m + a.y, 0) / here.length;
        const outer = Math.max(...here.map((a) => a.off + a.rr));
        const rr = Math.max(...here.map((a) => a.rr));
        if (p.fix === 'wire' || here.length > 1 && rng() < 0.5) {
          // two or three turns crossing over the rail(s): an X on their face
          const turns = 2 + (rng() < 0.5 ? 1 : 0);
          const tilt = (rr + 0.012) / (postR(p, y) + 0.003);
          for (let t = 0; t < turns; t++) {
            const s = t % 2 ? 1 : -1;
            wireLoop(p, y, -(postR(p, y) + 0.004) * sd, (outer + 0.003) * sd, s * tilt * R(0.9, 1.1), R(-0.006, 0.006), false);
          }
        } else {
          for (const a of here) {
            const c = axis(p, a.y), out = p.S.map((v) => v * sd);
            const surf = madd(c, out, a.off + a.rr * 0.9);
            if (p.fix === 'nail') {
              const e = madd(surf, out, 0.004);
              const tilt = [R(-0.01, 0.01), R(-0.01, 0.01), R(-0.01, 0.01)];
              sweep(G, [{ p: madd(surf, out, -0.004), r: 0.0055 }, { p: add(e, tilt), r: 0.006 }], PROF_ROD, piece(1, 1), { kindFlat: 3, kindRound: 3, capEnd: true, capEndKind: 3, ref: UPV });
            } else {   // a wooden peg through the rail into the post, its end left proud
              const ln = R(0.02, 0.035), d = norm(add(out, [R(-0.15, 0.15), R(-0.2, 0.1), R(-0.15, 0.15)]));
              sweep(G, [{ p: madd(surf, d, -0.02), r: 0.0095 }, { p: madd(surf, d, ln * 0.6), r: 0.01 }, { p: madd(surf, d, ln), r: 0.0092 }],
                PROF_ROD, piece(R(0.5, 0.8), 1), { kindFlat: 0, kindRound: 1, capEnd: true, endTip: 0.003, ref: UPV, u0: R(0, 2) });
            }
          }
        }
      }
    }
  }
  // broken lashings left behind by the loose and the fallen rail
  for (const [k, y] of hangWires) {
    const p = posts[k];
    if (!p || p.paired) continue;
    wireLoop(p, Math.min(y, p.h - 0.1), -(postR(p, y) + 0.003), postR(p, y) + 0.004, 0.25, 0, true);
  }

  // ------------------------------------------------------------- the gate
  let gatePole = null;
  if (gF >= 0) {
    // a long pole leaning on the far gate post, its foot in the gap: the gate, opened
    const p = posts[gF];
    const rp = R(0.03, 0.036), y = R(0.95, 1.08);
    const back = p.F.map((v) => -v);     // toward the gap
    const c = axis(p, y);
    const touch = madd(madd(c, back, postR(p, y) + rp * 0.9), p.S, 0.02);
    const foot = [p.x + back[0] * 0.62 + p.S[0] * 0.1, rp + 0.004, p.z + back[2] * 0.62 + p.S[2] * 0.1];
    const d = norm(sub(touch, foot)), pts = [];
    for (let i = 0; i <= 8; i++) pts.push(lerp3(foot, touch, i / 8));
    pts.push(madd(touch, d, 0.25), madd(touch, d, 0.5));
    sweepRail(pts, rp, rp * 0.72, true, { ground: true });
    shadows.push([foot[0], foot[2], foot[0], foot[2], 0.1, 0.5]);
    gatePole = [foot[0], foot[2]];
    // a slack wire loop on the near gate post: the old latch
    const pn = posts[gN];
    wireLoop(pn, Math.min(1.02, pn.h - 0.12), -(postR(pn, 1) + 0.004), postR(pn, 1) + 0.03, 0.3, 0, true);
  }

  // ------------------------------------------------------------- meshes
  const geo = G.build();
  geometries.push(geo);
  const uniforms = {
    uNight: { value: new THREE.Vector3(...o.night) },
    uHaze: { value: lin(o.hazeColor) },
    uGround: { value: lin(o.groundTone) },
    uCenter: { value: new THREE.Vector2(C.x, C.z) },
  };
  for (const k in PALETTE) uniforms[k] = { value: lin(PALETTE[k]) };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0, fog: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <worldpos_vertex>', VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_WOOD)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <opaque_fragment>', FRAG_HAZE);
  };
  mat.customProgramCacheKey = () => 'iskry-fence-wood-1';
  materials.push(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fence-wood';
  group.add(mesh);

  // contact shadows: soft dark capsules on the ground under every foot and lying pole
  {
    const P = [], Cc = [], I = [];
    const SEG = 7;
    for (const [ax, az, bx, bz, r, a0] of shadows) {
      const D = Math.hypot((ax + bx) / 2 - C.x, (az + bz) / 2 - C.z);
      const a = a0 * (1 - 0.55 * Math.min(1, Math.max(0, (D - 10) / 20)));
      let dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz);
      if (l < 1e-4) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
      const nx = -dz, nz = dx;
      const base = P.length / 3;
      P.push(ax, 0.007, az, bx, 0.007, bz); Cc.push(0, 0, 0, a, 0, 0, 0, a);
      // ring: semicircle round B (from -n through +d to +n), then round A (from +n through -d to -n)
      const ring = [];
      for (let i = 0; i <= SEG; i++) { const t = -Math.PI / 2 + (i / SEG) * Math.PI; ring.push([bx + (dx * Math.cos(t) + nx * Math.sin(t)) * r * 1.15, bz + (dz * Math.cos(t) + nz * Math.sin(t)) * r * 1.15, 1]); }
      for (let i = 0; i <= SEG; i++) { const t = Math.PI / 2 + (i / SEG) * Math.PI; ring.push([ax + (dx * Math.cos(t) + nx * Math.sin(t)) * r * 1.15, az + (dz * Math.cos(t) + nz * Math.sin(t)) * r * 1.15, 0]); }
      for (const [x, z] of ring) { P.push(x, 0.007, z); Cc.push(0, 0, 0, 0); }
      const rb = base + 2;
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const hub = ring[i][2] === 1 ? base + 1 : base;
        I.push(hub, rb + j, rb + i);
        if (ring[i][2] !== ring[j][2]) I.push(base, base + 1, rb + j);   // the side quads between the hubs
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 4));
    sg.setIndex(I);
    sg.computeBoundingSphere();
    geometries.push(sg);
    const smat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide });
    materials.push(smat);
    const sm = new THREE.Mesh(sg, smat);
    sm.name = 'fence-contact';
    sm.renderOrder = -1;          // over the ground cover (ground.js draws at -2), under everything opaque
    group.add(sm);
  }

  // ------------------------------------------------------------- handle
  const layout = {
    posts: posts.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2), +p.h.toFixed(2)]),
    gate: gN >= 0 ? [[+posts[gN].x.toFixed(2), +posts[gN].z.toFixed(2)], [+posts[gF].x.toFixed(2), +posts[gF].z.toFixed(2)]] : null,
    gatePole,
    loose: looseK, fallen: fallenK, xBrace: xK, paired: pairedK,
    vertices: G.n, triangles: G.I.length / 3,
  };
  const night0 = o.night.slice();

  function setTimeOfDay(tod) {
    if (!tod) return;
    // a little more sky light at dusk and before dawn, cooler at dawn
    const d = +tod.dusk || 0, w = +tod.dawn || 0, g = 1 + 0.5 * d + 0.7 * w;
    uniforms.uNight.value.set(night0[0] * g * (1 - 0.1 * w), night0[1] * g, night0[2] * g * (1 + 0.25 * w));
  }
  function update() { /* the fence stands still */ }
  function resize() { /* nothing depends on the viewport */ }
  function dispose() {
    group.removeFromParent();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    geometries.length = materials.length = 0;
  }
  return { group, update, resize, dispose, setTimeOfDay, layout };
}
