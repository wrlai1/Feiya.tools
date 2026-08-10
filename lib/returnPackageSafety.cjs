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

function normalizeManualReturnPackageItems(rawItems) {
  return mergeInventoryComponents(rawItems).map((item) => ({
    sku_id: '',
    sku_code: 'Admin manual selection (PO not found)',
    style: item.style,
    color: item.color,
    size: item.size,
    expected_qty: item.qty,
    source_qty: item.qty,
  }))
}

function normalizeManualReturnDraft({ trackingNumber, storeName, storeKey, username = '' }) {
  const cleanTracking = String(trackingNumber || '').trim().slice(0, 200)
  const trackingKey = cleanTracking.replace(/\s+/g, '').toUpperCase()
  const cleanStoreName = String(storeName || '').trim().replace(/\s+/g, ' ').slice(0, 100)
  const cleanStoreKey = String(storeKey || '').trim().toLowerCase()
  if (!trackingKey) throw new Error('Manual return requires a tracking number')
  if (
    !cleanStoreName
    || !cleanStoreKey
    || cleanStoreKey === 'unresolved'
    || cleanStoreKey === 'all stores'
  ) throw new Error('Manual return requires one validated store')
  return {
    tracking_number: cleanTracking,
    tracking_key: trackingKey,
    store_name: cleanStoreName,
    store_key: cleanStoreKey,
    source_file: 'Manual tracking entry',
    status: 'pending',
    expected_units: 0,
    uploaded_by: String(username || '').trim().slice(0, 100),
    review_reason: 'manual_tracking_no_order',
    requires_item_resolution: true,
    review_data: {
      unresolvedSkus: [],
      blockingIssues: ['manual_tracking_no_order'],
      workerInspection: null,
    },
  }
}

function buildReturnItemsForOrderSelection(orderItem, rawQuantity, manualComponents = []) {
  const quantity = Number(rawQuantity)
  const orderedQuantity = Number(orderItem?.quantity)
  if (
    !Number.isSafeInteger(quantity)
    || quantity <= 0
    || !Number.isSafeInteger(orderedQuantity)
    || quantity > orderedQuantity
  ) throw new Error('Choose a valid returned quantity from the original order')

  const hasCatalogMapping = orderItem?.catalog_status === 'ready'
    && Array.isArray(orderItem.catalog_components)
    && orderItem.catalog_components.length > 0
  if (hasCatalogMapping && manualComponents.length) {
    throw new Error('This product already has a catalog mapping')
  }
  if (!hasCatalogMapping && !manualComponents.length) {
    throw new Error('This product requires an inventory mapping')
  }
  const components = hasCatalogMapping
    ? mergeInventoryComponents(orderItem.catalog_components)
    : mergeInventoryComponents(manualComponents)
  return components.map((component) => {
    const expectedQuantity = component.qty * quantity
    if (!Number.isSafeInteger(expectedQuantity) || expectedQuantity > 9999) {
      throw new Error('The selected product quantity is too large')
    }
    return {
      sku_id: String(orderItem.sku_id || '').trim(),
      sku_code: String(orderItem.sku_code || '').trim(),
      style: component.style,
      color: component.color,
      size: component.size,
      expected_qty: expectedQuantity,
      source_qty: quantity,
    }
  })
}

function findReturnSkuMappingTarget(unresolvedSkus, relatedOrders, rawSkuId) {
  const skuId = String(rawSkuId || '').trim()
  if (!skuId) return null
  const unresolvedSku = (unresolvedSkus || []).find((item) => (
    String(item.skuId || item.sku_id || '').trim() === skuId
  ))
  if (unresolvedSku) {
    return {
      kind: 'unresolved_manifest_sku',
      skuCode: String(unresolvedSku.skuCode || unresolvedSku.sku_code || '').trim(),
      quantity: Number(unresolvedSku.quantity),
      unresolvedSku,
    }
  }
  const orderItem = (relatedOrders || [])
    .flatMap((order) => order.items || [])
    .find((item) => (
      String(item.sku_id || item.skuId || '').trim() === skuId
      && item.catalog_status !== 'ready'
    ))
  if (!orderItem) return null
  return {
    kind: 'unmapped_order_sku',
    skuCode: String(orderItem.sku_code || orderItem.skuCode || '').trim(),
    quantity: null,
    unresolvedSku: null,
  }
}

module.exports = {
  buildReturnItemsForOrderSelection,
  findReturnSkuMappingTarget,
  itemIdentity,
  mergeInventoryComponents,
  mergeReturnPackageItems,
  normalizeManualReturnDraft,
  normalizeManualReturnPackageItems,
}
