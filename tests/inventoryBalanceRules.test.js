import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  calcStats,
  formatRows,
  normalizeInventoryBulkUpdates,
  normalizeInventoryRowIds,
  queryInventorySnapshotHistory,
  trimInventorySnapshots,
} from '../api/inventory-balance.js'
import { compareInventorySizes } from '../src/utils/inventorySizeSort.js'

function captureSql(strings, ...values) {
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values }
}

test('inventory sizes follow the warehouse display order', () => {
  const sizes = ['3XL', '12', 'M', '1X', 'XL', '8', 'S', '2X', 'XS', '1XL', '16', '6', 'L', '3X', '2XL', '14', '10']
  assert.deepEqual(sizes.sort(compareInventorySizes), [
    'XS', 'S', 'M', 'L', 'XL',
    '6', '8', '10', '12', '14', '16',
    '1X', '2X', '3X',
    '1XL', '2XL', '3XL',
  ])
})

test('negative inventory stays available internally but is displayed and totaled as zero', () => {
  assert.deepEqual(formatRows([{ id: 1, style: 'A', color: 'Black', size: 'M', quantity: -3 }])[0], {
    id: 1,
    Style: 'A',
    Color: 'Black',
    Size: 'M',
    Quantity: 0,
    RawQuantity: -3,
    style_n: 'A',
    color_n: 'Black',
    size_n: 'M',
  })
  assert.deepEqual(calcStats([{ quantity: -3 }, { quantity: 7 }, { quantity: 0 }]), {
    total_units: 7,
    skus_in_stock: 1,
    skus_zero: 2,
  })
  const emailSource = readFileSync(new URL('../lib/inventoryEmailApi.js', import.meta.url), 'utf8')
  assert.match(emailSource, /GREATEST\(quantity, 0\)::int AS quantity/)
})

test('inventory row deletion IDs are validated and deduplicated before mutation', () => {
  assert.deepEqual(normalizeInventoryRowIds([12, '7', 12]), [12, 7])
  assert.throws(() => normalizeInventoryRowIds([]), /ids required/)
  assert.throws(() => normalizeInventoryRowIds([0]), /positive whole-number/)
  assert.throws(() => normalizeInventoryRowIds(['7x']), /positive whole-number/)
  assert.throws(() => normalizeInventoryRowIds([1.5]), /positive whole-number/)
})

test('bulk inventory updates require unique valid IDs and quantities', () => {
  assert.deepEqual(normalizeInventoryBulkUpdates([
    { id: '12', quantity: '0' },
    { id: 7, quantity: 25 },
  ]), [
    { id: 12, quantity: 0 },
    { id: 7, quantity: 25 },
  ])
  assert.deepEqual(normalizeInventoryBulkUpdates([
    { id: '12', quantity: '96', expectedQuantity: '-2' },
  ]), [
    { id: 12, quantity: 96, expected_quantity: -2 },
  ])
  assert.throws(() => normalizeInventoryBulkUpdates([]), /updates required/)
  assert.throws(() => normalizeInventoryBulkUpdates([{ id: 0, quantity: 1 }]), /positive whole-number/)
  assert.throws(() => normalizeInventoryBulkUpdates([{ id: 1, quantity: -1 }]), /whole number of 0 or more/)
  assert.throws(() => normalizeInventoryBulkUpdates([
    { id: 1, quantity: 2, expectedQuantity: 1.5 },
  ]), /Expected quantity must be a whole number/)
  assert.throws(() => normalizeInventoryBulkUpdates([
    { id: 1, quantity: 2 },
    { id: 1, quantity: 3 },
  ]), /only be updated once/)
})

test('snapshot retention protects every active transaction rollback point', () => {
  const query = trimInventorySnapshots(captureSql)

  assert.match(query.text, /transactions\.rolled_back_at IS NULL/)
  assert.match(query.text, /transactions\.rollback_snapshot_id = snapshots\.id/)
  assert.match(query.text, /transactions\.rollback_snapshot_id = candidate\.id/)
  assert.deepEqual(query.values, [20])

  const apiSource = readFileSync(new URL('../api/inventory-balance.js', import.meta.url), 'utf8')
  assert.equal((apiSource.match(/DELETE FROM inventory_snapshots/g) || []).length, 1)
  assert.equal((apiSource.match(/trimInventorySnapshots\(txn\)/g) || []).length, 9)
})

test('snapshot history caps only ordinary snapshots and always includes active rollback points', () => {
  const query = queryInventorySnapshotHistory(captureSql)

  assert.match(query.text, /active_transaction_snapshot_ids AS MATERIALIZED/)
  assert.match(query.text, /SELECT id FROM active_transaction_snapshot_ids UNION SELECT id FROM recent_other_snapshot_ids/)
  assert.match(query.text, /JOIN visible_snapshot_ids visible ON visible\.id = snapshots\.id/)
  assert.equal((query.text.match(/ LIMIT /g) || []).length, 1)
  assert.deepEqual(query.values, [20])
})

test('oversold substitutions require matching style and size, available stock, and support undo', () => {
  const source = readFileSync(new URL('../api/inventory-balance.js', import.meta.url), 'utf8')
  assert.match(source, /CREATE TABLE IF NOT EXISTS inventory_substitutions/)
  assert.match(source, /original\.quantity < 0/)
  assert.match(source, /ABS\(original\.quantity\) >= \$\{quantity\}/)
  assert.match(source, /substitute\.quantity >= \$\{quantity\}/)
  assert.match(source, /LOWER\(BTRIM\(substitute\.style\)\) = LOWER\(BTRIM\(original\.style\)\)/)
  assert.match(source, /'substitution_undo'/)
})
