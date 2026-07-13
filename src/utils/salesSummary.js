import { fetchStoreProducts, fetchStoreRange } from './api.js'

function isoDay(value) {
  return String(value || '').slice(0, 10)
}

export function shiftISODate(day, amount) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function formatISODate(day) {
  const value = isoDay(day)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '-'
  const [year, month, date] = value.split('-')
  return `${month}/${date}/${year}`
}

function productMultiplier(product) {
  const value = Number(product?.unitMultiplier)
  return Number.isFinite(value) && value > 0 ? value : 1
}

function rowColor(row) {
  return String(
    row?.color ?? row?.Color ?? row?.['颜色'] ?? row?.['商品颜色'] ?? row?.['SKU颜色'] ?? '',
  ).trim()
}

function addRankValue(map, key, units, details = {}) {
  if (!key || !units) return
  const current = map.get(key) || { key, units: 0, ...details, storeUnits: new Map() }
  current.units += units
  if (details.label && !current.label) current.label = details.label
  if (details.spu && !current.spu) current.spu = details.spu
  if (details.sku && !current.sku) current.sku = details.sku
  if (details.productName && !current.productName) current.productName = details.productName
  if (details.store) {
    current.storeUnits.set(details.store, (current.storeUnits.get(details.store) || 0) + units)
  }
  map.set(key, current)
}

function rankedRows(currentMap, previousMap) {
  return [...currentMap.values()]
    .sort((a, b) => b.units - a.units)
    .slice(0, 5)
    .map((item) => {
      const previousUnits = previousMap.get(item.key)?.units || 0
      const topStore = [...item.storeUnits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
      return {
        ...item,
        storeUnits: undefined,
        previousUnits,
        change: previousUnits ? (item.units - previousUnits) / previousUnits : null,
        isNew: previousUnits === 0 && item.units > 0,
        topStore,
      }
    })
}

export async function loadSalesSummary(stores, windowDays = 30) {
  const availableStores = (stores || [])
    .map((store) => ({ ...store, lastDay: isoDay(store.last_day || store.lastDay) }))
    .filter((store) => store.name && store.lastDay)

  const latestDay = availableStores.map((store) => store.lastDay).sort().at(-1) || ''
  if (!latestDay) {
    return {
      latestDay: '', from: '', trend: [], latestUnits: 0, sevenDayTotal: 0,
      sevenDayAverage: 0, thirtyDayAverage: 0, topProducts: [], topColors: [],
      storeCount: 0, latestStoreCount: 0, availableDayCount: 0,
    }
  }

  const from = shiftISODate(latestDay, -(windowDays - 1))
  const currentSevenFrom = shiftISODate(latestDay, -6)
  const previousSevenFrom = shiftISODate(latestDay, -13)
  const previousSevenTo = shiftISODate(latestDay, -7)

  const payloads = await Promise.all(availableStores.map(async (store) => {
    const [range, catalog] = await Promise.all([
      fetchStoreRange(store.name, from, latestDay),
      fetchStoreProducts(store.name).catch(() => ({ products: [] })),
    ])
    return { store: store.name, rows: range.rows || [], products: catalog.products || [] }
  }))

  const daily = new Map()
  const currentProducts = new Map()
  const previousProducts = new Map()
  const currentColors = new Map()
  const previousColors = new Map()

  for (const payload of payloads) {
    const products = new Map(payload.products.map((product) => [String(product.spu || ''), product]))
    for (const row of payload.rows) {
      const day = isoDay(row.date || row.periodEnd)
      if (!day) continue
      const product = products.get(String(row.spu || '')) || {}
      const units = (Number(row.units) || 0) * productMultiplier(product)
      const dailyItem = daily.get(day) || { day, units: 0, stores: new Set() }
      dailyItem.units += units
      dailyItem.stores.add(payload.store)
      daily.set(day, dailyItem)

      const inCurrentSeven = day >= currentSevenFrom && day <= latestDay
      const inPreviousSeven = day >= previousSevenFrom && day <= previousSevenTo
      if (!inCurrentSeven && !inPreviousSeven) continue

      const spu = String(row.spu || row.productId || '').trim()
      const productDetails = {
        spu,
        sku: String(product.sku || '').trim(),
        productName: String(product.productName || row.productName || spu).trim(),
        store: payload.store,
      }
      const color = rowColor(row)
      if (inCurrentSeven) {
        addRankValue(currentProducts, spu, units, productDetails)
        addRankValue(currentColors, color.toLowerCase(), units, { label: color, store: payload.store })
      } else {
        addRankValue(previousProducts, spu, units, productDetails)
        addRankValue(previousColors, color.toLowerCase(), units, { label: color, store: payload.store })
      }
    }
  }

  const trend = [...daily.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((item) => ({ day: item.day, units: item.units, storeCount: item.stores.size }))
  const latest = daily.get(latestDay)
  const sevenDays = trend.filter((item) => item.day >= currentSevenFrom && item.day <= latestDay)
  const sevenDayTotal = sevenDays.reduce((total, item) => total + item.units, 0)
  const windowTotal = trend.reduce((total, item) => total + item.units, 0)

  return {
    latestDay,
    from,
    trend,
    latestUnits: latest?.units || 0,
    sevenDayTotal,
    sevenDayAverage: sevenDays.length ? sevenDayTotal / sevenDays.length : 0,
    thirtyDayAverage: trend.length ? windowTotal / trend.length : 0,
    topProducts: rankedRows(currentProducts, previousProducts),
    topColors: rankedRows(currentColors, previousColors),
    storeCount: availableStores.length,
    latestStoreCount: latest?.stores.size || 0,
    availableDayCount: trend.length,
  }
}
