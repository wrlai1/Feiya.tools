import test from 'node:test'
import assert from 'node:assert/strict'

import { validBusinessDay } from '../api/inventory-balance.js'

test('inventory movement dates accept real calendar days only', () => {
  assert.equal(validBusinessDay('2026-08-03'), '2026-08-03')
  assert.equal(validBusinessDay('2026-02-29'), '')
  assert.equal(validBusinessDay('2026-13-03'), '')
  assert.equal(validBusinessDay('08/03/2026'), '')
  assert.equal(validBusinessDay(''), '')
})
