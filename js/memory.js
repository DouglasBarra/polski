/*
  OWNER: memory agent. Other modules call this one and do not edit it.
  STATUS: Phase 4, "gentle spacing". Every earlier signature still works; record() takes
  an optional second argument and familiarity() / isMet() are new.

  THE IDEA
    A word you catch should come back while you can still almost remember it: a few
    minutes later, then later the same evening, then tomorrow, then in a few days, a
    week, three weeks. Nobody is told any of this. The only thing memory does is make
    some words a little more likely to drift past than others, and now and then ask the
    card to hide the English for a moment. No scores, no right or wrong, and nothing here
    is ever shown as a number.

  THE SCHEDULE
    Each caught word has a stage, 1 to MAX_STAGE. INTERVALS[stage] is how long it rests
    after the catch that put it there:
        1: 2 min   2: 10 min   3: 1 h   4: a day   5: 3 days   6: 8 days   7: 3 weeks
    ("a day" is 20 hours, so tomorrow evening counts even if you sit down a little
    earlier.) While it rests it is "not due"; after that it is "due".
    A CATCH (the visitor clicked the drifting word) moves the schedule:
      - first catch: stage 1.
      - caught while due: one stage up. Never more than one step per catch, and from
        stage 4 on each step needs at least a day, so the top takes weeks.
      - caught while resting: nothing moves, the rest simply starts again.
      - caught after a very long absence (stage 4 and up only): between FORGIVE_HOLD and
        FORGIVE_DROP intervals late the stage is kept, later than that it goes down by
        one, but never below stage 4. It is never reset, and a golden word stays golden.
    A RELATED view (the word was opened from a chip on another word's card) is a light
    touch: it is counted as a view and nothing else. It does not move the stage, does not
    count as a visit day and so can never make a word golden.

  CONTRACT
    Iskry.memory.weight(id)   -> number > 0, about 0.3 to 8. Relative chance of this word
                                 being spawned; the scene calls it for every candidate.
                                   never caught          1, falling to UNMET_LOW (0.2) while
                                                         many caught words are "in the air"
                                                         so the evening circles around them
                                   caught, resting       REST_MIN (0.3) just after the catch,
                                                         rising to 1.2 (stages 1 to 3, still
                                                         tonight's word) or 0.6 (stage 4 and
                                                         up) as the rest runs out
                                   caught, due           DUE_HIGH (8, or 6 from stage 4 on)
                                                         when it becomes due or the visit
                                                         starts, easing down to DUE_LINGER
                                                         (1.5) over the next minutes, so a
                                                         word that is not caught again drifts
                                                         by more and more sparsely
                                 When very many words are due at once their weights are
                                 scaled so together they stay near DUE_BUDGET: old friends
                                 take about half the sky at most. Never 0.
    Iskry.memory.record(id, opts) -> undefined. "This word was looked at."
                                 opts.via: "catch" (default; one-argument calls are
                                 catches) or "related" (see above). Dispatches
                                 "memory:change".
    Iskry.memory.isGolden(id) -> boolean. Stage GOLDEN_MIN_STAGE (4) or more, caught on at
                                 least GOLDEN_MIN_DAYS (3) separate visit days. A quiet
                                 sign of familiarity, never a score, badge or streak.
    Iskry.memory.isMet(id)    -> boolean. Caught at least once.
    Iskry.memory.familiarity(id) -> "new" | "returning" | "golden". "new": never caught,
                                 or first caught today. "returning": first caught on an
                                 earlier visit day. Ask BEFORE record(id).
    Iskry.memory.entries()    -> array, a fresh copy each call, most recently seen first:
                                   [{ id, count, firstSeen, lastSeen, days, golden,
                                      caught, today, stage, due }]
                                 count is all views, days the distinct catch days, caught
                                 whether it was ever caught (a word only opened from a
                                 chip has caught: false), today whether it was caught
                                 this visit day. For code only: never show a number.
                                 May contain ids that are not in Iskry.WORDS.
    Iskry.memory.hideTranslation(id) -> boolean. A gentle "do you remember?". Never for a
                                 word first caught today or never caught. Otherwise
                                 random, by how settled the word is: HIDE_BY_STAGE
                                 (0.15 at stage 1 up to 0.55 from stage 4), HIDE_GOLDEN
                                 (0.6) for a golden word, and HIDE_RESTING (x 0.4) of that
                                 when the word is not due. Nothing is inferred from
                                 whether the visitor lifts the veil. Call it once per
                                 showing, before record(id).
  Everything is synchronous, never throws, and accepts unknown ids.

  EVENT
    "memory:change" on document, detail { id }, after every record(). Also fired with
    detail { id: null } when another tab changed the stored memory.

  STORAGE
    One localStorage key, STORAGE_KEY ("iskry.memory.v2"), JSON:
      { v: 2, words: { [id]: { c, n, f, l, k, a, s, d } } }
        c views (catches and related)     n catches
        f first seen ms                   l last seen ms
        k last catch ms (0: never)        a ms when the current rest began
        s stage (0: never caught)         d [dayKey...] visit days with a catch
    dayKey is the local date "YYYY-MM-DD" of a visit; a visit day starts at
    DAY_START_HOUR (04:00) so a late night by the fire is one day. d keeps the most
    recent MAX_DAYS_KEPT days.
    MIGRATION: when there is no v2 data, "iskry.memory.v1" ({ c, f, l, d }) is read and
    converted (every old view counts as a catch; stage = min(views, days + 2), so a word
    that was golden stays golden). The v1 key is left where it is.
    Every storage access is wrapped in try/catch: if storage is unavailable, throws, or
    holds corrupt data, memory carries on in memory only for this page. Corrupt entries
    are dropped one by one, not the whole store.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  var SECOND_MS = 1000;
  var MINUTE_MS = 60 * SECOND_MS;
  var HOUR_MS = 60 * MINUTE_MS;
  var DAY_MS = 24 * HOUR_MS;
  var DAYISH_MS = 20 * HOUR_MS;      // "tomorrow evening", even a little earlier than today

  /* ---------- tuning ---------- */
  var STORAGE_KEY = "iskry.memory.v2";
  var LEGACY_KEY = "iskry.memory.v1";
  var VERSION = 2;

  // INTERVALS[stage]: how long a word rests after the catch that put it at that stage.
  var INTERVALS = [
    0,
    2 * MINUTE_MS,
    10 * MINUTE_MS,
    HOUR_MS,
    DAYISH_MS,
    2 * DAY_MS + DAYISH_MS,
    7 * DAY_MS + DAYISH_MS,
    20 * DAY_MS + DAYISH_MS
  ];
  var MAX_STAGE = INTERVALS.length - 1;
  var DAY_STAGE = 4;                 // first stage whose rest is a day or more
  var FORGIVE_HOLD = 8;              // later than this many intervals: the stage is kept
  var FORGIVE_DROP = 20;             // later than this many: one stage down (not below 4)

  var GOLDEN_MIN_STAGE = 4;
  var GOLDEN_MIN_DAYS = 3;

  var WEIGHT_NEW = 1;                // a word never caught, on a quiet night
  var UNMET_LOW = 0.2;               // ... while many caught words are in the air
  var AIR_FEW = 2;                   // up to this many in the air: new words are not held back
  var AIR_MANY = 8;                  // from this many: new words are at UNMET_LOW
  var REST_MIN = 0.3;                // just caught
  var REST_MAX = 0.6;                // resting, almost due (stage 4 and up: days to go)
  var REST_MAX_YOUNG = 1.2;          // ... stages 1 to 3: still tonight's word, let it pass by
  var DUE_HIGH_YOUNG = 8;            // due, stages 1 to 3
  var DUE_HIGH_OLD = 6;              // due, stage 4 and up
  var DUE_LINGER = 1.5;              // due for a long while and not caught again
  var DUE_RELAX_MS = 3 * MINUTE_MS;  // a due word's weight halves after this long, and so on
  var DUE_FLOOR = 0.6;               // a due word never weighs less, however many are due
  var DUE_BUDGET = 45;               // all due words together stay near this
  var HOT_WEIGHT = 2;                // a due word above this is "in the air"
  var YOUNG_AIR_MS = 3 * HOUR_MS;    // a resting word of stage 1 to 3 caught this recently is too
  var SESSION_GAP_MS = 15 * MINUTE_MS; // no weight() call for this long: a new visit begins

  var HIDE_BY_STAGE = [0, 0.15, 0.25, 0.4, 0.55, 0.55, 0.55, 0.55];
  var HIDE_GOLDEN = 0.6;
  var HIDE_RESTING = 0.4;

  var DAY_START_HOUR = 4;            // a visit day runs 04:00 .. 03:59 local time
  var MAX_DAYS_KEPT = 32;
  var MAX_ID_LENGTH = 80;
  var AGGREGATE_TTL_MS = SECOND_MS;

  var hasOwn = Object.prototype.hasOwnProperty;

  var words = Object.create(null);   // id -> { c, n, f, l, k, a, s, d: [] }
  var storage = null;                // localStorage, or null when unavailable
  var sessionStart = 0;              // ms: when this visit began
  var lastAsked = 0;                 // ms: the last weight() call
  var agg = null;                    // { t, unmet, dueScale }: the state of the whole sky

  /* ---------- helpers ---------- */

  function now() {
    var t = Date.now();
    return typeof t === "number" && isFinite(t) ? t : 0;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function dayKey(t) {
    var d = new Date(t - DAY_START_HOUR * HOUR_MS);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function validId(id) {
    return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;
  }

  function get(id) {
    return validId(id) && hasOwn.call(words, id) ? words[id] : null;
  }

  function clampStage(s) {
    s = Math.floor(Number(s));
    if (!(s >= 0)) return 0;
    return s > MAX_STAGE ? MAX_STAGE : s;
  }

  function cleanDays(list) {
    var d = [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var k = list[i];
        if (typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k) && d.indexOf(k) < 0) d.push(k);
      }
    }
    d.sort();
    if (d.length > MAX_DAYS_KEPT) d = d.slice(d.length - MAX_DAYS_KEPT);
    return d;
  }

  // A v2 entry, or null when it cannot be trusted.
  function sanitizeEntry(e) {
    if (!e || typeof e !== "object") return null;
    var c = Math.floor(Number(e.c));
    var f = Number(e.f);
    var l = Number(e.l);
    if (!(c >= 1) || !isFinite(f) || !isFinite(l)) return null;
    if (f > l) f = l;
    var n = Math.floor(Number(e.n));
    if (!(n >= 0)) n = 0;
    if (n > c) n = c;
    var s = clampStage(e.s);
    var d = cleanDays(e.d);
    var k = Number(e.k);
    var a = Number(e.a);
    if (n === 0) {
      return { c: c, n: 0, f: f, l: l, k: 0, a: 0, s: 0, d: [] };
    }
    if (!isFinite(k) || k <= 0) k = l;
    if (!isFinite(a) || a <= 0) a = k;
    if (s < 1) s = 1;
    if (d.length === 0) d.push(dayKey(k));
    return { c: c, n: n, f: f, l: l, k: k, a: a, s: s, d: d };
  }

  // A v1 entry { c, f, l, d } as a v2 one. Every old view is taken as a catch.
  function migrateEntry(e) {
    if (!e || typeof e !== "object") return null;
    var c = Math.floor(Number(e.c));
    var f = Number(e.f);
    var l = Number(e.l);
    if (!(c >= 1) || !isFinite(f) || !isFinite(l)) return null;
    if (f > l) f = l;
    var d = cleanDays(e.d);
    if (d.length === 0) d.push(dayKey(l));
    var s = Math.max(1, Math.min(c, d.length + 2, MAX_STAGE));
    return { c: c, n: c, f: f, l: l, k: l, a: l, s: s, d: d };
  }

  function golden(e) {
    return !!e && e.s >= GOLDEN_MIN_STAGE && e.d.length >= GOLDEN_MIN_DAYS;
  }

  function dueAt(e) {
    return e.a + INTERVALS[e.s];
  }

  /* ---------- storage ---------- */

  function openStorage() {
    try {
      var s = window.localStorage;
      if (!s) return null;
      var probe = STORAGE_KEY + ".probe";
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch (e) {
      return null;
    }
  }

  // Reads one key. Returns a words map, or null when the key holds nothing usable.
  function read(key, version, convert) {
    try {
      var raw = storage.getItem(key);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object" || data.v !== version ||
          !data.words || typeof data.words !== "object") return null;
      var out = Object.create(null);
      for (var id in data.words) {
        if (!hasOwn.call(data.words, id) || !validId(id)) continue;
        var e = convert(data.words[id]);
        if (e) out[id] = e;
      }
      return out;
    } catch (err) {
      return null; // corrupt or unreadable
    }
  }

  function load() {
    var next = null;
    var migrated = false;
    if (storage) {
      next = read(STORAGE_KEY, VERSION, sanitizeEntry);
      if (!next) {
        next = read(LEGACY_KEY, 1, migrateEntry);
        migrated = !!next;
      }
    }
    words = next || Object.create(null);
    agg = null;
    if (migrated) save();
  }

  function save() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, words: words }));
    } catch (e) {
      /* full or revoked: keep going in memory */
    }
  }

  function emit(id) {
    try {
      var doc = window.document;
      if (!doc || typeof doc.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
      doc.dispatchEvent(new window.CustomEvent("memory:change", { detail: { id: id } }));
    } catch (e) {
      /* a listener's problem is not ours */
    }
  }

  /* ---------- the sky as a whole ---------- */

  // How strongly a due word pulls right now: high when it becomes due (or when the visit
  // starts, for a word that was already due), then easing down, as if it had drifted by
  // unanswered a few times. Memory is never told which words actually passed.
  function duePull(e, t) {
    var from = Math.max(dueAt(e), sessionStart);
    var since = t > from ? t - from : 0;
    var high = e.s < DAY_STAGE ? DUE_HIGH_YOUNG : DUE_HIGH_OLD;
    var w = high / (1 + since / DUE_RELAX_MS);
    return w > DUE_LINGER ? w : DUE_LINGER;
  }

  function aggregate(t) {
    if (agg && t >= agg.t && t - agg.t < AGGREGATE_TTL_MS) return agg;
    var dueMass = 0;
    var air = 0;
    for (var id in words) {
      var e = words[id];
      if (e.s < 1) continue;
      if (t >= dueAt(e)) {
        var w = duePull(e, t);
        dueMass += w;
        if (w > HOT_WEIGHT) air++;
      } else if (e.s < DAY_STAGE && t - e.k < YOUNG_AIR_MS) {
        air++;
      }
    }
    var crowd = (air - AIR_FEW) / (AIR_MANY - AIR_FEW);
    if (!(crowd > 0)) crowd = 0;
    if (crowd > 1) crowd = 1;
    agg = {
      t: t,
      unmet: crowd >= 1 ? UNMET_LOW : WEIGHT_NEW + (UNMET_LOW - WEIGHT_NEW) * crowd,
      dueScale: dueMass > DUE_BUDGET ? DUE_BUDGET / dueMass : 1
    };
    return agg;
  }

  /* ---------- API ---------- */

  function weight(id) {
    try {
      var t = now();
      // The scene asks for weights every few seconds while it is being watched. A long
      // silence (tab hidden, laptop closed) means a new visit: due words start fresh.
      if (t - lastAsked > SESSION_GAP_MS || t < lastAsked) { sessionStart = t; agg = null; }
      lastAsked = t;

      var sky = aggregate(t);
      var e = get(id);
      if (!e || e.s < 1) return sky.unmet;

      var w;
      var rest = INTERVALS[e.s];
      var away = t - e.a;
      if (away >= rest) {
        w = duePull(e, t) * sky.dueScale;
        if (w < DUE_FLOOR) w = DUE_FLOOR;
      } else {
        var p = away > 0 ? away / rest : 0;
        w = REST_MIN + ((e.s < DAY_STAGE ? REST_MAX_YOUNG : REST_MAX) - REST_MIN) * p * p;
      }
      return isFinite(w) && w > 0 ? w : WEIGHT_NEW;
    } catch (err) {
      return WEIGHT_NEW;
    }
  }

  function record(id, opts) {
    try {
      if (!validId(id)) return;
      var related = !!opts && typeof opts === "object" && opts.via === "related";
      var t = now();
      var e = hasOwn.call(words, id) ? words[id] : null;
      if (!e) {
        e = words[id] = { c: 0, n: 0, f: t, l: t, k: 0, a: 0, s: 0, d: [] };
      }
      e.c += 1;
      e.l = t;

      if (!related) {
        if (e.s < 1) {
          e.s = 1;
        } else {
          var rest = INTERVALS[e.s];
          var away = t - e.a;
          if (away >= rest) {
            if (e.s > DAY_STAGE && away > rest * FORGIVE_DROP) e.s -= 1;
            else if (e.s >= DAY_STAGE && away > rest * FORGIVE_HOLD) { /* kept */ }
            else if (e.s < MAX_STAGE) e.s += 1;
          }
          // Caught while resting: the stage stays and the rest starts again.
        }
        e.a = t;
        e.k = t;
        e.n += 1;
        var k = dayKey(t);
        if (e.d.indexOf(k) < 0) {
          e.d.push(k);
          e.d.sort();
          if (e.d.length > MAX_DAYS_KEPT) e.d.shift();
        }
      }
      agg = null;
      save();
      emit(id);
    } catch (err) {
      /* memory must never break the card */
    }
  }

  function isGolden(id) {
    try {
      return golden(get(id));
    } catch (err) {
      return false;
    }
  }

  function isMet(id) {
    try {
      var e = get(id);
      return !!e && e.s >= 1;
    } catch (err) {
      return false;
    }
  }

  // First caught on an earlier visit day than today.
  function returning(e, t) {
    return !!e && e.s >= 1 && e.d.length > 0 && e.d[0] < dayKey(t);
  }

  function familiarity(id) {
    try {
      var e = get(id);
      if (golden(e)) return "golden";
      return returning(e, now()) ? "returning" : "new";
    } catch (err) {
      return "new";
    }
  }

  function entries() {
    var list = [];
    try {
      var t = now();
      var today = dayKey(t);
      for (var id in words) {
        var e = words[id];
        list.push({
          id: id,
          count: e.c,
          firstSeen: e.f,
          lastSeen: e.l,
          days: e.d.length,
          golden: golden(e),
          caught: e.s >= 1,
          today: e.s >= 1 && dayKey(e.k) === today,
          stage: e.s,
          due: e.s >= 1 && t >= dueAt(e)
        });
      }
      list.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    } catch (err) {
      /* return what we have */
    }
    return list;
  }

  function hideTranslation(id) {
    try {
      var e = get(id);
      var t = now();
      if (!returning(e, t)) return false;
      var p = golden(e) ? HIDE_GOLDEN : HIDE_BY_STAGE[e.s] || 0;
      if (t < dueAt(e)) p *= HIDE_RESTING;
      return Math.random() < p;
    } catch (err) {
      return false;
    }
  }

  /* ---------- boot ---------- */

  storage = openStorage();
  sessionStart = lastAsked = now();
  load();

  try {
    if (storage && typeof window.addEventListener === "function") {
      window.addEventListener("storage", function (ev) {
        if (ev && ev.key !== null && ev.key !== STORAGE_KEY) return;
        load();
        emit(null);
      });
    }
  } catch (e) {
    /* no cross-tab sync, fine */
  }

  Iskry.memory = {
    weight: weight,
    record: record,
    isGolden: isGolden,
    isMet: isMet,
    familiarity: familiarity,
    entries: entries,
    hideTranslation: hideTranslation
  };
})(window.Iskry);
