import React, { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  Archive, Boxes, CalendarClock, CheckCircle2, ChevronRight,
  AlertCircle, Download, FileSpreadsheet, Layers3, Link2, MapPin,
  PackageCheck, RefreshCw, Search, Upload, Warehouse, X,
} from 'lucide-react'
import FileUploadZone from '../components/FileUploadZone.jsx'
import DataTable from '../components/DataTable.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseInventoryExcel, inventoryToCSV, downloadCSV } from '../utils/excelParser.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import { fetchInventory, saveInventory } from '../utils/api.js'

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

function InfoPill({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
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

export default function InventoryCheck() {
  const [rows, setRows] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [activeSheet, setActiveSheet] = useState('Location final')
  const [inputValue, setInputValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [showUpload, setShowUpload] = useState(false)
  const [isFetching, setIsFetching] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
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

  const handleFile = useCallback(async (file) => {
    setIsUploading(true)
    try {
      const parsed = await parseInventoryExcel(file)
      await saveInventory(parsed, file.name)
      setRows(parsed)
      setLastUpdated(new Date().toISOString())
      setFileName(file.name)
      setActiveSheet('Location final')
      setShowUpload(false)
      toast.success(`Updated ${parsed.length.toLocaleString()} rows. The previous weekly file was replaced.`, 'Weekly Inventory Updated')
    } catch (error) {
      toast.error(error.message, 'Upload Error')
    } finally {
      setIsUploading(false)
    }
  }, [toast])

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
    { key: 'box', label: 'Boxes', sortable: true, cellClassName: 'tabular-nums' },
    { key: 'qty', label: 'Qty', sortable: true, cellClassName: 'font-bold tabular-nums' },
    { key: 'sizes', label: 'Size Breakdown', render: (value, row) => <div className="min-w-[150px]"><p className="font-medium">{value || '—'}</p>{row.ratio && <p className="mt-0.5 text-xs text-slate-400">{row.ratio}</p>}</div> },
    { key: 'company', label: 'Company' },
    { key: 'customer', label: 'Customer' },
    ...(categorySheet ? [{ key: 'id', label: 'Master Link', sortable: false, render: (_, row) => {
      const links = getLinks(row)
      return links.length ? <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700"><Link2 className="h-3 w-3" />{links.length === 1 ? links[0].rack || 'Linked' : `${links.length} locations`}</span> : <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700"><AlertCircle className="h-3 w-3" />Review</span>
    } }] : []),
  ]

  const pendingColumns = [
    { key: 'po', label: 'PO #', sortable: true, cellClassName: 'font-semibold whitespace-nowrap' },
    { key: 'style', label: 'Style / Description', sortable: true },
    { key: 'pallet', label: 'Pallet', sortable: true },
    { key: 'box', label: 'Boxes', sortable: true },
    { key: 'qty', label: 'Pcs', sortable: true, cellClassName: 'font-bold tabular-nums' },
    { key: 'startDate', label: 'Start Date', sortable: true, cellClassName: 'whitespace-nowrap' },
    { key: 'cancelDate', label: 'Cancel Date', sortable: true, cellClassName: 'whitespace-nowrap' },
    { key: 'customer', label: 'Customer' },
    { key: 'remark', label: 'Remark' },
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
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!!rows.length && <button onClick={handleDownload} className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20"><Download className="h-4 w-4" />Export View</button>}
            <button onClick={() => setShowUpload((value) => !value)} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-indigo-950 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:bg-indigo-50"><Upload className="h-4 w-4" />Weekly Upload</button>
          </div>
        </div>
      </section>

      {apiError && <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="h-4 w-4" />The database is temporarily unavailable: {apiError}</div>}

      {showUpload && (
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

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                  <input value={inputValue} onChange={(event) => { const value = event.target.value; setInputValue(value); startTransition(() => setSearchQuery(value)) }} className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100" placeholder="Search location, style, color, fabric, label, company, remark or customer…" />
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {isPending ? 'Searching…' : `${num(filteredRows.length)} results`}
                  {inputValue && <button onClick={() => { setInputValue(''); startTransition(() => setSearchQuery('')) }} className="rounded-lg px-2 py-1 font-semibold text-indigo-600 hover:bg-indigo-50">Clear</button>}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                {activeSheet === 'Location final' ? <><CheckCircle2 className="h-4 w-4 text-emerald-500" />These totals are the official on-hand inventory.</> : pendingSheet ? <><CalendarClock className="h-4 w-4 text-amber-500" />Pending quantities are not included in on-hand inventory.</> : <><Link2 className="h-4 w-4 text-indigo-500" />This is a linked view; quantities are already included in Location Final.</>}
              </div>
            </div>
            <div className="p-3 sm:p-5">
              <DataTable data={filteredRows} columns={pendingSheet ? pendingColumns : inventoryColumns} pageSize={50} onRowClick={setSelected} getRowKey={(row) => row.id} emptyMessage={searchQuery ? `No results for “${searchQuery}”` : 'No inventory rows in this sheet'} />
            </div>
          </section>
        </>
      ) : (
        <button onClick={() => setShowUpload(true)} className="group flex min-h-[340px] w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-indigo-200 bg-gradient-to-br from-white to-indigo-50/60 p-8 text-center transition hover:border-indigo-400">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600 transition group-hover:scale-105"><Warehouse className="h-8 w-8" /></span>
          <span className="mt-5 text-lg font-bold text-slate-800">Upload your first weekly inventory</span>
          <span className="mt-2 max-w-md text-sm leading-6 text-slate-500">The system will read Location Final and every category sheet to create a searchable inventory view.</span>
        </button>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <aside className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-5 backdrop-blur">
              <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-indigo-500">{SHEET_LABELS[selected.sheet] || selected.sheet}</p><h2 className="mt-1 text-2xl font-black text-slate-900">{selected.style || selected.po || 'Inventory Detail'}</h2><p className="mt-1 text-sm text-slate-500">{selected.color || selected.customer || `Excel row ${selected.rowNumber}`}</p></div><button onClick={() => setSelected(null)} className="rounded-xl bg-slate-100 p-2 text-slate-500 hover:bg-slate-200"><X className="h-5 w-5" /></button></div>
            </div>
            <div className="space-y-6 p-6">
              {selected.rack && <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 p-5 text-white"><p className="text-xs font-bold uppercase tracking-widest text-indigo-200">Warehouse Location</p><p className="mt-2 flex items-center gap-2 text-2xl font-black"><MapPin className="h-6 w-6" />{selected.rack}</p></div>}
              <div className="grid grid-cols-2 gap-x-5 gap-y-5 rounded-2xl border border-slate-200 p-5">
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
    </div>
  )
}
