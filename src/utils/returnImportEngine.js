import { consolidateRows } from './consolidateEngine.js'
import { fillTemplate } from './autoDeductEngine.js'

const TRACKING_ALIASES = [
  'Tracking', 'Tracking Number', 'Tracking No', 'Return Tracking',
  '运单号 Tracking Number', '退货运单号', '运单号', '物流单号',
]
const SKU_ID_ALIASES = ['SKU ID', 'SKUID', 'SKU_ID']
const SKU_CODE_ALIASES = ['SKU货号', 'SKU', 'SKU Code', 'Style']
const PO_ALIASES = ['订单号 PO', 'PO', '订单号', 'Order Number']
const REASON_ALIASES = ['退货原因', 'Return Reason']
const REMARK_ALIASES = ['买家备注', 'Buyer Remark', 'Buyer Note']
const CARRIER_ALIASES = ['物流商', 'Carrier']
const QUANTITY_ALIASES = ['Quantity', 'Qty', '数量', '应履约件数', '商品数量']

const CONFIRMED_SHORTHAND_COMBOS = [
  {
    pattern: /^0015DenimDustyWhite(S|M|L|XL)$/i,
    colors: ['Denim', 'Dusty Blue', 'White'],
  },
  {
    pattern: /^0015WhtKhakiBk(S|M|L|XL)$/i,
    colors: ['White', 'Khaki', 'Black'],
  },
]

function findKey(row, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return Object.keys(row).find((key) => wanted.has(key.trim().toLowerCase()))
}

export function normalizeTracking(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase()
}

export function expandConfirmedProductSku(value) {
  const skuCode = String(value || '').trim()
  for (const rule of CONFIRMED_SHORTHAND_COMBOS) {
    const match = skuCode.match(rule.pattern)
    if (match) return `0015${rule.colors.join('&')}${match[1].toUpperCase()}`
  }
  return skuCode
}

export function parseProductCatalogRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Product file is empty')
  const skuIdKey = findKey(rows[0], SKU_ID_ALIASES)
  const skuCodeKey = findKey(rows[0], SKU_CODE_ALIASES)
  if (!skuIdKey || !skuCodeKey) throw new Error('Product file requires SKU ID and SKU货号 columns')

  const seen = new Set()
  return rows.map((row, index) => {
    const skuId = String(row[skuIdKey] ?? '').trim()
    const skuCode = String(row[skuCodeKey] ?? '').trim()
    if (!skuId || !skuCode) throw new Error(`Product row ${index + 2} is missing SKU ID or SKU货号`)
    if (seen.has(skuId)) throw new Error(`SKU ID ${skuId} appears more than once in this file`)
    seen.add(skuId)
    return { skuId, skuCode }
  })
}

export function resolveProductCatalogRows(catalogRows, templateRows, aliases = {}) {
  return catalogRows.map((catalogRow) => {
    const consolidated = consolidateRows([{
      SKU: expandConfirmedProductSku(catalogRow.skuCode),
      Quantity: 1,
    }])
    if (consolidated.needsReview.length) {
      return {
        ...catalogRow,
        status: 'review',
        issue: consolidated.needsReview[0].parse_issue || 'sku_parse_failed',
        components: [],
      }
    }
    const result = fillTemplate(templateRows, consolidated.consolidated, aliases)
    if (result.unmatchedRows.length) {
      return {
        ...catalogRow,
        status: 'review',
        issue: result.unmatchedRows[0].parseIssue || 'inventory_target_missing',
        components: [],
      }
    }
    return {
      ...catalogRow,
      status: 'ready',
      issue: '',
      components: result.filledRows
        .filter((row) => Number(row.QTY) > 0)
        .map((row) => ({
          style: row.STYLE,
          color: row.COLOR,
          size: row.SIZE,
          qty: Number(row.QTY),
        })),
    }
  })
}

export function parseSkuReturnManifestRows(rows, catalogRows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Return file is empty')
  const trackingKey = findKey(rows[0], TRACKING_ALIASES)
  const skuIdKey = findKey(rows[0], SKU_ID_ALIASES)
  if (!trackingKey || !skuIdKey) {
    throw new Error('Return file requires Tracking Number and SKU ID columns')
  }
  const poKey = findKey(rows[0], PO_ALIASES)
  const reasonKey = findKey(rows[0], REASON_ALIASES)
  const remarkKey = findKey(rows[0], REMARK_ALIASES)
  const carrierKey = findKey(rows[0], CARRIER_ALIASES)
  const quantityKey = findKey(rows[0], QUANTITY_ALIASES)
  const catalog = new Map((catalogRows || []).map((row) => [String(row.sku_id || row.skuId), row]))
  const groups = new Map()
  const needsReview = []

  rows.forEach((row, index) => {
    const excelRow = index + 2
    const trackingNumber = String(row[trackingKey] ?? '').trim()
    const tracking = normalizeTracking(trackingNumber)
    const skuId = String(row[skuIdKey] ?? '').trim()
    const rawQty = quantityKey ? row[quantityKey] : 1
    const quantity = rawQty === '' || rawQty == null ? 1 : Number(rawQty)
    if (!tracking) {
      needsReview.push({ tracking: '', excelRow, skuId, parse_issue: 'tracking_missing' })
      return
    }
    const group = groups.get(tracking) || {
      tracking,
      trackingNumber,
      items: [],
      orders: new Set(),
      reasons: new Set(),
      buyerRemarks: new Set(),
      carriers: new Set(),
      review: [],
    }
    if (!skuId) {
      group.review.push({ tracking: trackingNumber, excelRow, skuId, parse_issue: 'sku_id_missing' })
    } else if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      group.review.push({ tracking: trackingNumber, excelRow, skuId, parse_issue: 'quantity_invalid' })
    } else {
      const product = catalog.get(skuId)
      if (!product) {
        group.review.push({ tracking: trackingNumber, excelRow, skuId, parse_issue: 'sku_id_not_in_store_catalog' })
      } else if (product.status !== 'ready' || !Array.isArray(product.components) || !product.components.length) {
        group.review.push({ tracking: trackingNumber, excelRow, skuId, parse_issue: product.issue || 'sku_mapping_needs_review' })
      } else {
        product.components.forEach((component) => {
          group.items.push({
            skuId,
            skuCode: product.sku_code || product.skuCode,
            style: component.style,
            color: component.color,
            size: component.size,
            expectedQty: Number(component.qty || 1) * quantity,
          })
        })
      }
    }
    if (poKey && row[poKey]) group.orders.add(String(row[poKey]).trim())
    if (reasonKey && row[reasonKey]) group.reasons.add(String(row[reasonKey]).trim())
    if (remarkKey && row[remarkKey]) group.buyerRemarks.add(String(row[remarkKey]).trim())
    if (carrierKey && row[carrierKey]) group.carriers.add(String(row[carrierKey]).trim())
    groups.set(tracking, group)
  })

  const packages = []
  for (const group of groups.values()) {
    if (group.review.length) {
      needsReview.push(...group.review)
      continue
    }
    packages.push({
      tracking: group.tracking,
      trackingNumber: group.trackingNumber,
      orders: [...group.orders],
      reasons: [...group.reasons],
      buyerRemarks: [...group.buyerRemarks],
      carrier: [...group.carriers].join(', '),
      items: group.items,
      expectedUnits: group.items.reduce((sum, item) => sum + item.expectedQty, 0),
    })
  }

  return {
    packages,
    needsReview,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking || `row:${row.excelRow}`)).size,
    },
  }
}

export function parseReturnManifestRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Return file is empty')
  const trackingKey = findKey(rows[0], TRACKING_ALIASES)
  if (!trackingKey) throw new Error('Could not find a Tracking/运单号 column')

  const groups = new Map()
  rows.forEach((row, index) => {
    const trackingNumber = String(row[trackingKey] || '').trim()
    const tracking = normalizeTracking(trackingNumber)
    if (!tracking) throw new Error(`Row ${index + 2} is missing a tracking number`)
    const group = groups.get(tracking) || { tracking, trackingNumber, rows: [] }
    group.rows.push(row)
    groups.set(tracking, group)
  })

  const packages = []
  const needsReview = []
  for (const group of groups.values()) {
    const result = consolidateRows(group.rows)
    if (result.needsReview.length) {
      needsReview.push(...result.needsReview.map((row) => ({
        tracking: group.trackingNumber,
        ...row,
      })))
    }
    const items = result.consolidated
      .filter((row) => row.QTY > 0)
      .map((row) => ({
        style: row.style,
        color: row.color,
        size: row.size,
        expectedQty: row.QTY,
        packCount: row.pack_count || 1,
        parseIssue: row.parse_issue || '',
      }))
    if (!items.length) throw new Error(`Tracking ${group.trackingNumber} has no return units`)
    packages.push({
      tracking: group.tracking,
      trackingNumber: group.trackingNumber,
      items,
      expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    })
  }

  return {
    packages,
    needsReview,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking)).size,
    },
  }
}

export function resolveReturnManifestPackages(parsed, templateRows, aliases = {}) {
  const packages = []
  const needsReview = []
  for (const pkg of parsed.packages || []) {
    const result = fillTemplate(
      templateRows,
      pkg.items.map((item) => ({
        style: item.style,
        color: item.color,
        size: item.size,
        QTY: item.expectedQty,
        pack_count: item.packCount,
        parse_issue: item.parseIssue,
      })),
      aliases,
    )
    if (result.unmatchedRows.length) {
      needsReview.push(...result.unmatchedRows.map((row) => ({
        tracking: pkg.trackingNumber,
        raw_style: `${row.style} / ${row.color} / ${row.size}`,
        ...row,
        parse_issue: row.parseIssue || 'inventory_target_missing',
      })))
      continue
    }
    const items = result.filledRows
      .filter((row) => Number(row.QTY) > 0)
      .map((row) => ({
        style: row.STYLE,
        color: row.COLOR,
        size: row.SIZE,
        expectedQty: Number(row.QTY),
      }))
    packages.push({
      ...pkg,
      items,
      expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    })
  }
  return {
    packages,
    needsReview,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking)).size,
    },
  }
}
