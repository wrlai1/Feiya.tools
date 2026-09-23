import { neon } from '@neondatabase/serverless'
import authentication from '../lib/authentication.cjs'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'
import returnPackageSafety from '../lib/returnPackageSafety.cjs'
import { summarizeReturnInspection } from '../src/utils/returnInspection.js'
import {
  limitReturnPackageQuantities,
  remainingOrderItemQuantities,
} from '../src/utils/returnOrderQuantity.js'
import { identifyTrackingNumber, normalizeTracking } from '../src/utils/trackingIdentifier.js'
import { respondWithReturnAnalytics } from '../lib/returnAnalyticsCache.js'

const { resolveInventoryTargets } = inventoryTargetResolution
const { authenticateUser } = authentication
const {
  canResolveReturnItems,
  itemIdentity,
  mergeInventoryComponents,
  mergeReturnPackageItems,
  replaceSelectedReturnPackageItems,
} = returnPackageSafety
const MAX_PACKAGES_PER_IMPORT = 5000
const MAX_ITEMS_PER_IMPORT = 50000
const MAX_CATALOG_ROWS_PER_IMPORT = 20000
const MAX_CATALOG_LOOKUPS = 1000
const MAX_ORDERS_PER_IMPORT = 1000
const MAX_ORDER_ITEMS_PER_IMPORT = 5000
const MAX_ORDER_LOOKUPS = 1000
const COMBINED_ORDER_STORE_KEY = 'all stores'

function getDB() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  return neon(url)
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

function normalizeReviewData(rawData) {
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? rawData
    : {}
  const unresolved = new Map()
  for (const rawItem of Array.isArray(data.unresolvedSkus) ? data.unresolvedSkus : []) {
    const skuId = cleanText(rawItem.skuId || rawItem.sku_id, 100)
    const skuCode = cleanText(rawItem.skuCode || rawItem.sku_code, 300)
    const quantity = Number(rawItem.quantity)
    const issue = cleanText(rawItem.issue || 'sku_mapping_needs_review', 200)
    if (!skuId || !skuCode || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 9999) {
      throw new Error('Invalid unresolved SKU review data')
    }
    const existing = unresolved.get(skuId)
    if (existing && existing.skuCode !== skuCode) {
      throw new Error(`SKU ID ${skuId} has conflicting SKU codes`)
    }
    if (existing) {
      existing.quantity += quantity
      if (existing.quantity > 9999) throw new Error(`SKU ID ${skuId} quantity is too large`)
    } else {
      unresolved.set(skuId, { skuId, skuCode, quantity, issue })
    }
  }
  const rawInspection = data.workerInspection || data.worker_inspection
  let workerInspection = null
  if (rawInspection && typeof rawInspection === 'object' && !Array.isArray(rawInspection)) {
    const status = rawInspection.status === 'all_good' ? 'all_good' : ''
    const productUnits = Number(rawInspection.productUnits ?? rawInspection.product_units)
    const checkedBy = cleanText(rawInspection.checkedBy || rawInspection.checked_by, 100)
    const checkedAt = cleanText(rawInspection.checkedAt || rawInspection.checked_at, 100)
    if (
      status
      && Number.isSafeInteger(productUnits)
      && productUnits >= 0
      && productUnits <= 9999
      && checkedBy
      && checkedAt
    ) {
      workerInspection = { status, productUnits, checkedBy, checkedAt }
    }
  }
  return {
    unresolvedSkus: [...unresolved.values()],
    blockingIssues: cleanTextArray(data.blockingIssues, 200),
    workerInspection,
  }
}

function packageProductUnits(pkg) {
  const reviewData = normalizeReviewData(pkg.review_data)
  const products = new Map()
  for (const item of pkg.items || []) {
    const key = `${item.sku_id || ''}\u241f${item.sku_code || ''}`
    const sourceQty = Number(item.source_qty)
    const fallbackQty = Number(item.expected_qty)
    const productQty = Number.isSafeInteger(sourceQty) && sourceQty > 0
      ? sourceQty
      : Number.isSafeInteger(fallbackQty) && fallbackQty > 0 ? 1 : 0
    products.set(key, Math.max(products.get(key) || 0, productQty))
  }
  for (const item of reviewData.unresolvedSkus) {
    const key = `${item.skuId || ''}\u241f${item.skuCode || ''}`
    if (!products.has(key)) products.set(key, Number(item.quantity || 0))
  }
  return [...products.values()].reduce((sum, quantity) => sum + quantity, 0)
}

function normalizePackages(rawPackages, fallbackStore = null, {
  allowEmptyItems = false,
  status = 'pending',
} = {}) {
  if (!Array.isArray(rawPackages) || !rawPackages.length) throw new Error('packages array required')
  if (rawPackages.length > MAX_PACKAGES_PER_IMPORT) throw new Error(`Import is limited to ${MAX_PACKAGES_PER_IMPORT} packages`)

  let itemCount = 0
  const packages = new Map()
  for (const rawPackage of rawPackages) {
    const trackingIdentity = identifyTrackingNumber(rawPackage.trackingNumber || rawPackage.tracking)
    const trackingKey = trackingIdentity.key
    const trackingNumber = String(rawPackage.trackingNumber || rawPackage.tracking || '').trim()
    const rawStoreName = cleanText(rawPackage.storeName || rawPackage.store_name, 100)
    const store = rawStoreName ? normalizeStore(rawStoreName) : fallbackStore
    if (!trackingKey) throw new Error('Every package requires a tracking number')
    if (!store) throw new Error(`Tracking ${trackingNumber || trackingKey} has no resolved store`)
    if ((!Array.isArray(rawPackage.items) || !rawPackage.items.length) && !allowEmptyItems) {
      throw new Error(`Tracking ${trackingNumber || trackingKey} has no items`)
    }
    const reviewData = normalizeReviewData(rawPackage.reviewData || rawPackage.review_data)
    const pkg = packages.get(trackingKey) || {
      tracking_key: trackingKey,
      tracking_number: trackingNumber || trackingKey,
      store_name: store.name,
      store_key: store.key,
      order_numbers: new Set(),
      return_reasons: new Set(),
      buyer_remarks: new Set(),
      carrier: String(rawPackage.carrier || trackingIdentity.carrier).trim(),
      status,
      review_reason: cleanText(rawPackage.reviewReason || rawPackage.review_reason, 500),
      requires_item_resolution: Boolean(
        rawPackage.requiresItemResolution ?? rawPackage.requires_item_resolution,
      ),
      review_data: { unresolvedSkus: [], blockingIssues: [], workerInspection: null },
      items: new Map(),
    }
    if (pkg.store_key !== store.key) {
      throw new Error(`Tracking ${trackingNumber || trackingKey} contains products from multiple stores`)
    }
    for (const value of rawPackage.orders || []) if (String(value || '').trim()) pkg.order_numbers.add(String(value).trim())
    for (const value of rawPackage.reasons || []) if (String(value || '').trim()) pkg.return_reasons.add(String(value).trim())
    for (const value of rawPackage.buyerRemarks || []) if (String(value || '').trim()) pkg.buyer_remarks.add(String(value).trim())
    pkg.review_data.unresolvedSkus.push(...reviewData.unresolvedSkus)
    pkg.review_data.blockingIssues.push(...reviewData.blockingIssues)
    if (reviewData.workerInspection) pkg.review_data.workerInspection = reviewData.workerInspection
    for (const rawItem of rawPackage.items || []) {
      itemCount += 1
      if (itemCount > MAX_ITEMS_PER_IMPORT) throw new Error(`Import is limited to ${MAX_ITEMS_PER_IMPORT} item rows`)
      const item = {
        sku_id: String(rawItem.skuId || rawItem.sku_id || '').trim(),
        sku_code: String(rawItem.skuCode || rawItem.sku_code || '').trim(),
        style: String(rawItem.style || rawItem.STYLE || '').trim(),
        color: String(rawItem.color || rawItem.COLOR || '').trim(),
        size: String(rawItem.size || rawItem.SIZE || '').trim(),
        expected_qty: Number(rawItem.expectedQty ?? rawItem.expected_qty ?? rawItem.QTY),
        source_qty: Number(rawItem.sourceQty ?? rawItem.source_qty ?? 0) || null,
      }
      if (
        !item.style
        || !item.color
        || !item.size
        || !Number.isSafeInteger(item.expected_qty)
        || item.expected_qty <= 0
        || (item.source_qty != null && (
          !Number.isSafeInteger(item.source_qty) || item.source_qty <= 0
        ))
      ) {
        throw new Error(`Invalid item in tracking ${trackingNumber || trackingKey}`)
      }
      const key = itemIdentity(item)
      const existing = pkg.items.get(key)
      if (existing) {
        existing.expected_qty += item.expected_qty
        existing.source_qty = existing.source_qty != null && item.source_qty != null
          ? existing.source_qty + item.source_qty
          : null
      }
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
      status: pkg.status,
      review_reason: pkg.review_reason,
      requires_item_resolution: pkg.requires_item_resolution,
      review_data: normalizeReviewData(pkg.review_data),
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
      || !Number.isSafeInteger(component.qty) || component.qty <= 0 || component.qty > 9999
    ))) throw new Error(`Resolved SKU ${skuId} has invalid physical components`)
    return { sku_id: skuId, sku_code: skuCode, status, issue, components }
  })
}

async function loadPackage(sql, trackingKey) {
  const [pkg] = await sql`
    SELECT id, tracking_number, tracking_key, source_file, status, store_name, store_key,
           order_numbers, return_reasons, buyer_remarks, carrier, expected_units,
           actual_units, restock_units, flagged_not_ours, remark, uploaded_by, uploaded_at,
           confirmed_by, confirmed_at, review_reason, requires_item_resolution,
           review_data, escalated_by, escalated_at
    FROM return_packages
    WHERE tracking_key = ${trackingKey}
  `
  if (!pkg) return null
  const items = await sql`
    SELECT id, sku_id, sku_code, style, color, size, expected_qty, source_qty,
           actual_qty, restock_qty, not_ours_qty
    FROM return_package_items
    WHERE package_id = ${pkg.id}
    ORDER BY style, color, size
  `
  const relatedOrders = await loadOrdersWithCombinedFallback(
    sql,
    pkg.store_key,
    Array.isArray(pkg.order_numbers) ? pkg.order_numbers : [],
  )
  return { ...pkg, items, related_orders: relatedOrders }
}

async function loadReturnedProductsForOrder(sql, order, excludePackageId = 0) {
  return sql`
    WITH package_products AS (
      SELECT
        packages.id AS package_id,
        items.sku_id,
        items.sku_code,
        MAX(CASE
          WHEN packages.status IN ('pending', 'needs_review') THEN
            CASE
              WHEN items.source_qty IS NOT NULL AND items.source_qty > 0 THEN items.source_qty
              ELSE items.expected_qty
            END
          WHEN COALESCE(items.actual_qty, 0) <= 0 THEN 0
          WHEN items.source_qty IS NOT NULL AND items.source_qty > 0 AND items.expected_qty > 0
            THEN CEIL(items.actual_qty::numeric * items.source_qty / items.expected_qty)::int
          ELSE items.actual_qty
        END)::int AS returned_quantity
      FROM return_packages packages
      JOIN return_package_items items ON items.package_id = packages.id
      WHERE packages.id <> ${excludePackageId}
        AND packages.status <> 'rejected'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(packages.order_numbers) entry(value)
          WHERE REGEXP_REPLACE(
            UPPER(REPLACE(entry.value, ' ', '')), '-D[0-9]+$', ''
          ) = ${normalizeOrderNumber(order.order_number)}
        )
        AND (
          ${order.store_key === COMBINED_ORDER_STORE_KEY}
          OR packages.store_key = ${order.store_key}
        )
      GROUP BY packages.id, items.sku_id, items.sku_code
    )
    SELECT sku_id, sku_code, SUM(returned_quantity)::int AS returned_quantity
    FROM package_products
    GROUP BY sku_id, sku_code
  `
}

function attachReturnableQuantities(pkg, quantities) {
  return {
    ...pkg,
    related_orders: (pkg.related_orders || []).map((order) => ({
      ...order,
      items: (order.items || []).map((item) => ({
        ...item,
        returnable_quantity: Number(quantities[String(item.id)] || 0),
      })),
    })),
  }
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
      orders.shipped_at, orders.delivered_at, orders.source_file, orders.updated_at,
      orders.inventory_status
    FROM return_orders orders
    JOIN wanted ON wanted.order_key = orders.order_key
    WHERE (${storeKey || ''} = '' OR orders.store_key = ${storeKey || ''})
    ORDER BY
      CASE WHEN orders.inventory_status = 'applied' THEN 0 ELSE 1 END,
      orders.order_created_at DESC NULLS LAST,
      orders.order_number
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
      catalog.status AS catalog_status,
      catalog.store_name AS catalog_store_name,
      catalog.store_key AS catalog_store_key
    FROM return_order_items items
    JOIN wanted ON wanted.order_id = items.order_id
    JOIN return_orders orders ON orders.id = items.order_id
    LEFT JOIN LATERAL (
      SELECT
        candidate.components,
        candidate.status,
        candidate.store_name,
        candidate.store_key
      FROM return_product_catalog candidate
      WHERE candidate.sku_id = items.sku_id
        AND (
          orders.store_key = ${COMBINED_ORDER_STORE_KEY}
          OR candidate.store_key = orders.store_key
        )
        AND NOT EXISTS (
          SELECT 1
          FROM return_product_catalog other
          WHERE other.sku_id = candidate.sku_id
            AND other.id <> candidate.id
        )
    ) catalog ON true
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

async function loadOrdersWithCombinedFallback(sql, storeKey, orderNumbers) {
  const direct = await loadOrdersByKeys(sql, storeKey, orderNumbers)
  if (!storeKey || storeKey === COMBINED_ORDER_STORE_KEY) return direct
  const found = new Set(direct.map((order) => order.order_key))
  const missing = (orderNumbers || []).filter((orderNumber) =>
    !found.has(normalizeOrderNumber(orderNumber))
  )
  if (!missing.length) return direct
  const combined = await loadOrdersByKeys(sql, COMBINED_ORDER_STORE_KEY, missing)
  return [...direct, ...combined]
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

async function reuseSkuMappingForQueuedPackages(
  sql,
  { storeKey, skuId, skuCode, components, excludePackageId },
) {
  const candidates = await sql`
    SELECT id, review_data
    FROM return_packages
    WHERE store_key = ${storeKey}
      AND status = 'needs_review'
      AND id <> ${excludePackageId}
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(review_data->'unresolvedSkus', '[]'::jsonb)
        ) unresolved(value)
        WHERE unresolved.value->>'skuId' = ${skuId}
      )
    ORDER BY id
    LIMIT 500
  `
  let resolvedPackages = 0
  for (const candidate of candidates) {
    const reviewData = normalizeReviewData(candidate.review_data)
    const unresolvedSku = reviewData.unresolvedSkus.find((item) => item.skuId === skuId)
    if (!unresolvedSku) continue
    const remainingSkus = reviewData.unresolvedSkus.filter((item) => item.skuId !== skuId)
    const nextReviewData = {
      unresolvedSkus: remainingSkus,
      blockingIssues: reviewData.blockingIssues,
      workerInspection: reviewData.workerInspection,
    }
    const reviewReason = [...new Set([
      ...remainingSkus.map((item) => item.issue),
      ...reviewData.blockingIssues,
    ])].join(',')
    const packageItems = components.map((component) => ({
      sku_id: skuId,
      sku_code: skuCode || unresolvedSku.skuCode,
      style: component.style,
      color: component.color,
      size: component.size,
      expected_qty: component.qty * unresolvedSku.quantity,
      source_qty: unresolvedSku.quantity,
    }))
    if (packageItems.some((item) => item.expected_qty > 9999)) continue
    const results = await sql.transaction((txn) => [
      txn`
        WITH claimed AS (
          UPDATE return_packages
          SET review_data = ${JSON.stringify(nextReviewData)}::jsonb,
              review_reason = ${reviewReason},
              requires_item_resolution = ${Boolean(
                remainingSkus.length || reviewData.blockingIssues.length,
              )}
          WHERE id = ${candidate.id}
            AND status = 'needs_review'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(review_data->'unresolvedSkus', '[]'::jsonb)
              ) unresolved(value)
              WHERE unresolved.value->>'skuId' = ${skuId}
            )
          RETURNING id
        ),
        incoming AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(packageItems)}::jsonb)
            AS item(
              sku_id TEXT, sku_code TEXT, style TEXT, color TEXT, size TEXT,
              expected_qty INTEGER, source_qty INTEGER
            )
        )
        INSERT INTO return_package_items (
          package_id, sku_id, sku_code, style, color, size,
          expected_qty, source_qty, actual_qty, restock_qty, not_ours_qty
        )
        SELECT
          claimed.id, incoming.sku_id, incoming.sku_code, incoming.style,
          incoming.color, incoming.size, incoming.expected_qty,
          incoming.source_qty, NULL, NULL, NULL
        FROM claimed
        CROSS JOIN incoming
        ON CONFLICT (package_id, sku_id, style, color, size) DO UPDATE SET
          sku_code = EXCLUDED.sku_code,
          expected_qty = return_package_items.expected_qty + EXCLUDED.expected_qty,
          source_qty = COALESCE(return_package_items.source_qty, 0) + EXCLUDED.source_qty
        RETURNING package_id
      `,
      txn`
        UPDATE return_packages
        SET expected_units = (
          SELECT COALESCE(SUM(expected_qty), 0)::int
          FROM return_package_items
          WHERE package_id = ${candidate.id}
        )
        WHERE id = ${candidate.id}
      `,
    ], { isolationLevel: 'Serializable' })
    if (results[0]?.length) resolvedPackages += 1
  }
  return resolvedPackages
}

export default async function handler(req, res) {
  try {
    const sql = getDB()
    const payload = await authenticateUser(
      sql,
      req.headers.authorization,
      process.env.JWT_SECRET,
    )
    if (!payload) return res.status(401).json({ error: 'Not authenticated' })
    const action = String(req.query.action || '')

    if (req.method === 'POST' && action === 'catalog-import') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const rows = normalizeCatalogRows(req.body?.rows)
      const sourceFile = String(req.body?.sourceFile || '').trim()
      const data = JSON.stringify(rows)
      const conflicts = await sql`
        WITH incoming AS (
          SELECT sku_id
          FROM jsonb_to_recordset(${data}::jsonb) AS item(sku_id TEXT)
        )
        SELECT catalog.sku_id, MIN(catalog.store_name) AS store_name
        FROM return_product_catalog catalog
        JOIN incoming USING (sku_id)
        WHERE catalog.store_key <> ${store.key}
        GROUP BY catalog.sku_id
        ORDER BY catalog.sku_id
        LIMIT 50
      `
      if (conflicts.length) {
        return res.status(409).json({
          error: `${conflicts.length} SKU ID(s) already belong to another store`,
          conflicts,
        })
      }
      const [protectedSummary] = await sql`
        WITH incoming AS (
          SELECT sku_id
          FROM jsonb_to_recordset(${data}::jsonb) AS item(sku_id TEXT)
        )
        SELECT COUNT(*)::int AS protected_rows
        FROM return_product_catalog catalog
        JOIN incoming USING (sku_id)
        WHERE catalog.store_key = ${store.key}
          AND catalog.mapping_source = 'admin'
      `
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
          sku_code = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.sku_code
            ELSE EXCLUDED.sku_code
          END,
          components = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.components
            ELSE EXCLUDED.components
          END,
          status = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.status
            ELSE EXCLUDED.status
          END,
          issue = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.issue
            ELSE EXCLUDED.issue
          END,
          source_file = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.source_file
            ELSE EXCLUDED.source_file
          END,
          updated_by = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.updated_by
            ELSE EXCLUDED.updated_by
          END,
          mapping_version = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.mapping_version
            ELSE return_product_catalog.mapping_version + 1
          END,
          updated_at = CASE
            WHEN return_product_catalog.mapping_source = 'admin'
              THEN return_product_catalog.updated_at
            ELSE NOW()
          END
      `
      const [importSummary] = await sql`
        WITH incoming AS (
          SELECT sku_id
          FROM jsonb_to_recordset(${data}::jsonb) AS item(sku_id TEXT)
        )
        SELECT
          COUNT(*) FILTER (WHERE catalog.status = 'ready')::int AS ready_rows,
          COUNT(*) FILTER (WHERE catalog.status <> 'ready')::int AS review_rows
        FROM return_product_catalog catalog
        JOIN incoming USING (sku_id)
        WHERE catalog.store_key = ${store.key}
      `
      return res.json({
        ok: true,
        store_name: store.name,
        imported_rows: rows.length,
        ready_rows: Number(importSummary?.ready_rows || 0),
        review_rows: Number(importSummary?.review_rows || 0),
        protected_rows: Number(protectedSummary?.protected_rows || 0),
      })
    }

    if (req.method === 'POST' && action === 'catalogs-lookup') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const skuIds = Array.isArray(req.body?.skuIds)
        ? [...new Set(req.body.skuIds.map((value) => cleanText(value, 100)).filter(Boolean))]
        : []
      if (!skuIds.length) return res.status(400).json({ error: 'skuIds array required' })
      if (skuIds.length > MAX_CATALOG_LOOKUPS) {
        return res.status(400).json({ error: `Lookup is limited to ${MAX_CATALOG_LOOKUPS} SKU IDs per batch` })
      }
      const rows = await sql`
        WITH wanted AS (
          SELECT value #>> '{}' AS sku_id
          FROM jsonb_array_elements(${JSON.stringify(skuIds)}::jsonb)
        )
        SELECT
          catalog.store_name, catalog.store_key, catalog.sku_id, catalog.sku_code,
          catalog.components, catalog.status, catalog.issue, catalog.source_file,
          catalog.updated_at, catalog.mapping_source, catalog.mapping_version,
          catalog.mapping_confirmed_by, catalog.mapping_confirmed_at
        FROM return_product_catalog catalog
        JOIN wanted USING (sku_id)
        ORDER BY catalog.sku_id, catalog.store_name
      `
      return res.json({ rows })
    }

    if (req.method === 'POST' && action === 'catalog-update') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.body?.storeName)
      const skuId = cleanText(req.body?.skuId, 100)
      if (!skuId) return res.status(400).json({ error: 'skuId is required' })
      const [existing] = await sql`
        SELECT sku_id, sku_code, components, status, issue, mapping_source, mapping_version
        FROM return_product_catalog
        WHERE store_key = ${store.key} AND sku_id = ${skuId}
      `
      if (!existing) return res.status(404).json({ error: 'Saved SKU mapping not found' })

      const [catalogRow] = normalizeCatalogRows([{
        skuId,
        skuCode: existing.sku_code,
        status: 'ready',
        components: req.body?.components,
      }])
      const resolution = await resolveInventoryRows(sql, catalogRow.components.map((component) => ({
        ...component,
        allowCreate: false,
      })))
      if (resolution.missing.length || resolution.ambiguous.length) {
        return res.status(409).json({
          error: 'One or more selected style, color, and size targets are not unique in inventory',
        })
      }
      const components = mergeInventoryComponents(resolution.rows.map((component) => ({
        style: component.style,
        color: component.color,
        size: component.size,
        qty: component.qty,
      })))
      const componentData = JSON.stringify(components)
      const oldMapping = JSON.stringify({
        sku_code: existing.sku_code,
        components: existing.components,
        status: existing.status,
        issue: existing.issue,
        mapping_source: existing.mapping_source,
        mapping_version: existing.mapping_version,
      })
      const newMapping = JSON.stringify({
        sku_code: existing.sku_code,
        components,
        status: 'ready',
      })

      await sql.transaction((txn) => [
        txn`
          INSERT INTO return_product_catalog_history (
            store_name, store_key, sku_id, old_mapping, new_mapping,
            change_source, tracking_number, changed_by
          ) VALUES (
            ${store.name}, ${store.key}, ${skuId}, ${oldMapping}::jsonb,
            ${newMapping}::jsonb, 'catalog_set_edit', NULL, ${payload.username}
          )
        `,
        txn`
          UPDATE return_product_catalog
          SET components = ${componentData}::jsonb,
              status = 'ready',
              issue = NULL,
              source_file = 'Saved Set Edit',
              updated_by = ${payload.username},
              updated_at = NOW(),
              mapping_source = 'admin',
              mapping_version = mapping_version + 1,
              mapping_confirmed_by = ${payload.username},
              mapping_confirmed_at = NOW()
          WHERE store_key = ${store.key} AND sku_id = ${skuId}
        `,
      ], { isolationLevel: 'Serializable' })

      const [row] = await sql`
        SELECT sku_id, sku_code, components, status, issue, source_file, updated_at,
               mapping_source, mapping_version, mapping_confirmed_by, mapping_confirmed_at
        FROM return_product_catalog
        WHERE store_key = ${store.key} AND sku_id = ${skuId}
      `
      return res.json({ ok: true, row })
    }

    if (req.method === 'GET' && action === 'catalog') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const store = normalizeStore(req.query.store)
      const query = cleanText(req.query.q, 200)
      const setsOnly = String(req.query.setsOnly || '') === '1'
      const rows = await sql`
        SELECT sku_id, sku_code, components, status, issue, source_file, updated_at,
               mapping_source, mapping_version, mapping_confirmed_by, mapping_confirmed_at
        FROM return_product_catalog
        WHERE store_key = ${store.key}
          AND (
            ${query} = ''
            OR sku_id ILIKE ${`%${query}%`}
            OR sku_code ILIKE ${`%${query}%`}
            OR components::text ILIKE ${`%${query}%`}
          )
          AND (
            ${setsOnly} = false
            OR CASE
              WHEN jsonb_typeof(components) = 'array' THEN jsonb_array_length(components) > 1
                OR COALESCE((
                  SELECT SUM((component->>'qty')::int)
                  FROM jsonb_array_elements(components) component
                  WHERE component->>'qty' ~ '^[0-9]+$'
                ), 0) > 1
              ELSE false
            END
          )
        ORDER BY sku_id
        LIMIT 100
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
      const inventoryStatus = req.body?.inventoryStatus === 'pending' ? 'pending' : 'applied'
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
            source_file, source_hash, imported_by, imported_at, updated_at,
            inventory_status
          )
          SELECT
            store_name, store_key, order_number, order_key, site, status,
            order_created_at, order_confirmed_at, shipped_at, delivered_at,
            ${sourceFile}, ${sourceHash}, ${payload.username}, NOW(), NOW(),
            ${inventoryStatus}
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
            source_file = CASE
              WHEN return_orders.inventory_status = 'applied'
               AND EXCLUDED.inventory_status = 'pending'
                THEN return_orders.source_file
              ELSE EXCLUDED.source_file
            END,
            source_hash = CASE
              WHEN return_orders.inventory_status = 'applied'
               AND EXCLUDED.inventory_status = 'pending'
                THEN return_orders.source_hash
              ELSE COALESCE(NULLIF(EXCLUDED.source_hash, ''), return_orders.source_hash)
            END,
            imported_by = CASE
              WHEN return_orders.inventory_status = 'applied'
               AND EXCLUDED.inventory_status = 'pending'
                THEN return_orders.imported_by
              ELSE EXCLUDED.imported_by
            END,
            inventory_status = CASE
              WHEN return_orders.inventory_status = 'applied' THEN 'applied'
              ELSE EXCLUDED.inventory_status
            END,
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
            order_count, item_count, conflict_count, imported_by, inventory_status
          )
          VALUES (
            ${store.name}, ${store.key}, ${sourceFile}, ${sourceHash},
            ${Number.isSafeInteger(batchIndex) ? batchIndex : null},
            ${orders.length}, ${flatItems.length}, ${conflicts.length}, ${payload.username},
            ${inventoryStatus}
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
      const orders = storeKey
        ? await loadOrdersWithCombinedFallback(sql, storeKey, [orderNumber])
        : await loadOrdersByKeys(sql, '', [orderNumber])
      if (!orders.length) return res.status(404).json({ error: 'Order is not in the uploaded history' })
      if (!storeKey && new Set(orders.map((order) => order.store_key)).size > 1) {
        return res.status(409).json({
          error: 'This order number exists in more than one store. Choose a store.',
          stores: [...new Set(orders.map((order) => order.store_name))],
        })
      }
      const order = orders[0]
      const returnHistory = await sql`
        SELECT
          packages.id, packages.tracking_number, packages.status,
          packages.expected_units, packages.actual_units, packages.restock_units,
          packages.uploaded_at, packages.confirmed_at,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'sku_id', items.sku_id,
              'sku_code', items.sku_code,
              'style', items.style,
              'color', items.color,
              'size', items.size,
              'source_qty', items.source_qty,
              'expected_qty', items.expected_qty,
              'actual_qty', items.actual_qty
            ) ORDER BY items.id)
            FROM return_package_items items
            WHERE items.package_id = packages.id
          ), '[]'::jsonb) AS items
        FROM return_packages packages
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(packages.order_numbers) entry(value)
          WHERE REGEXP_REPLACE(
            UPPER(REPLACE(entry.value, ' ', '')), '-D[0-9]+$', ''
          ) = ${orderKey}
        )
          AND (
            ${order.store_key === COMBINED_ORDER_STORE_KEY}
            OR packages.store_key = ${order.store_key}
          )
        ORDER BY packages.uploaded_at DESC, packages.id DESC
        LIMIT 50
      `
      return res.json({ order, returns: returnHistory, matches: orders.length })
    }

    if (req.method === 'POST' && action === 'manual-create') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const orderNumber = cleanText(req.body?.orderNumber, 100)
      const orderKey = normalizeOrderNumber(orderNumber)
      if (!orderKey) return res.status(400).json({ error: 'orderNumber required' })
      const storeValue = cleanText(req.body?.storeName, 100)
      const storeKey = storeValue ? normalizeStore(storeValue).key : ''
      const orders = storeKey
        ? await loadOrdersWithCombinedFallback(sql, storeKey, [orderNumber])
        : await loadOrdersByKeys(sql, '', [orderNumber])
      if (!orders.length) return res.status(404).json({ error: 'Order is not in the uploaded history' })
      if (!storeKey && new Set(orders.map((order) => order.store_key)).size > 1) {
        return res.status(409).json({
          error: 'This order number exists in more than one store. Choose a store.',
          stores: [...new Set(orders.map((order) => order.store_name))],
        })
      }
      const order = orders[0]
      if (!order.items?.length) return res.status(409).json({ error: 'This order has no products' })
      const [openPackage] = await sql`
        SELECT id, tracking_key
        FROM return_packages packages
        WHERE packages.status IN ('pending', 'needs_review')
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(packages.order_numbers) entry(value)
            WHERE REGEXP_REPLACE(
              UPPER(REPLACE(entry.value, ' ', '')), '-D[0-9]+$', ''
            ) = ${orderKey}
          )
          AND (
            ${order.store_key === COMBINED_ORDER_STORE_KEY}
            OR packages.store_key = ${order.store_key}
          )
        ORDER BY packages.uploaded_at DESC, packages.id DESC
        LIMIT 1
      `
      if (openPackage) {
        const returnedProducts = await loadReturnedProductsForOrder(sql, order, openPackage.id)
        const suggestions = remainingOrderItemQuantities(order.items, returnedProducts)
        const existingPackage = attachReturnableQuantities(
          await loadPackage(sql, openPackage.tracking_key),
          suggestions,
        )
        return res.json({
          ok: true,
          package: existingPackage,
          suggested_selections: suggestions,
          reused_existing: true,
        })
      }

      const returnedProducts = await loadReturnedProductsForOrder(sql, order)
      const suggestions = remainingOrderItemQuantities(order.items, returnedProducts)
      if (!Object.values(suggestions).some((quantity) => quantity > 0)) {
        return res.status(409).json({
          error: 'Every product in this order already has a return record. Open the existing return instead.',
        })
      }
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
      const trackingNumber = `MANUAL-${orderKey}-${suffix}`
      const reviewData = JSON.stringify({
        unresolvedSkus: [],
        blockingIssues: [],
        workerInspection: null,
        manualReturn: {
          orderNumber: order.order_number,
          createdBy: payload.username,
          createdAt: new Date().toISOString(),
        },
      })
      await sql`
        INSERT INTO return_packages (
          tracking_number, tracking_key, source_file, status, store_name, store_key,
          order_numbers, expected_units, uploaded_by, requires_item_resolution,
          review_reason, review_data
        ) VALUES (
          ${trackingNumber}, ${normalizeTracking(trackingNumber)}, 'Manual PO Return', 'pending',
          ${order.store_name}, ${order.store_key}, ${JSON.stringify([order.order_number])}::jsonb,
          0, ${payload.username}, true, 'manual_po_return', ${reviewData}::jsonb
        )
      `
      const manualPackage = attachReturnableQuantities(
        await loadPackage(sql, normalizeTracking(trackingNumber)),
        suggestions,
      )
      return res.json({
        ok: true,
        package: manualPackage,
        suggested_selections: suggestions,
        reused_existing: false,
      })
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
      const orders = await loadOrdersWithCombinedFallback(sql, store.key, orderNumbers)
      return res.json({ orders })
    }

    if (req.method === 'POST' && action === 'orders-lookup-any') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const orderNumbers = Array.isArray(req.body?.orderNumbers)
        ? [...new Set(req.body.orderNumbers.map((value) => cleanText(value, 100)).filter(Boolean))]
        : []
      if (!orderNumbers.length) return res.status(400).json({ error: 'orderNumbers array required' })
      if (orderNumbers.length > MAX_ORDER_LOOKUPS) {
        return res.status(400).json({ error: `Lookup is limited to ${MAX_ORDER_LOOKUPS} orders per batch` })
      }
      const orders = await loadOrdersByKeys(sql, '', orderNumbers)
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
      const fallbackStore = req.body?.storeName ? normalizeStore(req.body.storeName) : null
      const readyInput = Array.isArray(req.body?.packages) ? req.body.packages : []
      const reviewInput = Array.isArray(req.body?.reviewPackages) ? req.body.reviewPackages : []
      if (!readyInput.length && !reviewInput.length) {
        return res.status(400).json({ error: 'No return packages are ready to upload' })
      }
      const readyPackages = readyInput.length
        ? normalizePackages(readyInput, fallbackStore)
        : []
      const reviewPackages = reviewInput.length
        ? normalizePackages(reviewInput, fallbackStore, {
            allowEmptyItems: true,
            status: 'needs_review',
          })
        : []
      const packages = [...readyPackages, ...reviewPackages]
      if (packages.length > MAX_PACKAGES_PER_IMPORT) {
        return res.status(400).json({ error: `Import is limited to ${MAX_PACKAGES_PER_IMPORT} packages` })
      }
      if (new Set(packages.map((pkg) => pkg.tracking_key)).size !== packages.length) {
        return res.status(400).json({ error: 'A tracking number cannot be both ready and under review' })
      }
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
      let importable = packages.filter((pkg) => !finalKeys.has(pkg.tracking_key))
      const orderKeys = [...new Set(importable.flatMap((pkg) => pkg.order_numbers)
        .map(normalizeOrderNumber).filter(Boolean))]
      let correctedPackages = 0
      if (orderKeys.length) {
        const quantityOrders = await sql`
          WITH wanted AS (
            SELECT value #>> '{}' AS order_key
            FROM jsonb_array_elements(${JSON.stringify(orderKeys)}::jsonb)
          )
          SELECT orders.order_key, orders.store_key,
            jsonb_agg(jsonb_build_object(
              'sku_id', items.sku_id, 'sku_code', items.sku_code, 'quantity', items.quantity
            )) AS items
          FROM return_orders orders
          JOIN wanted USING (order_key)
          JOIN return_order_items items ON items.order_id = orders.id
          GROUP BY orders.id
        `
        const limited = limitReturnPackageQuantities(importable, quantityOrders)
        correctedPackages = limited.filter((pkg, index) => pkg !== importable[index]).length
        importable = limited
      }

      if (importable.length) {
        const manifest = JSON.stringify(importable)
        await sql.transaction((txn) => [
          txn`
            WITH incoming AS (
              SELECT * FROM jsonb_to_recordset(${manifest}::jsonb)
                AS item(
                  tracking_key TEXT, tracking_number TEXT, store_name TEXT, store_key TEXT,
                  order_numbers JSONB, return_reasons JSONB, buyer_remarks JSONB, carrier TEXT,
                  status TEXT, review_reason TEXT, requires_item_resolution BOOLEAN,
                  review_data JSONB, expected_units INTEGER, items JSONB
                )
            )
            INSERT INTO return_packages (
              tracking_key, tracking_number, store_name, store_key, order_numbers,
              return_reasons, buyer_remarks, carrier, source_file, status, expected_units,
              actual_units, restock_units, flagged_not_ours, uploaded_by, uploaded_at,
              confirmed_by, confirmed_at, remark, review_reason, requires_item_resolution,
              review_data, escalated_by, escalated_at
            )
            SELECT
              tracking_key, tracking_number, store_name, store_key, order_numbers,
              return_reasons, buyer_remarks, carrier, ${sourceFile}, status, expected_units,
              0, 0, false, ${payload.username}, NOW(), NULL, NULL, NULL,
              review_reason, requires_item_resolution, review_data, NULL, NULL
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
              status = EXCLUDED.status,
              expected_units = EXCLUDED.expected_units,
              actual_units = 0,
              restock_units = 0,
              flagged_not_ours = false,
              review_reason = EXCLUDED.review_reason,
              requires_item_resolution = EXCLUDED.requires_item_resolution,
              review_data = EXCLUDED.review_data,
              uploaded_by = EXCLUDED.uploaded_by,
              uploaded_at = NOW(),
              confirmed_by = NULL,
              confirmed_at = NULL,
              remark = NULL,
              escalated_by = NULL,
              escalated_at = NULL
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
              AND packages.status IN ('pending', 'needs_review')
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
                item.expected_qty,
                item.source_qty
              FROM incoming_packages packages
              CROSS JOIN LATERAL jsonb_to_recordset(packages.items)
                AS item(
                  sku_id TEXT, sku_code TEXT, style TEXT, color TEXT, size TEXT,
                  expected_qty INTEGER, source_qty INTEGER
                )
            )
            INSERT INTO return_package_items (
              package_id, sku_id, sku_code, style, color, size, expected_qty, source_qty,
              actual_qty, restock_qty, not_ours_qty
            )
            SELECT
              packages.id, items.sku_id, items.sku_code, items.style, items.color,
              items.size, items.expected_qty, items.source_qty, NULL, NULL, NULL
            FROM incoming_items items
            JOIN return_packages packages ON packages.tracking_key = items.tracking_key
            WHERE packages.status IN ('pending', 'needs_review')
          `,
        ])
      }
      return res.json({
        ok: true,
        imported_packages: importable.length,
        corrected_packages: correctedPackages,
        review_packages: importable.filter((pkg) => pkg.status === 'needs_review').length,
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
            SELECT id, tracking_number, store_name, status, expected_units, actual_units,
                   restock_units, flagged_not_ours, review_reason, requires_item_resolution,
                   escalated_by, escalated_at, uploaded_at, confirmed_at
            FROM return_packages
            WHERE status = ${status}
            ORDER BY uploaded_at DESC
            LIMIT 200
          `
        : await sql`
            SELECT id, tracking_number, store_name, status, expected_units, actual_units,
                   restock_units, flagged_not_ours, review_reason, requires_item_resolution,
                   escalated_by, escalated_at, uploaded_at, confirmed_at
            FROM return_packages
            ORDER BY CASE
              WHEN status = 'needs_review' THEN 0
              WHEN status = 'pending' THEN 1
              ELSE 2
            END, uploaded_at DESC
            LIMIT 200
          `
      return res.json({ packages: rows })
    }

    if (req.method === 'POST' && action === 'flag') {
      const trackingKey = normalizeTracking(req.body?.tracking)
      if (!trackingKey) return res.status(400).json({ error: 'tracking required' })
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      if (!['pending', 'needs_review'].includes(pkg.status)) {
        return res.status(409).json({ error: 'This return package has already been completed' })
      }
      const reason = cleanText(req.body?.reason || 'worker_flagged', 500)
      const workerChecked = req.body?.workerChecked === true
      const reviewData = normalizeReviewData(pkg.review_data)
      if (workerChecked) {
        const productUnits = packageProductUnits(pkg)
        reviewData.workerInspection = {
          status: 'all_good',
          productUnits,
          checkedBy: payload.username,
          checkedAt: new Date().toISOString(),
        }
      }
      await sql`
        UPDATE return_packages
        SET status = 'needs_review',
            review_reason = CASE
              WHEN status = 'pending' THEN ${reason}
              ELSE COALESCE(NULLIF(review_reason, ''), ${reason})
            END,
            requires_item_resolution = CASE
              WHEN status = 'pending' THEN false
              ELSE requires_item_resolution
            END,
            review_data = ${JSON.stringify(reviewData)}::jsonb,
            escalated_by = COALESCE(escalated_by, ${payload.username}),
            escalated_at = COALESCE(escalated_at, NOW())
        WHERE id = ${pkg.id}
          AND status IN ('pending', 'needs_review')
      `
      return res.json({ ok: true, status: 'needs_review' })
    }

    if (req.method === 'POST' && action === 'resolve-sku-mapping') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const trackingKey = normalizeTracking(req.body?.tracking)
      const skuId = cleanText(req.body?.skuId, 100)
      if (!trackingKey || !skuId) {
        return res.status(400).json({ error: 'tracking and skuId are required' })
      }
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      if (pkg.status !== 'needs_review') {
        return res.status(409).json({ error: 'This package is no longer waiting for Admin Review' })
      }
      if (!pkg.store_key || pkg.store_key === 'unresolved') {
        return res.status(409).json({ error: 'Resolve the package store before saving this SKU mapping' })
      }

      const reviewData = normalizeReviewData(pkg.review_data)
      const unresolvedSku = reviewData.unresolvedSkus.find((item) => item.skuId === skuId)
      if (!unresolvedSku) {
        return res.status(409).json({ error: 'This SKU mapping was already resolved or is no longer pending' })
      }
      const [catalogRow] = normalizeCatalogRows([{
        skuId,
        skuCode: unresolvedSku.skuCode,
        status: 'ready',
        components: req.body?.components,
      }])
      const resolution = await resolveInventoryRows(sql, catalogRow.components.map((component) => ({
        ...component,
        allowCreate: false,
      })))
      if (resolution.missing.length || resolution.ambiguous.length) {
        return res.status(409).json({
          error: 'One or more selected style, color, and size targets are not unique in inventory',
        })
      }
      const components = mergeInventoryComponents(resolution.rows.map((component) => ({
        style: component.style,
        color: component.color,
        size: component.size,
        qty: component.qty,
      })))
      const packageItems = components.map((component) => ({
        sku_id: skuId,
        sku_code: unresolvedSku.skuCode,
        style: component.style,
        color: component.color,
        size: component.size,
        expected_qty: component.qty * unresolvedSku.quantity,
        source_qty: unresolvedSku.quantity,
      }))
      if (packageItems.some((item) => item.expected_qty > 9999)) {
        return res.status(400).json({ error: 'Resolved return quantity is too large' })
      }

      const conflicts = await sql`
        SELECT store_name
        FROM return_product_catalog
        WHERE sku_id = ${skuId} AND store_key <> ${pkg.store_key}
        LIMIT 1
      `
      if (conflicts.length) {
        return res.status(409).json({
          error: `SKU ID ${skuId} already belongs to ${conflicts[0].store_name}`,
        })
      }

      const remainingSkus = reviewData.unresolvedSkus.filter((item) => item.skuId !== skuId)
      const nextReviewData = {
        unresolvedSkus: remainingSkus,
        blockingIssues: reviewData.blockingIssues,
        workerInspection: reviewData.workerInspection,
      }
      const requiresItemResolution = Boolean(
        remainingSkus.length || reviewData.blockingIssues.length,
      )
      const reviewReason = [...new Set([
        ...remainingSkus.map((item) => item.issue),
        ...reviewData.blockingIssues,
      ])].join(',')
      const componentData = JSON.stringify(components)
      const itemData = JSON.stringify(packageItems)
      const newMapping = JSON.stringify({
        sku_code: unresolvedSku.skuCode,
        components,
        status: 'ready',
      })

      await sql.transaction((txn) => [
        txn`
          INSERT INTO return_product_catalog_history (
            store_name, store_key, sku_id, old_mapping, new_mapping,
            change_source, tracking_number, changed_by
          )
          SELECT
            ${pkg.store_name}, ${pkg.store_key}, ${skuId},
            CASE WHEN catalog.id IS NULL THEN NULL ELSE jsonb_build_object(
              'sku_code', catalog.sku_code,
              'components', catalog.components,
              'status', catalog.status,
              'issue', catalog.issue,
              'mapping_source', catalog.mapping_source,
              'mapping_version', catalog.mapping_version
            ) END,
            ${newMapping}::jsonb,
            'admin_review',
            ${pkg.tracking_number},
            ${payload.username}
          FROM (SELECT 1) seed
          LEFT JOIN return_product_catalog catalog
            ON catalog.store_key = ${pkg.store_key}
           AND catalog.sku_id = ${skuId}
        `,
        txn`
          INSERT INTO return_product_catalog (
            store_name, store_key, sku_id, sku_code, components, status, issue,
            source_file, updated_by, updated_at, mapping_source, mapping_version,
            mapping_confirmed_by, mapping_confirmed_at
          )
          VALUES (
            ${pkg.store_name}, ${pkg.store_key}, ${skuId}, ${unresolvedSku.skuCode},
            ${componentData}::jsonb, 'ready', NULL, 'Admin Review', ${payload.username}, NOW(),
            'admin', 1, ${payload.username}, NOW()
          )
          ON CONFLICT (store_key, sku_id) DO UPDATE SET
            store_name = EXCLUDED.store_name,
            sku_code = EXCLUDED.sku_code,
            components = EXCLUDED.components,
            status = 'ready',
            issue = NULL,
            updated_by = EXCLUDED.updated_by,
            mapping_source = 'admin',
            mapping_version = return_product_catalog.mapping_version + 1,
            mapping_confirmed_by = EXCLUDED.mapping_confirmed_by,
            mapping_confirmed_at = NOW(),
            updated_at = NOW()
        `,
        txn`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${itemData}::jsonb)
              AS item(
                sku_id TEXT, sku_code TEXT, style TEXT, color TEXT, size TEXT,
                expected_qty INTEGER, source_qty INTEGER
              )
          )
          INSERT INTO return_package_items (
            package_id, sku_id, sku_code, style, color, size,
            expected_qty, source_qty, actual_qty, restock_qty, not_ours_qty
          )
          SELECT
            ${pkg.id}, sku_id, sku_code, style, color, size,
            expected_qty, source_qty, NULL, NULL, NULL
          FROM incoming
          ON CONFLICT (package_id, sku_id, style, color, size) DO UPDATE SET
            sku_code = EXCLUDED.sku_code,
            expected_qty = return_package_items.expected_qty + EXCLUDED.expected_qty,
            source_qty = COALESCE(return_package_items.source_qty, 0) + EXCLUDED.source_qty
        `,
        txn`
          UPDATE return_packages
          SET review_data = ${JSON.stringify(nextReviewData)}::jsonb,
              review_reason = ${reviewReason},
              requires_item_resolution = ${requiresItemResolution},
              expected_units = (
                SELECT COALESCE(SUM(expected_qty), 0)::int
                FROM return_package_items
                WHERE package_id = ${pkg.id}
              )
          WHERE id = ${pkg.id} AND status = 'needs_review'
        `,
      ], { isolationLevel: 'Serializable' })

      let reusedPackages = 0
      let reuseWarning = ''
      try {
        reusedPackages = await reuseSkuMappingForQueuedPackages(sql, {
          storeKey: pkg.store_key,
          skuId,
          skuCode: unresolvedSku.skuCode,
          components,
          excludePackageId: pkg.id,
        })
      } catch (error) {
        console.error('[/api/returns] queued SKU mapping reuse:', error.message)
        reuseWarning = 'The mapping was saved, but some older review packages still need a refresh.'
      }
      return res.json({
        ok: true,
        package: await loadPackage(sql, trackingKey),
        reused_packages: reusedPackages,
        reuse_warning: reuseWarning,
      })
    }

    if (req.method === 'POST' && action === 'edit-set-mapping') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const trackingKey = normalizeTracking(req.body?.tracking)
      const skuId = cleanText(req.body?.skuId, 100)
      if (!trackingKey || !skuId) {
        return res.status(400).json({ error: 'tracking and skuId are required' })
      }
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      if (!['pending', 'needs_review'].includes(pkg.status) || pkg.requires_item_resolution) {
        return res.status(409).json({ error: 'Only an unresolved inventory check can be edited' })
      }
      if (!pkg.store_key || pkg.store_key === 'unresolved') {
        return res.status(409).json({ error: 'Resolve the package store before editing this set' })
      }

      const matchingItems = pkg.items.filter((item) => String(item.sku_id || '').trim() === skuId)
      if (!matchingItems.length) {
        return res.status(404).json({ error: 'This SKU is not in the selected return package' })
      }
      const skuCode = cleanText(matchingItems[0].sku_code, 300)
      const sourceQuantities = [...new Set(matchingItems
        .map((item) => Number(item.source_qty))
        .filter((quantity) => Number.isSafeInteger(quantity) && quantity > 0))]
      if (sourceQuantities.length > 1) {
        return res.status(409).json({ error: 'This set has inconsistent product quantities and needs review' })
      }
      const productQuantity = sourceQuantities[0] || 1
      const [catalogRow] = normalizeCatalogRows([{
        skuId,
        skuCode,
        status: 'ready',
        components: req.body?.components,
      }])
      const resolution = await resolveInventoryRows(sql, catalogRow.components.map((component) => ({
        ...component,
        allowCreate: false,
      })))
      if (resolution.missing.length || resolution.ambiguous.length) {
        return res.status(409).json({
          error: 'One or more selected style, color, and size targets are not unique in inventory',
        })
      }
      const components = mergeInventoryComponents(resolution.rows.map((component) => ({
        style: component.style,
        color: component.color,
        size: component.size,
        qty: component.qty,
      })))
      const replacementItems = components.map((component) => ({
        sku_id: skuId,
        sku_code: skuCode,
        style: component.style,
        color: component.color,
        size: component.size,
        expected_qty: component.qty * productQuantity,
        source_qty: productQuantity,
      }))
      if (replacementItems.some((item) => item.expected_qty > 9999)) {
        return res.status(400).json({ error: 'Resolved return quantity is too large' })
      }

      const conflicts = await sql`
        SELECT store_name
        FROM return_product_catalog
        WHERE sku_id = ${skuId} AND store_key <> ${pkg.store_key}
        LIMIT 1
      `
      if (conflicts.length) {
        return res.status(409).json({
          error: `SKU ID ${skuId} already belongs to ${conflicts[0].store_name}`,
        })
      }

      const items = replaceSelectedReturnPackageItems(
        pkg.items,
        replacementItems,
        [{ sku_id: skuId, sku_code: skuCode }],
      )
      const expectedUnits = items.reduce((sum, item) => sum + item.expected_qty, 0)
      const componentData = JSON.stringify(components)
      const newMapping = JSON.stringify({ sku_code: skuCode, components, status: 'ready' })

      await sql.transaction((txn) => [
        txn`
          INSERT INTO return_product_catalog_history (
            store_name, store_key, sku_id, old_mapping, new_mapping,
            change_source, tracking_number, changed_by
          )
          SELECT
            ${pkg.store_name}, ${pkg.store_key}, ${skuId},
            CASE WHEN catalog.id IS NULL THEN NULL ELSE jsonb_build_object(
              'sku_code', catalog.sku_code,
              'components', catalog.components,
              'status', catalog.status,
              'issue', catalog.issue,
              'mapping_source', catalog.mapping_source,
              'mapping_version', catalog.mapping_version
            ) END,
            ${newMapping}::jsonb,
            'returns_set_edit',
            ${pkg.tracking_number},
            ${payload.username}
          FROM (SELECT 1) seed
          LEFT JOIN return_product_catalog catalog
            ON catalog.store_key = ${pkg.store_key}
           AND catalog.sku_id = ${skuId}
        `,
        txn`
          INSERT INTO return_product_catalog (
            store_name, store_key, sku_id, sku_code, components, status, issue,
            source_file, updated_by, updated_at, mapping_source, mapping_version,
            mapping_confirmed_by, mapping_confirmed_at
          ) VALUES (
            ${pkg.store_name}, ${pkg.store_key}, ${skuId}, ${skuCode},
            ${componentData}::jsonb, 'ready', NULL, 'Returns Set Edit',
            ${payload.username}, NOW(), 'admin', 1, ${payload.username}, NOW()
          )
          ON CONFLICT (store_key, sku_id) DO UPDATE SET
            store_name = EXCLUDED.store_name,
            sku_code = EXCLUDED.sku_code,
            components = EXCLUDED.components,
            status = 'ready',
            issue = NULL,
            source_file = EXCLUDED.source_file,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW(),
            mapping_source = 'admin',
            mapping_version = return_product_catalog.mapping_version + 1,
            mapping_confirmed_by = EXCLUDED.mapping_confirmed_by,
            mapping_confirmed_at = NOW()
        `,
        txn`DELETE FROM return_package_items WHERE package_id = ${pkg.id}`,
        ...items.map((item) => txn`
          INSERT INTO return_package_items (
            package_id, sku_id, sku_code, style, color, size,
            expected_qty, source_qty, actual_qty, restock_qty, not_ours_qty
          ) VALUES (
            ${pkg.id}, ${item.sku_id}, ${item.sku_code}, ${item.style}, ${item.color},
            ${item.size}, ${item.expected_qty}, ${item.source_qty}, NULL, NULL, NULL
          )
        `),
        txn`
          UPDATE return_packages
          SET expected_units = ${expectedUnits}
          WHERE id = ${pkg.id} AND status = ${pkg.status}
        `,
      ], { isolationLevel: 'Serializable' })

      return res.json({ ok: true, package: await loadPackage(sql, trackingKey) })
    }

    if (req.method === 'POST' && action === 'resolve-items') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const trackingKey = normalizeTracking(req.body?.tracking)
      if (!trackingKey) return res.status(400).json({ error: 'tracking required' })
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      if (!canResolveReturnItems(pkg)) {
        return res.status(409).json({ error: 'This package does not require item selection' })
      }

      const selections = Array.isArray(req.body?.selections) ? req.body.selections : []
      const orderItems = new Map(
        (pkg.related_orders || []).flatMap((order) => order.items || [])
          .map((item) => [Number(item.id), item]),
      )
      let returnableQuantities = null
      if ((pkg.related_orders || []).length === 1) {
        const [order] = pkg.related_orders
        const returnedProducts = await loadReturnedProductsForOrder(sql, order, pkg.id)
        returnableQuantities = remainingOrderItemQuantities(order.items, returnedProducts)
      }
      const selectedIds = new Set()
      const selectedItems = []
      for (const selection of selections) {
        const orderItemId = Number(selection.orderItemId)
        const quantity = Number(selection.quantity)
        const orderItem = orderItems.get(orderItemId)
        if (
          !Number.isSafeInteger(orderItemId)
          || selectedIds.has(orderItemId)
          || !Number.isSafeInteger(quantity)
          || quantity <= 0
          || !orderItem
          || quantity > Number(orderItem.quantity)
          || (returnableQuantities
            && quantity > Number(returnableQuantities[String(orderItemId)] || 0))
        ) {
          return res.status(400).json({
            error: 'Choose quantities that have not already been matched to another return for this order',
          })
        }
        const catalogReady = orderItem.catalog_status === 'ready'
          && Array.isArray(orderItem.catalog_components)
          && orderItem.catalog_components.length
        let components
        try {
          components = mergeInventoryComponents(
            catalogReady ? orderItem.catalog_components : selection.components,
          )
          if (!components.length) throw new Error('Inventory mapping required')
        } catch {
          return res.status(400).json({
            error: `Choose a complete inventory product for ${orderItem.sku_code || orderItem.sku_id || 'this item'}`,
          })
        }
        selectedIds.add(orderItemId)
        if (!catalogReady) {
          const resolution = await resolveInventoryRows(sql, components.map((component) => ({
            ...component,
            allowCreate: false,
          })))
          if (resolution.missing.length || resolution.ambiguous.length) {
            return res.status(409).json({
              error: `The selected inventory product is missing or duplicated for ${orderItem.sku_code || orderItem.sku_id || 'this item'}`,
            })
          }
          components = mergeInventoryComponents(resolution.rows)
        }
        selectedItems.push({ orderItem, quantity, components, catalogReady })
      }
      const resolvedItems = []
      for (const { orderItem, quantity, components } of selectedItems) {
        for (const component of components) {
          const componentQty = Number(component.qty || 1)
          if (
            !component.style
            || !component.color
            || !component.size
            || !Number.isSafeInteger(componentQty)
            || componentQty <= 0
            || componentQty * quantity > 9999
          ) {
            return res.status(409).json({ error: 'The selected SKU has an invalid inventory mapping' })
          }
          resolvedItems.push({
            sku_id: cleanText(orderItem.sku_id, 100),
            sku_code: cleanText(orderItem.sku_code, 300),
            style: cleanText(component.style, 300),
            color: cleanText(component.color, 300),
            size: cleanText(component.size, 100),
            expected_qty: componentQty * quantity,
            source_qty: quantity,
          })
        }
      }
      if (!resolvedItems.length) {
        return res.status(400).json({ error: 'Select at least one returned product' })
      }

      const manualMappingsBySku = new Map()
      for (const { orderItem, components, catalogReady } of selectedItems) {
        if (catalogReady) continue
        const skuId = cleanText(orderItem.sku_id, 100)
        if (!skuId) continue
        const skuCode = cleanText(orderItem.sku_code, 300)
        const normalizedComponents = mergeInventoryComponents(components)
        const signature = JSON.stringify([...normalizedComponents].sort((left, right) => (
          `${left.style}\u0000${left.color}\u0000${left.size}`
            .localeCompare(`${right.style}\u0000${right.color}\u0000${right.size}`)
        )))
        const existing = manualMappingsBySku.get(skuId)
        if (existing && existing.signature !== signature) {
          return res.status(409).json({
            error: `SKU ${skuCode || skuId} was manually matched to two different inventory combinations`,
          })
        }
        manualMappingsBySku.set(skuId, {
          skuId,
          skuCode,
          components: normalizedComponents,
          signature,
        })
      }
      const manualMappings = [...manualMappingsBySku.values()]
      if (manualMappings.length) {
        const conflicts = await sql`
          WITH wanted AS (
            SELECT value #>> '{}' AS sku_id
            FROM jsonb_array_elements(${JSON.stringify(manualMappings.map((item) => item.skuId))}::jsonb)
          )
          SELECT catalog.sku_id, MIN(catalog.store_name) AS store_name
          FROM return_product_catalog catalog
          JOIN wanted USING (sku_id)
          WHERE catalog.store_key <> ${pkg.store_key}
          GROUP BY catalog.sku_id
          LIMIT 1
        `
        if (conflicts.length) {
          return res.status(409).json({
            error: `SKU ID ${conflicts[0].sku_id} already belongs to ${conflicts[0].store_name}`,
          })
        }
      }

      const items = replaceSelectedReturnPackageItems(
        pkg.items,
        resolvedItems,
        selectedItems.map(({ orderItem }) => orderItem),
      )
      const expectedUnits = items.reduce((sum, item) => sum + item.expected_qty, 0)
      let returnClaims = null
      let returnOrder = null
      if ((pkg.related_orders || []).length === 1) {
        ;[returnOrder] = pkg.related_orders
        const claims = new Map()
        for (const { orderItem, quantity } of selectedItems) {
          const skuId = cleanText(orderItem.sku_id, 100)
          const skuCode = cleanText(orderItem.sku_code, 300)
          const key = skuId ? `id:${skuId}` : `code:${skuCode.toLowerCase()}`
          const existing = claims.get(key) || {
            sku_id: skuId,
            sku_code: skuCode,
            selected_quantity: 0,
            order_quantity: 0,
          }
          existing.selected_quantity += quantity
          claims.set(key, existing)
        }
        for (const orderItem of returnOrder.items || []) {
          const skuId = cleanText(orderItem.sku_id, 100)
          const skuCode = cleanText(orderItem.sku_code, 300)
          const key = skuId ? `id:${skuId}` : `code:${skuCode.toLowerCase()}`
          if (claims.has(key)) claims.get(key).order_quantity += Number(orderItem.quantity || 0)
        }
        returnClaims = JSON.stringify([...claims.values()])
      }

      await sql.transaction((txn) => [
        ...(returnClaims ? [
          txn`SELECT pg_advisory_xact_lock(hashtext(${`return-order:${normalizeOrderNumber(returnOrder.order_number)}`}))`,
          txn`
            WITH claims AS (
              SELECT *
              FROM jsonb_to_recordset(${returnClaims}::jsonb)
                AS claim(
                  sku_id TEXT, sku_code TEXT,
                  selected_quantity INTEGER, order_quantity INTEGER
                )
            ),
            package_products AS (
              SELECT
                packages.id AS package_id,
                items.sku_id,
                items.sku_code,
                MAX(CASE
                  WHEN packages.status IN ('pending', 'needs_review') THEN
                    CASE
                      WHEN items.source_qty IS NOT NULL AND items.source_qty > 0 THEN items.source_qty
                      ELSE items.expected_qty
                    END
                  WHEN COALESCE(items.actual_qty, 0) <= 0 THEN 0
                  WHEN items.source_qty IS NOT NULL AND items.source_qty > 0 AND items.expected_qty > 0
                    THEN CEIL(items.actual_qty::numeric * items.source_qty / items.expected_qty)::int
                  ELSE items.actual_qty
                END)::int AS returned_quantity
              FROM return_packages packages
              JOIN return_package_items items ON items.package_id = packages.id
              WHERE packages.id <> ${pkg.id}
                AND packages.status <> 'rejected'
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(packages.order_numbers) entry(value)
                  WHERE REGEXP_REPLACE(
                    UPPER(REPLACE(entry.value, ' ', '')), '-D[0-9]+$', ''
                  ) = ${normalizeOrderNumber(returnOrder.order_number)}
                )
                AND (
                  ${returnOrder.store_key === COMBINED_ORDER_STORE_KEY}
                  OR packages.store_key = ${returnOrder.store_key}
                )
              GROUP BY packages.id, items.sku_id, items.sku_code
            ),
            violations AS (
              SELECT claims.sku_id, claims.sku_code
              FROM claims
              WHERE claims.selected_quantity + COALESCE((
                SELECT SUM(products.returned_quantity)
                FROM package_products products
                WHERE (
                  claims.sku_id <> '' AND products.sku_id = claims.sku_id
                ) OR (
                  (claims.sku_id = '' OR products.sku_id = '')
                  AND LOWER(products.sku_code) = LOWER(claims.sku_code)
                )
              ), 0) > claims.order_quantity
            )
            SELECT CASE
              WHEN COUNT(*) = 0 THEN 1
              ELSE ('return_order_quantity_changed_' || COUNT(*)::text)::int
            END AS valid
            FROM violations
          `,
        ] : []),
        ...manualMappings.flatMap((mapping) => {
          const componentData = JSON.stringify(mapping.components)
          const newMapping = JSON.stringify({
            sku_code: mapping.skuCode,
            components: mapping.components,
            status: 'ready',
          })
          return [
            txn`
              INSERT INTO return_product_catalog_history (
                store_name, store_key, sku_id, old_mapping, new_mapping,
                change_source, tracking_number, changed_by
              )
              SELECT
                ${pkg.store_name}, ${pkg.store_key}, ${mapping.skuId},
                CASE WHEN catalog.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'sku_code', catalog.sku_code,
                  'components', catalog.components,
                  'status', catalog.status,
                  'issue', catalog.issue,
                  'mapping_source', catalog.mapping_source,
                  'mapping_version', catalog.mapping_version
                ) END,
                ${newMapping}::jsonb,
                'po_manual_match',
                ${pkg.tracking_number},
                ${payload.username}
              FROM (SELECT 1) seed
              LEFT JOIN return_product_catalog catalog
                ON catalog.store_key = ${pkg.store_key}
               AND catalog.sku_id = ${mapping.skuId}
            `,
            txn`
              INSERT INTO return_product_catalog (
                store_name, store_key, sku_id, sku_code, components, status, issue,
                source_file, updated_by, updated_at, mapping_source, mapping_version,
                mapping_confirmed_by, mapping_confirmed_at
              ) VALUES (
                ${pkg.store_name}, ${pkg.store_key}, ${mapping.skuId}, ${mapping.skuCode},
                ${componentData}::jsonb, 'ready', NULL, 'PO Manual Match',
                ${payload.username}, NOW(), 'admin', 1, ${payload.username}, NOW()
              )
              ON CONFLICT (store_key, sku_id) DO UPDATE SET
                store_name = EXCLUDED.store_name,
                sku_code = EXCLUDED.sku_code,
                components = EXCLUDED.components,
                status = 'ready',
                issue = NULL,
                source_file = EXCLUDED.source_file,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW(),
                mapping_source = 'admin',
                mapping_version = return_product_catalog.mapping_version + 1,
                mapping_confirmed_by = EXCLUDED.mapping_confirmed_by,
                mapping_confirmed_at = NOW()
            `,
          ]
        }),
        txn`DELETE FROM return_package_items WHERE package_id = ${pkg.id}`,
        ...items.map((item) => txn`
          INSERT INTO return_package_items (
            package_id, sku_id, sku_code, style, color, size,
            expected_qty, source_qty, actual_qty, restock_qty, not_ours_qty
          )
          VALUES (
            ${pkg.id}, ${item.sku_id}, ${item.sku_code}, ${item.style}, ${item.color},
            ${item.size}, ${item.expected_qty}, ${item.source_qty}, NULL, NULL, NULL
          )
        `),
        txn`
          UPDATE return_packages
          SET expected_units = ${expectedUnits},
              requires_item_resolution = false,
              review_data = jsonb_set(
                COALESCE(review_data, '{}'::jsonb),
                '{blockingIssues}',
                '[]'::jsonb,
                true
              )
          WHERE id = ${pkg.id} AND status = ${pkg.status}
        `,
      ], { isolationLevel: 'Serializable' })

      return res.json({
        ok: true,
        package: await loadPackage(sql, trackingKey),
        remembered_mappings: manualMappings.length,
      })
    }

    if (req.method === 'POST' && action === 'confirm') {
      const trackingKey = normalizeTracking(req.body?.tracking)
      if (!trackingKey) return res.status(400).json({ error: 'tracking required' })
      const pkg = await loadPackage(sql, trackingKey)
      if (!pkg) return res.status(404).json({ error: 'Tracking is not in the uploaded return manifest' })
      const adminReview = payload.role === 'admin' && pkg.status === 'needs_review'
      if (pkg.status !== 'pending' && !adminReview) {
        return res.status(409).json({ error: 'This return package has already been received or needs admin review' })
      }
      if (pkg.requires_item_resolution) {
        return res.status(409).json({ error: 'Choose the returned products before receiving this package' })
      }

      const actualItems = Array.isArray(req.body?.items) ? req.body.items : []
      const countsById = new Map()
      for (const item of actualItems) {
        const id = Number(item.id)
        const actualQty = Number(item.actualQty)
        const restockQty = Number(item.restockQty)
        const notOursQty = Number(item.notOursQty || 0)
        if (
          !Number.isSafeInteger(id)
          || !Number.isSafeInteger(actualQty)
          || !Number.isSafeInteger(restockQty)
          || !Number.isSafeInteger(notOursQty)
          || actualQty < 0
          || actualQty > 9999
          || restockQty < 0
          || restockQty > actualQty
          || notOursQty < 0
          || notOursQty > 9999
          || countsById.has(id)
        ) {
          return res.status(400).json({
            error: 'Every item requires valid received and restockable quantities; restockable cannot exceed received',
          })
        }
        countsById.set(id, { actualQty, restockQty, notOursQty })
      }
      if (countsById.size !== pkg.items.length || pkg.items.some((item) => !countsById.has(Number(item.id)))) {
        return res.status(400).json({ error: 'Count every expected item before confirming the package' })
      }
      let inspection
      try {
        inspection = summarizeReturnInspection(pkg.items.map((item) => {
          const counts = countsById.get(Number(item.id))
          return {
            expectedQty: Number(item.expected_qty),
            goodQty: counts.restockQty,
            damagedQty: counts.actualQty - counts.restockQty,
            notOursQty: counts.notOursQty,
          }
        }))
      } catch (error) {
        return res.status(400).json({ error: error.message })
      }
      if (payload.role !== 'admin' && inspection.status !== 'received') {
        return res.status(403).json({ error: 'Workers must send any problem to Admin Review' })
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
      const inventoryLockTargets = [...new Map(receivedRows.map((row) => [
        [row.style, row.color, row.size]
          .map((value) => String(value || '').trim().toLowerCase())
          .join('\u0000'),
        { style: row.style, color: row.color, size: row.size },
      ])).values()]
      const packageItemsForValidation = pkg.items.map((item) => ({
        id: String(item.id),
        sku_id: item.sku_id,
        sku_code: item.sku_code,
        style: item.style,
        color: item.color,
        size: item.size,
        expected_qty: Number(item.expected_qty),
        source_qty: item.source_qty == null ? null : Number(item.source_qty),
      }))
      const { actualUnits, restockUnits, notOursUnits, status: finalStatus } = inspection
      const sourceName = `Return ${pkg.tracking_number}`
      const sourceHash = `return-package:${pkg.tracking_key}`
      const remark = String(req.body?.remark || '').trim().slice(0, 1000)

      await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
        txn`
          WITH targets AS (
            SELECT
              (target.ordinality - 1)::int AS target_index,
              target.value->>'style' AS style,
              target.value->>'color' AS color,
              target.value->>'size' AS size
            FROM jsonb_array_elements(${JSON.stringify(inventoryLockTargets)}::jsonb)
              WITH ORDINALITY AS target(value, ordinality)
          ),
          expected_package_items AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(packageItemsForValidation)}::jsonb)
              AS expected(
                id BIGINT, sku_id TEXT, sku_code TEXT, style TEXT, color TEXT, size TEXT,
                expected_qty INTEGER, source_qty INTEGER
              )
          ),
          current_package_items AS MATERIALIZED (
            SELECT
              id, sku_id, sku_code, style, color, size, expected_qty, source_qty
            FROM return_package_items
            WHERE package_id = ${pkg.id}
          ),
          package_item_changes AS (
            SELECT COALESCE(expected.id, current.id) AS id
            FROM expected_package_items expected
            FULL JOIN current_package_items current USING (id)
            WHERE expected.id IS NULL
               OR current.id IS NULL
               OR expected.sku_id IS DISTINCT FROM current.sku_id
               OR expected.sku_code IS DISTINCT FROM current.sku_code
               OR expected.style IS DISTINCT FROM current.style
               OR expected.color IS DISTINCT FROM current.color
               OR expected.size IS DISTINCT FROM current.size
               OR expected.expected_qty IS DISTINCT FROM current.expected_qty
               OR expected.source_qty IS DISTINCT FROM current.source_qty
          ),
          package_validation AS (
            SELECT
              EXISTS (
                SELECT 1
                FROM return_packages
                WHERE id = ${pkg.id}
                  AND status = ${pkg.status}
                  AND requires_item_resolution = false
              )
              AND NOT EXISTS (SELECT 1 FROM package_item_changes) AS valid
          ),
          locked AS MATERIALIZED (
            SELECT target.target_index, inventory.id
            FROM targets target
            JOIN inventory_balance inventory
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
            FOR UPDATE OF inventory
          ),
          validation AS (
            SELECT targets.target_index, COUNT(locked.id)::int AS match_count
            FROM targets
            LEFT JOIN locked USING (target_index)
            GROUP BY targets.target_index
          )
          SELECT CASE
            WHEN NOT (SELECT valid FROM package_validation)
              THEN ('return_package_changed_'
                || (SELECT COUNT(*)::text FROM package_item_changes))::int
            WHEN COUNT(*) FILTER (WHERE match_count = 1) = COUNT(*) THEN 1
            ELSE ('return_inventory_target_changed_' || COUNT(*)::text)::int
          END AS targets_valid
          FROM validation
        `,
        txn`
          WITH claimed AS (
            UPDATE return_packages
            SET status = 'processing'
            WHERE id = ${pkg.id} AND status = ${pkg.status}
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
            applied_by, rollback_snapshot_id, store_name, store_key
          )
          SELECT
            'return', ${sourceName}, ${sourceHash}, ${restockUnits},
            ${receivedRows.length}, ${payload.username}, saved_snapshot.id,
            ${pkg.store_name || ''}, ${pkg.store_key || ''}
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
              transaction_id, txn_type, style, color, size, qty, source_file, applied_by,
              store_name, store_key
            )
            SELECT
              transactions.id, 'return', ${row.style}, ${row.color}, ${row.size},
              ${row.qty}, ${sourceName}, ${payload.username},
              ${pkg.store_name || ''}, ${pkg.store_key || ''}
            FROM inventory_transactions transactions
            WHERE transactions.transaction_type = 'return'
              AND transactions.source_hash = ${sourceHash}
              AND transactions.rolled_back_at IS NULL
          `,
        ]),
        ...pkg.items.map((item) => txn`
          UPDATE return_package_items
          SET actual_qty = ${countsById.get(Number(item.id)).actualQty},
              restock_qty = ${countsById.get(Number(item.id)).restockQty},
              not_ours_qty = ${countsById.get(Number(item.id)).notOursQty}
          WHERE id = ${item.id} AND package_id = ${pkg.id}
        `),
        txn`
          UPDATE return_packages
          SET status = ${finalStatus},
              actual_units = ${actualUnits},
              restock_units = ${restockUnits},
              flagged_not_ours = ${notOursUnits > 0},
              remark = ${remark},
              confirmed_by = ${payload.username},
              confirmed_at = NOW()
          WHERE id = ${pkg.id} AND status = 'processing'
        `,
        txn`
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
              LIMIT 20
          )
        `,
      ], { isolationLevel: 'Serializable' })

      return res.json({
        ok: true,
        status: finalStatus,
        expected_units: Number(pkg.expected_units),
        actual_units: actualUnits,
        restock_units: restockUnits,
        not_ours_units: notOursUnits,
        added_units: restockUnits,
      })
    }

    if (req.method === 'GET' && action === 'integrity') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      const [
        transactionMismatches,
        returnTransactionMismatches,
        catalogTargetMismatches,
        rollbackMismatches,
        pendingOrderArchives,
        rememberedSkuReviews,
        salesCatalogCoverageMismatches,
        duplicateOrderConflicts,
      ] = await Promise.all([
        sql`
          WITH issues AS (
            SELECT
              transactions.id,
              transactions.transaction_type,
              transactions.source_file,
              transactions.applied_units,
              transactions.row_count,
              COALESCE(SUM(rows.qty), 0)::int AS detail_units,
              COUNT(rows.id)::int AS detail_rows
            FROM inventory_transactions transactions
            LEFT JOIN inventory_txn_rows rows ON rows.transaction_id = transactions.id
            WHERE transactions.rolled_back_at IS NULL
            GROUP BY transactions.id
            HAVING COALESCE(transactions.applied_units, 0) <> COALESCE(SUM(rows.qty), 0)
                OR COALESCE(transactions.row_count, 0) <> COUNT(rows.id)
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY id DESC
          LIMIT 20
        `,
        sql`
          WITH item_totals AS (
            SELECT
              package_id,
              COALESCE(SUM(restock_qty), 0)::int AS item_restock_units
            FROM return_package_items
            GROUP BY package_id
          ),
          transaction_totals AS (
            SELECT
              SUBSTRING(source_hash FROM LENGTH('return-package:') + 1) AS tracking_key,
              COUNT(*)::int AS active_transactions,
              COALESCE(SUM(applied_units), 0)::int AS transaction_units
            FROM inventory_transactions
            WHERE transaction_type = 'return'
              AND source_hash LIKE 'return-package:%'
              AND rolled_back_at IS NULL
            GROUP BY 1
          ),
          issues AS (
            SELECT
              packages.tracking_number,
              packages.status,
              packages.restock_units,
              COALESCE(items.item_restock_units, 0)::int AS item_restock_units,
              COALESCE(transactions.active_transactions, 0)::int AS active_transactions,
              COALESCE(transactions.transaction_units, 0)::int AS transaction_units
            FROM return_packages packages
            LEFT JOIN item_totals items ON items.package_id = packages.id
            LEFT JOIN transaction_totals transactions
              ON transactions.tracking_key = packages.tracking_key
            WHERE packages.status IN ('received', 'discrepancy', 'rejected')
              AND (
                COALESCE(transactions.active_transactions, 0) <> 1
                OR packages.restock_units <> COALESCE(items.item_restock_units, 0)
                OR packages.restock_units <> COALESCE(transactions.transaction_units, 0)
              )
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY tracking_number
          LIMIT 20
        `,
        sql`
          WITH component_matches AS (
            SELECT
              catalog.store_name,
              catalog.sku_id,
              component.ordinality::int AS component_number,
              component.value->>'style' AS style,
              component.value->>'color' AS color,
              component.value->>'size' AS size,
              COUNT(inventory.id)::int AS match_count
            FROM return_product_catalog catalog
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(catalog.components) = 'array' THEN catalog.components
                ELSE '[]'::jsonb
              END
            )
              WITH ORDINALITY AS component(value, ordinality)
            LEFT JOIN inventory_balance inventory
              ON LOWER(BTRIM(inventory.style)) = LOWER(BTRIM(component.value->>'style'))
             AND LOWER(BTRIM(inventory.color)) = LOWER(BTRIM(component.value->>'color'))
             AND (
               CASE UPPER(BTRIM(inventory.size))
                 WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
                 ELSE UPPER(BTRIM(inventory.size))
               END
             ) = (
               CASE UPPER(BTRIM(component.value->>'size'))
                 WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
                 ELSE UPPER(BTRIM(component.value->>'size'))
               END
             )
            WHERE catalog.status = 'ready'
            GROUP BY
              catalog.store_name, catalog.sku_id, component.ordinality,
              component.value->>'style', component.value->>'color', component.value->>'size'
          ),
          issues AS (
            SELECT * FROM component_matches WHERE match_count <> 1
            UNION ALL
            SELECT
              catalog.store_name,
              catalog.sku_id,
              0 AS component_number,
              '' AS style,
              '' AS color,
              '' AS size,
              0 AS match_count
            FROM return_product_catalog catalog
            WHERE catalog.status = 'ready'
              AND CASE
                WHEN jsonb_typeof(catalog.components) = 'array'
                  THEN jsonb_array_length(catalog.components) = 0
                ELSE true
              END
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY store_name, sku_id, component_number
          LIMIT 20
        `,
        sql`
          WITH issues AS (
            SELECT
              packages.tracking_number AS reference,
              'rolled_back_return_still_complete' AS issue
            FROM inventory_transactions transactions
            JOIN return_packages packages
              ON transactions.source_hash = 'return-package:' || packages.tracking_key
            WHERE transactions.transaction_type = 'return'
              AND transactions.rolled_back_at IS NOT NULL
              AND packages.status IN ('received', 'discrepancy', 'rejected')
              AND NOT EXISTS (
                SELECT 1
                FROM inventory_transactions active
                WHERE active.transaction_type = 'return'
                  AND active.source_hash = transactions.source_hash
                  AND active.rolled_back_at IS NULL
              )
            UNION ALL
            SELECT
              packages.tracking_number AS reference,
              'active_return_package_not_complete' AS issue
            FROM inventory_transactions transactions
            JOIN return_packages packages
              ON transactions.source_hash = 'return-package:' || packages.tracking_key
            WHERE transactions.transaction_type = 'return'
              AND transactions.rolled_back_at IS NULL
              AND packages.status NOT IN ('received', 'discrepancy', 'rejected')
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY reference
          LIMIT 20
        `,
        sql`
          WITH issues AS (
            SELECT
              source_hash,
              MIN(source_file) AS source_file,
              MIN(store_name) AS store_name,
              COUNT(*)::int AS order_count,
              MAX(updated_at) AS updated_at
            FROM return_orders
            WHERE inventory_status = 'pending'
            GROUP BY source_hash
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY updated_at DESC
          LIMIT 20
        `,
        sql`
          WITH issues AS (
            SELECT
              packages.tracking_number,
              packages.store_name,
              unresolved.value->>'skuId' AS sku_id
            FROM return_packages packages
            CROSS JOIN LATERAL jsonb_array_elements(
              COALESCE(packages.review_data->'unresolvedSkus', '[]'::jsonb)
            ) AS unresolved(value)
            JOIN return_product_catalog catalog
              ON catalog.store_key = packages.store_key
             AND catalog.sku_id = unresolved.value->>'skuId'
             AND catalog.status = 'ready'
            WHERE packages.status = 'needs_review'
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY tracking_number, sku_id
          LIMIT 20
        `,
        sql`
          WITH order_item_candidates AS (
            SELECT
              orders.id AS order_id,
              items.id AS item_id,
              orders.order_number,
              orders.order_key,
              orders.store_key AS order_store_key,
              orders.store_name AS order_store_name,
              orders.inventory_status,
              orders.updated_at AS order_updated_at,
              items.item_key,
              items.sku_id,
              items.sku_code,
              items.quantity,
              LOWER(BTRIM(items.item_key)) AS logical_item_key
            FROM return_orders orders
            JOIN return_order_items items ON items.order_id = orders.id
          ),
          order_item_scope AS (
            SELECT
              candidates.*,
              BOOL_OR(order_store_key = ${COMBINED_ORDER_STORE_KEY}) OVER (
                PARTITION BY order_key
              ) AS has_combined_order,
              BOOL_OR(
                order_store_key = ${COMBINED_ORDER_STORE_KEY}
                AND inventory_status = 'pending'
              ) OVER (PARTITION BY order_key) AS has_pending_combined_order,
              BOOL_OR(
                order_store_key = ${COMBINED_ORDER_STORE_KEY}
                AND inventory_status = 'applied'
              ) OVER (PARTITION BY order_key) AS has_applied_combined_order
            FROM order_item_candidates candidates
          ),
          order_item_sku_metadata AS (
            SELECT
              order_key,
              logical_item_key,
              CASE
                WHEN COUNT(DISTINCT NULLIF(BTRIM(sku_id), '')) = 1
                  THEN MIN(NULLIF(BTRIM(sku_id), ''))
                ELSE NULL
              END AS unique_sku_id
            FROM order_item_candidates
            GROUP BY order_key, logical_item_key
          ),
          ranked_order_items AS (
            SELECT
              scoped.*,
              metadata.unique_sku_id,
              ROW_NUMBER() OVER (
                PARTITION BY
                  order_key,
                  logical_item_key,
                  CASE WHEN has_combined_order THEN 0 ELSE order_id END
                ORDER BY
                  CASE
                    WHEN order_store_key = ${COMBINED_ORDER_STORE_KEY}
                     AND inventory_status = 'applied' THEN 0
                    WHEN order_store_key <> ${COMBINED_ORDER_STORE_KEY}
                     AND inventory_status = 'applied' THEN 1
                    WHEN order_store_key = ${COMBINED_ORDER_STORE_KEY}
                     AND inventory_status = 'pending' THEN 2
                    ELSE 3
                  END,
                  CASE WHEN NULLIF(BTRIM(sku_id), '') IS NOT NULL THEN 0 ELSE 1 END,
                  order_updated_at DESC NULLS LAST,
                  order_id DESC,
                  item_id DESC
              ) AS canonical_rank
            FROM order_item_scope scoped
            JOIN order_item_sku_metadata metadata USING (order_key, logical_item_key)
          ),
          canonical_order_items AS (
            SELECT
              ranked.*,
              COALESCE(
                NULLIF(BTRIM(ranked.sku_id), ''),
                CASE WHEN ranked.has_combined_order THEN ranked.unique_sku_id END
              ) AS resolved_sku_id,
              CASE
                WHEN ranked.has_applied_combined_order THEN true
                WHEN ranked.has_pending_combined_order THEN false
                ELSE ranked.inventory_status = 'applied'
              END AS inventory_reconciled
            FROM ranked_order_items ranked
            WHERE canonical_rank = 1
          ),
          catalog_counts AS (
            SELECT sku_id, COUNT(*)::int AS match_count
            FROM return_product_catalog
            GROUP BY sku_id
          ),
          unique_catalog AS (
            SELECT catalog.*
            FROM return_product_catalog catalog
            JOIN catalog_counts counts USING (sku_id)
            WHERE counts.match_count = 1
          ),
          checked AS (
            SELECT
              items.order_number,
              items.order_store_name,
              items.resolved_sku_id AS sku_id,
              items.sku_code,
              items.quantity,
              catalog.store_name AS catalog_store_name,
              CASE
                WHEN items.resolved_sku_id IS NULL THEN 'sku_id_missing'
                WHEN counts.sku_id IS NULL THEN 'catalog_missing'
                WHEN counts.match_count <> 1 THEN 'catalog_ambiguous'
                WHEN items.order_store_key <> ${COMBINED_ORDER_STORE_KEY}
                 AND catalog.store_key IS DISTINCT FROM items.order_store_key
                  THEN 'catalog_store_mismatch'
                WHEN catalog.status IS DISTINCT FROM 'ready' THEN 'catalog_not_ready'
                WHEN CASE
                  WHEN jsonb_typeof(catalog.components) = 'array'
                    THEN jsonb_array_length(catalog.components) = 0
                  ELSE true
                END THEN 'catalog_components_missing'
                WHEN EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(catalog.components) = 'array' THEN catalog.components
                      ELSE '[]'::jsonb
                    END
                  ) component(value)
                  WHERE NULLIF(BTRIM(component.value->>'style'), '') IS NULL
                     OR NULLIF(BTRIM(component.value->>'color'), '') IS NULL
                     OR NULLIF(BTRIM(component.value->>'size'), '') IS NULL
                     OR COALESCE(component.value->>'qty', '') !~ '^[1-9][0-9]{0,3}$'
                ) THEN 'catalog_components_invalid'
                ELSE NULL
              END AS issue
            FROM canonical_order_items items
            LEFT JOIN catalog_counts counts ON counts.sku_id = items.resolved_sku_id
            LEFT JOIN unique_catalog catalog ON catalog.sku_id = items.resolved_sku_id
          ),
          issues AS (
            SELECT * FROM checked WHERE issue IS NOT NULL
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY order_number, sku_id
          LIMIT 20
        `,
        sql`
          WITH order_signatures AS (
            SELECT
              orders.id AS order_id,
              orders.order_number,
              orders.order_key,
              orders.store_name,
              orders.store_key,
              COUNT(*)::int AS item_count,
              jsonb_agg(
                LOWER(BTRIM(items.item_key))
                ORDER BY LOWER(BTRIM(items.item_key)), items.id
              ) AS item_keys,
              jsonb_agg(
                jsonb_build_array(LOWER(BTRIM(items.item_key)), items.quantity)
                ORDER BY LOWER(BTRIM(items.item_key)), items.id
              ) AS quantities,
              jsonb_agg(
                jsonb_build_array(
                  LOWER(BTRIM(items.item_key)),
                  NULLIF(BTRIM(items.sku_id), '')
                )
                ORDER BY LOWER(BTRIM(items.item_key)), items.id
              ) AS sku_ids
            FROM return_orders orders
            JOIN return_order_items items ON items.order_id = orders.id
            GROUP BY
              orders.id, orders.order_number, orders.order_key,
              orders.store_name, orders.store_key
          ),
          combined_orders AS (
            SELECT *
            FROM order_signatures
            WHERE store_key = ${COMBINED_ORDER_STORE_KEY}
          ),
          historical_orders AS (
            SELECT *
            FROM order_signatures
            WHERE store_key <> ${COMBINED_ORDER_STORE_KEY}
          ),
          issues AS (
            SELECT
              combined.order_number,
              historical.store_name AS historical_store,
              combined.item_count AS daily_item_count,
              historical.item_count AS historical_item_count,
              CASE
                WHEN combined.item_keys IS DISTINCT FROM historical.item_keys
                  THEN 'item_set_mismatch'
                WHEN combined.quantities IS DISTINCT FROM historical.quantities
                 AND combined.sku_ids IS DISTINCT FROM historical.sku_ids
                  THEN 'quantity_and_sku_mismatch'
                WHEN combined.quantities IS DISTINCT FROM historical.quantities
                  THEN 'quantity_mismatch'
                ELSE 'sku_mismatch'
              END AS issue
            FROM combined_orders combined
            JOIN historical_orders historical USING (order_key)
            WHERE combined.item_keys IS DISTINCT FROM historical.item_keys
               OR combined.quantities IS DISTINCT FROM historical.quantities
               OR combined.sku_ids IS DISTINCT FROM historical.sku_ids
          )
          SELECT issues.*, COUNT(*) OVER()::int AS issue_count
          FROM issues
          ORDER BY order_number, historical_store
          LIMIT 20
        `,
      ])
      const check = (id, label, rows, severity = 'error') => ({
        id,
        label,
        severity,
        issue_count: Number(rows[0]?.issue_count || 0),
        examples: rows.map(({ issue_count: ignored, ...row }) => row),
      })
      const checks = [
        check('transaction_totals', 'Transaction total equals detail rows', transactionMismatches),
        check('return_transactions', 'Completed return has one matching inventory transaction', returnTransactionMismatches),
        check('catalog_targets', 'Ready product mappings point to one inventory SKU', catalogTargetMismatches),
        check('rollback_state', 'Rollback and package status agree', rollbackMismatches),
        check('pending_orders', 'Order archives waiting for inventory apply', pendingOrderArchives, 'warning'),
        check('remembered_reviews', 'Remembered SKUs still waiting in Admin Review', rememberedSkuReviews, 'warning'),
        check(
          'sales_catalog_coverage',
          'Canonical order items have one ready product catalog mapping',
          salesCatalogCoverageMismatches,
          'warning',
        ),
        check(
          'duplicate_order_conflicts',
          'Duplicate daily and historical order items agree',
          duplicateOrderConflicts,
          'warning',
        ),
      ]
      return res.json({
        ok: checks.every((item) => item.issue_count === 0),
        checked_at: new Date().toISOString(),
        checks,
      })
    }

    if (req.method === 'GET' && action === 'analytics') {
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
      return await respondWithReturnAnalytics(sql, req, res)
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (error) {
    console.error('[/api/returns]', error.message)
    if (/return_inventory_target_changed/.test(error.message)) {
      return res.status(409).json({
        error: 'One or more inventory targets changed before the return could be saved. Refresh the package and try again.',
      })
    }
    if (/return_package_changed/.test(error.message)) {
      return res.status(409).json({
        error: 'This return package changed while it was being saved. Refresh the package and confirm it again.',
      })
    }
    if (/return_order_quantity_changed/.test(error.message)) {
      return res.status(409).json({
        error: 'Another return already matched these products. Reopen the PO to see the remaining quantities.',
      })
    }
    if (/could not serialize access|serialization failure/i.test(error.message)) {
      return res.status(409).json({
        error: 'Inventory or return data changed while it was being saved. Refresh and try again.',
      })
    }
    if (/division by zero|inventory_transactions_active_source_hash_uq/.test(error.message)) {
      return res.status(409).json({ error: 'This return package was already received. Inventory was not changed.' })
    }
    return res.status(500).json({ error: error.message })
  }
}
