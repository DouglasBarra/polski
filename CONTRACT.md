# Iskry: Phase 1 contract

Single source of truth. If a file header disagrees with this document, this document wins.

Iskry ("sparks") is a place to meet Polish words for pleasure. No lessons, levels, streaks, scores, accounts or notifications. Warm, slow, dark, desktop first, no sound.

## Hard rules

- Plain static HTML/CSS/JS. No framework, no build step, no dependencies.
- Must work from `file://`. No ES modules, no `fetch` of local files. Classic `<script>` tags only.
- One global: `window.Iskry`. Every file starts with `window.Iskry = window.Iskry || {};` and wraps its code in an IIFE.
- Edit only the files and sections you own. Do not rename ids, classes, events or tokens listed here.
- Use tokens from `css/tokens.css` for every color, font, size, duration and easing. Need a new one? Add it to your own section in `main.css` as a local custom property; do not edit `tokens.css`.

## Ownership

| File | Owner |
|---|---|
| `index.html`, `css/tokens.css`, `css/main.css` BASE section, `js/memory.js`, `CONTRACT.md` | director |
| `js/scene.js`, `css/main.css` SCENE section | scene agent |
| `js/card.js`, `css/main.css` CARD section | card agent |
| `data/words.js` | words agent |
| `tools/validate-words.js` | QA agent |

## Boot

Script order: `data/words.js`, `js/memory.js`, `js/card.js`, `js/scene.js`, then the inline boot in `index.html`, which calls:

```js
Iskry.card.init(document.getElementById("card-root"), wordsById); // { [id]: word }
Iskry.scene.init(document.getElementById("scene"), Iskry.WORDS);  // array
```

`init` is called once. Neither module calls the other; they talk only through the two events below.

## DOM hooks

Scene (inside `#scene`; the scene agent may add children to these three layers only):

- `#scene-strings`: the guitar-string lines. `aria-hidden`.
- `#scene-words`: the floating words. Each word is `<button type="button" class="spark" data-id="{id}">{pl}</button>`.
- `#scene-fire`: the firelight glow. `aria-hidden`.
- Word state classes: `is-plucked` (vibrating), `is-caught` (held while its card is open), `is-rare` (`word.rare`), `is-golden` (`Iskry.memory.isGolden(id)`).
- `#scene[data-holding="true"]` while a word is caught.

Card (inside `#card-root`; the card agent builds everything in it):

- `#card-root` has the `hidden` attribute when closed and `data-state="closed|opening|open|closing"`.
- `.card-root__backdrop`: full-viewport click-outside catcher.
- `.card` (`role="dialog"`, `aria-modal="true"`, `aria-labelledby` the word) containing `.card__close` (button, `aria-label="Close"`), `.card__word` (with `lang="pl"`), `.card__respelling`, `.card__meaning`, `.card__example-pl` (`lang="pl"`), `.card__example-en`, `.card__family`, and one `<button class="card__family-item" data-id="{id}">` per related word.

## Events (both dispatched on `document`)

**`word:catch`**, `detail: { id, rect }`. Dispatched by the scene.

- Fired when the pluck vibration **ends**, `--dur-pluck` after the click (immediately under reduced motion). Sequence: click, word freezes and gets `is-plucked`, vibration ends, word gets `is-caught`, event fires.
- `rect` is the word button's `getBoundingClientRect()` taken at dispatch, at rest, in viewport coordinates.
- The caught word stays held exactly where it is, bright, for as long as it is caught. The other words keep drifting.
- Only one word is caught at a time. From click until `word:release` the scene ignores every other catch attempt (the backdrop also blocks pointer clicks).

**`word:release`**, `detail: { id }`. Dispatched by the card.

- Fired when the close animation **starts**, on Esc, backdrop click or the close button. Fired exactly once per `word:catch`.
- `id` is always the id from the `word:catch` that opened the card, even if the card switched to a related word.
- The scene removes `is-caught`, clears `data-holding`, lets the word resume rising and returns focus to that word's button (`focus({ preventScroll: true })`). An unknown id is ignored.

## Card behavior

- Position: anchored to `rect`. Prefer beside the word (right, else left), vertically centered on it, `--card-gap` away, clamped `--card-margin` inside the viewport. Never cover the word. No `rect`: center in the viewport.
- On open: focus moves to `.card__close`; Tab stays inside the card.
- Clicking a related word **re-renders the same card in place** with that word. No event goes to the scene, the card does not move, and the originally caught word stays held. Family ids missing from `wordsById` are skipped; an empty family hides `.card__family`.
- A `word:catch` with an unknown id is ignored (no card, and the card dispatches `word:release` straight away so the scene is not stuck).

## Keyboard

- Words are real `<button>`s, so Tab reaches them and Enter/Space catches them, same path as a click.
- A keyboard-focused word (`:focus-visible`) behaves like a hovered one (slow and bright). Focus that follows a mouse close does not count, so the released word drifts on.
- Esc closes the card. Focus goes back to the word.

## Memory hooks

- Scene: calls `Iskry.memory.weight(id)` for each candidate when picking the next word to spawn (weighted random; higher is more likely), and `Iskry.memory.isGolden(id)` when creating a word element.
- Card: calls `Iskry.memory.record(id)` every time a word is shown in the card, including a switch to a related word.
- Phase 1: `weight` is 1, `record` only counts in memory, `isGolden` is false. Callers must not assume that.

## Motion

- Hover or focus slows a word to `--hover-slow-factor` of its speed and brightens it.
- JS reads motion and density tokens with `getComputedStyle(document.documentElement)` at init and again when `(prefers-reduced-motion: reduce)` changes. Durations are in `ms`, speeds in px/s, the rest unitless.
- Reduced motion: no sway, no flicker, no string shiver, no vibration; words still rise slowly and fade.

## Words

Schema and respelling guide live at the top of `data/words.js`. Themes: `fire-night`, `home`, `food`, `nature`, `feelings`, `people`, `small-words`. Check with `node tools/validate-words.js`.

`family` means **related words** (the card labels it so). Two kinds only: words that share a root (`kot`/`kotek`, `noc`/`dobranoc`) and fixed conversational partners (`tak`/`nie`, `dziękuję`/`proszę`). Words that only share a topic are not family. Links are symmetric.

Validator severity: an unknown extra field is an error; a character outside the expected Polish set is a warning.

## Accepted deviations (Phase 1 review)

Scene:

- Each `.spark` also carries `lang="pl"`, `aria-label="{pl}"` and `data-pl="{pl}"`. `data-pl` feeds a bright `::after` twin, so brightening is an opacity fade only.
- A hovered or keyboard-focused word stops climbing at 90% of the climb, so it cannot fade out from under the pointer.
- Look-and-feel knobs that are not tokens live in `TUNE` at the top of `js/scene.js`; local opacity knobs (`--scene-glow-*`, `--scene-grain`) live on `.scene`.
- `#scene-fire` holds `.scene__glow--wide|body|core` and `.scene__grain`; `#scene-strings` holds one `svg.scene__strings-svg` with `.scene__string` paths.
- A pluck also makes the nearest string shiver.

Card:

- Extra elements: `.card__content` (crossfade wrapper), `.card__rare` ("a rare spark", shown when `word.rare`; the card also gets `is-rare`), `.card__example`, `.card__family-label`, `.card__family-list` (`ul`; each `.card__family-item` button sits in an `li`), `.card__family-pl`, `.card__family-en`.
- `.card__word` is an `h2` with `tabindex="-1"`. After a switch to a related word, focus moves to it.
- When the card fits on neither side of the word it goes below it, or above if there is more room there, centered on the word.
- `#card-root` gets `data-anchored="true"` and `--spark-x/y/rx/ry` when opened from a `rect`; the backdrop uses them to leave a clearing around the held word. `.card` gets `--card-origin`.
- A `word:catch` that arrives while a card is still closing ends that close at once and opens the new card.
