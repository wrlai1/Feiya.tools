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
  const [selectedStyle, setSelectedStyle] = useState('')
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
      setSelectedStyle('')
      return
    }
    if (!styles.some((style) => normalizedPart(style) === normalizedPart(selectedStyle))) {
      setSelectedStyle(styles[0])
    }
  }, [selectedStyle, styles])

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

  const report = useMemo(() => buildDailyStyleReport({
    inventoryRows,
    movements,
    style: selectedStyle,
  }), [inventoryRows, movements, selectedStyle])

  const exportReport = async () => {
    if (!report) return
    setExporting(true)
    setError('')
    try {
      const XLSX = await import('xlsx')
      const workbook = createDailyStyleWorkbook(XLSX, report)
      XLSX.writeFile(workbook, dailyStyleReportFileName(report), {
        cellStyles: true,
        compression: true,
      })
      toast.success(`${report.style} daily inventory report downloaded`, 'Report Ready')
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
              Daily Style Report / 单款库存日报
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Select one exact inventory style. Current stock is never reduced again by the historical sales shown here.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button onClick={load} disabled={loading} className="btn-secondary text-sm disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={exportReport} disabled={!report || loading || exporting}
              className="btn-primary text-sm disabled:opacity-50">
              <Download className="h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>

        <label className="block max-w-xl text-xs font-semibold text-slate-500">
          Style / 款式
          <select value={selectedStyle} onChange={(event) => setSelectedStyle(event.target.value)}
            className="input-base mt-1.5 text-sm">
            {styles.map((style) => <option key={normalizedPart(style)} value={style}>{style}</option>)}
          </select>
        </label>

        {report && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <span className="flex items-center gap-1.5 font-semibold">
              <CalendarDays className="h-3.5 w-3.5" /> Sales data through {report.dataThroughDay}
            </span>
            <span>28-day history uses actual order dates, not upload time.</span>
            <span>All current inventory colors remain visible, including zero-sales colors.</span>
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Current Inventory', count(report.totals.currentInventory)],
              [`Sales ${report.dataThroughDay}`, count(report.totals.latestDaySales)],
              ['Last 7 Days', count(report.totals.last7Sales)],
              ['Previous 7 Days', count(report.totals.previous7Sales)],
              ['28D Avg / Day', count(report.totals.dailyAverage, 1)],
              ['Estimated Days Left', daysLabel(report.totals.daysLeft)],
            ].map(([label, value]) => (
              <div key={label} className="card px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                <p className="mt-1 text-xl font-bold text-slate-800">{value}</p>
              </div>
            ))}
          </div>

          <div className="card p-4">
            <div className="mb-3">
              <h3 className="font-semibold text-slate-800">Inventory and Sales by Color</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                The Excel report also includes size-level history, four weekly comparisons, 28 daily rows, and source data.
              </p>
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[950px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                    <th className="pb-2 pr-3">Color</th>
                    {report.sizes.map((size) => <th key={size} className="pb-2 pr-3 text-right">{size} Stock</th>)}
                    <th className="pb-2 pr-3 text-right">Total Stock</th>
                    <th className="pb-2 pr-3 text-right">Latest Day</th>
                    <th className="pb-2 pr-3 text-right">Last 7d</th>
                    <th className="pb-2 pr-3 text-right">Previous 7d</th>
                    <th className="pb-2 pr-3 text-right">Trend</th>
                    <th className="pb-2 text-right">Days Left</th>
                  </tr>
                </thead>
                <tbody>
                  {report.colorRows.map((row) => (
                    <tr key={normalizedPart(row.color)} className="border-b border-slate-100 hover:bg-slate-50/70">
                      <td className="py-2 pr-3 font-medium text-slate-800">{row.color}</td>
                      {report.sizes.map((size) => (
                        <td key={size} className="py-2 pr-3 text-right">{count(row.inventoryBySize[size])}</td>
                      ))}
                      <td className="py-2 pr-3 text-right font-bold">{count(row.onHand)}</td>
                      <td className="py-2 pr-3 text-right">{count(row.latestDaySales)}</td>
                      <td className="py-2 pr-3 text-right">{count(row.last7Sales)}</td>
                      <td className="py-2 pr-3 text-right">{count(row.previous7Sales)}</td>
                      <td className="py-2 pr-3 text-right font-medium">{trendLabel(row)}</td>
                      <td className="py-2 text-right font-semibold">{daysLabel(row.daysLeft)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {report.colorRows.map((row) => (
                <article key={normalizedPart(row.color)} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900">{row.color}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{daysLabel(row.daysLeft)}</p>
                    </div>
                    <p className="text-right text-xl font-black text-slate-900">{count(row.onHand)}</p>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {report.sizes.map((size) => (
                      <div key={size} className="rounded-lg bg-slate-50 px-2 py-2 text-center">
                        <p className="text-[10px] font-semibold text-slate-400">{size}</p>
                        <p className="font-bold text-slate-800">{count(row.inventoryBySize[size])}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div><p className="text-slate-400">Latest</p><p className="font-bold">{count(row.latestDaySales)}</p></div>
                    <div><p className="text-slate-400">Last 7d</p><p className="font-bold">{count(row.last7Sales)}</p></div>
                    <div><p className="text-slate-400">Previous 7d</p><p className="font-bold">{count(row.previous7Sales)}</p></div>
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
