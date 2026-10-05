const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { buildDailyPerformance, loadDailyPerformance } = require('../lib/dailyPerformance.cjs')
const { buildInventoryEmail, buildInventoryWorkbook } = require('../lib/inventoryEmail.cjs')

const products = [
  { store: 'A', spu: '111', data: { styleNumber: '5010015', unitMultiplier: 2 } },
  { store: 'B', spu: '222', data: { styleNumber: '5010015', unitMultiplier: 3 } },
  { store: 'B', spu: '111', data: { styleNumber: '853105' } },
]
const days = [
  { store: 'A', day: '2026-10-03', rows: [{ spu: '111', units: 5, revenue: 100, spend: 10, roas: 10 }, { spu: 'unknown', units: 50, revenue: 999, spend: 1 }] },
  { store: 'B', day: '2026-10-03', rows: [{ spu: '222', units: 4, revenue: 200, spend: 100, roas: 2 }, { spu: '111', units: 7, revenue: 70, spend: 0 }] },
  { store: 'C', day: '2026-10-02', rows: [{ spu: '111', units: 999, revenue: 999, spend: 1 }] },
  { store: 'D', day: null, rows: [] },
]

test('links by store and SPU then style, converts pieces and weights ROAS by spend', () => {
  const report = buildDailyPerformance({ days, products, styles: ['5010015', '853105'] })
  const sameStyle = report.rows.find((row) => row.styleNumber === '5010015')
  assert.equal(sameStyle.units, 22)
  assert.equal(sameStyle.roas, 300 / 110)
  assert.equal(sameStyle.revenue, 300)
  assert.equal(report.rows.find((row) => row.styleNumber === '853105').roas, null)
  assert.equal(report.details.find((row) => row.spu === 'unknown').styleNumber, '')
  assert.equal(report.coverage.find((row) => row.store === 'C').current, false)
  assert.equal(report.coverage.find((row) => row.store === 'D').current, false)
})

test('only includes selected styles, skips period totals, does not guess missing mappings', () => {
  const report = buildDailyPerformance({ products, styles: ['5010015'], days: [
    ...days,
    { store: 'E', day: '2026-10-03', rows: [{ spu: '111', units: 100, revenue: 100 }, { spu: 'period', units: 200, periodStart: '2026-10-01', periodEnd: '2026-10-03' }] },
  ] })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].units, 22)
  assert.equal(report.details.some((row) => row.spu === 'period'), false)
  assert.equal(report.details.some((row) => row.store === 'E' && row.styleNumber), false)
})

test('workbook keeps shipment date and uploaded purchase date separate with daily received returns', async () => {
  const performance = buildDailyPerformance({ days, products, styles: ['5010015'] })
  const report = buildInventoryEmail({ reportDate: '2026-10-04', movementDay: '2026-10-01',
    inventory: [{ style: '5010015', color: 'Black', size: 'S', quantity: 76 }],
    movements: [{ style: '5010015', color: 'Black', size: 'S', sales: 2, returns: 1 }],
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildInventoryWorkbook({ ...report, reportDate: '2026-10-04', movementDay: '2026-10-01', performance }))
  assert.match(workbook.getWorksheet('Shipments Summary').getCell('A2').value, /2026-10-01/)
  assert.equal(workbook.getWorksheet('Shipments Summary').getCell('K5').value, 1)
  const roas = workbook.getWorksheet('Purchase ROAS')
  assert.match(roas.getCell('A2').value, /2026-10-03.*Dates parsed from uploaded reports/)
  assert.equal(roas.getCell('C5').value, 22)
  assert.equal(roas.getCell('F5').value, 300 / 110)
  assert.match(workbook.getWorksheet('Data Coverage').getCell('C7').value, /Older date/)
})

test('missing analytics tables reports unavailable rather than zero ROAS', async () => {
  const report = await loadDailyPerformance(async () => [{ days: null }], ['5010015'])
  assert.match(report.unavailable, /not available/)
  assert.equal(report.rows.length, 0)
})

test('database reader uses shared admin data, latest uploaded dates without a clock-based cutoff, and lists stores without uploads', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE analytics_stores (username TEXT, name TEXT);
      CREATE TABLE analytics_store_days (username TEXT, store TEXT, day DATE, rows JSONB);
      CREATE TABLE analytics_store_products (username TEXT, store TEXT, spu TEXT, data JSONB);
      INSERT INTO analytics_stores VALUES ('admin','A'), ('admin','B'), ('other','Private');
      INSERT INTO analytics_store_days VALUES
        ('admin','A','2026-10-03','[{"spu":"111","units":5,"revenue":100,"spend":10}]'),
        ('admin','A','2026-10-05','[{"spu":"111","units":999,"revenue":999,"spend":1}]'),
        ('other','Private','2026-10-04','[{"spu":"111","units":999,"revenue":999,"spend":1}]');
      INSERT INTO analytics_store_products VALUES ('admin','A','111','{"styleNumber":"5010015","unitMultiplier":2}');`)
    const sql = async (strings, ...values) => {
      const query = strings.reduce((out, part, index) => out + part + (index < values.length ? `$${index + 1}` : ''), '')
      return (await db.query(query, values)).rows
    }
    const result = await loadDailyPerformance(sql, ['5010015'])
    assert.equal(result.purchaseDay, '2026-10-05')
    assert.equal(result.rows[0].units, 1998)
    assert.equal(result.coverage.length, 2)
    assert.equal(result.coverage.find((row) => row.store === 'B').current, false)
    assert.equal(result.details.some((row) => row.store === 'Private'), false)
  } finally {
    await db.close()
  }
})
