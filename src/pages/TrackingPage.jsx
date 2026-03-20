import React, { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Search,
  Truck,
  Copy,
  CheckCheck,
  RefreshCw,
  Trash2,
  Hash,
  CloudOff,
  Clock,
  Package,
  Ruler,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseTrackingCSV } from '../utils/csvParser.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import { fetchTracking, saveTracking, clearTracking } from '../utils/api.js'

// ─── Shared copy button ────────────────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }
  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors flex-shrink-0 ${
        copied ? 'bg-green-100 text-green-700' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
      }`}
      title="Copy"
    >
      {copied ? <CheckCheck className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// ─── Tracking # view — one card per tracking number ───────────────────────────
function TrackingGroup({ tracking, rows }) {
  const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0)

  return (
    <div className="card overflow-hidden">
      {/* Card header — tracking number */}
      <div className="flex items-center gap-3 px-4 py-3 bg-teal-50 border-b border-teal-100">
        <div className="w-9 h-9 bg-teal-500 rounded-lg flex items-center justify-center flex-shrink-0">
          <Truck className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-mono font-semibold text-slate-800 text-sm truncate">{tracking}</p>
          <p className="text-xs text-teal-600 mt-0.5">
            {rows.length} line{rows.length !== 1 ? 's' : ''} · <span className="font-semibold">{totalUnits} total units</span>
          </p>
        </div>
        <CopyButton text={tracking} />
      </div>

      {/* Rows: SKU | True Size | Qty */}
      <div className="divide-y divide-slate-100">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_120px_72px] gap-2 px-4 py-2 bg-slate-50">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
            <Hash className="w-3 h-3" /> SKU
          </span>
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
            <Ruler className="w-3 h-3" /> True Size
          </span>
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
            <Package className="w-3 h-3" /> Qty
          </span>
        </div>

        {rows.map((row, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[1fr_120px_72px] gap-2 px-4 py-2.5 hover:bg-slate-50 transition-colors items-center"
          >
            {/* SKU */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-slate-800 truncate">{row.sku || '—'}</span>
              {row.sku && <CopyButton text={row.sku} />}
            </div>

            {/* True Size */}
            <div>
              {row.actualSize ? (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
                  {row.actualSize}
                </span>
              ) : (
                <span className="text-xs text-slate-400">—</span>
              )}
            </div>

            {/* Qty */}
            <div>
              <span className={`inline-flex items-center justify-center w-9 h-7 rounded-lg text-sm font-bold ${
                (row.quantity || 0) >= 10
                  ? 'bg-green-100 text-green-700'
                  : (row.quantity || 0) >= 1
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-600'
              }`}>
                {row.quantity ?? 0}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Footer summary */}
      <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
        <span className="text-xs text-slate-400">{rows.length} SKU line{rows.length !== 1 ? 's' : ''}</span>
        <span className="text-xs font-semibold text-slate-600">{totalUnits} units total</span>
      </div>
    </div>
  )
}

// ─── SKU view — one card per SKU with size tiles ──────────────────────────────
function SKUGroup({ sku, rows }) {
  const bySizeMap = useMemo(() => {
    const map = {}
    rows.forEach((r) => {
      const size = r.actualSize || 'Unknown'
      if (!map[size]) map[size] = { size, totalQty: 0, trackingNums: [] }
      map[size].totalQty += r.quantity || 0
      map[size].trackingNums.push(r.tracking)
    })
    return Object.values(map).sort((a, b) => a.size.localeCompare(b.size))
  }, [rows])

  const totalQty = rows.reduce((s, r) => s + (r.quantity || 0), 0)

  return (
    <div className="card overflow-hidden">
      {/* SKU header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200">
        <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
          <Hash className="w-4 h-4 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 truncate">{sku}</p>
          <p className="text-xs text-slate-500">
            {rows.length} tracking entr{rows.length !== 1 ? 'ies' : 'y'} · <span className="font-semibold">{totalQty} total units</span>
          </p>
        </div>
        <CopyButton text={sku} />
      </div>

      {/* Size tiles */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Ruler className="w-3 h-3" /> Size breakdown
        </p>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {bySizeMap.map(({ size, totalQty: qty }) => (
            <div key={size} className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-center">
              <p className="text-xs font-semibold text-blue-600 truncate">{size}</p>
              <p className="text-2xl font-bold text-slate-800 leading-tight">{qty}</p>
              <p className="text-xs text-slate-400">units</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function TrackingPage() {
  const [trackingData, setTrackingData] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isFetching, setIsFetching] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [apiError, setApiError] = useState(null)
  const [searchType, setSearchType] = useState('tracking')
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsFetching(true)
      setApiError(null)
      try {
        const result = await fetchTracking()
        if (!cancelled) {
          setTrackingData(result.rows || [])
          setLastUpdated(result.updatedAt || null)
          setFileName(result.fileName || null)
        }
      } catch (err) {
        if (!cancelled) setApiError(err.message)
      } finally {
        if (!cancelled) setIsFetching(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const handleFile = useCallback(async (file) => {
    setIsUploading(true)
    try {
      const data = await parseTrackingCSV(file)
      await saveTracking(data, file.name)
      setTrackingData(data)
      setLastUpdated(new Date().toISOString())
      setFileName(file.name)
      toast.success(`Uploaded ${data.length} rows — visible to everyone`, 'Tracking Updated')
    } catch (err) {
      toast.error(err.message, 'Upload Error')
    } finally {
      setIsUploading(false)
    }
  }, [toast])

  const handleClear = useCallback(async () => {
    try {
      await clearTracking()
      setTrackingData([])
      setLastUpdated(null)
      setFileName(null)
      setSearchQuery('')
      toast.info('Tracking data cleared for everyone')
    } catch (err) {
      toast.error(err.message, 'Clear Error')
    }
  }, [toast])

  // Filter rows matching the query
  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return trackingData
    const q = searchQuery.toLowerCase()
    return trackingData.filter((r) =>
      searchType === 'tracking'
        ? (r.tracking || '').toLowerCase().includes(q)
        : (r.sku || '').toLowerCase().includes(q)
    )
  }, [trackingData, searchQuery, searchType])

  // Group by tracking number (for tracking # search view)
  const groupedByTracking = useMemo(() => {
    const map = {}
    filteredData.forEach((row) => {
      const t = row.tracking || 'Unknown'
      if (!map[t]) map[t] = []
      map[t].push(row)
    })
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [filteredData])

  // Group by SKU (for SKU search view)
  const groupedBySKU = useMemo(() => {
    const map = {}
    filteredData.forEach((row) => {
      const sku = row.sku || 'Unknown SKU'
      if (!map[sku]) map[sku] = []
      map[sku].push(row)
    })
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [filteredData])

  const hasData    = trackingData.length > 0
  const isLoading  = isFetching || isUploading
  const totalUnits = filteredData.reduce((s, r) => s + (r.quantity || 0), 0)
  const hasQuery   = searchQuery.trim().length > 0

  const summaryLine = searchType === 'tracking'
    ? `${groupedByTracking.length} tracking number${groupedByTracking.length !== 1 ? 's' : ''} · ${filteredData.length} lines · ${totalUnits} units`
    : `${groupedBySKU.length} SKU${groupedBySKU.length !== 1 ? 's' : ''} · ${filteredData.length} rows · ${totalUnits} units`

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-800">Tracking → SKU</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload a tracking CSV — data stays shared until cleared or re-uploaded
          </p>
        </div>
        {hasData && (
          <button onClick={handleClear} className="btn-secondary text-sm">
            <Trash2 className="w-4 h-4" />
            Clear Data
          </button>
        )}
      </div>

      {/* API error */}
      {apiError && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <CloudOff className="w-4 h-4 flex-shrink-0" />
          <span>Could not reach the database: {apiError}</span>
        </div>
      )}

      {/* Upload zone */}
      <div className="card p-5">
        <h3 className="font-medium text-slate-700 mb-3 flex items-center gap-2">
          <Truck className="w-4 h-4 text-teal-500" />
          Upload Tracking File
        </h3>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-6 h-6 text-teal-500 animate-spin" />
            <span className="ml-3 text-slate-500">
              {isFetching ? 'Loading shared tracking data…' : 'Uploading & saving…'}
            </span>
          </div>
        ) : (
          <FileUploadZone
            onFile={handleFile}
            accept=".csv"
            acceptedTypes="CSV"
            label="Drag & drop your tracking CSV here"
            sublabel="Columns: Tracking, SKU, Quantity, Actual Size On TEMU"
            currentFile={hasData && fileName ? { name: fileName } : null}
            onClear={handleClear}
          />
        )}
        {lastUpdated && (
          <p className="text-xs text-slate-400 mt-3 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Last updated: {formatLastUpdated(lastUpdated)}
            {fileName && <><span className="text-slate-300 mx-1">·</span><span className="truncate max-w-xs">{fileName}</span></>}
          </p>
        )}
      </div>

      {/* Search bar */}
      {hasData && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            {/* Mode toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm font-medium">
              <button
                onClick={() => { setSearchType('tracking'); setSearchQuery('') }}
                className={`px-4 py-2 transition-colors ${
                  searchType === 'tracking' ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                Tracking #
              </button>
              <button
                onClick={() => { setSearchType('sku'); setSearchQuery('') }}
                className={`px-4 py-2 transition-colors ${
                  searchType === 'sku' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                SKU
              </button>
            </div>

            {/* Search input */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder={searchType === 'tracking' ? 'Enter tracking number…' : 'Enter SKU…'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-base pl-9"
              />
            </div>
            {hasQuery && (
              <button onClick={() => setSearchQuery('')} className="btn-secondary text-sm flex-shrink-0">
                Clear
              </button>
            )}
          </div>

          {/* Summary line */}
          {hasQuery && (
            <p className="text-xs text-slate-500">{summaryLine}</p>
          )}
        </div>
      )}

      {/* Results */}
      {hasData && hasQuery && (
        <div className="space-y-3">
          {searchType === 'tracking' ? (
            groupedByTracking.length === 0 ? (
              <div className="card p-10 text-center">
                <Search className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No tracking numbers found</p>
                <p className="text-slate-400 text-sm mt-1">Try a different number</p>
              </div>
            ) : (
              groupedByTracking.map(([tracking, rows]) => (
                <TrackingGroup key={tracking} tracking={tracking} rows={rows} />
              ))
            )
          ) : (
            groupedBySKU.length === 0 ? (
              <div className="card p-10 text-center">
                <Search className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No SKUs found</p>
                <p className="text-slate-400 text-sm mt-1">Try a different SKU</p>
              </div>
            ) : (
              groupedBySKU.map(([sku, rows]) => (
                <SKUGroup key={sku} sku={sku} rows={rows} />
              ))
            )
          )}
        </div>
      )}

      {/* Prompt when data loaded but no query yet */}
      {hasData && !hasQuery && !isLoading && (
        <div className="card p-8 text-center">
          <div className="w-14 h-14 bg-teal-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Search className="w-7 h-7 text-teal-500" />
          </div>
          <h3 className="font-semibold text-slate-700 mb-1">
            {trackingData.length.toLocaleString()} rows loaded
          </h3>
          <p className="text-sm text-slate-400">
            {searchType === 'tracking'
              ? 'Type a tracking number above to see its SKUs, sizes, and quantities.'
              : 'Type a SKU above to see its size and quantity breakdown.'}
          </p>
        </div>
      )}

      {/* Empty state — no data uploaded yet */}
      {!hasData && !isLoading && (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 bg-teal-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Truck className="w-8 h-8 text-teal-500" />
          </div>
          <h3 className="font-semibold text-slate-700 mb-1">No tracking data loaded</h3>
          <p className="text-sm text-slate-400">
            Upload a tracking CSV — it stays available for the whole team until cleared or replaced.
          </p>
        </div>
      )}
    </div>
  )
}
