import test from 'node:test'
import assert from 'node:assert/strict'
import ledger from '../lib/inventoryLedger.cjs'
import { buildShipmentReport } from '../src/utils/shipmentReport.js'
import { PGlite } from '@electric-sql/pglite'
import { neonConfig } from '@neondatabase/serverless'
import jwt from 'jsonwebtoken'
import handler from '../api/inventory-balance.js'
import { migrateReturnsSchema } from '../lib/returnsSchema.js'
import ExcelJS from 'exceljs'

test('later shipments do not increase an earlier shipment day; query and email agree per SKU', () => {
  const inventory = ['S','M','L','XL'].map(size=>({style:'5010015',color:'BLACK',size,quantity:80}))
  const history = []
  const first=[13,18,14,13], later=[21,55,67,52]
  inventory.forEach((sku,i)=>{
    history.push({...sku,txn_type:'sales',qty:first[i],day:'2026-10-08',applied_day:'2026-10-10',source_file:'TEMU ORDER-20261009.xlsx'})
  })
  const before=ledger.movementsForReport(history,'2026-10-09','2026-10-09')
  inventory.forEach((sku,i)=>{
    history.push({...sku,txn_type:'sales',qty:later[i],day:'2026-10-09',applied_day:'2026-10-13',source_file:'TEMU ORDER-20261012.xlsx'})
  })
  history.push({style:'5010015',color:'DELETED',size:'S',txn_type:'sales',qty:999,day:'2026-10-09',applied_day:'2026-10-10',source_file:'TEMU ORDER-20261009.xlsx'})
  const original=JSON.stringify({inventory,history})
  const reportDay='2026-10-14'
  const email=ledger.buildLedger({inventory,history:ledger.movementsForReport(history,null,reportDay),reportDate:reportDay})
  for(const [day,expected] of [['2026-10-09',first],['2026-10-12',later]]){
    const rows=ledger.currentInventoryMovements(ledger.movementsForReport(history,day,day),inventory)
    const grid=buildShipmentReport('5010015',day,day,rows)
    assert.deepEqual(grid.rows.map(r=>r.total),expected)
    assert.deepEqual(email.rows.map(r=>r.out[day]),expected)
    assert.equal(grid.total,expected.reduce((a,b)=>a+b,0))
  }
  assert.deepEqual(ledger.currentInventoryMovements(ledger.movementsForReport(history,'2026-10-09','2026-10-09'),inventory),before)
  assert.equal(JSON.stringify({inventory,history}),original)
})

test('undated filenames use New York confirmation day; return dates are preserved and aliases share a reporting row', () => {
  const rows=[
    {style:'NEW',color:'black',size:'2XL',txn_type:'sales',qty:2,day:'2026-10-01',applied_day:'2026-10-13',source_file:'orders.xlsx'},
    {style:'NEW',color:'BLACK',size:'2X',txn_type:'return',qty:1,day:'2026-10-10',applied_day:'2026-10-13'},
  ]
  const result=ledger.currentInventoryMovements(ledger.movementsForReport(rows,'2026-10-10','2026-10-13'),[{style:'NEW',color:'BLACK',size:'2X'}])
  assert.deepEqual(result.map(row=>[row.txn_type,row.day]),[['return','2026-10-10'],['sales','2026-10-13']])
  assert.deepEqual(result.map(row=>row.size),['2X','2X'])
  assert.equal(ledger.movementsForReport(rows,'2026-10-01','2026-10-01').length,0)
})

test('actual shipment query and downloaded email workbook agree without writing stock or movement history', async () => {
  const db=new PGlite(), previousFetch=neonConfig.fetchFunction
  const oldUrl=process.env.DATABASE_URL,oldSecret=process.env.JWT_SECRET
  process.env.DATABASE_URL='postgresql://test:test@localhost/test';process.env.JWT_SECRET='local-shipment-date-test'
  const execute=async(connection,{query,params})=>{
    const r=await connection.query(query,params)
    return {fields:r.fields.map(({name,dataTypeID})=>({name,dataTypeID})),rows:r.rows.map(row=>r.fields.map(({name})=>{
      const value=row[name];return value==null?null:value instanceof Date?value.toISOString():typeof value==='object'?JSON.stringify(value):String(value)
    }))}
  }
  neonConfig.fetchFunction=async(_url,options)=>{
    const request=JSON.parse(options.body)
    try {
      const result=request.queries?await db.transaction(async connection=>{const results=[];for(const q of request.queries)results.push(await execute(connection,q));return {results}}):await execute(db,request)
      return {ok:true,json:async()=>result}
    } catch(error){return {ok:false,status:400,json:async()=>({message:error.message,code:error.code})}}
  }
  const token=jwt.sign({userId:1},process.env.JWT_SECRET)
  const call=async(method,query,body)=>{
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(body){this.body=body;return this},send(body){this.body=body;return this}}
    await handler({method,query,body,headers:{authorization:`Bearer ${token}`}},res);return res
  }
  try{
    const sql=async(strings,...values)=>(await db.query(strings.reduce((s,p,i)=>s+(i?`$${i}`:'')+p,''),values)).rows
    await migrateReturnsSchema(sql)
    await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,username TEXT,role TEXT);INSERT INTO users VALUES(1,'admin','admin');
      INSERT INTO inventory_balance(style,color,size,quantity) VALUES('5010015','BLACK','S',80),('5010015','BLACK','M',0);
      INSERT INTO inventory_transactions(id,transaction_type,source_file,applied_by,applied_at,rolled_back_at)
      VALUES(99,'sales','TEMU ORDER-20261009.xlsx','admin','2026-10-10 12:00Z',NOW());
      INSERT INTO inventory_txn_rows(transaction_id,txn_type,style,color,size,qty,business_day,source_file,applied_at,applied_by) VALUES
      (NULL,'sales','5010015','BLACK','S',7,'2026-10-09','TEMU ORDER-20261009.xlsx','2026-10-10 12:00Z','admin'),
      (NULL,'sales','5010015','BLACK','S',6,'2026-10-08','TEMU ORDER-20261009.xlsx','2026-10-10 12:02Z','admin'),
      (99,'sales','5010015','BLACK','S',999,'2026-10-09','TEMU ORDER-20261009.xlsx','2026-10-10 12:00Z','admin'),
      (NULL,'sales','5010015','DELETED','S',999,'2026-10-09','TEMU ORDER-20261009.xlsx','2026-10-10 12:02Z','admin');`)
    // First legacy row must not coincide with the revoked transaction's fallback window.
    await db.exec("UPDATE inventory_txn_rows SET applied_at='2026-10-10 12:02Z' WHERE qty=7")
    const query={action:'movements',from:'2026-10-09',to:'2026-10-09',style:'5010015',txnType:'sales'}
    const first=await call('GET',query)
    assert.equal(first.code,200,JSON.stringify(first.body))
    assert.equal(buildShipmentReport('5010015',query.from,query.to,first.body.rows).total,13)
    await db.exec("INSERT INTO inventory_txn_rows(txn_type,style,color,size,qty,business_day,source_file,applied_at) VALUES('sales','5010015','BLACK','S',3,'2026-10-09','TEMU ORDER-20261012.xlsx','2026-10-13 12:00Z')")
    const stockBefore=(await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows
    const historyBefore=(await db.query('SELECT * FROM inventory_txn_rows ORDER BY id')).rows
    const next=await call('GET',query)
    assert.deepEqual(next.body.rows,first.body.rows)
    const later=await call('GET',{...query,from:'2026-10-12',to:'2026-10-12'})
    assert.equal(later.body.rows.reduce((s,r)=>s+r.qty,0),3)
    const download=await call('POST',{action:'email-download'},{styles:['5010015']})
    assert.equal(download.code,200,JSON.stringify(download.body))
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(download.body)
    const sheet=wb.getWorksheet('5010015'),columns=sheet.getRow(5).values
    const outStart=sheet.getRow(4).values.indexOf('OUT')
    const column=columns.findIndex((v,i)=>i>=outStart&&v instanceof Date&&v.toISOString().slice(0,10)==='2026-10-09')
    assert.equal(sheet.getCell(6,column).value,13)
    assert.equal(sheet.getCell(7,columns.indexOf('Balance')).value,0)
    assert.deepEqual((await db.query('SELECT * FROM inventory_balance ORDER BY id')).rows,stockBefore)
    assert.deepEqual((await db.query('SELECT * FROM inventory_txn_rows ORDER BY id')).rows,historyBefore)
  } finally{
    neonConfig.fetchFunction=previousFetch
    if(oldUrl==null)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl
    if(oldSecret==null)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret
    await db.close()
  }
})
