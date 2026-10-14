const DAY = 86400000
export const CARRIERS = { UPS: 100, GOFO: 100, USPS: 50, OTHER: 40 }
export const DEFAULT_SETTINGS = { employee_count: 3, employee_absent: 0, orders_per_hour: 35, hours_remaining: 5, weekly_threshold: 5, max_prep_days: 2 }
export const skuKey = row => JSON.stringify(['style', 'color', 'size'].map(field => String(row[field] ?? '').trim().toLowerCase()))
export const orderKey = row => JSON.stringify([row.store_id, row.platform, row.order_id])
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
export function businessDay(value = new Date()) {
  return dayFormatter.format(new Date(value))
}
function integer(value, name, min = 0) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`${name} must be a whole number >= ${min}`)
  return Number(value)
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${name} is required (max 200 characters)`)
  return value.trim()
}
function timestamp(value, name) {
  const result = text(value, name)
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${name} needs an ISO timestamp with timezone`)
  const datePart = result.slice(0, 10)
  if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart) throw new Error(`${name} has an invalid calendar date`)
  return result
}
export function normalizeOrders(rows) {
  if (!Array.isArray(rows) || rows.length > 50000) throw new Error('Import at most 50,000 order lines')
  const seen = new Set(), metadata = new Map()
  return rows.map((row, i) => {
    const r = Object.fromEntries(['order_id', 'store_id', 'platform', 'style', 'color', 'size', 'order_status', 'shipment_status'].map(field => [field, text(row[field], `Row ${i + 2}: ${field}`)]))
    r.carrier = text(row.carrier, 'carrier').toUpperCase()
    if (!(r.carrier in CARRIERS)) throw new Error('Carrier must be UPS, GOFO, USPS or OTHER')
    r.qty = integer(row.qty, 'qty', 1)
    r.order_date = timestamp(row.order_date, 'order_date')
    r.ship_deadline = timestamp(row.ship_deadline, 'ship_deadline')
    if (Date.parse(r.ship_deadline) < Date.parse(r.order_date)) throw new Error('ship_deadline cannot precede order_date')
    r.paid_time = row.paid_time ? timestamp(row.paid_time, 'paid_time') : ''
    r.tracking_number = String(row.tracking_number ?? '').trim()
    const key = orderKey(r), line = `${key}:${skuKey(r)}`
    if (seen.has(line)) throw new Error(`Duplicate order/SKU line at row ${i + 2}; consolidate its quantity first`)
    seen.add(line)
    const meta = JSON.stringify([r.carrier, Date.parse(r.order_date), Date.parse(r.ship_deadline), r.order_status.toLowerCase(), r.shipment_status.toLowerCase()])
    if (metadata.has(key) && metadata.get(key) !== meta) throw new Error(`Conflicting order information at row ${i + 2}`)
    metadata.set(key, meta)
    return r
  })
}
export function normalizeSales(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50000) throw new Error('Import 1–50,000 sales rows')
  const seen = new Set()
  return rows.map(row => {
    const date = text(row.date, 'date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid sales date')
    const result = { date, ...Object.fromEntries(['style', 'color', 'size'].map(field => [field, text(row[field], field)])), sold_qty: integer(row.sold_qty, 'sold_qty') }
    const key = `${date}:${skuKey(result)}`
    if (seen.has(key)) throw new Error('Duplicate sales date/SKU; consolidate daily sales across stores first')
    seen.add(key)
    return result
  })
}
export function normalizeSettings(value) {
  const result = {}
  if (!value || typeof value !== 'object') throw new Error('Settings are required')
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'hours_remaining') {
      const hours = value[key]
      if (!['string', 'number'].includes(typeof hours) || String(hours).trim() === '' || !Number.isFinite(Number(hours)) || Number(hours) < 0) throw new Error('hours_remaining must be a non-negative number')
      result[key] = Number(hours)
    } else result[key] = integer(value[key], key, key === 'max_prep_days' ? 1 : 0)
  }
  if (result.employee_absent > result.employee_count) throw new Error('Absent employees cannot exceed employee count')
  if (result.max_prep_days > 7 || result.hours_remaining > 24) throw new Error('Prep cap max 7 days; remaining hours max 24')
  return result
}
export function validateOverride(field, value) {
  if (!['ready_qty', 'forecast_qty', 'prep_target', 'priority', 'carrier_urgency', 'warehouse_location'].includes(field)) throw new Error('Unsupported override field')
  if (field === 'warehouse_location') return String(value ?? '').trim().slice(0, 200)
  if (value === null && field !== 'ready_qty') return null
  return integer(value, field)
}
const CLOSED = new Set(['shipped', 'delivered', 'cancelled', 'canceled', 'completed', 'refunded'])
export function calculateWarehouseAlerts({ orders = [], inventory = [], sales = [], overrides = {}, settings = DEFAULT_SETTINGS, now = new Date() } = {}) {
  const time = new Date(now).getTime(), day = businessDay(now), dayNumber = Date.parse(`${day}T00:00:00Z`) / DAY
  const groups = new Map(), pending = new Map()
  const group = row => {
    const key = skuKey(row)
    if (!groups.has(key)) groups.set(key, { key, style: row.style, color: row.color, size: row.size, physical_inventory: 0, inventory_known: false, UPS: 0, GOFO: 0, USPS: 0, OTHER: 0, risk: 'GREEN', riskRank: 0, today_sales: 0, sales3: 0, sales7: 0 })
    return groups.get(key)
  }
  for (const row of inventory) {
    const g = group(row)
    g.physical_inventory += Number(row.quantity ?? row.physical_inventory) || 0
    g.inventory_known = true
  }
  for (const row of sales) {
    const age = dayNumber - Date.parse(`${String(row.date).slice(0, 10)}T00:00:00Z`) / DAY
    if (!Number.isFinite(age) || age < 0 || age > 7) continue
    const g = group(row), qty = Number(row.sold_qty) || 0
    if (age === 0) g.today_sales += qty
    // Historical averages use completed days; today's partial sales drive spike detection.
    if (age >= 1 && age <= 3) g.sales3 += qty
    if (age >= 1 && age <= 7) g.sales7 += qty
  }
  for (const row of orders) {
    if (CLOSED.has(String(row.order_status).toLowerCase()) || CLOSED.has(String(row.shipment_status).toLowerCase())) continue
    const key = orderKey(row), hours = (Date.parse(row.ship_deadline) - time) / 3600000
    const age = Math.max(0, (time - Date.parse(row.order_date)) / DAY), urgent = ['UPS', 'GOFO'].includes(row.carrier)
    const overdue = hours < 0, dueToday = businessDay(row.ship_deadline) === day
    const deadlineScore = overdue ? 300 : hours <= 6 ? 200 : hours <= 12 ? 150 : hours <= 24 ? 100 : hours <= 48 ? 50 : 0
    const ageScore = age >= 3 ? 100 : age >= 2 ? 60 : age >= 1 ? 30 : 0
    const bufferScore = row.carrier === 'USPS' ? age > 2 ? 150 : age > 1 ? 70 : 0 : 0
    const override = overrides[`order:${key}`] || {}
    const priority_score = override.priority ?? ((override.carrier_urgency ?? CARRIERS[row.carrier] ?? 40) + deadlineScore + ageScore + bufferScore)
    if (!pending.has(key)) pending.set(key, { ...row, key, age, overdue, dueToday, priority_score, qty: 0 })
    pending.get(key).qty += row.qty
    const g = group(row)
    g[row.carrier] += row.qty
    // Overdue orders on every carrier must remain visible; USPS buffer never hides a breached deadline.
    const rank = overdue || (urgent && dueToday) ? 3 : urgent && hours <= 24 ? 2 : row.carrier === 'USPS' && age >= 1 ? 1 : 0
    if (rank > g.riskRank) { g.riskRank = rank; g.risk = ['GREEN', 'YELLOW', 'ORANGE', 'RED'][rank] }
  }
  const rows = [...groups.values()].map(g => {
    const override = overrides[`sku:${g.key}`] || {}, avg_3d = g.sales3 / 3, avg_7d = g.sales7 / 7
    const sales_spike = g.today_sales * 2 > g.sales3
    // Algebraically equivalent integer ratios avoid rounding an exact whole quantity up twice.
    const bufferedForecast = (49 * g.sales3 + 9 * g.sales7) / 175
    const forecast_qty = override.forecast_qty ?? Math.ceil(sales_spike ? Math.max(g.today_sales * 6 / 5, bufferedForecast) : bufferedForecast)
    const unshipped_qty = g.UPS + g.GOFO + g.USPS + g.OTHER, ready_qty = override.ready_qty ?? 0
    const usable_ready_qty = Math.min(ready_qty, Math.max(0, g.physical_inventory))
    const max_ready_target = unshipped_qty + forecast_qty * settings.max_prep_days
    const target_ready_qty = Math.min(override.prep_target ?? (unshipped_qty + forecast_qty), max_ready_target)
    const prep_needed = Math.max(0, target_ready_qty - usable_ready_qty)
    const shortage = Math.max(0, target_ready_qty - g.physical_inventory)
    const weekly_target = avg_7d >= settings.weekly_threshold ? Math.min(Math.max(0, g.physical_inventory), Math.ceil(avg_7d * 2.5)) : 0
    return { ...g, avg_3d, avg_7d, sales_spike, forecast_qty, unshipped_qty, ready_qty, usable_ready_qty, target_ready_qty, prep_needed, shortage, ready_invalid: ready_qty > Math.max(0, g.physical_inventory), warehouse_location: override.warehouse_location || '', urgent_demand: g.UPS + g.GOFO, buffered_demand: g.USPS, alert_level: prep_needed > 60 ? 'CRITICAL' : prep_needed > 30 ? 'HIGH' : prep_needed > 10 ? 'MEDIUM' : prep_needed > 0 ? 'LOW' : 'NONE', weekly_target, weekly_prep: Math.max(0, weekly_target - usable_ready_qty) }
  }).sort((a, b) => b.riskRank - a.riskRank || b.prep_needed - a.prep_needed || b.avg_7d - a.avg_7d)
  const orderRows = [...pending.values()].sort((a, b) => b.priority_score - a.priority_score || Date.parse(a.ship_deadline) - Date.parse(b.ship_deadline))
  const summary = { UPS: 0, GOFO: 0, USPS: 0, OTHER: 0, overdue: 0, due_today: 0, oldest_usps_age: 0 }
  for (const row of orderRows) {
    summary[row.carrier]++
    summary.overdue += Number(row.overdue)
    summary.due_today += Number(row.dueToday)
    if (row.carrier === 'USPS') summary.oldest_usps_age = Math.max(summary.oldest_usps_age, row.age)
  }
  const employees = Math.max(0, settings.employee_count - settings.employee_absent), hourly = employees * settings.orders_per_hour
  const capacity = Math.floor(hourly * settings.hours_remaining)
  const priority_remaining = orderRows.filter(row => ['UPS', 'GOFO'].includes(row.carrier) || row.overdue || row.dueToday || (row.carrier === 'USPS' && row.age > 1)).length
  const urgent_remaining = summary.UPS + summary.GOFO
  return { generated_at: new Date(now).toISOString(), business_day: day, summary, rows, orders: orderRows, capacity: { employees, estimated: capacity, priority_remaining, urgent_remaining, shortfall: Math.max(0, priority_remaining - capacity), critical: urgent_remaining > capacity, completion_hours: orderRows.length === 0 ? 0 : hourly ? orderRows.length / hourly : null } }
}
