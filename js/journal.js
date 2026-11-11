/*
  OWNER: memory agent (this file and css/journal.css).

  INTERFACE
    Iskry.journal.init(rootEl, wordsById)   called once by the boot script.
      rootEl     an empty element, e.g. <div id="journal-root"></div>, placed after
                 #card-root. The journal builds everything inside it.
      wordsById  { [id]: word }, the same map the card gets. Optional: falls back to
                 Iskry.WORDS.

  WHAT THIS DOES
    A quiet side panel listing every word you have caught (Iskry.memory.entries()),
    grouped by theme in the order of CONTRACT.md, Polish words sorted alphabetically,
    each with pl and en. Golden words (Iskry.memory.isGolden) are drawn softly in gold.
    No counts, dates or progress: nothing is shown as a number.
    - A small book glyph in the bottom-right corner (.journal-toggle) opens and closes it.
    - The panel slides in from the right and is NOT modal: the scene stays usable around
      it. It closes on Esc, on its close button, on the toggle, and when a word is caught
      ("word:catch"), so the card always has the whole night to itself.
    - Re-renders on "memory:change". Entries whose id is not in wordsById are skipped.

  DOM (all inside rootEl)
    .journal-toggle[aria-expanded][aria-controls="journal-panel"]
    aside#journal-panel.journal[.is-open], .journal__close, .journal__title,
    .journal__empty, .journal__group, .journal__theme, .journal__list,
    .journal__entry[data-id][.is-golden], .journal__pl[lang=pl], .journal__en

  ACCESSIBILITY
    Toggle is a real button with aria-expanded. On open, focus moves to the panel
    title; on close (Esc, close button) it returns to the toggle. Closed, the panel is
    visibility:hidden, so it is out of the tab order and the accessibility tree.

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
  var EMPTY_LINE = "Nothing kept here yet. The night is long.";
  var SVG_NS = "http://www.w3.org/2000/svg";

  var hasOwn = Object.prototype.hasOwnProperty;
  var root = null;
  var words = {};
  var els = {};
  var isOpen = false;
  var dirty = true;

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
    head.appendChild(title);
    head.appendChild(close);

    var body = el("div", "journal__body");
    var empty = el("p", "journal__empty", EMPTY_LINE);
    var groups = el("div", "journal__groups");
    body.appendChild(empty);
    body.appendChild(groups);

    panel.appendChild(head);
    panel.appendChild(body);
    root.appendChild(toggle);
    root.appendChild(panel);

    els = { toggle: toggle, panel: panel, title: title, close: close, body: body, empty: empty, groups: groups };
  }

  /* ---------- render ---------- */

  function render() {
    dirty = false;
    var byTheme = Object.create(null);
    var any = false;
    var list = memoryEntries();
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !hasOwn.call(words, entry.id)) continue;
      var w = words[entry.id];
      var theme = typeof w.theme === "string" ? w.theme : "";
      (byTheme[theme] = byTheme[theme] || []).push({ word: w, golden: golden(entry) });
      any = true;
    }

    els.empty.hidden = any;
    els.groups.textContent = "";
    if (!any) return;

    var order = THEMES.slice();
    for (var t in byTheme) {
      var known = false;
      for (var j = 0; j < THEMES.length; j++) if (THEMES[j][0] === t) known = true;
      if (!known) order.push([t, OTHER_LABEL]);
    }

    var frag = document.createDocumentFragment();
    for (var k = 0; k < order.length; k++) {
      var items = byTheme[order[k][0]];
      if (!items) continue;
      items.sort(function (a, b) { return String(a.word.pl).localeCompare(String(b.word.pl), "pl"); });

      var section = el("section", "journal__group");
      var headingId = "journal-theme-" + k;
      var heading = el("h3", "journal__theme", order[k][1]);
      heading.id = headingId;
      section.setAttribute("aria-labelledby", headingId);
      var ul = el("ul", "journal__list");
      for (var n = 0; n < items.length; n++) {
        var it = items[n];
        var li = el("li", "journal__entry");
        li.setAttribute("data-id", it.word.id);
        var pl = el("span", "journal__pl", it.word.pl);
        pl.lang = "pl";
        li.appendChild(pl);
        li.appendChild(el("span", "journal__en", it.word.en));
        if (it.golden) {
          li.classList.add("is-golden");
          li.appendChild(el("span", "visually-hidden journal__sr", ", an old friend"));
        }
        ul.appendChild(li);
      }
      section.appendChild(heading);
      section.appendChild(ul);
      frag.appendChild(section);
    }
    els.groups.appendChild(frag);
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
