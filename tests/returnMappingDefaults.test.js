import test from 'node:test'
import assert from 'node:assert/strict'
import { updateReturnMappingTarget, newReturnMappingTarget } from '../src/utils/returnMappingDefaults.js'

test('first style fills only unassigned pieces, preserving explicit mixed styles', () => {
  const targets = [
    { style: '', color: '', size: '', qty: 1 },
    { style: '', color: '', size: '', qty: 2 },
    { style: 'OTHER', color: 'RED', size: 'M', qty: 1 },
  ]
  const next = updateReturnMappingTarget(targets, 0, { style: '853105 MISSY', color: '', size: '' })
  assert.equal(next[1].style, '853105 MISSY')
  assert.equal(next[1].qty, 2)
  assert.deepEqual(next[2], targets[2])
  assert.equal(targets[0].style, '')
  const changed = updateReturnMappingTarget(next, 1, { style: 'M017 MISSY', color: '', size: '' })
  assert.equal(changed[0].style, '853105 MISSY')
  assert.equal(changed[1].style, 'M017 MISSY')
})

test('new piece inherits a style but never guesses color, size or quantity', () => {
  assert.deepEqual(newReturnMappingTarget([{ style: 'M017 MISSY', color: 'BLACK', size: 'XL', qty: 5 }]),
    { style: 'M017 MISSY', color: '', size: '', qty: 1 })
  assert.deepEqual(newReturnMappingTarget([]), { style: '', color: '', size: '', qty: 1 })
})
