import { parseInventoryReceiptRows } from '../src/utils/inventoryReceiptUpload.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeStyleNames } from '../src/utils/styleNames.js'
import { fillTemplate } from '../src/utils/autoDeductEngine.js'

test('style identity updates preserve source IDs, unrelated text and quantities', () => {
  const input = { Style: ' old ', STYLE: 'OLD', style_n: 'Old', targetStyle: 'OLD', styleNumber: 'OLD', styles: ['OLD', 'NEW'],
    sku_code: 'OLD-BLACK-S', spu: 'OLD', productName: 'OLD', filename: 'OLD.csv', quantity: -3,
    source_hash: 'OLD', item_key: 'sku:OLD', nested: [{ style: 'OLD', color: 'OLD' }] }
  assert.deepEqual(canonicalizeStyleNames(input, { OLD: 'NEW' }), { ...input,
    Style: 'NEW', STYLE: 'NEW', style_n: 'NEW', targetStyle: 'NEW', styleNumber: 'NEW', styles: ['NEW'], nested: [{ style: 'NEW', color: 'OLD' }] })
  assert.equal(input.Style, ' old ')
})

test('warehouse overrides, request targets and snapshot keys follow style rename without silent merging', () => {
  const oldKey = 'sku:["old","black","s"]', newKey = 'sku:["new","black","s"]'
  const actual = canonicalizeStyleNames({ overrides: { [oldKey]: { ready_qty: 2 } }, target: oldKey,
    rows: [{ style: 'OLD', key: '["old","black","s"]' }] }, { OLD: 'NEW' })
  assert.deepEqual(actual.overrides, { [newKey]: { ready_qty: 2 } })
  assert.equal(actual.target, newKey)
  assert.equal(actual.rows[0].key, '["new","black","s"]')
  assert.throws(() => canonicalizeStyleNames({ [oldKey]: 1, [newKey]: 2 }, { OLD: 'NEW' }), /conflict/)
})

test('old source names and saved mappings fill the new inventory without changing source claims', () => {
  const template = [{ STYLE: 'NEW', COLOR: 'BLACK', SIZE: 'S' }]
  const sales = [{ style: 'OLD', color: 'BLACK', size: 'S', QTY: 3 }]
  const result = fillTemplate(template, sales, {}, { OLD: 'NEW' })
  assert.equal(result.unmatchedRows.length, 0)
  assert.equal(result.filledRows[0].STYLE, 'NEW')
  assert.equal(result.filledRows[0].QTY, 3)
  assert.equal(sales[0].style, 'OLD')
  const mapped = fillTemplate(template, [{ ...sales[0], color: 'BK' }], {
    'old::bk': { STYLE: 'OLD', COLOR: 'BLACK', _confirmed: true },
  }, { OLD: 'NEW' })
  assert.equal(mapped.filledRows[0].QTY, 3)
})

test('receipt files using an old style name resolve to the current stock row', () => {
  const parsed = parseInventoryReceiptRows([{ Style: 'OLD', Color: 'BLACK', Size: 'S', 'Received Quantity': 4 }],
    [{ id: 1, Style: 'NEW', Color: 'BLACK', Size: 'S', Quantity: 6 }], { OLD: 'NEW' })
  assert.equal(parsed[0].style, 'NEW')
  assert.equal(parsed[0].quantity, 4)
  assert.equal(parsed[0].current, 6)
})
