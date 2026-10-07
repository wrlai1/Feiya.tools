import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import range from '../lib/shipmentDateRange.cjs'
import { buildShipmentReport, shipmentReportSheet } from '../src/utils/shipmentReport.js'

test('inclusive date validation rejects invalid dates and reversed ranges',()=>{
  assert.deepEqual(range.shipmentDateRange('2024-02-29','2024-03-01'),{from:'2024-02-29',to:'2024-03-01'})
  for(const dates of [['2026-02-29','2026-03-01'],['2026-10-06','2026-10-01'],['','2026-10-06']])assert.throws(()=>range.shipmentDateRange(...dates))
})
test('daily grid sums matching shipments, fills missing dates, and exports identical totals',()=>{
  const report=buildShipmentReport('5010015','2026-10-01','2026-10-03',[
    {txn_type:'sales',style:'5010015',color:'BLACK',size:'S',day:'2026-10-01',qty:3},
    {txn_type:'sales',style:'5010015',color:'BLACK',size:'S',day:'2026-10-01',qty:2},
    {txn_type:'sales',style:'5010015',color:'BLACK',size:'M',day:'2026-10-03',qty:4},
    {txn_type:'return',style:'5010015',color:'BLACK',size:'S',day:'2026-10-02',qty:99},
    {txn_type:'sales',style:'853105',color:'BLACK',size:'S',day:'2026-10-02',qty:99},
    {txn_type:'sales',style:'5010015',color:'BLACK',size:'S',day:'2026-09-30',qty:99},
  ])
  assert.equal(report.total,9);assert.deepEqual(report.dailyTotals,[5,0,4]);assert.equal(report.rows[0].size,'S')
  assert.deepEqual(shipmentReportSheet(report).at(-1),['TOTAL','',5,0,4,9])
})
test('actual movement SQL uses business dates, inclusive range and excludes rolled-back or non-sales rows',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`CREATE TABLE inventory_transactions(id INTEGER,rolled_back_at TIMESTAMPTZ,transaction_type TEXT,source_file TEXT,applied_by TEXT,applied_at TIMESTAMPTZ);
      CREATE TABLE inventory_txn_rows(transaction_id INTEGER,txn_type TEXT,style TEXT,color TEXT,size TEXT,qty INTEGER,business_day DATE,applied_at TIMESTAMPTZ,source_file TEXT,applied_by TEXT);
      INSERT INTO inventory_transactions VALUES (1,NULL,'sales','good','admin','2026-10-06 12:00Z'),(2,NOW(),'sales','bad','admin','2026-10-06 12:00Z'),(3,NOW(),'sales','legacy','admin','2026-10-06 12:00Z');
      INSERT INTO inventory_txn_rows VALUES
      (1,'sales','5010015','BLACK','S',5,'2026-10-01','2026-10-06 12:00Z','good','admin'),
      (1,'sales','5010015','BLACK','M',4,'2026-10-03','2026-10-06 12:00Z','good','admin'),
      (2,'sales','5010015','BLACK','S',99,'2026-10-02','2026-10-06 12:00Z','bad','admin'),
      (NULL,'sales','5010015','BLACK','S',99,'2026-10-02','2026-10-06 12:00Z','legacy','admin'),
      (1,'return','5010015','BLACK','S',99,'2026-10-02','2026-10-06 12:00Z','good','admin'),
      (1,'sales','853105','BLACK','S',99,'2026-10-02','2026-10-06 12:00Z','good','admin'),
      (1,'sales','5010015','BLACK','S',99,'2026-09-30','2026-10-06 12:00Z','good','admin'),
      (1,'sales','5010015','BLACK','S',2,NULL,'2026-10-04 02:00Z','good','admin'),
      (1,'sales','5010015','BLACK','S',99,NULL,'2026-10-04 05:00Z','good','admin');`)
    const sql=async(strings,...values)=>(await db.query(strings.reduce((s,p,i)=>s+p+(i<values.length?`$${i+1}`:''),''),values)).rows
    const source=fs.readFileSync(new URL('../api/inventory-balance.js',import.meta.url),'utf8')
    const block=source.slice(source.indexOf("action === 'movements'"),source.indexOf('// ── GET transactions'))
    const query=block.match(/const rows = await sql`([\s\S]*?)`/)[1]
    const execute=new Function('sql','fromDay','toDay','style','salesOnly','return sql`'+query+'`')
    const rows=await execute(sql,'2026-10-01','2026-10-03','5010015',true)
    assert.equal(rows.length,3);assert.equal(rows.reduce((sum,row)=>sum+row.qty,0),11)
    assert.equal(rows[0].day.toISOString().slice(0,10),'2026-10-01')
  } finally { await db.close() }
})
