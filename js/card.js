/*
  OWNER: card agent (this file, plus the CARD section of css/main.css).
  STATUS: stub. The interface below is fixed; the implementation is yours.
  CONTRACT.md is the source of truth; this header repeats the parts you need.

  INTERFACE
    Iskry.card.init(rootEl, wordsById)
      rootEl     the #card-root element: empty, with the hidden attribute and
                 data-state="closed". Build everything inside it.
      wordsById  plain object { [id]: word } (schema at the top of data/words.js).
      Called once, after the DOM is ready. Returns nothing.

  DOM YOU BUILD (class names are fixed; QA relies on them)
    #card-root[hidden][data-state="closed|opening|open|closing"]
      .card-root__backdrop          full-viewport click-outside catcher
      .card                         role="dialog" aria-modal="true" aria-labelledby the word
        .card__close                <button aria-label="Close">
        .card__word                 the Polish word, lang="pl"
        .card__respelling           e.g. KOH-tek
        .card__meaning              the English meaning
        .card__example-pl           example sentence, lang="pl"
        .card__example-en           its translation
        .card__family               container for related words; hidden when there are none
          .card__family-item        <button data-id="{id}" lang="pl">{pl}</button>, one per word
    Remove the hidden attribute to show the root; set it again when the close animation
    has finished. Insert word data with textContent, never innerHTML.

  EVENTS (on document)
    You listen for  "word:catch", detail: { id, rect }
      - Open the card for wordsById[id]. rect is the caught word's DOMRect in viewport
        coordinates.
      - Unknown id: do not open; dispatch word:release for that id straight away so the
        scene is not left holding a word.
    You dispatch  new CustomEvent("word:release", { detail: { id } })
      - When the close animation STARTS, on Esc, backdrop click or the close button.
      - Exactly once per word:catch. id is always the id that came with that word:catch,
        even if the card has switched to a related word since.

  BEHAVIOR
    - Position: anchored to rect. Prefer beside the word (right, else left), vertically
      centered on it, --card-gap away, clamped --card-margin inside the viewport. Never
      cover the word. No rect: center in the viewport. Recompute on window resize.
    - Open takes --dur-card-open, close takes --dur-card-close. Animate transform and
      opacity only. Under reduced motion, opacity only.
    - On open, focus .card__close. Keep Tab inside the card while it is open.
      Do not restore focus on close: the scene refocuses the word on word:release.
    - Clicking a .card__family-item re-renders the same card in place with that word
      (crossfade over --dur-card-swap). No event goes to the scene, the card does not
      move, and the originally caught word stays held.
    - Family ids missing from wordsById are skipped silently.

  MEMORY HOOK
    Call Iskry.memory.record(id) every time a word is shown in the card: on open and on
    each switch to a related word.

  DO NOT call Iskry.scene, touch #scene, or edit files you do not own.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  Iskry.card = {
    init: function (rootEl, wordsById) {
      // Stub: the card agent implements this.
    }
  };
})(window.Iskry);
