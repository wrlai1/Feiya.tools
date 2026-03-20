import React, { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Search,
  Truck,
  Copy,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
  Hash,
  CloudOff,
  Clock,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseTrackingCSV } from '../utils/csvParser.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import { fetchTracking, saveTracking, clearTracking } from '../utils/api.js'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
        copied
          ? 'bg-green-100 text-green-700'
          : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
      }`}
      title="Copy to clipboard"
    >
      {copied ? <CheckCheck className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function SKUGroup({ sku, rows }) {
  const [expanded, setExpanded] = useState(false)

  const bySizeMap = useMemo(() => {
    const map = {}
    rows.forEach((r) => {
      const size = r.actualSize || 'Unknown'
      if (!map[size]) map[size] = { size, totalQty: 0, count: 0, rows: [] }
      map[size].totalQty += r.quantity || 0
      map[size].count += 1
      map[size].rows.push(r)
    })
    return Object.values(map).sort((a, b) => a.size.localeCompare(b.size))
  }, [rows])

  const totalQty = rows.reduce((s, r) => s + (r.quantity || 0), 0)

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-50">
        <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
          <Hash className="w-4 h-4 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 truncate">{sku}</p>
          <p className="text-xs text-slate-500">
            {rows.length} tracking entries · {totalQty} total units
          </p>
        </div>
        <CopyButton text={sku} />
      </div>

      <div className="px-4 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-3">
          {bySizeMap.map(({ size, totalQty: qty, count }) => (
            <div key={size} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-xs text-slate-500 truncate">{size}</p>
              <p className="text-lg font-bold text-slate-800">{qty}</p>
              <p className="text-xs text-slate-400">{count} pkg</p>
            </div>
          ))}
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {expanded ? 'Hide' : 'Show'} {rows.length} raw rows
        </button>

        {expanded && (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide">Tracking</th>
                  <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide">Actual Size On TEMU</th>
                  <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide">Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-700 font-mono">{row.tracking}</td>
                    <td className="px-3 py-2 text-slate-600">{row.actualSize}</td>
                    <td className="px-3 py-2 text-slate-700 font-medium">{row.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

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

  // Load shared tracking data on mount
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

  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return trackingData
    const q = searchQuery.toLowerCase()
    return trackingData.filter((r) =>
      searchType === 'tracking'
        ? (r.tracking || '').toLowerCase().includes(q)
        : (r.sku || '').toLowerCase().includes(q)
    )
  }, [trackingData, searchQuery, searchType])

  const groupedBySKU = useMemo(() => {
    const map = {}
    filteredData.forEach((row) => {
      const sku = row.sku || 'Unknown SKU'
      if (!map[sku]) map[sku] = []
      map[sku].push(row)
    })
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [filteredData])

  const hasData = trackingData.length > 0
  const totalSKUs = groupedBySKU.length
  const totalUnits = filteredData.reduce((s, r) => s + (r.quantity || 0), 0)
  const isLoading = isFetching || isUploading

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
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

      {/* API Error banner */}
      {apiError && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <CloudOff className="w-4 h-4 flex-shrink-0" />
          <span>Could not reach the database: {apiError}</span>
        </div>
      )}

      {/* Upload Zone */}
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
            {fileName && <span className="text-slate-300 mx-1">·</span>}
            {fileName && <span className="truncate max-w-xs">{fileName}</span>}
          </p>
        )}
      </div>

      {/* Search + Results */}
      {hasData && (
        <>
          <div className="card p-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  onClick={() => setSearchType('tracking')}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    searchType === 'tracking'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Tracking #
                </button>
                <button
                  onClick={() => setSearchType('sku')}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    searchType === 'sku'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  SKU
                </button>
              </div>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder={searchType === 'tracking' ? 'Search by tracking number...' : 'Search by SKU...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input-base pl-9"
                />
              </div>
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="btn-secondary text-sm flex-shrink-0">
                  Clear
                </button>
              )}
            </div>

            <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
              <span>{totalSKUs} SKUs</span>
              <span>·</span>
              <span>{filteredData.length} rows</span>
              <span>·</span>
              <span>{totalUnits} total units</span>
            </div>
          </div>

          <div className="space-y-3">
            {groupedBySKU.length === 0 ? (
              <div className="card p-10 text-center">
                <Search className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No results found</p>
                <p className="text-slate-400 text-sm mt-1">Try searching with a different term</p>
              </div>
            ) : (
              groupedBySKU.map(([sku, rows]) => (
                <SKUGroup key={sku} sku={sku} rows={rows} />
              ))
            )}
          </div>
        </>
      )}

      {/* Empty state */}
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
