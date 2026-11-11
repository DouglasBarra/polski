#!/usr/bin/env node
/*
  OWNER: QA agent.
  STATUS: stub. Implement the checks below.

  CONTRACT
    Usage: node tools/validate-words.js   (run from anywhere; resolve paths from __dirname)
    Node only, no dependencies, no package.json.
    Load data/words.js by reading it as UTF-8 text and evaluating it with a fake
    `window` object (for example `new Function("window", source)(fakeWindow)` or the
    `vm` module), then read fakeWindow.Iskry.WORDS. Do not change words.js to make it
    loadable.
    Print one line per problem as `{id or index}: {field}: {what is wrong}`, then a
    summary line. Exit 0 when there are no errors, 1 otherwise. Warnings do not fail.

  ERRORS
    - Iskry.WORDS is missing, not an array, or empty.
    - An entry is missing a field, has an extra field, or has a field of the wrong type.
      Fields: id, pl, en, respelling, example { pl, en }, theme, family, rare.
    - id: does not match /^[a-z0-9]+(-[a-z0-9]+)*$/, or is not unique.
    - id: is not the ascii slug of pl (strip ą ć ę ł ń ó ś ź ż to a c e l n o s z z,
      lowercase, spaces to hyphens), allowing an extra "-hint" suffix.
    - pl, en, example.pl, example.en: empty, or with leading or trailing whitespace.
    - pl, example.pl: contain characters outside Polish letters, spaces, hyphens and
      basic punctuation; contain mojibake or the replacement character U+FFFD; are not
      in NFC form.
    - respelling: does not match /^[A-Za-z]+(-[A-Za-z]+)*( [A-Za-z]+(-[A-Za-z]+)*)*$/;
      a syllable mixes upper and lower case; a space-separated word does not have
      exactly one all-caps syllable; the number of words differs from pl.
    - theme: not one of fire-night, home, food, nature, feelings, people, small-words.
    - family: not an array of strings; contains its own id, a duplicate, or an id that
      does not exist; a link that is not symmetric (a lists b but b does not list a).
    - rare: not a boolean.
    - example.pl or example.en does not start with an uppercase letter or does not end
      with . ! ? or …

  WARNINGS
    - The stressed syllable is not the second-to-last one in a word of 2+ syllables
      (legitimate exceptions exist).
    - Syllable count of the respelling differs from the number of vowel groups in pl
      (a, ą, e, ę, i, o, ó, u, y; "i" before another vowel only softens and does not
      count).
    - example.pl does not contain the first 3 letters of pl, case-insensitively
      (the word may be inflected).
    - example.pl is longer than 8 words.
    - A theme has no words; more than 15% of words are rare.
    - Fewer words than --words-max in css/tokens.css (the sky cannot fill without repeats).
*/
"use strict";

console.error("validate-words: not implemented yet (QA agent).");
process.exit(1);
