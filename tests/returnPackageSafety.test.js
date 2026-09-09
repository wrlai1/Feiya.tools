import test from 'node:test'
import assert from 'node:assert/strict'
import returnPackageSafety from '../lib/returnPackageSafety.cjs'
import { inventoryMappingFromPackageItems } from '../src/utils/returnInspection.js'

const { canResolveReturnItems, replaceSelectedReturnPackageItems } = returnPackageSafety

test('item selection is available for pending packages that require resolution', () => {
  assert.equal(canResolveReturnItems({
    status: 'pending',
    requires_item_resolution: true,
  }), true)
})

test('item selection remains available for Admin Review packages', () => {
  assert.equal(canResolveReturnItems({
    status: 'needs_review',
    requires_item_resolution: true,
  }), true)
})

test('item selection is blocked for completed or already-resolved packages', () => {
  assert.equal(canResolveReturnItems({
    status: 'received',
    requires_item_resolution: true,
  }), false)
  assert.equal(canResolveReturnItems({
    status: 'pending',
    requires_item_resolution: false,
  }), false)
})

test('existing package lines provide the inventory mapping for the selected order product', () => {
  assert.deepEqual(inventoryMappingFromPackageItems({
    sku_id: '62965207483',
    sku_code: '0090black+ink+denim M',
  }, [
    { sku_id: '62965207483', style: '5020090', color: 'BLACK', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: '62965207483', style: '5020090', color: 'DENIM', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: '62965207483', style: '5020090', color: 'INK', size: 'M', expected_qty: 1, source_qty: 1 },
  ]), [
    { style: '5020090', color: 'BLACK', size: 'M', qty: 1 },
    { style: '5020090', color: 'DENIM', size: 'M', qty: 1 },
    { style: '5020090', color: 'INK', size: 'M', qty: 1 },
  ])
})

test('selected products replace their old automatic match without duplicating other products', () => {
  const existing = [
    { sku_id: 'SET', sku_code: 'SETM', style: '5020090', color: 'BLACK', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: 'SET', sku_code: 'SETM', style: '5020090', color: 'DENIM', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: 'OTHER', sku_code: 'OTHER-L', style: 'OTHER', color: 'NAVY', size: 'L', expected_qty: 1, source_qty: 1 },
  ]
  const resolved = [
    { sku_id: 'SET', sku_code: 'SETM', style: '5020090', color: 'BLACK', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: 'SET', sku_code: 'SETM', style: '5020090', color: 'DENIM', size: 'M', expected_qty: 1, source_qty: 1 },
    { sku_id: 'SET', sku_code: 'SETM', style: '5020090', color: 'INK', size: 'M', expected_qty: 1, source_qty: 1 },
  ]

  const items = replaceSelectedReturnPackageItems(existing, resolved, [{
    sku_id: 'SET',
    sku_code: 'SETM',
  }])

  assert.equal(items.reduce((sum, item) => sum + item.expected_qty, 0), 4)
  assert.deepEqual(items.map((item) => item.color), ['NAVY', 'BLACK', 'DENIM', 'INK'])
})
