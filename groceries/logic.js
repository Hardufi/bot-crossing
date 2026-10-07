// Everything the app decides, with no DOM in it, so it can be tested on its own.
// Days are local calendar days written 'YYYY-MM-DD'; they compare correctly as strings.

import { byKey, normalizeName, FREEZER_DAYS, STORAGE, KINDS, MEAT_CATS, UNITS } from './catalog.js'

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
    // Where you shop: [{id, name}].
    vendors: [],
    // The latest price at each store: {productId: {vendorId: {amount, unit, on, prev}}}.
    prices: {},
    settings: { remindAt: '19:00', lastVendorId: null },
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
const MAX_PRICE = 100000
// Keys a pasted backup could use to reach Object.prototype through a plain object.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const count = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_DAYS) : null
}

// The fields every product-shaped record carries, from a catalog key or what was typed.
function cleanProduct(raw) {
  const name = text(raw.name, 60)
  if (!name) return null
  const known = typeof raw.key === 'string' ? byKey(raw.key) : null
  const kind = known?.kind ?? (Object.hasOwn(KINDS, raw.kind) ? raw.kind : 'veg')
  return {
    key: known ? raw.key : null,
    name,
    emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji.slice(0, 16) : null,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null,
    kind,
    cat: known?.cat ?? (kind === 'meat' && Object.hasOwn(MEAT_CATS, raw.cat) ? raw.cat : null),
    unit: Object.hasOwn(UNITS, raw.unit) ? raw.unit : (known?.unit ?? 'kg'),
  }
}

// A price as typed: "12.9", "12,90" or "₪ 12.90". Null when it is not a usable price.
export function parseAmount(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[₪\s]/g, '').replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PRICE) return null
  return Math.round(n * 100) / 100
}

const cleanUnit = (u) => (Object.hasOwn(UNITS, u) ? u : null)

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

  const vendors = []
  const vendorIds = new Set()
  for (const v of list(raw.vendors)) {
    const name = text(v.name, 30)
    if (!name || vendors.some((x) => normalizeName(x.name) === normalizeName(name))) continue
    const id = typeof v.id === 'string' && /^[a-z0-9]{1,40}$/i.test(v.id) && !vendorIds.has(v.id) ? v.id : uid() + vendors.length
    vendorIds.add(id)
    vendors.push({ id, name })
  }
  const vendorOf = (v) => (typeof v === 'string' && vendorIds.has(v) ? v : null)

  const items = []
  for (const i of list(raw.items)) {
    const p = cleanProduct(i)
    const shelfLife = count(i.shelfLife)
    if (!p || !shelfLife || !isDay(i.boughtOn) || !isDay(i.nextCheckOn)) continue
    const amount = parseAmount(i.price?.amount)
    const unit = cleanUnit(i.price?.unit)
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
      vendorId: vendorOf(i.vendorId),
      price: amount && unit ? { amount, unit } : null,
    }
    // Ask "how much was it?" once. Items from before prices existed are asked too, but only
    // while the purchase is recent (see needsPrice).
    item.priceAsked = i.priceAsked === true || i.sample === true || item.price !== null || item.vendorId !== null
    if (i.wasFrozen === true) item.wasFrozen = true
    if (i.sample === true) item.sample = true
    items.push(item)
  }

  const prices = {}
  if (raw.prices && typeof raw.prices === 'object') {
    for (const [pid, byVendor] of Object.entries(raw.prices)) {
      if (UNSAFE_KEYS.has(pid) || pid.length > 80 || !byVendor || typeof byVendor !== 'object') continue
      for (const [vid, r] of Object.entries(byVendor)) {
        const amount = parseAmount(r?.amount)
        const unit = cleanUnit(r?.unit)
        if (!vendorOf(vid) || !amount || !unit || !isDay(r.on)) continue
        const record = { amount, unit, on: r.on, prev: parseAmount(r.prev) }
        // A typed product keeps its name and kind with its prices, for when no item is left.
        if (pid.startsWith('name:')) {
          const p = cleanProduct({ name: r.name, kind: r.kind, cat: r.cat })
          if (p) Object.assign(record, { name: p.name, kind: p.kind, cat: p.cat })
        }
        ;(prices[pid] ??= {})[vid] = record
      }
    }
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
      if (n && pid.length <= 80 && !UNSAFE_KEYS.has(pid)) learned[pid] = n
    }
  }

  const remindAt = raw.settings?.remindAt
  return {
    ...base,
    items,
    shopping,
    history,
    learned,
    vendors,
    prices,
    settings: {
      remindAt: typeof remindAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(remindAt) ? remindAt : base.settings.remindAt,
      lastVendorId: vendorOf(raw.settings?.lastVendorId),
    },
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
    name: String(entry.name || known?.name || '').trim().slice(0, 60),
    emoji: entry.emoji ?? known?.emoji ?? null,
    color: entry.color ?? known?.color ?? null,
    kind: entry.kind ?? known?.kind ?? 'veg',
    cat: entry.cat ?? known?.cat ?? null,
    unit: entry.unit ?? known?.unit ?? 'kg',
    // Something typed rather than picked: raw meat keeps a couple of days, the rest about a week.
    days: entry.days ?? known?.days ?? ((entry.kind === 'meat' && entry.cat !== 'processed') ? 2 : 7),
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
    cat: p.cat,
    unit: p.unit,
    storage,
    qty: extra.qty ?? '',
    boughtOn,
    shelfLife,
    nextCheckOn: firstCheckOn(boughtOn, shelfLife),
    useSoon: false,
    lastCheckedOn: null,
    vendorId: null,
    price: null,
    priceAsked: Boolean(extra.sample),
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
    // A thaw is not a purchase: never ask what an old freezer item cost as today's shopping.
    if (daysBetween(prev.boughtOn, today) > PRICE_WINDOW) item.priceAsked = true
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
  const { key, name, emoji, color, kind, cat, unit } = item
  state.history.push({ id: uid(), type, key, name, emoji, color, kind, cat, unit, on: today, age })
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
  if (existing) {
    if (!entry.sample) delete existing.sample
    return { entry: existing, added: false }
  }
  const s = { id: uid(), key: p.key, name: p.name, emoji: p.emoji, color: p.color, kind: p.kind, cat: p.cat, unit: p.unit, note, addedOn: today, done: false }
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

// Everything ticked off on the shopping list goes into the inventory as bought today. It was
// really bought, so it is never a demo item, whatever put it on the list.
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

// ---- stores and prices -----------------------------------------------------------------------

export const PRICE_WINDOW = 3 // days after a purchase during which the app asks what it cost

export function vendorName(state, id) {
  return state.vendors.find((v) => v.id === id)?.name ?? null
}

// A store by name, created on first use. Names match the way products do: "רמי-לוי" is "רמי לוי".
export function addVendor(state, name) {
  const clean = String(name ?? '').trim().slice(0, 30)
  if (!clean) return null
  const existing = state.vendors.find((v) => normalizeName(v.name) === normalizeName(clean))
  if (existing) return existing
  const vendor = { id: uid(), name: clean }
  state.vendors.push(vendor)
  return vendor
}

// Forgets a store and the prices it had. Items bought there keep their own price.
export function removeVendor(state, id) {
  state.vendors = state.vendors.filter((v) => v.id !== id)
  if (state.settings.lastVendorId === id) state.settings.lastVendorId = null
  for (const [pid, byVendor] of Object.entries(state.prices)) {
    delete byVendor[id]
    if (!Object.keys(byVendor).length) delete state.prices[pid]
  }
  for (const item of state.items) if (item.vendorId === id) item.vendorId = null
}

// Whether to ask what this item cost: a real purchase from the last few days not yet asked about.
export function needsPrice(item, today) {
  return !item.priceAsked && !item.sample && daysBetween(item.boughtOn, today) <= PRICE_WINDOW && item.boughtOn <= today
}

// The most recent shopping day with something still to ask about, and what was bought then.
export function priceQuestion(state, today) {
  const open = state.items.filter((i) => needsPrice(i, today))
  if (!open.length) return null
  const on = open.reduce((a, i) => (i.boughtOn > a ? i.boughtOn : a), open[0].boughtOn)
  return { on, items: open.filter((i) => i.boughtOn === on) }
}

// Records where an item was bought and, if given, what it cost. The store's latest price for the
// product moves only for a purchase at least as recent as the one it holds.
export function recordPurchase(state, itemId, { vendorId = null, amount = null, unit = null } = {}) {
  const item = state.items.find((i) => i.id === itemId)
  if (!item) return null
  item.priceAsked = true
  if (vendorId && !state.vendors.some((v) => v.id === vendorId)) vendorId = null
  if (vendorId) item.vendorId = vendorId
  const value = parseAmount(amount)
  const u = cleanUnit(unit) ?? item.unit ?? 'kg'
  if (!value) return item
  item.price = { amount: value, unit: u }
  if (!item.vendorId) return item
  const byVendor = (state.prices[productId(item)] ??= {})
  const old = byVendor[item.vendorId]
  if (!old || item.boughtOn >= old.on) {
    const prev = old && old.unit === u ? (old.on === item.boughtOn ? old.prev : old.amount) : null
    const record = { amount: value, unit: u, on: item.boughtOn, prev }
    if (!item.key) Object.assign(record, { name: item.name, kind: item.kind, cat: item.cat ?? null })
    byVendor[item.vendorId] = record
  }
  return item
}

// Takes back what one purchase put in the price table, when that purchase is corrected: a
// different store, a different price or date, or no price after all. The store goes back to
// its previous price, or loses the entry if there was none.
export function withdrawPurchase(state, pid, { vendorId, amount, unit, on }) {
  const byVendor = state.prices[pid]
  const e = byVendor?.[vendorId]
  if (!e || e.on !== on || e.amount !== amount || e.unit !== unit) return
  if (e.prev != null) byVendor[vendorId] = { ...e, amount: e.prev, prev: null }
  else delete byVendor[vendorId]
  if (!Object.keys(byVendor).length) delete state.prices[pid]
}

// Marks items as asked without recording anything ("I don't remember").
export function skipPrices(state, ids) {
  for (const item of state.items) if (ids.includes(item.id)) item.priceAsked = true
}

// Every store's latest price for a product, cheapest first within each unit, the product's own
// unit first.
export function pricesFor(state, entry) {
  const p = product(entry)
  const byVendor = state.prices[productId(p)] ?? {}
  return Object.entries(byVendor)
    .map(([vendorId, r]) => ({ vendorId, vendor: vendorName(state, vendorId), ...r }))
    .filter((r) => r.vendor)
    .sort((a, b) => (a.unit === b.unit ? a.amount - b.amount : a.unit === p.unit ? -1 : b.unit === p.unit ? 1 : a.unit < b.unit ? -1 : 1))
}

// The cheapest known price for a product, compared only with prices in the same unit.
export function cheapest(state, entry) {
  const list = pricesFor(state, entry)
  if (!list.length) return null
  const unit = list[0].unit
  const same = list.filter((r) => r.unit === unit)
  // A tie is not a cheapest store.
  return { ...same[0], stores: same.length, tie: same.length > 1 && same[1].amount === same[0].amount }
}

// For a shopping list: the store that is cheapest for the most items, among items with prices
// from at least two stores.
export function bestStore(state, entries) {
  const wins = new Map()
  let compared = 0
  for (const e of entries) {
    const c = cheapest(state, e)
    if (!c || c.stores < 2 || c.tie) continue
    compared++
    wins.set(c.vendorId, (wins.get(c.vendorId) ?? 0) + 1)
  }
  if (!compared) return null
  const sorted = [...wins].sort((a, b) => b[1] - a[1])
  if (sorted[1] && sorted[1][1] === sorted[0][1]) return null // no single best store
  const [vendorId, count] = sorted[0]
  return { vendorId, vendor: vendorName(state, vendorId), wins: count, compared }
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

const shekel = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function money(amount) {
  return shekel.format(amount)
}

// "12.90 ₪ לק״ג"
export function priceText(amount, unit) {
  return `${money(amount)}${NB}${UNITS[unit] ?? ''}`.trim()
}

// "at <store>". The suggested places with an article read naturally only one way each; any
// other Hebrew name takes ב as it is (a leading ה may be part of the name: היפר כהן), and a
// name in another script takes ב־.
const AT_PLACE = { השוק: 'בשוק', הקצב: 'אצל הקצב', הירקן: 'אצל הירקן' }

export function atVendor(name) {
  if (Object.hasOwn(AT_PLACE, name)) return AT_PLACE[name]
  if (/^[\u05d0-\u05ea]/.test(name)) return 'ב' + name
  return 'ב־' + name
}
