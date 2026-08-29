function validDay(value) {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function performanceDateRangeFromFileName(name, fallbackDay) {
  const source = String(name || '')
  const dates = []
  const addDate = (year, month, day) => {
    const value = `${year}-${month}-${day}`
    if (validDay(value) && !dates.includes(value)) dates.push(value)
  }
  for (const match of source.matchAll(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/g)) addDate(match[1], match[2], match[3])
  for (const match of source.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) addDate(match[1], match[2], match[3])
  for (const match of source.matchAll(/(?<!\d)(\d{2})[-_.](\d{2})[-_.](20\d{2})(?!\d)/g)) addDate(match[3], match[1], match[2])
  if (dates.length >= 2) return { start: dates.at(-2), end: dates.at(-1), detected: true }
  if (dates.length === 1) return { start: dates[0], end: dates[0], detected: true }
  return { start: fallbackDay, end: fallbackDay, detected: false }
}

export function groupPerformanceReportsByDay(reports) {
  const dayMap = new Map()
  for (const report of reports || []) {
    const day = report.end || report.start
    if (!dayMap.has(day)) dayMap.set(day, { day, rows: [], fileNames: [] })
    const entry = dayMap.get(day)
    entry.rows.push(...(report.rows || []))
    entry.fileNames.push(report.fileName)
  }
  return [...dayMap.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((entry) => ({ ...entry, fileName: entry.fileNames.join(', ') }))
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
