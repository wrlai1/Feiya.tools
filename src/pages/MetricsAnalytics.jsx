import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  BarChart, Bar, ComposedChart, Legend, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  AlertTriangle, BarChart3, Calendar, CheckCircle, Package, Plus,
  Download, History, NotebookPen, RotateCcw, Save, Trash2, TrendingUp, Upload, X,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import KPICard from '../components/KPICard.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseCSV } from '../utils/autoDeductEngine.js'
import {
  fetchStores, createStore, deleteStore, saveStoreDay, fetchStoreRange, deleteStoreRange,
  fetchStoreProducts, saveStoreProducts, fetchAnalyticsSettings, saveAnalyticsSettings,
  fetchAnalyticsEvents, restoreAnalyticsEvent, fetchDailyLogs, saveDailyLog as saveDailyLogApi,
} from '../utils/api.js'
import { formatISODate, loadSalesSummary } from '../utils/salesSummary.js'
import { buildSmartDecisions } from '../utils/smartDecisionEngine.js'

const todayISO = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

const MONEY_COLS = ['花费', '销售额', '申报价', '成本', '价格', '毛利', '售价', 'Coupon']
const RATE_COLS = ['率', '费比', '折扣']
const FALLBACK_CNY_TO_USD = 0.14
const DEFAULT_MONEY_CURRENCY = 'CNY'
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
const TREND_METRICS = [
  { key: 'dailyUnits', label: 'Daily Units', type: 'count', axis: 'left', color: '#1d4ed8' },
  { key: 'units', label: 'Units', type: 'count', axis: 'left', color: '#2563eb' },
  { key: 'revenue', label: 'Revenue', type: 'money', axis: 'left', color: '#14b8a6' },
  { key: 'spend', label: 'Spend', type: 'money', axis: 'left', color: '#8b5cf6' },
  { key: 'ctr', label: 'CTR', type: 'percent', axis: 'right', color: '#22c55e' },
  { key: 'conversionRate', label: 'Conversion', type: 'percent', axis: 'right', color: '#f97316' },
  { key: 'orders', label: 'Orders', type: 'count', axis: 'left', color: '#0f766e' },
  { key: 'roas', label: 'ROAS', type: 'ratio', axis: 'right', color: '#dc2626' },
  { key: 'impressions', label: 'Impressions', type: 'count', axis: 'left', color: '#64748b' },
  { key: 'clicks', label: 'Clicks', type: 'count', axis: 'left', color: '#0ea5e9' },
  { key: 'carts', label: 'Carts', type: 'count', axis: 'left', color: '#f59e0b' },
]
const DEFAULT_TREND_METRICS = ['dailyUnits', 'revenue', 'spend', 'ctr', 'conversionRate']
const PRODUCT_TEXT_FIELDS = ['sku', 'productName', 'notes', 'category', 'sizeLine', 'lifecycle', 'skuType']
const PRODUCT_NUMBER_FIELDS = ['unitMultiplier', 'cost', 'declaredPrice', 'frontPrice', 'couponPrice', 'grossProfit']
const PRODUCT_PERCENT_FIELDS = ['grossMargin', 'discountRate']
const EXCHANGE_RATE_SOURCES = [
  {
    name: 'Frankfurter',
    url: 'https://api.frankfurter.app/latest?from=CNY&to=USD',
    read: (data) => data?.rates?.USD,
  },
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/CNY',
    read: (data) => data?.rates?.USD,
  },
]
let exchangeRateCache = null
const PRODUCT_EDIT_FIELDS = [
  ['sku', 'SKU', 'text'],
  ['productName', '商品名', 'text'],
  ['notes', '备注', 'textarea'],
  ['unitMultiplier', 'Unit 数量', 'number'],
  ['category', '品类', 'text'],
  ['lifecycle', '生命周期', 'text'],
  ['skuType', 'SKU 类型', 'text'],
  ['cost', '成本 $', 'number'],
  ['declaredPrice', '申报价 $', 'number'],
  ['frontPrice', '前端售价 $', 'number'],
  ['couponPrice', 'Coupon 后价 $', 'number'],
  ['grossProfit', '毛利 $', 'number'],
  ['grossMargin', '毛利率 %', 'percent'],
]

function normalizeId(v) {
  const s = String(v ?? '').trim()
  if (!s || s === 'nan' || s === 'null' || s === 'undefined') return ''
  return s.replace(/\.0$/, '')
}

function normalizeStoreName(v) {
  return String(v ?? '').trim().toLowerCase()
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

function detectCurrency(v, key = '', fileName = '') {
  const text = `${v ?? ''} ${key} ${fileName}`.toUpperCase()
  if (/USD|US\$|\$/.test(text)) return 'USD'
  if (/RMB|CNY|CN¥|¥|￥/.test(text)) return 'CNY'
  return DEFAULT_MONEY_CURRENCY
}

async function fetchCnyToUsdRate() {
  const today = todayISO()
  if (exchangeRateCache?.date === today) return exchangeRateCache

  for (const source of EXCHANGE_RATE_SOURCES) {
    try {
      const res = await fetch(source.url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const rate = Number(source.read(data))
      if (Number.isFinite(rate) && rate > 0) {
        exchangeRateCache = {
          date: today,
          rate,
          source: source.name,
          fetchedAt: new Date().toISOString(),
          fallback: false,
        }
        return exchangeRateCache
      }
    } catch {
      // Try the next public exchange-rate source, then fall back below.
    }
  }

  exchangeRateCache = {
    date: today,
    rate: FALLBACK_CNY_TO_USD,
    source: 'fallback',
    fetchedAt: new Date().toISOString(),
    fallback: true,
  }
  return exchangeRateCache
}

function moneyToUsd(v, key = '', fileName = '', exchangeRate = { rate: FALLBACK_CNY_TO_USD, source: 'fallback', fallback: true }) {
  const amount = toNumber(v, key)
  if (amount == null) return { value: null, currency: detectCurrency(v, key, fileName), rate: null, original: null }
  const currency = detectCurrency(v, key, fileName)
  const rate = currency === 'CNY' ? exchangeRate.rate : 1
  return {
    value: amount * rate,
    currency,
    rate,
    original: amount,
    rateSource: currency === 'CNY' ? exchangeRate.source : 'native USD',
    rateFetchedAt: currency === 'CNY' ? exchangeRate.fetchedAt : null,
    rateFallback: currency === 'CNY' ? exchangeRate.fallback : false,
  }
}

function summarizeCurrencies(rows, exchangeRate) {
  const counts = rows.reduce((acc, row) => {
    const currency = row.sourceCurrency || DEFAULT_MONEY_CURRENCY
    acc[currency] = (acc[currency] || 0) + 1
    return acc
  }, {})
  const currencies = Object.keys(counts)
  return {
    primary: currencies.length === 1 ? currencies[0] : 'MIXED',
    counts,
    cnyToUsd: exchangeRate?.rate || FALLBACK_CNY_TO_USD,
    rateSource: exchangeRate?.source || 'fallback',
    rateFallback: Boolean(exchangeRate?.fallback),
    rateFetchedAt: exchangeRate?.fetchedAt || null,
  }
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

function formatEventTime(value) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString()
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
        notes: String(r['备注'] ?? r['Notes'] ?? '').trim(),
        unitMultiplier: toNumber(r['Unit'] ?? r['unit'] ?? r['Unit数量'] ?? r['组合数量'] ?? r['件数倍率']) || 1,
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
  const exchangeRate = await fetchCnyToUsdRate()
  const raw = await readSheetRows(file)
  const { start, end } = dateRangeFromFileName(file.name)
  const rows = raw
    .filter((r) => !isSummaryRow(r))
    .map((r) => {
      const spu = normalizeId(r['SPU ID'] ?? r['SPU/款号'] ?? r['SPU'])
      if (!spu) return null
      const spendMoney = moneyToUsd(r['总花费'], '总花费', file.name, exchangeRate)
      const netSpendMoney = moneyToUsd(r['净总花费'], '净总花费', file.name, exchangeRate)
      const revenueMoney = moneyToUsd(r['申报价销售额（全域）'], '申报价销售额（全域）', file.name, exchangeRate)
      const netRevenueMoney = moneyToUsd(r['净申报价销售额（全域）'], '净申报价销售额（全域）', file.name, exchangeRate)
      const cpaMoney = moneyToUsd(r['每笔成交花费（全域）'], '每笔成交花费（全域）', file.name, exchangeRate)
      return {
        spu,
        productId: normalizeId(r['商品ID']),
        productName: String(r['商品名称'] ?? '').trim(),
        color: String(r['颜色'] ?? r['商品颜色'] ?? r['SKU颜色'] ?? r['Color'] ?? r['color'] ?? '').trim(),
        region: String(r['当前区域'] ?? '').trim(),
        site: String(r['商品站点'] ?? '').trim(),
        spend: spendMoney.value,
        spendOriginal: spendMoney.original,
        netSpend: netSpendMoney.value,
        netSpendOriginal: netSpendMoney.original,
        revenue: revenueMoney.value,
        revenueOriginal: revenueMoney.original,
        netRevenue: netRevenueMoney.value,
        netRevenueOriginal: netRevenueMoney.original,
        roas: toNumber(r['投资回报率(ROAS)（全域）']),
        netRoas: toNumber(r['净投资回报率(ROAS)（全域）']),
        costRatio: toNumber(r['费比（全域）'], '费比'),
        cpa: cpaMoney.value,
        cpaOriginal: cpaMoney.original,
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
        sourceCurrency: revenueMoney.currency || spendMoney.currency || DEFAULT_MONEY_CURRENCY,
        currencyRateToUsd: revenueMoney.rate || spendMoney.rate || exchangeRate.rate,
        currencyRateSource: revenueMoney.rateSource || spendMoney.rateSource || exchangeRate.source,
        currencyRateFetchedAt: revenueMoney.rateFetchedAt || spendMoney.rateFetchedAt || exchangeRate.fetchedAt,
        currencyRateFallback: revenueMoney.rateFallback || spendMoney.rateFallback || exchangeRate.fallback,
      }
    })
    .filter(Boolean)
  if (!rows.length) throw new Error('没有找到带 SPU ID 的商品推广数据')
  return { rows, start, end, fileName: file.name, currencySummary: summarizeCurrencies(rows, exchangeRate) }
}

function sum(rows, key) {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0)
}

function unitMultiplier(product) {
  const n = Number(product?.unitMultiplier)
  return Number.isFinite(n) && n > 0 ? n : 1
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
    const rawUnits = sum(group, 'units')
    const multiplier = unitMultiplier(product)
    const units = rawUnits * multiplier
    const grossProfitEstimate = product.grossProfit ? product.grossProfit * units : null
    const out = {
      spu,
      sku: product.sku || '',
      productName: product.productName || group.find((r) => r.productName)?.productName || spu,
      category: product.category || '',
      lifecycle: product.lifecycle || '',
      skuType: product.skuType || '',
      newProductImportedAt: product.newProductImportedAt || null,
      isNewProduct: Boolean(product.newProductImportedAt || /新品|new/i.test(product.lifecycle || '')),
      unitMultiplier: multiplier,
      frontPrice: product.frontPrice ?? null,
      couponPrice: product.couponPrice ?? null,
      grossMargin: product.grossMargin ?? null,
      spend,
      revenue,
      impressions,
      clicks,
      carts,
      orders,
      rawUnits,
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

function aggregateTotals(rows, products = []) {
  const productMap = new Map(products.map((p) => [p.spu, p]))
  const spend = sum(rows, 'spend')
  const revenue = sum(rows, 'revenue')
  const impressions = sum(rows, 'impressions')
  const clicks = sum(rows, 'clicks')
  const carts = sum(rows, 'carts')
  const orders = sum(rows, 'orders')
  const units = rows.reduce((total, row) => {
    const product = productMap.get(row.spu)
    return total + ((Number(row.units) || 0) * unitMultiplier(product))
  }, 0)
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

function productIdentity(product) {
  return {
    spu: normalizeId(product?.spu),
    sku: normalizeId(product?.sku),
  }
}

function uniqueProductPlanRows(rows) {
  const map = new Map()
  const duplicateSpus = new Set()
  for (const row of rows) {
    const { spu } = productIdentity(row)
    if (!spu) continue
    if (map.has(spu)) duplicateSpus.add(spu)
    map.set(spu, row)
  }
  return { rows: [...map.values()], duplicateSpus: [...duplicateSpus] }
}

function findProductPlanDuplicates(incoming, existing) {
  const existingSpus = new Set()
  const existingSkus = new Set()
  for (const product of existing) {
    const { spu, sku } = productIdentity(product)
    if (spu) existingSpus.add(spu)
    if (sku) existingSkus.add(sku)
  }
  return incoming.filter((product) => {
    const { spu, sku } = productIdentity(product)
    return (spu && existingSpus.has(spu)) || (sku && existingSkus.has(sku))
  })
}

function mergeProductPlans(existing, incoming, overwriteDuplicates) {
  const incomingSpus = new Set(incoming.map((p) => productIdentity(p).spu).filter(Boolean))
  const incomingSkus = new Set(incoming.map((p) => productIdentity(p).sku).filter(Boolean))
  const base = existing.filter((product) => {
    const { spu, sku } = productIdentity(product)
    const duplicated = (spu && incomingSpus.has(spu)) || (sku && incomingSkus.has(sku))
    return overwriteDuplicates ? !duplicated : true
  })
  const additions = overwriteDuplicates
    ? incoming
    : incoming.filter((product) => {
      const { spu, sku } = productIdentity(product)
      return !existing.some((item) => {
        const current = productIdentity(item)
        return (spu && current.spu === spu) || (sku && current.sku === sku)
      })
    })
  return [...base, ...additions]
}

function annotateNewProductPlans(existing, incoming, fileName) {
  const existingSpus = new Set(existing.map((p) => productIdentity(p).spu).filter(Boolean))
  const existingSkus = new Set(existing.map((p) => productIdentity(p).sku).filter(Boolean))
  const importedAt = new Date().toISOString()
  return incoming.map((product) => {
    const { spu, sku } = productIdentity(product)
    const isNew = (spu && !existingSpus.has(spu)) && (!sku || !existingSkus.has(sku))
    if (!isNew) return product
    const name = product.productName || product.sku || product.spu
    return {
      ...product,
      newProductName: name,
      newProductImportedAt: importedAt,
      newProductSourceFile: fileName || null,
    }
  })
}

function newProductPlanNames(existing, incoming) {
  const existingSpus = new Set(existing.map((p) => productIdentity(p).spu).filter(Boolean))
  const existingSkus = new Set(existing.map((p) => productIdentity(p).sku).filter(Boolean))
  return incoming
    .filter((product) => {
      const { spu, sku } = productIdentity(product)
      return (spu && !existingSpus.has(spu)) && (!sku || !existingSkus.has(sku))
    })
    .map((product) => product.productName || product.sku || product.spu)
    .filter(Boolean)
}

function duplicatePreview(rows) {
  return rows.slice(0, 6).map((r) => r.sku || r.spu).filter(Boolean).join(', ')
}

function unmatchedPerformanceGroups(rows, products) {
  const knownSpus = new Set(products.map((p) => normalizeId(p.spu)).filter(Boolean))
  const groups = new Map()
  for (const row of rows || []) {
    const spu = normalizeId(row.spu)
    if (!spu || knownSpus.has(spu)) continue
    if (!groups.has(spu)) {
      groups.set(spu, {
        spu,
        rows: 0,
        productName: row.productName || '',
        spend: 0,
        units: 0,
        revenue: 0,
      })
    }
    const group = groups.get(spu)
    group.rows += 1
    group.spend += Number(row.spend) || 0
    group.units += Number(row.units) || 0
    group.revenue += Number(row.revenue) || 0
    if (!group.productName && row.productName) group.productName = row.productName
  }
  return [...groups.values()].sort((a, b) => (b.units || 0) - (a.units || 0))
}

function blankProduct(store) {
  return {
    store,
    spu: '',
    sku: '',
    productName: '',
    notes: '',
    unitMultiplier: 1,
    category: '',
    sizeLine: '',
    lifecycle: '',
    skuType: '',
    cost: null,
    declaredPrice: null,
    frontPrice: null,
    couponPrice: null,
    grossProfit: null,
    grossMargin: null,
    discountRate: null,
  }
}

function normalizeProductDraft(draft, store) {
  const product = { ...draft, store, spu: normalizeId(draft?.spu) }
  PRODUCT_TEXT_FIELDS.forEach((key) => {
    product[key] = String(draft?.[key] ?? '').trim()
  })
  product.sku = normalizeId(product.sku)
  PRODUCT_NUMBER_FIELDS.forEach((key) => {
    product[key] = toNumber(draft?.[key], '价格')
  })
  product.unitMultiplier = Number(product.unitMultiplier) > 0 ? Number(product.unitMultiplier) : 1
  PRODUCT_PERCENT_FIELDS.forEach((key) => {
    const n = Number(draft?.[key])
    product[key] = Number.isFinite(n) ? n : null
  })
  return product
}

function daySeries(rows, products = []) {
  const days = new Map()
  for (const r of rows) {
    const day = r.date || r.periodEnd || todayISO()
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(r)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, rs]) => {
    const t = aggregateTotals(rs, products)
    return {
      day,
      units: t.units,
      orders: t.orders,
      spend: t.spend,
      revenue: t.revenue,
      dailyUnits: t.units,
      impressions: t.impressions,
      clicks: t.clicks,
      carts: t.carts,
      roas: t.roas || 0,
      ctr: t.ctr || 0,
      cartRate: t.cartRate || 0,
      conversionRate: t.conversionRate || 0,
    }
  })
}

function timeframeRange(tf, customFrom, customTo, anchorDay = todayISO()) {
  const to = anchorDay || todayISO()
  if (tf === 'yesterday') {
    const day = addDaysISO(to, -1)
    return { from: day, to: day }
  }
  if (tf === '7d' || tf === '14d' || tf === '30d') {
    const days = tf === '7d' ? 7 : tf === '14d' ? 14 : 30
    return { from: addDaysISO(to, -(days - 1)), to }
  }
  if (tf === 'custom') return { from: customFrom, to: customTo }
  return { from: to, to }
}

function addDaysISO(day, amount) {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + amount)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

function dateSpan(from, to, maxDays = 62) {
  if (!from || !to) return []
  const start = from <= to ? from : to
  const end = from <= to ? to : from
  const out = []
  let current = start
  while (current <= end && out.length < maxDays) {
    out.push(current)
    current = addDaysISO(current, 1)
  }
  return out
}

function missingDaysInRange(range, savedDays) {
  const days = dateSpan(range.from, range.to, 62)
  const saved = new Set((savedDays || []).map((d) => d.day))
  return days.filter((day) => !saved.has(day))
}

export default function MetricsAnalytics() {
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const initialStore = searchParams.get('store') || ''
  const initialProduct = normalizeId(searchParams.get('spu'))
  const deepLinkScrollPending = useRef(Boolean(initialProduct))
  const [stores, setStores] = useState([])
  const [activeStore, setActiveStore] = useState(initialStore)
  const [newStore, setNewStore] = useState('')
  const [products, setProducts] = useState([])
  const [storeRows, setStoreRows] = useState([])
  const [storeDays, setStoreDays] = useState([])
  const [dailyLogs, setDailyLogs] = useState([])
  const [dailyLogSaving, setDailyLogSaving] = useState(false)
  const [previousStoreRows, setPreviousStoreRows] = useState([])
  const [previousStoreDays, setPreviousStoreDays] = useState(null)
  const [draftReport, setDraftReport] = useState(null)
  const [uploadDate, setUploadDate] = useState(todayISO())
  const [timeframe, setTimeframe] = useState('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [metricX, setMetricX] = useState('ctr')
  const [tableFilter, setTableFilter] = useState('all')
  const [matrixSort, setMatrixSort] = useState('units_desc')
  const [matrixQuery, setMatrixQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState(initialProduct)
  const [autoFocusProduct, setAutoFocusProduct] = useState(!initialProduct)
  const [storeComparison, setStoreComparison] = useState([])
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false)
  const [deleteFrom, setDeleteFrom] = useState('')
  const [deleteTo, setDeleteTo] = useState('')
  const [analyticsEvents, setAnalyticsEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [uploadConflict, setUploadConflict] = useState(null)
  const [uploadSummary, setUploadSummary] = useState(null)
  const [storeHealth, setStoreHealth] = useState([])
  const [storeHealthLoading, setStoreHealthLoading] = useState(false)
  const [crossStoreProducts, setCrossStoreProducts] = useState([])
  const [salesSummary, setSalesSummary] = useState(null)
  const [salesSummaryLoading, setSalesSummaryLoading] = useState(false)

  const activeDataDay = useMemo(() => {
    const value = stores.find((store) => store.name === activeStore)?.last_day
    return String(value || todayISO()).slice(0, 10)
  }, [stores, activeStore])
  const currentRange = useMemo(
    () => timeframeRange(timeframe, customFrom, customTo, activeDataDay),
    [timeframe, customFrom, customTo, activeDataDay],
  )
  const previousRange = useMemo(() => {
    const days = dateSpan(currentRange.from, currentRange.to, 62).length
    if (!days || !currentRange.from) return { from: '', to: '' }
    return {
      from: addDaysISO(currentRange.from, -days),
      to: addDaysISO(currentRange.from, -1),
    }
  }, [currentRange])

  const reloadStores = useCallback(async () => {
    try {
      const res = await fetchStores()
      const baseStores = res.stores || []
      const withCounts = await Promise.all(baseStores.map(async (store) => {
        const productRes = await fetchStoreProducts(store.name).catch(() => ({ products: [] }))
        return { ...store, spuCount: productRes.products?.length || 0 }
      }))
      setStores(withCounts)
    } catch (err) {
      setStores([])
    }
  }, [])

  useEffect(() => { reloadStores() }, [reloadStores])

  useEffect(() => {
    let cancelled = false
    if (!stores.length) {
      setSalesSummary(null)
      return () => { cancelled = true }
    }
    setSalesSummaryLoading(true)
    loadSalesSummary(stores)
      .then((summary) => { if (!cancelled) setSalesSummary(summary) })
      .catch(() => { if (!cancelled) setSalesSummary(null) })
      .finally(() => { if (!cancelled) setSalesSummaryLoading(false) })
    return () => { cancelled = true }
  }, [stores])

  const loadProducts = useCallback(async (store) => {
    if (!store) { setProducts([]); return }
    try {
      const res = await fetchStoreProducts(store)
      setProducts(res.products || [])
    } catch {
      setProducts([])
    }
  }, [])

  const loadAnalyticsEvents = useCallback(async () => {
    setEventsLoading(true)
    try {
      const res = await fetchAnalyticsEvents(activeStore || '', 50)
      setAnalyticsEvents(res.events || [])
    } catch {
      setAnalyticsEvents([])
    } finally {
      setEventsLoading(false)
    }
  }, [activeStore])

  const loadWindow = useCallback(async () => {
    if (!activeStore) { setStoreRows([]); setStoreDays([]); setDailyLogs([]); return }
    const { from, to } = timeframeRange(timeframe, customFrom, customTo, activeDataDay)
    if (!from || !to) return
    setLoading(true)
    try {
      const [res, logRes] = await Promise.all([
        fetchStoreRange(activeStore, from, to),
        fetchDailyLogs(activeStore, from, to).catch(() => ({ logs: [] })),
      ])
      setStoreRows(res.rows || [])
      setStoreDays(res.days || [])
      setDailyLogs(logRes.logs || [])
    } catch (err) {
      toast.error(err.message, '表现数据读取失败')
      setStoreRows([]); setStoreDays([]); setDailyLogs([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, timeframe, customFrom, customTo, activeDataDay])

  const handleSaveDailyLog = async (day, note) => {
    if (!activeStore || !day) return false
    setDailyLogSaving(true)
    try {
      await saveDailyLogApi(activeStore, day, note)
      const trimmed = note.trim()
      setDailyLogs((current) => {
        const next = current.filter((item) => item.day !== day)
        if (trimmed) next.push({ day, note: trimmed })
        return next.sort((a, b) => a.day.localeCompare(b.day))
      })
      toast.success(trimmed ? `${day} 的日志已保存` : `${day} 的日志已清除`, 'Daily Log')
      return true
    } catch (err) {
      toast.error(err.message, '日志保存失败')
      return false
    } finally {
      setDailyLogSaving(false)
    }
  }

  useEffect(() => {
    loadProducts(activeStore)
  }, [activeStore, loadProducts])

  useEffect(() => {
    loadWindow()
  }, [loadWindow])

  useEffect(() => {
    let cancelled = false
    if (!activeStore || !previousRange.from || !previousRange.to) {
      setPreviousStoreRows([])
      setPreviousStoreDays(null)
      return () => { cancelled = true }
    }
    setPreviousStoreRows([])
    setPreviousStoreDays(null)
    fetchStoreRange(activeStore, previousRange.from, previousRange.to)
      .then((res) => {
        if (!cancelled) {
          setPreviousStoreRows(res.rows || [])
          setPreviousStoreDays(res.days || [])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviousStoreRows([])
          setPreviousStoreDays([])
        }
      })
    return () => { cancelled = true }
  }, [activeStore, previousRange])

  useEffect(() => {
    if (storeSettingsOpen) loadAnalyticsEvents()
  }, [storeSettingsOpen, loadAnalyticsEvents])

  useEffect(() => {
    if (currentRange.from && currentRange.to) {
      setDeleteFrom(currentRange.from)
      setDeleteTo(currentRange.to)
    }
  }, [activeStore, currentRange.from, currentRange.to])

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
  const unmatchedDraftSpus = useMemo(
    () => unmatchedPerformanceGroups(draftReport?.rows || [], products),
    [draftReport, products],
  )
  const totals = useMemo(() => aggregateTotals(visibleRows, products), [visibleRows, products])
  const productRows = useMemo(() => aggregateBySpu(visibleRows, products, targets), [visibleRows, products, targets])
  const previousProductRows = useMemo(
    () => aggregateBySpu(previousStoreRows, products, targets),
    [previousStoreRows, products, targets],
  )
  const starProduct = productRows[0] || null
  const productChoices = useMemo(() => {
    const map = new Map()
    for (const p of [...products, ...productRows]) {
      if (!p?.spu) continue
      map.set(p.spu, { ...map.get(p.spu), ...p })
    }
    return [...map.values()].sort((a, b) => String(a.sku || a.spu).localeCompare(String(b.sku || b.spu)))
  }, [products, productRows])
  const catalogChoices = useMemo(
    () => products.filter((p) => p?.spu).sort((a, b) => String(a.sku || a.spu).localeCompare(String(b.sku || b.spu))),
    [products],
  )
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
  const selectedTotals = useMemo(() => aggregateTotals(selectedRows, products), [selectedRows, products])
  const selectedTrends = useMemo(() => daySeries(selectedRows, products), [selectedRows, products])
  const selectedProductSummary = useMemo(
    () => aggregateBySpu(selectedRows, products, targets)[0] || selectedProductMatches[0] || null,
    [selectedRows, products, selectedProductMatches, targets],
  )
  const trends = useMemo(() => daySeries(visibleRows, products), [visibleRows, products])
  const dailyStats = useMemo(() => {
    const map = {}
    for (const item of daySeries(storeRows, products)) map[item.day] = item
    return map
  }, [storeRows, products])
  const anomalies = useMemo(
    () => buildSmartDecisions({
      products: productRows,
      previousProducts: previousProductRows,
      crossStoreProducts,
      activeStore,
      missingDays: missingDaysInRange(currentRange, storeDays),
      previousMissingDays: previousStoreDays === null ? null : missingDaysInRange(previousRange, previousStoreDays),
      totals,
      trends,
      settings: targets,
    }),
    [productRows, previousProductRows, crossStoreProducts, activeStore, totals, trends, storeDays, previousStoreDays, currentRange, previousRange, targets],
  )
  const relationPoints = useMemo(() => productRows
    .map((p) => ({ ...p, x: p[metricX], y: p.units }))
    .filter((p) => p.x != null && p.y != null), [productRows, metricX])
  const filteredProducts = useMemo(() => {
    const q = matrixQuery.trim().toLowerCase()
    const filtered = productRows.filter((p) => {
      if (tableFilter !== 'all' && p.status !== tableFilter) return false
      if (!q) return true
      return [p.spu, p.sku, p.productName, p.category, p.lifecycle, p.decision]
        .some((v) => String(v || '').toLowerCase().includes(q))
    })
    const [key, dir] = matrixSort.split('_')
    const sorted = [...filtered].sort((a, b) => {
      const av = Number(a[key]) || 0
      const bv = Number(b[key]) || 0
      return dir === 'asc' ? av - bv : bv - av
    })
    return sorted
  }, [productRows, tableFilter, matrixSort, matrixQuery])

  useEffect(() => {
    const isInitialDeepLink = initialProduct
      && activeStore === initialStore
      && timeframe === '7d'
      && !customFrom
      && !customTo
    if (isInitialDeepLink) {
      setAutoFocusProduct(false)
      setSelectedProduct(initialProduct)
      return
    }
    setAutoFocusProduct(true)
    setSelectedProduct('')
  }, [activeStore, timeframe, customFrom, customTo, initialProduct, initialStore])

  useEffect(() => {
    if (!deepLinkScrollPending.current || !selectedProduct || !productChoices.length) return
    deepLinkScrollPending.current = false
    document.getElementById('spu-sku-focus')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedProduct, productChoices])

  useEffect(() => {
    if (!autoFocusProduct || selectedProduct || !starProduct) return
    setSelectedProduct(starProduct.sku || starProduct.spu)
  }, [autoFocusProduct, selectedProduct, starProduct])

  useEffect(() => {
    let cancelled = false
    async function loadStoreComparison() {
      const query = normalizeId(selectedProduct)
      if (!query || !stores.length) { setStoreComparison([]); return }
      const { from, to } = currentRange
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
            ...aggregateTotals(matchingRows, matchingProducts),
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
  }, [selectedProduct, stores, currentRange, targets])

  useEffect(() => {
    let cancelled = false
    async function loadStoreHealth() {
      if (!stores.length) { setStoreHealth([]); setCrossStoreProducts([]); return }
      const { from, to } = currentRange
      if (!from || !to) return
      setStoreHealthLoading(true)
      setCrossStoreProducts([])
      try {
        const rangeDays = dateSpan(from, to, 62)
        const results = await Promise.all(stores.map(async (store) => {
          const storeName = store.name
          const [productRes, rangeRes] = await Promise.all([
            fetchStoreProducts(storeName).catch(() => ({ products: [] })),
            fetchStoreRange(storeName, from, to).catch(() => ({ rows: [], days: [] })),
          ])
          const storeProducts = productRes.products || []
          const rangeRows = rangeRes.rows || []
          const totalsForStore = aggregateTotals(rangeRows, storeProducts)
          const productsForStore = aggregateBySpu(rangeRows, storeProducts, targets)
          const saved = new Set((rangeRes.days || []).map((d) => d.day))
          const missing = rangeDays.filter((day) => !saved.has(day))
          const attention = productsForStore.filter((p) => p.status === 'bad' || p.decision === '点击有，转化弱' || p.decision === '花费无单，控预算').length
          return {
            health: {
              store: storeName,
              spuCount: store.spuCount || storeProducts.length || 0,
              days: rangeRes.days?.length || 0,
              missingDays: missing.length,
              attention,
              ...totalsForStore,
            },
            products: productsForStore.map((product) => ({ ...product, store: storeName })),
          }
        }))
        if (!cancelled) {
          setStoreHealth(results.map((result) => result.health).sort((a, b) => (b.units || 0) - (a.units || 0)))
          setCrossStoreProducts(results.flatMap((result) => result.products))
        }
      } finally {
        if (!cancelled) setStoreHealthLoading(false)
      }
    }
    loadStoreHealth()
    return () => { cancelled = true }
  }, [stores, currentRange, targets])

  const saveTargets = async (nextTargets) => {
    const normalized = { ...DEFAULT_TARGETS, ...nextTargets }
    setTargets(normalized)
    try {
      await saveAnalyticsSettings(activeStore || '', normalized)
      await loadAnalyticsEvents()
      toast.success(activeStore ? `${activeStore} 的目标已保存` : '默认目标已保存', 'Analytics Settings')
    } catch (err) {
      toast.error(err.message, '目标保存失败')
    }
  }

  const focusProduct = useCallback((product) => {
    const value = product?.sku || product?.spu || product?.label || ''
    if (!value) return
    setAutoFocusProduct(false)
    setSelectedProduct(value)
    window.requestAnimationFrame(() => {
      document.getElementById('spu-sku-focus')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const handleCreateStore = async () => {
    const name = newStore.trim()
    if (!name) return
    try {
      await createStore(name)
      setNewStore('')
      setActiveStore(name)
      await reloadStores()
      await loadAnalyticsEvents()
    } catch (err) {
      toast.error(err.message, '店铺创建失败')
    }
  }

  const handleDeleteStore = async (name) => {
    const typed = window.prompt(`删除店铺会移除 ${name} 的每日数据、产品档案和目标设置。\n\n请输入店铺名 "${name}" 来确认删除：`)
    if (typed !== name) {
      if (typed != null) toast.info('店铺名不匹配，已取消删除', '删除已取消')
      return
    }
    try {
      await deleteStore(name)
      if (activeStore === name) setActiveStore('')
      setStoreSettingsOpen(false)
      await reloadStores()
      await loadAnalyticsEvents()
    } catch (err) {
      toast.error(err.message, '店铺删除失败')
    }
  }

  const handleSaveProduct = async (draft) => {
    if (!activeStore) { toast.error('请先选择店铺', '不能保存 SPU'); return false }
    const product = normalizeProductDraft(draft, activeStore)
    if (!product.spu) { toast.error('SPU 不能为空', '不能保存 SPU'); return false }
    const duplicateSku = product.sku && products.some((p) => normalizeId(p.sku) === product.sku && normalizeId(p.spu) !== product.spu)
    if (duplicateSku && !window.confirm(`SKU ${product.sku} 已经存在于其他 SPU。\n\n点击 OK 继续保存，点击 Cancel 返回修改。`)) return false
    const index = products.findIndex((p) => normalizeId(p.spu) === product.spu)
    const next = index >= 0
      ? products.map((p, i) => i === index ? { ...p, ...product, store: activeStore } : p)
      : [...products, product]
    try {
      await saveStoreProducts(activeStore, next, 'manual-product-edit')
      setProducts(next)
      await reloadStores()
      await loadAnalyticsEvents()
      toast.success(`${product.sku || product.spu} 已保存到 ${activeStore}`, index >= 0 ? 'SPU 已更新' : 'SPU 已新增')
      return true
    } catch (err) {
      toast.error(err.message, 'SPU 保存失败')
      return false
    }
  }

  const handleDeleteProduct = async (product) => {
    if (!activeStore || !product?.spu) return false
    const label = product.sku || product.spu
    if (!window.confirm(`确认从 ${activeStore} 的产品档案里删除 ${label}？\n\n历史每日表现数据不会删除，但这个 SPU 的档案信息会移除。`)) return false
    const next = products.filter((p) => normalizeId(p.spu) !== normalizeId(product.spu))
    try {
      await saveStoreProducts(activeStore, next, 'manual-product-delete')
      setProducts(next)
      await reloadStores()
      await loadAnalyticsEvents()
      toast.success(`${label} 已从产品档案移除`, 'SPU 已删除')
      return true
    } catch (err) {
      toast.error(err.message, 'SPU 删除失败')
      return false
    }
  }

  const handlePlanUpload = async (file) => {
    if (!activeStore) { toast.error('请先选择或创建店铺', '不能保存上新计划'); return }
    try {
      const rows = await parseProductPlan(file)
      const fileStores = [...new Set(rows.map((r) => String(r.store || '').trim()).filter(Boolean))]
      const mismatchedStores = fileStores.filter((name) => normalizeStoreName(name) !== normalizeStoreName(activeStore))
      if (mismatchedStores.length) {
        const ok = window.confirm(
          `这个上新计划文件里的店铺名称和当前店铺不一致。\n\n当前选择店铺：${activeStore}\n文件里的店铺：${mismatchedStores.slice(0, 6).join(', ')}${mismatchedStores.length > 6 ? ' ...' : ''}\n\n点击 OK = 仍然上传到当前店铺\n点击 Cancel = 取消上传，先检查店铺`,
        )
        if (!ok) {
          toast.info('已取消上传，请确认当前店铺是否正确。', '上新计划未保存')
          return
        }
      }
      const scoped = rows.map((r) => ({ ...r, store: activeStore }))
      const { rows: uniqueRows, duplicateSpus } = uniqueProductPlanRows(scoped)
      if (duplicateSpus.length) {
        toast.info(`文件里有 ${duplicateSpus.length} 个重复 SPU，已保留最后一条`, '上新计划去重')
      }
      const current = await fetchStoreProducts(activeStore).catch(() => ({ products: products || [] }))
      const existingProducts = current.products || []
      const duplicates = findProductPlanDuplicates(uniqueRows, existingProducts)
      let overwriteDuplicates = false
      if (duplicates.length) {
        overwriteDuplicates = window.confirm(`${activeStore} 已经有 ${duplicates.length} 个相同 SPU/SKU。\n\n重复项：${duplicatePreview(duplicates) || '见上传文件'}${duplicates.length > 6 ? ' ...' : ''}\n\n点击 OK = 覆盖这些重复产品\n点击 Cancel = 跳过这些重复产品，只导入新产品`)
      }
      const annotatedRows = annotateNewProductPlans(existingProducts, uniqueRows, file.name)
      const newNames = newProductPlanNames(existingProducts, uniqueRows)
      const merged = mergeProductPlans(existingProducts, annotatedRows, overwriteDuplicates).map((r) => ({ ...r, store: activeStore }))
      const addedCount = Math.max(0, merged.length - existingProducts.length)
      const skippedCount = overwriteDuplicates ? 0 : duplicates.length
      await saveStoreProducts(activeStore, merged, file.name)
      setProducts(merged)
      await reloadStores()
      await loadAnalyticsEvents()
      toast.success(
        `${uniqueRows.length - skippedCount} 个 SPU 已保存到 ${activeStore}${skippedCount ? `，跳过 ${skippedCount} 个重复` : ''}${addedCount ? `，新增 ${addedCount} 个` : ''}${newNames.length ? `：${newNames.slice(0, 3).join(', ')}${newNames.length > 3 ? ' ...' : ''}` : ''}`,
        overwriteDuplicates ? '重复产品已覆盖' : '上新计划已导入',
      )
    } catch (err) {
      toast.error(err.message, '上新计划读取失败')
    }
  }

  const handlePerformanceUpload = async (file) => {
    try {
      const report = await parsePerformanceFile(file)
      setDraftReport(report)
      setUploadConflict(null)
      setUploadDate(report.start === report.end ? report.start : report.end || todayISO())
      toast.success(`${report.rows.length} 个商品 · ${report.start} 到 ${report.end}`, '表现数据已读取')
    } catch (err) {
      toast.error(err.message, '表现数据读取失败')
    }
  }

  const addDraftSpuToCatalog = async (group) => {
    const product = {
      ...blankProduct(activeStore),
      spu: group.spu,
      productName: group.productName || group.spu,
      notes: `Added from performance upload ${draftReport?.fileName || ''}`.trim(),
    }
    await handleSaveProduct(product)
  }

  const removeDraftSpu = (spu) => {
    setDraftReport((prev) => {
      if (!prev) return prev
      const rows = prev.rows.filter((row) => normalizeId(row.spu) !== normalizeId(spu))
      return { ...prev, rows }
    })
    toast.info(`${spu} 已从本次上传删除`, '上传数据已更新')
  }

  const renameDraftSpu = (fromSpu, target) => {
    const matches = catalogChoices.filter((p) => matchesProductKey(p, target))
    const product = matches[0]
    if (!product?.spu) {
      toast.error('没有找到这个 SPU/SKU，请先加入产品档案或重新输入。', '无法修改 SPU')
      return
    }
    setDraftReport((prev) => {
      if (!prev) return prev
      const rows = prev.rows.map((row) => normalizeId(row.spu) === normalizeId(fromSpu)
        ? { ...row, spu: product.spu, productName: row.productName || product.productName }
        : row)
      return { ...prev, rows }
    })
    toast.success(`${fromSpu} 已改成 ${product.spu}`, '上传 SPU 已修改')
  }

  const saveDraft = async (saveMode = null) => {
    if (!activeStore || !draftReport) return
    if (!draftReport.rows.length) {
      toast.error('本次上传已经没有可保存的数据行。', '不能保存每日数据')
      return
    }
    if (unmatchedDraftSpus.length) {
      toast.error(`还有 ${unmatchedDraftSpus.length} 个 SPU 没有匹配产品档案，请先添加、修改或删除。`, '不能保存每日数据')
      return
    }
    const saveDate = uploadDate || todayISO()
    try {
      const existing = await fetchStoreRange(activeStore, saveDate, saveDate).catch(() => ({ rows: [] }))
      const existingRows = Array.isArray(existing.rows) ? existing.rows : []
      const hasExisting = existingRows.length > 0
      if (hasExisting && !saveMode) {
        setUploadConflict({
          store: activeStore,
          day: saveDate,
          existingRows: existingRows.length,
          newRows: draftReport.rows.length,
        })
        return
      }
      const mode = saveMode || 'overwrite'
      const nextRows = draftReport.rows.map((r) => ({ ...r, date: saveDate, reportDate: saveDate }))
      const rows = mode === 'append' ? [...existingRows, ...nextRows] : nextRows
      await saveStoreDay(activeStore, saveDate, draftReport.fileName, rows)
      toast.success(`${rows.length} 行保存到 ${activeStore} (${saveDate})`, mode === 'append' ? '已加到原有数据' : '每日数据已保存')
      setUploadSummary({
        store: activeStore,
        day: saveDate,
        mode,
        fileName: draftReport.fileName,
        newRows: nextRows.length,
        previousRows: existingRows.length,
        savedRows: rows.length,
        currencySummary: draftReport.currencySummary,
        unmatched: unmatchedDraftSpus.length,
      })
      setUploadConflict(null)
      setDraftReport(null)
      await reloadStores()
      await loadWindow()
      await loadAnalyticsEvents()
    } catch (err) {
      toast.error(err.message, '保存失败')
    }
  }

  const applyDeletePreset = (preset) => {
    const range = timeframeRange(preset, customFrom, customTo, activeDataDay)
    if (range.from && range.to) {
      setDeleteFrom(range.from)
      setDeleteTo(range.to)
    }
  }

  const deleteSelectedRange = async () => {
    try {
      if (!activeStore || !deleteFrom || !deleteTo) return
      const from = deleteFrom <= deleteTo ? deleteFrom : deleteTo
      const to = deleteFrom <= deleteTo ? deleteTo : deleteFrom
      const typed = window.prompt(`Delete analytics data for store "${activeStore}" from ${from} to ${to}.\n\nType the store name to confirm:`)
      if (typed !== activeStore) {
        if (typed != null) toast.info('店铺名不匹配，已取消删除', '删除已取消')
        return
      }
      const res = await deleteStoreRange(activeStore, from, to)
      await loadWindow()
      await reloadStores()
      await loadAnalyticsEvents()
      toast.success(`${res.days || 0} 个日期、${res.rows || 0} 行已删除，可在 Operation Log 恢复`, '数据已删除')
    } catch (err) {
      toast.error(err.message, '删除失败')
    }
  }

  const restoreEvent = async (eventId) => {
    try {
      if (!window.confirm(`Restore change #${eventId}?`)) return
      await restoreAnalyticsEvent(eventId)
      await loadWindow()
      await reloadStores()
      await loadProducts(activeStore)
      await loadAnalyticsEvents()
      toast.success('已恢复到该操作之前的快照', 'Restore complete')
    } catch (err) {
      toast.error(err.message, '恢复失败')
    }
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <FloatingStoreSwitcher
        stores={stores}
        activeStore={activeStore}
        setActiveStore={setActiveStore}
        summary={salesSummary}
        loading={salesSummaryLoading}
      />

      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Product Analytics</h1>
          <p className="text-slate-500 mt-1">按店铺和 SPU 追踪每天表现，看销量和点击率、转化率、加购、花费、ROAS 的关系。</p>
        </div>
      </div>

      <DateRangeControl
        timeframe={timeframe}
        setTimeframe={setTimeframe}
        customFrom={customFrom}
        customTo={customTo}
        setCustomFrom={setCustomFrom}
        setCustomTo={setCustomTo}
        loadWindow={loadWindow}
        activeStore={activeStore}
        loading={loading}
        storeDays={storeDays}
        anchorDay={activeDataDay}
        dailyLogs={dailyLogs}
        dailyStats={dailyStats}
        onSaveLog={handleSaveDailyLog}
        logSaving={dailyLogSaving}
      />

      <section className="card p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800">Stores</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeStore
                ? `当前店铺：${activeStore} · 显示数据：${currentRange.from && currentRange.to ? `${formatISODate(currentRange.from)} - ${formatISODate(currentRange.to)}` : '请选择时间'}`
                : '选择一个店铺后，上传、产品档案和数据分析都会绑定到这个店铺。'}
            </p>
          </div>
          <button onClick={() => setStoreSettingsOpen((v) => !v)} className="btn-secondary text-xs px-3 py-1.5">
            Store Settings
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {stores.map((s) => (
            <button
              key={s.name}
              onClick={() => setActiveStore(s.name)}
              className={`text-left rounded-lg border px-4 py-3 transition ${activeStore === s.name ? 'bg-blue-50 border-blue-300 text-blue-800 shadow-sm' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}
            >
              <div className="font-semibold truncate">{s.name}</div>
              <div className="text-xs mt-1 text-slate-400">{s.days || 0} saved days · {s.spuCount || 0} SPU</div>
            </button>
          ))}
          {!stores.length && <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-400">先到 Store Settings 里创建一个店铺。</div>}
        </div>

        <StoreHealthOverview
          rows={storeHealth}
          loading={storeHealthLoading}
          activeStore={activeStore}
          setActiveStore={setActiveStore}
        />

        {storeSettingsOpen && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-4">
            <div>
              <h3 className="font-semibold text-slate-700">Create Store</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <input className="metric-input" placeholder="New store name" value={newStore} onChange={(e) => setNewStore(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleCreateStore() }} />
                <button className="btn-primary text-sm px-3 py-2" onClick={handleCreateStore}><Plus className="w-4 h-4" /> Create store</button>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-700">Delete Performance Data</h3>
                  <p className="text-xs text-slate-500 mt-1">只删除当前店铺的数据。删除前会保存快照，可以在 Operation Log 里恢复。</p>
                </div>
                <span className="rounded-md bg-white px-2 py-1 text-xs text-slate-500 border border-slate-200">
                  {activeStore || 'No store selected'}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {[
                  ['7d', '7 天'],
                  ['14d', '14 天'],
                  ['30d', '30 天'],
                  ['today', '今天'],
                  ['yesterday', '昨天'],
                ].map(([key, label]) => (
                  <button key={key} type="button" onClick={() => applyDeletePreset(key)} className="btn-secondary text-xs px-3 py-1.5">
                    {label}
                  </button>
                ))}
                <button type="button" onClick={() => {
                  if (currentRange.from && currentRange.to) {
                    setDeleteFrom(currentRange.from)
                    setDeleteTo(currentRange.to)
                  }
                }} className="btn-secondary text-xs px-3 py-1.5">
                  当前显示范围
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <Calendar className="w-3.5 h-3.5" />
                <input type="date" className="metric-input !py-1" value={deleteFrom} onChange={(e) => setDeleteFrom(e.target.value)} />
                <span>to</span>
                <input type="date" className="metric-input !py-1" value={deleteTo} onChange={(e) => setDeleteTo(e.target.value)} />
                <button onClick={deleteSelectedRange} disabled={!activeStore || !deleteFrom || !deleteTo} className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-40">
                  <Trash2 className="w-4 h-4" /> Delete selected dates
                </button>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-700">Operation Log</h3>
                  <p className="text-xs text-slate-500 mt-1">记录谁在这个店铺做了上传、删除、设置修改和恢复。</p>
                </div>
                <button onClick={loadAnalyticsEvents} disabled={eventsLoading} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                  <History className="w-3.5 h-3.5" /> {eventsLoading ? 'Loading' : 'Refresh log'}
                </button>
              </div>
              <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white">
                {analyticsEvents.length ? analyticsEvents.map((event) => (
                  <div key={event.id} className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0">
                    <div>
                      <div className="text-sm font-medium text-slate-700">{event.summary || event.action}</div>
                      <div className="text-xs text-slate-400">
                        #{event.id} · {event.actor} · {formatEventTime(event.created_at)} · {event.details?.from && event.details?.to ? `${event.details.from} to ${event.details.to}` : event.details?.day || event.store || ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {event.details?.rows != null && <span className="text-xs text-slate-400">{event.details.rows} rows</span>}
                      <button onClick={() => restoreEvent(event.id)} disabled={!event.restorable} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                        <RotateCcw className="w-3.5 h-3.5" /> Restore
                      </button>
                    </div>
                  </div>
                )) : (
                  <div className="px-3 py-6 text-center text-sm text-slate-400">
                    No operations logged yet.
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="font-semibold text-red-700">Danger Zone</h3>
              <p className="text-xs text-slate-500 mt-1">删除店铺会删除它的每日数据、产品档案和分析目标。操作前必须输入完整店铺名。</p>
              <button onClick={() => handleDeleteStore(activeStore)} disabled={!activeStore} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-40">
                <Trash2 className="w-4 h-4" /> Delete current store
              </button>
            </div>
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
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-slate-800">1. 上新计划</h2>
              <p className="text-xs text-slate-400 mt-0.5">上传或更新当前店铺 SPU 档案。</p>
            </div>
            <span className="text-xs text-slate-500">{products.length} SPU</span>
          </div>
          <div className={`mb-2 rounded-lg px-3 py-1.5 text-xs ${activeStore ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
            {activeStore ? `上新计划会保存到：${activeStore}` : '请先选择或创建店铺，再上传上新计划。'}
          </div>
          <FileUploadZone compact onFile={handlePlanUpload} accept=".csv,.xlsx,.xls" label="Upload 上新计划.csv" acceptedTypes="CSV, XLSX" />
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-slate-800">2. 每日表现数据</h2>
              <p className="text-xs text-slate-400 mt-0.5">上传后先检查 SPU 是否能匹配产品档案。</p>
            </div>
            {draftReport && <span className="text-xs text-blue-600">{draftReport.start} to {draftReport.end}</span>}
          </div>
          <FileUploadZone compact onFile={handlePerformanceUpload} accept=".csv,.xlsx,.xls" label="Upload 商品推广数据" acceptedTypes="CSV, XLSX" />
          {draftReport && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">{draftReport.rows.length} rows from {draftReport.fileName}</span>
              {draftReport.currencySummary && (
                <span className="text-xs text-blue-600 bg-blue-50 rounded-lg px-2 py-1">
                  Currency: {draftReport.currencySummary.primary === 'CNY'
                    ? `RMB -> USD @ ${Number(draftReport.currencySummary.cnyToUsd).toFixed(4)} (${draftReport.currencySummary.rateSource}${draftReport.currencySummary.rateFallback ? ' fallback' : ''})`
                    : draftReport.currencySummary.primary === 'USD'
                      ? 'USD'
                      : `Mixed · RMB -> USD @ ${Number(draftReport.currencySummary.cnyToUsd).toFixed(4)} (${draftReport.currencySummary.rateSource}${draftReport.currencySummary.rateFallback ? ' fallback' : ''})`}
                </span>
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                保存日期
                <input type="date" className="metric-input !py-1" value={uploadDate} onChange={(e) => { setUploadDate(e.target.value); setUploadConflict(null) }} />
              </label>
              <button onClick={() => saveDraft()} disabled={!activeStore || unmatchedDraftSpus.length > 0} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40"><Save className="w-3.5 h-3.5" /> Save to {activeStore || 'store'}</button>
              <button onClick={() => { setDraftReport(null); setUploadConflict(null) }} className="btn-secondary text-xs px-3 py-1.5">Clear preview</button>
              {draftReport.start !== draftReport.end && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertTriangle className="w-3.5 h-3.5" /> 这是区间报表，请确认保存日期。</span>
              )}
            </div>
          )}
          {draftReport && uploadConflict && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-amber-800">这一天已经有数据</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {uploadConflict.store} · {uploadConflict.day} 已有 {uploadConflict.existingRows} 行；这次上传 {uploadConflict.newRows} 行。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => saveDraft('overwrite')} className="btn-primary text-xs px-3 py-1.5">
                    覆盖
                  </button>
                  <button onClick={() => saveDraft('append')} className="btn-secondary text-xs px-3 py-1.5">
                    Append
                  </button>
                  <button onClick={() => setUploadConflict(null)} className="btn-secondary text-xs px-3 py-1.5">
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}
          {draftReport && unmatchedDraftSpus.length > 0 && (
            <PerformanceSpuReconcile
              groups={unmatchedDraftSpus}
              catalogChoices={catalogChoices}
              onAdd={addDraftSpuToCatalog}
              onRemove={removeDraftSpu}
              onRename={renameDraftSpu}
            />
          )}
          {uploadSummary && !draftReport && (
            <UploadSummaryCard summary={uploadSummary} onClear={() => setUploadSummary(null)} />
          )}
        </div>
      </section>

      <ProductCatalogEditor
        activeStore={activeStore}
        products={products}
        onSave={handleSaveProduct}
        onDelete={handleDeleteProduct}
      />

      <section id="spu-sku-focus" className="card p-5 space-y-4 scroll-mt-6">
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
              onChange={(e) => { setAutoFocusProduct(false); setSelectedProduct(e.target.value) }}
            />
            <datalist id="analytics-product-options">
              {productChoices.map((p) => (
                <option key={p.spu} value={p.sku || p.spu}>{productKeyLabel(p)}</option>
              ))}
              {productChoices.map((p) => p.sku ? <option key={`${p.spu}-spu`} value={p.spu}>{productKeyLabel(p)}</option> : null)}
            </datalist>
            {selectedProduct && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => { setAutoFocusProduct(false); setSelectedProduct('') }}>Clear</button>}
            {starProduct && !autoFocusProduct && (
              <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => { setAutoFocusProduct(true); setSelectedProduct(starProduct.sku || starProduct.spu) }}>
                明星款
              </button>
            )}
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
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <KPICard title="Units" value={count(totals.units)} subtitle={`${count(totals.orders)} orders`} icon={Package} color="blue" />
            <KPICard title="Revenue" value={money(totals.revenue)} subtitle={`${ratio(totals.roas)} ROAS`} icon={TrendingUp} color="teal" />
            <KPICard title="Spend" value={money(totals.spend)} subtitle={`${money(totals.cpa)} / order`} icon={BarChart3} color="purple" />
            <KPICard title="CTR" value={pct(totals.ctr)} subtitle={`${count(totals.clicks)} clicks`} icon={Upload} color="green" />
            <KPICard title="Conversion" value={pct(totals.conversionRate)} subtitle={`${count(totals.carts)} carts`} icon={CheckCircle} color="orange" />
          </section>

          <NeedsAttentionPanel items={anomalies} onFocusProduct={focusProduct} />

          <ActionList products={productRows} />

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <TrendChartCard
              className="card p-5 lg:col-span-2"
              title="Daily Trend"
              subtitle={draftReport ? 'Preview upload' : `${storeDays.length} saved days`}
              trends={trends}
              height={300}
            />

            <FunnelCard totals={totals} trends={trends} />
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

          <ProductMatrix
            products={filteredProducts}
            filter={tableFilter}
            setFilter={setTableFilter}
            sort={matrixSort}
            setSort={setMatrixSort}
            query={matrixQuery}
            setQuery={setMatrixQuery}
          />
        </>
      )}
    </div>
  )
}

function FloatingStoreSwitcher({ stores, activeStore, setActiveStore, summary, loading }) {
  const [open, setOpen] = useState(false)
  const active = stores.find((s) => s.name === activeStore)
  const trend = summary?.trend?.slice(-14) || []
  return (
    <div className="fixed bottom-3 right-3 z-40 w-64 max-w-[calc(100vw-1.5rem)] sm:w-72 lg:bottom-5 lg:right-5">
      {open && (
        <div className="mb-2 rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100">
            <div className="text-xs font-semibold text-slate-500 uppercase">Switch Store</div>
          </div>
          <div className="max-h-80 overflow-y-auto p-2 space-y-1">
            {stores.map((store) => (
              <button
                key={store.name}
                onClick={() => { setActiveStore(store.name); setOpen(false) }}
                className={`w-full text-left rounded-md px-3 py-2 ${activeStore === store.name ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50 text-slate-600'}`}
              >
                <div className="font-semibold truncate">{store.name}</div>
                <div className="text-xs text-slate-400">{store.days || 0} days · {store.spuCount || 0} SPU</div>
              </button>
            ))}
            {!stores.length && <div className="px-3 py-6 text-sm text-slate-400 text-center">No stores yet.</div>}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-3 items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-left shadow-xl sm:hidden"
      >
        <div>
          <div className="text-[9px] font-semibold uppercase text-blue-500">Latest {summary?.latestDay?.slice(5).replace('-', '/') || '-'}</div>
          <div className="text-lg font-bold text-slate-800">{loading ? '-' : count(summary?.latestUnits || 0)}</div>
        </div>
        <div className="border-x border-slate-100 px-2 text-center">
          <div className="text-[9px] uppercase text-slate-400">7-day avg</div>
          <div className="text-lg font-semibold text-teal-700">{loading ? '-' : count(summary?.sevenDayAverage || 0)}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[9px] uppercase text-slate-400">Store</div>
          <div className="truncate text-xs font-semibold text-slate-700">{activeStore || '未选择'}</div>
        </div>
      </button>
      <div className="hidden overflow-hidden rounded-lg border border-blue-200 bg-white shadow-xl sm:block">
        <div className="px-3 py-2 sm:px-4 sm:pb-0 sm:pt-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase text-blue-500">All Stores Sales</div>
              <div className="mt-1 text-xl font-bold text-slate-800 sm:text-2xl">
                {loading ? '-' : count(summary?.latestUnits || 0)}
                <span className="ml-1 text-xs font-medium text-slate-400">units</span>
              </div>
              <div className="text-[11px] text-slate-400">
                Latest day {summary?.latestDay ? formatISODate(summary.latestDay) : '-'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase text-slate-400">7-day avg</div>
              <div className="text-lg font-semibold text-teal-700">{loading ? '-' : count(summary?.sevenDayAverage || 0)}</div>
              <div className="text-[10px] text-slate-400">units / day</div>
            </div>
          </div>
          <div className="mt-2 hidden h-20 sm:block">
            {trend.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 6, right: 3, left: 3, bottom: 2 }}>
                  <Tooltip
                    formatter={(value) => [count(value), 'All-store units']}
                    labelFormatter={(label) => formatISODate(label)}
                    contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0', fontSize: 11 }}
                  />
                  <Line type="monotone" dataKey="units" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">No daily sales trend</div>
            )}
          </div>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between border-t border-slate-100 px-4 py-2.5 text-left hover:bg-slate-50"
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase text-slate-400">Current Store</div>
            <div className="truncate text-sm font-semibold text-slate-700">{activeStore || '未选择店铺'}</div>
          </div>
          <div className="ml-3 flex-shrink-0 text-right text-[10px] text-slate-400">
            {active ? `${active.days || 0} days · ${active.spuCount || 0} SPU` : 'Switch store'}
          </div>
        </button>
      </div>
    </div>
  )
}

function PerformanceSpuReconcile({ groups, catalogChoices, onAdd, onRemove, onRename }) {
  const [targets, setTargets] = useState({})
  const setTarget = (spu, value) => setTargets((prev) => ({ ...prev, [spu]: value }))
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <div>
          <h3 className="font-semibold text-amber-800">SPU 对账需要处理</h3>
          <p className="text-xs text-amber-700/80 mt-0.5">
            上传文件里有 {groups.length} 个 SPU 没有匹配当前店铺的产品档案。请先改成已有 SPU、加入档案，或从本次上传删除。
          </p>
        </div>
        <span className="text-xs text-amber-700 bg-white/70 rounded-lg px-2.5 py-1">保存前必须处理完成</span>
      </div>

      <datalist id="performance-catalog-spu-options">
        {catalogChoices.map((p) => (
          <option key={p.spu} value={p.sku || p.spu}>{productKeyLabel(p)}</option>
        ))}
        {catalogChoices.map((p) => p.sku ? <option key={`${p.spu}-spu-reconcile`} value={p.spu}>{productKeyLabel(p)}</option> : null)}
      </datalist>

      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-amber-700/70 border-b border-amber-200">
              <th className="py-2 pr-4">上传 SPU</th>
              <th className="py-2 pr-4">商品名</th>
              <th className="py-2 pr-4 text-right">Rows</th>
              <th className="py-2 pr-4 text-right">Units</th>
              <th className="py-2 pr-4 text-right">Spend</th>
              <th className="py-2 pr-4">改成已有 SPU/SKU</th>
              <th className="py-2 pr-4">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-100">
            {groups.map((group) => (
              <tr key={group.spu} className="align-top">
                <td className="py-3 pr-4 font-semibold text-amber-900">{group.spu}</td>
                <td className="py-3 pr-4 min-w-48 text-amber-900/80">{group.productName || '-'}</td>
                <td className="py-3 pr-4 text-right text-amber-900/80">{count(group.rows)}</td>
                <td className="py-3 pr-4 text-right text-amber-900/80">{count(group.units)}</td>
                <td className="py-3 pr-4 text-right text-amber-900/80">{money(group.spend)}</td>
                <td className="py-3 pr-4 min-w-56">
                  <div className="flex gap-2">
                    <input
                      className="metric-input !py-1.5 bg-white"
                      list="performance-catalog-spu-options"
                      placeholder="选择已有 SPU / SKU"
                      value={targets[group.spu] || ''}
                      onChange={(e) => setTarget(group.spu, e.target.value)}
                    />
                    <button onClick={() => onRename(group.spu, targets[group.spu])} className="btn-secondary text-xs px-3 py-1.5">Apply</button>
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => onAdd(group)} className="btn-secondary text-xs px-3 py-1.5">加入档案</button>
                    <button onClick={() => onRemove(group.spu)} className="btn-secondary text-xs px-3 py-1.5 text-red-600">从上传删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProductCatalogEditor({ activeStore, products, onSave, onDelete }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState(null)
  const [isNew, setIsNew] = useState(false)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products
      .filter((p) => {
        if (!q) return true
        return [p.spu, p.sku, p.productName, p.newProductName, p.notes, p.category, p.lifecycle, p.skuType]
          .some((v) => String(v || '').toLowerCase().includes(q))
      })
      .sort((a, b) => String(a.sku || a.spu).localeCompare(String(b.sku || b.spu)))
  }, [products, query])

  useEffect(() => {
    setDraft(null)
    setIsNew(false)
    setQuery('')
  }, [activeStore])

  if (!open) {
    return (
      <section className="card p-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800">SPU Product Catalog</h2>
            <p className="text-xs text-slate-400 mt-0.5">{activeStore ? `${activeStore} · ${products.length} SPU` : '选择店铺后可以维护 SPU 档案。'} 这个工具不常用，默认收起。</p>
          </div>
          <button onClick={() => setOpen(true)} disabled={!activeStore} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
            Manage SPU Catalog
          </button>
        </div>
      </section>
    )
  }

  const startNew = () => {
    setDraft(blankProduct(activeStore))
    setIsNew(true)
  }

  const startEdit = (product) => {
    setDraft({ ...blankProduct(activeStore), ...product, store: activeStore })
    setIsNew(false)
  }

  const setField = (key, value, type) => {
    setDraft((prev) => {
      const next = { ...(prev || blankProduct(activeStore)) }
      if (type === 'number') next[key] = value === '' ? '' : Number(value)
      else if (type === 'percent') next[key] = value === '' ? '' : Number(value) / 100
      else next[key] = value
      return next
    })
  }

  const saveDraftProduct = async () => {
    if (!draft) return
    const ok = await onSave(draft)
    if (ok) {
      setDraft(null)
      setIsNew(false)
    }
  }

  const deleteDraftProduct = async () => {
    if (!draft || isNew) return
    const ok = await onDelete(draft)
    if (ok) setDraft(null)
  }

  return (
    <section className="card p-5 space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800">SPU Product Catalog</h2>
          <p className="text-xs text-slate-400 mt-0.5">修改上新计划里的 SPU 档案。这里的 SKU、商品名、备注、价格和毛利会用于后续分析。</p>
        </div>
        <div className="flex gap-2">
          <button onClick={startNew} disabled={!activeStore} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40">
            <Plus className="w-3.5 h-3.5" /> Add SPU
          </button>
          <button onClick={() => setOpen(false)} className="btn-secondary text-xs px-3 py-1.5">Collapse</button>
        </div>
      </div>

      {!activeStore ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">先选择店铺，再编辑这个店铺的 SPU 档案。</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2 mb-3">
              <input className="metric-input !py-1.5 flex-1" placeholder="Search SPU / SKU / name" value={query} onChange={(e) => setQuery(e.target.value)} />
              <span className="text-xs text-slate-400 whitespace-nowrap">{filtered.length} / {products.length}</span>
            </div>
            <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {filtered.slice(0, 80).map((product) => (
                <button
                  key={product.spu}
                  onClick={() => startEdit(product)}
                  className={`w-full text-left px-3 py-2 rounded-md ${draft?.spu === product.spu ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50 text-slate-600'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{product.sku || product.spu}</span>
                    <span className="text-[11px] text-slate-400">SPU {product.spu}</span>
                  </div>
                  <div className="text-xs text-slate-400 truncate">{product.productName || product.notes || 'No name yet'}</div>
                  {product.newProductName && (
                    <div className="mt-1 text-[11px] text-emerald-700 truncate">New: {product.newProductName}</div>
                  )}
                </button>
              ))}
              {!filtered.length && <div className="py-8 text-center text-sm text-slate-400">没有匹配的 SPU。</div>}
            </div>
          </div>

          <div className="xl:col-span-3 rounded-lg border border-slate-200 p-4">
            {!draft ? (
              <div className="h-full min-h-72 flex items-center justify-center text-sm text-slate-400">选择一个 SPU 修改，或新增遗漏的 SPU。</div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-700">{isNew ? 'Add New SPU' : `Edit ${draft.sku || draft.spu}`}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{isNew ? '新增后会保存到当前店铺。' : 'SPU 会锁定，避免历史数据无法匹配。'}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveDraftProduct} className="btn-primary text-xs px-3 py-1.5"><Save className="w-3.5 h-3.5" /> Save</button>
                    {!isNew && <button onClick={deleteDraftProduct} className="btn-secondary text-xs px-3 py-1.5 text-red-600"><Trash2 className="w-3.5 h-3.5" /> Delete</button>}
                    <button onClick={() => { setDraft(null); setIsNew(false) }} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {draft.newProductName && (
                    <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                      新 SPU 名称已保存：{draft.newProductName}
                      {draft.newProductSourceFile ? ` · ${draft.newProductSourceFile}` : ''}
                    </div>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500 font-medium">SPU</span>
                    <input
                      className="metric-input"
                      value={draft.spu || ''}
                      disabled={!isNew}
                      onChange={(e) => setField('spu', e.target.value, 'text')}
                    />
                  </label>
                  {PRODUCT_EDIT_FIELDS.map(([key, label, type]) => {
                    const value = type === 'percent' ? (Number(draft[key]) || 0) * 100 : draft[key] ?? ''
                    if (type === 'textarea') {
                      return (
                        <label key={key} className="sm:col-span-2 lg:col-span-3 flex flex-col gap-1">
                          <span className="text-xs text-slate-500 font-medium">{label}</span>
                          <textarea className="metric-input min-h-20" value={value} onChange={(e) => setField(key, e.target.value, type)} />
                        </label>
                      )
                    }
                    return (
                      <label key={key} className="flex flex-col gap-1">
                        <span className="text-xs text-slate-500 font-medium">{label}</span>
                        <input
                          type={type === 'text' ? 'text' : 'number'}
                          step={type === 'percent' ? '0.1' : '0.01'}
                          className="metric-input"
                          value={Number.isFinite(value) || typeof value === 'string' ? value : ''}
                          onChange={(e) => setField(key, e.target.value, type)}
                        />
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function DateRangeControl({
  timeframe,
  setTimeframe,
  customFrom,
  customTo,
  setCustomFrom,
  setCustomTo,
  loadWindow,
  activeStore,
  loading,
  storeDays,
  anchorDay,
  dailyLogs,
  dailyStats,
  onSaveLog,
  logSaving,
}) {
  const [editingDay, setEditingDay] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const range = timeframeRange(timeframe, customFrom, customTo, anchorDay)
  const days = dateSpan(range.from, range.to, 62)
  const savedDayMap = new Map((storeDays || []).map((d) => [d.day, d]))
  const logMap = new Map((dailyLogs || []).map((item) => [item.day, item]))
  const missingCount = days.filter((day) => !savedDayMap.has(day)).length
  const loggedDays = days.filter((day) => logMap.get(day)?.note)
  const summaryUnits = days.reduce((total, day) => total + (Number(dailyStats?.[day]?.units) || 0), 0)
  const summaryRevenue = days.reduce((total, day) => total + (Number(dailyStats?.[day]?.revenue) || 0), 0)
  const recentLogs = loggedDays.slice(-3).reverse()
  const options = [
    ['7d', '7 天'],
    ['14d', '14 天'],
    ['30d', '30 天'],
    ['today', '今天'],
    ['yesterday', '昨天'],
    ['custom', '自定义'],
  ]

  useEffect(() => {
    setEditingDay('')
    setNoteDraft('')
  }, [activeStore])

  const openEditor = (day) => {
    setEditingDay(day)
    setNoteDraft(logMap.get(day)?.note || '')
  }

  const saveLog = async () => {
    const saved = await onSaveLog(editingDay, noteDraft)
    if (saved) setEditingDay('')
  }

  const exportDailyLog = () => {
    const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = days.map((day) => [
      day,
      Number(dailyStats?.[day]?.units) || 0,
      (Number(dailyStats?.[day]?.revenue) || 0).toFixed(2),
      logMap.get(day)?.note || '',
    ])
    const csv = `\ufeff日期,销量,销售额,Daily Log\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${activeStore || 'store'}-daily-log-${range.from}-${range.to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="card p-4">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800">数据时间</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            当前显示：{range.from && range.to ? `${formatISODate(range.from)} - ${formatISODate(range.to)}` : '请选择开始和结束日期'}
          </p>
          {days.length > 0 && (
            <p className="text-xs text-slate-400 mt-0.5">
              {savedDayMap.size} 天已上传 · {missingCount} 天需要补
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            {options.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTimeframe(key)}
                className={`text-xs px-3 py-1.5 rounded-md ${timeframe === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {timeframe === 'custom' && (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Calendar className="w-3.5 h-3.5" />
              <input type="date" className="metric-input !py-1" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span>to</span>
              <input type="date" className="metric-input !py-1" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </span>
          )}
          <button onClick={loadWindow} disabled={!activeStore || loading} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
            {loading ? 'Loading' : 'Refresh'}
          </button>
        </div>
      </div>
      {days.length > 0 && (
        <div className="mt-4">
          <div className="grid grid-cols-7 gap-1.5">
            {days.map((day, index) => {
              const saved = savedDayMap.get(day)
              const log = logMap.get(day)
              const stats = dailyStats?.[day]
              const isLatest = day === anchorDay
              return (
                <div key={day} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      setTimeframe('custom')
                      setCustomFrom(day)
                      setCustomTo(day)
                    }}
                    className={`min-h-12 w-full rounded-md border px-1.5 py-1 text-left text-xs transition ${
                      saved
                        ? 'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300'
                        : 'border-slate-200 bg-slate-100 text-slate-400 hover:border-slate-300'
                    } ${isLatest ? 'ring-1 ring-blue-400' : ''}`}
                  >
                    <span className="flex items-center justify-between gap-1 font-semibold">
                      {day.slice(5).replace('-', '/')}
                      {log?.note && <NotebookPen className="h-3 w-3 text-amber-500" />}
                    </span>
                    <span className="mt-1 block truncate text-[10px]">
                      {saved ? `销量 ${count(stats?.units || 0)}` : 'No data'}
                    </span>
                  </button>
                  <div className={`pointer-events-none absolute top-full z-30 w-64 pt-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 ${index % 7 >= 5 ? 'right-0' : 'left-0'}`}>
                    <div className="rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xl">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-700">{formatISODate(day)}</span>
                        <span className="text-[10px] text-slate-400">{saved ? '已上传数据' : '未上传数据'}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="rounded-md bg-blue-50 px-2 py-1.5">
                          <div className="text-[10px] text-blue-500">销量</div>
                          <div className="text-sm font-semibold text-blue-700">{count(stats?.units || 0)}</div>
                        </div>
                        <div className="rounded-md bg-emerald-50 px-2 py-1.5">
                          <div className="text-[10px] text-emerald-500">销售额</div>
                          <div className="text-sm font-semibold text-emerald-700">{money(stats?.revenue || 0)}</div>
                        </div>
                      </div>
                      <div className="mt-2 rounded-md bg-amber-50 px-2 py-2">
                        <div className="text-[10px] font-medium text-amber-600">Daily Log</div>
                        <p className="mt-1 max-h-20 overflow-hidden whitespace-pre-wrap text-xs text-slate-600">
                          {log?.note || '今天还没有记录。'}
                        </p>
                      </div>
                      <button type="button" onClick={() => openEditor(day)} disabled={!activeStore} className="btn-secondary mt-2 w-full justify-center text-xs disabled:opacity-40">
                        <NotebookPen className="h-3.5 w-3.5" /> {!activeStore ? '请先选择店铺' : log?.note ? '编辑日志' : '写日志'}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-700">区间总结</div>
                <p className="mt-1 text-xs text-slate-500">
                  {days.length} 天 · 销量 {count(summaryUnits)} · 销售额 {money(summaryRevenue)} · {loggedDays.length} 天有日志
                </p>
                {recentLogs.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {recentLogs.map((day) => (
                      <p key={day} className="max-w-3xl truncate text-xs text-slate-600">
                        <span className="font-medium text-slate-500">{day.slice(5).replace('-', '/')}：</span>{logMap.get(day)?.note}
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" onClick={exportDailyLog} disabled={!activeStore} className="btn-secondary shrink-0 text-xs disabled:opacity-40">
                <Download className="h-3.5 w-3.5" /> 导出 Daily Log
              </button>
            </div>
          </div>
          {editingDay && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-700">{formatISODate(editingDay)} · Daily Log</div>
                  <p className="text-xs text-slate-500">简单记录今天上了哪些款、调了什么设置、做了哪些动作。</p>
                </div>
                <button type="button" onClick={() => setEditingDay('')} className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <textarea
                className="metric-input mt-3 min-h-24 w-full"
                maxLength={2000}
                placeholder={'例如：\n• 上新 3 款：A123、A124、A125\n• 调整 A123 广告预算\n• 主图换成新版'}
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[10px] text-slate-400">{noteDraft.length}/2000 · 清空后保存可删除日志</span>
                <button type="button" onClick={saveLog} disabled={logSaving} className="btn-primary text-xs disabled:opacity-50">
                  <Save className="h-3.5 w-3.5" /> {logSaving ? '保存中' : '保存日志'}
                </button>
              </div>
            </div>
          )}
          {dateSpan(range.from, range.to, 63).length > 62 && (
            <p className="mt-2 text-xs text-slate-400">自定义范围太长，日历先显示前 62 天。</p>
          )}
        </div>
      )}
    </section>
  )
}

function trendConfig(key) {
  return TREND_METRICS.find((m) => m.key === key) || TREND_METRICS[0]
}

function trendValue(value, type) {
  if (type === 'money') return money(value)
  if (type === 'percent') return pct(value)
  if (type === 'ratio') return ratio(value)
  return count(value)
}

function axisTickFormatter(axis, selectedMetrics) {
  const metrics = selectedMetrics.map(trendConfig).filter((m) => m.axis === axis)
  if (!metrics.length) return count
  const types = new Set(metrics.map((m) => m.type))
  if (types.size === 1) {
    const [type] = [...types]
    if (type === 'money') return (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (type === 'percent') return pct
    if (type === 'ratio') return ratio
  }
  return (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function TrendChartCard({ className, title, subtitle, trends, height = 300, emptyMessage = '当前时间范围没有趋势数据。', initialMetrics = DEFAULT_TREND_METRICS }) {
  const [selectedMetrics, setSelectedMetrics] = useState(() => initialMetrics)
  const activeMetrics = TREND_METRICS.filter((m) => selectedMetrics.includes(m.key))
  const toggleMetric = (key) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(key)) return prev.length === 1 ? prev : prev.filter((m) => m !== key)
      return [...prev, key]
    })
  }
  return (
    <div className={className}>
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-3 mb-3">
        <div>
          <h2 className="font-semibold text-slate-800">{title}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TREND_METRICS.map((metric) => {
            const active = selectedMetrics.includes(metric.key)
            return (
              <button
                key={metric.key}
                onClick={() => toggleMetric(metric.key)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${active ? 'bg-white border-slate-300 text-slate-700 shadow-sm' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? metric.color : '#cbd5e1' }} />
                {metric.label}
              </button>
            )
          })}
        </div>
      </div>
      {trends.length ? (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={trends} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={axisTickFormatter('left', selectedMetrics)} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={axisTickFormatter('right', selectedMetrics)} />
            <Tooltip formatter={(v, _name, props) => {
              const config = trendConfig(props.dataKey)
              return [trendValue(v, config.type), config.label]
            }} />
            {activeMetrics.map((metric) => (
              <Line
                key={metric.key}
                yAxisId={metric.axis}
                type="monotone"
                dataKey={metric.key}
                stroke={metric.color}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
                name={metric.label}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-60 flex items-center justify-center text-sm text-slate-400">{emptyMessage}</div>
      )}
    </div>
  )
}

function SelectedProductPanel({ product, rows, totals, trends, activeStore }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400 mb-1">当前店铺单品</p>
          <h3 className="font-semibold text-slate-800">{product?.sku || product?.spu || 'No match'}</h3>
          <p className="text-xs text-slate-400 mt-1 line-clamp-3">{product?.productName || '当前时间范围里没有匹配数据。'}</p>
          <div className="grid grid-cols-2 gap-2 mt-4 text-sm">
            <MetricCell label="Store" value={activeStore || '-'} />
            <MetricCell label="Rows" value={count(rows.length)} />
            <MetricCell label="Unit Qty" value={`x${product?.unitMultiplier || 1}`} />
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

        <TrendChartCard
          className="rounded-lg border border-slate-200 p-4 lg:col-span-2"
          title="Single Product Trend"
          subtitle={`${trends.length} day${trends.length !== 1 ? 's' : ''} · daily units / exposure`}
          trends={trends}
          height={240}
          emptyMessage="当前店铺和时间范围没有这个产品的数据。"
          initialMetrics={['dailyUnits', 'impressions', 'clicks', 'ctr', 'conversionRate']}
        />
      </div>
      <ProductExposureChart trends={trends} />
      <StyleDailyPerformanceTable trends={trends} />
    </div>
  )
}

function ProductExposureChart({ trends }) {
  const rows = trends.map((row) => ({
    day: row.day,
    impressions: row.impressions || 0,
    clicks: row.clicks || 0,
    ctr: row.ctr || 0,
  }))
  const totalImpressions = rows.reduce((sum, row) => sum + row.impressions, 0)
  const totalClicks = rows.reduce((sum, row) => sum + row.clicks, 0)
  const avgCtr = totalImpressions ? totalClicks / totalImpressions : null
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold text-slate-800">Exposure Comparison</h3>
          <p className="text-xs text-slate-400 mt-0.5">按天比较曝光量，同时看点击是否跟着曝光走。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <TargetPill label="Impressions" value={count(totalImpressions)} />
          <TargetPill label="Clicks" value={count(totalClicks)} />
          <TargetPill label="CTR %" value={pct(avgCtr)} />
        </div>
      </div>
      {rows.length ? (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={rows} margin={{ top: 8, right: 22, left: 4, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11 }}
              tickFormatter={count}
              label={{ value: 'Impressions / Clicks', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#64748b' } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11 }}
              tickFormatter={pct}
              label={{ value: 'CTR %', angle: 90, position: 'insideRight', style: { fontSize: 11, fill: '#64748b' } }}
            />
            <Tooltip formatter={(v, k) => {
              if (k === 'ctr') return [pct(v), 'CTR %']
              if (k === 'impressions') return [count(v), '曝光量 Impressions']
              return [count(v), '点击量 Clicks']
            }} />
            <Legend verticalAlign="top" height={28} formatter={(value) => ({
              impressions: '曝光量 Impressions',
              clicks: '点击量 Clicks',
              ctr: 'CTR %',
            }[value] || value)} />
            <Bar yAxisId="left" dataKey="impressions" fill="#93c5fd" name="impressions" radius={[4, 4, 0, 0]} />
            <Bar yAxisId="left" dataKey="clicks" fill="#2563eb" name="clicks" radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="ctr" stroke="#16a34a" strokeWidth={2} dot={{ r: 2 }} name="ctr" />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-28 flex items-center justify-center text-sm text-slate-400">当前款式没有曝光数据。</div>
      )}
    </div>
  )
}

function StyleDailyPerformanceTable({ trends }) {
  const rows = [...trends].sort((a, b) => String(b.day).localeCompare(String(a.day)))
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold text-slate-800">Style Daily Performance</h3>
          <p className="text-xs text-slate-400 mt-0.5">最近每天这个款卖了多少，用 daily units 做日对比。</p>
        </div>
        <span className="text-xs text-slate-400">{rows.length} days</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="py-2 pr-4">Day</th>
              <th className="py-2 pr-4 text-right">Daily Units</th>
              <th className="py-2 pr-4 text-right">Impressions</th>
              <th className="py-2 pr-4 text-right">Orders</th>
              <th className="py-2 pr-4 text-right">Revenue</th>
              <th className="py-2 pr-4 text-right">Spend</th>
              <th className="py-2 pr-4 text-right">ROAS</th>
              <th className="py-2 pr-4 text-right">CTR</th>
              <th className="py-2 pr-4 text-right">CVR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.day}>
                <td className="py-3 pr-4 font-medium text-slate-700">{row.day}</td>
                <td className="py-3 pr-4 text-right font-semibold text-slate-700">{count(row.dailyUnits ?? row.units)}</td>
                <td className="py-3 pr-4 text-right">{count(row.impressions)}</td>
                <td className="py-3 pr-4 text-right">{count(row.orders)}</td>
                <td className="py-3 pr-4 text-right">{money(row.revenue)}</td>
                <td className="py-3 pr-4 text-right">{money(row.spend)}</td>
                <td className="py-3 pr-4 text-right">{ratio(row.roas)}</td>
                <td className="py-3 pr-4 text-right">{pct(row.ctr)}</td>
                <td className="py-3 pr-4 text-right">{pct(row.conversionRate)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan="9" className="py-8 text-center text-slate-400">当前款式没有每日表现数据。</td></tr>
            )}
          </tbody>
        </table>
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

function StoreHealthOverview({ rows, loading, activeStore, setActiveStore }) {
  if (!rows.length && !loading) return null
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold text-slate-800">Store Health</h3>
          <p className="text-xs text-slate-400 mt-0.5">按当前时间范围对比每家店的数据完整度和表现。</p>
        </div>
        {loading && <span className="text-xs text-slate-400">Loading...</span>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {rows.map((row) => {
          const weak = row.missingDays > 0 || row.attention > 0 || ((row.roas || 0) > 0 && row.roas < 1)
          return (
            <button
              key={row.store}
              type="button"
              onClick={() => setActiveStore(row.store)}
              className={`text-left rounded-lg border p-3 transition ${activeStore === row.store ? 'border-blue-300 bg-blue-50' : weak ? 'border-amber-200 bg-amber-50/60 hover:border-amber-300' : 'border-slate-200 bg-slate-50 hover:border-slate-300'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-800 truncate">{row.store}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{row.spuCount || 0} SPU · {row.days || 0} days</div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${weak ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                  {weak ? 'Check' : 'OK'}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <MetricMini label="Units" value={count(row.units)} />
                <MetricMini label="Revenue" value={money(row.revenue)} />
                <MetricMini label="ROAS" value={ratio(row.roas)} />
                <MetricMini label="Missing" value={count(row.missingDays)} />
              </div>
              {row.attention > 0 && <div className="mt-2 text-xs text-amber-700">{row.attention} products need attention</div>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MetricMini({ label, value }) {
  return (
    <div className="rounded-md bg-white/70 px-2 py-1">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="font-semibold text-slate-700 truncate">{value}</div>
    </div>
  )
}

function UploadSummaryCard({ summary, onClear }) {
  const currency = summary.currencySummary
  const currencyText = currency?.primary === 'CNY'
    ? `RMB -> USD @ ${Number(currency.cnyToUsd).toFixed(4)}`
    : currency?.primary === 'USD'
      ? 'USD'
      : currency?.primary ? `Mixed @ ${Number(currency.cnyToUsd).toFixed(4)}` : '-'
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-800">Upload saved</p>
          <p className="text-xs text-emerald-700 mt-0.5">
            {summary.store} · {summary.day} · {summary.mode === 'append' ? 'Append' : '覆盖'} · {summary.savedRows} rows saved
          </p>
        </div>
        <button onClick={onClear} className="btn-secondary text-xs px-3 py-1.5">Dismiss</button>
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <MetricMini label="This upload" value={`${summary.newRows} rows`} />
        <MetricMini label="Before" value={`${summary.previousRows} rows`} />
        <MetricMini label="Saved total" value={`${summary.savedRows} rows`} />
        <MetricMini label="Currency" value={currencyText} />
      </div>
      <div className="mt-2 text-[11px] text-emerald-700 truncate">{summary.fileName}</div>
    </div>
  )
}

function NeedsAttentionPanel({ items, onFocusProduct }) {
  const confidenceText = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }
  const confidenceClass = {
    high: 'bg-emerald-100 text-emerald-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-slate-100 text-slate-600',
  }
  const severityClass = {
    bad: 'border-red-200 bg-red-50/70',
    warn: 'border-amber-200 bg-amber-50/70',
    watch: 'border-blue-200 bg-blue-50/60',
  }
  const iconClass = { bad: 'text-red-600', warn: 'text-amber-600', watch: 'text-blue-600' }
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-slate-800">Needs Attention · Smart Decision Maker</h2>
          <p className="text-xs text-slate-400 mt-0.5">用漏斗、前一周期、店内基准和跨店同款，给出一个最优先动作。</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${items.length ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
          {items.length ? `${items.length} decisions` : 'OK'}
        </span>
      </div>
      {items.length ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {items.map((item, index) => (
            <article key={`${item.type}-${item.product?.spu || index}`} className={`rounded-lg border p-4 ${severityClass[item.severity] || severityClass.warn}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconClass[item.severity] || iconClass.warn}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{item.title || item.product?.label || 'Store decision'}</div>
                      {item.product?.productName && <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{item.product.productName}</div>}
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confidenceClass[item.confidence?.level] || confidenceClass.low}`}>
                      {confidenceText[item.confidence?.level] || confidenceText.low}
                    </span>
                  </div>

                  <div className="mt-3 rounded-md bg-white/80 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-blue-600">Smart Decision</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-800">{item.decision}</div>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{item.cause}</p>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {item.product?.spu && (
                      <button
                        type="button"
                        onClick={() => onFocusProduct?.(item.product)}
                        className="inline-flex rounded-md border border-white bg-white/90 px-2 py-1 text-[11px] font-semibold text-blue-700 shadow-sm hover:border-blue-200 hover:bg-blue-50"
                      >
                        SPU {item.product.spu}
                      </button>
                    )}
                    {item.estimateUnits > 0 && (
                      <span className="rounded-md bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                        Estimated opportunity +{count(item.estimateUnits)} units
                      </span>
                    )}
                  </div>

                  {item.metrics && (
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {item.metrics.slice(0, 4).map(([label, value]) => (
                        <MetricMini key={label} label={label} value={value} />
                      ))}
                    </div>
                  )}

                  <div className="mt-3 text-xs leading-5 text-slate-700">
                    <span className="font-semibold">Next action: </span>{item.action}
                  </div>

                  <details className="mt-3 rounded-md border border-white/80 bg-white/60 px-3 py-2 text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold text-slate-700">查看完整判断依据</summary>
                    <div className="mt-3 space-y-3">
                      <div>
                        <div className="font-semibold text-slate-700">可信度</div>
                        <p className="mt-0.5 leading-5">{item.confidence?.reason}</p>
                      </div>
                      {item.evidence?.length > 0 && (
                        <div>
                          <div className="font-semibold text-slate-700">比较依据</div>
                          <ul className="mt-1 space-y-1 pl-4 list-disc">
                            {item.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
                          </ul>
                        </div>
                      )}
                      {item.possibleCauses?.length > 0 && (
                        <div>
                          <div className="font-semibold text-slate-700">可能原因</div>
                          <ul className="mt-1 space-y-1 pl-4 list-disc">
                            {item.possibleCauses.map((cause) => <li key={cause}>{cause}</li>)}
                          </ul>
                        </div>
                      )}
                      {item.metrics?.length > 4 && (
                        <div className="grid grid-cols-2 gap-1.5">
                          {item.metrics.slice(4).map(([label, value]) => <MetricMini key={label} label={label} value={value} />)}
                        </div>
                      )}
                      {item.daily?.length > 0 && (
                        <div>
                          <div className="font-semibold text-slate-700">每日数据</div>
                          <div className="mt-1 space-y-1">
                            {item.daily.slice(-5).map((day) => (
                              <div key={day.day} className="rounded-md bg-white/80 px-2 py-1">
                                {day.status
                                  ? `${day.day}: ${day.status}`
                                  : `${day.day}: ${count(day.units)} units · ${count(day.impressions)} impressions · ${pct(day.ctr)} CTR · ${pct(day.conversionRate)} CVR`}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <div className="font-semibold text-slate-700">不要同时做</div>
                        <p className="mt-0.5 leading-5">{item.avoid}</p>
                      </div>
                      <div>
                        <div className="font-semibold text-slate-700">复查条件</div>
                        <p className="mt-0.5 leading-5">{item.review}</p>
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          当前时间范围没有明显异常。
        </div>
      )}
    </section>
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

function FunnelCard({ totals, trends }) {
  const steps = [
    ['曝光', totals.impressions, null],
    ['点击', totals.clicks, totals.ctr],
    ['加购', totals.carts, totals.cartRate],
    ['订单', totals.orders, totals.conversionRate],
  ]
  const max = Math.max(totals.impressions || 1, 1)
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-semibold text-slate-800">Traffic Funnel</h2>
        <span className="text-xs text-slate-400">{trends.length} days</span>
      </div>
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
      <div className="mt-5">
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">Daily funnel trend</h3>
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={trends} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v, k) => [count(v), { impressions: '曝光', clicks: '点击', carts: '加购', orders: '订单' }[k] || k]} />
            <Bar dataKey="impressions" fill="#bfdbfe" radius={[3, 3, 0, 0]} name="曝光" />
            <Bar dataKey="clicks" fill="#60a5fa" radius={[3, 3, 0, 0]} name="点击" />
            <Bar dataKey="carts" fill="#2dd4bf" radius={[3, 3, 0, 0]} name="加购" />
            <Bar dataKey="orders" fill="#f97316" radius={[3, 3, 0, 0]} name="订单" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 max-h-44 overflow-y-auto divide-y divide-slate-100">
        {trends.map((d) => (
          <div key={d.day} className="grid grid-cols-5 gap-2 py-2 text-xs">
            <span className="font-medium text-slate-600">{d.day}</span>
            <span className="text-right text-slate-500">{count(d.impressions)} 曝光</span>
            <span className="text-right text-slate-500">{pct(d.ctr)} CTR</span>
            <span className="text-right text-slate-500">{pct(d.cartRate)} 加购</span>
            <span className="text-right text-slate-500">{pct(d.conversionRate)} CVR</span>
          </div>
        ))}
        {!trends.length && <div className="py-4 text-center text-xs text-slate-400">暂无每日漏斗数据。</div>}
      </div>
      <p className="text-xs text-slate-400 mt-4">如果某一天曝光够但 CTR 掉下去，优先看主图/标题；如果点击和加购正常但 CVR 掉下去，优先看价格、页面和评价。</p>
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

function ProductMatrix({ products, filter, setFilter, sort, setSort, query, setQuery }) {
  const filters = [
    ['all', 'All'],
    ['good', '机会'],
    ['warn', '观察'],
    ['bad', '需要修改'],
  ]
  const sorts = [
    ['units_desc', 'Units 最多'],
    ['revenue_desc', 'Revenue 最高'],
    ['roas_desc', 'ROAS 最高'],
    ['score_desc', 'Score 最高'],
    ['ctr_desc', 'CTR 最高'],
    ['conversionRate_desc', 'CVR 最高'],
    ['spend_desc', 'Spend 最高'],
    ['spend_asc', 'Spend 最低'],
  ]
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="font-semibold text-slate-800">Product Performance Matrix</h2>
          <p className="text-xs text-slate-400 mt-0.5">筛出销量最多、花费最高、转化最好或需要修改的款。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="metric-input !py-1.5 w-44"
            placeholder="Search SPU / SKU"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="metric-input !py-1.5" value={sort} onChange={(e) => setSort(e.target.value)}>
            {sorts.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap gap-1">
          {filters.map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} className={`text-xs px-3 py-1.5 rounded-lg border ${filter === key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">{products.length} products</span>
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
                  <div className="text-[11px] text-slate-400 mt-0.5">SPU {p.spu} · Unit x{p.unitMultiplier || 1}</div>
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
