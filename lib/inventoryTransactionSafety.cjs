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

module.exports = {
  normalizeInventoryQuantity,
  normalizeOrderClaims,
}
