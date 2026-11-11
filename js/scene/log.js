/*
  Iskry · log.js: the log bench by the fire, and the guitar leaning on it.
  OWNER: Opus worker "log". Interface: CONTRACT.md (environment modules).

    import { createLog } from './scene/log.js';
    const log = createLog(ctx, { firePosition, wind });
    log.update(t, dt); log.resize(w, h); log.dispose();
  handle = { group, update, resize, dispose, setTimeOfDay, layout }

  Placement comes from js/scene/layout.js (BENCH: centre, axis, length, radius; GUITAR: base, lean,
  facing), never redefined here. opts may override firePosition / bench / guitar for the dev bench.

  The log: a fallen pine trunk, a little bowed and tapered, bedded ~2.5 cm into the ground (the
  part that would sink is flared out at y >= 0 instead, the sky's ground disc shows through
  anything below 0). A flat seat hewn along the top and worn by sitting (growth-ring stripes
  where the cut crosses the rings, seasoning checks, adze ripples), plated bark with deep
  furrows and flaking layers, patches where the bark has fallen away to weathered sapwood with
  engraver-beetle galleries, a sawn end (rings, sapwood with blue stain, radial checks, saw
  marks, a ring of bark), an older greyer sawn end, a broken branch stub, moss on the shaded
  underside, a folded wool blanket and an enamel mug on the seat (opts.blanket / opts.mug).
  Bark albedo + height baked once into one DataTexture (sRGB, mipmapped) in a Web Worker made
  from this module's own pure functions (inline fallback without Worker); the silhouette is
  displaced from the same height so the bark breaks the outline. The group stays hidden until
  the bake is back (~0.3 s), so log and guitar appear together; main-thread build ~30 ms.
  The guitar: a steel-string OM-size acoustic, local frame x across (treble +x), y up the
  neck, z out of the top. Bouts and waist from two ellipses with a smooth union (the same
  outline drives the geometry, the binding and the fake shadow); a lightly arched spruce top
  (book-matched grain, silking, lacquer checking, pick wear, forearm wear, binding and
  purfling, rosette, sound hole, tortoise pickguard: all procedural in the shader), rosewood
  sides and back with a backstrip, a mahogany neck and heel, a rosewood fretboard with 20
  frets and pearl dots at real fret positions (645 mm scale, 14-fret join), bone nut and
  saddle, a belly bridge with pins, a headstock angled back with 3+3 tuners. Kept at about
  60% of a honey spruce and desaturated, so the flames keep the eye. Six strings are a
  separate thin pass: camera-facing ribbons at least ~1 px wide whose alpha carries their real
  width (no shimmer), Kajiya-Kay lit by the fire's point lights: a fine glint.

  Light: the fire's PointLight(s) (whatever point lights the scene has), fog, the sky's low
  ground haze mixed exactly as sky.js does, a dim night tone on unlit faces. No shadow maps:
  per-vertex contact AO (ground, guitar), the guitar's shadow on the log from each point
  light (ray-plane test against the guitar outline in the log's light loop), a ground decal
  (contact AO and the fire shadow of log and guitar, tinted with the haze), and firelight bounced
  off the lit ground onto faces that look sideways and down (follows fire.light's flicker).
  Draw calls: 4 (log + blanket + mug, guitar, strings, ground decal). No per-frame allocations.
  GPU ~0.02-0.15 ms at 1800x1021 DPR 2 (timer query, noisy). Nothing animates (reduced motion is moot).
*/
import * as THREE from 'three';
import { BENCH, GUITAR, FIRE, ZONES } from './layout.js';

// ---------------------------------------------------------------- tunables
const DEFAULTS = {
  firePosition: FIRE,
  wind: 0.25,
  seed: 5,
  center: ZONES.center,        // sky.js measures its ground haze from here
  hazeColor: '#372013',        // sky.js's low ground haze (sRGB)
  nightTone: '#120c08',        // unlit faces (sRGB)
  fireLightHeight: 0.8,        // m, the fire's luminous centre (fire.js lightHeight 0.62 x scale 1.3), for the ground decal
  guitarGain: 0.88,            // multiplies the guitar's albedo (the director wants it at about 60% of a honey spruce)
  blanket: true,               // a folded wool blanket on the seat
  mug: true,                   // an enamel mug on the seat
  barkTexture: [768, 384],    // texels along x around
  bench: BENCH,
  guitar: GUITAR,
};
const TAU = Math.PI * 2;
const BOUNCE = 0.03;          // ground bounce per candela of the fire light

// ---------------------------------------------------------------- small maths
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function mix(a, b, t) { return a + (b - a) * t; }
function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// value noise, periodic in y with an integer period py
function vnoise(x, y, py, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const y0 = ((iy % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash2(ix, y0, seed), b = hash2(ix + 1, y0, seed), c = hash2(ix, y1, seed), d = hash2(ix + 1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, py, oct, seed) {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x, y, py, seed + o * 31); n += a; x *= 2; y *= 2; py *= 2; a *= 0.5; }
  return s / n;
}
// Voronoi F1, F2 and the nearest cell's random, periodic in y
// out[3]: how much the edge to the second nearest cell runs around the trunk (a cross furrow), 0..1
function voronoi(x, y, py, seed, out) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, wy = ((cy % py) + py) % py;
    const h1 = hash2(cx, wy, seed), h2 = hash2(cx, wy, seed + 7);
    const dx = cx + 0.1 + 0.8 * h1 - x, dy = cy + 0.1 + 0.8 * h2 - y, d = dx * dx + dy * dy;
    if (d < f1) { f2 = f1; x2 = x1; y2 = y1; f1 = d; x1 = dx; y1 = dy; id = (h1 * 31.7 + h2 * 17.3) % 1; } else if (d < f2) { f2 = d; x2 = dx; y2 = dy; }
  }
  out[0] = Math.sqrt(f1); out[1] = Math.sqrt(f2); out[2] = id;
  const ex = x2 - x1, ey = y2 - y1;
  out[3] = Math.abs(ex) / (Math.sqrt(ex * ex + ey * ey) + 1e-6);
}
// linear -> sRGB byte (a LUT), sRGB hex -> linear rgb, in-place mix of rgb arrays
function makeSrgbLut() {
  const lut = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) { const x = i / 4095; lut[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); }
  return lut;
}
function lin(hex) {
  const n = parseInt(hex.slice(1), 16), f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
function mix3(o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }

// ---------------------------------------------------------------- the guitar's outline
// Lower and upper bouts as two ellipses, joined by a polynomial smooth max: the waist.
const GTR = {
  Lb: 0.505,                                 // body length
  e1: { c: 0.158, b: 0.158, a: 0.192, p: 2.25 },   // lower bout (centre y, half length, half width, superellipse power)
  e2: { c: 0.39, b: 0.115, a: 0.146, p: 2.7 },     // upper bout: flatter shoulders
  k: 0.07,                                   // waist softness
  Dt: 0.104,                                 // z of the top plane (the back tapers: depth 104 -> 88 mm)
  scale: 0.645,                              // scale length
  join: 14,                                  // fret at the body join
};
function ellW(e, y) { const t = Math.abs((y - e.c) / e.b); return t >= 1 ? 0 : e.a * Math.pow(1 - Math.pow(t, e.p), 1 / e.p); }
function bodyW(y) {
  const a = ellW(GTR.e1, y), b = ellW(GTR.e2, y);
  if (!(a > 0 && b > 0)) return Math.max(a, b);
  const h = Math.max(GTR.k - Math.abs(a - b), 0) / GTR.k;
  return Math.max(a, b) + h * h * GTR.k * 0.25;
}
const GLSL_OUTLINE = /* glsl */ `
  float lgEll( float y, vec4 e ) { float t = min( abs( ( y - e.x ) / e.y ), 1.0 ); return e.z * pow( max( 1.0 - pow( t, e.w ), 0.0 ), 1.0 / e.w ); }
  float lgBodyW( float y ) {
    float a = lgEll( y, vec4( ${GTR.e1.c}, ${GTR.e1.b}, ${GTR.e1.a}, ${GTR.e1.p} ) ), b = lgEll( y, vec4( ${GTR.e2.c}, ${GTR.e2.b}, ${GTR.e2.a}, ${GTR.e2.p} ) );
    float h = max( ${GTR.k} - abs( a - b ), 0.0 ) / ${GTR.k} * step( 1e-5, min( a, b ) );
    return max( a, b ) + h * h * ${GTR.k * 0.25};
  }
`;

// ---------------------------------------------------------------- shared GLSL
const GLSL_NOISE = /* glsl */ `
  float lgHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
  float lgNoise( vec3 x ) {
    vec3 i = floor( x ), f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( lgHash( i ), lgHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( lgHash( i + vec3( 0, 1, 0 ) ), lgHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( lgHash( i + vec3( 0, 0, 1 ) ), lgHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( lgHash( i + vec3( 0, 1, 1 ) ), lgHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
  // a thin dark line at the integer crossings of c, faded out when it gets finer than a pixel
  float lgLines( float c, float width ) {
    float fw = fwidth( c );
    float f = abs( fract( c ) - 0.5 );
    float l = 1.0 - smoothstep( 0.5 - width - fw, 0.5 - width + fw, f );
    return mix( l, width * 2.0, smoothstep( 0.25, 0.6, fw ) );
  }
  // bump from a height in metres (three's perturbNormalArb, screen-space derivatives)
  vec3 lgBump( vec3 surf_pos, vec3 surf_norm, float h, float faceDirection ) {
    vec2 dHdxy = vec2( dFdx( h ), dFdy( h ) );
    vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
    vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
    vec3 vN = surf_norm;
    vec3 R1 = cross( vSigmaY, vN );
    vec3 R2 = cross( vN, vSigmaX );
    float fDet = dot( vSigmaX, R1 ) * faceDirection;
    vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
    vec3 n = normalize( abs( fDet ) * surf_norm - vGrad );
    return dot( n, n ) > 0.5 ? n : surf_norm;
  }
  // box-filtered coverage of x in [a, b] over the pixel: crisp up close, a calm average when it gets finer than a pixel
  float lgBand( float x, float a, float b ) { float fw = max( fwidth( x ), 1e-7 ); return clamp( ( min( x + 0.5 * fw, b ) - max( x - 0.5 * fw, a ) ) / fw, 0.0, 1.0 ); }
  vec3 lgDesat( vec3 c, float k ) { float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); return mix( c, vec3( l ), k ); }
`;

// The common patch for the Phong materials here. part.frag computes, from the varyings:
//   vec3 lgAlb; float lgSpec; float lgShin; vec3 lgSpecCol; float lgH (metres, bump); float lgAO;
const VERT_PARS = /* glsl */ `
  attribute vec2 aUv;
  attribute vec3 aLoc;
  attribute float aKind;
  attribute float aAO;
  attribute float aEdge;
  varying vec2 vLgUv;
  varying vec3 vLgLoc;
  varying float vLgKind;
  varying float vLgAO;
  varying float vLgEdge;
  varying vec3 vLgW;
`;
const VERT_MAIN = /* glsl */ `
  #include <project_vertex>
  vLgUv = aUv; vLgLoc = aLoc; vLgKind = aKind; vLgAO = aAO; vLgEdge = aEdge;
  vLgW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const FRAG_PARS = /* glsl */ `
  varying vec2 vLgUv;
  varying vec3 vLgLoc;
  varying float vLgKind;
  varying float vLgAO;
  varying float vLgEdge;
  varying vec3 vLgW;
  uniform vec3 uLgNight;
  uniform vec3 uLgHaze;
  uniform vec2 uLgCenter;
  uniform float uLgGain;
  uniform vec3 uLgBounce;
  uniform vec3 uLgFire;
  ${GLSL_NOISE}
`;
// sky.js GLSL_WORLD: low = 0.62 (1 - exp(-(D - 6) / 30)) (1 - smoothstep(-0.5, 2.2, y)), linear space
const FRAG_HAZE = /* glsl */ `
  #include <opaque_fragment>
  {
    float lgD = length( vLgW.xz - uLgCenter );
    float lgLow = 0.62 * ( 1.0 - exp( -max( lgD - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vLgW.y ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uLgHaze, lgLow );
  }
`;

function patchPhong(mat, uniforms, key, part) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', VERT_MAIN);
    let lightsBegin = THREE.ShaderChunk.lights_fragment_begin;
    if (part.lightOcclusion) {
      lightsBegin = lightsBegin.replace(
        'getPointLightInfo( pointLight, geometryPosition, directLight );',
        'getPointLightInfo( pointLight, geometryPosition, directLight );\n\t\tdirectLight.color *= lgOcclusion( pointLight.position );');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS + (part.pars || ''))
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + part.frag + '\n diffuseColor.rgb = lgAlb;')
      .replace('#include <specularmap_fragment>', 'float specularStrength = lgSpec;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = lgBump( - vViewPosition, normal, lgH, faceDirection );')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 lgUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
          float lgL = dot( lgAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
          totalEmissiveRadiance = uLgNight * ( 0.6 + 0.4 * max( dot( normal, lgUp ), 0.0 ) ) * ( 0.55 + 3.0 * lgL ) * lgAO;
          // firelight bounced off the lit ground around the fire: reaches the faces that look sideways and down
          vec3 lgToF = uLgFire - vLgW;
          float lgFd2 = dot( lgToF, lgToF );
          float lgFace = 0.35 + 0.65 * max( dot( normalize( transpose( mat3( viewMatrix ) ) * normal ), normalize( vec3( lgToF.x, 0.0, lgToF.z ) ) ), 0.0 );
          totalEmissiveRadiance += uLgBounce * lgAlb * ( 0.5 - 0.5 * dot( normal, lgUp ) ) * lgFace / ( 1.0 + lgFd2 / 3.0 ) * lgAO;
        }`)
      .replace('#include <lights_phong_fragment>', '#include <lights_phong_fragment>\n material.specularShininess = lgShin; material.specularColor = lgSpecCol;')
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.directDiffuse *= lgAO; reflectedLight.indirectDiffuse *= lgAO; reflectedLight.directSpecular *= lgAO * lgAO;`)
      .replace('#include <opaque_fragment>', FRAG_HAZE + `
        // a soft shoulder: the fire is close, nothing here may clip
        gl_FragColor.rgb = gl_FragColor.rgb / ( 1.0 + max( gl_FragColor.rgb - 0.3, 0.0 ) * 1.6 );`);
  };
  mat.customProgramCacheKey = () => 'iskry-log-' + key;
  return mat;
}

// ---------------------------------------------------------------- the log's fragment code
const LOG_FRAG_PARS = /* glsl */ `
  uniform sampler2D uLgBark;
  uniform mat4 uLgG2L;           // world -> guitar local
  ${GLSL_OUTLINE}
  // the guitar's shadow on the log from a point light (view-space position)
  float lgOcclusion( vec3 lightView ) {
    vec3 lw = transpose( mat3( viewMatrix ) ) * ( lightView - viewMatrix[ 3 ].xyz );
    vec3 p = ( uLgG2L * vec4( vLgW, 1.0 ) ).xyz, l = ( uLgG2L * vec4( lw, 1.0 ) ).xyz;
    float zm = ${(GTR.Dt * 0.55).toFixed(4)};
    float t = ( zm - p.z ) / ( l.z - p.z + 1e-5 );
    if ( t <= 0.0 || t >= 1.0 ) return 1.0;
    vec3 q = mix( p, l, t );
    float dist = length( l - p ) * t;                         // receiver -> occluder
    float soft = 0.006 + dist * 0.3;                          // an extended flame: the penumbra widens with distance
    float body = smoothstep( -soft, soft, lgBodyW( q.y ) - abs( q.x ) );
    float neck = smoothstep( -soft, soft, 0.028 - abs( q.x ) ) * smoothstep( ${GTR.Lb - 0.02}, ${GTR.Lb + 0.01}, q.y ) * ( 1.0 - smoothstep( ${GTR.Lb + 0.53}, ${GTR.Lb + 0.56}, q.y ) );
    float head = smoothstep( -soft, soft, 0.044 - abs( q.x ) ) * smoothstep( ${GTR.Lb + 0.36}, ${GTR.Lb + 0.38}, q.y ) * ( 1.0 - smoothstep( ${GTR.Lb + 0.53}, ${GTR.Lb + 0.56}, q.y ) );
    return 1.0 - 0.88 * max( body, max( neck, head ) );
  }
`;
const LOG_FRAG = /* glsl */ `
  vec3 lgAlb; float lgSpec = 0.0; float lgShin = 8.0; vec3 lgSpecCol = vec3( 0.04 ); float lgH = 0.0; float lgAO = vLgAO;
  int lgK = int( vLgKind + 0.5 );
  if ( lgK == 0 ) {
    // baked bark / bare wood / seat / moss: albedo (sRGB texture) + height in alpha
    vec4 bk = texture2D( uLgBark, vLgUv );
    lgAlb = bk.rgb;
    lgH = bk.a * 0.014;
    lgSpec = 0.25 * smoothstep( 0.35, 0.6, bk.a ) * smoothstep( 0.05, 0.2, dot( bk.rgb, vec3( 0.33 ) ) );   // smooth worn wood, a faint sheen
    lgShin = 14.0;
  } else if ( lgK == 1 ) {
    // a sawn end: vLgLoc.xy cut-plane coords (m) from the axis, z = end (+1 near, -1 far), vLgEdge = r / wood radius
    float endId = vLgLoc.z;
    vec2 q = vLgLoc.xy - vec2( 0.011, -0.014 ) * ( endId > 0.0 ? 1.0 : -0.6 );
    float r = length( q ), a = atan( q.y, q.x );
    float fr = vLgEdge;
    float warp = 0.0035 * ( lgNoise( vec3( cos( a ) * 2.0, sin( a ) * 2.0, r * 22.0 + endId ) ) - 0.5 ) + 0.002 * sin( a * 3.0 + endId );
    float ring = ( r + warp ) * ( 300.0 - 90.0 * fr ) + 1.5 * lgNoise( vec3( q * 60.0, endId ) );
    float late = lgLines( ring, 0.12 );
    float heart = 1.0 - smoothstep( 0.55, 0.62, fr + 0.03 * sin( a * 5.0 ) );
    vec3 sap = vec3( 0.30, 0.215, 0.13 ), hw = vec3( 0.21, 0.11, 0.05 );
    lgAlb = mix( sap, hw, heart );
    // blue stain fungus in the sapwood: grey streaks along the rays
    float blue = smoothstep( 0.55, 0.8, lgNoise( vec3( a * 7.0, fr * 3.0, endId * 3.0 ) ) ) * ( 1.0 - heart ) * smoothstep( 0.98, 0.7, fr );
    lgAlb = mix( lgAlb, vec3( 0.075, 0.08, 0.08 ), blue * 0.7 );
    lgAlb *= 1.0 - 0.45 * late;
    lgH = -0.0004 * late;
    // weathering: grey, darker for the older far end; grime and green algae creeping up from the bottom
    lgAlb = mix( lgAlb, vec3( 0.14, 0.13, 0.115 ), endId > 0.0 ? 0.28 : 0.55 );
    float low = smoothstep( -0.05, -0.19, q.y );
    lgAlb = mix( lgAlb, vec3( 0.035, 0.04, 0.018 ), low * ( 0.35 + 0.4 * lgNoise( vec3( q * 40.0, 3.0 ) ) ) );
    // saw marks: faint parallel kerf ripples
    float saw = sin( dot( q, vec2( 0.86, 0.5 ) ) * 700.0 + 2.5 * sin( q.y * 35.0 ) );
    lgAlb *= 1.0 + 0.06 * saw * ( 1.0 - smoothstep( 0.0, 0.5, fwidth( dot( q, vec2( 0.86, 0.5 ) ) * 110.0 ) ) );
    lgH += 0.00012 * saw;
    // radial checks, opening outward
    float crack = 0.0;
    for ( int k = 0; k < 6; k++ ) {
      float fk = float( k );
      float ak = fk * 1.13 + 0.7 * sin( fk * 3.7 + endId * 2.1 ) + endId * 0.4;
      float len = 0.55 + 0.45 * fract( sin( fk * 12.9 + endId * 7.1 ) * 43758.5 );
      float da = abs( mod( a - ak + 0.03 * sin( r * 90.0 + fk ) + 3.14159, 6.28318 ) - 3.14159 ) * r;
      float w = 0.0003 + 0.0045 * fr * fr * ( endId > 0.0 ? 1.0 : 1.5 );
      float c = ( 1.0 - smoothstep( w * 0.4, w, da ) ) * smoothstep( 0.04, 0.12, fr ) * ( 1.0 - smoothstep( len - 0.05, len, 1.0 - fr ) * 0.0 ) * step( 1.0 - len, fr );
      crack = max( crack, c );
    }
    lgAlb = mix( lgAlb, vec3( 0.006, 0.004, 0.003 ), crack );
    lgH -= 0.004 * crack;
    lgAO *= 1.0 - 0.6 * crack;
    // the pith
    lgAlb = mix( lgAlb, vec3( 0.06, 0.03, 0.015 ), 1.0 - smoothstep( 0.002, 0.004, r ) );
    // bark ring beyond the wood
    float bark = smoothstep( 0.995, 1.01, fr );
    float layers = 0.5 + 0.5 * sin( ( fr - 1.0 ) * 900.0 + 3.0 * lgNoise( vec3( a * 9.0, fr * 30.0, 2.0 ) ) );
    vec3 barkCol = mix( vec3( 0.055, 0.03, 0.018 ), vec3( 0.13, 0.06, 0.03 ), layers * smoothstep( 1.06, 1.0, fr ) );
    lgAlb = mix( lgAlb, barkCol, bark );
    lgH += bark * 0.001 * layers;
  } else if ( lgK == 2 ) {
    // broken raw wood (the branch stub's tip): pale, greyed, torn fibres along the stub
    float f = lgLines( vLgLoc.y * 9.0 + 0.4 * lgNoise( vec3( vLgLoc * 80.0 ) ), 0.2 );
    lgAlb = vec3( 0.2, 0.17, 0.13 ) * ( 0.75 + 0.35 * lgNoise( vec3( vLgLoc * 150.0 ) ) ) * ( 1.0 - 0.5 * f );
    lgH = 0.001 * f;
  } else if ( lgK == 3 ) {
    // branch bark (procedural, small scale): vLgLoc = (t along, phi, 0)
    float n = lgNoise( vec3( vLgLoc.x * 60.0, cos( vLgLoc.y ) * 3.0, sin( vLgLoc.y ) * 3.0 ) );
    float fl = lgLines( vLgLoc.y * 3.0 + n * 2.0, 0.08 );
    lgAlb = mix( vec3( 0.06, 0.042, 0.03 ), vec3( 0.11, 0.06, 0.035 ), n ) * ( 1.0 - 0.5 * fl );
    lgH = 0.0012 * n;
    lgAlb = mix( lgAlb, vec3( 0.03, 0.035, 0.015 ), smoothstep( 0.6, 0.0, vLgLoc.x * 10.0 ) * 0.5 );
  } else if ( lgK == 4 ) {
    // folded wool blanket: a muted check (umber ground, oxblood and smoke-grey bands), fold layers on the sides
    vec3 q = vLgLoc;
    float bx = lgBand( fract( q.x / 0.075 ), 0.0, 0.32 ), bz = lgBand( fract( q.z / 0.075 + 0.3 ), 0.0, 0.32 );
    float lx = lgBand( fract( q.x / 0.075 ), 0.6, 0.66 ), lz = lgBand( fract( q.z / 0.075 + 0.3 ), 0.6, 0.66 );
    vec3 wool = vec3( 0.045, 0.03, 0.022 );
    wool = mix( wool, vec3( 0.062, 0.027, 0.019 ), max( bx, bz ) * 0.8 );
    wool = mix( wool, vec3( 0.03, 0.012, 0.009 ), bx * bz * 0.7 );
    wool = mix( wool, vec3( 0.09, 0.08, 0.068 ), max( lx, lz ) * 0.4 );
    float fuzz = lgNoise( vec3( q * 600.0 ) ) * 0.6 + lgNoise( vec3( q * 160.0 ) ) * 0.4;
    wool *= 0.8 + 0.4 * fuzz;
    // the sides show the folded layers
    vec3 nW = normalize( transpose( mat3( viewMatrix ) ) * vNormal );
    float side = 1.0 - smoothstep( 0.4, 0.8, abs( nW.y ) );
    float layers = lgLines( ( q.y + 0.021 ) / 0.0105, 0.12 );
    wool *= 1.0 - 0.6 * layers * side;
    lgAlb = wool;
    lgH = 0.0006 * fuzz;
    lgSpec = 0.0;
  } else if ( lgK == 5 ) {
    // enamel: dark bottle green, speckled, a black rim, chips down to the black steel
    float a = vLgLoc.x, y = vLgLoc.y;
    float sp = smoothstep( 0.8, 0.86, lgNoise( vec3( cos( a ) * 70.0, sin( a ) * 70.0, y * 260.0 ) ) );
    vec3 en = mix( vec3( 0.012, 0.035, 0.03 ), vec3( 0.13, 0.14, 0.12 ), sp * 0.6 );
    float rim = smoothstep( 0.0755, 0.0775, y ) + ( 1.0 - smoothstep( 0.002, 0.004, y ) );
    float chip = smoothstep( 0.78, 0.8, lgNoise( vec3( cos( a ) * 9.0, sin( a ) * 9.0, y * 40.0 + 3.0 ) ) );
    lgAlb = mix( en, vec3( 0.008, 0.007, 0.006 ), clamp( rim + chip, 0.0, 1.0 ) );
    lgSpec = mix( 0.9, 0.3, chip ); lgShin = 70.0; lgSpecCol = vec3( 0.08 );
    lgH = -0.0003 * chip;
  } else if ( lgK == 6 ) {
    // the mug's inside: pale enamel gone grey, a dark ring where tea stood
    float y = vLgLoc.y;
    lgAlb = mix( vec3( 0.07, 0.068, 0.06 ), vec3( 0.025, 0.015, 0.008 ), smoothstep( 0.03, 0.04, y ) * ( 1.0 - smoothstep( 0.045, 0.05, y ) ) * 0.7 + ( 1.0 - smoothstep( 0.006, 0.02, y ) ) * 0.4 );
    lgSpec = 0.5; lgShin = 40.0;
  } else {
    lgAlb = vec3( 0.05 );
  }
`;

// ---------------------------------------------------------------- the guitar's fragment code
// position is the guitar's local frame: x across (treble +x), y up the neck, z out of the top.
function guitarFrag() {
  const Lb = GTR.Lb, S = GTR.scale;
  const dJoin = S * (1 - Math.pow(2, -GTR.join / 12));
  const yNut = Lb + dJoin;
  const yHole = Lb - 0.135;
  return {
    pars: /* glsl */ `
      ${GLSL_OUTLINE}
      varying vec3 vLgP;
      const float LG_YNUT = ${yNut.toFixed(5)};
      const float LG_YHOLE = ${yHole.toFixed(5)};
      const float LG_SCALE = ${S.toFixed(4)};
      float lgSmin( float a, float b, float k ) { float h = max( k - abs( a - b ), 0.0 ) / k; return min( a, b ) - h * h * k * 0.25; }
    `,
    frag: /* glsl */ `
      vec3 lgAlb; float lgSpec = 0.3; float lgShin = 40.0; vec3 lgSpecCol = vec3( 0.05 ); float lgH = 0.0; float lgAO = vLgAO;
      vec3 p = vLgP;
      int lgK = int( vLgKind + 0.5 );
      if ( lgK == 0 ) {
        // ---- the spruce top
        float ax = abs( p.x );
        float e = vLgEdge;                                     // m from the outline
        // book-matched grain: tight at the centre seam, wider toward the edges, a slow wander
        float wander = 1.6 * lgNoise( vec3( p.y * 3.0, ax * 14.0, 1.0 ) ) + 0.5 * sin( p.y * 7.0 + ax * 25.0 );
        float gc = ax * ( 520.0 - 330.0 * ax ) + wander;
        float late = lgLines( gc, 0.16 );
        float fine = lgLines( gc * 3.0 + 0.7 * lgNoise( vec3( p.y * 20.0, ax * 60.0, 3.0 ) ), 0.1 );
        // silking: short pale cross-grain flecks (medullary rays)
        float silk = smoothstep( 0.72, 0.9, lgNoise( vec3( p.y * 260.0, ax * 25.0, 5.0 ) ) ) * ( 1.0 - smoothstep( 0.2, 0.6, fwidth( p.y * 260.0 ) ) );
        vec3 spruce = vec3( 0.094, 0.075, 0.051 );               // aged honey spruce, already ~60% and desaturated
        spruce *= ( 0.9 + 0.14 * lgNoise( vec3( p.x * 9.0, p.y * 2.0, 7.0 ) ) );
        spruce *= 1.0 - 0.3 * late - 0.08 * fine;
        spruce *= 1.0 + 0.1 * silk;
        // the finish has ambered toward the edges and around the bridge: a faint sunburst of age
        spruce = mix( spruce, spruce * vec3( 0.78, 0.6, 0.45 ), smoothstep( 0.05, 0.0, e ) * 0.6 );
        lgAlb = spruce;
        lgSpec = 0.55; lgShin = 55.0; lgSpecCol = vec3( 0.06, 0.055, 0.05 );
        lgH = -0.00008 * late;
        // lacquer checking: a faint network of fine cracks
        float chk = lgLines( p.y * 140.0 + 1.5 * lgNoise( vec3( p.xy * vec2( 40.0, 8.0 ), 9.0 ) ), 0.04 ) * smoothstep( 0.55, 0.85, lgNoise( vec3( p.xy * 11.0, 4.0 ) ) );
        lgAlb *= 1.0 - 0.18 * chk;
        // wear: under the strumming hand and where the forearm rests (bass side, lower bout edge)
        vec2 pw = p.xy - vec2( 0.012, LG_YHOLE - 0.072 );
        float pick = 1.0 - smoothstep( 0.02, 0.05, length( pw * vec2( 1.0, 1.35 ) ) );
        float arm = smoothstep( 0.05, 0.0, e ) * smoothstep( 0.0, -0.06, p.x ) * smoothstep( 0.12, 0.2, p.y ) * smoothstep( 0.34, 0.26, p.y );
        float scr = smoothstep( 0.62, 0.9, lgNoise( vec3( ( mat2( 0.8, 0.6, -0.6, 0.8 ) * p.xy ) * vec2( 900.0, 30.0 ), 11.0 ) ) );
        float wear = max( pick * ( 0.55 + 0.45 * scr ), arm * 0.8 );
        lgAlb = mix( lgAlb, lgDesat( lgAlb, 0.5 ) * 1.15, wear * 0.65 );
        lgSpec *= 1.0 - 0.85 * wear;
        // sound hole: the dark inside, a thin rim of the top's end grain
        vec2 hc = p.xy - vec2( 0.0, LG_YHOLE );
        float hr = length( hc ), ha = atan( hc.y, hc.x );
        float RH = 0.049;
        // rosette: thin rings, a mosaic band (herringbone), thin rings
        float rr = hr - RH;
        float thinA = lgBand( rr, 0.0025, 0.0045 );
        float thinB = lgBand( rr, 0.016, 0.0185 );
        float band = lgBand( rr, 0.0055, 0.0145 );
        float herr = step( 0.5, fract( ha * 30.0 + ( ( fract( rr * 220.0 ) < 0.5 ) ? rr * 220.0 : -rr * 220.0 ) ) );
        herr = mix( herr, 0.5, smoothstep( 0.3, 0.8, fwidth( ha * 30.0 ) ) );
        vec3 ros = mix( vec3( 0.015, 0.01, 0.008 ), vec3( 0.17, 0.15, 0.12 ), herr );
        float tl = lgLines( rr * 1300.0, 0.25 );               // black-white-black lines
        lgAlb = mix( lgAlb, mix( vec3( 0.16, 0.145, 0.12 ), vec3( 0.012, 0.009, 0.007 ), tl ), max( thinA, thinB ) );
        lgAlb = mix( lgAlb, ros, band );
        float inside = lgBand( hr, -1.0, RH );
        float rim = lgBand( hr, RH - 0.0014, RH );
        vec3 deep = vec3( 0.006, 0.004, 0.003 ) + vec3( 0.02, 0.012, 0.007 ) * smoothstep( 0.0, -RH, hc.y ) * ( 1.0 - smoothstep( 0.6, 1.0, hr / RH ) );
        lgAlb = mix( lgAlb, deep, inside );
        lgAlb = mix( lgAlb, vec3( 0.17, 0.13, 0.08 ), rim );
        lgSpec *= 1.0 - inside;
        lgAO *= 1.0 - 0.6 * inside;
        // tortoiseshell pickguard, hugging the rosette on the treble side
        float pg = lgSmin( length( p.xy - vec2( 0.04, LG_YHOLE - 0.042 ) ) - 0.046, length( p.xy - vec2( 0.066, LG_YHOLE - 0.096 ) ) - 0.024, 0.045 );
        pg = max( pg, -( hr - ( RH + 0.0205 ) ) );                     // it hugs the rosette
        float pgm = lgBand( pg, -1.0, 0.0 );
        float tort = lgNoise( vec3( p.xy * 55.0, 2.0 ) ) * 0.7 + lgNoise( vec3( p.xy * 160.0, 8.0 ) ) * 0.3;
        vec3 pgc = mix( vec3( 0.016, 0.008, 0.0045 ), vec3( 0.055, 0.025, 0.01 ), smoothstep( 0.55, 0.9, tort ) );
        pgc = mix( pgc, vec3( 0.035, 0.03, 0.026 ), pick * scr * 0.4 );         // scratched by the pick
        lgAlb = mix( lgAlb, pgc, pgm );
        lgSpec = mix( lgSpec, 0.3 * ( 1.0 - 0.6 * pick ), pgm );
        lgH += pgm * 0.0003;
        // binding (aged ivory) and purfling at the edge
        float bind = lgBand( e, -1.0, 0.0031 );
        float purf = lgBand( e, 0.0031, 0.0042 );
        lgAlb = mix( lgAlb, vec3( 0.012, 0.009, 0.007 ), purf );
        vec3 ivory = vec3( 0.25, 0.21, 0.15 ) * ( 0.9 + 0.2 * lgNoise( vec3( p.xy * 300.0, 1.0 ) ) );
        lgAlb = mix( lgAlb, mix( ivory, ivory * 0.6, arm ), bind );
        lgH += bind * 0.0002;
        // contact darkening around the fretboard extension and the bridge
        float fbx = 0.0295 - ax;
        lgAO *= 1.0 - 0.45 * smoothstep( 0.008, 0.0, -fbx ) * step( 0.0, -fbx ) * smoothstep( ${(Lb - 0.088).toFixed(4)}, ${(Lb - 0.082).toFixed(4)}, p.y );
      } else if ( lgK == 1 || lgK == 2 ) {
        // ---- rosewood sides (grain along the side) and back (book-matched, a marquetry backstrip)
        float g = lgK == 1 ? p.z * 900.0 + 3.0 * lgNoise( vec3( p.xy * 12.0, 1.0 ) ) : abs( p.x ) * 700.0 + 2.5 * lgNoise( vec3( p.y * 10.0, abs( p.x ) * 30.0, 4.0 ) );
        float n = lgNoise( vec3( p * 25.0 ) );
        lgAlb = mix( vec3( 0.03, 0.014, 0.008 ), vec3( 0.075, 0.036, 0.018 ), n );
        lgAlb *= 1.0 - 0.45 * lgLines( g, 0.18 );
        lgSpec = 0.45; lgShin = 50.0; lgSpecCol = vec3( 0.05 );
        if ( lgK == 1 ) {
          float bt = lgBand( vLgEdge, -1.0, 0.0031 );          // top binding on the side
          float bb = 1.0 - smoothstep( 0.0018, 0.0024, vLgEdge - 0.0 ) ;
          lgAlb = mix( lgAlb, vec3( 0.23, 0.195, 0.14 ), bt );
          lgAO *= 1.0 - 0.15 * smoothstep( 0.1, 0.0, ${GTR.Dt} - p.z );
        } else {
          float strip = lgBand( p.x, -0.0028, 0.0028 );
          float zig = step( 0.5, fract( p.y * 220.0 + abs( p.x ) * 400.0 ) );
          lgAlb = mix( lgAlb, mix( vec3( 0.02, 0.012, 0.008 ), vec3( 0.2, 0.17, 0.12 ), zig ), strip );
        }
      } else if ( lgK == 3 ) {
        // ---- mahogany neck, heel and headstock edges: satin, worn smooth where the hand slides
        float g = p.x * 400.0 + p.z * 300.0 + 2.0 * lgNoise( vec3( p.y * 6.0, p.x * 50.0, 2.0 ) );
        lgAlb = vec3( 0.085, 0.042, 0.022 ) * ( 1.0 - 0.3 * lgLines( g, 0.15 ) ) * ( 0.9 + 0.2 * lgNoise( vec3( p * 40.0 ) ) );
        float hand = smoothstep( LG_YNUT - 0.02, LG_YNUT - 0.06, p.y ) * smoothstep( LG_YNUT - 0.3, LG_YNUT - 0.2, p.y ) * smoothstep( ${(GTR.Dt - 0.008).toFixed(4)}, ${(GTR.Dt - 0.02).toFixed(4)}, p.z );
        lgAlb = mix( lgAlb, lgAlb * 1.35, hand );
        lgSpec = 0.2 + 0.4 * hand; lgShin = 25.0 + 30.0 * hand;
      } else if ( lgK == 4 ) {
        // ---- rosewood fretboard with pearl dots at the real fret positions
        float d = LG_YNUT - p.y;                                   // m from the nut
        lgAlb = vec3( 0.022, 0.012, 0.007 ) * ( 0.8 + 0.4 * lgNoise( vec3( p.x * 400.0, p.y * 25.0, 3.0 ) ) );
        lgAlb *= 1.0 - 0.35 * lgLines( p.x * 650.0 + lgNoise( vec3( p.y * 30.0, p.x * 90.0, 1.0 ) ) * 2.0, 0.15 );
        lgSpec = 0.15; lgShin = 18.0;
        float n = -12.0 * log2( max( 1.0 - d / LG_SCALE, 0.05 ) );
        float fretN = floor( n ) + 1.0;                           // the space before this fret
        float mid = LG_SCALE * ( 1.0 - exp2( -( fretN - 0.5 ) / 12.0 ) );
        float on = 0.0;
        if ( fretN == 3.0 || fretN == 5.0 || fretN == 7.0 || fretN == 9.0 || fretN == 15.0 || fretN == 17.0 ) on = 1.0;
        float dx = fretN == 12.0 ? abs( abs( p.x ) - 0.0095 ) : abs( p.x );
        if ( fretN == 12.0 ) on = 1.0;
        float dot1 = on * ( 1.0 - smoothstep( 0.0028, 0.0033, length( vec2( dx, d - mid ) ) ) ) * step( ${GTR.Dt + 0.007}, p.z );
        vec3 pearl = vec3( 0.2, 0.2, 0.19 ) + 0.06 * vec3( sin( p.x * 3000.0 ), sin( p.x * 3000.0 + 2.0 ), sin( p.x * 3000.0 + 4.0 ) );
        lgAlb = mix( lgAlb, pearl, dot1 );
        lgSpec = mix( lgSpec, 0.7, dot1 );
      } else if ( lgK == 5 ) {
        // ---- nickel-silver frets and tuners, a little dulled
        lgAlb = vec3( 0.07, 0.065, 0.06 );
        lgSpec = 1.0; lgShin = 70.0; lgSpecCol = vec3( 0.45, 0.42, 0.38 );
      } else if ( lgK == 6 ) {
        // ---- headstock veneer (dark rosewood), glossy
        lgAlb = vec3( 0.018, 0.01, 0.006 ) * ( 0.8 + 0.4 * lgNoise( vec3( p * 120.0 ) ) );
        lgSpec = 0.6; lgShin = 60.0;
      } else if ( lgK == 7 ) {
        // ---- bone and ivory-coloured plastic (nut, saddle, pins, end pin)
        lgAlb = vec3( 0.27, 0.235, 0.17 );
        lgSpec = 0.4; lgShin = 30.0;
      } else {
        // ---- rosewood bridge
        lgAlb = vec3( 0.03, 0.016, 0.009 ) * ( 0.8 + 0.4 * lgNoise( vec3( p.x * 300.0, p.y * 60.0, 5.0 ) ) );
        lgSpec = 0.25; lgShin = 25.0;
      }
      lgAlb *= uLgGain;
    `,
  };
}

// ---------------------------------------------------------------- strings
const STR_VERT = /* glsl */ `
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aDiam;
  attribute float aType;
  uniform float uPx;                 // world size of one drawing-buffer pixel at view depth 1
  varying float vCov;
  varying float vAcross;
  varying vec3 vT;
  varying vec3 vVP;
  varying float vType;
  varying vec3 vSW;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    vec3 t = normalize( mat3( modelViewMatrix ) * aDir );
    vec3 side = normalize( cross( t, normalize( - mvPosition.xyz ) ) );
    float w = max( aDiam, uPx * ( - mvPosition.z ) * 1.15 );
    vCov = aDiam / w;
    mvPosition.xyz += side * aSide * w * 0.5;
    vAcross = aSide; vT = t; vVP = mvPosition.xyz; vType = aType;
    vSW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const STR_FRAG = /* glsl */ `
  varying float vCov;
  varying float vAcross;
  varying vec3 vT;
  varying vec3 vVP;
  varying float vType;
  varying vec3 vSW;
  uniform vec3 uSteel;
  uniform vec3 uBronze;
  uniform vec3 uNight;
  uniform vec3 uHaze;
  uniform vec2 uCenter;
  uniform float uGlint;
  #include <common>
  #include <lights_pars_begin>
  #include <fog_pars_fragment>
  void main() {
    vec3 V = normalize( - vVP );
    vec3 T = normalize( vT );
    vec3 side = normalize( cross( T, V ) );
    float c = clamp( vAcross, -1.0, 1.0 );
    vec3 N = normalize( side * c + V * sqrt( max( 1.0 - c * c, 0.0 ) ) );
    vec3 base = vType > 0.5 ? uBronze : uSteel;
    vec3 col = uNight * ( 0.5 + 2.0 * base );
    #if NUM_POINT_LIGHTS > 0
    for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
      vec3 Lv = pointLights[ i ].position - vVP;
      float d = length( Lv );
      vec3 L = Lv / d;
      vec3 irr = pointLights[ i ].color * getDistanceAttenuation( d, pointLights[ i ].distance, pointLights[ i ].decay );
      float TL = dot( T, L ), TV = dot( T, V );
      float kk = max( sqrt( max( 1.0 - TL * TL, 0.0 ) ) * sqrt( max( 1.0 - TV * TV, 0.0 ) ) - TL * TV, 0.0 );
      float diff = max( dot( N, L ), 0.0 );
      float spec = pow( kk, 50.0 ) * 1.3 + pow( kk, 8.0 ) * 0.08;
      col += irr * ( base * diff * RECIPROCAL_PI + spec * uGlint * mix( vec3( 0.9, 0.88, 0.85 ), base * 2.4, vType ) );
    }
    #endif
    float D = length( vSW.xz - uCenter );
    col = mix( col, uHaze, 0.62 * ( 1.0 - exp( -max( D - 6.0, 0.0 ) / 30.0 ) ) * ( 1.0 - smoothstep( -0.5, 2.2, vSW.y ) ) );
    col = col / ( 1.0 + max( col - 0.35, 0.0 ) * 1.2 );
    float aa = 1.0 - smoothstep( 1.0 - fwidth( vAcross ) * 1.5, 1.0, abs( vAcross ) );
    gl_FragColor = vec4( col, vCov * aa );
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// ---------------------------------------------------------------- the log's shape (pure, shared with the bake worker)
// P = { L, R, BT, SEAT: { a, b, ramp, depth } }
function coreR(P, s, th) {
  // wood (core) radius: tapering toward the crown (+s), oval, lumpy
  return (P.R - P.BT * 0.85) * (1 + 0.04 * (-s / P.L)) * (1 + 0.022 * Math.cos(2 * th - 0.6) + 0.012 * Math.cos(3 * th + 1.1) + 0.01 * Math.sin(s * 4.3 + th) + 0.008 * Math.sin(s * 9.1 - 2 * th));
}
function seatCutP(P, s, xf) {
  // the seat: a plane hewn along the top, tilted a touch toward the fire, shallow hollows where people sit
  const S = P.SEAT, ramp = smooth(S.a - S.ramp, S.a, s) * (1 - smooth(S.b, S.b + S.ramp, s));
  const top = P.R + 0.04, seat = P.R - S.depth;
  return top - (top - seat) * ramp - 0.05 * xf * ramp - 0.004 * Math.exp(-(((s + 0.18) / 0.22) ** 2)) - 0.003 * Math.exp(-(((s - 0.32) / 0.2) ** 2));
}

// ---------------------------------------------------------------- bake the bark
// Texture u along the log (0 at end A), v around from the bottom (THETA0). RGB albedo (sRGB), A = bump height.
// hgt (m above the wood) drives the silhouette, so the geometry and the texture agree.
// Pure: runs in a worker (its source is this module's own functions), or inline as a fallback.
function bakeBark(P) {
  const { TW, TH, L, R, BT, THETA0, seed } = P;
  const TAU = Math.PI * 2;
const BOUNCE = 0.03;          // ground bounce per candela of the fire light
  const lut = makeSrgbLut();
  const toByte = (x) => lut[clamp(Math.round(x * 4095), 0, 4095)];
  const Rc = (s, th) => coreR(P, s, th), seatCut = (s, xf) => seatCutP(P, s, xf);
  const tex = new Uint8Array(TW * TH * 4);
  const hgt = new Float32Array(TW * TH);
  {
    const NA = 22;                                   // bark plates around (about 5.5 cm wide)
    // slow fields on a coarse grid (peel, moss), bilinear per texel
    const CW = (TW >> 3) + 1, CH = TH >> 3;
    const cPeel = new Float32Array(CW * CH), cMoss = new Float32Array(CW * CH);
    for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++) {
      const u = i / (CW - 1), v = j / CH, s = (u - 0.5) * L, th = THETA0 + TAU * v, st = Math.sin(th), ct = Math.cos(th);
      cPeel[j * CW + i] = fbm(s / 0.2, v * 6, 6, 4, seed + 5) + 0.12 * smooth(0.2, 1, st) + 0.16 * smooth(0.6, 0.95, Math.abs(s) / L * 2)
        + 0.05 * Math.max(0, ct) - 0.3 * smooth(-0.1, -0.7, st);
      cMoss[j * CW + i] = fbm(s / 0.1, v * 14, 14, 3, seed + 6);
    }
    const coarse = (A, u, v) => {
      const x = u * (CW - 1), y = v * CH - 0.5;
      const i = Math.min(Math.floor(x), CW - 2), fx = x - i, jy = Math.floor(y), fy = y - jy;
      const j0 = ((jy % CH) + CH) % CH, j1 = (j0 + 1) % CH;
      const a = A[j0 * CW + i], b = A[j0 * CW + i + 1], c = A[j1 * CW + i], d = A[j1 * CW + i + 1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    const vo = [0, 0, 0, 0];
    const C_PLATE = [lin('#3b342e'), lin('#463d35'), lin('#332b25'), lin('#3f352c')];
    const C_FLAKE = lin('#4e2c1c'), C_FLAKE2 = lin('#603826'), C_FISS = lin('#0f0907'), C_INNER = lin('#4d2d1d');
    const C_WOOD = lin('#463f36'), C_WOOD2 = lin('#3b342b'), C_GALL = lin('#2a1e16');
    const C_SEAT = lin('#5f4f3e'), C_SEAT_LATE = lin('#3f3125'), C_BARKCUT = lin('#3e2316');
    const C_MOSS = lin('#2f3a15'), C_MOSS2 = lin('#4b5520'), C_LICHEN = lin('#5d6152');
    const col = [0, 0, 0], tmp = [0, 0, 0];
    const CHECK_X = [-0.028, 0.041, 0.006], CHECK_SPAN = [[-0.5, 0.15], [-0.1, 0.55], [-0.55, -0.3]], C_CRACK = [0.005, 0.0035, 0.0025];
    for (let j = 0; j < TH; j++) {
      const v = (j + 0.5) / TH, th = THETA0 + TAU * v, st = Math.sin(th), ct = Math.cos(th);
      const low = smooth(-0.55, -0.98, st);
      for (let i = 0; i < TW; i++) {
        const u = (i + 0.5) / TW, s = (u - 0.5) * L;
        // --- plates: long irregular cells along the trunk, V-shaped fissures between them
        const warp = vnoise(s / 0.06, v * 36, 36, seed + 1) - 0.5;
        voronoi(s / 0.19 + warp * 0.45, v * NA + warp * 0.9, NA, seed + 2, vo);
        const cross = vo[3] * vo[3];
        const edge = (vo[1] - vo[0]) * (1 + 1.6 * cross), pid = vo[2];   // cross furrows narrower and shallower
        const plate = smooth(0.05, 0.42, edge) * (1 - 0.25 * cross * (1 - smooth(0.0, 0.3, edge)));                // 0 in the fissure, 1 on the plate
        const fiss = 1 - plate;
        // scaly layers on the plate: terraces of a noise, lower layers redder (fresh), the top grey
        const fl = 0.65 * vnoise(s / 0.022 + pid * 13, v * 96, 96, seed + 3) + 0.35 * vnoise(s / 0.009, v * 230, 230, seed + 23);
        const lev = Math.floor(fl * 5) / 5;
        const stepEdge = 1 - smooth(0.0, 0.08, Math.abs(fl * 5 - Math.round(fl * 5)));   // the rim of each scale
        // cross cracks breaking the long plates
        const xc = smooth(0.9, 0.97, vnoise(s / 0.035, v * NA * 1.5, NA * 3, seed + 24)) * plate;
        const top = plate * (1 - xc * 0.7);
        let hb = top * (0.55 + 0.2 * pid + 0.35 * lev) + (fiss > 0.05 ? 0.06 * fiss * vnoise(s / 0.04, v * 380, 380, seed + 4) : 0);
        // --- bark gone: weathered sapwood
        const pm = coarse(cPeel, u, v) + 0.035 * (warp);
        const peel = smooth(0.635, 0.645, pm);
        const lip = Math.exp(-(((pm - 0.64) / 0.005) ** 2)) * (1 - peel * 0.5);
        // --- moss low on the trunk and in the fissures
        const mn = coarse(cMoss, u, v);
        const moss = smooth(0.44, 0.64, -st * 0.8 + Math.max(0, -ct) * 0.2 + (mn - 0.5) * 1.0 + fiss * 0.18 + 0.12) * (1 - 0.8 * peel);
        // --- geometry height (m above the wood)
        let h = BT * (0.18 + 0.82 * hb);
        h = mix(h, 0.0006, peel) + lip * BT * 0.3;
        h += moss * 0.0035 * (0.4 + mn);
        // --- colour
        // grey weathered tops, red-brown flanks and freshly flaked scales, black at the fissure bottoms
        mix3(col, C_PLATE[(pid * 4) | 0], lev < 0.4 ? C_FLAKE : C_FLAKE2, smooth(0.32, 0.06, edge) * 0.7 + (1 - lev) * 0.2);
        const sh = 0.75 + 0.45 * fl - 0.3 * stepEdge;
        col[0] *= sh; col[1] *= sh; col[2] *= sh;
        mix3(col, col, C_FISS, Math.max(smooth(0.35, 1, fiss) * 0.92, xc * 0.75));
        mix3(col, col, C_INNER, lip * 0.8);
        if (st > 0.1 && plate > 0.01 && peel < 1) {
          const lichen = smooth(0.8, 0.86, vnoise(s / 0.011, v * 170, 170, seed + 7)) * smooth(0.1, 0.7, st) * plate * (1 - peel);
          mix3(col, col, C_LICHEN, lichen * 0.55);
        }
        if (peel > 0.001) {
          const gw = vnoise(s / 0.35, v * 600, 600, seed + 8);
          const grain = smooth(0.6, 0.85, vnoise(s / 0.8, v * 480 + gw * 2.5, 480, seed + 9));
          mix3(tmp, C_WOOD, C_WOOD2, coarse(cMoss, u * 0.7 + 0.1, v));
          const gk = 1 - 0.28 * grain; tmp[0] *= gk; tmp[1] *= gk; tmp[2] *= gk;
          // engraver beetle galleries: a mother gallery along the grain, larval galleries out to the sides
          const cs = 0.15, nv = 8, cv = 1 / nv;
          const ci = Math.floor(s / cs), cj = Math.floor(v / cv);
          let gall = 0;
          if (hash2(ci, cj % nv, seed + 11) > 0.55) {
            const ls = s - (ci + 0.5) * cs + 0.03 * (hash2(ci, cj, seed + 30) - 0.5), la = (v - (cj + 0.5) * cv) * TAU * R;
            const Lm = 0.03 + 0.025 * hash2(ci, cj, seed + 12);
            const wob = 0.003 * Math.sin(ls * 90 + ci) + 0.0015 * Math.sin(ls * 230);
            const aa = Math.abs(la - wob);
            if (Math.abs(ls) < Lm) gall = 1 - smooth(0.0007, 0.0014, aa);
            const k = Math.round(ls / 0.0038), lk = k * 0.0038;
            if (Math.abs(lk) < Lm) {
              const reach = (0.006 + 0.02 * (1 - Math.abs(lk) / Lm)) * (0.5 + 0.5 * hash2(k, ci + cj * 7, seed + 13));
              if (aa < reach) {
                const path = lk + Math.sign(lk || 1) * aa * 0.5 + 0.0016 * Math.sin(aa * 500 + k * 1.7);
                const w = 0.0004 + 0.0008 * aa / reach;
                gall = Math.max(gall, (1 - smooth(w * 0.5, w, Math.abs(ls - path))) * 0.8);
              }
            }
          }
          mix3(tmp, tmp, C_GALL, gall * 0.7);
          const chk = smooth(0.965, 0.99, vnoise(s / 0.5, v * 160, 160, seed + 25)) * smooth(0.3, 0.6, vnoise(s / 0.12, v * 9, 9, seed + 26));
          mix3(tmp, tmp, C_FISS, chk * 0.8);
          h -= chk * 0.002 * peel;
          h -= gall * 0.001 * peel;
          mix3(col, col, tmp, peel);
        }
        if (moss > 0.002) {
          mix3(tmp, C_MOSS, C_MOSS2, smooth(0.35, 0.8, vnoise(s / 0.007, v * 280, 280, seed + 15)) * 0.7 + mn * 0.2);
          mix3(col, col, tmp, moss * 0.9);
        }
        const lk2 = 1 - 0.45 * low; col[0] *= lk2; col[1] *= lk2 * 1.03; col[2] *= lk2 * 1.05;
        // --- the seat, hewn through the top (the same test as the geometry)
        let bump = clamp(h / 0.02, 0, 1);
        const rc = st > 0.55 ? Rc(s, th) : 0, ro = rc + h, xf = ro * ct, yu = ro * st;
        const cut = st > 0.55 ? seatCut(s, xf) : 1;
        if (yu > cut) {
          if (rc * st < cut) {
            // the plane only passes through the bark: its section, dark red-brown, a few layers
            const lay = vnoise(s / 0.01, (yu - cut) * 400, 1e6, seed + 16);
            mix3(col, C_BARKCUT, C_FISS, 0.25 + 0.4 * lay);
            bump = 0.45;
          } else {
            // growth rings where the plane crosses them: long V's from the taper
            const rho = Math.sqrt(xf * xf + cut * cut) - 0.012 * (s / L) + 0.0015 * vnoise(s / 0.2, v * 30, 30, seed + 17);
            const rr = rho * 290 + 0.8 * vnoise(s / 0.3, v * 50, 50, seed + 18);
            const f = rr - Math.floor(rr);
            const late = smooth(0.62, 0.78, f) * (1 - smooth(0.9, 1.0, f));
            mix3(col, C_SEAT, C_SEAT_LATE, late * 0.6);
            const n2 = vnoise(s / 0.05, v * 60, 60, seed + 19);
            const k2 = 0.9 + 0.2 * n2; col[0] *= k2; col[1] *= k2; col[2] *= k2;
            // darkened and smoothed by sitting in the middle, greyer at the edges
            const sit = smooth(0.1, 0.0, Math.abs(xf)) * (Math.exp(-(((s + 0.18) / 0.24) ** 2)) + Math.exp(-(((s - 0.32) / 0.2) ** 2)));
            const k3 = 1 - 0.2 * sit; col[0] *= k3; col[1] *= k3 * 0.98; col[2] *= k3 * 0.96;
            mix3(col, col, C_WOOD, smooth(0.08, 0.13, Math.abs(xf)) * 0.4);
            // adze ripples across the seat
            const adze = Math.sin(s / 0.045 * TAU + 2 * n2);
            bump = 0.5 + 0.05 * adze * (1 - sit);
            const k4 = 1 + 0.035 * adze; col[0] *= k4; col[1] *= k4; col[2] *= k4;
            // seasoning checks along the grain
            for (let k = 0; k < 3; k++) {
              const x0 = CHECK_X[k] + 0.004 * Math.sin(s * (5 + k) + k) + 0.002 * (vnoise(s / 0.04, k * 3, 9, seed + 21) - 0.5);
              const span = CHECK_SPAN[k];
              const open = smooth(span[0], span[0] + 0.1, s) * (1 - smooth(span[1] - 0.1, span[1], s));
              if (open < 0.02) continue;
              const w = (0.0004 + 0.0016 * open) * (0.7 + 0.6 * vnoise(s / 0.02, k, 9, seed + 22));
              const c = 1 - smooth(w * 0.5, w, Math.abs(xf - x0));
              if (c > 0) { mix3(col, col, C_CRACK, c); bump -= 0.35 * c; }
            }
          }
        }
        const k4 = (j * TW + i) * 4;
        tex[k4] = toByte(col[0]); tex[k4 + 1] = toByte(col[1]); tex[k4 + 2] = toByte(col[2]);
        tex[k4 + 3] = Math.round(clamp(bump, 0, 1) * 255);
        hgt[j * TW + i] = h;
      }
    }
  }
  return { tex, hgt };
}
const WORKER_SRC = [clamp, smooth, mix, hash2, vnoise, fbm, voronoi, makeSrgbLut, lin, mix3, coreR, seatCutP, bakeBark].map((f) => f.toString()).join('\n')
  + '\nonmessage = (e) => { const r = bakeBark(e.data); postMessage(r, [r.tex.buffer, r.hgt.buffer]); };';

// ---------------------------------------------------------------- geometry accumulator
// Indexed, with: position, normal, aUv (2), aLoc (3), aKind, aAO, aEdge.
const OUT = { u: 0, v: 0, lx: 0, ly: 0, lz: 0, kind: 0, ao: 1, edge: 0 };
class Acc {
  constructor() { this.P = []; this.N = []; this.UV = []; this.L = []; this.K = []; this.A = []; this.E = []; this.I = []; }
  // geo: a BufferGeometry (consumed). m: Matrix4 or null. fn(lp, wp, wn, OUT) fills OUT per vertex.
  add(geo, m, fn) {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pa = geo.attributes.position, na = geo.attributes.normal;
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const base = this.P.length / 3;
    const lp = new THREE.Vector3(), wp = new THREE.Vector3(), wn = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) {
      lp.fromBufferAttribute(pa, i); wp.copy(lp); if (m) wp.applyMatrix4(m);
      wn.fromBufferAttribute(na, i); if (nm) wn.applyMatrix3(nm); wn.normalize();
      OUT.u = 0; OUT.v = 0; OUT.lx = lp.x; OUT.ly = lp.y; OUT.lz = lp.z; OUT.kind = 0; OUT.ao = 1; OUT.edge = 0;
      if (fn) fn(lp, wp, wn, OUT, i);
      this.P.push(wp.x, wp.y, wp.z); this.N.push(wn.x, wn.y, wn.z);
      this.UV.push(OUT.u, OUT.v); this.L.push(OUT.lx, OUT.ly, OUT.lz);
      this.K.push(OUT.kind); this.A.push(OUT.ao); this.E.push(OUT.edge);
    }
    if (geo.index) { const ix = geo.index.array; for (let i = 0; i < ix.length; i++) this.I.push(base + ix[i]); }
    else for (let i = 0; i < pa.count; i++) this.I.push(base + i);
    geo.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('aLoc', new THREE.Float32BufferAttribute(this.L, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.K, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.A, 1));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.E, 1));
    g.setIndex(this.P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}
// a grid of (nu + 1) x (nv + 1) vertices from pos(iu, iv, outVec3) -> BufferGeometry (normals computed)
function gridGeo(nu, nv, pos, flip = false) {
  const p = new Float32Array((nu + 1) * (nv + 1) * 3), v = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { pos(i, j, v); const k = (j * (nu + 1) + i) * 3; p[k] = v.x; p[k + 1] = v.y; p[k + 2] = v.z; }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
function M(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

// ================================================================== build
export function createLog(ctx, opts = {}) {
  const t0 = performance.now();
  const T = {};
  const o = { ...DEFAULTS, ...opts };
  o.bench = { ...BENCH, ...(opts.bench || {}) };
  o.guitar = { ...GUITAR, ...(opts.guitar || {}) };
  const F = { x: +(o.firePosition.x ?? FIRE.x), y: +(o.firePosition.y ?? 0), z: +(o.firePosition.z ?? FIRE.z) };
  const seed = (o.seed * 977) | 0;

  const group = new THREE.Group();
  group.name = 'log';
  group.visible = false;
  ctx.scene.add(group);
  const geometries = [], materials = [], textures = [];

  const night = new THREE.Color(o.nightTone);
  const haze = new THREE.Color(o.hazeColor);
  const center = new THREE.Vector2(o.center.x, o.center.z);
  const common = {
    uLgNight: { value: night.clone() },
    uLgHaze: { value: haze.clone() },
    uLgCenter: { value: center.clone() },
    uLgBounce: { value: new THREE.Color(1, 0.42, 0.12).multiplyScalar(30 * BOUNCE) },
    uLgFire: { value: new THREE.Vector3(F.x, 0.3, F.z) },
  };

  // ------------------------------------------------------------ the log's frame
  const bn = o.bench;
  const L = bn.length, R = bn.radius;
  const e1 = new THREE.Vector3(bn.dirX, 0, bn.dirZ).normalize();         // along the log
  const ef = new THREE.Vector3(-e1.z, 0, e1.x); if (ef.z < 0) ef.negate();  // the side facing the camera
  const UP = new THREE.Vector3(0, 1, 0);
  const BT = 0.017;                                  // bark thickness at the plates
  const BED = 0.026;                                 // how far the log would sink
  const yC = R - BED;                                // axis height at the middle
  const THETA0 = -Math.PI / 2;                       // texture seam along the bottom
  const C0 = new THREE.Vector3(bn.x, yC, bn.z);
  const SEAT = { a: -0.6, b: 0.6, ramp: 0.08, depth: 0.048 };
  const LP = { L, R, BT, SEAT, THETA0, TW: o.barkTexture[0], TH: o.barkTexture[1], seed };
  const Rc = (s, th) => coreR(LP, s, th);
  const bowU = (s) => 0.012 * Math.sin(Math.PI * (s / L + 0.5));
  const bowF = (s) => -0.014 * Math.sin(Math.PI * (s / L + 0.5) * 1.2);
  const axisAt = (s, out) => out.copy(C0).addScaledVector(e1, s).addScaledVector(UP, bowU(s)).addScaledVector(ef, bowF(s));
  const seatCut = (s, xf) => seatCutP(LP, s, xf);
  // ground contact: whatever would go below Y_F is flared out at y >= 0 instead
  const Y_F = 0.02;
  const bed = (y) => (y >= Y_F ? y : Y_F * Math.exp((y - Y_F) / Y_F));

  // ------------------------------------------------------------ the guitar's frame (needed by the log's AO)
  const g = o.guitar;
  const Lb = GTR.Lb, Dt = GTR.Dt, S = GTR.scale;
  const dJoin = S * (1 - Math.pow(2, -GTR.join / 12));
  const yNut = Lb + dJoin, yHole = Lb - 0.135, ySad = yNut - S;
  const zBack = (y) => Dt - (0.104 - 0.016 * clamp(y / Lb, 0, 1));
  const arch = (v, y) => 0.0028 * (1 - v * v) * Math.pow(Math.max(0, Math.sin(Math.PI * clamp(y / Lb, 0, 1))), 0.8);
  const face = new THREE.Vector3(g.faceX, 0, g.faceZ).normalize();
  const yaw = Math.atan2(face.x, face.z);
  const gQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-g.lean, yaw, 0, 'YXZ'));
  const gPos = new THREE.Vector3(g.x, 0, g.z);
  const G = new THREE.Matrix4();
  const G2L = new THREE.Matrix4();
  const setG = () => { G.compose(gPos, gQ, new THREE.Vector3(1, 1, 1)); G2L.copy(G).invert(); };
  setG();

  // ------------------------------------------------------------ the guitar geometry (local frame)
  const ga = new Acc();
  const fbW = (y) => 0.043 + (0.0575 - 0.043) * clamp((yNut - y) / 0.4419, 0, 1.05);   // fretboard width
  const fbEnd = yNut - S * (1 - Math.pow(2, -20 / 12)) - 0.004;
  const zFb = Dt + 0.0015 + 0.006;                 // fretboard top
  const outline = [];                              // dense outline for edge distances
  for (let i = 0; i <= 400; i++) { const y = Lb * (1 - Math.cos(Math.PI * i / 400)) / 2; outline.push([bodyW(y), y]); }
  const edgeDist = (x, y) => {
    // only segments within 7 cm in y matter (the shader only uses distances below ~5 cm)
    let best = 0.07;
    const ax = Math.abs(x);
    let lo = 0, hi = outline.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (outline[m][1] < y - 0.07) lo = m; else hi = m; }
    for (let i = lo; i < outline.length - 1 && outline[i][1] < y + 0.07; i++) {
      const [x0, y0] = outline[i], [x1, y1] = outline[i + 1];
      const ex = x1 - x0, ey = y1 - y0, l2 = ex * ex + ey * ey || 1e-12;
      const t = clamp(((ax - x0) * ex + (y - y0) * ey) / l2, 0, 1);
      const d = Math.hypot(ax - x0 - ex * t, y - y0 - ey * t);
      if (d < best) best = d;
    }
    return best;
  };
  {
    const NY = 150, NV = 44;
    const ys = [], vs = [];
    for (let i = 0; i <= NY; i++) { const t = i / NY; ys.push(Lb * (0.55 * (1 - Math.cos(Math.PI * t)) / 2 + 0.45 * t)); }
    for (let j = 0; j <= NV; j++) { const uu = -1 + 2 * j / NV; vs.push(uu * (2 - Math.abs(uu))); }
    // top
    ga.add(gridGeo(NY, NV, (i, j, out) => { const y = ys[i], v = vs[j]; out.set(v * bodyW(y), y, Dt + arch(v, y) - 0.0004 * v * v * v * v); }), null,
      (lp, wp, wn, O) => { O.kind = 0; O.edge = edgeDist(lp.x, lp.y); });
    // back
    ga.add(gridGeo(NY, NV, (i, j, out) => { const y = ys[i], v = vs[j]; out.set(v * bodyW(y), y, zBack(y) - 1.4 * arch(v, y)); }, true), null,
      (lp, wp, wn, O) => { O.kind = 2; });
    // sides: around the outline (right half up, left half down), rows from the back to the top
    const loop = [];
    for (let i = 0; i <= NY; i++) loop.push([bodyW(ys[i]), ys[i]]);
    for (let i = NY - 1; i >= 0; i--) loop.push([-bodyW(ys[i]), ys[i]]);
    const zr = [0, 0.002, 0.5, 0.996, 1];
    ga.add(gridGeo(loop.length - 1, zr.length - 1, (i, j, out) => {
      const [x, y] = loop[i], zb = zBack(y), zt = Dt - 0.0004;
      out.set(x, y, zb + (zt - zb) * zr[j]);
    }, true), null, (lp, wp, wn, O) => { O.kind = 1; O.edge = Dt - lp.z; });
  }
  // neck shaft and heel (a loft of half ellipses under the fretboard)
  {
    const NA = 18, NYn = 40;
    const y0 = Lb - 0.012, y1 = yNut + 0.03;
    const zTop = Dt + 0.0015;
    ga.add(gridGeo(NA, NYn, (i, j, out) => {
      const y = y0 + (y1 - y0) * j / NYn;
      const phi = Math.PI * i / NA;
      const heel = Math.pow(smooth(Lb + 0.075, Lb - 0.004, y), 1.3);
      const dep = mix(0.020 + 0.003 * clamp((yNut - y) / 0.3, 0, 1), zTop - zBack(Lb) - 0.001, heel);
      let hw = fbW(Math.min(y, yNut)) / 2;
      // past the nut the neck turns into the headstock's volute
      const past = smooth(yNut - 0.002, yNut + 0.03, y);
      const zt = zTop - past * 0.006;
      hw *= 1 - 0.1 * past;
      const x = hw * Math.cos(phi) * (1 - 0.4 * heel * Math.sin(phi)) * (1 - 0.15 * Math.sin(phi) * (1 - heel));
      out.set(x, y, zt - (dep * (1 - 0.35 * past)) * Math.pow(Math.sin(phi), 0.9));
    }, true), null, (lp, wp, wn, O) => { O.kind = 3; });
  }
  // fretboard: a tapered slab
  {
    const len = yNut - fbEnd;
    const geo = new THREE.BoxGeometry(1, len, 0.006, 1, 8, 1);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) { const y = pa.getY(i) + fbEnd + len / 2; pa.setXYZ(i, pa.getX(i) * fbW(y), y, pa.getZ(i) + Dt + 0.0015 + 0.003); }
    geo.computeVertexNormals();
    ga.add(geo, null, (lp, wp, wn, O) => { O.kind = 4; });
    // frets
    for (let n = 1; n <= 20; n++) {
      const y = yNut - S * (1 - Math.pow(2, -n / 12));
      const fg = new THREE.CylinderGeometry(0.00115, 0.00115, fbW(y) - 0.0008, 6, 1, false);
      ga.add(fg, M(0, y, zFb, 0, 0, Math.PI / 2), (lp, wp, wn, O) => { O.kind = 5; });
    }
    // nut
    ga.add(new THREE.BoxGeometry(fbW(yNut), 0.005, 0.0055), M(0, yNut + 0.0025, zFb + 0.0003), (lp, wp, wn, O) => { O.kind = 7; });
  }
  // headstock, angled back 14 degrees from the nut, 3 + 3 tuners
  const HS_ANGLE = 0.245;
  const HS = M(0, yNut + 0.005, zFb - 0.0025, -HS_ANGLE, 0, 0);
  {
    const sh = new THREE.Shape();
    const pts = [[0.0265, 0], [0.033, 0.02], [0.042, 0.055], [0.0445, 0.12], [0.044, 0.168], [0.04, 0.186], [0.02, 0.192], [0, 0.194]];
    sh.moveTo(-pts[0][0], 0);
    for (const [x, y] of pts) sh.lineTo(x, y);
    for (let i = pts.length - 2; i >= 0; i--) sh.lineTo(-pts[i][0], pts[i][1]);
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.013, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 4 });
    geo.translate(0, 0, -0.013 - 0.0012);
    ga.add(geo, HS, (lp, wp, wn, O) => { O.kind = lp.z > -0.0006 ? 6 : 3; });
    for (let k = 0; k < 6; k++) {
      const side = k < 3 ? -1 : 1, t = 0.048 + 0.044 * (k % 3);
      const m = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().multiplyMatrices(HS, M(x, y, z, rx, ry, rz, sx, sy, sz));
      const met = (lp, wp, wn, O) => { O.kind = 5; };
      ga.add(new THREE.CylinderGeometry(0.0048, 0.0052, 0.002, 12), m(side * 0.03, t, 0.001, Math.PI / 2), met);       // bushing
      ga.add(new THREE.CylinderGeometry(0.0028, 0.0028, 0.013, 8), m(side * 0.03, t, 0.0065, Math.PI / 2), met);       // post
      ga.add(new THREE.BoxGeometry(0.02, 0.016, 0.0085), m(side * 0.033, t, -0.0142 - 0.0042), met);                  // gear housing
      ga.add(new THREE.CylinderGeometry(0.0016, 0.0016, 0.022, 6), m(side * 0.055, t, -0.0142 - 0.004, 0, 0, Math.PI / 2), met);   // shaft
      ga.add(new THREE.SphereGeometry(1, 12, 8), m(side * 0.07, t, -0.0142 - 0.004, 0, 0, 0, 0.0085, 0.0032, 0.0072), met);  // button
    }
  }
  // bridge (belly), saddle, pins, end pin
  const yBr = ySad - 0.0045;
  const zBr = Dt + 0.0026;
  {
    const sh = new THREE.Shape();
    const r = [[0, -0.0195], [0.028, -0.0178], [0.044, -0.0125], [0.06, -0.0108], [0.073, -0.0098], [0.0775, -0.004], [0.0775, 0.006], [0.073, 0.0105], [0.045, 0.0112], [0, 0.0118]];
    sh.moveTo(r[0][0], r[0][1]);
    for (const [x, y] of r) sh.lineTo(x, y);
    for (let i = r.length - 2; i >= 0; i--) sh.lineTo(-r[i][0], r[i][1]);
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.0062, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 1, curveSegments: 2 });
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i); pa.setZ(i, z * (1 - 0.5 * smooth(0.03, 0.078, Math.abs(x)))); }
    geo.computeVertexNormals();
    ga.add(geo, M(0, yBr, zBr - 0.0008), (lp, wp, wn, O) => { O.kind = 8; });
    ga.add(new THREE.BoxGeometry(0.073, 0.0028, 0.006), M(0, ySad, zBr + 0.0062 + 0.0004, 0, 0, 0.035), (lp, wp, wn, O) => { O.kind = 7; });
    for (let k = 0; k < 6; k++) {
      const x = -0.026 + k * 0.0104, y = yBr - 0.0085 - 0.0012 * Math.abs(k - 2.5) / 2.5;
      ga.add(new THREE.SphereGeometry(0.0029, 10, 6, 0, TAU, 0, Math.PI / 2), M(x, y, zBr + 0.0062, Math.PI / 2, 0, 0, 1, 0.8, 1), (lp, wp, wn, O) => { O.kind = 7; });
    }
    ga.add(new THREE.CylinderGeometry(0.003, 0.0035, 0.009, 10), M(0, -0.003, zBack(0) + 0.052, 0, 0, 0), (lp, wp, wn, O) => { O.kind = 7; });
  }

  // place: base on the ground at GUITAR, leaning back on the log. Lift so its lowest point is at
  // y = 0.0015, then slide it along its facing by the gap to the bark (a few mm, so the upper
  // bout really rests on the log rather than floating or sinking into it).
  const gGeoTmp = ga.P;
  const logLocal = (wx, wy, wz) => {
    // distance of a world point to the bark surface (positive outside), ignoring the seat
    const dx = wx - C0.x, dz = wz - C0.z;
    const s = dx * e1.x + dz * e1.z;
    if (Math.abs(s) > L / 2) return 1;
    axisAt(s, _v);
    const rx = wx - _v.x, ry = wy - _v.y, rz = wz - _v.z;
    const xf = rx * ef.x + rz * ef.z, yu = ry;
    const th = Math.atan2(yu, xf);
    return Math.hypot(xf, yu) - (Rc(s, th) + BT * 0.9);   // the plate tops
  };
  const gp = new THREE.Vector3();
  let fitShift = 0;
  {
    let minY = Infinity;
    for (let i = 0; i < gGeoTmp.length; i += 3) { gp.set(gGeoTmp[i], gGeoTmp[i + 1], gGeoTmp[i + 2]).applyMatrix4(G); if (gp.y < minY) minY = gp.y; }
    gPos.y = 0.0015 - minY; setG();
    const fh = new THREE.Vector3(face.x, 0, face.z);
    const gapAt = (shift) => {
      const M2 = new THREE.Matrix4().makeTranslation(-fh.x * shift, 0, -fh.z * shift).multiply(G);
      let best = Infinity;
      for (let i = 0; i < gGeoTmp.length; i += 3) {
        const k = ga.K[i / 3];
        if (k !== 1 && k !== 2) continue;
        gp.set(gGeoTmp[i], gGeoTmp[i + 1], gGeoTmp[i + 2]).applyMatrix4(M2);
        const d = logLocal(gp.x, gp.y, gp.z);
        if (d < best) best = d;
      }
      return best;
    };
    let gap = gapAt(0);
    for (let it = 0; it < 4 && Math.abs(gap - 0.0015) > 0.0005; it++) { fitShift += gap - 0.0015; fitShift = clamp(fitShift, -0.06, 0.06); gap = gapAt(fitShift); }
    gPos.addScaledVector(fh, -fitShift);
    // re-lift after the slide (the ground is flat, so the lowest point is unchanged)
    setG();
  }
  // guitar AO: the ground under it, the log behind it
  for (let i = 0, n = ga.P.length / 3; i < n; i++) {
    gp.set(ga.P[i * 3], ga.P[i * 3 + 1], ga.P[i * 3 + 2]).applyMatrix4(G);
    const dl = logLocal(gp.x, gp.y, gp.z);
    ga.A[i] = (0.45 + 0.55 * smooth(0.0, 0.14, gp.y)) * (1 - 0.45 * Math.exp(-Math.max(dl, 0) / 0.04));
  }
  const guitarGeo = ga.build();
  geometries.push(guitarGeo);

  const gf = guitarFrag();
  const gU = { ...common, uLgGain: { value: o.guitarGain } };
  const gMat = patchPhong(new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x111111, shininess: 40, fog: true }), gU, 'guitar', {
    pars: gf.pars, frag: gf.frag,
  });
  // the guitar's shader reads its local position
  const prevCompile = gMat.onBeforeCompile;
  gMat.onBeforeCompile = (sh, r) => {
    prevCompile(sh, r);
    sh.vertexShader = sh.vertexShader.replace('varying vec3 vLgW;', 'varying vec3 vLgW;\nvarying vec3 vLgP;').replace('vLgUv = aUv;', 'vLgUv = aUv; vLgP = position;');
  };
  materials.push(gMat);
  const gMesh = new THREE.Mesh(guitarGeo, gMat);
  gMesh.name = 'guitar';
  gMesh.matrixAutoUpdate = false;
  gMesh.matrix.copy(G);
  group.add(gMesh);

  // ------------------------------------------------------------ strings
  let strMesh = null, strMat = null;
  {
    const P = [], D = [], Sd = [], Dm = [], Ty = [], I = [];
    const diam = [0.00119, 0.00091, 0.00076, 0.00061, 0.00041, 0.0003];
    const zSad = zBr + 0.0062 + 0.0004 + 0.003;
    const seg = (a, b, k) => {
      const d = new THREE.Vector3().subVectors(b, a).normalize();
      const base = P.length / 3;
      for (const [pt, sd] of [[a, -1], [a, 1], [b, -1], [b, 1]]) {
        P.push(pt.x, pt.y, pt.z); D.push(d.x, d.y, d.z); Sd.push(sd); Dm.push(diam[k]); Ty.push(k < 4 ? 1 : 0);
      }
      I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    };
    for (let k = 0; k < 6; k++) {
      const xs = -0.026 + k * 0.0104;
      const ySk = ySad - 0.0013 * (1 - k / 5) + 0.0006 * (k === 1 ? 1 : 0);
      const pin = new THREE.Vector3(xs, yBr - 0.0085, zBr + 0.0062 + 0.0018).applyMatrix4(G);
      const sad = new THREE.Vector3(xs, ySk, zSad).applyMatrix4(G);
      const nut = new THREE.Vector3(-0.0178 + k * 0.00712, yNut + 0.0005, zFb + 0.0003 + 0.00275).applyMatrix4(G);
      const side = k < 3 ? -1 : 1, t = 0.048 + 0.044 * (k < 3 ? k : 5 - k);
      const post = new THREE.Vector3(side * 0.03 - side * 0.0029, t, 0.006).applyMatrix4(new THREE.Matrix4().multiplyMatrices(G, HS));
      seg(pin, sad, k); seg(sad, nut, k); seg(nut, post, k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('aDir', new THREE.Float32BufferAttribute(D, 3));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(Sd, 1));
    geo.setAttribute('aDiam', new THREE.Float32BufferAttribute(Dm, 1));
    geo.setAttribute('aType', new THREE.Float32BufferAttribute(Ty, 1));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 0.05;
    geometries.push(geo);
    strMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, {
        uPx: { value: 0.001 },
        uSteel: { value: new THREE.Color(0.05, 0.05, 0.05) },
        uBronze: { value: new THREE.Color(0.06, 0.035, 0.015) },
        uNight: { value: night.clone() },
        uHaze: { value: haze.clone() },
        uCenter: { value: center.clone() },
        uGlint: { value: 1 },
      }]),
      vertexShader: STR_VERT, fragmentShader: STR_FRAG,
      lights: true, fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    materials.push(strMat);
    strMesh = new THREE.Mesh(geo, strMat);
    strMesh.name = 'guitar-strings';
    strMesh.matrixAutoUpdate = false;
    strMesh.renderOrder = 2;
    group.add(strMesh);
  }

  // ------------------------------------------------------------ ground decal: contact AO + fire shadow
  let decal = null;
  {
    const NSd = 56, NQd = 30;
    const s0 = -L / 2 - 0.6, s1 = L / 2 + 0.6, q0 = -0.7, q1 = 1.05;
    const Lf = new THREE.Vector3(F.x, o.fireLightHeight, F.z);
    const A0 = axisAt(-L / 2, new THREE.Vector3()), A1 = axisAt(L / 2, new THREE.Vector3());
    const P = [], Cc = [], I = [];
    const pw = new THREE.Vector3(), dir = new THREE.Vector3(), pl = new THREE.Vector3(), ll = new THREE.Vector3();
    // min distance between segment P->Lf and the log axis segment
    const segSeg = (p0, p1, q0v, q1v) => {
      const d1 = new THREE.Vector3().subVectors(p1, p0), d2 = new THREE.Vector3().subVectors(q1v, q0v), r = new THREE.Vector3().subVectors(p0, q0v);
      const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2);
      const den = a * e - b * b;
      let s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      let t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      const c1 = p0.clone().addScaledVector(d1, s), c2 = q0v.clone().addScaledVector(d2, t);
      return [c1.distanceTo(c2), s];
    };
    for (let j = 0; j <= NQd; j++) for (let i = 0; i <= NSd; i++) {
      const s = mix(s0, s1, i / NSd), q = mix(q0, q1, j / NQd);
      pw.copy(C0).addScaledVector(e1, s).addScaledVector(ef, q); pw.y = 0.011;
      // contact AO around the log's footprint
      const sc = clamp(s, -L / 2, L / 2);
      const dAx = Math.hypot(s - sc, q - bowF(sc));
      let ao = 0.8 * Math.exp(-Math.max(0, dAx - 0.09) / 0.085);
      // the guitar: its foot, and the ground under its leaning body
      pl.copy(pw).applyMatrix4(G2L); ll.set(0, 1, 0).transformDirection(G2L);
      const tUp = (zBack(clamp(pl.y, 0, Lb)) - pl.z) / (ll.z || 1e-6);
      if (tUp > 0) {
        const qy = pl.y + ll.y * tUp, qx = pl.x + ll.x * tUp;
        const inside = smooth(-0.04, 0.03, bodyW(qy) - Math.abs(qx));
        ao = 1 - (1 - ao) * (1 - 0.6 * inside * Math.exp(-tUp / 0.22));
      }
      const foot = Math.hypot(pw.x - gPos.x, pw.z - gPos.z);
      ao = 1 - (1 - ao) * (1 - 0.55 * Math.exp(-foot / 0.07));
      // the fire's shadow: the log, then the guitar
      const [dd, sp] = segSeg(pw, Lf, A0, A1);
      const soft = 0.05 + 0.4 * sp;
      let sh = (1 - smooth(R - soft, R + soft, dd)) * smooth(0.0, 0.04, sp);
      dir.subVectors(Lf, pw);
      pl.copy(pw).applyMatrix4(G2L); ll.copy(Lf).applyMatrix4(G2L);
      const tz = (Dt * 0.55 - pl.z) / (ll.z - pl.z);
      if (tz > 0 && tz < 1) {
        const qy = mix(pl.y, ll.y, tz), qx = mix(pl.x, ll.x, tz);
        const dist = dir.length() * tz, sf = 0.01 + 0.3 * dist;
        const body = smooth(-sf, sf, bodyW(qy) - Math.abs(qx));
        const neck = smooth(-sf, sf, 0.03 - Math.abs(qx)) * smooth(Lb - 0.02, Lb, qy) * (1 - smooth(Lb + 0.54, Lb + 0.56, qy));
        sh = Math.max(sh, Math.max(body, neck) * 0.9);
      }
      // feather to nothing at the decal's border
      const border = smooth(0, 0.12, i / NSd) * smooth(0, 0.12, 1 - i / NSd) * smooth(0, 0.15, j / NQd) * smooth(0, 0.15, 1 - j / NQd);
      const a = clamp(1 - (1 - ao) * (1 - 0.7 * sh), 0, 0.88) * border;
      // tint: what is left of the ground is the haze in front of it
      const Dd = Math.hypot(pw.x - center.x, pw.z - center.y);
      const hz = 0.62 * (1 - Math.exp(-Math.max(Dd - 6, 0) / 30));
      P.push(pw.x, pw.y, pw.z);
      Cc.push(haze.r * hz, haze.g * hz, haze.b * hz, a);
    }
    for (let j = 0; j < NQd; j++) for (let i = 0; i < NSd; i++) {
      const a = j * (NSd + 1) + i, b = a + 1, c = a + NSd + 1, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 4));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    geometries.push(geo);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true });
    // the decal sits on a surface that faces up: make sure no winding issue hides it
    mat.side = THREE.FrontSide;
    materials.push(mat);
    decal = new THREE.Mesh(geo, mat);
    decal.name = 'log-contact';
    decal.renderOrder = -1;
    decal.matrixAutoUpdate = false;
    group.add(decal);
  }

  let logMesh = null, logU = null, worker = null, disposed = false, nightK = 1;
  // ------------------------------------------------------------ the log (once the bark is baked)
  function finishLog({ tex, hgt }) {
    if (disposed) return;
    const tf = performance.now();
    const TW = LP.TW, TH = LP.TH;
    const barkTex = new THREE.DataTexture(tex, TW, TH, THREE.RGBAFormat);
    barkTex.colorSpace = THREE.SRGBColorSpace;
    barkTex.wrapS = THREE.ClampToEdgeWrapping; barkTex.wrapT = THREE.RepeatWrapping;
    barkTex.magFilter = THREE.LinearFilter; barkTex.minFilter = THREE.LinearMipmapLinearFilter;
    barkTex.generateMipmaps = true;
    barkTex.anisotropy = Math.min(8, ctx.renderer && ctx.renderer.capabilities ? ctx.renderer.capabilities.getMaxAnisotropy() : 1);
    barkTex.needsUpdate = true;
    textures.push(barkTex);
    const sampleH = (u, v) => {
      const x = clamp(u * TW - 0.5, 0, TW - 1.001), y = v * TH - 0.5;
      const i = Math.floor(x), fx = x - i, jy = Math.floor(y), fy = y - jy;
      const j0 = ((jy % TH) + TH) % TH, j1 = (j0 + 1) % TH, i1 = Math.min(i + 1, TW - 1);
      const a = hgt[j0 * TW + i], b = hgt[j0 * TW + i1], c = hgt[j1 * TW + i], d = hgt[j1 * TW + i1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };

    // ------------------------------------------------------------ the log geometry (world)
    const la = new Acc();
    const NS = 128, NT = 136;
    const endRing = [[], []];                       // final positions of the end rings (for the caps)
    const gl2 = new THREE.Vector3();
    const aoAt = (wx, wy, wz) => {
      // contact AO: the ground, and the guitar leaning on it
      let ao = 0.4 + 0.6 * smooth(0.0, 0.16, wy);
      gl2.set(wx, wy, wz).applyMatrix4(G2L);
      const inside = smooth(-0.01, 0.02, bodyW(gl2.y) - Math.abs(gl2.x));
      const dz = Math.max(0, zBack(gl2.y) - gl2.z);
      ao *= 1 - 0.55 * inside * Math.exp(-dz / 0.05);
      return ao;
    };
    {
      const A = new THREE.Vector3();
      const geo = gridGeo(NS, NT, (i, j, out) => {
        const s = -L / 2 + L * i / NS, u = i / NS, v = j / NT;
        const th = THETA0 + TAU * v;
        const r = Rc(s, th) + sampleH(u, v);
        let xf = r * Math.cos(th), yu = r * Math.sin(th);
        const cut = seatCut(s, xf);
        if (yu > cut) yu = cut;
        axisAt(s, A);
        out.copy(A).addScaledVector(ef, xf).addScaledVector(UP, yu);
        // bedding: flare out instead of sinking
        if (out.y < Y_F) { const k = (Y_F - out.y); out.y = bed(out.y); out.addScaledVector(ef, Math.sign(xf) * k * 0.35); }
        if (i === 0 || i === NS) endRing[i === 0 ? 0 : 1][j] = out.clone();
      }, true);
      la.add(geo, null, (lp, wp, wn, O, idx) => {
        const i = idx % (NS + 1), j = Math.floor(idx / (NS + 1));
        O.u = i / NS; O.v = j / NT; O.kind = 0; O.ao = aoAt(wp.x, wp.y, wp.z);
      });
    }
    // sawn ends: polar rings from the pith to the bark, a crisp ring at the wood/bark boundary
    for (let end = 0; end < 2; end++) {
      const s = end ? L / 2 : -L / 2, sign = end ? 1 : -1;
      const A = axisAt(s, new THREE.Vector3());
      const fr = [0, 0.05, 0.12, 0.22, 0.34, 0.46, 0.57, 0.66, 0.75, 0.83, 0.9, 0.95];
      const pos = [], loc = [], edge = [];
      for (let j = 0; j <= NT; j++) {
        const th = THETA0 + TAU * j / NT;
        const P = endRing[end][j];
        const ro = Math.hypot(P.x - A.x, P.y - A.y, P.z - A.z);
        const rw = Rc(s, th);
        const ts = fr.map((f) => f * rw / ro).concat([(rw - 0.0006) / ro, rw / ro, 1]);
        for (let k = 0; k < ts.length; k++) {
          const t = Math.min(ts[k], 1);
          const X = new THREE.Vector3().lerpVectors(A, P, t);
          if (k < ts.length - 1) X.y = bed(X.y);
          const dx = X.x - A.x, dz = X.z - A.z;
          pos.push(X);
          loc.push([dx * ef.x + dz * ef.z, X.y - A.y]);
          edge.push(t * ro / rw);
        }
      }
      const nr = fr.length + 3;
      const geo = gridGeo(nr - 1, NT, (i, j, out) => out.copy(pos[j * nr + i]), end === 0);
      la.add(geo, null, (lp, wp, wn, O, idx) => {
        O.kind = 1; O.lx = loc[idx][0]; O.ly = loc[idx][1]; O.lz = sign; O.edge = edge[idx]; O.ao = aoAt(wp.x, wp.y, wp.z);
      });
    }
    // a broken branch stub on the upper back, pointing up and toward the crown
    {
      const sSt = -0.2, thSt = 2.35;
      const A = axisAt(sSt, new THREE.Vector3());
      const radial = new THREE.Vector3().addScaledVector(ef, Math.cos(thSt)).addScaledVector(UP, Math.sin(thSt));
      const r0 = Rc(sSt, thSt) + BT * 0.6;
      const base = A.clone().addScaledVector(radial, r0 - 0.035);
      const dir = radial.clone().multiplyScalar(Math.cos(0.55)).addScaledVector(e1, Math.sin(0.55)).normalize();
      const b1 = new THREE.Vector3().crossVectors(dir, e1).normalize(), b2 = new THREE.Vector3().crossVectors(dir, b1);
      const NAr = 14, NL = 9, len = 0.17;
      const tipAt = (phi) => len + 0.012 * Math.sin(phi * 3 + 1) + 0.035 * Math.pow(Math.max(0, Math.cos(phi - 0.8)), 4) - 0.01 * Math.pow(Math.max(0, Math.cos(phi + 2.2)), 2);
      const geo = gridGeo(NAr, NL, (i, j, out) => {
        const phi = TAU * i / NAr, f = j / NL;
        const tt = -0.0 + (tipAt(phi) + 0.035) * f;
        const t = tt - 0.035;
        const rad = (0.021 - 0.004 * clamp(t / len, 0, 1)) + 0.016 * Math.exp(-Math.max(t, 0) / 0.022) + 0.012 * smooth(0.0, -0.035, t);
        const wob = 1 + 0.06 * Math.sin(phi * 2 + t * 30);
        out.copy(base).addScaledVector(dir, tt).addScaledVector(b1, Math.cos(phi) * rad * wob).addScaledVector(b2, Math.sin(phi) * rad * wob);
      }, true);
      la.add(geo, null, (lp, wp, wn, O, idx) => {
        const i = idx % (NAr + 1), j = Math.floor(idx / (NAr + 1));
        const phi = TAU * i / NAr;
        O.kind = j >= NL - 1 ? 2 : 3; O.lx = (tipAt(phi) + 0.035) * j / NL - 0.035; O.ly = phi; O.ao = aoAt(wp.x, wp.y, wp.z) * (j === 0 ? 0.5 : 1);
      });
      // the torn end: a jagged fan, raw wood
      const tip = gridGeo(NAr, 1, (i, j, out) => {
        const phi = TAU * i / NAr;
        const rad = j ? 0 : (0.021 - 0.004) * 0.98;
        const tt = (j ? len - 0.008 : tipAt(phi)) + 0.0;
        out.copy(base).addScaledVector(dir, tt + 0.035 - 0.035).addScaledVector(b1, Math.cos(phi) * rad).addScaledVector(b2, Math.sin(phi) * rad);
      }, true);
      la.add(tip, null, (lp, wp, wn, O) => { O.kind = 2; O.lx = lp.x; O.ly = lp.y; O.lz = lp.z; });
    }
    // a folded wool blanket on the seat at the fire end: a soft rounded slab that follows the seat
    if (o.blanket) {
      const A = 0.34, Hh = 0.042, Dd = 0.235, rr = 0.016, sB = -0.4, xB = 0.004, yawB = 0.07;
      const box = new THREE.BoxGeometry(1, 1, 1, 26, 6, 18);
      const pa = box.attributes.position;
      const q = new THREE.Vector3(), inner = new THREE.Vector3(), X = new THREE.Vector3();
      const half = new THREE.Vector3(A / 2, Hh / 2, Dd / 2);
      const loc = [];
      for (let i = 0; i < pa.count; i++) {
        q.set(pa.getX(i) * A, pa.getY(i) * Hh, pa.getZ(i) * Dd);
        inner.set(clamp(q.x, -half.x + rr, half.x - rr), clamp(q.y, -half.y + rr, half.y - rr), clamp(q.z, -half.z + rr, half.z - rr));
        const d = q.distanceTo(inner);
        if (d > 1e-6) q.sub(inner).multiplyScalar(rr / d).add(inner);
        loc.push([q.x, q.y, q.z]);
        // soft wool: a few slow folds on top, the fold edge (front) rounder and a little fuller
        const top = smooth(-0.2, 1, q.y / half.y);
        q.y += top * (0.003 * Math.sin(q.x * 37 + 1.3) * Math.sin(q.z * 23) + 0.0025 * Math.sin(q.x * 13 - q.z * 9));
        const cx = Math.cos(yawB), sx = Math.sin(yawB);
        const s = sB + q.x * cx - q.z * sx, xf = xB + q.x * sx + q.z * cx;
        const droop = Math.max(0, Math.abs(xf) - 0.1) * 0.9;
        axisAt(s, X).addScaledVector(ef, xf).addScaledVector(UP, seatCut(s, xf) + half.y + q.y + 0.0012 - droop);
        pa.setXYZ(i, X.x, X.y, X.z);
      }
      box.computeVertexNormals();
      la.add(box, null, (lp, wp, wn, O, idx) => {
        O.kind = 4; [O.lx, O.ly, O.lz] = loc[idx]; O.ao = aoAt(wp.x, wp.y, wp.z) * (0.55 + 0.45 * smooth(-Hh / 2, Hh / 2, loc[idx][1]));
      });
    }
    // an enamel mug, standing on the seat between the blanket and the guitar
    if (o.mug) {
      const sM = -0.12, xM = -0.035;
      const prof = [[0, 0], [0.034, 0], [0.037, 0.0025], [0.0385, 0.012], [0.0402, 0.076], [0.0418, 0.0792], [0.0412, 0.0822], [0.0392, 0.0812], [0.0378, 0.076], [0.0364, 0.0065], [0, 0.0065]]
        .map(([x, y]) => new THREE.Vector2(x, y));
      const base = axisAt(sM, new THREE.Vector3()).addScaledVector(ef, xM).addScaledVector(UP, seatCut(sM, xM) - 0.0008);
      const yawM = Math.atan2(e1.x, e1.z) + 2.3;
      const mm = new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(UP, yawM), new THREE.Vector3(1, 1, 1));
      la.add(new THREE.LatheGeometry(prof, 28), mm, (lp, wp, wn, O, idx) => {
        const r = Math.hypot(lp.x, lp.z);
        const insideWall = idx % prof.length >= 8;            // lathe points 8..10: the inside
        O.kind = insideWall ? 6 : 5; O.lx = Math.atan2(lp.z, lp.x); O.ly = lp.y; O.lz = r; O.ao = aoAt(wp.x, wp.y, wp.z) * (insideWall ? 0.5 : 1);
      });
      const hg = new THREE.TorusGeometry(0.023, 0.0042, 8, 16, Math.PI);
      la.add(hg, new THREE.Matrix4().multiplyMatrices(mm, M(0.039, 0.043, 0, 0, 0, -Math.PI / 2, 1, 1, 0.9)), (lp, wp, wn, O) => {
        O.kind = 5; O.lx = 0; O.ly = 0.04 + lp.y * 0.0; O.lz = 0.05; O.ao = aoAt(wp.x, wp.y, wp.z);
      });
    }
    const logGeo = la.build();
    geometries.push(logGeo);

    // ------------------------------------------------------------ materials and meshes
    logU = { ...common, uLgBark: { value: barkTex }, uLgG2L: { value: G2L }, uLgGain: { value: 1 } };
    const logMat = patchPhong(new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x0a0a0a, shininess: 10, fog: true }), logU, 'bench', {
      pars: LOG_FRAG_PARS, frag: LOG_FRAG, lightOcclusion: true,
    });
    materials.push(logMat);
    logMesh = new THREE.Mesh(logGeo, logMat);
    logMesh.name = 'log-bench';
    logMesh.matrixAutoUpdate = false;
    group.add(logMesh);


    if (nightK !== 1) logU.uLgNight.value.copy(night).multiplyScalar(nightK);
    T.logMs = performance.now() - tf;
    group.visible = true;               // the guitar and the decal wait for the log, so they appear together
  }
  T.main = performance.now() - t0;
  if (typeof Worker !== 'undefined' && !o.sync) {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      const tw = performance.now();
      worker.onmessage = (e) => { T.workerMs = performance.now() - tw; worker.terminate(); worker = null; finishLog(e.data); };
      worker.onerror = (e) => { e.preventDefault(); if (worker) worker.terminate(); worker = null; finishLog(bakeBark(LP)); };
      worker.postMessage(LP);
    } catch (e) { worker = null; finishLog(bakeBark(LP)); }
  } else finishLog(bakeBark(LP));

  // ------------------------------------------------------------ handle
  const dbs = new THREE.Vector2();
  function resize() {
    if (!ctx.renderer) return;
    ctx.renderer.getDrawingBufferSize(dbs);
    const p11 = ctx.camera.projectionMatrix.elements[5] || 2.75;
    strMat.uniforms.uPx.value = 2 / (p11 * Math.max(1, dbs.y));
  }
  resize();
  let fireLight = null, seek = 0;
  function update() {
    // the strings' pixel size follows the camera's projection; the ground bounce follows the fire's flicker
    const p11 = ctx.camera.projectionMatrix.elements[5];
    if (p11 && dbs.y) strMat.uniforms.uPx.value = 2 / (p11 * dbs.y);
    if (!fireLight && --seek <= 0) { seek = 60; fireLight = ctx.scene.getObjectByName('fire-light') || null; }
    if (fireLight) {
      common.uLgBounce.value.copy(fireLight.color).multiplyScalar(fireLight.intensity * BOUNCE);
      fireLight.getWorldPosition(common.uLgFire.value); common.uLgFire.value.y = 0.3;
      if (!fireLight.parent) fireLight = null;
    }
  }
  function setTimeOfDay(tod) {
    // a little more sky light on the unlit faces at dusk and dawn
    if (!tod) return;
    const k = 1 + 0.6 * (+tod.dusk || 0) + 0.4 * (+tod.dawn || 0);
    nightK = k;
    if (logU) logU.uLgNight.value.copy(night).multiplyScalar(k);
    gU.uLgNight.value.copy(night).multiplyScalar(k);
    strMat.uniforms.uNight.value.copy(night).multiplyScalar(k);
  }
  function dispose() {
    disposed = true;
    if (worker) { worker.terminate(); worker = null; }
    ctx.scene.remove(group);
    for (const x of geometries) x.dispose();
    for (const x of materials) x.dispose();
    for (const x of textures) x.dispose();
  }
  const buildMs = performance.now() - t0;
  return {
    group, update, resize, dispose, setTimeOfDay,
    layout: { bench: { ...bn }, guitar: { x: gPos.x, y: gPos.y, z: gPos.z, lean: g.lean, slide: fitShift }, buildMs,
      points: {   // world positions of the details, for the dev bench's close-ups
        hole: new THREE.Vector3(0, yHole, Dt).applyMatrix4(G).toArray(),
        bridge: new THREE.Vector3(0, ySad, Dt).applyMatrix4(G).toArray(),
        head: new THREE.Vector3(0, 0.1, 0).applyMatrix4(new THREE.Matrix4().multiplyMatrices(G, HS)).toArray(),
        endB: axisAt(L / 2, new THREE.Vector3()).toArray(),
        endA: axisAt(-L / 2, new THREE.Vector3()).toArray(),
        seat: axisAt(0, new THREE.Vector3()).addScaledVector(UP, R - 0.05).toArray(),
        face: [face.x, face.z], axis: [e1.x, e1.z],
      }, T, get ready() { return !!logMesh; } },
  };
}
