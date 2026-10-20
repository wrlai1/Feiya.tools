// Platform SKU/SPU IDs, source filenames, notes and deduplication keys stay intact.
const styleFields = new Set(['style', 'style_n', 'targetstyle', 'originalstyle', 'stylename', 'stylenumber', 'style_number', 'style number', '款号', '内部款号'])
const listFields = new Set(['styles', 'selectedstyles'])
export const styleNameKey = value => String(value ?? '').trim().toUpperCase()

export function resolveStyleName(value, aliases = {}) {
  return typeof value === 'string' ? (aliases[styleNameKey(value)] ?? value) : value
}

function warehouseIdentity(value, aliases, prefix = '') {
  if (typeof value !== 'string' || !value.startsWith(prefix + '[')) return value
  try {
    const identity = JSON.parse(value.slice(prefix.length))
    if (Array.isArray(identity) && identity.length === 3 && aliases[styleNameKey(identity[0])]) {
      identity[0] = String(resolveStyleName(identity[0], aliases)).trim().toLowerCase()
      return prefix + JSON.stringify(identity)
    }
  } catch { /* A non-SKU string remains unchanged. */ }
  return value
}

export function canonicalizeStyleNames(value, aliases = {}, field = '') {
  if (styleFields.has(field.toLowerCase())) return resolveStyleName(value, aliases)
  if (field === 'target' && typeof value === 'string') return warehouseIdentity(value, aliases, 'sku:')
  if (listFields.has(field.toLowerCase()) && Array.isArray(value)) {
    return [...new Set(value.map(item => resolveStyleName(item, aliases)))]
  }
  if (Array.isArray(value)) return value.map(item => canonicalizeStyleNames(item, aliases))
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const nextKey = warehouseIdentity(key, aliases, 'sku:')
    if (Object.hasOwn(result, nextKey)) {
      throw Object.assign(new Error('Style names conflict in saved warehouse overrides. Resolve the duplicate before renaming.'), { status: 409 })
    }
    // Define an own property, including for imported keys such as __proto__.
    Object.defineProperty(result, nextKey, { value: canonicalizeStyleNames(item, aliases, key), enumerable: true, configurable: true, writable: true })
  }
  if (typeof value.style === 'string' && typeof value.key === 'string') result.key = warehouseIdentity(value.key, aliases)
  return result
}
