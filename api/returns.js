import { neon } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'

const { resolveInventoryTargets } = inventoryTargetResolution
const MAX_PACKAGES_PER_IMPORT = 5000
const MAX_ITEMS_PER_IMPORT = 50000
const MAX_CATALOG_ROWS_PER_IMPORT = 20000
const MAX_ORDERS_PER_IMPORT = 1000
const MAX_ORDER_ITEMS_PER_IMPORT = 5000
const MAX_ORDER_LOOKUPS = 1000

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

function normalizeStore(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 100)
  if (!name) throw new Error('Store name is required')
  return { name, key: name.toLowerCase() }
}

function normalizeOrderNumber(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/-D\d+$/, '')
}

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\t/g, '').trim().slice(0, maxLength)
}

function cleanTextArray(value, maxLength = 200) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))]
}

function cleanDate(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid order date: ${text}`)
  return new Date(parsed).toISOString()
}

function normalizeOrderItems(rawOrders, store) {
  if (!Array.isArray(rawOrders) || !rawOrders.length) throw new Error('orders array required')
  if (rawOrders.length > MAX_ORDERS_PER_IMPORT) {
    throw new Error(`Import is limited to ${MAX_ORDERS_PER_IMPORT} orders per batch`)
  }

  let itemCount = 0
  const orders = []
  const seenOrders = new Set()
  for (const rawOrder of rawOrders) {
    const orderNumber = cleanText(rawOrder.orderNumber || rawOrder.order_number, 100)
    const orderKey = normalizeOrderNumber(orderNumber)
    if (!orderKey || seenOrders.has(orderKey)) {
      throw new Error(`Invalid or duplicate order number: ${orderNumber || '(blank)'}`)
    }
    seenOrders.add(orderKey)
    if (!Array.isArray(rawOrder.items) || !rawOrder.items.length) {
      throw new Error(`Order ${orderNumber} has no items`)
    }

    const items = []
    const seenItems = new Set()
    for (const rawItem of rawOrder.items) {
      itemCount += 1
      if (itemCount > MAX_ORDER_ITEMS_PER_IMPORT) {
        throw new Error(`Import is limited to ${MAX_ORDER_ITEMS_PER_IMPORT} order items per batch`)
      }
      const skuCode = cleanText(rawItem.skuCode || rawItem.sku_code, 300)
      const attributes = cleanText(rawItem.attributes, 500)
      const baseItemKey = [skuCode, attributes].map((value) => value.toLowerCase()).join('\u241f')
      const requestedItemKey = cleanText(rawItem.itemKey || rawItem.item_key, 1000)
      const itemKey = requestedItemKey === baseItemKey
        || requestedItemKey.startsWith(`${baseItemKey}\u241fsku:`)
        ? requestedItemKey
        : baseItemKey
      const quantity = Number(rawItem.quantity)
      if (!skuCode || !attributes || seenItems.has(itemKey)
        || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 9999) {
        throw new Error(`Invalid or duplicate item in order ${orderNumber}`)
      }
      seenItems.add(itemKey)
      items.push({
        store_key: store.key,
        order_key: orderKey,
        item_key: itemKey,
        sku_id: cleanText(rawItem.skuId || rawItem.sku_id, 100),
        skc_id: cleanText(rawItem.skcId || rawItem.skc_id, 100),
        spu_id: cleanText(rawItem.spuId || rawItem.spu_id, 100),
        sku_code: skuCode,
        product_name: cleanText(rawItem.productName || rawItem.product_name, 1000),
        attributes,
        quantity,
        outbound_trackings: cleanTextArray(rawItem.outboundTrackings || rawItem.outbound_trackings),
        package_numbers: cleanTextArray(rawItem.packageNumbers || rawItem.package_numbers),
        carriers: cleanTextArray(rawItem.carriers),
        warehouses: cleanTextArray(rawItem.warehouses),
      })
    }

    orders.push({
      store_name: store.name,
      store_key: store.key,
      order_number: orderNumber,
      order_key: orderKey,
      site: cleanText(rawOrder.site, 100),
      status: cleanText(rawOrder.status, 100),
      order_created_at: cleanDate(rawOrder.orderCreatedAt || rawOrder.order_created_at),
      order_confirmed_at: cleanDate(rawOrder.orderConfirmedAt || rawOrder.order_confirmed_at),
      shipped_at: cleanDate(rawOrder.shippedAt || rawOrder.shipped_at),
      delivered_at: cleanDate(rawOrder.deliveredAt || rawOrder.delivered_at),
      items,
    })
  }
  return orders
}

function itemIdentity(item) {
  return [item.sku_id, item.style, item.color, item.size]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('\u0000')
}

function normalizePackages(rawPackages, store) {
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
      store_name: store.name,
      store_key: store.key,
      order_numbers: new Set(),
      return_reasons: new Set(),
      buyer_remarks: new Set(),
      carrier: String(rawPackage.carrier || '').trim(),
      items: new Map(),
    }
    for (const value of rawPackage.orders || []) if (String(value || '').trim()) pkg.order_numbers.add(String(value).trim())
    for (const value of rawPackage.reasons || []) if (String(value || '').trim()) pkg.return_reasons.add(String(value).trim())
    for (const value of rawPackage.buyerRemarks || []) if (String(value || '').trim()) pkg.buyer_remarks.add(String(value).trim())
    for (const rawItem of rawPackage.items) {
      itemCount += 1
      if (itemCount > MAX_ITEMS_PER_IMPORT) throw new Error(`Import is limited to ${MAX_ITEMS_PER_IMPORT} item rows`)
      const item = {
        sku_id: String(rawItem.skuId || rawItem.sku_id || '').trim(),
        sku_code: String(rawItem.skuCode || rawItem.sku_code || '').trim(),
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
      store_name: pkg.store_name,
      store_key: pkg.store_key,
      order_numbers: [...pkg.order_numbers],
      return_reasons: [...pkg.return_reasons],
      buyer_remarks: [...pkg.buyer_remarks],
      carrier: pkg.carrier,
      expected_units: items.reduce((sum, item) => sum + item.expected_qty, 0),
      items,
    }
  })
}

function normalizeCatalogRows(rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw new Error('Product rows are required')
  if (rawRows.length > MAX_CATALOG_ROWS_PER_IMPORT) {
    throw new Error(`Product import is limited to ${MAX_CATALOG_ROWS_PER_IMPORT} rows`)
  }
  const seen = new Set()
  return rawRows.map((rawRow) => {
    const skuId = String(rawRow.skuId || rawRow.sku_id || '').trim()
    const skuCode = String(rawRow.skuCode || rawRow.sku_code || '').trim()
    const status = rawRow.status === 'ready' ? 'ready' : 'review'
    const issue = String(rawRow.issue || '').trim().slice(0, 200)
    if (!skuId || !skuCode || seen.has(skuId)) throw new Error(`Invalid or duplicate SKU ID: ${skuId || '(blank)'}`)
    seen.add(skuId)
    const components = Array.isArray(rawRow.components) ? rawRow.components.map((component) => ({
      style: String(component.style || '').trim(),
      color: String(component.color || '').trim(),
      size: String(component.size || '').trim(),
      qty: Number(component.qty || 1),
    })) : []
    if (status === 'ready' && (!components.length || components.some((component) =>
      !component.style || !component.color || !component.size
      || !Number.isSafeInteger(component.qty) || component.qty <= 0
    ))) throw new Error(`Resolved SKU ${skuId} has invalid physical components`)
    return { sku_id: skuId, sku_code: skuCode, status, issue, components }
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
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS order_numbers JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS return_reasons JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS buyer_remarks JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS carrier TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS restock_units INTEGER NOT NULL DEFAULT 0`
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
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS sku_id TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS sku_code TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS restock_qty INTEGER`
  await sql`ALTER TABLE return_package_items DROP CONSTRAINT IF EXISTS return_package_items_package_id_style_color_size_key`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS return_package_items_source_sku_uq
    ON return_package_items (package_id, sku_id, style, color, size)
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_product_catalog (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      sku_code TEXT NOT NULL,
      components JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'review',
      issue TEXT,
      source_file TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_key, sku_id)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_orders (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      order_number TEXT NOT NULL,
      order_key TEXT NOT NULL,
      site TEXT,
      status TEXT,
      order_created_at TIMESTAMPTZ,
      order_confirmed_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      source_file TEXT,
      source_hash TEXT,
      imported_by TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_key, order_key)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES return_orders(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      sku_id TEXT NOT NULL DEFAULT '',
      skc_id TEXT NOT NULL DEFAULT '',
      spu_id TEXT NOT NULL DEFAULT '',
      sku_code TEXT NOT NULL,
      product_name TEXT,
      attributes TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      outbound_trackings JSONB NOT NULL DEFAULT '[]'::jsonb,
      package_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      carriers JSONB NOT NULL DEFAULT '[]'::jsonb,
      warehouses JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_file TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(order_id, item_key)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_order_imports (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      source_file TEXT,
      source_hash TEXT,
      batch_index INTEGER,
      order_count INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      imported_by TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS return_packages_status_idx ON return_packages (status, uploaded_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_confirmed_idx ON return_packages (confirmed_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_store_idx ON return_packages (store_key, uploaded_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_orders_number_idx ON return_orders (order_key)`
  await sql`CREATE INDEX IF NOT EXISTS return_orders_store_created_idx ON return_orders (store_key, order_created_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_order_items_sku_id_idx ON return_order_items (sku_id)`
}

async function loadPackage(sql, trackingKey) {
  const [pkg] = await sql`
    SELECT id, tracking_number, tracking_key, source_file, status, store_name, store_key,
           order_numbers, return_reasons, buyer_remarks, carrier, expected_units,
           actual_units, restock_units, remark, uploaded_by, uploaded_at, confirmed_by, confirmed_at
    FROM return_packages
    WHERE tracking_key = ${trackingKey}
  `
  if (!pkg) return null
  const items = await sql`
    SELECT id, sku_id, sku_code, style, color, size, expected_qty, actual_qty, restock_qty
    FROM return_package_items
    WHERE package_id = ${pkg.id}
    ORDER BY style, color, size
  `
  const relatedOrders = await loadOrdersByKeys(
    sql,
    pkg.store_key,
    Array.isArray(pkg.order_numbers) ? pkg.order_numbers : [],
  )
  return { ...pkg, items, related_orders: relatedOrders }
}

async function loadOrdersByKeys(sql, storeKey, orderNumbers) {
  const orderKeys = [...new Set(
    (orderNumbers || []).map(normalizeOrderNumber).filter(Boolean),
  )]
  if (!orderKeys.length) return []
  const orders = await sql`
    WITH wanted AS (
      SELECT value #>> '{}' AS order_key
      FROM jsonb_array_elements(${JSON.stringify(orderKeys)}::jsonb)
    )
    SELECT
      orders.id, orders.store_name, orders.store_key, orders.order_number, orders.order_key,
      orders.site, orders.status, orders.order_created_at, orders.order_confirmed_at,
      orders.shipped_at, orders.delivered_at, orders.source_file, orders.updated_at
    FROM return_orders orders
    JOIN wanted ON wanted.order_key = orders.order_key
    WHERE (${storeKey || ''} = '' OR orders.store_key = ${storeKey || ''})
    ORDER BY orders.order_created_at DESC NULLS LAST, orders.order_number
  `
  if (!orders.length) return []
  const orderIds = orders.map((order) => String(order.id))
  const items = await sql`
    WITH wanted AS (
      SELECT (value #>> '{}')::bigint AS order_id
      FROM jsonb_array_elements(${JSON.stringify(orderIds)}::jsonb)
    )
    SELECT
      items.id, items.order_id, items.sku_id, items.skc_id, items.spu_id,
      items.sku_code, items.product_name, items.attributes, items.quantity,
      items.outbound_trackings, items.package_numbers, items.carriers, items.warehouses,
      catalog.components AS catalog_components,
      catalog.status AS catalog_status
    FROM return_order_items items
    JOIN wanted ON wanted.order_id = items.order_id
    JOIN return_orders orders ON orders.id = items.order_id
    LEFT JOIN return_product_catalog catalog
      ON catalog.store_key = orders.store_key
     AND catalog.sku_id = items.sku_id
    ORDER BY items.order_id, items.sku_code, items.attributes
  `
  const itemsByOrder = new Map()
  for (const item of items) {
    const key = String(item.order_id)
    if (!itemsByOrder.has(key)) itemsByOrder.set(key, [])
    itemsByOrder.get(key).push(item)
  }
  return orders.map((order) => ({
    ...order,
    items: itemsByOrder.get(String(order.id)) || [],
  }))
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

    if (req.method === 'POST' && action === 'catalog-import') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const rows = normalizeCatalogRows(req.body?.rows)
      const sourceFile = String(req.body?.sourceFile || '').trim()
      const data = JSON.stringify(rows)
      await sql`
        WITH incoming AS (
          SELECT *
          FROM jsonb_to_recordset(${data}::jsonb)
            AS item(
              sku_id TEXT, sku_code TEXT, status TEXT, issue TEXT, components JSONB
            )
        )
        INSERT INTO return_product_catalog (
          store_name, store_key, sku_id, sku_code, components, status, issue,
          source_file, updated_by, updated_at
        )
        SELECT
          ${store.name}, ${store.key}, sku_id, sku_code, components, status, issue,
          ${sourceFile}, ${payload.username}, NOW()
        FROM incoming
        ON CONFLICT (store_key, sku_id) DO UPDATE SET
          store_name = EXCLUDED.store_name,
          sku_code = EXCLUDED.sku_code,
          components = EXCLUDED.components,
          status = EXCLUDED.status,
          issue = EXCLUDED.issue,
          source_file = EXCLUDED.source_file,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `
      return res.json({
        ok: true,
        store_name: store.name,
        imported_rows: rows.length,
        ready_rows: rows.filter((row) => row.status === 'ready').length,
        review_rows: rows.filter((row) => row.status !== 'ready').length,
      })
    }

    if (req.method === 'GET' && action === 'catalog') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.query.store)
      const rows = await sql`
        SELECT sku_id, sku_code, components, status, issue, source_file, updated_at
        FROM return_product_catalog
        WHERE store_key = ${store.key}
        ORDER BY sku_id
      `
      return res.json({ store_name: store.name, rows })
    }

    if (req.method === 'GET' && action === 'stores') {
      const rows = await sql`
        WITH product_counts AS (
          SELECT
            store_key,
            MIN(store_name) AS store_name,
            COUNT(*)::int AS product_count,
            COUNT(*) FILTER (WHERE status = 'ready')::int AS ready_count,
            MAX(updated_at) AS updated_at
          FROM return_product_catalog
          GROUP BY store_key
        ),
        order_counts AS (
          SELECT
            store_key,
            MIN(store_name) AS store_name,
            COUNT(*)::int AS order_count,
            MAX(updated_at) AS updated_at
          FROM return_orders
          GROUP BY store_key
        ),
        keys AS (
          SELECT store_key FROM product_counts
          UNION
          SELECT store_key FROM order_counts
        )
        SELECT
          keys.store_key,
          COALESCE(products.store_name, orders.store_name) AS store_name,
          COALESCE(products.product_count, 0)::int AS product_count,
          COALESCE(products.ready_count, 0)::int AS ready_count,
          COALESCE(orders.order_count, 0)::int AS order_count,
          GREATEST(products.updated_at, orders.updated_at) AS updated_at
        FROM keys
        LEFT JOIN product_counts products USING (store_key)
        LEFT JOIN order_counts orders USING (store_key)
        ORDER BY store_name
      `
      return res.json({ stores: rows })
    }

    if (req.method === 'POST' && action === 'orders-import') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const orders = normalizeOrderItems(req.body?.orders, store)
      const sourceFile = cleanText(req.body?.sourceFile, 300)
      const sourceHash = cleanText(req.body?.sourceHash, 100)
      const batchIndex = Number(req.body?.batchIndex)
      const flatItems = orders.flatMap((order) => order.items)
      const orderData = JSON.stringify(orders.map(({ items, ...order }) => order))
      const itemData = JSON.stringify(flatItems)

      const existingOrders = await sql`
        WITH incoming AS (
          SELECT order_key
          FROM jsonb_to_recordset(${orderData}::jsonb)
            AS item(order_key TEXT)
        )
        SELECT orders.order_key
        FROM return_orders orders
        JOIN incoming USING (order_key)
        WHERE orders.store_key = ${store.key}
      `
      const existingOrderKeys = new Set(existingOrders.map((order) => order.order_key))

      const existingItems = flatItems.length ? await sql`
        WITH incoming AS (
          SELECT *
          FROM jsonb_to_recordset(${itemData}::jsonb)
            AS item(
              store_key TEXT, order_key TEXT, item_key TEXT, sku_id TEXT, skc_id TEXT,
              spu_id TEXT, sku_code TEXT, product_name TEXT, attributes TEXT, quantity INTEGER,
              outbound_trackings JSONB, package_numbers JSONB, carriers JSONB, warehouses JSONB
            )
        )
        SELECT
          incoming.order_key, incoming.item_key,
          incoming.sku_id AS incoming_sku_id,
          incoming.skc_id AS incoming_skc_id,
          incoming.spu_id AS incoming_spu_id,
          incoming.quantity AS incoming_quantity,
          items.sku_id AS existing_sku_id,
          items.skc_id AS existing_skc_id,
          items.spu_id AS existing_spu_id,
          items.quantity AS existing_quantity
        FROM incoming
        JOIN return_orders orders
          ON orders.store_key = incoming.store_key
         AND orders.order_key = incoming.order_key
        JOIN return_order_items items
          ON items.order_id = orders.id
         AND items.item_key = incoming.item_key
      ` : []

      const existingItemKeys = new Set()
      const conflictKeys = new Set()
      const conflicts = []
      for (const item of existingItems) {
        const key = `${item.order_key}\u241f${item.item_key}`
        existingItemKeys.add(key)
        const issues = []
        if (Number(item.existing_quantity) !== Number(item.incoming_quantity)) issues.push('quantity_changed')
        for (const [label, existingValue, incomingValue] of [
          ['sku_id_changed', item.existing_sku_id, item.incoming_sku_id],
          ['skc_id_changed', item.existing_skc_id, item.incoming_skc_id],
          ['spu_id_changed', item.existing_spu_id, item.incoming_spu_id],
        ]) {
          if (existingValue && incomingValue && existingValue !== incomingValue) issues.push(label)
        }
        if (issues.length) {
          conflictKeys.add(key)
          conflicts.push({
            order_number: item.order_key,
            item_key: item.item_key,
            issues,
            existing_quantity: Number(item.existing_quantity),
            incoming_quantity: Number(item.incoming_quantity),
          })
        }
      }
      const importableItems = flatItems.filter((item) =>
        !conflictKeys.has(`${item.order_key}\u241f${item.item_key}`)
      )
      const importableItemData = JSON.stringify(importableItems)

      await sql.transaction((txn) => [
        txn`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${orderData}::jsonb)
              AS item(
                store_name TEXT, store_key TEXT, order_number TEXT, order_key TEXT,
                site TEXT, status TEXT, order_created_at TIMESTAMPTZ,
                order_confirmed_at TIMESTAMPTZ, shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ
              )
          )
          INSERT INTO return_orders (
            store_name, store_key, order_number, order_key, site, status,
            order_created_at, order_confirmed_at, shipped_at, delivered_at,
            source_file, source_hash, imported_by, imported_at, updated_at
          )
          SELECT
            store_name, store_key, order_number, order_key, site, status,
            order_created_at, order_confirmed_at, shipped_at, delivered_at,
            ${sourceFile}, ${sourceHash}, ${payload.username}, NOW(), NOW()
          FROM incoming
          ON CONFLICT (store_key, order_key) DO UPDATE SET
            store_name = EXCLUDED.store_name,
            order_number = EXCLUDED.order_number,
            site = COALESCE(NULLIF(EXCLUDED.site, ''), return_orders.site),
            status = COALESCE(NULLIF(EXCLUDED.status, ''), return_orders.status),
            order_created_at = COALESCE(EXCLUDED.order_created_at, return_orders.order_created_at),
            order_confirmed_at = COALESCE(EXCLUDED.order_confirmed_at, return_orders.order_confirmed_at),
            shipped_at = COALESCE(EXCLUDED.shipped_at, return_orders.shipped_at),
            delivered_at = COALESCE(EXCLUDED.delivered_at, return_orders.delivered_at),
            source_file = EXCLUDED.source_file,
            source_hash = COALESCE(NULLIF(EXCLUDED.source_hash, ''), return_orders.source_hash),
            imported_by = EXCLUDED.imported_by,
            updated_at = NOW()
        `,
        ...(importableItems.length ? [txn`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${importableItemData}::jsonb)
              AS item(
                store_key TEXT, order_key TEXT, item_key TEXT, sku_id TEXT, skc_id TEXT,
                spu_id TEXT, sku_code TEXT, product_name TEXT, attributes TEXT, quantity INTEGER,
                outbound_trackings JSONB, package_numbers JSONB, carriers JSONB, warehouses JSONB
              )
          )
          INSERT INTO return_order_items (
            order_id, item_key, sku_id, skc_id, spu_id, sku_code, product_name,
            attributes, quantity, outbound_trackings, package_numbers, carriers,
            warehouses, source_file, updated_at
          )
          SELECT
            orders.id, incoming.item_key, incoming.sku_id, incoming.skc_id,
            incoming.spu_id, incoming.sku_code, incoming.product_name,
            incoming.attributes, incoming.quantity, incoming.outbound_trackings,
            incoming.package_numbers, incoming.carriers, incoming.warehouses,
            ${sourceFile}, NOW()
          FROM incoming
          JOIN return_orders orders
            ON orders.store_key = incoming.store_key
           AND orders.order_key = incoming.order_key
          ON CONFLICT (order_id, item_key) DO UPDATE SET
            sku_id = COALESCE(NULLIF(return_order_items.sku_id, ''), EXCLUDED.sku_id),
            skc_id = COALESCE(NULLIF(return_order_items.skc_id, ''), EXCLUDED.skc_id),
            spu_id = COALESCE(NULLIF(return_order_items.spu_id, ''), EXCLUDED.spu_id),
            product_name = COALESCE(NULLIF(return_order_items.product_name, ''), EXCLUDED.product_name),
            outbound_trackings = (
              SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
              FROM (
                SELECT DISTINCT value
                FROM jsonb_array_elements_text(
                  return_order_items.outbound_trackings || EXCLUDED.outbound_trackings
                ) AS entry(value)
              ) merged
            ),
            package_numbers = (
              SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
              FROM (
                SELECT DISTINCT value
                FROM jsonb_array_elements_text(
                  return_order_items.package_numbers || EXCLUDED.package_numbers
                ) AS entry(value)
              ) merged
            ),
            carriers = (
              SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
              FROM (
                SELECT DISTINCT value
                FROM jsonb_array_elements_text(return_order_items.carriers || EXCLUDED.carriers)
                  AS entry(value)
              ) merged
            ),
            warehouses = (
              SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
              FROM (
                SELECT DISTINCT value
                FROM jsonb_array_elements_text(return_order_items.warehouses || EXCLUDED.warehouses)
                  AS entry(value)
              ) merged
            ),
            source_file = EXCLUDED.source_file,
            updated_at = NOW()
        `] : []),
        txn`
          INSERT INTO return_order_imports (
            store_name, store_key, source_file, source_hash, batch_index,
            order_count, item_count, conflict_count, imported_by
          )
          VALUES (
            ${store.name}, ${store.key}, ${sourceFile}, ${sourceHash},
            ${Number.isSafeInteger(batchIndex) ? batchIndex : null},
            ${orders.length}, ${flatItems.length}, ${conflicts.length}, ${payload.username}
          )
        `,
      ])

      return res.json({
        ok: true,
        store_name: store.name,
        orders_received: orders.length,
        new_orders: orders.filter((order) => !existingOrderKeys.has(order.order_key)).length,
        existing_orders: orders.filter((order) => existingOrderKeys.has(order.order_key)).length,
        new_items: flatItems.filter((item) =>
          !existingItemKeys.has(`${item.order_key}\u241f${item.item_key}`)
        ).length,
        existing_items: existingItems.length,
        conflicts,
      })
    }

    if (req.method === 'GET' && action === 'order-lookup') {
      const orderNumber = cleanText(req.query.order, 100)
      const orderKey = normalizeOrderNumber(orderNumber)
      if (!orderKey) return res.status(400).json({ error: 'order required' })
      const storeValue = String(req.query.store || '').trim()
      const storeKey = storeValue ? normalizeStore(storeValue).key : ''
      const orders = await loadOrdersByKeys(sql, storeKey, [orderNumber])
      if (!orders.length) return res.status(404).json({ error: 'Order is not in the uploaded history' })
      if (!storeKey && new Set(orders.map((order) => order.store_key)).size > 1) {
        return res.status(409).json({
          error: 'This order number exists in more than one store. Choose a store.',
          stores: [...new Set(orders.map((order) => order.store_name))],
        })
      }
      return res.json({ order: orders[0], matches: orders.length })
    }

    if (req.method === 'POST' && action === 'orders-lookup') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const orderNumbers = Array.isArray(req.body?.orderNumbers)
        ? [...new Set(req.body.orderNumbers.map((value) => cleanText(value, 100)).filter(Boolean))]
        : []
      if (!orderNumbers.length) return res.status(400).json({ error: 'orderNumbers array required' })
      if (orderNumbers.length > MAX_ORDER_LOOKUPS) {
        return res.status(400).json({ error: `Lookup is limited to ${MAX_ORDER_LOOKUPS} orders per batch` })
      }
      const orders = await loadOrdersByKeys(sql, store.key, orderNumbers)
      return res.json({ orders })
    }

    if (req.method === 'GET' && action === 'order-stats') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const rows = await sql`
        SELECT
          orders.store_key,
          MIN(orders.store_name) AS store_name,
          COUNT(DISTINCT orders.id)::int AS order_count,
          COUNT(items.id)::int AS item_count,
          COALESCE(SUM(items.quantity), 0)::int AS unit_count,
          MIN(orders.order_created_at) AS earliest_order,
          MAX(orders.order_created_at) AS latest_order,
          MAX(orders.updated_at) AS updated_at
        FROM return_orders orders
        LEFT JOIN return_order_items items ON items.order_id = orders.id
        GROUP BY orders.store_key
        ORDER BY store_name
      `
      return res.json({ stores: rows })
    }

    if (req.method === 'POST' && action === 'import') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const packages = normalizePackages(req.body?.packages, store)
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
                  tracking_key TEXT, tracking_number TEXT, store_name TEXT, store_key TEXT,
                  order_numbers JSONB, return_reasons JSONB, buyer_remarks JSONB, carrier TEXT,
                  expected_units INTEGER, items JSONB
                )
            )
            INSERT INTO return_packages (
              tracking_key, tracking_number, store_name, store_key, order_numbers,
              return_reasons, buyer_remarks, carrier, source_file, status, expected_units,
              actual_units, restock_units, uploaded_by, uploaded_at, confirmed_by, confirmed_at, remark
            )
            SELECT
              tracking_key, tracking_number, store_name, store_key, order_numbers,
              return_reasons, buyer_remarks, carrier, ${sourceFile}, 'pending', expected_units,
              0, 0, ${payload.username}, NOW(), NULL, NULL, NULL
            FROM incoming
            ON CONFLICT (tracking_key) DO UPDATE SET
              tracking_number = EXCLUDED.tracking_number,
              store_name = EXCLUDED.store_name,
              store_key = EXCLUDED.store_key,
              order_numbers = EXCLUDED.order_numbers,
              return_reasons = EXCLUDED.return_reasons,
              buyer_remarks = EXCLUDED.buyer_remarks,
              carrier = EXCLUDED.carrier,
              source_file = EXCLUDED.source_file,
              expected_units = EXCLUDED.expected_units,
              actual_units = 0,
              restock_units = 0,
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
                item.sku_id,
                item.sku_code,
                item.style,
                item.color,
                item.size,
                item.expected_qty
              FROM incoming_packages packages
              CROSS JOIN LATERAL jsonb_to_recordset(packages.items)
                AS item(
                  sku_id TEXT, sku_code TEXT, style TEXT, color TEXT, size TEXT, expected_qty INTEGER
                )
            )
            INSERT INTO return_package_items (
              package_id, sku_id, sku_code, style, color, size, expected_qty, actual_qty, restock_qty
            )
            SELECT
              packages.id, items.sku_id, items.sku_code, items.style, items.color,
              items.size, items.expected_qty, NULL, NULL
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
            SELECT id, tracking_number, store_name, status, expected_units, actual_units, restock_units,
                   uploaded_at, confirmed_at
            FROM return_packages
            WHERE status = ${status}
            ORDER BY uploaded_at DESC
            LIMIT 200
          `
        : await sql`
            SELECT id, tracking_number, store_name, status, expected_units, actual_units, restock_units,
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
      const countsById = new Map()
      for (const item of actualItems) {
        const id = Number(item.id)
        const actualQty = Number(item.actualQty)
        const restockQty = Number(item.restockQty)
        if (
          !Number.isSafeInteger(id)
          || !Number.isSafeInteger(actualQty)
          || !Number.isSafeInteger(restockQty)
          || actualQty < 0
          || actualQty > 9999
          || restockQty < 0
          || restockQty > actualQty
          || countsById.has(id)
        ) {
          return res.status(400).json({
            error: 'Every item requires valid received and restockable quantities; restockable cannot exceed received',
          })
        }
        countsById.set(id, { actualQty, restockQty })
      }
      if (countsById.size !== pkg.items.length || pkg.items.some((item) => !countsById.has(Number(item.id)))) {
        return res.status(400).json({ error: 'Count every expected item before confirming the package' })
      }

      const inventoryRows = pkg.items
        .map((item) => ({
          style: item.style,
          color: item.color,
          size: item.size,
          qty: countsById.get(Number(item.id)).restockQty,
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
      const actualUnits = [...countsById.values()].reduce((sum, counts) => sum + counts.actualQty, 0)
      const restockUnits = [...countsById.values()].reduce((sum, counts) => sum + counts.restockQty, 0)
      const hasDiscrepancy = pkg.items.some((item) =>
        countsById.get(Number(item.id)).actualQty !== Number(item.expected_qty)
        || countsById.get(Number(item.id)).restockQty !== countsById.get(Number(item.id)).actualQty
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
            'return', ${sourceName}, ${sourceHash}, ${restockUnits},
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
          SET actual_qty = ${countsById.get(Number(item.id)).actualQty},
              restock_qty = ${countsById.get(Number(item.id)).restockQty}
          WHERE id = ${item.id} AND package_id = ${pkg.id}
        `),
        txn`
          UPDATE return_packages
          SET status = ${finalStatus},
              actual_units = ${actualUnits},
              restock_units = ${restockUnits},
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
        restock_units: restockUnits,
        added_units: restockUnits,
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
          COALESCE(SUM(actual_units), 0)::int AS returned_units,
          COALESCE(SUM(restock_units), 0)::int AS restocked_units
        FROM return_packages
        WHERE status IN ('received', 'discrepancy')
          AND confirmed_at >= ${from}
      `
      const [salesSummary] = await sql`
        SELECT COALESCE(SUM(rows.qty), 0)::int AS sold_units
        FROM inventory_txn_rows rows
        WHERE rows.txn_type = 'sales'
          AND rows.applied_at >= ${from}
          AND NOT EXISTS (
            SELECT 1
            FROM inventory_transactions transactions
            WHERE transactions.rolled_back_at IS NOT NULL
              AND transactions.transaction_type = rows.txn_type
              AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
              AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
              AND transactions.applied_at = rows.applied_at
          )
      `
      summary.sold_units = Number(salesSummary?.sold_units || 0)
      summary.total_return_rate = summary.sold_units > 0
        ? Number(summary.returned_units || 0) * 100 / summary.sold_units
        : null
      const stores = await sql`
        SELECT
          COALESCE(NULLIF(store_name, ''), 'Unassigned') AS store_name,
          COUNT(*)::int AS received_packages,
          COUNT(*) FILTER (WHERE status = 'discrepancy')::int AS discrepancy_packages,
          COALESCE(SUM(expected_units), 0)::int AS expected_units,
          COALESCE(SUM(actual_units), 0)::int AS returned_units,
          COALESCE(SUM(restock_units), 0)::int AS restocked_units
        FROM return_packages
        WHERE status IN ('received', 'discrepancy')
          AND confirmed_at >= ${from}
        GROUP BY COALESCE(NULLIF(store_name, ''), 'Unassigned')
        ORDER BY returned_units DESC, store_name
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
      return res.json({ days, summary, stores, rows })
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
