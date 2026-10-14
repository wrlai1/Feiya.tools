const { createHash } = require('node:crypto')

function normalizeReceipt(body = {}) {
  const reference = String(body.reference || '').trim()
  if (!reference || reference.length > 100) throw new Error('Enter a receipt reference (1–100 characters)')
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 10000) throw new Error('Upload 1–10000 inventory rows')
  const seen = new Set()
  const rows = body.rows.map((row) => {
    const id = Number(row.id), quantity = Number(row.quantity)
    if (!Number.isSafeInteger(id) || id < 1 || !['string', 'number'].includes(typeof row.quantity) || String(row.quantity).trim() === '' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) throw new Error('Received quantities must be positive whole numbers')
    if (seen.has(id)) throw new Error('Duplicate inventory row in receipt')
    seen.add(id)
    return { id, quantity, style: String(row.style || '').trim(), color: String(row.color || '').trim(), size: String(row.size || '').trim() }
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
    ), matched AS MATERIALIZED (
      SELECT inventory.*, requested.quantity AS received FROM inventory_balance inventory JOIN requested
      ON inventory.id=requested.id AND inventory.style=requested.style AND inventory.color=requested.color AND inventory.size=requested.size
      FOR UPDATE OF inventory
    ), valid AS (
      SELECT (SELECT COUNT(*) FROM requested)=(SELECT COUNT(*) FROM matched)
        AND NOT EXISTS(SELECT 1 FROM matched WHERE quantity::bigint+received::bigint > 2147483647)
        AND NOT EXISTS(SELECT 1 FROM inventory_transactions WHERE transaction_type='adjustment' AND source_hash=${receipt.hash} AND rolled_back_at IS NULL) AS ok
    ), snapshot AS (
      INSERT INTO inventory_snapshots(label,source_name,data,total_rows,total_units)
      SELECT 'adjustment',${source},COALESCE(jsonb_agg(jsonb_build_object('style',style,'color',color,'size',size,'quantity',quantity,'sort_order',sort_order) ORDER BY id),'[]'::jsonb),COUNT(*)::int,COALESCE(SUM(quantity),0)::int
      FROM inventory_balance WHERE (SELECT ok FROM valid) HAVING (SELECT ok FROM valid) RETURNING id
    ), logged AS (
      INSERT INTO inventory_transactions(transaction_type,source_file,source_hash,applied_units,row_count,applied_by,rollback_snapshot_id)
      SELECT 'adjustment',${source},${receipt.hash},${receipt.total},${receipt.rows.length},${username},id FROM snapshot RETURNING id
    ), updated AS (
      UPDATE inventory_balance inventory SET quantity=inventory.quantity+matched.received,updated_at=NOW()
      FROM matched,logged WHERE inventory.id=matched.id RETURNING inventory.id,inventory.quantity
    ), movements AS (
      INSERT INTO inventory_txn_rows(transaction_id,txn_type,style,color,size,qty,source_file,applied_by,business_day)
      SELECT logged.id,'in',matched.style,matched.color,matched.size,matched.received,${source},${username},(NOW() AT TIME ZONE 'America/New_York')::date FROM matched CROSS JOIN logged
    ) SELECT (SELECT COUNT(*)::int FROM updated) AS updated,
      EXISTS(SELECT 1 FROM inventory_transactions WHERE transaction_type='adjustment' AND source_hash=${receipt.hash} AND rolled_back_at IS NULL) AS duplicate,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'quantity',quantity)) FROM updated),'[]'::jsonb) AS rows`,
  ], { isolationLevel: 'Serializable' })
  return results[1][0]
}

module.exports = { normalizeReceipt, receiveInventory }
