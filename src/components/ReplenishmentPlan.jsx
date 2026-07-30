import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  Download,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react'
import { fetchMovements } from '../utils/api.js'
import { calculateReplenishmentPlan } from '../utils/replenishmentPlan.js'

const DEFAULT_SETTINGS = {
  windowDays: 30,
  leadDays: 30,
  safetyDays: 14,
  targetDays: 60,
}

const STATUS = {
  urgent: {
    label: 'Urgent / 紧急',
    badge: 'bg-red-100 text-red-700',
    border: 'border-red-200 bg-red-50/40',
    rank: 0,
  },
  reorder: {
    label: 'Order now / 该补货',
    badge: 'bg-orange-100 text-orange-700',
    border: 'border-orange-200 bg-orange-50/40',
    rank: 1,
  },
  watch: {
    label: 'Watch / 关注',
    badge: 'bg-amber-100 text-amber-700',
    border: 'border-amber-200 bg-amber-50/30',
    rank: 2,
  },
  healthy: {
    label: 'Healthy / 正常',
    badge: 'bg-emerald-100 text-emerald-700',
    border: 'border-slate-200 bg-white',
    rank: 3,
  },
  'no-demand': {
    label: 'No recent demand / 近期无销量',
    badge: 'bg-slate-100 text-slate-600',
    border: 'border-slate-200 bg-white',
    rank: 4,
  },
}

function readSavedPlan(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return {
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
      incomingByKey: saved.incomingByKey || {},
    }
  } catch {
    return { settings: DEFAULT_SETTINGS, incomingByKey: {} }
  }
}

function safePlanningNumber(value, fallback, minimum = 0, maximum = 3650) {
  if (value === '') return minimum
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(number)))
}

function daysLabel(value) {
  if (!Number.isFinite(value)) return '∞'
  return `${Math.round(value)}d`
}

function confidenceMessage(meta) {
  if (meta.confidence === 'none') return 'No Auto Deduct history is available yet. Suggestions are waiting for sales data.'
  if (meta.confidence === 'low') return `Low confidence: only ${meta.historySpanDays} calendar day(s) and ${meta.activeDayCount} active day(s) are available.`
  if (meta.confidence === 'medium') return `Building confidence: ${meta.historySpanDays}/${meta.windowDays} calendar days and ${meta.activeDayCount} active day(s).`
  return `High confidence: ${meta.historySpanDays} calendar days with ${meta.activeDayCount} active sales day(s).`
}

function StatusBadge({ status }) {
  const config = STATUS[status] || STATUS['no-demand']
  return <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${config.badge}`}>{config.label}</span>
}

function IncomingInput({ row, onChange }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min="0"
      step="1"
      value={row.incoming || ''}
      placeholder="0"
      onChange={(event) => onChange(row.key, event.target.value)}
      aria-label={`Incoming units for ${row.style} ${row.color} ${row.size}`}
      className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-right text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
    />
  )
}

export default function ReplenishmentPlan({ inventoryRows, storageOwner = 'admin' }) {
  const storageKey = `feiya-replenishment-plan-v1:${storageOwner}`
  const saved = useMemo(() => readSavedPlan(storageKey), [storageKey])
  const [settings, setSettings] = useState(saved.settings)
  const [incomingByKey, setIncomingByKey] = useState(saved.incomingByKey)
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('action')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetchMovements(30)
      setMovements(response.rows || [])
    } catch (loadError) {
      setMovements([])
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ settings, incomingByKey }))
  }, [incomingByKey, settings, storageKey])

  const plan = useMemo(() => calculateReplenishmentPlan({
    inventoryRows,
    movements,
    incomingByKey,
    ...settings,
  }), [incomingByKey, inventoryRows, movements, settings])

  const visibleRows = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return plan.rows
      .filter((row) => {
        if (filter === 'urgent' && row.status !== 'urgent') return false
        if (filter === 'action' && !row.recommendedQty) return false
        if (!terms.length) return true
        const searchable = `${row.style} ${row.color} ${row.size}`.toLocaleLowerCase()
        return terms.every((term) => searchable.includes(term))
      })
      .sort((a, b) => {
        const statusDifference = STATUS[a.status].rank - STATUS[b.status].rank
        if (statusDifference) return statusDifference
        if (b.recommendedQty !== a.recommendedQty) return b.recommendedQty - a.recommendedQty
        return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' })
      })
  }, [filter, plan.rows, query])

  const totals = useMemo(() => plan.rows.reduce((summary, row) => ({
    sales: summary.sales + row.sales,
    inventory: summary.inventory + row.onHand,
    incoming: summary.incoming + row.incoming,
    recommended: summary.recommended + row.recommendedQty,
    urgent: summary.urgent + (row.status === 'urgent' ? 1 : 0),
    action: summary.action + (row.recommendedQty > 0 ? 1 : 0),
  }), { sales: 0, inventory: 0, incoming: 0, recommended: 0, urgent: 0, action: 0 }), [plan.rows])

  const updateSetting = (field, value) => {
    const minimum = field === 'windowDays' || field === 'targetDays' ? 1 : 0
    setSettings((current) => ({
      ...current,
      [field]: safePlanningNumber(value, current[field], minimum),
    }))
  }

  const updateIncoming = (key, value) => {
    setIncomingByKey((current) => {
      if (value === '') {
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: safePlanningNumber(value, 0, 0, 100000000) }
    })
  }

  const exportPlan = async () => {
    if (!visibleRows.length) return
    setExporting(true)
    setError('')
    try {
      const XLSX = await import('xlsx')
      const rows = visibleRows.map((row) => ({
        Style: row.style,
        Color: row.color,
        Size: row.size,
        [`Sales (${plan.meta.windowDays}d)`]: row.sales,
        Returns: row.returns,
        'Daily Net Sales': Number(row.dailyNetSales.toFixed(2)),
        'On Hand': row.onHand,
        Incoming: row.incoming,
        'Days Left': Number.isFinite(row.daysLeft) ? Math.round(row.daysLeft) : '',
        'Reorder Point': row.reorderPoint,
        'Target Stock': row.targetStock,
        'Suggested Replenishment': row.recommendedQty,
        Status: STATUS[row.status].label,
        Confidence: plan.meta.confidence,
      }))
      const sheet = XLSX.utils.json_to_sheet(rows)
      sheet['!cols'] = Object.keys(rows[0]).map((header) => ({
        wch: Math.min(28, Math.max(10, header.length + 2)),
      }))
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, 'Replenishment Plan')
      XLSX.writeFile(workbook, `replenishment_plan_${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch (exportError) {
      setError(`Export failed: ${exportError.message}`)
    } finally {
      setExporting(false)
    }
  }

  const confidenceTone = plan.meta.confidence === 'high'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : plan.meta.confidence === 'none' || plan.meta.confidence === 'low'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-blue-200 bg-blue-50 text-blue-800'

  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-slate-800">
              <PackagePlus className="h-5 w-5 text-indigo-600" />
              Replenishment Plan / 补货计划
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Applied Auto Deduct orders are already included in current inventory and are never deducted twice.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} disabled={loading} className="btn-secondary text-sm disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={exportPlan} disabled={!visibleRows.length || exporting} className="btn-primary text-sm disabled:opacity-50">
              <Download className="h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export Plan'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-xs font-medium text-slate-500">
            Sales window
            <select
              value={settings.windowDays}
              onChange={(event) => updateSetting('windowDays', event.target.value)}
              className="input-base mt-1"
            >
              {[7, 14, 30].map((days) => <option key={days} value={days}>Last {days} days</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">
            Production + shipping days
            <input type="number" min="0" step="1" value={settings.leadDays}
              onChange={(event) => updateSetting('leadDays', event.target.value)} className="input-base mt-1" />
          </label>
          <label className="text-xs font-medium text-slate-500">
            Safety days
            <input type="number" min="0" step="1" value={settings.safetyDays}
              onChange={(event) => updateSetting('safetyDays', event.target.value)} className="input-base mt-1" />
          </label>
          <label className="text-xs font-medium text-slate-500">
            Target stock days
            <input type="number" min="1" step="1" value={settings.targetDays}
              onChange={(event) => updateSetting('targetDays', event.target.value)} className="input-base mt-1" />
          </label>
        </div>

        <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${confidenceTone}`}>
          {plan.meta.confidence === 'high'
            ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-semibold">{confidenceMessage(plan.meta)}</p>
            <p className="mt-0.5 opacity-80">
              Suggestions use net inventory flow (sales minus restocked returns). Incoming units are saved on this device and reduce the suggested order.
            </p>
            {plan.meta.targetDays !== settings.targetDays && (
              <p className="mt-0.5 font-medium">
                Target cover was raised to {plan.meta.targetDays} days so it is not shorter than lead time plus safety days.
              </p>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Window sales', totals.sales],
          ['Current inventory', totals.inventory],
          ['Incoming', totals.incoming],
          ['SKUs to order', totals.action],
          ['Urgent SKUs', totals.urgent],
          ['Suggested units', totals.recommended],
        ].map(([label, value]) => (
          <div key={label} className="card px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-1 text-xl font-bold text-slate-800">{Number(value).toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="card p-4 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Style, Color or Size…" className="input-base pl-9" />
          </label>
          <div className="flex rounded-xl bg-slate-100 p-1">
            {[
              ['action', 'To Order'],
              ['urgent', 'Urgent'],
              ['all', 'All'],
            ].map(([value, label]) => (
              <button key={value} onClick={() => setFilter(value)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium sm:flex-none ${
                  filter === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-500">
          Showing {visibleRows.length.toLocaleString()} SKU(s). “Incoming” means factory orders already placed or currently in transit.
        </p>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1050px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                <th className="pb-2 pr-3">Style</th>
                <th className="pb-2 pr-3">Color</th>
                <th className="pb-2 pr-3">Size</th>
                <th className="pb-2 pr-3 text-right">Sales</th>
                <th className="pb-2 pr-3 text-right">Returns</th>
                <th className="pb-2 pr-3 text-right">Daily net</th>
                <th className="pb-2 pr-3 text-right">On hand</th>
                <th className="pb-2 pr-3 text-right">Incoming</th>
                <th className="pb-2 pr-3 text-right">Days left</th>
                <th className="pb-2 pr-3 text-right">Suggested</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.slice(0, 200).map((row) => (
                <tr key={row.key} className="border-b border-slate-100 hover:bg-slate-50/70">
                  <td className="py-2 pr-3 font-mono font-medium text-slate-800">{row.style}</td>
                  <td className="py-2 pr-3 text-slate-700">{row.color}</td>
                  <td className="py-2 pr-3 text-slate-700">{row.size}</td>
                  <td className="py-2 pr-3 text-right">{row.sales.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right text-slate-500">{row.returns.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right">{row.dailyNetSales.toFixed(1)}</td>
                  <td className="py-2 pr-3 text-right font-semibold">{row.onHand.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right"><IncomingInput row={row} onChange={updateIncoming} /></td>
                  <td className={`py-2 pr-3 text-right font-medium ${row.status === 'urgent' ? 'text-red-600' : 'text-slate-700'}`}>
                    {daysLabel(row.daysLeft)}
                  </td>
                  <td className="py-2 pr-3 text-right text-base font-bold text-indigo-700">{row.recommendedQty.toLocaleString()}</td>
                  <td className="py-2"><StatusBadge status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRows.length > 200 && <p className="mt-3 text-xs text-slate-400">Showing the first 200 results. Export includes all filtered results.</p>}
        </div>

        <div className="space-y-3 md:hidden">
          {visibleRows.slice(0, 100).map((row) => (
            <article key={row.key} className={`rounded-2xl border p-4 ${STATUS[row.status].border}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-base font-bold text-slate-900">{row.style}</p>
                  <p className="truncate text-sm text-slate-600">{row.color} · {row.size}</p>
                </div>
                <StatusBadge status={row.status} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-white/80 px-2 py-2">
                  <p className="text-[10px] uppercase text-slate-400">Sales</p>
                  <p className="font-bold text-slate-800">{row.sales}</p>
                </div>
                <div className="rounded-xl bg-white/80 px-2 py-2">
                  <p className="text-[10px] uppercase text-slate-400">On hand</p>
                  <p className="font-bold text-slate-800">{row.onHand}</p>
                </div>
                <div className="rounded-xl bg-white/80 px-2 py-2">
                  <p className="text-[10px] uppercase text-slate-400">Days left</p>
                  <p className={`font-bold ${row.status === 'urgent' ? 'text-red-600' : 'text-slate-800'}`}>{daysLabel(row.daysLeft)}</p>
                </div>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <label className="text-xs font-medium text-slate-500">
                  Incoming / 在途
                  <div className="mt-1"><IncomingInput row={row} onChange={updateIncoming} /></div>
                </label>
                <div className="text-right">
                  <p className="text-[11px] font-medium uppercase text-slate-400">Suggested / 建议补货</p>
                  <p className="text-2xl font-black text-indigo-700">{row.recommendedQty.toLocaleString()}</p>
                </div>
              </div>
            </article>
          ))}
        </div>

        {!visibleRows.length && !loading && (
          <p className="py-10 text-center text-sm text-slate-400">
            No SKUs match the current replenishment filter.
          </p>
        )}
      </div>
    </div>
  )
}
