const COLORS = {
  total: 'FFDDEBF7', review: 'FFFFC7CE', dark: 'FF1F2937',
}

function displayTimestamp(value) {
  const timestamp = String(value || '')
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}     ${match[4]}` : timestamp.replace('T', ' ')
}

function isAttendanceDay(day) {
  return new Date(`${day.workDate}T00:00:00Z`).getUTCDay() !== 0 && Number(day.punchCount) >= 2
}

export function buildAttendanceWorkbook(ExcelJS, { days, from, to }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Feiya Factory Attendance'
  const sheet = workbook.addWorksheet(`${from.slice(5)}-${to.slice(5)}`.slice(0, 31))
  const header = sheet.addRow(['ID.', 'Nombre', 'Depart.', 'Tiempo', 'WH', 'Working Days'])
  header.font = { bold: true, color: { argb: COLORS.dark } }
  header.alignment = { horizontal: 'center' }

  const employees = new Map()
  for (const day of days || []) {
    if (!employees.has(day.employeeCode)) employees.set(day.employeeCode, [])
    employees.get(day.employeeCode).push(day)
  }

  for (const [employeeCode, employeeDays] of [...employees.entries()].sort((a, b) => a[0] - b[0])) {
    const orderedDays = [...employeeDays].sort((a, b) => a.workDate.localeCompare(b.workDate))
    let totalMinutes = 0
    let workingDays = 0
    for (const day of orderedDays) {
      if (isAttendanceDay(day)) workingDays += 1
      if (day.workedMinutes != null) totalMinutes += Number(day.workedMinutes)
      const punches = day.punches?.length ? day.punches : [day.firstPunch].filter(Boolean)
      punches.forEach((punch, index) => {
        const row = sheet.addRow([
          employeeCode, day.name, day.department, displayTimestamp(punch),
          index === 0 ? (day.needsReview ? 'Needs Review' : day.workedMinutes == null ? null : Number((day.workedMinutes / 60).toFixed(2))) : null,
          null,
        ])
        if (day.needsReview) {
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.review } }
          })
        }
      })
    }
    const totalRow = sheet.addRow([null, null, 'Total', null, Number((totalMinutes / 60).toFixed(2)), workingDays])
    totalRow.font = { bold: true }
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.total } }
    })
  }

  sheet.columns = [10, 28, 23, 25, 16, 16].map((width) => ({ width }))
  sheet.getColumn(5).numFmt = '0.00'
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: 'A1', to: 'F1' }
  return workbook
}
