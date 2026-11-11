/*
  Iskry · dev/perf.js — the whole-scene profiler behind dev/perf.html. OWNER: perf agent.

  WHAT IT DOES
    Builds the stage the core builds (js/scene.js buildStage / measure / moduleCtx / moduleTable /
    loadModules), loads every environment module with the same factory and options, one after
    another (so each module's compile cost is its own), and reports per module:
      import, create     ms: the dynamic import and the factory call (CPU; includes any bake it does)
      first render       ms: the first render of the module alone, forced to finish (shader compile,
                         program link, geometry and texture upload), and the programs it added
      update             ms: CPU time of handle.update(t, dt), mean and worst of 240 calls
      submit             ms: CPU time of renderer.render() with only this module visible
      GPU alone          ms: GPU time of the module alone (see METHOD)
      GPU marginal       ms: GPU time of the full set minus the full set without this module, in
                         alternating rounds (median of the paired differences). Overdraw and
                         early-z interact, so this, not "alone", is what removing it would save
      calls, tris        renderer.info.render with only this module visible
      tex / geo MB       texture storage allocated at load (from the GL calls) and vertex data
      uploads/frame      buffer and texture uploads per frame while it animates (calls, bytes)
    and for the whole scene: GPU total, CPU total, the pixel-ratio sweep (2 / 1.5 / 1.25 / 1, the
    quality governor's steps), the cost of a time-of-day tick (setTimeOfDay + applyFog: CPU ms,
    programs relinked, bytes uploaded), the cost of lights arriving late (programs relinked when
    fire.js loads after the lit modules), and a dispose check against renderer.info.

  METHOD
    GPU time uses EXT_disjoint_timer_query_webgl2: `reps` renders inside ONE TIME_ELAPSED query
    (a single frame is too short to time), minus the same number of renders of the empty scene,
    `rounds` times; the minimum is reported (other tabs share the GPU and only ever add time) with
    the median beside it. Without the extension it falls back to wall time to a forced finish
    (a 1 px readPixels). Lights stay on while a module is measured alone: only meshes are hidden,
    so the lit materials keep the programs they have in the real scene.

  NOT MEASURED HERE
    The CSS3D words, the MSAA resolve and the compositor: tools/perf/run.mjs measures whole frames
    on the real page.

  KEEP IN STEP WITH js/scene.js: CORE and moduleTable() below mirror TUNE and moduleTable() there.
  checkCore() fetches scene.js and warns when its module list or these constants have moved on.
*/
import * as THREE from 'three';
import { CAMERA, FIRE } from '../js/scene/layout.js';

const q = new URLSearchParams(location.search);
const num = (name, fallback) => { const v = parseFloat(q.get(name)); return Number.isFinite(v) ? v : fallback; };
const list = (name) => (q.get(name) || '').split(',').map((s) => s.trim()).filter(Boolean);

// Mirrors TUNE in js/scene.js (the parts the modules see).
const CORE = {
  cameraLook: [0, 4.1, -10],
  fireScale: 1.3,
  treeSeed: 7,
  moonSpot: [17, 22],
  stringExtents: { xMin: -22, xMax: 22, yMin: 1.5, yMax: 10, zMin: -14, zMax: 2 },
  fogNear: 14,
  fogFar: 70,
  maxPixelRatio: 2,
  sky: { horizonY: 0, radius: 90 },
  place: { latitudeDeg: 52.1, longitudeDeg: 19.4 }
};
const ORDER = ['sky', 'stars', 'moon', 'trees', 'ground', 'road', 'grass', 'fence', 'log', 'foreground', 'strings', 'fire'];

const P = {
  reps: Math.max(1, Math.round(num('reps', 30))),
  rounds: Math.max(1, Math.round(num('rounds', 5))),
  dpr: num('dpr', Math.min(window.devicePixelRatio || 1, CORE.maxPixelRatio)),
  aa: q.get('aa') !== '0',
  marginal: q.get('marginal') !== '0',
  fill: q.get('fill') !== '0',
  live: q.get('live') !== '0',
  auto: q.get('auto') === '1',
  quick: q.get('quick') === '1',
  reducedMotion: q.get('rm') === '1',
  only: list('only'), skip: list('skip')
};
let W = window.innerWidth, H = window.innerHeight;
{
  const m = /^(\d+)x(\d+)$/.exec(q.get('size') || '');
  if (m) { W = +m[1]; H = +m[2]; }
}

const perf = (window.__perf = {
  done: false, error: null, phase: 'starting',
  params: { ...P, width: W, height: H }, env: {}, warnings: [],
  modules: {}, total: null, sweep: null, tick: null, lateLights: null, dispose: null
});
const statusEl = document.getElementById('status'), outEl = document.getElementById('out');
const status = (s) => { perf.phase = s; statusEl.textContent = s; };
const now = () => performance.now();
const nextTask = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const r2 = (v) => Math.round(v * 100) / 100;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : 0; };

/* ---------- stage (mirrors buildStage and measure in js/scene.js) ---------- */

function readToken(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (/^-?[\d.]+(e-?\d+)?[a-z%]*$/i.test(raw)) {
    const n = parseFloat(raw);
    if (isFinite(n)) return n;
  }
  return raw;
}
const tokenNum = (name, fallback) => { const v = readToken(name, fallback); return typeof v === 'number' ? v : fallback; };

let scene, camera, renderer, gl, timerExt = null, focal = 1;
const modules = {};          // name -> handle
const records = {};          // name -> { handle, roots, renderables }
const glc = {};              // GL call counters: name -> { calls, bytes }
const pixel = new Uint8Array(4);

// Bytes per pixel of the internal formats the modules use (others count as 4).
const BPP = { 0x8229: 1, 0x822B: 2, 0x8051: 3, 0x8058: 4, 0x8C43: 4, 0x8C41: 3, 0x881A: 8, 0x8814: 16, 0x822D: 2, 0x822E: 4, 0x822F: 4, 0x8230: 8, 0x81A5: 2, 0x81A6: 4, 0x88F0: 4, 0x8CAC: 4 };
const bpp = (fmt) => BPP[fmt] || 4;

function instrument(ctx) {
  const size = (a) => (a && a.byteLength) || 0;
  const mips = (levels) => (levels > 1 ? 4 / 3 : 1);
  const wrap = (name, bytes) => {
    const f = ctx[name];
    if (typeof f !== 'function') return;
    const c = (glc[name] = { calls: 0, bytes: 0 });
    ctx[name] = function () { c.calls++; if (bytes) c.bytes += bytes(arguments) || 0; return f.apply(ctx, arguments); };
  };
  wrap('compileShader'); wrap('linkProgram'); wrap('generateMipmap');
  wrap('texStorage2D', (a) => a[3] * a[4] * bpp(a[2]) * mips(a[1]));
  wrap('texStorage3D', (a) => a[3] * a[4] * a[5] * bpp(a[2]) * mips(a[1]));
  wrap('texImage2D', (a) => (a.length >= 9 ? a[3] * a[4] * bpp(a[2]) : 0));
  wrap('texImage3D', (a) => a[3] * a[4] * a[5] * bpp(a[2]));
  wrap('renderbufferStorage', (a) => a[2] * a[3] * bpp(a[1]));
  wrap('renderbufferStorageMultisample', (a) => a[0] * 0 + a[3] * a[4] * bpp(a[2]) * Math.max(1, a[1]));
  wrap('texSubImage2D', (a) => (a.length >= 9 ? size(a[8]) || a[4] * a[5] * 4 : 0));
  wrap('texSubImage3D', (a) => size(a[10]) || a[5] * a[6] * a[7] * 4);
  wrap('bufferData', (a) => (typeof a[1] === 'number' ? a[1] : size(a[1])));
  wrap('bufferSubData', (a) => size(a[2]));
}
const counters = () => { const o = {}; for (const k in glc) o[k] = { calls: glc[k].calls, bytes: glc[k].bytes }; return o; };
function since(c0) {
  const o = {};
  for (const k in glc) {
    const calls = glc[k].calls - c0[k].calls, bytes = glc[k].bytes - c0[k].bytes;
    if (calls) o[k] = { calls, bytes };
  }
  return o;
}
const sumBytes = (d, keys) => keys.reduce((n, k) => n + (d[k] ? d[k].bytes : 0), 0);
const sumCalls = (d, keys) => keys.reduce((n, k) => n + (d[k] ? d[k].calls : 0), 0);
const STORAGE = ['texStorage2D', 'texStorage3D', 'texImage2D', 'texImage3D', 'renderbufferStorage', 'renderbufferStorageMultisample'];
const UPLOADS = ['texSubImage2D', 'texSubImage3D', 'texImage2D', 'texImage3D', 'bufferData', 'bufferSubData'];

function buildStage() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(String(readToken('--fog', '#2b1a10'))), CORE.fogNear, CORE.fogFar);

  const fov = Math.min(100, Math.max(10, tokenNum('--camera-fov', 40)));
  camera = new THREE.PerspectiveCamera(fov, W / H, 0.1, 450);
  camera.position.set(CAMERA.x, CAMERA.y, CAMERA.z);
  camera.lookAt(CORE.cameraLook[0], CORE.cameraLook[1], CORE.cameraLook[2]);
  camera.updateProjectionMatrix();
  focal = (H / 2) / Math.tan((fov * Math.PI / 180) / 2);

  // Same context attributes as the core's renderer; the context is created here only so that
  // its calls can be counted.
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl2', {
    alpha: true, depth: true, stencil: false, antialias: P.aa, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false
  });
  if (!gl) throw new Error('WebGL2 is unavailable');
  instrument(gl);
  renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: P.aa, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(P.dpr);
  renderer.setSize(W, H, false);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  document.getElementById('scene-world').appendChild(canvas);
  timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  perf.env = {
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    timerQuery: !!timerExt, parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
    samples: gl.getParameter(gl.SAMPLES), drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    devicePixelRatio: window.devicePixelRatio, window: [window.innerWidth, window.innerHeight],
    three: THREE.REVISION, userAgent: navigator.userAgent
  };
}

const moduleCtx = () => ({ scene, camera, renderer, reducedMotion: P.reducedMotion, readToken });

// Mirrors moduleTable() in js/scene.js, plus the sky's row from loadModules().
function moduleTable() {
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const firePos = [FIRE.x, FIRE.y, FIRE.z];
  const wind = (tokenNum('--wind-speed', 44) * Math.max(1, tokenNum('--depth-near', 10))) / focal;   // mean wind, m/s
  const date = new Date();
  return {
    sky: ['createSky', () => ({ ...CORE.sky })],
    stars: ['createStars', () => ({ date, latitudeDeg: CORE.place.latitudeDeg, longitudeDeg: CORE.place.longitudeDeg })],
    moon: ['createMoon', () => ({
      date, latitudeDeg: CORE.place.latitudeDeg, longitudeDeg: CORE.place.longitudeDeg,
      facingAzDeg: modules.stars && Number.isFinite(modules.stars.facingAzDeg) ? modules.stars.facingAzDeg : 120,
      azimuthDeg: CORE.moonSpot[0], altitudeDeg: CORE.moonSpot[1]
    })],
    trees: ['createTrees', () => ({ firePosition: v(firePos), wind, seed: CORE.treeSeed })],
    ground: ['createGround', () => ({ firePosition: v(firePos), wind })],
    road: ['createRoad', () => ({ firePosition: v(firePos), wind })],
    grass: ['createGrass', () => ({ firePosition: v(firePos), wind })],
    fence: ['createFence', () => ({ firePosition: v(firePos), wind })],
    log: ['createLog', () => ({ firePosition: v(firePos), wind })],
    foreground: ['createForeground', () => ({ firePosition: v(firePos), wind })],
    strings: ['createStrings', () => ({
      count: Math.max(1, Math.round(Number(readToken('--strings-count', 6)) || 6)),
      extents: Object.assign({}, CORE.stringExtents),
      firePosition: v([firePos[0], firePos[1] + 0.7, firePos[2]])
    })],
    fire: ['createFire', () => ({ position: v(firePos), scale: CORE.fireScale, wind })]
  };
}

// The time of day, as the core computes it (TIME_KEYS and timeOfDay() in js/scene.js).
const TIME_KEYS = [
  [0, 0, 1, 0], [3.5, 0, 1, 0], [5.5, 0, 0.3, 0.7], [7, 0, 0.2, 0.8],
  [9, 0.3, 0.7, 0], [16, 0.3, 0.7, 0], [17.5, 0.8, 0.2, 0], [20, 0, 1, 0], [24, 0, 1, 0]
];
const tod = { hour: 0, dusk: 0, night: 1, dawn: 0 };
function timeOfDay(hour) {
  let h = hour;
  if (h == null) h = Number.isFinite(parseFloat(q.get('hour'))) ? ((parseFloat(q.get('hour')) % 24) + 24) % 24 : null;
  if (h == null) { const d = new Date(); h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
  let i = 0;
  while (i < TIME_KEYS.length - 2 && h >= TIME_KEYS[i + 1][0]) i++;
  const a = TIME_KEYS[i], b = TIME_KEYS[i + 1];
  let t = Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0])));
  t = t * t * (3 - 2 * t);
  tod.hour = h;
  tod.dusk = a[1] + (b[1] - a[1]) * t;
  tod.night = a[2] + (b[2] - a[2]) * t;
  tod.dawn = a[3] + (b[3] - a[3]) * t;
  return tod;
}
function applyFog(sky) {
  if (!sky || !sky.fogColor || !sky.fogColor.isColor) return;
  scene.fog.color.copy(sky.fogColor);
  if (sky.fogNear > 0) scene.fog.near = sky.fogNear;
  if (sky.fogFar > scene.fog.near) scene.fog.far = sky.fogFar;
}
function linkMoon() {
  const sky = modules.sky, moon = modules.moon;
  if (!sky || !moon || !sky.setMoon || !moon.direction) return;
  try { sky.setMoon(moon.direction, Number(moon.illumination) || 0); } catch (e) { /* optional */ }
}

// Warns when js/scene.js has moved on from what this file mirrors.
async function checkCore() {
  try {
    const src = await (await fetch('../js/scene.js', { cache: 'no-store' })).text();
    const names = new Set(['sky']);
    for (const m of src.matchAll(/\["(\w+)", "create\w+"/g)) names.add(m[1]);
    for (const n of names) if (!ORDER.includes(n)) perf.warnings.push(`js/scene.js loads "${n}", which this profiler does not know: add it to ORDER and moduleTable() in dev/perf.js`);
    for (const n of ORDER) if (!names.has(n)) perf.warnings.push(`this profiler loads "${n}", which js/scene.js no longer does`);
    const want = [
      'cameraLook: [0, 4.1, -10]', 'fireScale: 1.3', 'treeSeed: 7', 'moonSpot: [17, 22]',
      'stringExtents: { xMin: -22, xMax: 22, yMin: 1.5, yMax: 10, zMin: -14, zMax: 2 }', 'maxPixelRatio: 2',
      '{ horizonY: 0, radius: 90 }', 'antialias: true, alpha: true, powerPreference: "high-performance"'
    ];
    for (const w of want) if (!src.includes(w)) perf.warnings.push(`js/scene.js no longer contains "${w}": update CORE in dev/perf.js`);
  } catch (e) {
    perf.warnings.push('could not read js/scene.js to check the mirrored constants: ' + e.message);
  }
}

/* ---------- visibility sets ---------- */

// Shows only the meshes of the named modules. Lights are never hidden (see METHOD).
// Returns a function that puts every flag back.
function showOnly(names) {
  const keep = new Set(names), saved = [];
  for (const name in records) {
    if (keep.has(name)) continue;
    for (const o of records[name].renderables) { saved.push(o, o.visible); o.visible = false; }
  }
  return () => { for (let i = 0; i < saved.length; i += 2) saved[i].visible = saved[i + 1]; };
}

// Blocks until the GPU has done everything submitted so far: a readPixels of a 1 px framebuffer.
// (Reading the canvas itself would add a multisample resolve of the whole drawing buffer, ~50 ms.)
let syncFbo = null;
function finish() {
  if (!syncFbo) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    syncFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, syncFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    renderer.resetState();
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, syncFbo);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // what three has bound while it draws to the canvas
}

async function queryResult(query) {
  for (let i = 0; i < 400; i++) {
    await nextTask(i < 10 ? 2 : 8);
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
      gl.deleteQuery(query);
      return disjoint ? null : ns / 1e6;
    }
  }
  gl.deleteQuery(query);
  return null;
}

// One round: `reps` renders of whatever is visible. -> { gpu, wall, submit } in ms per render.
async function timeRound(reps) {
  let query = null;
  if (timerExt) { gl.getParameter(timerExt.GPU_DISJOINT_EXT); query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); }
  const t0 = now();
  for (let i = 0; i < reps; i++) renderer.render(scene, camera);
  const t1 = now();
  if (query) gl.endQuery(timerExt.TIME_ELAPSED_EXT);
  finish();
  const t2 = now();
  const gpu = query ? await queryResult(query) : null;
  return { gpu: gpu == null ? null : gpu / reps, wall: (t2 - t0) / reps, submit: (t1 - t0) / reps };
}

let simTime = 30;   // the modules' clock while measuring
function stepModules(names, frames = 1) {
  for (let f = 0; f < frames; f++) {
    simTime += 1 / 60;
    for (const n of names) { const h = modules[n]; if (h && h.update) h.update(simTime, 1 / 60); }
  }
}

let emptyCost = { gpu: 0, wall: 0 };
// GPU and CPU cost of rendering the named modules together (minus the empty scene).
async function measureSet(names, opts = {}) {
  const reps = opts.reps || P.reps, rounds = opts.rounds || P.rounds;
  stepModules(Object.keys(modules), 2);
  const restore = showOnly(names);
  try {
    renderer.render(scene, camera); renderer.render(scene, camera); finish();   // warm: programs for this light/visibility state
    const info = renderer.info.render;
    const draw = { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines };
    const gpu = [], wall = [], submit = [];
    for (let r = 0; r < rounds; r++) {
      const t = await timeRound(reps);
      if (t.gpu != null) gpu.push(t.gpu);
      wall.push(t.wall); submit.push(t.submit);
      await nextTask();
    }
    const base = opts.raw ? { gpu: 0, wall: 0 } : emptyCost;
    const out = {
      wallMin: r2(Math.max(0, Math.min(...wall) - base.wall)), wallMed: r2(Math.max(0, median(wall) - base.wall)),
      submit: r2(median(submit)), ...draw
    };
    if (gpu.length) { out.gpuMin = r2(Math.max(0, Math.min(...gpu) - base.gpu)); out.gpuMed = r2(Math.max(0, median(gpu) - base.gpu)); }
    // The headline number: the timer query when there is one, else wall time to a forced finish.
    out.ms = gpu.length ? out.gpuMin : out.wallMin;
    out.msMed = gpu.length ? out.gpuMed : out.wallMed;
    return out;
  } finally { restore(); }
}

// The cost of A minus the cost of B, measured in alternating rounds so that slow drift in the
// GPU's load (other tabs) cancels. -> { ms: median of the paired differences, min, max }
async function measureDiff(namesA, namesB, opts = {}) {
  const reps = opts.reps || P.reps, rounds = opts.rounds || P.rounds;
  stepModules(Object.keys(modules), 2);
  const diffs = [];
  let restore = showOnly(namesA);
  renderer.render(scene, camera); finish(); restore();
  restore = showOnly(namesB);
  renderer.render(scene, camera); finish(); restore();
  for (let r = 0; r < rounds; r++) {
    restore = showOnly(namesA);
    const a = await timeRound(reps); restore();
    restore = showOnly(namesB);
    const b = await timeRound(reps); restore();
    if (a.gpu != null && b.gpu != null) diffs.push(a.gpu - b.gpu); else if (!timerExt) diffs.push(a.wall - b.wall);
    await nextTask();
  }
  if (!diffs.length) return { ms: null };
  return { ms: r2(median(diffs)), min: r2(Math.min(...diffs)), max: r2(Math.max(...diffs)) };
}

/* ---------- loading one module ---------- */

function collect(roots) {
  const renderables = [];
  let geoBytes = 0;
  const seen = new Set();
  for (const root of roots) {
    root.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      renderables.push(o);
      const g = o.geometry;
      if (g && !seen.has(g)) {
        seen.add(g);
        for (const k in g.attributes) { const a = g.attributes[k]; geoBytes += (a.array || (a.data && a.data.array) || { byteLength: 0 }).byteLength; }
        if (g.index) geoBytes += g.index.array.byteLength;
      }
      if (o.isInstancedMesh) {
        geoBytes += o.instanceMatrix.array.byteLength;
        if (o.instanceColor) geoBytes += o.instanceColor.array.byteLength;
      }
    });
  }
  return { renderables, geoBytes };
}

async function loadOne(name, table) {
  const [factory, opts] = table[name];
  const rec = (perf.modules[name] = { name });
  const before = new Set(scene.children);
  const mem0 = { ...renderer.info.memory }, c0 = counters(), prog0 = renderer.info.programs.length;
  try {
    const t0 = now();
    const mod = await import(`../js/scene/${name}.js`);
    const t1 = now();
    const handle = mod[factory](moduleCtx(), opts());
    finish();
    const t2 = now();
    if (handle && handle.resize) handle.resize(W, H);
    modules[name] = handle || null;
    if (handle && handle.setTimeOfDay) { try { handle.setTimeOfDay(timeOfDay()); } catch (e) { /* optional */ } }
    if (name === 'sky') applyFog(handle);
    linkMoon();

    const roots = scene.children.filter((c) => !before.has(c));
    if (handle && handle.group && !roots.includes(handle.group)) {
      let inRoots = false;
      for (let p = handle.group.parent; p; p = p.parent) if (roots.includes(p)) inRoots = true;
      if (!inRoots) roots.push(handle.group);
    }
    const { renderables, geoBytes } = collect(roots);
    records[name] = { handle, roots, renderables };

    // First render, alone: compile, link and upload. Then a second one: the steady cost to compare.
    if (handle && handle.update) handle.update(simTime, 1 / 60);
    const restore = showOnly([name]);
    const t3 = now();
    renderer.render(scene, camera); finish();
    const t4 = now();
    renderer.render(scene, camera); finish();
    const t5 = now();
    restore();
    const d = since(c0);
    Object.assign(rec, {
      importMs: r2(t1 - t0), createMs: r2(t2 - t1), firstRenderMs: r2(t4 - t3), secondRenderMs: r2(t5 - t4),
      programs: renderer.info.programs.length - prog0, links: d.linkProgram ? d.linkProgram.calls : 0,
      geometries: renderer.info.memory.geometries - mem0.geometries, textures: renderer.info.memory.textures - mem0.textures,
      texMB: r2(sumBytes(d, STORAGE) / 1048576), geoMB: r2(geoBytes / 1048576),
      loadUploadMB: r2(sumBytes(d, UPLOADS) / 1048576), objects: renderables.length,
      hasSetTimeOfDay: !!(handle && handle.setTimeOfDay), hasSetQuality: !!(handle && handle.setQuality)
    });
  } catch (e) {
    rec.error = String(e && e.message ? e.message : e);
    perf.warnings.push(`module "${name}" failed to load: ${rec.error}`);
    console.warn('perf: module "' + name + '" is unavailable.', e);
  }
}

/* ---------- per-module measurements ---------- */

function measureUpdate(name) {
  const h = modules[name];
  if (!h || !h.update) return { mean: 0, max: 0 };
  const N = 240;
  let max = 0;
  for (let i = 0; i < 20; i++) { simTime += 1 / 60; h.update(simTime, 1 / 60); }   // warm the JIT
  const t0 = now();
  for (let i = 0; i < N; i++) {
    simTime += 1 / 60;
    const a = now();
    h.update(simTime, 1 / 60);
    const d = now() - a;
    if (d > max) max = d;
  }
  return { mean: Math.round(((now() - t0) / N) * 1000) / 1000, max: r2(max) };
}

// Buffer and texture uploads per frame while the module animates, alone.
function measureUploads(name) {
  const restore = showOnly([name]);
  const frames = 60;
  stepModules([name], 2); renderer.render(scene, camera);
  const c0 = counters();
  for (let i = 0; i < frames; i++) { stepModules([name], 1); renderer.render(scene, camera); }
  finish();
  const d = since(c0);
  restore();
  return {
    callsPerFrame: r2(sumCalls(d, UPLOADS) / frames), kbPerFrame: r2(sumBytes(d, UPLOADS) / 1024 / frames),
    linksPerFrame: r2((d.linkProgram ? d.linkProgram.calls : 0) / frames),
    detail: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { callsPerFrame: r2(v.calls / frames), kbPerFrame: r2(v.bytes / 1024 / frames) }]))
  };
}

// What one time-of-day tick costs: every module's setTimeOfDay, then the core's applyFog and
// linkMoon, then the next frame. A relink or a large upload here is a hitch every 20 s.
function measureTick(names) {
  const steady = [];
  for (let i = 0; i < 5; i++) { const a = now(); renderer.render(scene, camera); finish(); steady.push(now() - a); }
  const base = timeOfDay().hour;
  const out = { steadyFrameMs: r2(median(steady)), ticks: [], perModule: {} };
  // 20 s later, 40 s later, then jumps across the evening: the real tick is the first kind.
  const hours = [base + 20 / 3600, base + 40 / 3600, 17.5, 19, 22, 5.5, 6.75, base];
  for (const hour of hours) {
    const c0 = counters(), a = now();
    const t = timeOfDay(((hour % 24) + 24) % 24);
    for (const n of names) {
      const h = modules[n];
      if (!h || !h.setTimeOfDay) continue;
      const b = now();
      try { h.setTimeOfDay(t); } catch (e) { /* optional */ }
      const pm = (out.perModule[n] = out.perModule[n] || { calls: 0, cpuMs: 0, maxMs: 0 });
      const d = now() - b;
      pm.calls++; pm.cpuMs += d; pm.maxMs = Math.max(pm.maxMs, d);
    }
    applyFog(modules.sky); linkMoon();
    const b = now();
    renderer.render(scene, camera); finish();
    const c = now(), d = since(c0);
    out.ticks.push({
      hour: r2(hour), cpuMs: r2(b - a), nextFrameMs: r2(c - b), extraMs: r2(Math.max(0, c - b - out.steadyFrameMs)),
      links: d.linkProgram ? d.linkProgram.calls : 0, uploadCalls: sumCalls(d, UPLOADS), uploadKB: r2(sumBytes(d, UPLOADS) / 1024)
    });
  }
  for (const n in out.perModule) { const pm = out.perModule[n]; pm.cpuMs = r2(pm.cpuMs / pm.calls); pm.maxMs = r2(pm.maxMs); }
  out.worstExtraMs = Math.max(0, ...out.ticks.map((t) => t.extraMs + t.cpuMs));
  out.links = out.ticks.reduce((n, t) => n + t.links, 0);
  return out;
}

async function disposeCheck(baseline) {
  for (const name of Object.keys(modules)) {
    const h = modules[name];
    modules[name] = null;
    if (h && h.dispose) { try { h.dispose(); } catch (e) { perf.warnings.push(`"${name}".dispose() threw: ${e.message}`); } }
  }
  renderer.render(scene, camera); finish();
  await nextFrame();
  const m = renderer.info.memory;
  const lights = [];
  scene.traverse((o) => { if (o !== scene) lights.push(o.type + (o.name ? ':' + o.name : '')); });
  return {
    geometries: m.geometries - baseline.geometries, textures: m.textures - baseline.textures,
    programs: renderer.info.programs.length - baseline.programs, leftInScene: lights,
    clean: m.geometries === baseline.geometries && m.textures === baseline.textures && renderer.info.programs.length === baseline.programs && lights.length === 0
  };
}

/* ---------- report ---------- */

function render() {
  const names = Object.keys(perf.modules);
  const cell = (v, hot) => `<td${hot ? ' class="hot"' : ''}>${v == null || Number.isNaN(v) ? '·' : v}</td>`;
  const rows = names.map((n) => {
    const m = perf.modules[n];
    if (m.error) return `<tr><td>${n}</td><td colspan="15" class="warn">failed: ${m.error}</td></tr>`;
    const a = m.alone || {}, up = m.uploads || {}, u = m.update || {};
    return `<tr><td>${n}</td>${cell(m.importMs)}${cell(m.createMs, m.createMs > 50)}${cell(m.firstRenderMs, m.firstRenderMs > 30)}${cell(m.programs)}` +
      `${cell(u.mean, u.mean > 0.3)}${cell(a.submit)}${cell(a.ms, a.ms > 2)}${cell(a.msMed)}${cell(m.marginal, m.marginal > 2)}` +
      `${cell(a.calls)}${cell(a.triangles != null ? Math.round(a.triangles / 1000) + 'k' : null)}${cell(m.texMB)}${cell(m.geoMB)}` +
      `${cell(up.callsPerFrame, up.callsPerFrame > 0)}${cell(up.kbPerFrame, up.kbPerFrame > 4)}</tr>`;
  }).join('');
  const t = perf.total;
  const sum = (f) => r2(names.reduce((s, n) => s + (f(perf.modules[n]) || 0), 0));
  const totalRow = t ? `<tr class="total"><td>all together</td>${cell(sum((m) => m.importMs))}${cell(sum((m) => m.createMs))}${cell(sum((m) => m.firstRenderMs))}${cell(sum((m) => m.programs))}` +
    `${cell(sum((m) => m.update && m.update.mean))}${cell(t.submit)}${cell(t.ms)}${cell(t.msMed)}${cell('')}` +
    `${cell(t.calls)}${cell(Math.round(t.triangles / 1000) + 'k')}${cell(sum((m) => m.texMB))}${cell(sum((m) => m.geoMB))}${cell(sum((m) => m.uploads && m.uploads.callsPerFrame))}${cell(sum((m) => m.uploads && m.uploads.kbPerFrame))}</tr>` : '';
  let html = `<p>${W}x${H} css px, pixel ratio ${P.dpr} (${perf.env.drawingBuffer ? perf.env.drawingBuffer.join('x') : ''}), MSAA ${perf.env.samples}x, ${perf.env.gpu || ''}. ` +
    `GPU: ${perf.env.timerQuery ? `timer query, ${P.reps} renders x ${P.rounds} rounds, minimum (median beside it)` : 'no timer query: wall time to a forced finish'}; empty scene ${r2(emptyCost.gpu || emptyCost.wall)} ms subtracted.</p>` +
    `<table><tr><th>module</th><th>import</th><th>create</th><th>1st render</th><th>progs</th><th>update</th><th>submit</th><th>GPU alone</th><th>(med)</th><th>GPU marginal</th><th>calls</th><th>tris</th><th>tex MB</th><th>geo MB</th><th>uploads/f</th><th>kB/f</th></tr>${rows}${totalRow}</table>`;
  if (t) {
    html += `<p>Whole scene: GPU ${t.ms} ms (median ${t.msMed}; spread over ${t.samples ? t.samples.length : 1} measurements ${t.samples ? t.samples.join(' / ') : ''}), CPU ${r2(t.submit + sum((m) => m.update && m.update.mean))} ms (submit ${t.submit} + update ${sum((m) => m.update && m.update.mean)}), ` +
      `${t.calls} draw calls, ${Math.round(t.triangles / 1000)}k triangles, ${renderer.info.programs.length} programs. Budget at 120 Hz: 8.3 ms; at 60 Hz: 16.7 ms.</p>`;
  }
  if (perf.sweep) html += `<p>Pixel-ratio sweep of the whole scene (GPU ms): ${perf.sweep.map((s) => `${s.pixelRatio} → ${s.ms}`).join(', ')}.</p>`;
  if (perf.lateLights) html += `<p>Lights arriving late: loading fire.js after the lit modules relinked ${perf.lateLights.links} programs in ${perf.lateLights.ms} ms (one frame).</p>`;
  if (perf.tick) {
    const k = perf.tick;
    html += `<p>Time-of-day tick: 20 s step costs ${k.ticks[0].cpuMs} ms CPU + ${k.ticks[0].extraMs} ms extra on the next frame, ${k.ticks[0].links} relinks, ${k.ticks[0].uploadKB} kB uploaded; worst of ${k.ticks.length} steps ${r2(k.worstExtraMs)} ms, ${k.links} relinks in all.</p>`;
  }
  if (perf.dispose) html += `<p>Dispose: ${perf.dispose.clean ? 'renderer.info is back to its baseline.' : `<span class="warn">left behind ${perf.dispose.geometries} geometries, ${perf.dispose.textures} textures, ${perf.dispose.programs} programs, ${perf.dispose.leftInScene.length} scene objects (${perf.dispose.leftInScene.slice(0, 6).join(', ')}).</span>`}</p>`;
  if (perf.warnings.length) html += `<p class="warn">${perf.warnings.join('<br>')}</p>`;
  outEl.innerHTML = html;
}

/* ---------- live view ---------- */

function live() {
  const box = document.createElement('p');
  const fpsEl = document.createElement('span');
  const hidden = new Set();
  for (const name of Object.keys(records)) {
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'checkbox'; c.checked = true;
    c.addEventListener('change', () => { if (c.checked) hidden.delete(name); else hidden.add(name); for (const o of records[name].roots) o.visible = c.checked; });
    l.append(c, ' ' + name); box.append(l);
  }
  box.append(fpsEl);
  document.getElementById('panel').append(box);
  let last = 0, acc = 0, n = 0, worst = 0;
  const frame = (t) => {
    const dt = last ? t - last : 0; last = t;
    if (dt > 0 && dt < 500) { acc += dt; n++; worst = Math.max(worst, dt); }
    if (acc > 1000) { fpsEl.textContent = ` live: ${Math.round(1000 * n / acc)} fps, worst ${worst.toFixed(1)} ms`; acc = 0; n = 0; worst = 0; }
    simTime += Math.min(0.1, dt / 1000);
    for (const name in modules) { const h = modules[name]; if (h && h.update && !hidden.has(name)) h.update(simTime, Math.min(0.1, dt / 1000)); }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ---------- run ---------- */

async function run() {
  buildStage();
  await checkCore();
  const table = moduleTable();
  let names = ORDER.filter((n) => table[n]);
  if (P.only.length) names = names.filter((n) => P.only.includes(n));
  names = names.filter((n) => !P.skip.includes(n));
  for (const n of [...P.only, ...P.skip]) if (!ORDER.includes(n)) perf.warnings.push(`unknown module "${n}" in ?only / ?skip`);

  renderer.render(scene, camera); finish();
  const baseline = { ...renderer.info.memory, programs: renderer.info.programs.length };
  await nextFrame();

  // Load one after another (the site loads them in parallel; here each compile is its own).
  for (const name of names) {
    status(`loading ${name}…`);
    await nextFrame();
    const linksBefore = glc.linkProgram.calls;
    await loadOne(name, table);
    if (name === 'fire' && modules.fire) {
      // The fire's lights change every lit material's program: count the relinks on the next full frame.
      const a = now(), l0 = glc.linkProgram.calls;
      renderer.render(scene, camera); finish();
      perf.lateLights = { links: glc.linkProgram.calls - l0, ms: r2(now() - a), fireOwnLinks: l0 - linksBefore };
    }
    render();
  }
  const loaded = names.filter((n) => modules[n]);
  perf.load = {
    createMs: r2(loaded.reduce((s, n) => s + perf.modules[n].createMs, 0)),
    firstRenderMs: r2(loaded.reduce((s, n) => s + perf.modules[n].firstRenderMs, 0)),
    programs: renderer.info.programs.length
  };

  status('measuring the empty scene…');
  await nextFrame();
  const empty = await measureSet([], { raw: true });
  emptyCost = { gpu: empty.gpuMin || 0, wall: empty.wallMin };
  perf.empty = empty;

  const totals = [];
  const measureTotal = async () => { const t = await measureSet(loaded); totals.push(t); return t; };
  status('measuring the whole scene…');
  perf.total = await measureTotal();
  render();

  for (const name of P.quick ? [] : loaded) {
    status(`measuring ${name}: update, uploads, alone…`);
    await nextFrame();
    const m = perf.modules[name];
    m.update = measureUpdate(name);
    m.uploads = measureUploads(name);
    m.alone = await measureSet([name]);
    render();
  }

  if (P.marginal && !P.quick && loaded.length > 1) {
    for (let i = 0; i < loaded.length; i++) {
      const name = loaded[i];
      status(`measuring the whole scene without ${name}…`);
      await nextFrame();
      if (i === Math.floor(loaded.length / 2)) await measureTotal();
      const d = await measureDiff(loaded, loaded.filter((n) => n !== name));
      perf.modules[name].marginal = d.ms;
      perf.modules[name].marginalRange = [d.min, d.max];
      render();
    }
    await measureTotal();
  }
  // The total is the best (minimum) of the passes; the spread shows how noisy the GPU was.
  const best = totals.reduce((a, b) => (b.ms < a.ms ? b : a));
  perf.total = { ...best, msMed: r2(median(totals.map((t) => t.msMed))), samples: totals.map((t) => t.ms) };
  render();

  if (P.fill && !P.quick) {
    perf.sweep = [];
    for (const pr of [2, 1.5, 1.25, 1]) {
      if (pr > P.dpr + 1e-6 && pr !== 2) continue;
      status(`measuring the whole scene at pixel ratio ${pr}…`);
      await nextFrame();
      renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
      for (const n of loaded) { const h = modules[n]; if (h && h.resize) h.resize(W, H); }
      const e = await measureSet([], { raw: true, rounds: 3 });
      const t = await measureSet(loaded, { raw: true, rounds: 3 });
      perf.sweep.push({ pixelRatio: pr, ms: r2(Math.max(0, t.ms - (e.gpuMin != null ? e.gpuMin : e.wallMin))), msMed: r2(Math.max(0, t.msMed - (e.gpuMed != null ? e.gpuMed : e.wallMed))) });
    }
    renderer.setPixelRatio(P.dpr); renderer.setSize(W, H, false);
    for (const n of loaded) { const h = modules[n]; if (h && h.resize) h.resize(W, H); }
    render();
  }

  if (!P.quick) {
    status('measuring a time-of-day tick…');
    await nextFrame();
    perf.tick = measureTick(loaded);
    render();
  }

  if (P.auto || q.get('dispose') === '1') {
    status('checking dispose…');
    perf.dispose = await disposeCheck(baseline);
    render();
  } else if (P.live) {
    live();
  }
  status(`done in ${Math.round(now() / 1000)} s. Results: window.__perf`);
  perf.done = true;
}

perf.toJSON = () => {
  const { toJSON, ...rest } = perf;
  return JSON.parse(JSON.stringify(rest));
};
window.addEventListener('error', (e) => perf.warnings.push('error: ' + e.message));
run().catch((e) => {
  perf.error = String(e && e.stack ? e.stack : e);
  status('failed: ' + perf.error);
  console.error(e);
});
