function validDay(value) {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function performanceDateRangeFromFileName(name, fallbackDay) {
  const source = String(name || '')
  const dates = []
  const addDate = (year, month, day, index) => {
    const value = `${year}-${month}-${day}`
    if (validDay(value)) dates.push({ value, index })
  }
  for (const match of source.matchAll(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/g)) addDate(match[1], match[2], match[3], match.index)
  for (const match of source.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) addDate(match[1], match[2], match[3], match.index)
  for (const match of source.matchAll(/(?<!\d)(\d{2})[-_.](\d{2})[-_.](20\d{2})(?!\d)/g)) addDate(match[3], match[1], match[2], match.index)
  dates.sort((left, right) => left.index - right.index)
  if (dates.length >= 2) return { start: dates.at(-2).value, end: dates.at(-1).value, detected: true }
  if (dates.length === 1) return { start: dates[0].value, end: dates[0].value, detected: true }
  return { start: fallbackDay, end: fallbackDay, detected: false }
}

export function groupPerformanceReportsByDay(reports) {
  const entryMap = new Map()
  for (const report of reports || []) {
    const periodStart = report.start || report.end
    const periodEnd = report.end || report.start
    const kind = periodStart === periodEnd ? 'daily' : 'period'
    const key = `${kind}|${periodStart}|${periodEnd}`
    if (!entryMap.has(key)) {
      entryMap.set(key, {
        day: periodEnd,
        periodStart,
        periodEnd,
        kind,
        rows: [],
        fileNames: [],
      })
    }
    const entry = entryMap.get(key)
    entry.rows.push(...(report.rows || []))
    entry.fileNames.push(report.fileName)
  }
  return [...entryMap.values()]
    .sort((left, right) => left.periodStart.localeCompare(right.periodStart) || left.periodEnd.localeCompare(right.periodEnd))
    .map((entry) => ({ ...entry, fileName: entry.fileNames.join(', ') }))
}

export function isAggregatePeriod(value) {
  const start = String(value?.periodStart || '')
  const end = String(value?.periodEnd || '')
  return Boolean(value?.dataKind === 'period' || value?.kind === 'period' || (start && end && start !== end))
}

export function dailyAnalyticsRows(rows) {
  return (rows || []).filter((row) => !isAggregatePeriod(row))
}

export function analyticsCoverageDays(savedDays, periods, from, to) {
  const daily = new Set((savedDays || []).map((item) => item.day).filter(Boolean))
  const period = new Set()
  for (const item of periods || []) {
    let day = item.periodStart
    const end = item.periodEnd
    while (day && end && day <= end) {
      if ((!from || day >= from) && (!to || day <= to) && !daily.has(day)) period.add(day)
      const date = new Date(`${day}T00:00:00Z`)
      date.setUTCDate(date.getUTCDate() + 1)
      day = date.toISOString().slice(0, 10)
    }
  }
  return { daily, period, covered: new Set([...daily, ...period]) }
}

export function findAnalyticsOverlaps(entries, savedDays, periods) {
  const dailyDays = new Set((savedDays || []).map((item) => item.day).filter(Boolean))
  const existingPeriods = periods || []
  return (entries || []).filter((entry) => {
    const start = entry.periodStart || entry.day
    const end = entry.periodEnd || entry.day
    if ([...dailyDays].some((day) => day >= start && day <= end)) return true
    return existingPeriods.some((period) => period.periodStart <= end && period.periodEnd >= start)
  })
}

export function chunkAnalyticsDays(days, maxBytes = 2_500_000) {
  const chunks = []
  let current = []
  let currentBytes = 2
  for (const day of days || []) {
    const bytes = new TextEncoder().encode(JSON.stringify(day)).length + 1
    if (current.length && currentBytes + bytes > maxBytes) {
      chunks.push(current)
      current = []
      currentBytes = 2
    }
    current.push(day)
    currentBytes += bytes
  }
  if (current.length) chunks.push(current)
  return chunks
}
