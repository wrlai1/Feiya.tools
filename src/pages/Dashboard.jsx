import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Package,
  Palette,
  TrendingUp,
} from 'lucide-react'
import KPICard from '../components/KPICard.jsx'
import { fetchStores } from '../utils/api.js'
import { formatISODate, loadSalesSummary, shiftISODate } from '../utils/salesSummary.js'

const EMPTY_SUMMARY = {
  latestDay: '',
  from: '',
  trend: [],
  latestUnits: 0,
  sevenDayTotal: 0,
  thirtyDayAverage: 0,
  topProducts: [],
  topColors: [],
  storeCount: 0,
  latestStoreCount: 0,
  availableDayCount: 0,
}

function units(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US')
}

function shortDate(day) {
  return day ? day.slice(5).replace('-', '/') : '-'
}

function changeLabel(row) {
  if (row.isNew) return { text: 'New', className: 'text-blue-600 bg-blue-50', icon: TrendingUp }
  if (row.change == null) return { text: '-', className: 'text-slate-400 bg-slate-50', icon: null }
  const up = row.change >= 0
  return {
    text: `${up ? '+' : ''}${(row.change * 100).toFixed(0)}%`,
    className: up ? 'text-green-700 bg-green-50' : 'text-red-700 bg-red-50',
    icon: up ? ArrowUpRight : ArrowDownRight,
  }
}

function colorSwatch(name) {
  const value = String(name || '').toLowerCase()
  const colors = [
    ['black', '#111827'], ['white', '#ffffff'], ['navy', '#1e3a8a'], ['blue', '#3b82f6'],
    ['red', '#ef4444'], ['green', '#22c55e'], ['pink', '#ec4899'], ['purple', '#a855f7'],
    ['yellow', '#eab308'], ['orange', '#f97316'], ['brown', '#92400e'], ['khaki', '#b9a66a'],
    ['beige', '#d6c7a1'], ['gray', '#94a3b8'], ['grey', '#94a3b8'],
    ['黑', '#111827'], ['白', '#ffffff'], ['蓝', '#3b82f6'], ['红', '#ef4444'],
    ['绿', '#22c55e'], ['粉', '#ec4899'], ['紫', '#a855f7'], ['黄', '#eab308'],
  ]
  return colors.find(([key]) => value.includes(key))?.[1] || '#cbd5e1'
}

function SalesTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload || {}
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold text-slate-700">{formatISODate(label)}</p>
      <p className="mt-0.5 text-sm font-bold text-blue-700">{units(payload[0].value)} units</p>
      <p className="text-[11px] text-slate-400">{row.storeCount || 0} stores reported</p>
    </div>
  )
}

function RankingList({ title, icon: Icon, rows, type }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-slate-500" />
          <h3 className="font-semibold text-slate-800">{title}</h3>
        </div>
        <span className="text-[11px] text-slate-400">Last 7 days</span>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((row, index) => {
          const change = changeLabel(row)
          const ChangeIcon = change.icon
          const content = (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="w-4 flex-shrink-0 text-xs font-semibold text-slate-400">{index + 1}</span>
                {type === 'color' && (
                  <span
                    className="h-4 w-4 flex-shrink-0 rounded-sm border border-slate-300"
                    style={{ backgroundColor: colorSwatch(row.label) }}
                    title={row.label}
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-700">
                    {type === 'product' ? row.sku || row.spu : row.label}
                  </p>
                  {type === 'product' && (
                    <p className="truncate text-[11px] text-slate-400">{row.productName || `SPU ${row.spu}`}</p>
                  )}
                </div>
              </div>
              <div className="ml-3 flex flex-shrink-0 items-center gap-2">
                <span className="text-sm font-semibold text-slate-700">{units(row.units)}</span>
                <span className={`inline-flex min-w-12 items-center justify-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${change.className}`}>
                  {ChangeIcon && <ChangeIcon className="h-3 w-3" />}
                  {change.text}
                </span>
                {type === 'product' && <ArrowRight className="h-3.5 w-3.5 text-slate-300" />}
              </div>
            </>
          )
          return type === 'product' ? (
            <Link
              key={row.key}
              to={`/analytics?store=${encodeURIComponent(row.topStore)}&spu=${encodeURIComponent(row.spu)}`}
              className="flex min-h-12 items-center py-2 hover:bg-slate-50"
            >
              {content}
            </Link>
          ) : (
            <div key={row.key} className="flex min-h-12 items-center py-2">{content}</div>
          )
        })}
        {!rows.length && (
          <div className="flex min-h-28 items-center justify-center px-4 text-center text-sm text-slate-400">
            {type === 'color' ? '销售报表暂时没有颜色数据' : '最近 7 天没有款式销量数据'}
          </div>
        )}
      </div>
    </section>
  )
}

export default function Dashboard() {
  const [summary, setSummary] = useState(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const storeResult = await fetchStores()
        const next = await loadSalesSummary(storeResult.stores || [])
        if (!cancelled) setSummary(next)
      } catch (err) {
        if (!cancelled) {
          setSummary(EMPTY_SUMMARY)
          setError('Sales data could not be loaded. Please refresh the page.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const sevenFrom = summary.latestDay ? shiftISODate(summary.latestDay, -6) : ''
  const dateRange = summary.latestDay
    ? `${formatISODate(summary.from)} - ${formatISODate(summary.latestDay)}`
    : 'No sales dates available'

  return (
    <div className="max-w-7xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Sales Overview</h2>
          <p className="mt-1 text-sm text-slate-500">All stores combined. Open Analytics for product and store details.</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <CalendarDays className="h-4 w-4 text-blue-600" />
          <div>
            <p className="text-[10px] font-semibold uppercase text-slate-400">Data period</p>
            <p className="text-sm font-semibold text-slate-700">{loading ? 'Loading...' : dateRange}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{error}</div>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard
          title="Latest Day Sales"
          value={loading ? '-' : units(summary.latestUnits)}
          subtitle={summary.latestDay ? `${formatISODate(summary.latestDay)} · ${summary.latestStoreCount}/${summary.storeCount} stores` : 'No sales data'}
          icon={Package}
          color="blue"
        />
        <KPICard
          title="Last 7 Days"
          value={loading ? '-' : units(summary.sevenDayTotal)}
          subtitle={summary.latestDay ? `${formatISODate(sevenFrom)} - ${formatISODate(summary.latestDay)}` : 'No sales data'}
          icon={BarChart3}
          color="teal"
        />
        <KPICard
          title="30-Day Daily Average"
          value={loading ? '-' : units(summary.thirtyDayAverage)}
          subtitle={summary.availableDayCount ? `Based on ${summary.availableDayCount} days with data` : 'No sales data'}
          icon={TrendingUp}
          color="orange"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-800">Daily Sales Trend</h3>
              <p className="mt-0.5 text-xs text-slate-400">Daily units from all stores</p>
            </div>
            <Link to="/analytics" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
              Analytics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {summary.trend.length ? (
            <ResponsiveContainer width="100%" height={310}>
              <LineChart data={summary.trend} margin={{ top: 8, right: 12, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={units} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<SalesTooltip />} />
                <Line type="monotone" dataKey="units" name="Daily Units" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 2.5, fill: '#ffffff', strokeWidth: 2 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[310px] items-center justify-center text-sm text-slate-400">
              {loading ? 'Loading sales trend...' : 'No sales trend available'}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <RankingList title="Top Styles" icon={Package} rows={summary.topProducts} type="product" />
          <RankingList title="Top Colors" icon={Palette} rows={summary.topColors} type="color" />
        </div>
      </section>
    </div>
  )
}
