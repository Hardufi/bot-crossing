import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, cleanDetections, recognize, visionSource, VisionError, MAX_FRAMES, SCHEMA } from '../vision.js'
import { CATALOG } from '../catalog.js'

test('the prompt names every catalog product and the frame count', () => {
  const p = buildPrompt(6)
  assert.match(p, /These 6 images/)
  for (const item of CATALOG) assert.ok(p.includes(`${item.key}: ${item.name}`), item.key)
})

test('the reply schema is strict: every object closed, every field required', () => {
  const walk = (node) => {
    if (node?.type === 'object') {
      assert.equal(node.additionalProperties, false)
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort())
      Object.values(node.properties).forEach(walk)
    }
    if (node?.type === 'array') walk(node.items)
    node?.anyOf?.forEach(walk)
  }
  walk(SCHEMA)
})

test('detections are cleaned, merged and ordered by certainty', () => {
  const out = cleanDetections(
    {
      items: [
        { key: 'banana', name: 'בננות', kind: 'fruit', count: 6, confidence: 0.9, frame: 1 },
        { key: 'banana', name: 'בננה', kind: 'fruit', count: 5, confidence: 0.7, frame: 3 }, // the same product, less sure
        { key: null, name: 'עגבניות', kind: 'veg', count: null, confidence: 0.8, frame: 9 }, // a catalog name without the key; frame out of range
        { key: 'unicorn', name: 'פיטאיה', kind: 'fruit', count: 2.5, confidence: 3, frame: 2 }, // unknown key: kept as typed
        { key: 'salmon', name: 'x', kind: 'veg', count: 1, confidence: 0.4, frame: 0 }, // catalog kind wins
        { key: null, name: '   ', kind: 'veg', count: 1, confidence: 1, frame: 0 }, // no name: dropped
        null,
        'nonsense',
      ],
    },
    4,
  )
  assert.deepEqual(
    out.map((d) => [d.key, d.name, d.kind, d.count, d.confidence, d.frame]),
    [
      [null, 'פיטאיה', 'fruit', null, 1, 2],
      ['banana', 'בננה', 'fruit', 6, 0.9, 1],
      ['tomato', 'עגבנייה', 'veg', null, 0.8, 0],
      ['salmon', 'סלמון', 'meat', 1, 0.4, 0],
    ],
  )
  assert.equal(out[1].emoji, '🍌')
  assert.equal(out[3].cat, 'fish')
})

test('anything that is not a list of detections gives nothing', () => {
  for (const raw of [null, 'x', 42, {}, { items: 'x' }]) assert.deepEqual(cleanDetections(raw, 3), [])
  assert.equal(cleanDetections([{ key: 'apple', name: 'תפוח', kind: 'fruit', count: 3, confidence: 0.9, frame: 0 }], 1).length, 1)
})

// A stand-in for the artifact's `sample` capability: records each request, answers from `reply`.
function fakeSample(reply) {
  const calls = []
  return {
    calls,
    async limits() {
      return { images: { maxCount: 20 } }
    },
    async json(prompt, { images }) {
      calls.push({ prompt, images })
      return reply(images, calls.length - 1)
    },
  }
}

test('more frames than one request carries go in batches, frame numbers kept in the whole set', async () => {
  const sample = fakeSample((images, n) =>
    n === 0
      ? { items: [{ key: 'banana', name: 'בננה', kind: 'fruit', count: 6, confidence: 0.6, frame: 2 }] }
      : n === 1
        ? { items: [{ key: 'banana', name: 'בננה', kind: 'fruit', count: 6, confidence: 0.9, frame: 1 }, { key: 'apple', name: 'תפוח', kind: 'fruit', count: 3, confidence: 0.8, frame: 7 }] }
        : { items: [{ key: 'lemon', name: 'לימון', kind: 'fruit', count: null, confidence: 0.7, frame: 0 }] },
  )
  const frames = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']
  const out = await recognize({ kind: 'claude', sample, maxImages: 3 }, frames)
  assert.deepEqual(sample.calls.map((c) => c.images), [['f0', 'f1', 'f2'], ['f3', 'f4', 'f5'], ['f6']])
  assert.match(sample.calls[2].prompt, /These 1 images/)
  // The surer sighting of the bananas wins, at its place in the whole set; a frame number outside
  // its batch falls back to the batch's first frame.
  assert.deepEqual(out.map((d) => [d.key, d.frame]), [['banana', 4], ['apple', 3], ['lemon', 6]])
})

test('errors say what can be done about them', () => {
  const flags = (code) => {
    const e = new VisionError(code)
    return [e.code, e.retry, e.settings, e.permanent]
  }
  assert.deepEqual(flags('rate_limited'), ['rate_limited', true, false, false])
  assert.deepEqual(flags('too_long'), ['too_long', true, false, false])
  assert.deepEqual(flags('bad_request'), ['bad_request', false, true, false])
  assert.deepEqual(flags('auth'), ['auth', false, true, false])
  assert.deepEqual(flags('refused'), ['refused', false, false, false])
  assert.deepEqual(flags('not_granted'), ['not_granted', false, false, true])
  assert.deepEqual(flags('toString'), ['failed', true, false, false])
  assert.deepEqual(flags(undefined), ['failed', true, false, false])
  assert.equal(new VisionError('bad_request', null, 'credit balance is too low').detail, 'credit balance is too low')
})

test('a stop passes through as a stop; a refusal of consent closes the claude.ai route', async () => {
  const stopped = fakeSample(() => {
    throw { code: 'cancelled' }
  })
  await assert.rejects(recognize({ kind: 'claude', sample: stopped, maxImages: 3 }, ['f0']), (e) => e.code === 'cancelled' && !(e instanceof VisionError))

  const declined = fakeSample(() => {
    throw Object.assign(new Error('no'), { code: 'not_granted' })
  })
  globalThis.window = { claude: { use: async () => declined } }
  try {
    const source = await visionSource('sk-ant-test')
    assert.equal(source.kind, 'claude')
    assert.equal(source.maxImages, MAX_FRAMES)
    await assert.rejects(recognize(source, ['f0']), (e) => e instanceof VisionError && e.code === 'not_granted' && e.permanent)
    assert.deepEqual(await visionSource('sk-ant-test'), { kind: 'api', apiKey: 'sk-ant-test', maxImages: MAX_FRAMES })
    assert.equal(await visionSource(null), null)
  } finally {
    delete globalThis.window
  }
})
