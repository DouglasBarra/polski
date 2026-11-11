/*
  OWNER: director (delegated to the memory agent for Phase 2). Builder agents call this
  module and do not edit it.
  STATUS: Phase 2. The Phase 1 signatures are unchanged; entries() and hideTranslation()
  are new and only add to them.

  CONTRACT
    Iskry.memory.weight(id)   -> number > 0. Relative chance of this word being spawned.
                                 Called by the scene for each candidate when it picks the
                                 next word. A word never met is 1. A word met before sits
                                 in [WEIGHT_MIN, WEIGHT_MAX] (0.5 .. 2): low right after it
                                 was seen (so it does not come straight back), rising
                                 smoothly the longer it has been away (old friends drift
                                 back). Never 0.
    Iskry.memory.record(id)   -> undefined. "This word was looked at." Called by the card
                                 every time a word is shown (including a switch to a related
                                 word). Saves the count, first and last seen time and the
                                 distinct visit days, then dispatches "memory:change".
    Iskry.memory.isGolden(id) -> boolean. Whether the scene should draw this word with the
                                 is-golden class: met at least GOLDEN_MIN_COUNT times on at
                                 least GOLDEN_MIN_DAYS separate days. A quiet sign of
                                 familiarity, never a score, badge or streak.
  All three are synchronous, never throw, and accept unknown ids.

  READ API (Phase 2, for the journal and the card)
    Iskry.memory.entries()    -> array, a fresh copy each call, most recently seen first:
                                   [{ id, count, firstSeen, lastSeen, days, golden }]
                                 firstSeen/lastSeen are ms since the epoch, days is the
                                 number of distinct visit days. These numbers are for code
                                 only: nothing here is ever shown to the user as a number.
                                 May contain ids that are not (or no longer) in Iskry.WORDS;
                                 callers skip those.
    Iskry.memory.hideTranslation(id) -> boolean. A gentle "do you remember?". When true,
                                 the card should first show the word WITHOUT its English
                                 (meaning and example translation), and reveal it on a click
                                 or Enter/Space, with no judgement either way. True only for a
                                 returning word: first met on an earlier visit day than
                                 today (so never on a first meeting, nor later the same
                                 day) and then only about 1 time in HIDE_CHANCE_INV (4).
                                 It is random: call it once per showing, and it does not
                                 matter whether it is called before or after record(id).
                                 The card agent consumes this (not yet wired in Phase 2).
                                 Synchronous, never throws, false for unknown ids.

  EVENT
    "memory:change" on document, detail { id }, after every record(id). Also fired with
    detail { id: null } when another tab changed the stored memory.

  STORAGE
    One localStorage key, STORAGE_KEY ("iskry.memory.v1"), JSON:
      { v: 1, words: { [id]: { c: count, f: firstSeenMs, l: lastSeenMs, d: [dayKey...] } } }
    dayKey is the local date "YYYY-MM-DD" of a visit; a visit day starts at DAY_START_HOUR
    (04:00) so a late night by the fire is one day, not two. d keeps the most recent
    MAX_DAYS_KEPT days (plenty for golden). Every storage access is wrapped in try/catch:
    if storage is unavailable, throws, or holds corrupt data, memory carries on in memory
    only for this page. Corrupt entries are dropped one by one, not the whole store.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  /* ---------- tuning ---------- */
  var STORAGE_KEY = "iskry.memory.v1";
  var VERSION = 1;
  var GOLDEN_MIN_COUNT = 5;          // views in total ...
  var GOLDEN_MIN_DAYS = 3;           // ... spread over at least this many visit days
  var WEIGHT_NEW = 1;                // a word never met
  var WEIGHT_MIN = 0.5;              // a word just seen
  var WEIGHT_MAX = 2;                // a word met before and away for a long time
  var WEIGHT_TAU_HOURS = 10;         // how fast the weight climbs back (63% after this long)
  var HIDE_CHANCE_INV = 4;           // hideTranslation: about 1 in 4 for returning words
  var DAY_START_HOUR = 4;            // a visit day runs 04:00 .. 03:59 local time
  var MAX_DAYS_KEPT = 32;
  var MAX_ID_LENGTH = 80;

  var HOUR_MS = 3600 * 1000;
  var hasOwn = Object.prototype.hasOwnProperty;

  var words = Object.create(null);   // id -> { c, f, l, d: [] }
  var storage = null;                // localStorage, or null when unavailable

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

  function sanitizeEntry(e) {
    if (!e || typeof e !== "object") return null;
    var c = Math.floor(Number(e.c));
    var f = Number(e.f);
    var l = Number(e.l);
    if (!(c >= 1) || !isFinite(f) || !isFinite(l)) return null;
    var d = [];
    if (Array.isArray(e.d)) {
      for (var i = 0; i < e.d.length; i++) {
        var k = e.d[i];
        if (typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k) && d.indexOf(k) < 0) d.push(k);
      }
    }
    if (d.length === 0) d.push(dayKey(l));
    if (d.length > MAX_DAYS_KEPT) d = d.slice(d.length - MAX_DAYS_KEPT);
    if (f > l) f = l;
    return { c: c, f: f, l: l, d: d };
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

  function load() {
    var next = Object.create(null);
    if (storage) {
      try {
        var raw = storage.getItem(STORAGE_KEY);
        var data = raw ? JSON.parse(raw) : null;
        if (data && typeof data === "object" && data.v === VERSION &&
            data.words && typeof data.words === "object") {
          for (var id in data.words) {
            if (!hasOwn.call(data.words, id) || !validId(id)) continue;
            var e = sanitizeEntry(data.words[id]);
            if (e) next[id] = e;
          }
        }
      } catch (err) {
        /* corrupt or unreadable: start fresh in memory */
      }
    }
    words = next;
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

  /* ---------- API ---------- */

  function weight(id) {
    try {
      var e = get(id);
      if (!e) return WEIGHT_NEW;
      var away = Math.max(0, now() - e.l) / HOUR_MS;
      var w = WEIGHT_MIN + (WEIGHT_MAX - WEIGHT_MIN) * (1 - Math.exp(-away / WEIGHT_TAU_HOURS));
      return isFinite(w) && w > 0 ? w : WEIGHT_NEW;
    } catch (err) {
      return WEIGHT_NEW;
    }
  }

  function record(id) {
    try {
      if (!validId(id)) return;
      var t = now();
      var k = dayKey(t);
      var e = hasOwn.call(words, id) ? words[id] : null;
      if (!e) {
        e = words[id] = { c: 0, f: t, l: t, d: [] };
      }
      e.c += 1;
      e.l = t;
      if (e.d.indexOf(k) < 0) {
        e.d.push(k);
        if (e.d.length > MAX_DAYS_KEPT) e.d.shift();
      }
      save();
      emit(id);
    } catch (err) {
      /* memory must never break the card */
    }
  }

  function isGolden(id) {
    try {
      var e = get(id);
      return !!e && e.c >= GOLDEN_MIN_COUNT && e.d.length >= GOLDEN_MIN_DAYS;
    } catch (err) {
      return false;
    }
  }

  function entries() {
    var list = [];
    try {
      for (var id in words) {
        var e = words[id];
        list.push({
          id: id,
          count: e.c,
          firstSeen: e.f,
          lastSeen: e.l,
          days: e.d.length,
          golden: e.c >= GOLDEN_MIN_COUNT && e.d.length >= GOLDEN_MIN_DAYS
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
      if (!e) return false;
      // Returning: first met on an earlier visit day than today.
      if (dayKey(e.f) >= dayKey(now())) return false;
      return Math.random() * HIDE_CHANCE_INV < 1;
    } catch (err) {
      return false;
    }
  }

  /* ---------- boot ---------- */

  storage = openStorage();
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
    entries: entries,
    hideTranslation: hideTranslation
  };
})(window.Iskry);
