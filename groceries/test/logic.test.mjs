import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../logic.js'
import { byKey, searchCatalog, findByName, inSeason, CATALOG, STAPLES, SEASON } from '../catalog.js'

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
  assert.equal(L.aboutDays(2), 'כיומיים')
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
  assert.equal(on(7), 'עבר את המשוער ביום')
  assert.equal(on(8), 'עבר את המשוער ביומיים')
  assert.equal(on(10), 'עבר את המשוער ב־4\u00a0ימים')
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
