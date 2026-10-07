// A tiny static server for trying the app locally: `node groceries/serve.mjs`.
// Any static host works just as well (GitHub Pages, Netlify, `python3 -m http.server`).

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT) || 5280
const HOST = process.env.HOST || '127.0.0.1'
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

createServer(async (req, res) => {
  let path
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    res.writeHead(400).end()
    return
  }
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path))
  if (!file.startsWith(ROOT) || file.includes(`${ROOT}test`)) {
    res.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, HOST, () => console.log(`בתוקף: http://${HOST}:${PORT}/`))
