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
    - Calls Iskry.memory.record(id) on every word shown.

  ACCESSIBILITY
    - role="dialog", aria-modal="true": the card is MODAL. aria-labelledby is the word,
      aria-describedby is the meaning.
    - Focus moves to the close button on open; Tab and Shift+Tab wrap inside the card, and
      focus that escapes is pulled back. Focus is not restored here: the scene refocuses
      the word on word:release.
    - After switching to a related word, focus moves to the new word (tabindex="-1") so a
      screen reader announces it and the keyboard user is not dropped on <body>.
    - Motion is driven by CSS and the --dur-* tokens; reduced motion is opacity only.

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
    var meaning = el("p", "card__meaning");
    meaning.id = "iskry-card-meaning";

    var example = el("div", "card__example");
    var examplePl = el("p", "card__example-pl");
    examplePl.lang = "pl";
    var exampleEn = el("p", "card__example-en");
    example.appendChild(examplePl);
    example.appendChild(exampleEn);

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
    content.appendChild(meaning);
    content.appendChild(example);
    content.appendChild(family);

    card.appendChild(close);
    card.appendChild(content);

    root.appendChild(backdrop);
    root.appendChild(card);

    els = {
      backdrop: backdrop, card: card, close: close, content: content, rare: rare,
      word: word, respelling: respelling, meaning: meaning, example: example,
      examplePl: examplePl, exampleEn: exampleEn, family: family, familyList: familyList
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
    li.appendChild(btn);
    return li;
  }

  // Fill the card with one word. Never touches position or state.
  function render(word) {
    var isRare = !!word.rare;
    els.card.classList.toggle("is-rare", isRare);
    els.rare.hidden = !isRare;

    els.word.textContent = str(word.pl);
    els.respelling.textContent = str(word.respelling);
    els.respelling.hidden = !str(word.respelling);
    els.meaning.textContent = str(word.en);
    els.meaning.hidden = !str(word.en);

    var ex = word.example || {};
    els.examplePl.textContent = str(ex.pl);
    els.exampleEn.textContent = str(ex.en);
    els.exampleEn.hidden = !str(ex.en);
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

    els.card.scrollTop = 0;
  }

  function show(id) {
    viewId = id;
    render(words[id]);
    try {
      if (Iskry.memory && typeof Iskry.memory.record === "function") Iskry.memory.record(id);
    } catch (err) { /* memory must never break the card */ }
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
      show(target);
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
      if (list[i].getClientRects().length) out.push(list[i]);
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
    init: function (rootEl, wordsById) {
      if (!rootEl || root) return;
      root = rootEl;
      words = wordsById || {};
      build();

      root.hidden = true;
      root.setAttribute("data-state", "closed");

      els.close.addEventListener("click", close);
      els.backdrop.addEventListener("click", close);
      els.card.addEventListener("click", function (event) {
        var target = event.target;
        var item = target && target.closest ? target.closest(".card__family-item") : null;
        if (item && els.card.contains(item)) swapTo(item.getAttribute("data-id"));
      });

      document.addEventListener("word:catch", onCatch);
      document.addEventListener("keydown", onKeydown, true);
      document.addEventListener("focusin", onFocusIn);
      window.addEventListener("resize", onResize);
    }
  };
})(window.Iskry);
