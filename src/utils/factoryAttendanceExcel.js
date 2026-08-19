import { buildDailyRoster } from './factoryAttendance.js'

const COLORS = {
  header: 'FF1E3A5F', red: 'FFFFC7CE', yellow: 'FFFFEB9C', blue: 'FFDDEBF7', white: 'FFFFFFFF',
}

function payrollCode(value) {
  return `WSL${String(value).padStart(3, '0')}`
}

function timeOnly(value) {
  return value ? String(value).slice(11, 16) : '—'
}

function styleWorksheet(sheet, headerRow, rowColor) {
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } }
  })
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }]
  sheet.autoFilter = { from: headerRow.getCell(1).address, to: headerRow.getCell(headerRow.cellCount).address }
  sheet.eachRow((row) => {
    if (row.number <= headerRow.number) return
    const color = rowColor?.(row.values)
    if (color) row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }
    })
  })
}

export function buildDailyAttendanceWorkbook(ExcelJS, { days, employees, workDate }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Feiya Factory Attendance'
  const sheet = workbook.addWorksheet('Daily Attendance')
  const title = sheet.addRow([`Daily Attendance — ${workDate}`])
  sheet.mergeCells(title.number, 1, title.number, 13)
  title.getCell(1).font = { bold: true, size: 14, color: { argb: COLORS.header } }
  const header = sheet.addRow(['Code', 'Employee ID', 'Name', 'Department', 'First Punch', 'Last Punch', 'Punches', 'Worked Hours', 'Late', 'Early', 'Status', 'Flags', 'Note'])

  for (const day of buildDailyRoster(days, employees, workDate)) {
    const status = day.absent ? 'Absent' : day.needsReview ? 'Needs Review' : day.manuallyConfirmed ? 'Confirmed' : 'Complete'
    sheet.addRow([
      payrollCode(day.employeeCode), day.employeeCode, day.name, day.department,
      timeOnly(day.firstPunch), timeOnly(day.lastPunch), day.punchCount,
      day.needsReview ? null : Number((Number(day.workedMinutes || 0) / 60).toFixed(2)),
      day.late ? 'Yes' : 'No', day.early ? 'Yes' : 'No', status,
      (day.flags || []).join(', '), day.reviewNote || '—',
    ])
  }
  sheet.columns = [12, 12, 25, 20, 12, 12, 10, 14, 9, 9, 16, 24, 30].map((width) => ({ width }))
  sheet.getColumn(8).numFmt = '0.00'
  styleWorksheet(sheet, header, (values) => {
    if (values[11] === 'Absent' || values[11] === 'Needs Review') return COLORS.red
    if (values[9] === 'Yes' || values[10] === 'Yes') return COLORS.yellow
    if (values[11] === 'Confirmed') return COLORS.blue
    return null
  })
  return workbook
}

export function buildPayrollToDateWorkbook(ExcelJS, { summary, settings, from, to }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Feiya Factory Attendance'
  const sheet = workbook.addWorksheet('Payroll to Date')
  const title = sheet.addRow([`Payroll to Date — ${from} to ${to}`])
  sheet.mergeCells(title.number, 1, title.number, 16)
  title.getCell(1).font = { bold: true, size: 14, color: { argb: COLORS.header } }
  const note = sheet.addRow([`Normal hourly rate = Daily Payment ÷ ${Number(settings.weekdayStandardMinutes) / 60}; overtime above ${Number(settings.payrollStandardMinutes) / 60} hours = Q${Number(settings.hourlyAdjustmentRate).toFixed(2)}/hour. Unconfirmed days are excluded.`])
  sheet.mergeCells(note.number, 1, note.number, 16)
  note.getCell(1).font = { italic: true, color: { argb: 'FF64748B' } }
  const header = sheet.addRow(['Code', 'Employee ID', 'Name', 'Department', 'Work Days', 'Total Hours', 'Needs Review', 'Late', 'Early', 'Daily Payment (Q)', 'Normal Hourly Rate (Q)', 'Basic Pay (Q)', 'Overtime Hours', 'Overtime Pay (Q)', 'Bonus (Q)', 'Pay to Date (Q)'])

  for (const row of summary) sheet.addRow([
    payrollCode(row.employeeCode), row.employeeCode, row.name, row.department, row.workdays,
    Number((row.totalMinutes / 60).toFixed(2)), row.reviewDays, row.lateDays, row.earlyDays,
    row.dailyPayment, row.normalHourlyRate == null ? null : Number(row.normalHourlyRate.toFixed(4)),
    row.basicSalary == null ? null : Number(row.basicSalary.toFixed(2)),
    Number((row.overtimeMinutes / 60).toFixed(2)), Number(row.overtimePay.toFixed(2)), row.bonus,
    row.estimatedPay == null ? null : Number(row.estimatedPay.toFixed(2)),
  ])
  sheet.columns = [12, 12, 25, 20, 11, 12, 14, 8, 8, 18, 23, 16, 16, 18, 14, 17].map((width) => ({ width }))
  for (const index of [10, 11, 12, 14, 15, 16]) sheet.getColumn(index).numFmt = '"Q"#,##0.00'
  sheet.getColumn(6).numFmt = '0.00'
  sheet.getColumn(13).numFmt = '0.00'
  styleWorksheet(sheet, header, (values) => values[10] == null ? COLORS.red : Number(values[7]) > 0 ? COLORS.yellow : null)
  return workbook
}
