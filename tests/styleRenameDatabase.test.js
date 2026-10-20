import { migrateReturnsSchema } from '../lib/returnsSchema.js'
import emailHandler from '../lib/inventoryEmailApi.js'
import appDataHandler from '../api/app-data.js'
import { neon } from '@neondatabase/serverless'
import inventoryLedger from '../lib/inventoryLedger.cjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { neonConfig } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import handler from '../api/inventory-balance.js'

// Execute the actual API SQL locally, including transaction rollback on errors.
test('global style rename is atomic across reports, mappings and imports', async (t) => {
  const db = new PGlite()
  const previousFetch = neonConfig.fetchFunction
  const previousUrl = process.env.DATABASE_URL
  const previousSecret = process.env.JWT_SECRET
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test'
  process.env.JWT_SECRET = 'inventory-local-test'
  let beforeBatch
  const execute = async (connection, { query, params }) => {
    const result = await connection.query(query, params)
    return {
      fields: result.fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID })),
      rows: result.rows.map(row => result.fields.map(field => {
        const value = row[field.name]
        if (value == null) return null
        if (value instanceof Date) return value.toISOString()
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
      })),
    }
  }
  neonConfig.fetchFunction = async (_url, options) => {
    const request = JSON.parse(options.body)
    try {
      if (request.queries && beforeBatch) {
        const callback = beforeBatch; beforeBatch = null
        await callback()
      }
      const data = request.queries
        ? await db.transaction(async connection => {
          const results = []
          for (const query of request.queries) results.push(await execute(connection, query))
          return { results }
        })
        : await execute(db, request)
      return { ok: true, json: async () => data }
    } catch (error) {
      return { ok: false, status: 400, json: async () => ({ message: error.message, code: error.code }) }
    }
  }
  const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET)
  const call = async (action, body = {}, method = 'POST', query = {}) => {
    const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handler({ method, query: { action, ...query }, body, headers: { authorization: `Bearer ${token}` } }, response)
    return response
  }
  const ok = async (...args) => {
    const response = await call(...args)
    assert.equal(response.code, 200, JSON.stringify(response.body))
    return response.body
  }
  const balance = async () => (await db.query('SELECT style, color, size, quantity FROM inventory_balance ORDER BY style, color, size')).rows
  const active = async () => Number((await db.query('SELECT COUNT(*) AS n FROM inventory_transactions WHERE rolled_back_at IS NULL')).rows[0].n)
  const row = { Style: 'A', Color: 'Black', Size: '1X', Quantity: 10 }
  const apply = (hash, quantity = 2, extra = {}) => ({
    txnType: 'sales', sourceName: hash, sourceHash: hash, storeName: 'Store', sourceUnits: quantity,
    orderClaims: [{ orderKey: hash, itemKey: 'sku:a' }],
    filledRows: [{ STYLE: 'A', COLOR: 'Black', SIZE: '1X', QTY: quantity }], ...extra,
  })
  const callOther = async (handler, action, body, method = 'POST', extraQuery = {}) => {
    const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handler({ method, query: { action, ...extraQuery }, body, headers: { authorization: `Bearer ${token}` } }, response)
    assert.equal(response.code, 200, JSON.stringify(response.body))
    return response.body
  }
  try {
    const sql = neon(process.env.DATABASE_URL)
    await migrateReturnsSchema(sql)
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
      INSERT INTO users VALUES(1,'admin','admin');
      CREATE TABLE app_data(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE warehouse_alert_data(key TEXT PRIMARY KEY,value JSONB NOT NULL,revision INT NOT NULL DEFAULT 0);
      CREATE TABLE inventory_sku_corrections(id SERIAL PRIMARY KEY,transaction_id INT,undone_at TIMESTAMPTZ,stock_changes JSONB,movement_changes JSONB,evidence JSONB);
      CREATE TABLE analytics_store_days(username TEXT,store TEXT,day DATE,rows JSONB,PRIMARY KEY(username,store,day));`)
    await ok('init', { rows: [row, { ...row, Style: 'B', Quantity: 50 }, { ...row, Size: 'M', Quantity: 3 }] })
    await ok('apply', apply('rename-original-sale'))
    await db.exec("UPDATE inventory_balance SET quantity=-2 WHERE style='A' AND size='M'")
    await callOther(emailHandler, 'email-settings', { enabled: true, recipients: ['recipient@example.com'], styles: ['A'], sendHour: 9 })
    await callOther(emailHandler, 'email-minimum-upload', { rows: [{ style: 'A', color: 'Black', size: '1X', minimum: 123 }] })
    await db.exec(`INSERT INTO app_data VALUES
      ('inventory','{"rows":[{"style":"A","qty":777}],"revision":2}',NOW()),
      ('autodeduct_template','{"rows":[{"STYLE":"A","COLOR":"Black","SIZE":"1X"}]}',NOW()),
      ('autodeduct_aliases','{"aliases":{"a::bk":{"STYLE":"A","COLOR":"Black","_confirmed":true}}}',NOW());
      INSERT INTO warehouse_alert_data VALUES('state','{"orders":[{"style":"A","qty":12}],"overrides":{"sku:[\\"a\\",\\"black\\",\\"1x\\"]":{"ready_qty":2}}}',4);
      INSERT INTO return_packages(tracking_key,tracking_number,status,expected_units) VALUES('TRACK1','TRACK1','pending',3);
      INSERT INTO return_package_items(package_id,sku_id,sku_code,style,color,size,expected_qty) VALUES(1,'SKU1','A-BLACK-1X','A','Black','1X',3);
      INSERT INTO return_product_catalog(store_name,store_key,sku_id,sku_code,components,status)
        VALUES('Store','store','SKU1','A-BLACK-1X','[{"style":"A","color":"Black","size":"1X","qty":1}]','ready');
      INSERT INTO return_product_catalog_history(store_name,store_key,sku_id,new_mapping,change_source)
        VALUES('Store','store','SKU1','{"components":[{"style":"A","qty":1}]}','admin');
      INSERT INTO inventory_sku_corrections(stock_changes,movement_changes,evidence) VALUES('[{"style":"A","quantity":7}]','[{"target":{"style":"A"}}]','{"style":"A","source":"original evidence"}');
      INSERT INTO return_analytics_cache(period,result,generated_at) VALUES('30','{"rows":[{"style":"A"}]}',NOW());
      INSERT INTO analytics_store_days VALUES('admin','store','2026-10-01','[{"style":"A","spu":"A","revenue":12}]');`)
    await t.test('one rename updates linked names and retains all numeric and source identities', async () => {
      const before = await balance()
      const renamed = await ok('rename-style', { oldStyle: 'A', newStyle: 'New Name' }, 'PATCH')
      assert.equal(renamed.updated, 2)
      assert.deepEqual((await balance()).map(item => item.quantity).sort(), before.map(item => item.quantity).sort())
      assert.equal((await db.query('SELECT styles FROM inventory_email_settings')).rows[0].styles[0], 'New Name')
      const minimum = (await db.query('SELECT * FROM inventory_email_minimum')).rows[0]
      assert.equal(minimum.minimum, 123)
      assert.equal(minimum.sku_key, inventoryLedger.skuKey({ style: 'New Name', color: 'Black', size: '1X' }))
      const catalog = (await db.query('SELECT * FROM return_product_catalog')).rows[0]
      assert.equal(catalog.components[0].style, 'New Name')
      assert.equal(catalog.mapping_version, 2)
      assert.equal(catalog.sku_code, 'A-BLACK-1X')
      const item = (await db.query('SELECT * FROM return_package_items')).rows[0]
      assert.equal(item.style, 'New Name')
      assert.equal(item.expected_qty, 3)
      assert.equal(item.sku_id, 'SKU1')
      const inventory = (await db.query("SELECT value FROM app_data WHERE key='inventory'")).rows[0].value
      assert.equal(inventory.rows[0].style, 'New Name')
      assert.equal(inventory.rows[0].qty, 777)
      assert.equal(inventory.revision, 3)
      const aliases = (await db.query("SELECT value FROM app_data WHERE key='autodeduct_aliases'")).rows[0].value.aliases
      assert.equal(aliases['a::bk'].STYLE, 'New Name')
      const warehouse = (await db.query('SELECT * FROM warehouse_alert_data')).rows[0]
      assert.equal(warehouse.revision, 5)
      assert.equal(warehouse.value.orders[0].qty, 12)
      assert.equal(warehouse.value.overrides['sku:["new name","black","1x"]'].ready_qty, 2)
      assert.equal((await db.query('SELECT COUNT(*)::int n FROM return_analytics_cache')).rows[0].n, 0)
      const correction = (await db.query('SELECT * FROM inventory_sku_corrections')).rows[0]
      assert.equal(correction.stock_changes[0].style, 'New Name')
      assert.equal(correction.movement_changes[0].target.style, 'New Name')
      assert.equal(correction.evidence.style, 'A')
      const analytics = (await db.query('SELECT rows FROM analytics_store_days')).rows[0].rows[0]
      assert.equal(analytics.style, 'New Name')
      assert.equal(analytics.spu, 'A')
      assert.equal(analytics.revenue, 12)
    })
    await t.test('old file names resolve before inventory lookup and repeated renames flatten aliases', async () => {
      await ok('apply', apply('old-name-import'))
      assert.equal((await balance()).find(item => item.style === 'New Name' && item.size === '1X').quantity, 6)
      await ok('rename-style', { oldStyle: 'New Name', newStyle: 'FINAL' }, 'PATCH')
      const aliases = (await ok('list', {}, 'GET')).styleAliases
      assert.equal(aliases.A, 'FINAL')
      assert.equal(aliases['NEW NAME'], 'FINAL')
      assert.equal(aliases.FINAL, 'FINAL')
      assert.equal((await call('rename-style', { oldStyle: 'B', newStyle: 'A' }, 'PATCH')).code, 409)
      const saved = await callOther(appDataHandler, '', { type: 'inventory', data: [{ style: 'A', qty: 7 }], expectedRevision: 4 })
      assert.equal(saved.revision, 5)
      assert.equal((await db.query("SELECT value FROM app_data WHERE key='inventory'")).rows[0].value.rows[0].style, 'FINAL')
      const snapshot = (await db.query("SELECT rollback_snapshot_id id FROM inventory_transactions WHERE source_file='old-name-import'")).rows[0].id
      await ok('restore', {}, 'POST', { id: snapshot })
      assert.equal((await balance()).find(item => item.style === 'FINAL' && item.size === '1X').quantity, 8)
      assert.equal((await balance()).some(item => item.style === 'A'), false)
    })
    await t.test('concurrent edits and inserts abort every rename mutation', async () => {
      const before = await balance()
      const auditCount = (await db.query('SELECT COUNT(*)::int n FROM inventory_style_renames')).rows[0].n
      beforeBatch = async () => db.exec(`UPDATE app_data SET value='{"rows":[{"style":"FINAL","qty":999}],"revision":6}' WHERE key='inventory'`)
      assert.equal((await call('rename-style', { oldStyle: 'FINAL', newStyle: 'NO-COMMIT' }, 'PATCH')).code, 409)
      assert.deepEqual(await balance(), before)
      assert.equal((await db.query('SELECT COUNT(*)::int n FROM inventory_style_renames')).rows[0].n, auditCount)
      assert.equal((await db.query('SELECT styles FROM inventory_email_settings')).rows[0].styles[0], 'FINAL')
      beforeBatch = async () => db.exec(`INSERT INTO app_data VALUES('new-document','{"style":"FINAL"}',NOW())`)
      assert.equal((await call('rename-style', { oldStyle: 'FINAL', newStyle: 'NO-COMMIT' }, 'PATCH')).code, 409)
      assert.deepEqual(await balance(), before)
    })
    await t.test('unique conflicts in dependent records and unauthorized users save nothing', async () => {
      await db.exec(`INSERT INTO return_package_items(package_id,sku_id,sku_code,style,color,size,expected_qty) VALUES(1,'SKU1','external','TAKEN','Black','1X',1)`)
      const before = await balance()
      assert.equal((await call('rename-style', { oldStyle: 'FINAL', newStyle: 'TAKEN' }, 'PATCH')).code, 409)
      assert.deepEqual(await balance(), before)
      assert.equal((await db.query('SELECT styles FROM inventory_email_settings')).rows[0].styles[0], 'FINAL')
      await db.exec("UPDATE users SET role='user'")
      assert.equal((await call('rename-style', { oldStyle: 'FINAL', newStyle: 'NOT-ALLOWED' }, 'PATCH')).code, 403)
      await db.exec("UPDATE users SET role='admin'")
      await ok('rename-style', { oldStyle: 'FINAL', newStyle: 'final' }, 'PATCH')
      assert.equal((await ok('list', {}, 'GET')).styleAliases.A, 'final')
    })
    await t.test('a stale writer cannot recreate retired names or partially change stock', async () => {
      const before = await balance()
      await assert.rejects(db.transaction(async connection => {
        await connection.query("UPDATE inventory_balance SET quantity=quantity+1 WHERE style='final'")
        await connection.query("INSERT INTO app_data(key,value) VALUES('stale-request',$1::jsonb)", [JSON.stringify({ rows: [{ style: 'A' }] })])
      }), { code: 'PST01' })
      assert.deepEqual(await balance(), before)
      assert.equal((await db.query("SELECT COUNT(*)::int n FROM app_data WHERE key='stale-request'")).rows[0].n, 0)
      await assert.rejects(db.query("INSERT INTO inventory_balance(style,color,size,quantity) VALUES('A','White','L',4)"), { code: 'PST01' })
      await ok('rename-style', { oldStyle: 'final', newStyle: 'A' }, 'PATCH')
      assert.equal((await ok('list', {}, 'GET')).styleAliases.FINAL, 'A')
      await ok('apply', { ...apply('final-alias-import'), filledRows: [{ STYLE: 'FINAL', COLOR: 'Black', SIZE: '1X', QTY: 2 }] })
      assert.equal((await balance()).some(item => item.style === 'final'), false)
    })
  } finally {
    neonConfig.fetchFunction = previousFetch
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret
    await db.close()
  }
})
