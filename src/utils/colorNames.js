import { resolveStyleName, styleNameKey } from './styleNames.js'

export const colorAliasKey = (style, color) => JSON.stringify([styleNameKey(style), styleNameKey(color)])
export const resolveColorName = (style, color, aliases = {}) => typeof color === 'string'
  ? (aliases[colorAliasKey(style, color)] ?? color) : color
const colorFields = new Set(['color', 'color_n', 'targetcolor', 'original_color', 'substitute_color', 'originalcolor', 'substitutecolor'])

function identity(value, aliases, prefix = '') {
  if (typeof value !== 'string' || !value.startsWith(prefix + '[')) return value
  try {
    const parts = JSON.parse(value.slice(prefix.length))
    if (Array.isArray(parts) && parts.length === 3 && aliases[colorAliasKey(parts[0], parts[1])]) {
      parts[1] = String(resolveColorName(parts[0], parts[1], aliases)).trim().toLowerCase()
      return prefix + JSON.stringify(parts)
    }
  } catch { /* Ordinary strings are not inventory keys. */ }
  return value
}

export function canonicalizeColorNames(value, aliases = {}, field = '', parentStyle = '') {
  if (colorFields.has(field.toLowerCase())) return resolveColorName(parentStyle, value, aliases)
  if (field === 'target' && typeof value === 'string') return identity(value, aliases, 'sku:')
  if (Array.isArray(value)) return value.map(item => canonicalizeColorNames(item, aliases, field, parentStyle))
  if (!value || typeof value !== 'object') return value
  const style = value.style ?? value.Style ?? value.STYLE ?? value.style_n ?? value.styleNumber ?? value.style_number ?? value['Style Number'] ?? value['款号'] ?? value['内部款号'] ?? value.targetStyle ?? parentStyle
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const nextKey = identity(key, aliases, 'sku:')
    if (Object.hasOwn(result, nextKey)) throw Object.assign(new Error('Color names conflict in saved warehouse overrides. Resolve the duplicate first.'), { status: 409 })
    Object.defineProperty(result, nextKey, { value: canonicalizeColorNames(item, aliases, key, key.toLowerCase() === 'targetcolor' ? value.targetStyle ?? style : style), enumerable: true, configurable: true, writable: true })
  }
  if (typeof value.key === 'string' && style) result.key = identity(value.key, aliases)
  return result
}

export function rekeyColorAliases(aliases, styleAliases) {
  return Object.fromEntries(Object.entries(aliases || {}).map(([key, color]) => {
    const [style, oldColor] = JSON.parse(key)
    return [colorAliasKey(resolveStyleName(style, styleAliases), oldColor), color]
  }))
}
