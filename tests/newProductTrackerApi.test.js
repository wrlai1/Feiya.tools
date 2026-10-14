import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { neonConfig } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import analytics from '../api/analytics-store.js'
import tracker from '../api/new-product-tracker.js'

test('analytics uploads and tracker refresh synchronize atomically', async () => {
  const db = new PGlite()
  const previousFetch = neonConfig.fetchFunction
  const previousUrl = process.env.DATABASE_URL
  const previousSecret = process.env.JWT_SECRET
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test'
  process.env.JWT_SECRET = 'tracker-test'
  let failSync = false
  const execute = async (connection, { query, params }) => {
    if (failSync && query.includes('WITH clock AS')) throw new Error('simulated sync failure')
    const result = await connection.query(query, params)
    return {
      fields: result.fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID })),
      rows: result.rows.map(row => result.fields.map(field => {
        const value = row[field.name]
        if (value == null) return null
        if (value instanceof Date) return field.dataTypeID === 1082 ? value.toISOString().slice(0, 10) : value.toISOString()
        return typeof value === 'object' ? JSON.stringify(value) : String(value)
      })),
    }
  }
  neonConfig.fetchFunction = async (_url, options) => {
    const request = JSON.parse(options.body)
    try {
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
  const call = async (handler, action, body = {}, method = 'POST', query = {}) => {
    const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handler({ method, query: { action, ...query }, body, headers: { authorization: `Bearer ${token}` } }, response)
    return response
  }
  const ok = async (...args) => {
    const response = await call(...args)
    assert.equal(response.code, 200, JSON.stringify(response.body))
    return response.body
  }
  try {
    await db.exec("CREATE TABLE users(id int PRIMARY KEY, username text, role text); INSERT INTO users VALUES(1,'admin','admin')")
    const today = (await db.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date::text AS day")).rows[0].day
    await ok(analytics, 'save-day', { store: 'JR', day: today, rows: [{ spu: 'A', productName: 'First' }] })
    let list = await ok(tracker, 'list', {}, 'GET')
    assert.equal(list.trackers.length, 1)
    assert.equal(list.trackers[0].launchDate, today)
    assert.deepEqual(list.trackers[0].roasEvents, [])
    await ok(analytics, 'save-days', { store: 'JR', days: [{ day: today, rows: [{ spu: 'a' }, { spu: 'B' }] }] })
    await ok(tracker, 'sync')
    list = await ok(tracker, 'list', {}, 'GET')
    assert.equal(list.trackers.length, 2)
    const a = list.trackers.find(row => row.spu === 'A')
    await ok(tracker, '', {}, 'DELETE', { id: a.id })
    await ok(tracker, 'sync')
    assert.equal((await ok(tracker, 'list', {}, 'GET')).trackers.length, 1)
    failSync = true
    assert.equal((await call(analytics, 'save-day', { store: 'JR', day: today, rows: [{ spu: 'C' }] })).code, 500)
    failSync = false
    const saved = (await db.query('SELECT rows FROM analytics_store_days')).rows[0].rows
    assert.deepEqual(saved, [{ spu: 'a' }, { spu: 'B' }])
    assert.equal((await ok(tracker, 'list', {}, 'GET')).trackers.length, 1)
  } finally {
    neonConfig.fetchFunction = previousFetch
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    if (previousSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousSecret
    await db.close()
  }
})
