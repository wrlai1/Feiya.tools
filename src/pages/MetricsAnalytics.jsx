import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  AlertTriangle, BarChart3, Calendar, CheckCircle, Package, Plus,
  Save, Trash2, TrendingUp, Upload, X,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import KPICard from '../components/KPICard.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseCSV } from '../utils/autoDeductEngine.js'
import {
  fetchStores, createStore, deleteStore, saveStoreDay, fetchStoreRange, deleteStoreDay,
  fetchStoreProducts, saveStoreProducts, fetchAnalyticsSettings, saveAnalyticsSettings,
} from '../utils/api.js'

const todayISO = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

const MONEY_COLS = ['花费', '销售额', '申报价', '成本', '价格', '毛利', '售价', 'Coupon']
const RATE_COLS = ['率', '费比', '折扣']
const DEFAULT_TARGETS = {
  ctrTarget: 0.03,
  conversionTarget: 0.02,
  cartRateTarget: 0.08,
  roasTarget: 2.5,
  costRatioMax: 0.4,
  minImpressions: 500,
  minClicks: 50,
  stopLossSpend: 10,
  targetUnits: 3,
  newProductDays: 7,
}
const TARGET_FIELDS = [
  ['ctrTarget', 'CTR 目标', 'percent'],
  ['conversionTarget', '转化率目标', 'percent'],
  ['cartRateTarget', '加购率目标', 'percent'],
  ['roasTarget', 'ROAS 目标', 'number'],
  ['costRatioMax', '费比上限', 'percent'],
  ['minImpressions', '最低曝光判断量', 'integer'],
  ['minClicks', '最低点击判断量', 'integer'],
  ['stopLossSpend', '花费止损线 $', 'money'],
  ['targetUnits', '销量目标', 'integer'],
  ['newProductDays', '新品观察天数', 'integer'],
]

function normalizeId(v) {
  const s = String(v ?? '').trim()
  if (!s || s === 'nan' || s === 'null' || s === 'undefined') return ''
  return s.replace(/\.0$/, '')
}

function isRateColumn(key) {
  return RATE_COLS.some((x) => String(key).includes(x))
}

function toNumber(v, key = '') {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v == null) return null
  const raw = String(v).trim()
  if (!raw) return null
  const hadPercent = raw.includes('%')
  const cleaned = raw.replace(/[$¥,\s]/g, '').replace(/[%x×]$/i, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return hadPercent || isRateColumn(key) ? n / 100 : n
}

function money(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function count(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return Math.round(Number(v)).toLocaleString('en-US')
}

function pct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return (Number(v) * 100).toFixed(1) + '%'
}

function ratio(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return Number(v).toFixed(2) + 'x'
}

function isSummaryRow(row) {
  return Object.values(row).some((v) => /共\s*\d+\s*项|总计|合计|^\s*total\s*$/i.test(String(v ?? '')))
}

async function readSheetRows(file) {
  if (/\.csv$/i.test(file.name)) return parseCSV(await file.text())
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' })
}

function dateRangeFromFileName(name) {
  const dates = String(name).match(/\d{4}-\d{2}-\d{2}/g) || []
  if (dates.length >= 2) {
    return { start: dates[dates.length - 2], end: dates[dates.length - 1] }
  }
  return { start: todayISO(), end: todayISO() }
}

async function parseProductPlan(file) {
  const raw = await readSheetRows(file)
  const rows = raw
    .filter((r) => !isSummaryRow(r))
    .map((r) => {
      const spu = normalizeId(r['SPU/款号'] ?? r['SPU ID'] ?? r['SPU'])
      if (!spu) return null
      return {
        spu,
        store: String(r['店铺'] ?? '').trim(),
        sku: normalizeId(r['SKU']),
        productName: String(r['商品名'] ?? r['商品名称'] ?? '').trim(),
        category: String(r['品类'] ?? '').trim(),
        sizeLine: String(r['尺码线'] ?? '').trim(),
        lifecycle: String(r['生命周期'] ?? '').trim(),
        skuType: String(r['SKU类型'] ?? '').trim(),
        cost: toNumber(r['成本$'], '成本'),
        minDeclaredPrice: toNumber(r['最低申报价'], '价格'),
        declaredPrice: toNumber(r['申报价$'], '价格'),
        eventPrice: toNumber(r['活动价$'], '价格'),
        tbpPrice: toNumber(r['TBP流量加速价$'], '价格'),
        frontPrice: toNumber(r['前端售价$'], '价格'),
        couponPrice: toNumber(r['Coupon后价$'], '价格'),
        markup: toNumber(r['Hidden Markup=前端/TBP']),
        discountRate: toNumber(r['活动折扣率'], '率'),
        grossProfit: toNumber(r['前端毛利$'], '毛利'),
        grossMargin: toNumber(r['前端毛利率'], '率'),
        initialOrders: toNumber(r['订单']),
      }
    })
    .filter(Boolean)
  if (!rows.length) throw new Error('没有找到带 SPU/款号 的上新计划数据')
  return rows
}

async function parsePerformanceFile(file) {
  const raw = await readSheetRows(file)
  const { start, end } = dateRangeFromFileName(file.name)
  const rows = raw
    .filter((r) => !isSummaryRow(r))
    .map((r) => {
      const spu = normalizeId(r['SPU ID'] ?? r['SPU/款号'] ?? r['SPU'])
      if (!spu) return null
      return {
        spu,
        productId: normalizeId(r['商品ID']),
        productName: String(r['商品名称'] ?? '').trim(),
        region: String(r['当前区域'] ?? '').trim(),
        site: String(r['商品站点'] ?? '').trim(),
        spend: toNumber(r['总花费'], '花费'),
        netSpend: toNumber(r['净总花费'], '花费'),
        revenue: toNumber(r['申报价销售额（全域）'], '销售额'),
        netRevenue: toNumber(r['净申报价销售额（全域）'], '销售额'),
        roas: toNumber(r['投资回报率(ROAS)（全域）']),
        netRoas: toNumber(r['净投资回报率(ROAS)（全域）']),
        costRatio: toNumber(r['费比（全域）'], '费比'),
        cpa: toNumber(r['每笔成交花费（全域）'], '花费'),
        orders: toNumber(r['子订单数（全域）']),
        units: toNumber(r['件数（全域）']),
        impressions: toNumber(r['曝光（全域）']),
        clicks: toNumber(r['点击（全域）']),
        ctr: toNumber(r['点击率（全域）'], '率'),
        conversionRate: toNumber(r['转化率（全域）'], '率'),
        carts: toNumber(r['加入购物车数（全域）']),
        netOrders: toNumber(r['净子订单数（全域）']),
        netUnits: toNumber(r['净件数（全域）']),
        periodStart: start,
        periodEnd: end,
        sourceFile: file.name,
      }
    })
    .filter(Boolean)
  if (!rows.length) throw new Error('没有找到带 SPU ID 的商品推广数据')
  return { rows, start, end, fileName: file.name }
}

function sum(rows, key) {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0)
}

function aggregateBySpu(rows, products, settings = DEFAULT_TARGETS) {
  const productMap = new Map(products.map((p) => [p.spu, p]))
  const groups = new Map()
  for (const row of rows) {
    const key = row.spu || row.productId
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.entries()].map(([spu, group]) => {
    const product = productMap.get(spu) || {}
    const spend = sum(group, 'spend')
    const revenue = sum(group, 'revenue')
    const impressions = sum(group, 'impressions')
    const clicks = sum(group, 'clicks')
    const carts = sum(group, 'carts')
    const orders = sum(group, 'orders')
    const units = sum(group, 'units')
    const grossProfitEstimate = product.grossProfit ? product.grossProfit * units : null
    const out = {
      spu,
      sku: product.sku || '',
      productName: product.productName || group.find((r) => r.productName)?.productName || spu,
      category: product.category || '',
      lifecycle: product.lifecycle || '',
      skuType: product.skuType || '',
      frontPrice: product.frontPrice ?? null,
      couponPrice: product.couponPrice ?? null,
      grossMargin: product.grossMargin ?? null,
      spend,
      revenue,
      impressions,
      clicks,
      carts,
      orders,
      units,
      ctr: impressions ? clicks / impressions : null,
      conversionRate: clicks ? orders / clicks : null,
      cartRate: clicks ? carts / clicks : null,
      roas: spend ? revenue / spend : null,
      costRatio: revenue ? spend / revenue : null,
      cpa: orders ? spend / orders : null,
      grossProfitEstimate,
      daysSeen: new Set(group.map((r) => r.date || r.periodEnd).filter(Boolean)).size,
    }
    return { ...out, ...diagnoseProduct(out, settings) }
  }).sort((a, b) => (b.units || 0) - (a.units || 0))
}

function scoreProduct(p, settings = DEFAULT_TARGETS) {
  let score = 0
  if ((p.ctr ?? 0) >= settings.ctrTarget) score += 15
  if ((p.conversionRate ?? 0) >= settings.conversionTarget) score += 20
  if ((p.cartRate ?? 0) >= settings.cartRateTarget) score += 10
  if ((p.roas ?? 0) >= settings.roasTarget) score += 25
  if (p.costRatio != null && p.costRatio <= settings.costRatioMax) score += 10
  if ((p.units || 0) >= settings.targetUnits) score += 15
  if ((p.grossMargin ?? 0) >= 0.4) score += 5
  return Math.min(100, score)
}

function scoreBand(score) {
  if (score >= 80) return { status: 'good', label: 'Winner' }
  if (score >= 60) return { status: 'good', label: 'Potential' }
  if (score >= 40) return { status: 'warn', label: 'Fix' }
  return { status: 'bad', label: 'Kill / Pause' }
}

function diagnoseProduct(p, settings = DEFAULT_TARGETS) {
  const score = scoreProduct(p, settings)
  const band = scoreBand(score)
  if ((p.roas ?? 0) >= settings.roasTarget && (p.units || 0) >= settings.targetUnits) {
    return { score, grade: band.label, status: 'good', decision: '表现好，可加流量', reason: 'ROAS 和销量都达到你的目标，优先观察库存和预算。' }
  }
  if ((p.conversionRate ?? 0) >= settings.conversionTarget && (p.impressions || 0) < settings.minImpressions) {
    return { score, grade: band.label, status: 'good', decision: '转化好，缺流量', reason: '转化率达标但曝光不足，可以测试加流量。' }
  }
  if ((p.impressions || 0) >= settings.minImpressions && (p.ctr ?? 0) < settings.ctrTarget) {
    return { score, grade: band.label, status: 'bad', decision: '先改主图/标题', reason: '曝光达到判断量，但 CTR 低于你的目标。' }
  }
  if ((p.clicks || 0) >= settings.minClicks && (p.conversionRate ?? 0) < settings.conversionTarget) {
    return { score, grade: band.label, status: 'bad', decision: '点击有，转化弱', reason: '点击达到判断量，但转化率低于你的目标，优先看价格、页面、评价。' }
  }
  if ((p.cartRate ?? 0) >= settings.cartRateTarget && (p.conversionRate ?? 0) < settings.conversionTarget) {
    return { score, grade: band.label, status: 'warn', decision: '加购不成单', reason: '加购率达标但订单转化弱，检查优惠、价格或结账阻力。' }
  }
  if ((p.spend || 0) >= settings.stopLossSpend && (p.orders || 0) === 0) {
    return { score, grade: band.label, status: 'bad', decision: '花费无单，控预算', reason: '花费超过止损线但没有订单，先暂停或降低测试。' }
  }
  if ((p.clicks || 0) < settings.minClicks && (p.impressions || 0) < settings.minImpressions) {
    return { score, grade: band.label, status: 'watch', decision: '数据太少，继续观察', reason: '样本量不够，暂时不要过早判断。' }
  }
  return { score, grade: band.label, status: band.status, decision: band.label === 'Potential' ? '有潜力，继续测试' : '稳定观察', reason: '没有明显异常，继续按当前目标积累数据。' }
}

function aggregateTotals(rows) {
  const spend = sum(rows, 'spend')
  const revenue = sum(rows, 'revenue')
  const impressions = sum(rows, 'impressions')
  const clicks = sum(rows, 'clicks')
  const carts = sum(rows, 'carts')
  const orders = sum(rows, 'orders')
  const units = sum(rows, 'units')
  return {
    spend, revenue, impressions, clicks, carts, orders, units,
    ctr: impressions ? clicks / impressions : null,
    conversionRate: clicks ? orders / clicks : null,
    cartRate: clicks ? carts / clicks : null,
    roas: spend ? revenue / spend : null,
    cpa: orders ? spend / orders : null,
  }
}

function matchesProductKey(item, query) {
  const q = normalizeId(query).toLowerCase()
  if (!q) return false
  return [item?.spu, item?.sku].some((v) => normalizeId(v).toLowerCase() === q)
}

function productKeyLabel(item) {
  if (!item) return ''
  const left = item.sku ? `SKU ${item.sku}` : `SPU ${item.spu}`
  const right = item.sku ? `SPU ${item.spu}` : ''
  return [left, right, item.productName].filter(Boolean).join(' · ')
}

function daySeries(rows) {
  const days = new Map()
  for (const r of rows) {
    const day = r.date || r.periodEnd || todayISO()
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(r)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, rs]) => {
    const t = aggregateTotals(rs)
    return { day, units: t.units, orders: t.orders, spend: t.spend, revenue: t.revenue, roas: t.roas || 0, ctr: t.ctr || 0, conversionRate: t.conversionRate || 0 }
  })
}

function timeframeRange(tf, customFrom, customTo) {
  const to = todayISO()
  if (tf === '7d' || tf === '14d') {
    const d = new Date()
    d.setDate(d.getDate() - (tf === '7d' ? 6 : 13))
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return { from: d.toISOString().slice(0, 10), to }
  }
  if (tf === 'custom') return { from: customFrom, to: customTo }
  return { from: to, to }
}

export default function MetricsAnalytics() {
  const toast = useToast()
  const [stores, setStores] = useState([])
  const [activeStore, setActiveStore] = useState('')
  const [newStore, setNewStore] = useState('')
  const [products, setProducts] = useState([])
  const [storeRows, setStoreRows] = useState([])
  const [storeDays, setStoreDays] = useState([])
  const [draftReport, setDraftReport] = useState(null)
  const [uploadDate, setUploadDate] = useState(todayISO())
  const [timeframe, setTimeframe] = useState('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [metricX, setMetricX] = useState('ctr')
  const [tableFilter, setTableFilter] = useState('all')
  const [selectedProduct, setSelectedProduct] = useState('')
  const [storeComparison, setStoreComparison] = useState([])
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const reloadStores = useCallback(async () => {
    try {
      const res = await fetchStores()
      setStores(res.stores || [])
    } catch (err) {
      setStores([])
    }
  }, [])

  useEffect(() => { reloadStores() }, [reloadStores])

  const loadProducts = useCallback(async (store) => {
    if (!store) { setProducts([]); return }
    try {
      const res = await fetchStoreProducts(store)
      setProducts(res.products || [])
    } catch {
      setProducts([])
    }
  }, [])

  const loadWindow = useCallback(async () => {
    if (!activeStore) { setStoreRows([]); setStoreDays([]); return }
    const { from, to } = timeframeRange(timeframe, customFrom, customTo)
    if (!from || !to) return
    setLoading(true)
    try {
      const res = await fetchStoreRange(activeStore, from, to)
      setStoreRows(res.rows || [])
      setStoreDays(res.days || [])
    } catch (err) {
      toast.error(err.message, '表现数据读取失败')
      setStoreRows([]); setStoreDays([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, timeframe, customFrom, customTo])

  useEffect(() => {
    loadProducts(activeStore)
  }, [activeStore, loadProducts])

  useEffect(() => {
    loadWindow()
  }, [loadWindow])

  useEffect(() => {
    let cancelled = false
    async function loadSettings() {
      try {
        const res = await fetchAnalyticsSettings(activeStore || '')
        if (!cancelled) setTargets({ ...DEFAULT_TARGETS, ...(res.settings || {}) })
      } catch {
        if (!cancelled) setTargets(DEFAULT_TARGETS)
      }
    }
    loadSettings()
    return () => { cancelled = true }
  }, [activeStore])

  const visibleRows = draftReport?.rows?.length ? draftReport.rows : storeRows
  const totals = useMemo(() => aggregateTotals(visibleRows), [visibleRows])
  const productRows = useMemo(() => aggregateBySpu(visibleRows, products, targets), [visibleRows, products, targets])
  const productChoices = useMemo(() => {
    const map = new Map()
    for (const p of [...products, ...productRows]) {
      if (!p?.spu) continue
      map.set(p.spu, { ...map.get(p.spu), ...p })
    }
    return [...map.values()].sort((a, b) => String(a.sku || a.spu).localeCompare(String(b.sku || b.spu)))
  }, [products, productRows])
  const selectedProductMatches = useMemo(
    () => productChoices.filter((p) => matchesProductKey(p, selectedProduct)),
    [productChoices, selectedProduct],
  )
  const selectedSpus = useMemo(
    () => new Set(selectedProductMatches.map((p) => p.spu).filter(Boolean)),
    [selectedProductMatches],
  )
  const selectedRows = useMemo(() => {
    const q = normalizeId(selectedProduct)
    if (!q) return []
    return visibleRows.filter((r) => selectedSpus.has(r.spu) || normalizeId(r.spu) === q)
  }, [visibleRows, selectedProduct, selectedSpus])
  const selectedTotals = useMemo(() => aggregateTotals(selectedRows), [selectedRows])
  const selectedTrends = useMemo(() => daySeries(selectedRows), [selectedRows])
  const selectedProductSummary = useMemo(
    () => aggregateBySpu(selectedRows, products, targets)[0] || selectedProductMatches[0] || null,
    [selectedRows, products, selectedProductMatches, targets],
  )
  const trends = useMemo(() => daySeries(visibleRows), [visibleRows])
  const relationPoints = useMemo(() => productRows
    .map((p) => ({ ...p, x: p[metricX], y: p.units }))
    .filter((p) => p.x != null && p.y != null), [productRows, metricX])
  const filteredProducts = useMemo(() => {
    if (tableFilter === 'all') return productRows
    return productRows.filter((p) => p.status === tableFilter)
  }, [productRows, tableFilter])

  useEffect(() => {
    let cancelled = false
    async function loadStoreComparison() {
      const query = normalizeId(selectedProduct)
      if (!query || !stores.length) { setStoreComparison([]); return }
      const { from, to } = timeframeRange(timeframe, customFrom, customTo)
      if (!from || !to) return
      setComparisonLoading(true)
      try {
        const rows = []
        for (const store of stores) {
          const storeName = store.name
          const [productRes, rangeRes] = await Promise.all([
            fetchStoreProducts(storeName).catch(() => ({ products: [] })),
            fetchStoreRange(storeName, from, to).catch(() => ({ rows: [] })),
          ])
          const storeProducts = productRes.products || []
          const matchingProducts = storeProducts.filter((p) => matchesProductKey(p, query))
          const matchingSpus = new Set(matchingProducts.map((p) => p.spu))
          const matchingRows = (rangeRes.rows || []).filter((r) => matchingSpus.has(r.spu) || normalizeId(r.spu) === query)
          if (!matchingRows.length && !matchingProducts.length) continue
          const summary = aggregateBySpu(matchingRows, matchingProducts, targets)[0] || {
            ...(matchingProducts[0] || { spu: query, sku: query }),
            ...aggregateTotals(matchingRows),
          }
          rows.push({ store: storeName, ...summary, rows: matchingRows.length })
        }
        if (!cancelled) setStoreComparison(rows.sort((a, b) => (b.units || 0) - (a.units || 0)))
      } finally {
        if (!cancelled) setComparisonLoading(false)
      }
    }
    loadStoreComparison()
    return () => { cancelled = true }
  }, [selectedProduct, stores, timeframe, customFrom, customTo, targets])

  const saveTargets = async (nextTargets) => {
    const normalized = { ...DEFAULT_TARGETS, ...nextTargets }
    setTargets(normalized)
    try {
      await saveAnalyticsSettings(activeStore || '', normalized)
      toast.success(activeStore ? `${activeStore} 的目标已保存` : '默认目标已保存', 'Analytics Settings')
    } catch (err) {
      toast.error(err.message, '目标保存失败')
    }
  }

  const handleCreateStore = async () => {
    const name = newStore.trim()
    if (!name) return
    try {
      await createStore(name)
      setNewStore('')
      setActiveStore(name)
      await reloadStores()
    } catch (err) {
      toast.error(err.message, '店铺创建失败')
    }
  }

  const handleDeleteStore = async (name) => {
    if (!window.confirm(`Delete store ${name}? This removes its saved daily data.`)) return
    try {
      await deleteStore(name)
      if (activeStore === name) setActiveStore('')
      await reloadStores()
    } catch (err) {
      toast.error(err.message, '店铺删除失败')
    }
  }

  const handlePlanUpload = async (file) => {
    if (!activeStore) { toast.error('请先选择或创建店铺', '不能保存上新计划'); return }
    try {
      const rows = await parseProductPlan(file)
      const scoped = rows.map((r) => ({ ...r, store: r.store || activeStore }))
      await saveStoreProducts(activeStore, scoped, file.name)
      setProducts(scoped)
      toast.success(`${scoped.length} 个 SPU 已保存到 ${activeStore}`, '上新计划已导入')
    } catch (err) {
      toast.error(err.message, '上新计划读取失败')
    }
  }

  const handlePerformanceUpload = async (file) => {
    try {
      const report = await parsePerformanceFile(file)
      setDraftReport(report)
      setUploadDate(todayISO())
      toast.success(`${report.rows.length} 个商品 · ${report.start} 到 ${report.end}`, '表现数据已读取')
    } catch (err) {
      toast.error(err.message, '表现数据读取失败')
    }
  }

  const saveDraft = async () => {
    if (!activeStore || !draftReport) return
    const saveDate = uploadDate || todayISO()
    try {
      const existing = await fetchStoreRange(activeStore, saveDate, saveDate).catch(() => ({ rows: [] }))
      const existingRows = Array.isArray(existing.rows) ? existing.rows : []
      const hasExisting = existingRows.length > 0
      let mode = 'overwrite'
      if (hasExisting) {
        const overwrite = window.confirm(`${activeStore} 在 ${saveDate} 已经有 ${existingRows.length} 行数据。\n\n点击 OK = 覆盖这一天\n点击 Cancel = 加到原有数据后面`)
        mode = overwrite ? 'overwrite' : 'append'
      }
      const nextRows = draftReport.rows.map((r) => ({ ...r, date: saveDate, reportDate: saveDate }))
      const rows = mode === 'append' ? [...existingRows, ...nextRows] : nextRows
      await saveStoreDay(activeStore, saveDate, draftReport.fileName, rows)
      toast.success(`${rows.length} 行保存到 ${activeStore} (${saveDate})`, mode === 'append' ? '已加到原有数据' : '每日数据已保存')
      setDraftReport(null)
      await reloadStores()
      await loadWindow()
    } catch (err) {
      toast.error(err.message, '保存失败')
    }
  }

  const removeDay = async (day) => {
    try {
      await deleteStoreDay(activeStore, day)
      await loadWindow()
      await reloadStores()
    } catch (err) {
      toast.error(err.message, '删除失败')
    }
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Product Analytics</h1>
          <p className="text-slate-500 mt-1">按店铺和 SPU 追踪每天表现，看销量和点击率、转化率、加购、花费、ROAS 的关系。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input className="metric-input" placeholder="New store" value={newStore} onChange={(e) => setNewStore(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleCreateStore() }} />
          <button className="btn-primary text-sm px-3 py-2" onClick={handleCreateStore}><Plus className="w-4 h-4" /> Create</button>
        </div>
      </div>

      <section className="card p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 uppercase">Stores</span>
          {stores.map((s) => (
            <span key={s.name} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${activeStore === s.name ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-600'}`}>
              <button onClick={() => setActiveStore(s.name)} className="font-medium">{s.name}</button>
              <span className="text-slate-400">{s.days || 0}d</span>
              <button onClick={() => handleDeleteStore(s.name)} className="text-slate-300 hover:text-red-500" title="Delete store"><Trash2 className="w-3 h-3" /></button>
            </span>
          ))}
          {!stores.length && <span className="text-sm text-slate-400">先创建一个店铺。</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 uppercase">Range</span>
          {[
            ['today', 'Daily'],
            ['7d', '7 days'],
            ['14d', '14 days'],
            ['custom', 'Custom'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setTimeframe(key)} className={`text-xs px-3 py-1.5 rounded-lg border ${timeframe === key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
          {timeframe === 'custom' && (
            <span className="inline-flex items-center gap-2 text-xs text-slate-500">
              <Calendar className="w-3.5 h-3.5" />
              <input type="date" className="metric-input !py-1" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span>to</span>
              <input type="date" className="metric-input !py-1" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </span>
          )}
          <button onClick={loadWindow} disabled={!activeStore || loading} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">Refresh</button>
        </div>

        {activeStore && storeDays.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {storeDays.map((d) => (
              <span key={d.day} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                {d.day} · {d.rowCount} rows
                <button onClick={() => removeDay(d.day)} className="text-slate-300 hover:text-red-500" title="Remove day"><X className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800">Analytics Settings</h2>
            <p className="text-xs text-slate-400 mt-0.5">设置你自己的目标。诊断、评分和行动清单都会按这些目标计算。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TargetPill label="CTR" value={pct(targets.ctrTarget)} />
            <TargetPill label="CVR" value={pct(targets.conversionTarget)} />
            <TargetPill label="ROAS" value={ratio(targets.roasTarget)} />
            <TargetPill label="Stop" value={money(targets.stopLossSpend)} />
            <button onClick={() => setSettingsOpen((v) => !v)} className="btn-secondary text-xs px-3 py-1.5">
              {settingsOpen ? 'Hide settings' : 'Edit targets'}
            </button>
          </div>
        </div>
        {settingsOpen && (
          <SettingsPanel
            targets={targets}
            activeStore={activeStore}
            onSave={saveTargets}
            onReset={() => saveTargets(DEFAULT_TARGETS)}
          />
        )}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-slate-800">1. 上新计划 / 产品档案</h2>
              <p className="text-xs text-slate-400 mt-0.5">保存 SKU、SPU、品类、生命周期、成本、售价、毛利。</p>
            </div>
            <span className="text-xs text-slate-500">{products.length} SPU</span>
          </div>
          <FileUploadZone onFile={handlePlanUpload} accept=".csv,.xlsx,.xls" label="Upload 上新计划.csv" acceptedTypes="CSV, XLSX" />
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-slate-800">2. 每日表现数据</h2>
              <p className="text-xs text-slate-400 mt-0.5">上传商品推广数据，系统按 SPU 和产品档案合并。</p>
            </div>
            {draftReport && <span className="text-xs text-blue-600">{draftReport.start} to {draftReport.end}</span>}
          </div>
          <FileUploadZone onFile={handlePerformanceUpload} accept=".csv,.xlsx,.xls" label="Upload 商品推广数据" acceptedTypes="CSV, XLSX" />
          {draftReport && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">{draftReport.rows.length} rows from {draftReport.fileName}</span>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                保存日期
                <input type="date" className="metric-input !py-1" value={uploadDate} onChange={(e) => setUploadDate(e.target.value)} />
              </label>
              <button onClick={saveDraft} disabled={!activeStore} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40"><Save className="w-3.5 h-3.5" /> Save to {activeStore || 'store'}</button>
              <button onClick={() => setDraftReport(null)} className="btn-secondary text-xs px-3 py-1.5">Clear preview</button>
              {draftReport.start !== draftReport.end && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertTriangle className="w-3.5 h-3.5" /> 这是区间报表，请确认保存日期。</span>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800">SPU / SKU Focus</h2>
            <p className="text-xs text-slate-400 mt-0.5">选择一个 SPU 或 SKU，看当前店铺单品表现，并对比所有店铺同款表现。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="metric-input min-w-64"
              list="analytics-product-options"
              placeholder="输入或选择 SPU / SKU"
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
            />
            <datalist id="analytics-product-options">
              {productChoices.map((p) => (
                <option key={p.spu} value={p.sku || p.spu}>{productKeyLabel(p)}</option>
              ))}
              {productChoices.map((p) => p.sku ? <option key={`${p.spu}-spu`} value={p.spu}>{productKeyLabel(p)}</option> : null)}
            </datalist>
            {selectedProduct && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setSelectedProduct('')}>Clear</button>}
          </div>
        </div>

        {selectedProduct ? (
          <div className="space-y-4">
            <SelectedProductPanel
              product={selectedProductSummary}
              rows={selectedRows}
              totals={selectedTotals}
              trends={selectedTrends}
              activeStore={activeStore}
            />
            <CrossStoreComparison rows={storeComparison} loading={comparisonLoading} />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">
            选择一个 SPU 或 SKU 后，这里会显示单品趋势和跨店对比。
          </div>
        )}
      </section>

      {!visibleRows.length ? (
        <div className="card p-8 text-center text-slate-400">
          {activeStore ? '上传一份表现数据，或选择有数据的时间范围。' : '先创建或选择店铺。'}
        </div>
      ) : (
        <>
          <ActionList products={productRows} />

          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <KPICard title="Units" value={count(totals.units)} subtitle={`${count(totals.orders)} orders`} icon={Package} color="blue" />
            <KPICard title="Revenue" value={money(totals.revenue)} subtitle={`${ratio(totals.roas)} ROAS`} icon={TrendingUp} color="teal" />
            <KPICard title="Spend" value={money(totals.spend)} subtitle={`${money(totals.cpa)} / order`} icon={BarChart3} color="purple" />
            <KPICard title="CTR" value={pct(totals.ctr)} subtitle={`${count(totals.clicks)} clicks`} icon={Upload} color="green" />
            <KPICard title="Conversion" value={pct(totals.conversionRate)} subtitle={`${count(totals.carts)} carts`} icon={CheckCircle} color="orange" />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card p-5 lg:col-span-2">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-slate-800">Daily Trend</h2>
                <span className="text-xs text-slate-400">{draftReport ? 'Preview upload' : `${storeDays.length} saved days`}</span>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={trends} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={ratio} />
                  <Tooltip formatter={(v, k) => k === 'roas' ? ratio(v) : count(v)} />
                  <Line yAxisId="left" type="monotone" dataKey="units" stroke="#2563eb" strokeWidth={2} name="Units" />
                  <Line yAxisId="left" type="monotone" dataKey="orders" stroke="#14b8a6" strokeWidth={2} name="Orders" />
                  <Line yAxisId="right" type="monotone" dataKey="roas" stroke="#f97316" strokeWidth={2} name="ROAS" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <FunnelCard totals={totals} />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h2 className="font-semibold text-slate-800">销量和指标关系</h2>
                <select className="metric-input !py-1" value={metricX} onChange={(e) => setMetricX(e.target.value)}>
                  <option value="ctr">点击率 CTR</option>
                  <option value="conversionRate">转化率</option>
                  <option value="cartRate">加购率</option>
                  <option value="roas">ROAS</option>
                  <option value="spend">花费</option>
                  <option value="impressions">曝光</option>
                  <option value="clicks">点击</option>
                </select>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis type="number" dataKey="x" tick={{ fontSize: 11 }} tickFormatter={metricX.includes('Rate') || metricX === 'ctr' ? pct : undefined} />
                  <YAxis type="number" dataKey="y" tick={{ fontSize: 11 }} name="Units" />
                  <Tooltip formatter={(v, k) => [k === 'x' && (metricX.includes('Rate') || metricX === 'ctr') ? pct(v) : count(v), k === 'x' ? metricLabel(metricX) : 'Units']} labelFormatter={() => ''} />
                  <Scatter data={relationPoints} fill="#2563eb" />
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            <TopProductsChart products={productRows} />
          </section>

          <ProductMatrix products={filteredProducts} filter={tableFilter} setFilter={setTableFilter} />
        </>
      )}
    </div>
  )
}

function SelectedProductPanel({ product, rows, totals, trends, activeStore }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="rounded-lg border border-slate-200 p-4">
        <p className="text-xs text-slate-400 mb-1">当前店铺单品</p>
        <h3 className="font-semibold text-slate-800">{product?.sku || product?.spu || 'No match'}</h3>
        <p className="text-xs text-slate-400 mt-1 line-clamp-3">{product?.productName || '当前时间范围里没有匹配数据。'}</p>
        <div className="grid grid-cols-2 gap-2 mt-4 text-sm">
          <MetricCell label="Store" value={activeStore || '-'} />
          <MetricCell label="Rows" value={count(rows.length)} />
          <MetricCell label="Units" value={count(totals.units)} />
          <MetricCell label="Orders" value={count(totals.orders)} />
          <MetricCell label="Revenue" value={money(totals.revenue)} />
          <MetricCell label="Spend" value={money(totals.spend)} />
          <MetricCell label="ROAS" value={ratio(totals.roas)} />
          <MetricCell label="CVR" value={pct(totals.conversionRate)} />
          <MetricCell label="Score" value={product?.score != null ? `${product.score} · ${product.grade || ''}` : '-'} />
        </div>
        {product?.decision && (
          <div className="mt-4">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${statusClass(product.status)}`}>
              {product.status === 'good' ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              {product.decision}
            </span>
            <p className="text-xs text-slate-400 mt-1">{product.reason}</p>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 p-4 lg:col-span-2">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-800">Single Product Trend</h3>
          <span className="text-xs text-slate-400">{trends.length} day{trends.length !== 1 ? 's' : ''}</span>
        </div>
        {trends.length ? (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trends} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={ratio} />
              <Tooltip formatter={(v, k) => k === 'roas' ? ratio(v) : count(v)} />
              <Line yAxisId="left" type="monotone" dataKey="units" stroke="#2563eb" strokeWidth={2} name="Units" />
              <Line yAxisId="left" type="monotone" dataKey="orders" stroke="#14b8a6" strokeWidth={2} name="Orders" />
              <Line yAxisId="right" type="monotone" dataKey="roas" stroke="#f97316" strokeWidth={2} name="ROAS" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-60 flex items-center justify-center text-sm text-slate-400">当前店铺和时间范围没有这个产品的数据。</div>
        )}
      </div>
    </div>
  )
}

function MetricCell({ label, value }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="font-semibold text-slate-700 truncate">{value}</div>
    </div>
  )
}

function CrossStoreComparison({ rows, loading }) {
  const chartRows = rows.map((r) => ({ store: r.store, units: r.units || 0, roas: r.roas || 0, revenue: r.revenue || 0 }))
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-slate-800">Same Product Across Stores</h3>
          <p className="text-xs text-slate-400 mt-0.5">比较同一个 SPU/SKU 在不同店铺的销量、ROAS、转化率和判断。</p>
        </div>
        {loading && <span className="text-xs text-slate-400">Loading...</span>}
      </div>
      {rows.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartRows} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="store" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={ratio} />
              <Tooltip formatter={(v, k) => k === 'roas' ? ratio(v) : count(v)} />
              <Bar yAxisId="left" dataKey="units" fill="#2563eb" name="Units" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="roas" fill="#f97316" name="ROAS" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-4">Store</th>
                  <th className="py-2 pr-4 text-right">Units</th>
                  <th className="py-2 pr-4 text-right">Revenue</th>
                  <th className="py-2 pr-4 text-right">ROAS</th>
                  <th className="py-2 pr-4 text-right">CTR</th>
                  <th className="py-2 pr-4 text-right">CVR</th>
                  <th className="py-2 pr-4 text-right">Score</th>
                  <th className="py-2 pr-4">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.store}>
                    <td className="py-3 pr-4 font-medium text-slate-700">{r.store}</td>
                    <td className="py-3 pr-4 text-right">{count(r.units)}</td>
                    <td className="py-3 pr-4 text-right">{money(r.revenue)}</td>
                    <td className="py-3 pr-4 text-right">{ratio(r.roas)}</td>
                    <td className="py-3 pr-4 text-right">{pct(r.ctr)}</td>
                    <td className="py-3 pr-4 text-right">{pct(r.conversionRate)}</td>
                    <td className="py-3 pr-4 text-right font-semibold text-slate-700">{r.score ?? '-'}</td>
                    <td className="py-3 pr-4 min-w-44">
                      {r.decision ? (
                        <>
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusClass(r.status)}`}>{r.decision}</span>
                          <p className="text-xs text-slate-400 mt-1">{r.reason}</p>
                        </>
                      ) : <span className="text-slate-400">No data</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="h-28 flex items-center justify-center text-sm text-slate-400">
          {loading ? '正在读取所有店铺...' : '其他店铺没有匹配的 SPU/SKU 数据。'}
        </div>
      )}
    </div>
  )
}

function TargetPill({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

function SettingsPanel({ targets, activeStore, onSave, onReset }) {
  const [draft, setDraft] = useState(targets)

  useEffect(() => { setDraft(targets) }, [targets])

  const setField = (key, value, type) => {
    const n = Number(value)
    setDraft((prev) => ({
      ...prev,
      [key]: type === 'percent' ? n / 100 : n,
    }))
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-slate-700">Scoring Rules</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {activeStore ? `这些目标会保存到 ${activeStore}。` : '未选择店铺时保存为默认目标。'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onSave(draft)} className="btn-primary text-xs px-3 py-1.5"><Save className="w-3.5 h-3.5" /> Save targets</button>
          <button onClick={onReset} className="btn-secondary text-xs px-3 py-1.5">Reset default</button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {TARGET_FIELDS.map(([key, label, type]) => {
          const value = type === 'percent' ? (draft[key] || 0) * 100 : draft[key]
          return (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 font-medium">{label}</span>
              <input
                type="number"
                className="metric-input"
                min="0"
                step={type === 'integer' ? '1' : '0.1'}
                value={Number.isFinite(value) ? value : ''}
                onChange={(e) => setField(key, e.target.value, type)}
              />
            </label>
          )
        })}
      </div>
    </div>
  )
}

function ActionList({ products }) {
  const used = new Set()
  const take = (predicate) => products.filter((p) => {
    if (used.has(p.spu) || !predicate(p)) return false
    used.add(p.spu)
    return true
  })
  const groups = [
    ['加流量', take((p) => p.decision === '表现好，可加流量' || p.decision === '转化好，缺流量')],
    ['需要修改', take((p) => p.status === 'bad')],
    ['继续测试', take((p) => p.grade === 'Potential' || p.decision === '有潜力，继续测试')],
    ['观察', take((p) => p.status === 'watch' || p.decision === '稳定观察')],
  ]
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-slate-800">Daily Action List</h2>
          <p className="text-xs text-slate-400 mt-0.5">按当前目标自动整理这个时间范围里最该看的产品。</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {groups.map(([title, rows]) => (
          <div key={title} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
              <span className="text-xs text-slate-400">{rows.length}</span>
            </div>
            <div className="space-y-2">
              {rows.slice(0, 5).map((p) => (
                <div key={`${title}-${p.spu}`} className="rounded-md bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm text-slate-700 truncate">{p.sku || p.spu}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(p.status)}`}>{p.score ?? 0}</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5 truncate">{p.decision}</div>
                  <div className="text-[11px] text-slate-400 mt-1">{count(p.units)} units · {ratio(p.roas)} ROAS · {pct(p.ctr)} CTR</div>
                </div>
              ))}
              {!rows.length && <div className="text-xs text-slate-400 py-3">暂无产品。</div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function metricLabel(key) {
  return {
    ctr: 'CTR',
    conversionRate: 'Conversion',
    cartRate: 'Cart rate',
    roas: 'ROAS',
    spend: 'Spend',
    impressions: 'Impressions',
    clicks: 'Clicks',
  }[key] || key
}

function FunnelCard({ totals }) {
  const steps = [
    ['曝光', totals.impressions, null],
    ['点击', totals.clicks, totals.ctr],
    ['加购', totals.carts, totals.cartRate],
    ['订单', totals.orders, totals.conversionRate],
  ]
  const max = Math.max(totals.impressions || 1, 1)
  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-800 mb-3">Traffic Funnel</h2>
      <div className="space-y-3">
        {steps.map(([label, value, rate]) => (
          <div key={label}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-medium text-slate-600">{label}</span>
              <span className="text-slate-400">{count(value)} {rate != null ? `· ${pct(rate)}` : ''}</span>
            </div>
            <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(3, Math.min(100, ((value || 0) / max) * 100))}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400 mt-4">如果曝光够但点击率低，先改主图/标题；如果点击够但转化低，先看价格、页面和评价。</p>
    </div>
  )
}

function TopProductsChart({ products }) {
  const data = products.slice(0, 10).map((p) => ({
    name: p.sku || p.spu,
    units: p.units,
    roas: p.roas || 0,
  }))
  return (
    <div className="card p-5">
      <h2 className="font-semibold text-slate-800 mb-3">Top Products</h2>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 46 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v, k) => k === 'roas' ? ratio(v) : count(v)} />
          <Bar dataKey="units" fill="#2563eb" radius={[4, 4, 0, 0]} name="Units" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ProductMatrix({ products, filter, setFilter }) {
  const filters = [
    ['all', 'All'],
    ['good', '机会'],
    ['warn', '观察'],
    ['bad', '需要修改'],
  ]
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="font-semibold text-slate-800">Product Performance Matrix</h2>
          <p className="text-xs text-slate-400 mt-0.5">每一行是一个 SPU，最后一列是系统根据当前数据给出的操作方向。</p>
        </div>
        <div className="flex gap-1">
          {filters.map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} className={`text-xs px-3 py-1.5 rounded-lg border ${filter === key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="py-2 pr-4">Product</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4 text-right">Units</th>
              <th className="py-2 pr-4 text-right">Spend</th>
              <th className="py-2 pr-4 text-right">Revenue</th>
              <th className="py-2 pr-4 text-right">ROAS</th>
              <th className="py-2 pr-4 text-right">CTR</th>
              <th className="py-2 pr-4 text-right">CVR</th>
              <th className="py-2 pr-4 text-right">Score</th>
              <th className="py-2 pr-4">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.map((p) => (
              <tr key={p.spu} className="align-top">
                <td className="py-3 pr-4 min-w-64">
                  <div className="font-medium text-slate-700">{p.sku || p.spu}</div>
                  <div className="text-xs text-slate-400 line-clamp-2">{p.productName}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">SPU {p.spu}</div>
                </td>
                <td className="py-3 pr-4 text-xs text-slate-500">
                  <div>{p.category || '-'}</div>
                  <div>{p.lifecycle || '-'}</div>
                  <div>{p.skuType || '-'}</div>
                </td>
                <td className="py-3 pr-4 text-right font-medium text-slate-700">{count(p.units)}</td>
                <td className="py-3 pr-4 text-right">{money(p.spend)}</td>
                <td className="py-3 pr-4 text-right">{money(p.revenue)}</td>
                <td className="py-3 pr-4 text-right">{ratio(p.roas)}</td>
                <td className="py-3 pr-4 text-right">{pct(p.ctr)}</td>
                <td className="py-3 pr-4 text-right">{pct(p.conversionRate)}</td>
                <td className="py-3 pr-4 text-right">
                  <div className="font-semibold text-slate-700">{p.score ?? 0}</div>
                  <div className="text-[11px] text-slate-400">{p.grade || '-'}</div>
                </td>
                <td className="py-3 pr-4 min-w-52">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${statusClass(p.status)}`}>
                    {p.status === 'good' ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                    {p.decision}
                  </span>
                  <div className="text-xs text-slate-400 mt-1">{p.reason}</div>
                </td>
              </tr>
            ))}
            {!products.length && (
              <tr><td colSpan="10" className="py-8 text-center text-slate-400">这个筛选下没有产品。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function statusClass(status) {
  if (status === 'good') return 'bg-green-50 text-green-700'
  if (status === 'bad') return 'bg-red-50 text-red-700'
  if (status === 'warn') return 'bg-amber-50 text-amber-700'
  return 'bg-slate-100 text-slate-600'
}
