import test from 'node:test'
import assert from 'node:assert/strict'
import {consolidateRows} from '../src/utils/consolidateEngine.js'

test('four disputed orders allocate one Black and one Navy per SKU, preserving sixteen total pieces',()=>{
  const rows=['M','M','S','XL'].map(size=>({SKU:`0015Navy&Sahara&Black&Yellow ${size}`,'Product Attribute':`Black&Sahara&Black&Yellow / ${size}`,Quantity:1}))
  const original=JSON.stringify(rows),result=consolidateRows(rows)
  const sum=color=>result.consolidated.filter(r=>r.color===color).reduce((s,r)=>s+r.QTY,0)
  assert.equal(sum('black'),4);assert.equal(sum('navy'),4)
  assert.equal(sum('sahara'),4);assert.equal(sum('yellow'),4)
  assert.equal(result.stats.newTotal,16);assert.equal(result.needsReview.length,0)
  assert.equal(JSON.stringify(rows),original)
  assert.deepEqual(consolidateRows(rows.map(({SKU,Quantity})=>({SKU,Quantity}))).consolidated,result.consolidated)
})

test('attribute lists cannot expand a single SKU or fill missing SKU sizes; explicit duplicate SKU components remain valid',()=>{
  const single=consolidateRows([{SKU:'0015BlackS','Product Attribute':'Black&Navy&White / XL',Quantity:2}])
  assert.equal(single.stats.newTotal,2);assert.equal(single.consolidated.length,1)
  assert.equal(single.consolidated[0].size,'S')
  const missing=consolidateRows([{SKU:'0015Black','Product Attribute':'Black / M',Quantity:1}])
  assert.equal(missing.consolidated[0].size,'');assert.ok(missing.needsReview.length)
  const duplicate=consolidateRows([{SKU:'0015Black&BlackM',Quantity:1}])
  assert.equal(duplicate.consolidated[0].QTY,2)
})
