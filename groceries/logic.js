// Everything the app decides, with no DOM in it, so it can be tested on its own.
// Days are local calendar days written 'YYYY-MM-DD'; they compare correctly as strings.

import { byKey, normalizeName, FREEZER_DAYS, STORAGE } from './catalog.js'

export const MAX_HISTORY = 400
export const MAX_CHECK_GAP = 14

const DAY_MS = 86_400_000
const pad = (n) => String(n).padStart(2, '0')

export function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Calendar arithmetic runs in UTC so a daylight-saving change never turns a day into 23 hours.
function utc(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDays(iso, n) {
  const t = new Date(utc(iso) + n * DAY_MS)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function daysBetween(from, to) {
  return Math.round((utc(to) - utc(from)) / DAY_MS)
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function emptyState() {
  return {
    v: 1,
    items: [],
    shopping: [],
    history: [],
    // Shelf life you have taught the app, in days, by catalog key or item name.
    learned: {},
    settings: { remindAt: '19:00' },
    updatedAt: 0,
  }
}

// A real calendar day: '2026-02-30' has the right shape but is not one.
export function isDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s
}

// Whether pasted text is plausibly a backup, before it is allowed to replace everything.
export function looksLikeBackup(raw) {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.items)
}

const MAX_DAYS = 3650
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const count = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_DAYS) : null
}

// The fields every product-shaped record carries, from a catalog key or what was typed.
function cleanProduct(raw) {
  const name = text(raw.name, 60)
  if (!name) return null
  return {
    key: typeof raw.key === 'string' && byKey(raw.key) ? raw.key : null,
    name,
    emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji.slice(0, 16) : null,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null,
    kind: raw.kind === 'fruit' ? 'fruit' : 'veg',
  }
}

// Accepts anything that came out of storage, another device or a pasted backup, and returns a
// state the app can render safely: every field the right type, every id unique and plain.
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const ids = new Set()
  const cleanId = (v) => {
    const id = typeof v === 'string' && /^[a-z0-9]{1,40}$/i.test(v) && !ids.has(v) ? v : uid() + ids.size
    ids.add(id)
    return id
  }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])

  const items = []
  for (const i of list(raw.items)) {
    const p = cleanProduct(i)
    const shelfLife = count(i.shelfLife)
    if (!p || !shelfLife || !isDay(i.boughtOn) || !isDay(i.nextCheckOn)) continue
    const item = {
      id: cleanId(i.id),
      ...p,
      storage: Object.hasOwn(STORAGE, i.storage) ? i.storage : 'fridge',
      qty: text(i.qty, 24),
      boughtOn: i.boughtOn,
      shelfLife,
      nextCheckOn: i.nextCheckOn,
      useSoon: i.useSoon === true,
      lastCheckedOn: isDay(i.lastCheckedOn) ? i.lastCheckedOn : null,
    }
    if (i.wasFrozen === true) item.wasFrozen = true
    if (i.sample === true) item.sample = true
    items.push(item)
  }

  const shopping = []
  for (const s of list(raw.shopping)) {
    const p = cleanProduct(s)
    if (!p) continue
    const entry = { id: cleanId(s.id), ...p, note: text(s.note, 60), addedOn: isDay(s.addedOn) ? s.addedOn : null, done: s.done === true }
    if (s.sample === true) entry.sample = true
    shopping.push(entry)
  }

  const history = []
  for (const h of list(raw.history).slice(-MAX_HISTORY)) {
    const p = cleanProduct(h)
    if (!p || !isDay(h.on) || (h.type !== 'eaten' && h.type !== 'spoiled')) continue
    const age = Math.round(Number(h.age))
    history.push({ id: cleanId(h.id), type: h.type, ...p, on: h.on, age: Number.isFinite(age) && age >= 0 ? age : 0 })
  }

  const learned = {}
  if (raw.learned && typeof raw.learned === 'object') {
    for (const [pid, days] of Object.entries(raw.learned)) {
      const n = count(days)
      if (n && pid.length <= 80) learned[pid] = n
    }
  }

  const remindAt = raw.settings?.remindAt
  return {
    ...base,
    items,
    shopping,
    history,
    learned,
    settings: { remindAt: typeof remindAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(remindAt) ? remindAt : base.settings.remindAt },
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

// What the app remembers about a product: one key per catalog item, or the typed name.
export function productId(p) {
  return p.key || 'name:' + normalizeName(p.name)
}

export function sameProduct(a, b) {
  return productId(a) === productId(b)
}

// A product as typed or picked, filled in with catalog defaults.
export function product(entry) {
  const known = byKey(entry.key) ?? null
  return {
    key: known?.key ?? null,
    name: entry.name || known?.name || '',
    emoji: entry.emoji ?? known?.emoji ?? null,
    color: entry.color ?? known?.color ?? null,
    kind: entry.kind ?? known?.kind ?? 'veg',
    days: entry.days ?? known?.days ?? 7,
    storage: entry.storage ?? known?.storage ?? 'fridge',
  }
}

export function estimateDays(state, entry, storage) {
  const p = product(entry)
  if ((storage ?? p.storage) === 'freezer') return FREEZER_DAYS
  return state.learned[productId(p)] ?? p.days
}

// Only a fresh, real item says anything about how long this product keeps in the kitchen.
// Freezer time, time in the freezer before a thaw, and the demo inventory teach nothing.
function teaches(item) {
  return item.storage !== 'freezer' && !item.wasFrozen && !item.sample
}

// The first question comes halfway through the expected life, never on the day of purchase.
export function firstCheckOn(boughtOn, shelfLife) {
  return addDays(boughtOn, Math.max(1, Math.floor(shelfLife / 2)))
}

export function freshness(item, today) {
  const age = Math.max(0, daysBetween(item.boughtOn, today))
  const left = item.shelfLife - age
  const soonAt = Math.max(1, Math.round(item.shelfLife * 0.25))
  const level = left < 0 ? 'over' : item.useSoon || left <= soonAt ? 'soon' : 'fresh'
  return { age, left, level }
}

export function isDue(item, today) {
  return item.nextCheckOn <= today
}

export function byUrgency(today) {
  return (a, b) => freshness(a, today).left - freshness(b, today).left || a.name.localeCompare(b.name, 'he')
}

export function dueItems(state, today) {
  return state.items.filter((i) => isDue(i, today)).sort(byUrgency(today))
}

// After "still good": ask again halfway to the expected end, and daily once it is close.
export function nextCheckAfterFresh(item, today) {
  const { left } = freshness(item, today)
  if (item.useSoon || left <= 2) return addDays(today, 1)
  return addDays(today, Math.min(MAX_CHECK_GAP, Math.max(1, Math.floor(left / 2))))
}

export function addItem(state, entry, today, extra = {}) {
  const p = product(entry)
  const storage = extra.storage ?? p.storage
  const shelfLife = Math.max(1, Math.round(extra.shelfLife ?? estimateDays(state, p, storage)))
  const boughtOn = extra.boughtOn ?? today
  const item = {
    id: uid(),
    key: p.key,
    name: p.name,
    emoji: p.emoji,
    color: p.color,
    kind: p.kind,
    storage,
    qty: extra.qty ?? '',
    boughtOn,
    shelfLife,
    nextCheckOn: firstCheckOn(boughtOn, shelfLife),
    useSoon: false,
    lastCheckedOn: null,
  }
  if (extra.sample) item.sample = true
  state.items.push(item)
  return item
}

// Apply edits from the item sheet, and move the next question if the dates changed.
export function editItem(state, id, changes, today) {
  const item = state.items.find((i) => i.id === id)
  if (!item) return null
  const prev = { storage: item.storage, boughtOn: item.boughtOn, shelfLife: item.shelfLife }
  const before = item.boughtOn + '/' + item.shelfLife
  if (typeof changes.name === 'string' && changes.name.trim()) item.name = changes.name.trim().slice(0, 60)
  if (typeof changes.qty === 'string') item.qty = changes.qty.trim().slice(0, 24)
  if (Object.hasOwn(STORAGE, changes.storage)) item.storage = changes.storage
  if (isDay(changes.boughtOn)) item.boughtOn = changes.boughtOn
  if (changes.shelfLife !== undefined) item.shelfLife = count(changes.shelfLife) ?? 1
  if (item.boughtOn > today) item.boughtOn = today

  // Out of the freezer, the kitchen clock starts again from today.
  const thawed = prev.storage === 'freezer' && item.storage !== 'freezer'
  if (thawed) {
    item.wasFrozen = true
    if (item.boughtOn === prev.boughtOn) item.boughtOn = today
    if (item.shelfLife === prev.shelfLife) item.shelfLife = estimateDays(state, item, item.storage)
  }
  // "Eat soon" belonged to the old batch or the old place.
  if (item.boughtOn !== prev.boughtOn || (item.storage === 'freezer' && prev.storage !== 'freezer')) item.useSoon = false

  if (item.boughtOn + '/' + item.shelfLife !== before) {
    const earliest = item.lastCheckedOn ? addDays(item.lastCheckedOn, 1) : item.boughtOn
    const first = firstCheckOn(item.boughtOn, item.shelfLife)
    item.nextCheckOn = first > earliest ? first : earliest
  }
  return item
}

function remember(state, item, type, age, today) {
  const { key, name, emoji, color, kind } = item
  state.history.push({ id: uid(), type, key, name, emoji, color, kind, on: today, age })
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY)
}

// Takes an item out of the inventory. `outcome` is 'eaten', 'spoiled', or null for a mistake.
export function removeItem(state, id, outcome, today) {
  const index = state.items.findIndex((i) => i.id === id)
  if (index < 0) return null
  const [item] = state.items.splice(index, 1)
  const { age } = freshness(item, today)
  if (outcome && !item.sample) remember(state, item, outcome, age, today)
  // Something that went off sooner than expected shortens the estimate. Blend rather than
  // replace, because it was found at the check, not on the day it turned. Finding it spoiled
  // after the estimate says nothing new, so it never lengthens it.
  if (outcome === 'spoiled' && teaches(item)) {
    const pid = productId(item)
    const base = state.learned[pid] ?? product(item).days
    if (age < base) state.learned[pid] = Math.max(1, Math.round((base + age) / 2))
  }
  return item
}

// Removes the demo inventory and anything it put on the shopping list.
export function clearSample(state) {
  state.items = state.items.filter((i) => !i.sample)
  state.shopping = state.shopping.filter((s) => !s.sample)
}

// The answer to "still good?". kind: fresh | soon | later | eaten | spoiled.
export function answer(state, id, kind, today) {
  const item = state.items.find((i) => i.id === id)
  if (!item) return null
  const { age, left } = freshness(item, today)
  item.lastCheckedOn = today
  switch (kind) {
    case 'fresh':
      // Still good past the estimate: it keeps longer than we thought, here and next time.
      if (left <= 0) {
        item.shelfLife = age + 1
        if (teaches(item)) {
          const pid = productId(item)
          state.learned[pid] = Math.max(state.learned[pid] ?? product(item).days, age + 1)
        }
      }
      item.nextCheckOn = nextCheckAfterFresh(item, today)
      return { item, kind }
    case 'soon':
      item.useSoon = true
      item.nextCheckOn = addDays(today, 1)
      return { item, kind }
    case 'later':
      item.nextCheckOn = addDays(today, 1)
      return { item, kind }
    case 'eaten':
    case 'spoiled':
      removeItem(state, id, kind, today)
      return { item, kind, age }
    default:
      throw new Error('unknown answer: ' + kind)
  }
}

export function addToShopping(state, entry, today, note = '') {
  const p = product(entry)
  const existing = state.shopping.find((s) => !s.done && sameProduct(s, p))
  if (existing) return { entry: existing, added: false }
  const s = { id: uid(), key: p.key, name: p.name, emoji: p.emoji, color: p.color, kind: p.kind, note, addedOn: today, done: false }
  if (entry.sample) s.sample = true
  state.shopping.push(s)
  return { entry: s, added: true }
}

export function toggleShopping(state, id) {
  const s = state.shopping.find((x) => x.id === id)
  if (s) s.done = !s.done
  return s
}

export function removeShopping(state, id) {
  state.shopping = state.shopping.filter((s) => s.id !== id)
}

// Everything ticked off on the shopping list goes into the inventory as bought today.
export function checkout(state, today) {
  const bought = state.shopping.filter((s) => s.done)
  state.shopping = state.shopping.filter((s) => !s.done)
  return bought.map((s) => addItem(state, s, today, { sample: s.sample }))
}

export function stats(state, today, days = 30) {
  const since = addDays(today, -days)
  const recent = state.history.filter((h) => h.on > since)
  const eaten = recent.filter((h) => h.type === 'eaten').length
  const spoiled = recent.filter((h) => h.type === 'spoiled').length
  const counts = new Map()
  for (const h of recent) {
    if (h.type !== 'spoiled') continue
    const pid = productId(h)
    const c = counts.get(pid) ?? { ...h, count: 0 }
    c.count++
    counts.set(pid, c)
  }
  const topSpoiled = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3)
  return { eaten, spoiled, wasteRate: eaten + spoiled ? spoiled / (eaten + spoiled) : 0, topSpoiled }
}

export function spoiledCount(state, entry, today, days = 30) {
  const since = addDays(today, -days)
  return state.history.filter((h) => h.type === 'spoiled' && h.on > since && sameProduct(h, entry)).length
}

// Things that ran out lately and are neither at home nor on the list yet: the likeliest
// things to buy again.
export function recentlyFinished(state, today, days = 14, limit = 8) {
  const since = addDays(today, -days)
  const seen = new Set([...state.items, ...state.shopping].map(productId))
  const out = []
  for (let i = state.history.length - 1; i >= 0 && out.length < limit; i--) {
    const h = state.history[i]
    if (h.on <= since) break
    const pid = productId(h)
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(h)
  }
  return out
}

// ---- Hebrew wording -------------------------------------------------------------------------

// Counts are joined to their noun with a no-break space so "4 ימים" never splits across lines.
const NB = '\u00a0'

export function daysText(n) {
  if (n === 1) return `יום${NB}אחד`
  if (n === 2) return 'יומיים'
  return `${n}${NB}ימים`
}

// How long an item has been at home, without a verb so it reads right for any noun's gender.
export function atHomeText(age) {
  if (age <= 0) return 'בבית מהיום'
  if (age === 1) return 'בבית מאתמול'
  return `בבית כבר ${daysText(age)}`
}

export function inDaysText(n) {
  if (n <= 0) return 'היום'
  if (n === 1) return 'מחר'
  return `בעוד ${daysText(n)}`
}

// A one-letter prefix joined to a count of days. The maqaf goes only before a numeral:
// כיום אחד, ליומיים, כ־5 ימים.
function prefixed(prefix, n) {
  if (n === 1) return `${prefix}יום${NB}אחד`
  if (n === 2) return prefix + 'יומיים'
  return `${prefix}־${n}${NB}ימים`
}

// "About n days".
export function aboutDays(n) {
  return prefixed('כ', n)
}

// "To n days", as in "updated to".
export function toDays(n) {
  return prefixed('ל', n)
}

export function statusText(item, today) {
  const { left, level } = freshness(item, today)
  if (level === 'over') return `${daysText(-left)} אחרי המשוער`
  if (left === 0) return 'יום אחרון משוער'
  if (item.useSoon) return 'לאכול בקרוב'
  if (left <= 2) return 'עוד ' + (left === 1 ? 'יום' : 'יומיים')
  return 'עוד ' + aboutDays(left)
}
