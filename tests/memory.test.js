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
var KEY = "iskry.memory.v1";
var HOUR = 3600 * 1000;
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

test("unknown ids: weight 1, not golden, no hide, never throw", function () {
  var env = load();
  eq(env.m.weight("nope"), 1);
  eq(env.m.isGolden("nope"), false);
  eq(env.m.hideTranslation("nope"), false);
  [undefined, null, 42, {}, [], "", "x".repeat(500), "__proto__", "constructor", "toString"].forEach(function (bad) {
    var w = env.m.weight(bad);
    ok(w > 0 && isFinite(w), "weight positive for " + String(bad));
    eq(env.m.isGolden(bad), false);
    eq(env.m.hideTranslation(bad), false);
    env.m.record(bad); // must not throw
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
  eq(reloaded.m.weight("toString"), 1, "prototype names are not entries");
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
  eq(env.m.weight("kot"), 0.5);
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
  var env = load({ storage: s });
  eq(env.m.entries().length, 0);
  env.m.record("kot");
  var parsed = JSON.parse(s.data[KEY]);
  eq(parsed.v, 1);
  eq(parsed.words.kot.c, 1);
});

test("wrong shape or version is ignored; bad entries dropped one by one", function () {
  ["null", "42", "[]", '"str"', '{"v":2,"words":{"kot":{"c":3,"f":1,"l":2,"d":[]}}}', '{"v":1}', '{"v":1,"words":7}']
    .forEach(function (raw) {
      var s = makeStorage(); s.data[KEY] = raw;
      eq(load({ storage: s }).m.entries().length, 0, "for " + raw);
    });
  var s = makeStorage();
  s.data[KEY] = JSON.stringify({ v: 1, words: {
    good: { c: 2, f: T0 - DAY, l: T0 - HOUR, d: ["2026-11-09", "2026-11-10", "bad", 5, "2026-11-10"] },
    zero: { c: 0, f: T0, l: T0, d: [] },
    nan: { c: 1, f: "x", l: T0, d: [] },
    str: "hello",
    nodays: { c: 1, f: T0, l: T0 }
  } });
  var env = load({ storage: s });
  var ids = env.m.entries().map(function (e) { return e.id; }).sort();
  eq(ids.join(","), "good,nodays");
  var good = env.m.entries().filter(function (e) { return e.id === "good"; })[0];
  eq(good.days, 2, "invalid and duplicate day keys dropped");
  eq(env.m.entries().filter(function (e) { return e.id === "nodays"; })[0].days, 1, "missing days fall back to last seen");
});

/* ---------- weight ---------- */

test("weight stays within 0.5..2, never 0, and rises with absence", function () {
  var env = load();
  env.m.record("kot");
  var prev = 0;
  [0, 0.1, 1, 3, 6, 12, 24, 48, 24 * 30, 24 * 3650].forEach(function (h) {
    env.clock.t = T0 + h * HOUR;
    var w = env.m.weight("kot");
    ok(w >= 0.5 && w <= 2, "in band at " + h + "h: " + w);
    ok(w >= prev, "non-decreasing at " + h + "h");
    prev = w;
  });
  env.clock.t = T0;
  eq(env.m.weight("kot"), 0.5, "just seen");
  env.clock.t = T0 + DAY;
  ok(env.m.weight("kot") > 1.5, "a day away favours it over a new word");
  ok(env.m.weight("kot") > env.m.weight("pies"), "old friend beats stranger after a while");
});

test("weight with the clock going backwards stays in band", function () {
  var env = load();
  env.m.record("kot");
  env.clock.t = T0 - 10 * DAY;
  var w = env.m.weight("kot");
  ok(w >= 0.5 && w <= 2, "got " + w);
});

/* ---------- golden ---------- */

test("golden needs >= 5 views on >= 3 distinct days", function () {
  var env = load();
  for (var i = 0; i < 20; i++) env.m.record("one-day");
  eq(env.m.isGolden("one-day"), false, "many views, one day");

  visit(env, "two-days", 2, 5);
  eq(env.m.isGolden("two-days"), false, "many views, two days");

  visit(env, "thin", 3, 1);
  eq(env.m.isGolden("thin"), false, "three days but only 3 views");

  var env2 = load();
  env2.m.record("kot");
  env2.m.record("kot");
  env2.clock.t += DAY;
  env2.m.record("kot");
  env2.m.record("kot");
  eq(env2.m.isGolden("kot"), false, "4 views, 2 days");
  env2.m.record("kot");
  eq(env2.m.isGolden("kot"), false, "5 views, still 2 days");
  env2.clock.t += DAY;
  env2.m.record("kot");
  eq(env2.m.isGolden("kot"), true, "6 views on 3 days");
  eq(env2.m.entries()[0].golden, true);
});

test("a late night counts as one visit day (day starts at 04:00)", function () {
  var start = new Date(2026, 10, 10, 22, 0, 0).getTime();
  var env = load({ t: start });
  env.m.record("noc");
  env.clock.t = start + 5 * HOUR; // 03:00 next morning
  env.m.record("noc");
  eq(env.m.entries()[0].days, 1);
  env.clock.t = start + 7 * HOUR; // 05:00
  env.m.record("noc");
  eq(env.m.entries()[0].days, 2);
});

/* ---------- hideTranslation ---------- */

test("hideTranslation is never true for a first meeting or the same day", function () {
  var env = load({ random: "function () { return 0; }" }); // always "lucky"
  eq(env.m.hideTranslation("kot"), false, "never met");
  env.m.record("kot");
  eq(env.m.hideTranslation("kot"), false, "met once today");
  for (var i = 0; i < 10; i++) env.m.record("kot");
  env.clock.t += 10 * HOUR; // 22:00 the same visit day
  eq(env.m.hideTranslation("kot"), false, "met many times, same day");
  env.clock.t = T0 + DAY;
  eq(env.m.hideTranslation("kot"), true, "returning the next day, before record");
  env.m.record("kot");
  eq(env.m.hideTranslation("kot"), true, "returning the next day, after record");
});

test("hideTranslation is about 1 in 4 for returning words", function () {
  var env = load();
  env.m.record("kot");
  env.clock.t += 2 * DAY;
  var hits = 0, n = 20000;
  for (var i = 0; i < n; i++) if (env.m.hideTranslation("kot")) hits++;
  var rate = hits / n;
  ok(rate > 0.22 && rate < 0.28, "rate " + rate);
});

/* ---------- persistence and events ---------- */

test("persistence round trip", function () {
  var s = makeStorage();
  var a = load({ storage: s });
  visit(a, "kot", 3, 2);
  a.m.record("pies");
  var before = JSON.stringify(a.m.entries());
  ok(s.data[KEY], "something stored under " + KEY);
  eq(Object.keys(s.data).length, 1, "one key only (probe cleaned up)");

  var b = load({ storage: s, t: a.clock.t });
  eq(JSON.stringify(b.m.entries()), before, "same entries after reload");
  eq(b.m.isGolden("kot"), true);
  eq(b.m.weight("pies"), a.m.weight("pies"));
});

test("entries: fresh copies, most recent first, all fields", function () {
  var env = load();
  env.m.record("a");
  env.clock.t += HOUR;
  env.m.record("b");
  var list = env.m.entries();
  eq(list[0].id, "b");
  eq(list[1].id, "a");
  ["id", "count", "firstSeen", "lastSeen", "days", "golden"].forEach(function (k) {
    ok(k in list[0], "has " + k);
  });
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
