const test=require('node:test'),assert=require('node:assert/strict')
const {PGlite}=require('@electric-sql/pglite')
const {neon,neonConfig}=require('@neondatabase/serverless')
const service=require('../lib/inventorySkuCorrection.cjs')
test('SKU correction transfers only four current units, preserves evidence, refuses stale/repeated execution, and reverses ledger changes on rollback',async()=>{
 const db=new PGlite(),previousFetch=neonConfig.fetchFunction
 const execute=async(connection,{query,params})=>{
  const r=await connection.query(query,params);return {fields:r.fields.map(({name,dataTypeID})=>({name,dataTypeID})),rows:r.rows.map(row=>r.fields.map(({name})=>row[name]==null?null:row[name] instanceof Date?row[name].toISOString():typeof row[name]==='object'?JSON.stringify(row[name]):String(row[name])))}
 }
 neonConfig.fetchFunction=async(_url,options)=>{const q=JSON.parse(options.body);try{const data=q.queries?await db.transaction(async c=>{const results=[];for(const query of q.queries)results.push(await execute(c,query));return{results}}):await execute(db,q);return{ok:true,json:async()=>data}}catch(e){return{ok:false,status:400,json:async()=>({message:e.message,code:e.code})}}}
 const sql=neon('postgresql://test:test@localhost/test')
 try{
  await db.exec(`CREATE TABLE inventory_balance(id SERIAL PRIMARY KEY,style TEXT,color TEXT,size TEXT,quantity INT,sort_order INT,updated_at TIMESTAMPTZ);
   CREATE TABLE inventory_transactions(id SERIAL PRIMARY KEY,transaction_type TEXT,source_file TEXT,source_hash TEXT,applied_units INT,row_count INT,applied_by TEXT,rollback_snapshot_id INT,rolled_back_at TIMESTAMPTZ);
   CREATE TABLE inventory_snapshots(id SERIAL PRIMARY KEY,label TEXT,source_name TEXT,data JSONB,total_rows INT,total_units INT);
   CREATE TABLE inventory_txn_rows(id BIGSERIAL PRIMARY KEY,transaction_id INT,txn_type TEXT,style TEXT,color TEXT,size TEXT,qty INT,source_file TEXT,applied_by TEXT,business_day DATE,applied_at TIMESTAMPTZ,store_name TEXT,store_key TEXT);
   CREATE TABLE return_orders(id SERIAL PRIMARY KEY,order_number TEXT,order_created_at TIMESTAMPTZ,source_hash TEXT);
   CREATE TABLE return_order_items(order_id INT,sku_code TEXT,quantity INT,attributes TEXT);
   INSERT INTO inventory_transactions(transaction_type,source_file,source_hash) VALUES('sales','TEMU ORDER-20261009.xlsx','original');
   INSERT INTO inventory_balance(style,color,size,quantity) VALUES('5010015','BLACK','S',100),('5010015','BLACK','M',200),('5010015','BLACK','XL',300),('5010015','NAVY','S',40),('5010015','NAVY','M',50),('5010015','NAVY','XL',-1),('OTHER','COLOR','S',999);
   INSERT INTO inventory_txn_rows(transaction_id,txn_type,style,color,size,qty,source_file,business_day,applied_at) VALUES
    (1,'sales','5010015','BLACK','S',13,'TEMU ORDER-20261009.xlsx','2026-10-08','2026-10-10'),
    (1,'sales','5010015','BLACK','M',18,'TEMU ORDER-20261009.xlsx','2026-10-08','2026-10-10'),
    (1,'sales','5010015','BLACK','XL',13,'TEMU ORDER-20261009.xlsx','2026-10-09','2026-10-10');`)
  for(const [order,size] of [['PO-211-08099449019510778','M'],['PO-211-07639354094713648','M'],['PO-211-07987197340791641','S'],['PO-211-07693930171513261','XL']]){
   const row=(await db.query("INSERT INTO return_orders(order_number,source_hash) VALUES($1,'original') RETURNING id",[order])).rows[0]
   await db.query('INSERT INTO return_order_items VALUES($1,$2,1,$3)',[row.id,`0015Navy&Sahara&Black&Yellow ${size}`,`Black&Sahara&Black&Yellow / ${size}`])
  }
  await service.ensureCorrectionTable(sql)
  const preview=await service.correctionPreview(sql)
  await assert.rejects(()=>service.applyCorrection(sql,preview,'wrong','admin'),/preview changed/)
  await db.exec("UPDATE inventory_balance SET quantity=201 WHERE color='BLACK' AND size='M'")
  await assert.rejects(()=>service.applyCorrection(sql,preview,preview.version,'admin'),/division by zero/)
  assert.equal((await db.query('SELECT COUNT(*) n FROM inventory_snapshots')).rows[0].n,0)
  const updated=await service.correctionPreview(sql),result=await service.applyCorrection(sql,updated,updated.version,'admin')
  assert.equal(result.ok,true)
  const quantities=(await db.query('SELECT color,size,quantity FROM inventory_balance WHERE style=\'5010015\' ORDER BY id')).rows.map(r=>r.quantity)
  assert.deepEqual(quantities,[101,203,301,39,48,-2])
  assert.equal((await db.query("SELECT quantity FROM inventory_balance WHERE style='OTHER'")).rows[0].quantity,999)
  assert.deepEqual((await db.query("SELECT size,qty FROM inventory_txn_rows WHERE color='BLACK' ORDER BY id")).rows.map(r=>r.qty),[12,16,12])
  assert.equal((await db.query('SELECT SUM(qty)::int AS n FROM inventory_txn_rows')).rows[0].n,44)
  assert.equal((await service.correctionPreview(sql)).applied,true)
  await service.applyCorrection(sql,await service.correctionPreview(sql),updated.version,'admin')
  assert.equal((await db.query('SELECT COUNT(*) n FROM inventory_sku_corrections')).rows[0].n,1)
  await db.query('UPDATE inventory_transactions SET rolled_back_at=NOW() WHERE id=$1',[result.record.transaction_id])
  await sql.transaction(txn=>[service.undoCorrections(txn)])
  assert.deepEqual((await db.query('SELECT qty FROM inventory_txn_rows ORDER BY id')).rows.map(r=>r.qty),[13,18,13])
  await sql.transaction(txn=>[service.undoCorrections(txn)])
  assert.deepEqual((await db.query('SELECT qty FROM inventory_txn_rows ORDER BY id')).rows.map(r=>r.qty),[13,18,13])
 }finally{neonConfig.fetchFunction=previousFetch;await db.close()}
})
