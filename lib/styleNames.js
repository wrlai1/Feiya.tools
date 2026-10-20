import { canonicalizeStyleNames } from '../src/utils/styleNames.js'

export async function loadStyleAliases(sql) {
  const [schema] = await sql`SELECT to_regclass('inventory_style_aliases')::text AS aliases`
  if (!schema?.aliases) return {}
  const rows = await sql`SELECT alias_key, style FROM inventory_style_aliases`
  return Object.fromEntries(rows.map(row => [row.alias_key, row.style]))
}

// Resolve old files and already-open forms before SKU lookup, not after writing.
export async function canonicalizeStyleRequest(sql, req) {
  const aliases = await loadStyleAliases(sql)
  if (req.body) req.body = canonicalizeStyleNames(req.body, aliases)
  if (req.query?.style) req.query.style = canonicalizeStyleNames({ style: req.query.style }, aliases).style
  return aliases
}
