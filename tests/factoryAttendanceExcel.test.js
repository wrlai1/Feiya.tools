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
      punches: ['2026-08-19T07:00:00', '2026-08-19T12:00:00', '2026-08-19T13:00:00'],
    },
    {
      employeeCode: 6, name: 'Laura', department: 'Sewing', workDate: '2026-08-15',
      punchCount: 2, workedMinutes: 300, workday: true, needsReview: false, inProgress: false,
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
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['ID.', 'Nombre', 'Depart.', 'Tiempo', 'WH', 'Working Days', 'Status'])

  const reviewRow = sheet.getRow(6)
  assert.equal(reviewRow.getCell(5).value, 10)
  assert.equal(reviewRow.getCell(7).value, 'Needs Review')
  assert.equal(reviewRow.getCell(1).fill.fgColor.argb, 'FFFFC7CE')
  assert.equal(sheet.getRow(9).getCell(5).value, 19.83)
  assert.equal(sheet.getRow(9).getCell(6).value, 2)

  const saturdayTotal = sheet.getRow(12)
  assert.equal(saturdayTotal.getCell(5).value, 5)
  assert.equal(saturdayTotal.getCell(6).value, 1)
  assert.equal(sheet.rowCount, 12)
})
