import { neon } from '@neondatabase/serverless'
import authentication from '../lib/authentication.cjs'

const { authenticateUser } = authentication

function getDB() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  return neon(url)
}

function getSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not set')
  return secret
}

function dayString(value) {
  if (!value) return ''
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function validDay(value) {
  const day = dayString(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const [year, month, date] = day.split('-').map(Number)
  const checked = new Date(Date.UTC(year, month - 1, date))
  return checked.getUTCFullYear() === year
    && checked.getUTCMonth() === month - 1
    && checked.getUTCDate() === date
    ? day
    : ''
}

async function ensureTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS new_product_trackers (
      id           BIGSERIAL PRIMARY KEY,
      username     TEXT NOT NULL,
      store        TEXT NOT NULL,
      spu          TEXT NOT NULL,
      product_name TEXT,
      launch_date  DATE NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS new_product_roas_events (
      id             BIGSERIAL PRIMARY KEY,
      tracker_id     BIGINT NOT NULL REFERENCES new_product_trackers(id) ON DELETE CASCADE,
      username       TEXT NOT NULL,
      effective_date DATE NOT NULL,
      roas           NUMERIC NOT NULL,
      note           TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tracker_id, effective_date)
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS new_product_trackers_user_idx
    ON new_product_trackers (username, created_at DESC)
  `
}

function trackerJson(row, events = []) {
  return {
    id: String(row.id),
    store: row.store,
    spu: row.spu,
    productName: row.product_name || '',
    launchDate: dayString(row.launch_date),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roasEvents: events.map((event) => ({
      id: String(event.id),
      effectiveDate: dayString(event.effective_date),
      roas: Number(event.roas),
      note: event.note || '',
      createdAt: event.created_at,
    })),
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql = getDB()
    const payload = await authenticateUser(sql, req.headers.authorization, getSecret())
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    const username = payload.role === 'admin' ? 'admin' : payload.username
    const action = String(req.query.action || '')
    await ensureTables(sql)

    if (req.method === 'GET' && action === 'list') {
      const trackers = await sql`
        SELECT id, store, spu, product_name, launch_date, created_at, updated_at
        FROM new_product_trackers
        WHERE username = ${username}
        ORDER BY launch_date DESC, created_at DESC
      `
      const events = await sql`
        SELECT e.id, e.tracker_id, e.effective_date, e.roas, e.note, e.created_at
        FROM new_product_roas_events e
        JOIN new_product_trackers t ON t.id = e.tracker_id
        WHERE t.username = ${username}
        ORDER BY e.effective_date, e.created_at
      `
      const byTracker = new Map()
      for (const event of events) {
        const key = String(event.tracker_id)
        if (!byTracker.has(key)) byTracker.set(key, [])
        byTracker.get(key).push(event)
      }
      return res.json({
        trackers: trackers.map((row) => trackerJson(row, byTracker.get(String(row.id)) || [])),
      })
    }

    if (req.method === 'POST' && action === 'create') {
      const store = String(req.body?.store || '').trim()
      const spu = String(req.body?.spu || '').trim()
      const productName = String(req.body?.productName || '').trim()
      const launchDate = validDay(req.body?.launchDate)
      const initialRoas = Number(req.body?.initialRoas)
      if (!store || !spu || !launchDate) {
        return res.status(400).json({ error: '店铺、SPU 和上架日期为必填项' })
      }
      if (!Number.isFinite(initialRoas) || initialRoas <= 0) {
        return res.status(400).json({ error: '请填写大于 0 的目标 ROAS' })
      }
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('new-product-tracker-write'))`,
        txn`
          WITH inserted_tracker AS (
            INSERT INTO new_product_trackers (
              username, store, spu, product_name, launch_date
            )
            SELECT ${username}, ${store}, ${spu}, ${productName || null}, ${launchDate}
            WHERE NOT EXISTS (
              SELECT 1
              FROM new_product_trackers
              WHERE username = ${username}
                AND LOWER(store) = LOWER(${store})
                AND LOWER(spu) = LOWER(${spu})
            )
            RETURNING id, store, spu, product_name, launch_date, created_at, updated_at
          ),
          inserted_event AS (
            INSERT INTO new_product_roas_events (
              tracker_id, username, effective_date, roas, note
            )
            SELECT id, ${username}, ${launchDate}, ${initialRoas}, ${'初始目标'}
            FROM inserted_tracker
            RETURNING id, tracker_id, effective_date, roas, note, created_at
          )
          SELECT
            tracker.*,
            event.id AS event_id,
            event.effective_date AS event_effective_date,
            event.roas AS event_roas,
            event.note AS event_note,
            event.created_at AS event_created_at
          FROM inserted_tracker tracker
          JOIN inserted_event event ON event.tracker_id = tracker.id
        `,
      ])
      const tracker = results[1][0]
      if (!tracker) {
        return res.status(409).json({ error: '这个店铺的 SPU 已在追踪中；如需重新上架，请先删除旧追踪' })
      }
      return res.status(201).json({
        tracker: trackerJson(tracker, [{
          id: tracker.event_id,
          effective_date: tracker.event_effective_date,
          roas: tracker.event_roas,
          note: tracker.event_note,
          created_at: tracker.event_created_at,
        }]),
      })
    }

    if (req.method === 'POST' && action === 'save-roas') {
      const trackerId = Number(req.body?.trackerId)
      const effectiveDate = validDay(req.body?.effectiveDate)
      const roas = Number(req.body?.roas)
      const note = String(req.body?.note || '').trim()
      if (!Number.isSafeInteger(trackerId) || trackerId <= 0
        || !effectiveDate || !Number.isFinite(roas) || roas <= 0) {
        return res.status(400).json({ error: '追踪款、修改日期和目标 ROAS 均为必填项' })
      }
      const owned = await sql`
        SELECT id, launch_date FROM new_product_trackers
        WHERE id = ${trackerId} AND username = ${username}
        LIMIT 1
      `
      if (!owned.length) return res.status(404).json({ error: '未找到这个新品追踪' })
      if (effectiveDate < dayString(owned[0].launch_date)) {
        return res.status(400).json({ error: 'ROAS 修改日期不能早于新品上架日期' })
      }
      const events = await sql`
        INSERT INTO new_product_roas_events (tracker_id, username, effective_date, roas, note)
        VALUES (${trackerId}, ${username}, ${effectiveDate}, ${roas}, ${note || null})
        ON CONFLICT (tracker_id, effective_date)
        DO UPDATE SET roas = EXCLUDED.roas, note = EXCLUDED.note
        RETURNING id, tracker_id, effective_date, roas, note, created_at
      `
      await sql`UPDATE new_product_trackers SET updated_at = NOW() WHERE id = ${trackerId}`
      return res.json({
        event: {
          id: String(events[0].id),
          effectiveDate: dayString(events[0].effective_date),
          roas: Number(events[0].roas),
          note: events[0].note || '',
          createdAt: events[0].created_at,
        },
      })
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query.id)
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'id is required' })
      const rows = await sql`
        DELETE FROM new_product_trackers
        WHERE id = ${id} AND username = ${username}
        RETURNING id
      `
      if (!rows.length) return res.status(404).json({ error: '未找到这个新品追踪' })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
