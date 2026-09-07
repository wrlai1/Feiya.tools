import { neon } from '@neondatabase/serverless'
import authentication from '../lib/authentication.cjs'
import inventoryEmail from '../lib/inventoryEmail.cjs'

const { authenticateUser } = authentication
const { buildInventoryEmail, localDateParts, normalizeSettings, previousDate } = inventoryEmail

function getDB() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set')
  return neon(process.env.DATABASE_URL)
}

async function ensureSchema(sql) {
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
    if (existing?.status === 'sent' || existing?.status === 'sending') return { skipped: true, reason: `Report already ${existing.status}` }
  }
  if (!force) {
    const claimed = await sql`INSERT INTO inventory_email_runs (report_date, status, recipients, styles)
      VALUES (${reportDate}::date, 'sending', ${JSON.stringify(settings.recipients)}::jsonb, ${JSON.stringify(settings.styles)}::jsonb)
      ON CONFLICT (report_date) DO UPDATE SET status = 'sending', recipients = EXCLUDED.recipients,
        styles = EXCLUDED.styles, provider_id = NULL, error = NULL, created_at = NOW(), sent_at = NULL
      WHERE inventory_email_runs.status = 'failed'
      RETURNING id`
    if (!claimed.length) return { skipped: true, reason: 'Report is already being processed' }
  }

  try {
    const inventory = await sql`SELECT style, color, size, quantity FROM inventory_balance WHERE UPPER(style) = ANY(${settings.styles}::text[]) ORDER BY style, color, size`
    const movementDay = previousDate(reportDate)
    const movements = await sql`SELECT rows.style, rows.color, rows.size,
      COALESCE(SUM(rows.qty) FILTER (WHERE rows.txn_type = 'sales'), 0)::int AS sales,
      COALESCE(SUM(rows.qty) FILTER (WHERE rows.txn_type = 'return'), 0)::int AS returns
      FROM inventory_txn_rows rows
      WHERE UPPER(rows.style) = ANY(${settings.styles}::text[])
        AND COALESCE(rows.business_day, rows.applied_at::date) = ${movementDay}::date
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions transactions WHERE transactions.id = rows.transaction_id AND transactions.rolled_back_at IS NOT NULL)
      GROUP BY rows.style, rows.color, rows.size`
    const report = buildInventoryEmail({ reportDate, inventory, movements })
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.INVENTORY_EMAIL_FROM, to: settings.recipients, subject: report.subject, html: report.html }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.message || `Email provider returned ${response.status}`)
    if (!force) await sql`UPDATE inventory_email_runs SET status = 'sent', provider_id = ${data.id || null}, sent_at = NOW() WHERE report_date = ${reportDate}::date`
    return { sent: true, providerId: data.id, rowCount: report.rows.length }
  } catch (error) {
    if (!force) await sql`UPDATE inventory_email_runs SET status = 'failed', error = ${String(error.message || error).slice(0, 1000)} WHERE report_date = ${reportDate}::date`
    throw error
  }
}

export default async function handler(req, res) {
  try {
    const sql = getDB()
    await ensureSchema(sql)
    const action = String(req.query?.action || '')

    if (action === 'cron') {
      if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
      const settings = await getSettings(sql)
      const local = localDateParts(new Date(), settings.timezone)
      if (!settings.enabled) return res.json({ skipped: true, reason: 'Disabled' })
      if (local.hour !== settings.sendHour) return res.json({ skipped: true, reason: 'Outside configured send hour' })
      return res.json(await sendReport(sql, settings, local.date))
    }

    const user = await authenticateUser(sql, req.headers.authorization, process.env.JWT_SECRET)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })

    if (req.method === 'GET') {
      const settings = await getSettings(sql)
      const styles = await sql`SELECT DISTINCT style FROM inventory_balance WHERE style <> '' ORDER BY style`
      const runs = await sql`SELECT report_date, status, recipients, styles, provider_id, error, created_at, sent_at FROM inventory_email_runs ORDER BY created_at DESC LIMIT 14`
      return res.json({ settings, availableStyles: styles.map((row) => row.style), runs, emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.INVENTORY_EMAIL_FROM), cronConfigured: Boolean(process.env.CRON_SECRET) })
    }

    if (req.method === 'POST') {
      const settings = normalizeSettings(req.body || {})
      if (settings.enabled && (!settings.recipients.length || !settings.styles.length)) return res.status(400).json({ error: 'Recipients and styles are required when daily email is enabled' })
      await sql`INSERT INTO inventory_email_settings (id, enabled, recipients, styles, send_hour, timezone, updated_by, updated_at)
        VALUES (TRUE, ${settings.enabled}, ${JSON.stringify(settings.recipients)}::jsonb, ${JSON.stringify(settings.styles)}::jsonb, ${settings.sendHour}, ${settings.timezone}, ${user.username}, NOW())
        ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, recipients = EXCLUDED.recipients,
          styles = EXCLUDED.styles, send_hour = EXCLUDED.send_hour, timezone = EXCLUDED.timezone,
          updated_by = EXCLUDED.updated_by, updated_at = NOW()`
      if (action === 'send-test') {
        const local = localDateParts()
        return res.json(await sendReport(sql, settings, local.date, true))
      }
      return res.json({ ok: true, settings })
    }
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    console.error('[/api/inventory-email]', error)
    return res.status(500).json({ error: error.message || 'Inventory email request failed' })
  }
}
