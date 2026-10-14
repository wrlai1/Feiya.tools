import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { returnMappingMigration, planReturnMappingMigration } from '../lib/returnMappingMigration.js'

test('migrates saved SKU targets and pending items atomically, preserving stock and confirmed returns', async () => {
  const db = new PGlite()
  let beforeWrite = null
  const sql = (strings, ...params) => ({ query: strings.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), params })
  sql.transaction = async (queries) => {
    if (typeof queries === 'function' && beforeWrite) { const hook = beforeWrite; beforeWrite = null; await hook() }
    return db.transaction(async tx => {
      const results = []
      for (const q of typeof queries === 'function' ? queries(sql) : queries) results.push((await tx.query(q.query, q.params)).rows)
      return results
    })
  }
  const call = async (action, body, role = 'admin') => {
    const res = { code: 200, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await returnMappingMigration({ query: { action }, body }, res, sql, { username: 'operator', role })
    return res
  }
  const body = { storeName: 'House', fromStyle: '853105', toStyle: '853105 Missy' }
  try {
    await db.exec(`CREATE TABLE inventory_balance(id SERIAL PRIMARY KEY,style TEXT,color TEXT,size TEXT,quantity INT);
      INSERT INTO inventory_balance(style,color,size,quantity) VALUES('853105','BLACK','S',100),('853105 Missy','Black','S',80),('853105 Missy','Black','M',70);
      CREATE TABLE return_product_catalog(id BIGSERIAL PRIMARY KEY,store_name TEXT,store_key TEXT,sku_id TEXT,sku_code TEXT,components JSONB,status TEXT,issue TEXT,mapping_source TEXT,mapping_version INT,updated_at TIMESTAMPTZ,updated_by TEXT,source_file TEXT,mapping_confirmed_by TEXT,mapping_confirmed_at TIMESTAMPTZ);
      CREATE TABLE return_product_catalog_history(id BIGSERIAL PRIMARY KEY,store_name TEXT,store_key TEXT,sku_id TEXT,old_mapping JSONB,new_mapping JSONB,change_source TEXT,changed_by TEXT);
      CREATE TABLE return_packages(id BIGSERIAL PRIMARY KEY,store_key TEXT,tracking_number TEXT,status TEXT,confirmed_at TIMESTAMPTZ);
      CREATE TABLE return_package_items(id BIGSERIAL PRIMARY KEY,package_id BIGINT,sku_id TEXT,style TEXT,color TEXT,size TEXT,expected_qty INT,source_qty INT,actual_qty INT,restock_qty INT,not_ours_qty INT,UNIQUE(package_id,sku_id,style,color,size));
      INSERT INTO return_packages(store_key,tracking_number,status,confirmed_at) VALUES('house','PENDING','pending',NULL),('house','REVIEW','needs_review',NULL),('house','DONE','received',NOW()),('other','OTHER','pending',NULL);
      INSERT INTO return_package_items(package_id,sku_id,style,color,size,expected_qty,source_qty,actual_qty,restock_qty) VALUES(1,'A','853105','BLACK','S',2,2,NULL,NULL),(2,'B','853105','BLACK','M',4,2,NULL,NULL),(3,'A','853105','BLACK','S',2,2,2,2),(4,'A','853105','BLACK','S',1,1,NULL,NULL);`)
    for (const [sku, color, size, store] of [['A','BLACK','S','House'],['B','BLACK','M','House'],['C','GREEN','S','House'],['A','BLACK','S','Other']]) {
      await db.query(`INSERT INTO return_product_catalog(store_name,store_key,sku_id,sku_code,components,status,mapping_source,mapping_version,updated_at) VALUES($1,$2,$3,$3,$4,'ready','admin',1,NOW())`, [store, store.toLowerCase(), sku, JSON.stringify([{ style: '853105', color, size, qty: sku === 'B' ? 2 : 1 }])])
    }
    const stock = (await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows
    const confirmed = (await db.query('SELECT * FROM return_package_items WHERE package_id=3')).rows
    const preview = await call('catalog-migrate-preview', body)
    assert.equal(preview.body.rows.length, 3)
    assert.equal(preview.body.rows.find(r => r.sku === 'C').issues.length, 1)
    const selected = preview.body.rows.filter(r => !r.issues.length).map(r => r.id)
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM return_product_catalog_history')).rows[0].n, 0)
    assert.equal((await call('catalog-migrate-apply', { ...body, token: preview.body.token, ids: selected }, 'worker')).code, 403)
    const done = await call('catalog-migrate-apply', { ...body, token: preview.body.token, ids: selected })
    assert.equal(done.code, 200)
    assert.equal(done.body.updated, 2)
    assert.equal(done.body.pending_items, 2)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, stock)
    assert.deepEqual((await db.query('SELECT * FROM return_package_items WHERE package_id=3')).rows, confirmed)
    assert.equal((await db.query('SELECT style FROM return_package_items WHERE package_id=4')).rows[0].style, '853105')
    assert.deepEqual((await db.query('SELECT style,expected_qty FROM return_package_items WHERE package_id<3 ORDER BY id')).rows, [{ style: '853105 Missy', expected_qty: 2 }, { style: '853105 Missy', expected_qty: 4 }])
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM return_product_catalog_history')).rows[0].n, 2)
    assert.equal((await call('catalog-migrate-apply', { ...body, token: preview.body.token, ids: selected })).code, 409)
    const all = await call('catalog-migrate-preview', { ...body, allStores: true })
    const other = all.body.rows.find(r => r.store === 'Other')
    beforeWrite = () => db.query("UPDATE return_packages SET status='received',confirmed_at=NOW() WHERE id=4")
    assert.equal((await call('catalog-migrate-apply', { ...body, allStores: true, token: all.body.token, ids: [other.id] })).code, 409)
    assert.equal((await db.query('SELECT style FROM return_package_items WHERE package_id=4')).rows[0].style, '853105')
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM return_product_catalog_history')).rows[0].n, 2)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, stock)
  } finally { await db.close() }
})

test('ambiguous targets and pending destination collisions require manual review', () => {
  const component = { style: 'OLD', color: 'BLACK', size: '2XL', qty: 1 }
  const saved = { id: 1, store_name: 'House', store_key: 'house', sku_id: 'A', components: [component], status: 'ready' }
  const target = { style: 'NEW', color: 'Black', size: '2X' }
  assert.ok(planReturnMappingMigration([saved], [target,target], [], 'OLD', 'NEW')[0].issues.length)
  const pending = [{ id: 1, package_id: 1, store_key: 'house', sku_id: 'A', tracking_number: 'P1', ...component }, { id: 2, package_id: 1, store_key: 'house', sku_id: 'A', ...target }]
  assert.ok(planReturnMappingMigration([saved], [target], pending, 'OLD', 'NEW')[0].issues.length)
})
