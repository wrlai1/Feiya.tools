import { attendancePunchLabel } from './factoryAttendance.js'

const COLORS = {
  total: 'FFDDEBF7', review: 'FFFFC7CE', warning: 'FFFFEB9C', dark: 'FF1F2937',
}

function displayTimestamp(value) {
  const timestamp = String(value || '')
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}     ${match[4]}` : timestamp.replace('T', ' ')
}

function displayDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : String(value || '')
}

function displayMonthDay(value) {
  const match = String(value || '').match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${match[1]}/${match[2]}` : String(value || '')
}

function isWeekday(value) {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

function isAttendanceDay(day) {
  return Boolean(day.workday) && !day.inProgress
}

function attendanceStatus(day) {
  const labels = []
  if (day.needsReview) labels.push('Needs Review')
  if (day.flags?.includes('missing_lunch')) labels.push('Missing Lunch Punches')
  if (day.late) labels.push('Late')
  if (day.early) labels.push('Early')
  if (day.possibleEarlyWork) labels.push('Possible Early Work')
  if (day.possibleOvertime) labels.push('Possible Overtime')
  return labels.join(' · ')
}

export function buildAttendanceWorkbook(ExcelJS, { days, employees: employeeList = [], exportDates = [], from, to }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Feiya Factory Attendance'
  const sheet = workbook.addWorksheet(`${from.slice(5)}-${to.slice(5)}`.slice(0, 31))
  const header = sheet.addRow(['ID.', 'Nombre', 'Depart.', 'Punch Type', 'Tiempo', 'WH', 'Working Days', 'Status'])
  header.font = { bold: true, color: { argb: COLORS.dark } }
  header.alignment = { horizontal: 'center' }

  const employees = new Map((employeeList || []).map((employee) => [
    Number(employee.employeeCode ?? employee.employee_code),
    { profile: employee, days: [] },
  ]))
  const presentDays = new Set((days || []).map((day) => `${day.employeeCode}|${day.workDate}`))
  for (const day of (days || []).filter((item) => !item.inProgress)) {
    if (!employees.has(day.employeeCode)) employees.set(day.employeeCode, { profile: day, days: [] })
    employees.get(day.employeeCode).days.push(day)
  }
  const inProgressDates = new Set((days || []).filter((day) => day.inProgress).map((day) => day.workDate))
  const attendanceDates = [...new Set(exportDates || [])]
    .filter((date) => isWeekday(date) && !inProgressDates.has(date))
    .sort()
  for (const [employeeCode, employee] of employees) {
    for (const workDate of attendanceDates) {
      if (presentDays.has(`${employeeCode}|${workDate}`)) continue
      employee.days.push({
        employeeCode,
        name: employee.profile.name || '',
        department: employee.profile.department || '',
        workDate,
        absent: true,
      })
    }
  }

  for (const [employeeCode, employee] of [...employees.entries()].sort((a, b) => a[0] - b[0])) {
    const employeeDays = employee.days
    const orderedDays = [...employeeDays].sort((a, b) => a.workDate.localeCompare(b.workDate))
    let totalMinutes = 0
    let workingDays = 0
    for (const day of orderedDays) {
      if (day.absent) {
        const row = sheet.addRow([
          employeeCode, day.name, day.department, 'Absent', displayDate(day.workDate), 0, null,
          `${displayMonthDay(day.workDate)} Absent`,
        ])
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.review } }
        })
        continue
      }
      if (isAttendanceDay(day)) workingDays += 1
      if (day.workedMinutes != null) totalMinutes += Number(day.workedMinutes)
      const punches = day.punches?.length ? day.punches : [day.firstPunch].filter(Boolean)
      punches.forEach((punch, index) => {
        const row = sheet.addRow([
          employeeCode, day.name, day.department, attendancePunchLabel(day, index), displayTimestamp(punch),
          index === 0 && day.workedMinutes != null ? Number((day.workedMinutes / 60).toFixed(2)) : null,
          null,
          index === 0 ? attendanceStatus(day) || null : null,
        ])
        if (day.needsReview) {
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.review } }
          })
        } else if (day.late || day.early) {
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warning } }
          })
        }
      })
    }
    const totalRow = sheet.addRow([null, null, 'Total', null, null, Number((totalMinutes / 60).toFixed(2)), workingDays, null])
    totalRow.font = { bold: true }
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.total } }
    })
  }

  sheet.columns = [10, 28, 23, 20, 25, 16, 16, 52].map((width) => ({ width }))
  sheet.getColumn(6).numFmt = '0.00'
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: 'A1', to: 'H1' }
  return workbook
}
