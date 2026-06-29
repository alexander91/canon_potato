import { Card, Language } from './types'

/**
 * Built-in sample deck for STANDALONE DEV ONLY.
 *
 * When the game is opened directly (not inside the Translator iframe and no
 * `translator:init` arrives), App falls back to this deck so you can run and play
 * with `npm run dev`. In production the real deck comes from `GET /api/cards`.
 *
 * English ↔ Greek, mirroring the design sketch (σκύλος = dog).
 */
const SAMPLE: { en: string; foreign: string; translit: string; pos: string }[] = [
  { en: 'dog', foreign: 'σκύλος', translit: 'skílos', pos: 'noun' },
  { en: 'cat', foreign: 'γάτα', translit: 'gáta', pos: 'noun' },
  { en: 'house', foreign: 'σπίτι', translit: 'spíti', pos: 'noun' },
  { en: 'water', foreign: 'νερό', translit: 'neró', pos: 'noun' },
  { en: 'bread', foreign: 'ψωμί', translit: 'psomí', pos: 'noun' },
  { en: 'sun', foreign: 'ήλιος', translit: 'ílios', pos: 'noun' },
  { en: 'book', foreign: 'βιβλίο', translit: 'vivlío', pos: 'noun' },
  { en: 'tree', foreign: 'δέντρο', translit: 'déntro', pos: 'noun' },
  { en: 'fish', foreign: 'ψάρι', translit: 'psári', pos: 'noun' },
  { en: 'milk', foreign: 'γάλα', translit: 'gála', pos: 'noun' },
  { en: 'car', foreign: 'αυτοκίνητο', translit: 'aftokínito', pos: 'noun' },
  { en: 'door', foreign: 'πόρτα', translit: 'pórta', pos: 'noun' },
]

const EN: Language = 'en'
const GR: Language = 'gr'

export const DEV_CARDS: Card[] = SAMPLE.map((w, i) => ({
  id: `dev-${i}`,
  createdAt: 0,
  updatedAt: 0,
  languagePair: [EN, GR],
  translation: {
    id: `dev-${i}`,
    partOfSpeech: w.pos,
    englishWord: { id: `dev-en-${i}`, value: w.en, language: EN },
    foreignWord: { id: `dev-gr-${i}`, value: w.foreign, language: GR },
    transliteration: w.translit,
  },
  imageUrlSmall: '',
  imageUrlLarge: '',
  score: 0,
}))
