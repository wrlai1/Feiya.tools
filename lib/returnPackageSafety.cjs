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

module.exports = { itemIdentity, mergeReturnPackageItems }
