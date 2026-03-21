import React, { useState, useCallback, useEffect } from 'react'
import {
  Minus,
  TrendingUp,
  RefreshCw,
  FileDown,
  CheckCircle,
  AlertTriangle,
  Settings,
  X,
  ServerCrash,
  Upload,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { fillInventory, applyToBalance, getConfig, uploadTemplate } from '../utils/inventoryFillApi.js'

// ── Settings modal ────────────────────────────────────────────────────────────
function SettingsModal({ onClose, onUploaded }) {
  const [file,    setFile]    = useState(null)
  const [status,  setStatus]  = useState(null)  // {template_exists, template_name}
  const [saving,  setSaving]  = useState(false)
  const toast = useToast()

  useEffect(() => {
    getConfig()
      .then(setStatus)
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    if (!file) return
    setSaving(true)
    try {
      await uploadTemplate(file)
      toast.success(`Template "${file.name}" uploaded — all users will use this template now`, 'Template Updated')
      onUploaded?.()
      onClose()
    } catch (err) {
      toast.error(err.message, 'Upload Failed')
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

        {/* Current template status */}
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
                : 'No template uploaded yet — upload one to enable Auto-Fill'}
            </span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Upload Detail Inventory Template
          </label>
          <FileUploadZone
            onFile={setFile}
            accept=".csv"
            acceptedTypes="CSV"
            label="Drag & drop Detail Inventory template.csv"
            sublabel="or click to browse"
            currentFile={file}
            onClear={() => setFile(null)}
          />
          <p className="text-xs text-slate-400 mt-1.5">
            The template is stored securely and shared across all users of this app.
            Uploading a new file replaces the existing one immediately.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !file}
            className="btn-primary text-sm px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving
              ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              : <Upload className="w-3.5 h-3.5" />}
            Upload Template
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, color = 'slate' }) {
  const colors = {
    slate:  'text-slate-800',
    green:  'text-green-600',
    yellow: 'text-yellow-600',
    red:    'text-red-600',
  }
  return (
    <div className="card px-4 py-3">
      <p className={`text-2xl font-bold ${colors[color]}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AutoDeduct() {
  const [srcFile,         setSrcFile]         = useState(null)
  const [txnType,         setTxnType]         = useState('sales')
  const [processing,      setProcessing]      = useState(false)
  const [result,          setResult]          = useState(null)
  const [applying,        setApplying]        = useState(false)
  const [applied,         setApplied]         = useState(false)
  const [serverError,     setServerError]     = useState(null)
  const [templateMissing, setTemplateMissing] = useState(false)
  const [showSettings,    setShowSettings]    = useState(false)
  const toast = useToast()

  // Ping server on mount to detect connectivity + template status
  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setServerError(null)
        setTemplateMissing(!cfg.template_exists)
      })
      .catch((err) => setServerError(err.message))
  }, [])

  const handleFile = useCallback((file) => {
    setSrcFile(file)
    setResult(null)
    setApplied(false)
  }, [])

  const handleRun = useCallback(async () => {
    if (!srcFile || processing) return
    setProcessing(true)
    setResult(null)
    setApplied(false)
    try {
      const data = await fillInventory(srcFile)
      setResult(data)
      setServerError(null)
    } catch (err) {
      setServerError(err.message)
      toast.error(err.message, 'Processing Error')
    } finally {
      setProcessing(false)
    }
  }, [srcFile, processing, toast])

  const handleDownload = useCallback(() => {
    if (!result?.xlsx_b64) return
    const bytes = Uint8Array.from(atob(result.xlsx_b64), (c) => c.charCodeAt(0))
    const blob  = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href     = url
    a.download = `Detail_Inventory_filled_${srcFile?.name?.replace('.csv', '') || 'output'}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Excel downloaded')
  }, [result, srcFile, toast])

  const handleApply = useCallback(async () => {
    if (!result?.filled_rows || applying) return
    setApplying(true)
    try {
      await applyToBalance(result.filled_rows, txnType, srcFile?.name)
      setApplied(true)
      const units = result.stats.filled_total
      toast.success(
        `${units.toLocaleString()} units ${txnType === 'sales' ? 'deducted from' : 'added to'} inventory balance`,
        'Balance Updated'
      )
    } catch (err) {
      toast.error(err.message, 'Balance Error')
    } finally {
      setApplying(false)
    }
  }, [result, txnType, srcFile, applying, toast])

  const stats = result?.stats

  return (
    <div className="space-y-6 max-w-4xl">
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onUploaded={() => setTemplateMissing(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Auto Deduct</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload a sales or return CSV — fills the inventory template and updates the balance
          </p>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="btn-secondary text-sm"
        >
          <Settings className="w-4 h-4" />
          Settings
        </button>
      </div>

      {/* Server error banner */}
      {serverError && (
        <div className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <ServerCrash className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Inventory server not reachable</p>
            <p className="text-red-500 mt-0.5 text-xs">
              Check that the inventory API is deployed and running.
            </p>
          </div>
        </div>
      )}

      {/* Template not uploaded banner */}
      {!serverError && templateMissing && (
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Template not uploaded yet</p>
            <p className="mt-0.5 text-amber-700">
              Click <strong>Settings</strong> to upload your Detail Inventory template CSV before running Auto-Fill.
            </p>
          </div>
        </div>
      )}

      {/* Upload card */}
      <div className="card p-5 space-y-4">
        {/* Transaction type toggle */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl w-fit">
          <button
            onClick={() => setTxnType('sales')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              txnType === 'sales'
                ? 'bg-white text-orange-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Minus className="w-4 h-4" />
            Sales — Deduct
          </button>
          <button
            onClick={() => setTxnType('return')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              txnType === 'return'
                ? 'bg-white text-green-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            Return — Add Back
          </button>
        </div>

        {/* File upload */}
        <FileUploadZone
          onFile={handleFile}
          accept=".csv"
          acceptedTypes="CSV"
          label="Drag & drop consolidated / return CSV here"
          sublabel="or click to browse"
          currentFile={srcFile}
          onClear={() => { setSrcFile(null); setResult(null); setApplied(false) }}
        />

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={!srcFile || processing}
          className="btn-primary w-full justify-center py-3 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {processing ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Processing…
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              Run Auto-Fill
            </>
          )}
        </button>
      </div>

      {/* Results */}
      {stats && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Source Total"  value={stats.src_total}    color="slate" />
            <StatCard label="Filled"        value={stats.filled_total} color="green" />
            <StatCard
              label="Appended"
              value={stats.append_total}
              color={stats.append_total > 0 ? 'yellow' : 'slate'}
            />
            <div className="card px-4 py-3 flex items-center gap-2.5">
              {stats.reconciled_total === stats.src_total ? (
                <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0" />
              )}
              <div>
                <p className={`text-sm font-bold ${stats.reconciled_total === stats.src_total ? 'text-green-600' : 'text-yellow-600'}`}>
                  {stats.reconciled_total === stats.src_total ? 'Reconciled ✓' : 'Mismatch'}
                </p>
                <p className="text-xs text-slate-500">Status</p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="card p-5 space-y-3">
            <h3 className="font-medium text-slate-700 text-sm">Actions</h3>

            {/* Download */}
            <button onClick={handleDownload} className="btn-primary w-full justify-center py-2.5">
              <FileDown className="w-4 h-4" />
              Download Filled Template (.xlsx)
            </button>

            {/* Apply to balance */}
            {applied ? (
              <div className="flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-green-600">
                <CheckCircle className="w-4 h-4" />
                Balance updated successfully
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
                {applying ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : txnType === 'sales' ? (
                  <Minus className="w-4 h-4" />
                ) : (
                  <TrendingUp className="w-4 h-4" />
                )}
                {applying
                  ? 'Updating balance…'
                  : txnType === 'sales'
                  ? 'Apply: Deduct from Inventory Balance'
                  : 'Apply: Add to Inventory Balance'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
