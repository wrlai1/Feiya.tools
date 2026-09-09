function itemIdentity(item) {
  return [item.sku_id, item.style, item.color, item.size]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('\u0000')
}

function mergeReturnPackageItems(existingItems, resolvedItems) {
  const merged = new Map()
  for (const rawItem of [...(existingItems || []), ...(resolvedItems || [])]) {
    const item = {
      sku_id: String(rawItem.sku_id || '').trim(),
      sku_code: String(rawItem.sku_code || '').trim(),
      style: String(rawItem.style || '').trim(),
      color: String(rawItem.color || '').trim(),
      size: String(rawItem.size || '').trim(),
      expected_qty: Number(rawItem.expected_qty),
      source_qty: Number(rawItem.source_qty || 0) || null,
    }
    if (
      !item.style
      || !item.color
      || !item.size
      || !Number.isSafeInteger(item.expected_qty)
      || item.expected_qty <= 0
    ) throw new Error('Invalid return package item')
    const key = itemIdentity(item)
    const existing = merged.get(key)
    if (existing) {
      existing.expected_qty += item.expected_qty
      existing.source_qty = existing.source_qty != null && item.source_qty != null
        ? existing.source_qty + item.source_qty
        : null
    } else {
      merged.set(key, item)
    }
  }
  return [...merged.values()]
}

function mergeInventoryComponents(rawComponents) {
  const merged = new Map()
  for (const rawComponent of rawComponents || []) {
    const component = {
      style: String(rawComponent.style || '').trim(),
      color: String(rawComponent.color || '').trim(),
      size: String(rawComponent.size || '').trim(),
      qty: Number(rawComponent.qty),
    }
    if (
      !component.style
      || !component.color
      || !component.size
      || !Number.isSafeInteger(component.qty)
      || component.qty <= 0
      || component.qty > 9999
    ) throw new Error('Invalid inventory component')
    const normalizedSize = component.size.toUpperCase().replace(/^([123])XL$/, '$1X')
    const key = [component.style, component.color, normalizedSize]
      .map((value) => value.toLowerCase())
      .join('\u0000')
    const existing = merged.get(key)
    if (existing) {
      existing.qty += component.qty
      if (existing.qty > 9999) throw new Error('Inventory component quantity is too large')
    } else {
      merged.set(key, component)
    }
  }
  return [...merged.values()]
}

function canResolveReturnItems(pkg) {
  return Boolean(
    pkg?.requires_item_resolution
    && ['pending', 'needs_review'].includes(pkg.status),
  )
}

function replaceSelectedReturnPackageItems(existingItems, resolvedItems, selectedOrderItems) {
  const selected = selectedOrderItems || []
  const retained = (existingItems || []).filter((item) => !selected.some((orderItem) => {
    const itemSkuId = String(item.sku_id || '').trim()
    const orderSkuId = String(orderItem.sku_id || '').trim()
    if (itemSkuId && orderSkuId) return itemSkuId === orderSkuId
    const itemSkuCode = String(item.sku_code || '').trim().toLowerCase()
    const orderSkuCode = String(orderItem.sku_code || '').trim().toLowerCase()
    return Boolean(itemSkuCode && orderSkuCode && itemSkuCode === orderSkuCode)
  }))
  return mergeReturnPackageItems(retained, resolvedItems)
}

module.exports = {
  canResolveReturnItems,
  itemIdentity,
  mergeInventoryComponents,
  mergeReturnPackageItems,
  replaceSelectedReturnPackageItems,
}
