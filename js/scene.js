/*
  OWNER: scene agent (this file, plus the SCENE section of css/main.css).
  CONTRACT.md is the source of truth; this header repeats the parts that matter here.

  INTERFACE
    Iskry.scene.init(rootEl, words)
      rootEl  the #scene element with its three layers (#scene-strings, #scene-words,
              #scene-fire). Children are only ever added to those layers.
      words   Iskry.WORDS. May be short: a word is never shown twice at once, and the
              sky simply holds fewer words when there are fewer than --words-min.

  WHAT IT DRAWS
    #scene-fire     three layered radial glows (CSS flicker) and a faint film grain.
    #scene-strings  one SVG with --strings-count faint lines. A word drifting through a
                    line makes it shiver: a damped standing wave over --dur-shiver.
    #scene-words    <button type="button" class="spark" data-id lang="pl"
                    aria-label="{pl}" data-pl="{pl}">{pl}</button>
                    data-pl feeds the bright ::after overlay, so hover brightening is an
                    opacity change only. aria-label keeps the name to the word itself.

  EVENTS (on document)
    dispatch  word:catch   { id, rect }  when the pluck ends (straight away if --dur-pluck is 0)
    listen    word:release { id }        unknown or stale ids are ignored

  MOTION
    One requestAnimationFrame loop, paused while document.hidden. Words move with
    transform and opacity only. Tokens are read at init and when reduced motion changes.
    Layout fractions and other look-and-feel knobs live in TUNE below.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var TAU = Math.PI * 2;

  // Look-and-feel knobs that are not design tokens. Fractions are of the viewport.
  var TUNE = {
    spawnTop: 0.83,         // words appear between these heights (just above the fire)
    spawnBottom: 0.9,
    climbBase: 0.87,        // the climb is measured from here...
    climbTop: 0.04,         // ...to here, where a word has fully faded
    spawnMarginX: 0.07,     // keep spawns this far from the side edges
    spawnTries: 6,          // candidate x positions tried to avoid crowding
    depthAlphaMin: 0.55,    // far words are this bright, near words 1
    depthSpeedShare: 0.5,   // how much of the speed spread comes from depth (parallax)
    alphaSmoothing: 0.3,    // s, time constant easing every opacity change
    attendLift: 0.95,       // a hovered or focused word brightens to at least this
    attendStopAt: 0.9,      // a hovered or focused word stops climbing at this fraction
    windMax: 7,             // px/s, slow global breeze (off when --sway-amplitude is 0)
    windPeriodA: 47,        // s, the two sines that make the breeze wander
    windPeriodB: 29,
    minSpawnGap: 650,       // ms, never spawn faster than this while catching up
    stringsTop: 0.13,       // the strings cross the sky between these heights
    stringsBottom: 0.7,
    stringTilt: -0.035,     // base slope of the strings (negative rises to the right)
    stringFan: 0.012,       // extra slope per string, so they fan like a guitar neck
    stringPoints: 48,       // path vertices per string
    stringFreq: 5.2,        // Hz, base visible shiver frequency
    stringModes: 4,         // standing-wave modes summed per excitation
    stringHysteresis: 2,    // px a word must be past a string before it counts as a side
    stringMaxExcite: 4,     // simultaneous excitations kept per string
    answerAmp: 0.6,         // nearest-string answer to a pluck, times --shiver-amplitude
    answerReach: 0.25       // ...only if the string is within this fraction of the height
  };

  var root, wordsLayer, stringsLayer, fireLayer, svg;
  var pool = [];            // valid word objects from the dataset
  var live = [];            // word states on screen
  var onScreen = Object.create(null); // id -> state
  var strings = [];
  var T = {};               // tokens
  var mq = null;
  var reduced = false;
  var W = 0, H = 0;
  var rafId = 0, lastNow = 0, clock = 0;
  var nextSpawnAt = 0;      // in clock seconds
  var holding = null;       // the word from click until word:release
  var pluckTimer = 0;
  var resizeQueued = false;

  /* ---------- helpers ---------- */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function ease(dt, tau) { return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau); }

  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    function num(name, fallback) {
      var v = parseFloat(cs.getPropertyValue(name));
      return isFinite(v) ? v : fallback;
    }
    T = {
      riseMin: num("--rise-speed-min", 12),
      riseMax: num("--rise-speed-max", 28),
      swayAmp: num("--sway-amplitude", 18),
      swayPMin: num("--sway-period-min", 6000) / 1000,
      swayPMax: num("--sway-period-max", 11000) / 1000,
      hoverSlow: num("--hover-slow-factor", 0.2),
      durHover: num("--dur-hover", 600),
      durPluck: num("--dur-pluck", 520),
      durShiver: num("--dur-shiver", 900),
      durFadeIn: num("--dur-fade-in", 2400),
      pluckAmp: num("--pluck-amplitude", 5),
      pluckCycles: num("--pluck-cycles", 7),
      fadeStart: clamp(num("--fade-start", 0.55), 0, 0.99),
      shiverAmp: num("--shiver-amplitude", 3),
      wordsMin: Math.max(0, Math.round(num("--words-min", 15))),
      wordsMax: Math.max(1, Math.round(num("--words-max", 25))),
      stringsCount: Math.max(0, Math.round(num("--strings-count", 6)))
    };
    if (T.wordsMax < T.wordsMin) T.wordsMax = T.wordsMin;
    if (T.swayPMin <= 0) T.swayPMin = 6;
    if (T.swayPMax < T.swayPMin) T.swayPMax = T.swayPMin;
    reduced = !!(mq && mq.matches);
  }

  function weightOf(id) {
    var w = 1;
    try { w = Iskry.memory && Iskry.memory.weight ? Number(Iskry.memory.weight(id)) : 1; } catch (e) { w = 1; }
    return isFinite(w) && w > 0 ? w : 0;
  }

  function isGolden(id) {
    try { return !!(Iskry.memory && Iskry.memory.isGolden && Iskry.memory.isGolden(id)); } catch (e) { return false; }
  }

  function focusVisible(el) {
    try { return el.matches(":focus-visible"); } catch (e) { return true; }
  }

  /* ---------- fire ---------- */

  function buildFire() {
    var names = ["wide", "body", "core"];
    for (var i = 0; i < names.length; i++) {
      var g = document.createElement("div");
      g.className = "scene__glow scene__glow--" + names[i];
      fireLayer.appendChild(g);
    }
    var grain = document.createElement("div");
    grain.className = "scene__grain";
    fireLayer.appendChild(grain);
  }

  /* ---------- strings ---------- */

  function buildStrings() {
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "scene__strings-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("focusable", "false");
    stringsLayer.appendChild(svg);
    layoutStrings();
  }

  function layoutStrings() {
    var n = T.stringsCount;
    // Keep each string's jitter stable across resizes.
    while (strings.length < n) {
      var base = document.createElementNS(SVG_NS, "path");
      base.setAttribute("class", "scene__string");
      var bright = document.createElementNS(SVG_NS, "path");
      bright.setAttribute("class", "scene__string scene__string--bright");
      bright.style.opacity = "0";
      svg.appendChild(base);
      svg.appendChild(bright);
      strings.push({ base: base, bright: bright, jitter: rand(-0.35, 0.35), ex: [], active: false });
    }
    while (strings.length > n) {
      var s = strings.pop();
      svg.removeChild(s.base);
      svg.removeChild(s.bright);
    }
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var pts = TUNE.stringPoints;
    for (var i = 0; i < strings.length; i++) {
      var st = strings[i];
      var f = (i + 0.5 + st.jitter) / Math.max(1, n);
      st.yc = H * lerp(TUNE.stringsTop, TUNE.stringsBottom, f);
      st.slope = TUNE.stringTilt + (i - (n - 1) / 2) * TUNE.stringFan;
      st.x0 = -24;
      st.x1 = W + 24;
      var len = Math.sqrt(1 + st.slope * st.slope);
      st.nx = -st.slope / len; // unit normal
      st.ny = 1 / len;
      // Static per-vertex mode shapes sin(n*pi*u).
      st.shape = [];
      for (var k = 0; k <= pts; k++) {
        var u = k / pts, row = [];
        for (var m = 1; m <= TUNE.stringModes; m++) row.push(Math.sin(m * Math.PI * u));
        st.shape.push(row);
      }
      st.ex.length = 0;
      drawString(st, null);
    }
  }

  function lineY(st, x) { return st.yc + st.slope * (x - W / 2); }

  function excite(st, x, amp) {
    if (!(T.shiverAmp > 0) || !(T.durShiver > 0) || amp <= 0) return;
    var u0 = clamp((x - st.x0) / (st.x1 - st.x0), 0.02, 0.98);
    var w = [];
    for (var m = 1; m <= TUNE.stringModes; m++) w.push(Math.sin(m * Math.PI * u0) / m);
    if (st.ex.length >= TUNE.stringMaxExcite) st.ex.shift();
    st.ex.push({ t0: clock, amp: amp, w: w, ph: Math.random() * TAU });
    st.active = true;
  }

  function drawString(st, disp) {
    var pts = TUNE.stringPoints, d = "";
    for (var k = 0; k <= pts; k++) {
      var x = st.x0 + (st.x1 - st.x0) * (k / pts);
      var y = lineY(st, x);
      var o = disp ? disp[k] : 0;
      d += (k ? "L" : "M") + (x + st.nx * o).toFixed(1) + " " + (y + st.ny * o).toFixed(2);
      if (!disp) { // a straight line needs only its two ends
        x = st.x1; y = lineY(st, x);
        d += "L" + x.toFixed(1) + " " + y.toFixed(2);
        break;
      }
    }
    st.base.setAttribute("d", d);
    st.bright.setAttribute("d", d);
  }

  var dispBuf = [];
  function updateStrings() {
    var D = T.durShiver / 1000;
    for (var i = 0; i < strings.length; i++) {
      var st = strings[i];
      if (!st.active) continue;
      // Drop excitations that have rung out.
      for (var e = st.ex.length - 1; e >= 0; e--) {
        if (D <= 0 || clock - st.ex[e].t0 > D) st.ex.splice(e, 1);
      }
      if (!st.ex.length) {
        st.active = false;
        drawString(st, null);
        st.bright.style.opacity = "0";
        continue;
      }
      var pts = TUNE.stringPoints, energy = 0;
      // Per-mode coefficient summed over excitations, then shaped per vertex.
      var coef = [];
      for (var m = 0; m < TUNE.stringModes; m++) coef[m] = 0;
      for (e = 0; e < st.ex.length; e++) {
        var ex = st.ex[e], t = clock - ex.t0;
        var env0 = Math.exp(-3 * t / D);
        energy += ex.amp * env0;
        for (m = 0; m < TUNE.stringModes; m++) {
          var n = m + 1;
          var env = Math.exp(-(3 + n) * t / D);  // higher modes die sooner
          var f = TUNE.stringFreq * (0.8 + 0.4 * n);
          coef[m] += 0.75 * ex.amp * ex.w[m] * env * Math.cos(TAU * f * t + ex.ph * (n - 1));
        }
      }
      for (var k = 0; k <= pts; k++) {
        var row = st.shape[k], s = 0;
        for (m = 0; m < TUNE.stringModes; m++) s += coef[m] * row[m];
        dispBuf[k] = s;
      }
      drawString(st, dispBuf);
      st.bright.style.opacity = clamp(energy / Math.max(0.01, T.shiverAmp), 0, 1).toFixed(3);
    }
  }

  function quietStrings() {
    for (var i = 0; i < strings.length; i++) {
      strings[i].ex.length = 0;
      strings[i].active = false;
      drawString(strings[i], null);
      strings[i].bright.style.opacity = "0";
    }
  }

  /* ---------- words ---------- */

  function climbSpan() {
    return Math.max(1, H * (TUNE.climbBase - TUNE.climbTop));
  }

  function climbOf(y) {
    return (H * TUNE.climbBase - y) / climbSpan();
  }

  function pickWord() {
    var total = 0, cands = [], ws = [];
    for (var i = 0; i < pool.length; i++) {
      var w = pool[i];
      if (onScreen[w.id]) continue;
      var wt = weightOf(w.id);
      if (wt <= 0) continue;
      cands.push(w); ws.push(wt); total += wt;
    }
    if (!cands.length) return null;
    var r = Math.random() * total;
    for (i = 0; i < cands.length; i++) {
      r -= ws[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  function spawnX() {
    var best = W / 2, bestScore = -1;
    for (var t = 0; t < TUNE.spawnTries; t++) {
      // Triangular distribution: most sparks leave the middle of the fire.
      var f = (Math.random() + Math.random()) / 2;
      var x = W * lerp(TUNE.spawnMarginX, 1 - TUNE.spawnMarginX, f);
      var score = Infinity;
      for (var i = 0; i < live.length; i++) {
        var o = live[i];
        if (o.y < H * 0.55) continue; // only crowding near the fire matters
        var dx = Math.abs(o.x - x);
        if (dx < score) score = dx;
      }
      if (score > bestScore) { bestScore = score; best = x; }
    }
    return best;
  }

  function spawn(y, ageMs) {
    var data = pickWord();
    if (!data) return null;
    var z = Math.pow(Math.random(), 1.3); // 0 far .. 1 near; most are a little far
    var w = {
      id: data.id,
      data: data,
      z: z,
      r: clamp(TUNE.depthSpeedShare * z + (1 - TUNE.depthSpeedShare) * Math.random(), 0, 1),
      x: spawnX(),
      y: y == null ? H * rand(TUNE.spawnTop, TUNE.spawnBottom) : y,
      t: Math.random() * 60,
      p1: rand(T.swayPMin, T.swayPMax),
      p2: rand(T.swayPMin, T.swayPMax) * 0.57,
      ph1: Math.random() * TAU,
      ph2: Math.random() * TAU,
      mix: rand(0.6, 0.8),
      age: ageMs || 0,
      alpha: 0,
      k: 0,              // eased hover/focus amount, 0..1
      hover: false,
      focus: false,
      state: "rising",
      pluckStart: 0,
      sides: [],
      zBase: 1 + Math.round(z * 100),
      el: null
    };

    var el = document.createElement("button");
    el.type = "button";
    el.className = "spark";
    el.setAttribute("data-id", data.id);
    el.setAttribute("data-pl", data.pl);
    el.setAttribute("aria-label", data.pl);
    el.setAttribute("lang", "pl");
    el.textContent = data.pl;
    if (data.rare) el.classList.add("is-rare");
    if (isGolden(data.id)) el.classList.add("is-golden");
    el.style.fontSize = "calc(var(--size-spark-min) + (var(--size-spark-max) - var(--size-spark-min)) * " + z.toFixed(3) + ")";
    el.style.zIndex = String(w.zBase);
    el.style.opacity = "0";
    w.el = el;

    el.addEventListener("pointerenter", function () { w.hover = true; });
    el.addEventListener("pointerleave", function () { w.hover = false; });
    // Only keyboard focus counts as attention. A word refocused after a mouse close
    // must not stay slow and bright (and pinned at attendStopAt) for ever.
    el.addEventListener("focus", function () { w.focus = focusVisible(el); });
    el.addEventListener("blur", function () { w.focus = false; });
    el.addEventListener("click", function () { pluck(w); });

    live.push(w);
    onScreen[w.id] = w;
    render(w, 0);
    wordsLayer.appendChild(el);
    return w;
  }

  function removeWord(i) {
    var w = live[i];
    live.splice(i, 1);
    delete onScreen[w.id];
    if (w.el.parentNode) w.el.parentNode.removeChild(w.el);
  }

  function swayX(w) {
    if (!(T.swayAmp > 0)) return 0;
    var a = T.swayAmp * (0.7 + 0.3 * w.z);
    return a * (w.mix * Math.sin(TAU * w.t / w.p1 + w.ph1) +
                (1 - w.mix) * Math.sin(TAU * w.t / w.p2 + w.ph2));
  }

  function render(w, offset) {
    var x = w.x + swayX(w) + offset;
    w.dx = x; w.dy = w.y;
    w.el.style.transform = "translate3d(" + x.toFixed(2) + "px," + w.y.toFixed(2) + "px,0) translate(-50%,-50%)";
  }

  function targetAlpha(w, p) {
    if (w.state !== "rising") return 1;
    var fadeIn = T.durFadeIn > 0 ? smooth(w.age / T.durFadeIn) : (w.age >= 0 ? 1 : 0);
    var fs = T.fadeStart;
    var fadeOut = p <= fs ? 1 : 1 - smooth((p - fs) / (1 - fs));
    var a = fadeIn * fadeOut * lerp(TUNE.depthAlphaMin, 1, w.z);
    if (w.k > 0) a = lerp(a, Math.max(a, TUNE.attendLift * fadeIn), w.k);
    return a;
  }

  function stepWord(w, dt, wind) {
    var attend = w.hover || w.focus;
    var tau = T.durHover / 1000 / 3; // ~95% of the way in --dur-hover
    w.k += ((attend ? 1 : 0) - w.k) * ease(dt, tau);
    var mul = 1 + (T.hoverSlow - 1) * w.k;
    w.age += dt * 1000;

    var p = climbOf(w.y);
    if (w.state === "rising") {
      var speed = lerp(T.riseMin, T.riseMax, w.r) * mul;
      if (!(attend && p >= TUNE.attendStopAt)) w.y -= speed * dt;
      w.t += dt * mul;
      w.x += wind * dt * mul * (0.4 + 0.6 * clamp(p, 0, 1)); // the breeze is stronger higher up
      p = climbOf(w.y);
    }

    var offset = 0;
    if (w.state === "plucked" && T.durPluck > 0 && T.pluckAmp > 0) {
      var e = (performance.now() - w.pluckStart) / T.durPluck;
      if (e < 1) offset = T.pluckAmp * (1 - e) * (1 - e) * Math.sin(TAU * T.pluckCycles * e);
    }
    render(w, offset);

    w.alpha += (targetAlpha(w, p) - w.alpha) * ease(dt, TUNE.alphaSmoothing);
    w.el.style.opacity = w.alpha.toFixed(3);

    if (w.state === "rising" && T.shiverAmp > 0) crossStrings(w);
    return p;
  }

  function crossStrings(w) {
    var h = TUNE.stringHysteresis;
    for (var i = 0; i < strings.length; i++) {
      var st = strings[i];
      var d = w.dy - lineY(st, w.dx);
      var side = d > h ? 1 : d < -h ? -1 : 0;
      if (!side) continue;
      var prev = w.sides[i];
      if (prev && prev !== side && w.alpha > 0.05) {
        excite(st, w.dx, T.shiverAmp * clamp(w.alpha, 0, 1) * (0.6 + 0.4 * w.z));
      }
      w.sides[i] = side;
    }
  }

  /* ---------- catch and release ---------- */

  function pluck(w) {
    if (holding || w.state !== "rising" || !w.el.parentNode) return;
    holding = w;
    w.state = "plucked";
    w.pluckStart = performance.now();
    w.el.classList.add("is-plucked");
    w.el.style.zIndex = "500";

    // The nearest string answers with a small shiver.
    if (T.shiverAmp > 0) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < strings.length; i++) {
        var dd = Math.abs(w.dy - lineY(strings[i], w.dx));
        if (dd < bestD) { bestD = dd; best = strings[i]; }
      }
      if (best && bestD < H * TUNE.answerReach) {
        excite(best, w.dx, T.shiverAmp * TUNE.answerAmp * (1 - bestD / (H * TUNE.answerReach)));
      }
    }

    if (T.durPluck > 0) {
      pluckTimer = setTimeout(function () { finishPluck(w); }, T.durPluck);
    } else {
      finishPluck(w);
    }
  }

  function finishPluck(w) {
    pluckTimer = 0;
    if (holding !== w || w.state !== "plucked") return;
    w.state = "caught";
    w.el.classList.remove("is-plucked");
    w.el.classList.add("is-caught");
    root.setAttribute("data-holding", "true");
    render(w, 0); // at rest, no vibration offset
    w.alpha = Math.max(w.alpha, 0.6);
    w.el.style.opacity = w.alpha.toFixed(3);
    var rect = w.el.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent("word:catch", { detail: { id: w.id, rect: rect } }));
  }

  function onRelease(ev) {
    var id = ev && ev.detail ? ev.detail.id : null;
    var w = holding;
    if (!w || w.id !== id) return;
    if (pluckTimer) { clearTimeout(pluckTimer); pluckTimer = 0; }
    holding = null;
    w.state = "rising";
    w.el.classList.remove("is-plucked", "is-caught");
    w.el.style.zIndex = String(w.zBase);
    root.removeAttribute("data-holding");
    w.sides.length = 0; // no phantom crossing from the frozen spot
    try { w.el.focus({ preventScroll: true }); } catch (e) { w.el.focus(); }
  }

  /* ---------- spawning ---------- */

  function targetCount() {
    return Math.min(pool.length, Math.round((T.wordsMin + T.wordsMax) / 2));
  }

  function spawnInterval() {
    var avgSpeed = Math.max(1, (T.riseMin + T.riseMax) / 2);
    var life = climbSpan() / avgSpeed;           // seconds a word spends in the sky
    return life / Math.max(1, Math.round((T.wordsMin + T.wordsMax) / 2));
  }

  function maybeSpawn() {
    if (clock < nextSpawnAt) return;
    var n = live.length;
    var cap = Math.min(T.wordsMax, pool.length);
    if (n >= cap) { nextSpawnAt = clock + 0.5; return; }
    var interval = spawnInterval();
    var gap = n < Math.min(T.wordsMin, pool.length)
      ? Math.max(TUNE.minSpawnGap / 1000, interval * 0.35)
      : interval * rand(0.6, 1.4);
    if (spawn(null, 0)) nextSpawnAt = clock + gap;
    else nextSpawnAt = clock + 0.5;
  }

  function populate() {
    var n = targetCount();
    var top = H * TUNE.climbTop + climbSpan() * 0.12;
    var bottom = H * TUNE.climbBase;
    for (var i = 0; i < n; i++) {
      var y = lerp(top, bottom, (i + Math.random()) / n);
      if (!spawn(y, -Math.random() * 1500)) break;
    }
    nextSpawnAt = spawnInterval() * rand(0.4, 1);
  }

  /* ---------- loop ---------- */

  function frame(now) {
    rafId = 0;
    var dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
    lastNow = now;
    clock += dt;

    var wind = 0;
    if (T.swayAmp > 0) {
      wind = TUNE.windMax * (0.6 * Math.sin(TAU * clock / TUNE.windPeriodA) +
                             0.4 * Math.sin(TAU * clock / TUNE.windPeriodB + 1.3));
    }

    for (var i = live.length - 1; i >= 0; i--) {
      var w = live[i];
      var p = stepWord(w, dt, wind);
      if (w.state === "rising" && p >= 1 && w.alpha < 0.02 && !w.hover && !w.focus) removeWord(i);
    }
    updateStrings();
    maybeSpawn();
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

  function measure() {
    W = window.innerWidth || document.documentElement.clientWidth || 1;
    H = window.innerHeight || document.documentElement.clientHeight || 1;
  }

  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      measure();
      layoutStrings();
      for (var i = 0; i < live.length; i++) live[i].sides.length = 0;
    });
  }

  function onMotionChange() {
    readTokens();
    if (!(T.shiverAmp > 0)) quietStrings();
    if (T.stringsCount !== strings.length) layoutStrings();
  }

  /* ---------- init ---------- */

  Iskry.scene = {
    init: function (rootEl, words) {
      if (root || !rootEl) return;
      root = rootEl;
      wordsLayer = root.querySelector("#scene-words") || document.getElementById("scene-words");
      stringsLayer = root.querySelector("#scene-strings") || document.getElementById("scene-strings");
      fireLayer = root.querySelector("#scene-fire") || document.getElementById("scene-fire");
      if (!wordsLayer || !stringsLayer || !fireLayer) return;

      var seen = Object.create(null);
      (words || []).forEach(function (w) {
        if (w && typeof w.id === "string" && typeof w.pl === "string" && w.pl && !seen[w.id]) {
          seen[w.id] = true;
          pool.push(w);
        }
      });

      mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      readTokens();
      measure();

      buildFire();
      buildStrings();
      populate();

      if (mq) {
        if (mq.addEventListener) mq.addEventListener("change", onMotionChange);
        else if (mq.addListener) mq.addListener(onMotionChange);
      }
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) stop(); else start();
      });
      document.addEventListener("word:release", onRelease);
      start();
    }
  };
})(window.Iskry);
