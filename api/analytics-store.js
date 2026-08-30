// api/analytics-store.js
// Per-account stores + daily and aggregate-period analytics data (Analytics page).
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
import authentication from '../lib/authentication.cjs'

const { authenticateUser } = authentication

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
function dayString(value) {
  if (!value) return ''
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function strictDay(value) {
  const day = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const parsed = new Date(`${day}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? '' : day
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
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
    CREATE TABLE IF NOT EXISTS analytics_store_periods (
      username     TEXT NOT NULL,
      store        TEXT NOT NULL,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      file_name    TEXT,
      rows         JSONB NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, period_start, period_end)
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
      tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
      follow_up  TEXT,
      follow_up_done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, day)
    )
  `
  await sql`ALTER TABLE analytics_daily_logs ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE analytics_daily_logs ADD COLUMN IF NOT EXISTS follow_up TEXT`
  await sql`ALTER TABLE analytics_daily_logs ADD COLUMN IF NOT EXISTS follow_up_done BOOLEAN NOT NULL DEFAULT FALSE`
}

async function recordEvent(sql, username, actor, store, action, summary, details = {}, snapshot = null) {
  const detailsJson = JSON.stringify(details || {})
  const snapshotJson = snapshot ? JSON.stringify(snapshot) : null
  await sql`
    INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
    VALUES (${username}, ${actor}, ${store || null}, ${action}, ${summary || null}, ${detailsJson}::jsonb, ${snapshotJson}::jsonb)
  `
}

function restoreSnapshotQueries(txn, username, snapshot) {
  if (!snapshot?.type) return { queries: [], restored: 0 }

  if (snapshot.type === 'days') {
    const store = String(snapshot.store || '').trim()
    const days = (Array.isArray(snapshot.days) ? snapshot.days : [])
      .map((item) => ({
        day: strictDay(item?.day),
        fileName: item?.fileName || null,
        rows: Array.isArray(item?.rows) ? item.rows : [],
      }))
      .filter((item) => item.day)
    if (!store || !days.length) return { queries: [], restored: 0 }
    const json = JSON.stringify(days)
    return {
      queries: [txn`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        SELECT ${username}, ${store}, item->>'day', NULLIF(item->>'fileName', ''),
               COALESCE(item->'rows', '[]'::jsonb), NOW()
        FROM jsonb_array_elements(${json}::jsonb) AS item
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `],
      restored: days.length,
    }
  }

  if (snapshot.type === 'periods') {
    const store = String(snapshot.store || '').trim()
    const periods = (Array.isArray(snapshot.periods) ? snapshot.periods : [])
      .map((item) => ({
        periodStart: strictDay(item?.periodStart),
        periodEnd: strictDay(item?.periodEnd),
        fileName: item?.fileName || null,
        rows: Array.isArray(item?.rows) ? item.rows : [],
      }))
      .filter((item) => item.periodStart && item.periodEnd && item.periodStart < item.periodEnd)
    if (!store || !periods.length) return { queries: [], restored: 0 }
    const json = JSON.stringify(periods)
    return {
      queries: [txn`
        INSERT INTO analytics_store_periods
          (username, store, period_start, period_end, file_name, rows, updated_at)
        SELECT ${username}, ${store}, (item->>'periodStart')::date, (item->>'periodEnd')::date,
               NULLIF(item->>'fileName', ''), COALESCE(item->'rows', '[]'::jsonb), NOW()
        FROM jsonb_array_elements(${json}::jsonb) AS item
        ON CONFLICT (username, store, period_start, period_end)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `],
      restored: periods.length,
    }
  }

  if (snapshot.type === 'analytics-data-batch') {
    const store = String(snapshot.store || '').trim()
    if (!store) return { queries: [], restored: 0 }
    const targetDays = [...new Set((snapshot.targetDays || []).map(strictDay).filter(Boolean))]
    const targetPeriods = (snapshot.targetPeriods || [])
      .map((item) => ({ periodStart: strictDay(item?.periodStart), periodEnd: strictDay(item?.periodEnd) }))
      .filter((item) => item.periodStart && item.periodEnd)
    const queries = []
    if (targetDays.length) {
      queries.push(txn`
        DELETE FROM analytics_store_days
        WHERE username = ${username} AND store = ${store}
          AND day IN (SELECT value::date FROM jsonb_array_elements_text(${JSON.stringify(targetDays)}::jsonb))
      `)
    }
    if (targetPeriods.length) {
      queries.push(txn`
        DELETE FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND (period_start, period_end) IN (
            SELECT (item->>'periodStart')::date, (item->>'periodEnd')::date
            FROM jsonb_array_elements(${JSON.stringify(targetPeriods)}::jsonb) AS item
          )
      `)
    }
    const previousDays = restoreSnapshotQueries(txn, username, { type: 'days', store, days: snapshot.previousDays || [] })
    const previousPeriods = restoreSnapshotQueries(txn, username, { type: 'periods', store, periods: snapshot.previousPeriods || [] })
    queries.push(...previousDays.queries, ...previousPeriods.queries)
    return { queries, restored: previousDays.restored + previousPeriods.restored }
  }

  if (snapshot.type === 'day') {
    const store = String(snapshot.store || '').trim()
    const day = strictDay(snapshot.day)
    if (!store || !day) return { queries: [], restored: 0 }
    if (snapshot.previous) {
      const rowsJson = JSON.stringify(Array.isArray(snapshot.previous.rows) ? snapshot.previous.rows : [])
      return {
        queries: [txn`
          INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
          VALUES (${username}, ${store}, ${day}, ${snapshot.previous.fileName || null}, ${rowsJson}::jsonb, NOW())
          ON CONFLICT (username, store, day)
          DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
        `],
        restored: 1,
      }
    }
    return {
      queries: [txn`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${store} AND day = ${day}`],
      restored: 0,
    }
  }

  if (snapshot.type === 'day-batch') {
    const store = String(snapshot.store || '').trim()
    const targetDays = [...new Set((Array.isArray(snapshot.targetDays) ? snapshot.targetDays : []).map(strictDay).filter(Boolean))]
    const previous = (Array.isArray(snapshot.previous) ? snapshot.previous : [])
      .map((item) => ({
        day: strictDay(item?.day),
        fileName: item?.fileName || null,
        rows: Array.isArray(item?.rows) ? item.rows : [],
      }))
      .filter((item) => item.day)
    if (!store || !targetDays.length) return { queries: [], restored: 0 }
    const queries = [txn`
      DELETE FROM analytics_store_days
      WHERE username = ${username} AND store = ${store}
        AND day IN (SELECT value::date FROM jsonb_array_elements_text(${JSON.stringify(targetDays)}::jsonb))
    `]
    if (previous.length) {
      const json = JSON.stringify(previous)
      queries.push(txn`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        SELECT ${username}, ${store}, (item->>'day')::date, NULLIF(item->>'fileName', ''),
               COALESCE(item->'rows', '[]'::jsonb), NOW()
        FROM jsonb_array_elements(${json}::jsonb) AS item
      `)
    }
    return { queries, restored: previous.length }
  }

  if (snapshot.type === 'products') {
    const store = String(snapshot.store || '').trim()
    if (!store) return { queries: [], restored: 0 }
    const products = (Array.isArray(snapshot.products) ? snapshot.products : [])
      .map((product) => ({
        spu: String(product?.spu || product?.data?.spu || '').trim(),
        data: product?.data || product,
        fileName: product?.fileName || null,
      }))
      .filter((product) => product.spu && product.data)
    const queries = [txn`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${store}`]
    if (products.length) {
      const json = JSON.stringify(products)
      queries.push(txn`
        INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
        SELECT ${username}, ${store}, item->>'spu', item->'data', NULLIF(item->>'fileName', ''), NOW()
        FROM jsonb_array_elements(${json}::jsonb) AS item
      `)
    }
    return { queries, restored: products.length }
  }

  if (snapshot.type === 'settings') {
    const store = String(snapshot.store || '').trim()
    if (!store) return { queries: [], restored: 0 }
    if (snapshot.previous) {
      const json = JSON.stringify(snapshot.previous.data || {})
      return {
        queries: [txn`
          INSERT INTO analytics_store_settings (username, store, data, updated_at)
          VALUES (${username}, ${store}, ${json}::jsonb, NOW())
          ON CONFLICT (username, store)
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `],
        restored: 1,
      }
    }
    return {
      queries: [txn`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${store}`],
      restored: 0,
    }
  }

  if (snapshot.type === 'logs') {
    const store = String(snapshot.store || '').trim()
    const logs = (Array.isArray(snapshot.logs) ? snapshot.logs : [])
      .map((item) => ({ ...item, day: strictDay(item?.day) }))
      .filter((item) => item.day)
    if (!store || !logs.length) return { queries: [], restored: 0 }
    const json = JSON.stringify(logs)
    return {
      queries: [txn`
        INSERT INTO analytics_daily_logs
          (username, store, day, note, tags, follow_up, follow_up_done, updated_by, updated_at)
        SELECT ${username}, ${store}, item->>'day', COALESCE(item->>'note', ''),
               COALESCE(item->'tags', '[]'::jsonb), NULLIF(item->>'followUp', ''),
               COALESCE((item->>'followUpDone')::boolean, FALSE),
               NULLIF(item->>'updatedBy', ''), NOW()
        FROM jsonb_array_elements(${json}::jsonb) AS item
        ON CONFLICT (username, store, day)
        DO UPDATE SET note = EXCLUDED.note, tags = EXCLUDED.tags, follow_up = EXCLUDED.follow_up,
          follow_up_done = EXCLUDED.follow_up_done, updated_by = EXCLUDED.updated_by, updated_at = NOW()
      `],
      restored: logs.length,
    }
  }

  if (snapshot.type === 'store') {
    const store = String(snapshot.store || '').trim()
    if (!store) return { queries: [], restored: 0 }
    const queries = [txn`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${store}) ON CONFLICT DO NOTHING`]
    const children = [
      { type: 'days', store, days: snapshot.days || [] },
      { type: 'periods', store, periods: snapshot.periods || [] },
      { type: 'products', store, products: snapshot.products || [] },
      { type: 'logs', store, logs: snapshot.logs || [] },
    ]
    if (snapshot.settings) children.push({ type: 'settings', store, previous: snapshot.settings })
    for (const child of children) queries.push(...restoreSnapshotQueries(txn, username, child).queries)
    return { queries, restored: 1 }
  }

  return { queries: [], restored: 0 }
}

async function restoreSnapshot(sql, username, snapshot) {
  let restored = 0
  await sql.transaction((txn) => {
    const result = restoreSnapshotQueries(txn, username, snapshot)
    restored = result.restored
    return [
      txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
      ...result.queries,
    ]
  }, { isolationLevel: 'Serializable' })
  return { restored }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql     = getDB()
    const payload = await authenticateUser(sql, req.headers.authorization, getSecret())
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    const actor = payload.username
    const username = payload.role === 'admin' ? 'admin' : payload.username
    const action   = req.query.action
    await ensureTables(sql)

    if (req.method === 'GET' && action === 'stores') {
      const rows = await sql`
        SELECT s.name,
               (SELECT COUNT(*)::int FROM analytics_store_days d
                WHERE d.username = s.username AND d.store = s.name) AS days,
               (SELECT COUNT(*)::int FROM analytics_store_periods p
                WHERE p.username = s.username AND p.store = s.name) AS periods,
               (SELECT MAX(d.day) FROM analytics_store_days d
                WHERE d.username = s.username AND d.store = s.name) AS last_daily_day,
               (SELECT MAX(p.period_end) FROM analytics_store_periods p
                WHERE p.username = s.username AND p.store = s.name) AS last_period_end,
               LEAST(
                 (SELECT MIN(d.day) FROM analytics_store_days d WHERE d.username = s.username AND d.store = s.name),
                 (SELECT MIN(p.period_start) FROM analytics_store_periods p WHERE p.username = s.username AND p.store = s.name)
               ) AS first_day,
               GREATEST(
                 (SELECT MAX(d.day) FROM analytics_store_days d WHERE d.username = s.username AND d.store = s.name),
                 (SELECT MAX(p.period_end) FROM analytics_store_periods p WHERE p.username = s.username AND p.store = s.name)
               ) AS last_day
        FROM analytics_stores s
        WHERE s.username = ${username}
        ORDER BY s.name
      `
      return res.json({ stores: rows })
    }

    if (req.method === 'POST' && action === 'create-store') {
      const name = String(req.body?.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      if (name.length > 100) return res.status(400).json({ error: 'Store name is too long' })
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          WITH inserted AS (
            INSERT INTO analytics_stores (username, name)
            SELECT ${username}, ${name}
            WHERE NOT EXISTS (
              SELECT 1 FROM analytics_stores
              WHERE username = ${username} AND LOWER(name) = LOWER(${name})
            )
            RETURNING name
          )
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          SELECT ${username}, ${actor}, name, 'create-store', ${`Created store ${name}`},
                 jsonb_build_object('store', name), NULL
          FROM inserted
          RETURNING id
        `,
      ], { isolationLevel: 'Serializable' })
      if (!results[1].length) return res.status(409).json({ error: 'A store with this name already exists' })
      return res.json({ ok: true, name })
    }

    if (req.method === 'DELETE' && action === 'delete-store') {
      const name = String(req.query.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          SELECT ${username}, ${actor}, ${name}, 'delete-store', ${`Deleted store ${name}`},
            jsonb_build_object(
              'store', ${name},
              'days', (SELECT COUNT(*) FROM analytics_store_days WHERE username = ${username} AND store = ${name}),
              'periods', (SELECT COUNT(*) FROM analytics_store_periods WHERE username = ${username} AND store = ${name}),
              'products', (SELECT COUNT(*) FROM analytics_store_products WHERE username = ${username} AND store = ${name}),
              'logs', (SELECT COUNT(*) FROM analytics_daily_logs WHERE username = ${username} AND store = ${name})
            ),
            jsonb_build_object(
              'type', 'store',
              'store', ${name},
              'days', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'day', TO_CHAR(day, 'YYYY-MM-DD'), 'fileName', file_name, 'rows', rows
                ) ORDER BY day)
                FROM analytics_store_days WHERE username = ${username} AND store = ${name}
              ), '[]'::jsonb),
              'periods', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'periodStart', TO_CHAR(period_start, 'YYYY-MM-DD'),
                  'periodEnd', TO_CHAR(period_end, 'YYYY-MM-DD'),
                  'fileName', file_name, 'rows', rows
                ) ORDER BY period_start, period_end)
                FROM analytics_store_periods WHERE username = ${username} AND store = ${name}
              ), '[]'::jsonb),
              'products', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'spu', spu, 'data', data, 'fileName', file_name
                ) ORDER BY spu)
                FROM analytics_store_products WHERE username = ${username} AND store = ${name}
              ), '[]'::jsonb),
              'settings', (
                SELECT jsonb_build_object('data', data)
                FROM analytics_store_settings WHERE username = ${username} AND store = ${name}
                LIMIT 1
              ),
              'logs', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'day', TO_CHAR(day, 'YYYY-MM-DD'), 'note', note, 'tags', tags,
                  'followUp', follow_up, 'followUpDone', follow_up_done, 'updatedBy', updated_by
                ) ORDER BY day)
                FROM analytics_daily_logs WHERE username = ${username} AND store = ${name}
              ), '[]'::jsonb)
            )
          WHERE EXISTS (
            SELECT 1 FROM analytics_stores WHERE username = ${username} AND name = ${name}
          )
          RETURNING id
        `,
        txn`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${name}`,
        txn`DELETE FROM analytics_store_periods WHERE username = ${username} AND store = ${name}`,
        txn`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`,
        txn`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${name}`,
        txn`DELETE FROM analytics_daily_logs WHERE username = ${username} AND store = ${name}`,
        txn`DELETE FROM analytics_stores WHERE username = ${username} AND name = ${name} RETURNING name`,
      ], { isolationLevel: 'Serializable' })
      if (!results[7].length) return res.status(404).json({ error: 'Store not found' })
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
      const normalizedProducts = products.map((product, index) => {
        const spu = String(product?.spu || '').trim()
        if (!spu) throw new Error(`Product row ${index + 1} requires SPU`)
        return { ...product, store: name, spu }
      })
      const seenSpus = new Set()
      for (const product of normalizedProducts) {
        const key = product.spu.toLowerCase()
        if (seenSpus.has(key)) return res.status(400).json({ error: `Duplicate SPU in product catalog: ${product.spu}` })
        seenSpus.add(key)
      }
      const json = JSON.stringify(normalizedProducts)
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          VALUES (
            ${username}, ${actor}, ${name}, 'save-products', ${`Saved ${normalizedProducts.length} product catalog rows`},
            jsonb_build_object(
              'store', ${name}::text,
              'fileName', ${fileName || null}::text,
              'count', ${normalizedProducts.length}::int,
              'newCount', (
                SELECT COUNT(*) FROM jsonb_array_elements(${json}::jsonb) AS item
                WHERE NOT EXISTS (
                  SELECT 1 FROM analytics_store_products current
                  WHERE current.username = ${username} AND current.store = ${name}
                    AND LOWER(current.spu) = LOWER(item->>'spu')
                )
              ),
              'newProducts', COALESCE((
                SELECT jsonb_agg(candidate.data)
                FROM (
                  SELECT jsonb_build_object(
                    'spu', item->>'spu', 'sku', COALESCE(item->>'sku', ''),
                    'name', COALESCE(item->>'newProductName', item->>'productName', item->>'sku', item->>'spu', '')
                  ) AS data
                  FROM jsonb_array_elements(${json}::jsonb) AS item
                  WHERE NOT EXISTS (
                    SELECT 1 FROM analytics_store_products current
                    WHERE current.username = ${username} AND current.store = ${name}
                      AND LOWER(current.spu) = LOWER(item->>'spu')
                  )
                  LIMIT 50
                ) AS candidate
              ), '[]'::jsonb)
            ),
            jsonb_build_object(
              'type', 'products', 'store', ${name}::text,
              'products', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'spu', spu, 'data', data, 'fileName', file_name
                ) ORDER BY spu)
                FROM analytics_store_products WHERE username = ${username} AND store = ${name}
              ), '[]'::jsonb)
            )
          )
        `,
        txn`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`,
        txn`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`,
        txn`
          INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
          SELECT ${username}, ${name}, item->>'spu', item, ${fileName || null}, NOW()
          FROM jsonb_array_elements(${json}::jsonb) AS item
        `,
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true, count: normalizedProducts.length })
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
      const json = JSON.stringify(settings)
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          VALUES (
            ${username}, ${actor}, ${name}, 'save-settings', ${`Saved analytics settings for ${name}`},
            jsonb_build_object('store', ${name}::text),
            jsonb_build_object(
              'type', 'settings', 'store', ${name}::text,
              'previous', (
                SELECT jsonb_build_object('data', data)
                FROM analytics_store_settings
                WHERE username = ${username} AND store = ${name}
                LIMIT 1
              )
            )
          )
        `,
        txn`
          INSERT INTO analytics_store_settings (username, store, data, updated_at)
          VALUES (${username}, ${name}, ${json}::jsonb, NOW())
          ON CONFLICT (username, store)
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `,
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true, settings })
    }

    if (req.method === 'POST' && action === 'save-day') {
      const { store, day, fileName, rows } = req.body || {}
      const name = String(store || '').trim()
      const normalizedDay = strictDay(day)
      if (!name || !normalizedDay || !Array.isArray(rows)) {
        return res.status(400).json({ error: 'store, day and rows are required' })
      }
      const json = JSON.stringify(rows)
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          VALUES (
            ${username}, ${actor}, ${name}, 'save-day', ${`Saved ${rows.length} rows for ${name} on ${normalizedDay}`},
            jsonb_build_object(
              'store', ${name}::text, 'day', ${normalizedDay}::text,
              'fileName', ${fileName || null}::text, 'rows', ${rows.length}::int
            ),
            jsonb_build_object(
              'type', 'day', 'store', ${name}::text, 'day', ${normalizedDay}::text,
              'previous', (
                SELECT jsonb_build_object(
                  'day', TO_CHAR(day, 'YYYY-MM-DD'), 'fileName', file_name, 'rows', rows
                )
                FROM analytics_store_days
                WHERE username = ${username} AND store = ${name} AND day = ${normalizedDay}
                LIMIT 1
              )
            )
          )
        `,
        txn`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`,
        txn`
          INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
          VALUES (${username}, ${name}, ${normalizedDay}, ${fileName || null}, ${json}::jsonb, NOW())
          ON CONFLICT (username, store, day)
          DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
        `,
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true })
    }

    if (req.method === 'POST' && action === 'save-days') {
      const { store, days, replaceOverlaps = false } = req.body || {}
      const name = String(store || '').trim()
      const normalizedDays = (Array.isArray(days) ? days : []).map((item) => ({
        periodStart: strictDay(item?.periodStart || item?.day),
        periodEnd: strictDay(item?.periodEnd || item?.day),
        fileName: String(item?.fileName || '').trim() || null,
        rows: Array.isArray(item?.rows) ? item.rows : null,
      })).map((item) => ({
        ...item,
        day: item.periodEnd,
        kind: item.periodStart === item.periodEnd ? 'daily' : 'period',
      }))
      if (!name || !normalizedDays.length || normalizedDays.length > 30
        || normalizedDays.some((item) => !item.periodStart || !item.periodEnd || item.periodStart > item.periodEnd || !item.rows)) {
        return res.status(400).json({ error: 'store and between 1 and 30 valid analytics files are required' })
      }
      for (let index = 0; index < normalizedDays.length; index += 1) {
        for (let other = index + 1; other < normalizedDays.length; other += 1) {
          const left = normalizedDays[index]
          const right = normalizedDays[other]
          if (left.periodStart <= right.periodEnd && left.periodEnd >= right.periodStart) {
            return res.status(400).json({ error: 'Uploaded analytics files contain overlapping date ranges' })
          }
        }
      }
      const json = JSON.stringify(normalizedDays)
      const totalRows = normalizedDays.reduce((sum, item) => sum + item.rows.length, 0)
      if (!replaceOverlaps) {
        const conflicts = await sql`
          SELECT
            EXISTS (
              SELECT 1 FROM analytics_store_days saved
              JOIN jsonb_array_elements(${json}::jsonb) item
                ON saved.day BETWEEN (item->>'periodStart')::date AND (item->>'periodEnd')::date
              WHERE saved.username = ${username} AND saved.store = ${name}
                AND NOT (item->>'kind' = 'daily' AND saved.day = (item->>'periodStart')::date)
            ) OR EXISTS (
              SELECT 1 FROM analytics_store_periods saved
              JOIN jsonb_array_elements(${json}::jsonb) item
                ON saved.period_start <= (item->>'periodEnd')::date
               AND saved.period_end >= (item->>'periodStart')::date
              WHERE saved.username = ${username} AND saved.store = ${name}
                AND NOT (
                  item->>'kind' = 'period'
                  AND saved.period_start = (item->>'periodStart')::date
                  AND saved.period_end = (item->>'periodEnd')::date
                )
            ) AS overlap
        `
        if (conflicts[0]?.overlap) {
          return res.status(409).json({ error: 'This upload overlaps saved daily or period data. Confirm overwrite first.' })
        }
      }
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`
          INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
          VALUES (
            ${username}, ${actor}, ${name}, 'save-days',
            ${`Saved ${totalRows} rows across ${normalizedDays.length} analytics files for ${name}`},
            jsonb_build_object(
              'store', ${name}::text,
              'days', ${normalizedDays.filter((item) => item.kind === 'daily').length}::int,
              'periods', ${normalizedDays.filter((item) => item.kind === 'period').length}::int,
              'rows', ${totalRows}::int
            ),
            jsonb_build_object(
              'type', 'analytics-data-batch', 'store', ${name}::text,
              'targetDays', (
                SELECT jsonb_agg(item->>'day' ORDER BY item->>'day')
                FROM jsonb_array_elements(${json}::jsonb) AS item
                WHERE item->>'kind' = 'daily'
              ),
              'targetPeriods', (
                SELECT jsonb_agg(jsonb_build_object(
                  'periodStart', item->>'periodStart', 'periodEnd', item->>'periodEnd'
                ) ORDER BY item->>'periodStart', item->>'periodEnd')
                FROM jsonb_array_elements(${json}::jsonb) AS item
                WHERE item->>'kind' = 'period'
              ),
              'previousDays', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'day', TO_CHAR(saved.day, 'YYYY-MM-DD'),
                  'fileName', saved.file_name,
                  'rows', saved.rows
                ) ORDER BY saved.day)
                FROM analytics_store_days saved
                WHERE saved.username = ${username} AND saved.store = ${name}
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(${json}::jsonb) AS item
                    WHERE saved.day BETWEEN (item->>'periodStart')::date AND (item->>'periodEnd')::date
                  )
              ), '[]'::jsonb),
              'previousPeriods', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'periodStart', TO_CHAR(saved.period_start, 'YYYY-MM-DD'),
                  'periodEnd', TO_CHAR(saved.period_end, 'YYYY-MM-DD'),
                  'fileName', saved.file_name,
                  'rows', saved.rows
                ) ORDER BY saved.period_start, saved.period_end)
                FROM analytics_store_periods saved
                WHERE saved.username = ${username} AND saved.store = ${name}
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(${json}::jsonb) AS item
                    WHERE saved.period_start <= (item->>'periodEnd')::date
                      AND saved.period_end >= (item->>'periodStart')::date
                  )
              ), '[]'::jsonb)
            )
          )
        `,
        txn`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`,
        txn`
          DELETE FROM analytics_store_days saved
          WHERE ${Boolean(replaceOverlaps)}::boolean
            AND saved.username = ${username} AND saved.store = ${name}
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(${json}::jsonb) AS item
              WHERE saved.day BETWEEN (item->>'periodStart')::date AND (item->>'periodEnd')::date
            )
        `,
        txn`
          DELETE FROM analytics_store_periods saved
          WHERE ${Boolean(replaceOverlaps)}::boolean
            AND saved.username = ${username} AND saved.store = ${name}
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(${json}::jsonb) AS item
              WHERE saved.period_start <= (item->>'periodEnd')::date
                AND saved.period_end >= (item->>'periodStart')::date
            )
        `,
        txn`
          INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
          SELECT ${username}, ${name}, (item->>'day')::date, NULLIF(item->>'fileName', ''),
                 COALESCE(item->'rows', '[]'::jsonb), NOW()
          FROM jsonb_array_elements(${json}::jsonb) AS item
          WHERE item->>'kind' = 'daily'
          ON CONFLICT (username, store, day)
          DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
        `,
        txn`
          INSERT INTO analytics_store_periods
            (username, store, period_start, period_end, file_name, rows, updated_at)
          SELECT ${username}, ${name}, (item->>'periodStart')::date, (item->>'periodEnd')::date,
                 NULLIF(item->>'fileName', ''), COALESCE(item->'rows', '[]'::jsonb), NOW()
          FROM jsonb_array_elements(${json}::jsonb) AS item
          WHERE item->>'kind' = 'period'
          ON CONFLICT (username, store, period_start, period_end)
          DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
        `,
      ], { isolationLevel: 'Serializable' })
      return res.json({
        ok: true,
        days: normalizedDays.filter((item) => item.kind === 'daily').length,
        periods: normalizedDays.filter((item) => item.kind === 'period').length,
        rows: totalRows,
      })
    }

    if (req.method === 'GET' && action === 'range') {
      const store = String(req.query.store || '').trim()
      const from = strictDay(req.query.from)
      const to = strictDay(req.query.to)
      if (!store || !from || !to || from > to) return res.status(400).json({ error: 'store and a valid date range are required' })
      const days = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      const periods = await sql`
        SELECT period_start, period_end, file_name, rows FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND period_start <= ${to} AND period_end >= ${from}
        ORDER BY period_start, period_end
      `
      // Daily rows power trends. Fully-contained aggregate periods join range
      // totals, but remain tagged so daily analysis can exclude them.
      const rows = []
      const summary = []
      for (const d of days) {
        const dayStr = d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10)
        const dayRows = Array.isArray(d.rows) ? d.rows : []
        summary.push({ day: dayStr, fileName: d.file_name, rowCount: dayRows.length })
        for (const r of dayRows) rows.push({ ...r, date: dayStr, dataKind: 'daily', periodStart: dayStr, periodEnd: dayStr })
      }
      const periodSummary = []
      for (const period of periods) {
        const periodStart = dayString(period.period_start)
        const periodEnd = dayString(period.period_end)
        const includedInTotals = periodStart >= from && periodEnd <= to
        const periodRows = Array.isArray(period.rows) ? period.rows : []
        periodSummary.push({
          periodStart,
          periodEnd,
          fileName: period.file_name,
          rowCount: periodRows.length,
          includedInTotals,
        })
        if (includedInTotals) {
          for (const r of periodRows) {
            rows.push({ ...r, date: periodEnd, dataKind: 'period', periodStart, periodEnd })
          }
        }
      }
      return res.json({ days: summary, periods: periodSummary, rows })
    }

    if (req.method === 'GET' && action === 'daily-logs') {
      const store = String(req.query.store || '').trim()
      const from = strictDay(req.query.from)
      const to = strictDay(req.query.to)
      if (!store || !from || !to || from > to) return res.status(400).json({ error: 'store and a valid date range are required' })
      const rows = await sql`
        SELECT day, note, tags, follow_up, follow_up_done, updated_by, updated_at
        FROM analytics_daily_logs
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      return res.json({
        logs: rows.map((row) => ({
          day: dayString(row.day),
          note: row.note,
          tags: Array.isArray(row.tags) ? row.tags : [],
          followUp: row.follow_up || '',
          followUpDone: Boolean(row.follow_up_done),
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
        })),
      })
    }

    if (req.method === 'POST' && action === 'save-daily-log') {
      const store = String(req.body?.store || '').trim()
      const day = strictDay(req.body?.day)
      const note = String(req.body?.note || '').trim()
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10) : []
      const followUp = String(req.body?.followUp || '').trim()
      const followUpDone = Boolean(req.body?.followUpDone)
      if (!store || !day) {
        return res.status(400).json({ error: 'store and a valid day are required' })
      }
      if (!note && !followUp) {
        await sql.transaction((txn) => [
          txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
          txn`DELETE FROM analytics_daily_logs WHERE username = ${username} AND store = ${store} AND day = ${day}`,
        ], { isolationLevel: 'Serializable' })
        return res.json({ ok: true, deleted: true })
      }
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
        txn`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${store}) ON CONFLICT DO NOTHING`,
        txn`
          INSERT INTO analytics_daily_logs (username, store, day, note, tags, follow_up, follow_up_done, updated_by, updated_at)
          VALUES (${username}, ${store}, ${day}, ${note}, ${JSON.stringify(tags)}::jsonb, ${followUp || null}, ${followUpDone}, ${actor}, NOW())
          ON CONFLICT (username, store, day)
          DO UPDATE SET note = EXCLUDED.note, tags = EXCLUDED.tags, follow_up = EXCLUDED.follow_up,
            follow_up_done = EXCLUDED.follow_up_done, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `,
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true, log: { day, note, tags, followUp, followUpDone, updatedBy: actor } })
    }

    if (req.method === 'DELETE' && action === 'delete-day') {
      const store = String(req.query.store || '').trim()
      const day = strictDay(req.query.day)
      if (!store || !day) return res.status(400).json({ error: 'store and day are required' })
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day = ${day}
      `
      const periodRows = await sql`
        SELECT period_start, period_end, file_name, rows FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND period_start <= ${day} AND period_end >= ${day}
      `
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${store} AND day = ${day}`
      await sql`
        DELETE FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND period_start <= ${day} AND period_end >= ${day}
      `
      const snapshotDays = dayRows.map((d) => ({ day: dayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }))
      const snapshotPeriods = periodRows.map((period) => ({
        periodStart: dayString(period.period_start),
        periodEnd: dayString(period.period_end),
        fileName: period.file_name,
        rows: Array.isArray(period.rows) ? period.rows : [],
      }))
      await recordEvent(sql, username, actor, store, 'delete-day', `Deleted ${store} data on ${day}`, {
        store,
        from: day,
        to: day,
        days: snapshotDays.length,
        periods: snapshotPeriods.length,
        rows: [...snapshotDays, ...snapshotPeriods].reduce((total, item) => total + item.rows.length, 0),
      }, {
        type: 'analytics-data-batch', store, targetDays: [], targetPeriods: [],
        previousDays: snapshotDays, previousPeriods: snapshotPeriods,
      })
      return res.json({ ok: true })
    }

    if (req.method === 'DELETE' && action === 'delete-range') {
      const store = String(req.query.store || '').trim()
      const from = strictDay(req.query.from)
      const to = strictDay(req.query.to)
      if (!store || !from || !to || from > to) return res.status(400).json({ error: 'store, from and to are required' })
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `
      const periodRows = await sql`
        SELECT period_start, period_end, file_name, rows FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND period_start <= ${to} AND period_end >= ${from}
        ORDER BY period_start, period_end
      `
      const snapshotDays = dayRows.map((d) => ({ day: dayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }))
      const snapshotPeriods = periodRows.map((period) => ({
        periodStart: dayString(period.period_start),
        periodEnd: dayString(period.period_end),
        fileName: period.file_name,
        rows: Array.isArray(period.rows) ? period.rows : [],
      }))
      await sql`
        DELETE FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
      `
      await sql`
        DELETE FROM analytics_store_periods
        WHERE username = ${username} AND store = ${store}
          AND period_start <= ${to} AND period_end >= ${from}
      `
      const rowCount = [...snapshotDays, ...snapshotPeriods].reduce((total, item) => total + item.rows.length, 0)
      await recordEvent(sql, username, actor, store, 'delete-range', `Deleted ${snapshotDays.length} saved days and ${snapshotPeriods.length} periods from ${store}`, {
        store,
        from,
        to,
        days: snapshotDays.length,
        periods: snapshotPeriods.length,
        rows: rowCount,
      }, {
        type: 'analytics-data-batch', store, targetDays: [], targetPeriods: [],
        previousDays: snapshotDays, previousPeriods: snapshotPeriods,
      })
      return res.json({ ok: true, days: snapshotDays.length, periods: snapshotPeriods.length, rows: rowCount })
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
