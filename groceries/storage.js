// Where the inventory lives.
//
// Opened as an ordinary web page, everything stays in this browser's localStorage. Opened as a
// claude.ai Artifact, the same state is also kept in the artifact's database, in the viewer's
// own private folder, so it follows them between devices. localStorage stays as a fast cache
// either way, so the first frame never waits on the network.

const LOCAL_KEY = 'betokef.state.v1'

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveLocal(state) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state))
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

// Resolves to a store with save(state). onRemote(data) is called with the synced copy whenever
// it changes elsewhere; onError(message) when the synced copy cannot be written.
export async function openStore({ onRemote, onError }) {
  const claude = typeof window !== 'undefined' ? window.claude : undefined
  if (!claude?.use) return localStore
  let db, user
  try {
    ;[db, user] = await Promise.all([claude.use('db'), claude.use('user')])
  } catch {
    return localStore
  }
  const id = db && user ? await user.id() : null
  if (!id) return localStore

  const ref = db.doc(`data/users/${id}/state`)
  let pending = null
  let timer = null
  let chain = Promise.resolve()

  ref.onSnapshot(
    (snap) => {
      if (snap.metadata.hasPendingWrites) return
      onRemote(snap.exists ? snap.data() : null)
    },
    () => onError?.('הסנכרון נעצר. השינויים נשמרים במכשיר הזה.'),
  )

  // Writes are coalesced and sent one at a time, as the store asks.
  const flush = () => {
    if (!pending) return
    const body = pending
    pending = null
    chain = chain
      .then(() => ref.set(body))
      .catch((e) => {
        const quota = e?.code === 'quota_exceeded'
        onError?.(quota ? 'אין מקום לשמור עוד בחשבון. השינויים נשמרו במכשיר הזה.' : 'השמירה בחשבון נכשלה. השינויים נשמרו במכשיר הזה.')
      })
  }

  return {
    kind: 'cloud',
    save(state) {
      saveLocal(state)
      pending = JSON.parse(JSON.stringify(state))
      clearTimeout(timer)
      timer = setTimeout(flush, 500)
    },
  }
}
