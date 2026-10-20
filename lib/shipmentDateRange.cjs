function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
}
function shipmentDateRange(from, to) {
  if (!validDay(from) || !validDay(to)) throw new Error('Choose valid start and end dates')
  if (from > to) throw new Error('Start date must not be after end date')
  return { from, to }
}
module.exports = { shipmentDateRange }
