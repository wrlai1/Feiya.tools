const ORDER_ALIASES = ['订单号', '订单号 PO', 'PO', 'Order Number']
const SKU_ID_ALIASES = ['SKU ID', 'SKUID', 'SKU_ID']
const SKC_ID_ALIASES = ['SKC ID', 'SKCID', 'SKC_ID']
const SPU_ID_ALIASES = ['SPU ID', 'SPUID', 'SPU_ID']
const SKU_CODE_ALIASES = ['SKU货号', 'SKU', 'SKU Code']
const ATTRIBUTES_ALIASES = ['商品属性', 'Product Attributes', 'Attributes']
const PRODUCT_NAME_ALIASES = ['商品名称', 'Product Name']
const QUANTITY_ALIASES = ['应履约件数', 'Quantity', 'Qty', '数量', '商品数量']
const SITE_ALIASES = ['站点', 'Site']
const STATUS_ALIASES = ['订单状态', 'Order Status']
const TRACKING_ALIASES = ['运单号', 'Outbound Tracking', 'Tracking Number']
const PACKAGE_ALIASES = ['包裹号', 'Package Number']
const CARRIER_ALIASES = ['物流商', 'Carrier']
const WAREHOUSE_ALIASES = ['发货仓', 'Warehouse']
const CREATED_AT_ALIASES = ['订单创建时间', 'Order Created At']
const CONFIRMED_AT_ALIASES = ['订单确认时间', 'Order Confirmed At']
const SHIPPED_AT_ALIASES = ['实际发货时间', 'Shipped At']
const DELIVERED_AT_ALIASES = ['实际签收时间', 'Delivered At']

function cleanHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase()
}

function clean(value) {
  return String(value ?? '').replace(/\t/g, '').trim()
}

function findKey(row, aliases) {
  const wanted = new Set(aliases.map(cleanHeader))
  return Object.keys(row || {}).find((key) => wanted.has(cleanHeader(key)))
}

function addValue(set, value) {
  const normalized = clean(value)
  if (normalized) set.add(normalized)
}

function dateValue(value) {
  const text = clean(value)
  if (!text) return ''
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function itemKey(skuCode, attributes) {
  return `${clean(skuCode).toLowerCase()}\u241f${clean(attributes).toLowerCase()}`
}

function finalizeItem(item) {
  return {
    itemKey: item.itemKey,
    skuId: item.skuId,
    skcId: item.skcId,
    spuId: item.spuId,
    skuCode: item.skuCode,
    productName: item.productName,
    attributes: item.attributes,
    quantity: item.quantity,
    outboundTrackings: [...item.outboundTrackings],
    packageNumbers: [...item.packageNumbers],
    carriers: [...item.carriers],
    warehouses: [...item.warehouses],
  }
}

export function buildInventoryOrderClaims(orders) {
  const claims = []
  const seen = new Set()
  for (const order of orders || []) {
    const orderKey = clean(order?.orderNumber).toLowerCase()
    if (!orderKey) continue
    for (const item of order?.items || []) {
      const skuId = clean(item?.skuId).toLowerCase()
      const skcId = clean(item?.skcId).toLowerCase()
      const fallbackKey = clean(item?.itemKey).toLowerCase().replace(/\s+/g, '')
      const normalizedItemKey = skuId
        ? `sku:${skuId}`
        : skcId
          ? `skc:${skcId}`
          : fallbackKey
            ? `item:${fallbackKey}`
            : ''
      if (!normalizedItemKey) continue
      const key = `${orderKey}\u241f${normalizedItemKey}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({ orderKey, itemKey: normalizedItemKey })
    }
  }
  return claims
}

export function parseOrderHistoryRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Order file is empty')

  const sample = rows.find((row) => row && Object.keys(row).length) || {}
  const keys = {
    order: findKey(sample, ORDER_ALIASES),
    skuId: findKey(sample, SKU_ID_ALIASES),
    skcId: findKey(sample, SKC_ID_ALIASES),
    spuId: findKey(sample, SPU_ID_ALIASES),
    skuCode: findKey(sample, SKU_CODE_ALIASES),
    attributes: findKey(sample, ATTRIBUTES_ALIASES),
    productName: findKey(sample, PRODUCT_NAME_ALIASES),
    quantity: findKey(sample, QUANTITY_ALIASES),
    site: findKey(sample, SITE_ALIASES),
    status: findKey(sample, STATUS_ALIASES),
    tracking: findKey(sample, TRACKING_ALIASES),
    packageNumber: findKey(sample, PACKAGE_ALIASES),
    carrier: findKey(sample, CARRIER_ALIASES),
    warehouse: findKey(sample, WAREHOUSE_ALIASES),
    createdAt: findKey(sample, CREATED_AT_ALIASES),
    confirmedAt: findKey(sample, CONFIRMED_AT_ALIASES),
    shippedAt: findKey(sample, SHIPPED_AT_ALIASES),
    deliveredAt: findKey(sample, DELIVERED_AT_ALIASES),
  }
  if (!keys.order || !keys.skuCode || !keys.attributes) {
    throw new Error('Order file requires 订单号, SKU货号, and 商品属性 columns')
  }

  const orders = new Map()
  const skippedRows = []
  const conflicts = []
  let sourceRows = 0

  rows.forEach((row, index) => {
    const excelRow = index + 2
    const orderNumber = clean(row[keys.order])
    const skuCode = clean(row[keys.skuCode])
    const attributes = clean(row[keys.attributes])
    const rawQuantity = keys.quantity ? row[keys.quantity] : 1
    const quantity = rawQuantity === '' || rawQuantity == null ? 1 : Number(rawQuantity)

    if (!orderNumber || !skuCode || !attributes) {
      skippedRows.push({ excelRow, issue: 'missing_order_sku_or_attributes' })
      return
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      skippedRows.push({ excelRow, orderNumber, skuCode, issue: 'invalid_quantity' })
      return
    }
    sourceRows += 1

    const orderKey = orderNumber.toLowerCase()
    const order = orders.get(orderKey) || {
      orderNumber,
      site: clean(keys.site ? row[keys.site] : ''),
      status: clean(keys.status ? row[keys.status] : ''),
      orderCreatedAt: dateValue(keys.createdAt ? row[keys.createdAt] : ''),
      orderConfirmedAt: dateValue(keys.confirmedAt ? row[keys.confirmedAt] : ''),
      shippedAt: dateValue(keys.shippedAt ? row[keys.shippedAt] : ''),
      deliveredAt: dateValue(keys.deliveredAt ? row[keys.deliveredAt] : ''),
      items: new Map(),
    }
    if (!order.site && keys.site) order.site = clean(row[keys.site])
    if (!order.status && keys.status) order.status = clean(row[keys.status])
    if (!order.orderCreatedAt && keys.createdAt) order.orderCreatedAt = dateValue(row[keys.createdAt])
    if (!order.orderConfirmedAt && keys.confirmedAt) order.orderConfirmedAt = dateValue(row[keys.confirmedAt])
    if (!order.shippedAt && keys.shippedAt) order.shippedAt = dateValue(row[keys.shippedAt])
    if (!order.deliveredAt && keys.deliveredAt) order.deliveredAt = dateValue(row[keys.deliveredAt])

    const key = itemKey(skuCode, attributes)
    const skuId = clean(keys.skuId ? row[keys.skuId] : '')
    const baseItem = order.items.get(key)
    let effectiveKey = key
    if (baseItem?.skuId && skuId && baseItem.skuId !== skuId) {
      conflicts.push({
        excelRow,
        orderNumber,
        skuCode,
        attributes,
        issue: 'same_sku_and_attributes_have_different_sku_ids',
        existingSkuId: baseItem.skuId,
        incomingSkuId: skuId,
      })
      effectiveKey = `${key}\u241fsku:${skuId.toLowerCase()}`
    }
    const existing = order.items.get(effectiveKey)
    if (existing) {
      existing.quantity += quantity
      if (!existing.skuId) existing.skuId = skuId
      if (!existing.skcId && keys.skcId) existing.skcId = clean(row[keys.skcId])
      if (!existing.spuId && keys.spuId) existing.spuId = clean(row[keys.spuId])
      if (!existing.productName && keys.productName) existing.productName = clean(row[keys.productName])
      addValue(existing.outboundTrackings, keys.tracking ? row[keys.tracking] : '')
      addValue(existing.packageNumbers, keys.packageNumber ? row[keys.packageNumber] : '')
      addValue(existing.carriers, keys.carrier ? row[keys.carrier] : '')
      addValue(existing.warehouses, keys.warehouse ? row[keys.warehouse] : '')
    } else {
      const item = {
        itemKey: effectiveKey,
        skuId,
        skcId: clean(keys.skcId ? row[keys.skcId] : ''),
        spuId: clean(keys.spuId ? row[keys.spuId] : ''),
        skuCode,
        productName: clean(keys.productName ? row[keys.productName] : ''),
        attributes,
        quantity,
        outboundTrackings: new Set(),
        packageNumbers: new Set(),
        carriers: new Set(),
        warehouses: new Set(),
      }
      addValue(item.outboundTrackings, keys.tracking ? row[keys.tracking] : '')
      addValue(item.packageNumbers, keys.packageNumber ? row[keys.packageNumber] : '')
      addValue(item.carriers, keys.carrier ? row[keys.carrier] : '')
      addValue(item.warehouses, keys.warehouse ? row[keys.warehouse] : '')
      order.items.set(effectiveKey, item)
    }
    orders.set(orderKey, order)
  })

  const parsedOrders = [...orders.values()].map((order) => ({
    orderNumber: order.orderNumber,
    site: order.site,
    status: order.status,
    orderCreatedAt: order.orderCreatedAt,
    orderConfirmedAt: order.orderConfirmedAt,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    items: [...order.items.values()].map(finalizeItem),
  }))
  const dates = parsedOrders
    .map((order) => order.orderCreatedAt)
    .filter(Boolean)
    .sort()

  return {
    orders: parsedOrders,
    skippedRows,
    conflicts,
    stats: {
      sourceRows,
      orderCount: parsedOrders.length,
      itemCount: parsedOrders.reduce((sum, order) => sum + order.items.length, 0),
      unitCount: parsedOrders.reduce(
        (sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0),
        0,
      ),
      skippedRows: skippedRows.length,
      conflicts: conflicts.length,
      earliestOrder: dates[0] || '',
      latestOrder: dates.at(-1) || '',
    },
  }
}
