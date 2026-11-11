/*
  OWNER: card agent (this file, plus the CARD section of css/main.css).
  CONTRACT.md is the source of truth.

  INTERFACE
    Iskry.card.init(rootEl, wordsById)   called once by the boot script in index.html.

  WHAT THIS DOES
    - Listens for "word:catch" ({ id, rect }) on document and opens a small card beside
      the caught word. Unknown id: no card, "word:release" is dispatched straight away.
    - Dispatches "word:release" ({ id }) exactly once per catch, when the close animation
      starts (Esc, backdrop click or the close button). The id is the one from the catch,
      even after the card has switched to a related word.
    - Related words re-render the same card in place (crossfade, no event, no movement).
    - Calls Iskry.memory.record(id, { via }) on every word shown: via "catch" for the
      word that was caught, via "related" for a word opened from a related-word chip (a
      light touch that does not move the word's schedule).
    - Helps the eye (markup only; the CARD section of css/main.css styles it):
        span.card__example-hit       around the caught word's form in .card__example-pl
                                     ("ogień" finds "ognia"), and around its English gloss
                                     in .card__example-en when the gloss is there. When
                                     nothing can be found for sure, nothing is marked.
                                     The English example is not marked while it is veiled.
        span.card__respelling-stress around each stressed (CAPS) syllable in
                                     .card__respelling. The text itself is unchanged.
        p.card__met                  last child of .card__content, data-familiarity=
                                     "new|returning|golden": "new tonight", "you've met
                                     this one before", "an old friend". Words only.
        .card.is-golden              the shown word is golden.
        .card__family-item.is-met / .is-golden   a related word caught before / golden
                                     (plus a visually hidden ", met before" or ", an old
                                     friend" for screen readers).
      Iskry.card.mark = { form(pl, sentence), gloss(en, sentence), stress(respelling) }
      are the pure functions behind this; tools/validate-words.js uses them too.
    - "Remember?" (Phase 2): for every showing (open and each related-word switch) it asks
      Iskry.memory.hideTranslation(id) once, BEFORE record(id). When true on an open (a
      related-word switch never veils: its English was just on the chip), the Polish word,
      respelling and Polish example show as usual, but the English meaning and the English
      example are replaced by a soft blurred "ghost" of themselves (.card__ghost, always
      aria-hidden; the real text stays in place, transparent). The meaning line is covered
      by a real <button> (.card__veil, "remember?"); a click, Enter or Space on it, or a
      click on the misted example translation, crossfades ghost to text (opacity only,
      instant under reduced motion). It stays lifted for that showing. Never a quiz: there
      is no answer and no judgement.

  ACCESSIBILITY
    - role="dialog", aria-modal="true": the card is MODAL. aria-labelledby is the word,
      aria-describedby is the meaning.
    - Focus moves to the close button on open; Tab and Shift+Tab wrap inside the card, and
      focus that escapes is pulled back. Focus is not restored here: the scene refocuses
      the word on word:release.
    - After switching to a related word, focus moves to the new word (tabindex="-1") so a
      screen reader announces it and the keyboard user is not dropped on <body>.
    - Motion is driven by CSS and the --dur-* tokens; reduced motion is opacity only.
    - While veiled, the English meaning and example are aria-hidden and the dialog has no
      aria-describedby (a description reference would read hidden text). The veil button
      sits in the tab order after the close button. On reveal, focus moves from the veil
      to the meaning (tabindex="-1") so a screen reader reads it; the veil leaves the tab
      order at once and is removed from layout when its fade ends.

  All text from data goes in with textContent. Never innerHTML.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  var hasOwn = Object.prototype.hasOwnProperty;

  var root = null;
  var words = {};
  var els = {};

  var state = "closed";     // closed | opening | open | closing
  var catchId = null;       // id from the word:catch that opened the card
  var released = true;      // whether word:release was already sent for catchId
  var anchor = null;        // normalized rect of the caught word, or null
  var viewId = null;        // id currently shown (may be a related word)

  var stateTimer = 0;
  var swapTimer = 0;
  var swapTarget = null;
  var resizeFrame = 0;

  var veiled = false;       // the English of the shown word is under the veil
  var veilTimer = 0;

  var MET_TEXT = {
    "new": "new tonight",
    "returning": "you've met this one before",
    "golden": "an old friend"
  };
  var CHIP_MET_TEXT = ", met before";
  var CHIP_GOLDEN_TEXT = ", an old friend";

  /* ---------- small helpers ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function str(value) {
    return value == null ? "" : String(value);
  }

  function has(obj, key) {
    return typeof key === "string" && hasOwn.call(obj, key);
  }

  function token(name, fallback) {
    var raw = "";
    try {
      raw = getComputedStyle(root).getPropertyValue(name);
    } catch (err) {
      raw = "";
    }
    var n = parseFloat(raw);
    return isNaN(n) ? fallback : n;
  }

  function clamp(value, lo, hi) {
    if (hi < lo) return lo;
    return Math.min(Math.max(value, lo), hi);
  }

  function setState(next) {
    state = next;
    root.setAttribute("data-state", next);
  }

  function isLive() {
    return state === "opening" || state === "open";
  }

  function normalizeRect(r) {
    if (!r || typeof r !== "object") return null;
    var left = typeof r.left === "number" ? r.left : r.x;
    var top = typeof r.top === "number" ? r.top : r.y;
    var width = typeof r.width === "number" ? r.width : (r.right - left);
    var height = typeof r.height === "number" ? r.height : (r.bottom - top);
    var right = typeof r.right === "number" ? r.right : left + width;
    var bottom = typeof r.bottom === "number" ? r.bottom : top + height;
    var all = [left, top, right, bottom];
    for (var i = 0; i < all.length; i++) {
      if (typeof all[i] !== "number" || !isFinite(all[i])) return null;
    }
    return { left: left, top: top, right: right, bottom: bottom };
  }

  /* ---------- finding the word in its example ---------- */

  var PL_FOLD = { "ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n", "ó": "o", "ś": "s", "ź": "z", "ż": "z" };
  var VOWELS = "aeiouy";

  // Lowercase ascii form of Polish text. One character in, one character out, so
  // positions in the folded text are positions in the original.
  function fold(text) {
    var out = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i).toLowerCase();
      if (ch.length !== 1) ch = text.charAt(i);
      out += hasOwn.call(PL_FOLD, ch) ? PL_FOLD[ch] : ch;
    }
    return out;
  }

  function tokens(sentence) {
    var list = [];
    var re = /[a-z]+/g;
    var folded = fold(sentence);
    var m;
    while ((m = re.exec(folded))) list.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    return list;
  }

  function commonPrefix(a, b) {
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a.charAt(i) === b.charAt(i)) i++;
    return i;
  }

  // The stem of a word that loses its last "e" when it takes an ending:
  // ogień -> ogn(ia), domek -> domk(u), sweter -> swetr(a). "" when there is none.
  function fleetingStem(word) {
    var n = word.length;
    if (n < 4 || VOWELS.indexOf(word.charAt(n - 1)) >= 0 || word.charAt(n - 2) !== "e") return "";
    var head = word.slice(0, n - 2);
    if (head.charAt(head.length - 1) === "i") head = head.slice(0, -1);
    if (!head || VOWELS.indexOf(head.charAt(head.length - 1)) >= 0) return "";
    var stem = head + word.charAt(n - 1);
    return stem.length >= 3 ? stem : "";
  }

  // How well a token of the sentence fits a dictionary word (both folded). 0: not at all.
  // Polish changes the end of a word, so a form shares the word's beginning: all of it
  // but the last letter or two (gitara / gitarze, marzyć / marzę), followed by a short
  // ending. Words of one or two letters must match exactly.
  function fit(token, word) {
    if (token === word) return 1000 + word.length;
    var n = word.length;
    if (n < 3) return 0;
    var best = 0;
    var shared = commonPrefix(token, word);
    var tail = token.length - shared;
    var dropped = n - shared;
    if (shared >= Math.max(3, n - 2) && dropped <= 2 && tail <= (n <= 3 ? 2 : 4)) {
      best = shared * 10 - tail - dropped;
    }
    var stem = fleetingStem(word);
    if (stem && token.indexOf(stem) === 0 && token.length - stem.length <= 3) {
      best = Math.max(best, stem.length * 10 - (token.length - stem.length) - 1);
    }
    return best;
  }

  // Where the word (or phrase) `pl` stands in `sentence`, possibly inflected.
  // Returns [start, end) in the sentence's own characters, or null when unsure.
  function findForm(pl, sentence) {
    pl = str(pl);
    sentence = str(sentence);
    var want = tokens(pl);
    var have = tokens(sentence);
    if (!want.length || !have.length) return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i + want.length <= have.length; i++) {
      var score = 0;
      for (var j = 0; j < want.length; j++) {
        var s = fit(have[i + j].text, want[j].text);
        // The words of a phrase must stand next to each other.
        if (!s || (j > 0 && !/^\s+$/.test(sentence.slice(have[i + j - 1].end, have[i + j].start)))) { score = 0; break; }
        score += s;
      }
      if (score > bestScore) {
        bestScore = score;
        best = [have[i].start, have[i + want.length - 1].end];
      }
    }
    return best;
  }

  function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // English forms a plain gloss may take in a sentence: sing / sings, hug / hugging,
  // shine / shining, berry / berries. Irregular forms are simply not found.
  function englishForms(sense) {
    var forms = [sense, sense + "s", sense + "es", sense + "ing", sense + "ed", sense + "d"];
    var last = sense.charAt(sense.length - 1);
    var stem = sense.slice(0, -1);
    if (last === "e") forms.push(stem + "ing");
    if (last === "y") forms.push(stem + "ies", stem + "ied");
    if (/[bdgmnprt]/.test(last)) forms.push(sense + last + "ing", sense + last + "ed");
    return forms;
  }

  // Where the English meaning `en` ("to sing", "fog; mist") stands in `sentence`.
  // Every sense is tried and the longest find wins ("very much" over "very"); a long
  // definition is never searched for. Returns [start, end) or null.
  function findGloss(en, sentence) {
    en = str(en);
    sentence = str(sentence);
    var senses = en.split(";");
    var best = null;
    for (var i = 0; i < senses.length; i++) {
      var full = senses[i].replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (!full || full.split(" ").length > 3) continue;
      var bare = full.replace(/^(to|a|an|the) /, "");
      var tries = bare !== full ? [full, bare] : [full];
      for (var t = 0; t < tries.length; t++) {
        if (tries[t].length < 2) continue;
        var forms = englishForms(tries[t]);
        var alt = [];
        for (var f = 0; f < forms.length; f++) alt.push(escapeRe(forms[f]));
        alt.sort(function (a, b) { return b.length - a.length; });
        var m = new RegExp("(^|[^a-z])(" + alt.join("|") + ")(?![a-z])", "i").exec(sentence);
        if (m) {
          var start = m.index + m[1].length;
          if (!best || m[2].length > best[1] - best[0]) best = [start, start + m[2].length];
          break; // the full sense was found: no need for the bare one
        }
      }
    }
    return best;
  }

  // "OH-gyen" -> [{ text: "OH", stress: true }, { text: "-gyen", stress: false }].
  // The pieces joined are exactly the respelling.
  function stressParts(respelling) {
    var parts = [];
    var re = /[A-Za-z]+|[^A-Za-z]+/g;
    var text = str(respelling);
    var m;
    while ((m = re.exec(text))) {
      var stress = /^[A-Z]+$/.test(m[0]);
      var prev = parts[parts.length - 1];
      if (prev && !stress && !prev.stress) prev.text += m[0];
      else parts.push({ text: m[0], stress: stress });
    }
    return parts;
  }

  // Put `text` into `node`, with [start, end) wrapped in <span class=cls>.
  function setMarked(node, text, range, cls) {
    node.textContent = "";
    if (!range || !(range[0] >= 0) || !(range[1] > range[0]) || range[1] > text.length) {
      node.textContent = text;
      return;
    }
    if (range[0] > 0) node.appendChild(document.createTextNode(text.slice(0, range[0])));
    node.appendChild(el("span", cls, text.slice(range[0], range[1])));
    if (range[1] < text.length) node.appendChild(document.createTextNode(text.slice(range[1])));
  }

  /* ---------- what memory knows (never shown as a number) ---------- */

  function memoryCall(name, id, fallback) {
    try {
      var m = Iskry.memory;
      if (m && typeof m[name] === "function") return m[name](id);
    } catch (err) { /* memory must never break the card */ }
    return fallback;
  }

  /* ---------- DOM ---------- */

  function build() {
    root.textContent = "";

    var backdrop = el("div", "card-root__backdrop");
    backdrop.setAttribute("aria-hidden", "true");

    var card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "iskry-card-word");
    card.setAttribute("aria-describedby", "iskry-card-meaning");
    card.tabIndex = -1;

    var close = el("button", "card__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");

    var content = el("div", "card__content");

    var rare = el("p", "card__rare", "a rare spark");
    rare.hidden = true;

    var word = el("h2", "card__word");
    word.id = "iskry-card-word";
    word.lang = "pl";
    word.tabIndex = -1;

    var respelling = el("p", "card__respelling");

    // The meaning and, when the word is veiled, the button that covers it.
    var sense = el("div", "card__sense");
    var meaning = el("p", "card__meaning");
    meaning.id = "iskry-card-meaning";
    meaning.tabIndex = -1;
    var veil = el("button", "card__veil");
    veil.type = "button";
    veil.setAttribute("aria-label", "Remember? Show the meaning");
    veil.appendChild(el("span", "card__veil-text", "remember?"));
    veil.hidden = true;
    var meaningGhost = el("span", "card__ghost card__ghost--meaning");
    meaningGhost.setAttribute("aria-hidden", "true");
    sense.appendChild(meaning);
    sense.appendChild(meaningGhost);
    sense.appendChild(veil);

    var example = el("div", "card__example");
    var examplePl = el("p", "card__example-pl");
    examplePl.lang = "pl";
    var exampleEn = el("p", "card__example-en");
    var exampleEnWrap = el("div", "card__example-en-wrap");
    var exampleGhost = el("span", "card__ghost card__ghost--example");
    exampleGhost.setAttribute("aria-hidden", "true");
    exampleEnWrap.appendChild(exampleEn);
    exampleEnWrap.appendChild(exampleGhost);
    example.appendChild(examplePl);
    example.appendChild(exampleEnWrap);

    var family = el("div", "card__family");
    family.setAttribute("role", "group");
    family.setAttribute("aria-labelledby", "iskry-card-family-label");
    var familyLabel = el("p", "card__family-label", "related words");
    familyLabel.id = "iskry-card-family-label";
    var familyList = el("ul", "card__family-list");
    family.appendChild(familyLabel);
    family.appendChild(familyList);

    content.appendChild(rare);
    content.appendChild(word);
    content.appendChild(respelling);
    content.appendChild(sense);
    content.appendChild(example);
    // A quiet line about how well you know this word. Words only, never a number.
    var met = el("p", "card__met");
    met.setAttribute("aria-live", "off");

    content.appendChild(family);
    content.appendChild(met);

    card.appendChild(close);
    card.appendChild(content);

    root.appendChild(backdrop);
    root.appendChild(card);

    els = {
      backdrop: backdrop, card: card, close: close, content: content, rare: rare,
      word: word, respelling: respelling, sense: sense, meaning: meaning, veil: veil,
      meaningGhost: meaningGhost, example: example, examplePl: examplePl,
      exampleEn: exampleEn, exampleEnWrap: exampleEnWrap, exampleGhost: exampleGhost, family: family, familyList: familyList,
      met: met
    };
  }

  function familyItem(fw) {
    var li = document.createElement("li");
    var btn = el("button", "card__family-item");
    btn.type = "button";
    btn.setAttribute("data-id", fw.id);
    btn.appendChild(el("span", "card__family-pl", str(fw.pl)));
    btn.lastChild.lang = "pl";
    if (str(fw.en)) {
      // A hidden comma so the accessible name reads "kotek, kitten" without aria-label,
      // which would flatten the language switch.
      btn.appendChild(el("span", "visually-hidden", ", "));
      btn.appendChild(el("span", "card__family-en", str(fw.en)));
    }
    var isGold = memoryCall("isGolden", fw.id, false) === true;
    var isMet = isGold || memoryCall("isMet", fw.id, false) === true;
    btn.classList.toggle("is-met", isMet);
    btn.classList.toggle("is-golden", isGold);
    if (isMet) btn.appendChild(el("span", "visually-hidden", isGold ? CHIP_GOLDEN_TEXT : CHIP_MET_TEXT));
    li.appendChild(btn);
    return li;
  }

  /* ---------- the "remember?" veil ---------- */

  function setVeil(on) {
    clearTimeout(veilTimer);
    veilTimer = 0;
    veiled = on;
    els.card.classList.toggle("is-veiled", on);
    els.card.classList.remove("is-revealing");
    els.veil.hidden = !on;
    els.veil.removeAttribute("tabindex");
    els.veil.removeAttribute("aria-hidden");
    if (on) {
      els.meaning.setAttribute("aria-hidden", "true");
      els.exampleEn.setAttribute("aria-hidden", "true");
      els.card.removeAttribute("aria-describedby");
    } else {
      els.meaning.removeAttribute("aria-hidden");
      els.exampleEn.removeAttribute("aria-hidden");
      els.card.setAttribute("aria-describedby", "iskry-card-meaning");
    }
  }

  // Lift the veil for this showing. Calm fade, then the button leaves the layout.
  function reveal() {
    if (!veiled || !isLive()) return;
    var hadFocus = document.activeElement === els.veil;
    veiled = false;
    els.meaning.removeAttribute("aria-hidden");
    els.exampleEn.removeAttribute("aria-hidden");
    els.card.setAttribute("aria-describedby", "iskry-card-meaning");
    els.veil.tabIndex = -1;
    els.veil.setAttribute("aria-hidden", "true");
    els.card.classList.remove("is-veiled");
    els.card.classList.add("is-revealing");
    if (hadFocus) {
      try {
        els.meaning.focus({ preventScroll: true });
      } catch (err) {
        els.meaning.focus();
      }
    }
    veilTimer = setTimeout(function () {
      veilTimer = 0;
      els.card.classList.remove("is-revealing");
      els.veil.hidden = true;
    }, token("--card-dur-reveal", 700));
  }

  // Fill the card with one word. Never touches position or state.
  // familiarity: "new" | "returning" | "golden", from memory.
  function render(word, hideEnglish, familiarity) {
    var isRare = !!word.rare;
    els.card.classList.toggle("is-rare", isRare);
    els.rare.hidden = !isRare;

    if (!hasOwn.call(MET_TEXT, familiarity)) familiarity = "new";
    els.card.classList.toggle("is-golden", familiarity === "golden");
    els.met.textContent = MET_TEXT[familiarity];
    els.met.setAttribute("data-familiarity", familiarity);

    els.word.textContent = str(word.pl);
    els.respelling.textContent = "";
    var parts = stressParts(word.respelling);
    for (var p = 0; p < parts.length; p++) {
      els.respelling.appendChild(parts[p].stress
        ? el("span", "card__respelling-stress", parts[p].text)
        : document.createTextNode(parts[p].text));
    }
    els.respelling.hidden = !str(word.respelling);
    els.meaning.textContent = str(word.en);
    els.sense.hidden = !str(word.en);

    var ex = word.example || {};
    var willVeil = !!hideEnglish && !!str(word.en);
    setMarked(els.examplePl, str(ex.pl), findForm(word.pl, ex.pl), "card__example-hit");
    // Under the veil the English example stays plain: a marked word would show through.
    setMarked(els.exampleEn, str(ex.en), willVeil ? null : findGloss(word.en, ex.en), "card__example-hit");
    els.exampleEnWrap.hidden = !str(ex.en);
    els.example.hidden = !str(ex.pl);

    els.familyList.textContent = "";
    var ids = Array.isArray(word.family) ? word.family : [];
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      var fid = ids[i];
      if (!has(words, fid) || fid === word.id || seen[fid]) continue;
      seen[fid] = true;
      els.familyList.appendChild(familyItem(words[fid]));
    }
    els.family.hidden = els.familyList.childNodes.length === 0;

    // Only veil when there is a meaning to remember.
    var veil = willVeil;
    els.meaningGhost.textContent = veil ? str(word.en) : "";
    els.exampleGhost.textContent = veil ? str(ex.en) : "";
    setVeil(veil);

    els.card.scrollTop = 0;
  }

  // fromSwitch: shown via a related-word chip. Its English was just visible on the chip,
  // so it is never veiled; hideTranslation is still asked (before record) so memory's
  // rhythm is the same for every showing, and its answer is ignored.
  function show(id, fromSwitch) {
    viewId = id;
    // Ask once per showing, before record(id).
    var hideEnglish = false;
    try {
      if (Iskry.memory && typeof Iskry.memory.hideTranslation === "function") {
        hideEnglish = Iskry.memory.hideTranslation(id) === true;
      }
    } catch (err) { hideEnglish = false; }
    // How well the word was known before this showing...
    var familiarity = memoryCall("familiarity", id, "new");
    // A catch moves the word's schedule; a related-word view is only a light touch.
    try {
      if (Iskry.memory && typeof Iskry.memory.record === "function") {
        Iskry.memory.record(id, { via: fromSwitch ? "related" : "catch" });
      }
    } catch (err) { /* memory must never break the card */ }
    // ...except that the catch that turns it golden shows it golden at once, like the sky.
    if (memoryCall("isGolden", id, false) === true) familiarity = "golden";
    render(words[id], hideEnglish && !fromSwitch, familiarity);
  }

  /* ---------- position ---------- */

  function viewport() {
    return {
      w: document.documentElement.clientWidth || window.innerWidth,
      h: window.innerHeight || document.documentElement.clientHeight
    };
  }

  function place() {
    var m = token("--card-margin", 16);
    var gap = token("--card-gap", 28);
    var vp = viewport();
    var card = els.card;

    card.style.maxHeight = Math.max(120, vp.h - 2 * m) + "px";
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var a = anchor;
    var left, top, cx = 0, cy = 0;

    if (!a) {
      left = (vp.w - w) / 2;
      top = (vp.h - h) / 2;
    } else {
      cx = (a.left + a.right) / 2;
      cy = (a.top + a.bottom) / 2;
      var roomRight = vp.w - m - a.right - gap;
      var roomLeft = a.left - gap - m;
      if (roomRight >= w) {
        left = a.right + gap;
        top = cy - h / 2;
      } else if (roomLeft >= w) {
        left = a.left - gap - w;
        top = cy - h / 2;
      } else {
        // Too narrow to sit beside the word: go below it, or above if there is more room.
        var below = vp.h - m - a.bottom - gap;
        var above = a.top - gap - m;
        top = (below >= h || below >= above) ? a.bottom + gap : a.top - gap - h;
        left = cx - w / 2;
      }
    }

    left = clamp(left, m, vp.w - m - w);
    top = clamp(top, m, vp.h - m - h);
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";

    // The card grows out of the held word: scale origin and glow point at it.
    if (a) {
      card.style.setProperty("--card-origin", Math.round(cx - left) + "px " + Math.round(cy - top) + "px");
      root.style.setProperty("--spark-x", Math.round(cx) + "px");
      root.style.setProperty("--spark-y", Math.round(cy) + "px");
      root.style.setProperty("--spark-rx", Math.round(a.right - a.left + 140) + "px");
      root.style.setProperty("--spark-ry", Math.round(a.bottom - a.top + 140) + "px");
      root.setAttribute("data-anchored", "true");
    } else {
      card.style.removeProperty("--card-origin");
      root.removeAttribute("data-anchored");
    }
  }

  // After a swap the card may be taller or shorter. Do not move it unless it now
  // runs outside the viewport.
  function keepInView() {
    var m = token("--card-margin", 16);
    var vp = viewport();
    var card = els.card;
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var left = clamp(parseFloat(card.style.left) || 0, m, vp.w - m - w);
    var top = clamp(parseFloat(card.style.top) || 0, m, vp.h - m - h);
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
  }

  /* ---------- open / close ---------- */

  function dispatchRelease(id) {
    document.dispatchEvent(new CustomEvent("word:release", { detail: { id: id } }));
  }

  function release() {
    if (released) return;
    released = true;
    dispatchRelease(catchId);
  }

  function cancelSwap() {
    clearTimeout(swapTimer);
    swapTimer = 0;
    swapTarget = null;
    els.content.classList.remove("is-swapping");
  }

  function hide() {
    clearTimeout(stateTimer);
    stateTimer = 0;
    cancelSwap();
    setVeil(false);
    root.hidden = true;
    setState("closed");
    catchId = null;
    viewId = null;
    anchor = null;
  }

  // Used when a new catch arrives while a card is still on screen.
  function finishNow() {
    clearTimeout(stateTimer);
    stateTimer = 0;
    if (!released) release();
    hide();
  }

  function onCatch(event) {
    var detail = (event && event.detail) || {};
    var id = detail.id;

    if (state !== "closed") finishNow();

    if (!has(words, id)) {
      dispatchRelease(id);
      return;
    }

    catchId = id;
    released = false;
    anchor = normalizeRect(detail.rect);

    root.hidden = false;
    show(id);
    place();
    setState("opening");
    try {
      els.close.focus({ preventScroll: true });
    } catch (err) {
      els.close.focus();
    }

    stateTimer = setTimeout(function () {
      stateTimer = 0;
      if (state === "opening") setState("open");
    }, token("--dur-card-open", 420));
  }

  function close() {
    if (!isLive()) return;
    clearTimeout(stateTimer);
    cancelSwap();
    setState("closing");
    release();
    stateTimer = setTimeout(hide, token("--dur-card-close", 320));
  }

  /* ---------- switching to a related word ---------- */

  function swapTo(id) {
    if (!isLive() || !has(words, id) || id === viewId) return;
    swapTarget = id;
    if (swapTimer) return; // already fading out; it will pick up the latest target
    els.content.classList.add("is-swapping");
    swapTimer = setTimeout(function () {
      swapTimer = 0;
      var target = swapTarget;
      swapTarget = null;
      if (!isLive() || !has(words, target)) {
        els.content.classList.remove("is-swapping");
        return;
      }
      show(target, true);
      keepInView();
      els.content.classList.remove("is-swapping");
      try {
        els.word.focus({ preventScroll: true });
      } catch (err) {
        els.word.focus();
      }
    }, token("--dur-card-swap", 220) / 2);
  }

  /* ---------- keyboard and focus ---------- */

  function focusables() {
    var list = els.card.querySelectorAll("button:not([disabled])");
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].tabIndex >= 0 && list[i].getClientRects().length) out.push(list[i]);
    }
    return out;
  }

  function trapTab(event) {
    var list = focusables();
    if (!list.length) {
      event.preventDefault();
      els.card.focus({ preventScroll: true });
      return;
    }
    var first = list[0];
    var last = list[list.length - 1];
    var active = document.activeElement;
    var inside = els.card.contains(active);
    if (event.shiftKey) {
      if (active === first || !inside) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else if (active === last || !inside) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function onKeydown(event) {
    if (!isLive()) return;
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      trapTab(event);
    }
  }

  function onFocusIn(event) {
    if (isLive() && !root.contains(event.target)) {
      els.close.focus({ preventScroll: true });
    }
  }

  function onResize() {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = 0;
      if (isLive()) place();
    });
  }

  /* ---------- init ---------- */

  Iskry.card = {
    // Pure helpers, shared with tools/validate-words.js (no DOM needed).
    mark: { form: findForm, gloss: findGloss, stress: stressParts },

    init: function (rootEl, wordsById) {
      if (!rootEl || root) return;
      root = rootEl;
      words = wordsById || {};
      build();

      root.hidden = true;
      root.setAttribute("data-state", "closed");

      els.close.addEventListener("click", close);
      els.backdrop.addEventListener("click", close);
      els.veil.addEventListener("click", reveal);
      els.card.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var item = target.closest(".card__family-item");
        if (item && els.card.contains(item)) {
          swapTo(item.getAttribute("data-id"));
        } else if (veiled && target.closest(".card__example-en-wrap")) {
          reveal(); // a pointer shortcut; keyboard users have the veil button
        }
      });

      document.addEventListener("word:catch", onCatch);
      document.addEventListener("keydown", onKeydown, true);
      document.addEventListener("focusin", onFocusIn);
      window.addEventListener("resize", onResize);
    }
  };
})(window.Iskry);
