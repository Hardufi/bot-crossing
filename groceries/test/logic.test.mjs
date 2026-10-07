import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../logic.js'
import { byKey, searchCatalog, findByName, inSeason, CATALOG, STAPLES, SEASON, MEAT_CATS, UNITS, VENDOR_SUGGESTIONS } from '../catalog.js'

const T = '2026-10-06'

function stateWith(...entries) {
  const s = L.emptyState()
  for (const [key, ago = 0] of entries) L.addItem(s, byKey(key), T, { boughtOn: L.addDays(T, -ago) })
  return s
}

test('calendar arithmetic ignores daylight saving and month ends', () => {
  assert.equal(L.addDays('2026-03-26', 2), '2026-03-28') // Israel springs forward on 27 March
  assert.equal(L.addDays('2026-10-24', 3), '2026-10-27') // and falls back on 25 October
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(L.daysBetween('2026-03-26', '2026-03-30'), 4)
  assert.equal(L.daysBetween(T, '2026-10-01'), -5)
  assert.equal(L.isoDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('a new item is first asked about halfway through its expected life', () => {
  const s = stateWith(['banana'], ['apple'], ['strawberry'], ['fig'])
  const [banana, apple, strawberry, fig] = s.items
  assert.equal(banana.shelfLife, 5)
  assert.equal(banana.nextCheckOn, L.addDays(T, 2))
  assert.equal(apple.nextCheckOn, L.addDays(T, 10))
  assert.equal(strawberry.nextCheckOn, L.addDays(T, 1))
  assert.equal(fig.nextCheckOn, L.addDays(T, 1), 'never asks on the day of purchase')
  assert.equal(L.dueItems(s, T).length, 0)
})

test('items bought days ago are due, most urgent first', () => {
  const s = stateWith(['apple', 12], ['banana', 4], ['avocado', 2], ['carrot', 1])
  const due = L.dueItems(s, T).map((i) => i.key)
  assert.deepEqual(due, ['banana', 'avocado', 'apple'])
})

test('freshness levels', () => {
  const [item] = stateWith(['banana', 0]).items
  assert.equal(L.freshness(item, T).level, 'fresh')
  assert.equal(L.freshness(item, L.addDays(T, 3)).level, 'fresh')
  assert.equal(L.freshness(item, L.addDays(T, 4)).level, 'soon') // one day left of five
  assert.equal(L.freshness(item, L.addDays(T, 5)).level, 'soon') // last expected day
  assert.equal(L.freshness(item, L.addDays(T, 6)).level, 'over')
  assert.equal(L.freshness({ ...item, useSoon: true }, T).level, 'soon')
})

test('"still good" asks again halfway to the expected end, then daily near it', () => {
  const s = stateWith(['carrot', 4])
  const id = s.items[0].id
  L.answer(s, id, 'fresh', T) // 17 days left
  assert.equal(s.items[0].nextCheckOn, L.addDays(T, 8))
  L.answer(s, id, 'fresh', L.addDays(T, 15)) // 2 days left
  assert.equal(s.items[0].nextCheckOn, L.addDays(T, 16))
  assert.equal(s.items[0].lastCheckedOn, L.addDays(T, 15))
})

test('the gap between questions is capped', () => {
  const s = L.emptyState()
  L.addItem(s, byKey('carrot'), T, { storage: 'freezer' })
  assert.equal(s.items[0].shelfLife, 90)
  L.answer(s, s.items[0].id, 'fresh', L.addDays(T, 45))
  assert.equal(s.items[0].nextCheckOn, L.addDays(T, 45 + L.MAX_CHECK_GAP))
})

test('"eat soon" and "later" both ask again tomorrow', () => {
  const s = stateWith(['tomato', 3], ['cucumber', 3])
  const [tomato, cucumber] = s.items
  L.answer(s, tomato.id, 'soon', T)
  L.answer(s, cucumber.id, 'later', T)
  assert.equal(tomato.useSoon, true)
  assert.equal(tomato.nextCheckOn, L.addDays(T, 1))
  assert.equal(cucumber.useSoon, false)
  assert.equal(cucumber.nextCheckOn, L.addDays(T, 1))
  // Once marked to eat soon, "still good" keeps asking daily.
  L.answer(s, tomato.id, 'fresh', L.addDays(T, 1))
  assert.equal(tomato.nextCheckOn, L.addDays(T, 2))
})

test('still good past the estimate stretches this item and the estimate for next time', () => {
  const s = stateWith(['banana', 7])
  const item = s.items[0]
  L.answer(s, item.id, 'fresh', T)
  assert.equal(item.shelfLife, 8)
  assert.equal(item.nextCheckOn, L.addDays(T, 1))
  assert.equal(s.learned.banana, 8)
  const next = L.addItem(s, byKey('banana'), T)
  assert.equal(next.shelfLife, 8)
})

test('"eaten" and "spoiled" leave the inventory and are remembered', () => {
  const s = stateWith(['banana', 2], ['strawberry', 2])
  const [banana, strawberry] = s.items
  const r1 = L.answer(s, banana.id, 'eaten', T)
  const r2 = L.answer(s, strawberry.id, 'spoiled', T)
  assert.equal(r1.age, 2)
  assert.equal(r2.item.name, 'תותים')
  assert.equal(s.items.length, 0)
  assert.deepEqual(
    s.history.map((h) => [h.key, h.type, h.on, h.age]),
    [
      ['banana', 'eaten', T, 2],
      ['strawberry', 'spoiled', T, 2],
    ],
  )
  assert.equal(s.learned.banana, undefined, 'eating teaches nothing about shelf life')
})

test('spoiling early pulls the estimate down, blended rather than replaced', () => {
  const s = stateWith(['lettuce', 1]) // estimate 5
  L.answer(s, s.items[0].id, 'spoiled', T)
  assert.equal(s.learned.lettuce, 3) // (5 + 1) / 2
  const again = L.addItem(s, byKey('lettuce'), T)
  assert.equal(again.shelfLife, 3)
  assert.equal(again.nextCheckOn, L.addDays(T, 1))
})

test('the freezer never teaches the fridge estimate', () => {
  const s = L.emptyState()
  L.addItem(s, byKey('strawberry'), T, { storage: 'freezer', boughtOn: L.addDays(T, -100) })
  L.answer(s, s.items[0].id, 'fresh', T)
  assert.equal(s.learned.strawberry, undefined)
  L.addItem(s, byKey('strawberry'), T, { storage: 'freezer', boughtOn: L.addDays(T, -2) })
  L.answer(s, s.items[1].id, 'spoiled', T)
  assert.equal(s.learned.strawberry, undefined)
  assert.equal(L.estimateDays(s, byKey('strawberry')), 3)
})

test('custom items are remembered by name', () => {
  const s = L.emptyState()
  const item = L.addItem(s, { name: 'פיטאיה', kind: 'fruit' }, T, { boughtOn: L.addDays(T, -2) })
  assert.equal(item.shelfLife, 7)
  assert.equal(item.key, null)
  L.answer(s, item.id, 'spoiled', T)
  assert.equal(s.learned['name:פיטאיה'], 5)
  assert.equal(L.addItem(s, { name: 'פיטאיה' }, T).shelfLife, 5)
})

test('editing the purchase date or shelf life moves the next question', () => {
  const s = stateWith(['apple', 0])
  const item = s.items[0]
  L.editItem(s, item.id, { boughtOn: L.addDays(T, -15) }, T)
  assert.equal(item.nextCheckOn, L.addDays(T, -5))
  assert.ok(L.isDue(item, T))
  L.editItem(s, item.id, { qty: '4' }, T)
  assert.equal(item.nextCheckOn, L.addDays(T, -5), 'other edits leave it alone')
  L.editItem(s, item.id, { boughtOn: '2099-01-01' }, T)
  assert.equal(item.boughtOn, T, 'a purchase date cannot be in the future')
})

test('shopping list: no duplicates, checkout moves ticked items home', () => {
  const s = L.emptyState()
  assert.equal(L.addToShopping(s, byKey('banana'), T).added, true)
  assert.equal(L.addToShopping(s, { name: 'בננה', key: 'banana' }, T).added, false)
  L.addToShopping(s, { name: 'פיטאיה' }, T)
  L.addToShopping(s, byKey('lemon'), T)
  const [banana, , lemon] = s.shopping
  L.toggleShopping(s, banana.id)
  L.toggleShopping(s, lemon.id)
  const moved = L.checkout(s, T)
  assert.deepEqual(moved.map((i) => i.key), ['banana', 'lemon'])
  assert.deepEqual(s.shopping.map((x) => x.name), ['פיטאיה'])
  assert.equal(s.items.length, 2)
  assert.equal(s.items[0].boughtOn, T)
  assert.equal(s.items[1].storage, 'fridge')
})

test('stats and suggestions come from the last weeks of history', () => {
  const s = stateWith(['banana', 2], ['strawberry', 2], ['lettuce', 1], ['apple', 3])
  const [banana, strawberry, lettuce] = s.items
  L.answer(s, banana.id, 'eaten', T)
  L.answer(s, strawberry.id, 'spoiled', T)
  L.answer(s, lettuce.id, 'spoiled', L.addDays(T, -40)) // too old to count
  L.addItem(s, byKey('strawberry'), T, { boughtOn: L.addDays(T, -3) })
  L.answer(s, s.items.at(-1).id, 'spoiled', T)

  const st = L.stats(s, T)
  assert.equal(st.eaten, 1)
  assert.equal(st.spoiled, 2)
  assert.equal(Math.round(st.wasteRate * 100), 67)
  assert.deepEqual(st.topSpoiled.map((t) => [t.key, t.count]), [['strawberry', 2]])
  assert.equal(L.spoiledCount(s, byKey('strawberry'), T), 2)

  L.addToShopping(s, byKey('banana'), T)
  assert.deepEqual(L.recentlyFinished(s, T).map((h) => h.key), ['strawberry'], 'banana is already on the list, lettuce is too old')
})

test('history is capped', () => {
  const s = L.emptyState()
  for (let i = 0; i < L.MAX_HISTORY + 20; i++) {
    const item = L.addItem(s, byKey('banana'), T)
    L.removeItem(s, item.id, 'eaten', T)
  }
  assert.equal(s.history.length, L.MAX_HISTORY)
})

test('normalizeState repairs whatever storage or a backup hands it', () => {
  assert.deepEqual(L.normalizeState(null), L.emptyState())
  assert.deepEqual(L.normalizeState('nonsense'), L.emptyState())
  const s = L.normalizeState({
    items: [
      { name: 'בננה', boughtOn: T, nextCheckOn: T, shelfLife: '5' },
      { name: 'broken', boughtOn: 'yesterday', nextCheckOn: T, shelfLife: 5 },
      null,
    ],
    shopping: 'x',
    settings: { remindAt: '08:30' },
    updatedAt: 42,
  })
  assert.equal(s.items.length, 1)
  assert.equal(s.items[0].shelfLife, 5)
  assert.deepEqual(s.shopping, [])
  assert.equal(s.settings.remindAt, '08:30')
  assert.equal(s.updatedAt, 42)
})

test('Hebrew wording', () => {
  assert.equal(L.daysText(1), 'יום\u00a0אחד')
  assert.equal(L.daysText(2), 'יומיים')
  assert.equal(L.daysText(5), '5\u00a0ימים')
  assert.equal(L.aboutDays(1), 'כיום\u00a0אחד', 'not כיום, which means nowadays')
  assert.equal(L.aboutDays(2), 'כיומיים')
  assert.equal(L.toDays(1), 'ליום\u00a0אחד')
  assert.equal(L.toDays(2), 'ליומיים', 'no maqaf between a prefix and a word')
  assert.equal(L.toDays(6), 'ל־6\u00a0ימים')
  assert.equal(L.aboutDays(9), 'כ־9\u00a0ימים')
  assert.equal(L.atHomeText(0), 'בבית מהיום')
  assert.equal(L.atHomeText(1), 'בבית מאתמול')
  assert.equal(L.atHomeText(4), 'בבית כבר 4\u00a0ימים')
  assert.equal(L.inDaysText(1), 'מחר')
  assert.equal(L.inDaysText(3), 'בעוד 3\u00a0ימים')

  const [item] = stateWith(['tomato', 0]).items // 6 days
  const on = (n) => L.statusText(item, L.addDays(T, n))
  assert.equal(on(0), 'עוד כ־6\u00a0ימים')
  assert.equal(on(4), 'עוד יומיים')
  assert.equal(on(5), 'עוד יום')
  assert.equal(on(6), 'יום אחרון משוער')
  assert.equal(on(7), 'יום\u00a0אחד אחרי המשוער')
  assert.equal(on(8), 'יומיים אחרי המשוער')
  assert.equal(on(10), '4\u00a0ימים אחרי המשוער')
})

test('catalog: unique keys, searchable in everyday Hebrew', () => {
  const keys = CATALOG.map((p) => p.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const p of CATALOG) {
    assert.ok(p.days > 0 && ['fridge', 'counter', 'freezer'].includes(p.storage), p.key)
    assert.ok(p.emoji || /^#[0-9a-f]{6}$/i.test(p.color), `${p.key} needs an emoji or a colour`)
  }
  for (const k of [...STAPLES, ...Object.values(SEASON).flat()]) assert.ok(byKey(k), k)

  assert.equal(searchCatalog('עגבניה')[0].key, 'tomato')
  assert.equal(searchCatalog('גינגר')[0].key, 'ginger')
  assert.equal(searchCatalog('תפוא')[0].key, 'potato')
  assert.equal(searchCatalog('תפוח')[0].key, 'apple')
  assert.ok(searchCatalog('תפוח').some((p) => p.key === 'potato'))
  assert.ok(searchCatalog('', 'fruit').every((p) => p.kind === 'fruit'))
  assert.equal(findByName('בננות')?.key, 'banana')
  assert.equal(findByName('פיטאיה'), null)
  assert.deepEqual(inSeason(10).map((p) => p.key).slice(0, 2), ['pomegranate', 'persimmon'])
})

test('finding something spoiled after its estimate never lengthens the estimate', () => {
  const s = stateWith(['lettuce', 10]) // estimate 5, found on day 10
  L.answer(s, s.items[0].id, 'spoiled', T)
  assert.equal(s.learned.lettuce, undefined)

  // An item whose shelf life was raised by hand still blends from the product default.
  const t = L.emptyState()
  const banana = L.addItem(t, byKey('banana'), T, { boughtOn: L.addDays(T, -2), shelfLife: 14 })
  L.answer(t, banana.id, 'spoiled', T)
  assert.equal(t.learned.banana, 4) // (5 + 2) / 2, not (14 + 2) / 2
})

test('"still good" never shortens the estimate below the product default', () => {
  const s = L.emptyState()
  const tomato = L.addItem(s, byKey('tomato'), T, { boughtOn: L.addDays(T, -2), shelfLife: 2 })
  L.answer(s, tomato.id, 'fresh', T)
  assert.equal(tomato.shelfLife, 3, 'this batch keeps another day')
  assert.equal(s.learned.tomato, 6, 'the catalog default stands')
  assert.equal(L.addItem(s, byKey('tomato'), T).shelfLife, 6)
})

test('out of the freezer: the clock restarts, "eat soon" clears, and nothing is learned', () => {
  const s = L.emptyState()
  const item = L.addItem(s, byKey('strawberry'), T, { boughtOn: '2026-08-01', storage: 'freezer' })
  item.useSoon = true
  L.editItem(s, item.id, { storage: 'fridge' }, T)
  assert.equal(item.boughtOn, T)
  assert.equal(item.shelfLife, 3)
  assert.equal(item.wasFrozen, true)
  assert.equal(L.freshness(item, T).level, 'fresh')
  assert.equal(L.isDue(item, T), false)

  L.answer(s, item.id, 'fresh', L.addDays(T, 5)) // still fine two days past the estimate
  assert.equal(s.learned.strawberry, undefined)
  L.answer(s, item.id, 'spoiled', L.addDays(T, 6))
  assert.equal(s.learned.strawberry, undefined)
})

test('moving to the freezer or changing the purchase date clears "eat soon"', () => {
  const s = stateWith(['tomato', 3], ['cucumber', 3])
  const [tomato, cucumber] = s.items
  L.answer(s, tomato.id, 'soon', T)
  L.answer(s, cucumber.id, 'soon', T)
  L.editItem(s, tomato.id, { storage: 'freezer', shelfLife: 90 }, T)
  L.editItem(s, cucumber.id, { boughtOn: T }, T)
  assert.equal(tomato.useSoon, false)
  assert.equal(cucumber.useSoon, false)
  L.answer(s, tomato.id, 'fresh', L.addDays(T, 45))
  assert.equal(tomato.nextCheckOn, L.addDays(T, 45 + L.MAX_CHECK_GAP), 'not asked daily for months')
})

test('the demo inventory leaves no trace once cleared', () => {
  const s = L.emptyState()
  const sample = L.addItem(s, byKey('banana'), T, { boughtOn: L.addDays(T, -2), sample: true })
  const real = L.addItem(s, byKey('apple'), T)
  const r = L.answer(s, sample.id, 'spoiled', T)
  assert.equal(r.kind, 'spoiled')
  L.addToShopping(s, sample, T)
  L.addToShopping(s, byKey('lemon'), T)
  assert.deepEqual(s.history, [])
  assert.deepEqual(s.learned, {})
  L.clearSample(s)
  assert.deepEqual(s.items.map((i) => i.id), [real.id])
  assert.deepEqual(s.shopping.map((x) => x.key), ['lemon'])
})

test('editItem ignores fields the sheet does not edit', () => {
  const s = stateWith(['apple', 0])
  const item = s.items[0]
  L.editItem(s, item.id, { id: 'x"><b>', name: '  תפוח גאלה  ', storage: 'attic', shelfLife: 'abc' }, T)
  assert.notEqual(item.id, 'x"><b>')
  assert.equal(item.name, 'תפוח גאלה')
  assert.equal(item.storage, 'fridge')
  assert.equal(item.shelfLife, 1)
})

test('only something shaped like a backup may replace the data', () => {
  for (const v of [123456, 'hello', [], {}, true, null, { items: 'x' }]) assert.equal(L.looksLikeBackup(v), false, JSON.stringify(v))
  assert.equal(L.looksLikeBackup({ items: [] }), true)
})

test('normalizeState makes hostile backups harmless', () => {
  const evil = '"><img src=x onerror=alert(1)>'
  const s = L.normalizeState({
    items: [
      { id: evil, name: 'תפוח', key: 'apple', boughtOn: T, nextCheckOn: T, shelfLife: 5, color: 'red;background:url(x)', storage: evil, useSoon: 'yes', qty: 4 },
      { id: 'same', name: 'בננה', boughtOn: T, nextCheckOn: T, shelfLife: 99999 },
      { id: 'same', name: 'חסה', boughtOn: '2026-02-30', nextCheckOn: T, shelfLife: 5 },
      { id: 'same', name: 'גזר', boughtOn: T, nextCheckOn: T, shelfLife: 5 },
    ],
    shopping: [{ id: 's1', name: 'לימון', done: evil }],
    history: [{ id: 'h', type: evil, name: 'x', on: T }, { id: 'h2', type: 'eaten', name: 'תפוח', on: T, age: 'old' }],
    learned: { banana: evil, apple: '9', 'name:x': -3 },
    settings: { remindAt: evil },
  })
  const [apple, banana, carrot] = s.items
  assert.equal(s.items.length, 3, 'the impossible date is dropped')
  assert.match(apple.id, /^[a-z0-9]+$/i)
  assert.equal(apple.color, null)
  assert.equal(apple.storage, 'fridge')
  assert.equal(apple.useSoon, false)
  assert.equal(apple.qty, '4')
  assert.equal(banana.shelfLife, 3650)
  assert.equal(banana.id, 'same')
  assert.notEqual(carrot.id, 'same', 'duplicate ids are replaced')
  assert.equal(s.shopping[0].done, false)
  assert.deepEqual(s.history.map((h) => [h.type, h.age]), [['eaten', 0]])
  assert.deepEqual(s.learned, { apple: 9 })
  assert.equal(s.settings.remindAt, '19:00')
})

test('a demo entry on the shopping list becomes real once it is really wanted or bought', () => {
  const s = L.emptyState()
  const demo = L.addItem(s, byKey('banana'), T, { sample: true })
  L.answer(s, demo.id, 'eaten', T)
  L.addToShopping(s, demo, T)
  L.addToShopping(s, byKey('lemon'), T)
  const demoLemon = L.addItem(s, byKey('apple'), T, { sample: true })
  L.addToShopping(s, demoLemon, T)
  assert.deepEqual(s.shopping.map((x) => [x.key, x.sample === true]), [['banana', true], ['lemon', false], ['apple', true]])

  // Asking for the banana for real keeps one entry and makes it real.
  assert.equal(L.addToShopping(s, byKey('banana'), T).added, false)
  assert.equal(s.shopping[0].sample, undefined)

  // Whatever is ticked and checked out was really bought.
  s.shopping.forEach((x) => (x.done = true))
  const bought = L.checkout(s, T)
  assert.ok(bought.every((i) => !i.sample))
  L.clearSample(s)
  assert.deepEqual(s.items.map((i) => i.key).sort(), ['apple', 'banana', 'lemon'])
})

test('names are capped where they come in, so a reload never changes a product', () => {
  const s = L.emptyState()
  const long = 'א'.repeat(80)
  const item = L.addItem(s, { name: '  ' + long + '  ' }, T)
  assert.equal(item.name.length, 60)
  const again = L.normalizeState(JSON.parse(JSON.stringify(s)))
  assert.equal(L.productId(again.items[0]), L.productId(item))
})

test('meat: every category is stocked, searchable, and keeps briefly in the fridge', () => {
  const meat = CATALOG.filter((p) => p.kind === 'meat')
  for (const cat of Object.keys(MEAT_CATS)) assert.ok(meat.some((p) => p.cat === cat), cat)
  for (const p of meat) {
    assert.ok(Object.hasOwn(MEAT_CATS, p.cat), p.key)
    assert.ok(Object.hasOwn(UNITS, p.unit), p.key)
    if (p.cat !== 'processed') assert.ok(p.days <= 3, `${p.key} raw meat keeps days, not weeks`)
  }
  assert.equal(searchCatalog('שניצל')[0].key, 'chicken-breast')
  assert.equal(searchCatalog('טחון')[0].key, 'ground-beef')
  assert.equal(searchCatalog('עוף')[0].key, 'whole-chicken')
  assert.ok(searchCatalog('', 'meat', 'fish').every((p) => p.cat === 'fish'))
  assert.equal(searchCatalog('', 'fruit', 'fish').length, 0)

  const s = L.emptyState()
  const chicken = L.addItem(s, byKey('chicken-breast'), T)
  assert.equal(chicken.nextCheckOn, L.addDays(T, 1), 'asked about the very next day')
  assert.equal(chicken.cat, 'chicken')
  const frozen = L.addItem(s, byKey('ground-beef'), T, { storage: 'freezer' })
  assert.equal(frozen.shelfLife, 90)
  L.editItem(s, frozen.id, { storage: 'fridge' }, L.addDays(T, 30))
  assert.equal(frozen.shelfLife, 1, 'thawed mince is for today or tomorrow')
})

test('prices are typed the way people type them', () => {
  assert.equal(L.parseAmount('12.9'), 12.9)
  assert.equal(L.parseAmount('12,90'), 12.9)
  assert.equal(L.parseAmount(' ₪ 7 '), 7)
  assert.equal(L.parseAmount('3.456'), 3.46)
  for (const bad of ['', 'abc', '0', '-4', '1e9', null, undefined]) assert.equal(L.parseAmount(bad), null, String(bad))
  assert.match(L.priceText(12.9, 'kg'), /12\.90/)
  assert.match(L.priceText(12.9, 'kg'), /לק״ג$/)
})

test('stores are named once, whatever the spelling', () => {
  const s = L.emptyState()
  const a = L.addVendor(s, 'רמי לוי')
  assert.equal(L.addVendor(s, ' רמי-לוי ').id, a.id)
  assert.equal(L.addVendor(s, '   '), null)
  L.addVendor(s, 'שופרסל')
  assert.deepEqual(s.vendors.map((v) => v.name), ['רמי לוי', 'שופרסל'])
  assert.ok(VENDOR_SUGGESTIONS.includes('רמי לוי'))
})

test('a purchase records the store, the price and which way it moved', () => {
  const s = L.emptyState()
  const rami = L.addVendor(s, 'רמי לוי')
  const shufersal = L.addVendor(s, 'שופרסל')
  const t1 = L.addItem(s, byKey('tomato'), T, { boughtOn: L.addDays(T, -10) })
  L.recordPurchase(s, t1.id, { vendorId: rami.id, amount: '6.90', unit: 'kg' })
  const t2 = L.addItem(s, byKey('tomato'), T)
  L.recordPurchase(s, t2.id, { vendorId: rami.id, amount: '7.90', unit: 'kg' })
  const t3 = L.addItem(s, byKey('tomato'), T, { boughtOn: L.addDays(T, -1) })
  L.recordPurchase(s, t3.id, { vendorId: shufersal.id, amount: '5.90' })

  assert.deepEqual(t2.price, { amount: 7.9, unit: 'kg' })
  assert.equal(t2.vendorId, rami.id)
  assert.deepEqual(s.prices.tomato[rami.id], { amount: 7.9, unit: 'kg', on: T, prev: 6.9 })
  assert.equal(s.prices.tomato[shufersal.id].unit, 'kg', 'the product\'s usual unit when none is given')

  // An older receipt typed in late does not replace a newer price.
  const old = L.addItem(s, byKey('tomato'), T, { boughtOn: L.addDays(T, -20) })
  L.recordPurchase(s, old.id, { vendorId: rami.id, amount: '3' })
  assert.equal(s.prices.tomato[rami.id].amount, 7.9)
  // Correcting today's price does not count as a price change.
  const fix = L.addItem(s, byKey('tomato'), T)
  L.recordPurchase(s, fix.id, { vendorId: rami.id, amount: '7.50' })
  assert.deepEqual(s.prices.tomato[rami.id], { amount: 7.5, unit: 'kg', on: T, prev: 6.9 })

  assert.deepEqual(L.pricesFor(s, byKey('tomato')).map((r) => [r.vendor, r.amount]), [['שופרסל', 5.9], ['רמי לוי', 7.5]])
  const c = L.cheapest(s, byKey('tomato'))
  assert.equal(c.vendor, 'שופרסל')
  assert.equal(c.stores, 2)
  assert.deepEqual(L.bestStore(s, [byKey('tomato'), byKey('banana')]), { vendorId: shufersal.id, vendor: 'שופרסל', wins: 1, compared: 1 })

  // A store can be forgotten, and its prices with it.
  L.removeVendor(s, shufersal.id)
  assert.equal(L.cheapest(s, byKey('tomato')).vendor, 'רמי לוי')
  assert.equal(t3.vendorId, null)
  assert.deepEqual(t3.price, { amount: 5.9, unit: 'kg' }, 'what was paid stays on the item')
})

test('prices in different units are never compared', () => {
  const s = L.emptyState()
  const a = L.addVendor(s, 'א')
  const b = L.addVendor(s, 'ב')
  const x = L.addItem(s, byKey('strawberry'), T) // sold by the box
  L.recordPurchase(s, x.id, { vendorId: a.id, amount: 12, unit: 'unit' })
  const y = L.addItem(s, byKey('strawberry'), T)
  L.recordPurchase(s, y.id, { vendorId: b.id, amount: 30, unit: 'kg' })
  const c = L.cheapest(s, byKey('strawberry'))
  assert.equal(c.unit, 'unit')
  assert.equal(c.stores, 1)
  assert.equal(L.bestStore(s, [byKey('strawberry')]), null, 'nothing to compare')
})

test('the app asks what the latest shopping cost, once, while it is fresh in memory', () => {
  const s = L.emptyState()
  const old = L.addItem(s, byKey('apple'), T, { boughtOn: L.addDays(T, -L.PRICE_WINDOW - 1) })
  const yesterday = L.addItem(s, byKey('banana'), T, { boughtOn: L.addDays(T, -1) })
  const a = L.addItem(s, byKey('salmon'), T)
  const b = L.addItem(s, byKey('lettuce'), T)
  L.addItem(s, byKey('carrot'), T, { sample: true })
  let q = L.priceQuestion(s, T)
  assert.equal(q.on, T)
  assert.deepEqual(q.items.map((i) => i.id), [a.id, b.id])

  const v = L.addVendor(s, 'השוק')
  L.recordPurchase(s, a.id, { vendorId: v.id, amount: '89.90' })
  L.recordPurchase(s, b.id, { vendorId: v.id }) // the store, without a price
  assert.equal(b.vendorId, v.id)
  assert.equal(b.price, null)
  q = L.priceQuestion(s, T)
  assert.deepEqual(q.items.map((i) => i.id), [yesterday.id])
  L.skipPrices(s, [yesterday.id])
  assert.equal(L.priceQuestion(s, T), null)
  assert.equal(old.priceAsked, false, 'too old to ask about, so it is simply never asked')
})

test('normalizeState keeps stores and prices consistent and safe', () => {
  const evil = '"><img src=x onerror=alert(1)>'
  const s = L.normalizeState({
    vendors: [{ id: 'v1', name: 'רמי לוי' }, { id: 'v1', name: 'שופרסל' }, { id: evil, name: 'השוק' }, { id: 'v9', name: ' רמי-לוי ' }, { name: '' }],
    items: [
      { id: 'a', name: 'עגבנייה', key: 'tomato', boughtOn: T, nextCheckOn: T, shelfLife: 6, vendorId: 'v1', price: { amount: '7.9', unit: 'kg' } },
      { id: 'b', name: 'חסה', key: 'lettuce', boughtOn: T, nextCheckOn: T, shelfLife: 5, vendorId: 'gone', price: { amount: -3, unit: 'kg' } },
      { id: 'c', name: 'בננה', key: 'banana', boughtOn: T, nextCheckOn: T, shelfLife: 5, priceAsked: true },
      { id: 'd', name: 'חזה עוף', key: 'chicken-breast', boughtOn: T, nextCheckOn: T, shelfLife: 2, kind: 'fruit', cat: 'fish' },
    ],
    prices: { tomato: { v1: { amount: 7.9, unit: 'kg', on: T, prev: 'x' }, gone: { amount: 1, unit: 'kg', on: T } }, banana: { v1: { amount: 5, unit: 'litre', on: T } } },
  })
  assert.equal(s.vendors.length, 3)
  assert.equal(s.vendors[0].id, 'v1')
  assert.notEqual(s.vendors[1].id, 'v1', 'duplicate store ids are replaced')
  assert.match(s.vendors[2].id, /^[a-z0-9]+$/i)
  const [a, b, c, d] = s.items
  assert.equal(a.vendorId, 'v1')
  assert.deepEqual(a.price, { amount: 7.9, unit: 'kg' })
  assert.equal(a.priceAsked, true)
  assert.equal(b.vendorId, null)
  assert.equal(b.price, null)
  assert.equal(b.priceAsked, false, 'an item from before prices existed is asked about while recent')
  assert.equal(c.priceAsked, true)
  assert.equal(d.kind, 'meat', 'catalog items keep their catalog kind')
  assert.equal(d.cat, 'chicken')
  assert.deepEqual(s.prices, { tomato: { v1: { amount: 7.9, unit: 'kg', on: T, prev: null } } })
})
