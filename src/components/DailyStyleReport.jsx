import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarDays,
  Download,
  FileSpreadsheet,
  RefreshCw,
} from 'lucide-react'
import { fetchMovements } from '../utils/api.js'
import {
  buildDailyStyleReport,
  createDailyStyleWorkbook,
  dailyStyleReportFileName,
} from '../utils/dailyStyleReport.js'
import { useToast } from '../hooks/useToast.js'

function normalizedPart(value) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function count(value, digits = 0) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function daysLabel(value) {
  return Number.isFinite(value) ? `${Math.round(value)} days` : 'No recent sales'
}

function trendLabel(row) {
  if (row.previous7Sales > 0) {
    const percent = ((row.last7Sales - row.previous7Sales) / row.previous7Sales) * 100
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(0)}%`
  }
  return row.last7Sales > 0 ? 'New sales' : 'No change'
}

export default function DailyStyleReport({ inventoryRows = [] }) {
  const toast = useToast()
  const [selectedStyles, setSelectedStyles] = useState([])
  const [activeStyle, setActiveStyle] = useState('')
  const [styleSearch, setStyleSearch] = useState('')
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const styles = useMemo(() => {
    const byKey = new Map()
    for (const row of inventoryRows || []) {
      const style = String(row.Style ?? row.style ?? '').trim()
      const key = normalizedPart(style)
      if (key && !byKey.has(key)) byKey.set(key, style)
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: 'base',
    }))
  }, [inventoryRows])

  useEffect(() => {
    if (!styles.length) {
      setSelectedStyles([])
      setActiveStyle('')
      return
    }
    setSelectedStyles((current) => {
      const valid = current.filter((selected) => styles.some((style) => normalizedPart(style) === normalizedPart(selected)))
      return valid.length ? valid : [styles[0]]
    })
  }, [styles])

  useEffect(() => {
    if (!selectedStyles.some((style) => normalizedPart(style) === normalizedPart(activeStyle))) {
      setActiveStyle(selectedStyles[0] || '')
    }
  }, [activeStyle, selectedStyles])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetchMovements(60)
      setMovements(response.rows || [])
    } catch (loadError) {
      setMovements([])
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const reports = useMemo(() => selectedStyles.map((style) => buildDailyStyleReport({
    inventoryRows,
    movements,
    style,
  })).filter(Boolean), [inventoryRows, movements, selectedStyles])

  const report = reports.find((item) => normalizedPart(item.style) === normalizedPart(activeStyle)) || reports[0]
  const filteredStyles = styles.filter((style) => normalizedPart(style).includes(normalizedPart(styleSearch)))

  const toggleStyle = (style) => {
    setSelectedStyles((current) => {
      const selected = current.some((item) => normalizedPart(item) === normalizedPart(style))
      if (selected) return current.length === 1 ? current : current.filter((item) => normalizedPart(item) !== normalizedPart(style))
      return [...current, style]
    })
  }

  const exportReport = async () => {
    if (!reports.length) return
    setExporting(true)
    setError('')
    try {
      const XLSX = await import('xlsx')
      const workbook = createDailyStyleWorkbook(XLSX, reports)
      XLSX.writeFile(workbook, dailyStyleReportFileName(reports), {
        cellStyles: true,
        compression: true,
      })
      toast.success(`${reports.length} style sheet${reports.length === 1 ? '' : 's'} downloaded`, 'Report Ready')
    } catch (exportError) {
      setError(`Export failed: ${exportError.message}`)
    } finally {
      setExporting(false)
    }
  }

  if (!styles.length) {
    return (
      <div className="card p-8 text-center text-sm text-slate-500">
        Add inventory styles before generating a daily report.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-4 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-slate-800">
              <FileSpreadsheet className="h-5 w-5 text-blue-600" />
              Daily Style Report / 多款库存日报
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Select one or more styles. The export creates one clear, color-coded sheet per style.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button onClick={load} disabled={loading} className="btn-secondary text-sm disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={exportReport} disabled={!reports.length || loading || exporting}
              className="btn-primary text-sm disabled:opacity-50">
              <Download className="h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>

        <div className="max-w-3xl">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-500">Styles / 款式（已选 {selectedStyles.length}）</p>
            <div className="flex gap-3 text-xs font-semibold">
              <button type="button" onClick={() => setSelectedStyles(styles)} className="text-blue-600 hover:text-blue-800">Select all</button>
              <button type="button" onClick={() => setSelectedStyles([activeStyle || styles[0]])} className="text-slate-500 hover:text-slate-800">Keep one</button>
            </div>
          </div>
          <input value={styleSearch} onChange={(event) => setStyleSearch(event.target.value)}
            placeholder="Search style / 搜索款号" className="input-base mb-2 text-sm" />
          <div className="grid max-h-52 grid-cols-1 gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2 sm:grid-cols-2 lg:grid-cols-3">
            {filteredStyles.map((style) => {
              const checked = selectedStyles.some((item) => normalizedPart(item) === normalizedPart(style))
              return (
                <label key={normalizedPart(style)} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${checked ? 'bg-blue-100 font-semibold text-blue-900' : 'bg-white text-slate-700 hover:bg-slate-100'}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleStyle(style)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                  <span className="truncate">{style}</span>
                </label>
              )
            })}
          </div>
        </div>

        {report && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <span className="flex items-center gap-1.5 font-semibold">
              <CalendarDays className="h-3.5 w-3.5" /> Sales data through {report.dataThroughDay}
            </span>
            <span>28-day history uses actual order dates, not upload time.</span>
            <span>{reports.length} style{reports.length === 1 ? '' : 's'} selected · one Excel sheet per style.</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {report && (
        <>
          {reports.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {reports.map((item) => (
                <button key={normalizedPart(item.style)} type="button" onClick={() => setActiveStyle(item.style)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${normalizedPart(item.style) === normalizedPart(report.style) ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'}`}>
                  {item.style}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Current Inventory', count(report.totals.currentInventory), 'border-blue-200 bg-blue-50', 'text-blue-900'],
              [`Sales ${report.dataThroughDay}`, count(report.totals.latestDaySales), 'border-emerald-200 bg-emerald-50', 'text-emerald-900'],
              ['Last 7 Days', count(report.totals.last7Sales), 'border-emerald-200 bg-emerald-50', 'text-emerald-900'],
              ['Previous 7 Days', count(report.totals.previous7Sales), 'border-emerald-200 bg-emerald-50', 'text-emerald-900'],
              ['28D Avg / Day', count(report.totals.dailyAverage, 1), 'border-emerald-200 bg-emerald-50', 'text-emerald-900'],
              ['Estimated Days Left', daysLabel(report.totals.daysLeft), 'border-orange-200 bg-orange-50', 'text-orange-900'],
            ].map(([label, value, color, textColor]) => (
              <div key={label} className={`rounded-2xl border px-4 py-3 ${color}`}>
                <p className={`text-[11px] font-semibold uppercase tracking-wide ${textColor}`}>{label}</p>
                <p className={`mt-1 text-xl font-bold ${textColor}`}>{value}</p>
              </div>
            ))}
          </div>

          <div className="card p-4">
            <div className="mb-3">
              <h3 className="font-semibold text-slate-800">Inventory and Sales by Color</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Blue = current inventory · Green = recent sales · Orange = estimated selling days.
              </p>
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[950px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-600">
                    <th className="pb-2 pr-3">Color</th>
                    {report.sizes.map((size) => <th key={size} className="bg-blue-50 pb-2 pr-3 text-right text-blue-800">{size} Stock</th>)}
                    <th className="bg-blue-50 pb-2 pr-3 text-right text-blue-800">Total Stock</th>
                    <th className="bg-emerald-50 pb-2 pr-3 text-right text-emerald-800">Latest Day</th>
                    <th className="bg-emerald-50 pb-2 pr-3 text-right text-emerald-800">Last 7d</th>
                    <th className="bg-emerald-50 pb-2 pr-3 text-right text-emerald-800">Previous 7d</th>
                    <th className="bg-emerald-50 pb-2 pr-3 text-right text-emerald-800">Trend</th>
                    <th className="bg-orange-50 pb-2 text-right text-orange-800">Days Left</th>
                  </tr>
                </thead>
                <tbody>
                  {report.colorRows.map((row) => (
                    <tr key={normalizedPart(row.color)} className="border-b border-slate-100 hover:bg-slate-50/70">
                      <td className="py-2 pr-3 font-medium text-slate-800">{row.color}</td>
                      {report.sizes.map((size) => (
                        <td key={size} className="bg-blue-50/40 py-2 pr-3 text-right">{count(row.inventoryBySize[size])}</td>
                      ))}
                      <td className="bg-blue-50/40 py-2 pr-3 text-right font-bold text-blue-900">{count(row.onHand)}</td>
                      <td className="bg-emerald-50/40 py-2 pr-3 text-right">{count(row.latestDaySales)}</td>
                      <td className="bg-emerald-50/40 py-2 pr-3 text-right">{count(row.last7Sales)}</td>
                      <td className="bg-emerald-50/40 py-2 pr-3 text-right">{count(row.previous7Sales)}</td>
                      <td className="bg-emerald-50/40 py-2 pr-3 text-right font-medium">{trendLabel(row)}</td>
                      <td className="bg-orange-50/50 py-2 text-right font-semibold text-orange-900">{daysLabel(row.daysLeft)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {report.colorRows.map((row) => (
                <article key={normalizedPart(row.color)} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-bold text-slate-900">{row.color}</p>
                    <div className="rounded-lg bg-orange-50 px-3 py-1.5 text-right text-orange-900">
                      <p className="text-[10px] font-semibold uppercase">Days left</p>
                      <p className="font-black">{daysLabel(row.daysLeft)}</p>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl bg-blue-50 p-3">
                    <div className="mb-2 flex items-center justify-between text-blue-900">
                      <p className="text-xs font-semibold uppercase">Current Inventory</p>
                      <p className="text-xl font-black">{count(row.onHand)}</p>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                    {report.sizes.map((size) => (
                      <div key={size} className="rounded-lg bg-white/80 px-2 py-2 text-center">
                        <p className="text-[10px] font-semibold text-blue-500">{size}</p>
                        <p className="font-bold text-blue-900">{count(row.inventoryBySize[size])}</p>
                      </div>
                    ))}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-emerald-50 p-3 text-center text-xs text-emerald-900">
                    <div><p className="text-emerald-600">Latest</p><p className="font-bold">{count(row.latestDaySales)}</p></div>
                    <div><p className="text-emerald-600">Last 7d</p><p className="font-bold">{count(row.last7Sales)}</p></div>
                    <div><p className="text-emerald-600">Previous 7d</p><p className="font-bold">{count(row.previous7Sales)}</p></div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
