// Keeps the app opening offline, and brings it forward when a reminder is tapped.
// Bump VERSION whenever any file in SHELL changes, so installed copies pick it up.

const VERSION = 'betokef-v2'
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'logic.js', 'catalog.js', 'storage.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// Network first, so an update shows up on the next open; the cache answers when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? caches.match('index.html'))),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname))
      if (open) {
        open.navigate?.(self.registration.scope + '#check').catch(() => {})
        return open.focus()
      }
      return self.clients.openWindow('./#check')
    }),
  )
})
