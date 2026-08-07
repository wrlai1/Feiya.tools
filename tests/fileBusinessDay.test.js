import test from 'node:test'
import assert from 'node:assert/strict'

import { businessDayFromFilename, validBusinessDay } from '../src/utils/fileBusinessDay.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'
import { fillTemplate } from '../src/utils/autoDeductEngine.js'

test('Auto Deduct reads one valid YYYYMMDD business day from the filename', () => {
  assert.deepEqual(businessDayFromFilename('TEMU ORDER-20260803.xlsx'), {
    day: '2026-08-03',
    status: 'parsed',
  })
  assert.deepEqual(businessDayFromFilename('20260803_consolidated.csv'), {
    day: '2026-08-03',
    status: 'parsed',
  })
})

test('Auto Deduct requires user input when a filename date is missing or unsafe', () => {
  assert.equal(businessDayFromFilename('TEMU ORDER.xlsx').status, 'missing')
  assert.equal(businessDayFromFilename('TEMU ORDER-20260230.xlsx').status, 'invalid')
  assert.equal(businessDayFromFilename('TEMU-20260803-20260230.xlsx').status, 'invalid')
  assert.equal(businessDayFromFilename('TEMU-20260803-20260804.xlsx').status, 'ambiguous')
  assert.equal(businessDayFromFilename('ORDER1202608039.xlsx').status, 'missing')
})

test('business days accept real calendar dates only', () => {
  assert.equal(validBusinessDay('2026-08-03'), '2026-08-03')
  assert.equal(validBusinessDay('2026-02-30'), '')
  assert.equal(validBusinessDay('08/03/2026'), '')
})

test('one filename business day overrides every order row in the Auto Deduct batch', () => {
  const salesRows = consolidateRows([
    { SKU: '0015Black&DenimM', Quantity: 2, 'Order Created At': '2026-08-01 23:30:00' },
    { SKU: '5010015black M', Quantity: 1, 'Order Created At': '2026-08-02 10:00:00' },
  ], { businessDay: '2026-08-03' }).consolidated
  const result = fillTemplate([
    { STYLE: '5010015', COLOR: 'Black', SIZE: 'M' },
    { STYLE: '5010015', COLOR: 'Denim', SIZE: 'M' },
  ], salesRows)

  assert.equal(result.stats.filled_total, 5)
  assert.deepEqual([...new Set(result.matchLog.map((row) => row.businessDay))], ['2026-08-03'])
})
