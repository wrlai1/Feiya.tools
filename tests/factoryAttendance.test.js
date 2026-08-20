import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attendancePunchLabel,
  buildAttendanceSummary,
  buildPayrollSummary,
  buildDailyRoster,
  calculateAttendanceDays,
  filterAttendanceRecordsByDates,
  parseAttendanceFiles,
  parseAttendanceText,
  partitionAttendanceDuplicates,
  payrollRangeForDate,
  payrollRangesBetween,
  standardMinutesForSchedule,
} from '../src/utils/factoryAttendance.js'

test('labels known and uncertain punch roles clearly', () => {
  assert.deepEqual([0, 1, 2, 3].map((index) => attendancePunchLabel({ punches: ['a', 'b', 'c', 'd'] }, index)), [
    'Clock In', 'Lunch Out', 'Lunch In', 'Clock Out',
  ])
  assert.deepEqual([0, 1, 2].map((index) => attendancePunchLabel({ punches: ['a', 'b', 'c'] }, index)), [
    'Clock In', 'Unconfirmed Punch', 'Clock Out',
  ])
  assert.equal(attendancePunchLabel({ punches: ['a'] }, 0), 'Only Punch')
})

test('attendance summary counts complete pairs but excludes unconfirmed hours', () => {
  const employees = [
    { employeeCode: 5, name: 'Angelica', department: 'Inspection' },
    { employeeCode: 6, name: 'Laura', department: 'Sewing' },
  ]
  const days = [
    {
      employeeCode: 5, name: 'Angelica', workDate: '2026-08-18', punchCount: 4,
      workday: true, workedMinutes: 590, late: true, early: false, needsReview: false,
    },
    {
      employeeCode: 5, name: 'Angelica', workDate: '2026-08-19', punchCount: 3,
      workday: true, workedMinutes: 600, late: false, early: false, needsReview: true,
    },
    {
      employeeCode: 5, name: 'Angelica', workDate: '2026-08-16', punchCount: 2,
      workday: false, workedMinutes: null, late: false, early: false, needsReview: true,
    },
  ]

  const summary = buildAttendanceSummary(days, employees)
  assert.equal(summary.length, 2)
  assert.deepEqual(summary[0], {
    employeeCode: 5, name: 'Angelica', department: 'Inspection', attendanceDays: 2,
    workdays: 1, totalMinutes: 1190, lateDays: 1, earlyDays: 0, reviewDays: 2,
  })
  assert.equal(summary[1].attendanceDays, 0)
  assert.equal(summary[1].totalMinutes, 0)
})

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

test('keeps only the dates selected before a multi-day upload', () => {
  const records = [
    { employeeCode: 5, punchedAt: '2026-08-18T07:00:00' },
    { employeeCode: 5, punchedAt: '2026-08-19T07:00:00' },
  ]
  assert.deepEqual(filterAttendanceRecordsByDates(records, ['2026-08-18']), [records[0]])
  assert.deepEqual(filterAttendanceRecordsByDates(records, []), [])
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
  assert.deepEqual(day.flags, ['needs_review', 'late', 'early', 'below_standard'])
})

test('non-four-punch day calculates known hours and requires manual confirmation', () => {
  const punches = ['07:00:00', '12:00:00'].map((time) => ({ employeeCode: 7, punchedAt: `2026-08-14T${time}` }))
  const [pending] = calculateAttendanceDays(punches)
  assert.equal(pending.workday, true)
  assert.equal(pending.workedMinutes, 240)
  assert.equal(pending.needsReview, true)
  assert.deepEqual(pending.flags, ['needs_review', 'missing_lunch', 'early', 'below_standard'])

  const [confirmed] = calculateAttendanceDays(punches, {}, [
    { employeeCode: 7, workDate: '2026-08-14', confirmed: true, adjustedMinutes: 300, late: false, early: true },
  ])
  assert.equal(confirmed.workday, true)
  assert.equal(confirmed.workedMinutes, 300)
  assert.equal(confirmed.early, true)
})

test('derives daily hours from the selected end time', () => {
  assert.equal(standardMinutesForSchedule('2026-08-18', '17:00'), 540)
  assert.equal(standardMinutesForSchedule('2026-08-18', '18:00'), 600)
  assert.equal(standardMinutesForSchedule('2026-08-18', '19:00'), 660)
  assert.equal(standardMinutesForSchedule('2026-08-15', '12:00'), 300)
})

test('missing lunch punches still count a full covered day but need review', () => {
  const [day] = calculateAttendanceDays([
    { employeeCode: 5, punchedAt: '2026-08-18T06:41:52' },
    { employeeCode: 5, punchedAt: '2026-08-18T18:10:43' },
  ], {}, [], [{ workDate: '2026-08-18', endTime: '18:00', standardMinutes: 600 }], '2026-08-19T08:00:00')
  assert.equal(day.workedMinutes, 600)
  assert.equal(day.workday, true)
  assert.equal(day.needsReview, true)
  assert.deepEqual(day.flags, ['needs_review', 'missing_lunch'])
})

test('deducts late or early minutes from a covered two-punch day', () => {
  const schedules = [{ workDate: '2026-08-18', endTime: '18:00', standardMinutes: 600 }]
  const [late] = calculateAttendanceDays([
    { employeeCode: 5, punchedAt: '2026-08-18T07:10:00' },
    { employeeCode: 5, punchedAt: '2026-08-18T18:10:00' },
  ], {}, [], schedules, '2026-08-19T08:00:00')
  assert.equal(late.workedMinutes, 590)
  assert.deepEqual(late.flags, ['needs_review', 'missing_lunch', 'late', 'below_standard'])

  const [early] = calculateAttendanceDays([
    { employeeCode: 5, punchedAt: '2026-08-18T06:50:00' },
    { employeeCode: 5, punchedAt: '2026-08-18T17:40:00' },
  ], {}, [], schedules, '2026-08-19T08:00:00')
  assert.equal(early.workedMinutes, 580)
  assert.deepEqual(early.flags, ['needs_review', 'missing_lunch', 'early', 'below_standard'])
})

test('caps normal hours and flags possible early work or overtime', () => {
  const schedules = [{ workDate: '2026-08-18', endTime: '18:00', standardMinutes: 600 }]
  const [day] = calculateAttendanceDays([
    { employeeCode: 5, punchedAt: '2026-08-18T05:50:00' },
    { employeeCode: 5, punchedAt: '2026-08-18T12:00:00' },
    { employeeCode: 5, punchedAt: '2026-08-18T13:00:00' },
    { employeeCode: 5, punchedAt: '2026-08-18T19:00:00' },
  ], {}, [], schedules, '2026-08-19T08:00:00')
  assert.equal(day.workedMinutes, 600)
  assert.equal(day.needsReview, true)
  assert.deepEqual(day.flags, ['needs_review', 'possible_early_work', 'possible_overtime'])
})

test('keeps the current Guatemala workday in progress through the 30-minute grace period', () => {
  const punches = [{ employeeCode: 5, punchedAt: '2026-08-19T07:00:00' }]
  const schedules = [{ workDate: '2026-08-19', endTime: '17:00', standardMinutes: 540 }]
  const [inProgress] = calculateAttendanceDays(punches, {}, [], schedules, '2026-08-19T17:30:00')
  assert.equal(inProgress.inProgress, true)
  assert.equal(inProgress.workedMinutes, null)
  assert.equal(inProgress.needsReview, false)
  assert.deepEqual(inProgress.flags, ['in_progress'])

  const [finished] = calculateAttendanceDays(punches, {}, [], schedules, '2026-08-19T17:30:01')
  assert.equal(finished.inProgress, false)
  assert.equal(finished.needsReview, true)
  assert.deepEqual(finished.flags, ['needs_review', 'early'])
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

test('payroll summary pays valid hours without negative adjustments', () => {
  const days = [
    { employeeCode: 5, name: 'Angelica', workday: true, workedMinutes: 600, late: false, early: false, needsReview: false },
  ]
  const settings = { payrollStandardMinutes: 540, weekdayStandardMinutes: 600, hourlyAdjustmentRate: 20, fulltimeBonus: 125 }
  const [overtime] = buildPayrollSummary(days, [{ employeeCode: 5, dailyPayment: 107.37, bonusEligible: true }], settings)
  assert.equal(overtime.overtimeMinutes, 60)
  assert.equal(overtime.shortfallMinutes, 0)
  assert.equal(overtime.basicSalary, 107.37)
  assert.equal(overtime.overtimePay, 20)
  assert.equal(overtime.estimatedPay, 252.37)

  const [shortfall] = buildPayrollSummary(days, [{ employeeCode: 5, dailyPayment: 100 }], {
    payrollStandardMinutes: 660, weekdayStandardMinutes: 600,
    hourlyAdjustmentRate: 20,
  })
  assert.equal(shortfall.overtimeMinutes, 0)
  assert.equal(shortfall.shortfallMinutes, 60)
  assert.equal(shortfall.basicSalary, 100)
  assert.equal(shortfall.overtimePay, 0)
  assert.equal(shortfall.estimatedPay, 100)
})

test('pays 89 hours at the normal hourly rate and lists employees without punches', () => {
  const employees = [
    { employeeCode: 5, name: 'Angelica', department: 'Inspection', dailyPayment: 107.37 },
    { employeeCode: 6, name: 'Laura', department: 'Sewing', dailyPayment: 107.37 },
  ]
  const days = [{
    employeeCode: 5, name: 'Angelica', workDate: '2026-08-18', workday: true,
    workedMinutes: 89 * 60, late: false, early: false, needsReview: false,
  }]
  const summary = buildPayrollSummary(days, employees, { payrollStandardMinutes: 5400, weekdayStandardMinutes: 600 })
  assert.equal(summary.length, 2)
  assert.ok(Math.abs(summary[0].basicSalary - 955.593) < 0.000001)
  assert.equal(summary[0].overtimePay, 0)
  assert.equal(summary[1].totalMinutes, 0)
  assert.equal(summary[1].basicSalary, 0)

  const roster = buildDailyRoster(days, employees, '2026-08-18')
  assert.equal(roster.length, 2)
  assert.equal(roster[0].absent, undefined)
  assert.equal(roster[1].absent, true)
  assert.deepEqual(roster[1].flags, ['absent'])
})
