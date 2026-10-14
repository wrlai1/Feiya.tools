import { createHash } from 'node:crypto'

const clean = value => String(value || '').trim()
const norm = value => clean(value).toUpperCase()
const sizeKey = value => norm(value).replace(/^([1-5])XL$/, '$1X')
const key = row => [norm(row.style), norm(row.color), sizeKey(row.size)].join('|')

export function planReturnMappingMigration(catalog, inventory, pending, fromStyle, toStyle) {
  const targets = new Map()
  for (const row of inventory) {
    const k = key(row)
    if (!targets.has(k)) targets.set(k, [])
    targets.get(k).push(row)
  }
  const rows = []
  for (const saved of catalog) {
    if (!(saved.components || []).some(c => norm(c.style) === norm(fromStyle))) continue
    const issues = [], changes = [], components = []
    if (saved.status !== 'ready') issues.push('原匹配仍待审核，请先单独核对')
    for (const component of saved.components) {
      if (norm(component.style) !== norm(fromStyle)) { components.push(component); continue }
      const found = targets.get(key({ ...component, style: toStyle })) || []
      if (found.length !== 1 || !Number.isInteger(Number(component.qty)) || Number(component.qty) < 1) {
        issues.push(`${component.color} / ${component.size}: ${found.length > 1 ? '目标库存有多个匹配' : '目标库存不存在或原匹配无效'}`)
        continue
      }
      const next = { style: found[0].style, color: found[0].color, size: found[0].size, qty: Number(component.qty) }
      changes.push({ old: component, next })
      components.push(next)
    }
    const merged = new Map()
    for (const component of components) {
      const k = key(component)
      if (merged.has(k)) merged.get(k).qty += Number(component.qty)
      else merged.set(k, { ...component, qty: Number(component.qty) })
    }
    const items = []
    for (const item of pending.filter(p => p.store_key === saved.store_key && p.sku_id === saved.sku_id)) {
      const change = changes.find(c => key(c.old) === key(item))
      if (!change) continue
      if (pending.some(other => other.id !== item.id && other.package_id === item.package_id && other.sku_id === item.sku_id && key(other) === key(change.next))) {
        issues.push(`包裹 ${item.tracking_number}: 目标颜色尺码已存在，请单独核对`)
      }
      items.push({ ...item, new_style: change.next.style, new_color: change.next.color, new_size: change.next.size })
    }
    const destinations = new Set()
    for (const item of items) {
      const destination = item.package_id + '|' + item.sku_id + '|' + key({ style: item.new_style, color: item.new_color, size: item.new_size })
      if (destinations.has(destination)) issues.push(`包裹 ${item.tracking_number}: 多个项目将合并到同一目标，请单独核对`)
      destinations.add(destination)
    }
    if ([...merged.values()].some(c => !Number.isSafeInteger(c.qty) || c.qty < 1 || c.qty > 9999)) issues.push('匹配件数无效，请先单独核对')
    rows.push({ id: Number(saved.id), store: saved.store_name, sku: saved.sku_id, skuCode: saved.sku_code,
      old: saved, components: [...merged.values()], changes, pending: items, issues: [...new Set(issues)] })
  }
  return rows
}

async function loadPlan(sql, options) {
  const [catalog, inventory, pending] = await sql.transaction([
    sql`SELECT id,store_name,store_key,sku_id,sku_code,components,status,issue,mapping_source,mapping_version,updated_at
      FROM return_product_catalog WHERE (${options.allStores}::boolean OR store_key=${options.storeKey}) ORDER BY id`,
    sql`SELECT style,color,size FROM inventory_balance ORDER BY id`,
    sql`SELECT items.*,packages.store_key,packages.tracking_number FROM return_package_items items
      JOIN return_packages packages ON packages.id=items.package_id
      WHERE packages.status IN ('pending','needs_review') AND packages.confirmed_at IS NULL
        AND (${options.allStores}::boolean OR packages.store_key=${options.storeKey}) ORDER BY items.id`,
  ], { isolationLevel: 'RepeatableRead', readOnly: true })
  const rows = planReturnMappingMigration(catalog, inventory, pending, options.fromStyle, options.toStyle)
  const token = createHash('sha256').update(JSON.stringify({ options, rows })).digest('hex')
  return { rows, token, sourceStyles: [...new Set(catalog.flatMap(r => (r.components || []).map(c => c.style)))].sort(), targetStyles: [...new Set(inventory.map(r => r.style))].sort() }
}

export async function returnMappingMigration(req, res, sql, user) {
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
  const body = req.body || {}
  const options = { storeKey: clean(body.storeName).toLowerCase(), allStores: body.allStores === true, fromStyle: clean(body.fromStyle), toStyle: clean(body.toStyle) }
  if (!options.allStores && !options.storeKey) return res.status(400).json({ error: '请选择店铺' })
  const plan = await loadPlan(sql, options)
  if (req.query.action === 'catalog-migrate-preview') return res.json(plan)
  if (!options.fromStyle || !options.toStyle || norm(options.fromStyle) === norm(options.toStyle)) return res.status(400).json({ error: '请选择不同的旧款式和新款式' })
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))] : []
  if (!ids.length || ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id))) return res.status(400).json({ error: '请选择 1–1000 条已核对的匹配' })
  if (body.token !== plan.token) return res.status(409).json({ error: '匹配或待处理包裹已变化，请重新预览' })
  const selected = plan.rows.filter(row => ids.includes(row.id))
  if (selected.length !== ids.length || selected.some(row => row.issues.length)) return res.status(409).json({ error: '存在未解决的匹配，请重新预览并核对' })
  const mappings = selected.map(row => ({ id: row.id, version: row.old.mapping_version, old_components: row.old.components, old_status: row.old.status, old_source: row.old.mapping_source, components: row.components }))
  const pending = selected.flatMap(row => row.pending)
  const targets = selected.flatMap(row => row.changes.map(change => change.next))
  const results = await sql.transaction(txn => [
    txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
    txn`SELECT id FROM return_packages WHERE id=ANY(${[...new Set(pending.map(p => Number(p.package_id)))]}::bigint[]) ORDER BY id FOR UPDATE`,
    txn`WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(mappings)}::jsonb) AS r(id BIGINT,version INT,old_components JSONB,old_status TEXT,old_source TEXT,components JSONB)
    ), wanted_items AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(pending)}::jsonb) AS r(id BIGINT,package_id BIGINT,style TEXT,color TEXT,size TEXT,expected_qty INT,source_qty INT,actual_qty INT,restock_qty INT,not_ours_qty INT,new_style TEXT,new_color TEXT,new_size TEXT)
    ), matched AS MATERIALIZED (
      SELECT catalog.*,incoming.components AS new_components FROM return_product_catalog catalog JOIN incoming ON catalog.id=incoming.id
        AND catalog.mapping_version=incoming.version AND catalog.components=incoming.old_components AND catalog.status=incoming.old_status AND catalog.mapping_source=incoming.old_source FOR UPDATE OF catalog
    ), matched_items AS MATERIALIZED (
      SELECT items.id,wanted_items.new_style,wanted_items.new_color,wanted_items.new_size FROM return_package_items items
      JOIN wanted_items ON items.id=wanted_items.id AND items.package_id=wanted_items.package_id AND items.style=wanted_items.style AND items.color=wanted_items.color AND items.size=wanted_items.size
        AND items.expected_qty=wanted_items.expected_qty AND items.source_qty IS NOT DISTINCT FROM wanted_items.source_qty
        AND items.actual_qty IS NOT DISTINCT FROM wanted_items.actual_qty AND items.restock_qty IS NOT DISTINCT FROM wanted_items.restock_qty
        AND items.not_ours_qty IS NOT DISTINCT FROM wanted_items.not_ours_qty
      JOIN return_packages packages ON packages.id=items.package_id AND packages.status IN ('pending','needs_review') AND packages.confirmed_at IS NULL
      FOR UPDATE OF items
    ), valid AS (
      SELECT (SELECT COUNT(*) FROM matched)=${selected.length} AND (SELECT COUNT(*) FROM matched_items)=${pending.length}
        AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS target(style TEXT,color TEXT,size TEXT)
          WHERE (SELECT COUNT(*) FROM inventory_balance WHERE LOWER(BTRIM(style))=LOWER(BTRIM(target.style)) AND LOWER(BTRIM(color))=LOWER(BTRIM(target.color))
            AND CASE UPPER(BTRIM(size)) WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X' WHEN '4XL' THEN '4X' WHEN '5XL' THEN '5X' ELSE UPPER(BTRIM(size)) END=
              CASE UPPER(BTRIM(target.size)) WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X' WHEN '4XL' THEN '4X' WHEN '5XL' THEN '5X' ELSE UPPER(BTRIM(target.size)) END)<>1)
        AND NOT EXISTS(SELECT 1 FROM matched_items changes JOIN return_package_items original ON original.id=changes.id
          JOIN return_package_items other ON other.package_id=original.package_id AND other.sku_id=original.sku_id
            AND other.style=changes.new_style AND other.color=changes.new_color AND other.size=changes.new_size AND other.id<>original.id) AS ok
    ), history AS (
      INSERT INTO return_product_catalog_history(store_name,store_key,sku_id,old_mapping,new_mapping,change_source,changed_by)
      SELECT store_name,store_key,sku_id,jsonb_build_object('sku_code',sku_code,'components',components,'status',status,'mapping_source',mapping_source,'mapping_version',mapping_version),
        jsonb_build_object('sku_code',sku_code,'components',new_components,'status','ready'),'bulk_target_migration',${user.username}
      FROM matched WHERE (SELECT ok FROM valid) RETURNING sku_id
    ), changed AS (
      UPDATE return_product_catalog catalog SET components=matched.new_components,status='ready',issue=NULL,mapping_source='admin',
        mapping_version=catalog.mapping_version+1,mapping_confirmed_by=${user.username},mapping_confirmed_at=NOW(),updated_by=${user.username},updated_at=NOW(),source_file='Bulk Target Migration'
      FROM matched WHERE catalog.id=matched.id AND (SELECT ok FROM valid) RETURNING catalog.id
    ), changed_items AS (
      UPDATE return_package_items items SET style=matched_items.new_style,color=matched_items.new_color,size=matched_items.new_size
      FROM matched_items WHERE items.id=matched_items.id AND (SELECT ok FROM valid) RETURNING items.id
    ) SELECT (SELECT COUNT(*)::int FROM changed) AS updated,(SELECT COUNT(*)::int FROM changed_items) AS pending_items`,
  ], { isolationLevel: 'Serializable' })
  const result = results[2][0]
  if (Number(result.updated) !== selected.length) return res.status(409).json({ error: '匹配、包裹或库存款式已变化，没有迁移任何匹配，请重新预览' })
  return res.json({ ok: true, ...result })
}
