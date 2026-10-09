import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, cleanDetections, SCHEMA } from '../vision.js'
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
