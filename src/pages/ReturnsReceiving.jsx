import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  FileSpreadsheet,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Upload,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseReturnManifestRows, resolveReturnManifestPackages } from '../utils/returnImportEngine.js'

const BASE = '/api'

const DEMO_PACKAGE = {
  id: 'demo-return',
  tracking_number: '1Z-RETURN-DEMO',
  status: 'pending',
  expected_units: 4,
  actual_units: 0,
  items: [
    { id: 'demo-black', style: '62300SET', color: 'BLACK', size: 'M', expected_qty: 1 },
    { id: 'demo-denim', style: '62300SET', color: 'DENIM', size: 'M', expected_qty: 1 },
    { id: 'demo-khaki', style: '62300SET', color: 'KHAKI', size: 'M', expected_qty: 1 },
    { id: 'demo-white', style: '62300SET', color: 'WHITE', size: 'M', expected_qty: 1 },
  ],
}

function headers(getToken, json = false) {
  return {
    Authorization: `Bearer ${getToken()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function statusBadge(status) {
  if (status === 'received') return 'bg-emerald-100 text-emerald-700'
  if (status === 'discrepancy') return 'bg-amber-100 text-amber-800'
  return 'bg-blue-100 text-blue-700'
}

function statusLabel(status) {
  if (status === 'received') return 'Received'
  if (status === 'discrepancy') return 'Discrepancy'
  return 'Pending'
}

function CountControl({ value, onChange, disabled }) {
  const [error, setError] = useState('')

  const setValue = (next) => {
    const number = Number(next)
    if (!Number.isSafeInteger(number) || number < 0 || number > 9999) {
      setError('Whole numbers only (0–9999)')
      return
    }
    setError('')
    onChange(number)
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`inline-flex items-center overflow-hidden rounded-xl border bg-white ${
        error ? 'border-red-300 ring-2 ring-red-100' : 'border-slate-200'
      }`}>
        <button
          type="button"
          disabled={disabled || value <= 0}
          onClick={() => setValue(value - 1)}
          className="flex h-11 w-11 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-30"
          aria-label="Decrease actual quantity"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={disabled}
          value={value}
          aria-invalid={Boolean(error)}
          aria-label="Actual quantity"
          onChange={(event) => setValue(event.target.value)}
          className="h-11 w-16 border-x border-slate-200 text-center text-base font-semibold outline-none disabled:bg-slate-50"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setValue(value + 1)}
          className="flex h-11 w-11 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-30"
          aria-label="Increase actual quantity"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {error && <p role="alert" className="text-[11px] font-medium text-red-600">{error}</p>}
    </div>
  )
}

export default function ReturnsReceiving() {
  const { user, getToken } = useAuth()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'
  const demoMode = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('mock') === '1'
  const scannerRef = useRef(null)
  const [tab, setTab] = useState('receive')
  const [tracking, setTracking] = useState('')
  const [loading, setLoading] = useState(false)
  const [pkg, setPkg] = useState(null)
  const [counts, setCounts] = useState({})
  const [remark, setRemark] = useState('')
  const [counted, setCounted] = useState(false)
  const [recent, setRecent] = useState([])
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [analytics, setAnalytics] = useState(null)
  const [analyticsDays, setAnalyticsDays] = useState(30)

  const loadRecent = useCallback(async () => {
    if (demoMode) {
      setRecent([DEMO_PACKAGE])
      return
    }
    const res = await fetch(`${BASE}/returns?action=list`, { headers: headers(getToken) })
    const data = await res.json().catch(() => ({}))
    if (res.ok) setRecent(data.packages || [])
  }, [demoMode, getToken])

  useEffect(() => {
    loadRecent()
    if (demoMode) {
      setPkg(DEMO_PACKAGE)
      setTracking(DEMO_PACKAGE.tracking_number)
      setCounts(Object.fromEntries(DEMO_PACKAGE.items.map((item) => [item.id, 0])))
    }
    const frame = requestAnimationFrame(() => scannerRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [demoMode, loadRecent])

  const lookup = useCallback(async (value = tracking) => {
    const query = String(value || '').trim()
    if (!query) return
    if (demoMode) {
      setPkg(DEMO_PACKAGE)
      setTracking(DEMO_PACKAGE.tracking_number)
      setCounts(Object.fromEntries(DEMO_PACKAGE.items.map((item) => [item.id, 0])))
      setCounted(false)
      setRemark('')
      return
    }
    setLoading(true)
    setPkg(null)
    setCounted(false)
    setRemark('')
    try {
      const res = await fetch(`${BASE}/returns?action=lookup&tracking=${encodeURIComponent(query)}`, {
        headers: headers(getToken),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Return package not found')
      const next = data.package
      setPkg(next)
      setTracking(next.tracking_number)
      setCounts(Object.fromEntries(
        (next.items || []).map((item) => [
          item.id,
          next.status === 'pending' ? 0 : Number(item.actual_qty || 0),
        ]),
      ))
      setRemark(next.remark || '')
    } catch (error) {
      toast.error(error.message, 'Tracking Not Found')
      setTracking('')
      requestAnimationFrame(() => scannerRef.current?.focus())
    } finally {
      setLoading(false)
    }
  }, [demoMode, getToken, toast, tracking])

  const expectedUnits = Number(pkg?.expected_units || 0)
  const actualUnits = useMemo(
    () => Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0),
    [counts],
  )
  const discrepancy = Boolean(pkg?.items?.some((item) =>
    Number(counts[item.id] || 0) !== Number(item.expected_qty)
  ))

  const confirmPackage = async () => {
    if (!pkg || pkg.status !== 'pending' || !counted || loading) return
    if (discrepancy) {
      const proceed = window.confirm(
        `Expected ${expectedUnits} units but counted ${actualUnits}.\n\n` +
        'Only the counted units will be added to inventory. Save this package as a discrepancy?'
      )
      if (!proceed) return
    }
    setLoading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=confirm`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({
          tracking: pkg.tracking_number,
          items: pkg.items.map((item) => ({
            id: item.id,
            actualQty: Number(counts[item.id] || 0),
          })),
          remark,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not receive return package')
      toast.success(
        `${Number(data.added_units || 0).toLocaleString()} actual units added to inventory`,
        data.status === 'discrepancy' ? 'Discrepancy Recorded' : 'Return Received',
      )
      await lookup(pkg.tracking_number)
      await loadRecent()
    } catch (error) {
      toast.error(error.message, 'Receive Failed')
    } finally {
      setLoading(false)
    }
  }

  const parseFile = async (nextFile) => {
    setFile(nextFile)
    setParsed(null)
    if (!nextFile) return
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await nextFile.arrayBuffer(), { type: 'array' })
      const sheetName = workbook.SheetNames.find((name) => name.trim().toUpperCase() === 'TEMU-STYLES')
        || workbook.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false, defval: '' })
      const parsedRows = parseReturnManifestRows(rows)
      const [inventoryRes, aliasesRes] = await Promise.all([
        fetch(`${BASE}/inventory-balance?action=list`, { headers: headers(getToken) }),
        fetch(`${BASE}/auto-deduct?action=aliases`, { headers: headers(getToken) }),
      ])
      const [inventoryData, aliasesData] = await Promise.all([
        inventoryRes.json().catch(() => ({})),
        aliasesRes.json().catch(() => ({})),
      ])
      if (!inventoryRes.ok) throw new Error(inventoryData.error || 'Could not load inventory targets')
      if (!aliasesRes.ok) throw new Error(aliasesData.error || 'Could not load confirmed SKU mappings')
      const result = resolveReturnManifestPackages(
        parsedRows,
        (inventoryData.rows || []).map((row) => ({
          STYLE: row.Style,
          COLOR: row.Color,
          SIZE: row.Size,
        })),
        aliasesData.aliases || {},
      )
      setParsed(result)
      if (result.needsReview.length) {
        toast.error(
          `${result.stats.reviewPackages} packages contain a combo that cannot be safely split`,
          'Review Required',
        )
      }
    } catch (error) {
      toast.error(error.message, 'Could Not Read Return File')
    }
  }

  const uploadManifest = async () => {
    if (!parsed?.packages?.length || parsed.needsReview.length || uploading) return
    setUploading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=import`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({
          packages: parsed.packages,
          sourceFile: file?.name || '',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not upload return manifest')
      toast.success(
        `${data.imported_packages} packages · ${data.imported_units} expected units`,
        'Return Manifest Uploaded',
      )
      setFile(null)
      setParsed(null)
      await loadRecent()
      setTab('receive')
      requestAnimationFrame(() => scannerRef.current?.focus())
    } catch (error) {
      toast.error(error.message, 'Upload Failed')
    } finally {
      setUploading(false)
    }
  }

  const loadAnalytics = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=analytics&days=${analyticsDays}`, {
        headers: headers(getToken),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load return analytics')
      setAnalytics(data)
    } catch (error) {
      toast.error(error.message, 'Analytics Failed')
    } finally {
      setLoading(false)
    }
  }, [analyticsDays, getToken, isAdmin, toast])

  useEffect(() => {
    if (tab === 'analytics') loadAnalytics()
  }, [loadAnalytics, tab])

  const tabs = [
    { id: 'receive', label: 'Scan & Receive', icon: ScanLine },
    ...(isAdmin ? [
      { id: 'upload', label: 'Upload Manifest', icon: Upload },
      { id: 'analytics', label: 'Return Analytics', icon: BarChart3 },
    ] : []),
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Returns Receiving</h2>
          <p className="mt-1 text-sm text-slate-500">
            Scan, count, compare, and restock only what is physically returned
          </p>
        </div>
        <div className="flex w-full gap-1 rounded-xl border border-slate-200 bg-white p-1 sm:w-auto">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium sm:flex-none ${
                tab === item.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <item.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'receive' && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              lookup()
            }}
            className="card p-4 sm:p-5"
          >
            <label className="text-sm font-semibold text-slate-800" htmlFor="return-tracking">
              Scan return package
            </label>
            <div className="mt-2 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={scannerRef}
                  id="return-tracking"
                  value={tracking}
                  onChange={(event) => setTracking(event.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="Scan or enter tracking number"
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-3 text-base outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <button type="submit" disabled={loading || !tracking.trim()} className="btn-primary h-12 px-4">
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="hidden sm:inline">Find</span>
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">USB and Bluetooth barcode scanners work as keyboard input. Scan ends with Enter.</p>
          </form>

          {pkg && (
            <div className="card overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <PackageOpen className="h-5 w-5 text-blue-600" />
                    <h3 className="font-semibold text-slate-900">{pkg.tracking_number}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(pkg.status)}`}>
                      {statusLabel(pkg.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Expected {expectedUnits} units · {pkg.items.length} SKU lines
                  </p>
                </div>
                {pkg.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => setCounts(Object.fromEntries(
                      pkg.items.map((item) => [item.id, Number(item.expected_qty)]),
                    ))}
                    className="btn-secondary w-full justify-center text-sm sm:w-auto"
                  >
                    <CheckCircle2 className="h-4 w-4" /> All expected items present
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-100">
                {pkg.items.map((item) => {
                  const actual = Number(counts[item.id] || 0)
                  const differs = actual !== Number(item.expected_qty)
                  return (
                    <div key={item.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">
                          {item.style} / {item.color} / {item.size}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Expected: <strong>{item.expected_qty}</strong>
                          {pkg.status !== 'pending' && <> · Received: <strong>{item.actual_qty ?? 0}</strong></>}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:justify-end">
                        {pkg.status === 'pending' && (
                          <span className={`text-xs font-semibold ${differs ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {differs ? `Difference ${actual - Number(item.expected_qty)}` : 'Matches'}
                          </span>
                        )}
                        <CountControl
                          value={actual}
                          disabled={pkg.status !== 'pending'}
                          onChange={(value) => setCounts((current) => ({ ...current, [item.id]: value }))}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {pkg.status === 'pending' && (
                <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                  <div className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                    discrepancy
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  }`}>
                    {discrepancy
                      ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                    <span>
                      Counted <strong>{actualUnits}</strong> of <strong>{expectedUnits}</strong> expected units.
                      {discrepancy && ' Only actual counted units will be restocked.'}
                    </span>
                  </div>
                  <textarea
                    value={remark}
                    onChange={(event) => setRemark(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="Optional note: missing item, wrong item, damaged item…"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={counted}
                      onChange={(event) => setCounted(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    I opened this package and physically counted every listed item.
                  </label>
                  <button
                    type="button"
                    onClick={confirmPackage}
                    disabled={!counted || loading}
                    className="btn-primary mt-4 w-full justify-center py-3 text-sm disabled:opacity-50 sm:w-auto sm:min-w-52"
                  >
                    {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
                    Add {actualUnits} Actual Units to Inventory
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
              <h3 className="text-sm font-semibold text-slate-800">Recent return packages</h3>
              <button type="button" onClick={loadRecent} className="text-slate-400 hover:text-slate-700">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            {!recent.length ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">No return packages uploaded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recent.slice(0, 20).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      setTracking(item.tracking_number)
                      lookup(item.tracking_number)
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-700">{item.tracking_number}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {item.actual_units || 0} received / {item.expected_units} expected
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'upload' && isAdmin && (
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-blue-50 p-2 text-blue-600">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Upload daily return manifest</h3>
              <p className="mt-1 text-sm text-slate-500">
                Accepts Excel or CSV with Tracking/运单号, SKU/款号, Quantity/数量, and optional Product Attribute/商品属性.
              </p>
            </div>
          </div>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => parseFile(event.target.files?.[0] || null)}
            className="mt-5 block w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
          />

          {parsed && (
            <div className="mt-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xl font-bold text-slate-900">{parsed.stats.packageCount}</p>
                  <p className="text-xs text-slate-500">Packages ready</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xl font-bold text-slate-900">{parsed.stats.expectedUnits}</p>
                  <p className="text-xs text-slate-500">Expected units</p>
                </div>
                <div className={`rounded-xl p-3 ${parsed.stats.reviewPackages ? 'bg-amber-50' : 'bg-emerald-50'}`}>
                  <p className={`text-xl font-bold ${parsed.stats.reviewPackages ? 'text-amber-800' : 'text-emerald-700'}`}>
                    {parsed.stats.reviewPackages}
                  </p>
                  <p className="text-xs text-slate-500">Packages needing review</p>
                </div>
              </div>

              {parsed.needsReview.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-semibold text-amber-800">Upload stopped for safety</p>
                  <p className="mt-1 text-xs text-amber-700">
                    These packages contain a set/combo without a trusted “&” color breakdown:
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-amber-800">
                    {parsed.needsReview.slice(0, 10).map((row, index) => (
                      <li key={`${row.tracking}-${index}`}>
                        {row.tracking}: {row.raw_style} ({row.parse_issue})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={uploadManifest}
                disabled={uploading || !parsed.packages.length || parsed.needsReview.length > 0}
                className="btn-primary w-full justify-center py-3 disabled:opacity-50 sm:w-auto"
              >
                {uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload Return Manifest
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'analytics' && isAdmin && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <select
              value={analyticsDays}
              onChange={(event) => setAnalyticsDays(Number(event.target.value))}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </select>
            <button type="button" onClick={loadAnalytics} className="btn-secondary text-sm">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {analytics && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  ['Received Packages', analytics.summary.received_packages],
                  ['Discrepancy Packages', analytics.summary.discrepancy_packages],
                  ['Expected Units', analytics.summary.expected_units],
                  ['Actual Returned Units', analytics.summary.returned_units],
                ].map(([label, value]) => (
                  <div key={label} className="card p-4">
                    <p className="text-2xl font-bold text-slate-900">{Number(value || 0).toLocaleString()}</p>
                    <p className="mt-1 text-xs text-slate-500">{label}</p>
                  </div>
                ))}
              </div>
              <div className="card overflow-hidden">
                <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
                  <h3 className="text-sm font-semibold text-slate-800">Return rate by SKU</h3>
                  <p className="mt-1 text-xs text-slate-400">Actual received units ÷ sold units in the selected period</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Style</th>
                        <th className="px-4 py-3">Color</th>
                        <th className="px-4 py-3">Size</th>
                        <th className="px-4 py-3 text-right">Sold</th>
                        <th className="px-4 py-3 text-right">Returned</th>
                        <th className="px-4 py-3 text-right">Return Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(analytics.rows || []).map((row, index) => (
                        <tr key={`${row.style}-${row.color}-${row.size}-${index}`}>
                          <td className="px-4 py-3 font-medium text-slate-800">{row.style}</td>
                          <td className="px-4 py-3 text-slate-600">{row.color}</td>
                          <td className="px-4 py-3 text-slate-600">{row.size}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{row.sold_qty}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-blue-700">{row.returned_qty}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold">
                            {row.return_rate == null ? '—' : `${Number(row.return_rate).toFixed(2)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
