// The sync rules in storage.js, run against an in-memory stand-in for the claude.ai Artifact
// database. Each test imports a fresh copy of the module, because it keeps the cache owner and
// the last synced version in module state.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const KEY = 'betokef.state.v1'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  }
}

function fakeDb(initialDoc) {
  let doc = initialDoc ? structuredClone(initialDoc) : null
  const listeners = []
  const writes = []
  const failures = []
  const snap = (meta) => ({
    exists: Boolean(doc),
    data: () => (doc ? Object.freeze(structuredClone(doc)) : undefined),
    metadata: { fromCache: false, hasPendingWrites: false, ...meta },
  })
  return {
    writes,
    failures,
    get doc() {
      return doc
    },
    emit(meta = {}) {
      for (const l of listeners) l(snap(meta))
    },
    remoteWrite(next) {
      doc = structuredClone(next)
      this.emit()
    },
    api: {
      doc: (path) => ({
        path,
        async set(body) {
          const failure = failures.shift()
          if (failure) throw { code: failure }
          writes.push(structuredClone(body))
          doc = structuredClone(body)
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
async function setup({ cache, doc, uid = 'u1' } = {}) {
  globalThis.localStorage = memoryStorage(cache ? { [KEY]: JSON.stringify(cache) } : {})
  globalThis.document = { visibilityState: 'visible', addEventListener() {} }
  globalThis.addEventListener = () => {}
  const db = fakeDb(doc)
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? db.api : name === 'user' ? { id: async () => uid } : null) } }
  const storage = await import(`../storage.js?copy=${++copy}`)
  let state = storage.loadLocal() ?? { items: [], updatedAt: 0 }
  const adopted = []
  const statuses = []
  const store = await storage.openStore({
    getState: () => state,
    adopt(data, why) {
      adopted.push(why)
      state = data ? structuredClone(data) : { items: [], updatedAt: 0 }
    },
    onStatus: (m) => statuses.push(m),
  })
  const commit = (changes) => {
    state = { ...state, ...changes, updatedAt: state.updatedAt + 1000 }
    store.save(state)
  }
  const cached = () => JSON.parse(globalThis.localStorage.getItem(KEY))
  return { db, store, adopted, statuses, commit, cached, getState: () => state }
}

const S = (updatedAt, items = []) => ({ items, updatedAt })

test('a new device takes the account copy and writes nothing back', async () => {
  const t = await setup({ doc: S(500, ['pepper']) })
  t.db.emit()
  assert.deepEqual(t.adopted, ['newer'])
  assert.deepEqual(t.getState().items, ['pepper'])
  assert.equal(t.cached().syncedAt, 500)
  await wait(650)
  assert.equal(t.db.writes.length, 0)
})

test('changes made offline on top of the synced copy are sent', async () => {
  const t = await setup({ cache: { owner: 'u1', syncedAt: 100, state: S(200, ['tomato', 'lettuce']) }, doc: S(100, ['tomato']) })
  t.db.emit()
  assert.deepEqual(t.adopted, [])
  await wait(50)
  assert.deepEqual(t.db.writes.map((w) => w.updatedAt), [200])
  assert.equal(t.cached().syncedAt, 200)
})

test('when both sides changed, the account copy wins and the user is told', async () => {
  const t = await setup({ cache: { owner: 'u1', syncedAt: 100, state: S(200, ['stale']) }, doc: S(150, ['laptop']) })
  t.db.emit()
  assert.deepEqual(t.adopted, ['conflict'])
  assert.deepEqual(t.getState().items, ['laptop'])
  await wait(650)
  assert.equal(t.db.writes.length, 0, 'the stale cache never overwrites the account')
})

test('an edit made before the account copy arrives does not overwrite newer changes', async () => {
  const t = await setup({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['tomato', 'cucumber']) }, doc: S(300, ['tomato', 'cucumber', 'pepper']) })
  t.commit({ items: ['tomato'] }) // answered a question in the first second
  await wait(650)
  assert.equal(t.db.writes.length, 0, 'nothing is sent before the account copy is weighed')
  t.db.emit()
  assert.deepEqual(t.adopted, ['conflict'])
  await wait(650)
  assert.equal(t.db.writes.length, 0)
  assert.deepEqual(t.db.doc.items, ['tomato', 'cucumber', 'pepper'])
})

test('a cached-only first snapshot is not taken as the account copy', async () => {
  const t = await setup({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['a']) }, doc: S(400, ['b']) })
  // The listener's first page comes from a local cache that does not have the document yet.
  for (const l of [t.db]) l.emit({ fromCache: true })
  await wait(650)
  assert.equal(t.db.writes.length, 0)
  t.db.emit()
  assert.deepEqual(t.adopted, ['newer'])
})

test('a cache left by someone else is dropped, never uploaded', async () => {
  const t = await setup({ cache: { owner: 'someone-else', syncedAt: 900, state: S(900, ['their', 'list']) } })
  assert.deepEqual(t.adopted, ['reset'])
  assert.equal(t.getState().updatedAt, 0)
  t.db.emit() // this account has no document yet
  await wait(650)
  assert.equal(t.db.writes.length, 0)
})

test('a queued write is dropped when a newer copy arrives from another device', async () => {
  const t = await setup({ cache: { owner: 'u1', syncedAt: 100, state: S(100, ['a']) }, doc: S(100, ['a']) })
  t.db.emit()
  t.commit({ items: ['a', 'phone'] }) // updatedAt 1100, queued for 500 ms
  t.db.remoteWrite(S(5000, ['a', 'laptop']))
  assert.deepEqual(t.adopted, ['newer'])
  await wait(650)
  assert.equal(t.db.writes.length, 0)
  assert.deepEqual(t.db.doc.items, ['a', 'laptop'])
})

test('a transient failure is retried once; a refusal stops cloud writes', async () => {
  const t = await setup({ doc: S(100, []) })
  t.db.emit()
  t.db.failures.push('unavailable')
  t.commit({ items: ['x'] })
  await wait(3800)
  assert.deepEqual(t.db.writes.map((w) => w.items), [['x']])
  assert.deepEqual(t.statuses, [])

  t.db.failures.push('invalid_argument')
  t.commit({ items: ['x', 'y'] })
  await wait(650)
  assert.equal(t.store.kind, 'local')
  assert.equal(t.statuses.length, 1)
  t.commit({ items: ['x', 'y', 'z'] })
  await wait(650)
  assert.equal(t.db.writes.length, 1)
  assert.deepEqual(t.cached().state.items, ['x', 'y', 'z'], 'still saved on the device')
})

test('without the claude.ai runtime everything stays local', async () => {
  globalThis.localStorage = memoryStorage()
  globalThis.window = {}
  const storage = await import(`../storage.js?copy=${++copy}`)
  const store = await storage.openStore({ getState: () => S(0), adopt() {}, onStatus() {} })
  assert.equal(store.kind, 'local')
  store.save(S(42, ['a']))
  assert.deepEqual(JSON.parse(localStorage.getItem(KEY)).state.items, ['a'])
  assert.deepEqual(storage.loadLocal().items, ['a'])
})

test('the first release stored the bare state; it still loads', async () => {
  globalThis.localStorage = memoryStorage({ [KEY]: JSON.stringify(S(7, ['old'])) })
  const storage = await import(`../storage.js?copy=${++copy}`)
  assert.deepEqual(storage.loadLocal().items, ['old'])
})
