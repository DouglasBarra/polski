# Iskry: contract (Phase 1b)

Single source of truth. If a file header disagrees with this document, this document wins.

Iskry ("sparks") is a place to meet Polish words for pleasure. No lessons, levels, streaks, scores, accounts or notifications. Warm, slow, dark, desktop first, no sound.

## Hard rules

- Plain static HTML/CSS/JS. No framework and no build step. One dependency: three.js 0.186.1 (r186), **vendored** in `vendor/three/` and resolved by the import map in `index.html` (`three`, `three/addons/`). Nothing is loaded from a CDN at runtime except the two web fonts.
- Served over http: `python3 -m http.server 8765` from the repo root, then open `http://localhost:8765/`. The old "must work from `file://`" rule is gone: the scene is now a three.js ES module, and browsers refuse to load modules from `file://`.
- One global: `window.Iskry`. `data/words.js`, `js/memory.js` and `js/card.js` stay classic scripts (each starts with `window.Iskry = window.Iskry || {};` and wraps its code in an IIFE). `js/scene.js` and `js/scene/*.js` are ES modules; `scene.js` also sets `Iskry.scene`.
- Edit only the files and sections you own. Do not rename ids, classes, events or tokens listed here.
- Use tokens from `css/tokens.css` for every color, font, size, duration and easing. Need a new one? Add it to your own section in `main.css` as a local custom property; do not edit `tokens.css`.

## Ownership

| File | Owner |
|---|---|
| `index.html`, `css/tokens.css`, `css/main.css` BASE and SCENE sections, `js/memory.js`, `js/scene.js`, `vendor/`, `README.md`, `CONTRACT.md` | director |
| `js/scene/fire.js`, `js/scene/strings.js`, `js/scene/sky.js`, each with its test page `dev/<name>.html` | one environment agent each |
| `js/card.js`, `css/main.css` CARD section | card agent |
| `data/words.js` | words agent |
| `tools/validate-words.js` | QA agent |

## Boot

Order: `data/words.js`, `js/memory.js`, `js/card.js` (classic), then the inline module in `index.html`:

```js
import { init as initScene } from "./js/scene.js";
Iskry.card.init(document.getElementById("card-root"), wordsById); // { [id]: word }
initScene(document.getElementById("scene"), Iskry.WORDS);         // array
```

`init` is called once. Scene and card never call each other; they talk only through the two events below.

## The scene

One `THREE.Scene` and one `PerspectiveCamera`, drawn by two renderers that share them, in one `requestAnimationFrame` loop (paused while the tab is hidden):

- `WebGLRenderer` into `#scene-world`: the night (sky, fire, strings). Transparent, so the CSS night gradient on `body` shows until the sky draws, and if WebGL is unavailable.
- `CSS3DRenderer` into `#scene-words`: the words, as real DOM buttons wrapped in `CSS3DSprite`s. Each sprite is scaled so the text is drawn 1:1 (the button's `font-size` is the size on screen), which keeps it crisp. Words are always drawn above the canvas.

World: metres, ground at y = 0. The camera sits at (0, 1.6, 12), looks toward -z pitched up about 6.5°, and only ever translates (pointer parallax and slow breathing, at most about 0.3 m; frozen while a word is held).

**Drift.** Words ride one wind along +x (left to right; `--wind-direction: -1` reverses it) at depths from `--depth-near` to `--depth-far`. The wind is the same everywhere, so near words are larger, brighter and faster and far words smaller, dimmer, slower and tinted toward the fog: real parallax. The wind strength wanders (`--wind-gust`), each word bobs gently (`--bob-*`), and words fade in and out over `--fade-edge` of the width at the edges. Left to right was chosen because it is the reading direction: the eye follows without effort, and it does not read as a news ticker.

**Environment modules** (`js/scene/fire.js`, `strings.js`, `sky.js`). Each exports one factory, `createFire|createStrings|createSky(ctx, opts) -> handle`:

```js
ctx    = { scene, camera, renderer, reducedMotion, readToken(name, fallback) }
handle = { group, update(timeSec, dtSec), resize(width, height), dispose() }
fire    opts { position, scale }   + { light, intensity() }            // flicker 0..1
strings opts { count, extents }    + { touch(prevPos, pos), pluckNearest(worldPos, strength), nearestPoint(worldPos) }
sky     opts { horizonY, radius }  + { fogColor, fogNear, fogFar }     // suggestions
```

The core loads each with a guarded dynamic `import()`: a missing or throwing module is logged and skipped and the words drift on. Modules have no global side effects (no `scene.fog`, background or renderer settings) and make no per-frame allocations. The core calls `update` every frame, `strings.touch(prev, pos)` for every drifting word, `strings.pluckNearest` on a pluck, applies the sky's fog to `scene.fog` and to `--scene-fog` (the far words' tint), and lets `fire.intensity()` breathe on the words near the fire. Modules are rebuilt when reduced motion changes. `?bare=1` skips them.

## DOM hooks

Scene (inside `#scene`; the scene adds children to these two layers only):

- `#scene-world`: the WebGL canvas. `aria-hidden`.
- `#scene-words`: the CSS3D layer with the words. Each word is `<button type="button" class="spark" data-id="{id}">{pl}</button>`.
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
- The caught word stays held exactly where it is, bright, for as long as it is caught (the camera holds still too). The other words keep drifting.
- Only one word is caught at a time. From click until `word:release` the scene ignores every other catch attempt (the backdrop also blocks pointer clicks).

**`word:release`**, `detail: { id }`. Dispatched by the card.

- Fired when the close animation **starts**, on Esc, backdrop click or the close button. Fired exactly once per `word:catch`.
- `id` is always the id from the `word:catch` that opened the card, even if the card switched to a related word.
- The scene removes `is-caught`, clears `data-holding`, lets the word drift on and returns focus to that word's button (`focus({ preventScroll: true })`). An unknown id is ignored.

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

- Hover or focus slows a word to `--hover-slow-factor` of its speed and brightens it. A word that has your attention waits at the downwind edge instead of fading away.
- A pluck vibrates the word vertically (`--pluck-amplitude`, `--pluck-cycles`, `--dur-pluck`) and plucks the nearest string.
- JS reads motion, depth, camera and density tokens with `getComputedStyle(document.documentElement)` at init and again when `(prefers-reduced-motion: reduce)` changes. Durations are in `ms`, speeds in px/s, depths in metres, the rest unitless.
- Reduced motion: a slow steady drift, no bob, no gusts, no camera motion, no word vibration; the modules get `reducedMotion: true` (steady fire, few particles, still strings).
- Performance: one render loop, device pixel ratio capped at 2, one layout read per word (its width, once) plus one `getBoundingClientRect()` per catch.

## Words

Schema and respelling guide live at the top of `data/words.js`. Themes: `fire-night`, `home`, `food`, `nature`, `feelings`, `people`, `small-words`. Check with `node tools/validate-words.js`.

`family` means **related words** (the card labels it so). Two kinds only: words that share a root (`kot`/`kotek`, `noc`/`dobranoc`) and fixed conversational partners (`tak`/`nie`, `dziękuję`/`proszę`). Words that only share a topic are not family. Links are symmetric.

Validator severity: an unknown extra field is an error; a character outside the expected Polish set is a warning.

## Accepted deviations

Scene:

- Each `.spark` also carries `lang="pl"`, `aria-label="{pl}"` and `data-pl="{pl}"`. `data-pl` feeds a bright `::after` twin, so brightening is an opacity fade only.
- JS sets per word: `font-size` in px (by depth, never below `--size-spark-min`), `opacity`, the CSS3D `transform`, and `--spark-fog` (0 near to 1 far).
- Look-and-feel knobs that are not tokens live in `TUNE` at the top of `js/scene.js` (camera placement, the height band the words use, fire position, string extents).
- Nothing in WebGL can occlude a word, and words are depth-sorted among themselves by the browser.
- While a card is open, a click on another word lands on the backdrop and only closes the card (unchanged from Phase 1; undecided).

Card:

- Extra elements: `.card__content` (crossfade wrapper), `.card__rare` ("a rare spark", shown when `word.rare`; the card also gets `is-rare`), `.card__example`, `.card__family-label`, `.card__family-list` (`ul`; each `.card__family-item` button sits in an `li`), `.card__family-pl`, `.card__family-en`.
- `.card__word` is an `h2` with `tabindex="-1"`. After a switch to a related word, focus moves to it.
- When the card fits on neither side of the word it goes below it, or above if there is more room there, centered on the word.
- `#card-root` gets `data-anchored="true"` and `--spark-x/y/rx/ry` when opened from a `rect`; the backdrop uses them to leave a clearing around the held word. `.card` gets `--card-origin`.
- A `word:catch` that arrives while a card is still closing ends that close at once and opens the new card.
