import test from 'node:test'
import assert from 'node:assert/strict'
import { orderSkuQuantity, limitReturnPackageQuantities } from '../src/utils/returnOrderQuantity.js'
import { parseSkuReturnManifestRows } from '../src/utils/returnImportEngine.js'

const order = (quantity = 1) => ({
  store_key: 'all stores', order_number: 'PO-ONE',
  items: [{ sku_id: '', sku_code: '0015lavander S', quantity }],
})
const pkg = (quantity = 3, colors = ['Lavander']) => ({
  store_key: 'garden', order_numbers: ['PO-ONE-D01', 'PO-ONE'],
  expected_units: quantity * colors.length,
  items: colors.map((color) => ({
    sku_id: '53241064876', sku_code: '0015lavander S',
    style: '5010015', color, size: 'S', source_qty: quantity, expected_qty: quantity,
  })),
})

test('legacy unique SKU code caps an inflated single-item return', () => {
  const [result] = limitReturnPackageQuantities([pkg()], [order()])
  assert.equal(result.expected_units, 1)
  assert.equal(result.items[0].source_qty, 1)
  assert.equal(result.items[0].expected_qty, 1)
})

test('quantity cap preserves different colors in a set and repeated pieces per product', () => {
  const input = pkg(3, ['WHITE', 'WINE'])
  input.items[1].expected_qty = 6
  const [result] = limitReturnPackageQuantities([input], [order()])
  assert.equal(result.expected_units, 3)
  assert.deepEqual(result.items.map((item) => [item.color, item.expected_qty]), [['WHITE', 1], ['WINE', 2]])
})

test('valid multiple purchased units and partial returns keep their quantity', () => {
  for (const count of [1, 2]) {
    const input = pkg(count)
    assert.equal(limitReturnPackageQuantities([input], [order(2)])[0], input)
  }
})

test('store-specific orders take precedence without double-counting All Stores or D suffixes', () => {
  const [result] = limitReturnPackageQuantities([pkg()], [order(4), { ...order(), store_key: 'garden' }])
  assert.equal(result.expected_units, 1)
})

test('distinct orders sharing one package retain their combined quantities', () => {
  const input = pkg()
  input.order_numbers.push('PO-TWO')
  const [result] = limitReturnPackageQuantities([input], [order(), { ...order(), order_number: 'PO-TWO' }])
  assert.equal(result.expected_units, 2)
})

test('ambiguous, contradictory, incomplete, or invalid order evidence does not lower quantities', () => {
  const input = pkg()
  for (const orders of [
    [], [order(), order()], [{ ...order(), store_key: 'house' }],
    [{ ...order(), items: [order().items[0], order().items[0]] }],
    [{ ...order(), items: [{ ...order().items[0], sku_id: 'OTHER' }] }],
    [order(0)], [order(1.5)],
  ]) assert.equal(limitReturnPackageQuantities([input], orders)[0], input)
  const missingOrder = { ...input, order_numbers: ['PO-ONE', 'PO-MISSING'] }
  assert.equal(limitReturnPackageQuantities([missingOrder], [order()])[0], missingOrder)
})

test('exact SKU ID wins over a code-only row; invalid exact quantities are not ignored', () => {
  const exact = { ...order().items[0], sku_id: 'ID', quantity: 2 }
  assert.equal(orderSkuQuantity({ items: [exact, order().items[0]] }, 'ID', exact.sku_code), 2)
  assert.equal(orderSkuQuantity({ items: [exact, { ...exact, quantity: 0 }] }, 'ID', exact.sku_code), null)
})

test('manifest preview caps duplicate rows using a legacy order with no SKU ID', () => {
  const row = { '订单号 PO': 'PO-ONE-D01', 'SKU ID': '53241064876', Tracking: 'RETURN', Quantity: 2 }
  const result = parseSkuReturnManifestRows([row, { ...row, '订单号 PO': 'PO-ONE' }], [{
    sku_id: '53241064876', sku_code: '0015lavander S', store_key: 'garden', store_name: 'Garden',
    status: 'ready', components: [{ style: '5010015', color: 'Lavander', size: 'S', qty: 1 }],
  }], [order()])
  assert.equal(result.packages[0].expectedUnits, 1)
  assert.equal(result.packages[0].items[0].sourceQty, 1)
  assert.equal(result.needsReview.length, 0)
})
