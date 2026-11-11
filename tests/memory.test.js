/*
  Tests for js/memory.js. Plain Node, no dependencies:  node tests/memory.test.js
  Each test loads a fresh copy of memory.js into a vm context with a fake window,
  a fake localStorage and a controllable clock.
*/
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var SRC = fs.readFileSync(path.join(__dirname, "..", "js", "memory.js"), "utf8");
var KEY = "iskry.memory.v2";
var OLD_KEY = "iskry.memory.v1";
var MIN = 60 * 1000;
var HOUR = 60 * MIN;
var DAY = 24 * HOUR;

/* ---------- fakes ---------- */

function makeStorage(opts) {
  opts = opts || {};
  var data = Object.create(null);
  return {
    data: data,
    getItem: function (k) {
      if (opts.throwOnGet) throw new Error("SecurityError");
      return k in data ? data[k] : null;
    },
    setItem: function (k, v) {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      data[k] = String(v);
    },
    removeItem: function (k) { delete data[k]; }
  };
}

// Local noon on 2026-11-10, a fixed reference point.
var T0 = new Date(2026, 10, 10, 12, 0, 0).getTime();

function load(opts) {
  opts = opts || {};
  var clock = { t: opts.t != null ? opts.t : T0 };
  var events = [];
  var listeners = {};
  function FakeDate(a) {
    return arguments.length ? new Date(a) : new Date(clock.t);
  }
  FakeDate.now = function () { return clock.t; };

  var win = {
    document: {
      dispatchEvent: function (ev) { events.push(ev); return true; }
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };
  if (opts.storageThrowsOnAccess) {
    Object.defineProperty(win, "localStorage", { get: function () { throw new Error("SecurityError"); } });
  } else if (opts.storage !== null) {
    win.localStorage = opts.storage || makeStorage();
  }
  var ctx = vm.createContext({ window: win, Date: FakeDate });
  if (opts.random) vm.runInContext("Math.random = " + opts.random, ctx);
  vm.runInContext(SRC, ctx, { filename: "memory.js" });
  return {
    m: win.Iskry.memory,
    clock: clock,
    events: events,
    storage: opts.storageThrowsOnAccess ? null : win.localStorage,
    ctx: ctx,
    fire: function (type, ev) { (listeners[type] || []).forEach(function (fn) { fn(ev); }); }
  };
}

/* ---------- tiny runner ---------- */

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || "expected equal") + ": got " + JSON.stringify(a) + ", want " + JSON.stringify(b));
}
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

/* Record `id` n times on each of `days` consecutive days, one hour apart. */
function visit(env, id, days, perDay) {
  for (var d = 0; d < days; d++) {
    for (var i = 0; i < perDay; i++) {
      env.m.record(id);
      env.clock.t += HOUR;
    }
    env.clock.t += DAY - perDay * HOUR;
  }
}

console.log("memory.js");

/* ---------- unknown ids and bad input ---------- */

test("unknown ids: weight 1, not golden, not met, new, no hide, never throw", function () {
  var env = load();
  eq(env.m.weight("nope"), 1);
  eq(env.m.isGolden("nope"), false);
  eq(env.m.isMet("nope"), false);
  eq(env.m.familiarity("nope"), "new");
  eq(env.m.hideTranslation("nope"), false);
  [undefined, null, 42, {}, [], "", "x".repeat(500), "__proto__", "constructor", "toString"].forEach(function (bad) {
    var w = env.m.weight(bad);
    ok(w > 0 && isFinite(w), "weight positive for " + String(bad));
    eq(env.m.isGolden(bad), false);
    eq(env.m.isMet(bad), false);
    eq(env.m.familiarity(bad), "new");
    eq(env.m.hideTranslation(bad), false);
    env.m.record(bad); // must not throw
    env.m.record(bad, { via: "related" });
    env.m.record(bad, "nonsense");
  });
});

test("non-string ids are not recorded; odd strings are safe", function () {
  var env = load();
  env.m.record(42);
  env.m.record(null);
  env.m.record("");
  eq(env.m.entries().length, 0);
  env.m.record("__proto__");
  env.m.record("constructor");
  eq(env.m.entries().length, 2);
  var reloaded = load({ storage: env.storage });
  eq(reloaded.m.entries().length, 2, "odd ids survive a reload");
  eq(reloaded.m.isMet("toString"), false, "prototype names are not entries");
});

test("odd second arguments to record are catches", function () {
  var env = load();
  [undefined, null, 7, "related", {}, { via: "catch" }, { via: 3 }, []].forEach(function (o, i) {
    env.m.record("w" + i, o);
    eq(env.m.isMet("w" + i), true, "arg " + JSON.stringify(o));
  });
});

/* ---------- storage failures ---------- */

test("no localStorage at all: works in memory", function () {
  var env = load({ storage: null });
  env.m.record("kot");
  env.m.record("kot");
  eq(env.m.entries()[0].count, 2);
});

test("localStorage getter throws: works in memory", function () {
  var env = load({ storageThrowsOnAccess: true });
  env.m.record("kot");
  eq(env.m.entries().length, 1);
  eq(env.m.weight("kot"), 0.3);
});

test("setItem throws (quota, private mode): works in memory", function () {
  var env = load({ storage: makeStorage({ throwOnSet: true }) });
  env.m.record("kot");
  eq(env.m.entries()[0].count, 1);
});

test("getItem throws: starts empty, still records", function () {
  var env = load({ storage: makeStorage({ throwOnGet: true }) });
  eq(env.m.entries().length, 0);
  env.m.record("kot");
  eq(env.m.entries().length, 1);
});

test("corrupt JSON: starts empty, then overwrites cleanly", function () {
  var s = makeStorage();
  s.data[KEY] = "{not json";
  s.data[OLD_KEY] = "also{not json";
  var env = load({ storage: s });
  eq(env.m.entries().length, 0);
  env.m.record("kot");
  var parsed = JSON.parse(s.data[KEY]);
  eq(parsed.v, 2);
  eq(parsed.words.kot.c, 1);
  eq(parsed.words.kot.s, 1);
});

test("wrong shape or version is ignored; bad entries dropped one by one", function () {
  ["null", "42", "[]", '"str"', '{"v":1,"words":{"kot":{"c":3,"f":1,"l":2,"d":[]}}}', '{"v":3,"words":{"kot":{"c":3,"f":1,"l":2}}}', '{"v":2}', '{"v":2,"words":7}']
    .forEach(function (raw) {
      var s = makeStorage(); s.data[KEY] = raw;
      eq(load({ storage: s }).m.entries().length, 0, "for " + raw);
    });
  var s = makeStorage();
  s.data[KEY] = JSON.stringify({ v: 2, words: {
    good: { c: 2, n: 2, f: T0 - DAY, l: T0 - HOUR, k: T0 - HOUR, a: T0 - HOUR, s: 2, d: ["2026-11-09", "2026-11-10", "bad", 5, "2026-11-10"] },
    zero: { c: 0, n: 0, f: T0, l: T0, d: [] },
    nan: { c: 1, n: 1, f: "x", l: T0, d: [] },
    str: "hello",
    bare: { c: 1, n: 1, f: T0, l: T0 },
    wild: { c: 3, n: 99, f: T0, l: T0, k: "x", a: null, s: 400, d: "nope" },
    touched: { c: 2, n: 0, f: T0, l: T0, s: 5, d: ["2026-11-10"] }
  } });
  var env = load({ storage: s });
  var by = {};
  env.m.entries().forEach(function (e) { by[e.id] = e; });
  eq(Object.keys(by).sort().join(","), "bare,good,touched,wild");
  eq(by.good.days, 2, "invalid and duplicate day keys dropped");
  eq(by.bare.days, 1, "missing days fall back to the last catch");
  eq(by.bare.stage, 1, "a caught word is at least stage 1");
  eq(by.wild.stage, 7, "stage clamped");
  eq(by.wild.caught, true);
  eq(by.touched.caught, false, "no catches: not caught, whatever the stage said");
  eq(by.touched.stage, 0);
  eq(by.touched.days, 0);
  ok(env.m.weight("wild") > 0 && isFinite(env.m.weight("wild")));
});

/* ---------- migration from v1 ---------- */

test("v1 storage migrates: nothing lost, golden stays golden, v1 key kept", function () {
  var s = makeStorage();
  var v1 = JSON.stringify({ v: 1, words: {
    ogien: { c: 7, f: T0 - 6 * DAY, l: T0 - DAY, d: ["2026-11-04", "2026-11-07", "2026-11-09"] },
    noc: { c: 5, f: T0 - 5 * DAY, l: T0 - 2 * HOUR, d: ["2026-11-05", "2026-11-08", "2026-11-10"] },
    iskra: { c: 2, f: T0 - DAY, l: T0 - DAY, d: ["2026-11-09"] },
    gitara: { c: 1, f: T0 - HOUR, l: T0 - HOUR, d: ["2026-11-10"] },
    many: { c: 40, f: T0 - HOUR, l: T0 - HOUR, d: ["2026-11-10"] },
    broken: { c: "x" },
    nodays: { c: 1, f: T0 - 3 * DAY, l: T0 - 3 * DAY }
  } });
  s.data[OLD_KEY] = v1;
  var env = load({ storage: s });
  var by = {};
  env.m.entries().forEach(function (e) { by[e.id] = e; });
  eq(Object.keys(by).sort().join(","), "gitara,iskra,many,noc,nodays,ogien");
  eq(by.ogien.count, 7);
  eq(by.ogien.firstSeen, T0 - 6 * DAY);
  eq(by.ogien.lastSeen, T0 - DAY);
  eq(by.ogien.days, 3);
  eq(env.m.isGolden("ogien"), true, "v1 golden (7 views, 3 days) stays golden");
  eq(env.m.isGolden("noc"), true, "v1 golden at the threshold (5 views, 3 days) stays golden");
  eq(env.m.isGolden("iskra"), false);
  eq(env.m.isGolden("many"), false, "one day is never golden");
  eq(by.many.stage, 3, "stage = min(views, days + 2)");
  eq(by.iskra.stage, 2);
  eq(by.gitara.stage, 1);
  eq(by.nodays.days, 1);
  ["ogien", "noc", "iskra", "gitara", "many", "nodays"].forEach(function (id) {
    eq(env.m.isMet(id), true, id + " is met");
  });
  eq(env.m.familiarity("iskra"), "returning");
  eq(env.m.familiarity("gitara"), "new");
  eq(env.m.familiarity("ogien"), "golden");
  eq(s.data[OLD_KEY], v1, "the v1 key is untouched");
  ok(s.data[KEY], "v2 written at once");
  eq(JSON.parse(s.data[KEY]).v, 2);
  var again = load({ storage: s });
  eq(JSON.stringify(again.m.entries()), JSON.stringify(env.m.entries()), "same after a reload from v2");
});

test("v2 wins over v1 when both exist", function () {
  var s = makeStorage();
  s.data[OLD_KEY] = JSON.stringify({ v: 1, words: { stary: { c: 1, f: T0, l: T0, d: ["2026-11-10"] } } });
  var a = load({ storage: s });
  a.m.record("nowy");
  var b = load({ storage: s });
  eq(b.m.entries().map(function (e) { return e.id; }).sort().join(","), "nowy,stary");
  s.data[OLD_KEY] = JSON.stringify({ v: 1, words: { inny: { c: 1, f: T0, l: T0, d: ["2026-11-10"] } } });
  var c = load({ storage: s });
  eq(c.m.isMet("inny"), false, "v1 is not read again once v2 exists");
});

/* ---------- the schedule ---------- */

function stageOf(env, id) {
  return env.m.entries().filter(function (e) { return e.id === id; })[0].stage;
}

test("a catch while due moves one stage up; a catch while resting does not", function () {
  var env = load();
  env.m.record("kot");
  eq(stageOf(env, "kot"), 1);
  for (var i = 0; i < 10; i++) { env.clock.t += 5 * 1000; env.m.record("kot"); }
  eq(stageOf(env, "kot"), 1, "ten catches in a minute are still one step");
  env.clock.t += 2 * MIN;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 2);
  env.clock.t += 9 * MIN;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 2, "9 min into a 10 min rest");
  env.clock.t += 9 * MIN;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 2, "the early catch restarted the rest");
  env.clock.t += 10 * MIN;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 3);
  env.clock.t += HOUR;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 4);
  env.clock.t += 19 * HOUR;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 4, "a day has not passed");
  env.clock.t += 20 * HOUR;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 5);
  env.clock.t += 3 * DAY; env.m.record("kot");
  eq(stageOf(env, "kot"), 6);
  env.clock.t += 8 * DAY; env.m.record("kot");
  eq(stageOf(env, "kot"), 7);
  env.clock.t += 30 * DAY; env.m.record("kot");
  eq(stageOf(env, "kot"), 7, "the top stage stays");
});

test("a long absence is forgiven: kept, then one step down, never a reset", function () {
  function at(stageDays, awayDays) {
    var env = load();
    env.m.record("kot");
    env.clock.t += 2 * MIN; env.m.record("kot");
    env.clock.t += 10 * MIN; env.m.record("kot");
    env.clock.t += HOUR; env.m.record("kot");          // stage 4, rests a day
    if (stageDays >= 3) { env.clock.t += DAY; env.m.record("kot"); }   // stage 5, rests 3 days
    env.clock.t += awayDays * DAY;
    env.m.record("kot");
    return stageOf(env, "kot");
  }
  eq(at(1, 1), 5, "next day: up");
  eq(at(1, 6), 5, "six days late: still up");
  eq(at(1, 10), 4, "ten days: kept");
  eq(at(1, 30), 4, "a month: stage 4 is the floor");
  eq(at(1, 3000), 4, "years: still stage 4");
  eq(at(3, 20), 6, "stage 5 after 20 days: up");
  eq(at(3, 40), 5, "stage 5 after 40 days: kept");
  eq(at(3, 90), 4, "stage 5 after 90 days: one step down");

  var env = load();
  env.m.record("kot");
  env.clock.t += 400 * DAY;
  env.m.record("kot");
  eq(stageOf(env, "kot"), 2, "a young word is never pushed down");
});

test("a related view is a light touch: no stage, no day, never golden", function () {
  var env = load();
  env.m.record("kotek", { via: "related" });
  eq(env.m.isMet("kotek"), false);
  eq(env.m.entries()[0].caught, false);
  eq(env.m.entries()[0].count, 1);
  eq(env.m.entries()[0].days, 0);
  eq(env.m.weight("kotek"), 1, "still drifts like a new word");
  eq(env.m.familiarity("kotek"), "new");
  eq(env.events.length, 1, "memory:change still fires");
  for (var d = 0; d < 6; d++) {
    for (var i = 0; i < 6; i++) { env.m.record("kotek", { via: "related" }); env.clock.t += HOUR; }
    env.clock.t += DAY;
  }
  eq(env.m.isGolden("kotek"), false, "chip clicking never makes gold");
  eq(env.m.isMet("kotek"), false);
  eq(env.m.hideTranslation("kotek"), false);

  var env2 = load();
  env2.m.record("kot");
  env2.clock.t += 2 * MIN;
  env2.m.record("kot", { via: "related" });
  eq(stageOf(env2, "kot"), 1, "a related view of a due word does not advance it");
  eq(env2.m.entries()[0].count, 2);
  env2.m.record("kot");
  eq(stageOf(env2, "kot"), 2, "and does not use up the due catch");
});

/* ---------- weight ---------- */

test("weight: rests low after a catch, pulls when due, eases off, never 0", function () {
  var env = load();
  env.m.record("kot");
  eq(env.m.weight("kot"), 0.3, "just caught");
  env.clock.t = T0 + MIN;
  var resting = env.m.weight("kot");
  ok(resting > 0.3 && resting < 1, "resting: " + resting);
  env.clock.t = T0 + 2 * MIN;
  eq(env.m.weight("kot"), 8, "due: at its strongest");
  ok(env.m.weight("kot") > 4 * env.m.weight("pies"), "far more likely than a stranger");
  var prev = 8;
  [3, 5, 8, 12, 14].forEach(function (m) {
    env.clock.t = T0 + m * MIN;
    var w = env.m.weight("kot");
    ok(w < prev && w >= 1.5, "eases off at " + m + " min: " + w);
    prev = w;
  });
  for (var m = 15; m <= 50; m += 5) {   // the scene keeps asking, so the visit goes on
    env.clock.t = T0 + m * MIN;
    env.m.weight("pies");
  }
  eq(env.m.weight("kot"), 1.5, "lingers, a little above a new word");
});

test("weight is always finite and within about 0.2 .. 8", function () {
  var env = load();
  var ids = [];
  for (var i = 0; i < 40; i++) { ids.push("w" + i); env.m.record("w" + i); env.clock.t += 20 * 1000; }
  [0, 0.01, 0.1, 1, 3, 6, 12, 24, 48, 24 * 30, 24 * 3650].forEach(function (h) {
    env.clock.t = T0 + h * HOUR;
    ids.concat(["stranger"]).forEach(function (id) {
      var w = env.m.weight(id);
      ok(isFinite(w) && w >= 0.2 && w <= 8, id + " at " + h + "h: " + w);
    });
  });
});

test("weight with the clock going backwards stays in band", function () {
  var env = load();
  env.m.record("kot");
  env.clock.t = T0 - 10 * DAY;
  var w = env.m.weight("kot");
  ok(w >= 0.2 && w <= 8, "got " + w);
  env.m.record("kot");
  ok(isFinite(env.m.weight("kot")));
});

test("new words step back while caught words are in the air, and return afterwards", function () {
  var env = load();
  eq(env.m.weight("stranger"), 1);
  env.m.record("a"); env.m.record("b");
  eq(env.m.weight("stranger"), 1, "two in the air: no change");
  env.m.record("c"); env.m.record("d"); env.m.record("e");
  env.clock.t += 2000;
  var mid = env.m.weight("stranger");
  ok(mid < 1 && mid > 0.2, "five in the air: " + mid);
  ["f", "g", "h", "i"].forEach(function (id) { env.m.record(id); });
  env.clock.t += 2000;
  eq(env.m.weight("stranger"), 0.2, "nine in the air");
  env.clock.t = T0 + 5 * HOUR;
  env.m.weight("stranger");            // a new visit begins; the nine are due and hot
  env.clock.t += 30 * MIN;
  env.m.weight("stranger");
  env.clock.t += 10 * MIN;
  eq(env.m.weight("stranger"), 1, "once they have eased off, new words are back");
});

test("many due words share a budget instead of taking the whole sky", function () {
  var env = load();
  for (var i = 0; i < 60; i++) env.m.record("w" + i);
  env.clock.t = T0 + 3 * DAY;
  var total = 0;
  for (var j = 0; j < 60; j++) total += env.m.weight("w" + j);
  ok(total > 40 && total < 50, "60 due words weigh about the budget together: " + total);
  ok(env.m.weight("w0") >= 0.6, "each still above the floor");

  var few = load();
  few.m.record("a"); few.m.record("b");
  few.clock.t = T0 + 3 * DAY;
  eq(few.m.weight("a"), 8, "a few due words are not scaled");
});

test("a new visit lets words that were already due pull again", function () {
  var env = load();
  env.m.record("kot");
  env.clock.t = T0 + 2 * MIN; env.m.weight("kot");
  env.clock.t = T0 + 14 * MIN;
  var faded = env.m.weight("kot");
  ok(faded < 2, "faded tonight: " + faded);
  env.clock.t = T0 + DAY;                 // nothing asked for a day
  eq(env.m.weight("kot"), 8, "tomorrow it comes to say hello");
});

/* ---------- golden ---------- */

test("golden needs stage 4 and catches on 3 separate days", function () {
  var env = load();
  for (var i = 0; i < 20; i++) env.m.record("one-day");
  eq(env.m.isGolden("one-day"), false, "many catches, one day");

  // One long first evening reaches stage 4, but it is one day.
  var a = load();
  a.m.record("kot");
  a.clock.t += 2 * MIN; a.m.record("kot");
  a.clock.t += 10 * MIN; a.m.record("kot");
  a.clock.t += HOUR; a.m.record("kot");
  eq(stageOf(a, "kot"), 4);
  eq(a.m.isGolden("kot"), false, "stage 4 on one day");
  a.clock.t += DAY; a.m.record("kot");
  eq(a.m.isGolden("kot"), false, "two days");
  a.clock.t += 3 * DAY; a.m.record("kot");
  eq(a.m.isGolden("kot"), true, "three days");
  eq(a.m.entries()[0].golden, true);
  eq(a.m.familiarity("kot"), "golden");

  // One catch a day: three days are not enough, the fourth is.
  var b = load();
  b.m.record("pies");
  b.clock.t += DAY; b.m.record("pies");
  b.clock.t += DAY; b.m.record("pies");
  eq(b.m.entries()[0].days, 3);
  eq(b.m.isGolden("pies"), false, "three days, stage 3");
  b.clock.t += DAY; b.m.record("pies");
  eq(b.m.isGolden("pies"), true, "four quiet evenings");

  // Golden is never taken back, however long the absence.
  a.clock.t += 400 * DAY; a.m.record("kot");
  eq(a.m.isGolden("kot"), true, "still golden after a year away");
  a.clock.t += 4000 * DAY; a.m.record("kot");
  a.clock.t += 4000 * DAY; a.m.record("kot");
  eq(a.m.isGolden("kot"), true, "and after many years");
});

test("a late night counts as one visit day (day starts at 04:00)", function () {
  var start = new Date(2026, 10, 10, 22, 0, 0).getTime();
  var env = load({ t: start });
  env.m.record("noc");
  env.clock.t = start + 5 * HOUR; // 03:00 next morning
  env.m.record("noc");
  eq(env.m.entries()[0].days, 1);
  eq(env.m.entries()[0].today, true);
  eq(env.m.familiarity("noc"), "new", "still tonight");
  env.clock.t = start + 7 * HOUR; // 05:00
  eq(env.m.entries()[0].today, false);
  eq(env.m.familiarity("noc"), "returning");
  env.m.record("noc");
  eq(env.m.entries()[0].days, 2);
  eq(env.m.entries()[0].today, true);
});

/* ---------- hideTranslation ---------- */

test("hideTranslation is never true for a first meeting or the same day", function () {
  var env = load({ random: "function () { return 0; }" }); // always "lucky"
  eq(env.m.hideTranslation("kot"), false, "never met");
  env.m.record("kot");
  eq(env.m.hideTranslation("kot"), false, "met once today");
  for (var i = 0; i < 10; i++) { env.clock.t += 20 * MIN; env.m.record("kot"); }
  env.clock.t = T0 + 10 * HOUR; // 22:00 the same visit day
  eq(env.m.hideTranslation("kot"), false, "met many times, same day");
  env.clock.t = T0 + DAY;
  eq(env.m.hideTranslation("kot"), true, "returning the next day, before record");
  env.m.record("kot");
  eq(env.m.hideTranslation("kot"), true, "returning the next day, after record");
});

function hideRate(env, id) {
  var hits = 0, n = 20000;
  for (var i = 0; i < n; i++) if (env.m.hideTranslation(id)) hits++;
  return hits / n;
}

test("hideTranslation follows the schedule: rare when fragile, often when settled and due", function () {
  var env = load();
  env.m.record("kot");                       // stage 1
  env.clock.t += 2 * DAY;
  var fragile = hideRate(env, "kot");
  ok(fragile > 0.12 && fragile < 0.18, "stage 1, due: " + fragile);

  env.m.record("kot");                       // stage 2, resting
  var resting = hideRate(env, "kot");
  ok(resting > 0.07 && resting < 0.13, "stage 2, just caught: " + resting);
  env.clock.t += 10 * MIN; env.m.record("kot");   // 3
  env.clock.t += HOUR; env.m.record("kot");       // 4
  env.clock.t += DAY;
  var settled = hideRate(env, "kot");
  ok(settled > 0.52 && settled < 0.58, "stage 4, due: " + settled);
  env.m.record("kot");                       // stage 5, third day: golden
  eq(env.m.isGolden("kot"), true);
  var goldRest = hideRate(env, "kot");
  ok(goldRest > 0.21 && goldRest < 0.27, "golden, resting: " + goldRest);
  env.clock.t += 3 * DAY;
  var gold = hideRate(env, "kot");
  ok(gold > 0.57 && gold < 0.63, "golden, due: " + gold);
});

test("hideTranslation does not change anything", function () {
  var env = load();
  env.m.record("kot");
  env.clock.t += DAY;
  var before = JSON.stringify(env.m.entries()), n = env.events.length;
  for (var i = 0; i < 50; i++) env.m.hideTranslation("kot");
  eq(JSON.stringify(env.m.entries()), before);
  eq(env.events.length, n);
});

/* ---------- persistence and events ---------- */

test("persistence round trip", function () {
  var s = makeStorage();
  var a = load({ storage: s });
  visit(a, "kot", 4, 2);
  a.m.record("pies");
  a.m.record("kotek", { via: "related" });
  var before = JSON.stringify(a.m.entries());
  ok(s.data[KEY], "something stored under " + KEY);
  eq(Object.keys(s.data).length, 1, "one key only (probe cleaned up)");

  var b = load({ storage: s, t: a.clock.t });
  eq(JSON.stringify(b.m.entries()), before, "same entries after reload");
  eq(b.m.isGolden("kot"), true);
  eq(b.m.weight("pies"), a.m.weight("pies"));
  eq(b.m.isMet("kotek"), false);
});

test("entries: fresh copies, most recent first, all fields", function () {
  var env = load();
  env.m.record("a");
  env.clock.t += HOUR;
  env.m.record("b");
  var list = env.m.entries();
  eq(list[0].id, "b");
  eq(list[1].id, "a");
  ["id", "count", "firstSeen", "lastSeen", "days", "golden", "caught", "today", "stage", "due"].forEach(function (k) {
    ok(k in list[0], "has " + k);
  });
  eq(list[0].due, false);
  eq(list[1].due, true);
  list[0].count = 999;
  eq(env.m.entries()[0].count, 1, "mutating the copy does not touch memory");
});

test("record dispatches memory:change { id }", function () {
  var env = load();
  env.m.record("kot");
  eq(env.events.length, 1);
  eq(env.events[0].type, "memory:change");
  eq(env.events[0].detail.id, "kot");
  env.m.record(5);
  eq(env.events.length, 1, "nothing for an invalid id");
});

test("a change in another tab reloads and emits { id: null }", function () {
  var s = makeStorage();
  var a = load({ storage: s });
  var b = load({ storage: s });
  a.m.record("kot");
  eq(b.m.entries().length, 0);
  b.fire("storage", { key: KEY });
  eq(b.m.entries().length, 1);
  eq(b.events[b.events.length - 1].detail.id, null);
  b.fire("storage", { key: "something.else" });
  eq(b.events.length, 1, "other keys ignored");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
