import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import handler, { loadWarehouseSources, saveWarehouseState, saveWarehouseSnapshots } from '../lib/warehouseAlertsApi.js'
function tagged(db) { return async (strings, ...values) => (await db.query(strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ''), ''), values)).rows }
test('revision guard prevents concurrent saves and does not persist a rejected audit', async () => {
  const db = new PGlite(), sql = tagged(db)
  try {
    await db.exec("CREATE TABLE warehouse_alert_data (key TEXT PRIMARY KEY, value JSONB, revision INTEGER DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW()); INSERT INTO warehouse_alert_data (key,value) VALUES ('state','{}')")
    assert.equal((await saveWarehouseState(sql, { audit: ['first'] }, 0))[0].revision, 1)
    assert.deepEqual(await saveWarehouseState(sql, { audit: ['stale'] }, 0), [])
    assert.deepEqual((await db.query("SELECT value FROM warehouse_alert_data WHERE key='state'")).rows[0].value.audit, ['first'])
  } finally { await db.close() }
})
test('cron respects New York 6 PM across DST and preserves the first daily and Friday snapshots', async () => {
  const db = new PGlite(), sql = tagged(db)
  try {
    await db.exec('CREATE TABLE warehouse_alert_data (key TEXT PRIMARY KEY, value JSONB, revision INTEGER DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())')
    await saveWarehouseSnapshots(sql, { marker: 'early' }, new Date('2026-10-02T21:59:00Z'))
    assert.equal((await db.query('SELECT * FROM warehouse_alert_data')).rows.length, 1)
    await saveWarehouseSnapshots(sql, { marker: 'six' }, new Date('2026-10-02T22:00:00Z'))
    await saveWarehouseSnapshots(sql, { marker: 'later' }, new Date('2026-10-02T22:15:00Z'))
    const result = (await db.query('SELECT key, value FROM warehouse_alert_data ORDER BY key')).rows
    assert.deepEqual(result.map(row => row.key), ['daily:2026-10-02', 'latest', 'weekly:2026-10-02'])
    assert.equal(result[0].value.marker, 'six'); assert.equal(result[1].value.marker, 'later'); assert.equal(result[2].value.marker, 'six')
    await saveWarehouseSnapshots(sql, { marker: 'winter-early' }, new Date('2026-11-06T22:59:00Z'))
    assert.equal((await db.query("SELECT * FROM warehouse_alert_data WHERE key='daily:2026-11-06'")).rows.length, 0)
    await saveWarehouseSnapshots(sql, { marker: 'winter-six' }, new Date('2026-11-06T23:00:00Z'))
    assert.equal((await db.query("SELECT * FROM warehouse_alert_data WHERE key='weekly:2026-11-06'")).rows.length, 1)
  } finally { await db.close() }
})
test('ERP sales source excludes linked and legacy rolled-back transactions', async () => {
  const db = new PGlite(), sql = tagged(db)
  try {
    await db.exec(`CREATE TABLE inventory_balance (style TEXT, color TEXT, size TEXT, quantity INTEGER);
      CREATE TABLE inventory_txn_rows (style TEXT, color TEXT, size TEXT, qty INTEGER, txn_type TEXT, business_day DATE, applied_at TIMESTAMPTZ, transaction_id INTEGER, source_file TEXT, applied_by TEXT);
      CREATE TABLE inventory_transactions (id INTEGER, rolled_back_at TIMESTAMPTZ, transaction_type TEXT, source_file TEXT, applied_by TEXT, applied_at TIMESTAMPTZ);
      INSERT INTO inventory_balance VALUES ('50199','Black','L',400);
      INSERT INTO inventory_transactions VALUES (1,NOW(),'sales','rollback.csv','admin',NOW());
      INSERT INTO inventory_txn_rows VALUES ('50199','Black','L',8,'sales',CURRENT_DATE,NOW(),1,'rollback.csv','admin'), ('50199','Black','L',10,'sales',CURRENT_DATE,NOW(),NULL,'rollback.csv','admin'), ('50199','Black','L',20,'sales',CURRENT_DATE,NOW(),2,'active.csv','admin'), ('50199','Black','L',5,'return',CURRENT_DATE,NOW(),3,'return.csv','admin');`)
    const source = await loadWarehouseSources(sql)
    assert.equal(source.inventory[0].quantity, 400)
    assert.equal(source.sales.length, 1); assert.equal(source.sales[0].sold_qty, 20)
  } finally { await db.close() }
})
test('cron rejects absent or wrong secrets without accessing the database', async () => {
  const oldUrl = process.env.DATABASE_URL, oldSecret = process.env.CRON_SECRET
  process.env.DATABASE_URL = 'postgresql://unused:unused@localhost/unused'; process.env.CRON_SECRET = 'expected'
  try {
    for (const authorization of [undefined, 'Bearer wrong']) {
      let status, body
      const res = { status(code) { status = code; return this }, json(value) { body = value; return this } }
      await handler({ method: 'GET', query: { action: 'cron' }, headers: { authorization } }, res)
      assert.equal(status, 401); assert.equal(body.error, 'Not authenticated')
    }
  } finally {
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret
  }
})

test('sales without a business day use New York dates independently of database timezone', async () => {
  const db = new PGlite(), sql = tagged(db)
  try {
    await db.exec(`SET TIME ZONE 'Asia/Tokyo';
      CREATE TABLE inventory_balance (style TEXT, color TEXT, size TEXT, quantity INTEGER);
      CREATE TABLE inventory_txn_rows (style TEXT, color TEXT, size TEXT, qty INTEGER, txn_type TEXT, business_day DATE, applied_at TIMESTAMPTZ, transaction_id INTEGER, source_file TEXT, applied_by TEXT);
      CREATE TABLE inventory_transactions (id INTEGER, rolled_back_at TIMESTAMPTZ, transaction_type TEXT, source_file TEXT, applied_by TEXT, applied_at TIMESTAMPTZ);
      INSERT INTO inventory_txn_rows VALUES
      ('A','Black','L',7,'sales',NULL,'2026-10-02T02:00:00Z',1,'a','admin'),
      ('A','Black','L',5,'sales',NULL,'2026-09-25T03:59:59Z',2,'b','admin'),
      ('A','Black','L',9,'sales',NULL,'2026-09-25T04:00:00Z',3,'c','admin'),
      ('A','Black','L',99,'sales',NULL,'2026-10-03T04:00:00Z',4,'d','admin');`)
    const { sales } = await loadWarehouseSources(sql, new Date('2026-10-03T02:00:00Z'))
    assert.deepEqual(sales.map(row => [row.date, row.sold_qty]), [['2026-10-01', 7], ['2026-09-25', 9]])
  } finally { await db.close() }
})
