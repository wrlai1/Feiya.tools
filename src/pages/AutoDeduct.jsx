import React, { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Minus, TrendingUp, RefreshCw, FileDown,
  CheckCircle, AlertTriangle, Settings, X, Upload, AlertCircle,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import UnmatchedResolver from '../components/UnmatchedResolver.jsx'
import { useToast } from '../hooks/useToast.js'
import { useAuth } from '../context/AuthContext.jsx'
import { parseCSV, fillTemplate, generateExcel, aliasKey } from '../utils/autoDeductEngine.js'
import ConsolidateStep from '../components/ConsolidateStep.jsx'

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

// ── Mock data for UI preview (only active when ?mock=1 in the URL) ─────────────
const MOCK_TEMPLATE = [
  { STYLE: '50073', COLOR: 'dark denim#2',         SIZE: 'S' },
  { STYLE: '50073', COLOR: 'dark denim#2',         SIZE: 'M' },
  { STYLE: '50073', COLOR: 'dark denim#2',         SIZE: 'L' },
  { STYLE: '50073', COLOR: 'knit denim',           SIZE: 'S' },
  { STYLE: 'M022 Missy', COLOR: 'Canyon Rose',     SIZE: 'S' },
  { STYLE: 'M022 Missy', COLOR: 'Canyon Rose',     SIZE: 'M' },
  { STYLE: 'M022 PLUS',  COLOR: 'Canyon Rose',     SIZE: '1X' },
  { STYLE: '88053',      COLOR: 'BLACK',            SIZE: '12' },
  { STYLE: '88053',      COLOR: 'BLACK',            SIZE: '14' },
  { STYLE: '88053',      COLOR: 'WHITE',            SIZE: '12' },
]
const MOCK_RESULT = {
  filledRows:    MOCK_TEMPLATE.map(r => ({ ...r, QTY: 0 })),
  unmatchedRows: [
    { style: 'M022', color: 'melon', size: 'S', qty: 12 },
    { style: '88053', color: 'khaki white', size: '12', qty: 5 },
    { style: '5010130', color: 'peacock', size: 'M', qty: 8 },
  ],
  stats: { src_total: 25, filled_total: 0, append_total: 25, reconciled_total: 25 },
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function AutoDeduct() {
  const { getToken } = useAuth()
  // DEV-ONLY preview switch; import.meta.env.DEV is false in production builds.
  const isMock = import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1'
  const [srcFile,         setSrcFile]         = useState(null)
  const [txnType,         setTxnType]         = useState('sales')
  const [processing,      setProcessing]      = useState(false)
  const [result,          setResult]          = useState(null)   // { filledRows, unmatchedRows, stats }
  const [templateRows,    setTemplateRows]    = useState([])     // raw template for the resolver
  const [resolvedExtras,  setResolvedExtras]  = useState(null)  // null = resolver not done yet
  const [skippedRows,     setSkippedRows]     = useState([])    // rows user chose to skip — stay on the Unmatched sheet
  const [applying,        setApplying]        = useState(false)
  const [applied,         setApplied]         = useState(false)
  const [configError,     setConfigError]     = useState(null)
  const [templateMissing, setTemplateMissing] = useState(false)
  const [showSettings,    setShowSettings]    = useState(false)
  const [aliases,         setAliases]         = useState({})
  const toast = useToast()

  // Merge resolver output into filledRows:
  //   linked items  → find the matching row and add QTY
  //   created items → append as new row at the end
  const mergedFilledRows = useMemo(() => {
    if (!result) return []
    if (!resolvedExtras?.length) return result.filledRows
    const rows = result.filledRows.map(r => ({ ...r }))
    for (const extra of resolvedExtras) {
      if (extra._isCombo && Array.isArray(extra.components)) {
        for (const component of extra.components) {
          const found = rows.find(r => r.STYLE === component.STYLE && r.COLOR === component.COLOR && r.SIZE === component.SIZE)
          if (found) found.QTY = (found.QTY || 0) + extra.QTY
          else rows.push({ STYLE: component.STYLE, COLOR: component.COLOR, SIZE: component.SIZE, QTY: extra.QTY })
        }
        continue
      }
      if (extra._isNew) {
        rows.push({ STYLE: extra.STYLE, COLOR: extra.COLOR, SIZE: extra.SIZE, QTY: extra.QTY })
      } else {
        const found = rows.find(r => r.STYLE === extra.STYLE && r.COLOR === extra.COLOR && r.SIZE === extra.SIZE)
        if (found) found.QTY = (found.QTY || 0) + extra.QTY
        else rows.push({ STYLE: extra.STYLE, COLOR: extra.COLOR, SIZE: extra.SIZE, QTY: extra.QTY })
      }
    }
    return rows
  }, [result, resolvedExtras])

  useEffect(() => {
    if (isMock) { setTemplateRows(MOCK_TEMPLATE); return }
    fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      .then(r => r.json())
      .then(data => { setConfigError(null); setTemplateMissing(!data.initialized) })
      .catch(err => setConfigError(err.message))
  }, [getToken, isMock])

  useEffect(() => {
    if (isMock) return
    fetch(`${BASE}/auto-deduct?action=aliases`, { headers: authHeaders(getToken()) })
      .then(r => r.json())
      .then(data => setAliases(data.aliases || {}))
      .catch(() => setAliases({}))
  }, [getToken, isMock])

  const handleFile = useCallback((file) => {
    setSrcFile(file); setResult(null); setApplied(false); setResolvedExtras(null); setSkippedRows([])
  }, [])

  const handleRun = useCallback(async () => {
    if (isMock) {
      setResult(MOCK_RESULT)
      setTemplateRows(MOCK_TEMPLATE)
      setApplied(false); setResolvedExtras(null); setSkippedRows([])
      toast.info('3 rows need review', 'Mock Run Complete')
      return
    }
    if (!srcFile || processing) return
    setProcessing(true); setResult(null); setApplied(false); setResolvedExtras(null); setSkippedRows([])
    try {
      // 1. Fetch template from inventory balance (canonical SKU list)
      const tRes  = await fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      const tData = await tRes.json()
      if (!tRes.ok) throw new Error(tData.error || 'Could not load inventory balance')
      const tRows = (tData.rows || []).map(r => ({ STYLE: r.Style, COLOR: r.Color, SIZE: r.Size }))
      setTemplateRows(tRows)

      // 2. Parse sales CSV client-side
      const salesText = await srcFile.text()
      const salesRows = parseCSV(salesText)

      // 3. Match & fill — pure JS, no server needed
      const engineResult = fillTemplate(tRows, salesRows, aliases)
      setResult(engineResult)
      setConfigError(null)

      const { src_total, filled_total, append_total } = engineResult.stats
      if (append_total > 0) {
        toast.info(
          `${filled_total.toLocaleString()} / ${src_total.toLocaleString()} units matched · ${append_total} need review`,
          'Review Required'
        )
      } else {
        toast.success(
          `${filled_total.toLocaleString()} / ${src_total.toLocaleString()} units matched`,
          'Auto-Fill Complete'
        )
      }
    } catch (err) {
      setConfigError(err.message)
      toast.error(err.message, 'Processing Error')
    } finally {
      setProcessing(false)
    }
  }, [srcFile, processing, getToken, toast, aliases])

  // Called by UnmatchedResolver when user finishes reviewing.
  // Skipped rows are NOT deducted, but they must stay visible on the Unmatched
  // sheet — a skip is "leave for later", never "silently discard".
  const saveAliases = useCallback(async (nextAliases) => {
    if (isMock) return
    const res = await fetch(`${BASE}/auto-deduct?action=save-aliases`, {
      method: 'POST',
      headers: authHeaders(getToken(), true),
      body: JSON.stringify({ aliases: nextAliases }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not save learned matches')
  }, [getToken, isMock])

  const handleResolve = useCallback((items, skipped = []) => {
    setResolvedExtras(items)
    setSkippedRows(skipped)
    const learned = {}
    for (const item of items) {
      if (!item._learnAlias || !item._source) continue
      const aliasValue = item._isCombo
        ? { components: item.components || [] }
        : {
          STYLE: item.STYLE,
          COLOR: item.COLOR,
          SIZE: item.SIZE,
          _isNew: !!item._isNew,
        }
      if (!item._isCombo || !item._source.size) {
        learned[aliasKey(item._source.style, item._source.color)] = {
          ...aliasValue,
          SIZE: undefined,
        }
      }
      learned[aliasKey(item._source.style, item._source.color, item._source.size)] = aliasValue
    }
    const learnedCount = items.filter((item) => item._learnAlias && item._source).length
    if (learnedCount) {
      const nextAliases = { ...aliases, ...learned }
      setAliases(nextAliases)
      saveAliases(nextAliases)
        .then(() => toast.success(`${learnedCount} match${learnedCount !== 1 ? 'es' : ''} remembered for next time`, 'Matches Saved'))
        .catch((err) => toast.error(err.message, 'Could Not Save Matches'))
    }
    if (items.length > 0 || skipped.length > 0) {
      const parts = []
      if (items.length)   parts.push(`${items.length} resolved`)
      if (skipped.length) parts.push(`${skipped.length} skipped (kept on Unmatched sheet)`)
      toast.success(parts.join(' · '), 'Ready to Download')
    }
  }, [aliases, saveAliases, toast])

  const handleDownload = useCallback(async () => {
    if (!result) return
    // Before the resolver runs: all unmatched rows. After: only the skipped ones
    // (linked/created rows are already merged into mergedFilledRows).
    const unmatchedSheet = resolvedExtras !== null ? skippedRows : result.unmatchedRows
    try {
      await generateExcel(mergedFilledRows, unmatchedSheet, srcFile?.name || 'output')
      toast.success('Excel downloaded')
    } catch (err) {
      toast.error(err.message, 'Download Failed')
    }
  }, [result, resolvedExtras, skippedRows, mergedFilledRows, srcFile, toast])

  const handleApply = useCallback(async () => {
    if (!mergedFilledRows.length || applying) return
    setApplying(true)
    try {
      const res = await fetch(`${BASE}/inventory-balance?action=apply`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({
          filledRows:  mergedFilledRows,
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
  }, [mergedFilledRows, txnType, srcFile, applying, getToken, toast])

  const stats            = result?.stats
  const hasUnresolved    = result?.unmatchedRows?.length > 0 && resolvedExtras === null

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

      {/* 第一步（可选）：原始导出 → consolidated CSV */}
      <ConsolidateStep />

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
          disabled={!isMock && (!srcFile || processing || templateMissing)}
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

          {/* Resolver — shown when there are unmatched rows and user hasn't resolved yet */}
          {hasUnresolved && (
            <UnmatchedResolver
              unmatchedRows={result.unmatchedRows}
              templateRows={templateRows}
              onDone={handleResolve}
            />
          )}

          {/* Actions — shown after resolver is done (or if no unmatched rows) */}
          {(!hasUnresolved) && (
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
          )}
        </>
      )}
    </div>
  )
}
