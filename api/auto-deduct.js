// api/auto-deduct.js — Vercel serverless function
// Handles template storage and transaction logging for Auto Deduct.
// The actual CSV matching is done client-side (see autoDeductEngine.js).
//
// Endpoints:
//   GET  ?action=config          — check if template exists
//   GET  ?action=template        — return stored template rows
//   GET  ?action=aliases         — return learned unmatched-row aliases
//   POST ?action=upload-template — save template rows (JSON body from client)
//   POST ?action=save-aliases    — save learned unmatched-row aliases
//   POST ?action=apply           — log a deduction/return transaction

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

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null
  try { return jwt.verify(authHeader.slice(7), secret) } catch { return null }
}

async function ensureAppDataTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS app_data (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

async function ensureDeductLogTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS deduct_log (
      id          SERIAL PRIMARY KEY,
      txn_type    TEXT NOT NULL,
      source_name TEXT,
      applied_by  TEXT NOT NULL,
      row_count   INTEGER NOT NULL DEFAULT 0,
      total_qty   INTEGER NOT NULL DEFAULT 0,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql    = getDB()
    const secret = getSecret()
    const payload = verifyToken(req.headers.authorization, secret)
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })

    const isAdmin = payload.role === 'admin'
    const action  = req.query.action

    await ensureAppDataTable(sql)

    // ── GET config ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'config') {
      const rows = await sql`
        SELECT value->>'fileName' AS file_name, updated_at
        FROM app_data WHERE key = 'autodeduct_template'
      `
      return res.json({
        template_exists: rows.length > 0,
        template_name:   rows[0]?.file_name || null,
        updated_at:      rows[0]?.updated_at || null,
      })
    }

    // ── GET template ────────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'template') {
      const rows = await sql`SELECT value FROM app_data WHERE key = 'autodeduct_template'`
      if (!rows[0]) return res.status(404).json({ error: 'No template uploaded yet' })
      return res.json(rows[0].value)
    }

    if (req.method === 'GET' && action === 'aliases') {
      const rows = await sql`SELECT value FROM app_data WHERE key = 'autodeduct_aliases'`
      return res.json({ aliases: rows[0]?.value?.aliases || {} })
    }

    // ── POST upload-template (admin only) ───────────────────────────────────
    if (req.method === 'POST' && action === 'upload-template') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { rows, fileName } = req.body || {}
      if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ error: 'rows array required' })

      const value = JSON.stringify({
        rows,
        fileName:   fileName || 'template.csv',
        uploadedAt: new Date().toISOString(),
        uploadedBy: payload.username,
      })

      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES ('autodeduct_template', ${value}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `
      return res.json({ ok: true, count: rows.length })
    }

    if (req.method === 'POST' && action === 'save-aliases') {
      const { aliases } = req.body || {}
      if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
        return res.status(400).json({ error: 'aliases object required' })
      }
      const value = JSON.stringify({
        aliases,
        updatedAt: new Date().toISOString(),
        updatedBy: payload.username,
      })
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES ('autodeduct_aliases', ${value}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `
      return res.json({ ok: true, count: Object.keys(aliases).length })
    }

    // ── POST apply ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'apply') {
      await ensureDeductLogTable(sql)
      const { filledRows = [], txnType = 'sales', sourceName = '' } = req.body || {}
      const rowCount  = filledRows.length
      const totalQty  = filledRows.reduce((s, r) => s + (parseInt(r.QTY, 10) || 0), 0)

      await sql`
        INSERT INTO deduct_log (txn_type, source_name, applied_by, row_count, total_qty)
        VALUES (${txnType}, ${sourceName}, ${payload.username}, ${rowCount}, ${totalQty})
      `
      return res.json({ ok: true, totalQty, rowCount })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[/api/auto-deduct]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
