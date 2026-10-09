// "What's in this video?": frames from a short video of the shopping go to Claude, and come
// back as a list of products to confirm one by one.
//
// Two ways to reach Claude:
// - inside claude.ai, through the artifact's `sample` capability, on the viewer's own account;
// - anywhere else, through the Anthropic API with the user's own API key, kept only in this
//   browser and sent only to Anthropic.

import { CATALOG, KINDS, MEAT_CATS, byKey, findByName } from './catalog.js'

export const MAX_FRAMES = 8
export const MODEL = 'claude-opus-5-5'
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm'

// The reply's shape. Strict JSON schema: every object closed, every field listed.
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'name', 'kind', 'count', 'confidence', 'frame'],
        properties: {
          key: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          name: { type: 'string' },
          kind: { type: 'string', enum: Object.keys(KINDS) },
          count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          confidence: { type: 'number' },
          frame: { type: 'integer' },
        },
      },
    },
  },
}

export function buildPrompt(frameCount) {
  const catalog = CATALOG.map((p) => `${p.key}: ${p.name}${p.cat ? ` (${MEAT_CATS[p.cat]})` : ''}`).join('\n')
  return `These ${frameCount} images are frames, in order, from a short video someone in Israel took of groceries they just brought home. Frame numbers start at 0.

List each distinct fruit, vegetable, fresh herb, meat, poultry, fish or deli meat you can see. Ignore everything else (dairy, bread, drinks, packaged dry goods, cleaning products). The same product seen in several frames is one entry.

For each product:
- key: its key from the catalog below when it is that product, otherwise null.
- name: the catalog's Hebrew name when key is set; otherwise a short Hebrew name for it.
- kind: "fruit", "veg" or "meat" (meat includes poultry, fish and deli meats; herbs count as "veg").
- count: how many units are visible (6 bananas, 2 packs of chicken thighs), or null when it is loose or uncountable (a bag of potatoes, a bunch).
- confidence: from 0 to 1, how sure you are that the product is there and is what you named.
- frame: the frame number where it is seen most clearly.

Include products you are less sure about with a lower confidence rather than leaving them out; the user will confirm each one.

Catalog (key: Hebrew name):
${catalog}

Reply with only JSON in this shape: {"items": [{"key": "banana", "name": "בננה", "kind": "fruit", "count": 6, "confidence": 0.95, "frame": 2}]}`
}

// Whatever came back, made safe and useful: known keys only, Hebrew names, one entry per
// product, most certain first.
export function cleanDetections(raw, frameCount) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
  const seen = new Map()
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const typed = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : ''
    const known = byKey(typeof r.key === 'string' ? r.key : null) ?? (typed ? findByName(typed) : null)
    const name = known?.name ?? typed
    if (!name) continue
    const kind = known?.kind ?? (Object.hasOwn(KINDS, r.kind) ? r.kind : 'veg')
    const count = Number.isInteger(r.count) && r.count > 0 && r.count < 1000 ? r.count : null
    const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0))
    const frame = Number.isInteger(r.frame) && r.frame >= 0 && r.frame < frameCount ? r.frame : 0
    const id = known?.key ?? 'name:' + name
    const prev = seen.get(id)
    if (prev && prev.confidence >= confidence) continue
    seen.set(id, {
      key: known?.key ?? null,
      name,
      emoji: known?.emoji ?? null,
      color: known?.color ?? null,
      kind,
      cat: known?.cat ?? null,
      count,
      confidence,
      frame,
    })
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence)
}

// Plain-language reasons, by what the user can do about each.
const MESSAGES = {
  not_granted: 'אין הרשאה להשתמש ב־Claude מהדף הזה. אפשר לאשר את זה בפעם הבאה שהדף שואל.',
  sampling_disabled: 'Claude לא זמין לחשבון הזה.',
  images_unavailable: 'שליחת תמונות ל־Claude לא זמינה כאן.',
  image_rejected: 'התמונות מהסרטון לא התקבלו. אפשר לנסות סרטון אחר, או תמונות.',
  rate_limited: 'יותר מדי בקשות כרגע. אפשר לנסות שוב בעוד כמה דקות.',
  session_expired: 'צריך להתחבר מחדש ל־Claude.',
  refused: 'הבקשה לא אושרה. אפשר לנסות סרטון אחר.',
  invalid_json: 'התשובה לא הייתה מובנת. אפשר לנסות שוב.',
  empty_completion: 'לא התקבלה תשובה. אפשר לנסות שוב.',
  auth: 'מפתח ה־API לא התקבל. בודקים אותו בהגדרות.',
  permission: 'למפתח ה־API הזה אין הרשאה להשתמש במודל.',
  connection: 'אין חיבור ל־Anthropic. בודקים את האינטרנט ומנסים שוב.',
  overloaded: 'השירות עמוס כרגע. אפשר לנסות שוב בעוד רגע.',
  too_long: 'הסרטון ארוך מדי לזיהוי אחד. אפשר לצלם סרטון קצר יותר.',
  failed: 'הזיהוי נכשל. אפשר לנסות שוב.',
}

export class VisionError extends Error {
  constructor(code, cause) {
    super(MESSAGES[code] ?? MESSAGES.failed)
    this.code = MESSAGES[code] ? code : 'failed'
    this.cause = cause
  }
}

// Which way to Claude this page has, if any: {kind, maxImages} or null.
export async function visionSource(apiKey) {
  const claude = typeof window !== 'undefined' ? window.claude : undefined
  if (claude?.use) {
    try {
      const sample = await claude.use('sample')
      const limits = sample ? await sample.limits().catch(() => null) : null
      if (limits?.images) return { kind: 'claude', sample, maxImages: Math.max(1, Math.min(MAX_FRAMES, limits.images.maxCount)) }
    } catch {}
  }
  if (apiKey) return { kind: 'api', apiKey, maxImages: MAX_FRAMES }
  return null
}

export async function recognize(source, frames, { signal } = {}) {
  const raw = source.kind === 'claude' ? await viaSample(source.sample, frames, signal) : await viaApi(source.apiKey, frames, signal)
  return cleanDetections(raw, frames.length)
}

async function viaSample(sample, frames, signal) {
  try {
    return await sample.json(buildPrompt(frames.length), { images: frames, signal, modelTier: 'default' })
  } catch (e) {
    if (e?.code === 'cancelled') throw e
    throw new VisionError(e?.code, e)
  }
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

let sdk = null

async function viaApi(apiKey, frames, signal) {
  let Anthropic
  try {
    sdk ??= import(/* @vite-ignore */ SDK_URL)
    Anthropic = (await sdk).default
  } catch (e) {
    sdk = null
    throw new VisionError('connection', e)
  }
  // The key belongs to the person using this page, on their own device.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const images = await Promise.all(
    frames.map(async (f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(f) } })),
  )
  let response
  try {
    response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        // Recognising products in a few photos is perception, not deep reasoning.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        // If a safety classifier declines, the API retries on the model Anthropic recommends.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: [...images, { type: 'text', text: buildPrompt(frames.length) }] }],
      },
      { signal },
    )
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) throw { code: 'cancelled' }
    if (e instanceof Anthropic.AuthenticationError) throw new VisionError('auth', e)
    if (e instanceof Anthropic.PermissionDeniedError) throw new VisionError('permission', e)
    if (e instanceof Anthropic.RateLimitError) throw new VisionError('rate_limited', e)
    if (e instanceof Anthropic.BadRequestError) throw new VisionError('image_rejected', e)
    if (e instanceof Anthropic.APIConnectionError) throw new VisionError('connection', e)
    if (e instanceof Anthropic.InternalServerError) throw new VisionError('overloaded', e)
    throw new VisionError('failed', e)
  }
  if (response.stop_reason === 'refusal') throw new VisionError('refused')
  if (response.stop_reason === 'max_tokens') throw new VisionError('too_long')
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new VisionError('empty_completion')
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new VisionError('invalid_json', e)
  }
}
