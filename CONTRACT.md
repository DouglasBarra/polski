# Iskry: contract (Phase 3)

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
| `index.html`, `css/tokens.css`, `css/main.css` BASE and SCENE sections, `js/scene.js`, `vendor/`, `README.md`, `CONTRACT.md` | director |
| `js/scene/sky.js`, `stars.js` (+ its star catalogue), `moon.js`, `trees.js`, `foreground.js`, `strings.js`, `fire.js`, each with its test page `dev/<name>.html` | one environment agent each (sky, stars, moon, trees, foreground, strings, fire) |
| `js/memory.js`, `js/journal.js`, `css/journal.css`, `dev/journal.html`, `tests/` | memory agent |
| `js/card.js`, `css/main.css` CARD section | card agent |
| `data/words.js` | words agent |
| `tools/validate-words.js` | QA agent |

## Boot

Order: `data/words.js`, `js/memory.js`, `js/card.js`, `js/journal.js` (classic), then the inline module in `index.html`:

```js
import { init as initScene } from "./js/scene.js";
Iskry.card.init(document.getElementById("card-root"), wordsById);                    // { [id]: word }
if (Iskry.journal) Iskry.journal.init(document.getElementById("journal-root"), wordsById);
initScene(document.getElementById("scene"), Iskry.WORDS);                            // array
```

Each `init` is called once. Scene, card and journal never call each other; they talk only through the events below. `css/journal.css` loads after `css/main.css`.

## The scene

One `THREE.Scene` and one `PerspectiveCamera`, drawn by two renderers that share them, in one `requestAnimationFrame` loop (paused while the tab is hidden):

- `WebGLRenderer` into `#scene-world`: the night (sky, stars, moon, trees, foreground, strings, fire). Transparent, so the CSS night gradient on `body` shows until the sky draws, and if WebGL is unavailable.
- `CSS3DRenderer` into `#scene-words`: the words, as real DOM buttons wrapped in `CSS3DSprite`s. Each sprite is scaled so the text is drawn 1:1 (the button's `font-size` is the size on screen), which keeps it crisp. Words are always drawn above the canvas.

World: metres, ground at y = 0. The fire is at (-3, 0, -2), scale 1.3: the focal point, left of centre. The words' band (9% to 57% of the height, above the flames) must stay legible: nothing bright or busy behind it. The camera sits at (0, 1.6, 12), looks toward -z pitched up about 6.5° (compass azimuth 120°, ESE), and only ever translates (pointer parallax and slow breathing, at most about 0.3 m; frozen while a word is held).

**Drift.** Words ride one wind along +x (left to right; `--wind-direction: -1` reverses it) at depths from `--depth-near` to `--depth-far`. The wind is the same everywhere, so near words are larger, brighter and faster and far words smaller, dimmer, slower and tinted toward the fog: real parallax. The wind strength wanders (`--wind-gust`), each word bobs gently (`--bob-*`), and words fade in and out over `--fade-edge` of the width at the edges. Left to right was chosen because it is the reading direction: the eye follows without effort, and it does not read as a news ticker.

**Environment modules** (`js/scene/<name>.js`). Each exports one factory, `create<Name>(ctx, opts) -> handle`:

```js
ctx    = { scene, camera, renderer, reducedMotion, readToken(name, fallback) }
handle = { group, update(timeSec, dtSec), resize(width, height), dispose() }
sky        opts { horizonY, radius }                       + { fogColor, fogNear, fogFar, setMoon(direction, illumination) }   // fog: suggestions
stars      opts { date, latitudeDeg, longitudeDeg }                                         // the real sky over Poland tonight
moon       opts { date }                                   + { direction, phase, illumination }
trees      opts { firePosition, wind, seed }               (also exports buildDouglasFir, buildBirch)
foreground opts { firePosition, wind, stork, shrine }       + { layout }                      // stork { x, z, height }, shrine { x, z, faceX, faceZ }
strings    opts { count, extents, firePosition }           + { touch(prevPos, pos), pluckNearest(worldPos, strength), nearestPoint(worldPos) }
fire       opts { position, scale }                        + { light, intensity() }          // flicker 0..1
```

Optional on any handle: `setTimeOfDay({ hour, dusk, night, dawn })` (the weights sum to 1). The core calls it on load and every 20 s from the visitor's clock (dusk peaks at 17:30, deep night runs 20:00 to 03:30, dawn peaks around 06:30 to 07:00; the fire is always lit, so daytime shows as early night: dusk 0.3, night 0.7), then re-applies the sky's fog. `?hour=5.5` pins the clock. When both the sky and the moon are loaded, the core calls `sky.setMoon(moon.direction, moon.illumination)`.

`wind` is the mean wind in m/s along +x. The place is central Poland (52.1° N, 19.4° E); `date` is the visitor's clock at load.

**Compass.** The camera's -z faces azimuth 120° (ESE), fixed (`stars` opts `facingAzDeg` overrides). World +x is azimuth 210° (SSW), +z is 300° (WNW): compass azimuth A is the world direction (sin(A - 120°), 0, -cos(A - 120°)). The stars handle exposes `facingAzDeg` and `horizonToWorld(altDeg, azDeg, outVec3)`. On November evenings Orion rises left of centre; the November sun rises near 124° (ahead) and sets near 236° (behind, to the right, off screen). Load order: sky, then stars, then moon; the others in parallel with the stars. The stars read the visitor's local wall-clock time as the same time in Warsaw (`wallClock: true`, the default): 21:00 for the visitor shows the sky of 21:00 by a Polish fire.

Who draws what: `sky` the dome, haze, distant land (hills, the Tatras in the haze, a village) and fog; `stars` the stars and the Milky Way; `moon` the moon; `trees` **every tree**: the Douglas-fir treeline about 50 to 56 m out with a dip behind the fire, the side stands at 15 to 35 m and the birches (the sky and the foreground draw no trees); `foreground` the Polish countryside props within about 30 m (fence, wayside shrine, bench, grass, path), mostly low on the screen and at the edges, lit by `fire.light`; `strings` the guitar strings; `fire` the bonfire. Each module's frame budget is about 2 ms.

The core loads the sky first, then all the others in parallel, each with a guarded dynamic `import()`: a missing or throwing module is logged and skipped and the words drift on. Modules have no global side effects (no `scene.fog`, background or renderer settings) and make no per-frame allocations. The core calls `update` every frame, `strings.touch(prev, pos)` for every drifting word, `strings.pluckNearest` on a pluck, applies the sky's fog to `scene.fog` and to `--scene-fog` (the far words' tint), and lets `fire.intensity()` breathe on the words near the fire. Modules are rebuilt when reduced motion changes. `?bare=1` skips them.

## DOM hooks

Scene (inside `#scene`; the scene adds children to these two layers only):

- `#scene-world`: the WebGL canvas. `aria-hidden`.
- `#scene-words`: the CSS3D layer with the words. Each word is `<button type="button" class="spark" data-id="{id}">{pl}</button>`.
- Word state classes: `is-plucked` (vibrating), `is-caught` (held while its card is open), `is-rare` (`word.rare`), `is-golden` (`Iskry.memory.isGolden(id)`, updated on `memory:change`), `is-hinted` (the word under the pointer while a card is open: one click switches to it).
- `.scene__whisper` (inside `#scene-words`, `aria-hidden`): a gust's faint label.
- `#scene[data-holding="true"]` while a word is caught.

Journal (inside `#journal-root`; the memory agent builds everything in it): `.journal-toggle` (bottom right, `aria-expanded`, `aria-controls="journal-panel"`) and `aside#journal-panel.journal` titled "Caught sparks". Not modal. It sits one layer below the card (`--z-card` minus 1) and closes itself on `word:catch`.

Card (inside `#card-root`; the card agent builds everything in it):

- `#card-root` has the `hidden` attribute when closed and `data-state="closed|opening|open|closing"`.
- `.card-root__backdrop`: full-viewport click-outside catcher.
- `.card` (`role="dialog"`, `aria-modal="true"`, `aria-labelledby` the word) containing `.card__close` (button, `aria-label="Close"`), `.card__word` (with `lang="pl"`), `.card__respelling`, `.card__meaning`, `.card__example-pl` (`lang="pl"`), `.card__example-en`, `.card__family`, and one `<button class="card__family-item" data-id="{id}">` per related word.

## Events (both dispatched on `document`)

**`word:catch`**, `detail: { id, rect }`. Dispatched by the scene.

- Fired when the pluck vibration **ends**, `--dur-pluck` after the click (immediately under reduced motion). Sequence: click, word freezes and gets `is-plucked`, vibration ends, word gets `is-caught`, event fires.
- `rect` is the word button's `getBoundingClientRect()` taken at dispatch, at rest, in viewport coordinates.
- The caught word stays held exactly where it is, bright, for as long as it is caught (the camera holds still too). The other words keep drifting.
- Only one word is caught at a time. From click until `word:release` the scene ignores every other catch attempt.
- **Switching.** While a card is open, a click on another word lands on the card's backdrop and closes the card as usual. The scene sees that click (capture phase on `document`), finds the word under it through the backdrop (`document.elementsFromPoint`; a word under the card itself does not count), and after the card's `word:release` plucks that word, which then sends its own `word:catch`. One click: the old card fades out while the new word vibrates, then the new card opens. The card needs no special handling (it already accepts a `word:catch` while closing).

**`word:release`**, `detail: { id }`. Dispatched by the card.

- Fired when the close animation **starts**, on Esc, backdrop click or the close button. Fired exactly once per `word:catch`.
- `id` is always the id from the `word:catch` that opened the card, even if the card switched to a related word.
- The scene removes `is-caught`, clears `data-holding`, lets the word drift on and returns focus to that word's button (`focus({ preventScroll: true })`). An unknown id is ignored.

## Card behavior

- Position: anchored to `rect`. Prefer beside the word (right, else left), vertically centered on it, `--card-gap` away, clamped `--card-margin` inside the viewport. Never cover the word. No `rect`: center in the viewport.
- On open: focus moves to `.card__close`; Tab stays inside the card.
- Clicking a related word **re-renders the same card in place** with that word. No event goes to the scene, the card does not move, and the originally caught word stays held. Family ids missing from `wordsById` are skipped; an empty family hides `.card__family`.
- A `word:catch` with an unknown id is ignored (no card, and the card dispatches `word:release` straight away so the scene is not stuck).
- **"Remember?"** Every time a word is shown (on open and on every related-word switch) the card calls `Iskry.memory.hideTranslation(id)` once, before `record(id)`. Only on an open does a `true` result veil the word; after a related-word switch the answer is ignored and the word is never veiled, because its English was just visible on the chip. When veiled, the Polish word, respelling and Polish example show; the English meaning and English example are veiled (a blurred ghost copy; the real text is transparent and `aria-hidden`, with no `aria-describedby`). A `<button class="card__veil">` ("remember?", `aria-label="Remember? Show the meaning"`) covers the meaning and sits in the tab order after `.card__close`. A click, Enter or Space on it, or a click on the misted example, reveals both with an opacity crossfade (instant under reduced motion), and they stay revealed until the card shows another word or closes. On reveal, focus moves from the veil to `.card__meaning`. No judgement, ever.

## Keyboard

- Words are real `<button>`s, so Tab reaches them and Enter/Space catches them, same path as a click.
- A keyboard-focused word (`:focus-visible`) behaves like a hovered one (slow and bright). Focus that follows a mouse close does not count, so the released word drifts on.
- Esc closes the card. Focus goes back to the word.

**`memory:change`**, `detail: { id }`. Dispatched by memory after every `record(id)`; `id` is `null` after a change made in another tab. The scene refreshes `is-golden`; the journal re-renders.

## Memory

`js/memory.js` (memory agent), stored in `localStorage` under `iskry.memory.v1` (every access guarded; without storage it counts for this page only). A visit day starts at 04:00 local time, so a late night by the fire is one day. All calls are synchronous, never throw and accept unknown ids.

- `weight(id)` -> number in about 0.5 to 2: 0.5 right after a word is seen, rising back to 2 over time, so old friends drift back. Never 0.
- `record(id)`: "this word was looked at"; saves count, first and last seen, visit days; fires `memory:change`.
- `isGolden(id)`: at least 5 views on at least 3 separate days. A quiet sign of familiarity, never a score.
- `entries()` -> `[{ id, count, firstSeen, lastSeen, days, golden }]`, most recently seen first (a fresh copy).
- `hideTranslation(id)` -> boolean: about 1 in 4, and only for a word first met on an earlier visit day (a gentle "do you remember?").
- Nothing from memory is ever shown as a number.

Callers:

- Scene: `weight(id)` for each candidate when picking the next word to spawn, and for the words of a gust (weighted random; higher is more likely); `isGolden(id)` when creating a word element and on `memory:change`.
- Card: `hideTranslation(id)` then `record(id)` every time a word is shown in the card, including a switch to a related word (see "Remember?" below).
- Journal: `entries()` and `isGolden(id)`.

## Motion

- Hover or focus slows a word to `--hover-slow-factor` of its speed and brightens it. A word that has your attention waits at the downwind edge instead of fading away.
- When a nearer word passes in front of a farther one, the farther one fades back while it is covered (screen-space boxes, no layout reads). A word that has your attention, or is held, never fades back: the word in front of it does.
- The warm air above the fire lifts a passing word a little (`TUNE.heat*`; none under reduced motion).
- **Rare finds** (`word.rare`) are picked about 4 times less often, never two at once, ride the wind slower and carry a soft breathing halo.
- **Gusts.** `Iskry.GUSTS = [{ id, label, ids }]` (words agent) are themed clusters. Rarely (the first after about 1.5 to 2.5 min, then every 3 to 5.5 min) one rides in: 4 to 6 of its free, non-rare words, picked by `weight`, enter from the upwind edge one by one, loosely grouped in depth and height, while the wind swells a little (no swell under reduced motion) and ordinary spawning waits. The label (English) drifts ahead of them as a faint `.scene__whisper`. A cluster needs at least 3 free words; absent or malformed `GUSTS` simply means no gusts. `?gust=1` starts one after 4 s (dev).
- A pluck vibrates the word vertically (`--pluck-amplitude`, `--pluck-cycles`, `--dur-pluck`) and plucks the nearest string.
- JS reads motion, depth, camera and density tokens with `getComputedStyle(document.documentElement)` at init and again when `(prefers-reduced-motion: reduce)` changes. Durations are in `ms`, speeds in px/s, depths in metres, the rest unitless.
- Reduced motion: a slow steady drift, no bob, no gusts, no camera motion, no word vibration; the modules get `reducedMotion: true` (steady fire, few particles, still strings).
- Performance: one render loop, device pixel ratio capped at 2, one layout read per word (its width, once) plus one `getBoundingClientRect()` per catch.

## Words

Schema and respelling guide live at the top of `data/words.js`. Themes: `fire-night`, `home`, `food`, `nature`, `feelings`, `people`, `small-words`. Check with `node tools/validate-words.js`.

`data/words.js` also defines `Iskry.GUSTS`, themed clusters for the scene: `{ id, label, ids }`, 5 to 8 ids each, never rare words; a word may be in more than one gust; `label` is short lowercase English ("by the fire").

`family` means **related words** (the card labels it so). Two kinds only: words that share a root (`kot`/`kotek`, `noc`/`dobranoc`) and fixed conversational partners (`tak`/`nie`, `dziękuję`/`proszę`). Words that only share a topic are not family. Links are symmetric.

Validator severity: an unknown extra field is an error; a character outside the expected Polish set is a warning.

## Accepted deviations

Scene:

- Each `.spark` also carries `lang="pl"`, `aria-label="{pl}"` and `data-pl="{pl}"`. `data-pl` feeds a bright `::after` twin, so brightening is an opacity fade only.
- JS sets per word: `font-size` in px (by depth, never below `--size-spark-min`), `opacity`, the CSS3D `transform`, and `--spark-fog` (0 near to 1 far).
- Look-and-feel knobs that are not tokens live in `TUNE` at the top of `js/scene.js` (camera placement, the height band the words use, fire position, string extents).
- Nothing in WebGL can occlude a word, and words are depth-sorted among themselves by the browser.
- Words that drift under the open journal panel are cut at its edge (the panel is about 88% opaque, blurred).

Card:

- Extra elements: `.card__content` (crossfade wrapper), `.card__rare` ("a rare spark", shown when `word.rare`; the card also gets `is-rare`), `.card__example`, `.card__family-label`, `.card__family-list` (`ul`; each `.card__family-item` button sits in an `li`), `.card__family-pl`, `.card__family-en`.
- `.card__word` is an `h2` with `tabindex="-1"`. After a switch to a related word, focus moves to it.
- When the card fits on neither side of the word it goes below it, or above if there is more room there, centered on the word.
- `#card-root` gets `data-anchored="true"` and `--spark-x/y/rx/ry` when opened from a `rect`; the backdrop uses them to leave a clearing around the held word. `.card` gets `--card-origin`.
- A `word:catch` that arrives while a card is still closing ends that close at once and opens the new card.
- Veil elements: `.card__sense` (wraps `.card__meaning`, the meaning ghost and `.card__veil`), `.card__example-en-wrap` (wraps `.card__example-en` and its ghost), `.card__ghost` (`aria-hidden`, blurred copy), `.card__veil-text`. `.card__meaning` has `tabindex="-1"`. `.card` gets `is-veiled` while veiled and `is-revealing` during the fade. Local token `--card-dur-reveal` on `.card-root` (read by `card.js`).
