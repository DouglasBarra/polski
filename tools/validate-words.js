#!/usr/bin/env node
/*
  OWNER: QA agent.
  STATUS: implemented.

  CONTRACT
    Usage: node tools/validate-words.js [path/to/words.js]
           (run from anywhere; the default file is data/words.js, resolved from __dirname)
    Node only, no dependencies, no package.json.
    Load data/words.js by reading it as UTF-8 text and evaluating it with a fake
    `window` object (vm module), then read window.Iskry.WORDS. Do not change words.js to make it
    loadable.
    Print one line per problem as `{id or #position}: {field}: {what is wrong}`, grouped under
    ERRORS and WARNINGS, then stats and a result line. Exit 0 when there are no errors, 1 otherwise.
    Warnings do not fail.

  ERRORS
    - Iskry.WORDS is missing, not an array, or empty.
    - An entry is missing a field or has a field of the wrong type.
      Fields: id, pl, en, respelling, example { pl, en }, theme, family, rare.
    - id: does not match /^[a-z0-9]+(-[a-z0-9]+)*$/, or is not unique.
    - id: is not the ascii slug of pl (strip ą ć ę ł ń ó ś ź ż to a c e l n o s z z,
      lowercase, spaces to hyphens), allowing an extra "-hint" suffix.
    - pl, en, example.pl, example.en: empty, or with leading or trailing whitespace.
    - pl, example.pl: contain mojibake or the replacement character U+FFFD; are not in NFC form.
    - respelling: does not match /^[A-Za-z]+(-[A-Za-z]+)*( [A-Za-z]+(-[A-Za-z]+)*)*$/;
      a syllable mixes upper and lower case; a space-separated word does not have
      exactly one all-caps syllable; the number of words differs from pl.
    - theme: not one of fire-night, home, food, nature, feelings, people, small-words.
    - family: not an array of strings; contains its own id, a duplicate, or an id that
      does not exist; a link that is not symmetric (a lists b but b does not list a).
    - rare: not a boolean.
    - example.pl or example.en does not start with an uppercase letter or does not end
      with . ! ? or …
    - pl: more than 3 words (schema header of words.js).
    - Unknown extra field on an entry or on example (director's decision: the schema is
      closed, so a stray or misspelled field fails).

  WARNINGS
    - The stressed syllable is not the second-to-last one in a word of 2+ syllables
      (legitimate exceptions exist).
    - Syllable count of the respelling differs from the number of vowel groups in pl
      (a, ą, e, ę, i, o, ó, u, y; "i" before another vowel only softens and does not
      count).
    - example.pl does not contain the first 3 letters of pl, case-insensitively
      (the word may be inflected). Diacritics are ignored on both sides.
    - example.pl is longer than 8 words.
    - A theme has no words; more than 15% of words are rare.
    - Fewer words than --words-max in css/tokens.css (the sky cannot fill without repeats).
    - Character outside a sane set in pl or example.pl: Latin and Polish letters, space,
      hyphen, basic punctuation, Polish quotes. (Director's decision: a warning, because
      legitimate exceptions exist, such as a dash or a digit.)
*/
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FILE = path.join(ROOT, "data", "words.js");
const TOKENS_FILE = path.join(ROOT, "css", "tokens.css");

// Theme enum. Copied from the schema header of data/words.js (the "theme" line) and from
// CONTRACT.md, "Words" section. Keep all three in sync.
const THEMES = ["fire-night", "home", "food", "nature", "feelings", "people", "small-words"];

// Fields from the schema header of data/words.js. Every field is required.
const FIELDS = ["id", "pl", "en", "respelling", "example", "theme", "family", "rare"];
const EXAMPLE_FIELDS = ["pl", "en"];

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESPELLING_RE = /^[A-Za-z]+(-[A-Za-z]+)*( [A-Za-z]+(-[A-Za-z]+)*)*$/;
// UTF-8 read as Latin-1, Windows-1250 or cp1252 leaves these lead letters behind:
// Ã Â Ä Å Ă Ĺ (most Polish letters and ó), "â€" (quotes, dashes, ellipsis),
// U+FFFD (replacement character) and C1 control characters.
const MOJIBAKE_RE = /[ÂÃÄÅĂĹ�\u0080-\u009F]|â€/;
// One character that is fine in a Polish field: Latin and Polish letters, space, hyphen,
// basic punctuation, Polish quotation marks.
const POLISH_CHAR_RE = /[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ \-.,!?;:'’"„”«»()…]/;
const PL_FOLD = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };

const errors = [];
const warnings = [];
function err(who, field, msg) { errors.push(`${who}: ${field}: ${msg}`); }
function warn(who, field, msg) { warnings.push(`${who}: ${field}: ${msg}`); }

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function typeName(v) { return v === null ? "null" : Array.isArray(v) ? "array" : typeof v; }

// Lowercase ascii form of a Polish string: ą→a, ł→l, ...
function fold(s) {
  return s.normalize("NFC").toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => PL_FOLD[c]);
}
function plSlug(pl) {
  return fold(pl).replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(Boolean).join("-");
}
// Vowel groups in a Polish word. "i" before another vowel only softens, so it is dropped first.
function vowelGroups(word) {
  const w = word.toLowerCase().replace(/i(?=[aąeęoóuy])/g, "");
  return (w.match(/[aąeęioóuy]+/g) || []).length;
}

function loadWords(file) {
  const raw = fs.readFileSync(file);
  const source = raw.toString("utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: file, timeout: 5000 });
  const iskry = sandbox.window.Iskry;
  return {
    utf8: Buffer.from(source, "utf8").equals(raw),
    words: iskry ? iskry.WORDS : undefined,
  };
}

// Text field: non-empty string, no outer or double spaces, no mojibake.
function checkText(who, field, v) {
  if (typeof v !== "string") { err(who, field, `must be a string, got ${typeName(v)}`); return false; }
  if (v.trim() === "") { err(who, field, "is empty"); return false; }
  let ok = true;
  if (v !== v.trim()) { err(who, field, `has leading or trailing whitespace: ${JSON.stringify(v)}`); ok = false; }
  if (/\s\s/.test(v)) { err(who, field, `has a double space: ${JSON.stringify(v)}`); ok = false; }
  const bad = v.match(MOJIBAKE_RE);
  if (bad) {
    err(who, field, `looks like mojibake (UTF-8 read as Latin-1), found ${JSON.stringify(bad[0])} in ${JSON.stringify(v)}`);
    ok = false;
  }
  return ok;
}

// Polish field extras: NFC form (error) and characters outside the sane set (warning).
function checkPolish(who, field, v) {
  if (v.normalize("NFC") !== v) err(who, field, "is not in NFC form (decomposed accents?)");
  const odd = [...new Set(Array.from(v).filter((c) => !POLISH_CHAR_RE.test(c)))];
  if (odd.length) warn(who, field, `unexpected character(s) ${odd.map((c) => JSON.stringify(c)).join(" ")}`);
}

function checkRespelling(who, resp, pl) {
  if (!RESPELLING_RE.test(resp)) {
    err(who, "respelling", `must be ascii letters and hyphens, words separated by one space: ${JSON.stringify(resp)}`);
    return;
  }
  const words = resp.split(" ");
  const plWords = typeof pl === "string" && pl.trim() ? pl.trim().split(/\s+/) : null;
  if (plWords && plWords.length !== words.length) {
    err(who, "respelling", `has ${words.length} word(s), pl has ${plWords.length}`);
  }
  words.forEach((w, wi) => {
    const syls = w.split("-");
    let capsCount = 0;
    let capsAt = -1;
    syls.forEach((s, si) => {
      if (/^[A-Z]+$/.test(s)) { capsCount += 1; capsAt = si; }
      else if (!/^[a-z]+$/.test(s)) err(who, "respelling", `syllable "${s}" mixes upper and lower case`);
    });
    if (capsCount !== 1) {
      err(who, "respelling", `"${w}" needs exactly one ALL-CAPS (stressed) syllable, has ${capsCount}`);
    } else if (syls.length >= 2 && capsAt !== syls.length - 2) {
      warn(who, "respelling", `stress is on syllable ${capsAt + 1} of ${syls.length} in "${w}"; Polish usually stresses the second-to-last`);
    }
    if (plWords && plWords.length === words.length) {
      const vg = vowelGroups(plWords[wi]);
      if (vg !== syls.length) {
        warn(who, "respelling", `"${w}" has ${syls.length} syllable(s) but "${plWords[wi]}" has ${vg} vowel group(s)`);
      }
    }
  });
}

function checkExample(who, ex, pl) {
  if (!isObject(ex)) { err(who, "example", `must be an object { pl, en }, got ${typeName(ex)}`); return; }
  for (const k of Object.keys(ex)) {
    if (!EXAMPLE_FIELDS.includes(k)) err(who, `example.${k}`, "unknown field (not in the schema)");
  }
  for (const k of EXAMPLE_FIELDS) {
    const field = `example.${k}`;
    if (ex[k] === undefined) { err(who, field, "missing"); continue; }
    if (!checkText(who, field, ex[k])) continue;
    const s = ex[k];
    if (!/^\p{Lu}/u.test(s)) err(who, field, `must start with a capital letter: ${JSON.stringify(s)}`);
    if (!/[.!?…]$/.test(s)) err(who, field, `must end with . ! ? or …: ${JSON.stringify(s)}`);
  }
  if (typeof ex.pl === "string" && ex.pl.trim()) {
    const field = "example.pl";
    checkPolish(who, field, ex.pl);
    const n = ex.pl.trim().split(/\s+/).length;
    if (n > 8) warn(who, field, `${n} words; keep it to 8 or fewer`);
    if (typeof pl === "string" && pl.trim()) {
      const stem = fold(pl).replace(/[^a-z]/g, "").slice(0, 3);
      if (stem && !fold(ex.pl).includes(stem)) {
        warn(who, field, `does not contain "${stem}" (first letters of pl "${pl}"); wrong word or unusual inflection?`);
      }
    }
  }
}

function checkEntry(e, i, byId, idCount) {
  const pos = `#${i + 1}`;
  if (!isObject(e)) { err(pos, "entry", `must be an object, got ${typeName(e)}`); return; }
  const who = typeof e.id === "string" && e.id !== "" ? e.id : pos;

  for (const k of Object.keys(e)) {
    if (!FIELDS.includes(k)) err(who, k, "unknown field (not in the schema)");
  }
  for (const k of FIELDS) {
    if (e[k] === undefined) err(who, k, "missing");
  }

  // id
  if (e.id !== undefined) {
    if (typeof e.id !== "string") {
      err(who, "id", `must be a string, got ${typeName(e.id)}`);
    } else {
      if (!ID_RE.test(e.id)) {
        err(who, "id", `must be a lowercase ascii slug (a-z, 0-9, single hyphens), got ${JSON.stringify(e.id)}`);
      }
      const n = idCount.get(e.id) || 0;
      if (n > 1) err(who, "id", `not unique: ${n} entries use it (this one is ${pos})`);
      if (typeof e.pl === "string" && e.pl.trim()) {
        const slug = plSlug(e.pl);
        if (slug && e.id !== slug && !e.id.startsWith(`${slug}-`)) {
          err(who, "id", `does not match pl "${e.pl}": expected "${slug}" or "${slug}-<hint>"`);
        }
      }
    }
  }

  // pl, en
  if (checkText(who, "pl", e.pl)) {
    checkPolish(who, "pl", e.pl);
    if (e.pl.trim().split(/\s+/).length > 3) err(who, "pl", "has more than 3 words");
  }
  if (checkText(who, "en", e.en) && typeof e.pl === "string" && e.pl.trim().toLowerCase() === e.en.trim().toLowerCase()) {
    warn(who, "en", `same as pl ${JSON.stringify(e.pl)} (copy mistake?)`);
  }

  // respelling
  if (checkText(who, "respelling", e.respelling)) checkRespelling(who, e.respelling, e.pl);

  // example
  if (e.example !== undefined) checkExample(who, e.example, e.pl);

  // theme
  if (e.theme !== undefined && !THEMES.includes(e.theme)) {
    err(who, "theme", `must be one of ${THEMES.join(", ")}; got ${JSON.stringify(e.theme)}`);
  }

  // family
  if (e.family !== undefined) {
    if (!Array.isArray(e.family)) {
      err(who, "family", `must be an array of ids, got ${typeName(e.family)}`);
    } else {
      const seen = new Set();
      for (const f of e.family) {
        if (typeof f !== "string") { err(who, "family", `item ${JSON.stringify(f)} is not a string`); continue; }
        if (f === e.id) err(who, "family", "lists its own id");
        if (seen.has(f)) err(who, "family", `lists "${f}" more than once`);
        seen.add(f);
        const target = byId.get(f);
        if (!target) { err(who, "family", `"${f}" is not an id in this file`); continue; }
        if (typeof e.id === "string" && f !== e.id && Array.isArray(target.family) && !target.family.includes(e.id)) {
          err(who, "family", `lists "${f}", but ${f} does not list "${e.id}" back`);
        }
      }
    }
  }

  // rare
  if (e.rare !== undefined && typeof e.rare !== "boolean") {
    err(who, "rare", `must be true or false, got ${typeName(e.rare)}`);
  }
}

function checkWordsMax(total) {
  let css;
  try {
    css = fs.readFileSync(TOKENS_FILE, "utf8");
  } catch (e) {
    warn("(all)", "--words-max", `cannot read ${path.relative(ROOT, TOKENS_FILE)}; check skipped`);
    return;
  }
  const m = css.match(/--words-max\s*:\s*(\d+)/);
  if (!m) { warn("(all)", "--words-max", "token not found in css/tokens.css; check skipped"); return; }
  const max = Number(m[1]);
  if (total < max) {
    warn("(all)", "count", `${total} words, but css/tokens.css --words-max is ${max}; the sky cannot fill without repeats`);
  }
}

// Stats, plus the collection-wide warnings.
function collectStats(words) {
  const perTheme = Object.fromEntries(THEMES.map((t) => [t, 0]));
  const stats = { total: words.length, perTheme, invalidTheme: 0, rare: 0, withFamily: 0 };
  for (const e of words) {
    if (!isObject(e)) continue;
    if (THEMES.includes(e.theme)) perTheme[e.theme] += 1;
    else stats.invalidTheme += 1;
    if (e.rare === true) stats.rare += 1;
    if (Array.isArray(e.family) && e.family.length > 0) stats.withFamily += 1;
  }
  for (const t of THEMES) {
    if (perTheme[t] === 0) warn("(all)", "theme", `"${t}" has no words`);
  }
  if (stats.total && stats.rare / stats.total > 0.15) {
    const pct = Math.round((100 * stats.rare) / stats.total);
    warn("(all)", "rare", `${stats.rare} of ${stats.total} words (${pct}%) are rare; keep it at 15% or less`);
  }
  checkWordsMax(stats.total);
  return stats;
}

function checkWords(words) {
  const idCount = new Map();
  const byId = new Map();
  for (const e of words) {
    if (!isObject(e) || typeof e.id !== "string") continue;
    idCount.set(e.id, (idCount.get(e.id) || 0) + 1);
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  words.forEach((e, i) => checkEntry(e, i, byId, idCount));
  return collectStats(words);
}

function report(shown, stats) {
  const lines = [`validate-words: ${shown}`, "", `ERRORS (${errors.length})`];
  for (const l of errors) lines.push(`  ${l}`);
  lines.push("", `WARNINGS (${warnings.length})`);
  for (const l of warnings) lines.push(`  ${l}`);
  if (stats) {
    lines.push("", "STATS");
    lines.push(`  words: ${stats.total}`);
    lines.push("  per theme:");
    for (const t of THEMES) lines.push(`    ${t}: ${stats.perTheme[t]}`);
    if (stats.invalidTheme) lines.push(`    (invalid theme): ${stats.invalidTheme}`);
    lines.push(`  rare: ${stats.rare}`);
    lines.push(`  with families: ${stats.withFamily}`);
  }
  lines.push("", `RESULT: ${errors.length ? "FAIL" : "OK"} (${errors.length} error(s), ${warnings.length} warning(s))`);
  console.log(lines.join("\n"));
  process.exitCode = errors.length ? 1 : 0;
}

function main() {
  const arg = process.argv[2];
  const file = arg ? path.resolve(arg) : DEFAULT_FILE;
  const shown = file.startsWith(ROOT + path.sep) ? path.relative(ROOT, file) : file;

  let loaded;
  try {
    loaded = loadWords(file);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    err("(file)", "load", `could not load ${shown}: ${msg.split("\n")[0]}`);
    report(shown, null);
    return;
  }

  let stats = null;
  const { words } = loaded;
  if (!loaded.utf8) err("(file)", "encoding", "file is not valid UTF-8");
  if (words === undefined) err("(file)", "WORDS", "Iskry.WORDS is missing");
  else if (!Array.isArray(words)) err("(file)", "WORDS", `must be an array, got ${typeName(words)}`);
  else if (words.length === 0) err("(file)", "WORDS", "is empty");
  else stats = checkWords(words);
  report(shown, stats);
}

main();
