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

function normalizeStoreKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function mergeAnalyticsReturnStores(analyticsStores = [], returnStores = []) {
  const returnStats = new Map((returnStores || []).map((store) => [
    normalizeStoreKey(store.store_key || store.store_name),
    store,
  ]))

  return (analyticsStores || [])
    .map((store) => {
      const name = String(store?.name || '').trim()
      if (!name) return null
      const storeKey = normalizeStoreKey(name)
      const stats = returnStats.get(storeKey) || {}
      return {
        ...stats,
        analytics_days: Number(store.days || 0),
        analytics_first_day: store.first_day || null,
        analytics_last_day: store.last_day || null,
        store_key: storeKey,
        store_name: name,
        product_count: Number(stats.product_count || 0),
        ready_count: Number(stats.ready_count || 0),
        order_count: Number(stats.order_count || 0),
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.store_name.localeCompare(right.store_name))
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

export function resolveStyleSearchValue(options, rawValue) {
  const value = String(rawValue ?? '')
  const normalized = value.trim().toLowerCase()
  if (!normalized) return ''
  const exact = (options || []).find((option) => (
    String(option || '').trim().toLowerCase() === normalized
  ))
  return exact || value.trim()
}

export function getReturnManifestSkuIds(rows) {
  if (!Array.isArray(rows) || !rows.length) return []
  const skuIdKey = findKey(rows[0], SKU_ID_ALIASES)
  if (!skuIdKey) return []
  return [...new Set(rows.flatMap((row) => splitSkuIds(row[skuIdKey])).filter(Boolean))]
}

export function getHistoricalOrderSkuIds(historicalOrders) {
  if (!Array.isArray(historicalOrders) || !historicalOrders.length) return []
  return [...new Set(historicalOrders
    .flatMap((order) => Array.isArray(order?.items) ? order.items : [])
    .map((item) => String(item?.sku_id || item?.skuId || '').trim())
    .filter(Boolean))]
}

export function getHistoricalOrderSkuCodes(historicalOrders) {
  if (!Array.isArray(historicalOrders) || !historicalOrders.length) return []
  return [...new Set(historicalOrders
    .flatMap((order) => Array.isArray(order?.items) ? order.items : [])
    .map((item) => String(item?.sku_code || item?.skuCode || '').trim())
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

function normalizedSkuCode(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase()
}

function splitSkuIds(value) {
  return String(value ?? '')
    .split(/\r?\n|[;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function expandSkuManifestRows(rows, skuIdKey) {
  return rows.flatMap((row, index) => {
    const skuIds = splitSkuIds(row[skuIdKey])
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

function catalogStore(product) {
  const name = String(product?.store_name || product?.storeName || 'Selected Store').trim()
  const key = String(product?.store_key || product?.storeKey || name).trim().toLowerCase()
  return { name, key }
}

function addGroupStore(group, product) {
  if (!product) return
  const store = catalogStore(product)
  group.stores.set(store.key, store.name)
}

function addUnresolvedSku(group, {
  skuId,
  skuCode,
  quantity,
  issue,
}) {
  const cleanSkuId = String(skuId || '').trim()
  const cleanSkuCode = String(skuCode || '').trim()
  const cleanQuantity = Number(quantity)
  if (
    !cleanSkuId
    || !cleanSkuCode
    || !Number.isSafeInteger(cleanQuantity)
    || cleanQuantity <= 0
  ) return
  const existing = group.unresolvedSkus.get(cleanSkuId)
  if (existing && existing.skuCode === cleanSkuCode) {
    existing.quantity += cleanQuantity
    return
  }
  group.unresolvedSkus.set(cleanSkuId, {
    skuId: cleanSkuId,
    skuCode: cleanSkuCode,
    quantity: cleanQuantity,
    issue: String(issue || 'sku_mapping_needs_review').trim(),
  })
}

function resolvedCatalogProduct(catalog, skuId, selectedStoreKey = '') {
  const allMatches = catalog.get(String(skuId || '').trim()) || []
  const storeKey = normalizeStoreKey(selectedStoreKey)
  const matches = storeKey
    ? allMatches.filter((product) => catalogStore(product).key === storeKey)
    : allMatches
  if (!matches.length && allMatches.length) {
    return { product: null, issue: 'sku_id_not_in_selected_store_catalog' }
  }
  if (!matches.length) return { product: null, issue: 'sku_id_not_in_store_catalog' }
  const stores = new Set(matches.map((product) => catalogStore(product).key))
  if (stores.size !== 1 || matches.length !== 1) {
    return { product: null, issue: 'sku_id_store_ambiguous' }
  }
  return { product: matches[0], issue: '' }
}

function resolvedCatalogProductForOrderItem(
  catalog,
  catalogBySkuCode,
  skuId,
  skuCode,
  selectedStoreKey = '',
) {
  const byId = resolvedCatalogProduct(catalog, skuId, selectedStoreKey)
  if (byId.product || !['sku_id_not_in_store_catalog', 'sku_id_not_in_selected_store_catalog'].includes(byId.issue)) {
    return byId
  }
  const codeKey = normalizedSkuCode(skuCode)
  const allMatches = catalogBySkuCode.get(codeKey) || []
  const storeKey = normalizeStoreKey(selectedStoreKey)
  const matches = storeKey
    ? allMatches.filter((product) => catalogStore(product).key === storeKey)
    : allMatches
  if (!matches.length) return byId
  const stores = new Set(matches.map((product) => catalogStore(product).key))
  if (stores.size !== 1) {
    return { product: null, issue: 'sku_code_store_ambiguous' }
  }
  const [product] = [...matches].sort((left, right) => {
    const updatedDifference = Date.parse(right.updated_at || right.updatedAt || '')
      - Date.parse(left.updated_at || left.updatedAt || '')
    if (Number.isFinite(updatedDifference) && updatedDifference) return updatedDifference
    return Number(right.mapping_version || right.mappingVersion || 0)
      - Number(left.mapping_version || left.mappingVersion || 0)
  })
  return { product, issue: '' }
}

function resolvedGroupStore(group) {
  if (group.stores.size === 1) {
    const [[key, name]] = group.stores
    return { storeKey: key, storeName: name }
  }
  return { storeKey: 'unresolved', storeName: 'Unresolved' }
}

function orderStore(order) {
  const name = String(order?.store_name || order?.storeName || '').trim()
  const key = String(order?.store_key || order?.storeKey || name).trim().toLowerCase()
  return { name, key }
}

function usableOrderItems(order) {
  return Array.isArray(order?.items) ? order.items : []
}

function bestPopulatedOrder(orders) {
  return [...(orders || [])].sort((left, right) => (
    usableOrderItems(right).length - usableOrderItems(left).length
  ))[0] || null
}

function resolvedHistoricalOrder(orderMatches, group) {
  if (!orderMatches?.length) {
    return { order: null, eligibleOrders: [], issue: 'order_history_missing' }
  }
  const groupKeys = [...group.stores.keys()]
  if (groupKeys.length === 1) {
    const exact = orderMatches.filter((order) => orderStore(order).key === groupKeys[0])
    const combined = orderMatches.filter((order) => orderStore(order).key === 'all stores')
    const eligibleOrders = [...combined, ...exact]
    const populatedCombined = bestPopulatedOrder(
      combined.filter((order) => usableOrderItems(order).length),
    )
    const order = populatedCombined || bestPopulatedOrder(exact) || bestPopulatedOrder(combined)
    return order
      ? { order, eligibleOrders, issue: '' }
      : { order: null, eligibleOrders: [], issue: 'order_store_mismatch' }
  }

  const storeSpecific = orderMatches.filter((order) => orderStore(order).key !== 'all stores')
  const combined = orderMatches.filter((order) => orderStore(order).key === 'all stores')
  const populatedCombined = bestPopulatedOrder(
    combined.filter((order) => usableOrderItems(order).length),
  )
  if (populatedCombined) {
    return {
      order: populatedCombined,
      eligibleOrders: [...combined, ...storeSpecific],
      issue: '',
    }
  }
  const storeKeys = new Set(storeSpecific.map((order) => orderStore(order).key))
  if (storeKeys.size > 1) {
    return { order: null, eligibleOrders: [], issue: 'order_store_ambiguous' }
  }
  if (storeSpecific.length) {
    return {
      order: bestPopulatedOrder(storeSpecific),
      eligibleOrders: storeSpecific,
      issue: '',
    }
  }
  if (combined.length) {
    return {
      order: bestPopulatedOrder(combined),
      eligibleOrders: combined,
      issue: '',
    }
  }
  return { order: null, eligibleOrders: [], issue: 'order_store_ambiguous' }
}

export function parseSkuReturnManifestRows(rows, catalogRows, historicalOrders = [], decisions = {}) {
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
  const catalog = new Map()
  const catalogBySkuCode = new Map()
  for (const product of catalogRows || []) {
    const skuId = String(product.sku_id || product.skuId || '').trim()
    if (!catalog.has(skuId)) catalog.set(skuId, [])
    catalog.get(skuId).push(product)
    const skuCode = normalizedSkuCode(product.sku_code || product.skuCode)
    if (skuCode) {
      if (!catalogBySkuCode.has(skuCode)) catalogBySkuCode.set(skuCode, [])
      catalogBySkuCode.get(skuCode).push(product)
    }
  }
  const orders = new Map()
  for (const order of historicalOrders || []) {
    const orderKey = normalizeOrderNumber(order.order_number || order.orderNumber)
    if (!orders.has(orderKey)) orders.set(orderKey, [])
    orders.get(orderKey).push(order)
  }
  const storeByTracking = decisions?.storeByTracking || {}
  const trackingByExcelRow = decisions?.trackingByExcelRow || {}
  const skippedTrackings = new Set(
    (decisions?.skippedTrackings || []).map(normalizeTracking).filter(Boolean),
  )
  const manifestRows = expandSkuManifestRows(rows, skuIdKey)
  const explicitSkuIdsByTracking = new Map()
  const explicitStoresByTracking = new Map()
  for (const { row, excelRow } of manifestRows) {
    const tracking = normalizeTracking(trackingByExcelRow[excelRow] || row[trackingKey])
    if (skippedTrackings.has(tracking)) continue
    const skuId = String(row[skuIdKey] ?? '').trim()
    if (!tracking || !skuId) continue
    if (!explicitSkuIdsByTracking.has(tracking)) explicitSkuIdsByTracking.set(tracking, new Set())
    explicitSkuIdsByTracking.get(tracking).add(skuId)
    const { product } = resolvedCatalogProduct(
      catalog,
      skuId,
      storeByTracking[tracking]?.key,
    )
    if (product) {
      if (!explicitStoresByTracking.has(tracking)) explicitStoresByTracking.set(tracking, new Map())
      const store = catalogStore(product)
      explicitStoresByTracking.get(tracking).set(store.key, store.name)
    }
  }
  const groups = new Map()
  const needsReview = []
  const waitingForTracking = []
  const pendingUploadDecisions = []

  manifestRows.forEach(({ row, excelRow }) => {
    const trackingNumber = String(trackingByExcelRow[excelRow] || row[trackingKey] || '').trim()
    const tracking = normalizeTracking(trackingNumber)
    if (skippedTrackings.has(tracking)) return
    const skuId = String(row[skuIdKey] ?? '').trim()
    const orderNumber = String(poKey ? row[poKey] ?? '' : '').trim()
    const selectedStoreKey = storeByTracking[tracking]?.key
    const rawQty = quantityKey ? row[quantityKey] : 1
    const quantity = rawQty === '' || rawQty == null ? 1 : Number(rawQty)
    const returnReason = String(reasonKey ? row[reasonKey] ?? '' : '').trim()
    const buyerRemark = String(remarkKey ? row[remarkKey] ?? '' : '').trim()
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
      skuReasonDetails: [],
      carriers: new Set(),
      recoveredOrders: new Set(),
      candidateOrders: [],
      review: [],
      unresolvedSkus: new Map(),
      stores: new Map(explicitStoresByTracking.get(tracking) || []),
    }
    const selectedStore = storeByTracking[tracking]
    if (selectedStore?.key && selectedStore?.name) {
      group.stores.set(String(selectedStore.key), String(selectedStore.name))
    }
    if (orderNumber) group.orders.add(orderNumber)
    if (returnReason) group.reasons.add(returnReason)
    if (buyerRemark) group.buyerRemarks.add(buyerRemark)
    if (carrierKey && row[carrierKey]) group.carriers.add(String(row[carrierKey]).trim())

    if (!skuId) {
      const orderKey = normalizeOrderNumber(orderNumber)
      const orderMatches = orders.get(orderKey) || []
      if (!group.stores.size) {
        const inferredStores = new Map()
        orderMatches.forEach((order) => {
          usableOrderItems(order).forEach((orderItem) => {
            const { product } = resolvedCatalogProductForOrderItem(
              catalog,
              catalogBySkuCode,
              orderItem.sku_id || orderItem.skuId,
              orderItem.sku_code || orderItem.skuCode,
              selectedStoreKey,
            )
            if (product) {
              const name = String(product.store_name || product.storeName || '').trim()
              const key = normalizeStoreKey(product.store_key || product.storeKey || name)
              if (key && name) inferredStores.set(key, name)
            }
          })
        })
        if (inferredStores.size === 1) {
          const [[key, name]] = inferredStores
          group.stores.set(key, name)
        }
      }
      const orderAlreadyHandled = group.recoveredOrders.has(orderKey)
        || group.candidateOrders.some((order) => order.orderKey === orderKey)
      const {
        order: historicalOrder,
        issue: historicalOrderIssue,
      } = orderAlreadyHandled
        ? { order: null, issue: '' }
        : resolvedHistoricalOrder(orderMatches, group)
      if (!orderKey) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: 'sku_id_missing',
        })
      } else if (orderAlreadyHandled) {
        // The same logical order may appear on multiple rows (for example -D01 suffixes).
      } else if (!historicalOrder?.items?.length) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: historicalOrderIssue || 'order_history_missing',
        })
      } else {
        const historicalStore = orderStore(historicalOrder)
        if (historicalStore.key && historicalStore.key !== 'all stores') {
          group.stores.set(historicalStore.key, historicalStore.name)
        }
        const candidates = historicalOrder.items.flatMap((orderItem, itemIndex) => {
          const recoveredSkuId = String(orderItem.sku_id || orderItem.skuId || '').trim()
          const recoveredQuantity = Number(orderItem.quantity)
          const {
            product,
            issue: productIssue,
          } = resolvedCatalogProductForOrderItem(
            catalog,
            catalogBySkuCode,
            recoveredSkuId,
            orderItem.sku_code || orderItem.skuCode,
            selectedStoreKey,
          )
          if (explicitSkuIdsByTracking.get(tracking)?.has(recoveredSkuId)) return []
          let issue = ''
          if (!recoveredSkuId && !product) {
            issue = 'order_item_sku_missing'
          } else if (!Number.isSafeInteger(recoveredQuantity) || recoveredQuantity <= 0) {
            issue = 'order_quantity_invalid'
          } else if (!product) {
            issue = productIssue
          } else if (product.status !== 'ready' || !Array.isArray(product.components) || !product.components.length) {
            issue = product.issue || 'sku_mapping_needs_review'
          }
          if (product) addGroupStore(group, product)
          const store = product ? catalogStore(product) : { name: '', key: '' }
          return [{
            candidateKey: `${orderKey}\u241f${
              orderItem.id || orderItem.item_key || orderItem.itemKey || itemIndex
            }`,
            skuId: String(product?.sku_id || product?.skuId || recoveredSkuId).trim(),
            skuCode: String(
              orderItem.sku_code || orderItem.skuCode || product?.sku_code || product?.skuCode || '',
            ).trim(),
            attributes: String(orderItem.attributes || '').trim(),
            maxQuantity: recoveredQuantity,
            status: issue ? 'review' : 'ready',
            issue,
            components: issue ? [] : product.components,
            storeName: store.name,
            storeKey: store.key,
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
          if (returnReason || buyerRemark) {
            group.skuReasonDetails.push({
              skuId: candidate.skuId,
              skuCode: candidate.skuCode,
              quantity: candidate.maxQuantity,
              returnReason,
              buyerRemark,
              excelRow,
            })
          }
          candidate.components.forEach((component) => {
            group.items.push({
              skuId: candidate.skuId,
              skuCode: candidate.skuCode,
              style: component.style,
              color: component.color,
              size: component.size,
              expectedQty: Number(component.qty || 1) * candidate.maxQuantity,
              sourceQty: candidate.maxQuantity,
            })
          })
          group.recoveredOrders.add(orderKey)
        } else if (candidates.length === 1) {
          if (returnReason || buyerRemark) {
            group.skuReasonDetails.push({
              skuId: candidates[0].skuId,
              skuCode: candidates[0].skuCode,
              quantity: candidates[0].maxQuantity,
              returnReason,
              buyerRemark,
              excelRow,
            })
          }
          addUnresolvedSku(group, {
            skuId: candidates[0].skuId,
            skuCode: candidates[0].skuCode,
            quantity: candidates[0].maxQuantity,
            issue: candidates[0].issue,
          })
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId: candidates[0].skuId,
            parse_issue: candidates[0].issue,
          })
        } else {
          group.candidateOrders.push({
            orderNumber,
            orderKey,
            candidates,
            returnReason,
            buyerRemark,
            excelRow,
          })
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
      const {
        product,
        issue: productIssue,
      } = resolvedCatalogProduct(catalog, skuId, selectedStoreKey)
      if (returnReason || buyerRemark) {
        group.skuReasonDetails.push({
          skuId,
          skuCode: product?.sku_code || product?.skuCode || '',
          quantity,
          returnReason,
          buyerRemark,
          excelRow,
        })
      }
      if (!product) {
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: productIssue,
        })
      } else {
        addGroupStore(group, product)
      }
      if (orderNumber) {
        const orderKey = normalizeOrderNumber(orderNumber)
        const {
          order: historicalOrder,
          eligibleOrders: eligibleHistoricalOrders,
          issue: historicalOrderIssue,
        } = resolvedHistoricalOrder(orders.get(orderKey), group)
        if (!historicalOrder) {
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId,
            parse_issue: historicalOrderIssue || 'order_history_missing',
          })
        } else if (!(eligibleHistoricalOrders || [historicalOrder]).some((order) => (
          usableOrderItems(order).some((item) => {
            const itemSkuId = String(item.sku_id || item.skuId || '').trim()
            const sameCurrentSkuCode = product && normalizedSkuCode(
              item.sku_code || item.skuCode,
            ) === normalizedSkuCode(product.sku_code || product.skuCode)
            return itemSkuId === skuId || sameCurrentSkuCode
          })
        ))) {
          group.review.push({
            tracking: trackingNumber,
            excelRow,
            orderNumber,
            skuId,
            parse_issue: 'sku_not_in_claimed_order',
          })
        }
      }
      if (product && (
        product.status !== 'ready'
        || !Array.isArray(product.components)
        || !product.components.length
      )) {
        addUnresolvedSku(group, {
          skuId,
          skuCode: product.sku_code || product.skuCode,
          quantity,
          issue: product.issue || 'sku_mapping_needs_review',
        })
        group.review.push({
          tracking: trackingNumber,
          excelRow,
          orderNumber,
          skuId,
          parse_issue: product.issue || 'sku_mapping_needs_review',
        })
      } else if (product) {
        product.components.forEach((component) => {
          group.items.push({
            skuId,
            skuCode: product.sku_code || product.skuCode,
            style: component.style,
            color: component.color,
            size: component.size,
            expectedQty: Number(component.qty || 1) * quantity,
            sourceQty: quantity,
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
    const selectedStore = storeByTracking[group.tracking]
    if (selectedStore?.key && selectedStore?.name) {
      group.stores.clear()
      group.stores.set(String(selectedStore.key), String(selectedStore.name))
    }
    const claimedOrderKeys = [...group.orders].map(normalizeOrderNumber).filter(Boolean)
    const claimedHistoricalOrders = claimedOrderKeys.flatMap((orderKey) => orders.get(orderKey) || [])

    if (!group.stores.size) {
      const selectedOrderStores = new Map(claimedHistoricalOrders.map((order) => {
        const store = orderStore(order)
        return [store.key, store.name]
      }).filter(([key]) => key && key !== 'all stores'))
      if (selectedOrderStores.size === 1) {
        const [[key, name]] = selectedOrderStores
        group.stores.set(key, name)
      }
    }
    if (group.stores.size !== 1) {
      const relevantSkuIds = new Set(explicitSkuIdsByTracking.get(group.tracking) || [])
      claimedHistoricalOrders.forEach((order) => {
        for (const item of order.items || []) {
          const skuId = String(item.sku_id || item.skuId || '').trim()
          if (skuId) relevantSkuIds.add(skuId)
        }
      })
      const catalogStores = new Map()
      relevantSkuIds.forEach((skuId) => {
        for (const product of catalog.get(skuId) || []) {
          const store = catalogStore(product)
          if (store.key) catalogStores.set(store.key, store.name)
        }
      })
      const historicalStores = new Map(claimedHistoricalOrders.map((order) => {
        const store = orderStore(order)
        return [store.key, store.name]
      }).filter(([key]) => key))
      pendingUploadDecisions.push({
        tracking: group.tracking,
        trackingNumber: group.trackingNumber,
        issue: 'store_unresolved',
        claimedOrders: [...group.orders],
        candidateOrders: [],
        skuIds: [...relevantSkuIds],
        reviewIssues: [...new Set(group.review.map((row) => row.parse_issue).filter(Boolean))],
        orderHistoryFound: claimedHistoricalOrders.length > 0,
        allStoresHistory: historicalStores.has('all stores'),
        historicalStores: [...historicalStores.values()].filter(Boolean),
        catalogStores: [...catalogStores.values()].filter(Boolean),
      })
      continue
    }
    const store = resolvedGroupStore(group)
    if (group.review.length) {
      const unresolvedSkus = [...group.unresolvedSkus.values()]
      const unresolvedKeys = new Set(unresolvedSkus.map((item) =>
        `${item.skuId}\u241f${item.issue}`
      ))
      const blockingIssues = [...new Set(group.review
        .filter((row) => !unresolvedKeys.has(`${row.skuId}\u241f${row.parse_issue}`))
        .map((row) => row.parse_issue))]
      needsReview.push(...group.review)
      reviewPackages.push({
        tracking: group.tracking,
        trackingNumber: group.trackingNumber,
        orders: [...group.orders],
        reasons: [...group.reasons],
        buyerRemarks: [...group.buyerRemarks],
        skuReasonDetails: group.skuReasonDetails,
        carrier: [...group.carriers].join(', '),
        items: group.items,
        expectedUnits: group.items.reduce((sum, item) => sum + item.expectedQty, 0),
        reviewReason: [...new Set(group.review.map((row) => row.parse_issue))].join(','),
        requiresItemResolution: true,
        reviewData: { unresolvedSkus, blockingIssues },
        ...store,
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
          skuReasonDetails: group.skuReasonDetails,
          carrier: [...group.carriers].join(', '),
          baseItems: group.items,
          candidateOrders: group.candidateOrders,
          ...store,
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
      skuReasonDetails: group.skuReasonDetails,
      carrier: [...group.carriers].join(', '),
      items: group.items,
      expectedUnits: group.items.reduce((sum, item) => sum + item.expectedQty, 0),
      recoveredFromOrders: [...group.recoveredOrders],
      ...store,
    })
  }

  return {
    packages,
    reviewPackages,
    needsReview,
    waitingForTracking,
    pendingOrderMatches,
    pendingUploadDecisions,
    skippedTrackings: [...skippedTrackings],
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking || `row:${row.excelRow}`)).size,
      waitingForTracking: waitingForTracking.length,
      pendingUploadDecisions: pendingUploadDecisions.length,
      skippedPackages: skippedTrackings.size,
      recoveredPackages: packages.filter((pkg) => pkg.recoveredFromOrders.length > 0).length,
      storeCount: new Set(
        [...packages, ...reviewPackages]
          .map((pkg) => pkg.storeKey)
          .filter((key) => key && key !== 'unresolved'),
      ).size,
    },
  }
}

export function applyReturnOrderMatch(parsed, tracking, quantities) {
  const trackingKey = normalizeTracking(tracking)
  const match = (parsed.pendingOrderMatches || []).find((item) => item.tracking === trackingKey)
  if (!match) throw new Error('Order candidates are no longer available for this package')

  const selectedItems = []
  const selectedReasonDetails = []
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
      if (order.returnReason || order.buyerRemark) {
        selectedReasonDetails.push({
          skuId: candidate.skuId,
          skuCode: candidate.skuCode,
          quantity,
          returnReason: order.returnReason,
          buyerRemark: order.buyerRemark,
          excelRow: order.excelRow,
        })
      }
      candidate.components.forEach((component) => {
        selectedItems.push({
          skuId: candidate.skuId,
          skuCode: candidate.skuCode,
          style: component.style,
          color: component.color,
          size: component.size,
          expectedQty: Number(component.qty || 1) * quantity,
          sourceQty: quantity,
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
    if (existing) {
      existing.expectedQty += Number(item.expectedQty)
      existing.sourceQty = existing.sourceQty != null && item.sourceQty != null
        ? Number(existing.sourceQty) + Number(item.sourceQty)
        : undefined
    }
    else itemsByKey.set(key, { ...item, expectedQty: Number(item.expectedQty) })
  }
  const items = [...itemsByKey.values()]
  const pkg = {
    tracking: match.tracking,
    trackingNumber: match.trackingNumber,
    orders: match.orders,
    reasons: match.reasons,
    buyerRemarks: match.buyerRemarks,
    skuReasonDetails: [...(match.skuReasonDetails || []), ...selectedReasonDetails],
    carrier: match.carrier,
    items,
    expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    recoveredFromOrders: [...recoveredOrders],
    storeName: match.storeName,
    storeKey: match.storeKey,
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
      storeCount: new Set(packages.map((item) => item.storeKey).filter(Boolean)).size,
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
