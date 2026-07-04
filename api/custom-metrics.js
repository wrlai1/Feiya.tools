// api/custom-metrics.js
// Per-account storage for user-defined ratio metrics (Analytics page).
//
// Endpoints (all require a valid token; metrics are scoped to the caller):
//   GET    ?              — list this user's custom metrics
//   POST   ?              — upsert one metric { id, label, numerator, denominator, type }
//   DELETE ?id=<id>       — delete one of this user's metrics by id

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

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS custom_metrics (
      id          TEXT NOT NULL,
      username    TEXT NOT NULL,
      label       TEXT NOT NULL,
      numerator   TEXT NOT NULL,
      denominator TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'number',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, id)
    )
  `
}

const VALID_TYPES = ['percent', 'number', 'ratio', 'currency']

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql     = getDB()
    const secret  = getSecret()
    const payload = verifyToken(req.headers.authorization, secret)
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    const username = payload.username

    await ensureTable(sql)

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, label, numerator, denominator, type
        FROM custom_metrics WHERE username = ${username}
        ORDER BY created_at
      `
      return res.json({ metrics: rows })
    }

    if (req.method === 'POST') {
      const { id, label, numerator, denominator, type } = req.body || {}
      if (!id || !label || !numerator || !denominator) {
        return res.status(400).json({ error: 'id, label, numerator and denominator are required' })
      }
      const safeType = VALID_TYPES.includes(type) ? type : 'number'
      await sql`
        INSERT INTO custom_metrics (id, username, label, numerator, denominator, type)
        VALUES (${id}, ${username}, ${label}, ${numerator}, ${denominator}, ${safeType})
        ON CONFLICT (username, id) DO UPDATE SET
          label = EXCLUDED.label, numerator = EXCLUDED.numerator,
          denominator = EXCLUDED.denominator, type = EXCLUDED.type
      `
      return res.json({ ok: true, metric: { id, label, numerator, denominator, type: safeType } })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id is required' })
      await sql`DELETE FROM custom_metrics WHERE username = ${username} AND id = ${id}`
      return res.json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
