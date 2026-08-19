const DEFAULT_TIMEZONE = 'America/Guatemala'

export const DEFAULT_ATTENDANCE_SETTINGS = {
  timezone: DEFAULT_TIMEZONE,
  weekdayStart: '07:00',
  weekdayEnd: '18:00',
  weekdayStandardMinutes: 600,
  saturdayStart: '07:00',
  saturdayEnd: '12:00',
  saturdayStandardMinutes: 300,
  payrollStandardMinutes: 5400,
  hourlyAdjustmentRate: 20,
  fulltimeDailyRate: 107.37,
  fulltimeBonus: 125,
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function canonicalTimestamp(raw) {
  const match = String(raw || '').trim().match(
    /^(\d{2})([-/])(\d{2})\2(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  )
  if (!match) return null

  const [, first, separator, second, year, hour, minute, seconds] = match
  const month = separator === '/' ? Number(first) : Number(second)
  const day = separator === '/' ? Number(second) : Number(first)
  const parts = [Number(year), month, day, Number(hour), Number(minute), Number(seconds)]
  if (
    month < 1 || month > 12 || day < 1 || day > 31
    || parts.slice(3).some((part, index) => part < 0 || part > (index === 0 ? 23 : 59))
  ) return null

  const check = new Date(Date.UTC(parts[0], month - 1, day))
  if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  return `${parts[0]}-${pad(month)}-${pad(day)}T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5])}`
}

export function parseAttendanceText(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) throw new Error('The attendance file is empty')

  const header = lines[0].split('\t').map((value) => value.trim().toLowerCase())
  if (header.length < 5 || !header[0].startsWith('id') || !header[1].includes('nombre')) {
    throw new Error('Unsupported attendance TXT format')
  }

  const records = []
  const errors = []
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split('\t')
    const employeeCode = Number.parseInt(columns[0], 10)
    const punchedAt = canonicalTimestamp(columns[3])
    if (!Number.isSafeInteger(employeeCode) || employeeCode <= 0 || !punchedAt) {
      errors.push(index + 1)
      continue
    }
    records.push({
      employeeCode,
      name: String(columns[1] || '').trim(),
      department: String(columns[2] || '').trim(),
      punchedAt,
      rawTimestamp: String(columns[3] || '').trim(),
      deviceId: Number.parseInt(columns[4], 10) || 0,
    })
  }

  if (!records.length) throw new Error('No valid attendance records were found')
  if (errors.length) throw new Error(`Invalid attendance data on line${errors.length === 1 ? '' : 's'} ${errors.join(', ')}`)
  return records
}

export function parseAttendanceFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 3) {
    throw new Error('Select between one and three attendance TXT files')
  }
  return files.flatMap((file) => parseAttendanceText(file.content).map((record) => ({
    ...record,
    sourceFile: file.fileName,
  })))
}

export function attendanceRecordKey(record) {
  return [
    Number(record.employeeCode ?? record.employee_code),
    String(record.punchedAt ?? record.punched_at ?? '').replace(' ', 'T').slice(0, 19),
  ].join('|')
}

export function partitionAttendanceDuplicates(records, existingKeys = new Set()) {
  const accepted = []
  const duplicates = []
  const seen = new Set()

  for (const record of records || []) {
    const key = attendanceRecordKey(record)
    const reason = existingKeys.has(key) ? 'already_uploaded' : seen.has(key) ? 'repeated_in_file' : null
    if (reason) {
      duplicates.push({
        employeeCode: Number(record.employeeCode ?? record.employee_code),
        name: record.name || '',
        punchedAt: String(record.punchedAt ?? record.punched_at ?? '').replace(' ', 'T').slice(0, 19),
        deviceId: Number(record.deviceId ?? record.device_id ?? 0),
        sourceFile: record.sourceFile || '',
        reason,
      })
    } else {
      accepted.push(record)
      seen.add(key)
    }
  }
  return { accepted, duplicates }
}

export function payrollRangeForDate(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw new Error('Date must use YYYY-MM-DD')
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  const format = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

  if (day >= 6 && day <= 20) {
    return {
      start: format(new Date(Date.UTC(year, monthIndex, 6))),
      end: format(new Date(Date.UTC(year, monthIndex, 20))),
    }
  }
  if (day >= 21) {
    return {
      start: format(new Date(Date.UTC(year, monthIndex, 21))),
      end: format(new Date(Date.UTC(year, monthIndex + 1, 5))),
    }
  }
  return {
    start: format(new Date(Date.UTC(year, monthIndex - 1, 21))),
    end: format(new Date(Date.UTC(year, monthIndex, 5))),
  }
}

export function payrollRangesBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to)) || from > to) {
    throw new Error('Valid date range required')
  }
  const ranges = []
  let cursor = from
  while (cursor <= to) {
    const payroll = payrollRangeForDate(cursor)
    const end = payroll.end < to ? payroll.end : to
    ranges.push({ start: cursor, end, payrollStart: payroll.start, payrollEnd: payroll.end, provisional: cursor > payroll.start || end < payroll.end })
    const next = new Date(`${end}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    cursor = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
  }
  return ranges
}

function timeToSeconds(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0)
}

function timestampSeconds(value) {
  return timeToSeconds(String(value).slice(11, 19))
}

function daySchedule(date, settings) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  if (weekday === 0) return { start: null, end: null, standardMinutes: 0 }
  if (weekday === 6) {
    return {
      start: settings.saturdayStart,
      end: settings.saturdayEnd,
      standardMinutes: Number(settings.saturdayStandardMinutes),
    }
  }
  return {
    start: settings.weekdayStart,
    end: settings.weekdayEnd,
    standardMinutes: Number(settings.weekdayStandardMinutes),
  }
}

export function calculateAttendanceDays(punches, settingsInput = {}, reviews = []) {
  const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, ...settingsInput }
  const reviewMap = new Map(reviews.map((review) => [`${review.employeeCode}|${review.workDate}`, review]))
  const groups = new Map()

  for (const punch of punches || []) {
    const employeeCode = Number(punch.employeeCode ?? punch.employee_code)
    const punchedAt = String(punch.punchedAt ?? punch.punched_at ?? '').replace(' ', 'T').slice(0, 19)
    const workDate = punchedAt.slice(0, 10)
    if (!employeeCode || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) continue
    const key = `${employeeCode}|${workDate}`
    if (!groups.has(key)) {
      groups.set(key, {
        employeeCode,
        name: punch.name,
        department: punch.department,
        workDate,
        punches: [],
      })
    }
    groups.get(key).punches.push(punchedAt)
  }

  return [...groups.values()].map((day) => {
    day.punches.sort()
    const review = reviewMap.get(`${day.employeeCode}|${day.workDate}`)
    const punchCount = day.punches.length
    const schedule = daySchedule(day.workDate, settings)
    const isSaturday = new Date(`${day.workDate}T00:00:00Z`).getUTCDay() === 6
    const automaticallyValid = punchCount === 4 || (isSaturday && punchCount === 2)
    const manuallyConfirmed = Boolean(review?.confirmed) && Number(review?.adjustedMinutes) >= 0
    let workedMinutes = null

    if (automaticallyValid) {
      workedMinutes = 0
      for (let index = 0; index < day.punches.length; index += 2) {
        workedMinutes += (timestampSeconds(day.punches[index + 1]) - timestampSeconds(day.punches[index])) / 60
      }
    } else if (manuallyConfirmed) {
      workedMinutes = Number(review.adjustedMinutes)
    }

    const firstSeconds = timestampSeconds(day.punches[0])
    const lastSeconds = timestampSeconds(day.punches.at(-1))
    const possibleLate = schedule.start != null && firstSeconds > timeToSeconds(schedule.start)
    const possibleEarly = schedule.end != null && lastSeconds < timeToSeconds(schedule.end)
    const late = automaticallyValid ? possibleLate : manuallyConfirmed ? Boolean(review?.late) : false
    const early = automaticallyValid ? possibleEarly : manuallyConfirmed ? Boolean(review?.early) : false
    const belowStandard = workedMinutes != null && schedule.standardMinutes > 0 && workedMinutes < schedule.standardMinutes
    const flags = []
    if (!automaticallyValid && !manuallyConfirmed) flags.push('needs_review')
    if (late) flags.push('late')
    if (early) flags.push('early')
    if (belowStandard) flags.push('below_standard')

    return {
      ...day,
      firstPunch: day.punches[0],
      lastPunch: day.punches.at(-1),
      punchCount,
      workedMinutes,
      standardMinutes: schedule.standardMinutes,
      workday: workedMinutes != null,
      late,
      early,
      possibleLate,
      possibleEarly,
      belowStandard,
      needsReview: !automaticallyValid && !manuallyConfirmed,
      reviewNote: review?.note || '',
      manuallyConfirmed,
      reviewedBy: review?.updatedBy || '',
      reviewedAt: review?.updatedAt || null,
      flags,
    }
  }).sort((a, b) => a.workDate.localeCompare(b.workDate) || a.employeeCode - b.employeeCode)
}

export function buildPayrollSummary(days, employees = [], settingsInput = {}) {
  const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, ...settingsInput }
  const employeeMap = new Map(employees.map((employee) => [Number(employee.employeeCode ?? employee.employee_code), employee]))
  const grouped = new Map([...employeeMap.keys()].map((employeeCode) => [employeeCode, []]))

  for (const day of days || []) {
    if (!grouped.has(day.employeeCode)) grouped.set(day.employeeCode, [])
    grouped.get(day.employeeCode).push(day)
  }

  return [...grouped.entries()].map(([employeeCode, employeeDays]) => {
    const employee = employeeMap.get(employeeCode) || {}
    const workedDays = employeeDays.filter((day) => day.workday)
    const totalMinutes = workedDays.reduce((sum, day) => sum + Number(day.workedMinutes || 0), 0)
    const overtimeMinutes = Math.max(totalMinutes - Number(settings.payrollStandardMinutes), 0)
    const shortfallMinutes = Math.max(Number(settings.payrollStandardMinutes) - totalMinutes, 0)
    const dailyPayment = employee.dailyPayment ?? employee.daily_payment
    const bonusEligible = Boolean(employee.bonusEligible ?? employee.bonus_eligible)
    const normalHourlyRate = dailyPayment == null || Number(settings.weekdayStandardMinutes) <= 0
      ? null
      : Number(dailyPayment) / (Number(settings.weekdayStandardMinutes) / 60)
    const basicSalary = normalHourlyRate == null ? null : totalMinutes / 60 * normalHourlyRate
    const overtimePay = overtimeMinutes / 60 * Number(settings.hourlyAdjustmentRate)
    const bonus = bonusEligible ? Number(settings.fulltimeBonus) : 0

    return {
      employeeCode,
      name: employee.name || employeeDays[0]?.name || '',
      department: employee.department || employeeDays[0]?.department || '',
      workdays: workedDays.length,
      totalMinutes,
      overtimeMinutes,
      shortfallMinutes,
      lateDays: employeeDays.filter((day) => day.late).length,
      earlyDays: employeeDays.filter((day) => day.early).length,
      reviewDays: employeeDays.filter((day) => day.needsReview).length,
      dailyPayment: dailyPayment == null ? null : Number(dailyPayment),
      normalHourlyRate,
      basicSalary,
      overtimePay,
      bonus,
      estimatedPay: basicSalary == null ? null : basicSalary + overtimePay + bonus,
    }
  }).sort((a, b) => a.employeeCode - b.employeeCode)
}

export function buildAttendanceSummary(days, employees = []) {
  const employeeMap = new Map(employees.map((employee) => [Number(employee.employeeCode ?? employee.employee_code), employee]))
  const grouped = new Map([...employeeMap.keys()].map((employeeCode) => [employeeCode, []]))

  for (const day of days || []) {
    if (!grouped.has(day.employeeCode)) grouped.set(day.employeeCode, [])
    grouped.get(day.employeeCode).push(day)
  }

  return [...grouped.entries()].map(([employeeCode, employeeDays]) => {
    const employee = employeeMap.get(employeeCode) || {}
    const attendanceDays = employeeDays.filter((day) => (
      new Date(`${day.workDate}T00:00:00Z`).getUTCDay() !== 0 && Number(day.punchCount) >= 2
    )).length
    const confirmedDays = employeeDays.filter((day) => day.workday)
    return {
      employeeCode,
      name: employee.name || employeeDays[0]?.name || '',
      department: employee.department || employeeDays[0]?.department || '',
      attendanceDays,
      workdays: confirmedDays.length,
      totalMinutes: confirmedDays.reduce((sum, day) => sum + Number(day.workedMinutes || 0), 0),
      lateDays: employeeDays.filter((day) => day.late).length,
      earlyDays: employeeDays.filter((day) => day.early).length,
      reviewDays: employeeDays.filter((day) => day.needsReview).length,
    }
  }).sort((a, b) => a.employeeCode - b.employeeCode)
}

export function buildDailyRoster(days, employees = [], workDate) {
  const dayMap = new Map((days || [])
    .filter((day) => day.workDate === workDate)
    .map((day) => [Number(day.employeeCode), day]))

  return employees.map((employee) => {
    const employeeCode = Number(employee.employeeCode ?? employee.employee_code)
    const day = dayMap.get(employeeCode)
    if (day) return { ...day, name: employee.name || day.name, department: employee.department || day.department }
    return {
      employeeCode,
      name: employee.name || '',
      department: employee.department || '',
      workDate,
      punches: [],
      firstPunch: null,
      lastPunch: null,
      punchCount: 0,
      workedMinutes: 0,
      workday: false,
      late: false,
      early: false,
      needsReview: false,
      manuallyConfirmed: false,
      reviewNote: '',
      flags: ['absent'],
      absent: true,
    }
  }).sort((a, b) => a.employeeCode - b.employeeCode)
}

export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return 'Pending'
  const sign = Number(minutes) < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(Number(minutes)))
  return `${sign}${Math.floor(absolute / 60)}h ${absolute % 60}m`
}
