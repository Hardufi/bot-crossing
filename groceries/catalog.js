// Common fruit, vegetables and meat, with a rough shelf life for each.
// `days` is how long the item usually keeps where it is normally stored, counted from the day
// it came home. These are starting estimates only: the app adjusts them from your own answers.
// `unit` is how it is usually priced: by the kilo, or per unit (a box, a bunch, a pack).
// Items without an emoji get a coloured letter tile instead, so a missing emoji never shows a
// wrong fruit.

export const STORAGE = {
  fridge: 'מקרר',
  counter: 'מחוץ למקרר',
  freezer: 'מקפיא',
}

export const FREEZER_DAYS = 90

export const KINDS = { fruit: 'פירות', veg: 'ירקות', meat: 'בשר ודגים' }

// Meat as an Israeli supermarket shelves it. No pork: most kitchens here do not keep it.
export const MEAT_CATS = {
  chicken: 'עוף',
  turkey: 'הודו',
  beef: 'בקר',
  lamb: 'כבש',
  fish: 'דגים',
  processed: 'נקניקים ומעושנים',
}

export const UNITS = { kg: 'לק״ג', unit: 'ליחידה' }

const fruit = (key, name, emoji, days, storage, extra = {}) => ({ key, name, emoji, days, storage, kind: 'fruit', unit: 'kg', ...extra })
const veg = (key, name, emoji, days, storage, extra = {}) => ({ key, name, emoji, days, storage, kind: 'veg', unit: 'kg', ...extra })
// Raw meat keeps a day or two in the fridge; most of it is frozen if it is not cooked soon.
const meat = (cat, key, name, emoji, days, extra = {}) => ({ key, name, emoji, days, storage: 'fridge', kind: 'meat', cat, unit: 'kg', ...extra })

export const CATALOG = [
  fruit('banana', 'בננה', '🍌', 5, 'counter', { aliases: ['בננות'] }),
  fruit('apple', 'תפוח', '🍎', 21, 'fridge', { aliases: ['תפוחים', 'תפוח עץ'] }),
  fruit('green-apple', 'תפוח ירוק', '🍏', 21, 'fridge', { aliases: ['גרני סמית'] }),
  fruit('pear', 'אגס', '🍐', 7, 'fridge', { aliases: ['אגסים'] }),
  fruit('orange', 'תפוז', '🍊', 14, 'fridge', { aliases: ['תפוזים'] }),
  fruit('clementine', 'קלמנטינה', '🍊', 10, 'counter', { aliases: ['קלמנטינות', 'מנדרינה', 'אור'] }),
  fruit('grapefruit', 'אשכולית', '🍊', 14, 'fridge', { aliases: ['אשכוליות'] }),
  fruit('lemon', 'לימון', '🍋', 21, 'fridge', { aliases: ['לימונים'] }),
  fruit('avocado', 'אבוקדו', '🥑', 4, 'counter'),
  fruit('grapes', 'ענבים', '🍇', 7, 'fridge', { aliases: ['ענב'] }),
  fruit('strawberry', 'תותים', '🍓', 3, 'fridge', { aliases: ['תות', 'תות שדה'], unit: 'unit' }),
  fruit('blueberry', 'אוכמניות', '🫐', 7, 'fridge', { unit: 'unit' }),
  fruit('cherry', 'דובדבנים', '🍒', 5, 'fridge', { aliases: ['דובדבן'] }),
  fruit('peach', 'אפרסק', '🍑', 4, 'counter', { aliases: ['אפרסקים'] }),
  fruit('nectarine', 'נקטרינה', '🍑', 4, 'counter', { aliases: ['נקטרינות'] }),
  fruit('plum', 'שזיף', null, 5, 'counter', { color: '#7a3b69', aliases: ['שזיפים'] }),
  fruit('apricot', 'משמש', null, 3, 'counter', { color: '#d9822b', aliases: ['משמשים'] }),
  fruit('mango', 'מנגו', '🥭', 5, 'counter'),
  fruit('pineapple', 'אננס', '🍍', 4, 'counter', { unit: 'unit' }),
  fruit('watermelon', 'אבטיח', '🍉', 7, 'counter'),
  fruit('melon', 'מלון', '🍈', 5, 'counter'),
  fruit('kiwi', 'קיווי', '🥝', 14, 'fridge'),
  fruit('pomegranate', 'רימון', null, 21, 'fridge', { color: '#b8323a', aliases: ['רימונים'] }),
  fruit('persimmon', 'אפרסמון', null, 5, 'counter', { color: '#d4691c' }),
  fruit('guava', 'גויאבה', null, 4, 'counter', { color: '#7f9f33', aliases: ['גויאבות'] }),
  fruit('fig', 'תאנים', null, 2, 'fridge', { color: '#6d4a7a', aliases: ['תאנה'] }),
  fruit('dates', 'תמרים', null, 30, 'fridge', { color: '#8a5a2b', aliases: ['תמר', 'מג׳הול'] }),
  fruit('lychee', 'ליצ׳י', null, 5, 'fridge', { color: '#c4455f' }),

  veg('tomato', 'עגבנייה', '🍅', 6, 'counter', { aliases: ['עגבניה', 'עגבניות'] }),
  veg('cherry-tomato', 'עגבניות שרי', '🍅', 7, 'counter', { aliases: ['שרי'], unit: 'unit' }),
  veg('cucumber', 'מלפפון', '🥒', 7, 'fridge', { aliases: ['מלפפונים'] }),
  veg('bell-pepper', 'פלפל', '🫑', 7, 'fridge', { aliases: ['פלפלים', 'גמבה'] }),
  veg('hot-pepper', 'פלפל חריף', '🌶️', 10, 'fridge', { aliases: ['צ׳ילי'] }),
  veg('carrot', 'גזר', '🥕', 21, 'fridge'),
  veg('lettuce', 'חסה', '🥬', 5, 'fridge', { unit: 'unit' }),
  veg('cabbage', 'כרוב', '🥬', 21, 'fridge'),
  veg('spinach', 'תרד', '🥬', 4, 'fridge'),
  veg('broccoli', 'ברוקולי', '🥦', 5, 'fridge'),
  veg('cauliflower', 'כרובית', null, 7, 'fridge', { color: '#a39463' }),
  veg('potato', 'תפוח אדמה', '🥔', 30, 'counter', { aliases: ['תפוחי אדמה', 'תפוא', 'תפו״א'] }),
  veg('sweet-potato', 'בטטה', '🍠', 21, 'counter', { aliases: ['בטטות'] }),
  veg('onion', 'בצל', '🧅', 30, 'counter', { aliases: ['בצלים', 'בצל סגול'] }),
  veg('green-onion', 'בצל ירוק', null, 5, 'fridge', { color: '#4f8f3a', unit: 'unit' }),
  veg('garlic', 'שום', '🧄', 60, 'counter'),
  veg('eggplant', 'חציל', '🍆', 6, 'fridge', { aliases: ['חצילים'] }),
  veg('zucchini', 'קישוא', null, 6, 'fridge', { color: '#4f7f34', aliases: ['קישואים'] }),
  veg('corn', 'תירס', '🌽', 3, 'fridge', { unit: 'unit' }),
  veg('mushrooms', 'פטריות', '🍄', 5, 'fridge', { aliases: ['פטריה', 'שמפיניון'], unit: 'unit' }),
  veg('beet', 'סלק', null, 21, 'fridge', { color: '#8e2b4f' }),
  veg('kohlrabi', 'קולרבי', null, 14, 'fridge', { color: '#6f9450' }),
  veg('radish', 'צנונית', null, 10, 'fridge', { color: '#c0395a', aliases: ['צנוניות'] }),
  veg('celery', 'סלרי', null, 14, 'fridge', { color: '#5f9944', unit: 'unit' }),
  veg('leek', 'כרישה', null, 10, 'fridge', { color: '#5c8a43' }),
  veg('pumpkin', 'דלעת', '🎃', 30, 'counter'),
  veg('ginger', 'ג׳ינג׳ר', '🫚', 21, 'fridge'),
  veg('peas', 'אפונה', '🫛', 4, 'fridge'),
  veg('parsley', 'פטרוזיליה', '🌿', 6, 'fridge', { unit: 'unit' }),
  veg('coriander', 'כוסברה', '🌿', 5, 'fridge', { aliases: ['כוזברה'], unit: 'unit' }),
  veg('dill', 'שמיר', '🌿', 5, 'fridge', { unit: 'unit' }),
  veg('mint', 'נענע', '🌿', 5, 'fridge', { aliases: ['נענה'], unit: 'unit' }),

  meat('chicken', 'chicken-breast', 'חזה עוף', '🍗', 2, { aliases: ['שניצל', 'חזה'] }),
  meat('chicken', 'chicken-thighs', 'פרגיות', '🍗', 2, { aliases: ['פרגית', 'ירכיים'] }),
  meat('chicken', 'drumsticks', 'שוקיים', '🍗', 2, { aliases: ['שוק', 'כרעיים'] }),
  meat('chicken', 'chicken-wings', 'כנפיים', '🍗', 2, { aliases: ['כנפי עוף'] }),
  meat('chicken', 'whole-chicken', 'עוף שלם', '🐔', 2, { aliases: ['עוף'] }),
  meat('chicken', 'chicken-liver', 'כבד עוף', null, 1, { color: '#7a2e2a', aliases: ['כבדים'] }),
  meat('turkey', 'turkey-breast', 'חזה הודו', '🦃', 2),
  meat('turkey', 'turkey-shawarma', 'שווארמה הודו', '🦃', 2, { aliases: ['שווארמה', 'פרגית הודו'] }),
  meat('turkey', 'ground-turkey', 'טחון הודו', '🦃', 1),
  meat('beef', 'ground-beef', 'בשר טחון', '🥩', 1, { aliases: ['טחון', 'טחון בקר'] }),
  meat('beef', 'entrecote', 'אנטריקוט', '🥩', 3, { aliases: ['סטייק', 'ריב איי'] }),
  meat('beef', 'sirloin', 'סינטה', '🥩', 3),
  meat('beef', 'beef-stew', 'בשר לבישול', '🥩', 3, { aliases: ['גולאש', 'צלי', 'שריר', 'כתף', 'בשר בקר'] }),
  meat('beef', 'asado', 'אסאדו', '🥩', 3, { aliases: ['שפונדרה'] }),
  meat('beef', 'burgers', 'המבורגרים', '🍔', 2, { aliases: ['המבורגר', 'קציצות'] }),
  meat('beef', 'kebab', 'קבב', null, 2, { color: '#8c3b24', aliases: ['קבבים'] }),
  meat('lamb', 'lamb-chops', 'צלעות כבש', '🍖', 3, { aliases: ['כבש', 'טלה'] }),
  meat('lamb', 'ground-lamb', 'טחון כבש', '🍖', 1),
  meat('fish', 'salmon', 'סלמון', '🐟', 2, { aliases: ['סלומון'] }),
  meat('fish', 'tilapia', 'אמנון', '🐟', 2, { aliases: ['מושט'] }),
  meat('fish', 'sea-bream', 'דניס', '🐟', 2),
  meat('fish', 'sea-bass', 'לברק', '🐟', 2),
  meat('fish', 'fish-fillet', 'פילה דג', '🐟', 2, { aliases: ['פילה', 'מוסר ים', 'בקלה'] }),
  meat('processed', 'hot-dogs', 'נקניקיות', '🌭', 7, { unit: 'unit' }),
  meat('processed', 'pastrami', 'פסטרמה', null, 5, { color: '#9a3f3a', unit: 'unit' }),
  meat('processed', 'salami', 'סלמי', null, 14, { color: '#8a2f3b', unit: 'unit' }),
]

const BY_KEY = new Map(CATALOG.map((p) => [p.key, p]))

export function byKey(key) {
  return key ? BY_KEY.get(key) ?? null : null
}

// The common items offered as one-tap buttons when the inventory is empty.
export const STAPLES = ['tomato', 'cucumber', 'banana', 'apple', 'bell-pepper', 'carrot', 'lettuce', 'avocado', 'onion', 'potato', 'chicken-breast', 'ground-beef']

// Fruit in season in Israel, month by month (1 = January). Approximate: local seasons shift by
// a few weeks from year to year, and most vegetables are grown all year.
export const SEASON = {
  1: ['clementine', 'orange', 'grapefruit', 'avocado', 'strawberry', 'kiwi', 'lemon'],
  2: ['strawberry', 'clementine', 'orange', 'grapefruit', 'avocado', 'lemon'],
  3: ['strawberry', 'orange', 'grapefruit', 'avocado'],
  4: ['strawberry', 'orange', 'grapefruit'],
  5: ['apricot', 'cherry', 'watermelon', 'melon', 'peach'],
  6: ['apricot', 'cherry', 'watermelon', 'melon', 'peach', 'nectarine', 'plum'],
  7: ['watermelon', 'melon', 'peach', 'nectarine', 'plum', 'grapes', 'mango', 'fig', 'lychee'],
  8: ['watermelon', 'melon', 'grapes', 'mango', 'fig', 'peach', 'plum', 'lychee'],
  9: ['grapes', 'mango', 'fig', 'pomegranate', 'guava', 'dates', 'apple', 'pear'],
  10: ['pomegranate', 'persimmon', 'guava', 'dates', 'apple', 'pear', 'mango'],
  11: ['persimmon', 'clementine', 'avocado', 'pomegranate', 'dates', 'kiwi', 'guava'],
  12: ['clementine', 'orange', 'persimmon', 'avocado', 'kiwi', 'strawberry', 'grapefruit'],
}

export function inSeason(month) {
  return (SEASON[month] ?? []).map(byKey).filter(Boolean)
}

// Hebrew is matched without geresh, gershayim, quotes or spaces, so "גינגר" finds "ג׳ינג׳ר"
// and "תפוא" finds "תפו״א".
export function normalizeName(text) {
  return String(text ?? '').replace(/["'׳״\s-]/g, '').trim()
}

export function searchCatalog(query, kind = 'all', cat = 'all') {
  const q = normalizeName(query)
  const pool = CATALOG.filter((p) => (kind === 'all' || p.kind === kind) && (cat === 'all' || p.cat === cat))
  if (!q) return pool
  const scored = []
  for (const p of pool) {
    const names = [p.name, ...(p.aliases ?? [])].map(normalizeName)
    if (names.some((n) => n === q)) scored.push([0, p])
    else if (names.some((n) => n.startsWith(q))) scored.push([1, p])
    else if (names.some((n) => n.includes(q))) scored.push([2, p])
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, p]) => p)
}

// The catalog entry whose name (or alias) is exactly this text, if any.
export function findByName(text) {
  const q = normalizeName(text)
  if (!q) return null
  return CATALOG.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => normalizeName(n) === q)) ?? null
}

// Chains and places most Israeli households buy from, offered when the user names a store.
export const VENDOR_SUGGESTIONS = ['שופרסל', 'רמי לוי', 'ויקטורי', 'יוחננוף', 'אושר עד', 'מחסני השוק', 'קרפור', 'טיב טעם', 'השוק', 'הירקן', 'הקצב']
