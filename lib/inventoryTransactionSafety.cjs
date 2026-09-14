function cleanKey(value, maxLength) {
  return String(value ?? '').trim().toLowerCase().slice(0, maxLength)
}

function normalizeOrderClaims(rawClaims) {
  if (rawClaims == null) return []
  if (!Array.isArray(rawClaims)) throw new Error('orderClaims must be an array')
  if (rawClaims.length > 20000) throw new Error('Too many order items in one deduction')

  const claims = []
  const seen = new Set()
  for (const raw of rawClaims) {
    const orderKey = cleanKey(raw?.orderKey ?? raw?.orderNumber, 120)
    const itemKey = cleanKey(raw?.itemKey, 1000)
    if (!orderKey || !itemKey) throw new Error('Every order claim requires an order number and item key')
    const key = `${orderKey}\u241f${itemKey}`
    if (seen.has(key)) continue
    seen.add(key)
    claims.push({ orderKey, itemKey })
  }
  return claims
}

function normalizeInventoryQuantity(value) {
  const quantity = Number(value)
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a whole number of 0 or more')
  }
  return quantity
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null)
}

function inventoryIdentity(style, color, size) {
  const normalizedSize = String(size).trim().toUpperCase()
    .replace(/^([123])XL$/, '$1X')
  return [style, color, normalizedSize]
    .map((value) => String(value).trim().toLowerCase())
    .join('\u241f')
}

function normalizeInventoryRows(rawRows, { defaultSortOrder = true } = {}) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('At least one inventory row is required')
  }
  if (rawRows.length > 50000) throw new Error('Too many inventory rows in one import')

  const seen = new Map()
  return rawRows.map((raw, index) => {
    const rowNumber = index + 2
    const style = String(firstDefined(raw?.Style, raw?.style, raw?.STYLE, '')).trim()
    const color = String(firstDefined(raw?.Color, raw?.color, raw?.COLOR, '')).trim()
    const size = String(firstDefined(raw?.Size, raw?.size, raw?.SIZE, '')).trim()
    if (!style || !color || !size) {
      throw new Error(`Inventory row ${rowNumber} requires Style, Color, and Size`)
    }

    const rawQuantity = firstDefined(raw?.Quantity, raw?.quantity, raw?.QUANTITY, 0)
    let quantity
    try {
      quantity = normalizeInventoryQuantity(rawQuantity === '' ? 0 : rawQuantity)
    } catch {
      throw new Error(`Inventory row ${rowNumber} Quantity must be a whole number of 0 or more`)
    }

    const rawSortOrder = firstDefined(raw?.SortOrder, raw?.sort_order, raw?.sortOrder)
    let sortOrder = defaultSortOrder ? index : null
    if (rawSortOrder !== undefined && rawSortOrder !== '') {
      const parsed = Number(rawSortOrder)
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Inventory row ${rowNumber} SortOrder must be a whole number of 0 or more`)
      }
      sortOrder = parsed
    }

    const identity = inventoryIdentity(style, color, size)
    if (seen.has(identity)) {
      throw new Error(
        `Inventory rows ${seen.get(identity)} and ${rowNumber} describe the same Style / Color / Size`,
      )
    }
    seen.set(identity, rowNumber)
    return { style, color, size, quantity, sort_order: sortOrder }
  })
}

function orderClaimsToSqlRecords(claims) {
  return (claims || []).map(({ orderKey, itemKey }) => ({
    order_key: orderKey,
    item_key: itemKey,
  }))
}

module.exports = {
  inventoryIdentity,
  normalizeInventoryQuantity,
  normalizeInventoryRows,
  normalizeOrderClaims,
  orderClaimsToSqlRecords,
}
