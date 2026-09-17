import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { migrateReturnsSchema } from '../lib/returnsSchema.js'
import { computeReturnAnalytics } from '../lib/returnAnalytics.js'
import { readReturnAnalytics, respondWithReturnAnalytics } from '../lib/returnAnalyticsCache.js'

let db
let sql
before(async () => {
  db = new PGlite()
  sql = async (strings, ...values) => {
    const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
    return (await db.query(query, values)).rows
  }
  await migrateReturnsSchema(sql)
  await db.exec(`
    INSERT INTO return_product_catalog (store_key, store_name, sku_id, sku_code, components, status)
    VALUES ('house', 'House', '100', 'STYLE-BLACK-M',
      '[{"style":"STYLE","color":"BLACK","size":"M","qty":1}]', 'ready'),
      ('garden', 'Garden', '200', 'STYLE-WHITE-M',
      '[{"style":"STYLE","color":"WHITE","size":"M","qty":1}]', 'ready');
    INSERT INTO return_orders (id, store_key, store_name, order_key, order_number, order_created_at)
    VALUES (1, 'house', 'House', 'PO-1', 'PO-1', NOW() - INTERVAL '3 days'),
      (2, 'garden', 'Garden', 'PO-2', 'PO-2', NOW() - INTERVAL '60 days');
    INSERT INTO return_order_items (order_id, item_key, sku_id, sku_code, attributes, quantity)
    VALUES (1, 'sku:100', '100', 'STYLE-BLACK-M', 'BLACK M', 2),
      (2, 'sku:200', '200', 'STYLE-WHITE-M', 'WHITE M', 5);
    INSERT INTO return_packages (id, tracking_number, tracking_key, status, store_key, store_name,
      order_numbers, confirmed_at, expected_units, actual_units, restock_units)
    VALUES (1, 'TRACK1', 'TRACK1', 'received', 'house', 'House', '["PO-1"]', NOW(), 2, 2, 2),
      (2, 'TRACK2', 'TRACK2', 'received', 'house', 'House', '["PO-1"]', NOW(), 2, 2, 2),
      (3, 'TRACK3', 'TRACK3', 'received', 'garden', 'Garden', '["PO-2"]', NOW() - INTERVAL '40 days', 1, 1, 1);
    INSERT INTO return_package_items (package_id, sku_id, sku_code, style, color, size, expected_qty, actual_qty, source_qty, restock_qty)
    VALUES (1, '100', 'STYLE-BLACK-M', 'STYLE', 'BLACK', 'M', 2, 2, 2, 2),
      (2, '100', 'STYLE-BLACK-M', 'STYLE', 'BLACK', 'M', 2, 2, 2, 2),
      (3, '200', 'STYLE-WHITE-M', 'STYLE', 'WHITE', 'M', 1, 1, 1, 1);
    INSERT INTO inventory_transactions (id, transaction_type, source_file, applied_by, applied_at, rolled_back_at)
    VALUES (1, 'sales', 'active', 'admin', NOW(), NULL),
      (2, 'sales', 'reversed', 'admin', NOW(), NOW()),
      (3, 'sales', 'legacy-reversed', 'admin', NOW(), NOW());
    INSERT INTO inventory_txn_rows (txn_type, style, color, size, qty, transaction_id, business_day, source_file, applied_by, applied_at)
    VALUES ('sales', 'STYLE', 'BLACK', 'M', 2, 1, CURRENT_DATE, 'active', 'admin', NOW()),
      ('sales', 'STYLE', 'BLACK', 'M', 99, 2, CURRENT_DATE, 'reversed', 'admin', NOW()),
      ('sales', 'STYLE', 'BLACK', 'M', 50, NULL, NULL, 'legacy-reversed', 'admin', NOW());
  `)
})
after(async () => { await db?.close() })

test('analytics SQL preserves periods, store separation, return caps and rollback exclusion', async () => {
  const recent = await computeReturnAnalytics(sql, 30)
  assert.equal(recent.summary.inventory_physical_units, 2)
  assert.equal(recent.summary.sold_product_units, 2)
  assert.equal(recent.skuRows.length, 1)
  assert.equal(recent.skuRows[0].store_key, 'house')
  assert.equal(recent.skuRows[0].returned_product_units, 2)
  assert.equal(Number(recent.skuRows[0].return_rate), 100)
  const lifetime = await computeReturnAnalytics(sql, 'all')
  assert.equal(lifetime.summary.sold_product_units, 7)
  assert.equal(lifetime.skuRows.length, 2)
  assert.equal(Number(lifetime.skuRows.find(row => row.store_key === 'garden').return_rate), 20)
})

test('persistent cache survives callers, explicit refresh bypasses it and expired data recomputes', async () => {
  let calls = 0
  const compute = async () => ({ summary: { count: ++calls }, days: 90 })
  const first = await readReturnAnalytics(sql, 90, { compute })
  const second = await readReturnAnalytics(sql, 90, { compute })
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.summary.count, 1)
  assert.equal(calls, 1)
  const refreshed = await readReturnAnalytics(sql, 90, { compute, refresh: true })
  assert.equal(refreshed.summary.count, 2)
  await db.exec("UPDATE return_analytics_cache SET generated_at = NOW() - INTERVAL '2 minutes' WHERE period = '90'")
  assert.equal((await readReturnAnalytics(sql, 90, { compute })).summary.count, 3)
})

test('simultaneous requests share a calculation and a failed calculation can retry', async () => {
  let calls = 0
  let finish
  const compute = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  const first = readReturnAnalytics(sql, 365, { compute, refresh: true })
  const second = readReturnAnalytics(sql, 365, { compute, refresh: true })
  finish({ summary: { count: 1 } })
  assert.deepEqual(await first, await second)
  assert.equal(calls, 1)
  await assert.rejects(readReturnAnalytics(sql, 365, {
    refresh: true, compute: async () => { throw new Error('test failure') },
  }), /test failure/)
  assert.equal((await readReturnAnalytics(sql, 365)).cached, true)
})

test('invalid periods fail before reaching the database', async () => {
  let status
  const response = { status(code) { status = code; return this }, json(value) { return value } }
  await respondWithReturnAnalytics(() => { throw new Error('must not query') }, { query: { days: '-1' } }, response)
  assert.equal(status, 400)
})
