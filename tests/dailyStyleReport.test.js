import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'

import {
  buildDailyStyleReport,
  buildDailyStyleWorkbookData,
  createDailyStyleWorkbook,
} from '../src/utils/dailyStyleReport.js'

const inventoryRows = [
  { Style: 'M022 Missy', Color: 'HERRINGBONE JQD TAUPE', Size: 'S', Quantity: 96 },
  { Style: 'M022 Missy', Color: 'BLACK', Size: 'S', Quantity: 186 },
  { Style: 'M022 Missy', Color: 'BLACK', Size: 'M', Quantity: 150 },
  { Style: 'M022 Petite', Color: 'BLACK', Size: 'PS', Quantity: 36 },
]

const movements = [
  { txn_type: 'sales', style: 'OTHER', color: 'BLACK', size: 'S', qty: 1, day: '2026-08-03' },
  { txn_type: 'sales', style: 'M022 Missy', color: 'BLACK', size: 'S', qty: 3, day: '2026-08-03' },
  { txn_type: 'sales', style: 'M022 Missy', color: 'BLACK', size: 'S', qty: 2, day: '2026-08-02' },
  { txn_type: 'sales', style: 'M022 Missy', color: 'BLACK', size: 'S', qty: 5, day: '2026-07-28' },
  { txn_type: 'sales', style: 'M022 Missy', color: 'BLACK', size: 'S', qty: 4, day: '2026-07-27' },
  { txn_type: 'sales', style: 'M022 Missy', color: 'BLACK', size: 'M', qty: 7, day: '2026-08-03' },
  { txn_type: 'return', style: 'M022 Missy', color: 'BLACK', size: 'M', qty: 9, day: '2026-08-03' },
  { txn_type: 'sales', style: 'M022 Petite', color: 'BLACK', size: 'PS', qty: 20, day: '2026-08-03' },
]

test('daily style report keeps current inventory intact and includes zero-sales colors', () => {
  const report = buildDailyStyleReport({
    inventoryRows,
    movements,
    style: 'M022 Missy',
    today: '2026-08-03',
  })

  assert.equal(report.dataThroughDay, '2026-08-03')
  assert.equal(report.totals.currentInventory, 432)
  assert.equal(report.totals.latestDaySales, 10)
  assert.equal(report.totals.last7Sales, 17)
  assert.equal(report.totals.previous7Sales, 4)
  assert.deepEqual(report.sizes, ['S', 'M'])

  const black = report.colorRows.find((row) => row.color === 'BLACK')
  const taupe = report.colorRows.find((row) => row.color === 'HERRINGBONE JQD TAUPE')
  assert.deepEqual(black.inventoryBySize, { S: 186, M: 150 })
  assert.equal(black.latestDaySales, 10)
  assert.equal(black.last7Sales, 17)
  assert.equal(taupe.onHand, 96)
  assert.equal(taupe.last28Sales, 0)
  assert.equal(taupe.daysLeft, null)
})

test('sales windows end on the latest available order date instead of upload time', () => {
  const report = buildDailyStyleReport({
    inventoryRows,
    movements: movements.filter((movement) => movement.day !== '2026-08-03'),
    style: 'M022 Missy',
    today: '2026-08-10',
  })

  assert.equal(report.dataThroughDay, '2026-08-02')
  assert.equal(report.totals.latestDaySales, 2)
  assert.equal(report.dailyRows.at(-1).day, '2026-08-02')
})

test('5010015 report keeps August 3 sales on the original order date', () => {
  const report = buildDailyStyleReport({
    inventoryRows: [
      { Style: '5010015', Color: 'BLACK', Size: 'S', Quantity: 58 },
      { Style: '5010015', Color: 'BLACK', Size: 'M', Quantity: 88 },
    ],
    movements: [
      { txn_type: 'sales', style: '5010015', color: 'BLACK', size: 'S', qty: 13, day: '2026-08-03' },
      { txn_type: 'sales', style: '5010015', color: 'BLACK', size: 'M', qty: 15, day: '2026-08-03' },
      { txn_type: 'sales', style: '5010015', color: 'BLACK', size: 'S', qty: 13, day: '2026-08-04' },
    ],
    style: '5010015',
    today: '2026-08-04',
  })
  const august3 = report.dailyRows.find((row) => row.day === '2026-08-03')
  const august4 = report.dailyRows.find((row) => row.day === '2026-08-04')

  assert.deepEqual(august3, { day: '2026-08-03', bySize: { S: 13, M: 15 }, total: 28 })
  assert.deepEqual(august4, { day: '2026-08-04', bySize: { S: 13, M: 0 }, total: 13 })
  assert.ok(report.sourceMovements.some((row) => row.day === '2026-08-03' && row.quantity === 15))
})

test('gross sales drive sales comparison while returns do not reduce reported demand', () => {
  const report = buildDailyStyleReport({
    inventoryRows,
    movements,
    style: 'M022 Missy',
    today: '2026-08-03',
  })
  const blackMedium = report.sizeRows.find((row) => row.color === 'BLACK' && row.size === 'M')

  assert.equal(blackMedium.latestDaySales, 7)
  assert.equal(blackMedium.last28Sales, 7)
  assert.equal(report.sourceMovements.filter((row) => row.type === 'return').length, 1)
})

test('workbook exports one focused, color-grouped sheet for a style', () => {
  const report = buildDailyStyleReport({
    inventoryRows,
    movements,
    style: 'M022 Missy',
    today: '2026-08-03',
  })
  const data = buildDailyStyleWorkbookData(report)
  const workbook = createDailyStyleWorkbook(XLSX, report)
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true })
  const reopened = XLSX.read(buffer, { type: 'buffer' })
  const mainRows = XLSX.utils.sheet_to_json(reopened.Sheets['M022 Missy'], {
    header: 1,
    defval: '',
  })

  assert.deepEqual(reopened.SheetNames, ['M022 Missy'])
  assert.equal(data.sheets[0].rows[0][0], 'M022 Missy Daily Style Report / 每日款式报告')
  assert.deepEqual(data.sheets[0].groups, {
    inventoryStart: 1,
    inventoryTotal: 3,
    salesStart: 4,
    salesEnd: 8,
    forecastColumn: 9,
  })
  assert.ok(mainRows.some((row) => row[0] === 'HERRINGBONE JQD TAUPE'))
  assert.ok(mainRows.some((row) => row[0] === 'TOTAL' && row.includes(432)))
})

test('multi-style workbook creates one safely named sheet per selected style', () => {
  const missy = buildDailyStyleReport({ inventoryRows, movements, style: 'M022 Missy', today: '2026-08-03' })
  const petite = buildDailyStyleReport({ inventoryRows, movements, style: 'M022 Petite', today: '2026-08-03' })
  const workbook = createDailyStyleWorkbook(XLSX, [missy, petite])

  assert.deepEqual(workbook.SheetNames, ['M022 Missy', 'M022 Petite'])
  assert.ok(workbook.Sheets['M022 Missy']['!freeze'])
  assert.ok(workbook.Sheets['M022 Petite']['!autofilter'])
})

test('report remains usable when the selected style has no sales history', () => {
  const report = buildDailyStyleReport({
    inventoryRows,
    movements: [],
    style: 'M022 Missy',
    today: '2026-08-03',
  })

  assert.equal(report.dataThroughDay, '2026-08-03')
  assert.equal(report.totals.currentInventory, 432)
  assert.equal(report.totals.last28Sales, 0)
  assert.equal(report.totals.dailyAverage, 0)
  assert.equal(report.totals.daysLeft, null)
  assert.equal(report.dailyRows.length, 28)
  assert.ok(report.dailyRows.every((row) => row.total === 0))
})

test('style and color capitalization differences collapse without losing inventory', () => {
  const report = buildDailyStyleReport({
    inventoryRows: [
      { Style: 'M022 Missy', Color: 'Dusty Blue', Size: 'S', Quantity: 10 },
      { Style: 'm022   missy', Color: 'DUSTY BLUE', Size: 'M', Quantity: 12 },
    ],
    movements: [
      { txn_type: 'sales', style: 'm022 missy', color: 'dusty blue', size: 'S', qty: 2, day: '2026-08-03' },
    ],
    style: 'M022 Missy',
    today: '2026-08-03',
  })

  assert.equal(report.colorRows.length, 1)
  assert.equal(report.colorRows[0].onHand, 22)
  assert.equal(report.colorRows[0].latestDaySales, 2)
})

test('plus-size aliases 1X and 1XL resolve to one SKU and one report column', () => {
  const report = buildDailyStyleReport({
    inventoryRows: [
      { Style: 'M022 Plus', Color: 'BLACK', Size: '1X', Quantity: 25 },
    ],
    movements: [
      { txn_type: 'sales', style: 'M022 Plus', color: 'Black', size: '1XL', qty: 4, day: '2026-08-03' },
    ],
    style: 'M022 Plus',
    today: '2026-08-03',
  })

  assert.deepEqual(report.sizes, ['1X'])
  assert.equal(report.sizeRows.length, 1)
  assert.equal(report.sizeRows[0].onHand, 25)
  assert.equal(report.sizeRows[0].latestDaySales, 4)
})
