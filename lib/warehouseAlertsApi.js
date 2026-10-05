import { neon } from '@neondatabase/serverless'
import authentication from './authentication.cjs'
import { businessDay, calculateWarehouseAlerts, DEFAULT_SETTINGS, normalizeOrders, normalizeSales, normalizeSettings, validateOverride, skuKey, orderKey } from '../src/utils/warehouseAlerts.js'

export async function loadWarehouseSources(sql, now = new Date()) {
  const today = businessDay(now)
  const [inventory, sales] = await Promise.all([
    sql`SELECT style, color, size, quantity FROM inventory_balance`,
    sql`SELECT r.style, r.color, r.size, COALESCE(r.business_day, (r.applied_at AT TIME ZONE 'America/New_York')::date)::text AS date, r.qty AS sold_qty
      FROM inventory_txn_rows r
      WHERE r.txn_type = 'sales' AND COALESCE(r.business_day, (r.applied_at AT TIME ZONE 'America/New_York')::date) BETWEEN ${today}::date - 7 AND ${today}::date
      AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.rolled_back_at IS NOT NULL
        AND (t.id = r.transaction_id OR (r.transaction_id IS NULL AND t.transaction_type = r.txn_type
          AND t.source_file IS NOT DISTINCT FROM r.source_file AND t.applied_by IS NOT DISTINCT FROM r.applied_by
          AND ABS(EXTRACT(EPOCH FROM (t.applied_at - r.applied_at))) <= 30)))`,
  ])
  return { inventory, sales }
}
export function applyWarehouseChange(state, body, user, now = new Date()) {
  const next = { ...state }, action = body.action
  let old_value, new_value, target = ''
  if (action === 'orders' || action === 'sales') {
    next[action] = action === 'orders' ? normalizeOrders(body.rows) : normalizeSales(body.rows)
    old_value = { count: state[action]?.length || 0, imported_at: state[`${action}_updated_at`] || null }
    next[`${action}_updated_at`] = now.toISOString()
    new_value = { count: next[action].length, imported_at: next[`${action}_updated_at`] }
  } else if (action === 'sales_reset') {
    old_value = { source: state.sales === null ? 'ERP' : 'import', count: state.sales?.length || 0 }
    next.sales = null; next.sales_updated_at = now.toISOString(); new_value = { source: 'ERP' }
  } else if (action === 'settings') {
    old_value = state.settings; next.settings = normalizeSettings(body.settings); new_value = next.settings
  } else if (action === 'override') {
    target = String(body.target || '')
    if (!target.startsWith('sku:') && !target.startsWith('order:')) throw new Error('Invalid override target')
    const allowed = target.startsWith('order:') ? ['priority', 'carrier_urgency'] : ['ready_qty', 'forecast_qty', 'prep_target', 'warehouse_location']
    if (!allowed.includes(body.field)) throw new Error('Invalid field for this target')
    new_value = validateOverride(body.field, body.value)
    old_value = state.overrides?.[target]?.[body.field] ?? null
    next.overrides = { ...state.overrides, [target]: { ...state.overrides?.[target], [body.field]: new_value } }
  } else throw new Error('Unsupported action')
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw new Error('A reason is required (max 500 characters)')
  const entry = { action, target, field: body.field || null, changed_by: user.username, changed_at: now.toISOString(), old_value, new_value, reason: body.reason.trim() }
  next.audit = [...(state.audit || []), entry]
  return next
}
export async function saveWarehouseState(sql, next, revision) {
  return sql`UPDATE warehouse_alert_data SET value = ${JSON.stringify(next)}::jsonb, revision = revision + 1, updated_at = NOW() WHERE key = 'state' AND revision = ${revision} RETURNING revision`
}
export async function saveWarehouseSnapshots(sql, report, now = new Date()) {
  await sql`INSERT INTO warehouse_alert_data (key, value) VALUES ('latest', ${JSON.stringify(report)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now))
  if (hour >= 18) {
    const day = businessDay(now), weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now)
    const keys = [`daily:${day}`, ...(weekday === 'Fri' ? [`weekly:${day}`] : [])]
    for (const key of keys) await sql`INSERT INTO warehouse_alert_data (key, value) VALUES (${key}, ${JSON.stringify(report)}::jsonb) ON CONFLICT DO NOTHING`
  }
}
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured')
    const sql = neon(process.env.DATABASE_URL), cron = req.query.action === 'cron'
    let user
    if (cron) {
      if (req.method !== 'GET' || !process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Not authenticated' })
    } else {
      user = await authentication.authenticateUser(sql, req.headers.authorization, process.env.JWT_SECRET)
      if (!user) return res.status(401).json({ error: 'Not authenticated' })
      if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    }
    await sql`CREATE TABLE IF NOT EXISTS warehouse_alert_data (key TEXT PRIMARY KEY, value JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    const initial = JSON.stringify({ orders: [], sales: null, settings: DEFAULT_SETTINGS, overrides: {}, audit: [] })
    await sql`INSERT INTO warehouse_alert_data (key, value) VALUES ('state', ${initial}::jsonb) ON CONFLICT DO NOTHING`
    const [stored] = await sql`SELECT value, revision FROM warehouse_alert_data WHERE key = 'state'`
    if (req.method === 'GET' && req.query.snapshot) {
      const key = String(req.query.snapshot)
      if (!/^(daily|weekly):\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: 'Invalid snapshot key' })
      const [snapshot] = await sql`SELECT value FROM warehouse_alert_data WHERE key = ${key}`
      if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' })
      return res.json(snapshot.value)
    }
    let state = stored.value, revision = stored.revision
    const now = new Date()
    const sources = await loadWarehouseSources(sql, now)
    if (req.method === 'POST') {
      if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision !== revision) return res.status(409).json({ error: 'Data changed. Refresh before saving.' })
      let next
      try {
        next = applyWarehouseChange(state, req.body, user)
        if (req.body.action === 'override') {
          const target = req.body.target
          const valid = target.startsWith('sku:')
            ? [...sources.inventory, ...state.orders, ...(state.sales || sources.sales)].some(row => `sku:${skuKey(row)}` === target)
            : state.orders.some(row => `order:${orderKey(row)}` === target)
          if (!valid) throw new Error('Override target no longer exists')
          if (req.body.field === 'ready_qty') {
            const physical = sources.inventory.filter(row => `sku:${skuKey(row)}` === target).reduce((sum, row) => sum + row.quantity, 0)
            if (req.body.value > Math.max(0, physical)) throw new Error('Ready Qty cannot exceed physical inventory')
          }
        }
      } catch (error) { return res.status(400).json({ error: error.message }) }
      const saved = await saveWarehouseState(sql, next, revision)
      if (!saved.length) return res.status(409).json({ error: 'Data changed. Refresh before saving.' })
      state = next; revision = saved[0].revision
    }
    const report = calculateWarehouseAlerts({ ...sources, ...state, sales: state.sales ?? sources.sales, now })
    if (cron) {
      await saveWarehouseSnapshots(sql, report, now)
      return res.json({ ok: true, generated_at: report.generated_at })
    }
    const snapshots = await sql`SELECT key, updated_at FROM warehouse_alert_data WHERE key LIKE 'daily:%' OR key LIKE 'weekly:%' ORDER BY updated_at DESC LIMIT 10`
    return res.json({ state, revision, report, snapshots, sales_source: state.sales === null ? 'ERP sales transactions' : 'Imported sales snapshot' })
  } catch (error) { return res.status(500).json({ error: error.message }) }
}
