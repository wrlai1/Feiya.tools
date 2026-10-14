import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import { buildAttendanceWorkbook } from '../src/utils/factoryAttendanceExcel.js'

test('attendance workbook combines multiple days in one simple sheet', () => {
  const days = [
    {
      employeeCode: 5, name: 'Angelica', department: 'Inspection', workDate: '2026-08-18',
      punchCount: 4, workedMinutes: 590, workday: true, needsReview: false, inProgress: false,
      punches: ['2026-08-18T07:10:00', '2026-08-18T12:00:00', '2026-08-18T13:00:00', '2026-08-18T18:00:00'],
    },
    {
      employeeCode: 5, name: 'Angelica', department: 'Inspection', workDate: '2026-08-19',
      punchCount: 3, workedMinutes: 600, workday: true, needsReview: true, inProgress: false,
      late: true, early: false, possibleEarlyWork: false, possibleOvertime: true,
      flags: ['needs_review', 'missing_lunch', 'late', 'possible_overtime'],
      punches: ['2026-08-19T07:00:00', '2026-08-19T12:00:00', '2026-08-19T13:00:00'],
    },
    {
      employeeCode: 6, name: 'Laura', department: 'Sewing', workDate: '2026-08-15',
      punchCount: 2, workedMinutes: 300, workday: true, needsReview: false, inProgress: false,
      late: true, early: false, possibleEarlyWork: false, possibleOvertime: false, flags: ['late'],
      punches: ['2026-08-15T07:00:00', '2026-08-15T12:00:00'],
    },
    {
      employeeCode: 7, name: 'Current Shift', department: 'Sewing', workDate: '2026-08-19',
      punchCount: 1, workedMinutes: null, workday: false, needsReview: false, inProgress: true,
      punches: ['2026-08-19T07:00:00'],
    },
  ]

  const workbook = buildAttendanceWorkbook(ExcelJS, { days, from: '2026-08-15', to: '2026-08-19' })
  assert.equal(workbook.worksheets.length, 1)
  const sheet = workbook.worksheets[0]
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['ID.', 'Nombre', 'Depart.', 'Punch Type', 'Tiempo', 'WH', 'Working Days', 'Status'])

  const reviewRow = sheet.getRow(6)
  assert.equal(reviewRow.getCell(4).value, 'Clock In')
  assert.equal(sheet.getRow(7).getCell(4).value, 'Unconfirmed Punch')
  assert.equal(sheet.getRow(8).getCell(4).value, 'Clock Out')
  assert.equal(reviewRow.getCell(6).value, 10)
  assert.equal(reviewRow.getCell(8).value, 'Needs Review · Missing Lunch Punches · Late · Possible Overtime')
  assert.equal(reviewRow.getCell(1).fill.fgColor.argb, 'FFFFC7CE')
  assert.equal(sheet.getRow(9).getCell(6).value, 19.83)
  assert.equal(sheet.getRow(9).getCell(7).value, 2)

  const saturdayTotal = sheet.getRow(12)
  assert.equal(sheet.getRow(10).getCell(8).value, 'Late')
  assert.equal(sheet.getRow(10).getCell(1).fill.fgColor.argb, 'FFFFEB9C')
  assert.equal(saturdayTotal.getCell(6).value, 5)
  assert.equal(saturdayTotal.getCell(7).value, 1)
  assert.equal(sheet.rowCount, 12)
})

test('attendance workbook lists employees without weekday punches as absent', () => {
  const workbook = buildAttendanceWorkbook(ExcelJS, {
    from: '2026-08-18',
    to: '2026-08-18',
    exportDates: ['2026-08-18', '2026-08-19'],
    employees: [
      { employeeCode: 5, name: 'Angelica', department: 'Inspection' },
      { employeeCode: 6, name: 'Laura', department: 'Sewing' },
    ],
    days: [
      {
        employeeCode: 5, name: 'Angelica', department: 'Inspection', workDate: '2026-08-18',
        punchCount: 2, workedMinutes: 600, workday: true, needsReview: false, inProgress: false,
        punches: ['2026-08-18T07:00:00', '2026-08-18T18:00:00'],
      },
      {
        employeeCode: 5, name: 'Angelica', department: 'Inspection', workDate: '2026-08-19',
        punchCount: 1, workedMinutes: null, workday: false, needsReview: false, inProgress: true,
        punches: ['2026-08-19T07:00:00'],
      },
    ],
  })

  const sheet = workbook.worksheets[0]
  const absentRow = sheet.getRow(5)
  assert.equal(absentRow.getCell(1).value, 6)
  assert.equal(absentRow.getCell(2).value, 'Laura')
  assert.equal(absentRow.getCell(3).value, 'Sewing')
  assert.equal(absentRow.getCell(4).value, 'Absent')
  assert.equal(absentRow.getCell(5).value, '18-08-2026')
  assert.equal(absentRow.getCell(6).value, 0)
  assert.equal(absentRow.getCell(7).value, null)
  assert.equal(absentRow.getCell(8).value, '08/18 Absent')
  assert.equal(absentRow.getCell(1).fill.fgColor.argb, 'FFFFC7CE')
  assert.equal(sheet.getRow(6).getCell(6).value, 0)
  assert.equal(sheet.getRow(6).getCell(7).value, 0)
  assert.equal(sheet.rowCount, 6)
})
