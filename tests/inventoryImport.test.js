import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCSV } from '../src/utils/autoDeductEngine.js'
import {
  inventoryRowsToCsv,
  normalizeInventoryImportRows,
} from '../src/utils/inventoryImport.js'

test('inventory import accepts only complete, nonnegative whole-unit rows', () => {
  const result = normalizeInventoryImportRows([
    { Style: '5010015', Color: 'Black', Size: 'M', Quantity: '1,250' },
    { Style: '5010015', Color: 'Navy', Size: 'L', Quantity: 0 },
  ])
  assert.equal(result.totalUnits, 1250)
  assert.deepEqual(result.rows.map((row) => row.Quantity), [1250, 0])
  assert.throws(
    () => normalizeInventoryImportRows([{ Style: 'A', Color: 'B', Size: 'M', Quantity: '12pcs' }]),
    /whole number/,
  )
  assert.throws(
    () => normalizeInventoryImportRows([{ Style: 'A', Color: 'B', Size: 'M', Quantity: '' }]),
    /required/,
  )
})

test('inventory import rejects duplicate identities before replacing stock', () => {
  assert.throws(
    () => normalizeInventoryImportRows([
      { Style: '5010015', Color: 'Black', Size: '1XL', Quantity: 10 },
      { Style: '5010015', Color: ' black ', Size: '1X', Quantity: 20 },
    ]),
    /same inventory SKU/,
  )
})

test('inventory CSV export round-trips commas, quotes, and newlines', () => {
  const csv = inventoryRowsToCsv([
    { Style: 'A"1', Color: 'Navy, Blue\nWash', Size: 'M', Quantity: 12 },
  ])
  const [row] = parseCSV(csv.replace(/^\uFEFF/, ''))
  assert.equal(row.Style, 'A"1')
  assert.equal(row.Color, 'Navy, Blue\nWash')
  assert.equal(row.Quantity, '12')
})
