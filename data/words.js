/*
  OWNER: words agent. Data only: no logic in this file.

  CONTRACT
    Defines window.Iskry.WORDS, an array of word objects. Loaded with a classic <script>
    tag (file:// safe), and by tools/validate-words.js with a fake `window`.
    Save as UTF-8. Polish diacritics must be the real characters: ą ć ę ł ń ó ś ź ż.
    Run `node tools/validate-words.js` before committing.

  SCHEMA (every field is required)
    id          string. Unique. Lowercase ascii slug of `pl`: strip diacritics
                (ą→a ć→c ę→e ł→l ń→n ó→o ś→s ź→z ż→z), spaces become hyphens.
                Must match /^[a-z0-9]+(-[a-z0-9]+)*$/. Examples: "kot", "dziekuje",
                "dzien-dobry". If two words collide, add a hint: "zamek-castle".
    pl          string. The Polish word or short phrase as it would appear in a
                dictionary (nouns in the nominative singular, verbs in the infinitive),
                lowercase unless it is a proper noun. At most 3 words.
    en          string. Short English meaning, lowercase, no trailing period. Use "; "
                between two senses. Add the gender-neutral gloss a beginner needs and
                nothing more.
    respelling  string. How an English speaker should say it. Syllables joined by
                hyphens, the stressed syllable in CAPS, the rest lowercase, ascii letters
                only. A one-syllable word is all caps. In a phrase, separate words with a
                space and mark one stressed syllable per word.
                Polish stress almost always falls on the second-to-last syllable.
    example     object { pl, en }. One short, natural sentence (about 3 to 7 words) that
                contains the word, possibly inflected, and its English translation. Each
                starts with a capital and ends with punctuation.
    theme       string. Exactly one of:
                  "fire-night"   fire, night, sky, light, warmth, music
                  "home"         house, rooms, objects, pets
                  "food"         food and drink
                  "nature"       weather, plants, wild animals, landscape
                  "feelings"     emotions and states
                  "people"       family, friends, roles, greetings between people
                  "small-words"  yes, no, and, here, already: the glue
    family      array of ids of related words (diminutives, shared root, close pairs).
                May be empty. Every id must exist in this file, a word never lists
                itself, and links are symmetric: if a lists b, b lists a.
    rare        boolean. true for an unusual or poetic word that should drift by less
                often. Most words are false.

  RESPELLING GUIDE (be consistent)
    a → ah      e → eh      i → ee      o → oh      u, ó → oo     y → ih
    ą → on / om (before b, p)           ę → en / em (before b, p), "eh" at word end
    c → ts      cz → ch     ć, ci → ch  sz → sh     ś, si → sh
    ż, rz → zh  ź, zi → zh  dz → dz     dż → j      dź, dzi → j
    ł → w       w → v       j → y       ch, h → kh  ń, ni → ny (n + y glide)
    Final voiced consonants are devoiced: chleb → KHLEP, róg → ROOK.
    A syllable that ends in a consonant may drop the helper "h" when plain English
    spelling already reads correctly: kot → KOT, kotek → KOH-tek.
*/
window.Iskry = window.Iskry || {};

window.Iskry.WORDS = [
  {
    id: "kot",
    pl: "kot",
    en: "cat",
    respelling: "KOT",
    example: {
      pl: "Kot śpi przy ogniu.",
      en: "The cat is sleeping by the fire."
    },
    theme: "home",
    family: ["kotek"],
    rare: false
  },
  {
    id: "kotek",
    pl: "kotek",
    en: "kitten; kitty",
    respelling: "KOH-tek",
    example: {
      pl: "Mały kotek pije mleko.",
      en: "The little kitten is drinking milk."
    },
    theme: "home",
    family: ["kot"],
    rare: false
  },
  {
    id: "ogien",
    pl: "ogień",
    en: "fire",
    respelling: "OH-gyen",
    example: {
      pl: "Ogień jest ciepły.",
      en: "The fire is warm."
    },
    theme: "fire-night",
    family: [],
    rare: false
  }
];
