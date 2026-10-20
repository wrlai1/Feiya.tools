import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStyleRenames, parseStyleRenamePaste } from '../src/utils/styleRenames.js'

test('Excel two-column paste accepts headers, Chinese names and Windows newlines', () => {
  assert.deepEqual(parseStyleRenamePaste('原名称\t新名称\r\n A \t A-NEW \r\nB\tB-NEW\r\n'), [
    { oldStyle: 'A', newStyle: 'A-NEW' }, { oldStyle: 'B', newStyle: 'B-NEW' },
  ])
  assert.deepEqual(parseStyleRenamePaste('Old Style\tNew Style\nA\tNEW'), [{ oldStyle: 'A', newStyle: 'NEW' }])
  assert.throws(() => parseStyleRenamePaste('A\tNEW\tEXTRA'), /two columns/)
  assert.deepEqual(parseStyleRenamePaste('A\t\nB\tB-NEW'), [{ oldStyle: 'A', newStyle: '' }, { oldStyle: 'B', newStyle: 'B-NEW' }])
})

test('bulk rename rejects duplicate sources, reporting-equivalent destinations, incomplete rows and oversize batches', () => {
  assert.throws(() => normalizeStyleRenames([]), /1–200/)
  assert.throws(() => normalizeStyleRenames([{ oldStyle: 'A', newStyle: 'X' }, { oldStyle: ' a ', newStyle: 'Y' }]), /more than once/)
  assert.throws(() => normalizeStyleRenames([{ oldStyle: 'A', newStyle: 'N-E_W' }, { oldStyle: 'B', newStyle: 'new' }]), /More than one/)
  for (const change of [null, {}, { oldStyle: 'A', newStyle: '' }, { oldStyle: 'A', newStyle: 'A' }, { oldStyle: 'A', newStyle: 'X'.repeat(101) }]) {
    assert.throws(() => normalizeStyleRenames([change]), /Row 1/)
  }
  assert.throws(() => normalizeStyleRenames(Array.from({ length: 201 }, (_, i) => ({ oldStyle: `A${i}`, newStyle: `B${i}` }))), /1–200/)
  assert.deepEqual(normalizeStyleRenames([{ oldStyle: 'A', newStyle: 'a' }]), [{ oldStyle: 'A', newStyle: 'a' }])
})
