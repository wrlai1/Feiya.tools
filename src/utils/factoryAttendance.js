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
    const automaticallyValid = punchCount === 4
    const manuallyConfirmed = Boolean(review?.confirmed) && Number(review?.adjustedMinutes) >= 0
    let workedMinutes = null

    if (automaticallyValid) {
      workedMinutes = (
        timestampSeconds(day.punches[1]) - timestampSeconds(day.punches[0])
        + timestampSeconds(day.punches[3]) - timestampSeconds(day.punches[2])
      ) / 60
    } else if (manuallyConfirmed) {
      workedMinutes = Number(review.adjustedMinutes)
    }

    const schedule = daySchedule(day.workDate, settings)
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
      flags,
    }
  }).sort((a, b) => a.workDate.localeCompare(b.workDate) || a.employeeCode - b.employeeCode)
}

export function buildPayrollSummary(days, employees = [], settingsInput = {}) {
  const settings = { ...DEFAULT_ATTENDANCE_SETTINGS, ...settingsInput }
  const employeeMap = new Map(employees.map((employee) => [Number(employee.employeeCode ?? employee.employee_code), employee]))
  const grouped = new Map()

  for (const day of days || []) {
    if (!grouped.has(day.employeeCode)) grouped.set(day.employeeCode, [])
    grouped.get(day.employeeCode).push(day)
  }

  return [...grouped.entries()].map(([employeeCode, employeeDays]) => {
    const employee = employeeMap.get(employeeCode) || {}
    const workedDays = employeeDays.filter((day) => day.workday)
    const totalMinutes = workedDays.reduce((sum, day) => sum + Number(day.workedMinutes || 0), 0)
    const varianceMinutes = totalMinutes - Number(settings.payrollStandardMinutes)
    const overtimeMinutes = Math.max(varianceMinutes, 0)
    const shortfallMinutes = Math.max(-varianceMinutes, 0)
    const dailyPayment = employee.dailyPayment ?? employee.daily_payment
    const bonusEligible = Boolean(employee.bonusEligible ?? employee.bonus_eligible)
    const basicSalary = dailyPayment == null ? null : workedDays.length * Number(dailyPayment)
    const hoursAdjustment = varianceMinutes / 60 * Number(settings.hourlyAdjustmentRate)
    const bonus = bonusEligible ? Number(settings.fulltimeBonus) : 0

    return {
      employeeCode,
      name: employee.name || employeeDays[0]?.name || '',
      department: employee.department || employeeDays[0]?.department || '',
      workdays: workedDays.length,
      totalMinutes,
      overtimeMinutes,
      shortfallMinutes,
      varianceMinutes,
      lateDays: employeeDays.filter((day) => day.late).length,
      earlyDays: employeeDays.filter((day) => day.early).length,
      reviewDays: employeeDays.filter((day) => day.needsReview).length,
      dailyPayment: dailyPayment == null ? null : Number(dailyPayment),
      basicSalary,
      hoursAdjustment,
      bonus,
      estimatedPay: basicSalary == null ? null : basicSalary + hoursAdjustment + bonus,
    }
  }).sort((a, b) => a.employeeCode - b.employeeCode)
}

export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return 'Pending'
  const sign = Number(minutes) < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(Number(minutes)))
  return `${sign}${Math.floor(absolute / 60)}h ${absolute % 60}m`
}
