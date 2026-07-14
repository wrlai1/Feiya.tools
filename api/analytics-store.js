// api/analytics-store.js
// Per-account stores + their daily analytics data (Analytics page).
// One saved upload = one day of data for one store.
//
//   GET    ?action=stores                    — list this user's stores (+ day counts / range)
//   POST   ?action=create-store  {name}      — create an empty store
//   DELETE ?action=delete-store&name=        — delete a store and all its days
//   POST   ?action=save-day {store,day,fileName,rows}  — upsert one day's rows
//   GET    ?action=range&store=&from=&to=    — all rows across the day range (each tagged with date)
//   GET    ?action=daily-logs&store=&from=&to= — daily notes in a date range
//   POST   ?action=save-daily-log {store,day,note} — upsert or clear a daily note
//   DELETE ?action=delete-day&store=&day=    — remove one saved day
//   DELETE ?action=delete-range&store=&from=&to= — remove saved days in a date range
//   GET    ?action=events&store=             — list recent store operation log
//   POST   ?action=restore-event {eventId}   — restore data from an operation snapshot
//   GET    ?action=products&store=           — list product catalog rows for a store
//   POST   ?action=save-products {store,products,fileName} — replace product catalog for a store
//   GET    ?action=settings&store=           — get scoring/diagnosis settings
//   POST   ?action=save-settings {store,settings} — save scoring/diagnosis settings

import { neon } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'

function getDB() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  return neon(url)
}
function getSecret() {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET not set')
  return s
}
function verifyToken(header, secret) {
  if (!header?.startsWith('Bearer ')) return null
  try { return jwt.verify(header.slice(7), secret) } catch { return null }
}

function dayString(value) {
  if (!value) return ''
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

async function ensureTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_stores (
      username   TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, name)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_days (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      day        DATE NOT NULL,
      file_name  TEXT,
      rows       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, day)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_products (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      spu        TEXT NOT NULL,
      data       JSONB NOT NULL,
      file_name  TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, spu)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_settings (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_events (
      id         BIGSERIAL PRIMARY KEY,
      username   TEXT NOT NULL,
      actor      TEXT NOT NULL,
      store      TEXT,
      action     TEXT NOT NULL,
      summary    TEXT,
      details    JSONB,
      snapshot   JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_daily_logs (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      day        DATE NOT NULL,
      note       TEXT NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, day)
    )
  `
}

async function recordEvent(sql, username, actor, store, action, summary, details = {}, snapshot = null) {
  const detailsJson = JSON.stringify(details || {})
  const snapshotJson = snapshot ? JSON.stringify(snapshot) : null
  await sql`
    INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
    VALUES (${username}, ${actor}, ${store || null}, ${action}, ${summary || null}, ${detailsJson}::jsonb, ${snapshotJson}::jsonb)
  `
}

async function restoreSnapshot(sql, username, snapshot) {
  if (!snapshot?.type) return { restored: 0 }

  if (snapshot.type === 'days') {
    let restored = 0
    for (const item of snapshot.days || []) {
      const rowsJson = JSON.stringify(item.rows || [])
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${snapshot.store}, ${item.day}, ${item.fileName || null}, ${rowsJson}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `
      restored += 1
    }
    return { restored }
  }

  if (snapshot.type === 'day') {
    if (snapshot.previous) {
      const rowsJson = JSON.stringify(snapshot.previous.rows || [])
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${snapshot.store}, ${snapshot.day}, ${snapshot.previous.fileName || null}, ${rowsJson}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `
      return { restored: 1 }
    }
    await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${snapshot.store} AND day = ${snapshot.day}`
    return { restored: 0 }
  }

  if (snapshot.type === 'products') {
    await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${snapshot.store}`
    for (const product of snapshot.products || []) {
      const spu = String(product?.spu || product?.data?.spu || '').trim()
      const data = product?.data || product
      if (!spu || !data) continue
      const json = JSON.stringify(data)
      await sql`
        INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
        VALUES (${username}, ${snapshot.store}, ${spu}, ${json}::jsonb, ${product.fileName || null}, NOW())
        ON CONFLICT (username, store, spu)
        DO UPDATE SET data = EXCLUDED.data, file_name = EXCLUDED.file_name, updated_at = NOW()
      `
    }
    return { restored: (snapshot.products || []).length }
  }

  if (snapshot.type === 'settings') {
    if (snapshot.previous) {
      const json = JSON.stringify(snapshot.previous.data || {})
      await sql`
        INSERT INTO analytics_store_settings (username, store, data, updated_at)
        VALUES (${username}, ${snapshot.store}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `
      return { restored: 1 }
    }
    await sql`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${snapshot.store}`
    return { restored: 0 }
  }

  if (snapshot.type === 'store') {
    await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${snapshot.store}) ON CONFLICT DO NOTHING`
    await restoreSnapshot(sql, username, { type: 'days', store: snapshot.store, days: snapshot.days || [] })
    await restoreSnapshot(sql, username, { type: 'products', store: snapshot.store, products: snapshot.products || [] })
    if (snapshot.settings) {
      await restoreSnapshot(sql, username, { type: 'settings', store: snapshot.store, previous: snapshot.settings })
    }
    return { restored: 1 }
  }

  return { restored: 0 }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql     = getDB()
    const payload = verifyToken(req.headers.authorization, getSecret())
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    const actor = payload.username
    const username = payload.role === 'admin' ? 'admin' : payload.username
    const action   = req.query.action
    await ensureTables(sql)

    if (req.method === 'GET' && action === 'stores') {
      const rows = await sql`
        SELECT s.name,
               COUNT(d.day)::int AS days,
               MIN(d.day) AS first_day,
               MAX(d.day) AS last_day
        FROM analytics_stores s
        LEFT JOIN analytics_store_days d ON d.username = s.username AND d.store = s.name
        WHERE s.username = ${username}
        GROUP BY s.name
        ORDER BY s.name
      `
      return res.json({ stores: rows })
    }

    if (req.method === 'POST' && action === 'create-store') {
      const name = String(req.body?.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`
      await recordEvent(sql, username, actor, name, 'create-store', `Created store ${name}`, { store: name })
      return res.json({ ok: true, name })
    }

    if (req.method === 'DELETE' && action === 'delete-store') {
      const name = String(req.query.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${name}
        ORDER BY day
      `
      const productRows = await sql`
        SELECT spu, data, file_name FROM analytics_store_products
        WHERE username = ${username} AND store = ${name}
        ORDER BY spu
      `
      const settingRows = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND store = ${name}
        LIMIT 1
      `
      const snapshot = {
        type: 'store',
        store: name,
        days: dayRows.map((d) => ({ day: dayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] })),
        products: productRows.map((p) => ({ spu: p.spu, data: p.data, fileName: p.file_name })),
        settings: settingRows[0] ? { data: settingRows[0].data } : null,
      }
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${name}`
      await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`
      await sql`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${name}`
      await sql`DELETE FROM analytics_stores WHERE username = ${username} AND name = ${name}`
      await recordEvent(sql, username, actor, name, 'delete-store', `Deleted store ${name}`, {
        store: name,
        days: snapshot.days.length,
        products: snapshot.products.length,
      }, snapshot)
      return res.json({ ok: true })
    }

    if (req.method === 'GET' && action === 'products') {
      const store = String(req.query.store || '').trim()
      if (!store) return res.status(400).json({ error: 'store is required' })
      const rows = await sql`
        SELECT data FROM analytics_store_products
        WHERE username = ${username} AND store = ${store}
        ORDER BY data->>'sku', spu
      `
      return res.json({ products: rows.map((r) => r.data) })
    }

    if (req.method === 'POST' && action === 'save-products') {
      const { store, products, fileName } = req.body || {}
      const name = String(store || '').trim()
      if (!name || !Array.isArray(products)) {
        return res.status(400).json({ error: 'store and products are required' })
      }
      const previousProducts = await sql`
        SELECT spu, data, file_name FROM analytics_store_products
        WHERE username = ${username} AND store = ${name}
        ORDER BY spu
      `
      const previousSpus = new Set(previousProducts.map((p) => String(p.spu || p.data?.spu || '').trim()).filter(Boolean))
      const newProducts = products
        .filter((product) => {
          const spu = String(product?.spu || '').trim()
          return spu && !previousSpus.has(spu)
        })
        .map((product) => ({
          spu: String(product?.spu || '').trim(),
          sku: String(product?.sku || '').trim(),
          name: String(product?.newProductName || product?.productName || product?.sku || product?.spu || '').trim(),
        }))
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`
      await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`
      for (const product of products) {
        const spu = String(product?.spu || '').trim()
        if (!spu) continue
        const json = JSON.stringify({ ...product, store: product.store || name, spu })
        await sql`
          INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
          VALUES (${username}, ${name}, ${spu}, ${json}::jsonb, ${fileName || null}, NOW())
          ON CONFLICT (username, store, spu)
          DO UPDATE SET data = EXCLUDED.data, file_name = EXCLUDED.file_name, updated_at = NOW()
        `
      }
      await recordEvent(sql, username, actor, name, 'save-products', `Saved ${products.length} product catalog rows`, {
        store: name,
        fileName: fileName || null,
        count: products.length,
        newCount: newProducts.length,
        newProducts: newProducts.slice(0, 50),
      }, {
        type: 'products',
        store: name,
        products: previousProducts.map((p) => ({ spu: p.spu, data: p.data, fileName: p.file_name })),
      })
      return res.json({ ok: true, count: products.length })
    }

    if (req.method === 'GET' && action === 'settings') {
      const store = String(req.query.store || '__global__').trim() || '__global__'
      const rows = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND (store = ${store} OR store = '__global__')
        ORDER BY CASE WHEN store = ${store} THEN 0 ELSE 1 END
        LIMIT 1
      `
      return res.json({ settings: rows[0]?.data || null })
    }

    if (req.method === 'POST' && action === 'save-settings') {
      const { store, settings } = req.body || {}
      const name = String(store || '__global__').trim() || '__global__'
      if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings are required' })
      const previousSettings = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND store = ${name}
        LIMIT 1
      `
      const json = JSON.stringify(settings)
      await sql`
        INSERT INTO analytics_store_settings (username, store, data, updated_at)
        VALUES (${username}, ${name}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `
      await recordEvent(sql, username, actor, name, 'save-settings', `Saved analytics settings for ${name}`, {
        store: name,
      }, {
        type: 'settings',
        store: name,
        previous: previousSettings[0] ? { data: previousSettings[0].data } : null,
      })
      return res.json({ ok: true, settings })
    }

    if (req.method === 'POST' && action === 'save-day') {
      const { store, day, fileName, rows } = req.body || {}
      const name = String(store || '').trim()
      if (!name || !day || !Array.isArray(rows)) {
        return res.status(400).json({ error: 'store, day and rows are required' })
      }
      const previousDay = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${name} AND day = ${day}
        LIMIT 1
      `
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`
      const json = JSON.stringify(rows)
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${name}, ${day}, ${fileName || null}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `
      await recordEvent(sql, username, actor, name, 'save-day', `Saved ${rows.length} rows for ${name} on ${day}`, {
        store: name,
        day,
        fileName: fileName || null,
        rows: rows.length,
      }, {
        type: 'day',
        store: name,
        day,
        previous: previousDay[0]
          ? { day: dayString(previousDay[0].day), fileName: previousDay[0].file_name, rows: Array.isArray(previousDay[0].rows) ? previousDay[0].rows : [] }
          : null,
      })
      return res.json({ ok: true })
    }

    if (req.method === 'GET' && action === 'range') {
      const store = String(req.query.store || '').trim()
      const from  = req.query.from
      const to    = req.query.to
      if (!store || !from || !to) return res.status(400).json({ error: 'store, from and to are required' })
      const days = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      // Flatten every day's rows, tagging each with its date so callers can group
      // by product (window totals) or by date (a trend within the window).
      const rows = []
      const summary = []
      for (const d of days) {
        const dayStr = d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10)
        const dayRows = Array.isArray(d.rows) ? d.rows : []
        summary.push({ day: dayStr, fileName: d.file_name, rowCount: dayRows.length })
        for (const r of dayRows) rows.push({ ...r, date: dayStr })
      }
      return res.json({ days: summary, rows })
    }

    if (req.method === 'GET' && action === 'daily-logs') {
      const store = String(req.query.store || '').trim()
      const from = req.query.from
      const to = req.query.to
      if (!store || !from || !to) return res.status(400).json({ error: 'store, from and to are required' })
      const rows = await sql`
        SELECT day, note, updated_by, updated_at
        FROM analytics_daily_logs
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      return res.json({
        logs: rows.map((row) => ({
          day: dayString(row.day),
          note: row.note,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
        })),
      })
    }

    if (req.method === 'POST' && action === 'save-daily-log') {
      const store = String(req.body?.store || '').trim()
      const day = String(req.body?.day || '').slice(0, 10)
      const note = String(req.body?.note || '').trim()
      if (!store || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return res.status(400).json({ error: 'store and a valid day are required' })
      }
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${store}) ON CONFLICT DO NOTHING`
      if (!note) {
        await sql`DELETE FROM analytics_daily_logs WHERE username = ${username} AND store = ${store} AND day = ${day}`
        return res.json({ ok: true, deleted: true })
      }
      await sql`
        INSERT INTO analytics_daily_logs (username, store, day, note, updated_by, updated_at)
        VALUES (${username}, ${store}, ${day}, ${note}, ${actor}, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()
      `
      return res.json({ ok: true, log: { day, note, updatedBy: actor } })
    }

    if (req.method === 'DELETE' && action === 'delete-day') {
      const store = String(req.query.store || '').trim()
      const day   = req.query.day
      if (!store || !day) return res.status(400).json({ error: 'store and day are required' })
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day = ${day}
      `
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${store} AND day = ${day}`
      const snapshotDays = dayRows.map((d) => ({ day: dayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }))
      await recordEvent(sql, username, actor, store, 'delete-day', `Deleted ${store} data on ${day}`, {
        store,
        from: day,
        to: day,
        days: snapshotDays.length,
        rows: snapshotDays.reduce((total, d) => total + d.rows.length, 0),
      }, { type: 'days', store, days: snapshotDays })
      return res.json({ ok: true })
    }

    if (req.method === 'DELETE' && action === 'delete-range') {
      const store = String(req.query.store || '').trim()
      const from  = req.query.from
      const to    = req.query.to
      if (!store || !from || !to) return res.status(400).json({ error: 'store, from and to are required' })
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      const snapshotDays = dayRows.map((d) => ({ day: dayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }))
      await sql`
        DELETE FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
      `
      const rowCount = snapshotDays.reduce((total, d) => total + d.rows.length, 0)
      await recordEvent(sql, username, actor, store, 'delete-range', `Deleted ${snapshotDays.length} saved days from ${store}`, {
        store,
        from,
        to,
        days: snapshotDays.length,
        rows: rowCount,
      }, { type: 'days', store, days: snapshotDays })
      return res.json({ ok: true, days: snapshotDays.length, rows: rowCount })
    }

    if (req.method === 'GET' && action === 'events') {
      const store = String(req.query.store || '').trim()
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100)
      const rows = store
        ? await sql`
            SELECT id, actor, store, action, summary, details, created_at, snapshot IS NOT NULL AS restorable
            FROM analytics_store_events
            WHERE username = ${username} AND store = ${store}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT id, actor, store, action, summary, details, created_at, snapshot IS NOT NULL AS restorable
            FROM analytics_store_events
            WHERE username = ${username}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
      return res.json({ events: rows })
    }

    if (req.method === 'POST' && action === 'restore-event') {
      const eventId = Number(req.body?.eventId)
      if (!eventId) return res.status(400).json({ error: 'eventId is required' })
      const rows = await sql`
        SELECT id, store, action, summary, snapshot
        FROM analytics_store_events
        WHERE username = ${username} AND id = ${eventId}
        LIMIT 1
      `
      const event = rows[0]
      if (!event?.snapshot) return res.status(400).json({ error: 'This event has no restore snapshot' })
      const result = await restoreSnapshot(sql, username, event.snapshot)
      await recordEvent(sql, username, actor, event.store, 'restore-event', `Restored event #${eventId}`, {
        eventId,
        restoredFrom: event.action,
        restored: result.restored,
      }, null)
      return res.json({ ok: true, ...result })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
