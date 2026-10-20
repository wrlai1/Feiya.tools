import { createHash } from 'node:crypto'
import { renameDocumentSql } from './renameDocumentSql.js'
import { normalizeColorRenames } from '../src/utils/colorRenames.js'
import { canonicalizeColorNames, colorAliasKey } from '../src/utils/colorNames.js'
import { normalizeStyleRenames } from '../src/utils/styleRenames.js'
import { colorNameWriteGuardSql, styleNameWriteGuardSql, styleNameWriteGuardQueries } from './styleNameWriteGuards.js'
import returnDate from './returnBusinessDate.cjs'
import inventoryLedger from './inventoryLedger.cjs'
import { canonicalizeStyleNames, styleNameKey } from '../src/utils/styleNames.js'

// Explicit allowlist: external product IDs and raw evidence are not style names.
const targets = {
  inventory_color_aliases: { pk: ['style_key', 'color_key'], fields: ['style', 'color'], colorAliases: true },
  inventory_balance: { fields: ['style', 'color'] },
  inventory_txn_rows: { fields: ['style', 'color'] },
  inventory_substitutions: { fields: ['style', 'original_color', 'substitute_color'] },
  inventory_snapshots: { json: ['data'] },
  inventory_sku_corrections: { json: ['movement_changes', 'stock_changes'] },
  return_package_items: { fields: ['style', 'color'] },
  return_product_catalog: { json: ['components'], version: 'mapping_version' },
  return_product_catalog_history: { json: ['old_mapping', 'new_mapping'] },
  return_packages: { json: ['review_data'] },
  app_data: { pk: 'key', json: ['value'] },
  warehouse_tracking: { pk: 'tracking_key', json: ['order_refs'] },
  warehouse_alert_data: { pk: 'key', json: ['value'], version: 'revision' },
  inventory_email_settings: { json: ['styles'] },
  inventory_email_runs: { json: ['styles'], meta: ['status', 'payload', 'created_at', 'report_date'] },
  return_analytics_cache: { clear: true },
  inventory_email_minimum: { pk: 'sku_key', fields: ['style', 'color'], meta: ['color', 'size'], minimum: true },
  analytics_store_days: { pk: ['username', 'store', 'day'], json: ['rows'] },
  analytics_store_periods: { pk: ['username', 'store', 'period_start', 'period_end'], json: ['rows'] },
  analytics_store_settings: { pk: ['username', 'store'], json: ['data'] },
  analytics_store_events: { json: ['snapshot'] },
  analytics_store_products: { pk: ['username', 'store', 'spu'], json: ['data'] },
}
const conflict = message => Object.assign(new Error(message), { status: 409 })
const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"'

// Only small scalar rows and email status metadata leave the database.
async function readRenameRows(sql, select, params) {
  const rows = [], digest = createHash('md5')
  for (let offset = 0; ; offset += 1000) {
    const page = await sql.query(`SELECT saved.*, MD5(to_jsonb(saved)::text) AS "__rename_hash"
      FROM (${select}) saved LIMIT 1000 OFFSET $${params.length + 1}`, [...params, offset])
    for (const { __rename_hash, ...row } of page) {
      digest.update(__rename_hash)
      rows.push(Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value instanceof Date ? value.toISOString() : value])))
    }
    if (page.length < 1000) break
  }
  return { rows, version: digest.digest('hex') }
}

export async function renameStyle(sql, body, username) {
  const result = await renameStyles(sql, [body], username)
  return { ...result, ...result.renames[0] }
}

export async function renameStyles(sql, changes, username) {
  return renameInventoryNames(sql, normalizeStyleRenames(changes), username, 'style')
}

export async function renameColors(sql, changes, username) {
  return renameInventoryNames(sql, normalizeColorRenames(changes), username, 'color')
}

async function renameInventoryNames(sql, renames, username, kind) {
  const isColor = kind === 'color'
  const sourceKey = row => isColor ? colorAliasKey(row.style, row.oldColor) : styleNameKey(row.oldStyle)
  await sql`CREATE TABLE IF NOT EXISTS inventory_style_renames (
    id BIGSERIAL PRIMARY KEY, old_style TEXT NOT NULL, new_style TEXT NOT NULL,
    changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  await sql`CREATE TABLE IF NOT EXISTS inventory_style_aliases (alias_key TEXT PRIMARY KEY, style TEXT NOT NULL)`
  await sql`CREATE TABLE IF NOT EXISTS inventory_color_aliases (
    style_key TEXT NOT NULL, color_key TEXT NOT NULL, style TEXT NOT NULL, color TEXT NOT NULL, PRIMARY KEY(style_key,color_key)
  )`
  await sql`CREATE TABLE IF NOT EXISTS inventory_color_renames (
    id BIGSERIAL PRIMARY KEY, style TEXT NOT NULL, old_color TEXT NOT NULL, new_color TEXT NOT NULL,
    changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  const columns = await sql`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${Object.keys(targets)}::text[])`
  const schema = new Map()
  for (const row of columns) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set())
    schema.get(row.table_name).add(row.column_name)
  }
  const aliases = Object.fromEntries(renames.map(row => [sourceKey(row), isColor ? row.newColor : row.newStyle]))
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
    if (!['inventory_email_runs', 'inventory_color_aliases'].includes(table)) guards.push({ table, fields })
    const selected = [...new Set([...pk, ...fields, ...(config.meta || []).filter(field => available.has(field)), ...(available.has(config.version) ? [config.version] : [])])]
    const sourceStyles = renames.map(row => isColor ? row.style : row.oldStyle)
    const params = []
    let where = ''
    if (table !== 'inventory_balance') {
      if (available.has('style')) {
        params.push(sourceStyles.map(styleNameKey))
        where = ' WHERE UPPER(BTRIM(style)) = ANY($1::text[])'
      } else if (config.json?.length) {
        // Match literal JSON-encoded style text; wildcard characters in names
        // must never broaden the query. Whole documents are kept for safe edits.
        const terms = []
        for (const style of sourceStyles) {
          const literal = JSON.stringify(style).slice(1,-1).replace(/[\\%_]/g, '\\$&')
          params.push('%' + literal + '%')
          terms.push('(' + config.json.filter(field => available.has(field)).map(field => quote(field) + '::text ILIKE $' + params.length).join(' OR ') + ')')
        }
        where = ' WHERE (' + terms.join(' OR ') + ')'
      }
    }
    const projection = selected.map(field => table === 'inventory_email_runs' && field === 'payload'
      ? '(payload IS NOT NULL) AS "payload"'
      : ['day','period_start','period_end','report_date','created_at'].includes(field) ? quote(field) + '::text AS ' + quote(field) : quote(field)).join(',')
    const select = `SELECT ${projection} FROM ${quote(table)}${where} ORDER BY ${pk.map(quote).join(',')}`
    if (config.json?.length && table !== 'inventory_email_runs') {
      const fingerprint = `SELECT MD5(COALESCE(string_agg(MD5(to_jsonb(saved)::text), ''), '')) AS version FROM (${select}) saved`
      const [{ version }] = await sql.query(fingerprint, params)
      checks.push({ query: `SELECT 1 / CASE WHEN version = $${params.length + 1} THEN 1 ELSE 0 END FROM (${fingerprint}) current`, params: [...params, version] })
      const updateParams = [...params, JSON.stringify(aliases), isColor]
      const aliasBind = `$${params.length + 1}::jsonb`, kindBind = `$${params.length + 2}::boolean`
      const documentFields = config.json.filter(field => available.has(field))
      const transformed = documentFields.map(field => `pg_temp.inventory_rename_document(${quote(field)}, ${aliasBind}, ${kindBind}, ${"'" + field + "'"}) AS ${quote(field)}`)
      const set = documentFields.map(field => {
        let value = `renamed.${quote(field)}`
        if (table === 'app_data' && field === 'value') {
          value = `CASE WHEN jsonb_typeof(${value}) = 'object' AND jsonb_typeof(${value}->'rows') = 'array'
            THEN jsonb_set(${value}, '{revision}', to_jsonb(COALESCE((${value}->>'revision')::numeric, 1) + 1)) ELSE ${value} END`
        }
        return `${quote(field)} = ${value}`
      })
      if (available.has(config.version)) set.push(`${quote(config.version)} = original.${quote(config.version)} + 1`)
      queries.push({ query: `WITH renamed AS MATERIALIZED (
        SELECT ${pk.map(quote).join(',')}, ${transformed.join(',')} FROM ${quote(table)}${where}
      ) UPDATE ${quote(table)} original SET ${set.join(',')}
      FROM renamed WHERE ${pk.map(field => `original.${quote(field)} IS NOT DISTINCT FROM renamed.${quote(field)}`).join(' AND ')}
        AND (${documentFields.map(field => `original.${quote(field)} IS DISTINCT FROM renamed.${quote(field)}`).join(' OR ')})`, params: updateParams })
      continue
    }
    const { rows, version } = await readRenameRows(sql, select, params)
    const fingerprint = `SELECT MD5(COALESCE(string_agg(MD5(to_jsonb(saved)::text), ''), '')) AS version FROM (${select}) saved`
    checks.push({ query: `SELECT 1 / CASE WHEN version = $${params.length + 1} THEN 1 ELSE 0 END FROM (${fingerprint}) current`, params: [...params, version] })
    if (table === 'inventory_balance') {
      for (const change of renames) {
        const sourceStyle = isColor ? change.style : change.oldStyle
        const count = rows.filter(row => styleNameKey(row.style) === styleNameKey(sourceStyle)
          && (!isColor || styleNameKey(row.color) === styleNameKey(change.oldColor))).length
        if (!count) throw conflict(`${isColor ? 'Color' : 'Style'} ${sourceStyle}${isColor ? ' / ' + change.oldColor : ''} changed or no longer exists. Refresh and try again.`)
        sourceCounts.set(sourceKey(change), count)
        updated += count
        const collision = isColor ? rows.some(row => styleNameKey(row.style) === styleNameKey(change.style)
          && styleNameKey(row.color) !== styleNameKey(change.oldColor) && styleNameKey(row.color) === styleNameKey(change.newColor))
          : rows.some(row => styleNameKey(row.style) !== styleNameKey(change.oldStyle) && inventoryLedger.styleKey(row.style) === inventoryLedger.styleKey(change.newStyle))
        if (collision) throw conflict(`The new ${kind} name ${isColor ? change.newColor : change.newStyle} already exists. Choose a different name.`)
      }
    }
    for (const row of rows) {
      if (table === 'inventory_email_runs' && row.status === 'sent') continue
      if (isColor && table === 'inventory_email_runs' && row.styles.some(style => renames.some(change => styleNameKey(change.style) === styleNameKey(style)))) {
        if ((row.status === 'sending' && Date.now() - Date.parse(row.created_at) < 10 * 60 * 1000)
          || (row.status === 'failed' && row.payload && row.report_date === returnDate.newYorkDate())) {
          throw conflict('A daily email is sending or awaiting retry. Finish that email before renaming colors.')
        }
      }
      const next = isColor ? canonicalizeColorNames(row, aliases) : canonicalizeStyleNames(row, aliases)
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
      if (config.colorAliases) next.style_key = styleNameKey(next.style)
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
  const reserved = isColor
    ? await sql`SELECT style_key, color_key, color FROM inventory_color_aliases WHERE style_key = ANY(${renames.map(row => styleNameKey(row.style))}::text[])`
    : await sql`SELECT alias_key, style FROM inventory_style_aliases WHERE alias_key = ANY(${renames.map(row => styleNameKey(row.newStyle))}::text[])`
  for (const change of renames) {
    const existing = isColor ? reserved.find(row => row.style_key === styleNameKey(change.style) && row.color_key === styleNameKey(change.newColor))
      : reserved.find(row => row.alias_key === styleNameKey(change.newStyle))
    if (existing && (isColor ? styleNameKey(existing.color) !== styleNameKey(change.oldColor) : styleNameKey(existing.style) !== styleNameKey(change.oldStyle))) {
      throw conflict('This name belongs to another inventory target or its previous name.')
    }
  }
  const changesJson = JSON.stringify(renames.map(row => ({ ...row,
    styleKey: isColor ? styleNameKey(row.style) : null,
    oldKey: styleNameKey(isColor ? row.oldColor : row.oldStyle), newKey: styleNameKey(isColor ? row.newColor : row.newStyle),
    reportKey: isColor ? null : inventoryLedger.styleKey(row.newStyle), expected: sourceCounts.get(sourceKey(row)) })))
  try {
    await sql.transaction(txn => [
      txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
      txn`SELECT pg_advisory_xact_lock(hashtext('analytics-store-write'))`,
      // Lock the relevant tables in a fixed order; compare saved documents again
      // under these locks so concurrent imports cannot be partly overwritten.
      txn.query(`LOCK TABLE ${[...schema.keys(), 'inventory_style_aliases', 'inventory_style_renames', 'inventory_color_renames'].sort().map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`),
      isColor ? txn`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("styleKey" TEXT,"oldKey" TEXT,"newKey" TEXT,expected INT)
      ), valid AS (
        SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM incoming WHERE
          (SELECT COUNT(*) FROM inventory_balance WHERE UPPER(BTRIM(style))=incoming."styleKey" AND UPPER(BTRIM(color))=incoming."oldKey") <> incoming.expected
          OR EXISTS (SELECT 1 FROM inventory_balance WHERE UPPER(BTRIM(style))=incoming."styleKey" AND UPPER(BTRIM(color))=incoming."newKey" AND UPPER(BTRIM(color))<>incoming."oldKey")
          OR EXISTS (SELECT 1 FROM inventory_color_aliases WHERE style_key=incoming."styleKey" AND color_key=incoming."newKey" AND UPPER(BTRIM(color))<>incoming."oldKey")
        )
      ) SELECT 1 / COUNT(*)::int FROM valid` : txn`WITH incoming AS (
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
      ...renameDocumentSql.map(query => txn.query(query)),
      ...(isColor ? [
        txn`UPDATE inventory_color_aliases aliases SET color=changes."newColor"
          FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("styleKey" TEXT,"oldKey" TEXT,"newColor" TEXT)
          WHERE aliases.style_key=changes."styleKey" AND UPPER(BTRIM(aliases.color))=changes."oldKey"`,
        ...['oldKey','newKey'].map(key => txn.query(
          `INSERT INTO inventory_color_aliases(style_key,color_key,style,color)
           SELECT "styleKey", "${key}", style, "newColor" FROM jsonb_to_recordset($1::jsonb) AS changes("styleKey" TEXT,"oldKey" TEXT,"newKey" TEXT,style TEXT,"newColor" TEXT)
           ON CONFLICT(style_key,color_key) DO UPDATE SET color=EXCLUDED.color`, [changesJson])),
      ] : [txn`UPDATE inventory_style_aliases aliases SET style = changes."newStyle"
        FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldKey" TEXT, "newStyle" TEXT)
        WHERE UPPER(BTRIM(aliases.style)) = changes."oldKey"`,
      txn`INSERT INTO inventory_style_aliases(alias_key,style)
        SELECT "oldKey", "newStyle" FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldKey" TEXT,"newStyle" TEXT)
        ON CONFLICT(alias_key) DO UPDATE SET style = EXCLUDED.style`,
      txn`INSERT INTO inventory_style_aliases(alias_key,style)
        SELECT "newKey", "newStyle" FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("newKey" TEXT,"newStyle" TEXT)
        ON CONFLICT(alias_key) DO UPDATE SET style = EXCLUDED.style`]),
      ...queries.map(query => txn.query(query.query, query.params)),
      txn.query(styleNameWriteGuardSql),
      txn.query(colorNameWriteGuardSql),
      ...guards.flatMap(({ table, fields }) => styleNameWriteGuardQueries(txn, table, fields, quote)),
      isColor ? txn`INSERT INTO inventory_color_renames(style,old_color,new_color,changed_by)
        SELECT style,"oldColor","newColor",${username} FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes(style TEXT,"oldColor" TEXT,"newColor" TEXT)`
        : txn`INSERT INTO inventory_style_renames(old_style,new_style,changed_by)
        SELECT "oldStyle", "newStyle", ${username} FROM jsonb_to_recordset(${changesJson}::jsonb) AS changes("oldStyle" TEXT,"newStyle" TEXT)`,
    ], { isolationLevel: 'Serializable' })
  } catch (error) {
    if (['22012', '40001', '23505', '40P01', 'PST01'].includes(error.code) || /division by zero|serializ|duplicate key|deadlock/i.test(error.message)) {
      throw conflict('Related data changed or the name conflicts. Refresh and try again; no changes were saved.')
    }
    throw error
  }
  return { ok: true, updated, renames, [isColor ? 'renamedColors' : 'renamedStyles']: renames.length }
}
