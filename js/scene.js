/*
  OWNER: director. The core of the scene. CONTRACT.md is the source of truth; this header
  repeats the parts that matter here.

  INTERFACE
    import { init } from "./js/scene.js";   (also exposed as Iskry.scene.init)
    init(rootEl, words)
      rootEl  the #scene element with its two layers (#scene-world, #scene-words).
      words   Iskry.WORDS. May be short: a word is never shown twice at once, and the
              night simply holds fewer words when there are fewer than --words-min.
    Optional data: Iskry.GUSTS = [{ id, label, ids: [...] }], themed clusters of words
    that now and then ride in together on one gust. Absent or malformed: no gusts.

  WHAT IT DOES
    One THREE.Scene and one PerspectiveCamera, drawn by two renderers that share them:
      WebGLRenderer  -> #scene-world  the night. The environment lives in plug-in modules
                        (js/scene/sky.js, stars.js, moon.js, trees.js, foreground.js,
                        strings.js, fire.js; interface in CONTRACT.md).
                        Each is loaded with a guarded dynamic import: if one is missing or
                        throws, the words still drift over the CSS night gradient.
      CSS3DRenderer  -> #scene-words  the words. Each is a real
                        <button type="button" class="spark" data-id lang="pl"
                                aria-label="{pl}" data-pl="{pl}">{pl}</button>
                        wrapped in a CSS3DSprite, so hover, focus, click and
                        getBoundingClientRect() are plain DOM.
    Words drift along +x (the wind) at depths between --depth-near and --depth-far. Every
    word rides the same wind, so near words cross the screen faster than far ones: that
    is the parallax. Each sprite is scaled so its text is drawn 1:1 (its font-size is the
    size you see), which keeps it crisp at every depth.
    When a nearer word passes in front of a farther one, the one behind fades back (as if
    hidden), so overlapping words never read as a tangle. A word that has your attention
    (hovered, focused, held) is never the one that fades; the word in front of it does.
    Rare finds (word.rare) come seldom, one at a time, and drift slower. Now and then a
    themed gust (Iskry.GUSTS) carries a loose cluster of related words in together, with
    its label whispered very faintly ahead of them.

  EVENTS (on document)
    dispatch  word:catch   { id, rect }  when the pluck ends (straight away if --dur-pluck is 0)
    listen    word:release { id }        unknown or stale ids are ignored
    While a card is open, a click on another word (it lands on the card's backdrop) closes
    the card and catches that word: the scene sees the click, waits for word:release, then
    plucks the new word. A word under the pointer brightens while a card is open, as a hint.

  MOTION
    One requestAnimationFrame loop, paused while document.hidden. Tokens are read at init
    and when reduced motion changes (the environment modules are then rebuilt).
    Look-and-feel knobs that are not tokens live in TUNE below.
    Time of day: modules may expose setTimeOfDay({ hour, dusk, night, dawn }) (weights sum
    to 1, from the visitor's clock); it is called on load and every TUNE.timeEvery seconds.
    Dev only: ?bare=1 skips the environment modules, ?gust=1 sends the first gust after 4 s,
    ?hour=5.5 pins the clock.

  three.js 0.186.1 (r186), vendored in vendor/three/, resolved by the import map in index.html.
*/
import * as THREE from "three";
import { CSS3DRenderer, CSS3DSprite } from "three/addons/renderers/CSS3DRenderer.js";

const Iskry = (window.Iskry = window.Iskry || {});
const TAU = Math.PI * 2;

// Look-and-feel knobs that are not design tokens. Distances are metres; ground is y = 0.
const TUNE = {
  cameraPos: [0, 1.6, 12],     // eye height of someone sitting back from the fire
  cameraLook: [0, 4.1, -10],   // pitched up a little: the horizon sits about 2/3 down
  cameraEase: 1.4,             // s, how lazily the camera follows the pointer
  cameraParallaxY: 0.35,       // vertical share of --camera-parallax
  breathPeriodA: 19,           // s, the two sines of the breathing camera
  breathPeriodB: 13,
  bandTop: 0.09,               // words float between these fractions of the height
  bandBottom: 0.6,
  spawnTries: 9,               // candidate heights tried to avoid crowding
  spawnNearX: 0.3,             // only words within this fraction of the width crowd a spawn
  depthBias: 1,                // >1 favours far words, <1 near words
  speedJitter: 0.14,           // each word rides the wind this much faster or slower
  alphaSmoothing: 0.3,         // s, time constant easing every opacity change
  attendLift: 0.97,            // a hovered or focused word brightens to at least this
  windPeriodA: 41,             // s, the two sines that make the wind wander
  windPeriodB: 23,
  minSpawnGap: 900,            // ms, never spawn faster than this while catching up
  fireReach: 13,               // m, words within this of the fire breathe with its flicker
  fireDim: 0.12,               // how much a word next to the fire dims when the fire dips
  firePos: [-3, 0, -2],        // left of centre, so the embers blow across the middle
  fireScale: 1.3,              // a hearth, not a candle
  treeSeed: 7,                 // the same forest every visit
  heatLift: 0.14,              // m, how far the warm air above the fire lifts a word
  heatWidth: 2.6,              // m, half-width of the warm column (gaussian)
  heatDepth: 7,                // m, how far in front of or behind the fire it is felt
  stringExtents: { xMin: -22, xMax: 22, yMin: 1.5, yMax: 10, zMin: -14, zMax: 2 },
  fogNear: 14,                 // used until sky.js suggests its own
  fogFar: 70,
  occludeDim: 0.78,            // how far a word fades back while a nearer word covers it
  occludeGain: 3,              // covered fraction that counts as fully covered (1 / this)
  hoverHitEvery: 0.2,          // s, re-test what is under a still pointer while a card is open
  rareWeight: 0.25,            // rare finds are picked this much less often
  rareSlow: 0.72,              // and ride the wind this much slower
  rareDepth: [0.08, 0.5],      // and drift in the nearer half, so they can be read
  journalEase: 0.25,
  timeEvery: 20,               // s between time-of-day updates (the night shifts over hours)           // s, how fast the open sky's edge follows the journal panel
  gustFirst: [80, 140],        // s, the first gust comes this long after opening
  gustEvery: [190, 330],       // s, then this long after the previous one ends
  gustWords: [4, 6],           // words in one gust
  gustMinWords: 3,             // a cluster needs at least this many words free to fly
  gustGap: [1.1, 2.3],         // s between the words of one gust
  gustSpread: 0.17,            // fraction of the height the cluster spreads over, each way
  gustSwell: 0.16,             // the wind strengthens this much while a gust passes
  gustSwellEase: 5,            // s, how slowly the swell rises and falls
  gustLinger: 26,              // s after the last word of a gust before the swell fades
  whisperAlpha: 0.3,           // peak opacity of a gust's label
  whisperSize: 0.5,            // label size relative to a word at the same depth
  whisperMinPx: 13,
  maxPixelRatio: 2
};

let root, worldLayer, wordsLayer;
let scene, camera, gl = null, css;
const camPos0 = new THREE.Vector3(), camFwd = new THREE.Vector3(), camUp = new THREE.Vector3();
const camOffset = new THREE.Vector3(), camGoal = new THREE.Vector3();
let focal = 1;               // px: a 1 m object 1 m away is this many px
let pointerX = 0, pointerY = 0, pointerPx = -1, pointerPy = -1;

const pool = [];             // valid word objects from the dataset
const poolById = Object.create(null);
const live = [];             // word states on screen
const onScreen = Object.create(null); // id -> state
const modules = { sky: null, stars: null, moon: null, trees: null, foreground: null, strings: null, fire: null };
let modulesEpoch = 0;
let T = {};                  // tokens
let mq = null, reduced = false;
let W = 1, H = 1;
let rafId = 0, lastNow = 0, clock = 0;
let nextSpawnAt = 0;         // in clock seconds
let holding = null;          // the word from click until word:release
let pluckTimer = 0;
let resizeQueued = false;
let rareOnScreen = 0;

// The right edge of the open sky, in px: the viewport edge, or the journal panel's edge
// while it is open (words fade out before they slip under it). Eased.
let skyEdge = 1, skyEdgeGoal = 1, journalPanel = null;

// While a card is open: the word under the pointer (a hint), and a click's target.
let ghost = null, hitDirty = false, hitAt = 0;
let pendingSwitch = null;

// Gusts.
let gust = null;             // { id, queue, nextAt, dC, yC, jitter, endAt }
let nextGustAt = Infinity, lastGustId = null, swell = 0;
const whispers = [];         // gust labels drifting with their cluster

/* ---------- helpers ---------- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const randIn = (r) => rand(r[0], r[1]);
const ease = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

// Reads a CSS custom property from :root: a number when it parses as one, else the string.
function readToken(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (/^-?[\d.]+(e-?\d+)?[a-z%]*$/i.test(raw)) {
    const n = parseFloat(raw);
    if (isFinite(n)) return n;
  }
  return raw;
}

function readTokens() {
  const num = (name, fallback) => {
    const v = readToken(name, fallback);
    return typeof v === "number" ? v : fallback;
  };
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  T = {
    wind: num("--wind-speed", 44),
    gust: clamp(num("--wind-gust", 0.28), 0, 0.9),
    dir: num("--wind-direction", 1) < 0 ? -1 : 1,
    bobAmp: num("--bob-amplitude", 11),
    bobPMin: num("--bob-period-min", 7000) / 1000,
    bobPMax: num("--bob-period-max", 13000) / 1000,
    fadeEdge: clamp(num("--fade-edge", 0.15), 0.02, 0.45),
    hoverSlow: num("--hover-slow-factor", 0.2),
    durHover: num("--dur-hover", 600),
    durPluck: num("--dur-pluck", 520),
    durFadeIn: num("--dur-fade-in", 2400),
    pluckAmp: num("--pluck-amplitude", 5),
    pluckCycles: num("--pluck-cycles", 7),
    flicker: num("--flicker-strength", 0.12),
    depthNear: Math.max(1, num("--depth-near", 10)),
    depthFar: num("--depth-far", 26),
    fogAlpha: clamp(num("--fog-word-alpha", 0.82), 0, 1),
    sizeMax: num("--size-spark-max", 2.75) * remPx,
    sizeMin: num("--size-spark-min", 1.05) * remPx,
    fov: clamp(num("--camera-fov", 40), 10, 100),
    parallax: num("--camera-parallax", 0.3),
    breath: num("--camera-breath", 0.09),
    wordsMin: Math.max(0, Math.round(num("--words-min", 15))),
    wordsMax: Math.max(1, Math.round(num("--words-max", 25)))
  };
  if (T.depthFar < T.depthNear) T.depthFar = T.depthNear;
  if (T.wordsMax < T.wordsMin) T.wordsMax = T.wordsMin;
  if (T.bobPMin <= 0) T.bobPMin = 7;
  if (T.bobPMax < T.bobPMin) T.bobPMax = T.bobPMin;
  reduced = !!(mq && mq.matches);
}

function weightOf(id) {
  let w = 1;
  try { w = Iskry.memory && Iskry.memory.weight ? Number(Iskry.memory.weight(id)) : 1; } catch (e) { w = 1; }
  return isFinite(w) && w > 0 ? w : 0;
}

function isGolden(id) {
  try { return !!(Iskry.memory && Iskry.memory.isGolden && Iskry.memory.isGolden(id)); } catch (e) { return false; }
}

function focusVisible(el) {
  try { return el.matches(":focus-visible"); } catch (e) { return true; }
}

const fontAt = (d) => Math.max(T.sizeMin, (T.sizeMax * T.depthNear) / d);
const fogAt = (d) => (T.depthFar > T.depthNear ? (d - T.depthNear) / (T.depthFar - T.depthNear) : 0);
// Log-uniform depth: f 0 is --depth-near, 1 is --depth-far, sizes spread evenly between.
const depthAt = (f) => T.depthNear * Math.pow(T.depthFar / T.depthNear, clamp(f, 0, 1));

/* ---------- stage: scene, camera, renderers ---------- */

function buildStage() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(String(readToken("--fog", "#2b1a10"))), TUNE.fogNear, TUNE.fogFar);

  camera = new THREE.PerspectiveCamera(T.fov, 1, 0.1, 400);
  camPos0.fromArray(TUNE.cameraPos);
  camera.position.copy(camPos0);
  camera.lookAt(TUNE.cameraLook[0], TUNE.cameraLook[1], TUNE.cameraLook[2]);
  // The camera only ever translates, so its basis is fixed. (No yaw: right is world +x.)
  camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

  try {
    gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    gl.setClearColor(0x000000, 0);   // the CSS night gradient shows through until sky.js draws
    worldLayer.appendChild(gl.domElement);
  } catch (e) {
    gl = null;                        // no WebGL: the words still drift over the CSS night
    console.warn("Iskry: WebGL is unavailable, showing the words only.", e);
  }

  css = new CSS3DRenderer();
  css.domElement.classList.add("scene__words-3d");
  wordsLayer.appendChild(css.domElement);
}

function measure() {
  W = window.innerWidth || document.documentElement.clientWidth || 1;
  H = window.innerHeight || document.documentElement.clientHeight || 1;
  camera.fov = T.fov;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  focal = (H / 2) / Math.tan((T.fov * Math.PI / 180) / 2);
  if (gl) {
    gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, TUNE.maxPixelRatio));
    gl.setSize(W, H, false);
  }
  css.setSize(W, H);
  readJournalEdge();
  if (!(skyEdge > 1)) skyEdge = skyEdgeGoal;
  for (const name in modules) {
    const m = modules[name];
    if (m && m.resize) { try { m.resize(W, H); } catch (e) { /* a module must not stop the words */ } }
  }
  for (const w of live) w.obj.scale.setScalar(w.d / focal);
  for (const s of whispers) s.obj.scale.setScalar(s.d / focal);
}

/* ---------- environment modules ---------- */

function moduleCtx() {
  return { scene, camera, renderer: gl, reducedMotion: reduced, readToken };
}

function disposeModules() {
  for (const name in modules) {
    const m = modules[name];
    modules[name] = null;
    if (m && m.dispose) { try { m.dispose(); } catch (e) { /* ignore */ } }
  }
}

async function loadModule(name, factory, opts, epoch) {
  try {
    const mod = await import(`./scene/${name}.js`);
    if (epoch !== modulesEpoch) return;
    const handle = mod[factory](moduleCtx(), opts);
    if (handle && handle.resize) handle.resize(W, H);
    modules[name] = handle || null;
    if (handle && handle.setTimeOfDay) { try { handle.setTimeOfDay(timeOfDay()); } catch (e) { /* optional */ } }
    if (name === "sky") applyFog(handle);
  } catch (e) {
    console.warn("Iskry: scene module \"" + name + "\" is unavailable.", e);
  }
}

// Where the scene is: central Poland, tonight. Used by the stars and the moon.
const PLACE = { latitudeDeg: 52.1, longitudeDeg: 19.4 };

// Every environment module after the sky: name, factory, and its options (built at load).
function moduleTable() {
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const wind = (T.wind * T.depthNear) / focal;     // mean wind, m/s
  const date = new Date();
  return [
    ["stars", "createStars", () => ({ date, latitudeDeg: PLACE.latitudeDeg, longitudeDeg: PLACE.longitudeDeg })],
    ["moon", "createMoon", () => ({ date })],
    ["trees", "createTrees", () => ({ firePosition: v(TUNE.firePos), wind, seed: TUNE.treeSeed })],
    ["foreground", "createForeground", () => ({ firePosition: v(TUNE.firePos), wind })],
    ["strings", "createStrings", () => ({
      count: Math.max(1, Math.round(Number(readToken("--strings-count", 6)) || 6)),
      extents: Object.assign({}, TUNE.stringExtents)
    })],
    ["fire", "createFire", () => ({ position: v(TUNE.firePos), scale: TUNE.fireScale })]
  ];
}

function loadModules() {
  // ?bare=1 shows the core alone (words over the CSS night), for tuning and debugging.
  if (!gl || new URLSearchParams(location.search).has("bare")) return;
  const epoch = ++modulesEpoch;
  disposeModules();
  // Sky first, so it is behind everything that is added later.
  loadModule("sky", "createSky", { horizonY: 0, radius: 90 }, epoch)
    .then(() => Promise.all(moduleTable().map(([name, factory, opts]) => loadModule(name, factory, opts(), epoch))));
}

// The sky suggests a fog; the core applies it to WebGL and to the far words' color.
// Called on load and again with every time-of-day tick (the sky may shift its fog).
let fogHex = "";
function applyFog(sky) {
  if (!sky || !sky.fogColor || !sky.fogColor.isColor) return;
  scene.fog.color.copy(sky.fogColor);
  if (sky.fogNear > 0) scene.fog.near = sky.fogNear;
  if (sky.fogFar > scene.fog.near) scene.fog.far = sky.fogFar;
  const hex = "#" + sky.fogColor.getHexString();
  if (hex !== fogHex) { fogHex = hex; root.style.setProperty("--scene-fog", hex); }
}

/* ---------- time of day ---------- */

// The night follows the visitor's clock: dusk in the evening, deep night, then the cool
// hour before dawn. Daytime is the evening here (the fire is always lit), so the dawn
// hands over to dusk slowly in the morning. Weights sum to 1. ?hour=5.5 pins the clock (dev).
const TIME_KEYS = [  // hour, dusk, night, dawn
  [0, 0, 1, 0], [2.5, 0, 1, 0], [4.5, 0, 0.25, 0.75], [6.5, 0, 0, 1],
  [8.5, 1, 0, 0], [19.5, 1, 0, 0], [22, 0, 1, 0], [24, 0, 1, 0]
];
const tod = { hour: 0, dusk: 0, night: 1, dawn: 0 };
const pinnedHour = (() => {
  const h = parseFloat(new URLSearchParams(location.search).get("hour"));
  return isFinite(h) ? ((h % 24) + 24) % 24 : null;
})();

function timeOfDay() {
  let h = pinnedHour;
  if (h == null) { const d = new Date(); h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
  let i = 0;
  while (i < TIME_KEYS.length - 2 && h >= TIME_KEYS[i + 1][0]) i++;
  const a = TIME_KEYS[i], b = TIME_KEYS[i + 1];
  const t = smooth((h - a[0]) / (b[0] - a[0]));
  tod.hour = h;
  tod.dusk = lerp(a[1], b[1], t);
  tod.night = lerp(a[2], b[2], t);
  tod.dawn = lerp(a[3], b[3], t);
  return tod;
}

let todAt = 0;
function stepTimeOfDay() {
  if (clock - todAt < TUNE.timeEvery) return;
  todAt = clock;
  timeOfDay();
  for (const name in modules) {
    const m = modules[name];
    if (m && m.setTimeOfDay) { try { m.setTimeOfDay(tod); } catch (e) { /* optional */ } }
  }
  applyFog(modules.sky);
}

/* ---------- camera ---------- */

function updateCamera(dt) {
  // While a word is held the camera holds still too, so the word stays exactly put.
  if (!holding) {
    const b = T.breath;
    camGoal.set(
      pointerX * T.parallax * 0.5 + b * 0.6 * Math.sin(TAU * clock / TUNE.breathPeriodB + 0.7),
      -pointerY * T.parallax * 0.5 * TUNE.cameraParallaxY + b * 0.35 * Math.sin(TAU * clock / TUNE.breathPeriodA),
      b * Math.sin(TAU * clock / TUNE.breathPeriodA + 1.9)
    );
    camOffset.lerp(camGoal, ease(dt, TUNE.cameraEase));
  }
  camera.position.copy(camPos0).add(camOffset);
}

/* ---------- words ---------- */

// A word lives in rest-camera space: d metres ahead, u metres to the right, and at a
// fraction yf of the viewport height. That makes its rest screen position trivial:
function screenX(w) { return W / 2 + (w.u * focal) / w.d; }
function uAtScreenX(x, d) { return ((x - W / 2) * d) / focal; }

function pickWord() {
  let total = 0;
  const cands = [], ws = [];
  for (const w of pool) {
    if (onScreen[w.id]) continue;
    if (w.rare && rareOnScreen > 0) continue;   // one rare find at a time
    let wt = weightOf(w.id);
    if (wt <= 0) continue;
    if (w.rare) wt *= TUNE.rareWeight;
    cands.push(w); ws.push(wt); total += wt;
  }
  if (!cands.length) return null;
  let r = Math.random() * total;
  for (let i = 0; i < cands.length; i++) {
    r -= ws[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

// The height (fraction of the viewport, within lo..hi) farthest from the words near x.
function pickHeight(x, lo, hi) {
  let best = (lo + hi) / 2, bestScore = -1;
  for (let t = 0; t < TUNE.spawnTries; t++) {
    const yf = rand(lo, hi);
    let score = 1;
    for (const o of live) {
      if (Math.abs(o.sx - x) > W * TUNE.spawnNearX) continue;
      const dy = Math.abs(o.yf - yf);
      if (dy < score) score = dy;
    }
    if (score > bestScore) { bestScore = score; best = yf; }
  }
  return best;
}

function estimateHalfWidth(text, fontPx) {
  return (text.length * 0.5 + 1.2) * fontPx * 0.5;
}

const upwindX = (halfW) => (T.dir > 0 ? -(halfW + 24) : W + halfW + 24);

// x: rest screen x to appear at, or null to enter from the upwind edge.
// o (optional, for gusts): { data, d, yf, jitter, gust }.
function spawn(x, ageMs, o) {
  const data = o && o.data ? o.data : pickWord();
  if (!data || onScreen[data.id]) return null;

  const d = o && o.d ? o.d
    : data.rare ? depthAt(randIn(TUNE.rareDepth))
    : depthAt(Math.pow(Math.random(), 1 / TUNE.depthBias));
  const fog = fogAt(d);
  const fontPx = fontAt(d);
  const halfW = estimateHalfWidth(data.pl, fontPx);
  if (x == null) x = upwindX(halfW) - (o && o.lead ? T.dir * o.lead : 0);

  const el = document.createElement("button");
  el.type = "button";
  el.className = "spark";
  el.setAttribute("data-id", data.id);
  el.setAttribute("data-pl", data.pl);
  el.setAttribute("aria-label", data.pl);
  el.setAttribute("lang", "pl");
  el.textContent = data.pl;
  if (data.rare) el.classList.add("is-rare");
  if (isGolden(data.id)) el.classList.add("is-golden");
  el.style.fontSize = fontPx.toFixed(2) + "px";
  el.style.setProperty("--spark-fog", fog.toFixed(3));
  el.style.opacity = "0";

  const obj = new CSS3DSprite(el);
  obj.scale.setScalar(d / focal);       // 1 CSS px of the word is 1 px on screen

  let jitter = o && o.jitter ? o.jitter : 1 + rand(-TUNE.speedJitter, TUNE.speedJitter);
  if (data.rare) jitter *= TUNE.rareSlow;

  const w = {
    id: data.id,
    rare: !!data.rare,
    gust: o ? o.gust || null : null,
    el, obj,
    d, fog, fontPx, halfW, measured: false,
    u: uAtScreenX(x, d),
    yf: o && o.yf != null ? o.yf : pickHeight(x, TUNE.bandTop, TUNE.bandBottom),
    sx: x, sy: 0,
    jitter,
    t: Math.random() * 60,
    p1: rand(T.bobPMin, T.bobPMax),
    p2: rand(T.bobPMin, T.bobPMax) * 0.57,
    ph1: Math.random() * TAU,
    ph2: Math.random() * TAU,
    mix: rand(0.6, 0.8),
    age: ageMs || 0,
    alpha: 0, shown: -1,
    occ: 0,              // how much a nearer word covers this one, 0..1
    k: 0,                // eased hover/focus amount, 0..1
    hover: false, focus: false, ghost: false,
    state: "drifting",
    pluckStart: 0,
    pos: obj.position,
    prev: new THREE.Vector3(),
    hasPrev: false
  };

  el.addEventListener("pointerenter", () => { w.hover = true; });
  el.addEventListener("pointerleave", () => { w.hover = false; });
  // Only keyboard focus counts as attention. A word refocused after a mouse close must
  // not stay slow and bright for ever.
  el.addEventListener("focus", () => { w.focus = focusVisible(el); });
  el.addEventListener("blur", () => { w.focus = false; });
  el.addEventListener("click", () => { pluck(w); });

  live.push(w);
  onScreen[w.id] = w;
  if (w.rare) rareOnScreen++;
  place(w, 0);
  scene.add(obj);
  return w;
}

function removeWord(i) {
  const w = live[i];
  live.splice(i, 1);
  delete onScreen[w.id];
  if (w.rare) rareOnScreen--;
  if (ghost === w) ghost = null;
  if (pendingSwitch === w) pendingSwitch = null;
  scene.remove(w.obj);
  if (w.el.parentNode) w.el.parentNode.removeChild(w.el);
}

// Vertical float in px for the nearest words; far words float a little less.
function bob(w) {
  if (!(T.bobAmp > 0)) return 0;
  const a = T.bobAmp * (1 - 0.45 * w.fog);
  return a * (w.mix * Math.sin(TAU * w.t / w.p1 + w.ph1) +
              (1 - w.mix) * Math.sin(TAU * w.t / w.p2 + w.ph2));
}

// The warm air above the fire lifts a passing word a little (metres -> px at its depth).
function heat(w) {
  if (!(T.bobAmp > 0)) return 0;
  const dx = (w.pos.x - TUNE.firePos[0]) / TUNE.heatWidth;
  const dz = (w.pos.z - TUNE.firePos[2]) / TUNE.heatDepth;
  return (TUNE.heatLift * Math.exp(-dx * dx - dz * dz) * focal) / w.d;
}

function place(w, offsetPx) {
  // Screen px above the middle of the viewport, turned into metres at this depth.
  const up = (0.5 - w.yf) * H + offsetPx;
  const v = (up * w.d) / focal;
  w.sy = H / 2 - up;
  w.pos.set(
    camPos0.x + camFwd.x * w.d + w.u,
    camPos0.y + camFwd.y * w.d + camUp.y * v,
    camPos0.z + camFwd.z * w.d + camUp.z * v
  );
}

const attended = (w) => w.hover || w.focus || w.ghost || w.state !== "drifting";

// Fades a word in and out at the edges. At the journal panel the whole word fades before
// its leading end reaches the panel; at the viewport edge it may slide off as it fades.
function edgeFade(sx, halfW) {
  const span = T.fadeEdge * W, pad = 0.03 * W;
  const j = clamp((W - skyEdge) / 40, 0, 1);
  const right = lerp(W + pad, skyEdge - halfW, j);
  return smooth((sx + pad) / span) * smooth((right - sx) / span);
}

// The journal panel narrows the open sky on its side while it is open.
function readJournalEdge() {
  const open = journalPanel && journalPanel.classList.contains("is-open");
  const w = open ? journalPanel.offsetWidth : 0;   // layout width: ignores the slide-in transform
  skyEdgeGoal = Math.max(W * 0.4, W - w);
}

function watchJournal() {
  const jr = document.getElementById("journal-root");
  if (!jr || !window.MutationObserver) return;
  const hook = () => {
    const panel = jr.querySelector("#journal-panel");
    if (panel !== journalPanel) journalPanel = panel;
    readJournalEdge();
  };
  new MutationObserver(hook).observe(jr, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  hook();
}

function targetAlpha(w, flick) {
  if (w.state !== "drifting") return 1;
  const fadeIn = T.durFadeIn > 0 ? smooth(w.age / T.durFadeIn) : (w.age >= 0 ? 1 : 0);
  const edge = edgeFade(w.sx, w.halfW);
  let a = fadeIn * edge * lerp(1, T.fogAlpha, w.fog) * flick;
  a *= 1 - TUNE.occludeDim * w.occ;
  if (w.k > 0) a = lerp(a, Math.max(a, TUNE.attendLift * fadeIn * Math.max(edge, 0.6)), w.k);
  return a;
}

// Moves a word and updates its rest screen position (sx, sy).
function moveWord(w, dt, windMps) {
  const attend = w.hover || w.focus || w.ghost;
  const tau = T.durHover / 1000 / 3; // ~95% of the way in --dur-hover
  w.k += ((attend ? 1 : 0) - w.k) * ease(dt, tau);
  const mul = 1 + (T.hoverSlow - 1) * w.k;
  w.age += dt * 1000;

  if (!w.measured && w.el.isConnected) {    // one layout read per word, ever
    w.measured = true;
    const ow = w.el.offsetWidth;
    if (ow > 0) w.halfW = ow / 2;
  }

  if (w.state === "drifting") {
    // A word that has your attention waits at the downwind edge instead of fading away.
    const edgeX = T.dir > 0 ? skyEdge - W * T.fadeEdge * 0.75 : W * T.fadeEdge * 0.75;
    const leaving = T.dir > 0 ? w.sx >= edgeX : w.sx <= edgeX;
    if (!(attend && leaving)) w.u += T.dir * windMps * w.jitter * mul * dt;
    w.t += dt * mul;
    w.sx = screenX(w);
    place(w, bob(w) + heat(w));
  } else if (w.state === "plucked" && T.durPluck > 0 && T.pluckAmp > 0) {
    // Held where the click found it (bob and heat frozen), vibrating vertically.
    const e = (performance.now() - w.pluckStart) / T.durPluck;
    const swing = e < 1 ? T.pluckAmp * (1 - e) * (1 - e) * Math.sin(TAU * T.pluckCycles * e) : 0;
    place(w, w.restOffset + swing);
  }
}

// A nearer word covering a farther one fades the farther one back; if the farther one
// has your attention (or is held), the nearer one fades instead. Screen-space boxes only.
function occlude() {
  for (const w of live) w.occ = 0;
  const n = live.length;
  for (let i = 0; i < n; i++) {
    const a = live[i];
    if (a.alpha < 0.05) continue;
    const ahw = Math.max(4, a.halfW - 0.5 * a.fontPx), ahh = 0.42 * a.fontPx;
    for (let j = i + 1; j < n; j++) {
      const b = live[j];
      if (b.alpha < 0.05) continue;
      const bhw = Math.max(4, b.halfW - 0.5 * b.fontPx), bhh = 0.42 * b.fontPx;
      const ox = ahw + bhw - Math.abs(a.sx - b.sx);
      if (ox <= 0) continue;
      const oy = ahh + bhh - Math.abs(a.sy - b.sy);
      if (oy <= 0) continue;
      let front = a.d <= b.d ? a : b, back = front === a ? b : a;
      if (attended(back) && !attended(front)) { const t = front; front = back; back = t; }
      else if (attended(back)) continue;
      const bw = back === a ? ahw : bhw, bh = back === a ? ahh : bhh;
      const cover = (Math.min(ox, 2 * bw) * Math.min(oy, 2 * bh)) / (4 * bw * bh);
      const o = clamp(cover * TUNE.occludeGain, 0, 1) * clamp(front.alpha * 1.4, 0, 1);
      if (o > back.occ) back.occ = o;
    }
  }
}

// Opacity, firelight and the strings.
function shadeWord(w, dt, fireLevel) {
  let flick = 1;
  if (fireLevel < 1) {
    const dx = w.pos.x - TUNE.firePos[0], dy = w.pos.y - TUNE.firePos[1], dz = w.pos.z - TUNE.firePos[2];
    const near = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / TUNE.fireReach;
    if (near > 0) flick = 1 - TUNE.fireDim * near * (1 - fireLevel);
  }

  w.alpha += (targetAlpha(w, flick) - w.alpha) * ease(dt, TUNE.alphaSmoothing);
  if (Math.abs(w.alpha - w.shown) > 0.004) {
    w.shown = w.alpha;
    w.el.style.opacity = w.alpha.toFixed(3);
  }

  // Strings shiver when a word crosses them.
  const strings = modules.strings;
  if (strings && w.state === "drifting") {
    if (w.hasPrev && w.alpha > 0.05) {
      try { strings.touch(w.prev, w.pos); } catch (e) { /* a module must not stop the words */ }
    }
    w.prev.copy(w.pos);
    w.hasPrev = true;
  }
}

/* ---------- catch and release ---------- */

function pluck(w) {
  if (holding || w.state !== "drifting" || !onScreen[w.id]) return;
  holding = w;
  clearGhost();
  // Freeze the word exactly where it is, bob and warm-air lift included.
  w.restOffset = H / 2 - w.sy - (0.5 - w.yf) * H;
  w.state = "plucked";
  w.pluckStart = performance.now();
  w.el.classList.add("is-plucked");

  if (modules.strings && !reduced) {
    try { modules.strings.pluckNearest(w.pos, lerp(1, 0.55, w.fog)); } catch (e) { /* ignore */ }
  }

  if (T.durPluck > 0) pluckTimer = setTimeout(() => finishPluck(w), T.durPluck);
  else finishPluck(w);
}

function finishPluck(w) {
  pluckTimer = 0;
  if (holding !== w || w.state !== "plucked") return;
  w.state = "caught";
  w.el.classList.remove("is-plucked");
  w.el.classList.add("is-caught");
  root.setAttribute("data-holding", "true");
  w.alpha = Math.max(w.alpha, 0.6);
  w.shown = w.alpha;
  w.el.style.opacity = w.alpha.toFixed(3);
  // At rest, no vibration offset. Push the transform to the DOM before measuring.
  place(w, w.restOffset);
  css.render(scene, camera);
  const rect = w.el.getBoundingClientRect();
  document.dispatchEvent(new CustomEvent("word:catch", { detail: { id: w.id, rect } }));
}

function onRelease(ev) {
  const id = ev && ev.detail ? ev.detail.id : null;
  const w = holding;
  if (!w || w.id !== id) { pendingSwitch = null; return; }
  if (pluckTimer) { clearTimeout(pluckTimer); pluckTimer = 0; }
  holding = null;
  w.state = "drifting";
  w.hasPrev = false;      // no phantom string crossing from the held spot
  w.el.classList.remove("is-plucked", "is-caught");
  root.removeAttribute("data-holding");
  clearGhost();

  const next = pendingSwitch;
  pendingSwitch = null;
  if (next && next !== w && onScreen[next.id]) {
    // The click that closed the card was on another word: catch that one next. Deferred,
    // so the card finishes handling its own close before the new catch arrives.
    setTimeout(() => {
      if (holding || !onScreen[next.id] || next.state !== "drifting") return;
      try { next.el.focus({ preventScroll: true }); } catch (e) { next.el.focus(); }
      next.focus = false;           // a click, not keyboard attention
      pluck(next);
    }, 0);
    return;
  }
  try { w.el.focus({ preventScroll: true }); } catch (e) { w.el.focus(); }
}

// The live word whose button is under a viewport point, seen through the card's backdrop
// (and only through the backdrop: a word under the card itself does not count).
function wordAtPoint(x, y) {
  if (!document.elementsFromPoint) return null;
  const els = document.elementsFromPoint(x, y);
  if (!els.length || !els[0].classList || !els[0].classList.contains("card-root__backdrop")) return null;
  for (let i = 1; i < els.length; i++) {
    const el = els[i];
    if (el.classList && el.classList.contains("spark")) {
      const w = onScreen[el.getAttribute("data-id")];
      if (w && w.el === el) return w;
    }
  }
  return null;
}

// A click while a card is open lands on the card's backdrop. If it is over another word,
// remember that word: the card's own handler closes the card (word:release) right after.
function onClickCapture(ev) {
  pendingSwitch = null;
  if (!holding || holding.state !== "caught") return;
  const t = ev.target;
  if (!t || !t.classList || !t.classList.contains("card-root__backdrop")) return;
  const w = wordAtPoint(ev.clientX, ev.clientY);
  if (w && w !== holding && w.state === "drifting") pendingSwitch = w;
}

function clearGhost() {
  if (ghost) { ghost.ghost = false; ghost.el.classList.remove("is-hinted"); }
  ghost = null;
}

// While a card is open the backdrop hides the words from the pointer, so the scene finds
// the word under it itself (on pointer moves, and now and then while the pointer rests).
function updateGhost() {
  if (!holding || holding.state !== "caught" || pointerPx < 0) { if (ghost) clearGhost(); return; }
  if (!hitDirty && clock - hitAt < TUNE.hoverHitEvery) return;
  hitDirty = false;
  hitAt = clock;
  const w = wordAtPoint(pointerPx, pointerPy);
  const next = w && w !== holding && w.state === "drifting" ? w : null;
  if (next === ghost) return;
  clearGhost();
  if (next) { next.ghost = true; next.el.classList.add("is-hinted"); ghost = next; }
}

/* ---------- gusts: themed clusters riding in together ---------- */

function gustDefs() {
  const g = Iskry.GUSTS;
  return Array.isArray(g) ? g : [];
}

function freeIds(def) {
  const out = [];
  if (!def || !Array.isArray(def.ids)) return out;
  for (const id of def.ids) {
    const data = poolById[id];
    if (data && !onScreen[id] && !data.rare && weightOf(id) > 0 && out.indexOf(data) < 0) out.push(data);
  }
  return out;
}

function startGust() {
  const choices = [];
  for (const def of gustDefs()) {
    if (!def || typeof def.id !== "string") continue;
    const free = freeIds(def);
    if (free.length >= TUNE.gustMinWords) choices.push({ def, free });
  }
  if (choices.length > 1) {
    for (let i = choices.length - 1; i >= 0; i--) if (choices[i].def.id === lastGustId) choices.splice(i, 1);
  }
  if (!choices.length) { nextGustAt = clock + randIn(TUNE.gustEvery); return; }
  const { def, free } = choices[Math.floor(Math.random() * choices.length)];
  lastGustId = def.id;

  // Pick the words by memory weight, without replacement.
  const n = Math.min(free.length, Math.round(randIn(TUNE.gustWords)));
  const queue = [];
  const ws = free.map((d) => weightOf(d.id));
  for (let k = 0; k < n; k++) {
    let total = 0;
    for (const v of ws) total += v;
    let r = Math.random() * total, i = 0;
    for (; i < ws.length - 1; i++) { r -= ws[i]; if (r <= 0) break; }
    queue.push(free[i]);
    free.splice(i, 1);
    ws.splice(i, 1);
  }

  const spread = TUNE.gustSpread;
  const dC = depthAt(rand(0.12, 0.55));
  const yC = rand(TUNE.bandTop + spread, TUNE.bandBottom - spread);
  gust = {
    id: def.id, queue, nextAt: clock, dC, yC,
    jitter: 1 + rand(-TUNE.speedJitter, TUNE.speedJitter) * 0.6,
    endAt: Infinity
  };
  if (typeof def.label === "string" && def.label.trim()) addWhisper(def.label.trim(), gust);
}

function stepGust() {
  if (!gust) {
    if (clock >= nextGustAt) startGust();
    return;
  }
  if (gust.queue.length) {
    if (clock < gust.nextAt) return;
    const data = gust.queue.shift();
    if (!onScreen[data.id]) {
      const spread = TUNE.gustSpread;
      const x0 = upwindX(estimateHalfWidth(data.pl, fontAt(gust.dC)));
      spawn(null, 0, {
        data, gust,
        d: clamp(gust.dC * rand(0.86, 1.16), T.depthNear, T.depthFar),
        yf: pickHeight(x0, Math.max(TUNE.bandTop, gust.yC - spread), Math.min(TUNE.bandBottom, gust.yC + spread)),
        jitter: gust.jitter * (1 + rand(-0.04, 0.04)),
        lead: rand(0, 60)
      });
    }
    gust.nextAt = clock + randIn(TUNE.gustGap);
    if (!gust.queue.length) gust.endAt = clock + TUNE.gustLinger;
    return;
  }
  if (clock >= gust.endAt) {
    gust = null;
    nextGustAt = clock + randIn(TUNE.gustEvery);
  }
}

// The gust's label: a faint, non-interactive line of English drifting ahead of its words.
function addWhisper(text, g) {
  const el = document.createElement("div");
  el.className = "scene__whisper";
  el.setAttribute("aria-hidden", "true");
  el.textContent = text;
  const d = clamp(g.dC * 1.04, T.depthNear, T.depthFar);
  const fontPx = Math.max(TUNE.whisperMinPx, fontAt(d) * TUNE.whisperSize);
  el.style.fontSize = fontPx.toFixed(2) + "px";
  el.style.opacity = "0";
  const obj = new CSS3DSprite(el);
  obj.scale.setScalar(d / focal);
  const halfW = text.length * fontPx * 0.26 + 10;
  const x = upwindX(halfW) + T.dir * 40;
  const yf = clamp(g.yC - TUNE.gustSpread - 0.045, TUNE.bandTop * 0.6, TUNE.bandBottom);
  const s = { el, obj, d, halfW, u: uAtScreenX(x, d), yf, sx: x, age: 0, alpha: 0, shown: -1, jitter: g.jitter };
  const up = ((0.5 - yf) * H * d) / focal;
  obj.position.set(camPos0.x + camFwd.x * d + s.u, camPos0.y + camFwd.y * d + camUp.y * up, camPos0.z + camFwd.z * d + camUp.z * up);
  whispers.push(s);
  scene.add(obj);
}

function stepWhispers(dt, windMps) {
  for (let i = whispers.length - 1; i >= 0; i--) {
    const s = whispers[i];
    s.age += dt;
    s.u += T.dir * windMps * s.jitter * dt;
    s.sx = W / 2 + (s.u * focal) / s.d;
    const up = ((0.5 - s.yf) * H * s.d) / focal;
    s.obj.position.set(camPos0.x + camFwd.x * s.d + s.u, camPos0.y + camFwd.y * s.d + camUp.y * up, camPos0.z + camFwd.z * s.d + camUp.z * up);
    const a = TUNE.whisperAlpha * smooth(s.age / 5) * edgeFade(s.sx, s.halfW) * (holding ? 0.5 : 1);
    s.alpha += (a - s.alpha) * ease(dt, 0.8);
    if (Math.abs(s.alpha - s.shown) > 0.004) { s.shown = s.alpha; s.el.style.opacity = s.alpha.toFixed(3); }
    const gone = T.dir > 0 ? s.sx > W + s.halfW + 30 : s.sx < -(s.halfW + 30);
    if (gone) {
      whispers.splice(i, 1);
      scene.remove(s.obj);
      if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    }
  }
}

/* ---------- spawning ---------- */

function targetCount() {
  return Math.min(pool.length, Math.round((T.wordsMin + T.wordsMax) / 2));
}

// Seconds between spawns that keep about targetCount() words on screen.
function spawnInterval() {
  const midDepth = Math.sqrt(T.depthNear * T.depthFar);
  const pxPerSec = Math.max(1, (T.wind * T.depthNear) / midDepth);
  return (W * 1.1) / pxPerSec / Math.max(1, Math.round((T.wordsMin + T.wordsMax) / 2));
}

function maybeSpawn() {
  if (clock < nextSpawnAt) return;
  if (gust && gust.queue.length) { nextSpawnAt = clock + 0.5; return; }   // the gust has the sky
  const n = live.length;
  const cap = Math.min(T.wordsMax, pool.length);
  if (n >= cap) { nextSpawnAt = clock + 0.5; return; }
  const interval = spawnInterval();
  const gap = n < Math.min(T.wordsMin, pool.length)
    ? Math.max(TUNE.minSpawnGap / 1000, interval * 0.3)
    : interval * rand(0.6, 1.4);
  nextSpawnAt = clock + (spawn(null, 0) ? gap : 0.5);
}

// The night starts already full: words spread across the width, fading in one by one.
function populate() {
  const n = targetCount();
  const slots = [];
  for (let i = 0; i < n; i++) slots.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
  }
  for (let i = 0; i < n; i++) {
    const x = W * lerp(0.05, 0.95, (slots[i] + Math.random()) / n);
    if (!spawn(x, -i * 110)) break;
  }
  nextSpawnAt = spawnInterval() * rand(0.3, 0.8);
  nextGustAt = new URLSearchParams(location.search).has("gust") ? 4 : randIn(TUNE.gustFirst);
}

/* ---------- loop ---------- */

function frame(now) {
  rafId = 0;
  const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
  lastNow = now;
  clock += dt;

  // One wind for everything, in metres per second. Its strength wanders slowly, and
  // swells a little while a gust passes.
  const swellGoal = gust && clock < gust.endAt && T.gust > 0 ? 1 : 0;
  swell += (swellGoal - swell) * ease(dt, TUNE.gustSwellEase);
  const wander = 1 + T.gust * (0.6 * Math.sin(TAU * clock / TUNE.windPeriodA) +
                               0.4 * Math.sin(TAU * clock / TUNE.windPeriodB + 1.3));
  const windMps = (T.wind * T.depthNear / focal) * wander * (1 + TUNE.gustSwell * swell);

  updateCamera(dt);
  skyEdge += (skyEdgeGoal - skyEdge) * ease(dt, TUNE.journalEase);

  let fireLevel = 1;
  for (const name in modules) {
    const m = modules[name];
    if (!m) continue;
    try { m.update(clock, dt); } catch (e) { /* a module must not stop the words */ }
  }
  if (modules.fire && modules.fire.intensity && T.flicker > 0) {
    try { fireLevel = clamp(Number(modules.fire.intensity()), 0, 1); } catch (e) { fireLevel = 1; }
    if (!isFinite(fireLevel)) fireLevel = 1;
  }

  updateGhost();
  for (let i = 0; i < live.length; i++) moveWord(live[i], dt, windMps);
  occlude();
  for (let i = live.length - 1; i >= 0; i--) {
    const w = live[i];
    shadeWord(w, dt, fireLevel);
    const gone = T.dir > 0 ? w.sx > W + w.halfW + 30 : w.sx < -(w.halfW + 30);
    if (gone && w.state === "drifting" && !w.hover && !w.focus) removeWord(i);
  }
  stepWhispers(dt, windMps);
  stepGust();
  stepTimeOfDay();
  maybeSpawn();

  if (gl) gl.render(scene, camera);
  css.render(scene, camera);
  start();
}

function start() {
  if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame);
}

function stop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  lastNow = 0;
}

function onResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    measure();
  });
}

function onMotionChange() {
  readTokens();
  measure();
  loadModules();   // the modules take reducedMotion at creation, so rebuild them
}

function onPointerMove(ev) {
  pointerX = clamp((ev.clientX / W) * 2 - 1, -1, 1);
  pointerY = clamp((ev.clientY / H) * 2 - 1, -1, 1);
  pointerPx = ev.clientX;
  pointerPy = ev.clientY;
  hitDirty = true;
}

/* ---------- init ---------- */

export function init(rootEl, words) {
  if (root || !rootEl) return;
  const worldEl = rootEl.querySelector("#scene-world");
  const wordsEl = rootEl.querySelector("#scene-words");
  if (!worldEl || !wordsEl) return;
  root = rootEl;
  worldLayer = worldEl;
  wordsLayer = wordsEl;

  (words || []).forEach((w) => {
    if (w && typeof w.id === "string" && typeof w.pl === "string" && w.pl && !poolById[w.id]) {
      poolById[w.id] = w;
      pool.push(w);
    }
  });

  mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  readTokens();
  buildStage();
  measure();
  loadModules();
  populate();
  watchJournal();

  if (mq && mq.addEventListener) mq.addEventListener("change", onMotionChange);
  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { pointerPx = -1; hitDirty = true; });
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop(); else start();
  });
  document.addEventListener("word:release", onRelease);
  // A word that turns golden while it is on screen shows it straight away.
  document.addEventListener("memory:change", (ev) => {
    const id = ev && ev.detail ? ev.detail.id : null;
    const list = id ? (onScreen[id] ? [onScreen[id]] : []) : live;
    for (const w of list) w.el.classList.toggle("is-golden", isGolden(w.id));
  });
  start();
}

Iskry.scene = { init };
Iskry.scene._dbg = () => ({ skyEdge, skyEdgeGoal, jp: !!journalPanel, occ: live.filter((w) => w.occ > 0.01).map((w) => w.id + ":" + w.occ.toFixed(2) + " d" + w.d.toFixed(1)), ghost: ghost && ghost.id, pointerPx, pointerPy, hitDirty, hitAt, clock, holding: holding && holding.state });
