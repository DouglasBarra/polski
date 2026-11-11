/*
  OWNER: director. The core of the scene. CONTRACT.md is the source of truth; this header
  repeats the parts that matter here.

  INTERFACE
    import { init } from "./js/scene.js";   (also exposed as Iskry.scene.init)
    init(rootEl, words)
      rootEl  the #scene element with its two layers (#scene-world, #scene-words).
      words   Iskry.WORDS. May be short: a word is never shown twice at once, and the
              night simply holds fewer words when there are fewer than --words-min.

  WHAT IT DOES
    One THREE.Scene and one PerspectiveCamera, drawn by two renderers that share them:
      WebGLRenderer  -> #scene-world  the night. The environment lives in plug-in modules
                        (js/scene/fire.js, strings.js, sky.js; interface in CONTRACT.md).
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

  EVENTS (on document)
    dispatch  word:catch   { id, rect }  when the pluck ends (straight away if --dur-pluck is 0)
    listen    word:release { id }        unknown or stale ids are ignored

  MOTION
    One requestAnimationFrame loop, paused while document.hidden. Tokens are read at init
    and when reduced motion changes (the environment modules are then rebuilt).
    Look-and-feel knobs that are not tokens live in TUNE below.

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
  fireDim: 0.16,               // how much a word next to the fire dims when the fire dips
  firePos: [-3, 0, -2],        // left of centre, so the embers blow across the middle
  stringExtents: { xMin: -22, xMax: 22, yMin: 1.5, yMax: 10, zMin: -14, zMax: 2 },
  fogNear: 14,                 // used until sky.js suggests its own
  fogFar: 70,
  maxPixelRatio: 2
};

let root, worldLayer, wordsLayer;
let scene, camera, gl = null, css;
const camPos0 = new THREE.Vector3(), camFwd = new THREE.Vector3(), camUp = new THREE.Vector3();
const camOffset = new THREE.Vector3(), camGoal = new THREE.Vector3();
let focal = 1;               // px: a 1 m object 1 m away is this many px
let pointerX = 0, pointerY = 0;

const pool = [];             // valid word objects from the dataset
const live = [];             // word states on screen
const onScreen = Object.create(null); // id -> state
const modules = { fire: null, strings: null, sky: null };
let modulesEpoch = 0;
let T = {};                  // tokens
let mq = null, reduced = false;
let W = 1, H = 1;
let rafId = 0, lastNow = 0, clock = 0;
let nextSpawnAt = 0;         // in clock seconds
let holding = null;          // the word from click until word:release
let pluckTimer = 0;
let resizeQueued = false;

/* ---------- helpers ---------- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
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
  for (const name in modules) {
    const m = modules[name];
    if (m && m.resize) { try { m.resize(W, H); } catch (e) { /* a module must not stop the words */ } }
  }
  for (const w of live) w.obj.scale.setScalar(w.d / focal);
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
    if (name === "sky") applyFog(handle);
  } catch (e) {
    console.warn("Iskry: scene module \"" + name + "\" is unavailable.", e);
  }
}

function loadModules() {
  // ?bare=1 shows the core alone (words over the CSS night), for tuning and debugging.
  if (!gl || new URLSearchParams(location.search).has("bare")) return;
  const epoch = ++modulesEpoch;
  disposeModules();
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  // Sky first, so it is behind everything that is added later.
  loadModule("sky", "createSky", { horizonY: 0, radius: 90 }, epoch)
    .then(() => Promise.all([
      loadModule("strings", "createStrings", {
        count: Math.max(1, Math.round(Number(readToken("--strings-count", 6)) || 6)),
        extents: Object.assign({}, TUNE.stringExtents)
      }, epoch),
      loadModule("fire", "createFire", { position: v(TUNE.firePos), scale: 1 }, epoch)
    ]));
}

// The sky suggests a fog; the core applies it to WebGL and to the far words' color.
function applyFog(sky) {
  if (!sky || !sky.fogColor || !sky.fogColor.isColor) return;
  scene.fog.color.copy(sky.fogColor);
  if (sky.fogNear > 0) scene.fog.near = sky.fogNear;
  if (sky.fogFar > scene.fog.near) scene.fog.far = sky.fogFar;
  root.style.setProperty("--scene-fog", "#" + sky.fogColor.getHexString());
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
    const wt = weightOf(w.id);
    if (wt <= 0) continue;
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

// The height (fraction of the viewport) farthest from the words already near screen x.
function pickHeight(x) {
  let best = 0.3, bestScore = -1;
  for (let t = 0; t < TUNE.spawnTries; t++) {
    const yf = rand(TUNE.bandTop, TUNE.bandBottom);
    let score = 1;
    for (const o of live) {
      if (Math.abs(screenX(o) - x) > W * TUNE.spawnNearX) continue;
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

// x: rest screen x to appear at, or null to enter from the upwind edge.
function spawn(x, ageMs) {
  const data = pickWord();
  if (!data) return null;

  // Log-uniform depth: sizes are spread evenly between the smallest and the largest.
  const far = Math.pow(Math.random(), 1 / TUNE.depthBias);       // 0 near .. 1 far
  const d = T.depthNear * Math.pow(T.depthFar / T.depthNear, far);
  const fog = T.depthFar > T.depthNear ? (d - T.depthNear) / (T.depthFar - T.depthNear) : 0;
  const fontPx = Math.max(T.sizeMin, (T.sizeMax * T.depthNear) / d);
  const halfW = estimateHalfWidth(data.pl, fontPx);
  if (x == null) x = T.dir > 0 ? -(halfW + 24) : W + halfW + 24;

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

  const w = {
    id: data.id,
    el, obj,
    d, fog, halfW, measured: false,
    u: uAtScreenX(x, d),
    yf: pickHeight(x),
    jitter: 1 + rand(-TUNE.speedJitter, TUNE.speedJitter),
    t: Math.random() * 60,
    p1: rand(T.bobPMin, T.bobPMax),
    p2: rand(T.bobPMin, T.bobPMax) * 0.57,
    ph1: Math.random() * TAU,
    ph2: Math.random() * TAU,
    mix: rand(0.6, 0.8),
    age: ageMs || 0,
    alpha: 0, shown: -1,
    k: 0,                // eased hover/focus amount, 0..1
    hover: false, focus: false,
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
  place(w, 0);
  scene.add(obj);
  return w;
}

function removeWord(i) {
  const w = live[i];
  live.splice(i, 1);
  delete onScreen[w.id];
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

function place(w, offsetPx) {
  // Screen px above the middle of the viewport, turned into metres at this depth.
  const v = (((0.5 - w.yf) * H + bob(w) + offsetPx) * w.d) / focal;
  w.pos.set(
    camPos0.x + camFwd.x * w.d + w.u,
    camPos0.y + camFwd.y * w.d + camUp.y * v,
    camPos0.z + camFwd.z * w.d + camUp.z * v
  );
}

function targetAlpha(w, sx, flick) {
  if (w.state !== "drifting") return 1;
  const fadeIn = T.durFadeIn > 0 ? smooth(w.age / T.durFadeIn) : (w.age >= 0 ? 1 : 0);
  const span = T.fadeEdge * W, pad = 0.03 * W;
  const edge = smooth((sx + pad) / span) * smooth((W + pad - sx) / span);
  let a = fadeIn * edge * lerp(1, T.fogAlpha, w.fog) * flick;
  if (w.k > 0) a = lerp(a, Math.max(a, TUNE.attendLift * fadeIn * Math.max(edge, 0.6)), w.k);
  return a;
}

function stepWord(w, dt, windMps, fireLevel) {
  const attend = w.hover || w.focus;
  const tau = T.durHover / 1000 / 3; // ~95% of the way in --dur-hover
  w.k += ((attend ? 1 : 0) - w.k) * ease(dt, tau);
  const mul = 1 + (T.hoverSlow - 1) * w.k;
  w.age += dt * 1000;

  if (!w.measured && w.el.isConnected) {    // one layout read per word, ever
    w.measured = true;
    const ow = w.el.offsetWidth;
    if (ow > 0) w.halfW = ow / 2;
  }

  let sx = screenX(w);
  if (w.state === "drifting") {
    // A word that has your attention waits at the downwind edge instead of fading away.
    const edgeX = T.dir > 0 ? W * (1 - T.fadeEdge * 0.75) : W * T.fadeEdge * 0.75;
    const leaving = T.dir > 0 ? sx >= edgeX : sx <= edgeX;
    if (!(attend && leaving)) w.u += T.dir * windMps * w.jitter * mul * dt;
    w.t += dt * mul;
    sx = screenX(w);
  }

  let offset = 0;
  if (w.state === "plucked" && T.durPluck > 0 && T.pluckAmp > 0) {
    const e = (performance.now() - w.pluckStart) / T.durPluck;
    if (e < 1) offset = T.pluckAmp * (1 - e) * (1 - e) * Math.sin(TAU * T.pluckCycles * e);
  }
  place(w, offset);

  // Words near the fire breathe very slightly with its flicker.
  let flick = 1;
  if (fireLevel < 1) {
    const dx = w.pos.x - TUNE.firePos[0], dy = w.pos.y - TUNE.firePos[1], dz = w.pos.z - TUNE.firePos[2];
    const near = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / TUNE.fireReach;
    if (near > 0) flick = 1 - TUNE.fireDim * near * (1 - fireLevel);
  }

  w.alpha += (targetAlpha(w, sx, flick) - w.alpha) * ease(dt, TUNE.alphaSmoothing);
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
  return sx;
}

/* ---------- catch and release ---------- */

function pluck(w) {
  if (holding || w.state !== "drifting" || !onScreen[w.id]) return;
  holding = w;
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
  place(w, 0);
  css.render(scene, camera);
  const rect = w.el.getBoundingClientRect();
  document.dispatchEvent(new CustomEvent("word:catch", { detail: { id: w.id, rect } }));
}

function onRelease(ev) {
  const id = ev && ev.detail ? ev.detail.id : null;
  const w = holding;
  if (!w || w.id !== id) return;
  if (pluckTimer) { clearTimeout(pluckTimer); pluckTimer = 0; }
  holding = null;
  w.state = "drifting";
  w.hasPrev = false;      // no phantom string crossing from the held spot
  w.el.classList.remove("is-plucked", "is-caught");
  root.removeAttribute("data-holding");
  try { w.el.focus({ preventScroll: true }); } catch (e) { w.el.focus(); }
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
}

/* ---------- loop ---------- */

function frame(now) {
  rafId = 0;
  const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
  lastNow = now;
  clock += dt;

  // One wind for everything, in metres per second. Its strength wanders slowly.
  const gust = 1 + T.gust * (0.6 * Math.sin(TAU * clock / TUNE.windPeriodA) +
                             0.4 * Math.sin(TAU * clock / TUNE.windPeriodB + 1.3));
  const windMps = (T.wind * T.depthNear / focal) * gust;

  updateCamera(dt);

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

  for (let i = live.length - 1; i >= 0; i--) {
    const w = live[i];
    const sx = stepWord(w, dt, windMps, fireLevel);
    const gone = T.dir > 0 ? sx > W + w.halfW + 30 : sx < -(w.halfW + 30);
    if (gone && w.state === "drifting" && !w.hover && !w.focus) removeWord(i);
  }
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

  const seen = Object.create(null);
  (words || []).forEach((w) => {
    if (w && typeof w.id === "string" && typeof w.pl === "string" && w.pl && !seen[w.id]) {
      seen[w.id] = true;
      pool.push(w);
    }
  });

  mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  readTokens();
  buildStage();
  measure();
  loadModules();
  populate();

  if (mq && mq.addEventListener) mq.addEventListener("change", onMotionChange);
  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop(); else start();
  });
  document.addEventListener("word:release", onRelease);
  start();
}

Iskry.scene = { init };
