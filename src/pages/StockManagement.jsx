import React, { useState, useMemo, useCallback, useEffect, useTransition } from 'react'
import {
  Boxes, Search, Download, RefreshCw, CheckCircle, AlertTriangle, XCircle,
  TrendingUp, ChevronDown, ChevronUp, ServerCrash, Upload, X, FileUp,
  Pencil, Plus, Minus, Save,
} from 'lucide-react'
import DailyStyleReport from '../components/DailyStyleReport.jsx'
import FileUploadZone from '../components/FileUploadZone.jsx'
import ReplenishmentPlan from '../components/ReplenishmentPlan.jsx'
import OversoldManagement from '../components/OversoldManagement.jsx'
import { useToast } from '../hooks/useToast.js'
import { useAuth } from '../context/AuthContext.jsx'
import { parseCSV } from '../utils/autoDeductEngine.js'
import { inventoryRestoreMode } from '../utils/inventoryRestoreMode.js'
import { compareInventorySizes } from '../utils/inventorySizeSort.js'

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
function inventoryKey(row) {
  const size = String(row.Size || '').trim().toUpperCase().replace(/^([123])XL$/, '$1X')
  return [row.Style, row.Color, size].map((value) => String(value || '').trim().toLowerCase()).join('|||')
}

function normaliseRow(r, index = 0) {
  const row = {
    Style: String(r.Style ?? r.style ?? r.STYLE ?? '').trim(),
    Color: String(r.Color ?? r.color ?? r.COLOR ?? '').trim(),
    Size: String(r.Size ?? r.size ?? r.SIZE ?? '').trim(),
  }
  if (!row.Style || !row.Color || !row.Size) {
    throw new Error(`Excel row ${index + 2} requires Style, Color, and Size`)
  }
  const rawQuantity = r.Quantity ?? r.quantity ?? r.QUANTITY ?? 0
  const quantity = rawQuantity === '' ? 0 : Number(rawQuantity)
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error(`Excel row ${index + 2}: Quantity must be a whole number of 0 or more`)
  }
  return { ...row, Quantity: quantity }
}

function rowColor(row) {
  const n = Number(row.Quantity)
  if (n <= 0) return 'bg-red-50/60'
  if (n < 5)  return 'bg-yellow-50/60'
  return ''
}

function nextBlankInventoryRow() {
  return { key: `${Date.now()}-${Math.random()}`, Style: '', Color: '', Size: '', Quantity: '0' }
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

// ── Bulk Edit Quantity Modal ───────────────────────────────────────
function BulkEditQtyModal({ rows, onClose, onDone, getToken }) {
  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(rows.map((row) => [row.id, String(row.Quantity ?? 0)]))
  )
  const [setAllValue, setSetAllValue] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const changedRows = rows.filter((row) => String(row.Quantity ?? 0) !== quantities[row.id])

  const applyToAll = () => {
    const value = Number(setAllValue)
    if (setAllValue.trim() === '' || !Number.isSafeInteger(value) || value < 0) {
      toast.error('Quantity must be a whole number of 0 or more')
      return
    }
    setQuantities(Object.fromEntries(rows.map((row) => [row.id, String(value)])))
  }

  const handlePaste = (event, startIndex) => {
    const values = event.clipboardData.getData('text')
      .split(/[\t\r\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (values.length <= 1) return
    if (values.some((value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0)) {
      event.preventDefault()
      toast.error('The pasted quantity column contains an invalid value')
      return
    }
    event.preventDefault()
    setQuantities((current) => {
      const next = { ...current }
      values.forEach((value, offset) => {
        const row = rows[startIndex + offset]
        if (row) next[row.id] = value
      })
      return next
    })
  }

  const handleSave = async () => {
    const updates = changedRows.map((row) => ({ id: row.id, quantity: Number(quantities[row.id]) }))
    if (changedRows.some((row) => quantities[row.id].trim() === '') ||
        updates.some(({ quantity }) => !Number.isSafeInteger(quantity) || quantity < 0)) {
      toast.error('Every quantity must be a whole number of 0 or more')
      return
    }
    if (!updates.length) return
    setLoading(true)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=bulk-edit`, {
        method: 'PATCH',
        headers: authHeaders(getToken(), true),
        body: JSON.stringify({ updates, reason }),
      })
      toast.success(`Updated ${data.updated} SKUs`, 'Bulk Update Saved')
      onDone(data.rows || updates)
      onClose()
    } catch (err) {
      toast.error(err.message, 'Bulk Update Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 space-y-4 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-800">Bulk Edit Inventory</h3>
            <p className="text-xs text-slate-400 mt-1">
              Edit like a spreadsheet. Copy one quantity column from Excel and paste it into the first quantity cell.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 rounded-xl bg-blue-50 border border-blue-100 p-3">
          <input
            type="number"
            min="0"
            step="1"
            value={setAllValue}
            onChange={(event) => setSetAllValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && applyToAll()}
            placeholder="Set one quantity for all selected"
            className="input-base flex-1 bg-white"
          />
          <button onClick={applyToAll} className="btn-secondary justify-center whitespace-nowrap">Apply to all</button>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-200 flex-1 min-h-0">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2.5 text-left">Style</th>
                <th className="px-3 py-2.5 text-left">Color</th>
                <th className="px-3 py-2.5 text-left">Size</th>
                <th className="px-3 py-2.5 text-right">Current</th>
                <th className="px-3 py-2.5 text-left w-36">New Quantity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => {
                const changed = String(row.Quantity ?? 0) !== quantities[row.id]
                return (
                  <tr key={row.id} className={changed ? 'bg-blue-50/60' : ''}>
                    <td className="px-3 py-2 font-medium text-slate-700">{row.Style}</td>
                    <td className="px-3 py-2 text-slate-600">{row.Color}</td>
                    <td className="px-3 py-2 text-slate-600">{row.Size}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{row.Quantity}</td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={quantities[row.id]}
                        onChange={(event) => setQuantities((current) => ({ ...current, [row.id]: event.target.value }))}
                        onPaste={(event) => handlePaste(event, index)}
                        className={`w-full rounded-md border px-2 py-1.5 font-semibold outline-none focus:ring-2 focus:ring-blue-100 ${
                          changed ? 'border-blue-400 text-blue-700' : 'border-slate-200 text-slate-700'
                        }`}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
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
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">{changedRows.length} of {rows.length} selected SKUs changed</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary justify-center py-2.5">Cancel</button>
            <button
              onClick={handleSave}
              disabled={loading || changedRows.length === 0}
              className="btn-primary justify-center py-2.5 disabled:opacity-50"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Save {changedRows.length} Change{changedRows.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function InventorySpreadsheet({ rows, drafts, onChange }) {
  const [page, setPage] = useState(0)
  const [adjustmentAmount, setAdjustmentAmount] = useState('1')
  const pageSize = 100
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const visibleRows = rows.slice(page * pageSize, (page + 1) * pageSize)

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1))
  }, [totalPages])

  const quantityValue = (row) => drafts[row.id] ?? String(row.Quantity ?? 0)

  const adjustment = Number(adjustmentAmount)
  const validAdjustment = Number.isSafeInteger(adjustment) && adjustment > 0

  const changeBy = (row, direction) => {
    const current = Number(quantityValue(row))
    if (!Number.isSafeInteger(current) || !validAdjustment) return
    const next = current + (direction * adjustment)
    if (next < 0) return
    onChange(row, String(next))
  }

  const handlePaste = (event, startIndex) => {
    const values = event.clipboardData.getData('text')
      .split(/[\t\r\n]+/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
    if (values.length <= 1) return
    if (values.some((value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0)) return
    event.preventDefault()
    values.forEach((value, offset) => {
      const row = visibleRows[startIndex + offset]
      if (row) onChange(row, value)
    })
  }

  const focusNext = (event, index) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const inputs = event.currentTarget.closest('tbody')?.querySelectorAll('[data-inventory-quantity]')
    inputs?.[index + 1]?.focus()
    inputs?.[index + 1]?.select()
  }

  if (!rows.length) {
    return <div className="py-16 text-center text-sm text-slate-400">No rows match the current filters</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-sm sm:flex-row sm:items-center">
        <label htmlFor="inventory-adjustment-amount" className="font-semibold text-blue-900">Adjust by / 增减数量</label>
        <input
          id="inventory-adjustment-amount"
          type="number"
          min="1"
          step="1"
          value={adjustmentAmount}
          onChange={(event) => setAdjustmentAmount(event.target.value)}
          className={`h-8 w-28 rounded-md border bg-white px-2 font-semibold outline-none focus:ring-2 focus:ring-blue-200 ${validAdjustment ? 'border-blue-200 text-blue-900' : 'border-red-300 text-red-700'}`}
        />
        <span className="text-xs text-blue-700">
          Set this to 200, then use − / + beside any size to subtract or add 200. Type in the Quantity cell to set an exact total.
        </span>
      </div>
      <div className="max-h-[68vh] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="sticky top-0 z-20 bg-slate-100 text-xs uppercase tracking-wide text-slate-500 shadow-sm">
            <tr>
              <th className="sticky left-0 z-30 w-48 border-b border-r border-slate-200 bg-slate-100 px-3 py-2.5 text-left">Style</th>
              <th className="sticky left-48 z-30 w-56 border-b border-r border-slate-200 bg-slate-100 px-3 py-2.5 text-left">Color</th>
              <th className="w-28 border-b border-r border-slate-200 px-3 py-2.5 text-left">Size</th>
              <th className="w-64 border-b border-slate-200 px-3 py-2.5 text-left">Quantity</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => {
              const value = quantityValue(row)
              const changed = value !== String(row.Quantity ?? 0)
              const quantity = Number(value)
              const status = quantity <= 0 ? 'Out' : quantity < 5 ? 'Low' : 'In stock'
              return (
                <tr key={row.id} className={changed ? 'bg-amber-50' : rowColor(row)}>
                  <td className={`sticky left-0 z-10 border-b border-r border-slate-200 px-3 py-2 font-semibold text-slate-800 ${changed ? 'bg-amber-50' : 'bg-white'}`}>{row.Style}</td>
                  <td className={`sticky left-48 z-10 border-b border-r border-slate-200 px-3 py-2 text-slate-600 ${changed ? 'bg-amber-50' : 'bg-white'}`}>{row.Color}</td>
                  <td className="border-b border-r border-slate-200 px-3 py-2 font-medium text-slate-700">{row.Size}</td>
                  <td className="border-b border-slate-200 px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => changeBy(row, -1)}
                        disabled={!validAdjustment || !Number.isSafeInteger(quantity) || quantity - adjustment < 0}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label={`Subtract ${validAdjustment ? adjustment : 'adjustment'} from ${row.Style} ${row.Color} ${row.Size}`}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <input
                        data-inventory-quantity
                        type="number"
                        min="0"
                        step="1"
                        value={value}
                        onChange={(event) => onChange(row, event.target.value)}
                        onPaste={(event) => handlePaste(event, index)}
                        onKeyDown={(event) => focusNext(event, index)}
                        className={`h-8 w-24 rounded-md border px-2 text-center font-semibold outline-none focus:ring-2 focus:ring-blue-100 ${
                          changed ? 'border-amber-400 bg-white text-amber-800' : 'border-slate-200 bg-white text-slate-800'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => changeBy(row, 1)}
                        disabled={!validAdjustment || !Number.isSafeInteger(quantity) || quantity + adjustment < 0}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label={`Add ${validAdjustment ? adjustment : 'adjustment'} to ${row.Style} ${row.Color} ${row.Size}`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      {changed && <span className="ml-1 text-xs font-medium text-amber-700">was {row.Quantity}</span>}
                    </div>
                  </td>
                  <td className={`border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold ${
                    quantity <= 0 ? 'text-red-600' : quantity < 5 ? 'text-amber-600' : 'text-emerald-600'
                  }`}>{status}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
        <span>
          Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, rows.length)} of {rows.length.toLocaleString()} rows
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">Previous</button>
            <span>Page {page + 1} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((value) => value + 1)} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">Next</button>
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewInventoryChangesModal({ changes, onClose, onSave, saving }) {
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900">Review Inventory Changes</h3>
            <p className="mt-1 text-sm text-slate-500">Confirm {changes.length} quantity change{changes.length === 1 ? '' : 's'} before saving.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 overflow-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>{['Style', 'Color', 'Size', 'Before', 'After', 'Change'].map((label) => <th key={label} className="px-3 py-2 text-left">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {changes.map((row) => {
                const delta = row.newQuantity - Number(row.Quantity)
                return (
                  <tr key={row.id}>
                    <td className="px-3 py-2 font-medium">{row.Style}</td>
                    <td className="px-3 py-2">{row.Color}</td>
                    <td className="px-3 py-2">{row.Size}</td>
                    <td className="px-3 py-2 text-slate-400">{row.Quantity}</td>
                    <td className="px-3 py-2 font-semibold text-slate-800">{row.newQuantity}</td>
                    <td className={`px-3 py-2 font-semibold ${delta >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{delta > 0 ? '+' : ''}{delta}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-500">Reason / Remark (optional)</label>
          <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} placeholder="Example: Physical count correction" className="input-base w-full" />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary">Back</button>
          <button type="button" onClick={() => onSave(reason)} disabled={saving} className="btn-primary disabled:opacity-50">
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save {changes.length} Change{changes.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddRowsGridModal({ onClose, onDone, currentRows, getToken }) {
  const [rows, setRows] = useState(() => Array.from({ length: 6 }, nextBlankInventoryRow))
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()
  const fields = ['Style', 'Color', 'Size', 'Quantity']

  const updateCell = (rowKey, field, value) => {
    setRows((current) => current.map((row) => row.key === rowKey ? { ...row, [field]: value } : row))
    setPreview(null)
  }

  const handlePaste = (event, startRow, startField) => {
    const text = event.clipboardData.getData('text')
    if (!text.includes('\t') && !/[\r\n]/.test(text.trim())) return
    event.preventDefault()
    const matrix = text.replace(/\r/g, '').split('\n').filter((line) => line.length > 0).map((line) => line.split('\t'))
    setRows((current) => {
      const next = current.map((row) => ({ ...row }))
      while (next.length < startRow + matrix.length) next.push(nextBlankInventoryRow())
      matrix.forEach((values, rowOffset) => {
        values.forEach((value, columnOffset) => {
          const field = fields[startField + columnOffset]
          if (field) next[startRow + rowOffset][field] = value.trim()
        })
      })
      return next
    })
    setPreview(null)
  }

  const buildPreview = () => {
    try {
      const entered = rows.filter((row) => fields.some((field) => String(row[field] ?? '').trim()))
      if (!entered.length) throw new Error('Enter at least one inventory row')
      const normalized = entered.map((row, index) => normaliseRow(row, index))
      const seen = new Set()
      for (const row of normalized) {
        const key = inventoryKey(row)
        if (seen.has(key)) throw new Error(`${row.Style} / ${row.Color} / ${row.Size} appears more than once`)
        seen.add(key)
      }
      const currentByKey = new Map(currentRows.map((row) => [inventoryKey(row), row]))
      const toAdd = normalized.filter((row) => !currentByKey.has(inventoryKey(row)))
      const existing = normalized.filter((row) => currentByKey.has(inventoryKey(row))).map((row) => ({
        ...row,
        currentQuantity: currentByKey.get(inventoryKey(row)).Quantity,
      }))
      setPreview({ toAdd, existing })
    } catch (error) {
      toast.error(error.message, 'Check New Styles')
    }
  }

  const handleSave = async () => {
    if (!preview?.toAdd.length) return
    setLoading(true)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=add-rows`, {
        method: 'POST',
        headers: authHeaders(getToken(), true),
        body: JSON.stringify({ rows: preview.toAdd }),
      })
      toast.success(`Added ${data.added} inventory row${data.added === 1 ? '' : 's'}`, 'Styles Added')
      await onDone()
      onClose()
    } catch (error) {
      toast.error(error.message, 'Add Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col gap-4 rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900">Add Styles Online</h3>
            <p className="mt-1 text-sm text-slate-500">Type directly or paste four columns from Excel: Style, Color, Size, Quantity.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>

        {!preview ? (
          <>
            <div className="min-h-0 overflow-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="w-12 border-b border-r border-slate-200 px-2 py-2 text-center">#</th>
                    {fields.map((field) => <th key={field} className="border-b border-r border-slate-200 px-3 py-2 text-left">{field}</th>)}
                    <th className="w-12 border-b border-slate-200" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, rowIndex) => (
                    <tr key={row.key}>
                      <td className="border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-xs text-slate-400">{rowIndex + 1}</td>
                      {fields.map((field, fieldIndex) => (
                        <td key={field} className="border-b border-r border-slate-200 p-0">
                          <input
                            type={field === 'Quantity' ? 'number' : 'text'}
                            min={field === 'Quantity' ? '0' : undefined}
                            step={field === 'Quantity' ? '1' : undefined}
                            value={row[field]}
                            onChange={(event) => updateCell(row.key, field, event.target.value)}
                            onPaste={(event) => handlePaste(event, rowIndex, fieldIndex)}
                            className="h-9 w-full border-0 bg-transparent px-3 outline-none focus:bg-blue-50 focus:ring-2 focus:ring-inset focus:ring-blue-300"
                          />
                        </td>
                      ))}
                      <td className="border-b border-slate-200 p-1 text-center">
                        <button type="button" onClick={() => setRows((current) => current.length === 1 ? current : current.filter((item) => item.key !== row.key))} className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500"><X className="h-3.5 w-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <button type="button" onClick={() => setRows((current) => [...current, nextBlankInventoryRow()])} className="btn-secondary w-fit text-sm"><Plus className="h-4 w-4" /> Add Row</button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                <button type="button" onClick={buildPreview} className="btn-primary"><CheckCircle className="h-4 w-4" /> Review Rows</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-800">{preview.toAdd.length} new row{preview.toAdd.length === 1 ? '' : 's'} will be added</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-800">{preview.existing.length} existing row{preview.existing.length === 1 ? '' : 's'} will be skipped</p>
              </div>
            </div>
            <div className="min-h-0 overflow-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Style', 'Color', 'Size', 'Starting Qty', 'Result'].map((label) => <th key={label} className="px-3 py-2 text-left">{label}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {[...preview.toAdd.map((row) => ({ ...row, result: 'Add' })), ...preview.existing.map((row) => ({ ...row, result: `Exists (${row.currentQuantity})` }))].map((row, index) => (
                    <tr key={`${inventoryKey(row)}-${index}`}><td className="px-3 py-2 font-medium">{row.Style}</td><td className="px-3 py-2">{row.Color}</td><td className="px-3 py-2">{row.Size}</td><td className="px-3 py-2">{row.Quantity}</td><td className={`px-3 py-2 font-semibold ${row.result === 'Add' ? 'text-emerald-600' : 'text-amber-600'}`}>{row.result}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPreview(null)} disabled={loading} className="btn-secondary">Back to Edit</button>
              <button type="button" onClick={handleSave} disabled={loading || !preview.toAdd.length} className="btn-primary disabled:opacity-50">
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add {preview.toAdd.length} Row{preview.toAdd.length === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}
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
      const balanceMap = new Map(currentRows.map((row) => [inventoryKey(row), row]))
      const to_add        = []
      const already_exists = []

      for (const [index, raw] of uploaded.entries()) {
        const r = normaliseRow(raw, index)
        const key = inventoryKey(r)
        if (balanceMap.has(key)) {
          const existing = balanceMap.get(key)
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
      const balanceMap = new Map(currentRows.map((row) => [inventoryKey(row), row]))
      const to_remove = []
      const not_found  = []

      for (const [index, raw] of uploaded.entries()) {
        const r = normaliseRow(raw, index)
        const key = inventoryKey(r)
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
    const restoreMode = inventoryRestoreMode(snap.label)
    const fullRestore = restoreMode === 'full'
    const confirmation = fullRestore
      ? `Restore the entire inventory version from ${snap.timestamp}?\n\n` +
        `This whole-inventory restore replaces both quantities and the SKU list with ${snap.total_units.toLocaleString()} units across ${snap.total_rows.toLocaleString()} SKUs.\n` +
        'Styles, colors, and sizes added after this version will be removed.'
      : `Restore saved inventory quantities from ${snap.timestamp}?\n\n` +
        `Saved quantities for ${snap.total_rows.toLocaleString()} SKU rows will be restored. ` +
        'Styles, colors, and sizes added after this point will be kept.'
    if (!window.confirm(confirmation)) return

    setRestoring(snap.id)
    try {
      const modeQuery = fullRestore ? '' : '&mode=quantities'
      const res = await apiFetch(`${BASE}/inventory-balance?action=restore&id=${snap.id}${modeQuery}`, {
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
              Daily updates restore quantities and keep SKUs added later. A whole-inventory restore is available only for versions saved before a full inventory replacement, and it replaces the SKU list too.
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
                      {inventoryRestoreMode(snap.label) === 'full' ? 'Restore All' : 'Restore Qty'}
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
      const rows = uploaded.map(normaliseRow)
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
      const rows = uploaded.map(normaliseRow)
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
  const { getToken, user } = useAuth()
  const [balanceData,    setBalanceData]    = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [inputValue,     setInputValue]     = useState('')
  const [searchQuery,    setSearchQuery]    = useState('')
  const [filter,         setFilter]         = useState('all')  // all | low | zero
  const [styleFilter,    setStyleFilter]    = useState('all')
  const [isPending,      startTransition]   = useTransition()
  const [serverError,    setServerError]    = useState(null)
  const [resetting,      setResetting]      = useState(false)
  const [showImport,     setShowImport]     = useState(false)
  const [showAddRows,    setShowAddRows]    = useState(false)
  const [showRemoveRows, setShowRemoveRows] = useState(false)
  const [editTarget,     setEditTarget]     = useState(null)
  const [selectedIds,    setSelectedIds]    = useState(() => new Set())
  const [showBulkEdit,   setShowBulkEdit]   = useState(false)
  const [quantityDrafts, setQuantityDrafts] = useState({})
  const [showReview,     setShowReview]     = useState(false)
  const [savingGrid,     setSavingGrid]     = useState(false)
  const [activeView,     setActiveView]     = useState('balance')
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

  const loadBalance = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    setServerError(null)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=list`, {
        headers: authHeaders(getToken()),
      })
      setBalanceData(data)
    } catch (err) {
      setServerError(err.message)
    } finally {
      if (showSpinner) setLoading(false)
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

  const pendingChanges = useMemo(() => allRows.flatMap((row) => {
    if (!(row.id in quantityDrafts)) return []
    const raw = quantityDrafts[row.id]
    const quantity = Number(raw)
    if (raw === '' || !Number.isSafeInteger(quantity) || quantity < 0 || quantity === Number(row.Quantity)) return []
    return [{ ...row, newQuantity: quantity }]
  }), [allRows, quantityDrafts])

  const invalidDraftCount = useMemo(() => Object.entries(quantityDrafts).filter(([id, raw]) => {
    const row = allRows.find((item) => item.id === Number(id))
    if (!row) return false
    const quantity = Number(raw)
    return raw === '' || !Number.isSafeInteger(quantity) || quantity < 0
  }).length, [allRows, quantityDrafts])

  useEffect(() => {
    if (!pendingChanges.length && !invalidDraftCount) return undefined
    const warnBeforeLeave = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeave)
    return () => window.removeEventListener('beforeunload', warnBeforeLeave)
  }, [invalidDraftCount, pendingChanges.length])

  const handleGridChange = useCallback((row, value) => {
    setQuantityDrafts((current) => {
      const next = { ...current }
      if (value === String(row.Quantity ?? 0)) delete next[row.id]
      else next[row.id] = value
      return next
    })
  }, [])

  const saveGridChanges = useCallback(async (reason) => {
    if (!pendingChanges.length || invalidDraftCount) return
    setSavingGrid(true)
    try {
      const data = await apiFetch(`${BASE}/inventory-balance?action=bulk-edit`, {
        method: 'PATCH',
        headers: authHeaders(getToken(), true),
        body: JSON.stringify({
          reason,
          updates: pendingChanges.map((row) => ({
            id: row.id,
            quantity: row.newQuantity,
            expectedQuantity: Number(row.RawQuantity ?? row.Quantity),
          })),
        }),
      })
      const savedById = new Map((data.rows || []).map((row) => [Number(row.id), Number(row.quantity)]))
      setBalanceData((current) => {
        if (!current?.rows) return current
        const rows = current.rows.map((row) => savedById.has(row.id) ? {
          ...row,
          Quantity: Math.max(0, savedById.get(row.id)),
          RawQuantity: savedById.get(row.id),
        } : row)
        return {
          ...current,
          rows,
          total_units: rows.reduce((sum, row) => sum + (Number(row.Quantity) || 0), 0),
          skus_in_stock: rows.filter((row) => Number(row.Quantity) > 0).length,
          skus_zero: rows.filter((row) => Number(row.Quantity) <= 0).length,
        }
      })
      setQuantityDrafts({})
      setShowReview(false)
      toast.success(`Saved ${data.updated} inventory change${Number(data.updated) === 1 ? '' : 's'}`, 'Inventory Updated')
    } catch (error) {
      toast.error(error.message, 'Save Failed')
      if (error.message.toLowerCase().includes('changed')) await loadBalance()
    } finally {
      setSavingGrid(false)
    }
  }, [getToken, invalidDraftCount, loadBalance, pendingChanges, toast])

  const styles = useMemo(() => (
    [...new Set(allRows.map((row) => row.Style).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
  ), [allRows])

  const inventoryGroupOrder = useMemo(() => {
    const order = new Map()
    allRows.forEach((row) => {
      const key = `${String(row.Style || '').trim().toLowerCase()}\u241f${String(row.Color || '').trim().toLowerCase()}`
      if (!order.has(key)) order.set(key, order.size)
    })
    return order
  }, [allRows])

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
    if (styleFilter !== 'all') rows = rows.filter(r => r.Style === styleFilter)
    return [...rows].sort((left, right) => {
      const leftGroup = `${String(left.Style || '').trim().toLowerCase()}\u241f${String(left.Color || '').trim().toLowerCase()}`
      const rightGroup = `${String(right.Style || '').trim().toLowerCase()}\u241f${String(right.Color || '').trim().toLowerCase()}`
      return (inventoryGroupOrder.get(leftGroup) ?? 0) - (inventoryGroupOrder.get(rightGroup) ?? 0)
        || compareInventorySizes(left.Size, right.Size)
        || Number(left.id) - Number(right.id)
    })
  }, [allRows, searchQuery, filter, inventoryGroupOrder, styleFilter])

  const selectedRows = useMemo(
    () => allRows.filter((row) => selectedIds.has(row.id)),
    [allRows, selectedIds]
  )
  const allDisplayedSelected = displayRows.length > 0 && displayRows.every((row) => selectedIds.has(row.id))

  const toggleRow = useCallback((id) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllDisplayed = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current)
      const shouldSelect = displayRows.some((row) => !next.has(row.id))
      displayRows.forEach((row) => shouldSelect ? next.add(row.id) : next.delete(row.id))
      return next
    })
  }, [displayRows])

  const selectionColumn = useMemo(() => ({
    key: '__selected',
    label: (
      <input
        type="checkbox"
        checked={allDisplayedSelected}
        onChange={toggleAllDisplayed}
        onClick={(event) => event.stopPropagation()}
        aria-label="Select all filtered inventory rows"
        className="h-4 w-4 rounded border-slate-300 text-blue-600"
      />
    ),
    sortable: false,
    className: 'w-12',
    cellClassName: 'w-12',
    render: (_, row) => (
      <input
        type="checkbox"
        checked={selectedIds.has(row.id)}
        onChange={() => toggleRow(row.id)}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Select ${row.Style} ${row.Color} ${row.Size}`}
        className="h-4 w-4 rounded border-slate-300 text-blue-600"
      />
    ),
  }), [allDisplayedSelected, selectedIds, toggleAllDisplayed, toggleRow])

  const handleBulkUpdated = useCallback((updates) => {
    const byId = new Map(updates.map((row) => [Number(row.id), Number(row.quantity)]))
    setBalanceData((current) => {
      if (!current?.rows) return current
      const rows = current.rows.map((row) => byId.has(row.id) ? { ...row, Quantity: byId.get(row.id) } : row)
      return {
        ...current,
        rows,
        total_units: rows.reduce((sum, row) => sum + (Number(row.Quantity) || 0), 0),
        skus_in_stock: rows.filter((row) => Number(row.Quantity) > 0).length,
        skus_zero: rows.filter((row) => Number(row.Quantity) <= 0).length,
      }
    })
    setSelectedIds(new Set())
  }, [])

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
        <AddRowsGridModal onClose={() => setShowAddRows(false)} onDone={loadBalance} currentRows={allRows} getToken={getToken} />
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
      {showBulkEdit && selectedRows.length > 0 && (
        <BulkEditQtyModal
          rows={selectedRows}
          onClose={() => setShowBulkEdit(false)}
          onDone={handleBulkUpdated}
          getToken={getToken}
        />
      )}
      {showReview && pendingChanges.length > 0 && (
        <ReviewInventoryChangesModal
          changes={pendingChanges}
          onClose={() => setShowReview(false)}
          onSave={saveGridChanges}
          saving={savingGrid}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-800">Stock Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {activeView === 'balance'
              ? 'Real-time inventory balance — negative stock is displayed and exported as zero'
              : activeView === 'oversold'
                ? 'Resolve negative inventory with the color that was actually shipped'
              : activeView === 'daily-report'
                ? 'One-style daily inventory, sales comparison, and days-of-stock report'
                : 'Factory replenishment suggestions based on real inventory movement'}
          </p>
        </div>
        {activeView === 'balance' && (
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
              <button onClick={() => {
                if (pendingChanges.length && !window.confirm('Discard unsaved inventory changes and refresh?')) return
                setQuantityDrafts({})
                loadBalance()
              }} className="btn-secondary text-sm">
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
        )}
      </div>

      {/* Not initialized → show init panel */}
      {!initialized ? (
        <InitializePanel onDone={loadBalance} getToken={getToken} />
      ) : (
        <>
          <div className="flex w-full rounded-xl bg-slate-100 p-1 sm:w-fit">
            {[
              ['balance', 'Inventory Balance'],
              ['oversold', 'Oversold'],
              ['daily-report', 'Daily Style Report'],
              ['replenishment', 'Replenishment Plan'],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setActiveView(value)}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all sm:flex-none ${
                  activeView === value
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {activeView === 'replenishment' ? (
            <ReplenishmentPlan
              inventoryRows={allRows}
              storageOwner={user?.username || user?.name || 'admin'}
            />
          ) : activeView === 'daily-report' ? (
            <DailyStyleReport inventoryRows={allRows} />
          ) : activeView === 'oversold' ? (
            <OversoldManagement getToken={getToken} onInventoryChanged={() => loadBalance(false)} />
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

                  <select
                    value={styleFilter}
                    onChange={(event) => setStyleFilter(event.target.value)}
                    className="input-base sm:w-48 bg-white"
                    aria-label="Filter by style"
                  >
                    <option value="all">All styles</option>
                    {styles.map((style) => <option key={style} value={style}>{style}</option>)}
                  </select>

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

                {(inputValue || filter !== 'all' || styleFilter !== 'all') && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
                      {isPending ? '…' : `${displayRows.length.toLocaleString()} results`}
                    </span>
                    <button
                      onClick={() => { setInputValue(''); startTransition(() => setSearchQuery('')); setFilter('all'); setStyleFilter('all') }}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      Clear filters
                    </button>
                  </div>
                )}

                {(pendingChanges.length > 0 || invalidDraftCount > 0) && (
                  <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-amber-900">{pendingChanges.length} unsaved change{pendingChanges.length === 1 ? '' : 's'}</p>
                      <p className="mt-0.5 text-xs text-amber-700">
                        {invalidDraftCount ? `${invalidDraftCount} quantity cell${invalidDraftCount === 1 ? '' : 's'} must contain a whole number of 0 or more.` : 'Review the before and after quantities, then save them together.'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setQuantityDrafts({})} className="btn-secondary text-sm">Discard</button>
                      <button onClick={() => setShowReview(true)} disabled={!pendingChanges.length || invalidDraftCount > 0} className="btn-primary text-sm disabled:opacity-50">
                        <Save className="w-4 h-4" />
                        Review & Save
                      </button>
                    </div>
                  </div>
                )}

                {/* Legend */}
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-200" />Out of stock (≤ 0)</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-yellow-200" />Low stock (&lt; 5)</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-100" />In stock (≥ 5)</span>
                </div>

                <div className="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  Click a quantity to type, use + / −, or paste a vertical quantity column from Excel. Enter moves to the next row. Yellow cells are not saved yet.
                </div>

                <InventorySpreadsheet rows={displayRows} drafts={quantityDrafts} onChange={handleGridChange} />
              </div>

              {/* Version history + transaction log */}
              <VersionHistory onRestore={loadBalance} getToken={getToken} />
            </>
          )}
        </>
      )}
    </div>
  )
}
