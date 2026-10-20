const { createHash } = require('node:crypto')
const sourceFile = 'TEMU ORDER-20261009.xlsx'
const reference = 'SKU correction 20261009 5010015 Navy/Black'
const orders = [
  ['PO-211-08099449019510778', 'M', '2026-10-08'],
  ['PO-211-07639354094713648', 'M', '2026-10-08'],
  ['PO-211-07987197340791641', 'S', '2026-10-08'],
  ['PO-211-07693930171513261', 'XL', '2026-10-09'],
]
async function ensureCorrectionTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS inventory_sku_corrections (
    id BIGSERIAL PRIMARY KEY, reference TEXT NOT NULL, transaction_id INTEGER NOT NULL,
    original_transaction_id INTEGER NOT NULL, evidence JSONB NOT NULL,
    movement_changes JSONB NOT NULL, stock_changes JSONB NOT NULL,
    undone_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
}
async function correctionPreview(sql) {
  const transactions = await sql`SELECT id, source_hash, rolled_back_at FROM inventory_transactions
    WHERE source_file=${sourceFile} AND transaction_type='sales' AND rolled_back_at IS NULL`
  if (transactions.length !== 1 || !transactions[0].source_hash) throw new Error('Cannot uniquely identify the original active deduction')
  const original = transactions[0]
  const evidence = await sql`SELECT orders.order_number, orders.order_created_at, items.sku_code, items.quantity, items.attributes
    FROM return_orders orders JOIN return_order_items items ON items.order_id=orders.id
    WHERE orders.source_hash=${original.source_hash} AND orders.order_number=ANY(${orders.map(o=>o[0])}::text[])
    ORDER BY orders.order_number`
  if (evidence.length !== 4 || evidence.some(item => {
    const expected=orders.find(o=>o[0]===item.order_number)
    return !expected || item.quantity!==1 || String(item.sku_code).trim().toLowerCase()!==`0015navy&sahara&black&yellow ${expected[1].toLowerCase()}`
  })) throw new Error('Saved order SKU evidence differs from the confirmed four orders')
  const previous = await sql`SELECT corrections.* FROM inventory_sku_corrections corrections
    JOIN inventory_transactions transactions ON transactions.id=corrections.transaction_id
    WHERE corrections.reference=${reference} AND corrections.undone_at IS NULL AND transactions.rolled_back_at IS NULL`
  const stock = await sql`SELECT id,style,color,size,quantity FROM inventory_balance
    WHERE UPPER(BTRIM(style))='5010015' AND UPPER(BTRIM(color)) IN ('BLACK','NAVY') AND UPPER(BTRIM(size)) IN ('S','M','XL') ORDER BY id`
  const stockChanges=[]
  for(const [size,qty] of [['S',1],['M',2],['XL',1]]) for(const color of ['BLACK','NAVY']) {
    const matches=stock.filter(r=>r.color.trim().toUpperCase()===color && r.size.trim().toUpperCase()===size)
    if(matches.length!==1) throw new Error(`Inventory target is missing or ambiguous: ${color} ${size}`)
    const row=matches[0], delta=color==='BLACK'?qty:-qty
    if(!Number.isSafeInteger(row.quantity+delta) || row.quantity+delta < -2147483648 || row.quantity+delta > 2147483647) throw new Error('Inventory quantity exceeds integer limit')
    stockChanges.push({...row,delta,after:row.quantity+delta})
  }
  const movements = await sql`SELECT id,transaction_id,txn_type,style,color,size,qty,source_file,applied_by,business_day::text,applied_at,store_name,store_key
    FROM inventory_txn_rows WHERE transaction_id=${original.id} AND txn_type='sales'
      AND UPPER(BTRIM(style))='5010015' AND UPPER(BTRIM(color))='BLACK' ORDER BY id`
  const movementChanges=[]
  for(const [size,day,qty] of [['M','2026-10-08',2],['S','2026-10-08',1],['XL','2026-10-09',1]]) {
    const row=movements.find(r=>r.size.trim().toUpperCase()===size && r.business_day===day && r.qty>=qty)
    if(!row && !previous.length) throw new Error(`Original BLACK movement is missing: ${day} ${size}`)
    if(row) movementChanges.push({...row,delta:qty,target:stockChanges.find(r=>r.color.trim().toUpperCase()==='NAVY' && r.size.trim().toUpperCase()===size)})
  }
  const version=createHash('sha256').update(JSON.stringify({original,evidence,stockChanges,movementChanges})).digest('hex')
  return {reference,sourceFile,originalTransactionId:original.id,evidence,stockChanges,movementChanges,version,applied:previous.length>0,record:previous[0]||null}
}
async function applyCorrection(sql, preview, expectedVersion, username) {
  if(preview.applied) return {ok:true,alreadyApplied:true,record:preview.record}
  if(!expectedVersion || preview.version!==expectedVersion) throw new Error('Correction preview changed; refresh before applying')
  const result=await sql.transaction(txn=>[
    txn`SELECT pg_advisory_xact_lock(hashtext('inventory-balance-write'))`,
    txn`SELECT 1 / CASE WHEN
      EXISTS(SELECT 1 FROM inventory_transactions WHERE id=${preview.originalTransactionId} AND rolled_back_at IS NULL)
      AND (SELECT COUNT(*) FROM return_orders orders JOIN return_order_items items ON items.order_id=orders.id
        JOIN jsonb_to_recordset(${JSON.stringify(preview.evidence)}::jsonb) AS expected(order_number TEXT,sku_code TEXT,quantity INT)
          ON orders.order_number=expected.order_number AND items.sku_code=expected.sku_code AND items.quantity=expected.quantity
        JOIN inventory_transactions original ON original.source_hash=orders.source_hash AND original.id=${preview.originalTransactionId})=4
      AND NOT EXISTS(SELECT 1 FROM inventory_sku_corrections corrections JOIN inventory_transactions transactions ON transactions.id=corrections.transaction_id WHERE reference=${reference} AND corrections.undone_at IS NULL AND transactions.rolled_back_at IS NULL)
      AND (SELECT COUNT(*) FROM inventory_balance inventory JOIN jsonb_to_recordset(${JSON.stringify(preview.stockChanges)}::jsonb) AS expected(id INT,style TEXT,color TEXT,size TEXT,quantity INT) ON inventory.id=expected.id AND inventory.style=expected.style AND inventory.color=expected.color AND inventory.size=expected.size AND inventory.quantity=expected.quantity)=6
      AND (SELECT COUNT(*) FROM inventory_txn_rows movements JOIN jsonb_to_recordset(${JSON.stringify(preview.movementChanges)}::jsonb) AS expected(id BIGINT,qty INT,transaction_id INT,style TEXT,color TEXT,size TEXT,business_day DATE) ON movements.id=expected.id AND movements.qty=expected.qty AND movements.transaction_id=expected.transaction_id AND movements.style=expected.style AND movements.color=expected.color AND movements.size=expected.size AND movements.business_day=expected.business_day)=3
      THEN 1 ELSE 0 END AS valid`,
    txn`INSERT INTO inventory_snapshots(label,source_name,data,total_rows,total_units)
      SELECT 'adjustment',${reference},COALESCE(jsonb_agg(jsonb_build_object('style',style,'color',color,'size',size,'quantity',quantity,'sort_order',sort_order) ORDER BY id),'[]'::jsonb),COUNT(*)::int,COALESCE(SUM(quantity),0)::int FROM inventory_balance`,
    txn`INSERT INTO inventory_transactions(transaction_type,source_file,source_hash,applied_units,row_count,applied_by,rollback_snapshot_id)
      SELECT 'adjustment',${reference},${createHash('sha256').update(reference).digest('hex')},0,6,${username},MAX(id) FROM inventory_snapshots WHERE source_name=${reference}
      RETURNING id`,
    txn`WITH changed AS (
      UPDATE inventory_balance inventory SET quantity=inventory.quantity+expected.delta,updated_at=NOW()
      FROM jsonb_to_recordset(${JSON.stringify(preview.stockChanges)}::jsonb) AS expected(id INT,delta INT) WHERE inventory.id=expected.id RETURNING inventory.*
    ), reduced AS (
      UPDATE inventory_txn_rows movements SET qty=movements.qty-expected.delta
      FROM jsonb_to_recordset(${JSON.stringify(preview.movementChanges)}::jsonb) AS expected(id BIGINT,delta INT) WHERE movements.id=expected.id RETURNING movements.id
    ), added AS (
      INSERT INTO inventory_txn_rows(transaction_id,txn_type,style,color,size,qty,source_file,applied_by,business_day,applied_at,store_name,store_key)
      SELECT ${preview.originalTransactionId},'sales',expected.target->>'style',expected.target->>'color',expected.target->>'size',expected.delta,
        expected.source_file,expected.applied_by,expected.business_day,expected.applied_at,expected.store_name,expected.store_key
      FROM jsonb_to_recordset(${JSON.stringify(preview.movementChanges)}::jsonb) AS expected(id BIGINT,delta INT,target JSONB,source_file TEXT,applied_by TEXT,business_day DATE,applied_at TIMESTAMPTZ,store_name TEXT,store_key TEXT)
      RETURNING id,size,business_day
    ) INSERT INTO inventory_sku_corrections(reference,transaction_id,original_transaction_id,evidence,movement_changes,stock_changes)
      SELECT ${reference},(SELECT MAX(id) FROM inventory_transactions WHERE source_file=${reference} AND rolled_back_at IS NULL),${preview.originalTransactionId},${JSON.stringify(preview.evidence)}::jsonb,
        jsonb_build_object('original',${JSON.stringify(preview.movementChanges)}::jsonb,'added',(SELECT jsonb_agg(added) FROM added)),${JSON.stringify(preview.stockChanges)}::jsonb RETURNING *`,
  ],{isolationLevel:'Serializable'})
  return {ok:true,record:result.at(-1)[0]}
}
function undoCorrections(txn) {
  return txn`WITH undone AS (
    UPDATE inventory_sku_corrections corrections SET undone_at=NOW()
    FROM inventory_transactions transactions WHERE transactions.id=corrections.transaction_id AND transactions.rolled_back_at IS NOT NULL AND corrections.undone_at IS NULL
    RETURNING corrections.movement_changes
  ), restored AS (
    UPDATE inventory_txn_rows rows SET qty=rows.qty+changes.delta
    FROM (SELECT (item->>'id')::bigint AS id,SUM((item->>'delta')::int)::int AS delta FROM undone CROSS JOIN LATERAL jsonb_array_elements(movement_changes->'original') item GROUP BY 1) changes
    WHERE rows.id=changes.id RETURNING rows.id
  ) DELETE FROM inventory_txn_rows rows USING undone,LATERAL jsonb_array_elements(undone.movement_changes->'added') added WHERE rows.id=(added->>'id')::bigint`
}
module.exports={ensureCorrectionTable,correctionPreview,applyCorrection,undoCorrections}
