const test = require('node:test')
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { normalizeReceipt, receiveInventory } = require('../lib/inventoryReceipt.cjs')
const row = { id: 1, style: '0055', color: 'DENIM', size: 'S', quantity: 20 }
test('rejects invalid receipts and duplicate rows before any write', () => {
  for (const quantity of ['', -1, 0, 1.5, true, 'abc']) assert.throws(() => normalizeReceipt({ reference: 'A', rows: [{ ...row, quantity }] }))
  assert.throws(() => normalizeReceipt({ reference: '', rows: [row] }))
  assert.throws(() => normalizeReceipt({ reference: 'A', rows: [row, row] }))
  assert.equal(normalizeReceipt({ reference: 'A', rows: [row] }).hash, normalizeReceipt({ reference: 'a', rows: [row] }).hash)
})
test('receipts atomically increment latest stock, record IN, and prevent duplicate references', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE inventory_balance(id SERIAL PRIMARY KEY, style TEXT,color TEXT,size TEXT,quantity INT,sort_order INT,updated_at TIMESTAMPTZ);
      INSERT INTO inventory_balance VALUES(1,'0055','DENIM','S',80,1,NOW()),(2,'0055','DENIM','M',-5,2,NOW());
      CREATE TABLE inventory_snapshots(id SERIAL PRIMARY KEY,label TEXT,source_name TEXT,data JSONB,total_rows INT,total_units INT);
      CREATE TABLE inventory_transactions(id SERIAL PRIMARY KEY,transaction_type TEXT,source_file TEXT,source_hash TEXT,applied_units INT,row_count INT,applied_by TEXT,rollback_snapshot_id INT,rolled_back_at TIMESTAMPTZ);
      CREATE TABLE inventory_txn_rows(transaction_id INT,txn_type TEXT,style TEXT,color TEXT,size TEXT,qty INT,source_file TEXT,applied_by TEXT,business_day DATE);`)
    const sql = (strings, ...values) => ({ query: strings.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), values })
    sql.transaction = async (build) => db.transaction(async (tx) => {
      const result = []
      for (const stmt of build(sql)) result.push((await tx.query(stmt.query, stmt.values)).rows)
      return result
    })
    const receipt = normalizeReceipt({ reference: 'DELIVERY-1', rows: [row, { ...row, id: 2, size: 'M', quantity: 10 }] })
    await db.exec('UPDATE inventory_balance SET quantity=90 WHERE id=1')
    assert.equal((await receiveInventory(sql, receipt, 'admin')).updated, 2)
    assert.deepEqual((await db.query('SELECT quantity FROM inventory_balance ORDER BY id')).rows.map(r => r.quantity), [110, 5])
    assert.deepEqual((await db.query('SELECT txn_type,qty FROM inventory_txn_rows ORDER BY qty DESC')).rows, [{ txn_type: 'in', qty: 20 }, { txn_type: 'in', qty: 10 }])
    const before = (await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows
    assert.equal((await receiveInventory(sql, receipt, 'admin')).duplicate, true)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, before)
    const missing = normalizeReceipt({ reference: 'DELIVERY-2', rows: [row, { ...row, id: 99, color: 'MISSING' }] })
    assert.equal((await receiveInventory(sql, missing, 'admin')).updated, 0)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, before)
    const changedSku = normalizeReceipt({ reference: 'DELIVERY-3', rows: [{ ...row, color: 'OTHER' }] })
    assert.equal((await receiveInventory(sql, changedSku, 'admin')).updated, 0)
    await db.exec('UPDATE inventory_balance SET quantity=2147483640 WHERE id=1')
    assert.equal((await receiveInventory(sql, normalizeReceipt({ reference: 'OVERFLOW', rows: [row] }), 'admin')).updated, 0)
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM inventory_snapshots')).rows[0].n, 1)
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM inventory_transactions')).rows[0].n, 1)
    await db.exec("UPDATE inventory_balance SET quantity=110 WHERE id=1; INSERT INTO inventory_balance(id,style,color,size,quantity,sort_order) VALUES(3,'95445','BLACK','6',10,3); SELECT setval(pg_get_serial_sequence('inventory_balance','id'),3)")
    const multi = normalizeReceipt({ reference: 'MULTI', rows: [row, { style: '0055', color: 'NEW BLUE', size: 'M', quantity: 30 }, { style: '95445', color: 'NEW GREEN', size: '6', quantity: 40 }] })
    const saved = await receiveInventory(sql, multi, 'admin')
    assert.equal(saved.updated, 3)
    assert.equal(saved.added, 2)
    assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE id=1")).rows[0].quantity, 130)
    assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE color='NEW BLUE'")).rows[0].quantity, 30)
    assert.equal((await receiveInventory(sql, multi, 'admin')).updated, 0)
    const race = normalizeReceipt({ reference: 'NEXT', rows: [{ style: '0055', color: 'new blue', size: 'M', quantity: 5 }] })
    assert.equal((await receiveInventory(sql, race, 'admin')).added, 0)
    assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE color='NEW BLUE'")).rows[0].quantity, 35)
    const state = (await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows
    for (const extra of [{ style: 'UNKNOWN', color: 'BLUE', size: 'M', quantity: 1 }, { style: '0055', color: 'BLUE', size: 'NEW SIZE', quantity: 1 }]) {
      assert.equal((await receiveInventory(sql, normalizeReceipt({ reference: 'INVALID-'+extra.style+extra.size, rows: [row, extra] }), 'admin')).updated, 0)
      assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, state)
    }

  } finally { await db.close() }
})
