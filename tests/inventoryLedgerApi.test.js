import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { neonConfig } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import emailHandler from '../lib/inventoryEmailApi.js'
import returnsHandler from '../api/returns.js'
import balanceHandler from '../api/inventory-balance.js'
import { migrateReturnsSchema } from '../lib/returnsSchema.js'
import returnDate from '../lib/returnBusinessDate.cjs'
import ExcelJS from 'exceljs'

test('actual APIs persist Minimum overrides and selected return business dates', async () => {
  const db = new PGlite()
  const previousFetch = neonConfig.fetchFunction
  const oldUrl = process.env.DATABASE_URL
  const oldSecret = process.env.JWT_SECRET
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test'
  process.env.JWT_SECRET = 'ledger-api-local-test'
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
  const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET)
  const call = async (handler, action, body, options = {}) => {
    const response = { code: 200, headers: {}, setHeader(name, value) { this.headers[name] = value }, send(body) { this.body = body; return this }, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handler({ method: 'POST', query: { action }, body, headers: { authorization: `Bearer ${token}` }, ...options }, response)
    return response
  }
  const sql = async (strings, ...values) => (await db.query(strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, ''), values)).rows
  try {
    await migrateReturnsSchema(sql)
    await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
      INSERT INTO users VALUES (1,'admin','admin');
      INSERT INTO inventory_balance(style,color,size,quantity) VALUES ('0055','BLACK','S',80);
      INSERT INTO return_packages (tracking_number,tracking_key,status,expected_units) VALUES ('RETURN1','RETURN1','pending',3);
      INSERT INTO return_package_items(package_id,sku_id,sku_code,style,color,size,expected_qty) VALUES (1,'SKU1','0055-BLACK-S','0055','BLACK','S',3);`)
    const sku = { style: '0055', color: 'BLACK', size: 'S', minimum: 100.1 }
    assert.equal((await call(emailHandler, 'email-minimum-upload', { rows: [sku] })).code, 200)
    assert.equal((await db.query('SELECT minimum FROM inventory_email_minimum')).rows[0].minimum, 101)
    assert.equal((await call(emailHandler, 'email-minimum-upload', { rows: [sku, { ...sku, color: 'MISSING' }] })).code, 400)
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM inventory_email_minimum')).rows[0].n, 1)
    assert.equal((await call(emailHandler, 'email-minimum-reset', { rows: [sku] })).code, 200)
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM inventory_email_minimum')).rows[0].n, 0)
    const response = await call(returnsHandler, 'confirm', { tracking: 'RETURN1', businessDay: '2026-10-10', items: [{ id: 1, actualQty: 3, restockQty: 3 }] })
    assert.equal(response.code, 200, JSON.stringify(response.body))
    assert.equal((await db.query('SELECT business_day::text AS day FROM inventory_txn_rows')).rows[0].day, '2026-10-10')
    assert.equal((await db.query('SELECT quantity FROM inventory_balance')).rows[0].quantity, 83)
    assert.equal((await call(returnsHandler, 'confirm', { tracking: 'RETURN1', businessDay: '2026-10-10', items: [{ id: 1, actualQty: 3, restockQty: 3 }] })).code, 409)
    const applied = await call(balanceHandler, 'apply', { txnType: 'return', sourceHash: 'return-upload', sourceName: 'returns.xlsx', sourceUnits: 2,
      businessDay: '2026-10-11', filledRows: [{ STYLE: '0055', COLOR: 'BLACK', SIZE: 'S', QTY: 2 }] })
    assert.equal(applied.code, 200, JSON.stringify(applied.body))
    assert.equal((await db.query("SELECT business_day::text AS day FROM inventory_txn_rows WHERE source_file='returns.xlsx'")).rows[0].day, '2026-10-11')
    const defaulted = await call(balanceHandler, 'apply', { txnType: 'return', sourceHash: 'return-today', sourceName: 'today.xlsx', sourceUnits: 1,
      filledRows: [{ STYLE: '0055', COLOR: 'BLACK', SIZE: 'S', QTY: 1 }] })
    assert.equal(defaulted.code, 200, JSON.stringify(defaulted.body))
    assert.equal((await db.query("SELECT business_day::text AS day FROM inventory_txn_rows WHERE source_file='today.xlsx'")).rows[0].day, returnDate.newYorkDate())

    // Exercise actual cron/report/provider handoff entirely locally: no real
    // recipients, provider requests or production records are touched.
    const oldFetch = globalThis.fetch
    const emailKeys = ['CRON_SECRET', 'RESEND_API_KEY', 'INVENTORY_EMAIL_FROM']
    const oldEmailEnv = Object.fromEntries(emailKeys.map((key) => [key, process.env[key]]))
    process.env.CRON_SECRET = 'test-cron'
    process.env.RESEND_API_KEY = 'test-provider'
    process.env.INVENTORY_EMAIL_FROM = 'test@example.com'
    let calls = 0, sentPayload, providerFailure = false, firstPayload
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails')
      calls++
      sentPayload = JSON.parse(options.body)
      assert.equal(options.headers['Idempotency-Key'], `feiya-daily-inventory-v2/${returnDate.newYorkDate()}`)
      if (providerFailure) throw new Error('simulated provider timeout')
      return { ok: true, json: async () => ({ id: 'local-email-test' }) }
    }
    try {
      const day = returnDate.newYorkDate()
      const yesterday = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
      const oldDay = new Date(Date.parse(`${day}T12:00:00Z`) - 22 * 86400000).toISOString().slice(0, 10)
      await db.exec(`UPDATE inventory_balance SET quantity=80;
        INSERT INTO inventory_transactions(id,transaction_type,rolled_back_at) VALUES(999,'sales',NOW());`)
      await db.query(`INSERT INTO inventory_txn_rows (style,color,size,txn_type,qty,business_day,transaction_id)
        VALUES ('0055','BLACK','S','sales',100,$1,NULL),
          ('0055','BLACK','S','sales',900,$1,999),
          ('0055','BLACK','S','sales',5000,$2,NULL),
          ('UNSELECTED','BLACK','S','sales',7000,$3,NULL)`, [yesterday, oldDay, day])
      assert.equal((await call(emailHandler, 'email-settings', { enabled: true, recipients: ['recipient@example.com'], styles: ['0055'], sendHour: 0 })).code, 200)
      const cronOptions = { method: 'GET', headers: { authorization: 'Bearer test-cron' } }
      const sent = await call(emailHandler, 'email-cron', {}, cronOptions)
      assert.equal(sent.code, 200, JSON.stringify(sent.body))
      assert.equal(sent.body.sent, true)
      assert.equal(calls, 1)
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(sentPayload.attachments[0].content, 'base64'))
      const sheet = workbook.getWorksheet('0055')
      assert.ok(sheet)
      assert.equal(workbook.getWorksheet('UNSELECTED'), undefined)
      const headers = sheet.getRow(5).values
      assert.equal(sheet.getCell(6, headers.indexOf('Minimum')).value.result, 100)
      assert.equal(sheet.getCell(6, headers.indexOf('Replenishment')).value.result, 20)
      assert.match(sheet.getCell('A2').value, new RegExp(`OUT through ${yesterday}`))
      assert.match(sheet.getCell('A2').value, new RegExp(`Returns through ${day}`))
      const settingsBeforeDownload = (await db.query('SELECT * FROM inventory_email_settings')).rows
      const stockBeforeDownload = (await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows
      const runsBeforeDownload = (await db.query('SELECT * FROM inventory_email_runs')).rows
      delete process.env.RESEND_API_KEY
      delete process.env.INVENTORY_EMAIL_FROM
      const downloaded = await call(emailHandler, 'email-download', { styles: ['0055'], recipients: [] })
      assert.equal(downloaded.code, 200, JSON.stringify(downloaded.body))
      assert.match(downloaded.headers['Content-Type'], /spreadsheetml/)
      assert.match(downloaded.headers['Content-Disposition'], /daily_inventory_performance_/)
      const downloadedWorkbook = new ExcelJS.Workbook()
      await downloadedWorkbook.xlsx.load(downloaded.body)
      assert.equal(downloadedWorkbook.getWorksheet('UNSELECTED'), undefined)
      const downloadedSheet = downloadedWorkbook.getWorksheet('0055')
      const downloadedHeaders = downloadedSheet.getRow(5).values
      assert.equal(downloadedSheet.getCell(6, downloadedHeaders.indexOf('Replenishment')).value.result, 20)
      assert.deepEqual((await db.query('SELECT * FROM inventory_email_settings')).rows, settingsBeforeDownload)
      assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows, stockBeforeDownload)
      assert.deepEqual((await db.query('SELECT * FROM inventory_email_runs')).rows, runsBeforeDownload)
      assert.equal(calls, 1)
      assert.equal((await call(emailHandler, 'email-download', { styles: [] })).code, 400)
      assert.equal((await call(emailHandler, 'email-download', { styles: ['0055'] }, { headers: {} })).code, 401)
      process.env.RESEND_API_KEY = 'test-resend'
      process.env.INVENTORY_EMAIL_FROM = 'test@example.com'
      assert.equal((await call(emailHandler, 'email-cron', {}, cronOptions)).body.skipped, true)
      assert.equal(calls, 1)
      assert.equal((await db.query('SELECT status FROM inventory_email_runs')).rows[0].status, 'sent')
      assert.equal((await db.query('SELECT payload FROM inventory_email_runs')).rows[0].payload, null)
      firstPayload = sentPayload
      await db.query("UPDATE inventory_email_runs SET status='failed',payload=$1", [JSON.stringify(firstPayload)])
      providerFailure = true
      const failed = await call(emailHandler, 'email-cron', {}, cronOptions)
      assert.equal(failed.code, 500)
      assert.equal((await db.query('SELECT status FROM inventory_email_runs')).rows[0].status, 'failed')
      assert.deepEqual(sentPayload, firstPayload)
      // A retry must keep the exact same attachment even when stock changes.
      await db.exec('UPDATE inventory_balance SET quantity=999')
      providerFailure = false
      assert.equal((await call(emailHandler, 'email-cron', {}, cronOptions)).body.sent, true)
      assert.deepEqual(sentPayload, firstPayload)
      await db.query("UPDATE inventory_email_runs SET status='sending',created_at=NOW(),payload=$1", [JSON.stringify(firstPayload)])
      const beforeLease = calls
      assert.equal((await call(emailHandler, 'email-cron', {}, cronOptions)).body.skipped, true)
      assert.equal(calls, beforeLease)
      await db.exec("UPDATE inventory_email_runs SET created_at=NOW()-INTERVAL '11 minutes'")
      assert.equal((await call(emailHandler, 'email-cron', {}, cronOptions)).body.sent, true)
      assert.deepEqual(sentPayload, firstPayload)
      assert.equal((await call(emailHandler, 'email-minimum-upload', { rows: [sku] }, { headers: {} })).code, 401)
      assert.equal((await call(emailHandler, 'email-nonsense', {})).code, 400)
      assert.equal((await db.query('SELECT styles FROM inventory_email_settings')).rows[0].styles[0], '0055')
    } finally {
      globalThis.fetch = oldFetch
      for (const key of emailKeys) if (oldEmailEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEmailEnv[key]
    }
  } finally {
    neonConfig.fetchFunction = previousFetch
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret
    await db.close()
  }
})
