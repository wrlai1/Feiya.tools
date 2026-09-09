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
  const report = buildInventoryEmail({ reportDate: '2026-09-07', inventory: [{ style: '<50199>', color: 'White', size: 'M', quantity: 12 }], movements: [{ style: '<50199>', color: 'White', size: 'M', sales: 3, returns: 1 }] })
  assert.deepEqual(report.totals, { quantity: 12, sales: 3, returns: 1, net: -2 })
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
      { style: '50199', color: 'White', size: 'M', quantity: 12 },
      { style: '50199', color: 'Wine', size: 'M', quantity: 35 },
      { style: '50200', color: 'Black', size: 'L', quantity: 80 },
    ],
    movements: [{ style: '50199', color: 'White', size: 'M', sales: 3, returns: 1 }],
  })
  const bytes = await buildInventoryWorkbook({ ...report, reportDate: '2026-09-07', movementDay: '2026-09-06' })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['50199', '50200'])
  const sheet = workbook.getWorksheet('50199')
  assert.deepEqual(sheet.getRow(5).values.slice(1), ['White', 'M', 12, 3, 1, -2])
  assert.equal(sheet.getCell('C5').fill.fgColor.argb, 'FFF4CCCC')
  assert.equal(sheet.getCell('C6').fill.fgColor.argb, 'FFFFF2CC')
  assert.equal(workbook.getWorksheet('50200').getCell('C5').fill.type, 'pattern')
  assert.notEqual(workbook.getWorksheet('50200').getCell('C5').fill.fgColor?.argb, 'FFF4CCCC')
})
