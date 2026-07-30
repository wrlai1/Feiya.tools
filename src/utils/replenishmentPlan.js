const DAY_MS = 86400000

function normalizedPart(value) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function wholeNumber(value, fallback, minimum = 0, maximum = 3650) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(number)))
}

function dayKey(value) {
  const text = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function dayNumber(value) {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / DAY_MS
}

function todayKey(value) {
  if (typeof value === 'string' && dayKey(value)) return dayKey(value)
  const date = new Date(value ?? Date.now())
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function replenishmentSkuKey(row) {
  return [
    normalizedPart(row?.Style ?? row?.style),
    normalizedPart(row?.Color ?? row?.color),
    normalizedPart(row?.Size ?? row?.size).replace(/^([123])xl$/, '$1x'),
  ].join('\u241f')
}

export function calculateReplenishmentPlan({
  inventoryRows = [],
  movements = [],
  incomingByKey = {},
  windowDays = 30,
  leadDays = 30,
  safetyDays = 14,
  targetDays = 60,
  today,
} = {}) {
  const safeWindowDays = wholeNumber(windowDays, 30, 1, 365)
  const safeLeadDays = wholeNumber(leadDays, 30)
  const safeSafetyDays = wholeNumber(safetyDays, 14)
  const effectiveTargetDays = Math.max(
    wholeNumber(targetDays, 60, 1),
    safeLeadDays + safeSafetyDays,
  )
  const endDay = todayKey(today)
  const endDayNumber = dayNumber(endDay)
  const startDayNumber = endDayNumber - safeWindowDays + 1

  const movementBySku = new Map()
  const activeDays = new Set()
  let earliestDayNumber = null

  for (const movement of movements || []) {
    if (movement?.txn_type !== 'sales' && movement?.txn_type !== 'return') continue
    const movementDay = dayKey(movement.day)
    if (!movementDay) continue
    const movementDayNumber = dayNumber(movementDay)
    if (movementDayNumber < startDayNumber || movementDayNumber > endDayNumber) continue

    const quantity = Number(movement.qty)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    activeDays.add(movementDay)
    earliestDayNumber = earliestDayNumber == null
      ? movementDayNumber
      : Math.min(earliestDayNumber, movementDayNumber)

    const key = replenishmentSkuKey(movement)
    const totals = movementBySku.get(key) || { sales: 0, returns: 0 }
    totals[movement.txn_type === 'sales' ? 'sales' : 'returns'] += quantity
    movementBySku.set(key, totals)
  }

  const historySpanDays = earliestDayNumber == null
    ? 0
    : Math.min(safeWindowDays, endDayNumber - earliestDayNumber + 1)
  const activeDayCount = activeDays.size
  const activeDayRate = historySpanDays ? activeDayCount / historySpanDays : 0
  const minimumHistoryDays = Math.min(7, safeWindowDays)
  const confidence = historySpanDays === 0
    ? 'none'
    : historySpanDays < minimumHistoryDays || activeDayRate < 0.5
      ? 'low'
      : historySpanDays < safeWindowDays || activeDayRate < 0.8
        ? 'medium'
        : 'high'

  const inventoryBySku = new Map()
  for (const inventoryRow of inventoryRows || []) {
    const key = replenishmentSkuKey(inventoryRow)
    const existing = inventoryBySku.get(key)
    if (existing) {
      existing.onHand += Number(inventoryRow.Quantity ?? inventoryRow.quantity) || 0
      continue
    }
    inventoryBySku.set(key, {
      key,
      style: String(inventoryRow.Style ?? inventoryRow.style ?? '').trim(),
      color: String(inventoryRow.Color ?? inventoryRow.color ?? '').trim(),
      size: String(inventoryRow.Size ?? inventoryRow.size ?? '').trim(),
      onHand: Number(inventoryRow.Quantity ?? inventoryRow.quantity) || 0,
    })
  }

  const reorderDays = safeLeadDays + safeSafetyDays
  const rows = [...inventoryBySku.values()].map((inventoryRow) => {
    const movement = movementBySku.get(inventoryRow.key) || { sales: 0, returns: 0 }
    const netSales = movement.sales - movement.returns
    const dailyNetSales = historySpanDays > 0 ? Math.max(0, netSales) / historySpanDays : 0
    const incoming = wholeNumber(incomingByKey?.[inventoryRow.key], 0, 0, 100000000)
    const inventoryPosition = inventoryRow.onHand + incoming
    const daysLeft = dailyNetSales > 0
      ? Math.max(0, inventoryRow.onHand) / dailyNetSales
      : Infinity
    const reorderPoint = Math.ceil(dailyNetSales * reorderDays)
    const targetStock = Math.ceil(dailyNetSales * effectiveTargetDays)
    const shouldReorder = dailyNetSales > 0 && inventoryPosition <= reorderPoint
    const recommendedQty = shouldReorder
      ? Math.max(0, Math.ceil(targetStock - inventoryPosition))
      : 0
    const status = dailyNetSales <= 0
      ? 'no-demand'
      : inventoryRow.onHand <= 0 || daysLeft <= safeLeadDays
        ? 'urgent'
        : daysLeft <= reorderDays
          ? 'reorder'
          : daysLeft <= effectiveTargetDays
            ? 'watch'
            : 'healthy'

    return {
      ...inventoryRow,
      sales: movement.sales,
      returns: movement.returns,
      netSales,
      dailyNetSales,
      incoming,
      inventoryPosition,
      daysLeft,
      reorderPoint,
      targetStock,
      recommendedQty,
      status,
    }
  })

  return {
    rows,
    meta: {
      windowDays: safeWindowDays,
      leadDays: safeLeadDays,
      safetyDays: safeSafetyDays,
      targetDays: effectiveTargetDays,
      historySpanDays,
      activeDayCount,
      activeDayRate,
      confidence,
      firstDay: earliestDayNumber == null
        ? ''
        : new Date(earliestDayNumber * DAY_MS).toISOString().slice(0, 10),
      lastDay: historySpanDays ? endDay : '',
    },
  }
}
