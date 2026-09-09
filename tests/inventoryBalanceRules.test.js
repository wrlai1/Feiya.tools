import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  normalizeInventoryRowIds,
  queryInventorySnapshotHistory,
  trimInventorySnapshots,
} from '../api/inventory-balance.js'

function captureSql(strings, ...values) {
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values }
}

test('inventory row deletion IDs are validated and deduplicated before mutation', () => {
  assert.deepEqual(normalizeInventoryRowIds([12, '7', 12]), [12, 7])
  assert.throws(() => normalizeInventoryRowIds([]), /ids required/)
  assert.throws(() => normalizeInventoryRowIds([0]), /positive whole-number/)
  assert.throws(() => normalizeInventoryRowIds(['7x']), /positive whole-number/)
  assert.throws(() => normalizeInventoryRowIds([1.5]), /positive whole-number/)
})

test('snapshot retention protects every active transaction rollback point', () => {
  const query = trimInventorySnapshots(captureSql)

  assert.match(query.text, /transactions\.rolled_back_at IS NULL/)
  assert.match(query.text, /transactions\.rollback_snapshot_id = snapshots\.id/)
  assert.match(query.text, /transactions\.rollback_snapshot_id = candidate\.id/)
  assert.deepEqual(query.values, [20])

  const apiSource = readFileSync(new URL('../api/inventory-balance.js', import.meta.url), 'utf8')
  assert.equal((apiSource.match(/DELETE FROM inventory_snapshots/g) || []).length, 1)
  assert.equal((apiSource.match(/trimInventorySnapshots\(txn\)/g) || []).length, 5)
})

test('snapshot history caps only ordinary snapshots and always includes active rollback points', () => {
  const query = queryInventorySnapshotHistory(captureSql)

  assert.match(query.text, /active_transaction_snapshot_ids AS MATERIALIZED/)
  assert.match(query.text, /SELECT id FROM active_transaction_snapshot_ids UNION SELECT id FROM recent_other_snapshot_ids/)
  assert.match(query.text, /JOIN visible_snapshot_ids visible ON visible\.id = snapshots\.id/)
  assert.equal((query.text.match(/ LIMIT /g) || []).length, 1)
  assert.deepEqual(query.values, [20])
})
