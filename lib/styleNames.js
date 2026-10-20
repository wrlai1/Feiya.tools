import { canonicalizeColorNames, colorAliasKey } from '../src/utils/colorNames.js'
import { canonicalizeStyleNames } from '../src/utils/styleNames.js'

export async function loadStyleAliases(sql) {
  const [schema] = await sql`SELECT to_regclass('inventory_style_aliases')::text AS aliases`
  if (!schema?.aliases) return {}
  const rows = await sql`SELECT alias_key, style FROM inventory_style_aliases`
  return Object.fromEntries(rows.map(row => [row.alias_key, row.style]))
}

export async function loadColorAliases(sql) {
  const [schema] = await sql`SELECT to_regclass('inventory_color_aliases')::text AS colors`
  if (!schema?.colors) return {}
  const rows = await sql`SELECT style_key,color_key,color FROM inventory_color_aliases`
  return Object.fromEntries(rows.map(row => [colorAliasKey(row.style_key,row.color_key),row.color]))
}

// Resolve old files and already-open forms before SKU lookup, not after writing.
export async function canonicalizeStyleRequest(sql, req) {
  const aliases = await loadStyleAliases(sql)
  const colors = await loadColorAliases(sql)
  if (req.body) req.body = canonicalizeColorNames(canonicalizeStyleNames(req.body, aliases), colors)
  if (req.query?.style) req.query.style = canonicalizeStyleNames({ style: req.query.style }, aliases).style
  return aliases
}
