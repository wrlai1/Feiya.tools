const text = (value) => String(value || '').trim()
const orderKey = (value) => text(value).replace(/\s+/g, '').toUpperCase().replace(/-D\d+$/, '')

// Older order imports have SKU codes but no SKU IDs. Only use a code fallback
// when it identifies one row and does not contradict a recorded SKU ID.
export function orderSkuQuantity(order, skuId, skuCode) {
  const items = order?.items || []
  const id = text(skuId)
  let matches = id ? items.filter((item) => text(item.sku_id || item.skuId) === id) : []
  if (!matches.length) {
    const code = text(skuCode).toLowerCase()
    if (!code) return null
    matches = items.filter((item) => text(item.sku_code || item.skuCode).toLowerCase() === code)
    if (matches.length !== 1 || (text(matches[0].sku_id || matches[0].skuId)
      && text(matches[0].sku_id || matches[0].skuId) !== id)) return null
  }
  if (!matches.length || matches.some((item) => !Number.isSafeInteger(Number(item.quantity))
    || Number(item.quantity) <= 0)) return null
  return matches.reduce((sum, item) => sum + Number(item.quantity), 0)
}

// Cap sold-product quantities, preserving all physical components of a set.
// Incomplete or ambiguous evidence must never turn a real multi-item return into one.
export function limitReturnPackageQuantities(packages, orders) {
  const byOrder = new Map()
  for (const order of orders) {
    const key = orderKey(order.order_key || order.order_number)
    if (!byOrder.has(key)) byOrder.set(key, [])
    byOrder.get(key).push(order)
  }
  return packages.map((pkg) => {
    const keys = [...new Set((pkg.order_numbers || []).map(orderKey).filter(Boolean))]
    if (!keys.length) return pkg
    const matchedOrders = keys.map((key) => {
      const matches = byOrder.get(key) || []
      const direct = matches.filter((order) => order.store_key === pkg.store_key)
      const eligible = direct.length ? direct : matches.filter((order) => order.store_key === 'all stores')
      return eligible.length === 1 ? eligible[0] : null
    })
    if (matchedOrders.some((order) => !order)) return pkg
    const groups = new Map()
    for (const item of pkg.items) {
      const key = text(item.sku_id) || text(item.sku_code).toLowerCase()
      if (!key) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const replacements = new Map()
    for (const items of groups.values()) {
      const sourceQty = Number(items[0].source_qty)
      if (!Number.isSafeInteger(sourceQty) || sourceQty <= 0
        || items.some((item) => Number(item.source_qty) !== sourceQty
          || Number(item.expected_qty) <= 0
          || !Number.isSafeInteger(Number(item.expected_qty) / sourceQty))) continue
      const quantities = matchedOrders.map((order) =>
        orderSkuQuantity(order, items[0].sku_id, items[0].sku_code))
      if (quantities.some((quantity) => quantity == null)) continue
      const limit = quantities.reduce((sum, quantity) => sum + quantity, 0)
      if (sourceQty <= limit) continue
      for (const item of items) replacements.set(item, {
        ...item,
        source_qty: limit,
        expected_qty: Number(item.expected_qty) / sourceQty * limit,
      })
    }
    if (!replacements.size) return pkg
    const items = pkg.items.map((item) => replacements.get(item) || item)
    return { ...pkg, items, expected_units: items.reduce((sum, item) => sum + Number(item.expected_qty), 0) }
  })
}
