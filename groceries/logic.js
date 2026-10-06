// Everything the app decides, with no DOM in it, so it can be tested on its own.
// Days are local calendar days written 'YYYY-MM-DD'; they compare correctly as strings.

import { byKey, normalizeName, FREEZER_DAYS } from './catalog.js'

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

// Accepts anything that came out of storage or a pasted backup and returns a usable state.
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const items = Array.isArray(raw.items)
    ? raw.items.filter((i) => i && typeof i.name === 'string' && isDay(i.boughtOn) && isDay(i.nextCheckOn) && Number(i.shelfLife) > 0)
    : []
  return {
    ...base,
    items: items.map((i) => ({ ...i, shelfLife: Math.round(Number(i.shelfLife)) })),
    shopping: Array.isArray(raw.shopping) ? raw.shopping.filter((s) => s && typeof s.name === 'string') : [],
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && isDay(h.on)).slice(-MAX_HISTORY) : [],
    learned: raw.learned && typeof raw.learned === 'object' ? { ...raw.learned } : {},
    settings: { ...base.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
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
  const before = item.boughtOn + '/' + item.shelfLife
  Object.assign(item, changes)
  item.shelfLife = Math.max(1, Math.round(Number(item.shelfLife) || 1))
  if (item.boughtOn > today) item.boughtOn = today
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
  if (outcome) remember(state, item, outcome, age, today)
  // Something that went off teaches the app how long it really keeps. Blend rather than
  // replace, because it was found at the check, not on the day it turned.
  if (outcome === 'spoiled' && item.storage !== 'freezer') {
    const pid = productId(item)
    const base = state.learned[pid] ?? item.shelfLife
    state.learned[pid] = Math.max(1, Math.round((base + age) / 2))
  }
  return item
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
        if (item.storage !== 'freezer') {
          const pid = productId(item)
          state.learned[pid] = Math.max(state.learned[pid] ?? 0, age + 1)
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
  return bought.map((s) => addItem(state, s, today))
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

// "ב" or "כ" joined to a count of days: ביום, ביומיים, ב־5 ימים.
function joined(prefix, n) {
  if (n === 1) return prefix + 'יום'
  if (n === 2) return prefix + 'יומיים'
  return `${prefix}־${n}${NB}ימים`
}

// "About n days": כיום, כיומיים, כ־5 ימים.
export function aboutDays(n) {
  return joined('כ', n)
}

export function statusText(item, today) {
  const { left, level } = freshness(item, today)
  if (level === 'over') return 'עבר את המשוער ' + joined('ב', -left)
  if (left === 0) return 'יום אחרון משוער'
  if (item.useSoon) return 'לאכול בקרוב'
  if (left <= 2) return 'עוד ' + (left === 1 ? 'יום' : 'יומיים')
  return 'עוד ' + joined('כ', left)
}
