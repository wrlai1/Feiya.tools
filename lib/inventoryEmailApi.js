import { neon } from '@neondatabase/serverless'
import authentication from './authentication.cjs'
import inventoryEmail from './inventoryEmail.cjs'
import dailyPerformance from './dailyPerformance.cjs'
import inventoryLedger from './inventoryLedger.cjs'

const { buildLedger, normalizeMinimumRows, skuKey } = inventoryLedger

const { loadDailyPerformance } = dailyPerformance

const { authenticateUser } = authentication
const { ATTACHMENT_ONLY_HTML, buildInventoryEmail, buildInventoryWorkbook, localDateParts, normalizeSettings, shouldSendDailyReport } = inventoryEmail

function getDB() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set')
  return neon(process.env.DATABASE_URL)
}

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS inventory_email_minimum (
    sku_key TEXT PRIMARY KEY, style TEXT NOT NULL, color TEXT NOT NULL, size TEXT NOT NULL,
    minimum INTEGER NOT NULL CHECK (minimum >= 0), updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  await sql`CREATE TABLE IF NOT EXISTS inventory_email_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), enabled BOOLEAN NOT NULL DEFAULT FALSE,
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb, styles JSONB NOT NULL DEFAULT '[]'::jsonb,
    send_hour SMALLINT NOT NULL DEFAULT 9 CHECK (send_hour BETWEEN 0 AND 23),
    timezone TEXT NOT NULL DEFAULT 'America/New_York', updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  await sql`CREATE TABLE IF NOT EXISTS inventory_email_runs (
    id BIGSERIAL PRIMARY KEY, report_date DATE NOT NULL, status TEXT NOT NULL,
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb, styles JSONB NOT NULL DEFAULT '[]'::jsonb,
    provider_id TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ,
    UNIQUE (report_date)
  )`
  await sql`ALTER TABLE inventory_email_runs ADD COLUMN IF NOT EXISTS payload TEXT`
}

async function getSettings(sql) {
  const [row] = await sql`SELECT enabled, recipients, styles, send_hour, timezone, updated_by, updated_at FROM inventory_email_settings WHERE id = TRUE`
  return normalizeSettings(row || {})
}

async function sendReport(sql, settings, reportDate, force = false) {
  if (!settings.recipients.length) throw new Error('Add at least one recipient')
  if (!settings.styles.length) throw new Error('Select at least one style')
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured')
  if (!process.env.INVENTORY_EMAIL_FROM) throw new Error('INVENTORY_EMAIL_FROM is not configured')

  if (!force) {
    const [existing] = await sql`SELECT status FROM inventory_email_runs WHERE report_date = ${reportDate}::date`
    if (existing?.status === 'sent') return { skipped: true, reason: 'Report already sent' }
  }
  if (!force) {
    const claimed = await sql`INSERT INTO inventory_email_runs (report_date, status, recipients, styles)
      VALUES (${reportDate}::date, 'sending', ${JSON.stringify(settings.recipients)}::jsonb, ${JSON.stringify(settings.styles)}::jsonb)
      ON CONFLICT (report_date) DO UPDATE SET status = 'sending', recipients = EXCLUDED.recipients,
        styles = EXCLUDED.styles, provider_id = NULL, error = NULL, created_at = NOW(), sent_at = NULL
      WHERE inventory_email_runs.status = 'failed'
        OR (inventory_email_runs.status = 'sending' AND inventory_email_runs.created_at < NOW() - INTERVAL '10 minutes')
      RETURNING id`
    if (!claimed.length) return { skipped: true, reason: 'Report is already being processed' }
  }

  try {
    const [savedRun] = force ? [] : await sql`SELECT payload FROM inventory_email_runs WHERE report_date = ${reportDate}::date`
    let emailPayload = savedRun?.payload
    let rowCount = 0
    if (!emailPayload) {
    const [inventory, history, overrides] = await sql.transaction([
    sql`SELECT style, color, size, GREATEST(quantity, 0)::int AS quantity FROM inventory_balance WHERE UPPER(style) = ANY(${settings.styles}::text[]) ORDER BY style, color, size`,
    sql`SELECT rows.style, rows.color, rows.size, rows.txn_type, rows.qty,
      COALESCE(rows.business_day, (rows.applied_at AT TIME ZONE 'America/New_York')::date)::text AS day,
      (rows.applied_at AT TIME ZONE 'America/New_York')::date::text AS applied_day
      FROM inventory_txn_rows rows
      WHERE UPPER(rows.style) = ANY(${settings.styles}::text[])
        AND COALESCE(rows.business_day, (rows.applied_at AT TIME ZONE 'America/New_York')::date) <= ${reportDate}::date
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions transactions
          WHERE transactions.rolled_back_at IS NOT NULL AND (transactions.id = rows.transaction_id
            OR (rows.transaction_id IS NULL AND rows.source_file IS NOT NULL
              AND transactions.transaction_type = rows.txn_type
              AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
              AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
              AND ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))) <= 30)))
      ORDER BY rows.applied_at, rows.id`,
    sql`SELECT sku_key, minimum FROM inventory_email_minimum`,
    ], { isolationLevel: 'RepeatableRead', readOnly: true })
    const ledger = buildLedger({ reportDate, inventory, history, overrides, styles: settings.styles })
    const sumPeriod = (values, days, end) => {
      const start = new Date(Date.parse(`${end}T12:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10)
      return Object.entries(values).reduce((sum, [date, qty]) => sum + (date >= start && date <= end ? Number(qty) : 0), 0)
    }
    const ledgerMovements = ledger.rows.map((row) => ({
      style: row.style, color: row.color, size: row.size,
      sales: row.out[ledger.salesDay] || 0, returns: row.returns[ledger.returnDay] || 0,
      sales7: sumPeriod(row.out, 7, ledger.calculationDay), sales14: sumPeriod(row.out, 14, ledger.calculationDay),
      sales30: sumPeriod(row.out, 30, ledger.calculationDay), returns30: sumPeriod(row.returns, 30, reportDate),
    }))
    const report = buildInventoryEmail({ reportDate, movementDay: ledger.salesDay, inventory: ledger.rows, movements: ledgerMovements, ledger })
    report.ledger = ledger
    const performance = await loadDailyPerformance(sql, settings.styles)
    const workbook = await buildInventoryWorkbook({ ...report, reportDate, movementDay: ledger.salesDay, returnDay: ledger.returnDay, performance })
    emailPayload = JSON.stringify({
        from: process.env.INVENTORY_EMAIL_FROM,
        to: settings.recipients,
        subject: report.subject,
        html: ATTACHMENT_ONLY_HTML,
        attachments: [{
          filename: `daily_inventory_performance_${reportDate}.xlsx`,
          content: Buffer.from(workbook).toString('base64'),
        }],
    })
    rowCount = report.rows.length
    if (!force) await sql`UPDATE inventory_email_runs SET payload = ${emailPayload} WHERE report_date = ${reportDate}::date`
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        ...(!force ? { 'Idempotency-Key': `feiya-daily-inventory-v2/${reportDate}` } : {}),
      },
      body: emailPayload,
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.message || `Email provider returned ${response.status}`)
    if (!data.id) throw new Error('Email provider did not confirm a message ID')
    if (!force) await sql`UPDATE inventory_email_runs SET status = 'sent', provider_id = ${data.id}, sent_at = NOW(), payload = NULL WHERE report_date = ${reportDate}::date`
    return { sent: true, providerId: data.id, rowCount }
  } catch (error) {
    if (!force) await sql`UPDATE inventory_email_runs SET status = 'failed', error = ${String(error.message || error).slice(0, 1000)} WHERE report_date = ${reportDate}::date`
    throw error
  }
}

export default async function handler(req, res) {
  try {
    const sql = getDB()
    const action = String(req.query?.action || '')

    if (action === 'email-cron') {
      if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
      await ensureSchema(sql)
      const settings = await getSettings(sql)
      const local = localDateParts(new Date(), settings.timezone)
      if (!settings.enabled) return res.json({ skipped: true, reason: 'Disabled' })
      if (!shouldSendDailyReport(local.hour, settings.sendHour)) return res.json({ skipped: true, reason: 'Before configured send hour' })
      return res.json(await sendReport(sql, settings, local.date))
    }

    const user = await authenticateUser(sql, req.headers.authorization, process.env.JWT_SECRET)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    if (!['email-settings', 'email-send-test', 'email-minimum-upload', 'email-minimum-reset'].includes(action)) return res.status(400).json({ error: 'Unknown email action' })
    await ensureSchema(sql)

    if (req.method === 'POST' && ['email-minimum-upload', 'email-minimum-reset'].includes(action)) {
      let rows
      try { rows = normalizeMinimumRows(req.body?.rows) } catch (error) { return res.status(400).json({ error: error.message }) }
      const inventory = await sql`SELECT style, color, size FROM inventory_balance`
      const known = new Set(inventory.map(skuKey))
      const missing = rows.find((row) => !known.has(row.key))
      if (missing) return res.status(400).json({ error: `SKU not found: ${missing.style} / ${missing.color} / ${missing.size}. No Minimum values were changed.` })
      if (action === 'email-minimum-reset') {
        await sql`DELETE FROM inventory_email_minimum WHERE sku_key = ANY(${rows.map((row) => row.key)}::text[])`
      } else {
        await sql`INSERT INTO inventory_email_minimum (sku_key, style, color, size, minimum, updated_by)
          SELECT item->>'key', item->>'style', item->>'color', item->>'size', (item->>'minimum')::int, ${user.username}
          FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
          ON CONFLICT (sku_key) DO UPDATE SET minimum = EXCLUDED.minimum, updated_by = EXCLUDED.updated_by, updated_at = NOW()`
      }
      return res.json({ ok: true, updated: rows.length })
    }

    if (req.method === 'GET') {
      const settings = await getSettings(sql)
      const styles = await sql`SELECT DISTINCT style FROM inventory_balance WHERE style <> '' ORDER BY style`
      const runs = await sql`SELECT report_date, status, recipients, styles, provider_id, error, created_at, sent_at FROM inventory_email_runs ORDER BY created_at DESC LIMIT 14`
      const minimumOverrides = await sql`SELECT style, color, size, minimum FROM inventory_email_minimum ORDER BY style, color, size`
      return res.json({ settings, minimumOverrides, availableStyles: styles.map((row) => row.style), runs, emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.INVENTORY_EMAIL_FROM), cronConfigured: Boolean(process.env.CRON_SECRET) })
    }

    if (req.method === 'POST') {
      const settings = normalizeSettings(req.body || {})
      if (settings.enabled && (!settings.recipients.length || !settings.styles.length)) return res.status(400).json({ error: 'Recipients and styles are required when daily email is enabled' })
      await sql`INSERT INTO inventory_email_settings (id, enabled, recipients, styles, send_hour, timezone, updated_by, updated_at)
        VALUES (TRUE, ${settings.enabled}, ${JSON.stringify(settings.recipients)}::jsonb, ${JSON.stringify(settings.styles)}::jsonb, ${settings.sendHour}, ${settings.timezone}, ${user.username}, NOW())
        ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, recipients = EXCLUDED.recipients,
          styles = EXCLUDED.styles, send_hour = EXCLUDED.send_hour, timezone = EXCLUDED.timezone,
          updated_by = EXCLUDED.updated_by, updated_at = NOW()`
      if (action === 'email-send-test') {
        const local = localDateParts()
        return res.json(await sendReport(sql, settings, local.date, true))
      }
      return res.json({ ok: true, settings })
    }
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    console.error('[/api/inventory-balance?email]', error)
    return res.status(500).json({ error: error.message || 'Inventory email request failed' })
  }
}
