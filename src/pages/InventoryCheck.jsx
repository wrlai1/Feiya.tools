import React, { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  Archive, Boxes, CalendarClock, CheckCircle2, ChevronRight,
  AlertCircle, Download, Eye, FileSpreadsheet, Layers3, Link2, MapPin,
  Minus, PackageCheck, Pencil, Plus, RefreshCw, Search, Trash2,
  Upload, Warehouse, X,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import DataTable from '../components/DataTable.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseInventoryExcel, inventoryToCSV, downloadCSV } from '../utils/excelParser.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import { fetchInventory, saveInventory } from '../utils/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import userPermissions from '../utils/userPermissions.js'

const { INVENTORY_CHECK_EDIT, userHasPermission } = userPermissions

const SHEET_ORDER = [
  'Location final', 'Pending Shipment', 'PLUS', 'Petite', 'Missy',
  'Denim', 'Online', 'Stock', 'Sheet1',
]

const SHEET_LABELS = {
  'Location final': 'Location Final',
  'Pending Shipment': 'Pending Shipment',
  PLUS: 'Plus', Petite: 'Petite', Missy: 'Missy', Denim: 'Denim',
  Online: 'Online', Stock: 'Stock', Sheet1: 'Unsorted',
}

const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const linkKey = (row) => `${norm(row.style)}|${norm(row.color)}`
const num = (value) => Number(value || 0).toLocaleString()
const isValidInventoryNumber = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value))
const clearSheetTotals = (rows, sheet) => rows.map((row) => {
  if (row.sheet !== sheet) return row
  const { sheetBoxTotal, sheetQtyTotal, ...current } = row
  return current
})

const INVENTORY_FIELDS = [
  ['rack', 'Location'], ['style', 'Style'], ['color', 'Color'],
  ['box', 'Boxes', 'number'], ['qty', 'Quantity', 'number'],
  ['fabric', 'Fabric'], ['label', 'Label'], ['sizes', 'Size Breakdown'],
  ['ratio', 'Ratio / Breakdown'], ['company', 'Company'],
  ['customer', 'Customer'], ['remark', 'Remark', 'textarea'],
]

const PENDING_FIELDS = [
  ['po', 'PO #'], ['style', 'Style / Description'], ['pallet', 'Pallet'],
  ['box', 'Boxes', 'number'], ['qty', 'Pcs', 'number'],
  ['startDate', 'Start Date'], ['cancelDate', 'Cancel Date'],
  ['customer', 'Customer'], ['remark', 'Remark', 'textarea'],
  ['notes', 'Notes', 'textarea'],
]

function InfoPill({ icon: Icon, children }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
      <Icon className="h-3.5 w-3.5" /> {children}
    </span>
  )
}

function MetricCard({ icon: Icon, label, value, tone }) {
  const colors = {
    violet: { gradient: 'from-violet-500/15 to-fuchsia-500/5', text: 'text-violet-700', icon: 'bg-violet-100' },
    blue: { gradient: 'from-blue-500/15 to-cyan-500/5', text: 'text-blue-700', icon: 'bg-blue-100' },
    amber: { gradient: 'from-amber-500/15 to-orange-500/5', text: 'text-amber-700', icon: 'bg-amber-100' },
    emerald: { gradient: 'from-emerald-500/15 to-teal-500/5', text: 'text-emerald-700', icon: 'bg-emerald-100' },
  }[tone]
  return (
    <div className={`rounded-2xl border border-white bg-gradient-to-br ${colors.gradient} p-4 shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <p className={`mt-1 text-2xl font-black tracking-tight ${colors.text}`}>{value}</p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${colors.icon}`}>
          <Icon className={`h-5 w-5 ${colors.text}`} />
        </div>
      </div>
    </div>
  )
}

function DetailField({ label, value, wide = false }) {
  if (value === '' || value == null) return null
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-slate-700">{String(value)}</p>
    </div>
  )
}

function QuantityCell({ row, field, disabled, onAdjust, large = false, readOnly = false }) {
  if (readOnly) {
    return <span className={`${large ? 'text-lg' : ''} font-bold tabular-nums`}>{num(row[field])}</span>
  }
  return (
    <div className={`flex items-center ${large ? 'gap-2' : 'gap-1'}`} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        disabled={disabled || Number(row[field] || 0) <= 0}
        onClick={() => onAdjust(row, field, -1)}
        className={`${large ? 'flex h-11 w-11 items-center justify-center rounded-xl' : 'rounded-md p-1'} border border-slate-200 text-slate-500 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-30`}
        aria-label={`Decrease ${field}`}
      >
        <Minus className={large ? 'h-4 w-4' : 'h-3 w-3'} />
      </button>
      <span className={`${large ? 'min-w-12 text-lg' : 'min-w-10'} text-center font-bold tabular-nums`}>{num(row[field])}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAdjust(row, field, 1)}
        className={`${large ? 'flex h-11 w-11 items-center justify-center rounded-xl' : 'rounded-md p-1'} border border-slate-200 text-slate-500 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-30`}
        aria-label={`Increase ${field}`}
      >
        <Plus className={large ? 'h-4 w-4' : 'h-3 w-3'} />
      </button>
    </div>
  )
}

function MobileInventoryCards({ rows, pending, disabled, editable, resetKey, onAdjust, onEdit, onDelete, onSelect }) {
  const [visibleCount, setVisibleCount] = useState(25)

  useEffect(() => setVisibleCount(25), [resetKey])

  if (!rows.length) {
    return <div className="py-12 text-center text-sm text-slate-400">No inventory records found.</div>
  }

  const visibleRows = rows.slice(0, visibleCount)
  return (
    <div className="space-y-3 sm:hidden">
      {visibleRows.map((row) => (
        <article key={row.id} onClick={() => onSelect(row)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm active:bg-slate-50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-base font-black text-slate-900">{row.style || row.po || 'Inventory Record'}</p>
              <p className="mt-1 truncate text-sm text-slate-500">
                {[pending ? row.po : row.rack, row.color || row.customer].filter(Boolean).join(' · ') || 'No additional details'}
              </p>
            </div>
            {editable && (
              <div className="flex shrink-0 gap-1" onClick={(event) => event.stopPropagation()}>
                <button type="button" disabled={disabled} onClick={() => onEdit(row)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 disabled:opacity-40" aria-label="Edit record"><Pencil className="h-4 w-4" /></button>
                <button type="button" disabled={disabled} onClick={() => onDelete(row)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600 disabled:opacity-40" aria-label="Delete record"><Trash2 className="h-4 w-4" /></button>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-100 pt-4" onClick={(event) => event.stopPropagation()}>
            <div className="w-full">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Boxes</p>
              <QuantityCell row={row} field="box" disabled={disabled} onAdjust={onAdjust} large readOnly={!editable} />
            </div>
            <div className="w-full">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">{pending ? 'Pcs' : 'Quantity'}</p>
              <QuantityCell row={row} field="qty" disabled={disabled} onAdjust={onAdjust} large readOnly={!editable} />
            </div>
          </div>

          {row.remark && <p className="mt-4 line-clamp-2 rounded-xl bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-900"><span className="font-bold">Remark:</span> {row.remark}</p>}
          <p className="mt-3 text-xs font-semibold text-indigo-600">Tap card for full details</p>
        </article>
      ))}
      {visibleRows.length < rows.length && (
        <button type="button" onClick={() => setVisibleCount((count) => count + 25)} className="min-h-12 w-full rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">
          Load more · {num(rows.length - visibleRows.length)} remaining
        </button>
      )}
    </div>
  )
}

function InventoryEditor({ row, isNew, saving, onClose, onSave }) {
  const [draft, setDraft] = useState(row)
  const [errors, setErrors] = useState({})
  const fields = row.kind === 'pending' ? PENDING_FIELDS : INVENTORY_FIELDS

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const updateNumber = (key, value) => {
    update(key, value)
    setErrors((current) => ({
      ...current,
      [key]: isValidInventoryNumber(value) ? '' : 'Enter a whole number (0 or more).',
    }))
  }

  const adjustNumber = (key, delta) => {
    const current = isValidInventoryNumber(draft[key]) ? Number(draft[key]) : 0
    updateNumber(key, String(Math.max(0, current + delta)))
  }

  const submit = (event) => {
    event.preventDefault()
    const numberErrors = Object.fromEntries(
      fields
        .filter(([, , type]) => type === 'number')
        .map(([key]) => [key, isValidInventoryNumber(draft[key]) ? '' : 'Enter a whole number (0 or more).']),
    )
    setErrors(numberErrors)
    if (Object.values(numberErrors).some(Boolean)) return
    onSave(draft)
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-slate-950/35 backdrop-blur-sm" onClick={onClose}>
      <aside className="h-[100dvh] w-full max-w-xl overflow-y-auto bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6 sm:py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-indigo-500">{SHEET_LABELS[row.sheet] || row.sheet}</p>
              <h2 className="mt-1 text-2xl font-black text-slate-900">{isNew ? 'Add New Record' : 'Edit Record'}</h2>
              <p className="mt-1 text-sm text-slate-500">Changes are saved directly to Inventory Check.</p>
            </div>
            <button type="button" onClick={onClose} disabled={saving} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 disabled:opacity-50"><X className="h-5 w-5" /></button>
          </div>
        </div>
        <form
          className="space-y-5 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6"
          onSubmit={submit}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fields.map(([key, label, type]) => (
              <label key={key} className={type === 'textarea' ? 'sm:col-span-2' : ''}>
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
                {type === 'textarea' ? (
                  <textarea
                    value={draft[key] ?? ''}
                    onChange={(event) => update(key, event.target.value)}
                    rows={3}
                    className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 sm:text-sm"
                  />
                ) : (
                  <div className={type === 'number' ? 'mt-1.5 flex items-center gap-2' : ''}>
                    {type === 'number' && (
                      <button type="button" onClick={() => adjustNumber(key, -1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"><Minus className="h-4 w-4" /></button>
                    )}
                    <input
                      type="text"
                      inputMode={type === 'number' ? 'numeric' : undefined}
                      value={draft[key] ?? ''}
                      onChange={(event) => type === 'number' ? updateNumber(key, event.target.value) : update(key, event.target.value)}
                      aria-invalid={type === 'number' ? Boolean(errors[key]) : undefined}
                      aria-describedby={errors[key] ? `${key}-error` : undefined}
                      className={`${type === 'number' ? 'min-w-0 flex-1 text-center font-bold tabular-nums' : 'mt-1.5 w-full'} rounded-xl border px-3 py-2.5 text-base outline-none transition sm:text-sm ${errors[key] ? 'border-red-400 bg-red-50 focus:border-red-500 focus:ring-4 focus:ring-red-100' : 'border-slate-200 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100'}`}
                    />
                    {type === 'number' && (
                      <button type="button" onClick={() => adjustNumber(key, 1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"><Plus className="h-4 w-4" /></button>
                    )}
                  </div>
                )}
                {errors[key] && <p id={`${key}-error`} className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-red-600"><AlertCircle className="h-3.5 w-3.5" />{errors[key]}</p>}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-5">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60">
              {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
              {saving ? 'Saving…' : isNew ? 'Add Record' : 'Save Changes'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  )
}

export default function InventoryCheck() {
  const { user } = useAuth()
  const canEdit = userHasPermission(user, INVENTORY_CHECK_EDIT)
  const [rows, setRows] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [revision, setRevision] = useState(0)
  const [activeSheet, setActiveSheet] = useState('Location final')
  const [inputValue, setInputValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [editingRow, setEditingRow] = useState(null)
  const [isAdding, setIsAdding] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [isFetching, setIsFetching] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [apiError, setApiError] = useState(null)
  const [isPending, startTransition] = useTransition()
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await fetchInventory()
        if (!cancelled) {
          setRows(result.rows || [])
          setLastUpdated(result.updatedAt || null)
          setFileName(result.fileName || null)
          setRevision(Number(result.revision || 0))
        }
      } catch (error) {
        if (!cancelled) setApiError(error.message)
      } finally {
        if (!cancelled) setIsFetching(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const sheets = useMemo(() => {
    const found = [...new Set(rows.map((row) => row.sheet).filter(Boolean))]
    return found.sort((a, b) => {
      const ai = SHEET_ORDER.indexOf(a)
      const bi = SHEET_ORDER.indexOf(b)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    })
  }, [rows])

  useEffect(() => {
    if (sheets.length && !sheets.includes(activeSheet)) setActiveSheet(sheets[0])
  }, [sheets, activeSheet])

  const masterIndex = useMemo(() => {
    const index = new Map()
    rows.filter((row) => row.sheet === 'Location final').forEach((row) => {
      const key = linkKey(row)
      if (key === '|') return
      index.set(key, [...(index.get(key) || []), row])
    })
    return index
  }, [rows])

  const activeRows = useMemo(() => rows.filter((row) => row.sheet === activeSheet), [rows, activeSheet])
  const searchable = (row) => [
    row.rack, row.po, row.style, row.color, row.box, row.qty, row.fabric,
    row.label, row.sizes, row.ratio, row.company, row.remark, row.customer,
    row.pallet, row.startDate, row.cancelDate, row.notes,
  ].join(' ').toLowerCase()
  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return query ? activeRows.filter((row) => searchable(row).includes(query)) : activeRows
  }, [activeRows, searchQuery])

  const stats = useMemo(() => ({
    rows: activeRows.length,
    boxes: activeRows.find((row) => row.sheetBoxTotal != null)?.sheetBoxTotal ?? activeRows.reduce((sum, row) => sum + Number(row.box || 0), 0),
    qty: activeRows.find((row) => row.sheetQtyTotal != null)?.sheetQtyTotal ?? activeRows.reduce((sum, row) => sum + Number(row.qty || 0), 0),
    locations: new Set(activeRows.map((row) => row.rack).filter(Boolean)).size,
  }), [activeRows])

  const persistRows = useCallback(async (nextRows, message) => {
    setIsSaving(true)
    try {
      const result = await saveInventory(nextRows, fileName, revision)
      setRows(nextRows)
      setRevision(Number(result.revision))
      setLastUpdated(result.updatedAt || new Date().toISOString())
      toast.success(message, 'Inventory Updated')
      return true
    } catch (error) {
      toast.error(error.message, 'Could Not Save')
      return false
    } finally {
      setIsSaving(false)
    }
  }, [fileName, revision, toast])

  const handleAdjust = useCallback(async (row, field, delta) => {
    if (isSaving) return
    const nextValue = Math.max(0, Number(row[field] || 0) + delta)
    if (nextValue === Number(row[field] || 0)) return
    const nextRows = clearSheetTotals(
      rows.map((item) => item.id === row.id ? { ...item, [field]: nextValue } : item),
      row.sheet,
    )
    const saved = await persistRows(nextRows, `${field === 'box' ? 'Boxes' : 'Quantity'} changed to ${num(nextValue)}.`)
    if (saved) setSelected((current) => current?.id === row.id ? { ...current, [field]: nextValue } : current)
  }, [isSaving, persistRows, rows])

  const openAdd = useCallback(() => {
    const pending = activeSheet === 'Pending Shipment'
    setSelected(null)
    setIsAdding(true)
    setEditingRow({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheet: activeSheet,
      rowNumber: 'Manual',
      kind: pending ? 'pending' : 'inventory',
      box: 0,
      qty: 0,
    })
  }, [activeSheet])

  const handleSaveRow = useCallback(async (draft) => {
    if (!isValidInventoryNumber(draft.box) || !isValidInventoryNumber(draft.qty)) {
      toast.error('Boxes and Quantity must be whole numbers of 0 or more.', 'Check the Numbers')
      return
    }
    const clean = {
      ...draft,
      box: Number(draft.box),
      qty: Number(draft.qty),
    }
    const nextRows = clearSheetTotals(isAdding
      ? [...rows, clean]
      : rows.map((row) => row.id === clean.id ? clean : row),
    clean.sheet)
    const saved = await persistRows(nextRows, isAdding ? 'New inventory record added.' : 'Inventory record saved.')
    if (saved) {
      setSelected(isAdding ? null : clean)
      setEditingRow(null)
      setIsAdding(false)
    }
  }, [isAdding, persistRows, rows, toast])

  const handleDelete = useCallback(async (row) => {
    if (isSaving || !window.confirm(`Delete ${row.style || row.po || 'this inventory record'}? This cannot be undone.`)) return
    const nextRows = clearSheetTotals(rows.filter((item) => item.id !== row.id), row.sheet)
    const saved = await persistRows(nextRows, 'Inventory record deleted.')
    if (saved) {
      setSelected(null)
      setEditingRow(null)
      setIsAdding(false)
    }
  }, [isSaving, persistRows, rows])

  const handleFile = useCallback(async (file) => {
    setIsUploading(true)
    try {
      const parsed = await parseInventoryExcel(file)
      const result = await saveInventory(parsed, file.name, revision)
      setRows(parsed)
      setRevision(Number(result.revision))
      setLastUpdated(result.updatedAt || new Date().toISOString())
      setFileName(file.name)
      setActiveSheet('Location final')
      setShowUpload(false)
      toast.success(`Updated ${parsed.length.toLocaleString()} rows. The previous weekly file was replaced.`, 'Weekly Inventory Updated')
    } catch (error) {
      toast.error(error.message, 'Upload Error')
    } finally {
      setIsUploading(false)
    }
  }, [revision, toast])

  const handleDownload = useCallback(() => {
    downloadCSV(inventoryToCSV(filteredRows), `${SHEET_LABELS[activeSheet] || activeSheet}_${Date.now()}.csv`)
    toast.success(`Exported ${filteredRows.length.toLocaleString()} rows.`, 'CSV Exported')
  }, [filteredRows, activeSheet, toast])

  const pendingSheet = activeSheet === 'Pending Shipment'
  const categorySheet = !pendingSheet && activeSheet !== 'Location final'
  const getLinks = (row) => row.kind === 'inventory' ? (masterIndex.get(linkKey(row)) || []) : []

  const inventoryColumns = [
    { key: 'rack', label: 'Location', sortable: true, render: (value) => value ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-bold text-violet-700"><MapPin className="h-3.5 w-3.5" />{value}</span> : '—' },
    { key: 'style', label: 'Style', sortable: true, cellClassName: 'font-semibold whitespace-nowrap' },
    { key: 'color', label: 'Color', sortable: true },
    { key: 'box', label: 'Boxes', sortable: true, render: (_, row) => <QuantityCell row={row} field="box" disabled={isSaving} onAdjust={handleAdjust} readOnly={!canEdit} /> },
    { key: 'qty', label: 'Qty', sortable: true, render: (_, row) => <QuantityCell row={row} field="qty" disabled={isSaving} onAdjust={handleAdjust} readOnly={!canEdit} /> },
    { key: 'sizes', label: 'Size Breakdown', render: (value, row) => <div className="min-w-[150px]"><p className="font-medium">{value || '—'}</p>{row.ratio && <p className="mt-0.5 text-xs text-slate-400">{row.ratio}</p>}</div> },
    { key: 'company', label: 'Company' },
    { key: 'customer', label: 'Customer' },
    ...(categorySheet ? [{ key: 'id', label: 'Master Link', sortable: false, render: (_, row) => {
      const links = getLinks(row)
      return links.length ? <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700"><Link2 className="h-3 w-3" />{links.length === 1 ? links[0].rack || 'Linked' : `${links.length} locations`}</span> : <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700"><AlertCircle className="h-3 w-3" />Review</span>
    } }] : []),
    ...(canEdit ? [{ key: 'actions', label: 'Actions', sortable: false, render: (_, row) => <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}><button type="button" disabled={isSaving} onClick={() => { setIsAdding(false); setEditingRow(row) }} className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40" aria-label="Edit record"><Pencil className="h-4 w-4" /></button><button type="button" disabled={isSaving} onClick={() => handleDelete(row)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label="Delete record"><Trash2 className="h-4 w-4" /></button></div> }] : []),
  ]

  const pendingColumns = [
    { key: 'po', label: 'PO #', sortable: true, cellClassName: 'font-semibold whitespace-nowrap' },
    { key: 'style', label: 'Style / Description', sortable: true },
    { key: 'pallet', label: 'Pallet', sortable: true },
    { key: 'box', label: 'Boxes', sortable: true, render: (_, row) => <QuantityCell row={row} field="box" disabled={isSaving} onAdjust={handleAdjust} readOnly={!canEdit} /> },
    { key: 'qty', label: 'Pcs', sortable: true, render: (_, row) => <QuantityCell row={row} field="qty" disabled={isSaving} onAdjust={handleAdjust} readOnly={!canEdit} /> },
    { key: 'startDate', label: 'Start Date', sortable: true, cellClassName: 'whitespace-nowrap' },
    { key: 'cancelDate', label: 'Cancel Date', sortable: true, cellClassName: 'whitespace-nowrap' },
    { key: 'customer', label: 'Customer' },
    { key: 'remark', label: 'Remark' },
    ...(canEdit ? [{ key: 'actions', label: 'Actions', sortable: false, render: (_, row) => <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}><button type="button" disabled={isSaving} onClick={() => { setIsAdding(false); setEditingRow(row) }} className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40" aria-label="Edit record"><Pencil className="h-4 w-4" /></button><button type="button" disabled={isSaving} onClick={() => handleDelete(row)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label="Delete record"><Trash2 className="h-4 w-4" /></button></div> }] : []),
  ]

  const selectedLinks = selected ? getLinks(selected) : []

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 pb-10">
      <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-800 p-6 text-white shadow-xl shadow-indigo-950/15 sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-fuchsia-400/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-1/3 h-36 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Inventory Check</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-indigo-100/80 sm:text-base">
              Location Final is the single source of truth. Category sheets are linked views, while Pending Shipment is tracked separately to prevent double counting.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {fileName && <InfoPill icon={FileSpreadsheet}>{fileName}</InfoPill>}
              {lastUpdated && <InfoPill icon={CalendarClock}>Updated {formatLastUpdated(lastUpdated)}</InfoPill>}
              {!!rows.length && <InfoPill icon={Layers3}>{sheets.length} sheets · {num(rows.length)} rows</InfoPill>}
              {!canEdit && <InfoPill icon={Eye}>Read-only access</InfoPill>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!!rows.length && <button onClick={handleDownload} className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20"><Download className="h-4 w-4" />Export View</button>}
            {canEdit && <button onClick={() => setShowUpload((value) => !value)} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-indigo-950 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:bg-indigo-50"><Upload className="h-4 w-4" />Weekly Upload</button>}
          </div>
        </div>
      </section>

      {apiError && <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="h-4 w-4" />The database is temporarily unavailable: {apiError}</div>}

      {canEdit && showUpload && (
        <section className="rounded-3xl border border-indigo-100 bg-white p-5 shadow-lg shadow-indigo-950/5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div><h2 className="font-bold text-slate-800">Upload weekly workbook</h2><p className="mt-1 text-sm text-slate-500">The new upload replaces the previous Inventory Check file. It does not change Stock Management.</p></div>
            <button onClick={() => setShowUpload(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          </div>
          {isUploading ? <div className="flex items-center justify-center py-12 text-sm font-medium text-indigo-600"><RefreshCw className="mr-2 h-5 w-5 animate-spin" />Reading and saving all sheets…</div> : <FileUploadZone onFile={handleFile} accept=".xlsx,.xls" acceptedTypes="XLSX, XLS" label="Drop the weekly Inventory Update here" sublabel="or click to choose the file" compact />}
        </section>
      )}

      {isFetching ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-3xl border border-slate-200 bg-white"><RefreshCw className="mr-3 h-5 w-5 animate-spin text-indigo-600" /><span className="text-sm text-slate-500">Loading warehouse data…</span></div>
      ) : rows.length ? (
        <>
          <section className="rounded-3xl border border-slate-200/80 bg-white p-2 shadow-sm">
            <div className="flex gap-1.5 overflow-x-auto p-1">
              {sheets.map((sheet) => {
                const count = rows.filter((row) => row.sheet === sheet).length
                const active = activeSheet === sheet
                return <button key={sheet} onClick={() => { setActiveSheet(sheet); setSelected(null) }} className={`flex shrink-0 items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition ${active ? 'bg-slate-950 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><span>{SHEET_LABELS[sheet] || sheet}</span><span className={`rounded-full px-2 py-0.5 text-[10px] ${active ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-400'}`}>{num(count)}</span></button>
              })}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={Archive} label="Records" value={num(stats.rows)} tone="violet" />
            <MetricCard icon={Boxes} label="Boxes" value={num(stats.boxes)} tone="blue" />
            <MetricCard icon={PackageCheck} label={pendingSheet ? 'Pending Pcs' : 'Total Qty'} value={num(stats.qty)} tone="emerald" />
            <MetricCard icon={MapPin} label={pendingSheet ? 'PO Records' : 'Locations'} value={num(pendingSheet ? stats.rows : stats.locations)} tone="amber" />
          </div>

          <section className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input value={inputValue} onChange={(event) => { const value = event.target.value; setInputValue(value); startTransition(() => setSearchQuery(value)) }} className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100 sm:text-sm" placeholder="Search location, style, color, fabric, label, company, remark or customer…" />
                </div>
                <div className="flex w-full items-center justify-between gap-2 text-xs text-slate-500 lg:w-auto lg:justify-start">
                  {isPending ? 'Searching…' : `${num(filteredRows.length)} results`}
                  {inputValue && <button onClick={() => { setInputValue(''); startTransition(() => setSearchQuery('')) }} className="rounded-lg px-2 py-1 font-semibold text-indigo-600 hover:bg-indigo-50">Clear</button>}
                  {canEdit && <button type="button" onClick={openAdd} disabled={isSaving} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 lg:ml-2 lg:min-h-0 lg:px-3 lg:text-xs"><Plus className="h-4 w-4 lg:h-3.5 lg:w-3.5" />Add New</button>}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                {activeSheet === 'Location final' ? <><CheckCircle2 className="h-4 w-4 text-emerald-500" />These totals are the official on-hand inventory.</> : pendingSheet ? <><CalendarClock className="h-4 w-4 text-amber-500" />Pending quantities are not included in on-hand inventory.</> : <><Link2 className="h-4 w-4 text-indigo-500" />This is a linked view; quantities are already included in Location Final.</>}
              </div>
            </div>
            <div className="p-3 sm:p-5">
              <MobileInventoryCards
                rows={filteredRows}
                pending={pendingSheet}
                disabled={isSaving}
                editable={canEdit}
                resetKey={`${activeSheet}|${searchQuery}`}
                onAdjust={handleAdjust}
                onEdit={(row) => { setIsAdding(false); setEditingRow(row) }}
                onDelete={handleDelete}
                onSelect={setSelected}
              />
              <div className="hidden sm:block">
                <DataTable data={filteredRows} columns={pendingSheet ? pendingColumns : inventoryColumns} pageSize={50} onRowClick={setSelected} getRowKey={(row) => row.id} emptyMessage={searchQuery ? `No results for “${searchQuery}”` : 'No inventory rows in this sheet'} />
              </div>
            </div>
          </section>
        </>
      ) : canEdit ? (
        <button onClick={() => setShowUpload(true)} className="group flex min-h-[340px] w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-indigo-200 bg-gradient-to-br from-white to-indigo-50/60 p-8 text-center transition hover:border-indigo-400">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600 transition group-hover:scale-105"><Warehouse className="h-8 w-8" /></span>
          <span className="mt-5 text-lg font-bold text-slate-800">Upload your first weekly inventory</span>
          <span className="mt-2 max-w-md text-sm leading-6 text-slate-500">The system will read Location Final and every category sheet to create a searchable inventory view.</span>
        </button>
      ) : (
        <div className="flex min-h-[340px] w-full flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white p-8 text-center">
          <Eye className="h-10 w-10 text-slate-300" />
          <p className="mt-4 font-bold text-slate-700">No Inventory Check data is available yet.</p>
          <p className="mt-1 text-sm text-slate-500">An Admin can upload the weekly inventory workbook.</p>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <aside className="h-[100dvh] w-full max-w-xl overflow-y-auto bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6 sm:py-5">
              <div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-widest text-indigo-500">{SHEET_LABELS[selected.sheet] || selected.sheet}</p><h2 className="mt-1 truncate text-2xl font-black text-slate-900">{selected.style || selected.po || 'Inventory Detail'}</h2><p className="mt-1 truncate text-sm text-slate-500">{selected.color || selected.customer || `Excel row ${selected.rowNumber}`}</p></div><button onClick={() => setSelected(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200"><X className="h-5 w-5" /></button></div>
              {canEdit && <div className="mt-4 flex gap-2">
                <button type="button" disabled={isSaving} onClick={() => { setIsAdding(false); setEditingRow(selected) }} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:text-xs"><Pencil className="h-4 w-4 sm:h-3.5 sm:w-3.5" />Edit</button>
                <button type="button" disabled={isSaving} onClick={() => handleDelete(selected)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-red-200 px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 sm:min-h-0 sm:flex-none sm:text-xs"><Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />Delete</button>
              </div>}
            </div>
            <div className="space-y-6 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6">
              {selected.rack && <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 p-5 text-white"><p className="text-xs font-bold uppercase tracking-widest text-indigo-200">Warehouse Location</p><p className="mt-2 flex items-center gap-2 text-2xl font-black"><MapPin className="h-6 w-6" />{selected.rack}</p></div>}
              <div className="grid grid-cols-1 gap-x-5 gap-y-5 rounded-2xl border border-slate-200 p-5 sm:grid-cols-2">
                <DetailField label="PO #" value={selected.po} /><DetailField label="Style" value={selected.style} />
                <DetailField label="Color" value={selected.color} /><DetailField label="Pallet" value={selected.pallet} />
                <DetailField label="Boxes" value={selected.box || ''} /><DetailField label={selected.kind === 'pending' ? 'Pcs' : 'Quantity'} value={selected.qty || ''} />
                <DetailField label="Fabric" value={selected.fabric} /><DetailField label="Label" value={selected.label} />
                <DetailField label="Sizes" value={selected.sizes} /><DetailField label="Ratio / Breakdown" value={selected.ratio} />
                <DetailField label="Company" value={selected.company} /><DetailField label="Customer" value={selected.customer} />
                <DetailField label="Start Date" value={selected.startDate} /><DetailField label="Cancel Date" value={selected.cancelDate} />
                <DetailField label="Remark" value={selected.remark} wide /><DetailField label="Notes" value={selected.notes} wide />
              </div>
              {selected.sheet !== 'Location final' && selected.kind === 'inventory' && <div><h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Link2 className="h-4 w-4 text-indigo-500" />Location Final Link</h3>{selectedLinks.length ? <div className="space-y-2">{selectedLinks.map((row) => <button key={row.id} onClick={() => setSelected(row)} className="flex w-full items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left transition hover:border-emerald-400"><div><p className="font-bold text-emerald-900">{row.rack || 'Location Final'}</p><p className="mt-0.5 text-xs text-emerald-700">{row.style} · {row.color} · {num(row.qty)} pcs</p></div><ChevronRight className="h-5 w-5 text-emerald-500" /></button>)}</div> : <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">No exact Style + Color match in Location Final. This row is kept for manual review and is not added to the master total.</div>}</div>}
              <p className="text-xs text-slate-400">Source: {selected.sheet}, Excel row {selected.rowNumber}</p>
            </div>
          </aside>
        </div>
      )}

      {canEdit && editingRow && (
        <InventoryEditor
          row={editingRow}
          isNew={isAdding}
          saving={isSaving}
          onClose={() => { if (!isSaving) { setEditingRow(null); setIsAdding(false) } }}
          onSave={handleSaveRow}
        />
      )}
    </div>
  )
}
