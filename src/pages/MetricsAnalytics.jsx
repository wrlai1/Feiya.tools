import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { BarChart3, LineChart as LineIcon, GitCompare, Plus, Trash2, X, Sigma } from 'lucide-react'
import * as XLSX from 'xlsx'
import FileUploadZone from '../components/FileUploadZone.jsx'
import KPICard from '../components/KPICard.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseCSV } from '../utils/autoDeductEngine.js'
import { metricValue, rowMetricValue, pearson, metricOptions, formatMetric, slugify } from '../utils/metricsEngine.js'
import { fetchCustomMetrics, saveCustomMetric, deleteCustomMetric } from '../utils/api.js'

const MAX_BARS = 30
const MAX_SCATTERS = 9

// Coerce a cell to a number: "$1,234" → 1234, "12.5%" → 12.5, "1.75x" → 1.75, "" → null.
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$,\s]/g, '').replace(/[%x×]$/i, '')
  if (s === '' || Number.isNaN(Number(s))) return null
  return Number(s)
}

const prettify = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()
const isDateLike = (k) => /date|day|week|month|time|period|日期/i.test(k)
function inferType(key) {
  if (/gmv|revenue|sales|spend|cost|price|amount|value|花费|销售额|价|成本|毛利\$/i.test(key)) return 'currency'
  return 'number'
}
// A column meaning "sales" — the correlation target.
const isSalesCol = (k) => /订单|order|子订单|件数|units|销量|sales|销售额|gmv/i.test(k)
// Columns that are IDs, not measures (excluded from metrics).
const isKeyCol = (k) => /spu|款号|sku|商品\s*id|\bid\b/i.test(k)
// The join key across files, in priority order. SPU is the shared identifier
// between an ad export ("SPU ID") and a plan sheet ("SPU/款号"); pick it before
// per-variant SKU or a store-specific 商品ID, which don't line up across files.
function detectKeyCol(columns) {
  for (const re of [/spu|款号/i, /\bsku\b/i, /商品\s*id/i, /\bid\b/i]) {
    const c = columns.find((x) => re.test(x))
    if (c) return c
  }
  return null
}
// Skip aggregate/summary rows like TEMU's "共16项" total row.
const isSummaryText = (v) => /共\s*\d+\s*项|总计|合计|^\s*total\s*$|^\s*summary\s*$/i.test(String(v || ''))

// Parse one uploaded CSV/XLSX → { name, rows, columns, numericCols, dimensionCols, keyCol }.
// CSV is read as text and XLSX with raw:false so dates stay strings (not serials).
async function parseDataFile(file) {
  let raw
  if (/\.csv$/i.test(file.name)) {
    raw = parseCSV(await file.text())
  } else {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' })
  }
  if (!raw.length) throw new Error('No rows found in the file.')
  const columns = Object.keys(raw[0]).filter((c) => c !== '' && c != null)
  const keyCol = detectKeyCol(columns)

  // Drop summary rows: any cell reading like a total, or an empty join key.
  const clean = raw.filter((r) => {
    if (columns.some((c) => isSummaryText(r[c]))) return false
    if (keyCol && String(r[keyCol] ?? '').trim() === '') return false
    return true
  })

  const numericCols = new Set()
  for (const col of columns) {
    let numeric = 0, nonEmpty = 0
    for (const r of clean) {
      if (r[col] === '' || r[col] == null) continue
      nonEmpty++
      if (toNum(r[col]) !== null) numeric++
    }
    if (nonEmpty > 0 && numeric / nonEmpty >= 0.6) numericCols.add(col)
  }
  // ID / join columns are numeric-looking but not measures — correlating an SPU ID
  // with sales is noise, so keep them as dimensions (still usable for join/labels).
  for (const c of [...numericCols]) if (isKeyCol(c)) numericCols.delete(c)
  const dimensionCols = columns.filter((c) => !numericCols.has(c))

  const rows = clean.map((r) => {
    const out = {}
    for (const col of columns) {
      if (numericCols.has(col)) { const n = toNum(r[col]); if (n !== null) out[col] = n }
      else out[col] = String(r[col] ?? '')
    }
    return out
  })
  return { name: file.name, rows, columns, numericCols: [...numericCols], dimensionCols, keyCol }
}

// Merge datasets on their key columns (outer join, last value wins per column).
// Rows without a usable key stay standalone so nothing is silently dropped.
function joinDatasets(datasets) {
  if (datasets.length === 1) {
    const d = datasets[0]
    return { rows: d.rows, columns: d.columns, numericCols: d.numericCols, dimensionCols: d.dimensionCols }
  }
  const map = new Map()
  let auto = 0
  for (const ds of datasets) {
    for (const row of ds.rows) {
      const kv = ds.keyCol ? String(row[ds.keyCol] ?? '').trim() : ''
      const key = kv || `__solo_${auto++}`
      map.set(key, Object.assign(map.get(key) || {}, row))
    }
  }
  const rows = [...map.values()]
  const numericCols = [...new Set(datasets.flatMap((d) => d.numericCols))]
  const numSet = new Set(numericCols)
  const dimensionCols = [...new Set(datasets.flatMap((d) => d.columns))].filter((c) => !numSet.has(c))
  return { rows, columns: [...new Set(datasets.flatMap((d) => d.columns))], numericCols, dimensionCols }
}

export default function MetricsAnalytics() {
  const toast = useToast()
  const [datasets, setDatasets]         = useState([])
  const [mode, setMode]                 = useState('chart')      // 'chart' | 'compare'
  const [groupBy, setGroupBy]           = useState('')
  const [metricKey, setMetricKey]       = useState('')
  const [chartType, setChartType]       = useState('bar')
  const [salesTarget, setSalesTarget]   = useState('')
  const [customMetrics, setCustomMetrics] = useState([])
  const [showBuilder, setShowBuilder]   = useState(false)

  const data = useMemo(() => (datasets.length ? joinDatasets(datasets) : null), [datasets])

  useEffect(() => {
    fetchCustomMetricsSafe().then(setCustomMetrics)
  }, [])

  // Pick sensible defaults whenever the combined dataset changes.
  useEffect(() => {
    if (!data) return
    setGroupBy((g) => (data.columns.includes(g) ? g : data.dimensionCols[0] || data.columns[0]))
    setMetricKey((m) => (data.numericCols.includes(m) ? m : data.numericCols[0] || ''))
    setSalesTarget((s) => (data.numericCols.includes(s) ? s : data.numericCols.find(isSalesCol) || data.numericCols[0] || ''))
  }, [data])

  const addFile = useCallback(async (file) => {
    try {
      const ds = await parseDataFile(file)
      if (!ds.numericCols.length) { toast.error('No numeric columns to measure.', 'Nothing to chart'); return }
      setDatasets((prev) => [...prev.filter((d) => d.name !== ds.name), ds])
      toast.success(`${ds.rows.length} rows · ${ds.columns.length} cols${ds.keyCol ? ` · key ${ds.keyCol}` : ''}`, `Loaded ${file.name}`)
    } catch (err) {
      toast.error(err.message, 'Could not read file')
    }
  }, [toast])

  const standardFields = useMemo(
    () => (data ? data.numericCols.map((k) => ({ key: k, label: prettify(k), type: inferType(k) })) : []),
    [data],
  )
  const meta = useMemo(() => metricOptions(metricKey, standardFields, customMetrics), [metricKey, standardFields, customMetrics])
  const fmt = (v) => formatMetric(v, meta.type)

  // ── Chart mode: group rows by dimension, one point per group ───────────────
  const chartData = useMemo(() => {
    if (!data || !groupBy || !metricKey) return []
    const groups = new Map()
    for (const row of data.rows) {
      const k = String(row[groupBy] ?? '—') || '—'
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(row)
    }
    let pts = [...groups.entries()].map(([name, rows]) => ({ name, value: metricValue(rows, metricKey, customMetrics) }))
    if (isDateLike(groupBy)) pts.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    else pts.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
    return pts.slice(0, MAX_BARS)
  }, [data, groupBy, metricKey, customMetrics])

  const grandTotal = useMemo(
    () => (data ? metricValue(data.rows, metricKey, customMetrics) : null),
    [data, metricKey, customMetrics],
  )

  // ── Compare mode: correlate every variable with the sales target ───────────
  const ranked = useMemo(() => {
    if (!data || !salesTarget) return []
    const vars = [
      ...data.numericCols.filter((k) => k !== salesTarget).map((k) => ({ key: k, label: prettify(k) })),
      ...customMetrics.filter((c) => c.id !== salesTarget).map((c) => ({ key: c.id, label: c.label })),
    ]
    return vars
      .map((v) => ({ ...v, r: pearson(data.rows, v.key, salesTarget, customMetrics) }))
      .filter((v) => v.r != null)
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
  }, [data, salesTarget, customMetrics])

  const labelCol = useMemo(
    () => (data ? data.columns.find((c) => /商品名称|商品名|product|name|款号|spu|sku/i.test(c)) || data.dimensionCols[0] : null),
    [data],
  )

  const scatterFor = useCallback((varKey) => {
    if (!data) return []
    return data.rows
      .map((r) => ({ x: rowMetricValue(r, varKey, customMetrics), y: rowMetricValue(r, salesTarget, customMetrics), name: labelCol ? String(r[labelCol] ?? '') : '' }))
      .filter((p) => p.x != null && p.y != null)
  }, [data, salesTarget, customMetrics, labelCol])

  const handleAddMetric = useCallback(async (metric) => {
    setCustomMetrics((prev) => [...prev.filter((m) => m.id !== metric.id), metric])
    setMetricKey(metric.id)
    setShowBuilder(false)
    try { await saveCustomMetricSafe(metric); toast.success(metric.label, 'Ratio saved') }
    catch (err) { toast.error(`${err.message} — kept for this session only`, 'Could not save ratio') }
  }, [toast])

  const handleDeleteMetric = useCallback(async (id) => {
    setCustomMetrics((prev) => prev.filter((m) => m.id !== id))
    if (metricKey === id) setMetricKey(data?.numericCols[0] || '')
    try { await deleteCustomMetricSafe(id) } catch { /* already gone from view */ }
  }, [metricKey, data])

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Analytics</h1>
          <p className="text-slate-500 mt-1">
            Upload one or more exports — files sharing an SPU/SKU column are joined — then build ratios and compare what drives sales.
          </p>
        </div>
      </div>

      {!data ? (
        <div className="card p-6">
          <FileUploadZone
            onFile={addFile}
            accept=".xlsx,.xls,.csv"
            label="Drag & drop a performance or product export"
            sublabel="or click to browse"
            acceptedTypes="XLSX, XLS, CSV"
          />
          <p className="text-xs text-slate-400 mt-3 text-center">
            Upload multiple files (e.g. ad performance + pricing plan) and they'll be joined on their shared SPU/SKU.
          </p>
        </div>
      ) : (
        <>
          {/* Loaded files + add another */}
          <div className="flex flex-wrap items-center gap-2">
            {datasets.map((d) => (
              <span key={d.name} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
                {d.name} · {d.rows.length} rows
                <button onClick={() => setDatasets((p) => p.filter((x) => x.name !== d.name))} className="text-slate-400 hover:text-red-500">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <label className="text-xs px-2.5 py-1 rounded-full border border-dashed border-slate-300 text-slate-500 cursor-pointer hover:bg-slate-50">
              + add file
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) addFile(f); e.target.value = '' }} />
            </label>
            {datasets.length > 1 && (
              <span className="text-xs text-slate-400">joined → {data.rows.length} rows · {data.numericCols.length} numeric fields</span>
            )}
          </div>

          {/* Mode toggle */}
          <div className="flex gap-2">
            <ModeBtn active={mode === 'chart'} onClick={() => setMode('chart')} icon={BarChart3} label="Chart a metric" />
            <ModeBtn active={mode === 'compare'} onClick={() => setMode('compare')} icon={GitCompare} label="Compare vs sales" />
          </div>

          {mode === 'chart' ? (
            <ChartMode
              data={data} standardFields={standardFields} customMetrics={customMetrics}
              groupBy={groupBy} setGroupBy={setGroupBy} metricKey={metricKey} setMetricKey={setMetricKey}
              chartType={chartType} setChartType={setChartType} chartData={chartData} grandTotal={grandTotal}
              meta={meta} fmt={fmt} showBuilder={showBuilder} setShowBuilder={setShowBuilder}
              onAddMetric={handleAddMetric} onDeleteMetric={handleDeleteMetric} setMetricKeyDirect={setMetricKey}
            />
          ) : (
            <CompareMode
              data={data} standardFields={standardFields} salesTarget={salesTarget} setSalesTarget={setSalesTarget}
              ranked={ranked} scatterFor={scatterFor} labelCol={labelCol}
            />
          )}

          <button onClick={() => setDatasets([])} className="text-sm text-slate-400 hover:text-slate-600">← Start over with new files</button>
        </>
      )}
    </div>
  )
}

// ── Chart-a-metric mode ──────────────────────────────────────────────────────
function ChartMode({
  data, standardFields, customMetrics, groupBy, setGroupBy, metricKey, setMetricKey,
  chartType, setChartType, chartData, grandTotal, meta, fmt, showBuilder, setShowBuilder,
  onAddMetric, onDeleteMetric, setMetricKeyDirect,
}) {
  return (
    <>
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <Field label="Group by">
          <select className="metric-input" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {data.columns.map((c) => <option key={c} value={c}>{prettify(c)}</option>)}
          </select>
        </Field>
        <Field label="Metric">
          <select className="metric-input" value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
            <optgroup label="Fields">
              {standardFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </optgroup>
            {customMetrics.length > 0 && (
              <optgroup label="Custom ratios">
                {customMetrics.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setChartType('bar')} className={`p-2 rounded-lg border ${chartType === 'bar' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-slate-200 text-slate-400'}`} title="Bar"><BarChart3 className="w-4 h-4" /></button>
          <button onClick={() => setChartType('line')} className={`p-2 rounded-lg border ${chartType === 'line' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-slate-200 text-slate-400'}`} title="Line"><LineIcon className="w-4 h-4" /></button>
          <button onClick={() => setShowBuilder((s) => !s)} className="btn-primary text-sm px-3 py-2 ml-2"><Plus className="w-4 h-4" /> New ratio</button>
        </div>
      </div>

      {showBuilder && <CustomMetricBuilder options={standardFields} onAdd={onAddMetric} onCancel={() => setShowBuilder(false)} />}

      {customMetrics.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {customMetrics.map((m) => (
            <span key={m.id} className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${metricKey === m.id ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
              <button onClick={() => setMetricKeyDirect(m.id)} className="font-medium">{m.label}</button>
              <button onClick={() => onDeleteMetric(m.id)} title="Delete ratio" className="text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPICard title={`${meta.label} — overall`} value={fmt(grandTotal)} subtitle="total ÷ total, all rows" icon={Sigma} color="blue" />
        <KPICard title="Rows" value={data.rows.length.toLocaleString()} subtitle={`${data.columns.length} columns`} icon={BarChart3} color="teal" />
        <KPICard title="Groups" value={chartData.length.toLocaleString()} subtitle={`by ${prettify(groupBy)}`} icon={LineIcon} color="purple" />
      </div>

      <div className="card p-5">
        <h3 className="font-semibold text-slate-800 mb-1">{meta.label} by {prettify(groupBy)}</h3>
        {chartData.length >= MAX_BARS && <p className="text-xs text-slate-400 mb-2">Showing top {MAX_BARS} groups.</p>}
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
    </>
  )
}

// ── Compare-vs-sales mode: correlation ranking + scatter small-multiples ─────
function CompareMode({ data, standardFields, salesTarget, setSalesTarget, ranked, scatterFor, labelCol }) {
  const targetLabel = prettify(salesTarget)
  const top = ranked.slice(0, MAX_SCATTERS)
  return (
    <>
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <Field label="Sales target (the thing to explain)">
          <select className="metric-input" value={salesTarget} onChange={(e) => setSalesTarget(e.target.value)}>
            {standardFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </Field>
        <p className="text-xs text-slate-500 pb-2">
          Each variable is correlated with <b>{targetLabel}</b> across {data.rows.length} products. Higher |r| = stronger relationship;
          <span className="text-green-600"> green = moves together</span>, <span className="text-red-500">red = moves opposite</span>.
        </p>
      </div>

      {ranked.length === 0 ? (
        <div className="card p-6 text-center text-slate-400 text-sm">Need at least 3 products with values to correlate.</div>
      ) : (
        <>
          {/* Ranking */}
          <div className="card p-4">
            <h3 className="font-semibold text-slate-800 mb-3">What moves with {targetLabel}?</h3>
            <div className="space-y-1.5">
              {ranked.map((v) => (
                <div key={v.key} className="flex items-center gap-3 text-sm">
                  <span className="w-56 truncate text-slate-600" title={v.label}>{v.label}</span>
                  <div className="flex-1 h-3 bg-slate-100 rounded-full relative overflow-hidden">
                    <div
                      className={`absolute top-0 h-full ${v.r >= 0 ? 'bg-green-400 left-1/2' : 'bg-red-400 right-1/2'}`}
                      style={{ width: `${Math.abs(v.r) * 50}%` }}
                    />
                    <div className="absolute left-1/2 top-0 h-full w-px bg-slate-300" />
                  </div>
                  <span className={`w-14 text-right font-mono ${v.r >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {v.r >= 0 ? '+' : ''}{v.r.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Scatter small-multiples */}
          <div>
            <h3 className="font-semibold text-slate-800 mb-2">Top variables vs {targetLabel}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {top.map((v) => {
                const points = scatterFor(v.key)
                return (
                  <div key={v.key} className="card p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700 truncate" title={v.label}>{v.label}</span>
                      <span className={`text-xs font-mono ${v.r >= 0 ? 'text-green-600' : 'text-red-500'}`}>r={v.r >= 0 ? '+' : ''}{v.r.toFixed(2)}</span>
                    </div>
                    <ResponsiveContainer width="100%" height={150}>
                      <ScatterChart margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis type="number" dataKey="x" name={v.label} tick={{ fontSize: 9 }} />
                        <YAxis type="number" dataKey="y" name={targetLabel} tick={{ fontSize: 9 }} width={34} />
                        <ZAxis range={[40, 40]} />
                        <Tooltip cursor={{ strokeDasharray: '3 3' }}
                          formatter={(val, key) => [val, key === 'x' ? v.label : targetLabel]}
                          labelFormatter={() => ''} />
                        <Scatter data={points} fill={v.r >= 0 ? '#22c55e' : '#ef4444'} />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </>
  )
}

function ModeBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${active ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
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
      label: label.trim() || autoLabel, numerator, denominator, type,
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
        <button onClick={submit} disabled={!numerator || !denominator} className="btn-primary text-sm px-4 py-2 disabled:opacity-40">Add</button>
      </div>
    </div>
  )
}

// Persistence — degrade quietly if the metrics API/DB isn't reachable.
async function fetchCustomMetricsSafe() {
  try { return (await fetchCustomMetrics()).metrics || [] } catch { return [] }
}
const saveCustomMetricSafe = (metric) => saveCustomMetric(metric)
const deleteCustomMetricSafe = (id) => deleteCustomMetric(id)
