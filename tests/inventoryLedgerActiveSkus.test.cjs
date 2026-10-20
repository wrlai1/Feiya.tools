const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { buildLedger } = require('../lib/inventoryLedger.cjs')
const { buildInventoryEmail, buildInventoryWorkbook } = require('../lib/inventoryEmail.cjs')

test('deleted SKUs stay out of daily sheets and shipment summary without erasing history or zero-stock SKUs', async () => {
  const active = { style: '50747', color: '7 Red Plaid/HOUNDSTOOTH', size: 'M', quantity: 51 }
  const zero = { style: '50747', color: '8 White Black Plaid', size: 'S', quantity: 0 }
  const deleted = { style: '50747', color: 'redplaid/houndstooth', size: 'M' }
  const removedStyle = { style: 'DELETED-STYLE', color: 'BLACK', size: 'S' }
  const history = [
    { ...active, txn_type: 'sales', qty: 5, day: '2026-10-10' },
    { ...zero, txn_type: 'sales', qty: 2, day: '2026-10-12' },
    { ...deleted, txn_type: 'sales', qty: 90, day: '2026-10-13' },
    { ...deleted, txn_type: 'return', qty: 30, day: '2026-10-14' },
    { ...removedStyle, txn_type: 'in', qty: 100, day: '2026-10-14' },
  ]
  const source = { cutoff: '2026-10-05', rows: [{ ...deleted, in: { '2026-10-01': 300 }, out: { '2026-10-02': 50 } }] }
  const inventory = [active, zero]
  const before = JSON.stringify({ source, inventory, history })
  const ledger = buildLedger({ source, inventory, history, reportDate: '2026-10-14' })
  assert.deepEqual(ledger.rows.map((row) => row.color), [active.color, zero.color])
  assert.equal(ledger.rows[1].quantity, 0)
  assert.equal(ledger.rows[1].minimum, 2)
  assert.equal(ledger.rows[1].replenishment, 2)
  assert.equal(ledger.salesDay, '2026-10-13')
  const report = buildInventoryEmail({ reportDate: ledger.reportDate, inventory: ledger.rows, ledger })
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.quantity, 51)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildInventoryWorkbook({ ...report, ledger, reportDate: ledger.reportDate }))
  const sheet = workbook.getWorksheet('50747')
  assert.equal(sheet.rowCount, 7)
  assert.equal(workbook.getWorksheet('DELETED-STYLE'), undefined)
  assert.ok(!JSON.stringify(workbook.model).includes('Unavailable'))
  assert.equal(JSON.stringify({ source, inventory, history }), before)
  assert.deepEqual(buildLedger({ source, history, inventory: [], reportDate: '2026-10-14' }).rows, [])
})
