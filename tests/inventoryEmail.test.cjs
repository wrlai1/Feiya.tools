const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { buildInventoryEmail, buildInventoryWorkbook, localDateParts, normalizeSettings, previousDate, shouldSendDailyReport } = require('../lib/inventoryEmail.cjs')

test('normalizes comma separated recipients and styles', () => {
  assert.deepEqual(normalizeSettings({ enabled: true, recipients: 'A@EXAMPLE.COM, b@example.com', styles: '50199, 50200', sendHour: 8 }), {
    enabled: true, recipients: ['a@example.com', 'b@example.com'], styles: ['50199', '50200'], sendHour: 8, timezone: 'America/New_York',
  })
})

test('rejects invalid email and send hour', () => {
  assert.throws(() => normalizeSettings({ recipients: 'bad-email' }), /Invalid email/)
  assert.throws(() => normalizeSettings({ sendHour: 24 }), /0 to 23/)
})

test('builds totals and escapes inventory content', () => {
  const report = buildInventoryEmail({ reportDate: '2026-09-07', inventory: [{ style: '<50199>', color: 'White', size: 'M', quantity: 12 }], movements: [{ style: '<50199>', color: 'White', size: 'M', sales: 3, returns: 1, sales30: 90 }] })
  assert.deepEqual(report.totals, { quantity: 12, sales: 3, returns: 1, net: -2, sales30: 90, targetStock: 63, replenishment: 51 })
  assert.equal(report.rows[0].dailyAverage, 3)
  assert.equal(report.rows[0].targetStock, 63)
  assert.equal(report.rows[0].replenishment, 51)
  assert.match(report.html, /&lt;50199&gt;/)
  assert.doesNotMatch(report.html, /<50199>/)
})

test('uses New York local date and previous calendar date', () => {
  assert.deepEqual(localDateParts(new Date('2026-01-01T04:30:00Z')), { date: '2025-12-31', hour: 23 })
  assert.equal(previousDate('2026-03-01'), '2026-02-28')
})

test('allows a later cron invocation to catch up a missed daily report', () => {
  assert.equal(shouldSendDailyReport(8, 9), false)
  assert.equal(shouldSendDailyReport(9, 9), true)
  assert.equal(shouldSendDailyReport(10, 9), true)
})

test('builds one formatted worksheet per style with stock alerts', async () => {
  const report = buildInventoryEmail({
    reportDate: '2026-09-07',
    inventory: [
      { style: '50199', color: 'White', size: 'S', quantity: 120 },
      { style: '50199', color: 'White', size: 'M', quantity: 12 },
      { style: '50199', color: 'Wine', size: 'M', quantity: 75 },
      { style: '50200', color: 'Black', size: 'L', quantity: 100 },
      { style: '50200', color: 'Black', size: '6', quantity: 100 },
      { style: '50200', color: 'Black', size: 'PM', quantity: 100 },
      { style: '50200', color: 'Black', size: '2X', quantity: 100 },
      { style: '50200', color: 'Black', size: '14W', quantity: 100 },
    ],
    movements: [
      { style: '50199', color: 'White', size: 'S', sales: 2, returns: 0, sales30: 60 },
      { style: '50199', color: 'White', size: 'M', sales: 3, returns: 1, sales30: 90 },
      { style: '50199', color: 'Wine', size: 'M', sales: 1, returns: 0, sales30: 30 },
    ],
  })
  const bytes = await buildInventoryWorkbook({ ...report, reportDate: '2026-09-07', movementDay: '2026-09-06' })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['50199', '50200'])
  const sheet = workbook.getWorksheet('50199')
  assert.deepEqual(['A4', 'B4', 'D4', 'F4', 'H4', 'J4', 'L4', 'N4'].map((cell) => sheet.getCell(cell).value), ['Color', 'Current Inventory', 'Yesterday Sales', 'Yesterday Returns', '30-Day Avg / Day', '21-Day Target', 'Replenishment', 'Total Replenishment'])
  assert.deepEqual(sheet.getRow(5).values.slice(2, 6), ['S', 'M', 'S', 'M'])
  assert.equal(sheet.getCell('B5').fill.fgColor.argb, 'FF16A34A')
  assert.equal(sheet.getCell('C5').fill.fgColor.argb, 'FF16A34A')
  assert.deepEqual(sheet.getRow(6).values.slice(1, 6), ['White', 120, 12, 2, 3])
  assert.deepEqual(sheet.getCell('K6').value, { formula: 'ROUNDUP(I6*21,0)', result: 63 })
  assert.deepEqual(sheet.getCell('M6').value, { formula: 'MAX(0,K6-C6)', result: 51 })
  assert.equal(sheet.getCell('C6').fill.fgColor.argb, 'FFF4CCCC')
  assert.equal(sheet.getCell('C7').fill.fgColor.argb, 'FFFFF2CC')
  assert.equal(sheet.getCell('B7').value, null)
  assert.equal(sheet.getCell('B7').fill.type, 'pattern')
  assert.equal(sheet.getCell('B7').fill.pattern, 'none')
  const otherSizes = workbook.getWorksheet('50200')
  assert.notEqual(otherSizes.getCell('B6').fill.fgColor?.argb, 'FFF4CCCC')
  assert.notEqual(otherSizes.getCell('B6').fill.fgColor?.argb, 'FFFFF2CC')
  const sizeFills = {}
  const expectedSizes = new Set(['L', 'PM', '2X', '6', '14W'])
  otherSizes.getRow(5).eachCell((cell) => {
    if (expectedSizes.has(String(cell.value))) sizeFills[cell.value] = cell.fill.fgColor?.argb
  })
  assert.deepEqual(sizeFills, {
    L: 'FF16A34A', PM: 'FF0F766E', '2X': 'FF7C3AED', 6: 'FF2563EB', '14W': 'FFBE185D',
  })
})
