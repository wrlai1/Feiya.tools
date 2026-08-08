export function validBusinessDay(value) {
  const day = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const [year, month, date] = day.split('-').map(Number)
  const checked = new Date(Date.UTC(year, month - 1, date))
  return year >= 1900
    && year <= 9999
    && checked.getUTCFullYear() === year
    && checked.getUTCMonth() === month - 1
    && checked.getUTCDate() === date
    ? day
    : ''
}

export function businessDayFromFilename(filename) {
  const name = String(filename || '').trim()
  const tokens = [...name.matchAll(/(?:^|\D)(\d{8})(?=\D|$)/g)].map((match) => match[1])
  const parsedTokens = tokens.map((token) => {
    const day = `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
    return validBusinessDay(day)
  })
  if (parsedTokens.some((day) => !day)) return { day: '', status: 'invalid' }
  const days = [...new Set(parsedTokens)]

  if (days.length === 1) return { day: days[0], status: 'parsed' }
  if (days.length > 1) return { day: '', status: 'ambiguous' }
  return { day: '', status: 'missing' }
}
