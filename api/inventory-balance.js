// api/inventory-balance.js
// Single source of truth for inventory stock levels.
// Used by both Stock Management (view/edit) and Auto Deduct (fill template + apply).
//
// Tables: inventory_balance, inventory_transactions, inventory_snapshots
//
// Endpoints:
//   GET  ?action=list          — all rows + stats
//   POST ?action=init          — replace all rows (admin)
//   PATCH ?action=edit&id=N    — update one row's quantity (admin)
//   POST ?action=add-rows      — append new rows, skip existing (admin)
//   DELETE ?action=remove-rows — delete rows by id (admin)
//   POST ?action=reset         — set all quantities to 0 (admin)
//   POST ?action=apply         — deduct (sales) or add (return) quantities (admin)
//   GET  ?action=transactions  — transaction history
//   GET  ?action=history       — snapshot history (restorable)
//   POST ?action=restore&id=N  — restore a snapshot (admin)

import { neon } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'

const MAX_SNAPSHOTS = 5

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
    CREATE TABLE IF NOT EXISTS inventory_balance (
      id         SERIAL PRIMARY KEY,
      style      TEXT NOT NULL,
      color      TEXT NOT NULL,
      size       TEXT NOT NULL,
      quantity   INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(style, color, size)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id               SERIAL PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      source_file      TEXT,
      applied_units    INTEGER DEFAULT 0,
      applied_by       TEXT,
      applied_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `
  // Per-SKU movement log — one row per (style,color,size) per apply. This is the
  // source for sales-velocity / return-rate / days-of-stock analytics ("动销").
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_txn_rows (
      id          BIGSERIAL PRIMARY KEY,
      txn_type    TEXT NOT NULL,
      style       TEXT NOT NULL,
      color       TEXT NOT NULL,
      size        TEXT NOT NULL,
      qty         INTEGER NOT NULL,
      source_file TEXT,
      applied_by  TEXT,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `
  // Migrations: drop stale columns and add ones introduced after initial creation.
  await sql`ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS ts`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_by TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_file TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_units INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ DEFAULT NOW()`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS row_count INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_hash TEXT`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_source_hash_uq ON inventory_transactions (transaction_type, source_hash) WHERE source_hash IS NOT NULL AND source_hash <> ''`
  // sort_order preserves the original SalesTEMPLATE.csv row sequence so the
  // filled-template Excel download comes out in the same order as the template.
  await sql`ALTER TABLE inventory_balance ADD COLUMN IF NOT EXISTS sort_order INTEGER`
  // Seed sort_order from id for any rows that are still NULL (e.g. imported
  // before this column existed). Gives a stable insertion-order fallback until
  // the user re-uploads the SalesTEMPLATE.csv to get the exact template order.
  await sql`UPDATE inventory_balance SET sort_order = id WHERE sort_order IS NULL`
  // For inventory_snapshots we check whether the live table matches our expected
  // schema.  If stale NOT-NULL columns exist (snap_id, ts, …) from an older
  // version, drop and recreate the whole table — snapshots are ephemeral rollback
  // points (max 5 kept), so losing them during a schema migration is acceptable.
  const staleCheck = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'inventory_snapshots'
      AND column_name IN ('snap_id', 'ts')
  `
  if (staleCheck.length > 0) {
    await sql`DROP TABLE IF EXISTS inventory_snapshots`
  }
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id          SERIAL PRIMARY KEY,
      label       TEXT,
      source_name TEXT,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_rows  INTEGER DEFAULT 0,
      total_units INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

async function saveSnapshot(sql, label, sourceName = '') {
  const rows = await sql`SELECT style, color, size, quantity FROM inventory_balance ORDER BY style, color, size`
  const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0)
  await sql`
    INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
    VALUES (${label}, ${sourceName}, ${JSON.stringify(rows)}::jsonb, ${rows.length}, ${totalUnits})
  `
  // Keep only the most recent MAX_SNAPSHOTS
  await sql`
    DELETE FROM inventory_snapshots
    WHERE id NOT IN (
      SELECT id FROM inventory_snapshots ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOTS}
    )
  `
}

function formatRows(rows) {
  return rows.map(r => ({
    id:       r.id,
    Style:    r.style,
    Color:    r.color,
    Size:     r.size,
    Quantity: r.quantity,
    style_n:  r.style,
    color_n:  r.color,
    size_n:   r.size,
  }))
}

function calcStats(rows) {
  const totalUnits  = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0)
  const skusInStock = rows.filter(r => r.quantity > 0).length
  const skusZero    = rows.filter(r => r.quantity <= 0).length
  return { total_units: totalUnits, skus_in_stock: skusInStock, skus_zero: skusZero }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const sql     = getDB()
    const secret  = getSecret()
    const payload = verifyToken(req.headers.authorization, secret)
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })

    const isAdmin = payload.role === 'admin'
    const action  = req.query.action

    await ensureTables(sql)

    // ── GET list ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'list') {
      const rows = await sql`SELECT id, style, color, size, quantity FROM inventory_balance ORDER BY sort_order NULLS LAST, id`
      return res.json({
        initialized: rows.length > 0,
        rows: formatRows(rows),
        ...calcStats(rows),
      })
    }

    // ── POST init — replace entire balance ────────────────────────────────────
    if (req.method === 'POST' && action === 'init') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { rows, sourceName = '' } = req.body || {}
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' })

      await saveSnapshot(sql, 'pre_init', sourceName)
      await sql`DELETE FROM inventory_balance`

      for (const [i, r] of rows.entries()) {
        const style      = String(r.Style || r.style || '').trim()
        const color      = String(r.Color || r.color || '').trim()
        const size       = String(r.Size  || r.size  || '').trim()
        const qty        = parseInt(r.Quantity || r.quantity || 0, 10) || 0
        const sort_order = r.SortOrder !== undefined ? parseInt(r.SortOrder, 10) : i
        if (!style || !color || !size) continue
        await sql`
          INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
          VALUES (${style}, ${color}, ${size}, ${qty}, ${sort_order})
          ON CONFLICT (style, color, size)
          DO UPDATE SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `
      }

      const [stat] = await sql`SELECT COUNT(*)::int AS c, COALESCE(SUM(quantity),0)::int AS u FROM inventory_balance`
      return res.json({ ok: true, total_rows: stat.c, total_units: stat.u })
    }

    // ── PATCH edit — update one row's quantity ────────────────────────────────
    if (req.method === 'PATCH' && action === 'edit') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const id  = parseInt(req.query.id, 10)
      if (!id) return res.status(400).json({ error: 'id required' })
      const { quantity } = req.body || {}
      if (quantity === undefined || quantity === null) return res.status(400).json({ error: 'quantity required' })

      const [old] = await sql`SELECT quantity FROM inventory_balance WHERE id = ${id}`
      if (!old) return res.status(404).json({ error: 'Row not found' })

      await sql`UPDATE inventory_balance SET quantity = ${quantity}, updated_at = NOW() WHERE id = ${id}`
      return res.json({ ok: true, old_quantity: old.quantity, new_quantity: quantity })
    }

    // ── POST add-rows — append new rows, skip existing ────────────────────────
    if (req.method === 'POST' && action === 'add-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { rows } = req.body || {}
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' })

      let added = 0
      for (const r of rows) {
        const style      = String(r.Style || r.style || '').trim()
        const color      = String(r.Color || r.color || '').trim()
        const size       = String(r.Size  || r.size  || '').trim()
        const qty        = parseInt(r.Quantity || r.quantity || 0, 10) || 0
        const sort_order = r.SortOrder !== undefined ? parseInt(r.SortOrder, 10) : null
        if (!style || !color || !size) continue
        const result = await sql`
          INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
          VALUES (${style}, ${color}, ${size}, ${qty}, ${sort_order})
          ON CONFLICT (style, color, size)
          DO UPDATE SET sort_order = COALESCE(EXCLUDED.sort_order, inventory_balance.sort_order)
          RETURNING id
        `
        if (result.length) added++
      }
      return res.json({ ok: true, added })
    }

    // ── DELETE remove-rows — delete by ids ────────────────────────────────────
    if (req.method === 'DELETE' && action === 'remove-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { ids } = req.body || {}
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' })

      await saveSnapshot(sql, 'pre_remove')
      await sql`DELETE FROM inventory_balance WHERE id = ANY(${ids}::int[])`
      return res.json({ ok: true, removed: ids.length })
    }

    // ── POST reset — zero out all quantities ──────────────────────────────────
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      await saveSnapshot(sql, 'pre_reset')
      await sql`UPDATE inventory_balance SET quantity = 0, updated_at = NOW()`
      return res.json({ ok: true })
    }

    // ── POST apply — deduct (sales) or add (return) quantities ────────────────
    if (req.method === 'POST' && action === 'apply') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { filledRows = [], txnType = 'sales', sourceName = '', sourceHash = '' } = req.body || {}

      if (sourceHash) {
        const duplicate = await sql`SELECT id FROM inventory_transactions WHERE transaction_type = ${txnType} AND source_hash = ${sourceHash} LIMIT 1`
        if (duplicate.length) return res.status(409).json({ error: 'This exact file has already been applied. Inventory was not changed.' })
      }

      await saveSnapshot(sql, txnType, sourceName)

      let appliedUnits = 0
      let appliedRows = 0
      for (const r of filledRows) {
        const qty = parseInt(r.QTY, 10) || 0
        if (!qty) continue

        const delta = txnType === 'sales' ? -qty : qty
        await sql`
          INSERT INTO inventory_balance (style, color, size, quantity)
          VALUES (${String(r.STYLE)}, ${String(r.COLOR)}, ${String(r.SIZE)}, ${delta})
          ON CONFLICT (style, color, size)
          DO UPDATE SET quantity = inventory_balance.quantity + ${delta}, updated_at = NOW()
        `
        appliedUnits += qty
        appliedRows += 1

        // 动销流水：每个 SKU 一行，apply 时间戳即记账日期
        await sql`
          INSERT INTO inventory_txn_rows (txn_type, style, color, size, qty, source_file, applied_by)
          VALUES (${txnType}, ${String(r.STYLE)}, ${String(r.COLOR)}, ${String(r.SIZE)}, ${qty}, ${sourceName}, ${payload.username})
        `
      }

      await sql`
        INSERT INTO inventory_transactions (transaction_type, source_file, source_hash, applied_units, row_count, applied_by)
        VALUES (${txnType}, ${sourceName}, ${sourceHash}, ${appliedUnits}, ${appliedRows}, ${payload.username})
      `
      return res.json({ ok: true, applied_units: appliedUnits })
    }

    // ── GET movements — per-SKU dated flow for the 动销 view ─────────────────
    if (req.method === 'GET' && action === 'movements') {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
      const from = new Date(Date.now() - days * 86400000).toISOString()
      const rows = await sql`
        SELECT txn_type, style, color, size, qty, applied_at::date AS day
        FROM inventory_txn_rows
        WHERE applied_at >= ${from}
        ORDER BY applied_at
      `
      return res.json({ days, rows })
    }

    // ── GET transactions ──────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'transactions') {
      const rows = await sql`
        SELECT id, transaction_type, source_file, applied_units, row_count, applied_by, applied_at
        FROM inventory_transactions
        ORDER BY applied_at DESC LIMIT 200
      `
      return res.json({
        transactions: rows.map(r => ({
          ...r,
          timestamp: new Date(r.applied_at).toLocaleString(),
        })),
      })
    }

    // ── GET history — restorable snapshots ────────────────────────────────────
    if (req.method === 'GET' && action === 'history') {
      const rows = await sql`
        SELECT id, label, source_name, total_rows, total_units, created_at
        FROM inventory_snapshots ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOTS}
      `
      return res.json({
        snapshots: rows.map(r => ({
          id:          r.id,
          label:       r.label,
          source_name: r.source_name,
          total_rows:  r.total_rows,
          total_units: r.total_units,
          timestamp:   new Date(r.created_at).toLocaleString(),
        })),
      })
    }

    // ── POST restore — roll back to a snapshot ────────────────────────────────
    if (req.method === 'POST' && action === 'restore') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const snapId = parseInt(req.query.id, 10)
      if (!snapId) return res.status(400).json({ error: 'id required' })

      const [snap] = await sql`SELECT data FROM inventory_snapshots WHERE id = ${snapId}`
      if (!snap) return res.status(404).json({ error: 'Snapshot not found' })

      await saveSnapshot(sql, 'pre_restore')
      await sql`DELETE FROM inventory_balance`

      for (const r of snap.data) {
        await sql`
          INSERT INTO inventory_balance (style, color, size, quantity)
          VALUES (${r.style}, ${r.color}, ${r.size}, ${r.quantity})
          ON CONFLICT (style, color, size)
          DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
        `
      }

      const [stat] = await sql`SELECT COALESCE(SUM(quantity),0)::int AS u FROM inventory_balance`
      return res.json({ ok: true, total_units: stat.u })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[/api/inventory-balance]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
