/*
  A simulated evening by the fire, to check that memory's weights really bring caught
  words back. Plain Node, no dependencies:  node tests/spacing.sim.js

  It loads the real js/memory.js and data/words.js into a vm context with a fake clock
  and models the part of js/scene.js that matters here:
    - about 22 words on screen (cap --words-max 25), a spawn every 3 s or so (faster
      below --words-min 15), each word crossing in about 37 s (near) to 97 s (far);
    - pickWord(): weighted random over the words not on screen, weight from
      Iskry.memory.weight(id), rare words x 0.25 and one at a time;
    - gusts: now and then 4 to 6 words of one themed cluster, picked by weight.
  A visitor model catches words; memory is only ever told about catches, exactly as on
  the site. Every scenario runs RUNS times with seeded random numbers, so the output is
  the same on every run.
*/
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.join(__dirname, "..");
var MEMORY_SRC = fs.readFileSync(path.join(ROOT, "js", "memory.js"), "utf8");
var WORDS_SRC = fs.readFileSync(path.join(ROOT, "data", "words.js"), "utf8");

var SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
var RUNS = Number(process.env.RUNS) || 300;
var T0 = new Date(2026, 10, 10, 20, 0, 0).getTime();   // 20:00, a November evening

var wordsBox = { window: {} };
vm.runInNewContext(WORDS_SRC, wordsBox);
var WORDS = wordsBox.window.Iskry.WORDS;
var GUSTS = wordsBox.window.Iskry.GUSTS;
var BY_ID = {};
WORDS.forEach(function (w) { BY_ID[w.id] = w; });

/* ---------- seeded random ---------- */

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- memory under test, and the old one for comparison ---------- */

function loadMemory(clock, seedData) {
  var data = Object.create(null);
  if (seedData) for (var k in seedData) data[k] = seedData[k];
  function FakeDate(a) { return arguments.length ? new Date(a) : new Date(clock.t); }
  FakeDate.now = function () { return clock.t; };
  var win = {
    document: { dispatchEvent: function () { return true; } },
    CustomEvent: function () {},
    addEventListener: function () {},
    localStorage: {
      getItem: function (k) { return k in data ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    }
  };
  vm.runInContext(MEMORY_SRC, vm.createContext({ window: win, Date: FakeDate }), { filename: "memory.js" });
  var m = win.Iskry.memory;
  m._data = data;
  return m;
}

// The Phase 2 weights (before gentle spacing): 1 unmet, 0.5 just seen, back to 2 with
// a 10 h time constant.
function oldMemory(clock) {
  var last = Object.create(null);
  return {
    weight: function (id) {
      if (!(id in last)) return 1;
      var away = Math.max(0, clock.t - last[id]) / HOUR;
      return 0.5 + 1.5 * (1 - Math.exp(-away / 10));
    },
    record: function (id) { last[id] = clock.t; },
    isMet: function (id) { return id in last; }
  };
}

/* ---------- the scene, as far as spawning goes ---------- */

var SCENE = {
  wordsMin: 15, wordsMax: 25, spawnEvery: 3.0, minGap: 0.9,
  crossNear: 37, crossFar: 97, speedJitter: 0.14,
  rareWeight: 0.25, rareSlow: 0.72,
  gustFirst: [80, 140], gustEvery: [190, 330], gustWords: [4, 6], gustGap: [1.1, 2.3], gustMin: 3
};

function Sky(memory, clock, rng) {
  this.m = memory; this.clock = clock; this.rng = rng;
  this.live = [];               // { id, until }
  this.on = Object.create(null);
  this.spawns = [];             // { t, id, met }
  this.held = null;
  this.passes = 0;
  this.nextSpawn = 0; this.nextGust = 0; this.gust = null;
}

Sky.prototype.rand = function (a, b) { return a + (b - a) * this.rng(); };

Sky.prototype.pick = function (cands) {
  var total = 0, ws = [], list = [], rareOn = false, i;
  for (i = 0; i < this.live.length; i++) if (BY_ID[this.live[i].id].rare) rareOn = true;
  for (i = 0; i < cands.length; i++) {
    var w = cands[i];
    if (this.on[w.id]) continue;
    if (w.rare && rareOn) continue;
    var wt = this.m.weight(w.id);
    if (!(wt > 0)) continue;
    if (w.rare) wt *= SCENE.rareWeight;
    list.push(w); ws.push(wt); total += wt;
  }
  if (!list.length) return null;
  var r = this.rng() * total;
  for (i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
};

Sky.prototype.spawn = function (word, ageFraction) {
  if (!word) return false;
  var cross = this.rand(SCENE.crossNear, SCENE.crossFar) / (1 + this.rand(-SCENE.speedJitter, SCENE.speedJitter));
  if (word.rare) cross /= SCENE.rareSlow;
  var left = cross * (1 - (ageFraction || 0));
  this.live.push({ id: word.id, until: this.clock.t + left * SEC, pass: ++this.passes });
  this.on[word.id] = true;
  this.spawns.push({ t: this.clock.t, id: word.id, met: this.m.isMet(word.id) });
  return true;
};

Sky.prototype.populate = function () {
  var n = Math.round((SCENE.wordsMin + SCENE.wordsMax) / 2);
  for (var i = 0; i < n; i++) this.spawn(this.pick(WORDS), this.rng());
  this.spawns.length = 0;       // the opening sky is not counted as spawns
  this.nextSpawn = this.clock.t + SCENE.spawnEvery * this.rand(0.3, 0.8) * SEC;
  this.nextGust = this.clock.t + this.rand(SCENE.gustFirst[0], SCENE.gustFirst[1]) * SEC;
};

Sky.prototype.step = function () {
  var t = this.clock.t, i;
  for (i = this.live.length - 1; i >= 0; i--) {
    var w = this.live[i];
    if (w.id === this.held) { w.until += 500; continue; }   // a held word waits
    if (t >= w.until) { delete this.on[w.id]; this.live.splice(i, 1); }
  }
  // gusts
  if (!this.gust && t >= this.nextGust) {
    var choices = [];
    for (i = 0; i < GUSTS.length; i++) {
      var free = [];
      for (var j = 0; j < GUSTS[i].ids.length; j++) {
        var d = BY_ID[GUSTS[i].ids[j]];
        if (d && !d.rare && !this.on[d.id]) free.push(d);
      }
      if (free.length >= SCENE.gustMin) choices.push(free);
    }
    if (choices.length) {
      var pool = choices[Math.floor(this.rng() * choices.length)];
      var n = Math.min(pool.length, Math.round(this.rand(SCENE.gustWords[0], SCENE.gustWords[1])));
      var queue = [];
      for (i = 0; i < n; i++) {
        var p = this.pick(pool.filter(function (x) { return queue.indexOf(x) < 0; }));
        if (p) queue.push(p);
      }
      this.gust = { queue: queue, next: t };
    } else {
      this.nextGust = t + this.rand(SCENE.gustEvery[0], SCENE.gustEvery[1]) * SEC;
    }
  }
  if (this.gust) {
    if (this.gust.queue.length && t >= this.gust.next) {
      var g = this.gust.queue.shift();
      if (!this.on[g.id]) this.spawn(g, 0);
      this.gust.next = t + this.rand(SCENE.gustGap[0], SCENE.gustGap[1]) * SEC;
    }
    if (!this.gust.queue.length) {
      this.gust = null;
      this.nextGust = t + this.rand(SCENE.gustEvery[0], SCENE.gustEvery[1]) * SEC;
    }
    return;
  }
  // ordinary spawning
  if (t < this.nextSpawn) return;
  if (this.live.length >= SCENE.wordsMax) { this.nextSpawn = t + 500; return; }
  var gap = this.live.length < SCENE.wordsMin
    ? Math.max(SCENE.minGap, SCENE.spawnEvery * 0.3)
    : SCENE.spawnEvery * this.rand(0.6, 1.4);
  this.nextSpawn = t + (this.spawn(this.pick(WORDS), 0) ? gap : 0.5) * SEC;
};

/* ---------- visitors ---------- */

// Runs one evening. visitor(sky, t) is called every simulated half second and may
// return the id of an on-screen word to catch; the card then stays open for 12 s.
function evening(opts) {
  var clock = { t: opts.start };
  var rng = mulberry32(opts.seed);
  var memory = opts.old ? oldMemory(clock) : loadMemory(clock, opts.storage);
  if (opts.before) opts.before(memory, clock);
  clock.t = opts.start;
  var sky = new Sky(memory, clock, rng);
  sky.populate();
  var cardUntil = 0;
  var end = opts.start + opts.minutes * MIN;
  var catches = [];
  while (clock.t < end) {
    if (sky.held && clock.t >= cardUntil) sky.held = null;
    sky.step();
    if (!sky.held) {
      var id = opts.visitor(sky, clock.t - opts.start, rng, memory);
      if (id && sky.on[id]) {
        memory.record(id);
        catches.push({ t: clock.t - opts.start, id: id });
        sky.held = id;
        cardUntil = clock.t + 12 * SEC;
      }
    }
    clock.t += 500;
  }
  return { sky: sky, catches: catches, memory: memory, start: opts.start };
}

function onScreenIds(sky) { return sky.live.map(function (w) { return w.id; }); }

/* ---------- small statistics ---------- */

function median(a) {
  if (!a.length) return NaN;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; }
function quantile(a, q) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function fmt(n, d) { return isFinite(n) ? n.toFixed(d == null ? 1 : d) : "never"; }
function pct(n) { return Math.round(n * 100) + "%"; }

var passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
}

/* ---------- scenario 1: one word caught at minute 0, never caught again ---------- */

function oneWord(old) {
  var firsts = [], gaps = [[], [], []], counts = [], never = 0;
  for (var seed = 1; seed <= RUNS; seed++) {
    var target = null;
    var res = evening({
      start: T0, minutes: 30, seed: seed, old: old,
      visitor: function (sky, t, rng) {
        if (target) return null;
        var ids = onScreenIds(sky).filter(function (id) { return !BY_ID[id].rare; });
        target = ids[Math.floor(rng() * ids.length)];
        return target;
      }
    });
    var times = res.sky.spawns.filter(function (s) { return s.id === target; })
      .map(function (s) { return (s.t - T0) / MIN; });
    counts.push(times.length);
    if (!times.length) { never++; continue; }
    firsts.push(times[0]);
    for (var i = 1; i < times.length && i <= 3; i++) gaps[i - 1].push(times[i] - times[i - 1]);
  }
  return { firsts: firsts, gaps: gaps, counts: counts, never: never };
}

/* ---------- scenario 2: an ordinary evening ---------- */

// Catches 6 words in the first three minutes, then about one new word a minute, and
// catches again a third of the old friends it notices drifting back.
function ordinaryVisitor() {
  var nextNew = 5 * SEC, seenPass = Object.create(null), n = 0;
  return function (sky, t, rng, memory) {
    var ids = onScreenIds(sky);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!memory.isMet(id)) continue;
      var pass = sky.live[i].pass;
      if (seenPass[pass]) continue;
      seenPass[pass] = true;
      if (rng() < 1 / 3) return id;
    }
    if (t >= nextNew) {
      var fresh = ids.filter(function (x) { return !memory.isMet(x); });
      if (fresh.length) {
        n++;
        nextNew = t + (n < 6 ? 30 : 60) * SEC * (0.6 + 0.8 * rng());
        return fresh[Math.floor(rng() * fresh.length)];
      }
    }
    return null;
  };
}

function ordinary(old) {
  var shares = [], sharesLate = [], caught = [], recaught = [], freshShown = [];
  for (var seed = 1; seed <= RUNS; seed++) {
    var res = evening({ start: T0, minutes: 30, seed: 1000 + seed, old: old, visitor: ordinaryVisitor() });
    var after = res.sky.spawns.filter(function (s) { return s.t - T0 >= 4 * MIN; });
    var late = res.sky.spawns.filter(function (s) { return s.t - T0 >= 15 * MIN; });
    shares.push(after.filter(function (s) { return s.met; }).length / after.length);
    sharesLate.push(late.filter(function (s) { return s.met; }).length / late.length);
    var ids = {}, again = 0;
    res.catches.forEach(function (c) { if (ids[c.id]) again++; ids[c.id] = true; });
    caught.push(Object.keys(ids).length);
    recaught.push(again);
    var fresh = {};
    res.sky.spawns.forEach(function (s) { if (!s.met) fresh[s.id] = true; });
    freshShown.push(Object.keys(fresh).length);
  }
  return { shares: shares, sharesLate: sharesLate, caught: caught, recaught: recaught, freshShown: freshShown };
}

/* ---------- scenario 3: the next evening ---------- */

// Yesterday: 12 words, each caught once or a few times. Tonight the visitor only watches.
function nextEvening() {
  var shareFirst5 = [], shareAll = [], appearedIn5 = [], appearedIn15 = [];
  for (var seed = 1; seed <= RUNS; seed++) {
    var yesterday = [];
    var res = evening({
      start: T0 + DAY, minutes: 30, seed: 2000 + seed,
      before: function (memory, clock) {
        var rng = mulberry32(9000 + seed);
        var ids = WORDS.filter(function (w) { return !w.rare; }).map(function (w) { return w.id; });
        for (var i = 0; i < 12; i++) {
          var id = ids.splice(Math.floor(rng() * ids.length), 1)[0];
          yesterday.push(id);
          clock.t = T0 + i * MIN;
          memory.record(id);
          if (i % 2) { clock.t += 3 * MIN; memory.record(id); }
          if (i % 4 === 3) { clock.t += 11 * MIN; memory.record(id); }
        }
      },
      visitor: function () { return null; }
    });
    var start = T0 + DAY;
    var first5 = res.sky.spawns.filter(function (s) { return s.t - start < 5 * MIN; });
    shareFirst5.push(first5.filter(function (s) { return s.met; }).length / first5.length);
    shareAll.push(res.sky.spawns.filter(function (s) { return s.met; }).length / res.sky.spawns.length);
    var by5 = {}, by15 = {};
    res.sky.spawns.forEach(function (s) {
      if (!s.met) return;
      if (s.t - start < 5 * MIN) by5[s.id] = true;
      if (s.t - start < 15 * MIN) by15[s.id] = true;
    });
    appearedIn5.push(Object.keys(by5).length);
    appearedIn15.push(Object.keys(by15).length);
  }
  return { shareFirst5: shareFirst5, shareAll: shareAll, appearedIn5: appearedIn5, appearedIn15: appearedIn15 };
}

/* ---------- scenario 4: a big backlog must not crowd out new words ---------- */

function backlog() {
  var shares = [], fresh = [];
  for (var seed = 1; seed <= 60; seed++) {
    var res = evening({
      start: T0 + 30 * DAY, minutes: 30, seed: 3000 + seed,
      before: function (memory, clock) {
        var ids = WORDS.map(function (w) { return w.id; });
        for (var i = 0; i < 90; i++) { clock.t = T0 + i * MIN; memory.record(ids[i * 2 % ids.length]); }
      },
      visitor: function () { return null; }
    });
    shares.push(res.sky.spawns.filter(function (s) { return s.met; }).length / res.sky.spawns.length);
    var f = {};
    res.sky.spawns.forEach(function (s) { if (!s.met) f[s.id] = true; });
    fresh.push(Object.keys(f).length);
  }
  return { shares: shares, fresh: fresh };
}

/* ---------- run ---------- */

console.log("spacing simulation (" + RUNS + " seeded evenings per scenario, 30 min each)\n");

console.log("1. One word caught at minute 0 and never caught again");
var now1 = oneWord(false), old1 = oneWord(true);
function line1(label, r) {
  console.log("   " + label + ": first drifts back after " + fmt(median(r.firsts)) + " min (median; 90% within " +
    fmt(quantile(r.firsts, 0.9)) + "), then gaps of " + fmt(median(r.gaps[0])) + ", " + fmt(median(r.gaps[1])) +
    ", " + fmt(median(r.gaps[2])) + " min; " + fmt(mean(r.counts)) + " returns in 30 min; never came back in " +
    pct(r.never / RUNS) + " of evenings");
}
line1("before", old1);
line1("now   ", now1);
check("comes back within a few minutes", median(now1.firsts) <= 4.5 && quantile(now1.firsts, 0.9) <= 7,
  "median " + fmt(median(now1.firsts)) + " min");
var early = now1.firsts.filter(function (m) { return m < 1; }).length / RUNS;
check("rarely straight back (it rests first)", early <= 0.08, pct(early) + " of evenings within the first minute");
check("then more sparsely", median(now1.gaps[1]) > median(now1.gaps[0]) && median(now1.gaps[2]) > median(now1.gaps[1]),
  "gaps " + fmt(median(now1.gaps[0])) + " < " + fmt(median(now1.gaps[1])) + " < " + fmt(median(now1.gaps[2])) + " min");
check("always comes back the same evening", now1.never === 0);
check("but does not haunt the sky", mean(now1.counts) <= 8, fmt(mean(now1.counts)) + " returns");

console.log("\n2. An ordinary evening: 6 words caught early, then a new one about every minute,");
console.log("   a third of the returning friends caught again");
var now2 = ordinary(false), old2 = ordinary(true);
function line2(label, r) {
  console.log("   " + label + ": old friends are " + pct(mean(r.shares)) + " of spawns after minute 4 (" +
    pct(mean(r.sharesLate)) + " after minute 15); " + fmt(mean(r.caught)) + " different words caught, " +
    fmt(mean(r.recaught)) + " catches of a word met before; " + fmt(mean(r.freshShown), 0) + " different new words drifted by");
}
line2("before", old2);
line2("now   ", now2);
check("about a third of spawns are old friends", mean(now2.shares) >= 0.28 && mean(now2.shares) <= 0.5 &&
  mean(now2.sharesLate) >= 0.3 && mean(now2.sharesLate) <= 0.5, pct(mean(now2.shares)) + ", later " + pct(mean(now2.sharesLate)));
check("new words still fill the other half", mean(now2.freshShown) >= 90, fmt(mean(now2.freshShown), 0) + " different new words");
check("many more second meetings than before", mean(now2.recaught) >= 2 * mean(old2.recaught),
  fmt(mean(now2.recaught)) + " vs " + fmt(mean(old2.recaught)));

console.log("\n3. The next evening: 12 words were caught yesterday, tonight the visitor only watches");
var r3 = nextEvening();
console.log("   old friends are " + pct(mean(r3.shareFirst5)) + " of spawns in the first 5 min, " + pct(mean(r3.shareAll)) +
  " over 30 min; " + fmt(mean(r3.appearedIn5)) + " of the 12 drift by within 5 min, " + fmt(mean(r3.appearedIn15)) + " within 15");
check("yesterday's words come to say hello first", mean(r3.appearedIn5) >= 8, fmt(mean(r3.appearedIn5)) + " of 12 in 5 min");
check("nearly all of them within 15 min", mean(r3.appearedIn15) >= 11, fmt(mean(r3.appearedIn15)) + " of 12");
check("and then leave room", mean(r3.shareAll) <= 0.5, pct(mean(r3.shareAll)));

console.log("\n4. A month later with 90 caught words all due");
var r4 = backlog();
console.log("   old friends are " + pct(mean(r4.shares)) + " of spawns; " + fmt(mean(r4.fresh), 0) + " different new words still drift by");
check("a backlog never takes the whole sky", mean(r4.shares) <= 0.7 && mean(r4.fresh) >= 40,
  pct(mean(r4.shares)) + ", " + fmt(mean(r4.fresh), 0) + " new words");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
