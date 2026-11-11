/*
  OWNER: director. Builder agents call this module and do not edit it.
  STATUS: working Phase 1 stub. The signatures are final; the behavior grows in Phase 2.

  CONTRACT
    Iskry.memory.weight(id)   -> number > 0. Relative chance of this word being spawned.
                                 Called by the scene for each candidate when it picks the
                                 next word. Phase 1: always 1.
    Iskry.memory.record(id)   -> undefined. "This word was looked at." Called by the card
                                 every time a word is shown. Phase 1: counts in memory
                                 only; nothing is stored and nothing survives a reload.
    Iskry.memory.isGolden(id) -> boolean. Whether the scene should draw this word with the
                                 is-golden class. Phase 1: always false.
  All three are synchronous, never throw, and accept unknown ids.

  PHASE 2 (intended, not built)
    - record(id) saves a per-word count and last-seen time in localStorage, wrapped in
      try/catch because storage can be unavailable on file:// or in private windows.
    - weight(id) gently favors words that were caught before and not seen for a while,
      so old friends drift back. It stays within a narrow band (about 0.5 to 2) so the
      sky never feels like a drill, and never drops to 0.
    - isGolden(id) turns true for a word that has been caught several times across
      separate visits: a quiet sign of familiarity, never a score, badge or streak.
    - Nothing here is ever shown as a number, and there is no notion of right or wrong.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  var counts = Object.create(null);

  Iskry.memory = {
    weight: function (id) {
      return 1;
    },

    record: function (id) {
      if (typeof id !== "string") return;
      counts[id] = (counts[id] || 0) + 1;
    },

    isGolden: function (id) {
      return false;
    }
  };
})(window.Iskry);
