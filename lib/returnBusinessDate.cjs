function newYorkDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
function returnBusinessDate(value, now = new Date()) {
  const day = String(value || '').trim() || newYorkDate(now)
  const parsed = new Date(`${day}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day || day > newYorkDate(now)) throw new Error('Return date must be a valid date on or before today (Eastern Time)')
  return day
}
module.exports = { newYorkDate, returnBusinessDate }
