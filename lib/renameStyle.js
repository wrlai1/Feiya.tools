import { normalizeStyleRenames } from '../src/utils/styleRenames.js'
import { styleNameWriteGuardSql, styleNameWriteGuardQueries } from './styleNameWriteGuards.js'
import returnDate from './returnBusinessDate.cjs'
import inventoryLedger from './inventoryLedger.cjs'
import { canonicalizeStyleNames, styleNameKey } from '../src/utils/styleNames.js'

// Explicit allowlist: external product IDs and raw evidence are not style names.
const targets = {
  inventory_balance: { fields: ['style'] },
  inventory_txn_rows: { fields: ['style'] },
  inventory_substitutions: { fields: ['style'] },
  inventory_snapshots: { json: ['data'] },
  inventory_sku_corrections: { json: ['movement_changes', 'stock_changes'] },
  return_package_items: { fields: ['style'] },
  return_product_catalog: { json: ['components'], version: 'mapping_version' },
  return_product_catalog_history: { json: ['old_mapping', 'new_mapping'] },
  return_packages: { json: ['review_data'] },
  app_data: { pk: 'key', json: ['value'] },
  warehouse_tracking: { pk: 'tracking_key', json: ['order_refs'] },
  warehouse_alert_data: { pk: 'key', json: ['value'], version: 'revision' },
  inventory_email_settings: { json: ['styles'] },
  inventory_email_runs: { json: ['styles'], meta: ['status', 'payload', 'created_at', 'report_date'] },
  return_analytics_cache: { clear: true },
  inventory_email_minimum: { pk: 'sku_key', fields: ['style'], meta: ['color', 'size'], minimum: true },
  analytics_store_days: { pk: ['username', 'store', 'day'], json: ['rows'] },
  analytics_store_periods: { pk: ['username', 'store', 'period_start', 'period_end'], json: ['rows'] },
  analytics_store_settings: { pk: ['username', 'store'], json: ['data'] },
  analytics_store_events: { json: ['snapshot'] },
  analytics_store_products: { pk: ['username', 'store', 'spu'], json: ['data'] },
}
const conflict = message => Object.assign(new Error(message), { status: 409 })
const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"'

export async function renameStyle(sql, body, username) {
  const result = await renameStyles(sql, [body], username)
  return { ...result, ...result.renames[0] }
}

export async function renameStyles(sql, changes, username) {
  const renames = normalizeStyleRenames(changes)
  await sql`CREATE TABLE IF NOT EXISTS inventory_style_renames (
    id BIGSERIAL PRIMARY KEY, old_style TEXT NOT NULL, new_style TEXT NOT NULL,
    changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  await sql`CREATE TABLE IF NOT EXISTS inventory_style_aliases (alias_key TEXT PRIMARY KEY, style TEXT NOT NULL)`
  const columns = await sql`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${Object.keys(targets)}::text[])`
  const schema = new Map()
  for (const row of columns) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set())
    schema.get(row.table_name).add(row.column_name)
  }
  const aliases = Object.fromEntries(renames.map(({ oldStyle, newStyle }) => [styleNameKey(oldStyle), newStyle]))
  const sourceCounts = new Map()
  const queries = []
  const checks = []
  const guards = []
  let updated = 0
  for (const [table, config] of Object.entries(targets)) {
    const available = schema.get(table)
    if (!available) continue
    if (config.clear) {
      queries.push({ query: 'DELETE FROM ' + quote(table), params: [] })
      continue
    }
    const pk = [].concat(config.pk || 'id')
    const fields = [...(config.fields || []), ...(config.json || [])].filter(field => available.has(field))
    if (!fields.length || pk.some(field => !available.has(field))) continue
    if (table !== 'inventory_email_runs') guards.push({ table, fields })
    const selected = [...new Set([...pk, ...fields, ...(config.meta || []).filter(field => available.has(field)), ...(available.has(config.version) ? [config.version] : [])])]
    const select = `SELECT ${selected.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${pk.map(quote).join(',')}`
    const fingerprint = `SELECT COALESCE(jsonb_agg(to_jsonb(saved)), '[]'::jsonb) AS rows, MD5(COALESCE(jsonb_agg(to_jsonb(saved)), '[]'::jsonb)::text) AS version FROM (${select}) saved`
    const [snapshot] = await sql.query(fingerprint)
    const rows = snapshot.rows
    checks.push({ query: `SELECT 1 / CASE WHEN version = $1 THEN 1 ELSE 0 END FROM (${fingerprint}) current`, params: [snapshot.version] })
    if (table === 'inventory_balance') {
      for (const { oldStyle, newStyle } of renames) {
        const count = rows.filter(row => styleNameKey(row.style) === styleNameKey(oldStyle)).length
        if (!count) throw conflict(`Style ${oldStyle} changed or no longer exists. Refresh and try again.`)
        sourceCounts.set(styleNameKey(oldStyle), count)
        updated += count
        if (rows.some(row => styleNameKey(row.style) !== styleNameKey(oldStyle)
          && inventoryLedger.styleKey(row.style) === inventoryLedger.styleKey(newStyle))) {
          throw conflict(`The new style name ${newStyle} already exists. Choose a different name.`)
        }
      }
    }
    for (const row of rows) {
      if (table === 'inventory_email_runs' && row.status === 'sent') continue
      const next = { ...row }
      for (const field of config.fields || []) if (fields.includes(field)) next[field] = canonicalizeStyleNames({ style: row[field] }, aliases).style
      for (const field of config.json || []) if (fields.includes(field)) next[field] = canonicalizeStyleNames(row[field], aliases, field)
      if (JSON.stringify(next) === JSON.stringify(row)) continue
      if (table === 'inventory_email_runs') {
        if ((row.status === 'sending' && Date.now() - Date.parse(row.created_at) < 10 * 60 * 1000)
          || (row.status === 'failed' && row.payload && row.report_date === returnDate.newYorkDate())) {
          throw conflict('A daily email is sending or awaiting retry. Finish that email before renaming the style.')
        }
        // Provider retries must reuse their exact payload/idempotency key.
        // Completed and older attempts remain historical records.
        continue
      }
      if (config.minimum) next.sku_key = inventoryLedger.skuKey(next)
      // Invalidate stale forms rather than let them overwrite the renamed data.
      if (table === 'app_data' && next.value && !Array.isArray(next.value) && Array.isArray(next.value.rows)) {
        next.value = { ...next.value, revision: Number(next.value.revision || 1) + 1 }
      }
      if (available.has(config.version)) next[config.version] = Number(row[config.version]) + 1
      const changed = Object.keys(next).filter(field => JSON.stringify(next[field]) !== JSON.stringify(row[field]))
      const params = []
      const bind = (field, value) => {
        params.push(config.json?.includes(field) ? JSON.stringify(value) : value)
        return `$${params.length}${config.json?.includes(field) ? '::jsonb' : ''}`
      }
      const set = changed.map(field => `${quote(field)} = ${bind(field, next[field])}`)
      const where = pk.map(field => `${quote(field)} IS NOT DISTINCT FROM ${bind(field, row[field])}`)
      // A stale document must abort the entire transaction, including the audit.
      queries.push({ query: `WITH changed AS (UPDATE ${quote(table)} SET ${set.join(',')} WHERE ${where.join(' AND ')} RETURNING 1)
        SELECT 1 / COUNT(*)::int AS saved FROM changed`, params })
    }
  }
  const reserved = await sql`SELECT alias_key, style FROM inventory_style_aliases WHERE alias_key = ANY(${renames.map(row => styleNameKey(row.newStyle))}::text[])`
  for (const { oldStyle, newStyle } of renames) {
    const existing = reserved.find(row => row.alias_key === styleNameKey(newStyle))
    if (existing && styleNameKey(existing.style) !== styleNameKey(oldStyle)) {
      throw conflict(`Name ${newStyle} belongs to another style or its previous name.`)
    }
  }
  const changesJson = JSON.stringify(renames.map(row => ({ ...row, oldKey: styleNameKey(row.oldStyle),
    newKey: styleNameKey(row.newStyle), reportKey: inventoryLedger.styleKey(row.newStyle), expected: sourceCounts.get(styleNameKey(row.oldStyle)) })))
  try {
    await sql.transaction(txn => [
      txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
      txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
      // Lock the relevant tables in a fixed order; compare saved documents again
      // under these locks so concurrent imports cannot be partly overwritten.
      txn.query(`LOCK TABLE ${[...schema.keys(), 'inventory_style_aliases', 'inventory_style_renames'].sort().map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`),
      txn`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldKey" TEXT, "newKey" TEXT, "reportKey" TEXT, expected INT)
      ), valid AS (
        SELECT 1 WHERE NOT EXISTS (
          SELECT 1 FROM incoming WHERE
            (SELECT COUNT(*) FROM inventory_balance WHERE UPPER(BTRIM(style)) = incoming."oldKey") <> incoming.expected
            OR EXISTS (SELECT 1 FROM inventory_balance WHERE UPPER(BTRIM(style)) <> incoming."oldKey"
              AND UPPER(REGEXP_REPLACE(BTRIM(style), '[[:space:]_-]', '', 'g')) = incoming."reportKey")
            OR EXISTS (SELECT 1 FROM inventory_style_aliases WHERE alias_key = incoming."newKey" AND UPPER(BTRIM(style)) <> incoming."oldKey")
        )
      ) SELECT 1 / COUNT(*)::int FROM valid`,
      ...checks.map(query => txn.query(query.query, query.params)),
      txn`UPDATE inventory_style_aliases aliases SET style = changes."newStyle"
        FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldKey" TEXT, "newStyle" TEXT)
        WHERE UPPER(BTRIM(aliases.style)) = changes."oldKey"`,
      txn`INSERT INTO inventory_style_aliases(alias_key,style)
        SELECT "oldKey", "newStyle" FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldKey" TEXT,"newStyle" TEXT)
        ON CONFLICT(alias_key) DO UPDATE SET style = EXCLUDED.style`,
      txn`INSERT INTO inventory_style_aliases(alias_key,style)
        SELECT "newKey", "newStyle" FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("newKey" TEXT,"newStyle" TEXT)
        ON CONFLICT(alias_key) DO UPDATE SET style = EXCLUDED.style`,
      ...queries.map(query => txn.query(query.query, query.params)),
      txn.query(styleNameWriteGuardSql),
      ...guards.flatMap(({ table, fields }) => styleNameWriteGuardQueries(txn, table, fields, quote)),
      txn`INSERT INTO inventory_style_renames(old_style,new_style,changed_by)
        SELECT "oldStyle", "newStyle", ${username} FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldStyle" TEXT,"newStyle" TEXT)`,
    ], { isolationLevel: 'Serializable' })
  } catch (error) {
    if (['22012', '40001', '23505', '40P01', 'PST01'].includes(error.code) || /division by zero|serializ|duplicate key|deadlock/i.test(error.message)) {
      throw conflict('Related data changed or the name conflicts. Refresh and try again; no changes were saved.')
    }
    throw error
  }
  return { ok: true, updated, renames, renamedStyles: renames.length }
}
