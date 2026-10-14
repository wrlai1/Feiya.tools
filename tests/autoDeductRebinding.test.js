import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { neonConfig } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import handler from '../api/auto-deduct.js'
import { aliasKey, fillTemplate } from '../src/utils/autoDeductEngine.js'
import { aliasesForSource, buildRebindingPlan, savedRebindingGroups } from '../src/utils/autoDeductRebinding.js'

const inventory = ['Winter White', 'White'].flatMap((COLOR) => ['S', 'M', 'L', 'XL'].map((SIZE) => ({ STYLE: '5020090', COLOR, SIZE })))
const base = aliasKey('5020090', 'white')
const aliases = {
  [base]: { STYLE: '5020090', COLOR: 'Winter White', _confirmed: true },
  [`${base}::m`]: { STYLE: '5020090', COLOR: 'Winter White', SIZE: 'M', _confirmedDimensions: true, _confirmed: true },
  [`${base}::m::review::signature::issues`]: { STYLE: '5020090', COLOR: 'Winter White', SIZE: 'M', _sourceSignature: 'signature', _confirmedIssues: 'issues', _confirmed: true },
  [aliasKey('5020090', 'black')]: { STYLE: '5020090', COLOR: 'Black', _confirmed: true },
}
const group = savedRebindingGroups(aliases).find((item) => item.baseKey === base)

test('rebinding all sibling rules routes future quantities to real White and preserves sizes and review evidence', () => {
  const before = JSON.stringify({ aliases, inventory })
  const plan = buildRebindingPlan(aliases, inventory, group.id, '5020090', 'White')
  assert.equal(plan.rows.length, 3)
  assert.equal(plan.upserts[`${base}::m`].SIZE, 'M')
  assert.equal(plan.upserts[`${base}::m`]._confirmedDimensions, true)
  assert.equal(plan.upserts[`${base}::m::review::signature::issues`]._sourceSignature, 'signature')
  assert.equal(plan.upserts[`${base}::m::review::signature::issues`]._confirmedIssues, 'issues')
  assert.equal(plan.upserts[aliasKey('5020090', 'black')], undefined)
  const rows = ['S', 'M', 'L', 'XL'].map((size) => ({ style: '5020090', color: 'white', size, QTY: 7 }))
  const old = fillTemplate(inventory, rows, aliases)
  assert.equal(old.filledRows.filter((row) => row.COLOR === 'Winter White').reduce((sum, row) => sum + row.QTY, 0), 28)
  const result = fillTemplate(inventory, rows, { ...aliases, ...plan.upserts })
  assert.equal(result.unmatchedRows.length, 0)
  assert.equal(result.filledRows.filter((row) => row.COLOR === 'White').reduce((sum, row) => sum + row.QTY, 0), 28)
  assert.equal(result.filledRows.filter((row) => row.COLOR === 'Winter White').reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(JSON.stringify({ aliases, inventory }), before)
})

test('missing sizes, ambiguous targets and absent colors are rejected; legacy color-only rules are supported', () => {
  assert.throws(() => buildRebindingPlan(aliases, inventory.filter((row) => row.SIZE !== 'M'), group.id, '5020090', 'White'), /缺少尺码/)
  assert.throws(() => buildRebindingPlan(aliases, [...inventory, { STYLE: '5020090', COLOR: 'WHITE', SIZE: 'S' }], group.id, '5020090', 'White'), /重复匹配/)
  assert.throws(() => buildRebindingPlan(aliases, inventory, group.id, '5020090', 'Absent'), /当前库存/)
  assert.throws(() => buildRebindingPlan(aliases, inventory, group.id, '5020090', 'Winter White'), /不同/)
  const legacy = { [base]: 'Winter White' }
  const plan = buildRebindingPlan(legacy, inventory, savedRebindingGroups(legacy)[0].id, '5020090', 'White')
  assert.deepEqual(plan.upserts[base], { STYLE: '5020090', COLOR: 'White', _isNew: false, _confirmed: true })
})

test('actual admin API saves only rules, rejects stale plans and leaves inventory and confirmed history unchanged', async () => {
  const db = new PGlite()
  const previousFetch = neonConfig.fetchFunction
  const previousUrl = process.env.DATABASE_URL, previousSecret = process.env.JWT_SECRET
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test'
  process.env.JWT_SECRET = 'local-rebinding-test'
  const execute = async (connection, { query, params }) => {
    const result = await connection.query(query, params)
    return { fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })), rows: result.rows.map((row) => result.fields.map(({ name }) => {
      const value = row[name]
      return value == null ? null : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
    })) }
  }
  neonConfig.fetchFunction = async (_url, options) => {
    const request = JSON.parse(options.body)
    try {
      const result = request.queries ? await db.transaction(async (connection) => {
        const results = []
        for (const query of request.queries) results.push(await execute(connection, query))
        return { results }
      }) : await execute(db, request)
      return { ok: true, json: async () => result }
    } catch (error) { return { ok: false, status: 400, json: async () => ({ message: error.message, code: error.code }) } }
  }
  const token = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET)
  const call = async (body, authorization = `Bearer ${token(1)}`) => {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handler({ method: 'POST', query: { action: 'rebind-aliases' }, body, headers: { authorization } }, res)
    return res
  }
  try {
    await db.exec(`CREATE TABLE users(id INT PRIMARY KEY, username TEXT, role TEXT);
      INSERT INTO users VALUES(1,'admin','admin'),(2,'user','user');
      CREATE TABLE app_data(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE inventory_balance(style TEXT, color TEXT, size TEXT, quantity INT);
      CREATE TABLE inventory_txn_rows(style TEXT, color TEXT, size TEXT, qty INT);
      INSERT INTO inventory_txn_rows VALUES('5020090','Winter White','M',30);`)
    for (const row of inventory) await db.query('INSERT INTO inventory_balance VALUES($1,$2,$3,$4)', [row.STYLE, row.COLOR, row.SIZE, -5])
    await db.query("INSERT INTO app_data VALUES('autodeduct_aliases',$1,NOW())", [JSON.stringify({ aliases, extraMetadata: 'preserved' })])
    const stockBefore = (await db.query('SELECT * FROM inventory_balance')).rows
    const historyBefore = (await db.query('SELECT * FROM inventory_txn_rows')).rows
    const body = { groupId: group.id, targetStyle: '5020090', targetColor: 'White', expected: aliasesForSource(aliases, base) }
    assert.equal((await call(body, '')).code, 401)
    assert.equal((await call(body, `Bearer ${token(2)}`)).code, 403)
    assert.equal((await call({ ...body, targetColor: 'MISSING' })).code, 400)
    // An unrelated concurrent rule survives the document merge.
    await db.query("UPDATE app_data SET value=jsonb_set(value,'{aliases}',value->'aliases'||$1::jsonb)", [JSON.stringify({ 'OTHER::blue': { STYLE: 'OTHER', COLOR: 'Blue' } })])
    const saved = await call(body)
    assert.equal(saved.code, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.count, 3)
    assert.equal(saved.body.aliases[base].COLOR, 'White')
    assert.equal(saved.body.aliases['OTHER::blue'].COLOR, 'Blue')
    assert.equal((await db.query('SELECT value FROM app_data')).rows[0].value.extraMetadata, 'preserved')
    const stale = await call({ ...body, targetColor: 'Winter White', groupId: savedRebindingGroups(saved.body.aliases).find((item) => item.baseKey === base).id })
    assert.equal(stale.code, 409)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance')).rows, stockBefore)
    assert.deepEqual((await db.query('SELECT * FROM inventory_txn_rows')).rows, historyBefore)
  } finally {
    neonConfig.fetchFunction = previousFetch
    if (previousUrl == null) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl
    if (previousSecret == null) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret
    await db.close()
  }
})
