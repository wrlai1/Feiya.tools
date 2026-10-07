import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWarehouseCsv, warehouseCsv } from '../src/utils/warehouseCsv.js'
const header = 'date,style,color,size,sold_qty'
test('CSV supports BOM, CRLF, quoted commas, escaped quotes and multiline fields', () => {
  const rows = parseWarehouseCsv(`\uFEFF${header}\r\n2026-10-01,"Style, A","Black ""Ink""\nDark",L,5\r\n`, 'sales')
  assert.equal(rows[0].style, 'Style, A')
  assert.equal(rows[0].color, 'Black "Ink"\nDark')
  assert.equal(rows[0].sold_qty, 5)
})
test('malformed CSV cannot silently discard extra quantities or overwrite duplicate headers', () => {
  for (const csv of [
    `${header}\n2026-10-01,A,Black,L,5,100`,
    `${header}\n2026-10-01,A,Black,L`,
    `${header}\n2026-10-01,"A,Black,L,5`,
    `${header}\n2026-10-01,"A"oops,Black,L,5`,
    'date,style,color,size,sold_qty,sold_qty\n2026-10-01,A,Black,L,5,99',
    'date,style,color,size\n2026-10-01,A,Black,L',
    '',
  ]) assert.throws(() => parseWarehouseCsv(csv, 'sales'))
})
test('only a valid order header allows a zero-order snapshot', () => {
  const header = 'order_id,store_id,platform,order_date,ship_deadline,carrier,style,color,size,qty,order_status,shipment_status'
  assert.deepEqual(parseWarehouseCsv(header, 'orders'), [])
  assert.throws(() => parseWarehouseCsv('wrong,header', 'orders'), /Missing/)
})
test('CSV export escapes formulas and quotes while keeping numbers numeric', () => {
  assert.equal(warehouseCsv([{ style: '=1+1', location: 'A"B', shortage: -3 }]), '"style","location","shortage"\r\n"\'=1+1","A""B","-3"')
})
