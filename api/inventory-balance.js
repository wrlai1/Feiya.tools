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
import authentication from '../lib/authentication.cjs'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'
import inventoryTransactionSafety from '../lib/inventoryTransactionSafety.cjs'
import { inventoryRestoreMode, inventoryRestoreUsesQuantities } from '../src/utils/inventoryRestoreMode.js'

const MAX_SNAPSHOTS = 20
const { authenticateUser } = authentication
const { resolveInventoryTargets } = inventoryTargetResolution
const {
  inventoryIdentity,
  normalizeInventoryQuantity,
  normalizeInventoryRows,
  normalizeOrderClaims,
  orderClaimsToSqlRecords,
} = inventoryTransactionSafety

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
function normalizeStore(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 100)
  return name ? { name, key: name.toLowerCase() } : { name: '', key: '' }
}

export function normalizeInventoryRowIds(rawIds) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) throw new Error('ids required')
  const ids = rawIds.map(Number)
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('ids must contain positive whole-number inventory row IDs')
  }
  return [...new Set(ids)]
}

export function trimInventorySnapshots(sql) {
  return sql`
    DELETE FROM inventory_snapshots snapshots
    WHERE NOT EXISTS (
      SELECT 1
      FROM inventory_transactions transactions
      WHERE transactions.rolled_back_at IS NULL
        AND transactions.rollback_snapshot_id = snapshots.id
    )
      AND snapshots.id NOT IN (
        SELECT candidate.id
        FROM inventory_snapshots candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM inventory_transactions transactions
          WHERE transactions.rolled_back_at IS NULL
            AND transactions.rollback_snapshot_id = candidate.id
        )
        ORDER BY candidate.created_at DESC, candidate.id DESC
        LIMIT ${MAX_SNAPSHOTS}
      )
  `
}

export function queryInventorySnapshotHistory(sql) {
  return sql`
    WITH active_transaction_snapshot_ids AS MATERIALIZED (
      SELECT DISTINCT transactions.rollback_snapshot_id AS id
      FROM inventory_transactions transactions
      WHERE transactions.rolled_back_at IS NULL
        AND transactions.rollback_snapshot_id IS NOT NULL
    ),
    recent_other_snapshot_ids AS MATERIALIZED (
      SELECT snapshots.id
      FROM inventory_snapshots snapshots
      WHERE NOT EXISTS (
        SELECT 1
        FROM active_transaction_snapshot_ids active
        WHERE active.id = snapshots.id
      )
      ORDER BY snapshots.created_at DESC, snapshots.id DESC
      LIMIT ${MAX_SNAPSHOTS}
    ),
    visible_snapshot_ids AS (
      SELECT id FROM active_transaction_snapshot_ids
      UNION
      SELECT id FROM recent_other_snapshot_ids
    )
    SELECT
      snapshots.id,
      snapshots.label,
      snapshots.source_name,
      snapshots.total_rows,
      snapshots.total_units,
      snapshots.created_at,
      CASE
        WHEN snapshots.label IN ('sales', 'return', 'adjustment') THEN EXISTS (
          SELECT 1
          FROM inventory_transactions transactions
          WHERE transactions.rolled_back_at IS NULL
            AND (
              transactions.rollback_snapshot_id = snapshots.id
              OR (
                transactions.rollback_snapshot_id IS NULL
                AND transactions.transaction_type = snapshots.label
                AND transactions.source_file IS NOT DISTINCT FROM snapshots.source_name
                AND transactions.applied_at >= snapshots.created_at
              )
            )
        )
        ELSE snapshots.label <> 'pre_restore'
      END AS restorable
    FROM inventory_snapshots snapshots
    JOIN visible_snapshot_ids visible ON visible.id = snapshots.id
    ORDER BY snapshots.created_at DESC, snapshots.id DESC
  `
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
      business_day DATE,
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
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rollback_snapshot_id INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS transaction_id INTEGER`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS business_day DATE`
  await sql`
    UPDATE inventory_txn_rows rows
    SET transaction_id = (
      SELECT transactions.id
      FROM inventory_transactions transactions
      WHERE transactions.transaction_type = rows.txn_type
        AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
        AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
        AND ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))) <= 30
      ORDER BY
        ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))),
        transactions.id DESC
      LIMIT 1
    )
    WHERE rows.transaction_id IS NULL
  `
  await sql`
    CREATE INDEX IF NOT EXISTS inventory_txn_rows_transaction_id_idx
    ON inventory_txn_rows (transaction_id)
  `
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
  await sql`
    WITH restored_snapshots AS (
      SELECT
        substring(source_name FROM 'point ([0-9]+)$')::integer AS snapshot_id,
        created_at AS restored_at
      FROM inventory_snapshots
      WHERE label = 'pre_restore' AND source_name ~ 'point [0-9]+$'
    ),
    restored_transactions AS (
      SELECT
        restored.restored_at,
        (
          SELECT candidate.id
          FROM inventory_transactions candidate
          JOIN inventory_snapshots original ON original.id = restored.snapshot_id
          WHERE candidate.rollback_snapshot_id = original.id
             OR (
               candidate.rollback_snapshot_id IS NULL
               AND candidate.transaction_type = original.label
               AND candidate.source_file IS NOT DISTINCT FROM original.source_name
               AND candidate.applied_at >= original.created_at
             )
          ORDER BY
            CASE WHEN candidate.rollback_snapshot_id = original.id THEN 0 ELSE 1 END,
            candidate.applied_at,
            candidate.id
          LIMIT 1
        ) AS transaction_id
      FROM restored_snapshots restored
    )
    UPDATE inventory_transactions target
    SET rolled_back_at = restored.restored_at
    FROM restored_transactions restored
    WHERE target.id = restored.transaction_id
      AND target.rolled_back_at IS NULL
  `
  await sql`DROP INDEX IF EXISTS inventory_transactions_source_hash_uq`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_active_source_hash_uq
    ON inventory_transactions (transaction_type, source_hash)
    WHERE source_hash IS NOT NULL AND source_hash <> '' AND rolled_back_at IS NULL
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_order_claims (
      id BIGSERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL,
      order_key TEXT NOT NULL,
      item_key TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      claimed_at TIMESTAMPTZ DEFAULT NOW(),
      rolled_back_at TIMESTAMPTZ
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_order_claims_active_item_uq
    ON inventory_order_claims (order_key, item_key)
    WHERE rolled_back_at IS NULL
  `
  await sql`
    UPDATE inventory_order_claims claims
    SET rolled_back_at = transactions.rolled_back_at
    FROM inventory_transactions transactions
    WHERE claims.transaction_id = transactions.id
      AND claims.rolled_back_at IS NULL
      AND transactions.rolled_back_at IS NOT NULL
  `
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.return_orders') IS NOT NULL
         AND to_regclass('public.return_order_items') IS NOT NULL THEN
        INSERT INTO inventory_order_claims (
          transaction_id, order_key, item_key, source_hash
        )
        SELECT
          transactions.id,
          orders.order_key,
          CASE
            WHEN NULLIF(BTRIM(items.sku_id), '') IS NOT NULL
              THEN 'sku:' || LOWER(BTRIM(items.sku_id))
            WHEN NULLIF(BTRIM(items.skc_id), '') IS NOT NULL
              THEN 'skc:' || LOWER(BTRIM(items.skc_id))
            ELSE 'item:' || LOWER(REGEXP_REPLACE(items.item_key, '[[:space:]]+', '', 'g'))
          END,
          transactions.source_hash
        FROM inventory_transactions transactions
        JOIN return_orders orders
          ON orders.source_hash = transactions.source_hash
        JOIN return_order_items items
          ON items.order_id = orders.id
        WHERE transactions.transaction_type = 'sales'
          AND transactions.rolled_back_at IS NULL
          AND transactions.source_hash IS NOT NULL
          AND transactions.source_hash <> ''
        ON CONFLICT DO NOTHING;
      END IF;
    END
    $$;
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
    const payload = await authenticateUser(sql, req.headers.authorization, secret)
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })

    const isAdmin = payload.role === 'admin'
    const action  = req.query.action

    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })

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

      let importRows
      try {
        importRows = normalizeInventoryRows(rows)
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }
      const importJson = JSON.stringify(importRows)
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
          SELECT
            'pre_init', ${String(sourceName || '').slice(0, 500)},
            COALESCE(jsonb_agg(jsonb_build_object(
              'style', style, 'color', color, 'size', size, 'quantity', quantity,
              'sort_order', sort_order
            ) ORDER BY sort_order NULLS LAST, id), '[]'::jsonb),
            COUNT(*)::int, COALESCE(SUM(quantity), 0)::int
          FROM inventory_balance
        `,
        txn`DELETE FROM inventory_balance`,
        txn`
          INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
          SELECT imported.style, imported.color, imported.size, imported.quantity, imported.sort_order
          FROM jsonb_to_recordset(${importJson}::jsonb)
            AS imported(style TEXT, color TEXT, size TEXT, quantity INTEGER, sort_order INTEGER)
        `,
        trimInventorySnapshots(txn),
        txn`SELECT COUNT(*)::int AS c, COALESCE(SUM(quantity),0)::int AS u FROM inventory_balance`,
      ], { isolationLevel: 'Serializable' })
      const [stat] = results[results.length - 1]
      return res.json({ ok: true, total_rows: stat.c, total_units: stat.u })
    }

    // ── PATCH edit — update one row's quantity ────────────────────────────────
    if (req.method === 'PATCH' && action === 'edit') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const id  = parseInt(req.query.id, 10)
      if (!id) return res.status(400).json({ error: 'id required' })
      const { quantity: rawQuantity, reason: rawReason = '' } = req.body || {}
      if (rawQuantity === undefined || rawQuantity === null) return res.status(400).json({ error: 'quantity required' })
      let quantity
      try {
        quantity = normalizeInventoryQuantity(rawQuantity)
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }

      const [old] = await sql`SELECT style, color, size, quantity FROM inventory_balance WHERE id = ${id}`
      if (!old) return res.status(404).json({ error: 'Row not found' })
      if (Number(old.quantity) === quantity) {
        return res.json({ ok: true, old_quantity: old.quantity, new_quantity: quantity, no_change: true })
      }

      const reason = String(rawReason || '').trim().slice(0, 300)
      const sourceName = `Manual adjustment: ${old.style} / ${old.color} / ${old.size}${reason ? ` — ${reason}` : ''}`
      const [result] = await sql`
        WITH target AS MATERIALIZED (
          SELECT id, style, color, size, quantity
          FROM inventory_balance
          WHERE id = ${id}
          FOR UPDATE
        ),
        saved_snapshot AS (
          INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
          SELECT
            'adjustment',
            ${sourceName},
            COALESCE(jsonb_agg(jsonb_build_object(
              'style', inventory.style, 'color', inventory.color, 'size', inventory.size,
              'quantity', inventory.quantity, 'sort_order', inventory.sort_order
            ) ORDER BY inventory.sort_order NULLS LAST, inventory.id), '[]'::jsonb),
            COUNT(*)::int,
            COALESCE(SUM(inventory.quantity), 0)::int
          FROM inventory_balance inventory
          RETURNING id
        ),
        logged_transaction AS (
          INSERT INTO inventory_transactions (
            transaction_type, source_file, applied_units, row_count,
            applied_by, rollback_snapshot_id
          )
          SELECT
            'adjustment', ${sourceName}, ABS(${quantity} - target.quantity),
            1, ${payload.username}, saved_snapshot.id
          FROM target, saved_snapshot
          RETURNING id
        ),
        updated AS (
          UPDATE inventory_balance inventory
          SET quantity = ${quantity}, updated_at = NOW()
          FROM target
          WHERE inventory.id = target.id
          RETURNING inventory.quantity
        ),
        logged_movement AS (
          INSERT INTO inventory_txn_rows (
            transaction_id, txn_type, style, color, size, qty, source_file, applied_by
          )
          SELECT
            logged_transaction.id, 'adjustment', target.style, target.color, target.size,
            ${quantity} - target.quantity, ${sourceName}, ${payload.username}
          FROM target, logged_transaction
        )
        SELECT target.quantity AS old_quantity, updated.quantity AS new_quantity
        FROM target, updated
      `
      if (!result) return res.status(409).json({ error: 'Inventory row changed before the adjustment could be saved. Refresh and try again.' })
      return res.json({ ok: true, old_quantity: result.old_quantity, new_quantity: result.new_quantity })
    }

    // ── POST add-rows — append new rows, skip existing ────────────────────────
    if (req.method === 'POST' && action === 'add-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const { rows } = req.body || {}
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' })

      let importRows
      try {
        importRows = normalizeInventoryRows(rows, { defaultSortOrder: false })
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(importRows)}::jsonb)
              AS imported(style TEXT, color TEXT, size TEXT, quantity INTEGER, sort_order INTEGER)
          ),
          new_rows AS (
            SELECT incoming.*
            FROM incoming
            WHERE NOT EXISTS (
              SELECT 1
              FROM inventory_balance inventory
              WHERE LOWER(BTRIM(inventory.style)) = LOWER(BTRIM(incoming.style))
                AND LOWER(BTRIM(inventory.color)) = LOWER(BTRIM(incoming.color))
                AND CASE UPPER(BTRIM(inventory.size))
                      WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
                      ELSE UPPER(BTRIM(inventory.size))
                    END = CASE UPPER(BTRIM(incoming.size))
                      WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
                      ELSE UPPER(BTRIM(incoming.size))
                    END
            )
          ),
          inserted AS (
            INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
            SELECT style, color, size, quantity, sort_order FROM new_rows
            ON CONFLICT (style, color, size) DO NOTHING
            RETURNING id
          )
          SELECT COUNT(*)::int AS added FROM inserted
        `,
      ], { isolationLevel: 'Serializable' })
      const added = Number(results[1]?.[0]?.added || 0)
      return res.json({ ok: true, added, skipped: importRows.length - added })
    }

    // ── DELETE remove-rows — delete by ids ────────────────────────────────────
    if (req.method === 'DELETE' && action === 'remove-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      let ids
      try {
        ids = normalizeInventoryRowIds(req.body?.ids)
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }

      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
          SELECT
            'pre_remove', '',
            COALESCE(jsonb_agg(jsonb_build_object(
              'style', style, 'color', color, 'size', size, 'quantity', quantity,
              'sort_order', sort_order
            ) ORDER BY sort_order NULLS LAST, id), '[]'::jsonb),
            COUNT(*)::int, COALESCE(SUM(quantity), 0)::int
          FROM inventory_balance
        `,
        txn`
          WITH deleted AS (
            DELETE FROM inventory_balance
            WHERE id = ANY(${ids}::int[])
            RETURNING id
          )
          SELECT COUNT(*)::int AS removed FROM deleted
        `,
        trimInventorySnapshots(txn),
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true, removed: Number(results[2]?.[0]?.removed || 0) })
    }

    // ── POST reset — zero out all quantities ──────────────────────────────────
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
          SELECT
            'pre_reset', '',
            COALESCE(jsonb_agg(jsonb_build_object(
              'style', style, 'color', color, 'size', size, 'quantity', quantity,
              'sort_order', sort_order
            ) ORDER BY sort_order NULLS LAST, id), '[]'::jsonb),
            COUNT(*)::int, COALESCE(SUM(quantity), 0)::int
          FROM inventory_balance
        `,
        txn`
          WITH zeroed AS (
            UPDATE inventory_balance
            SET quantity = 0, updated_at = NOW()
            WHERE quantity <> 0
            RETURNING id
          )
          SELECT COUNT(*)::int AS zeroed FROM zeroed
        `,
        trimInventorySnapshots(txn),
      ], { isolationLevel: 'Serializable' })
      return res.json({ ok: true, zeroed: Number(results[2]?.[0]?.zeroed || 0) })
    }

    // ── POST apply — deduct (sales) or add (return) quantities ────────────────
    if (req.method === 'POST' && action === 'apply') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const {
        filledRows = [],
        movementRows: rawMovementRows = [],
        txnType = 'sales',
        sourceName = '',
        sourceHash: rawSourceHash = '',
        orderClaims: rawOrderClaims = [],
        sourceUnits: rawSourceUnits,
        storeName: rawStoreName = '',
      } = req.body || {}
      if (!['sales', 'return'].includes(txnType)) return res.status(400).json({ error: 'Invalid transaction type' })
      const sourceHash = String(rawSourceHash || '').trim()
      const store = normalizeStore(rawStoreName)
      if (!sourceHash) return res.status(400).json({ error: 'A source file fingerprint is required before inventory can be changed.' })
      if (txnType === 'sales' && !store.key) {
        return res.status(400).json({ error: 'The Analytics store is required before sales inventory can be changed.' })
      }
      let sourceUnits
      try {
        sourceUnits = normalizeInventoryQuantity(rawSourceUnits)
      } catch {
        return res.status(400).json({ error: 'A valid source physical-unit total is required before inventory can be changed.' })
      }
      let orderClaims
      try {
        orderClaims = normalizeOrderClaims(rawOrderClaims)
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }
      const orderClaimRecords = orderClaimsToSqlRecords(orderClaims)
      if (txnType !== 'sales' && orderClaims.length) {
        return res.status(400).json({ error: 'Order deduction claims are only valid for sales.' })
      }
      if (txnType === 'sales' && !orderClaims.length) {
        return res.status(400).json({
          error: 'Sales deductions require a raw order workbook with order numbers. Consolidated CSV files can be reviewed or downloaded, but cannot change inventory.',
        })
      }

      const duplicate = await sql`
        SELECT id FROM inventory_transactions
        WHERE transaction_type = ${txnType}
          AND source_hash = ${sourceHash}
          AND rolled_back_at IS NULL
        LIMIT 1
      `
      if (duplicate.length) return res.status(409).json({ error: 'This exact file has already been applied. Inventory was not changed.' })
      if (orderClaims.length) {
        const existingClaims = await sql`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(orderClaimRecords)}::jsonb)
              AS claim(order_key TEXT, item_key TEXT)
          )
          SELECT claims.order_key, claims.item_key
          FROM inventory_order_claims claims
          JOIN incoming
            ON incoming.order_key = claims.order_key
           AND incoming.item_key = claims.item_key
          WHERE claims.rolled_back_at IS NULL
          LIMIT 20
        `
        if (existingClaims.length) {
          return res.status(409).json({
            error: `${existingClaims.length} order item(s) were already deducted in an earlier file. Inventory was not changed.`,
            duplicate_order_items: existingClaims,
          })
        }
      }

      let applyRows = filledRows.flatMap((r) => {
        const style = String(r.STYLE || '').trim()
        const color = String(r.COLOR || '').trim()
        const size = String(r.SIZE || '').trim()
        const rawQty = r.QTY
        const qty = Number(rawQty)
        if (rawQty === '' || rawQty == null || qty === 0) return []
        return [{ style, color, size, qty, allowCreate: r.allowCreate === true }]
      })
      const invalidRow = applyRows.find((row) =>
        !row.style || !row.color || !row.size || !Number.isSafeInteger(row.qty) || row.qty < 0
      )
      if (invalidRow) return res.status(400).json({ error: 'Invalid style, color, size, or quantity in deduction preview' })
      if (!applyRows.length) return res.status(400).json({ error: 'No inventory quantities to apply' })

      const targetResolutions = await sql`
        WITH targets AS (
          SELECT
            (target.ordinality - 1)::int AS target_index,
            target.value->>'style' AS style,
            target.value->>'color' AS color,
            target.value->>'size' AS size
          FROM jsonb_array_elements(${JSON.stringify(applyRows)}::jsonb)
            WITH ORDINALITY AS target(value, ordinality)
        )
        SELECT
          target.target_index,
          COUNT(inventory.id)::int AS match_count,
          MIN(inventory.style) AS matched_style,
          MIN(inventory.color) AS matched_color,
          MIN(inventory.size) AS matched_size
        FROM targets target
        LEFT JOIN inventory_balance inventory
          ON LOWER(BTRIM(inventory.style)) = LOWER(BTRIM(target.style))
         AND LOWER(BTRIM(inventory.color)) = LOWER(BTRIM(target.color))
         AND CASE UPPER(BTRIM(inventory.size))
               WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
               ELSE UPPER(BTRIM(inventory.size))
             END = CASE UPPER(BTRIM(target.size))
               WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
               ELSE UPPER(BTRIM(target.size))
             END
        GROUP BY target.target_index
        ORDER BY target.target_index
      `
      const resolvedTargets = resolveInventoryTargets(applyRows, targetResolutions)
      if (resolvedTargets.ambiguous.length) {
        const target = resolvedTargets.ambiguous[0]
        return res.status(409).json({
          error: `More than one inventory target matches capitalization-insensitively: ${target.style} / ${target.color} / ${target.size}. Merge the duplicate inventory rows before applying.`,
        })
      }
      if (resolvedTargets.missing.length) {
        const target = resolvedTargets.missing[0]
        return res.status(409).json({ error: `Inventory target no longer exists: ${target.style} / ${target.color} / ${target.size}. Run Auto-Fill again.` })
      }
      applyRows = resolvedTargets.rows
      const existingTargets = applyRows.filter((row) => !row.allowCreate)

      const applyTotals = new Map()
      const applyTargets = new Map()
      for (const row of applyRows) {
        const key = inventoryIdentity(row.style, row.color, row.size)
        applyTotals.set(key, (applyTotals.get(key) || 0) + row.qty)
        applyTargets.set(key, row)
      }
      const movementInput = Array.isArray(rawMovementRows) && rawMovementRows.length
        ? rawMovementRows
        : applyRows.map((row) => ({ ...row, businessDay: '' }))
      const movementGroups = new Map()
      for (const raw of movementInput) {
        const style = String(raw.STYLE || raw.style || '').trim()
        const color = String(raw.COLOR || raw.color || '').trim()
        const size = String(raw.SIZE || raw.size || '').trim()
        const qty = Number(raw.QTY ?? raw.qty)
        const businessDay = String(raw.businessDay || raw.business_day || '').trim()
        if (
          !style || !color || !size
          || !Number.isSafeInteger(qty) || qty <= 0
          || (businessDay && !/^\d{4}-\d{2}-\d{2}$/.test(businessDay))
        ) {
          return res.status(400).json({ error: 'Movement rows require a valid inventory target, positive whole quantity, and YYYY-MM-DD business date' })
        }
        const targetKey = inventoryIdentity(style, color, size)
        const target = applyTargets.get(targetKey)
        if (!target) {
          return res.status(409).json({ error: `Movement date allocation does not match inventory target: ${style} / ${color} / ${size}` })
        }
        const groupKey = `${targetKey}\u241f${businessDay}`
        const current = movementGroups.get(groupKey) || {
          style: target.style,
          color: target.color,
          size: target.size,
          qty: 0,
          businessDay,
        }
        current.qty += qty
        movementGroups.set(groupKey, current)
      }
      const movementRows = [...movementGroups.values()]
      const movementTotals = new Map()
      for (const row of movementRows) {
        const key = inventoryIdentity(row.style, row.color, row.size)
        movementTotals.set(key, (movementTotals.get(key) || 0) + row.qty)
      }
      if (
        applyTotals.size !== movementTotals.size
        || [...applyTotals].some(([key, qty]) => movementTotals.get(key) !== qty)
      ) {
        return res.status(409).json({ error: 'Business-date movement totals do not match the inventory update. Inventory was not changed.' })
      }

      const appliedUnits = applyRows.reduce((sum, row) => sum + row.qty, 0)
      if (appliedUnits !== sourceUnits) {
        return res.status(409).json({
          error: `Source physical-unit total (${sourceUnits}) does not match the inventory update total (${appliedUnits}). Inventory was not changed.`,
        })
      }
      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        ...(existingTargets.length ? [txn`
          WITH targets AS (
            SELECT * FROM jsonb_to_recordset(${JSON.stringify(existingTargets)}::jsonb)
              AS target(style TEXT, color TEXT, size TEXT)
          ),
          locked AS MATERIALIZED (
            SELECT inventory.id
            FROM targets target
            JOIN inventory_balance inventory
              ON inventory.style = target.style
             AND inventory.color = target.color
             AND inventory.size = target.size
            FOR UPDATE OF inventory
          ),
          target_counts AS (
            SELECT
              (SELECT COUNT(*) FROM targets) AS expected,
              (SELECT COUNT(*) FROM locked) AS found
          )
          SELECT 1 / CASE WHEN expected = found THEN 1 ELSE 0 END AS targets_valid
          FROM target_counts
        `] : []),
        txn`
          WITH saved_snapshot AS (
            INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
            SELECT
              ${txnType},
              ${sourceName},
              COALESCE(jsonb_agg(jsonb_build_object(
                'style', style, 'color', color, 'size', size, 'quantity', quantity,
                'sort_order', sort_order
              ) ORDER BY sort_order NULLS LAST, id), '[]'::jsonb),
              COUNT(*)::int,
              COALESCE(SUM(quantity), 0)::int
            FROM inventory_balance
            RETURNING id
          )
          INSERT INTO inventory_transactions (
            transaction_type, source_file, source_hash, applied_units, row_count,
            applied_by, rollback_snapshot_id, store_name, store_key
          )
          SELECT
            ${txnType}, ${sourceName}, ${sourceHash}, ${appliedUnits},
            ${movementRows.length}, ${payload.username}, saved_snapshot.id,
            ${store.name}, ${store.key}
          FROM saved_snapshot
        `,
        ...(orderClaims.length ? [txn`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(orderClaimRecords)}::jsonb)
              AS claim(order_key TEXT, item_key TEXT)
          ),
          applied_transaction AS (
            SELECT id
            FROM inventory_transactions
            WHERE transaction_type = ${txnType}
              AND source_hash = ${sourceHash}
              AND rolled_back_at IS NULL
          )
          INSERT INTO inventory_order_claims (
            transaction_id, order_key, item_key, source_hash
          )
          SELECT
            applied_transaction.id, incoming.order_key, incoming.item_key, ${sourceHash}
          FROM incoming
          CROSS JOIN applied_transaction
        `] : []),
        ...applyRows.flatMap((row) => {
          const delta = txnType === 'sales' ? -row.qty : row.qty
          const update = row.allowCreate
            ? txn`
                INSERT INTO inventory_balance (style, color, size, quantity)
                VALUES (${row.style}, ${row.color}, ${row.size}, ${delta})
                ON CONFLICT (style, color, size)
                DO UPDATE SET quantity = inventory_balance.quantity + ${delta}, updated_at = NOW()
              `
            : txn`
                UPDATE inventory_balance
                SET quantity = quantity + ${delta}, updated_at = NOW()
                WHERE style = ${row.style} AND color = ${row.color} AND size = ${row.size}
              `
          return [update]
        }),
        ...movementRows.map((row) => txn`
          INSERT INTO inventory_txn_rows (
            transaction_id, txn_type, style, color, size, qty, source_file, applied_by,
            store_name, store_key, business_day
          )
          SELECT
            transactions.id, ${txnType}, ${row.style}, ${row.color}, ${row.size},
            ${row.qty}, ${sourceName}, ${payload.username}, ${store.name}, ${store.key},
            ${row.businessDay || null}::date
          FROM inventory_transactions transactions
          WHERE transactions.transaction_type = ${txnType}
            AND transactions.source_hash = ${sourceHash}
            AND transactions.rolled_back_at IS NULL
        `),
        ...(txnType === 'sales' ? [
          txn`
            UPDATE return_orders
            SET inventory_status = 'applied', updated_at = NOW()
            WHERE source_hash = ${sourceHash}
              AND inventory_status = 'pending'
          `,
          txn`
            UPDATE return_order_imports
            SET inventory_status = 'applied'
            WHERE source_hash = ${sourceHash}
              AND inventory_status = 'pending'
          `,
        ] : []),
        trimInventorySnapshots(txn),
      ])
      return res.json({ ok: true, applied_units: appliedUnits })
    }

    // ── GET movements — per-SKU dated flow for the 动销 view ─────────────────
    if (req.method === 'GET' && action === 'movements') {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
      const fromDay = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10)
      const rows = await sql`
        SELECT rows.txn_type, rows.style, rows.color, rows.size, rows.qty,
               COALESCE(rows.business_day, rows.applied_at::date) AS day
        FROM inventory_txn_rows rows
        WHERE COALESCE(rows.business_day, rows.applied_at::date) >= ${fromDay}::date
          AND NOT EXISTS (
            SELECT 1
            FROM inventory_transactions transactions
            WHERE transactions.rolled_back_at IS NOT NULL
              AND (
                transactions.id = rows.transaction_id
                OR (
                  rows.transaction_id IS NULL
                  AND transactions.transaction_type = rows.txn_type
                  AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
                  AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
                  AND ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))) <= 30
                )
              )
          )
        ORDER BY COALESCE(rows.business_day, rows.applied_at::date), rows.applied_at
      `
      return res.json({ days, rows })
    }

    // ── GET transactions ──────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'transactions') {
      const rows = await sql`
        SELECT id, transaction_type, source_file, applied_units, row_count, applied_by, applied_at, rolled_back_at
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
      const rows = await queryInventorySnapshotHistory(sql)
      return res.json({
        snapshots: rows.map(r => ({
          id:          r.id,
          label:       r.label,
          source_name: r.source_name,
          total_rows:  r.total_rows,
          total_units: r.total_units,
          created_at:  r.created_at,
          timestamp:   new Date(r.created_at).toLocaleString(),
          restorable:  Boolean(r.restorable),
        })),
      })
    }

    // ── POST restore — roll back to a snapshot ────────────────────────────────
    if (req.method === 'POST' && action === 'restore') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
      const snapId = parseInt(req.query.id, 10)
      if (!snapId) return res.status(400).json({ error: 'id required' })
      const requestedRestoreMode = req.query.mode

      const [snap] = await sql`
        SELECT data, label, source_name, created_at
        FROM inventory_snapshots
        WHERE id = ${snapId}
      `
      if (!snap) return res.status(404).json({ error: 'Snapshot not found' })
      if (snap.label === 'pre_restore') {
        return res.status(409).json({
          error: 'Rollback backup points are audit-only and cannot be restored safely. Choose the original deduction, return, or inventory version instead.',
        })
      }
      const snapshotRestoreMode = inventoryRestoreMode(snap.label)
      const quantityOnly = inventoryRestoreUsesQuantities(snap.label, requestedRestoreMode)
      const isTransactionSnapshot = ['sales', 'return', 'adjustment'].includes(snap.label)
      const [rollbackTransaction] = isTransactionSnapshot
        ? await sql`
            SELECT candidate.id, candidate.source_hash, candidate.applied_at
            FROM inventory_transactions candidate
            WHERE candidate.rolled_back_at IS NULL
              AND (
                candidate.rollback_snapshot_id = ${snapId}
                OR (
                  candidate.rollback_snapshot_id IS NULL
                  AND candidate.transaction_type = ${snap.label}
                  AND candidate.source_file IS NOT DISTINCT FROM ${snap.source_name}
                  AND candidate.applied_at >= ${snap.created_at}
                )
              )
            ORDER BY
              CASE WHEN candidate.rollback_snapshot_id = ${snapId} THEN 0 ELSE 1 END,
              candidate.applied_at,
              candidate.id
            LIMIT 1
          `
        : []
      if (isTransactionSnapshot && !rollbackTransaction) {
        return res.status(409).json({
          error: 'This inventory update was already rolled back, so this rollback point cannot be used again.',
        })
      }
      const rollbackTransactions = rollbackTransaction
        ? await sql`
            SELECT id, source_hash
            FROM inventory_transactions
            WHERE rolled_back_at IS NULL
              AND (
                applied_at > ${rollbackTransaction.applied_at}
                OR (
                  applied_at = ${rollbackTransaction.applied_at}
                  AND id >= ${rollbackTransaction.id}
                )
              )
            ORDER BY applied_at, id
          `
        : snapshotRestoreMode === 'full'
          ? await sql`
              SELECT id, source_hash
              FROM inventory_transactions
              WHERE rolled_back_at IS NULL
                AND applied_at >= ${snap.created_at}
              ORDER BY applied_at, id
            `
          : []
      const rollbackTransactionIds = rollbackTransactions.map((transaction) => Number(transaction.id))
      const salesSourceHashes = [...new Set(rollbackTransactions
        .map((transaction) => String(transaction.source_hash || ''))
        .filter((sourceHash) => sourceHash && !sourceHash.startsWith('return-package:')))]
      const returnTrackingKeys = [...new Set(rollbackTransactions
        .map((transaction) => String(transaction.source_hash || ''))
        .filter((sourceHash) => sourceHash.startsWith('return-package:'))
        .map((sourceHash) => sourceHash.slice('return-package:'.length))
        .filter(Boolean))]

      const restoreRows = (Array.isArray(snap.data) ? snap.data : []).map((row, index) => ({
        style: String(row.style || '').trim(),
        color: String(row.color || '').trim(),
        size: String(row.size || '').trim(),
        quantity: Number(row.quantity),
        sort_order: Number.isSafeInteger(Number(row.sort_order)) ? Number(row.sort_order) : index,
      }))
      const invalidRow = restoreRows.find((row) =>
        !row.style || !row.color || !row.size || !Number.isSafeInteger(row.quantity)
      )
      if (invalidRow) return res.status(409).json({ error: 'This rollback point contains invalid inventory data and cannot be restored safely.' })

      const totalUnits = restoreRows.reduce((sum, row) => sum + row.quantity, 0)
      const transactionResults = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
          SELECT
            'pre_restore',
            ${`${quantityOnly ? 'Quantity rollback' : 'Rollback'} point ${snapId}`},
            COALESCE(jsonb_agg(jsonb_build_object(
              'style', style, 'color', color, 'size', size, 'quantity', quantity,
              'sort_order', sort_order
            ) ORDER BY sort_order NULLS LAST, id), '[]'::jsonb),
            COUNT(*)::int,
            COALESCE(SUM(quantity), 0)::int
          FROM inventory_balance
        `,
        ...(rollbackTransactionIds.length
          ? [
              txn`
                UPDATE inventory_transactions
                SET rolled_back_at = NOW()
                WHERE id = ANY(${rollbackTransactionIds}::int[])
                  AND rolled_back_at IS NULL
              `,
              txn`
                UPDATE inventory_order_claims
                SET rolled_back_at = NOW()
                WHERE transaction_id = ANY(${rollbackTransactionIds}::int[])
                  AND rolled_back_at IS NULL
              `,
            ]
          : []),
        ...(returnTrackingKeys.length
          ? [
              txn`
                UPDATE return_package_items items
                SET actual_qty = NULL,
                    restock_qty = NULL,
                    not_ours_qty = NULL
                FROM return_packages packages
                WHERE items.package_id = packages.id
                  AND packages.tracking_key = ANY(${returnTrackingKeys}::text[])
              `,
              txn`
                UPDATE return_packages
                SET status = CASE
                      WHEN status IN ('discrepancy', 'rejected')
                        OR escalated_at IS NOT NULL
                        OR NULLIF(BTRIM(review_reason), '') IS NOT NULL
                      THEN 'needs_review'
                      ELSE 'pending'
                    END,
                    actual_units = 0,
                    restock_units = 0,
                    flagged_not_ours = false,
                    remark = NULL,
                    confirmed_by = NULL,
                    confirmed_at = NULL
                WHERE tracking_key = ANY(${returnTrackingKeys}::text[])
              `,
            ]
          : []),
        ...(salesSourceHashes.length
          ? [
              txn`
                UPDATE return_orders
                SET inventory_status = 'pending', updated_at = NOW()
                WHERE source_hash = ANY(${salesSourceHashes}::text[])
              `,
              txn`
                UPDATE return_order_imports
                SET inventory_status = 'pending'
                WHERE source_hash = ANY(${salesSourceHashes}::text[])
              `,
            ]
          : []),
        ...(quantityOnly
          ? [txn`
              INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
              SELECT restored.style, restored.color, restored.size, restored.quantity, restored.sort_order
              FROM jsonb_to_recordset(${JSON.stringify(restoreRows)}::jsonb)
                AS restored(style TEXT, color TEXT, size TEXT, quantity INTEGER, sort_order INTEGER)
              ON CONFLICT (style, color, size)
              DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
            `]
          : [
              txn`DELETE FROM inventory_balance`,
              txn`
                INSERT INTO inventory_balance (style, color, size, quantity, sort_order)
                SELECT restored.style, restored.color, restored.size, restored.quantity, restored.sort_order
                FROM jsonb_to_recordset(${JSON.stringify(restoreRows)}::jsonb)
                  AS restored(style TEXT, color TEXT, size TEXT, quantity INTEGER, sort_order INTEGER)
              `,
            ]),
        ...(quantityOnly && rollbackTransactionIds.length
          ? [txn`
              WITH restored_keys AS (
                SELECT restored.style, restored.color, restored.size
                FROM jsonb_to_recordset(${JSON.stringify(restoreRows)}::jsonb)
                  AS restored(style TEXT, color TEXT, size TEXT, quantity INTEGER, sort_order INTEGER)
              ),
              rolled_delta AS (
                SELECT
                  rows.style,
                  rows.color,
                  rows.size,
                  SUM(
                    CASE
                      WHEN rows.txn_type = 'sales' THEN -rows.qty
                      WHEN rows.txn_type = 'return' THEN rows.qty
                      ELSE rows.qty
                    END
                  )::int AS quantity_delta
                FROM inventory_txn_rows rows
                WHERE rows.transaction_id = ANY(${rollbackTransactionIds}::int[])
                GROUP BY rows.style, rows.color, rows.size
              )
              UPDATE inventory_balance inventory
              SET quantity = GREATEST(0, inventory.quantity - rolled_delta.quantity_delta),
                  updated_at = NOW()
              FROM rolled_delta
              WHERE inventory.style = rolled_delta.style
                AND inventory.color = rolled_delta.color
                AND inventory.size = rolled_delta.size
                AND NOT EXISTS (
                  SELECT 1
                  FROM restored_keys
                  WHERE restored_keys.style = inventory.style
                    AND restored_keys.color = inventory.color
                    AND restored_keys.size = inventory.size
                )
            `]
          : []),
        trimInventorySnapshots(txn),
        txn`
          SELECT COUNT(*)::int AS total_rows, COALESCE(SUM(quantity), 0)::int AS total_units
          FROM inventory_balance
        `,
      ], { isolationLevel: 'Serializable' })

      const [restoredStats] = transactionResults[transactionResults.length - 1]
      return res.json({
        ok: true,
        total_units: restoredStats?.total_units ?? totalUnits,
        total_rows: restoredStats?.total_rows ?? restoreRows.length,
        rolled_back_transactions: rollbackTransactionIds.length,
      })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[/api/inventory-balance]', err.message)
    if (/inventory_order_claims_active_item_uq/.test(err.message)) {
      return res.status(409).json({ error: 'One or more order items were already deducted. Inventory was not changed.' })
    }
    if (/inventory_transactions_active_source_hash_uq/.test(err.message)) {
      return res.status(409).json({ error: 'This exact file has already been applied. Inventory was not changed.' })
    }
    return res.status(500).json({ error: err.message })
  }
}
