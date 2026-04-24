import React, { useState, useCallback, useEffect } from 'react'
import {
  Minus, TrendingUp, RefreshCw, FileDown,
  CheckCircle, AlertTriangle, Settings, X, Upload, AlertCircle,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { useAuth } from '../context/AuthContext.jsx'
import { parseCSV, fillTemplate, generateExcel } from '../utils/autoDeductEngine.js'

const BASE = '/api'

function authHeaders(token, json = false) {
  const h = { Authorization: `Bearer ${token}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

// ── Settings modal ─────────────────────────────────────────────────────────────
function SettingsModal({ onClose, onUploaded, getToken }) {
  const [file,   setFile]   = useState(null)
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState(null)
  const toast = useToast()

  useEffect(() => {
    fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      .then(r => r.json())
      .then(data => setStatus({
        template_exists: data.initialized,
        template_name:   data.initialized ? `${data.rows?.length || 0} SKUs loaded` : null,
      }))
      .catch(() => {})
  }, [getToken])

  const handleSave = async () => {
    if (!file) return
    setSaving(true); setErr(null)
    try {
      // Parse CSV client-side, send rows as JSON — no file upload needed
      const text = await file.text()
      const raw  = parseCSV(text)
      if (!raw.length) throw new Error('CSV appears to be empty or unreadable')

      // Normalise to Pascal case, set Quantity: 0, and capture row index as SortOrder
      // so the DB can return rows in the original SalesTEMPLATE.csv sequence.
      const rows = raw
        .map((r, i) => ({
          Style:     String(r.STYLE || r.Style || r.style || '').trim(),
          Color:     String(r.COLOR || r.Color || r.color || '').trim(),
          Size:      String(r.SIZE  || r.Size  || r.size  || '').trim(),
          Quantity:  0,
          SortOrder: i,
        }))
        .filter(r => r.Style && r.Color && r.Size)
      if (!rows.length) throw new Error('No valid STYLE / COLOR / SIZE rows found')

      const res = await fetch(`${BASE}/inventory-balance?action=add-rows`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ rows }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success(
        `${data.added} new SKU${data.added !== 1 ? 's' : ''} added to inventory balance`,
        'Template Synced'
      )
      onUploaded?.()
      onClose()
    } catch (e) {
      setErr(e.message)
      toast.error(e.message, 'Upload Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center">
              <Settings className="w-4 h-4 text-blue-600" />
            </div>
            <h3 className="font-semibold text-slate-800">Template Settings</h3>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {status && (
          <div className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm border ${
            status.template_exists
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            {status.template_exists
              ? <CheckCircle className="w-4 h-4 flex-shrink-0" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            <span>
              {status.template_exists
                ? <><strong>Active:</strong> {status.template_name}</>
                : 'No template uploaded yet — upload the SalesTEMPLATE.csv to enable Auto-Fill'}
            </span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Upload SalesTEMPLATE.csv
          </label>
          <FileUploadZone
            onFile={setFile}
            accept=".csv"
            acceptedTypes="CSV"
            label="Drag & drop SalesTEMPLATE.csv here"
            sublabel="Columns: STYLE, COLOR, SIZE"
            currentFile={file}
            onClear={() => setFile(null)}
          />
          <p className="text-xs text-slate-400 mt-1.5">
            Template is stored and shared with all users. Uploading replaces the current one.
          </p>
          {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary text-sm px-4 py-2">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !file}
            className="btn-primary text-sm px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload Template
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, color = 'slate' }) {
  const colors = { slate: 'text-slate-800', green: 'text-green-600', yellow: 'text-yellow-600', red: 'text-red-600' }
  return (
    <div className="card px-4 py-3">
      <p className={`text-2xl font-bold ${colors[color]}`}>{Number(value).toLocaleString()}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function AutoDeduct() {
  const { getToken } = useAuth()
  const [srcFile,         setSrcFile]         = useState(null)
  const [txnType,         setTxnType]         = useState('sales')
  const [processing,      setProcessing]      = useState(false)
  const [result,          setResult]          = useState(null)   // { filledRows, unmatchedRows, stats }
  const [applying,        setApplying]        = useState(false)
  const [applied,         setApplied]         = useState(false)
  const [configError,     setConfigError]     = useState(null)
  const [templateMissing, setTemplateMissing] = useState(false)
  const [showSettings,    setShowSettings]    = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      .then(r => r.json())
      .then(data => { setConfigError(null); setTemplateMissing(!data.initialized) })
      .catch(err => setConfigError(err.message))
  }, [getToken])

  const handleFile = useCallback((file) => {
    setSrcFile(file); setResult(null); setApplied(false)
  }, [])

  const handleRun = useCallback(async () => {
    if (!srcFile || processing) return
    setProcessing(true); setResult(null); setApplied(false)
    try {
      // 1. Fetch template from inventory balance (canonical SKU list)
      const tRes  = await fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      const tData = await tRes.json()
      if (!tRes.ok) throw new Error(tData.error || 'Could not load inventory balance')
      const templateRows = (tData.rows || []).map(r => ({ STYLE: r.Style, COLOR: r.Color, SIZE: r.Size }))

      // 2. Parse sales CSV client-side
      const salesText = await srcFile.text()
      const salesRows = parseCSV(salesText)

      // 3. Match & fill — pure JS, no server needed
      const engineResult = fillTemplate(templateRows, salesRows)
      setResult(engineResult)
      setConfigError(null)

      const { src_total, filled_total, append_total } = engineResult.stats
      toast.success(
        `${filled_total.toLocaleString()} / ${src_total.toLocaleString()} units matched · ${append_total} unmatched`,
        'Auto-Fill Complete'
      )
    } catch (err) {
      setConfigError(err.message)
      toast.error(err.message, 'Processing Error')
    } finally {
      setProcessing(false)
    }
  }, [srcFile, processing, getToken, toast])

  const handleDownload = useCallback(async () => {
    if (!result) return
    try {
      await generateExcel(result.filledRows, result.unmatchedRows, srcFile?.name || 'output')
      toast.success('Excel downloaded')
    } catch (err) {
      toast.error(err.message, 'Download Failed')
    }
  }, [result, srcFile, toast])

  const handleApply = useCallback(async () => {
    if (!result?.filledRows || applying) return
    setApplying(true)
    try {
      const res = await fetch(`${BASE}/inventory-balance?action=apply`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({
          filledRows:  result.filledRows,
          txnType,
          sourceName:  srcFile?.name || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setApplied(true)
      toast.success(
        `${data.applied_units.toLocaleString()} units ${txnType === 'sales' ? 'deducted from inventory' : 'returned to inventory'}`,
        'Inventory Updated'
      )
    } catch (err) {
      toast.error(err.message, 'Apply Failed')
    } finally {
      setApplying(false)
    }
  }, [result, txnType, srcFile, applying, getToken, toast])

  const stats = result?.stats

  return (
    <div className="space-y-6 max-w-4xl">
      {showSettings && (
        <SettingsModal
          getToken={getToken}
          onClose={() => setShowSettings(false)}
          onUploaded={() => setTemplateMissing(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Auto Deduct</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload a consolidated sales CSV — matches against your template and fills quantities
          </p>
        </div>
        <button onClick={() => setShowSettings(true)} className="btn-secondary text-sm">
          <Settings className="w-4 h-4" />
          Settings
        </button>
      </div>

      {/* Error banner */}
      {configError && (
        <div className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p>{configError}</p>
        </div>
      )}

      {/* Template missing banner */}
      {!configError && templateMissing && (
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Template not uploaded yet</p>
            <p className="mt-0.5 text-amber-700">
              Click <strong>Settings</strong> and upload your <strong>SalesTEMPLATE.csv</strong> first.
            </p>
          </div>
        </div>
      )}

      {/* Upload card */}
      <div className="card p-5 space-y-4">
        {/* Transaction type */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl w-fit">
          {[
            { id: 'sales',  label: 'Sales — Deduct',    icon: Minus,       active: 'text-orange-600' },
            { id: 'return', label: 'Return — Add Back', icon: TrendingUp,  active: 'text-green-600'  },
          ].map(({ id, label, icon: Icon, active }) => (
            <button key={id} onClick={() => setTxnType(id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                txnType === id ? `bg-white shadow-sm ${active}` : 'text-slate-500 hover:text-slate-700'
              }`}>
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* File upload */}
        <FileUploadZone
          onFile={handleFile}
          accept=".csv"
          acceptedTypes="CSV"
          label="Drag & drop consolidated / return CSV here"
          sublabel="Columns: style, color, size, QTY"
          currentFile={srcFile}
          onClear={() => { setSrcFile(null); setResult(null); setApplied(false) }}
        />

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={!srcFile || processing || templateMissing}
          className="btn-primary w-full justify-center py-3 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {processing
            ? <><RefreshCw className="w-4 h-4 animate-spin" /> Processing…</>
            : <><RefreshCw className="w-4 h-4" /> Run Auto-Fill</>}
        </button>
      </div>

      {/* Results */}
      {stats && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Source Total"  value={stats.src_total}    color="slate" />
            <StatCard label="Matched"       value={stats.filled_total} color="green" />
            <StatCard label="Unmatched"     value={stats.append_total} color={stats.append_total > 0 ? 'yellow' : 'slate'} />
            <div className="card px-4 py-3 flex items-center gap-2.5">
              {stats.reconciled_total === stats.src_total
                ? <CheckCircle  className="w-5 h-5 text-green-500 flex-shrink-0" />
                : <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0" />}
              <div>
                <p className={`text-sm font-bold ${stats.reconciled_total === stats.src_total ? 'text-green-600' : 'text-yellow-600'}`}>
                  {stats.reconciled_total === stats.src_total ? 'Reconciled ✓' : 'Mismatch'}
                </p>
                <p className="text-xs text-slate-500">Status</p>
              </div>
            </div>
          </div>

          {/* Unmatched rows preview */}
          {result.unmatchedRows?.length > 0 && (
            <div className="card p-4">
              <p className="text-sm font-medium text-yellow-700 mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                {result.unmatchedRows.length} sales rows had no template match — included in "Unmatched Sales" sheet of the Excel
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-slate-600">
                  <thead>
                    <tr className="border-b border-slate-100">
                      {['Style','Color','Size','Qty'].map(h => (
                        <th key={h} className="text-left py-1 pr-4 text-slate-400 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.unmatchedRows.slice(0, 10).map((r, i) => (
                      <tr key={i} className="border-b border-slate-50">
                        <td className="py-1 pr-4">{r.style}</td>
                        <td className="py-1 pr-4">{r.color}</td>
                        <td className="py-1 pr-4">{r.size}</td>
                        <td className="py-1">{r.qty}</td>
                      </tr>
                    ))}
                    {result.unmatchedRows.length > 10 && (
                      <tr>
                        <td colSpan={4} className="py-1 text-slate-400 italic">
                          …and {result.unmatchedRows.length - 10} more (see Excel sheet)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="card p-5 space-y-3">
            <h3 className="font-medium text-slate-700 text-sm">Actions</h3>

            <button onClick={handleDownload} className="btn-primary w-full justify-center py-2.5">
              <FileDown className="w-4 h-4" />
              Download Filled Template (.xlsx)
            </button>

            {applied ? (
              <div className="flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-green-600">
                <CheckCircle className="w-4 h-4" />
                Transaction logged successfully
              </div>
            ) : (
              <button
                onClick={handleApply}
                disabled={applying}
                className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  txnType === 'sales'
                    ? 'bg-orange-100 hover:bg-orange-200 text-orange-700'
                    : 'bg-green-100 hover:bg-green-200 text-green-700'
                }`}
              >
                {applying
                  ? <RefreshCw className="w-4 h-4 animate-spin" />
                  : txnType === 'sales' ? <Minus className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
                {applying
                  ? 'Logging…'
                  : txnType === 'sales'
                  ? 'Log as Deducted from Inventory'
                  : 'Log as Returned to Inventory'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
