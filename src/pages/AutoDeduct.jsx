import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Minus, TrendingUp, RefreshCw, FileDown,
  CheckCircle, AlertTriangle, Settings, X, Upload, AlertCircle, History,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import UnmatchedResolver from '../components/UnmatchedResolver.jsx'
import { useToast } from '../hooks/useToast.js'
import { useAuth } from '../context/AuthContext.jsx'
import { parseCSV, fillTemplate, generateExcel, aliasKey, normalizeStyleIdentity } from '../utils/autoDeductEngine.js'
import ConsolidateStep from '../components/ConsolidateStep.jsx'
import { consolidateRows } from '../utils/consolidateEngine.js'

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
  const [sourceHash,      setSourceHash]      = useState('')
  const [editingResolutions, setEditingResolutions] = useState(false)
  const [resolutionAliasKeys, setResolutionAliasKeys] = useState([])
  const [previewConfirmed, setPreviewConfirmed] = useState(false)
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
          const multiplier = Math.max(1, parseInt(component.multiplier, 10) || 1)
          const componentQty = extra.QTY * multiplier
          if (found) found.QTY = (found.QTY || 0) + componentQty
          else rows.push({ STYLE: component.STYLE, COLOR: component.COLOR, SIZE: component.SIZE, QTY: componentQty })
        }
        continue
      }
      if (extra._isNew) {
        rows.push({ STYLE: extra.STYLE, COLOR: extra.COLOR, SIZE: extra.SIZE, QTY: extra.QTY, allowCreate: true })
      } else {
        const found = rows.find(r => r.STYLE === extra.STYLE && r.COLOR === extra.COLOR && r.SIZE === extra.SIZE)
        if (found) found.QTY = (found.QTY || 0) + extra.QTY
        else rows.push({ STYLE: extra.STYLE, COLOR: extra.COLOR, SIZE: extra.SIZE, QTY: extra.QTY })
      }
    }
    return rows
  }, [result, resolvedExtras])

  const deductionPreview = useMemo(() => {
    const preview = (result?.matchLog || []).map((match) => ({
      sourceStyle: match.style,
      sourceColor: match.salesColor,
      sourceSize: match.size,
      targetStyle: match.targetStyle,
      targetColor: match.targetColor,
      targetSize: match.targetSize,
      qty: match.qty,
      via: match.via,
    }))
    for (const extra of resolvedExtras || []) {
      if (extra._isCombo && Array.isArray(extra.components)) {
        for (const component of extra.components) {
          preview.push({
            sourceStyle: extra._source?.style,
            sourceColor: extra._source?.color,
            sourceSize: extra._source?.size,
            targetStyle: component.STYLE,
            targetColor: component.COLOR,
            targetSize: component.SIZE,
            qty: extra.QTY * Math.max(1, parseInt(component.multiplier, 10) || 1),
            via: 'manual combo',
          })
        }
      } else {
        preview.push({
          sourceStyle: extra._source?.style,
          sourceColor: extra._source?.color,
          sourceSize: extra._source?.size,
          targetStyle: extra.STYLE,
          targetColor: extra.COLOR,
          targetSize: extra.SIZE,
          qty: extra.QTY,
          via: extra._isNew ? 'manual new' : 'manual',
        })
      }
    }
    return preview
  }, [result, resolvedExtras])

  const hasCrossStylePreview = deductionPreview.some((item) =>
    normalizeStyleIdentity(item.sourceStyle) !== normalizeStyleIdentity(item.targetStyle)
  )

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
    setSrcFile(file); setResult(null); setApplied(false); setResolvedExtras(null); setSkippedRows([]); setSourceHash(''); setEditingResolutions(false); setResolutionAliasKeys([]); setPreviewConfirmed(false)
  }, [])

  const handleRun = useCallback(async () => {
    if (isMock) {
      setResult(MOCK_RESULT)
      setTemplateRows(MOCK_TEMPLATE)
      setApplied(false); setResolvedExtras(null); setSkippedRows([]); setEditingResolutions(false); setResolutionAliasKeys([]); setPreviewConfirmed(false)
      toast.info('3 rows need review', 'Mock Run Complete')
      return
    }
    if (!srcFile || processing) return
    setProcessing(true); setResult(null); setApplied(false); setResolvedExtras(null); setSkippedRows([]); setEditingResolutions(false); setResolutionAliasKeys([]); setPreviewConfirmed(false)
    try {
      // 1. Fetch template from inventory balance (canonical SKU list)
      const tRes  = await fetch(`${BASE}/inventory-balance?action=list`, { headers: authHeaders(getToken()) })
      const tData = await tRes.json()
      if (!tRes.ok) throw new Error(tData.error || 'Could not load inventory balance')
      const tRows = (tData.rows || []).map(r => ({ STYLE: r.Style, COLOR: r.Color, SIZE: r.Size }))
      setTemplateRows(tRows)

      // 2. Parse either a consolidated CSV or a raw TEMU workbook.
      const bytes = await srcFile.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      setSourceHash([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''))

      let salesRows
      if (/\.csv$/i.test(srcFile.name)) {
        salesRows = parseCSV(new TextDecoder().decode(bytes))
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(bytes, { type: 'array' })
        const sheetName = wb.SheetNames.find(name => name.trim().toUpperCase() === 'TEMU-STYLES') || wb.SheetNames[0]
        const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: false, defval: '' })
        salesRows = consolidateRows(rawRows).consolidated
      }

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
    setEditingResolutions(false)
    setPreviewConfirmed(false)
    const learned = {}
    for (const item of items) {
      if (!item._learnAlias || !item._source) continue
      // A simple human-confirmed link is stable at style+color level. Future
      // sizes reuse it only when the exact target size exists in inventory.
      if (item._isCombo) continue
      const aliasValue = {
          STYLE: item.STYLE,
          COLOR: item.COLOR,
          _isNew: !!item._isNew,
          _confirmed: true,
        }
      if (item._isNew) {
        learned[aliasKey(item._source.style, item._source.color, item._source.size)] = {
          ...aliasValue,
          SIZE: item.SIZE,
        }
      } else {
        learned[aliasKey(item._source.style, item._source.color)] = aliasValue
      }
    }
    const learnedCount = Object.keys(learned).length
    if (learnedCount || resolutionAliasKeys.length) {
      const nextAliases = { ...aliases }
      for (const key of resolutionAliasKeys) delete nextAliases[key]
      for (const [key, value] of Object.entries(learned)) {
        if (value._isNew || value.SIZE) continue
        for (const existingKey of Object.keys(nextAliases)) {
          if (existingKey.startsWith(`${key}::`)) delete nextAliases[existingKey]
        }
      }
      Object.assign(nextAliases, learned)
      setAliases(nextAliases)
      setResolutionAliasKeys(Object.keys(learned))
      saveAliases(nextAliases)
        .then(() => toast.success(
          learnedCount
            ? `${learnedCount} match${learnedCount !== 1 ? 'es' : ''} remembered for next time`
            : 'Previous draft matches removed',
          'Matches Saved'
        ))
        .catch((err) => toast.error(err.message, 'Could Not Save Matches'))
    }
    if (items.length > 0 || skipped.length > 0) {
      const parts = []
      if (items.length)   parts.push(`${items.length} resolved`)
      if (skipped.length) parts.push(`${skipped.length} skipped (kept on Unmatched sheet)`)
      toast.success(parts.join(' · '), 'Ready to Download')
    }
  }, [aliases, resolutionAliasKeys, saveAliases, toast])

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
    if (!previewConfirmed) {
      toast.error('Review the source-to-inventory preview and confirm it before applying.', 'Review Required')
      return
    }
    setApplying(true)
    try {
      const res = await fetch(`${BASE}/inventory-balance?action=apply`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({
          filledRows:  mergedFilledRows,
          txnType,
          sourceName:  srcFile?.name || '',
          sourceHash,
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
  }, [mergedFilledRows, txnType, srcFile, sourceHash, applying, getToken, previewConfirmed, toast])

  const stats            = result?.stats
  const hasUnresolved    = result?.unmatchedRows?.length > 0 && resolvedExtras === null
  const hasReviewRows    = result?.unmatchedRows?.length > 0
  const showResolver     = hasReviewRows && (hasUnresolved || editingResolutions)

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
            Strict mode: only exact or previously confirmed matches are automatic; everything else requires your choice
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/auto-deduct/history" className="btn-secondary text-sm">
            <History className="w-4 h-4" />
            History
          </Link>
          <button onClick={() => setShowSettings(true)} className="btn-secondary text-sm">
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </div>
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
            <button key={id} onClick={() => { setTxnType(id); setPreviewConfirmed(false) }}
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
          accept=".csv,.xlsx,.xls"
          acceptedTypes="CSV, XLSX"
          label="Drag & drop TEMU order / consolidated file here"
          sublabel="TEMU-STYLES is selected automatically"
          currentFile={srcFile}
          onClear={() => { setSrcFile(null); setResult(null); setApplied(false); setPreviewConfirmed(false) }}
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
            <StatCard label={stats.has_unknown_unit_counts ? 'Known Units (minimum)' : 'Source Total'} value={stats.src_total} color="slate" />
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

          {stats.has_unknown_unit_counts && (
            <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p>Some set contents are not confirmed, so this is only the known minimum. Those rows must be completed in the review section before their units can be deducted.</p>
            </div>
          )}

          {/* Resolver — shown when there are unmatched rows and user hasn't resolved yet */}
          {hasReviewRows && (
            <div className={showResolver ? '' : 'hidden'}>
              <UnmatchedResolver
                unmatchedRows={result.unmatchedRows}
                templateRows={templateRows}
                onDone={handleResolve}
              />
            </div>
          )}

          {/* Actions — shown after resolver is done (or if no unmatched rows) */}
          {(!hasUnresolved && !editingResolutions) && (
          <div className="card p-5 space-y-3">
            <h3 className="font-medium text-slate-700 text-sm">Actions</h3>

            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Inventory units to {txnType === 'sales' ? 'deduct' : 'add back'}: <strong className="text-slate-800">{mergedFilledRows.reduce((sum, row) => sum + (Number(row.QTY) || 0), 0).toLocaleString()}</strong>
              {skippedRows.length > 0 && <span className="ml-2 text-amber-600">· {skippedRows.length} skipped row(s) will not be applied</span>}
            </div>

            <details defaultOpen={hasCrossStylePreview} className="overflow-hidden rounded-xl border border-slate-200">
              <summary className="cursor-pointer bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                Review source → inventory targets ({deductionPreview.length.toLocaleString()} mappings)
              </summary>
              <div className="max-h-80 overflow-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="sticky top-0 bg-white text-slate-400">
                    <tr className="border-b border-slate-100">
                      <th className="px-3 py-2 font-semibold">Source</th>
                      <th className="px-3 py-2 font-semibold">Inventory target</th>
                      <th className="px-3 py-2 text-right font-semibold">Qty</th>
                      <th className="px-3 py-2 font-semibold">Method</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {deductionPreview.map((item, index) => {
                      const sourceStyle = normalizeStyleIdentity(item.sourceStyle)
                      const targetStyle = normalizeStyleIdentity(item.targetStyle)
                      const crossStyle = sourceStyle !== targetStyle
                      return (
                        <tr key={`${index}-${item.sourceStyle}-${item.sourceColor}-${item.sourceSize}`} className={crossStyle ? 'bg-red-50' : ''}>
                          <td className="px-3 py-2 text-slate-600">
                            <span className="font-mono font-semibold text-slate-800">{item.sourceStyle || '—'}</span>
                            <span className="mx-1 text-slate-300">/</span>{item.sourceColor || '—'}
                            <span className="mx-1 text-slate-300">/</span>{item.sourceSize || '—'}
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            <span className="font-mono font-semibold text-slate-800">{item.targetStyle || '—'}</span>
                            <span className="mx-1 text-slate-300">/</span>{item.targetColor || '—'}
                            <span className="mx-1 text-slate-300">/</span>{item.targetSize || '—'}
                            {crossStyle && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 font-bold text-red-700">Cross-style</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-800">{Number(item.qty || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-slate-500">{item.via}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {hasCrossStylePreview && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                Cross-style manual links are highlighted above. Confirm that every target style is intentional before applying.
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
              <input
                type="checkbox"
                checked={previewConfirmed}
                onChange={(event) => setPreviewConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-indigo-300 text-indigo-600"
              />
              <span>I reviewed the target style, color, size, and quantity for these mappings.</span>
            </label>

            {hasReviewRows && !applied && (
              <button onClick={() => { setEditingResolutions(true); setPreviewConfirmed(false) }} className="btn-secondary w-full justify-center py-2.5">
                Review / Edit Resolutions
              </button>
            )}

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
                disabled={applying || !previewConfirmed}
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
