import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildInventoryOrderClaims, parseOrderHistoryRows } from '../src/utils/orderImportEngine.js'

const require = createRequire(import.meta.url)
const {
  normalizeInventoryQuantity,
  normalizeOrderClaims,
} = require('../lib/inventoryTransactionSafety.cjs')

test('parses historical orders without retaining buyer PII', () => {
  const result = parseOrderHistoryRows([
    {
      '\uFEFF订单号': 'PO-1',
      'SKU ID': '123\t',
      'SKU货号': 'M022BlackM',
      '商品属性': 'Black / M',
      '商品名称': 'Pants',
      '收货人姓名': 'Private Buyer',
      '详细地址1': 'Private Address',
      '订单创建时间': '7/28/26 10:00',
    },
  ])

  assert.equal(result.stats.orderCount, 1)
  assert.equal(result.orders[0].items[0].skuId, '123')
  assert.equal(result.orders[0].items[0].quantity, 1)
  assert.equal('收货人姓名' in result.orders[0], false)
  assert.equal(JSON.stringify(result).includes('Private Buyer'), false)
  assert.equal(JSON.stringify(result).includes('Private Address'), false)
})

test('preserves repeated rows as quantity within one order snapshot', () => {
  const rows = [1, 2].map(() => ({
    '订单号': 'PO-2',
    'SKU ID': '456',
    'SKU货号': '0015BlackM',
    '商品属性': 'Black / M',
    '运单号': '1Z123',
  }))
  const result = parseOrderHistoryRows(rows)

  assert.equal(result.stats.sourceRows, 2)
  assert.equal(result.stats.itemCount, 1)
  assert.equal(result.stats.unitCount, 2)
  assert.equal(result.orders[0].items[0].quantity, 2)
})

test('builds one stable inventory claim per logical order item', () => {
  const parsed = parseOrderHistoryRows([
    {
      '订单号': ' PO-2 ',
      'SKU货号': '0015BlackM',
      '商品属性': 'Black / M',
      '应履约件数': 1,
    },
    {
      '订单号': 'PO-2',
      'SKU货号': '0015BlackM',
      '商品属性': 'Black / M',
      '应履约件数': 2,
    },
  ])

  assert.deepEqual(buildInventoryOrderClaims(parsed.orders), [{
    orderKey: 'po-2',
    itemKey: 'item:0015blackm\u241fblack/m',
  }])
  assert.deepEqual(normalizeOrderClaims([
    { orderKey: ' PO-2 ', itemKey: ' SKU-A ' },
    { orderNumber: 'po-2', itemKey: 'sku-a' },
  ]), [{ orderKey: 'po-2', itemKey: 'sku-a' }])
})

test('inventory claims prefer stable SKU IDs over attribute formatting', () => {
  assert.deepEqual(buildInventoryOrderClaims([{
    orderNumber: 'PO-3',
    items: [
      { skuId: ' 12345 ', itemKey: '0015blackm\u241fblack / m' },
      { skuId: '12345', itemKey: '0015blackm\u241fBlack/M' },
    ],
  }]), [{
    orderKey: 'po-3',
    itemKey: 'sku:12345',
  }])
})

test('manual inventory quantities reject partial, negative, and non-numeric values', () => {
  assert.equal(normalizeInventoryQuantity('12'), 12)
  assert.throws(() => normalizeInventoryQuantity('12 boxes'), /whole number/)
  assert.throws(() => normalizeInventoryQuantity(1.5), /whole number/)
  assert.throws(() => normalizeInventoryQuantity(-1), /whole number/)
})

test('uses daily fulfillment quantity and aggregates shipment references', () => {
  const result = parseOrderHistoryRows([
    {
      '订单号': 'PO-3',
      'SKU货号': '0015BlackM',
      '商品属性': 'Black / M',
      '应履约件数': '2',
      '运单号': 'TRACK-A',
      '包裹号': 'PK-A',
    },
    {
      '订单号': 'PO-3',
      'SKU货号': '0015BlackM',
      '商品属性': 'Black / M',
      '应履约件数': '1',
      '运单号': 'TRACK-B',
      '包裹号': 'PK-B',
    },
  ])

  const item = result.orders[0].items[0]
  assert.equal(item.quantity, 3)
  assert.deepEqual(item.outboundTrackings, ['TRACK-A', 'TRACK-B'])
  assert.deepEqual(item.packageNumbers, ['PK-A', 'PK-B'])
})

test('flags conflicting SKU IDs instead of silently merging them', () => {
  const result = parseOrderHistoryRows([
    { '订单号': 'PO-4', 'SKU ID': 'A', 'SKU货号': 'STYLE1', '商品属性': 'Black / S' },
    { '订单号': 'PO-4', 'SKU ID': 'B', 'SKU货号': 'STYLE1', '商品属性': 'Black / S' },
  ])

  assert.equal(result.stats.conflicts, 1)
  assert.equal(result.orders[0].items.length, 2)
  assert.deepEqual(result.orders[0].items.map((item) => item.skuId).sort(), ['A', 'B'])
  assert.equal(result.conflicts[0].issue, 'same_sku_and_attributes_have_different_sku_ids')
})
