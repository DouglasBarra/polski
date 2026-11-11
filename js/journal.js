/*
  OWNER: memory agent (this file and css/journal.css).

  INTERFACE
    Iskry.journal.init(rootEl, wordsById)   called once by the boot script.
      rootEl     an empty element, e.g. <div id="journal-root"></div>, placed after
                 #card-root. The journal builds everything inside it.
      wordsById  { [id]: word }, the same map the card gets. Optional: falls back to
                 Iskry.WORDS.

  WHAT THIS DOES
    A quiet side panel of the words you have caught (Iskry.memory.entries(); a word only
    opened from a related-word chip is not listed until it is caught). Golden words
    (Iskry.memory.isGolden) are drawn softly in gold. No counts, dates or progress:
    nothing is shown as a number, and nothing you do here is recorded.
    - A small book glyph in the bottom-right corner (.journal-toggle) opens and closes it.
    - The panel slides in from the right and is NOT modal: the scene stays usable around
      it. It closes on Esc, on its close button, on the toggle, and when a word is caught
      ("word:catch"), so the card always has the whole night to itself.
    - "Tonight" comes first: the words caught this visit day, newest first. The rest are
      grouped by theme in the order of CONTRACT.md, alphabetically.
    - Every word is a button. Pressing it opens the word in place: how to say it and its
      example sentence (the word marked in it). Pressing again closes it.
    - "mist" (.journal__mist, a toggle button): the English meanings sink into a soft
      mist, so you can look at a Polish word, think, and then rest the pointer on it,
      Tab to it, or open it, to see the meaning. A way to check yourself with no answers
      and no judgement; memory is not told. The choice is remembered (localStorage
      "iskry.journal.v1", guarded).
    - Re-renders on "memory:change", keeping open words open. Entries whose id is not in
      wordsById are skipped.

  DOM (all inside rootEl)
    .journal-toggle[aria-expanded][aria-controls="journal-panel"]
    aside#journal-panel.journal[.is-open][.is-misted]
      .journal__head: .journal__title, .journal__mist[aria-pressed], .journal__close
      .journal__body: .journal__empty, .journal__hint, .journal__groups
        .journal__group[.journal__group--tonight]: .journal__theme, .journal__list
          li.journal__entry[data-id][.is-golden][.is-open]
            button.journal__word[aria-expanded][aria-controls]: .journal__pl[lang=pl], .journal__en
            .journal__more: .journal__respelling (.journal__stress), .journal__example-pl
              [lang=pl] (.journal__hit), .journal__example-en

  ACCESSIBILITY
    Toggle is a real button with aria-expanded. On open, focus moves to the panel
    title; on close (Esc, close button) it returns to the toggle. Closed, the panel is
    visibility:hidden, so it is out of the tab order and the accessibility tree.
    Words are real buttons with aria-expanded, in reading order. The mist is a toggle
    button with aria-pressed. While the mist is on, a closed word's English is
    aria-hidden (the button reads as the Polish word alone) and opening the word gives
    the meaning back, so the self-check works the same without sight. Golden words carry
    a visually hidden ", an old friend".

  All text from data goes in with textContent. Never innerHTML.
*/
window.Iskry = window.Iskry || {};

(function (Iskry) {
  "use strict";

  var THEMES = [
    ["fire-night", "Fire and night"],
    ["home", "Home"],
    ["food", "Food"],
    ["nature", "Nature"],
    ["feelings", "Feelings"],
    ["people", "People"],
    ["small-words", "Small words"]
  ];
  var OTHER_LABEL = "And the rest";
  var TONIGHT_LABEL = "Tonight";
  var MIST_LABEL = "mist";
  var MIST_TITLE = "Hide the English until you rest on a word";
  var MIST_HINT = "The meanings are in the mist. Rest on a word, or open it, to see.";
  var PREF_KEY = "iskry.journal.v1";
  var EMPTY_LINE = "Nothing kept here yet. The night is long.";
  var SVG_NS = "http://www.w3.org/2000/svg";

  var hasOwn = Object.prototype.hasOwnProperty;
  var root = null;
  var words = {};
  var els = {};
  var isOpen = false;
  var dirty = true;
  var misted = false;
  var openIds = Object.create(null);   // words opened in place: { [id]: true }
  var serial = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* An open book, drawn with two soft strokes. */
  function bookGlyph() {
    var s = svg("svg", { viewBox: "0 0 24 24", width: "22", height: "22", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("path", { d: "M12 6.5C10 5 7 4.6 3.5 5v12.5c3.5-.4 6.5 0 8.5 1.5 2-1.5 5-1.9 8.5-1.5V5C17 4.6 14 5 12 6.5z" }));
    s.appendChild(svg("path", { d: "M12 6.5V19" }));
    return s;
  }

  function memoryEntries() {
    try {
      var m = Iskry.memory;
      return m && typeof m.entries === "function" ? m.entries() || [] : [];
    } catch (e) {
      return [];
    }
  }

  function golden(entry) {
    try {
      var m = Iskry.memory;
      if (m && typeof m.isGolden === "function") return !!m.isGolden(entry.id);
    } catch (e) { /* fall through */ }
    return !!entry.golden;
  }

  function readPref() {
    try { return window.localStorage.getItem(PREF_KEY) === "mist"; } catch (e) { return false; }
  }

  function writePref(on) {
    try {
      if (on) window.localStorage.setItem(PREF_KEY, "mist");
      else window.localStorage.removeItem(PREF_KEY);
    } catch (e) { /* not remembered, fine */ }
  }

  // The card's matchers, when card.js is loaded: where the word stands in its example,
  // and which syllables of the respelling are stressed.
  function mark() {
    var c = Iskry.card;
    return c && c.mark ? c.mark : null;
  }

  /* ---------- build ---------- */

  function build() {
    var toggle = el("button", "journal-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "journal-panel");
    toggle.setAttribute("aria-label", "Words you have caught");
    toggle.title = "Words you have caught";
    toggle.appendChild(bookGlyph());

    var panel = el("aside", "journal");
    panel.id = "journal-panel";
    panel.setAttribute("aria-labelledby", "journal-title");

    var head = el("header", "journal__head");
    var title = el("h2", "journal__title", "Caught sparks");
    title.id = "journal-title";
    title.tabIndex = -1;
    var close = el("button", "journal__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    var mist = el("button", "journal__mist", MIST_LABEL);
    mist.type = "button";
    mist.setAttribute("aria-pressed", "false");
    mist.setAttribute("aria-label", "Mist: hide the English meanings");
    mist.title = MIST_TITLE;
    head.appendChild(title);
    head.appendChild(mist);
    head.appendChild(close);

    var body = el("div", "journal__body");
    var empty = el("p", "journal__empty", EMPTY_LINE);
    var hint = el("p", "journal__hint", MIST_HINT);
    hint.hidden = true;
    var groups = el("div", "journal__groups");
    body.appendChild(empty);
    body.appendChild(hint);
    body.appendChild(groups);

    panel.appendChild(head);
    panel.appendChild(body);
    root.appendChild(toggle);
    root.appendChild(panel);

    els = { toggle: toggle, panel: panel, title: title, mist: mist, close: close, body: body, empty: empty, hint: hint, groups: groups };
  }

  /* ---------- render ---------- */

  // "OH-gyen" with its stressed syllable wrapped; the text is unchanged.
  function respellingLine(word) {
    var p = el("p", "journal__respelling");
    var m = mark();
    var parts = m && typeof m.stress === "function" ? m.stress(word.respelling) : null;
    if (!parts) { p.textContent = word.respelling; return p; }
    for (var i = 0; i < parts.length; i++) {
      p.appendChild(parts[i].stress ? el("span", "journal__stress", parts[i].text) : document.createTextNode(parts[i].text));
    }
    return p;
  }

  // The Polish example with the word's form wrapped, when it can be found for sure.
  function exampleLine(word, text) {
    var p = el("p", "journal__example-pl");
    p.lang = "pl";
    var m = mark();
    var at = null;
    try { at = m && typeof m.form === "function" ? m.form(word.pl, text) : null; } catch (e) { at = null; }
    if (!at) { p.textContent = text; return p; }
    if (at[0] > 0) p.appendChild(document.createTextNode(text.slice(0, at[0])));
    p.appendChild(el("span", "journal__hit", text.slice(at[0], at[1])));
    if (at[1] < text.length) p.appendChild(document.createTextNode(text.slice(at[1])));
    return p;
  }

  function entryNode(it) {
    var w = it.word;
    var id = String(w.id);
    var open = !!openIds[id];
    var li = el("li", "journal__entry");
    li.setAttribute("data-id", id);
    if (open) li.classList.add("is-open");

    var moreId = "journal-more-" + (++serial);
    var btn = el("button", "journal__word");
    btn.type = "button";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-controls", moreId);
    var pl = el("span", "journal__pl", w.pl);
    pl.lang = "pl";
    btn.appendChild(pl);
    btn.appendChild(el("span", "journal__sr", ", "));
    var en = el("span", "journal__en", w.en);
    if (misted && !open) en.setAttribute("aria-hidden", "true");
    btn.appendChild(en);
    if (it.golden) {
      li.classList.add("is-golden");
      btn.appendChild(el("span", "journal__sr", ", an old friend"));
    }
    li.appendChild(btn);

    var more = el("div", "journal__more");
    more.id = moreId;
    more.hidden = !open;
    if (w.respelling) more.appendChild(respellingLine(w));
    var ex = w.example || {};
    if (ex.pl) more.appendChild(exampleLine(w, String(ex.pl)));
    if (ex.en) more.appendChild(el("p", "journal__example-en", String(ex.en)));
    li.appendChild(more);
    return li;
  }

  function groupNode(label, items, modifier) {
    var section = el("section", "journal__group" + (modifier ? " journal__group--" + modifier : ""));
    var headingId = "journal-theme-" + (++serial);
    var heading = el("h3", "journal__theme", label);
    heading.id = headingId;
    section.setAttribute("aria-labelledby", headingId);
    var ul = el("ul", "journal__list");
    for (var n = 0; n < items.length; n++) ul.appendChild(entryNode(items[n]));
    section.appendChild(heading);
    section.appendChild(ul);
    return section;
  }

  function render() {
    dirty = false;
    var byTheme = Object.create(null);
    var tonight = [];
    var any = false;
    var list = memoryEntries();
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !hasOwn.call(words, entry.id)) continue;
      if (entry.caught === false) continue;           // only opened from a chip, never caught
      var w = words[entry.id];
      var item = { word: w, golden: golden(entry) };
      any = true;
      if (entry.today === true) { tonight.push(item); continue; }   // entries() is newest first
      var theme = typeof w.theme === "string" ? w.theme : "";
      (byTheme[theme] = byTheme[theme] || []).push(item);
    }

    // Keep the keyboard where it was: the same word, if it is still listed.
    var active = document.activeElement;
    var focusId = active && active.classList && active.classList.contains("journal__word") && els.groups.contains(active)
      ? active.parentNode.getAttribute("data-id") : null;

    els.empty.hidden = any;
    els.mist.hidden = !any;
    els.hint.hidden = !any || !misted;
    els.groups.textContent = "";
    if (!any) return;

    var order = THEMES.slice();
    for (var t in byTheme) {
      var known = false;
      for (var j = 0; j < THEMES.length; j++) if (THEMES[j][0] === t) known = true;
      if (!known) order.push([t, OTHER_LABEL]);
    }

    var frag = document.createDocumentFragment();
    if (tonight.length) frag.appendChild(groupNode(TONIGHT_LABEL, tonight, "tonight"));
    for (var k = 0; k < order.length; k++) {
      var items = byTheme[order[k][0]];
      if (!items) continue;
      items.sort(function (a, b) { return String(a.word.pl).localeCompare(String(b.word.pl), "pl"); });
      frag.appendChild(groupNode(order[k][1], items, ""));
    }
    els.groups.appendChild(frag);

    if (focusId !== null) {
      var again = entryById(focusId);
      if (again) {
        try { again.firstChild.focus({ preventScroll: true }); } catch (e) { again.firstChild.focus(); }
      }
    }
  }

  function entryById(id) {
    var items = els.groups.querySelectorAll(".journal__entry");
    for (var i = 0; i < items.length; i++) if (items[i].getAttribute("data-id") === id) return items[i];
    return null;
  }

  /* ---------- opening a word in place, and the mist ---------- */

  function toggleEntry(li) {
    var id = li.getAttribute("data-id");
    var open = !openIds[id];
    if (open) openIds[id] = true; else delete openIds[id];
    li.classList.toggle("is-open", open);
    var btn = li.querySelector(".journal__word");
    var more = li.querySelector(".journal__more");
    var en = li.querySelector(".journal__en");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (more) more.hidden = !open;
    if (en) {
      if (misted && !open) en.setAttribute("aria-hidden", "true");
      else en.removeAttribute("aria-hidden");
    }
  }

  function setMist(on) {
    misted = !!on;
    els.panel.classList.toggle("is-misted", misted);
    els.mist.setAttribute("aria-pressed", misted ? "true" : "false");
    els.hint.hidden = !misted || els.mist.hidden;
    var items = els.groups.querySelectorAll(".journal__entry");
    for (var i = 0; i < items.length; i++) {
      var en = items[i].querySelector(".journal__en");
      if (!en) continue;
      if (misted && !items[i].classList.contains("is-open")) en.setAttribute("aria-hidden", "true");
      else en.removeAttribute("aria-hidden");
    }
  }

  /* ---------- open / close ---------- */

  function open() {
    if (isOpen) return;
    if (dirty) render();
    isOpen = true;
    els.panel.classList.add("is-open");
    els.toggle.setAttribute("aria-expanded", "true");
    els.body.scrollTop = 0;
    try { els.title.focus({ preventScroll: true }); } catch (e) { els.title.focus(); }
  }

  function close(returnFocus) {
    if (!isOpen) return;
    isOpen = false;
    els.panel.classList.remove("is-open");
    els.toggle.setAttribute("aria-expanded", "false");
    if (returnFocus) {
      try { els.toggle.focus({ preventScroll: true }); } catch (e) { els.toggle.focus(); }
    }
  }

  function onKeydown(ev) {
    if (!isOpen) return;
    if (ev.key !== "Escape" && ev.key !== "Esc") return;
    // Esc belongs to the card while it is open (it closes the journal on word:catch anyway).
    var card = document.getElementById("card-root");
    if (card && !card.hidden) return;
    ev.preventDefault();
    var inside = root.contains(document.activeElement);
    close(inside || document.activeElement === document.body);
  }

  /* ---------- init ---------- */

  function init(rootEl, wordsById) {
    if (root || !rootEl) return;
    root = rootEl;
    root.classList.add("journal-root");

    if (wordsById && typeof wordsById === "object") {
      words = wordsById;
    } else {
      words = {};
      var list = Iskry.WORDS || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) words[list[i].id] = list[i];
    }

    build();
    setMist(readPref());

    els.mist.addEventListener("click", function () {
      setMist(!misted);
      writePref(misted);
    });
    els.groups.addEventListener("click", function (ev) {
      var target = ev.target;
      var btn = target && target.closest ? target.closest(".journal__word") : null;
      if (btn && els.groups.contains(btn)) toggleEntry(btn.parentNode);
    });

    els.toggle.addEventListener("click", function () {
      if (isOpen) close(true); else open();
    });
    els.close.addEventListener("click", function () { close(true); });
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("memory:change", function () {
      if (isOpen) render(); else dirty = true;
    });
    document.addEventListener("word:catch", function () { close(false); });
  }

  Iskry.journal = { init: init };
})(window.Iskry);
