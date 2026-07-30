import React, { useState, useMemo, useCallback, useEffect, useTransition } from 'react'
import {
  Boxes, Search, Download, RefreshCw, CheckCircle, AlertTriangle, XCircle,
  TrendingUp, ChevronDown, ChevronUp, ServerCrash, Upload, X, FileUp,
  Pencil, Plus, Minus,
} from 'lucide-react'
import DataTable from '../components/DataTable.jsx'
import FileUploadZone from '../components/FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { useAuth } from '../context/AuthContext.jsx'
import { parseCSV } from '../utils/autoDeductEngine.js'

const BASE = '/api'
const MAX_SNAPSHOTS = 20

function authHeaders(token, json = false) {
  const h = { Authorization: `Bearer ${token}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function apiFetch(url, options = {}) {
  let res
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error('Cannot reach the inventory server. Check your connection.')
  }
  const json = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

/** Parse a CSV or XLSX file into an array of plain objects */
async function parseFileRows(file) {
  if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text()
    return parseCSV(text)
  }
  const XLSX = await import('xlsx')
  const buf  = await file.arrayBuffer()
  const wb   = XLSX.read(buf, { type: 'array' })
  const ws   = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(ws, { defval: '' })
}

/** Normalise a row from any case convention into {Style, Color, Size, Quantity} */
function normaliseRow(r) {
  return {
    Style:    String(r.Style    || r.style    || r.STYLE    || '').trim(),
    Color:    String(r.Color    || r.color    || r.COLOR    || '').trim(),
    Size:     String(r.Size     || r.size     || r.SIZE     || '').trim(),
    Quantity: parseInt(r.Quantity ?? r.quantity ?? r.QUANTITY ?? 0, 10) || 0,
  }
}

function rowColor(row) {
  const n = Number(row.Quantity)
  if (n <= 0) return 'bg-red-50/60'
  if (n < 5)  return 'bg-yellow-50/60'
  return ''
}

// ── Edit Quantity Modal ────────────────────────────────────────────────────────
function EditQtyModal({ row, onClose, onDone, getToken }) {
  const [qty,     setQty]     = useState(String(row.Quantity ?? 0))
  const [reason,  setReason]  = useState('')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handleSave = async () => {
    const n = Number(qty)
    if (!Number.isSafeInteger(n) || n < 0) {
      toast.error('Quantity must be a whole number of 0 or more')
      return
    }
    setLoading(true)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=edit&id=${row.id}`, {
        method:  'PATCH',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ quantity: n, reason }),
      })
      toast.success(
        `${row.Style} / ${row.Color} / ${row.Size}: ${data.old_quantity} → ${data.new_quantity}`,
        'Quantity Updated'
      )
      onDone({ id: row.id, quantity: Number(data.new_quantity) })
      onClose()
    } catch (err) {
      toast.error(err.message, 'Update Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center">
              <Pencil className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Edit Quantity</h3>
              <p className="text-xs text-slate-400 mt-0.5">{row.Style} · {row.Color} · {row.Size}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1.5">New Quantity</label>
          <input
            type="number"
            min="0"
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            className="input-base w-full text-lg font-semibold"
            autoFocus
          />
          <p className="text-xs text-slate-400 mt-1">Current: {row.Quantity}</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1.5">Reason / Remark (optional)</label>
          <input
            type="text"
            value={reason}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Example: Physical count correction"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <p className="mt-1.5 text-xs text-slate-400">The old value, new value, user, and remark will be kept in the audit history.</p>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1 justify-center py-2.5">Cancel</button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add Rows Modal ─────────────────────────────────────────────────────────────
function AddRowsModal({ onClose, onDone, currentRows, getToken }) {
  const [file,    setFile]    = useState(null)
  const [preview, setPreview] = useState(null)   // {to_add, already_exists}
  const [step,    setStep]    = useState('upload')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handlePreview = async () => {
    if (!file) return
    setLoading(true)
    try {
      const uploaded   = await parseFileRows(file)
      const balanceSet = new Set(currentRows.map(r => `${r.Style}|||${r.Color}|||${r.Size}`))
      const to_add        = []
      const already_exists = []

      for (const raw of uploaded) {
        const r = normaliseRow(raw)
        if (!r.Style || !r.Color || !r.Size) continue
        const key = `${r.Style}|||${r.Color}|||${r.Size}`
        if (balanceSet.has(key)) {
          const existing = currentRows.find(x => x.Style === r.Style && x.Color === r.Color && x.Size === r.Size)
          already_exists.push({ Style: r.Style, Color: r.Color, Size: r.Size, current_quantity: existing?.Quantity ?? 0 })
        } else {
          to_add.push({ Style: r.Style, Color: r.Color, Size: r.Size, Quantity: r.Quantity })
        }
      }
      setPreview({ to_add, already_exists })
      setStep('preview')
    } catch (err) {
      toast.error(err.message, 'Preview Failed')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirm = async () => {
    if (!preview?.to_add?.length) return
    setLoading(true)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=add-rows`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ rows: preview.to_add }),
      })
      toast.success(`Added ${data.added} new SKU${data.added !== 1 ? 's' : ''} to balance`, 'Rows Added')
      onDone()
      onClose()
    } catch (err) {
      toast.error(err.message, 'Add Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-100 rounded-xl flex items-center justify-center">
              <Plus className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Add Styles via CSV</h3>
              <p className="text-xs text-slate-400 mt-0.5">Append new SKUs without touching existing rows</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'upload' && (
          <>
            <div className="bg-slate-50 rounded-xl px-4 py-3 text-xs text-slate-500 space-y-1">
              <p className="font-medium text-slate-600">Required columns:</p>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {['Style', 'Color', 'Size', 'Quantity'].map((c) => (
                  <span key={c} className="bg-white border border-slate-200 px-2 py-0.5 rounded font-mono text-slate-700">{c}</span>
                ))}
              </div>
              <p className="mt-1.5">Only rows that don't already exist in the balance will be added.</p>
            </div>
            <FileUploadZone
              onFile={setFile} accept=".csv,.xlsx,.xls" acceptedTypes="CSV, XLSX"
              label="Drag & drop your new styles file" currentFile={file} onClear={() => setFile(null)}
            />
            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1 justify-center py-2.5">Cancel</button>
              <button onClick={handlePreview} disabled={!file || loading} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Preview
              </button>
            </div>
          </>
        )}

        {step === 'preview' && preview && (
          <>
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">
                <span className="text-green-600 font-bold">{preview.to_add.length}</span> new SKU{preview.to_add.length !== 1 ? 's' : ''} to add
              </p>
              {preview.to_add.length > 0 ? (
                <div className="border border-green-200 rounded-xl overflow-hidden max-h-44 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-green-50 text-green-700 sticky top-0">
                      <tr>{['Style','Color','Size','Quantity'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.to_add.map((r, i) => (
                        <tr key={i} className="border-t border-green-100">
                          <td className="px-3 py-1.5">{r.Style}</td>
                          <td className="px-3 py-1.5">{r.Color}</td>
                          <td className="px-3 py-1.5">{r.Size}</td>
                          <td className="px-3 py-1.5 font-semibold text-green-700">+{r.Quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-400 py-2">No new rows to add — all already exist.</p>
              )}
            </div>

            {preview.already_exists.length > 0 && (
              <div>
                <p className="text-sm font-medium text-slate-500 mb-2">
                  <span className="text-amber-600 font-bold">{preview.already_exists.length}</span> already in balance (skipped)
                </p>
                <div className="border border-amber-200 rounded-xl overflow-hidden max-h-32 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-amber-50 text-amber-700 sticky top-0">
                      <tr>{['Style','Color','Size','Current Qty'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.already_exists.map((r, i) => (
                        <tr key={i} className="border-t border-amber-100">
                          <td className="px-3 py-1.5">{r.Style}</td>
                          <td className="px-3 py-1.5">{r.Color}</td>
                          <td className="px-3 py-1.5">{r.Size}</td>
                          <td className="px-3 py-1.5 text-amber-700">{r.current_quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setStep('upload')} className="btn-secondary flex-1 justify-center py-2.5">Back</button>
              <button
                onClick={handleConfirm}
                disabled={loading || preview.to_add.length === 0}
                className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add {preview.to_add.length} Row{preview.to_add.length !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Remove Rows Modal ──────────────────────────────────────────────────────────
function RemoveRowsModal({ onClose, onDone, currentRows, getToken }) {
  const [file,    setFile]    = useState(null)
  const [preview, setPreview] = useState(null)   // {to_remove, not_found}
  const [step,    setStep]    = useState('upload')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handlePreview = async () => {
    if (!file) return
    setLoading(true)
    try {
      const uploaded   = await parseFileRows(file)
      const balanceMap = new Map(currentRows.map(r => [`${r.Style}|||${r.Color}|||${r.Size}`, r]))
      const to_remove = []
      const not_found  = []

      for (const raw of uploaded) {
        const r = normaliseRow(raw)
        if (!r.Style || !r.Color || !r.Size) continue
        const key   = `${r.Style}|||${r.Color}|||${r.Size}`
        const found = balanceMap.get(key)
        if (found) {
          to_remove.push(found) // already has id, Style, Color, Size, Quantity
        } else {
          not_found.push({ Style: r.Style, Color: r.Color, Size: r.Size })
        }
      }
      setPreview({ to_remove, not_found })
      setStep('preview')
    } catch (err) {
      toast.error(err.message, 'Preview Failed')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirm = async () => {
    if (!preview?.to_remove?.length) return
    if (!window.confirm(
      `Permanently remove ${preview.to_remove.length} SKU${preview.to_remove.length !== 1 ? 's' : ''} from the balance?\n\nA restore point will be saved first.`
    )) return
    setLoading(true)
    try {
      const ids  = preview.to_remove.map(r => r.id)
      const data = await apiFetch(`${BASE}/inventory-balance?action=remove-rows`, {
        method:  'DELETE',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ ids }),
      })
      toast.success(`Removed ${data.removed} SKU${data.removed !== 1 ? 's' : ''} from balance`, 'Rows Removed')
      onDone()
      onClose()
    } catch (err) {
      toast.error(err.message, 'Remove Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-red-100 rounded-xl flex items-center justify-center">
              <Minus className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Remove Styles via CSV</h3>
              <p className="text-xs text-slate-400 mt-0.5">Delete specific SKUs without affecting the rest</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'upload' && (
          <>
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>Matched rows will be <strong>permanently deleted</strong> from the balance. A restore point is saved automatically first.</p>
            </div>
            <div className="bg-slate-50 rounded-xl px-4 py-3 text-xs text-slate-500">
              <p className="font-medium text-slate-600 mb-1">Required columns:</p>
              <div className="flex gap-1.5">
                {['Style', 'Color', 'Size'].map((c) => (
                  <span key={c} className="bg-white border border-slate-200 px-2 py-0.5 rounded font-mono text-slate-700">{c}</span>
                ))}
              </div>
            </div>
            <FileUploadZone
              onFile={setFile} accept=".csv,.xlsx,.xls" acceptedTypes="CSV, XLSX"
              label="Drag & drop the styles to remove" currentFile={file} onClear={() => setFile(null)}
            />
            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1 justify-center py-2.5">Cancel</button>
              <button onClick={handlePreview} disabled={!file || loading} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Preview
              </button>
            </div>
          </>
        )}

        {step === 'preview' && preview && (
          <>
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">
                <span className="text-red-600 font-bold">{preview.to_remove.length}</span> SKU{preview.to_remove.length !== 1 ? 's' : ''} will be removed
              </p>
              {preview.to_remove.length > 0 ? (
                <div className="border border-red-200 rounded-xl overflow-hidden max-h-44 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-red-50 text-red-700 sticky top-0">
                      <tr>{['Style','Color','Size','Current Qty'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.to_remove.map((r, i) => (
                        <tr key={i} className="border-t border-red-100">
                          <td className="px-3 py-1.5">{r.Style}</td>
                          <td className="px-3 py-1.5">{r.Color}</td>
                          <td className="px-3 py-1.5">{r.Size}</td>
                          <td className="px-3 py-1.5 font-semibold text-red-700">{r.Quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-400 py-2">No matching rows found in the balance.</p>
              )}
            </div>

            {preview.not_found.length > 0 && (
              <div>
                <p className="text-sm font-medium text-slate-500 mb-2">
                  <span className="text-slate-500 font-bold">{preview.not_found.length}</span> not found in balance (skipped)
                </p>
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-28 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-600 sticky top-0">
                      <tr>{['Style','Color','Size'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.not_found.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 text-slate-400">{r.Style}</td>
                          <td className="px-3 py-1.5 text-slate-400">{r.Color}</td>
                          <td className="px-3 py-1.5 text-slate-400">{r.Size}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setStep('upload')} className="btn-secondary flex-1 justify-center py-2.5">Back</button>
              <button
                onClick={handleConfirm}
                disabled={loading || preview.to_remove.length === 0}
                className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors flex-1 justify-center disabled:opacity-50"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Minus className="w-4 h-4" />}
                Remove {preview.to_remove.length} Row{preview.to_remove.length !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon: Icon, iconBg, iconColor }) {
  return (
    <div className="card px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg}`}>
        <Icon className={`w-4 h-4 ${iconColor}`} />
      </div>
      <div>
        <p className="text-xl font-bold text-slate-800">{Number(value).toLocaleString()}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
    </div>
  )
}

// ── Version History (snapshots + transaction log) ─────────────────────────────
function VersionHistory({ onRestore, getToken }) {
  const [snapOpen,  setSnapOpen]  = useState(false)
  const [logOpen,   setLogOpen]   = useState(false)
  const [snapshots, setSnapshots] = useState([])
  const [log,       setLog]       = useState([])
  const [loadingS,  setLoadingS]  = useState(false)
  const [loadingL,  setLoadingL]  = useState(false)
  const [restoring, setRestoring] = useState(null)
  const toast = useToast()

  useEffect(() => {
    if (!snapOpen) return
    setLoadingS(true)
    apiFetch(`${BASE}/inventory-balance?action=history`, { headers: authHeaders(getToken()) })
      .then((d) => setSnapshots((d.snapshots || []).filter((snapshot) =>
        snapshot.label !== 'pre_restore' && snapshot.restorable !== false
      )))
      .catch(() => {})
      .finally(() => setLoadingS(false))
  }, [snapOpen, getToken])

  useEffect(() => {
    if (!logOpen) return
    setLoadingL(true)
    apiFetch(`${BASE}/inventory-balance?action=transactions`, { headers: authHeaders(getToken()) })
      .then((d) => setLog(d.transactions || []))
      .catch(() => {})
      .finally(() => setLoadingL(false))
  }, [logOpen, getToken])

  const handleRestore = async (snap) => {
    if (!window.confirm(
      `Restore balance to the snapshot from ${snap.timestamp}?\n\n` +
      `This will revert to ${snap.total_units.toLocaleString()} units across ${snap.total_rows.toLocaleString()} SKUs.`
    )) return

    setRestoring(snap.id)
    try {
      const res = await apiFetch(`${BASE}/inventory-balance?action=restore&id=${snap.id}`, {
        method:  'POST',
        headers: authHeaders(getToken()),
      })
      toast.success(
        `Restored to ${snap.timestamp} — ${res.total_units.toLocaleString()} units`,
        'Balance Restored'
      )
      onRestore()
      const d = await apiFetch(`${BASE}/inventory-balance?action=history`, { headers: authHeaders(getToken()) })
      setSnapshots((d.snapshots || []).filter((snapshot) =>
        snapshot.label !== 'pre_restore' && snapshot.restorable !== false
      ))
    } catch (err) {
      toast.error(err.message, 'Restore Failed')
    } finally {
      setRestoring(null)
    }
  }

  const labelColors = {
    sales:       'bg-orange-100 text-orange-700',
    return:      'bg-green-100 text-green-700',
    adjustment:  'bg-amber-100 text-amber-700',
    pre_init:    'bg-blue-100 text-blue-700',
    pre_reset:   'bg-red-100 text-red-700',
    pre_remove:  'bg-rose-100 text-rose-700',
  }

  return (
    <div className="space-y-3">
      {/* ── Snapshots (restorable) ── */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setSnapOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span>Version History</span>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-normal">
              last {snapshots.length || MAX_SNAPSHOTS} saves
            </span>
          </div>
          {snapOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>

        {snapOpen && (
          <div className="border-t border-slate-100 px-5 py-4">
            <p className="text-xs text-slate-400 mb-3">
              The last {MAX_SNAPSHOTS} balance states are saved automatically before every change. Click <strong>Restore</strong> to roll back.
            </p>

            {loadingS ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-2">
                <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : snapshots.length === 0 ? (
              <p className="text-sm text-slate-400">No snapshots yet — they appear after the first transaction.</p>
            ) : (
              <div className="space-y-2">
                {snapshots.map((snap, i) => (
                  <div key={snap.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-slate-50 last:border-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 text-xs font-bold text-slate-500">
                        {i + 1}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-sm font-medium text-slate-700">{snap.timestamp}</p>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium capitalize ${labelColors[snap.label] || 'bg-slate-100 text-slate-600'}`}>
                            {snap.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 truncate max-w-xs mt-0.5">
                          {snap.source_name || '—'} &nbsp;·&nbsp; {snap.total_units.toLocaleString()} units · {snap.total_rows.toLocaleString()} SKUs
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestore(snap)}
                      disabled={restoring === snap.id}
                      className="flex-shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {restoring === snap.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Transaction log (read-only audit trail) ── */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setLogOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <span>Transaction Log</span>
          {logOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>

        {logOpen && (
          <div className="border-t border-slate-100 px-5 py-4">
            {loadingL ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : log.length === 0 ? (
              <p className="text-sm text-slate-400">No transactions recorded yet.</p>
            ) : (
              <div className="space-y-1">
                {log.map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-slate-50 last:border-0">
                    <div className="flex items-center gap-2.5">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                        t.transaction_type === 'sales'
                          ? 'bg-orange-100 text-orange-600'
                          : t.transaction_type === 'return'
                            ? 'bg-green-100 text-green-600'
                            : 'bg-amber-100 text-amber-600'
                      }`}>
                        {t.transaction_type === 'sales'
                          ? <XCircle    className="w-3.5 h-3.5" />
                          : <TrendingUp className="w-3.5 h-3.5" />}
                      </span>
                      <div>
                        <p className="font-medium text-slate-700 truncate max-w-xs">{t.source_file}</p>
                        <p className="text-xs text-slate-400">{t.timestamp}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className={`font-semibold ${
                        t.transaction_type === 'sales'
                          ? 'text-orange-600'
                          : t.transaction_type === 'return'
                            ? 'text-green-600'
                            : 'text-amber-600'
                      }`}>
                        {t.transaction_type === 'sales' ? '−' : t.transaction_type === 'return' ? '+' : '±'}
                        {(t.applied_units || 0).toLocaleString()} units
                      </p>
                      <p className="text-xs text-slate-400 capitalize">{t.transaction_type}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Import / Update modal ─────────────────────────────────────────────────────
function ImportModal({ onClose, onDone, getToken }) {
  const [file,    setFile]    = useState(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handleImport = async () => {
    if (!file) return
    setLoading(true)
    try {
      const uploaded = await parseFileRows(file)
      const rows     = uploaded.map(normaliseRow).filter(r => r.Style && r.Color && r.Size)
      if (!rows.length) throw new Error('No valid rows found in file')

      const data = await apiFetch(`${BASE}/inventory-balance?action=init`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ rows, sourceName: file.name }),
      })
      toast.success(
        `Balance updated: ${data.total_rows.toLocaleString()} rows · ${data.total_units.toLocaleString()} units`,
        'Inventory Imported'
      )
      onDone()
      onClose()
    } catch (err) {
      toast.error(err.message, 'Import Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center">
              <FileUp className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Import Updated Inventory</h3>
              <p className="text-xs text-slate-400 mt-0.5">Replaces current balance with your file</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>
            This will <strong>replace</strong> the entire current balance with your file.
            Your current balance will be automatically saved as a restore point first.
          </p>
        </div>

        <div className="bg-slate-50 rounded-xl px-4 py-3 text-xs text-slate-500 space-y-1">
          <p className="font-medium text-slate-600">Required columns:</p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {['Style', 'Color', 'Size', 'Quantity'].map((col) => (
              <span key={col} className="bg-white border border-slate-200 px-2 py-0.5 rounded font-mono text-slate-700">
                {col}
              </span>
            ))}
          </div>
          <p className="mt-1.5">Accepts CSV or Excel. Column names are detected automatically.</p>
        </div>

        <FileUploadZone
          onFile={setFile} accept=".csv,.xlsx,.xls" acceptedTypes="CSV, XLSX"
          label="Drag & drop your updated inventory file" sublabel="or click to browse"
          currentFile={file} onClear={() => setFile(null)}
        />

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary flex-1 justify-center py-2.5">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Importing…</>
              : <><Upload className="w-4 h-4" /> Replace Balance</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Initialize panel ──────────────────────────────────────────────────────────
function InitializePanel({ onDone, getToken }) {
  const [file,    setFile]    = useState(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handleInit = async () => {
    if (!file) return
    setLoading(true)
    try {
      const uploaded = await parseFileRows(file)
      const rows     = uploaded.map(normaliseRow).filter(r => r.Style && r.Color && r.Size)
      if (!rows.length) throw new Error('No valid rows found in file')

      const data = await apiFetch(`${BASE}/inventory-balance?action=init`, {
        method:  'POST',
        headers: authHeaders(getToken(), true),
        body:    JSON.stringify({ rows, sourceName: file.name }),
      })
      toast.success(
        `Balance initialized: ${data.total_rows.toLocaleString()} rows · ${data.total_units.toLocaleString()} units`,
        'Balance Ready'
      )
      onDone()
    } catch (err) {
      toast.error(err.message, 'Init Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card p-6 border-2 border-dashed border-blue-200 bg-blue-50/40 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <Boxes className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800">Initialize Inventory Balance</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload a CSV or Excel file with <strong>Style, Color, Size, Quantity</strong> columns to set your starting stock levels.
            After that, every Auto Deduct transaction will update this balance in real time.
          </p>
        </div>
      </div>

      <FileUploadZone
        onFile={setFile} accept=".csv,.xlsx,.xls" acceptedTypes="CSV, XLSX"
        label="Drag & drop initial inventory file"
        currentFile={file} onClear={() => setFile(null)}
      />

      <button
        onClick={handleInit}
        disabled={!file || loading}
        className="btn-primary w-full justify-center py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading
          ? <><RefreshCw className="w-4 h-4 animate-spin" /> Initializing…</>
          : <><Upload className="w-4 h-4" /> Set as Starting Balance</>}
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function StockManagement() {
  const { getToken } = useAuth()
  const [balanceData,    setBalanceData]    = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [inputValue,     setInputValue]     = useState('')
  const [searchQuery,    setSearchQuery]    = useState('')
  const [filter,         setFilter]         = useState('all')  // all | low | zero
  const [isPending,      startTransition]   = useTransition()
  const [serverError,    setServerError]    = useState(null)
  const [resetting,      setResetting]      = useState(false)
  const [showImport,     setShowImport]     = useState(false)
  const [showAddRows,    setShowAddRows]    = useState(false)
  const [showRemoveRows, setShowRemoveRows] = useState(false)
  const [editTarget,     setEditTarget]     = useState(null)
  const toast = useToast()

  const COLUMNS = useMemo(() => [
    { key: 'Style',    label: 'Style',    sortable: true },
    { key: 'Color',    label: 'Color',    sortable: true },
    { key: 'Size',     label: 'Size',     sortable: true },
    {
      key: 'Quantity',
      label: 'Quantity',
      sortable: true,
      render: (val, row) => {
        const n    = Number(val)
        const cls  = n <= 0 ? 'text-red-600' : n < 5 ? 'text-yellow-600' : 'text-green-600'
        const Icon = n <= 0 ? XCircle : n < 5 ? AlertTriangle : CheckCircle
        return (
          <span className="inline-flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 font-semibold ${cls}`}>
              <Icon className="w-3.5 h-3.5" />
              {n}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setEditTarget(row) }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-all"
              title="Edit quantity"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </span>
        )
      },
    },
  ], [])

  const loadBalance = useCallback(async () => {
    setLoading(true)
    setServerError(null)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=list`, {
        headers: authHeaders(getToken()),
      })
      setBalanceData(data)
    } catch (err) {
      setServerError(err.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { loadBalance() }, [loadBalance])

  const handleQuantityUpdated = useCallback(({ id, quantity }) => {
    setBalanceData((current) => {
      if (!current?.rows) return current

      const rows = current.rows.map((row) =>
        row.id === id ? { ...row, Quantity: quantity } : row
      )

      return {
        ...current,
        rows,
        total_units: rows.reduce((sum, row) => sum + (Number(row.Quantity) || 0), 0),
        skus_in_stock: rows.filter((row) => Number(row.Quantity) > 0).length,
        skus_zero: rows.filter((row) => Number(row.Quantity) <= 0).length,
      }
    })
  }, [])

  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset all quantities to zero? This cannot be undone.')) return
    setResetting(true)
    try {
      await apiFetch(`${BASE}/inventory-balance?action=reset`, {
        method:  'POST',
        headers: authHeaders(getToken()),
      })
      toast.info('All quantities reset to zero')
      loadBalance()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setResetting(false)
    }
  }, [getToken, toast, loadBalance])

  const allRows = balanceData?.rows || []

  const displayRows = useMemo(() => {
    let rows = allRows
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      rows = rows.filter(r =>
        (r.Style || '').toLowerCase().includes(q) ||
        (r.Color || '').toLowerCase().includes(q) ||
        (r.Size  || '').toLowerCase().includes(q)
      )
    }
    if (filter === 'low')  rows = rows.filter(r => Number(r.Quantity) > 0 && Number(r.Quantity) < 5)
    if (filter === 'zero') rows = rows.filter(r => Number(r.Quantity) <= 0)
    return rows
  }, [allRows, searchQuery, filter])

  const handleExport = useCallback(() => {
    if (!displayRows.length) return
    const header = 'Style,Color,Size,Quantity\n'
    const body   = displayRows.map(r =>
      [r.Style, r.Color, r.Size, r.Quantity].map(v => `"${v ?? ''}"`).join(',')
    ).join('\n')
    const blob = new Blob([header + body], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `inventory_balance_${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${displayRows.length.toLocaleString()} rows`)
  }, [displayRows, toast])

  // ── Render states ──────────────────────────────────────────────────────────
  if (serverError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <h2 className="text-xl font-bold text-slate-800">Stock Management</h2>
        <div className="card p-6 flex items-start gap-3 text-red-700 bg-red-50">
          <ServerCrash className="w-6 h-6 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Could not load inventory</p>
            <p className="text-sm text-red-500 mt-1">{serverError}</p>
            <button onClick={loadBalance} className="btn-secondary text-sm mt-3">
              <RefreshCw className="w-4 h-4" />
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-slate-400 py-16 justify-center">
        <RefreshCw className="w-5 h-5 animate-spin" />
        Loading balance…
      </div>
    )
  }

  const initialized = balanceData?.initialized

  return (
    <div className="space-y-6 max-w-7xl">
      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} onDone={loadBalance} getToken={getToken} />
      )}
      {showAddRows && (
        <AddRowsModal onClose={() => setShowAddRows(false)} onDone={loadBalance} currentRows={allRows} getToken={getToken} />
      )}
      {showRemoveRows && (
        <RemoveRowsModal onClose={() => setShowRemoveRows(false)} onDone={loadBalance} currentRows={allRows} getToken={getToken} />
      )}
      {editTarget && (
        <EditQtyModal
          row={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={handleQuantityUpdated}
          getToken={getToken}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-800">Stock Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Real-time inventory balance — updated every time you run Auto Deduct
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowImport(true)} className="btn-secondary text-sm">
            <FileUp className="w-4 h-4" />
            Import Update
          </button>
          {initialized && (
            <>
              <button onClick={() => setShowAddRows(true)} className="btn-secondary text-sm">
                <Plus className="w-4 h-4" />
                Add Styles
              </button>
              <button onClick={() => setShowRemoveRows(true)} className="btn-secondary text-sm">
                <Minus className="w-4 h-4" />
                Remove Styles
              </button>
              <button onClick={handleReset} disabled={resetting} className="btn-secondary text-sm disabled:opacity-50">
                {resetting ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                Reset to Zero
              </button>
              <button onClick={loadBalance} className="btn-secondary text-sm">
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
              <button onClick={handleExport} className="btn-primary text-sm">
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            </>
          )}
        </div>
      </div>

      {/* Not initialized → show init panel */}
      {!initialized ? (
        <InitializePanel onDone={loadBalance} getToken={getToken} />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="Total Units"     value={balanceData.total_units}
              icon={Boxes}            iconBg="bg-blue-100"   iconColor="text-blue-600"
            />
            <StatCard
              label="SKUs with Stock" value={balanceData.skus_in_stock}
              icon={CheckCircle}      iconBg="bg-green-100"  iconColor="text-green-600"
            />
            <StatCard
              label="Low Stock (< 5)"
              value={allRows.filter(r => Number(r.Quantity) > 0 && Number(r.Quantity) < 5).length}
              icon={AlertTriangle}    iconBg="bg-yellow-100" iconColor="text-yellow-600"
            />
            <StatCard
              label="Out of Stock"    value={balanceData.skus_zero}
              icon={XCircle}          iconBg="bg-red-100"    iconColor="text-red-600"
            />
          </div>

          {/* Search + filter */}
          <div className="card p-5 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by Style, Color or Size…"
                  value={inputValue}
                  onChange={(e) => {
                    const v = e.target.value
                    setInputValue(v)
                    startTransition(() => setSearchQuery(v))
                  }}
                  className="input-base pl-9"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl flex-shrink-0">
                {[
                  { id: 'all',  label: 'All' },
                  { id: 'low',  label: 'Low (< 5)' },
                  { id: 'zero', label: 'Out of Stock' },
                ].map(({ id, label }) => (
                  <button key={id} onClick={() => setFilter(id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      filter === id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {(inputValue || filter !== 'all') && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
                  {isPending ? '…' : `${displayRows.length.toLocaleString()} results`}
                </span>
                <button
                  onClick={() => { setInputValue(''); startTransition(() => setSearchQuery('')); setFilter('all') }}
                  className="text-slate-400 hover:text-slate-600"
                >
                  Clear filters
                </button>
              </div>
            )}

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-200" />Out of stock (≤ 0)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-yellow-200" />Low stock (&lt; 5)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-100" />In stock (≥ 5)</span>
            </div>

            <DataTable
              data={displayRows}
              columns={COLUMNS}
              pageSize={50}
              resetPageKey={`${searchQuery}\u0000${filter}`}
              rowClassName={rowColor}
              emptyMessage={
                searchQuery || filter !== 'all'
                  ? 'No rows match the current filters'
                  : 'No balance data'
              }
            />
          </div>

          {/* Version history + transaction log */}
          <VersionHistory onRestore={loadBalance} getToken={getToken} />
        </>
      )}
    </div>
  )
}
