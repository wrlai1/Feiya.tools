import { neon } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'

const { resolveInventoryTargets } = inventoryTargetResolution
const MAX_PACKAGES_PER_IMPORT = 5000
const MAX_ITEMS_PER_IMPORT = 50000

function getDB() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  return neon(url)
}

function verifyToken(header) {
  if (!header?.startsWith('Bearer ') || !process.env.JWT_SECRET) return null
  try { return jwt.verify(header.slice(7), process.env.JWT_SECRET) } catch { return null }
}

function normalizeTracking(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase()
}

function itemIdentity(item) {
  return [item.style, item.color, item.size]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('\u0000')
}

function normalizePackages(rawPackages) {
  if (!Array.isArray(rawPackages) || !rawPackages.length) throw new Error('packages array required')
  if (rawPackages.length > MAX_PACKAGES_PER_IMPORT) throw new Error(`Import is limited to ${MAX_PACKAGES_PER_IMPORT} packages`)

  let itemCount = 0
  const packages = new Map()
  for (const rawPackage of rawPackages) {
    const trackingKey = normalizeTracking(rawPackage.tracking || rawPackage.trackingNumber)
    const trackingNumber = String(rawPackage.trackingNumber || rawPackage.tracking || '').trim()
    if (!trackingKey) throw new Error('Every package requires a tracking number')
    if (!Array.isArray(rawPackage.items) || !rawPackage.items.length) {
      throw new Error(`Tracking ${trackingNumber || trackingKey} has no items`)
    }
    const pkg = packages.get(trackingKey) || {
      tracking_key: trackingKey,
      tracking_number: trackingNumber || trackingKey,
      items: new Map(),
    }
    for (const rawItem of rawPackage.items) {
      itemCount += 1
      if (itemCount > MAX_ITEMS_PER_IMPORT) throw new Error(`Import is limited to ${MAX_ITEMS_PER_IMPORT} item rows`)
      const item = {
        style: String(rawItem.style || rawItem.STYLE || '').trim(),
        color: String(rawItem.color || rawItem.COLOR || '').trim(),
        size: String(rawItem.size || rawItem.SIZE || '').trim(),
        expected_qty: Number(rawItem.expectedQty ?? rawItem.expected_qty ?? rawItem.QTY),
      }
      if (!item.style || !item.color || !item.size || !Number.isSafeInteger(item.expected_qty) || item.expected_qty <= 0) {
        throw new Error(`Invalid item in tracking ${trackingNumber || trackingKey}`)
      }
      const key = itemIdentity(item)
      const existing = pkg.items.get(key)
      if (existing) existing.expected_qty += item.expected_qty
      else pkg.items.set(key, item)
    }
    packages.set(trackingKey, pkg)
  }

  return [...packages.values()].map((pkg) => {
    const items = [...pkg.items.values()]
    return {
      tracking_key: pkg.tracking_key,
      tracking_number: pkg.tracking_number,
      expected_units: items.reduce((sum, item) => sum + item.expected_qty, 0),
      items,
    }
  })
}

async function ensureTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_balance (
      id SERIAL PRIMARY KEY,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(style, color, size)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      source_file TEXT,
      source_hash TEXT,
      applied_units INTEGER DEFAULT 0,
      row_count INTEGER,
      applied_by TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      rollback_snapshot_id INTEGER,
      rolled_back_at TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_hash TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS row_count INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rollback_snapshot_id INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ`
  await sql`ALTER TABLE inventory_balance ADD COLUMN IF NOT EXISTS sort_order INTEGER`
  await sql`DROP INDEX IF EXISTS inventory_transactions_source_hash_uq`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_active_source_hash_uq
    ON inventory_transactions (transaction_type, source_hash)
    WHERE source_hash IS NOT NULL AND source_hash <> '' AND rolled_back_at IS NULL
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_txn_rows (
      id BIGSERIAL PRIMARY KEY,
      txn_type TEXT NOT NULL,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      qty INTEGER NOT NULL,
      source_file TEXT,
      applied_by TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id SERIAL PRIMARY KEY,
      label TEXT,
      source_name TEXT,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_rows INTEGER DEFAULT 0,
      total_units INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_packages (
      id BIGSERIAL PRIMARY KEY,
      tracking_number TEXT NOT NULL,
      tracking_key TEXT UNIQUE NOT NULL,
      source_file TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expected_units INTEGER NOT NULL DEFAULT 0,
      actual_units INTEGER NOT NULL DEFAULT 0,
      remark TEXT,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_by TEXT,
      confirmed_at TIMESTAMPTZ
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_package_items (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT NOT NULL REFERENCES return_packages(id) ON DELETE CASCADE,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      expected_qty INTEGER NOT NULL,
      actual_qty INTEGER,
      UNIQUE(package_id, style, color, size)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS return_packages_status_idx ON return_packages (status, uploaded_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_confirmed_idx ON return_packages (confirmed_at DESC)`
}

async function loadPackage(sql, trackingKey) {
  const [pkg] = await sql`
    SELECT id, tracking_number, tracking_key, source_file, status, expected_units,
           actual_units, remark, uploaded_by, uploaded_at, confirmed_by, confirmed_at
    FROM return_packages
    WHERE tracking_key = ${trackingKey}
  `
  if (!pkg) return null
  const items = await sql`
    SELECT id, style, color, size, expected_qty, actual_qty
    FROM return_package_items
    WHERE package_id = ${pkg.id}
    ORDER BY style, color, size
  `
  return { ...pkg, items }
}

async function resolveInventoryRows(sql, rows) {
  if (!rows.length) return { rows: [], missing: [], ambiguous: [] }
  const resolutions = await sql`
    WITH targets AS (
      SELECT
        (target.ordinality - 1)::int AS target_index,
        target.value->>'style' AS style,
        target.value->>'color' AS color,
        target.value->>'size' AS size
      FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb)
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
     AND (
       CASE UPPER(BTRIM(inventory.size))
         WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
         ELSE UPPER(BTRIM(inventory.size))
       END
     ) = (
       CASE UPPER(BTRIM(target.size))
         WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
         ELSE UPPER(BTRIM(target.size))
       END
     )
    GROUP BY target.target_index
    ORDER BY target.target_index
  `
  return resolveInventoryTargets(rows, resolutions)
}

export default async function handler(req, res) {
  try {
    const payload = verifyToken(req.headers.authorization)
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    const sql = getDB()
    const action = String(req.query.action || '')
    await ensureTables(sql)

    if (req.method === 'POST' && action === 'import') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const packages = normalizePackages(req.body?.packages)
      const sourceFile = String(req.body?.sourceFile || '').trim()
      const trackingKeys = packages.map((pkg) => pkg.tracking_key)
      const finalPackages = await sql`
        WITH incoming AS (
          SELECT value #>> '{}' AS tracking_key
          FROM jsonb_array_elements(${JSON.stringify(trackingKeys)}::jsonb)
        )
        SELECT packages.tracking_key
        FROM return_packages packages
        JOIN incoming USING (tracking_key)
        WHERE packages.status <> 'pending'
      `
      const finalKeys = new Set(finalPackages.map((pkg) => pkg.tracking_key))
      const importable = packages.filter((pkg) => !finalKeys.has(pkg.tracking_key))

      if (importable.length) {
        const manifest = JSON.stringify(importable)
        await sql.transaction((txn) => [
          txn`
            WITH incoming AS (
              SELECT * FROM jsonb_to_recordset(${manifest}::jsonb)
                AS item(
                  tracking_key TEXT, tracking_number TEXT, expected_units INTEGER, items JSONB
                )
            )
            INSERT INTO return_packages (
              tracking_key, tracking_number, source_file, status, expected_units,
              actual_units, uploaded_by, uploaded_at, confirmed_by, confirmed_at, remark
            )
            SELECT
              tracking_key, tracking_number, ${sourceFile}, 'pending', expected_units,
              0, ${payload.username}, NOW(), NULL, NULL, NULL
            FROM incoming
            ON CONFLICT (tracking_key) DO UPDATE SET
              tracking_number = EXCLUDED.tracking_number,
              source_file = EXCLUDED.source_file,
              expected_units = EXCLUDED.expected_units,
              actual_units = 0,
              uploaded_by = EXCLUDED.uploaded_by,
              uploaded_at = NOW(),
              confirmed_by = NULL,
              confirmed_at = NULL,
              remark = NULL
            WHERE return_packages.status = 'pending'
          `,
          txn`
            WITH incoming AS (
              SELECT tracking_key
              FROM jsonb_to_recordset(${manifest}::jsonb)
                AS item(
                  tracking_key TEXT, tracking_number TEXT, expected_units INTEGER, items JSONB
                )
            )
            DELETE FROM return_package_items items
            USING return_packages packages, incoming
            WHERE items.package_id = packages.id
              AND packages.tracking_key = incoming.tracking_key
              AND packages.status = 'pending'
          `,
          txn`
            WITH incoming_packages AS (
              SELECT tracking_key, items
              FROM jsonb_to_recordset(${manifest}::jsonb)
                AS item(
                  tracking_key TEXT, tracking_number TEXT, expected_units INTEGER, items JSONB
                )
            ),
            incoming_items AS (
              SELECT
                packages.tracking_key,
                item.style,
                item.color,
                item.size,
                item.expected_qty
              FROM incoming_packages packages
              CROSS JOIN LATERAL jsonb_to_recordset(packages.items)
                AS item(style TEXT, color TEXT, size TEXT, expected_qty INTEGER)
            )
            INSERT INTO return_package_items (
              package_id, style, color, size, expected_qty, actual_qty
            )
            SELECT
              packages.id, items.style, items.color, items.size, items.expected_qty, NULL
            FROM incoming_items items
            JOIN return_packages packages ON packages.tracking_key = items.tracking_key
            WHERE packages.status = 'pending'
          `,
        ])
      }
      return res.json({
        ok: true,
        imported_packages: importable.length,
        imported_units: importable.reduce((sum, pkg) => sum + pkg.expected_units, 0),
        skipped_received: finalKeys.size,
      })
    }

    if (req.method === 'GET' && action === 'lookup') {
      const trackingKey = normalizeTracking(req.query.tracking)
      if (!trackingKey) return res.status(400).json({ error: 'tracking required' })
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      return res.json({ package: pkg })
    }

    if (req.method === 'GET' && action === 'list') {
      const status = String(req.query.status || '')
      const rows = status
        ? await sql`
            SELECT id, tracking_number, status, expected_units, actual_units,
                   uploaded_at, confirmed_at
            FROM return_packages
            WHERE status = ${status}
            ORDER BY uploaded_at DESC
            LIMIT 200
          `
        : await sql`
            SELECT id, tracking_number, status, expected_units, actual_units,
                   uploaded_at, confirmed_at
            FROM return_packages
            ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, uploaded_at DESC
            LIMIT 200
          `
      return res.json({ packages: rows })
    }

    if (req.method === 'POST' && action === 'confirm') {
      const trackingKey = normalizeTracking(req.body?.tracking)
      if (!trackingKey) return res.status(400).json({ error: 'tracking required' })
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      if (pkg.status !== 'pending') return res.status(409).json({ error: 'This return package has already been received' })

      const actualItems = Array.isArray(req.body?.items) ? req.body.items : []
      const actualById = new Map()
      for (const item of actualItems) {
        const id = Number(item.id)
        const actualQty = Number(item.actualQty)
        if (!Number.isSafeInteger(id) || !Number.isSafeInteger(actualQty) || actualQty < 0 || actualQty > 9999 || actualById.has(id)) {
          return res.status(400).json({ error: 'Every item requires one valid non-negative actual quantity' })
        }
        actualById.set(id, actualQty)
      }
      if (actualById.size !== pkg.items.length || pkg.items.some((item) => !actualById.has(Number(item.id)))) {
        return res.status(400).json({ error: 'Count every expected item before confirming the package' })
      }

      const inventoryRows = pkg.items
        .map((item) => ({
          style: item.style,
          color: item.color,
          size: item.size,
          qty: actualById.get(Number(item.id)),
          allowCreate: false,
        }))
        .filter((item) => item.qty > 0)
      const resolved = await resolveInventoryRows(sql, inventoryRows)
      if (resolved.ambiguous.length) {
        const item = resolved.ambiguous[0]
        return res.status(409).json({ error: `Multiple inventory rows match ${item.style} / ${item.color} / ${item.size}. Merge duplicate inventory rows first.` })
      }
      if (resolved.missing.length) {
        const item = resolved.missing[0]
        return res.status(409).json({ error: `Inventory target does not exist: ${item.style} / ${item.color} / ${item.size}` })
      }

      const receivedRows = resolved.rows
      const actualUnits = [...actualById.values()].reduce((sum, qty) => sum + qty, 0)
      const hasDiscrepancy = pkg.items.some((item) =>
        actualById.get(Number(item.id)) !== Number(item.expected_qty)
      )
      const finalStatus = hasDiscrepancy ? 'discrepancy' : 'received'
      const sourceName = `Return ${pkg.tracking_number}`
      const sourceHash = `return-package:${pkg.tracking_key}`
      const remark = String(req.body?.remark || '').trim().slice(0, 1000)

      await sql.transaction((txn) => [
        txn`
          WITH claimed AS (
            UPDATE return_packages
            SET status = 'processing'
            WHERE id = ${pkg.id} AND status = 'pending'
            RETURNING id
          )
          SELECT 1 / CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS claimed
          FROM claimed
        `,
        txn`
          WITH saved_snapshot AS (
            INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
            SELECT
              'return',
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
            applied_by, rollback_snapshot_id
          )
          SELECT
            'return', ${sourceName}, ${sourceHash}, ${actualUnits},
            ${receivedRows.length}, ${payload.username}, saved_snapshot.id
          FROM saved_snapshot
        `,
        ...receivedRows.flatMap((row) => [
          txn`
            UPDATE inventory_balance
            SET quantity = quantity + ${row.qty}, updated_at = NOW()
            WHERE style = ${row.style} AND color = ${row.color} AND size = ${row.size}
          `,
          txn`
            INSERT INTO inventory_txn_rows (
              txn_type, style, color, size, qty, source_file, applied_by
            )
            VALUES (
              'return', ${row.style}, ${row.color}, ${row.size}, ${row.qty},
              ${sourceName}, ${payload.username}
            )
          `,
        ]),
        ...pkg.items.map((item) => txn`
          UPDATE return_package_items
          SET actual_qty = ${actualById.get(Number(item.id))}
          WHERE id = ${item.id} AND package_id = ${pkg.id}
        `),
        txn`
          UPDATE return_packages
          SET status = ${finalStatus},
              actual_units = ${actualUnits},
              remark = ${remark},
              confirmed_by = ${payload.username},
              confirmed_at = NOW()
          WHERE id = ${pkg.id} AND status = 'processing'
        `,
        txn`
          DELETE FROM inventory_snapshots
          WHERE id NOT IN (
            SELECT id FROM inventory_snapshots ORDER BY created_at DESC LIMIT 20
          )
        `,
      ], { isolationLevel: 'Serializable' })

      return res.json({
        ok: true,
        status: finalStatus,
        expected_units: Number(pkg.expected_units),
        actual_units: actualUnits,
        added_units: actualUnits,
      })
    }

    if (req.method === 'GET' && action === 'analytics') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650)
      const from = new Date(Date.now() - days * 86400000).toISOString()
      const [summary] = await sql`
        SELECT
          COUNT(*)::int AS received_packages,
          COUNT(*) FILTER (WHERE status = 'discrepancy')::int AS discrepancy_packages,
          COALESCE(SUM(expected_units), 0)::int AS expected_units,
          COALESCE(SUM(actual_units), 0)::int AS returned_units
        FROM return_packages
        WHERE status IN ('received', 'discrepancy')
          AND confirmed_at >= ${from}
      `
      const rows = await sql`
        WITH sales AS (
          SELECT
            LOWER(BTRIM(style)) AS style_key,
            LOWER(BTRIM(color)) AS color_key,
            UPPER(BTRIM(size)) AS size_key,
            MIN(style) AS style,
            MIN(color) AS color,
            MIN(size) AS size,
            SUM(qty)::int AS sold_qty
          FROM inventory_txn_rows
          WHERE txn_type = 'sales'
            AND applied_at >= ${from}
            AND NOT EXISTS (
              SELECT 1
              FROM inventory_transactions transactions
              WHERE transactions.rolled_back_at IS NOT NULL
                AND transactions.transaction_type = inventory_txn_rows.txn_type
                AND transactions.source_file IS NOT DISTINCT FROM inventory_txn_rows.source_file
                AND transactions.applied_by IS NOT DISTINCT FROM inventory_txn_rows.applied_by
                AND transactions.applied_at = inventory_txn_rows.applied_at
            )
          GROUP BY 1, 2, 3
        ),
        returns AS (
          SELECT
            LOWER(BTRIM(items.style)) AS style_key,
            LOWER(BTRIM(items.color)) AS color_key,
            UPPER(BTRIM(items.size)) AS size_key,
            MIN(items.style) AS style,
            MIN(items.color) AS color,
            MIN(items.size) AS size,
            SUM(items.actual_qty)::int AS returned_qty
          FROM return_package_items items
          JOIN return_packages packages ON packages.id = items.package_id
          WHERE packages.status IN ('received', 'discrepancy')
            AND packages.confirmed_at >= ${from}
          GROUP BY 1, 2, 3
        ),
        keys AS (
          SELECT style_key, color_key, size_key FROM sales
          UNION
          SELECT style_key, color_key, size_key FROM returns
        )
        SELECT
          COALESCE(sales.style, returns.style) AS style,
          COALESCE(sales.color, returns.color) AS color,
          COALESCE(sales.size, returns.size) AS size,
          COALESCE(sales.sold_qty, 0)::int AS sold_qty,
          COALESCE(returns.returned_qty, 0)::int AS returned_qty,
          CASE
            WHEN COALESCE(sales.sold_qty, 0) > 0
            THEN ROUND(COALESCE(returns.returned_qty, 0)::numeric * 100 / sales.sold_qty, 2)
            ELSE NULL
          END AS return_rate
        FROM keys
        LEFT JOIN sales USING (style_key, color_key, size_key)
        LEFT JOIN returns USING (style_key, color_key, size_key)
        WHERE COALESCE(returns.returned_qty, 0) > 0
        ORDER BY returned_qty DESC, style, color, size
        LIMIT 500
      `
      return res.json({ days, summary, rows })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (error) {
    console.error('[/api/returns]', error.message)
    if (/division by zero|inventory_transactions_active_source_hash_uq/.test(error.message)) {
      return res.status(409).json({ error: 'This return package was already received. Inventory was not changed.' })
    }
    return res.status(500).json({ error: error.message })
  }
}
