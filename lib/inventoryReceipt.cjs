const { createHash } = require('node:crypto')

function normalizeReceipt(body = {}) {
  const reference = String(body.reference || '').trim()
  if (!reference || reference.length > 100) throw new Error('Enter a receipt reference (1–100 characters)')
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 10000) throw new Error('Upload 1–10000 inventory rows')
  const seen = new Set()
  const rows = body.rows.map((row) => {
    const id = row.id == null ? null : Number(row.id), quantity = Number(row.quantity)
    if ((id != null && (!Number.isSafeInteger(id) || id < 1)) || !['string', 'number'].includes(typeof row.quantity) || String(row.quantity).trim() === '' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) throw new Error('Received quantities must be positive whole numbers')
    const item = { id, quantity, style: String(row.style || '').trim(), color: String(row.color || '').trim(), size: String(row.size || '').trim().toUpperCase().replace(/^([1-5])XL$/, '$1X') }
    const key = [item.style, item.color, item.size].map(v => v.toUpperCase()).join('|')
    if (seen.has(key) || (id != null && seen.has(id))) throw new Error('Duplicate inventory row in receipt')
    seen.add(key)
    if (id != null) seen.add(id)
    return item
  })
  if (rows.some((r) => !r.style || !r.color || !r.size)) throw new Error('Each row needs style, color and size')
  const total = rows.reduce((sum, row) => sum + row.quantity, 0)
  if (total > 2147483647) throw new Error('Receipt total exceeds inventory limit')
  return { reference, rows, total, hash: createHash('sha256').update('goods-receipt/' + reference.toUpperCase()).digest('hex') }
}

async function receiveInventory(sql, receipt, username) {
  const source = `Goods receipt: ${receipt.reference}`
  const results = await sql.transaction((txn) => [
    txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
    txn`WITH requested AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(receipt.rows)}::jsonb) AS r(id INTEGER, quantity INTEGER, style TEXT, color TEXT, size TEXT)
    ), catalog AS (
      SELECT LOWER(BTRIM(style)) AS style_key,
        CASE UPPER(BTRIM(size)) WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X' WHEN '4XL' THEN '4X' WHEN '5XL' THEN '5X' ELSE UPPER(BTRIM(size)) END AS size_key,
        MIN(style) AS style,MIN(size) AS size FROM inventory_balance GROUP BY 1,2
    ), matched AS MATERIALIZED (
      SELECT inventory.*,requested.style AS input_style,requested.color AS input_color,requested.size AS input_size
      FROM inventory_balance inventory JOIN requested ON (requested.id IS NULL OR inventory.id=requested.id)
        AND LOWER(BTRIM(inventory.style))=LOWER(requested.style) AND LOWER(BTRIM(inventory.color))=LOWER(requested.color)
        AND CASE UPPER(BTRIM(inventory.size)) WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X' WHEN '4XL' THEN '4X' WHEN '5XL' THEN '5X' ELSE UPPER(BTRIM(inventory.size)) END=requested.size
      FOR UPDATE OF inventory
    ), prepared AS MATERIALIZED (
      SELECT requested.*,matched.id AS stock_id,matched.quantity AS old_quantity,
        COALESCE(matched.style,catalog.style) AS stock_style,COALESCE(matched.color,requested.color) AS stock_color,
        COALESCE(matched.size,catalog.size) AS stock_size
      FROM requested LEFT JOIN catalog ON catalog.style_key=LOWER(requested.style) AND catalog.size_key=requested.size
      LEFT JOIN matched ON matched.input_style=requested.style AND matched.input_color=requested.color AND matched.input_size=requested.size
    ), valid AS (
      SELECT (SELECT COUNT(*) FROM requested)=(SELECT COUNT(*) FROM prepared)
        AND NOT EXISTS(SELECT 1 FROM prepared WHERE stock_style IS NULL OR stock_size IS NULL OR (id IS NOT NULL AND stock_id IS NULL)
          OR COALESCE(old_quantity,0)::bigint+quantity::bigint > 2147483647)
        AND NOT EXISTS(SELECT 1 FROM inventory_transactions WHERE transaction_type='adjustment' AND source_hash=${receipt.hash} AND rolled_back_at IS NULL) AS ok
    ), snapshot AS (
      INSERT INTO inventory_snapshots(label,source_name,data,total_rows,total_units)
      SELECT 'adjustment',${source},COALESCE(jsonb_agg(jsonb_build_object('style',style,'color',color,'size',size,'quantity',quantity,'sort_order',sort_order) ORDER BY id),'[]'::jsonb),COUNT(*)::int,COALESCE(SUM(quantity),0)::int
      FROM inventory_balance WHERE (SELECT ok FROM valid) HAVING (SELECT ok FROM valid) RETURNING id
    ), logged AS (
      INSERT INTO inventory_transactions(transaction_type,source_file,source_hash,applied_units,row_count,applied_by,rollback_snapshot_id)
      SELECT 'adjustment',${source},${receipt.hash},${receipt.total},${receipt.rows.length},${username},id FROM snapshot RETURNING id
    ), updated AS (
      UPDATE inventory_balance inventory SET quantity=inventory.quantity+prepared.quantity,updated_at=NOW()
      FROM prepared,logged WHERE inventory.id=prepared.stock_id RETURNING inventory.id,inventory.quantity
    ), inserted AS (
      INSERT INTO inventory_balance(style,color,size,quantity,sort_order,updated_at)
      SELECT stock_style,stock_color,stock_size,prepared.quantity,
        (SELECT COALESCE(MAX(sort_order),0) FROM inventory_balance)+ROW_NUMBER() OVER(ORDER BY stock_style,stock_color,stock_size),NOW()
      FROM prepared CROSS JOIN logged WHERE stock_id IS NULL RETURNING id,quantity
    ), movements AS (
      INSERT INTO inventory_txn_rows(transaction_id,txn_type,style,color,size,qty,source_file,applied_by,business_day)
      SELECT logged.id,'in',stock_style,stock_color,stock_size,prepared.quantity,${source},${username},(NOW() AT TIME ZONE 'America/New_York')::date FROM prepared CROSS JOIN logged
    ) SELECT (SELECT COUNT(*)::int FROM updated)+(SELECT COUNT(*)::int FROM inserted) AS updated,
      (SELECT COUNT(*)::int FROM inserted) AS added,
      EXISTS(SELECT 1 FROM inventory_transactions WHERE transaction_type='adjustment' AND source_hash=${receipt.hash} AND rolled_back_at IS NULL) AS duplicate,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'quantity',quantity)) FROM (SELECT * FROM updated UNION ALL SELECT * FROM inserted) changed),'[]'::jsonb) AS rows`,
  ], { isolationLevel: 'Serializable' })
  return results[1][0]
}

module.exports = { normalizeReceipt, receiveInventory }
