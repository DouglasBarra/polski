# Iskry

Polish words drifting on the night wind past a fire. Catch one to see what it means.

A night in the Polish countryside: a bonfire, Douglas-firs against the hills, the real stars and moon of tonight, and a few guitar strings across the dark. Words ride the wind from left to right. Hover one to slow it, click it (or Tab to it and press Enter) to catch it: a card opens beside it with the meaning, how to say it, an example and related words. Now and then a small gust carries in a handful of words that belong together, and once in a while a rare one drifts by. The words you have caught are kept, quietly, in the journal (the book in the bottom-right corner). No lessons, scores or streaks.

## Start and stop

The scene is an ES module, so it needs a local server, not `file://`.

**Start**, from this folder:

```sh
python3 -m http.server 8765
```

Then open http://localhost:8765/.

**Stop:**
- If it runs in your terminal, press `Ctrl+C` there.
- If it runs in the background (or you closed that terminal):

  ```sh
  pkill -f "http.server 8765"
  ```

To check whether it is still running: `lsof -i :8765` (no output means it is stopped).

No build step. three.js 0.186.1 is vendored in `vendor/three/`. The rules every file follows are in `CONTRACT.md`.

- `?bare=1` shows the words without the WebGL night; `?gust=1` sends a themed gust after 4 seconds.
- Each scene module has a test page in `dev/` (for example `dev/fire.html`).
- `node tools/validate-words.js` checks `data/words.js`; `node tests/memory.test.js` runs the memory tests.

## Credits

- Star data: [HYG Database](https://github.com/astronexus/HYG-Database) v4.1, (c) David Nash / astronexus, CC BY-SA 4.0. The share-alike licence applies to `js/scene/stars-data.js`.
- Constellation lines (debug view only): [d3-celestial](https://github.com/ofrohn/d3-celestial), (c) 2015 Olaf Frohn, BSD 3-Clause.
- three.js, (c) three.js authors, MIT (`vendor/three/LICENSE`).
