const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { shipmentFileDay, buildLedger, normalizeMinimumRows, skuKey } = require('../lib/inventoryLedger.cjs')
const { buildInventoryWorkbook } = require('../lib/inventoryEmail.cjs')
const { returnBusinessDate } = require('../lib/returnBusinessDate.cjs')
const sku = { style: 'M015', color: 'BLACK', size: 'S' }
const source = { cutoff: '2026-10-13', rows: [{ ...sku, in: { '2026-10-05': 150 }, out: { '2026-10-12': 25, '2026-10-13': 30 }, balance: 95 }] }
const movement = (txn_type, day, qty, applied_day = day) => ({ ...sku, txn_type, day, qty, applied_day })

test('baseline history is not replayed and current balance is not deducted twice', () => {
  const ledger = buildLedger({ source, inventory: [{ ...sku, quantity: 80 }], reportDate: '2026-10-15', history: [movement('sales', '2026-10-13', 30), movement('sales', '2026-10-14', 45), movement('return', '2026-10-15', 5), movement('adjustment', '2026-10-15', 25)] })
  const row = ledger.rows[0]
  assert.equal(row.quantity, 80)
  assert.equal(row.out['2026-10-13'], 30)
  assert.equal(row.minimum, 100)
  assert.equal(row.replenishment, 20)
  assert.equal(row.in['2026-10-15'], 30)
  assert.equal(row.returns['2026-10-15'], 5)
  assert.equal(ledger.salesDay, '2026-10-14')
  assert.equal(ledger.returnDay, '2026-10-15')
})

test('late confirmation with a pre-baseline return date enters history once', () => {
  const ledger = buildLedger({ source, reportDate: '2026-10-16', inventory: [{ ...sku, quantity: 97 }], history: [movement('return', '2026-10-12', 2, '2026-10-16')] })
  assert.equal(ledger.rows[0].in['2026-10-12'], 2)
  assert.equal(ledger.returnDay, '2026-10-12')
})

test('21 calendar days exclude older sales, count missing days as zero and round up', () => {
  const row = buildLedger({ source: { cutoff: '2026-10-13', rows: [] }, reportDate: '2026-10-22', inventory: [{ ...sku, quantity: 0 }], history: [movement('sales', '2026-10-01', 1000), movement('sales', '2026-10-02', 5), movement('sales', '2026-10-22', 6)] }).rows[0]
  assert.equal(row.minimum, 11)
  assert.equal(row.sales21, 11)
})

test('manual Minimum including zero persists and removing override restores automatic demand', () => {
  for (const minimum of [0, 150]) {
    const row = buildLedger({ source, reportDate: '2026-10-14', inventory: [{ ...sku, quantity: 80 }], overrides: [{ sku_key: skuKey(sku), minimum }] }).rows[0]
    assert.equal(row.minimum, minimum)
    assert.equal(row.minimumMode, 'Manual')
    assert.equal(row.replenishment, Math.max(0, minimum - 80))
  }
  assert.equal(buildLedger({ source, reportDate: '2026-10-14', inventory: [{ ...sku, quantity: 80 }] }).rows[0].minimum, 55)
})

test('Minimum uploads reject missing, negative and duplicate SKUs and preserve leading zeros', () => {
  assert.equal(normalizeMinimumRows([{ style: '0055', color: 'BLACK', size: '6', minimum: 2.1 }])[0].minimum, 3)
  assert.throws(() => normalizeMinimumRows([{ ...sku, minimum: '' }]))
  assert.throws(() => normalizeMinimumRows([{ ...sku, minimum: -1 }]))
  assert.throws(() => normalizeMinimumRows([{ ...sku, minimum: 1 }, { ...sku, color: 'black', minimum: 2 }]), /Duplicate/)
})

test('retains every starting SKU and makes missing current balances unavailable', () => {
  const ledger = buildLedger({ source, reportDate: source.cutoff })
  assert.equal(ledger.rows.length, source.rows.length)
  assert.equal(ledger.rows[0].quantity, null)
  assert.equal(ledger.rows[0].replenishment, null)
})

test('workbook retains dated IN/OUT and actual return dates with live replenishment formula', async () => {
  const ledger = buildLedger({ source, inventory: [{ ...sku, quantity: 80 }], reportDate: '2026-10-16', history: [movement('sales', '2026-10-14', 45), movement('return', '2026-10-15', 3)] })
  const bytes = await buildInventoryWorkbook({ rows: [], ledger, reportDate: '2026-10-16', movementDay: ledger.salesDay, returnDay: ledger.returnDay })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  const sheet = workbook.getWorksheet('M015')
  const headers = sheet.getRow(5).values.map((value) => value instanceof Date ? value.toISOString().slice(0, 10) : value)
  const groupHeaders = sheet.getRow(4).values
  const outStart = groupHeaders.indexOf('OUT')
  const outColumns = headers.slice(outStart, headers.indexOf('Total', outStart))
  assert.ok(outColumns.includes('2026-10-14'))
  assert.ok(!outColumns.includes('2026-10-16'))
  assert.ok(headers.some((day, index) => day === '2026-10-15' && index < outStart))
  assert.ok(!groupHeaders.includes('Returns'))
  assert.ok(!groupHeaders.includes('Adjustments'))
  const rateColumn = headers.indexOf('Return Rate')
  assert.equal(rateColumn, headers.indexOf('Total', outStart) + 1)
  assert.equal(sheet.getCell(6, rateColumn).value.result, 3 / 100)
  assert.equal(sheet.getCell(6, rateColumn).numFmt, '0.0%')
  assert.equal(sheet.getCell(6, headers.indexOf('Balance')).value, 80)
  assert.equal(sheet.getCell(6, headers.indexOf('Minimum')).value.result, 100)
  assert.equal(sheet.getCell(6, headers.indexOf('Replenishment')).value.result, 20)
  assert.equal(sheet.getCell(6, headers.indexOf('2026-10-06')).value, null)
})

test('return date defaults to today in New York and accepts valid backdated dates', () => {
  const now = new Date('2026-10-14T01:00:00Z')
  assert.equal(returnBusinessDate('', now), '2026-10-13')
  assert.equal(returnBusinessDate('2026-10-10', now), '2026-10-10')
  assert.throws(() => returnBusinessDate('2026-10-14', now))
  assert.throws(() => returnBusinessDate('2026-02-30', now))
})

test('universal ledger applies only selected system styles, including a never-seen style', () => {
  const row = { style: 'NEW-STYLE-999', color: 'NEW COLOR', size: '42' }
  const ledger = buildLedger({ reportDate: '2026-10-13', styles: ['NEW-STYLE-999'], inventory: [
    { ...row, quantity: 80 }, { style: 'UNSELECTED', color: 'OTHER', size: 'M', quantity: 900 },
  ], history: [
    { ...row, txn_type: 'sales', day: '2026-10-12', qty: 100 },
    { style: 'UNSELECTED', color: 'OTHER', size: 'M', txn_type: 'sales', day: '2026-10-13', qty: 900 },
  ] })
  assert.equal(ledger.rows.length, 1)
  assert.equal(ledger.rows[0].minimum, 100)
  assert.equal(ledger.rows[0].replenishment, 20)
  assert.equal(ledger.salesDay, '2026-10-12')
})

test('no sales records produces zero demand without inventing an uploaded date', () => {
  const ledger = buildLedger({ reportDate: '2026-10-13', inventory: [{ ...sku, quantity: 20 }] })
  assert.equal(ledger.salesDay, '')
  assert.equal(ledger.rows[0].minimum, 0)
  assert.equal(ledger.rows[0].replenishment, 0)
})

test('reporting aliases sum physical stock and demand without mutating inventory', () => {
  const inventory = [{ style: 'NEW', color: 'BLACK', size: '2X', quantity: 3 }, { style: 'NEW', color: 'black', size: '2XL', quantity: 4 }]
  const original = JSON.stringify(inventory)
  const ledger = buildLedger({ reportDate: '2026-10-13', inventory, history: [
    { style: 'NEW', color: 'BLACK', size: '2XL', txn_type: 'sales', day: '2026-10-12', qty: 10 },
  ] })
  assert.equal(ledger.rows.length, 1)
  assert.equal(ledger.rows[0].quantity, 7)
  assert.equal(ledger.rows[0].replenishment, 3)
  assert.equal(JSON.stringify(inventory), original)
})

test('invalid quantities and dates fail explicitly rather than generating plausible zeros', () => {
  assert.throws(() => buildLedger({ reportDate: '2026-02-30' }), /valid report date/)
  assert.throws(() => buildLedger({ reportDate: '2026-10-13', inventory: [{ ...sku, quantity: 'NaN' }] }), /invalid SKU/)
  assert.throws(() => buildLedger({ reportDate: '2026-10-13', history: [movement('sales', '2026-02-30', 2)] }), /Invalid inventory movement/)
  assert.throws(() => normalizeMinimumRows([{ ...sku, minimum: ' ' }]))
  assert.throws(() => normalizeMinimumRows([{ ...sku, minimum: true }]))
})

test('all-history return rate excludes receipts, allows over 100 percent and zero shipments is N/A', async () => {
  const other = { style: 'RATE', color: 'NO SALES', size: 'M' }
  const ledger = buildLedger({ reportDate: '2026-10-13', inventory: [{ ...sku, quantity: 80 }, { ...other, quantity: 10 }], history: [
    movement('sales', '2026-09-01', 5), movement('sales', '2026-10-12', 5),
    movement('return', '2026-10-13', 15), movement('in', '2026-10-13', 100),
    { ...other, txn_type: 'return', day: '2026-10-13', qty: 2 },
  ] })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildInventoryWorkbook({ rows: [], ledger, reportDate: ledger.reportDate, movementDay: ledger.salesDay, returnDay: ledger.returnDay }))
  const sheet = workbook.getWorksheet('M015')
  const headers = sheet.getRow(5).values
  const rate = sheet.getCell(6, headers.indexOf('Return Rate'))
  assert.equal(rate.value.result, 1.5)
  assert.ok(rate.value.formula.includes("15/"))
  assert.equal(sheet.getCell(6, headers.indexOf('Total')).value.result, 115)
  const empty = workbook.getWorksheet('RATE')
  assert.equal(empty.getCell(6, empty.getRow(5).values.indexOf('Return Rate')).value.result, 'N/A')
})

test('each IN and OUT section shows latest seven calendar days and collapses earlier history', async () => {
  const ledger = buildLedger({ reportDate: '2026-10-13', inventory: [{ ...sku, quantity: 80 }], history: [
    movement('sales', '2026-09-01', 5), movement('sales', '2026-10-10', 7),
    movement('in', '2026-09-02', 100), movement('return', '2026-10-13', 2),
  ] })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildInventoryWorkbook({ rows: [], ledger, reportDate: ledger.reportDate, movementDay: ledger.salesDay, returnDay: ledger.returnDay }))
  const sheet = workbook.getWorksheet('M015')
  const headers = sheet.getRow(5).values
  const outStart = sheet.getRow(4).values.indexOf('OUT')
  const outTotal = headers.indexOf('Total', outStart)
  let visibleIn = 0, visibleOut = 0, hidden = 0
  for (let index = 3; index < headers.length; index++) {
    if (!(headers[index] instanceof Date)) { assert.equal(Boolean(sheet.getColumn(index).hidden), false); continue }
    const day = headers[index].toISOString().slice(0, 10)
    const isOut = index >= outStart && index < outTotal
    const expectedHidden = day < (isOut ? '2026-10-04' : '2026-10-07')
    assert.equal(Boolean(sheet.getColumn(index).hidden), expectedHidden)
    if (expectedHidden) { assert.equal(sheet.getColumn(index).outlineLevel, 1); hidden++ }
    else if (isOut) visibleOut++; else visibleIn++
  }
  assert.equal(visibleIn, 7)
  assert.equal(visibleOut, 7)
  assert.ok(hidden > 0)
  assert.equal(sheet.getCell(6, outTotal).value.result, 12)
  assert.equal(sheet.getCell(6, headers.indexOf('Return Rate')).value.result, 2 / 12)
  assert.equal(sheet.getCell(6, headers.indexOf('Minimum')).value.result, 7)
})

test('Auto Deduct filename date overrides order dates and undated files use upload date', () => {
  assert.equal(shipmentFileDay('TEMU ORDER-1010-packing list.xlsx', '2026-10-13'), '2026-10-10')
  assert.equal(shipmentFileDay('TEMU-2026-10-10.xlsx', '2026-10-13'), '2026-10-10')
  assert.equal(shipmentFileDay('TEMU-20261010.xlsx', '2026-10-13'), '2026-10-10')
  assert.equal(shipmentFileDay('TEMU-123456789012.xlsx', '2026-10-13'), '2026-10-13')
  assert.equal(shipmentFileDay('TEMU-1231.xlsx', '2027-01-02'), '2026-12-31')
  assert.equal(shipmentFileDay(null, '2026-10-13'), '2026-10-13')
  assert.throws(() => shipmentFileDay('TEMU-1010-1011.xlsx', '2026-10-13'), /Multiple/)
})
