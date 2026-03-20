import React, { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Search,
  Download,
  RefreshCw,
  Trash2,
  Clock,
  Package,
  AlertTriangle,
  CheckCircle,
  XCircle,
  CloudOff,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import DataTable from '../components/DataTable.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseInventoryExcel, inventoryToCSV, downloadCSV } from '../utils/excelParser.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import { fetchInventory, saveInventory, clearInventory } from '../utils/api.js'

const COLUMNS = [
  { key: 'style', label: 'Style #', sortable: true },
  { key: 'color', label: 'Color', sortable: true },
  { key: 'sizeBreak', label: 'Size Break', sortable: true },
  {
    key: 'quantity',
    label: 'Quantity',
    sortable: true,
    render: (val) => (
      <span
        className={`inline-flex items-center gap-1.5 font-semibold ${
          val === 0
            ? 'text-red-600'
            : val < 10
            ? 'text-yellow-600'
            : 'text-green-600'
        }`}
      >
        {val === 0 ? (
          <XCircle className="w-3.5 h-3.5" />
        ) : val < 10 ? (
          <AlertTriangle className="w-3.5 h-3.5" />
        ) : (
          <CheckCircle className="w-3.5 h-3.5" />
        )}
        {val}
      </span>
    ),
  },
  { key: 'location', label: 'Location', sortable: true },
]

function RowColoring(row) {
  if (row.quantity === 0) return 'bg-red-50/60'
  if (row.quantity < 10) return 'bg-yellow-50/60'
  return ''
}

export default function InventoryCheck() {
  const [inventoryData, setInventoryData] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isFetching, setIsFetching] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [apiError, setApiError] = useState(null)
  const toast = useToast()

  // Load shared inventory from DB on mount
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsFetching(true)
      setApiError(null)
      try {
        const result = await fetchInventory()
        if (!cancelled) {
          setInventoryData(result.rows || [])
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
      const data = await parseInventoryExcel(file)
      await saveInventory(data, file.name)
      setInventoryData(data)
      setLastUpdated(new Date().toISOString())
      setFileName(file.name)
      toast.success(`Uploaded ${data.length} rows — visible to everyone`, 'Inventory Updated')
    } catch (err) {
      toast.error(err.message, 'Upload Error')
    } finally {
      setIsUploading(false)
    }
  }, [toast])

  const handleClear = useCallback(async () => {
    try {
      await clearInventory()
      setInventoryData([])
      setLastUpdated(null)
      setFileName(null)
      setSearchQuery('')
      toast.info('Inventory data cleared for everyone')
    } catch (err) {
      toast.error(err.message, 'Clear Error')
    }
  }, [toast])

  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return inventoryData
    const q = searchQuery.toLowerCase()
    return inventoryData.filter(
      (r) =>
        (r.style || '').toLowerCase().includes(q) ||
        (r.color || '').toLowerCase().includes(q) ||
        (r.location || '').toLowerCase().includes(q)
    )
  }, [inventoryData, searchQuery])

  const stats = useMemo(() => ({
    total: inventoryData.length,
    outOfStock: inventoryData.filter((r) => r.quantity === 0).length,
    lowStock: inventoryData.filter((r) => r.quantity > 0 && r.quantity < 10).length,
    inStock: inventoryData.filter((r) => r.quantity >= 10).length,
  }), [inventoryData])

  const handleDownload = useCallback(() => {
    const csv = inventoryToCSV(filteredData)
    const name = searchQuery
      ? `inventory_filtered_${Date.now()}.csv`
      : `inventory_${Date.now()}.csv`
    downloadCSV(csv, name)
    toast.success(`Downloaded ${filteredData.length} rows`, 'CSV Exported')
  }, [filteredData, searchQuery, toast])

  const hasData = inventoryData.length > 0
  const isLoading = isFetching || isUploading

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-800">Inventory Check</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload 主库存表.xlsx — data is shared with everyone on the team
          </p>
        </div>
        {hasData && (
          <div className="flex items-center gap-2">
            <button onClick={handleClear} className="btn-secondary text-sm">
              <Trash2 className="w-4 h-4" />
              Clear
            </button>
            <button onClick={handleDownload} className="btn-primary text-sm">
              <Download className="w-4 h-4" />
              Export CSV
            </button>
          </div>
        )}
      </div>

      {/* API Error banner */}
      {apiError && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <CloudOff className="w-4 h-4 flex-shrink-0" />
          <span>Could not reach the database: {apiError}. Check your Netlify environment variables.</span>
        </div>
      )}

      {/* Upload Zone */}
      <div className="card p-5">
        <h3 className="font-medium text-slate-700 mb-3 flex items-center gap-2">
          <Package className="w-4 h-4 text-blue-500" />
          Upload Inventory File
        </h3>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-6 h-6 text-blue-500 animate-spin" />
            <span className="ml-3 text-slate-500">
              {isFetching ? 'Loading shared inventory…' : 'Uploading & saving…'}
            </span>
          </div>
        ) : (
          <FileUploadZone
            onFile={handleFile}
            accept=".xlsx,.xls"
            acceptedTypes="XLSX, XLS"
            label="Drag & drop 主库存表.xlsx here"
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

      {/* Stats */}
      {hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center">
              <Package className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800">{stats.total.toLocaleString()}</p>
              <p className="text-xs text-slate-500">Total Rows</p>
            </div>
          </div>
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-green-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800">{stats.inStock.toLocaleString()}</p>
              <p className="text-xs text-slate-500">In Stock</p>
            </div>
          </div>
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 bg-yellow-100 rounded-lg flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-yellow-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800">{stats.lowStock.toLocaleString()}</p>
              <p className="text-xs text-slate-500">Low Stock</p>
            </div>
          </div>
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center">
              <XCircle className="w-4 h-4 text-red-600" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800">{stats.outOfStock.toLocaleString()}</p>
              <p className="text-xs text-slate-500">Out of Stock</p>
            </div>
          </div>
        </div>
      )}

      {/* Search + Table */}
      {hasData && (
        <div className="card p-5">
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by Style#, Color, or Location..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-base pl-9"
              />
            </div>
            {searchQuery && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <span className="bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
                  {filteredData.length} results
                </span>
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-slate-400 hover:text-slate-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 mb-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-red-200 inline-block" />
              Out of stock (0)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-yellow-200 inline-block" />
              Low stock (&lt;10)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-green-100 inline-block" />
              In stock (≥10)
            </span>
          </div>

          <DataTable
            data={filteredData}
            columns={COLUMNS}
            pageSize={50}
            rowClassName={RowColoring}
            emptyMessage={searchQuery ? `No results for "${searchQuery}"` : 'No inventory data'}
          />
        </div>
      )}

      {/* Empty state */}
      {!hasData && !isLoading && (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Package className="w-8 h-8 text-blue-500" />
          </div>
          <h3 className="font-semibold text-slate-700 mb-1">No inventory loaded</h3>
          <p className="text-sm text-slate-400">
            Upload your 主库存表.xlsx file above — it will be visible to everyone on the team.
          </p>
        </div>
      )}
    </div>
  )
}
