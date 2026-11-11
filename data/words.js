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
    family      array of ids of RELATED WORDS, shown on the card as "related words".
                Two kinds only: words that share a root (kot/kotek, noc/dobranoc) and
                fixed conversational partners (tak/nie, dziękuję/proszę). Words that
                merely share a topic are not family; the theme covers that.
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
    Final voiced consonants are devoiced: chleb → KHLEP, róg → ROOK. A voiced consonant
    before a voiceless one is devoiced too: babcia → BAHP-chah.
    g before i or e is written "gh" so it is not read as "j": gitara → ghee-TAH-rah.
    ki, gi before a vowel → ky, gy: iskierka → ees-KYEHR-kah, ogień → OH-gyen.
    Word-final ń is written plain "n": ogień → OH-gyen.
    A syllable that ends in a consonant may drop the helper "h" when plain English
    spelling already reads correctly: kot → KOT, kotek → KOH-tek.
*/
window.Iskry = window.Iskry || {};

window.Iskry.WORDS = [
  /* ---------- fire-night ---------- */
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
    family: ["ognisko"],
    rare: false
  },
  {
    id: "ognisko",
    pl: "ognisko",
    en: "bonfire; campfire",
    respelling: "og-NEES-koh",
    example: {
      pl: "Siedzimy razem przy ognisku.",
      en: "We sit together by the campfire."
    },
    theme: "fire-night",
    family: ["ogien"],
    rare: false
  },
  {
    id: "iskra",
    pl: "iskra",
    en: "spark",
    respelling: "EES-krah",
    example: {
      pl: "Iskra leci w górę.",
      en: "A spark flies upward."
    },
    theme: "fire-night",
    family: ["iskierka"],
    rare: false
  },
  {
    id: "iskierka",
    pl: "iskierka",
    en: "little spark",
    respelling: "ees-KYEHR-kah",
    example: {
      pl: "Iskierka tańczy nad ogniskiem.",
      en: "A little spark dances above the campfire."
    },
    theme: "fire-night",
    family: ["iskra"],
    rare: false
  },
  {
    id: "noc",
    pl: "noc",
    en: "night",
    respelling: "NOTS",
    example: {
      pl: "Noc jest cicha i ciepła.",
      en: "The night is quiet and warm."
    },
    theme: "fire-night",
    family: ["dobranoc"],
    rare: false
  },
  {
    id: "gwiazda",
    pl: "gwiazda",
    en: "star",
    respelling: "GVYAHZ-dah",
    example: {
      pl: "Gwiazda świeci nad lasem.",
      en: "A star shines above the forest."
    },
    theme: "fire-night",
    family: [],
    rare: false
  },
  {
    id: "ksiezyc",
    pl: "księżyc",
    en: "moon",
    respelling: "KSHEN-zhits",
    example: {
      pl: "Księżyc wisi nad domem.",
      en: "The moon hangs above the house."
    },
    theme: "fire-night",
    family: [],
    rare: false
  },
  {
    id: "drewno",
    pl: "drewno",
    en: "wood; firewood",
    respelling: "DREV-noh",
    example: {
      pl: "Suche drewno płonie jasno.",
      en: "Dry wood burns brightly."
    },
    theme: "fire-night",
    family: [],
    rare: false
  },
  {
    id: "cieplo",
    pl: "ciepło",
    en: "warmth; also 'it is warm'",
    respelling: "CHEH-pwoh",
    example: {
      pl: "Czuję ciepło ognia.",
      en: "I feel the warmth of the fire."
    },
    theme: "fire-night",
    family: [],
    rare: false
  },
  {
    id: "gitara",
    pl: "gitara",
    en: "guitar",
    respelling: "ghee-TAH-rah",
    example: {
      pl: "Ktoś gra na gitarze.",
      en: "Someone is playing the guitar."
    },
    theme: "fire-night",
    family: [],
    rare: false
  },

  /* ---------- home ---------- */
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
    id: "dom",
    pl: "dom",
    en: "house; home",
    respelling: "DOM",
    example: {
      pl: "Wracam do domu.",
      en: "I am going back home."
    },
    theme: "home",
    family: ["domek"],
    rare: false
  },
  {
    id: "domek",
    pl: "domek",
    en: "little house; cabin",
    respelling: "DOH-mek",
    example: {
      pl: "W małym domku jest ciepło.",
      en: "It is warm in the little house."
    },
    theme: "home",
    family: ["dom"],
    rare: false
  },
  {
    id: "koc",
    pl: "koc",
    en: "blanket",
    respelling: "KOTS",
    example: {
      pl: "Biorę ciepły koc.",
      en: "I am taking a warm blanket."
    },
    theme: "home",
    family: [],
    rare: false
  },

  /* ---------- food ---------- */
  {
    id: "chleb",
    pl: "chleb",
    en: "bread",
    respelling: "KHLEP",
    example: {
      pl: "Chleb jest jeszcze ciepły.",
      en: "The bread is still warm."
    },
    theme: "food",
    family: [],
    rare: false
  },
  {
    id: "herbata",
    pl: "herbata",
    en: "tea",
    respelling: "khehr-BAH-tah",
    example: {
      pl: "Pijemy gorącą herbatę.",
      en: "We are drinking hot tea."
    },
    theme: "food",
    family: [],
    rare: false
  },
  {
    id: "miod",
    pl: "miód",
    en: "honey",
    respelling: "MYOOT",
    example: {
      pl: "Dodaję miód do herbaty.",
      en: "I add honey to the tea."
    },
    theme: "food",
    family: [],
    rare: false
  },
  {
    id: "mleko",
    pl: "mleko",
    en: "milk",
    respelling: "MLEH-koh",
    example: {
      pl: "Lubię kawę z mlekiem.",
      en: "I like coffee with milk."
    },
    theme: "food",
    family: [],
    rare: false
  },
  {
    id: "woda",
    pl: "woda",
    en: "water",
    respelling: "VOH-dah",
    example: {
      pl: "Piję zimną wodę.",
      en: "I am drinking cold water."
    },
    theme: "food",
    family: [],
    rare: false
  },

  /* ---------- nature ---------- */
  {
    id: "las",
    pl: "las",
    en: "forest",
    respelling: "LAHS",
    example: {
      pl: "Idziemy powoli do lasu.",
      en: "We are walking slowly to the forest."
    },
    theme: "nature",
    family: [],
    rare: false
  },
  {
    id: "deszcz",
    pl: "deszcz",
    en: "rain",
    respelling: "DESHCH",
    example: {
      pl: "Deszcz cicho pada na dach.",
      en: "Rain is falling softly on the roof."
    },
    theme: "nature",
    family: [],
    rare: false
  },
  {
    id: "wiatr",
    pl: "wiatr",
    en: "wind",
    respelling: "VYAHTR",
    example: {
      pl: "Wiatr szumi w drzewach.",
      en: "The wind rustles in the trees."
    },
    theme: "nature",
    family: [],
    rare: false
  },
  {
    id: "sowa",
    pl: "sowa",
    en: "owl",
    respelling: "SOH-vah",
    example: {
      pl: "Sowa nie śpi w nocy.",
      en: "The owl does not sleep at night."
    },
    theme: "nature",
    family: [],
    rare: false
  },
  {
    id: "niebo",
    pl: "niebo",
    en: "sky; heaven",
    respelling: "NYEH-boh",
    example: {
      pl: "Niebo jest pełne gwiazd.",
      en: "The sky is full of stars."
    },
    theme: "nature",
    family: [],
    rare: false
  },

  /* ---------- feelings ---------- */
  {
    id: "zal",
    pl: "żal",
    en: "sorrow; regret, a soft ache for what is gone",
    respelling: "ZHAHL",
    example: {
      pl: "Został tylko żal.",
      en: "Only sorrow was left."
    },
    theme: "feelings",
    family: [],
    rare: true
  },
  {
    id: "tesknota",
    pl: "tęsknota",
    en: "longing; the ache of missing someone or somewhere far away",
    respelling: "tensk-NOH-tah",
    example: {
      pl: "Tęsknota wraca wieczorem.",
      en: "The longing returns in the evening."
    },
    theme: "feelings",
    family: [],
    rare: true
  },
  {
    id: "radosc",
    pl: "radość",
    en: "joy",
    respelling: "RAH-doshch",
    example: {
      pl: "Gitara daje radość.",
      en: "The guitar gives joy."
    },
    theme: "feelings",
    family: [],
    rare: false
  },
  {
    id: "spokoj",
    pl: "spokój",
    en: "peace; calm",
    respelling: "SPOH-kooy",
    example: {
      pl: "W domu panuje spokój.",
      en: "Peace reigns in the house."
    },
    theme: "feelings",
    family: [],
    rare: false
  },
  {
    id: "milosc",
    pl: "miłość",
    en: "love",
    respelling: "MEE-woshch",
    example: {
      pl: "Miłość jest jak ogień.",
      en: "Love is like fire."
    },
    theme: "feelings",
    family: [],
    rare: false
  },

  /* ---------- people ---------- */
  {
    id: "babcia",
    pl: "babcia",
    en: "grandma",
    respelling: "BAHP-chah",
    example: {
      pl: "Babcia piecze chleb.",
      en: "Grandma is baking bread."
    },
    theme: "people",
    family: [],
    rare: false
  },
  {
    id: "tata",
    pl: "tata",
    en: "dad",
    respelling: "TAH-tah",
    example: {
      pl: "Tata rozpala ognisko.",
      en: "Dad is lighting the campfire."
    },
    theme: "people",
    family: [],
    rare: false
  },
  {
    id: "dziecko",
    pl: "dziecko",
    en: "child",
    respelling: "JETS-koh",
    example: {
      pl: "Dziecko patrzy na gwiazdy.",
      en: "The child looks at the stars."
    },
    theme: "people",
    family: [],
    rare: false
  },
  {
    id: "przyjaciel",
    pl: "przyjaciel",
    en: "close friend (male)",
    respelling: "pshih-YAH-chel",
    example: {
      pl: "To mój przyjaciel.",
      en: "This is my friend."
    },
    theme: "people",
    family: [],
    rare: false
  },
  {
    id: "dobranoc",
    pl: "dobranoc",
    en: "good night",
    respelling: "doh-BRAH-nots",
    example: {
      pl: "Dobranoc, śpij dobrze.",
      en: "Good night, sleep well."
    },
    theme: "people",
    family: ["noc"],
    rare: false
  },

  /* ---------- small-words ---------- */
  {
    id: "tak",
    pl: "tak",
    en: "yes",
    respelling: "TAHK",
    example: {
      pl: "Tak, to piękna noc.",
      en: "Yes, it is a beautiful night."
    },
    theme: "small-words",
    family: ["nie"],
    rare: false
  },
  {
    id: "nie",
    pl: "nie",
    en: "no; not",
    respelling: "NYEH",
    example: {
      pl: "Przy ogniu nie jest zimno.",
      en: "It is not cold by the fire."
    },
    theme: "small-words",
    family: ["tak"],
    rare: false
  },
  {
    id: "dziekuje",
    pl: "dziękuję",
    en: "thank you",
    respelling: "jen-KOO-yeh",
    example: {
      pl: "Dziękuję za herbatę.",
      en: "Thank you for the tea."
    },
    theme: "small-words",
    family: ["prosze"],
    rare: false
  },
  {
    id: "prosze",
    pl: "proszę",
    en: "please; you're welcome",
    respelling: "PROH-sheh",
    example: {
      pl: "Proszę, usiądź obok mnie.",
      en: "Please, sit next to me."
    },
    theme: "small-words",
    family: ["dziekuje"],
    rare: false
  },
  {
    id: "tu",
    pl: "tu",
    en: "here",
    respelling: "TOO",
    example: {
      pl: "Zostań tu ze mną.",
      en: "Stay here with me."
    },
    theme: "small-words",
    family: [],
    rare: false
  }
];
