import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarDays, ChevronDown,
  ChevronUp, Clock3, Gauge, GitCompareArrows, History, ImageIcon,
  Loader2, PackagePlus, Pencil, PlusCircle, RefreshCw, Rocket, Search,
  Sparkles, Tag, Trash2, TrendingUp, X,
} from 'lucide-react'
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  createNewProductTracker, deleteNewProductTracker, fetchNewProductTrackers,
  fetchStoreProducts, fetchStoreRange, fetchStores, saveNewProductRoas,
} from '../utils/api.js'
import { useToast } from '../hooks/useToast.js'

const DAY_MS = 86400000
const CYCLE_DAYS = 14
const MILESTONE_DAYS = [3, 7, 10, 14]
const LOCAL_EVENTS_KEY = 'feiya.new-product-events.v1'

function todayISO() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDay(day) {
  return new Date(`${String(day).slice(0, 10)}T00:00:00`)
}

function isValidDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const date = parseDay(day)
  if (Number.isNaN(date.getTime())) return false
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === day
}

function addDays(day, amount) {
  const date = parseDay(day)
  date.setDate(date.getDate() + amount)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayDiff(from, to) {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS)
}

function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function compact(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function percent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`
}

function average(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => value != null && Number.isFinite(Number(value)))
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null
}

function total(rows, key) {
  return rows.reduce((sum, row) => sum + number(row[key]), 0)
}

function aggregateRows(rows) {
  const uploaded = rows.filter((row) => row.uploaded)
  const impressions = total(uploaded, 'impressions')
  const clicks = total(uploaded, 'clicks')
  const orders = total(uploaded, 'orders')
  const spend = total(uploaded, 'spend')
  const revenue = total(uploaded, 'revenue')
  return {
    days: uploaded.length,
    units: total(uploaded, 'units'),
    avgUnits: average(uploaded, 'units'),
    impressions,
    ctr: impressions ? clicks / impressions : null,
    conversionRate: clicks ? orders / clicks : null,
    actualRoas: spend ? revenue / spend : null,
  }
}

function launchCohortStart(launchDate) {
  const date = parseDay(launchDate)
  const daysSinceMonday = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - daysSinceMonday)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function launchCohortLabel(launchDate) {
  const start = launchCohortStart(launchDate)
  return `${start} – ${addDays(start, 6)}`
}

function readLocalEvents() {
  if (typeof window === 'undefined') return {}
  try {
    const value = JSON.parse(window.localStorage.getItem(LOCAL_EVENTS_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).map(([trackerId, events]) => [
      trackerId,
      Array.isArray(events)
        ? events.filter((event) =>
          event
          && typeof event.id === 'string'
          && isValidDay(event.date)
          && ['image', 'price', 'other'].includes(event.type)
        ).map((event) => ({
          id: event.id,
          date: event.date,
          type: event.type,
          title: eventTitle(event.type),
          note: typeof event.note === 'string' ? event.note : '',
          source: 'local',
        }))
        : [],
    ]))
  } catch {
    return {}
  }
}

function eventTitle(type) {
  if (type === 'image') return '更新图片'
  if (type === 'price') return '调整价格'
  return '其他调整'
}

function combinedTimeline(tracker, manualEvents) {
  const roasEvents = (tracker.roasEvents || [])
    .filter((event) => typeof event.effectiveDate === 'string' && event.effectiveDate)
    .map((event, index) => ({
      id: `roas-${event.effectiveDate}-${index}`,
      date: event.effectiveDate,
      type: 'roas',
      title: `目标 ROAS 设为 ${compact(event.roas, 2)}`,
      note: event.note || '',
      source: 'analytics',
    }))
  return [...roasEvents, ...manualEvents]
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)))
}

function manualEventImpact(event, dailyRows, windowDays) {
  if (!dailyRows.length || event.date < dailyRows[0].day || event.date > dailyRows.at(-1).day) return null
  const before = dailyRows
    .filter((row) => row.uploaded && row.day <= event.date)
    .slice(-windowDays)
  const after = dailyRows
    .filter((row) => row.uploaded && row.day >= addDays(event.date, 1))
    .slice(0, windowDays)
  if (before.length < windowDays || after.length < windowDays) {
    return { waiting: true, before: before.length, after: after.length }
  }
  return {
    waiting: false,
    beforeUnits: average(before, 'units'),
    afterUnits: average(after, 'units'),
    beforeImpressions: average(before, 'impressions'),
    afterImpressions: average(after, 'impressions'),
  }
}

function cycleState(launchDate) {
  const elapsed = dayDiff(launchDate, todayISO())
  if (elapsed < 0) return { phase: 'future', day: 0, remaining: CYCLE_DAYS, progress: 0 }
  const day = elapsed + 1
  if (day > CYCLE_DAYS) return { phase: 'ended', day: CYCLE_DAYS, remaining: 0, progress: 100 }
  return {
    phase: 'active',
    day,
    remaining: CYCLE_DAYS - day,
    progress: Math.round((day / CYCLE_DAYS) * 100),
  }
}

function milestoneRecommendation(tracker, dailyRows, state, milestone, trendDays) {
  const endDate = addDays(tracker.launchDate, milestone - 1)
  const rows = dailyRows.filter((row) => row.day <= endDate)
  const metrics = aggregateRows(rows)
  const reached = state.phase === 'ended' || state.day >= milestone
  if (!reached) {
    return {
      day: milestone,
      reached: false,
      metrics,
      level: 'waiting',
      title: `Day ${milestone} 后生成复盘`,
      detail: '继续上传每日数据；到达节点后会用该阶段内的数据生成建议。',
    }
  }
  if (metrics.days < milestone) {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'waiting',
      title: `Day ${milestone} 等待补齐数据`,
      detail: `目前只匹配到 ${metrics.days} / ${milestone} 天。请先补齐 Analytics 日期并检查店铺与 SPU，再生成阶段结论。`,
    }
  }

  const uploadedRows = rows.filter((row) => row.uploaded)
  const unitsTrend = trendFor(uploadedRows, trendDays)
  const impressionTrend = trendFor(uploadedRows.map((row) => ({ ...row, units: row.impressions })), trendDays)
  const peakUnits = Math.max(...uploadedRows.map((row) => number(row.units)), 0)
  if (unitsTrend.status === 'waiting') {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'waiting',
      title: '阶段数据完整，趋势窗口仍在积累',
      detail: `当前选择每 ${trendDays} 天对比，需要至少 ${trendDays * 2} 天才能判断明显上升；继续观察下一天数据。`,
    }
  }
  if (milestone === CYCLE_DAYS && peakUnits <= 25 && unitsTrend.status !== 'up') {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'danger',
      title: '周期复盘：评估优化或重上',
      detail: '最高单日未超过 25 Units，且没有明显上升。先复盘流量和转化；若没有明确可修复项，再考虑下掉重上。',
    }
  }
  if (unitsTrend.status === 'up') {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'good',
      title: '阶段趋势明显上升',
      detail: '保持当前设置，避免同时改动多个变量；继续确认 Units 和流量能否稳定增长。',
    }
  }
  if (peakUnits <= 25 && ['flat', 'down'].includes(impressionTrend.status)) {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'warning',
      title: '流量没有形成上升',
      detail: '优先检查目标 ROAS 是否限制流量，并安排一次素材或流量测试；修改后从次日开始观察。',
    }
  }
  if (metrics.ctr != null && metrics.ctr < 0.02) {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'warning',
      title: '有曝光但点击偏弱',
      detail: '优先测试首图、标题或价格展示，一次只修改一个重点，便于判断关联变化。',
    }
  }
  if (metrics.conversionRate != null && metrics.conversionRate < 0.02) {
    return {
      day: milestone,
      reached: true,
      metrics,
      level: 'warning',
      title: '有点击但转化偏弱',
      detail: '优先检查价格、优惠、尺码信息和详情页，修改后继续比较次日 Units。',
    }
  }
  return {
    day: milestone,
    reached: true,
    metrics,
    level: 'neutral',
    title: peakUnits > 25 ? '阶段表现已跨过 25 Units' : '继续做单变量测试',
    detail: peakUnits > 25
      ? '继续观察是否形成稳定上升，不建议因为单日高点同时修改多个设置。'
      : '目前还没有明显上升信号。选择 ROAS、图片或价格中的一个变量测试，并记录修改时间。',
  }
}

function targetRoasForDay(events, day) {
  const event = [...events]
    .filter((item) => item.effectiveDate <= day)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .at(-1)
  return event?.roas ?? null
}

function productMatch(tracker, products) {
  const needle = normalizeId(tracker.spu)
  const product = products.find((item) =>
    [item.spu, item.sku, item.productId].some((value) => normalizeId(value) === needle)
  )
  const ids = new Set([needle])
  if (product) {
    ids.add(normalizeId(product.spu))
    ids.add(normalizeId(product.sku))
    ids.add(normalizeId(product.productId))
  }
  ids.delete('')
  return { product, ids }
}

function buildDailyRows(tracker, storeData) {
  const products = storeData?.products || []
  const allRows = storeData?.rows || []
  const uploadedDays = new Set(storeData?.days || [])
  const { product, ids } = productMatch(tracker, products)
  const multiplier = Math.max(number(product?.unitMultiplier) || 1, 1)
  const end = addDays(tracker.launchDate, CYCLE_DAYS - 1)
  const visibleEnd = todayISO() < end ? todayISO() : end
  if (visibleEnd < tracker.launchDate) return []

  const result = []
  for (let day = tracker.launchDate; day <= visibleEnd; day = addDays(day, 1)) {
    const matches = allRows.filter((row) => {
      if (row.date !== day) return false
      return [row.spu, row.productId, row.sku].some((value) => ids.has(normalizeId(value)))
    })
    const uploaded = uploadedDays.has(day)
    if (!uploaded) {
      result.push({
        day, label: `${parseDay(day).getMonth() + 1}/${parseDay(day).getDate()}`,
        uploaded: false, units: null, orders: null, impressions: null, clicks: null,
        carts: null, spend: null, revenue: null, actualRoas: null,
        targetRoas: targetRoasForDay(tracker.roasEvents || [], day),
      })
      continue
    }
    const spend = matches.reduce((sum, row) => sum + number(row.spend), 0)
    const revenue = matches.reduce((sum, row) => sum + number(row.revenue), 0)
    const impressions = matches.reduce((sum, row) => sum + number(row.impressions), 0)
    const clicks = matches.reduce((sum, row) => sum + number(row.clicks), 0)
    const carts = matches.reduce((sum, row) => sum + number(row.carts), 0)
    const orders = matches.reduce((sum, row) => sum + number(row.orders), 0)
    const units = matches.reduce((sum, row) => sum + number(row.units), 0) * multiplier
    result.push({
      day, label: `${parseDay(day).getMonth() + 1}/${parseDay(day).getDate()}`, uploaded: true,
      units, orders, impressions, clicks, carts, spend, revenue,
      ctr: impressions ? clicks / impressions : null,
      conversionRate: clicks ? orders / clicks : null,
      actualRoas: spend ? revenue / spend : null,
      targetRoas: targetRoasForDay(tracker.roasEvents || [], day),
    })
  }
  return result
}

function trendFor(dailyRows, windowDays) {
  const uploaded = dailyRows.filter((row) => row.uploaded)
  if (uploaded.length < windowDays * 2) {
    return { status: 'waiting', label: '等待数据', change: null, recent: null, previous: null }
  }
  const recentRows = uploaded.slice(-windowDays)
  const previousRows = uploaded.slice(-(windowDays * 2), -windowDays)
  const recent = average(recentRows, 'units')
  const previous = average(previousRows, 'units')
  const change = previous === 0 ? (recent > 0 ? 1 : 0) : (recent - previous) / previous
  if (change > 0.2) return { status: 'up', label: '明显上升', change, recent, previous }
  if (change > 0.05) return { status: 'slight-up', label: '小幅上升', change, recent, previous }
  if (change >= -0.05) return { status: 'flat', label: '走势平平', change, recent, previous }
  return { status: 'down', label: '正在下降', change, recent, previous }
}

function roasImpact(tracker, dailyRows, windowDays) {
  const changes = [...(tracker.roasEvents || [])]
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .slice(1)
  const change = changes.at(-1)
  if (!change) return null
  const effectStart = addDays(change.effectiveDate, 1)
  const before = dailyRows
    .filter((row) => row.uploaded && row.day <= change.effectiveDate)
    .slice(-windowDays)
  const after = dailyRows
    .filter((row) => row.uploaded && row.day >= effectStart)
    .slice(0, windowDays)
  const previousEvent = [...(tracker.roasEvents || [])]
    .filter((event) => event.effectiveDate < change.effectiveDate)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .at(-1)
  if (!before.length || after.length < windowDays) {
    return { waiting: true, change, previousRoas: previousEvent?.roas, effectStart, collected: after.length }
  }
  const beforeUnits = average(before, 'units')
  const afterUnits = average(after, 'units')
  const unitsChange = beforeUnits === 0 ? (afterUnits > 0 ? 1 : 0) : (afterUnits - beforeUnits) / beforeUnits
  return {
    waiting: false, change, previousRoas: previousEvent?.roas, effectStart,
    beforeUnits, afterUnits, unitsChange,
    beforeImpressions: average(before, 'impressions'),
    afterImpressions: average(after, 'impressions'),
    beforeActualRoas: average(before, 'actualRoas'),
    afterActualRoas: average(after, 'actualRoas'),
  }
}

function analysisFor(tracker, dailyRows, trend, state) {
  const available = dailyRows.filter((row) => row.uploaded)
  if (!available.length) {
    return {
      level: 'waiting',
      title: '等待 Analytics 数据',
      detail: '这个周期尚未匹配到已上传的日数据。请检查店铺、SPU 和上架日期是否正确。',
    }
  }
  const peakUnits = Math.max(...available.map((row) => row.units || 0), 0)
  const recent = available.slice(-Math.min(3, available.length))
  const recentCtr = average(recent, 'ctr')
  const recentCvr = average(recent, 'conversionRate')
  const impressionTrend = trendFor(dailyRows.map((row) => ({ ...row, units: row.impressions })), 1)

  if (state.phase === 'ended' && peakUnits <= 25 && ['flat', 'down', 'waiting'].includes(trend.status)) {
    return {
      level: 'danger',
      title: '建议评估下掉重上',
      detail: `14 天周期已结束，最高单日仅 ${compact(peakUnits)} Units，且没有形成明显上升趋势。可先复盘流量入口与页面转化；若没有明确可修复点，再考虑下掉重上。`,
    }
  }
  if (peakUnits <= 25 && ['flat', 'down'].includes(trend.status)) {
    if (impressionTrend.status === 'flat' || impressionTrend.status === 'down') {
      return {
        level: 'warning',
        title: '流量偏弱，尽快测试拉升方案',
        detail: `最高单日 ${compact(peakUnits)} Units，近期曝光也没有上升。建议检查目标 ROAS 是否限制流量，并准备流量方案；周期后段仍无改善时再评估重上。`,
      }
    }
    if (recentCtr != null && recentCtr < 0.02) {
      return {
        level: 'warning',
        title: '有曝光但点击弱，优先改首图',
        detail: `近期 CTR 为 ${percent(recentCtr)}。建议先测试主图、标题和价格展示，修改后继续观察次日 Units 与点击变化。`,
      }
    }
    if (recentCvr != null && recentCvr < 0.02) {
      return {
        level: 'warning',
        title: '有点击但转化弱，优先优化价格与详情',
        detail: `近期转化率为 ${percent(recentCvr)}。建议检查价格、优惠、尺码信息和详情页，而不是只增加流量。`,
      }
    }
    return {
      level: 'warning',
      title: '销量未形成上升趋势',
      detail: `最高单日 ${compact(peakUnits)} Units。建议做一次明确变量测试（ROAS、图片或价格），一次只改一个重点，并从次日开始观察。`,
    }
  }
  if (trend.status === 'up') {
    return {
      level: 'good',
      title: '趋势健康，继续保持',
      detail: `最近 ${trend.recent?.toFixed(1)} Units/天，相比前一阶段明显上升。建议保持当前设置，避免同时修改多个变量。`,
    }
  }
  return {
    level: 'neutral',
    title: '继续观察并积累数据',
    detail: '当前没有触发重上条件。继续上传每日 Analytics 数据，重点看 Units、曝光、CTR、转化率和实际 ROAS 是否同步改善。',
  }
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-label="关闭" />
      <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, note, icon: Icon, color }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    amber: 'bg-amber-50 text-amber-600',
    slate: 'bg-slate-100 text-slate-600',
  }
  return (
    <div className="card flex items-center gap-4 p-5">
      <div className={`rounded-xl p-3 ${colors[color]}`}><Icon className="h-6 w-6" /></div>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs text-slate-400">{note}</p>
      </div>
    </div>
  )
}

function Metric({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}
    </div>
  )
}

function TrendBadge({ trend }) {
  const config = {
    up: ['bg-emerald-100 text-emerald-700', ArrowUp],
    'slight-up': ['bg-blue-100 text-blue-700', ArrowUp],
    flat: ['bg-amber-100 text-amber-700', TrendingUp],
    down: ['bg-red-100 text-red-700', ArrowDown],
    waiting: ['bg-slate-100 text-slate-600', Clock3],
  }[trend.status]
  const Icon = config[1]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${config[0]}`}>
      <Icon className="h-3.5 w-3.5" />
      {trend.label}{trend.change != null ? ` ${trend.change >= 0 ? '+' : ''}${(trend.change * 100).toFixed(0)}%` : ''}
    </span>
  )
}

function MilestoneReviews({ tracker, dailyRows, state, trendDays }) {
  const reviews = MILESTONE_DAYS.map((day) => milestoneRecommendation(tracker, dailyRows, state, day, trendDays))
  const nextDay = reviews.find((review) => !review.reached)?.day
  const styles = {
    good: 'border-emerald-200 bg-emerald-50/70',
    warning: 'border-amber-200 bg-amber-50/70',
    danger: 'border-red-200 bg-red-50/70',
    waiting: 'border-slate-200 bg-white',
    neutral: 'border-blue-200 bg-blue-50/60',
  }
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <h4 className="font-semibold text-slate-900">Day 3 / 7 / 10 / 14 阶段复盘</h4>
        <p className="mt-1 text-xs text-slate-500">每个节点只使用截至该节点的 Analytics 数据；建议用于决定下一步测试，不会自动修改商品。</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {reviews.map((review) => (
          <div key={review.day} className={`rounded-xl border p-3 ${styles[review.level]}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-slate-900">Day {review.day}</p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                review.reached
                  ? review.metrics.days >= review.day ? 'bg-white/80 text-slate-600' : 'bg-amber-100 text-amber-700'
                  : nextDay === review.day ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
              }`}>
                {review.reached
                  ? review.metrics.days >= review.day ? '已复盘' : '待补数据'
                  : nextDay === review.day ? '下一节点' : '未到达'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-slate-400">累计 / 日均 Units</p>
                <p className="mt-0.5 font-semibold text-slate-800">
                  {review.reached ? `${compact(review.metrics.units)} / ${compact(review.metrics.avgUnits, 1)}` : '— / —'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">曝光 / CTR</p>
                <p className="mt-0.5 font-semibold text-slate-800">
                  {review.reached ? `${compact(review.metrics.impressions)} / ${percent(review.metrics.ctr)}` : '— / —'}
                </p>
              </div>
            </div>
            {review.reached && <p className="mt-2 text-[11px] text-slate-400">已上传 {review.metrics.days} / {review.day} 天</p>}
            <p className="mt-3 text-sm font-semibold text-slate-800">{review.title}</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{review.detail}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CohortComparison({ tracker, cohortCards }) {
  const ranked = [...cohortCards].sort((a, b) => {
    const aHasAverage = a.avgUnits != null && Number.isFinite(Number(a.avgUnits))
    const bHasAverage = b.avgUnits != null && Number.isFinite(Number(b.avgUnits))
    if (aHasAverage !== bHasAverage) return aHasAverage ? -1 : 1
    return number(b.avgUnits) - number(a.avgUnits) || number(b.latest?.units) - number(a.latest?.units)
  })
  const exactDateCount = cohortCards.filter((card) => card.tracker.launchDate === tracker.launchDate).length
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-blue-600" />
            <h4 className="font-semibold text-slate-900">同批新品横向比较</h4>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            批次定义：同一自然周（周一至周日）上架，{launchCohortLabel(tracker.launchDate)}。按已上传日期的日均 Units 排名。
          </p>
        </div>
        <span className="self-start rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          {cohortCards.length} 个同周 · {exactDateCount} 个同日
        </span>
      </div>
      {ranked.length > 1 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="pb-2 text-left">排名 / 新品</th>
                <th className="pb-2 text-left">店铺</th>
                <th className="pb-2 text-left">上架日期</th>
                <th className="pb-2 text-right">数据天数</th>
                <th className="pb-2 text-right">日均 Units</th>
                <th className="pb-2 text-right">最新 Units</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((card, index) => {
                const current = card.tracker.id === tracker.id
                return (
                  <tr key={card.tracker.id} className={`border-t border-slate-100 ${current ? 'bg-blue-50/60' : ''}`}>
                    <td className="py-2.5 font-medium text-slate-800">
                      <span className="mr-2 text-slate-400">#{index + 1}</span>{card.displayName}
                      {current && <span className="ml-2 text-xs text-blue-700">当前</span>}
                    </td>
                    <td className="py-2.5 text-slate-600">{card.tracker.store}</td>
                    <td className="py-2.5 text-slate-600">{card.tracker.launchDate}</td>
                    <td className="py-2.5 text-right text-slate-600">{card.dailyRows.filter((row) => row.uploaded).length}</td>
                    <td className="py-2.5 text-right font-semibold text-slate-800">{compact(card.avgUnits, 1)}</td>
                    <td className="py-2.5 text-right text-slate-600">{compact(card.latest?.units)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
          这一自然周目前只有这个新品；加入同周上架的 SPU 后即可横向比较。
        </p>
      )}
    </section>
  )
}

function EventTimeline({ tracker, dailyRows, manualEvents, trendDays, onAdd, onRemove }) {
  const events = combinedTimeline(tracker, manualEvents)
  const typeConfig = {
    roas: { icon: Gauge, label: 'ROAS', color: 'bg-amber-100 text-amber-700' },
    image: { icon: ImageIcon, label: '图片', color: 'bg-purple-100 text-purple-700' },
    price: { icon: Tag, label: '价格', color: 'bg-emerald-100 text-emerald-700' },
    other: { icon: History, label: '其他', color: 'bg-slate-100 text-slate-600' },
  }
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h4 className="font-semibold text-slate-900">商品调整时间轴</h4>
          <p className="mt-1 text-xs text-slate-500">
            ROAS 来自正式记录并只读；图片、价格和其他人工事件只保存在当前浏览器。
          </p>
        </div>
        <button type="button" onClick={onAdd} className="btn-secondary self-start text-sm">
          <PlusCircle className="h-4 w-4" /> 记录一次调整
        </button>
      </div>
      {events.length ? (
        <div className="mt-4 space-y-3">
          {events.map((event) => {
            const config = typeConfig[event.type] || typeConfig.other
            const Icon = config.icon
            const relatedImpact = event.source === 'local' ? manualEventImpact(event, dailyRows, trendDays) : null
            return (
              <div key={event.id} className="flex gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className={`mt-0.5 rounded-lg p-2 ${config.color}`}><Icon className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-800">{event.title}</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">{config.label}</span>
                    <span className="text-xs text-slate-400">{event.date}</span>
                  </div>
                  {event.note && <p className="mt-1 text-sm text-slate-600">{event.note}</p>}
                  {relatedImpact?.waiting && (
                    <p className="mt-2 rounded-md bg-blue-50 px-2.5 py-2 text-xs text-blue-700">
                      等待完整数据：修改前 {relatedImpact.before}/{trendDays} 天，修改后 {relatedImpact.after}/{trendDays} 天。
                    </p>
                  )}
                  {relatedImpact && !relatedImpact.waiting && (
                    <div className="mt-2 rounded-md bg-white px-2.5 py-2 text-xs text-slate-600">
                      <span>平均 Units {compact(relatedImpact.beforeUnits, 1)} → {compact(relatedImpact.afterUnits, 1)}</span>
                      <span className="mx-2 text-slate-300">·</span>
                      <span>平均曝光 {compact(relatedImpact.beforeImpressions)} → {compact(relatedImpact.afterImpressions)}</span>
                      <p className="mt-1 text-[11px] text-slate-400">修改后从次日开始比较；仅表示关联变化，不代表单一因果。</p>
                    </div>
                  )}
                </div>
                {event.source === 'local' && (
                  <button type="button" onClick={() => onRemove(event.id)} className="self-start rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="删除本地事件">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">尚未记录任何调整。</p>
      )}
    </section>
  )
}

function TrackerDetails({
  tracker, dailyRows, impact, state, cohortCards, manualEvents, trendDays, onAddEvent, onRemoveEvent,
}) {
  const uploaded = dailyRows.filter((row) => row.uploaded)
  return (
    <div className="border-t border-slate-200 bg-slate-50/50 px-5 py-5">
      <div className="mb-5">
        <MilestoneReviews tracker={tracker} dailyRows={dailyRows} state={state} trendDays={trendDays} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-4">
            <h4 className="font-semibold text-slate-900">14 天 Units 与 ROAS</h4>
            <p className="text-xs text-slate-500">目标 ROAS 修改当天记录，影响从第二天开始观察</p>
          </div>
          {dailyRows.length ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dailyRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="units" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="roas" orientation="right" tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(value, name) => [
                      value == null ? '未上传' : compact(value, name.includes('ROAS') ? 2 : 0),
                      name,
                    ]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.day || ''}
                  />
                  <Legend />
                  <Bar yAxisId="units" dataKey="units" fill="#2563eb" name="Units" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="roas" dataKey="actualRoas" stroke="#10b981" strokeWidth={2} name="实际 ROAS" connectNulls />
                  <Line yAxisId="roas" dataKey="targetRoas" stroke="#f59e0b" strokeDasharray="5 4" strokeWidth={2} name="目标 ROAS" connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="flex h-48 items-center justify-center text-sm text-slate-400">追踪周期尚未开始</div>}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h4 className="font-semibold text-slate-900">最近一次 ROAS 调整影响</h4>
            {!impact && <p className="mt-3 text-sm text-slate-500">目前只有初始目标，尚未记录 ROAS 修改。</p>}
            {impact?.waiting && (
              <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                <p className="font-medium">{impact.change.effectiveDate} 调至 {compact(impact.change.roas, 2)}</p>
                <p className="mt-1">从 {impact.effectStart} 开始计算，目前已收集 {impact.collected} 天，继续等待完整对比数据。</p>
              </div>
            )}
            {impact && !impact.waiting && (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-slate-500">目标 ROAS</span>
                  <span className="font-semibold text-slate-800">{compact(impact.previousRoas, 2)} → {compact(impact.change.roas, 2)}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-slate-500">平均 Units</span>
                  <span className={`font-semibold ${impact.unitsChange >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {compact(impact.beforeUnits, 1)} → {compact(impact.afterUnits, 1)}
                    {' '}({impact.unitsChange >= 0 ? '+' : ''}{(impact.unitsChange * 100).toFixed(0)}%)
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-slate-500">平均曝光</span>
                  <span className="font-semibold text-slate-800">{compact(impact.beforeImpressions)} → {compact(impact.afterImpressions)}</span>
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  这是修改前后关联变化，不代表单一因果；图片、价格、活动和自然流量也可能同时影响销量。
                </p>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h4 className="font-semibold text-slate-900">每日明细</h4>
            <div className="mt-3 max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white text-slate-400">
                  <tr><th className="pb-2 text-left">日期</th><th className="pb-2 text-right">Units</th><th className="pb-2 text-right">曝光</th><th className="pb-2 text-right">ROAS</th></tr>
                </thead>
                <tbody>
                  {dailyRows.map((row) => (
                    <tr key={row.day} className="border-t border-slate-100">
                      <td className="py-2 text-slate-600">{row.day.slice(5)}</td>
                      <td className="py-2 text-right font-medium">{row.uploaded ? compact(row.units) : '未上传'}</td>
                      <td className="py-2 text-right">{row.uploaded ? compact(row.impressions) : '—'}</td>
                      <td className="py-2 text-right">{row.uploaded ? compact(row.actualRoas, 2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!uploaded.length && <p className="py-5 text-center text-xs text-slate-400">暂无已上传数据</p>}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <CohortComparison tracker={tracker} cohortCards={cohortCards} />
        <EventTimeline
          tracker={tracker}
          dailyRows={dailyRows}
          manualEvents={manualEvents}
          trendDays={trendDays}
          onAdd={onAddEvent}
          onRemove={onRemoveEvent}
        />
      </div>
    </div>
  )
}

export default function NewProductTracker() {
  const toast = useToast()
  const [trackers, setTrackers] = useState([])
  const [stores, setStores] = useState([])
  const [storeData, setStoreData] = useState({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [trendDays, setTrendDays] = useState(2)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy, setSortBy] = useState('attention')
  const [expanded, setExpanded] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [roasTracker, setRoasTracker] = useState(null)
  const [eventTracker, setEventTracker] = useState(null)
  const [localEventsByTracker, setLocalEventsByTracker] = useState(readLocalEvents)
  const [saving, setSaving] = useState(false)
  const [createForm, setCreateForm] = useState({
    store: '', spu: '', productName: '', launchDate: todayISO(), initialRoas: '',
  })
  const [roasForm, setRoasForm] = useState({ effectiveDate: todayISO(), roas: '', note: '' })
  const [eventForm, setEventForm] = useState({ date: todayISO(), type: 'image', note: '' })

  const loadAll = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    try {
      const [trackerRes, storeRes] = await Promise.all([fetchNewProductTrackers(), fetchStores()])
      const nextTrackers = trackerRes.trackers || []
      const nextStores = (storeRes.stores || []).map((store) => store.name)
      setTrackers(nextTrackers)
      setStores(nextStores)
      const grouped = new Map()
      for (const tracker of nextTrackers) {
        if (!grouped.has(tracker.store)) grouped.set(tracker.store, [])
        grouped.get(tracker.store).push(tracker)
      }
      const entries = await Promise.all([...grouped.entries()].map(async ([store, items]) => {
        const from = items.map((item) => item.launchDate).sort()[0]
        const cycleEnds = items.map((item) => addDays(item.launchDate, CYCLE_DAYS - 1)).sort()
        const latestEnd = cycleEnds.at(-1)
        const to = latestEnd < todayISO() ? latestEnd : todayISO()
        const [rangeRes, productRes] = await Promise.all([
          from <= to ? fetchStoreRange(store, from, to) : Promise.resolve({ rows: [], days: [] }),
          fetchStoreProducts(store).catch(() => ({ products: [] })),
        ])
        return [store, {
          rows: rangeRes.rows || [],
          days: (rangeRes.days || []).map((day) => day.day),
          products: productRes.products || [],
        }]
      }))
      setStoreData(Object.fromEntries(entries))
    } catch (error) {
      toast.error(error.message, '新品追踪读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  // Keep the loader stable: showing a toast re-renders ToastProvider and creates
  // a new helper object, which must not trigger another data fetch.
  }, [])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_EVENTS_KEY, JSON.stringify(localEventsByTracker))
    } catch {
      // The timeline remains usable for this session if browser storage is unavailable.
    }
  }, [localEventsByTracker])

  const cards = useMemo(() => trackers.map((tracker) => {
    const dailyRows = buildDailyRows(tracker, storeData[tracker.store])
    const analyticsProduct = productMatch(tracker, storeData[tracker.store]?.products || []).product
    const state = cycleState(tracker.launchDate)
    const trend = trendFor(dailyRows, trendDays)
    const uploaded = dailyRows.filter((row) => row.uploaded)
    const latest = uploaded.at(-1)
    const peak = uploaded.length ? Math.max(...uploaded.map((row) => row.units || 0)) : null
    const avgUnits = average(uploaded, 'units')
    const analysis = analysisFor(tracker, dailyRows, trend, state)
    const impact = roasImpact(tracker, dailyRows, trendDays)
    const displayName = tracker.productName || analyticsProduct?.productName || tracker.spu
    return { tracker, displayName, dailyRows, state, trend, latest, peak, avgUnits, analysis, impact }
  }), [trackers, storeData, trendDays])

  const summary = useMemo(() => ({
    active: cards.filter((card) => card.state.phase === 'active').length,
    attention: cards.filter((card) => ['warning', 'danger'].includes(card.analysis.level)).length,
    ended: cards.filter((card) => card.state.phase === 'ended').length,
  }), [cards])

  const visibleCards = useMemo(() => {
    const needle = normalizeId(searchQuery)
    const filtered = cards.filter((card) => {
      const matchesSearch = !needle || [
        card.tracker.spu,
        card.displayName,
        card.tracker.store,
      ].some((value) => normalizeId(value).includes(needle))
      if (!matchesSearch) return false
      if (statusFilter === 'active') return card.state.phase === 'active'
      if (statusFilter === 'attention') return ['warning', 'danger'].includes(card.analysis.level)
      if (statusFilter === 'ended') return card.state.phase === 'ended'
      return true
    })

    const newestFirst = (a, b) => b.tracker.launchDate.localeCompare(a.tracker.launchDate)
    return [...filtered].sort((a, b) => {
      if (sortBy === 'remaining') {
        if (a.state.phase === 'ended' !== (b.state.phase === 'ended')) {
          return a.state.phase === 'ended' ? 1 : -1
        }
        return a.state.remaining - b.state.remaining || newestFirst(a, b)
      }
      if (sortBy === 'newest') return newestFirst(a, b)
      if (sortBy === 'units') return number(b.latest?.units) - number(a.latest?.units) || newestFirst(a, b)

      const attentionRank = (card) => {
        if (card.analysis.level === 'danger') return 0
        if (card.analysis.level === 'warning') return 1
        return 2
      }
      return attentionRank(a) - attentionRank(b)
        || a.state.remaining - b.state.remaining
        || newestFirst(a, b)
    })
  }, [cards, searchQuery, sortBy, statusFilter])

  async function submitCreate(event) {
    event.preventDefault()
    setSaving(true)
    try {
      await createNewProductTracker({ ...createForm, initialRoas: Number(createForm.initialRoas) })
      toast.success('已建立独立的 14 天追踪周期', '新品已加入')
      setShowCreate(false)
      setCreateForm({ store: stores[0] || '', spu: '', productName: '', launchDate: todayISO(), initialRoas: '' })
      await loadAll(true)
    } catch (error) {
      toast.error(error.message, '无法加入追踪')
    } finally {
      setSaving(false)
    }
  }

  function openCreate() {
    setCreateForm((current) => ({ ...current, store: current.store || stores[0] || '', launchDate: todayISO() }))
    setShowCreate(true)
  }

  function openRoas(tracker) {
    const current = [...(tracker.roasEvents || [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).at(-1)
    setRoasForm({ effectiveDate: todayISO(), roas: current?.roas ?? '', note: '' })
    setRoasTracker(tracker)
  }

  async function submitRoas(event) {
    event.preventDefault()
    setSaving(true)
    try {
      await saveNewProductRoas(roasTracker.id, roasForm.effectiveDate, Number(roasForm.roas), roasForm.note)
      toast.success('新目标已保存，系统会从第二天开始比较销量变化', 'ROAS 已记录')
      setRoasTracker(null)
      await loadAll(true)
    } catch (error) {
      toast.error(error.message, 'ROAS 保存失败')
    } finally {
      setSaving(false)
    }
  }

  function openEvent(tracker) {
    const cycleEnd = addDays(tracker.launchDate, CYCLE_DAYS - 1)
    const date = todayISO() < tracker.launchDate
      ? tracker.launchDate
      : todayISO() > cycleEnd ? cycleEnd : todayISO()
    setEventForm({ date, type: 'image', note: '' })
    setEventTracker(tracker)
  }

  function submitEvent(event) {
    event.preventDefault()
    const trackerKey = String(eventTracker.id)
    const nextEvent = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: eventForm.date,
      type: eventForm.type,
      title: eventTitle(eventForm.type),
      note: eventForm.note.trim(),
      source: 'local',
    }
    setLocalEventsByTracker((current) => ({
      ...current,
      [trackerKey]: [...(Array.isArray(current[trackerKey]) ? current[trackerKey] : []), nextEvent],
    }))
    setEventTracker(null)
    toast.success('这条记录只保存在当前浏览器，不会修改 Analytics 数据', '调整已记录')
  }

  function removeEvent(trackerId, eventId) {
    if (!window.confirm('确定删除这条本地调整记录吗？')) return
    const trackerKey = String(trackerId)
    setLocalEventsByTracker((current) => ({
      ...current,
      [trackerKey]: (Array.isArray(current[trackerKey]) ? current[trackerKey] : [])
        .filter((event) => event.id !== eventId),
    }))
  }

  async function removeTracker(tracker) {
    const confirmed = window.confirm(
      `确定删除 ${tracker.spu} 的新品追踪吗？\n\n会删除这个追踪周期、ROAS 记录和当前浏览器的人工事件，不会删除 Analytics 原始数据。`
    )
    if (!confirmed) return
    try {
      await deleteNewProductTracker(tracker.id)
      setTrackers((current) => current.filter((item) => item.id !== tracker.id))
      setLocalEventsByTracker((current) => {
        const next = { ...current }
        delete next[String(tracker.id)]
        return next
      })
      toast.success('Analytics 原始数据仍然保留', '追踪已删除')
    } catch (error) {
      toast.error(error.message, '删除失败')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center text-slate-500">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" />
          正在从 Analytics 读取新品数据…
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 sm:p-6">
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-blue-900 p-6 text-white shadow-lg">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-200">
              <Rocket className="h-4 w-4" /> 新品 14 天观察窗口
            </div>
            <h2 className="text-2xl font-bold">新品追踪</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-blue-100/80">
              每日数据直接读取 Analytics。系统分析 Units、流量、转化和 ROAS 修改后的变化，只提供建议，不会自动改动商品。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => loadAll(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> 同步 Analytics
            </button>
            <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-50">
              <PackagePlus className="h-4 w-4" /> 加入新品
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="追踪中" value={summary.active} note="14 天周期内" icon={Clock3} color="blue" />
        <SummaryCard label="需要关注" value={summary.attention} note="趋势或流量触发提醒" icon={AlertTriangle} color="amber" />
        <SummaryCard label="周期结束" value={summary.ended} note="可复盘后删除或重上" icon={CalendarDays} color="slate" />
      </div>

      <div className="card flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
        <div>
          <p className="font-semibold text-slate-800">趋势比较方式</p>
          <p className="text-sm text-slate-500">“明显上升”定义为最近阶段平均 Units 比上一阶段高 20% 以上。</p>
        </div>
        <div className="inline-flex self-start rounded-lg bg-slate-100 p-1 sm:self-auto">
          {[1, 2].map((days) => (
            <button key={days} onClick={() => setTrendDays(days)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${trendDays === days ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
              {days === 1 ? '每天对比' : '每两天对比'}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(240px,1fr)_180px_200px]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-500">搜索新品</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="input-base pl-9"
                  placeholder="搜索 SPU、款名或店铺"
                />
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-500">状态</span>
              <select className="input-base" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="all">全部</option>
                <option value="active">追踪中</option>
                <option value="attention">需关注</option>
                <option value="ended">已结束</option>
              </select>
            </label>
            <label className="block sm:col-span-2 lg:col-span-1">
              <span className="mb-1.5 block text-xs font-medium text-slate-500">排序</span>
              <select className="input-base" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="attention">需关注优先</option>
                <option value="remaining">剩余时间少 → 多</option>
                <option value="newest">最新上架</option>
                <option value="units">Units 最高</option>
              </select>
            </label>
          </div>
          <p className="whitespace-nowrap text-sm text-slate-500">
            显示 <span className="font-semibold text-slate-900">{visibleCards.length}</span> / {cards.length} 个新品
          </p>
        </div>
      </div>

      {!cards.length ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <div className="rounded-2xl bg-blue-50 p-4 text-blue-600"><Rocket className="h-9 w-9" /></div>
          <h3 className="mt-5 text-lg font-semibold text-slate-900">还没有追踪中的新品</h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">加入 SPU、选择对应的 Analytics 店铺并填写上架日期和初始目标 ROAS，即可开始 14 天追踪。</p>
          <button onClick={openCreate} className="btn-primary mt-5"><PackagePlus className="h-4 w-4" /> 加入第一个新品</button>
        </div>
      ) : !visibleCards.length ? (
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <div className="rounded-2xl bg-slate-100 p-4 text-slate-500"><Search className="h-8 w-8" /></div>
          <h3 className="mt-4 text-lg font-semibold text-slate-900">没有符合条件的新品</h3>
          <p className="mt-2 text-sm text-slate-500">尝试更换关键词或状态筛选。</p>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              setStatusFilter('all')
              setSortBy('attention')
            }}
            className="btn-secondary mt-5"
          >
            清空筛选
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleCards.map(({ tracker, displayName, dailyRows, state, trend, latest, peak, avgUnits, analysis, impact }) => {
            const expandedNow = expanded === tracker.id
            const cohortKey = launchCohortStart(tracker.launchDate)
            const cohortCards = cards.filter((card) => launchCohortStart(card.tracker.launchDate) === cohortKey)
            const savedEvents = localEventsByTracker[String(tracker.id)]
            const manualEvents = Array.isArray(savedEvents) ? savedEvents : []
            const analysisStyle = {
              good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
              warning: 'border-amber-200 bg-amber-50 text-amber-900',
              danger: 'border-red-200 bg-red-50 text-red-900',
              waiting: 'border-blue-200 bg-blue-50 text-blue-900',
              neutral: 'border-slate-200 bg-slate-50 text-slate-800',
            }[analysis.level]
            const latestTarget = [...(tracker.roasEvents || [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).at(-1)?.roas
            return (
              <article key={tracker.id} className="card overflow-hidden">
                <div className="p-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-bold text-slate-900">{displayName}</h3>
                        <TrendBadge trend={trend} />
                        {state.phase === 'ended' && <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600">周期已结束</span>}
                        {state.phase === 'future' && <span className="rounded-full bg-purple-100 px-2.5 py-1 text-xs font-semibold text-purple-700">等待上架</span>}
                      </div>
                      <p className="mt-1 text-sm text-slate-500">SPU {tracker.spu} · {tracker.store} · 上架 {tracker.launchDate}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => openRoas(tracker)} className="btn-secondary text-sm"><Pencil className="h-4 w-4" /> 修改 ROAS</button>
                      <button onClick={() => removeTracker(tracker)} className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
                        <Trash2 className="h-4 w-4" /> 删除
                      </button>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
                    <div className="rounded-xl bg-slate-900 p-4 text-white">
                      <div className="flex items-end justify-between">
                        <div>
                          <p className="text-xs text-slate-400">新品周期</p>
                          <p className="mt-1 text-2xl font-bold">
                            {state.phase === 'future' ? '尚未开始' : `第 ${state.day} / 14 天`}
                          </p>
                        </div>
                        <Clock3 className="h-7 w-7 text-blue-400" />
                      </div>
                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-700">
                        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${state.progress}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-slate-400">
                        {state.phase === 'future' ? `距离上架还有 ${Math.abs(dayDiff(tracker.launchDate, todayISO()))} 天`
                          : state.phase === 'ended' ? '14 天观察期已经结束'
                            : state.remaining === 0 ? '今天是最后一天' : `还剩 ${state.remaining} 天`}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                      <Metric label="最新 Units" value={compact(latest?.units)} sub={latest?.day || '暂无上传'} />
                      <Metric label="日均 Units" value={compact(avgUnits, 1)} sub={`${dailyRows.filter((row) => row.uploaded).length} 天数据`} />
                      <Metric label="最高单日" value={compact(peak)} sub="判断是否超过 25" />
                      <Metric label="最新曝光" value={compact(latest?.impressions)} sub={`CTR ${percent(latest?.ctr)}`} />
                      <Metric label="转化率" value={percent(latest?.conversionRate)} sub={`${compact(latest?.orders)} 单`} />
                      <Metric label="实际 / 目标 ROAS" value={`${compact(latest?.actualRoas, 2)} / ${compact(latestTarget, 2)}`} sub="实际值来自 Analytics" />
                    </div>
                  </div>

                  <div className={`mt-4 rounded-xl border p-4 ${analysisStyle}`}>
                    <div className="flex items-start gap-3">
                      <Sparkles className="mt-0.5 h-5 w-5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold">{analysis.title}</p>
                        <p className="mt-1 text-sm leading-6 opacity-80">{analysis.detail}</p>
                      </div>
                    </div>
                  </div>

                  <button onClick={() => setExpanded(expandedNow ? null : tracker.id)}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">
                    <BarChart3 className="h-4 w-4" /> {expandedNow ? '收起详细数据' : '查看图表、每日数据与 ROAS 影响'}
                    {expandedNow ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>
                {expandedNow && (
                  <TrackerDetails
                    tracker={tracker}
                    dailyRows={dailyRows}
                    impact={impact}
                    state={state}
                    cohortCards={cohortCards}
                    manualEvents={manualEvents}
                    trendDays={trendDays}
                    onAddEvent={() => openEvent(tracker)}
                    onRemoveEvent={(eventId) => removeEvent(tracker.id, eventId)}
                  />
                )}
              </article>
            )
          })}
        </div>
      )}

      {showCreate && (
        <Modal title="加入新品追踪" onClose={() => setShowCreate(false)}>
          <form onSubmit={submitCreate} className="space-y-4 p-6">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Analytics 店铺 *</label>
              <select required className="input-base" value={createForm.store} onChange={(e) => setCreateForm({ ...createForm, store: e.target.value })}>
                <option value="">选择已有店铺</option>
                {stores.map((store) => <option key={store} value={store}>{store}</option>)}
              </select>
              {!stores.length && <p className="mt-1 text-xs text-amber-600">请先在 Analytics 建立店铺并上传数据。</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">SPU *</label>
                <input required className="input-base" value={createForm.spu} onChange={(e) => setCreateForm({ ...createForm, spu: e.target.value })} placeholder="例如 5010015" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">款名（可选）</label>
                <input className="input-base" value={createForm.productName} onChange={(e) => setCreateForm({ ...createForm, productName: e.target.value })} placeholder="方便识别" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">新品上架日期 *</label>
                <input required type="date" className="input-base" value={createForm.launchDate} onChange={(e) => setCreateForm({ ...createForm, launchDate: e.target.value })} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">初始目标 ROAS *</label>
                <input required min="0.01" step="0.01" type="number" className="input-base" value={createForm.initialRoas} onChange={(e) => setCreateForm({ ...createForm, initialRoas: e.target.value })} placeholder="例如 2.5" />
              </div>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-800">
              数据会按“店铺 + SPU + 上架日期”从 Analytics 自动提取。删除追踪不会删除 Analytics 数据。
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary">取消</button>
              <button type="submit" disabled={saving || !stores.length} className="btn-primary disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} 开始追踪
              </button>
            </div>
          </form>
        </Modal>
      )}

      {roasTracker && (
        <Modal title={`修改 ${roasTracker.spu} 的目标 ROAS`} onClose={() => setRoasTracker(null)}>
          <form onSubmit={submitRoas} className="space-y-4 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">修改日期 *</label>
                <input required type="date" min={roasTracker.launchDate} className="input-base" value={roasForm.effectiveDate} onChange={(e) => setRoasForm({ ...roasForm, effectiveDate: e.target.value })} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">新目标 ROAS *</label>
                <input required min="0.01" step="0.01" type="number" className="input-base" value={roasForm.roas} onChange={(e) => setRoasForm({ ...roasForm, roas: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">备注（可选）</label>
              <textarea rows="3" className="input-base resize-none" value={roasForm.note} onChange={(e) => setRoasForm({ ...roasForm, note: e.target.value })} placeholder="例如：为了拉曝光，从 2.8 调低到 2.4" />
            </div>
            <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
              当天用于记录修改动作，系统从第二天的 Analytics 数据开始计算影响。若同一天再次保存，会更新当天记录。
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setRoasTracker(null)} className="btn-secondary">取消</button>
              <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gauge className="h-4 w-4" />} 保存 ROAS
              </button>
            </div>
          </form>
        </Modal>
      )}

      {eventTracker && (
        <Modal title={`记录 ${eventTracker.spu} 的商品调整`} onClose={() => setEventTracker(null)}>
          <form onSubmit={submitEvent} className="space-y-4 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">调整日期 *</label>
                <input
                  required
                  type="date"
                  min={eventTracker.launchDate}
                  max={todayISO() < eventTracker.launchDate
                    ? eventTracker.launchDate
                    : todayISO() < addDays(eventTracker.launchDate, CYCLE_DAYS - 1)
                      ? todayISO()
                      : addDays(eventTracker.launchDate, CYCLE_DAYS - 1)}
                  className="input-base"
                  value={eventForm.date}
                  onChange={(event) => setEventForm({ ...eventForm, date: event.target.value })}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">调整类型 *</label>
                <select
                  required
                  className="input-base"
                  value={eventForm.type}
                  onChange={(event) => setEventForm({ ...eventForm, type: event.target.value })}
                >
                  <option value="image">图片</option>
                  <option value="price">价格</option>
                  <option value="other">其他</option>
                  <option value="roas" disabled>ROAS（请使用正式 ROAS 入口）</option>
                </select>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">修改内容（可选）</label>
              <textarea
                rows="3"
                className="input-base resize-none"
                value={eventForm.note}
                onChange={(event) => setEventForm({ ...eventForm, note: event.target.value })}
                placeholder="例如：替换第一张主图，其他设置保持不变"
              />
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-800">
              这条人工记录只保存在当前浏览器。ROAS 调整请使用卡片上的“修改 ROAS”，系统会把正式记录自动合并到时间轴。
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEventTracker(null)} className="btn-secondary">取消</button>
              <button type="submit" className="btn-primary"><History className="h-4 w-4" /> 保存记录</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
