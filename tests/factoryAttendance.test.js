import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPayrollSummary,
  calculateAttendanceDays,
  parseAttendanceFiles,
  parseAttendanceText,
  partitionAttendanceDuplicates,
  payrollRangeForDate,
  payrollRangesBetween,
} from '../src/utils/factoryAttendance.js'

test('parses both attendance machine date formats', () => {
  const text = [
    'ID.\tNombre\tDepart.\tTiempo\tID del dispositivo',
    '5\tAngelica\tINSPECTION\t 06-08-2026     06:54:32\t7',
    '242\tLuz Lopez\tSEWING\t 08/14/2026     18:06:03\t1',
  ].join('\r\n')
  const records = parseAttendanceText(text)
  assert.equal(records[0].punchedAt, '2026-08-06T06:54:32')
  assert.equal(records[1].punchedAt, '2026-08-14T18:06:03')
})

test('reads a multi-day file and identifies exact duplicate punches', () => {
  const text = [
    'ID.\tNombre\tDepart.\tTiempo\tID del dispositivo',
    '5\tAngelica\tINSPECTION\t 06-08-2026     06:54:32\t7',
    '5\tAngelica\tINSPECTION\t 07-08-2026     06:55:00\t7',
    '5\tAngelica\tINSPECTION\t 07-08-2026     06:55:00\t7',
  ].join('\r\n')
  const records = parseAttendanceText(text)
  const { accepted, duplicates } = partitionAttendanceDuplicates(records)
  assert.equal(new Set(records.map((record) => record.punchedAt.slice(0, 10))).size, 2)
  assert.equal(accepted.length, 2)
  assert.deepEqual(duplicates, [{
    employeeCode: 5,
    name: 'Angelica',
    punchedAt: '2026-08-07T06:55:00',
    deviceId: 7,
    sourceFile: '',
    reason: 'repeated_in_file',
  }])

  const existing = new Set(['5|2026-08-06T06:54:32'])
  const partitionedAgainstHistory = partitionAttendanceDuplicates(records, existing)
  assert.equal(partitionedAgainstHistory.accepted.length, 1)
  assert.deepEqual(partitionedAgainstHistory.duplicates.map((item) => item.reason), [
    'already_uploaded',
    'repeated_in_file',
  ])
})

test('combines one employee punches across different attendance machines', () => {
  const [day] = calculateAttendanceDays([
    { employeeCode: 5, name: 'Angelica', deviceId: 1, punchedAt: '2026-08-14T07:00:00' },
    { employeeCode: 5, name: 'Angelica', deviceId: 2, punchedAt: '2026-08-14T12:00:00' },
    { employeeCode: 5, name: 'Angelica', deviceId: 3, punchedAt: '2026-08-14T13:00:00' },
    { employeeCode: 5, name: 'Angelica', deviceId: 2, punchedAt: '2026-08-14T18:00:00' },
  ])
  assert.equal(day.punchCount, 4)
  assert.equal(day.workedMinutes, 600)
  assert.equal(day.needsReview, false)
})

test('merges up to three machine files into one attendance batch', () => {
  const header = 'ID.\tNombre\tDepart.\tTiempo\tID del dispositivo'
  const records = parseAttendanceFiles([
    { fileName: 'machine-1.txt', content: `${header}\n5\tAngelica\tINSPECTION\t14-08-2026 07:00:00\t1` },
    { fileName: 'machine-2.txt', content: `${header}\n5\tAngelica\tINSPECTION\t14-08-2026 12:00:00\t2` },
    { fileName: 'machine-3.txt', content: `${header}\n5\tAngelica\tINSPECTION\t14-08-2026 13:00:00\t3` },
  ])
  assert.deepEqual(records.map((record) => record.sourceFile), ['machine-1.txt', 'machine-2.txt', 'machine-3.txt'])
  assert.equal(records.length, 3)
  assert.throws(() => parseAttendanceFiles([]), /one and three/)
})

test('treats two Saturday punches as a complete half day', () => {
  const [saturday] = calculateAttendanceDays([
    { employeeCode: 5, name: 'Angelica', punchedAt: '2026-08-15T07:00:00' },
    { employeeCode: 5, name: 'Angelica', punchedAt: '2026-08-15T12:00:00' },
  ])
  assert.equal(saturday.workedMinutes, 300)
  assert.equal(saturday.workday, true)
  assert.equal(saturday.needsReview, false)
  assert.deepEqual(saturday.flags, [])
})

test('calculates four punches and flags late, early, and short days', () => {
  const punches = ['07:10:00', '12:00:00', '13:00:00', '17:50:00'].map((time) => ({
    employeeCode: 5,
    name: 'Angelica',
    punchedAt: `2026-08-14T${time}`,
  }))
  const [day] = calculateAttendanceDays(punches)
  assert.equal(day.workedMinutes, 580)
  assert.equal(day.workday, true)
  assert.deepEqual(day.flags, ['late', 'early', 'below_standard'])
})

test('non-four-punch day requires manual confirmation', () => {
  const punches = ['07:00:00', '12:00:00'].map((time) => ({ employeeCode: 7, punchedAt: `2026-08-14T${time}` }))
  const [pending] = calculateAttendanceDays(punches)
  assert.equal(pending.workday, false)
  assert.equal(pending.needsReview, true)
  assert.deepEqual(pending.flags, ['needs_review'])

  const [confirmed] = calculateAttendanceDays(punches, {}, [
    { employeeCode: 7, workDate: '2026-08-14', confirmed: true, adjustedMinutes: 300, late: false, early: true },
  ])
  assert.equal(confirmed.workday, true)
  assert.equal(confirmed.workedMinutes, 300)
  assert.equal(confirmed.early, true)
})

test('uses the two fixed payroll periods', () => {
  assert.deepEqual(payrollRangeForDate('2026-08-18'), { start: '2026-08-06', end: '2026-08-20' })
  assert.deepEqual(payrollRangeForDate('2026-08-03'), { start: '2026-07-21', end: '2026-08-05' })
  assert.deepEqual(payrollRangeForDate('2026-08-25'), { start: '2026-08-21', end: '2026-09-05' })
  assert.deepEqual(payrollRangesBetween('2026-08-06', '2026-08-25'), [
    { start: '2026-08-06', end: '2026-08-20', payrollStart: '2026-08-06', payrollEnd: '2026-08-20', provisional: false },
    { start: '2026-08-21', end: '2026-08-25', payrollStart: '2026-08-21', payrollEnd: '2026-09-05', provisional: true },
  ])
})

test('payroll summary keeps overtime and shortfall separate while paying the signed variance', () => {
  const days = [
    { employeeCode: 5, name: 'Angelica', workday: true, workedMinutes: 600, late: false, early: false, needsReview: false },
  ]
  const settings = { payrollStandardMinutes: 540, hourlyAdjustmentRate: 20, fulltimeBonus: 125 }
  const [overtime] = buildPayrollSummary(days, [{ employeeCode: 5, dailyPayment: 107.37, bonusEligible: true }], settings)
  assert.equal(overtime.overtimeMinutes, 60)
  assert.equal(overtime.shortfallMinutes, 0)
  assert.equal(overtime.hoursAdjustment, 20)
  assert.equal(overtime.estimatedPay, 252.37)

  const [shortfall] = buildPayrollSummary(days, [{ employeeCode: 5, dailyPayment: 100 }], {
    payrollStandardMinutes: 660,
    hourlyAdjustmentRate: 20,
  })
  assert.equal(shortfall.overtimeMinutes, 0)
  assert.equal(shortfall.shortfallMinutes, 60)
  assert.equal(shortfall.hoursAdjustment, -20)
})
