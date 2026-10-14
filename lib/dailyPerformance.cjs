// Purchase performance uses dates parsed from uploaded reports, independently of shipments.
const text = (value) => String(value ?? '').trim()
const styleKey = (value) => text(value).toUpperCase()
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0

function buildDailyPerformance({ days = [], products = [], styles = [] } = {}) {
  const selected = new Set(styles.map(styleKey))
  const catalog = new Map(products.map((item) => [JSON.stringify([item.store, text(item.spu)]), item.data || item]))
  const purchaseDay = days.map((item) => text(item.day).slice(0, 10)).sort().at(-1) || ''
  const details = []
  const groups = new Map()
  const coverage = days.map((item) => ({ store: item.store, day: text(item.day).slice(0, 10), current: Boolean(purchaseDay) && text(item.day).slice(0, 10) === purchaseDay }))
  for (const daily of days) {
    if (text(daily.day).slice(0, 10) !== purchaseDay) continue
    for (const row of daily.rows || []) {
      if (row.dataKind === 'period' || row.kind === 'period' || (row.periodStart && row.periodEnd && row.periodStart !== row.periodEnd)) continue
      const spu = text(row.spu)
      const product = catalog.get(JSON.stringify([daily.store, spu])) || {}
      const styleNumber = styleKey(product.styleNumber)
      if (styleNumber && !selected.has(styleNumber)) continue
      const multiplier = number(product.unitMultiplier) > 0 ? number(product.unitMultiplier) : 1
      const detail = {
        store: daily.store, spu, styleNumber, purchaseDay,
        units: number(row.units) * multiplier,
        revenue: number(row.revenue), spend: number(row.spend),
        status: styleNumber ? 'Mapped' : 'Missing style number — excluded from style totals',
      }
      detail.roas = detail.spend > 0 ? detail.revenue / detail.spend : null
      details.push(detail)
      if (!styleNumber) continue
      const group = groups.get(styleNumber) || { styleNumber, purchaseDay, units: 0, revenue: 0, spend: 0, stores: new Set() }
      for (const field of ['units', 'revenue', 'spend']) group[field] += detail[field]
      group.stores.add(detail.store)
      groups.set(styleNumber, group)
    }
  }
  return {
    purchaseDay, coverage, details,
    rows: [...groups.values()].map((group) => ({ ...group, stores: [...group.stores].join(', '), roas: group.spend > 0 ? group.revenue / group.spend : null })),
  }
}

async function loadDailyPerformance(sql, styles) {
  const [tables] = await sql`SELECT to_regclass('analytics_store_days')::text AS days, to_regclass('analytics_store_products')::text AS products, to_regclass('analytics_stores')::text AS stores`
  if (!tables?.days || !tables?.products || !tables?.stores) return { ...buildDailyPerformance({ styles }), unavailable: 'Analytics daily data is not available.' }
  // Analytics admin users share the admin namespace, as in analytics-store.js.
  const days = await sql`SELECT stores.name AS store, latest.day::text AS day, COALESCE(latest.rows, '[]'::jsonb) AS rows
    FROM analytics_stores stores
    LEFT JOIN LATERAL (SELECT day, rows FROM analytics_store_days
      WHERE username = 'admin' AND store = stores.name ORDER BY day DESC LIMIT 1) latest ON TRUE
    WHERE stores.username = 'admin' ORDER BY stores.name`
  const products = await sql`SELECT store, spu, data FROM analytics_store_products WHERE username = 'admin'`
  return buildDailyPerformance({ days, products, styles })
}
module.exports = { buildDailyPerformance, loadDailyPerformance }
