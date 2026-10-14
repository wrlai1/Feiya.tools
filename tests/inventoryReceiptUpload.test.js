import test from 'node:test'
import assert from 'node:assert/strict'
import XLSX from 'xlsx'
import { parseInventoryReceiptRows } from '../src/utils/inventoryReceiptUpload.js'

const inventory = [
  { id: 1, Style: '5010015', Color: 'BLACK', Size: 'S', Quantity: 80 },
  { id: 2, Style: '5020090', Color: 'BLACK', Size: 'S', Quantity: 10 },
  { id: 3, Style: '0055', Color: 'BLACK', Size: '2X', Quantity: 1 },
]
test('a reopened dialog imports file styles without checkbox selection and preserves numeric style IDs', () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { Style: '5010015', Color: 'BLACK', Size: 'S', 'Received Quantity': 700 },
    { Style: 5020090, Color: 'White', Size: 'S', 'Received Quantity': 100 },
    { Style: '0055', Color: 'BLACK', Size: '2XL', 'Received Quantity': 5 },
  ]), 'Goods Receipt')
  const reloaded = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const parsed = parseInventoryReceiptRows(XLSX.utils.sheet_to_json(reloaded.Sheets['Goods Receipt'], { defval: '' }), inventory)
  assert.equal(parsed.length, 3)
  assert.equal(parsed.find(row => row.style === '5010015').quantity, 700)
  assert.deepEqual(parsed.find(row => row.style === '5020090'), { id: null, style: '5020090', color: 'White', size: 'S', quantity: 100, current: 0, isNew: true })
  assert.equal(parsed.find(row => row.style === '0055').id, 3)
})
test('reports actual worksheet rows, distinguishes missing fields and unknown styles, and rejects invalid quantities or duplicate SKUs', () => {
  const row = { Style: '5010015', Color: 'BLACK', Size: 'S', 'Received Quantity': 1 }
  assert.throws(() => parseInventoryReceiptRows([{ ...row, Color: '', __rowNum__: 9 }], inventory), /Row 10: 缺少颜色/)
  assert.throws(() => parseInventoryReceiptRows([{ ...row, Style: 'UNKNOWN' }], inventory), /不存在于库存/)
  assert.throws(() => parseInventoryReceiptRows([{ ...row, Size: 'INVALID' }], inventory), /尺码 INVALID 不属于/)
  assert.throws(() => parseInventoryReceiptRows([row, { ...row, Color: 'black' }], inventory), /重复/)
  for (const quantity of [-1, 1.2, true, 'bad']) assert.throws(() => parseInventoryReceiptRows([{ ...row, 'Received Quantity': quantity }], inventory), /非负整数/)
  assert.throws(() => parseInventoryReceiptRows([{ Style: row.Style, Color: row.Color, Size: row.Size }], inventory), /缺少 Received Quantity/)
  assert.throws(() => parseInventoryReceiptRows([{ ...row, Style: 55 }], inventory), /不存在于库存/)
  const before = structuredClone(inventory)
  parseInventoryReceiptRows([row, { ...row, Color: 'NEW', 'Received Quantity': 0 }], inventory)
  assert.deepEqual(inventory, before)
})
