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
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  BarChart3,
  CalendarDays,
  ClipboardCheck,
  Package,
  Palette,
  Rocket,
  TrendingUp,
  UploadCloud,
} from 'lucide-react'
import KPICard from '../components/KPICard.jsx'
import { useAuth } from '../context/AuthContext.jsx'
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

function QuickAction({ to, icon: Icon, label, detail, color = 'blue' }) {
  const styles = {
    blue: 'bg-blue-50 text-[#0071e3]',
    emerald: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
    amber: 'bg-amber-50 text-amber-600',
  }
  return (
    <Link to={to} className="group card flex items-center gap-3 p-4 transition-transform duration-200 hover:-translate-y-0.5">
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${styles[color]}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="truncate text-xs text-slate-400">{detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#0071e3]" />
    </Link>
  )
}

function ActionRow({ to, icon: Icon, title, detail, badge, tone = 'blue' }) {
  const styles = {
    blue: {
      icon: 'bg-blue-50 text-[#0071e3]',
      badge: 'bg-blue-50 text-[#0071e3]',
    },
    green: {
      icon: 'bg-emerald-50 text-emerald-600',
      badge: 'bg-emerald-50 text-emerald-700',
    },
    amber: {
      icon: 'bg-amber-50 text-amber-600',
      badge: 'bg-amber-50 text-amber-700',
    },
    purple: {
      icon: 'bg-purple-50 text-purple-600',
      badge: 'bg-purple-50 text-purple-700',
    },
  }
  const style = styles[tone]
  return (
    <Link to={to} className="group flex items-center gap-3 rounded-xl border border-transparent px-2 py-3 transition-colors hover:border-slate-200 hover:bg-slate-50">
      <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${style.icon}`}>
        <Icon className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.badge}`}>{badge}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-slate-400">{detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </Link>
  )
}

function RankingList({ title, icon: Icon, rows, type }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
            <Icon className="h-4 w-4 text-slate-500" strokeWidth={1.8} />
          </div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-500">Last 7 days</span>
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
              className="flex min-h-12 items-center rounded-xl px-2 py-2 transition-colors hover:bg-slate-50"
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
  const { user } = useAuth()
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
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const todayLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date())
  const coverageComplete = summary.storeCount > 0 && summary.latestStoreCount === summary.storeCount
  const leadingStyle = summary.topProducts[0]
  const missingStores = Math.max(summary.storeCount - summary.latestStoreCount, 0)
  const leadingStylePath = leadingStyle
    ? `/analytics?store=${encodeURIComponent(leadingStyle.topStore)}&spu=${encodeURIComponent(leadingStyle.spu)}`
    : '/analytics'

  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <section className="flex flex-col gap-5 rounded-[24px] border border-slate-200/70 bg-white px-6 py-6 shadow-[0_1px_2px_rgba(15,23,42,0.02),0_14px_40px_rgba(15,23,42,0.04)] sm:px-7 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-[#0071e3]">{todayLabel}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">
            {greeting}{user?.username ? `, ${user.username}` : ''}
          </h2>
          <p className="mt-2 text-sm text-slate-500">Here is what is happening across your operations today.</p>
        </div>
        <div className="flex items-center gap-3 rounded-2xl bg-[#f5f5f7] px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0071e3] shadow-sm">
            <CalendarDays className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Current data window</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">{loading ? 'Loading...' : dateRange}</p>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{error}</div>
      )}

      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-[-0.02em] text-slate-950">Quick Actions</h3>
            <p className="text-xs text-slate-400">Jump back into your most-used workspaces.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction to="/analytics" icon={BarChart3} label="Open Analytics" detail="Sales and traffic performance" color="blue" />
          <QuickAction to="/new-products" icon={Rocket} label="Track New Products" detail="Review 14-day launch progress" color="purple" />
          <QuickAction to="/inventory" icon={Package} label="Check Inventory" detail="Search and validate stock" color="emerald" />
          <QuickAction to="/auto-deduct" icon={ClipboardCheck} label="Run Auto Deduct" detail="Prepare inventory deductions" color="amber" />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard
          title="Latest Day Units"
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

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,0.72fr)]">
        <div className="card p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold tracking-[-0.02em] text-slate-950">Sales Momentum</h3>
              <p className="mt-1 text-xs text-slate-400">Daily Units across all reporting stores</p>
            </div>
            <Link to="/analytics" className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-[#0071e3] hover:bg-blue-100">
              Analytics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {summary.trend.length ? (
            <ResponsiveContainer width="100%" height={310}>
              <LineChart data={summary.trend} margin={{ top: 8, right: 12, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={units} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<SalesTooltip />} />
                <Line type="monotone" dataKey="units" name="Daily Units" stroke="#0071e3" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: '#ffffff', stroke: '#0071e3', strokeWidth: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[310px] items-center justify-center text-sm text-slate-400">
              {loading ? 'Loading sales trend...' : 'No sales trend available'}
            </div>
          )}
        </div>

        <aside className="card p-4 sm:p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-[#0071e3]">
              <Activity className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-950">Today’s Actions</h3>
              <p className="text-xs text-slate-400">Open the next task directly</p>
            </div>
          </div>
          <div className="space-y-1">
            <ActionRow
              to="/analytics"
              icon={summary.latestDay ? BarChart3 : UploadCloud}
              title={summary.latestDay ? 'Review latest sales' : 'Upload Analytics data'}
              detail={summary.latestDay ? `${units(summary.latestUnits)} Units reported on ${formatISODate(summary.latestDay)}.` : 'No sales dates are available yet. Start with the daily upload.'}
              badge={summary.latestDay ? 'Latest' : 'Required'}
              tone={summary.latestDay ? 'blue' : 'amber'}
            />
            <ActionRow
              to="/analytics"
              icon={coverageComplete ? CheckCircle2 : UploadCloud}
              title={coverageComplete ? 'Store reporting complete' : 'Complete store reporting'}
              detail={coverageComplete
                ? `All ${summary.storeCount} stores are included in the latest report.`
                : summary.storeCount
                  ? `${missingStores} of ${summary.storeCount} stores may still need the latest upload.`
                  : 'Create a store in Analytics to begin reporting.'}
              badge={coverageComplete ? 'Complete' : summary.storeCount ? `${missingStores} missing` : 'Set up'}
              tone={coverageComplete ? 'green' : 'amber'}
            />
            <ActionRow
              to={leadingStylePath}
              icon={TrendingUp}
              title={leadingStyle ? `Review ${leadingStyle.sku || leadingStyle.spu}` : 'Review product rankings'}
              detail={leadingStyle ? `${units(leadingStyle.units)} Units during the last 7 days.` : 'Product rankings will appear after recent sales are uploaded.'}
              badge={leadingStyle ? 'Top style' : 'Open'}
              tone={leadingStyle ? 'green' : 'blue'}
            />
            <ActionRow
              to="/new-products"
              icon={Rocket}
              title="Review new product launches"
              detail="Check countdowns, Units trends, and recent ROAS changes."
              badge="14-day"
              tone="purple"
            />
          </div>
        </aside>
      </section>

      <section>
        <div className="mb-3">
          <h3 className="text-lg font-semibold tracking-[-0.02em] text-slate-950">What’s Moving</h3>
          <p className="text-xs text-slate-400">The strongest styles and colors from the last seven days.</p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <RankingList title="Top Styles" icon={Package} rows={summary.topProducts} type="product" />
          <RankingList title="Top Colors" icon={Palette} rows={summary.topColors} type="color" />
        </div>
      </section>
    </div>
  )
}
