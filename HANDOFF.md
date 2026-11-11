# Iskry: handoff (2026-11-11, ~01:25)

Written by session **polski-f1** (work account, Opus agents) for the **"Session idea"** session (personal account,
Fable agents) and for whoever picks this up next. The project is paused here, at a stable, committed state.

Run it: `python3 -m http.server 8765` from the repo root, then open http://localhost:8765/ .
`CONTRACT.md` is the source of truth for ownership, interfaces and draw order. `README.md` has the user-facing summary
and credits.

## 1. Where things stand

Everything polski-f1's agents built is committed (see `git log`, commits from df0c76f to the end). The scene loads with no
console errors. Mouse and keyboard catch, the card, the one-click switch to another word, Esc and the journal all work.
It holds 60 fps at DPR 1. At DPR 2 it was about 48 fps until the adaptive-resolution safety net, which now settles it near
60 fps at roughly DPR 1.5.

| Area | Files | State |
|---|---|---|
| Core (director) | `js/scene.js`, `js/scene/layout.js`, `index.html`, `css/tokens.css`, `css/main.css` BASE+SCENE, `CONTRACT.md`, `README.md`, `vendor/` | Done. Guarded module loader table, gusts, rare finds, one-click switch, time-of-day hook (`setTimeOfDay`, `?hour=`), adaptive DPR, `?debug=1` gives `Iskry.scene.debug()` |
| Sky | `js/scene/sky.js` | Done. Dome, terrain layers, lake, village with a wooden church, Giewont, the Tatras, mist, time of day, `setMoon()`. Ground is a ring from 28 m |
| Stars | `js/scene/stars.js`, `stars-data.js` | Done. HYG catalogue placed for Poland on the current date, Milky Way, nebulae. Camera faces azimuth 120° (ESE) |
| Moon | `js/scene/moon.js` | Done. Procedural 3D moon, real phase but never under 30% lit (the user's choice), artistic spot at az 17 / alt 22 |
| Trees | `js/scene/trees.js` | Done. Procedural Douglas-firs and birches, treeline with a valley clearing, near framing stands |
| Fire | `js/scene/fire.js` | Done. Volumetric depth-tested glow (6 slices), ray-marched flame, 3D logs and coals, `light` + `fill` |
| Strings | `js/scene/strings.js` | Done. Standing-wave plucks, on-screen touch targeting |
| Foreground | `js/scene/foreground.js` | Done. Kapliczka (shrine) and the animated stork, a rig with 18 bones |
| Ground | `js/scene/ground.js` | Done. Lit November floor, ash ring, matte under grass, seamless 30 m edge |
| Grass | `js/scene/grass.js` | Done. Modelled blades, seed grasses and weeds, backlit by the fire, wind |
| Road | `js/scene/road.js` | Done, slightly over budget (see §4) |
| Fence | `js/scene/fence.js` | Done. Weathered split-rail fence, gate at the shrine |
| Log | `js/scene/log.js` | Done. Pine log bench, detailed guitar, blanket and mug |
| Words | `data/words.js` | 176 words, 31 families, 14 GUSTS. Now owned by the other session's learning agent |
| Memory / card / journal | `js/memory.js`, `js/card.js`, `js/journal.js`, `css/journal.css`, `tests/` | Phase 2 by polski-f1, then reworked by the other session (698243b, d5e2ea1: spaced return, `record(id, kind)`, `isMet`, `familiarity`) |

User decisions to respect: horizontal drift, a warm night, no sound, no pressure features (no scores, streaks or numbers).
The treeline is Douglas-fir. The landscape shows Poland: Tatras, kapliczka, storks, fence, birches. The moon is real but
never thin. Stars should look like a NASA-style astrophotograph. Trees, moon, stars and each near-world part are
separate, detailed components.

## 2. Ownership while both sessions work in this repo

Commit only your own agents' files, and never `git add -A`.

- **Other session:** Fable perf owns `dev/perf.*`, `js/quality.js` (planned, not on disk yet), `tools/perf/`, and perf-only
  edits to `sky.js`, `stars.js` and `strings.js`. Fable learning owns `memory.js`, `card.js`, `journal.*`, `tests/`,
  `data/words.js` and `tools/validate-words.js`. Sonnet owns the CARD section of `main.css`.
- **polski-f1** (paused): everything else in the table above. `tools/probes/` holds profiling snippets saved from
  polski-f1's agents.

## 3. Open work, by priority

### P1: GPU budget at DPR 2 (the biggest gap)
The director measured about 16-18 ms per frame at 1920x1008, DPR 2, ?hour=22. All per-module numbers are noisy because
other browser tabs share the GPU. Measure with `dev/perf.html` (the other session's profiler) or the probes in
`tools/probes/`, with the tab in the foreground, taking the best of several runs.

| Module | Measured at DPR 2 | Target | Next step (from its agent) |
|---|---|---|---|
| fire | ~7 ms (unreliable: the toggle also removes both lights, so it includes the firelight shading of the whole scene) | 1.5 ms | 1) re-measure with `tools/probes/fire-prof.js` (blocks: meshes off with lights kept, glow off, flame off); 2) replace the 6 glow slices with one tight back-face proxy and closed-form in-scatter, occlusion from a half-res depth texture plus a depth-aware upsample (or 2-3 tight slices); 3) flame box tighter, about 14 steps, early exit; 4) fold `fire.fill` into `fire.light` so lit pixels evaluate one point light |
| trees | ~2.8-4.8 ms (31 draws, 464k triangles) | ≤ 2 ms | 1) near crowns above about 30% height: half as many spray cards, 1.5x larger (main overdraw); 2) far treeline: one material per mesh (about 31 to 20 draws), one curtain per bough, halve the 200 understory firs; 3) drop instances hidden behind the near stands; 4) try a depth pre-pass for near foliage only, and keep it only if cheaper |
| grass | ~1.4-2.6 ms (272k triangles) | ≤ 1 ms | 1) cull instances outside the camera frustum and behind the logs at init, drop the band past 26 m; 2) far LOD material without dew or translucency; 3) 2 segments past 10 m; 4) trim extra plants from 85k to about 50k triangles; 5) `density: 0.8` only as a last resort |
| sky / strings / moon / fence / ground | ~1.0 / 0.8 / 0.5 / 0.4 / 0.3 ms | | sky, stars and strings perf belong to the other session's Fable perf agent |

**Quality controller:** `scene.js` has `adaptResolution()`: if fps stays under 52 over 150 frames (after the first 6 s),
DPR steps down by 0.25, with a floor of 1, never back up. When `js/quality.js` lands, it should become the only controller.
Replace `adaptResolution()` with its hook. Its tuning is `TUNE.slowFps`.

### P2: The final integrated pass, which never ran
Check every module together at `?hour=22`, `5.5` and `17.5`, plus: reduced motion; card open and journal open; words
over the fire; glow occlusion by the bench and guitar (fire is volumetric now); whether the near trees are lit too
dimly since the fire's physical falloff; and that the near trees don't crowd the stork. Then measure total GPU with a
per-module breakdown.

### P3: Visual polish list (the user has seen all of these called out)
- **fire:** the glowing log cracks look like squiggly doodles, because they come from noise contours. Use a cellular
  crack pattern on the charred ends only.
- **trees:** the 50 m treeline firs read as regularly tiered, like spruce. Use uneven whorls with some skipped, longer
  droopier lower boughs with a ragged edge, a softer top, and lopsided crowns.
- **moon:** the maria still look like flat grey patches with scalloped edges up close. Work from a real lunar albedo map
  outline. Little of this shows at 2° on screen.
- **stork:** the rig and animation are good, but the model is crude: an egg body, a tube neck, no feathers. It is about
  45 px on screen.
- **log:** the bark plates read like crazy paving, and the guitar top is a flat beige.
- **road:** see §4 (puddle brightness).
- **fence:** the gate gap is foreshortened from the camera, because the fence runs almost straight away from the
  viewer. This is a layout choice.

### P4: Code hygiene
- `ground.js` hard-codes approximate copies of the fire's log angles and the birch positions. Move them into `layout.js`
  (for example `FIRE.logAngles`, `TREES.birches`) and read them from there in fire, trees and ground.
- `ground.js` copies `sky.js`'s ground colour and haze formula so the 30 m edge matches. Any change to sky's ground
  tone must be mirrored there.
- `CONTRACT.md`'s memory and card-veil text predates 698243b. The learning agent should confirm or update it.
- The stars data is CC BY-SA 4.0 (share-alike on `js/scene/stars-data.js`). This only matters if the site is ever
  published.

## 4. Road status
Committed at wrap-up. It loads in the real `index.html` and draws one ribbon along `layout.ROAD`:
- **Ruts:** shaded per pixel (the rut bowls, mud lips, crown and verges), with the surface at y ≥ 0.016.
- **Baked details:** clods, tractor chevrons, horseshoe, boot, dog and roe-deer prints, and leaves and needles in the ruts.
- **Puddles:** dark warm mirrors with a faint flame reflection, fixed from the earlier white-blue blobs.

It is a transparent Lambert material: renderOrder -1, `depthWrite` false, polygonOffset -2/-2.

Open items:
- **Cost:** about 0.22-0.26 ms at DPR 2, slightly over its 0.2 ms budget. Next cuts: bake the profile slope into a texture, or drop the damp sheen.
- **Not seen after the last changes:** no final screenshot was taken after the last two (analytic profile slope, ribbon narrowed to 1.5 m). Look at it first.
- **Turf colour:** the crown and verge turf hasn't been checked against `ground.js`'s meadow colour.
- **Unused export:** `road.js` exports `roadSurface(x, z)` and `roadProfileY`, so grass could root blades on the crown and skip puddles. `grass.js` doesn't use them yet.

## 5. How the work was run (useful if you resume with agents)
- One agent per file or component. Each owns `js/scene/<name>.js` plus `dev/<name>.html` and reports with
  screenshots. The director integrates; a coordinator commits per agent.
- Each component exports `createX(ctx, opts) -> { group, update(t, dt), resize(w, h), dispose() }`, optionally with
  `setTimeOfDay(tod)`. `ctx` is `{ scene, camera, renderer, reducedMotion, readToken }`. Positions come from `layout.js`.
- Browser checks use the user's Dia browser via CDP at 127.0.0.1:9222. Each agent opens its own tab on its own port
  and closes it afterwards. Background tabs pause rAF, so activate the tab before timing or taking screenshots.
- Fable 5.2 is NOT available on the work account (Bedrock 403: no AWS Marketplace subscription). Run Fable from the
  personal account.
