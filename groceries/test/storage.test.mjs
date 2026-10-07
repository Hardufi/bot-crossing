// The sync rules in storage.js, run against an in-memory stand-in for the claude.ai Artifact
// database. Each window imports a fresh copy of the module, because it keeps the cache owner
// and the last synced version in module state; windows in one test share one localStorage and
// one database, as tabs in one browser do.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const KEY = 'betokef.state.v1'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const S = (updatedAt, items = []) => ({ items, updatedAt })

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  }
}

// failures: queued rejections for set(), each a code or {code, delay}.
function fakeDb(initialDoc) {
  let doc = initialDoc ? structuredClone(initialDoc) : null
  const listeners = []
  const held = new Set() // windows whose snapshots are delayed until delivered by hand
  const writes = []
  const failures = []
  let setCalls = 0
  const emitAll = (meta = {}) => listeners.forEach((l, i) => held.has(i) || l(snap(meta)))
  const snap = (meta, exists = Boolean(doc)) => ({
    exists,
    data: () => (exists && doc ? Object.freeze(structuredClone(doc)) : undefined),
    metadata: { fromCache: false, hasPendingWrites: false, ...meta },
  })
  return {
    writes,
    failures,
    listeners,
    get doc() {
      return doc
    },
    get setCalls() {
      return setCalls
    },
    emit: (meta) => emitAll(meta),
    hold: (i) => held.add(i),
    emitTo(i, meta = {}) {
      held.delete(i)
      listeners[i](snap(meta))
    },
    // A first page from a local cache that does not have the document yet.
    emitMissingFromCache() {
      for (const l of [...listeners]) l(snap({ fromCache: true }, false))
    },
    remoteWrite(next) {
      doc = structuredClone(next)
      this.emit()
    },
    api: {
      doc: (path) => ({
        path,
        async set(body) {
          setCalls++
          const f = failures.shift()
          if (f) {
            await wait(f.delay ?? 0)
            throw { code: f.code ?? f }
          }
          writes.push(structuredClone(body))
          doc = structuredClone(body)
          // Every subscriber, the writer included, hears the confirmed write.
          queueMicrotask(() => emitAll())
        },
        onSnapshot(next) {
          listeners.push(next)
          return () => {}
        },
      }),
    },
  }
}

let copy = 0
const pageHandlers = []

function browser({ cache, doc, uid = 'u1' } = {}) {
  globalThis.localStorage = memoryStorage(cache ? { [KEY]: JSON.stringify(cache) } : {})
  globalThis.document = { visibilityState: 'visible', addEventListener() {} }
  pageHandlers.length = 0
  globalThis.addEventListener = (type, fn) => type === 'pagehide' && pageHandlers.push(fn)
  const db = fakeDb(doc)
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? db.api : name === 'user' ? { id: async () => uid } : null) } }
  return { db, open: () => openWindow(db), hide: () => pageHandlers.forEach((fn) => fn()) }
}

// One window of the app: its own module copy, its own state, the glue app.js has.
async function openWindow(db) {
  const storage = await import(`../storage.js?copy=${++copy}`)
  let state = storage.loadLocal() ?? S(0)
  const adopted = []
  const statuses = []
  const store = await storage.openStore({
    getState: () => state,
    adopt(data, why) {
      adopted.push(why)
      state = data ? structuredClone(data) : S(0)
    },
    onStatus: (m) => statuses.push(m),
  })
  const w = {
    db,
    store,
    adopted,
    statuses,
    get state() {
      return state
    },
    commit(changes) {
      state = { ...state, ...changes, updatedAt: Math.max(state.updatedAt, Date.now()) + 1 }
      store.save(state)
    },
    // What app.js does on a 'storage' event from another window.
    follow() {
      const data = storage.stateFromStorageEvent({ key: KEY, newValue: localStorage.getItem(KEY) })
      if (data && data.updatedAt > state.updatedAt) {
        adopted.push('newer')
        state = structuredClone(data)
      }
    },
  }
  return w
}

const cached = () => JSON.parse(localStorage.getItem(KEY))

test('a new device takes the account copy and writes nothing back', async () => {
  const b = browser({ doc: S(500, ['pepper']) })
  const w = await b.open()
  b.db.emit()
  assert.deepEqual(w.adopted, ['newer'])
  assert.deepEqual(w.state.items, ['pepper'])
  assert.equal(cached().syncedAt, 500)
  await wait(650)
  assert.equal(b.db.writes.length, 0)
})

test('changes made offline on top of the synced copy are sent', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(200, ['tomato', 'lettuce']) }, doc: S(100, ['tomato']) })
  const w = await b.open()
  b.db.emit()
  assert.deepEqual(w.adopted, [])
  await wait(50)
  assert.deepEqual(b.db.writes.map((x) => x.updatedAt), [200])
  assert.equal(cached().syncedAt, 200)
})

test('when both sides changed, the account copy wins and the user is told', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(200, ['stale']) }, doc: S(150, ['laptop']) })
  const w = await b.open()
  b.db.emit()
  assert.deepEqual(w.adopted, ['conflict'])
  assert.deepEqual(w.state.items, ['laptop'])
  await wait(650)
  assert.equal(b.db.writes.length, 0, 'the stale cache never overwrites the account')
})

test('an edit made before the account copy arrives does not overwrite newer changes', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['tomato', 'cucumber']) }, doc: S(300, ['tomato', 'cucumber', 'pepper']) })
  const w = await b.open()
  w.commit({ items: ['tomato'] }) // answered a question in the first second
  await wait(650)
  assert.equal(b.db.writes.length, 0, 'nothing is sent before the account copy is weighed')
  b.db.emit()
  assert.deepEqual(w.adopted, ['conflict'])
  b.hide()
  await wait(650)
  assert.equal(b.db.writes.length, 0)
  assert.deepEqual(b.db.doc.items, ['tomato', 'cucumber', 'pepper'])
})

test('a cached first page without the document does not seed the account', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(200, ['a']) }, doc: S(400, ['b']) })
  const w = await b.open()
  b.db.emitMissingFromCache()
  await wait(650)
  assert.equal(b.db.writes.length, 0)
  assert.deepEqual(b.db.doc.items, ['b'])
  b.db.emit()
  assert.deepEqual(w.adopted, ['conflict'])
})

test('a cache left by someone else is cleared, never uploaded', async () => {
  const b = browser({ cache: { owner: 'someone-else', syncedAt: 900, state: S(900, ['their', 'list']) } })
  const w = await b.open()
  assert.deepEqual(w.adopted, ['reset'])
  assert.equal(w.state.updatedAt, 0)
  assert.equal(cached().state, null, 'their list is gone from this browser too')
  assert.equal(cached().owner, 'u1')
  b.db.emit() // this account has no document yet
  await wait(650)
  assert.equal(b.db.writes.length, 0)
})

test('a queued write is dropped when a newer copy arrives from another device', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['a']) }, doc: S(100, ['a']) })
  const w = await b.open()
  b.db.emit()
  w.commit({ items: ['a', 'phone'] }) // queued for 500 ms
  b.db.remoteWrite(S(Date.now() + 60_000, ['a', 'laptop']))
  assert.deepEqual(w.adopted, ['newer'])
  await wait(650)
  assert.equal(b.db.writes.length, 0)
  assert.deepEqual(b.db.doc.items, ['a', 'laptop'])
})

test('a window that follows another never uploads its own older queued change', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['a']) }, doc: S(100, ['a']) })
  const A = await b.open()
  const B = await b.open()
  b.db.hold(0) // A's first account copy is slow to arrive
  A.commit({ items: ['a', 'c1'] }) // so this stays queued in A
  B.follow()
  b.db.emitTo(1) // B is ready and sends c1
  await wait(50)
  B.commit({ items: ['a', 'c1', 'c2'] })
  await wait(650) // B sends c2
  A.follow()
  b.db.emitTo(0) // A's first account copy is c2, which it already shows
  b.hide()
  await wait(650)
  assert.deepEqual(b.db.doc.items, ['a', 'c1', 'c2'])
  assert.deepEqual(A.state.items, ['a', 'c1', 'c2'])
  assert.ok(b.db.writes.every((x) => x.items.includes('c2') || x.updatedAt < B.state.updatedAt))
  assert.deepEqual(b.db.writes.at(-1).items, ['a', 'c1', 'c2'])
})

test('a retry is abandoned when a newer copy took over in the meantime', async () => {
  const b = browser({ doc: S(100, ['a']) })
  const w = await b.open()
  b.db.emit()
  b.db.failures.push({ code: 'unavailable', delay: 150 })
  w.commit({ items: ['a', 'from-this-window'] })
  await wait(560) // the write is in flight
  b.db.remoteWrite(S(Date.now() + 60_000, ['a', 'from-phone'])) // arrives before the rejection
  await wait(3500)
  assert.deepEqual(b.db.doc.items, ['a', 'from-phone'])
  assert.equal(b.db.writes.length, 0)
  assert.deepEqual(w.statuses, [], 'nothing failed that matters')
})

test('what another window synced counts here, so a later unsent change is not dropped', async () => {
  const b = browser({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['a']) }, doc: S(100, ['a']) })
  const A = await b.open()
  const B = await b.open()
  b.db.emit()
  b.db.hold(0) // A hears about B's write from the shared cache before the account says so
  B.commit({ items: ['a', 'b'] })
  await wait(650) // B sends it; the cache records it as synced
  A.follow()
  b.db.emitTo(0)
  b.db.failures.push('unavailable', 'unavailable')
  A.commit({ items: ['a', 'b', 'c'] }) // never reaches the account
  await wait(3800)
  assert.equal(b.db.doc.items.length, 2)

  const C = await b.open() // the next visit
  b.db.emitTo(2)
  await wait(50)
  assert.deepEqual(C.adopted, [], 'not a conflict: the account has not moved since')
  assert.deepEqual(b.db.doc.items, ['a', 'b', 'c'])
})

test('a transient failure is retried once, then reported', async () => {
  const b = browser({ doc: S(100, []) })
  const w = await b.open()
  b.db.emit()
  b.db.failures.push('unavailable')
  w.commit({ items: ['x'] })
  await wait(3800)
  assert.deepEqual(b.db.writes.map((x) => x.items), [['x']])
  assert.deepEqual(w.statuses, [])

  b.db.failures.push('unavailable', 'unavailable')
  w.commit({ items: ['x', 'y'] })
  await wait(3800)
  assert.equal(b.db.setCalls, 4, 'one write, one retry, no more')
  assert.equal(b.db.writes.length, 1)
  assert.equal(w.statuses.length, 1)
  assert.match(w.statuses[0], /ואנסה שוב/)

  w.commit({ items: ['x', 'y', 'z'] }) // the next change goes through and clears the warning
  await wait(650)
  assert.equal(b.db.writes.length, 2)
  assert.deepEqual(w.statuses, [w.statuses[0], null])
})

test('an unknown error code is treated as passing; a refusal stops cloud writes', async () => {
  const b = browser({ doc: S(100, []) })
  const w = await b.open()
  b.db.emit()
  b.db.failures.push('queue_overflow')
  w.commit({ items: ['x'] })
  await wait(3800)
  assert.equal(w.store.kind, 'cloud')
  assert.deepEqual(b.db.doc.items, ['x'])

  b.db.failures.push('invalid_argument')
  w.commit({ items: ['x', 'y'] })
  await wait(650)
  assert.equal(w.store.kind, 'local')
  assert.equal(w.statuses.length, 1)
  w.commit({ items: ['x', 'y', 'z'] })
  await wait(650)
  assert.equal(b.db.writes.length, 1)
  assert.deepEqual(cached().state.items, ['x', 'y', 'z'], 'still saved on the device')
})

test('without the claude.ai runtime everything stays local', async () => {
  globalThis.localStorage = memoryStorage()
  globalThis.window = {}
  const storage = await import(`../storage.js?copy=${++copy}`)
  const store = await storage.openStore({ getState: () => S(0), adopt() {}, onStatus() {} })
  assert.equal(store.kind, 'local')
  store.save(S(42, ['a']))
  assert.deepEqual(cached().state.items, ['a'])
  assert.deepEqual(storage.loadLocal().items, ['a'])
})

test('the first release stored the bare state; it still loads', async () => {
  globalThis.localStorage = memoryStorage({ [KEY]: JSON.stringify(S(7, ['old'])) })
  const storage = await import(`../storage.js?copy=${++copy}`)
  assert.deepEqual(storage.loadLocal().items, ['old'])
})
