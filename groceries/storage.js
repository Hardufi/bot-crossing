// Where the inventory lives.
//
// Opened as an ordinary web page, everything stays in this browser's localStorage. Opened as a
// claude.ai Artifact, the same state is also kept in the artifact's database, in the viewer's
// own private folder, so it follows them between devices. localStorage stays as a fast cache
// either way, so the first frame never waits on the network.
//
// The cache remembers whose state it is (`owner`) and the last version known to be in the
// account (`syncedAt`). Those two decide, when the account copy arrives, whether this device
// holds changes the account has not seen (send them) or the account moved on (take its copy).

export const LOCAL_KEY = 'betokef.state.v1'

let cacheOwner = null
let syncedAt = 0

function parseCache(text) {
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object') return null
    // The first release stored the bare state, with no owner.
    if (Array.isArray(raw.items)) return { owner: null, syncedAt: 0, state: raw }
    return { owner: typeof raw.owner === 'string' ? raw.owner : null, syncedAt: Number(raw.syncedAt) || 0, state: raw.state ?? null }
  } catch {
    return null
  }
}

export function loadLocal() {
  let cache = null
  try {
    cache = parseCache(localStorage.getItem(LOCAL_KEY))
  } catch {}
  if (!cache) return null
  cacheOwner = cache.owner
  syncedAt = cache.syncedAt
  return cache.state
}

// The state another window of this app just saved, if it belongs to the same person.
export function stateFromStorageEvent(e) {
  if (e.key !== LOCAL_KEY || !e.newValue) return null
  const cache = parseCache(e.newValue)
  if (!cache || cache.owner !== cacheOwner) return null
  return cache.state
}

function saveLocal(state) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ owner: cacheOwner, syncedAt, state }))
  } catch {
    // Private windows and full disks refuse writes; the in-memory state carries on.
  }
}

// Small per-device settings that should not sync (whether this device shows notifications).
export function deviceGet(key, fallback = null) {
  try {
    const v = localStorage.getItem('betokef.device.' + key)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

export function deviceSet(key, value) {
  try {
    localStorage.setItem('betokef.device.' + key, JSON.stringify(value))
  } catch {}
}

export const localStore = { kind: 'local', save: saveLocal }

const jitter = () => 1000 + Math.random() * 2000

// Resolves to a store with save(state) and a `kind` of 'local' or 'cloud'.
//   getState()          the state on screen right now
//   adopt(data, why)    replace it: why is 'newer' (another device moved on), 'conflict'
//                       (both changed; this device's unsynced changes are dropped) or
//                       'reset' (the cache belonged to someone else; data is null)
//   onStatus(message)   a sync problem to show, or null once writes work again
export async function openStore({ getState, adopt, onStatus }) {
  const claude = typeof window !== 'undefined' ? window.claude : undefined
  if (!claude?.use) return localStore
  let db, user
  try {
    ;[db, user] = await Promise.all([claude.use('db'), claude.use('user')])
  } catch {
    return localStore
  }
  const uid = db && user ? await user.id() : null
  if (!uid) return localStore

  // A cache written by someone else signed in on this browser must never reach this account.
  if (cacheOwner && cacheOwner !== uid) {
    cacheOwner = uid
    syncedAt = 0
    adopt(null, 'reset')
  }
  cacheOwner = uid

  const ref = db.doc(`data/users/${uid}/state`)
  const store = { kind: 'cloud', save }
  let ready = false // the first definitive copy from the account has been weighed
  let dead = false
  let pending = null
  let timer = null
  let chain = Promise.resolve()
  let retried = false
  let failing = false

  function goLocal(message) {
    dead = true
    pending = null
    clearTimeout(timer)
    store.kind = 'local'
    onStatus(message)
  }

  function save(state) {
    saveLocal(state)
    if (dead) return
    pending = JSON.parse(JSON.stringify(state))
    clearTimeout(timer)
    if (ready) timer = setTimeout(flush, 500)
  }

  function flush() {
    clearTimeout(timer)
    if (!pending || dead || !ready) return
    const body = pending
    pending = null
    chain = chain
      .then(() => ref.set(body))
      .then(() => {
        syncedAt = Math.max(syncedAt, body.updatedAt)
        saveLocal(getState())
        retried = false
        if (failing) {
          failing = false
          onStatus(null)
        }
      })
      .catch((e) => {
        const code = e?.code
        if (code === 'unavailable' || code === 'resource_exhausted') {
          // Retry once after a short pause, unless a newer change is already queued.
          if (!retried && !pending) {
            retried = true
            pending = body
            timer = setTimeout(flush, jitter())
            return
          }
          retried = false
          failing = true
          onStatus('השמירה בחשבון נכשלה. השינויים נשמרו במכשיר הזה, ואנסה שוב בשינוי הבא.')
        } else if (code === 'quota_exceeded') {
          failing = true
          onStatus('אין מקום לשמור עוד בחשבון. השינויים נשמרו במכשיר הזה.')
        } else {
          goLocal('אין אפשרות לשמור בחשבון. השינויים נשמרים במכשיר הזה בלבד.')
        }
      })
  }

  // The account copy just replaced what is on screen: anything queued is older than it.
  function take(remote, why) {
    pending = null
    clearTimeout(timer)
    syncedAt = Number(remote.updatedAt) || 0
    saveLocal(remote)
    adopt(remote, why)
  }

  function onSnapshot(snap) {
    if (snap.metadata.hasPendingWrites) return
    // The first pages of a subscription can come from a local cache, not the account.
    if (!ready && snap.metadata.fromCache) return
    const remote = snap.exists ? snap.data() : null
    const remoteAt = Number(remote?.updatedAt) || 0
    const local = getState()

    if (!ready) {
      ready = true
      const unsynced = local.updatedAt > syncedAt
      if (!remote) {
        // A new account copy: seed it with whatever this device has.
        if (local.updatedAt > 0) {
          pending = JSON.parse(JSON.stringify(local))
          flush()
        }
      } else if (remoteAt === local.updatedAt) {
        syncedAt = remoteAt
        saveLocal(local)
      } else if (unsynced && remoteAt <= syncedAt) {
        // Only this device changed since the last sync.
        pending = JSON.parse(JSON.stringify(local))
        flush()
      } else {
        take(remote, unsynced ? 'conflict' : 'newer')
      }
      return
    }
    if (remote && remoteAt > local.updatedAt) take(remote, 'newer')
  }

  function subscribe() {
    ref.onSnapshot(onSnapshot, (e) => {
      if (dead) return
      // A bridge that stopped answering recovers only through a fresh subscription.
      if (e?.code === 'unavailable') setTimeout(subscribe, jitter())
      else goLocal('הסנכרון נעצר. השינויים נשמרים במכשיר הזה בלבד.')
    })
  }
  subscribe()

  // A change made just before the page goes away should not wait for the debounce.
  const flushNow = () => {
    if (pending && ready && !dead) flush()
  }
  addEventListener('pagehide', flushNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow()
  })

  return store
}
