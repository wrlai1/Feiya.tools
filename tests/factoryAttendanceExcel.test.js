import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import { buildPayrollSummary } from '../src/utils/factoryAttendance.js'
import { buildDailyAttendanceWorkbook, buildPayrollToDateWorkbook } from '../src/utils/factoryAttendanceExcel.js'

test('daily workbook lists absent employees and highlights exceptions', () => {
  const employees = [
    { employeeCode: 5, name: 'Angelica', department: 'Inspection' },
    { employeeCode: 6, name: 'Laura', department: 'Sewing' },
  ]
  const days = [{
    employeeCode: 5, name: 'Angelica', department: 'Inspection', workDate: '2026-08-18',
    firstPunch: '2026-08-18T07:10:00', lastPunch: '2026-08-18T18:00:00', punchCount: 4,
    workedMinutes: 590, late: true, early: false, needsReview: false, manuallyConfirmed: false,
    flags: ['late', 'below_standard'], punches: [], reviewNote: '',
  }]
  const workbook = buildDailyAttendanceWorkbook(ExcelJS, { days, employees, workDate: '2026-08-18' })
  const sheet = workbook.getWorksheet('Daily Attendance')
  assert.equal(sheet.rowCount, 4)
  assert.equal(sheet.getRow(3).getCell(11).value, 'Complete')
  assert.equal(sheet.getRow(4).getCell(11).value, 'Absent')
  assert.equal(sheet.getRow(4).getCell(1).fill.fgColor.argb, 'FFFFC7CE')
})

test('payroll workbook shows hourly basic pay and non-negative overtime pay', () => {
  const settings = {
    weekdayStandardMinutes: 600, payrollStandardMinutes: 5400,
    hourlyAdjustmentRate: 20, fulltimeBonus: 125,
  }
  const summary = buildPayrollSummary([{
    employeeCode: 5, name: 'Angelica', workday: true, workedMinutes: 89 * 60,
    late: false, early: false, needsReview: false,
  }], [{ employeeCode: 5, name: 'Angelica', dailyPayment: 107.37, bonusEligible: true }], settings)
  const workbook = buildPayrollToDateWorkbook(ExcelJS, { summary, settings, from: '2026-08-06', to: '2026-08-18' })
  const row = workbook.getWorksheet('Payroll to Date').getRow(4)
  assert.equal(row.getCell(12).value, 955.59)
  assert.equal(row.getCell(14).value, 0)
  assert.equal(row.getCell(16).value, 1080.59)
})
