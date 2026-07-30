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

export function chooseReturnManifestSheetName(sheetNames = []) {
  const names = Array.isArray(sheetNames) ? sheetNames : []
  return names.find((name) => String(name).trim() === '退货明细汇总')
    || names.find((name) => String(name).trim().toUpperCase() === 'TEMU-STYLES')
    || names[0]
    || ''
}

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

function normalizeOrderNumber(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/-D\d+$/, '')
}

export function getReturnManifestOrderNumbers(rows) {
  if (!Array.isArray(rows) || !rows.length) return []
  const poKey = findKey(rows[0], PO_ALIASES)
  if (!poKey) return []
  return [...new Set(rows
    .map((row) => String(row[poKey] ?? '').trim())
    .filter(Boolean))]
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
    const sourceComponents = [
      ...consolidated.consolidated.map((row) => ({
        style: row.style,
        color: row.color,
        size: row.size,
        qty: Number(row.QTY || 1),
      })),
      ...consolidated.needsReview.map((row) => ({
        style: row.style,
        color: row.color,
        size: row.size,
        qty: Number(row.QTY || row.qty || 1),
      })),
    ]
    if (consolidated.needsReview.length) {
      return {
        ...catalogRow,
        status: 'review',
        issue: consolidated.needsReview[0].parse_issue || 'sku_parse_failed',
        components: [],
        sourceComponents,
      }
    }
    const result = fillTemplate(templateRows, consolidated.consolidated, aliases)
    if (result.unmatchedRows.length) {
      return {
        ...catalogRow,
        status: 'review',
        issue: result.unmatchedRows[0].parseIssue || 'inventory_target_missing',
        components: [],
        sourceComponents,
      }
    }
    return {
      ...catalogRow,
      status: 'ready',
      issue: '',
      sourceComponents,
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

export function suggestProductCatalogSelections(sourceComponents, inventoryRows, aliases = {}) {
  return (sourceComponents || []).map((source) => {
    const result = fillTemplate(inventoryRows, [{
      style: source.style,
      color: source.color,
      size: source.size,
      qty: 1,
    }], aliases)
    const targets = result.filledRows.filter((row) => Number(row.QTY) > 0)
    if (result.unmatchedRows.length || targets.length !== 1 || Number(targets[0].QTY) !== 1) {
      return {}
    }
    return {
      style: targets[0].STYLE,
      color: targets[0].COLOR,
      matchedBy: result.matchLog[0]?.via || 'inventory',
    }
  })
}

function normalizedSize(value) {
  const size = String(value || '').trim().toUpperCase()
  if (size === '1XL') return '1X'
  if (size === '2XL') return '2X'
  if (size === '3XL') return '3X'
  return size
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase()
}

function expandSkuManifestRows(rows, skuIdKey) {
  return rows.flatMap((row, index) => {
    const skuIds = String(row[skuIdKey] ?? '')
      .split(/\r?\n|[;；]/)
      .map((value) => value.trim())
      .filter(Boolean)
    const values = skuIds.length ? skuIds : ['']
    return values.map((skuId) => ({
      row: { ...row, [skuIdKey]: skuId },
      excelRow: index + 2,
    }))
  })
}

export function applyProductCatalogMapping(catalogRows, skuId, selections, inventoryRows) {
  const selectedRow = (catalogRows || []).find((row) => String(row.skuId) === String(skuId))
  if (!selectedRow) throw new Error('SKU is no longer in this product file')
  if (!selectedRow.sourceComponents?.length) throw new Error('This SKU could not be split into source components')
  if (!Array.isArray(selections) || selections.length !== selectedRow.sourceComponents.length) {
    throw new Error('Choose an inventory style and color for every component')
  }

  const rules = new Map()
  selectedRow.sourceComponents.forEach((source, index) => {
    const selection = selections[index] || {}
    const matches = (inventoryRows || []).filter((target) =>
      normalizedIdentity(target.STYLE) === normalizedIdentity(selection.style)
      && normalizedIdentity(target.COLOR) === normalizedIdentity(selection.color)
      && normalizedSize(target.SIZE) === normalizedSize(source.size)
    )
    if (matches.length !== 1) {
      throw new Error(
        `${source.style} / ${source.color} / ${source.size} requires one exact inventory target`,
      )
    }
    rules.set(
      `${normalizedIdentity(source.style)}\u241f${normalizedIdentity(source.color)}`,
      { style: matches[0].STYLE, color: matches[0].COLOR },
    )
  })

  const updatedSkuIds = []
  const rows = (catalogRows || []).map((row) => {
    if (row.status === 'ready' || !row.sourceComponents?.length) return row
    const components = []
    for (const source of row.sourceComponents) {
      const rule = rules.get(
        `${normalizedIdentity(source.style)}\u241f${normalizedIdentity(source.color)}`,
      )
      if (!rule) return row
      const matches = (inventoryRows || []).filter((target) =>
        normalizedIdentity(target.STYLE) === normalizedIdentity(rule.style)
        && normalizedIdentity(target.COLOR) === normalizedIdentity(rule.color)
        && normalizedSize(target.SIZE) === normalizedSize(source.size)
      )
      if (matches.length !== 1) return row
      components.push({
        style: matches[0].STYLE,
        color: matches[0].COLOR,
        size: matches[0].SIZE,
        qty: Number(source.qty || 1),
      })
    }
    updatedSkuIds.push(row.skuId)
    return { ...row, status: 'ready', issue: '', components }
  })

  return { rows, updatedSkuIds }
}

export function parseSkuReturnManifestRows(rows, catalogRows, historicalOrders = []) {
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
  const orders = new Map((historicalOrders || []).map((order) => [
    normalizeOrderNumber(order.order_number || order.orderNumber),
    order,
  ]))
  const manifestRows = expandSkuManifestRows(rows, skuIdKey)
  const explicitSkuIdsByTracking = new Map()
  for (const { row } of manifestRows) {
    const tracking = normalizeTracking(row[trackingKey])
    const skuId = String(row[skuIdKey] ?? '').trim()
    if (!tracking || !skuId) continue
    if (!explicitSkuIdsByTracking.has(tracking)) explicitSkuIdsByTracking.set(tracking, new Set())
    explicitSkuIdsByTracking.get(tracking).add(skuId)
  }
  const groups = new Map()
  const needsReview = []
  const waitingForTracking = []

  manifestRows.forEach(({ row, excelRow }) => {
    const trackingNumber = String(row[trackingKey] ?? '').trim()
    const tracking = normalizeTracking(trackingNumber)
    const skuId = String(row[skuIdKey] ?? '').trim()
    const orderNumber = poKey ? String(row[poKey] ?? '').trim() : ''
    const rawQty = quantityKey ? row[quantityKey] : 1
    const quantity = rawQty === '' || rawQty == null ? 1 : Number(rawQty)
    if (!tracking) {
      waitingForTracking.push({
        excelRow,
        orderNumber,
        skuId,
        parse_issue: 'tracking_pending',
      })
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
      recoveredOrders: new Set(),
      candidateOrders: [],
      review: [],
    }
    if (orderNumber) group.orders.add(orderNumber)
    if (reasonKey && row[reasonKey]) group.reasons.add(String(row[reasonKey]).trim())
    if (remarkKey && row[remarkKey]) group.buyerRemarks.add(String(row[remarkKey]).trim())
    if (carrierKey && row[carrierKey]) group.carriers.add(String(row[carrierKey]).trim())

    if (!skuId) {
      const orderKey = normalizeOrderNumber(orderNumber)
      const historicalOrder = orders.get(orderKey)
      if (!orderKey) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: 'sku_id_missing',
        })
      } else if (!historicalOrder?.items?.length) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: 'order_history_missing',
        })
      } else if (
        !group.recoveredOrders.has(orderKey)
        && !group.candidateOrders.some((order) => order.orderKey === orderKey)
      ) {
        const candidates = historicalOrder.items.flatMap((orderItem, itemIndex) => {
          const recoveredSkuId = String(orderItem.sku_id || orderItem.skuId || '').trim()
          const recoveredQuantity = Number(orderItem.quantity)
          const product = catalog.get(recoveredSkuId)
          if (explicitSkuIdsByTracking.get(tracking)?.has(recoveredSkuId)) return []
          let issue = ''
          if (!recoveredSkuId) {
            issue = 'order_item_sku_missing'
          } else if (!Number.isSafeInteger(recoveredQuantity) || recoveredQuantity <= 0) {
            issue = 'order_quantity_invalid'
          } else if (!product) {
            issue = 'sku_id_not_in_store_catalog'
          } else if (product.status !== 'ready' || !Array.isArray(product.components) || !product.components.length) {
            issue = product.issue || 'sku_mapping_needs_review'
          }
          return [{
            candidateKey: `${orderKey}\u241f${
              orderItem.id || orderItem.item_key || orderItem.itemKey || itemIndex
            }`,
            skuId: recoveredSkuId,
            skuCode: String(
              orderItem.sku_code || orderItem.skuCode || product?.sku_code || product?.skuCode || '',
            ).trim(),
            attributes: String(orderItem.attributes || '').trim(),
            maxQuantity: recoveredQuantity,
            status: issue ? 'review' : 'ready',
            issue,
            components: issue ? [] : product.components,
          }]
        })

        if (!candidates.length) {
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId: '',
            parse_issue: 'missing_sku_ambiguous',
          })
        } else if (candidates.length === 1 && candidates[0].status === 'ready') {
          const candidate = candidates[0]
          candidate.components.forEach((component) => {
            group.items.push({
              skuId: candidate.skuId,
              skuCode: candidate.skuCode,
              style: component.style,
              color: component.color,
              size: component.size,
              expectedQty: Number(component.qty || 1) * candidate.maxQuantity,
            })
          })
          group.recoveredOrders.add(orderKey)
        } else if (candidates.length === 1) {
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId: candidates[0].skuId,
            parse_issue: candidates[0].issue,
          })
        } else {
          group.candidateOrders.push({ orderNumber, orderKey, candidates })
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId: '',
            candidateCount: candidates.length,
            parse_issue: 'order_has_multiple_skus',
          })
        }
      }
    } else if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      group.review.push({
        tracking: trackingNumber,
        excelRow,
        orderNumber,
        skuId,
        parse_issue: 'quantity_invalid',
      })
    } else {
      const product = catalog.get(skuId)
      if (!product) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: 'sku_id_not_in_store_catalog',
        })
      } else if (product.status !== 'ready' || !Array.isArray(product.components) || !product.components.length) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: product.issue || 'sku_mapping_needs_review',
        })
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
    groups.set(tracking, group)
  })

  const packages = []
  const reviewPackages = []
  const pendingOrderMatches = []
  for (const group of groups.values()) {
    if (group.review.length) {
      needsReview.push(...group.review)
      reviewPackages.push({
        tracking: group.tracking,
        trackingNumber: group.trackingNumber,
        orders: [...group.orders],
        reasons: [...group.reasons],
        buyerRemarks: [...group.buyerRemarks],
        carrier: [...group.carriers].join(', '),
        items: group.items,
        expectedUnits: group.items.reduce((sum, item) => sum + item.expectedQty, 0),
        reviewReason: [...new Set(group.review.map((row) => row.parse_issue))].join(','),
        requiresItemResolution: true,
      })
      if (
        group.candidateOrders.length
        && group.review.every((row) => row.parse_issue === 'order_has_multiple_skus')
      ) {
        pendingOrderMatches.push({
          tracking: group.tracking,
          trackingNumber: group.trackingNumber,
          orders: [...group.orders],
          reasons: [...group.reasons],
          buyerRemarks: [...group.buyerRemarks],
          carrier: [...group.carriers].join(', '),
          baseItems: group.items,
          candidateOrders: group.candidateOrders,
        })
      }
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
      recoveredFromOrders: [...group.recoveredOrders],
    })
  }

  return {
    packages,
    reviewPackages,
    needsReview,
    waitingForTracking,
    pendingOrderMatches,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking || `row:${row.excelRow}`)).size,
      waitingForTracking: waitingForTracking.length,
      recoveredPackages: packages.filter((pkg) => pkg.recoveredFromOrders.length > 0).length,
    },
  }
}

export function applyReturnOrderMatch(parsed, tracking, quantities) {
  const trackingKey = normalizeTracking(tracking)
  const match = (parsed.pendingOrderMatches || []).find((item) => item.tracking === trackingKey)
  if (!match) throw new Error('Order candidates are no longer available for this package')

  const selectedItems = []
  const recoveredOrders = new Set()
  for (const order of match.candidateOrders) {
    for (const candidate of order.candidates) {
      const quantity = Number(quantities?.[candidate.candidateKey] || 0)
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > candidate.maxQuantity) {
        throw new Error(`Choose a whole-number quantity from 0 to ${candidate.maxQuantity}`)
      }
      if (!quantity) continue
      if (candidate.status !== 'ready') {
        throw new Error(`${candidate.skuCode || candidate.skuId} still needs product mapping`)
      }
      recoveredOrders.add(order.orderKey)
      candidate.components.forEach((component) => {
        selectedItems.push({
          skuId: candidate.skuId,
          skuCode: candidate.skuCode,
          style: component.style,
          color: component.color,
          size: component.size,
          expectedQty: Number(component.qty || 1) * quantity,
        })
      })
    }
  }
  if (!selectedItems.length) throw new Error('Select at least one SKU from the original order')

  const itemsByKey = new Map()
  for (const item of [...(match.baseItems || []), ...selectedItems]) {
    const key = [item.skuId, item.style, item.color, item.size]
      .map((value) => String(value || '').trim().toLowerCase())
      .join('\u241f')
    const existing = itemsByKey.get(key)
    if (existing) existing.expectedQty += Number(item.expectedQty)
    else itemsByKey.set(key, { ...item, expectedQty: Number(item.expectedQty) })
  }
  const items = [...itemsByKey.values()]
  const pkg = {
    tracking: match.tracking,
    trackingNumber: match.trackingNumber,
    orders: match.orders,
    reasons: match.reasons,
    buyerRemarks: match.buyerRemarks,
    carrier: match.carrier,
    items,
    expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    recoveredFromOrders: [...recoveredOrders],
  }
  const packages = [...(parsed.packages || []), pkg]
  const pendingOrderMatches = (parsed.pendingOrderMatches || [])
    .filter((item) => item.tracking !== trackingKey)
  const needsReview = (parsed.needsReview || []).filter((row) =>
    normalizeTracking(row.tracking) !== trackingKey
    || row.parse_issue !== 'order_has_multiple_skus'
  )

  return {
    ...parsed,
    packages,
    pendingOrderMatches,
    needsReview,
    stats: {
      ...parsed.stats,
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, item) => sum + item.expectedUnits, 0),
      reviewPackages: new Set(
        needsReview.map((row) => row.tracking || `row:${row.excelRow}`),
      ).size,
      recoveredPackages: packages.filter(
        (item) => (item.recoveredFromOrders || []).length > 0,
      ).length,
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
