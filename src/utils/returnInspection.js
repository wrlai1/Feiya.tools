function toCount(value, label) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0 || count > 9999) {
    throw new Error(`${label} must be a whole number between 0 and 9999`)
  }
  return count
}

export function summarizeReturnInspection(lines) {
  const normalized = (lines || []).map((line) => {
    const expectedQty = toCount(line.expectedQty, 'Expected quantity')
    const goodQty = toCount(line.goodQty, 'Good quantity')
    const damagedQty = toCount(line.damagedQty, 'Damaged quantity')
    const notOursQty = toCount(line.notOursQty, 'Not ours quantity')
    if (goodQty + damagedQty + notOursQty > expectedQty) {
      throw new Error('The selected outcomes cannot exceed the expected quantity')
    }
    return { expectedQty, goodQty, damagedQty, notOursQty }
  })

  const totals = normalized.reduce((result, line) => ({
    expectedUnits: result.expectedUnits + line.expectedQty,
    actualUnits: result.actualUnits + line.goodQty + line.damagedQty,
    restockUnits: result.restockUnits + line.goodQty,
    damagedUnits: result.damagedUnits + line.damagedQty,
    notOursUnits: result.notOursUnits + line.notOursQty,
    categorizedUnits: result.categorizedUnits + line.goodQty + line.damagedQty + line.notOursQty,
  }), {
    expectedUnits: 0,
    actualUnits: 0,
    restockUnits: 0,
    damagedUnits: 0,
    notOursUnits: 0,
    categorizedUnits: 0,
  })

  const hasDiscrepancy = normalized.some((line) =>
    line.goodQty + line.damagedQty + line.notOursQty !== line.expectedQty
    || line.damagedQty > 0
    || line.notOursQty > 0
  )
  const status = totals.notOursUnits > 0 && totals.actualUnits === 0
    ? 'rejected'
    : hasDiscrepancy ? 'discrepancy' : 'received'

  return {
    ...totals,
    missingUnits: totals.expectedUnits - totals.categorizedUnits,
    hasDiscrepancy,
    status,
  }
}

export function groupReturnProducts(items = [], unresolvedSkus = []) {
  const groups = new Map()

  for (const item of items || []) {
    const skuId = String(item.sku_id || item.skuId || '').trim()
    const skuCode = String(item.sku_code || item.skuCode || '').trim()
    const key = `${skuId}\u241f${skuCode}`
    const expectedQty = toCount(item.expected_qty ?? item.expectedQty, 'Expected quantity')
    const rawSourceQty = item.source_qty ?? item.sourceQty
    const sourceQty = rawSourceQty == null ? null : toCount(rawSourceQty, 'Product quantity')
    const group = groups.get(key) || {
      key,
      skuId,
      skuCode,
      productQty: 0,
      inventoryPieces: 0,
      inventoryLines: 0,
      mappingPending: false,
    }
    group.inventoryPieces += expectedQty
    group.inventoryLines += 1
    group.productQty = Math.max(group.productQty, sourceQty || 0)
    groups.set(key, group)
  }

  for (const item of unresolvedSkus || []) {
    const skuId = String(item.skuId || item.sku_id || '').trim()
    const skuCode = String(item.skuCode || item.sku_code || '').trim()
    const key = `${skuId}\u241f${skuCode}`
    if (groups.has(key)) continue
    groups.set(key, {
      key,
      skuId,
      skuCode,
      productQty: toCount(item.quantity, 'Product quantity'),
      inventoryPieces: null,
      inventoryLines: 0,
      mappingPending: true,
    })
  }

  return [...groups.values()].map((group) => ({
    ...group,
    productQty: group.productQty || (group.inventoryPieces > 0 ? 1 : 0),
  }))
}

export function collectReturnSkuMappingCandidates(unresolvedSkus = [], relatedOrderItems = []) {
  const candidates = new Map()
  for (const item of unresolvedSkus || []) {
    const skuId = String(item.skuId || item.sku_id || '').trim()
    if (!skuId) continue
    candidates.set(skuId, {
      skuId,
      skuCode: String(item.skuCode || item.sku_code || '').trim(),
      returnQuantity: Number(item.quantity),
      reviewIssue: item.issue || 'product_catalog_mapping_required',
    })
  }
  for (const item of relatedOrderItems || []) {
    const skuId = String(item.sku_id || item.skuId || '').trim()
    if (!skuId || item.catalog_status === 'ready' || candidates.has(skuId)) continue
    candidates.set(skuId, {
      skuId,
      skuCode: String(item.sku_code || item.skuCode || '').trim(),
      returnQuantity: Number(item.quantity || 1),
      reviewIssue: 'product_catalog_mapping_required',
    })
  }
  return [...candidates.values()]
}
