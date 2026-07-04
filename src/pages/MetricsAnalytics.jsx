import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { BarChart3, LineChart as LineIcon, Plus, Trash2, X, Sigma } from 'lucide-react'
import * as XLSX from 'xlsx'
import FileUploadZone from '../components/FileUploadZone.jsx'
import KPICard from '../components/KPICard.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseCSV } from '../utils/autoDeductEngine.js'
import { metricValue, metricOptions, formatMetric, slugify } from '../utils/metricsEngine.js'
import { fetchCustomMetrics, saveCustomMetric, deleteCustomMetric } from '../utils/api.js'

const MAX_BARS = 30

// Coerce a cell to a number, tolerating "$1,234", "1,234", "12.5%", "" → null.
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$,\s]/g, '').replace(/%$/, '')
  if (s === '' || Number.isNaN(Number(s))) return null
  return Number(s)
}

const prettify = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const isDateLike = (k) => /date|day|week|month|time|period/i.test(k)
function inferType(key) {
  if (/gmv|revenue|sales|spend|cost|price|amount|\$|value/i.test(key)) return 'currency'
  return 'number'
}

// Parse an uploaded CSV/XLSX into { rows: [obj], columns, numericCols, dimensionCols }.
// Every column stays a top-level field; numeric columns are coerced to Number so the
// engine can sum them, dimension columns keep their string value for grouping.
// CSV is parsed as raw text and XLSX with raw:false so date columns (e.g. 2026-06-01)
// stay strings instead of being coerced to Excel serial numbers and treated as measures.
async function parseDataFile(file) {
  let raw
  if (/\.csv$/i.test(file.name)) {
    raw = parseCSV(await file.text())
  } else {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    raw = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' })
  }
  if (!raw.length) throw new Error('No rows found in the file.')

  const columns = Object.keys(raw[0])
  // A column is numeric if most of its non-empty values parse as numbers.
  const numericCols = new Set()
  for (const col of columns) {
    let numeric = 0, nonEmpty = 0
    for (const r of raw) {
      const cell = r[col]
      if (cell === '' || cell == null) continue
      nonEmpty++
      if (toNum(cell) !== null) numeric++
    }
    if (nonEmpty > 0 && numeric / nonEmpty >= 0.6) numericCols.add(col)
  }
  const dimensionCols = columns.filter((c) => !numericCols.has(c))

  const rows = raw.map((r) => {
    const out = {}
    for (const col of columns) {
      if (numericCols.has(col)) {
        const n = toNum(r[col])
        if (n !== null) out[col] = n
      } else {
        out[col] = String(r[col] ?? '')
      }
    }
    return out
  })
  return { rows, columns, numericCols: [...numericCols], dimensionCols }
}

export default function MetricsAnalytics() {
  const toast = useToast()
  const [data, setData]                 = useState(null)   // { rows, columns, numericCols, dimensionCols }
  const [fileName, setFileName]         = useState('')
  const [groupBy, setGroupBy]           = useState('')
  const [metricKey, setMetricKey]       = useState('')
  const [chartType, setChartType]       = useState('bar')
  const [customMetrics, setCustomMetrics] = useState([])
  const [showBuilder, setShowBuilder]   = useState(false)

  // Load this user's saved ratios (per-account, DB-backed). Degrade quietly if the
  // metrics API isn't reachable — the page still works, ratios just won't persist.
  useEffect(() => {
    fetchCustomMetrics()
      .then((res) => setCustomMetrics(res.metrics || []))
      .catch(() => {})
  }, [])

  const handleFile = useCallback(async (file) => {
    try {
      const parsed = await parseDataFile(file)
      if (!parsed.numericCols.length) {
        toast.error('No numeric columns found to measure.', 'Nothing to chart')
        return
      }
      setData(parsed)
      setFileName(file.name)
      setGroupBy(parsed.dimensionCols[0] || parsed.columns[0])
      setMetricKey(parsed.numericCols[0])
      toast.success(`${parsed.rows.length.toLocaleString()} rows · ${parsed.columns.length} columns`, 'File loaded')
    } catch (err) {
      toast.error(err.message, 'Could not read file')
    }
  }, [toast])

  // Field defs for the numeric columns (label + display type), used for the
  // metric picker, the ratio-builder ingredients, and value formatting.
  const standardFields = useMemo(() => {
    if (!data) return []
    return data.numericCols.map((k) => ({ key: k, label: prettify(k), type: inferType(k) }))
  }, [data])

  const meta = useMemo(
    () => metricOptions(metricKey, standardFields, customMetrics),
    [metricKey, standardFields, customMetrics],
  )

  // Group rows by the chosen dimension → one point per group (total-over-total).
  const chartData = useMemo(() => {
    if (!data || !groupBy || !metricKey) return []
    const groups = new Map()
    for (const row of data.rows) {
      const k = String(row[groupBy] ?? '—') || '—'
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(row)
    }
    let points = [...groups.entries()].map(([name, rows]) => ({
      name,
      value: metricValue(rows, metricKey, customMetrics),
    }))
    if (isDateLike(groupBy)) points.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    else points.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
    return points.slice(0, MAX_BARS)
  }, [data, groupBy, metricKey, customMetrics])

  // The headline number: one correct total across ALL rows (not an average of points).
  const grandTotal = useMemo(
    () => (data ? metricValue(data.rows, metricKey, customMetrics) : null),
    [data, metricKey, customMetrics],
  )

  const handleAddMetric = useCallback(async (metric) => {
    setCustomMetrics((prev) => [...prev.filter((m) => m.id !== metric.id), metric])
    setMetricKey(metric.id)
    setShowBuilder(false)
    try {
      await saveCustomMetric(metric)
      toast.success(metric.label, 'Ratio saved')
    } catch (err) {
      toast.error(`${err.message} — kept for this session only`, 'Could not save ratio')
    }
  }, [toast])

  const handleDeleteMetric = useCallback(async (id) => {
    setCustomMetrics((prev) => prev.filter((m) => m.id !== id))
    if (metricKey === id) setMetricKey(data?.numericCols[0] || '')
    try { await deleteCustomMetric(id) } catch { /* already gone from view */ }
  }, [metricKey, data])

  const fmt = (v) => formatMetric(v, meta.type)

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Analytics</h1>
          <p className="text-slate-500 mt-1">
            Upload a performance export, then build ratio metrics (like orders ÷ exposure) and chart them.
          </p>
        </div>
        {fileName && <span className="text-sm text-slate-400 mt-1">{fileName}</span>}
      </div>

      {!data ? (
        <div className="card p-6">
          <FileUploadZone
            onFile={handleFile}
            accept=".xlsx,.xls,.csv"
            label="Drag & drop a performance export"
            sublabel="or click to browse"
            acceptedTypes="XLSX, XLS, CSV"
          />
          <p className="text-xs text-slate-400 mt-3 text-center">
            Any columns work — numeric columns become measurable; the rest can group the chart.
          </p>
        </div>
      ) : (
        <>
          {/* Controls */}
          <div className="card p-4 flex flex-wrap items-end gap-4">
            <Field label="Group by">
              <select className="metric-input" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {data.columns.map((c) => (
                  <option key={c} value={c}>{prettify(c)}</option>
                ))}
              </select>
            </Field>

            <Field label="Metric">
              <select className="metric-input" value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
                <optgroup label="Fields">
                  {standardFields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </optgroup>
                {customMetrics.length > 0 && (
                  <optgroup label="Custom ratios">
                    {customMetrics.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>

            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setChartType('bar')}
                className={`p-2 rounded-lg border ${chartType === 'bar' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-slate-200 text-slate-400'}`}
                title="Bar chart"
              >
                <BarChart3 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setChartType('line')}
                className={`p-2 rounded-lg border ${chartType === 'line' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-slate-200 text-slate-400'}`}
                title="Line chart"
              >
                <LineIcon className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowBuilder((s) => !s)}
                className="btn-primary text-sm px-3 py-2 ml-2"
              >
                <Plus className="w-4 h-4" /> New ratio
              </button>
            </div>
          </div>

          {showBuilder && (
            <CustomMetricBuilder
              options={standardFields}
              onAdd={handleAddMetric}
              onCancel={() => setShowBuilder(false)}
            />
          )}

          {/* Manage saved ratios */}
          {customMetrics.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {customMetrics.map((m) => (
                <span
                  key={m.id}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
                    metricKey === m.id ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                  }`}
                >
                  <button onClick={() => setMetricKey(m.id)} className="font-medium">{m.label}</button>
                  <button onClick={() => handleDeleteMetric(m.id)} title="Delete ratio" className="text-slate-400 hover:text-red-500">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Headline total */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <KPICard title={`${meta.label} — overall`} value={fmt(grandTotal)} subtitle="total ÷ total, all rows" icon={Sigma} color="blue" />
            <KPICard title="Rows" value={data.rows.length.toLocaleString()} subtitle={`${data.columns.length} columns`} icon={BarChart3} color="teal" />
            <KPICard title="Groups" value={chartData.length.toLocaleString()} subtitle={`by ${prettify(groupBy)}`} icon={LineIcon} color="purple" />
          </div>

          {/* Chart */}
          <div className="card p-5">
            <h3 className="font-semibold text-slate-800 mb-1">{meta.label} by {prettify(groupBy)}</h3>
            {chartData.length >= MAX_BARS && (
              <p className="text-xs text-slate-400 mb-2">Showing top {MAX_BARS} groups.</p>
            )}
            <ResponsiveContainer width="100%" height={340}>
              {chartType === 'bar' ? (
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={64} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={64} />
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              ) : (
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={64} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={64} />
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>

          {/* Table */}
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-left">
                  <th className="px-4 py-2 font-medium">{prettify(groupBy)}</th>
                  <th className="px-4 py-2 font-medium text-right">{meta.label}</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((row) => (
                  <tr key={row.name} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-700">{row.name}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-800">{fmt(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={() => { setData(null); setFileName('') }} className="text-sm text-slate-400 hover:text-slate-600">
            ← Upload a different file
          </button>
        </>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-500 font-medium">{label}</span>
      {children}
    </label>
  )
}

// Numerator ÷ denominator ratio builder (ported from the framework reference,
// styled to match the app). Fires onAdd with a ready-to-store CustomMetric.
function CustomMetricBuilder({ options, onAdd, onCancel }) {
  const [numerator, setNumerator]     = useState(options[0]?.key || '')
  const [denominator, setDenominator] = useState(options[1]?.key || options[0]?.key || '')
  const [type, setType]               = useState('percent')
  const [label, setLabel]             = useState('')

  const numLabel = options.find((o) => o.key === numerator)?.label || numerator
  const denLabel = options.find((o) => o.key === denominator)?.label || denominator
  const autoLabel = numLabel && denLabel ? `${numLabel} / ${denLabel}` : ''

  const submit = () => {
    if (!numerator || !denominator) return
    onAdd({
      id: 'custom:' + slugify(label || autoLabel) + '-' + Date.now().toString(36),
      label: label.trim() || autoLabel,
      numerator,
      denominator,
      type,
    })
  }

  return (
    <div className="card p-4 border-blue-200 bg-blue-50/40">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-800">New ratio metric</h3>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Numerator">
          <select className="metric-input" value={numerator} onChange={(e) => setNumerator(e.target.value)}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </Field>
        <span className="pb-2 text-slate-400 text-lg">÷</span>
        <Field label="Denominator">
          <select className="metric-input" value={denominator} onChange={(e) => setDenominator(e.target.value)}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Show as">
          <select className="metric-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="percent">%</option>
            <option value="number">number</option>
            <option value="ratio">× ratio</option>
            <option value="currency">$</option>
          </select>
        </Field>
        <Field label="Name (optional)">
          <input className="metric-input" placeholder={autoLabel || 'Name'} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <button onClick={submit} disabled={!numerator || !denominator} className="btn-primary text-sm px-4 py-2 disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  )
}
