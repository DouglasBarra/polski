/*
  OWNER: scene agent (this file, plus the SCENE section of css/main.css).
  STATUS: stub. The interface below is fixed; the implementation is yours.
  CONTRACT.md is the source of truth; this header repeats the parts you need.

  INTERFACE
    Iskry.scene.init(rootEl, words)
      rootEl  the #scene element. It already contains three layers, and you may add
              children to them only:
                #scene-strings  guitar-string lines (aria-hidden)
                #scene-words    the floating words
                #scene-fire     firelight glow (aria-hidden)
      words   Iskry.WORDS, an array (schema at the top of data/words.js). May be short
              (3 entries during Phase 1 setup): never show the same word twice at once,
              and cope with fewer words than --words-min.
      Called once, after the DOM is ready. Returns nothing.

  WORD ELEMENTS
    <button type="button" class="spark" data-id="{id}">{pl}</button> inside #scene-words.
    State classes: is-plucked (vibrating), is-caught (held, card open),
                   is-rare (word.rare), is-golden (Iskry.memory.isGolden(id)).
    Real buttons, so Tab reaches them and Enter/Space catches them: handle "click",
    which covers mouse and keyboard. A focused word behaves like a hovered one.

  EVENTS (on document)
    You dispatch  new CustomEvent("word:catch", { detail: { id, rect } })
      - Sequence: click -> the word freezes in place and gets is-plucked -> the vibration
        ends after --dur-pluck -> the word gets is-caught, #scene gets data-holding="true"
        -> dispatch. Under reduced motion --dur-pluck is 0, so dispatch straight away.
      - rect is the button's getBoundingClientRect() at dispatch, at rest (no vibration
        offset), in viewport coordinates.
      - The caught word stays exactly where it is, bright, until released. The other
        words keep drifting.
      - One catch at a time: from the click until word:release, ignore every other
        catch attempt.
    You listen for  "word:release", detail: { id }
      - Remove is-caught, remove data-holding, let the word resume rising from where it
        is, and call focus({ preventScroll: true }) on its button.
      - Ignore an id that is not the currently caught word.

  MEMORY HOOKS
    - When picking the next word to spawn, call Iskry.memory.weight(id) for each
      candidate and do a weighted random pick (higher weight, more likely).
    - When creating a word element, call Iskry.memory.isGolden(id).

  MOTION
    - Words spawn near the bottom above the fire, rise at a speed between
      --rise-speed-min and --rise-speed-max (px/s), sway sideways by --sway-amplitude,
      fade in over --dur-fade-in, start fading at --fade-start of the climb, and are
      removed once invisible. Keep between --words-min and --words-max on screen.
    - Hover or focus: speed eases to --hover-slow-factor of normal and the word brightens.
    - Strings shiver (--shiver-amplitude, --dur-shiver) when a word drifts through them.
    - Read tokens with getComputedStyle(document.documentElement) at init and again when
      matchMedia("(prefers-reduced-motion: reduce)") changes. Animate transform and
      opacity only. Pause the loop while document.hidden.

  DO NOT call Iskry.card, touch #card-root, or edit files you do not own.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  Iskry.scene = {
    init: function (rootEl, words) {
      // Stub: the scene agent implements this.
    }
  };
})(window.Iskry);
