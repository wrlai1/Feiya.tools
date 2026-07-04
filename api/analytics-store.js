// api/analytics-store.js
// Per-account stores + their daily analytics data (Analytics page).
// One saved upload = one day of data for one store.
//
//   GET    ?action=stores                    — list this user's stores (+ day counts / range)
//   POST   ?action=create-store  {name}      — create an empty store
//   DELETE ?action=delete-store&name=        — delete a store and all its days
//   POST   ?action=save-day {store,day,fileName,rows}  — upsert one day's rows
//   GET    ?action=range&store=&from=&to=    — all rows across the day range (each tagged with date)
//   DELETE ?action=delete-day&store=&day=    — remove one saved day
//   GET    ?action=products&store=           — list product catalog rows for a store
//   POST   ?action=save-products {store,products,fileName} — replace product catalog for a store

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
    const username = payload.username
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
      return res.json({ ok: true, name })
    }

    if (req.method === 'DELETE' && action === 'delete-store') {
      const name = String(req.query.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${name}`
      await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`
      await sql`DELETE FROM analytics_stores WHERE username = ${username} AND name = ${name}`
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
      return res.json({ ok: true, count: products.length })
    }

    if (req.method === 'POST' && action === 'save-day') {
      const { store, day, fileName, rows } = req.body || {}
      const name = String(store || '').trim()
      if (!name || !day || !Array.isArray(rows)) {
        return res.status(400).json({ error: 'store, day and rows are required' })
      }
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`
      const json = JSON.stringify(rows)
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${name}, ${day}, ${fileName || null}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `
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

    if (req.method === 'DELETE' && action === 'delete-day') {
      const store = String(req.query.store || '').trim()
      const day   = req.query.day
      if (!store || !day) return res.status(400).json({ error: 'store and day are required' })
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${store} AND day = ${day}`
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
