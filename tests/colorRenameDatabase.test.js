import { colorAliasKey } from '../src/utils/colorNames.js'
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
test('color rename is scoped, atomic and compatible with style rename and rollback', async (t) => {
  const db = new PGlite()
  const previousFetch = neonConfig.fetchFunction
  const previousUrl = process.env.DATABASE_URL
  const previousSecret = process.env.JWT_SECRET
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test'
  process.env.JWT_SECRET = 'inventory-local-test'
  let beforeBatch
  let enforceBoundedRenameReads = false
  const renameReads = []
  const readDocuments = table => {
    return renameReads.filter(read => read.query.includes(`FROM "${table}"`)).flatMap(read => read.rows)
  }
  const execute = async (connection, { query, params }) => {
    if (enforceBoundedRenameReads && /jsonb_agg\(to_jsonb\(saved\)\)/.test(query)) {
      throw Object.assign(new Error('total size of jsonb array elements exceeds the maximum of 268435455 bytes'), { code: '54000' })
    }
    const result = await connection.query(query, params)
    if (enforceBoundedRenameReads && Buffer.byteLength(JSON.stringify(result.rows)) > 3 * 1024 * 1024) {
      throw new Error('response is too large (simulated HTTP limit)')
    }
    if (enforceBoundedRenameReads && query.includes('__rename_hash')) renameReads.push({ query, rows: result.rows })
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
    if (enforceBoundedRenameReads && Buffer.byteLength(options.body) > 3 * 1024 * 1024) throw new Error('request is too large (simulated HTTP limit)')
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
    await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,username TEXT,role TEXT);INSERT INTO users VALUES(1,'admin','admin');
      CREATE TABLE app_data(key TEXT PRIMARY KEY,value JSONB,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE warehouse_alert_data(key TEXT PRIMARY KEY,value JSONB,revision INT DEFAULT 0);`)
    await ok('init', { rows: [
      { Style: 'A', Color: 'BLACK', Size: 'S', Quantity: 10 }, { Style: 'A', Color: 'BLACK', Size: 'M', Quantity: 20 },
      { Style: 'A', Color: 'WHITE', Size: 'S', Quantity: 5 }, { Style: 'B', Color: 'BLACK', Size: 'S', Quantity: 30 },
      { Style: 'B', Color: 'WHITE', Size: 'S', Quantity: 40 },
    ] })
    await db.exec("UPDATE inventory_balance SET quantity=-2 WHERE style='A' AND size='M'")
    const sale = { txnType: 'sales', storeName: 'Store', sourceName: 'color-original-sale', sourceHash: 'color-original-sale', sourceUnits: 2, orderClaims: [{ orderKey: 'color-original-sale', itemKey: 'sku:color' }],
      filledRows: [{ STYLE: 'A', COLOR: 'BLACK', SIZE: 'S', QTY: 2 }] }
    await ok('apply', sale)
    await callOther(emailHandler, 'email-settings', { enabled: true, recipients: ['recipient@example.com'], styles: ['A','B'], sendHour: 0 })
    await callOther(emailHandler, 'email-minimum-upload', { rows: [{ style: 'A', color: 'BLACK', size: 'S', minimum: 101 }, { style: 'B', color: 'BLACK', size: 'S', minimum: 202 }] })
    await db.query("INSERT INTO app_data(key,value) VALUES('inventory',$1::jsonb)", [JSON.stringify({ rows: [{ style: 'A', color: 'BLACK', qty: 8 }, { style: 'B', color: 'BLACK', qty: 30 }], revision: 1 })])
    await db.query("INSERT INTO app_data(key,value) VALUES('autodeduct_aliases',$1::jsonb)", [JSON.stringify({ aliases: { 'a::source': { STYLE: 'A', COLOR: 'BLACK', _confirmed: true } } })])
    await db.query("INSERT INTO warehouse_alert_data VALUES('state',$1::jsonb,1)", [JSON.stringify({ orders: [{ style: 'A', color: 'BLACK', qty: 2 }, { style: 'B', color: 'BLACK', qty: 3 }], overrides: { 'sku:["a","black","s"]': { ready_qty: 2 }, 'sku:["b","black","s"]': { ready_qty: 3 } } })])
    await db.exec(`INSERT INTO return_packages(tracking_number,tracking_key,status,expected_units) VALUES('COLOR1','COLOR1','pending',2);
      INSERT INTO return_package_items(package_id,sku_id,sku_code,style,color,size,expected_qty) VALUES(1,'SKU1','A-BLACK-S','A','BLACK','S',2);
      INSERT INTO return_product_catalog(store_name,store_key,sku_id,sku_code,components,status) VALUES('Store','store','SKU1','A-BLACK-S','[{"style":"A","color":"BLACK","size":"S","qty":1}]','ready');
      INSERT INTO return_product_catalog_history(store_name,store_key,sku_id,new_mapping,change_source) VALUES('Store','store','SKU1','{"components":[{"style":"A","color":"BLACK","qty":1}]}','admin');
      INSERT INTO inventory_substitutions(transaction_id,original_row_id,substitute_row_id,style,original_color,substitute_color,size,quantity,created_by)
        VALUES(999,1,3,'A','BLACK','WHITE','S',1,'admin');`)
    await t.test('one color rename changes all sizes of its style and every linked color identity', async () => {
      const before = (await db.query('SELECT id,quantity FROM inventory_balance ORDER BY id')).rows
      const result = await ok('rename-colors', { renames: [{ style: 'A', oldColor: 'BLACK', newColor: 'MIDNIGHT' }] }, 'PATCH')
      assert.equal(result.updated, 2)
      assert.equal(result.renamedColors, 1)
      assert.deepEqual((await db.query('SELECT id,quantity FROM inventory_balance ORDER BY id')).rows, before)
      assert.equal((await db.query("SELECT COUNT(*)::int n FROM inventory_balance WHERE style='A' AND color='MIDNIGHT'")).rows[0].n, 2)
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='B' AND color='BLACK'")).rows[0].quantity, 30)
      assert.equal((await db.query('SELECT color FROM inventory_txn_rows')).rows[0].color, 'MIDNIGHT')
      const item = (await db.query('SELECT * FROM return_package_items')).rows[0]
      assert.equal(item.color, 'MIDNIGHT'); assert.equal(item.sku_code, 'A-BLACK-S'); assert.equal(item.expected_qty, 2)
      assert.equal((await db.query('SELECT components FROM return_product_catalog')).rows[0].components[0].color, 'MIDNIGHT')
      assert.equal((await db.query('SELECT new_mapping FROM return_product_catalog_history')).rows[0].new_mapping.components[0].color, 'MIDNIGHT')
      const substitution = (await db.query('SELECT * FROM inventory_substitutions')).rows[0]
      assert.equal(substitution.original_color, 'MIDNIGHT'); assert.equal(substitution.substitute_color, 'WHITE')
      const minimum = (await db.query("SELECT * FROM inventory_email_minimum WHERE style='A'")).rows[0]
      assert.equal(minimum.minimum, 101); assert.equal(minimum.color, 'MIDNIGHT')
      assert.equal(minimum.sku_key, inventoryLedger.skuKey({ style: 'A', color: 'MIDNIGHT', size: 'S' }))
      assert.equal((await db.query("SELECT minimum FROM inventory_email_minimum WHERE style='B'")).rows[0].minimum, 202)
      const shared = (await db.query("SELECT value FROM app_data WHERE key='inventory'")).rows[0].value
      assert.equal(shared.rows[0].color, 'MIDNIGHT'); assert.equal(shared.rows[1].color, 'BLACK'); assert.equal(shared.revision, 2)
      assert.equal((await db.query("SELECT value FROM app_data WHERE key='autodeduct_aliases'")).rows[0].value.aliases['a::source'].COLOR, 'MIDNIGHT')
      const warehouse = (await db.query('SELECT * FROM warehouse_alert_data')).rows[0]
      assert.equal(warehouse.value.overrides['sku:["a","midnight","s"]'].ready_qty, 2)
      assert.equal(warehouse.value.overrides['sku:["b","black","s"]'].ready_qty, 3)
      assert.equal((await ok('list', {}, 'GET')).colorAliases[colorAliasKey('A','BLACK')], 'MIDNIGHT')
    })
    await t.test('old colors resolve on import and rollback follows the new color without changing unrelated stock', async () => {
      await ok('apply', { ...sale, sourceName: 'old-color-import', sourceHash: 'old-color-import', orderClaims: [{ orderKey: 'old-color-import', itemKey: 'sku:color' }] })
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='A' AND color='MIDNIGHT' AND size='S'")).rows[0].quantity, 6)
      const id = (await db.query("SELECT rollback_snapshot_id id FROM inventory_transactions WHERE source_file='old-color-import'")).rows[0].id
      await ok('restore', {}, 'POST', { id })
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='A' AND color='MIDNIGHT' AND size='S'")).rows[0].quantity, 8)
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='B' AND color='BLACK'")).rows[0].quantity, 30)
    })
    await t.test('batch conflicts, stale writers and concurrent documents leave the entire batch unchanged', async () => {
      const before = await balance()
      assert.equal((await call('rename-colors', { renames: [{ style: 'A', oldColor: 'MIDNIGHT', newColor: 'NIGHT' }, { style: 'B', oldColor: 'BLACK', newColor: 'WHITE' }] }, 'PATCH')).code, 409)
      assert.deepEqual(await balance(), before)
      await assert.rejects(db.query("INSERT INTO inventory_balance(style,color,size,quantity) VALUES('A','BLACK','L',5)"), { code: 'PST01' })
      const changes = { renames: [{ style: 'A', oldColor: 'MIDNIGHT', newColor: 'NIGHT' }, { style: 'B', oldColor: 'BLACK', newColor: 'NIGHT' }] }
      beforeBatch = async () => db.query("UPDATE app_data SET value=$1::jsonb WHERE key='inventory'", [JSON.stringify({ rows: [{ style: 'A', color: 'MIDNIGHT', qty: 99 }], revision: 3 })])
      assert.equal((await call('rename-colors', changes, 'PATCH')).code, 409)
      assert.deepEqual(await balance(), before)
      await db.exec("UPDATE users SET role='user'")
      assert.equal((await call('rename-colors', changes, 'PATCH')).code, 403)
      await db.exec("UPDATE users SET role='admin'")
    })
    await t.test('multiple scoped colors commit together, keep alias chains, and survive a subsequent style rename', async () => {
      const before = (await db.query('SELECT id,quantity FROM inventory_balance ORDER BY id')).rows
      const changes = { renames: [{ style: 'A', oldColor: 'MIDNIGHT', newColor: 'NIGHT' }, { style: 'B', oldColor: 'BLACK', newColor: 'NIGHT' }] }
      assert.equal((await ok('rename-colors', changes, 'PATCH')).renamedColors, 2)
      assert.deepEqual((await db.query('SELECT id,quantity FROM inventory_balance ORDER BY id')).rows, before)
      assert.equal((await ok('list', {}, 'GET')).colorAliases[colorAliasKey('A','BLACK')], 'NIGHT')
      await ok('rename-style', { oldStyle: 'A', newStyle: 'A-NEW' }, 'PATCH')
      const aliases = (await ok('list', {}, 'GET')).colorAliases
      assert.equal(aliases[colorAliasKey('A-NEW','BLACK')], 'NIGHT')
      assert.equal(aliases[colorAliasKey('A','BLACK')], undefined)
      await ok('apply', { ...sale, sourceHash: 'both-old-names', sourceName: 'both-old-names', orderClaims: [{ orderKey: 'both-old-names', itemKey: 'sku:color' }] })
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='A-NEW' AND color='NIGHT' AND size='S'")).rows[0].quantity, 6)
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='B' AND color='NIGHT'")).rows[0].quantity, 30)
      const id = (await db.query("SELECT rollback_snapshot_id id FROM inventory_transactions WHERE source_file='both-old-names'")).rows[0].id
      await ok('restore', {}, 'POST', { id })
      assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='A-NEW' AND color='NIGHT' AND size='S'")).rows[0].quantity, 8)
    })
    await t.test('renaming back to a previous color and changing case keep every prior alias valid', async () => {
      await ok('rename-colors', { renames: [{ style: 'A-NEW', oldColor: 'NIGHT', newColor: 'BLACK' }] }, 'PATCH')
      await ok('rename-colors', { renames: [{ style: 'A-NEW', oldColor: 'BLACK', newColor: 'Black' }] }, 'PATCH')
      const aliases = (await ok('list', {}, 'GET')).colorAliases
      assert.equal(aliases[colorAliasKey('A-NEW','NIGHT')], 'Black')
      assert.equal(aliases[colorAliasKey('A-NEW','MIDNIGHT')], 'Black')
      assert.equal(aliases[colorAliasKey('A-NEW','BLACK')], 'Black')
      assert.equal(aliases[colorAliasKey('B','BLACK')], 'NIGHT')
    })
    await t.test('a late dependent-record collision rolls back every color alias and batch change', async () => {
      await db.exec("INSERT INTO return_package_items(package_id,sku_id,sku_code,style,color,size,expected_qty) VALUES(1,'SKU1','original-source','A-NEW','TAKEN','S',1)")
      const before = await balance()
      const aliasesBefore = (await ok('list', {}, 'GET')).colorAliases
      const auditBefore = (await db.query('SELECT COUNT(*)::int n FROM inventory_color_renames')).rows[0].n
      const response = await call('rename-colors', { renames: [{ style: 'A-NEW', oldColor: 'Black', newColor: 'TAKEN' }, { style: 'B', oldColor: 'NIGHT', newColor: 'DARK' }] }, 'PATCH')
      assert.equal(response.code, 409)
      assert.deepEqual(await balance(), before)
      assert.deepEqual((await ok('list', {}, 'GET')).colorAliases, aliasesBefore)
      assert.equal((await db.query('SELECT COUNT(*)::int n FROM inventory_color_renames')).rows[0].n, auditBefore)
    })
    await t.test('large history and cached attachments are never aggregated or loaded unnecessarily during a four-size rename', async () => {
      const oldColor = 'Black Grey Blue Plaid', newColor = '#21 Black Grey Blue Plaid'
      await ok('add-rows', { rows: ['S','M','L','XL'].map((size,index) => ({ Style: '5010149', Color: oldColor, Size: size, Quantity: index + 1 })) })
      await db.query("INSERT INTO app_data(key,value) VALUES('size-fix-related',$1::jsonb)", [JSON.stringify({ rows: [{ style: '5010149', color: oldColor, qty: 99 }], revision: 1 })])
      await db.exec(`INSERT INTO app_data(key,value) SELECT 'unrelated-large-' || n, jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('style','UNRELATED','color','BLACK','notes',repeat('z',200000)))) FROM generate_series(1,10) n;
        INSERT INTO inventory_email_runs(report_date,status,styles,payload) VALUES('2000-01-01','sent','["5010149"]',repeat('x',1000000));`)
      renameReads.length = 0
      enforceBoundedRenameReads = true
      const result = await ok('rename-colors', { renames: [{ style: '5010149', oldColor, newColor }] }, 'PATCH')
      enforceBoundedRenameReads = false
      assert.equal(result.updated, 4)
      const stock = (await db.query("SELECT color,quantity FROM inventory_balance WHERE style='5010149' ORDER BY id")).rows
      assert.deepEqual(stock.map(row => row.quantity).sort((a,b) => a-b), [1,2,3,4])
      assert.equal(stock.every(row => row.color === newColor), true)
      const documents = readDocuments('app_data')
      assert.deepEqual(documents, [], 'historical documents must stay in the database')
      const reports = readDocuments('inventory_email_runs')
      assert.equal(reports[0].payload, true)
      assert.equal((await db.query("SELECT value FROM app_data WHERE key='size-fix-related'")).rows[0].value.rows[0].color, newColor)
      assert.equal((await db.query("SELECT COUNT(*)::int n FROM app_data WHERE key LIKE 'unrelated-large-%'")).rows[0].n, 10)
    })
    await t.test('a related document larger than the HTTP limit is renamed without transporting it', async () => {
      const notes = 'unchanged-history-'.repeat(200000)
      await db.exec(`INSERT INTO inventory_balance(style,color,size,quantity)
        SELECT 'PAGING-' || n,'BLACK','S',1 FROM generate_series(1,1200) n`)
      await db.exec(`INSERT INTO inventory_txn_rows(txn_type,style,color,size,qty,source_file)
        SELECT 'sales','5010149','#21 Black Grey Blue Plaid','S',-1,'bulk-history-' || n FROM generate_series(1,3000) n`)
      await db.query("INSERT INTO app_data(key,value) VALUES('oversized-related',$1::jsonb)", [JSON.stringify({ rows: [{ style: '5010149', color: '#21 Black Grey Blue Plaid', quantity: 99 }], notes, revision: 1 })])
      renameReads.length = 0
      enforceBoundedRenameReads = true
      try {
        const result = await ok('rename-colors', { renames: [{ style: '5010149', oldColor: '#21 Black Grey Blue Plaid', newColor: '#22 Black Grey Blue Plaid' }] }, 'PATCH')
        assert.equal(result.updated, 4)
      } finally { enforceBoundedRenameReads = false }
      const reads = renameReads.filter(read => read.query.includes('FROM "app_data"'))
      assert.equal(reads.length, 0, 'large documents must never leave PostgreSQL')
      const inventoryReads = renameReads.filter(read => read.query.includes('FROM "inventory_balance"'))
      assert.equal(inventoryReads.length, 2, 'over 1,200 scalar inventory rows need two requests, not hundreds')
      assert.equal(readDocuments('inventory_txn_rows').length, 0, 'transaction history must be updated inside PostgreSQL')
      const history = (await db.query("SELECT COUNT(*)::int n,SUM(qty)::int qty FROM inventory_txn_rows WHERE source_file LIKE 'bulk-history-%' AND color='#22 Black Grey Blue Plaid'")).rows[0]
      assert.deepEqual(history, { n: 3000, qty: -3000 })
      const saved = (await db.query("SELECT value FROM app_data WHERE key='oversized-related'")).rows[0].value
      assert.equal(saved.rows[0].color, '#22 Black Grey Blue Plaid')
      assert.equal(saved.rows[0].quantity, 99)
      assert.equal(saved.notes, notes)
      assert.equal(saved.revision, 2)
    })
    await t.test('related-document filtering treats wildcard and JSON escape characters literally', async () => {
      const special = String.raw`STYLE%_"TEST`
      await ok('add-rows', { rows: [{ Style: special, Color: 'BLACK', Size: 'S', Quantity: 7 }] })
      await db.query("INSERT INTO app_data(key,value) VALUES('special-related',$1::jsonb),('special-unrelated',$2::jsonb)", [JSON.stringify({ style: special, color: 'BLACK' }), JSON.stringify({ style: 'STYLExxxTEST', color: 'BLACK' })])
      renameReads.length = 0
      enforceBoundedRenameReads = true
      await ok('rename-colors', { renames: [{ style: special, oldColor: 'BLACK', newColor: 'CHARCOAL' }] }, 'PATCH')
      enforceBoundedRenameReads = false
      const documents = readDocuments('app_data')
      assert.deepEqual(documents, [])
      assert.equal((await db.query("SELECT value FROM app_data WHERE key='special-related'")).rows[0].value.color, 'CHARCOAL')
      assert.equal((await db.query("SELECT value FROM app_data WHERE key='special-unrelated'")).rows[0].value.color, 'BLACK')
    })
  } finally {
    neonConfig.fetchFunction = previousFetch
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret
    await db.close()
  }
})
