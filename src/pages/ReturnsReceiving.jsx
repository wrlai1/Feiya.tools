import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSpreadsheet,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Upload,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { aliasKey } from '../utils/autoDeductEngine.js'
import {
  applyProductCatalogMapping,
  applyReturnOrderMatch,
  getReturnManifestOrderNumbers,
  parseProductCatalogRows,
  parseReturnManifestRows,
  parseSkuReturnManifestRows,
  resolveProductCatalogRows,
  resolveReturnManifestPackages,
} from '../utils/returnImportEngine.js'
import { parseOrderHistoryRows } from '../utils/orderImportEngine.js'
import { summarizeReturnInspection } from '../utils/returnInspection.js'

const BASE = '/api'

const DEMO_PACKAGE = {
  id: 'demo-return',
  tracking_number: '1Z-RETURN-DEMO',
  store_name: 'Demo Store',
  order_numbers: ['PO-DEMO-1'],
  return_reasons: ['Too large'],
  buyer_remarks: ['Demo four-piece return'],
  carrier: 'UPS',
  status: 'pending',
  expected_units: 4,
  actual_units: 0,
  items: [
    { id: 'demo-black', sku_id: 'DEMO-SKU', sku_code: '62300SETM', style: '62300SET', color: 'BLACK', size: 'M', expected_qty: 1 },
    { id: 'demo-denim', sku_id: 'DEMO-SKU', sku_code: '62300SETM', style: '62300SET', color: 'DENIM', size: 'M', expected_qty: 1 },
    { id: 'demo-khaki', sku_id: 'DEMO-SKU', sku_code: '62300SETM', style: '62300SET', color: 'KHAKI', size: 'M', expected_qty: 1 },
    { id: 'demo-white', sku_id: 'DEMO-SKU', sku_code: '62300SETM', style: '62300SET', color: 'WHITE', size: 'M', expected_qty: 1 },
  ],
  related_orders: [{
    order_key: 'PO-DEMO-1',
    order_number: 'PO-DEMO-1',
    store_key: 'demo store',
    store_name: 'Demo Store',
    status: 'Delivered',
    items: [{
      id: 'demo-order-item',
      sku_id: 'DEMO-SKU',
      sku_code: '62300SETM',
      attributes: 'Black & Denim & Khaki & White / M',
      quantity: 1,
      outbound_trackings: ['1Z-OUTBOUND-DEMO'],
      catalog_components: [
        { style: '62300SET', color: 'BLACK', size: 'M', qty: 1 },
        { style: '62300SET', color: 'DENIM', size: 'M', qty: 1 },
        { style: '62300SET', color: 'KHAKI', size: 'M', qty: 1 },
        { style: '62300SET', color: 'WHITE', size: 'M', qty: 1 },
      ],
    }],
  }],
}

function headers(getToken, json = false) {
  return {
    Authorization: `Bearer ${getToken()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function statusBadge(status) {
  if (status === 'received') return 'bg-emerald-100 text-emerald-700'
  if (status === 'discrepancy') return 'bg-amber-100 text-amber-800'
  if (status === 'rejected') return 'bg-red-100 text-red-700'
  return 'bg-blue-100 text-blue-700'
}

function statusLabel(status) {
  if (status === 'received') return '✅ Received / Recibido'
  if (status === 'discrepancy') return '⚠️ Review / Revisar'
  if (status === 'rejected') return '❌ Not ours / No es nuestro'
  return 'Pending / Pendiente'
}

function sameSize(left, right) {
  const normalize = (value) => {
    const size = String(value || '').trim().toUpperCase()
    if (size === '1XL') return '1X'
    if (size === '2XL') return '2X'
    if (size === '3XL') return '3X'
    return size
  }
  return normalize(left) === normalize(right)
}

function CountControl({ value, onChange, disabled, max = 9999, label = 'Actual quantity' }) {
  const [error, setError] = useState('')

  const setValue = (next) => {
    const number = Number(next)
    if (!Number.isSafeInteger(number) || number < 0 || number > max) {
      setError(`Whole numbers only / Solo números (0–${max})`)
      return
    }
    setError('')
    onChange(number)
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`inline-flex items-center overflow-hidden rounded-xl border bg-white ${
        error ? 'border-red-300 ring-2 ring-red-100' : 'border-slate-200'
      }`}>
        <button
          type="button"
          disabled={disabled || value <= 0}
          onClick={() => setValue(value - 1)}
          className="flex h-11 w-11 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-30"
          aria-label="Decrease actual quantity"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={disabled}
          value={value}
          aria-invalid={Boolean(error)}
          aria-label={label}
          onChange={(event) => setValue(event.target.value)}
          className="h-11 w-16 border-x border-slate-200 text-center text-base font-semibold outline-none disabled:bg-slate-50"
        />
        <button
          type="button"
          disabled={disabled || value >= max}
          onClick={() => setValue(value + 1)}
          className="flex h-11 w-11 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-30"
          aria-label="Increase actual quantity"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {error && <p role="alert" className="text-[11px] font-medium text-red-600">{error}</p>}
    </div>
  )
}

function OrderDetails({ order, compact = false }) {
  if (!order) return null
  return (
    <div className={`rounded-xl border border-indigo-100 bg-indigo-50/60 ${compact ? 'p-3' : 'p-4 sm:p-5'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardList className="h-4 w-4 text-indigo-600" />
        <p className="font-semibold text-slate-900">{order.order_number}</p>
        {order.store_name && (
          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-indigo-700">
            {order.store_name}
          </span>
        )}
        {order.status && (
          <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">{order.status}</span>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {(order.items || []).map((item) => (
          <div key={item.id || `${item.sku_code}-${item.attributes}`} className="rounded-lg bg-white p-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-slate-800">{item.sku_code}</p>
                <p className="mt-0.5 text-xs text-slate-500">{item.attributes}</p>
                {item.sku_id && <p className="mt-1 text-[11px] text-slate-400">SKU ID {item.sku_id}</p>}
              </div>
              <span className="mt-1 shrink-0 text-sm font-bold text-indigo-700 sm:mt-0">
                Qty {Number(item.quantity || 0)}
              </span>
            </div>
            {Array.isArray(item.catalog_components) && item.catalog_components.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {item.catalog_components.map((component, index) => (
                  <span
                    key={`${component.style}-${component.color}-${component.size}-${index}`}
                    className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600"
                  >
                    {component.style} / {component.color} / {component.size}
                    {Number(component.qty || 1) > 1 ? ` ×${component.qty}` : ''}
                  </span>
                ))}
              </div>
            )}
            {item.outbound_trackings?.length > 0 && (
              <p className="mt-2 break-all text-[11px] text-slate-400">
                Original shipment: {item.outbound_trackings.join(' · ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ReturnsReceiving() {
  const { user, getToken } = useAuth()
  const toast = useToast()
  const demoMode = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('mock') === '1'
  const isAdmin = user?.role === 'admin' || demoMode
  const scannerRef = useRef(null)
  const [tab, setTab] = useState('receive')
  const [tracking, setTracking] = useState('')
  const [loading, setLoading] = useState(false)
  const [pkg, setPkg] = useState(null)
  const [counts, setCounts] = useState({})
  const [remark, setRemark] = useState('')
  const [counted, setCounted] = useState(false)
  const [recent, setRecent] = useState([])
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [orderCandidateQuantities, setOrderCandidateQuantities] = useState({})
  const [uploading, setUploading] = useState(false)
  const [stores, setStores] = useState([])
  const [storeName, setStoreName] = useState('')
  const [catalogFile, setCatalogFile] = useState(null)
  const [catalogParsed, setCatalogParsed] = useState(null)
  const [catalogInventoryRows, setCatalogInventoryRows] = useState([])
  const [catalogSelections, setCatalogSelections] = useState({})
  const [catalogAliases, setCatalogAliases] = useState({})
  const [catalogUploading, setCatalogUploading] = useState(false)
  const [analytics, setAnalytics] = useState(null)
  const [analyticsDays, setAnalyticsDays] = useState(30)
  const [orderOnly, setOrderOnly] = useState(null)
  const [orderChoices, setOrderChoices] = useState([])
  const [orderFile, setOrderFile] = useState(null)
  const [orderParsed, setOrderParsed] = useState(null)
  const [orderUploading, setOrderUploading] = useState(false)
  const [orderStats, setOrderStats] = useState([])

  const loadRecent = useCallback(async () => {
    if (demoMode) {
      setRecent([DEMO_PACKAGE])
      return
    }
    const res = await fetch(`${BASE}/returns?action=list`, { headers: headers(getToken) })
    const data = await res.json().catch(() => ({}))
    if (res.ok) setRecent(data.packages || [])
  }, [demoMode, getToken])

  const loadStores = useCallback(async () => {
    if (!isAdmin || demoMode) return
    const res = await fetch(`${BASE}/returns?action=stores`, { headers: headers(getToken) })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      setStores(data.stores || [])
      setStoreName((current) => current || data.stores?.[0]?.store_name || '')
    }
  }, [demoMode, getToken, isAdmin])

  useEffect(() => {
    loadRecent()
    loadStores()
    if (demoMode) {
      setPkg(DEMO_PACKAGE)
      setTracking(DEMO_PACKAGE.tracking_number)
      setCounts(Object.fromEntries(DEMO_PACKAGE.items.map((item) => [
        item.id,
        { good: 0, damaged: 0, notOurs: 0 },
      ])))
    }
    const frame = requestAnimationFrame(() => scannerRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [demoMode, loadRecent, loadStores])

  const lookup = useCallback(async (value = tracking, orderStore = '') => {
    const query = String(value || '').trim()
    if (!query) return
    if (demoMode) {
      setPkg(DEMO_PACKAGE)
      setTracking(DEMO_PACKAGE.tracking_number)
      setCounts(Object.fromEntries(DEMO_PACKAGE.items.map((item) => [
        item.id,
        { good: 0, damaged: 0, notOurs: 0 },
      ])))
      setCounted(false)
      setRemark('')
      return
    }
    setLoading(true)
    setPkg(null)
    setOrderOnly(null)
    setOrderChoices([])
    setCounted(false)
    setRemark('')
    try {
      const res = await fetch(`${BASE}/returns?action=lookup&tracking=${encodeURIComponent(query)}`, {
        headers: headers(getToken),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const orderRes = await fetch(
          `${BASE}/returns?action=order-lookup&order=${encodeURIComponent(query)}${
            orderStore ? `&store=${encodeURIComponent(orderStore)}` : ''
          }`,
          { headers: headers(getToken) },
        )
        const orderData = await orderRes.json().catch(() => ({}))
        if (orderRes.status === 409 && Array.isArray(orderData.stores)) {
          setOrderChoices(orderData.stores)
          setTracking(query)
          return
        }
        if (!orderRes.ok) throw new Error(orderData.error || data.error || 'Return package or order not found')
        setOrderOnly(orderData.order)
        setTracking(orderData.order.order_number)
        return
      }
      const next = data.package
      setPkg(next)
      setTracking(next.tracking_number)
      setCounts(Object.fromEntries(
        (next.items || []).map((item) => [
          item.id,
          next.status === 'pending'
            ? { good: 0, damaged: 0, notOurs: 0 }
            : {
                good: Number(item.restock_qty || 0),
                damaged: Math.max(Number(item.actual_qty || 0) - Number(item.restock_qty || 0), 0),
                notOurs: Number(item.not_ours_qty || 0),
              },
        ]),
      ))
      setRemark(next.remark || '')
    } catch (error) {
      toast.error(error.message, 'Tracking or Order Not Found')
      setTracking('')
      requestAnimationFrame(() => scannerRef.current?.focus())
    } finally {
      setLoading(false)
    }
  }, [demoMode, getToken, toast, tracking])

  const expectedUnits = Number(pkg?.expected_units || 0)
  const inspection = useMemo(() => summarizeReturnInspection((pkg?.items || []).map((item) => ({
    expectedQty: Number(item.expected_qty),
    goodQty: Number(counts[item.id]?.good || 0),
    damagedQty: Number(counts[item.id]?.damaged || 0),
    notOursQty: Number(counts[item.id]?.notOurs || 0),
  }))), [counts, pkg])
  const {
    actualUnits, restockUnits, damagedUnits, notOursUnits, categorizedUnits,
    hasDiscrepancy: discrepancy,
  } = inspection

  const confirmPackage = async () => {
    if (!pkg || pkg.status !== 'pending' || !counted || loading) return
    if (discrepancy) {
      const proceed = window.confirm(
        `Expected / Esperado: ${expectedUnits}\n` +
        `Good / Bueno: ${restockUnits}\nDamaged / Dañado: ${damagedUnits}\nNot ours / No es nuestro: ${notOursUnits}\n\n` +
        'Confirm these results? / ¿Confirmar estos resultados?'
      )
      if (!proceed) return
    }
    setLoading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=confirm`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({
          tracking: pkg.tracking_number,
          items: pkg.items.map((item) => ({
            id: item.id,
            actualQty: Number(counts[item.id]?.good || 0) + Number(counts[item.id]?.damaged || 0),
            restockQty: Number(counts[item.id]?.good || 0),
            notOursQty: Number(counts[item.id]?.notOurs || 0),
          })),
          remark,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not receive return package')
      const title = data.status === 'rejected'
        ? 'Not ours / No es nuestro'
        : data.status === 'discrepancy' ? 'Saved / Guardado' : 'Received / Recibido'
      toast.success(`${Number(data.added_units || 0)} added to inventory / agregado al inventario`, title)
      await lookup(pkg.tracking_number)
      await loadRecent()
    } catch (error) {
      toast.error(error.message, 'Receive Failed')
    } finally {
      setLoading(false)
    }
  }

  const parseFile = async (nextFile) => {
    setFile(nextFile)
    setParsed(null)
    setOrderCandidateQuantities({})
    if (!nextFile) return
    if (!storeName.trim()) {
      toast.error('Choose or enter a store before reading the return file', 'Store Required')
      return
    }
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await nextFile.arrayBuffer(), { type: 'array' })
      const sheetName = workbook.SheetNames.find((name) => name.trim().toUpperCase() === 'TEMU-STYLES')
        || workbook.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false, defval: '' })
      const hasSkuId = Object.keys(rows[0] || {}).some((key) =>
        ['sku id', 'skuid', 'sku_id'].includes(key.trim().toLowerCase())
      )
      let result
      if (hasSkuId) {
        const catalogRes = await fetch(
          `${BASE}/returns?action=catalog&store=${encodeURIComponent(storeName.trim())}`,
          { headers: headers(getToken) },
        )
        const catalogData = await catalogRes.json().catch(() => ({}))
        if (!catalogRes.ok) throw new Error(catalogData.error || 'Could not load this store’s product catalog')
        const historicalOrders = []
        const orderNumbers = getReturnManifestOrderNumbers(rows)
        for (let index = 0; index < orderNumbers.length; index += 500) {
          const orderRes = await fetch(`${BASE}/returns?action=orders-lookup`, {
            method: 'POST',
            headers: headers(getToken, true),
            body: JSON.stringify({
              storeName: storeName.trim(),
              orderNumbers: orderNumbers.slice(index, index + 500),
            }),
          })
          const orderData = await orderRes.json().catch(() => ({}))
          if (!orderRes.ok) throw new Error(orderData.error || 'Could not load matching order history')
          historicalOrders.push(...(orderData.orders || []))
        }
        result = parseSkuReturnManifestRows(rows, catalogData.rows || [], historicalOrders)
      } else {
        const parsedRows = parseReturnManifestRows(rows)
        const [inventoryRes, aliasesRes] = await Promise.all([
          fetch(`${BASE}/inventory-balance?action=list`, { headers: headers(getToken) }),
          fetch(`${BASE}/auto-deduct?action=aliases`, { headers: headers(getToken) }),
        ])
        const [inventoryData, aliasesData] = await Promise.all([
          inventoryRes.json().catch(() => ({})),
          aliasesRes.json().catch(() => ({})),
        ])
        if (!inventoryRes.ok) throw new Error(inventoryData.error || 'Could not load inventory targets')
        if (!aliasesRes.ok) throw new Error(aliasesData.error || 'Could not load confirmed SKU mappings')
        result = resolveReturnManifestPackages(
          parsedRows,
          (inventoryData.rows || []).map((row) => ({
            STYLE: row.Style,
            COLOR: row.Color,
            SIZE: row.Size,
          })),
          aliasesData.aliases || {},
        )
      }
      setParsed(result)
      if (result.needsReview.length) {
        toast.warning(
          `${result.stats.reviewPackages} packages need review and will be skipped; ready packages can still upload`,
          'Review Required',
        )
      }
    } catch (error) {
      toast.error(error.message, 'Could Not Read Return File')
    }
  }

  const uploadManifest = async () => {
    if (!parsed?.packages?.length || !storeName.trim() || uploading) return
    setUploading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=import`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({
          packages: parsed.packages,
          storeName: storeName.trim(),
          sourceFile: file?.name || '',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not upload return manifest')
      toast.success(
        `${data.imported_packages} packages · ${data.imported_units} expected units`,
        'Return Manifest Uploaded',
      )
      setFile(null)
      setParsed(null)
      await loadRecent()
      setTab('receive')
      requestAnimationFrame(() => scannerRef.current?.focus())
    } catch (error) {
      toast.error(error.message, 'Upload Failed')
    } finally {
      setUploading(false)
    }
  }

  const parseCatalogFile = async (nextFile) => {
    setCatalogFile(nextFile)
    setCatalogParsed(null)
    setCatalogSelections({})
    if (!nextFile) return
    if (!storeName.trim()) {
      toast.error('Enter the store name before reading its product file', 'Store Required')
      return
    }
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await nextFile.arrayBuffer(), { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' })
      const catalogRows = parseProductCatalogRows(rows)
      const [inventoryRes, aliasesRes] = await Promise.all([
        fetch(`${BASE}/inventory-balance?action=list`, { headers: headers(getToken) }),
        fetch(`${BASE}/auto-deduct?action=aliases`, { headers: headers(getToken) }),
      ])
      const [inventoryData, aliasesData] = await Promise.all([
        inventoryRes.json().catch(() => ({})),
        aliasesRes.json().catch(() => ({})),
      ])
      if (!inventoryRes.ok) throw new Error(inventoryData.error || 'Could not load inventory targets')
      if (!aliasesRes.ok) throw new Error(aliasesData.error || 'Could not load confirmed SKU mappings')
      const inventoryRows = (inventoryData.rows || []).map((row) => ({
        STYLE: row.Style,
        COLOR: row.Color,
        SIZE: row.Size,
      }))
      const resolved = resolveProductCatalogRows(
        catalogRows,
        inventoryRows,
        aliasesData.aliases || {},
      )
      setCatalogInventoryRows(inventoryRows)
      setCatalogAliases(aliasesData.aliases || {})
      setCatalogParsed({
        rows: resolved,
        ready: resolved.filter((row) => row.status === 'ready').length,
        review: resolved.filter((row) => row.status !== 'ready').length,
      })
    } catch (error) {
      toast.error(error.message, 'Could Not Read Product File')
    }
  }

  const catalogSelectionFor = (row, index) => {
    const selectionKey = `${row.skuId}:${index}`
    if (catalogSelections[selectionKey]) return catalogSelections[selectionKey]
    const source = row.sourceComponents?.[index]
    const learned = source ? catalogAliases[aliasKey(source.style, source.color)] : null
    if (!learned || learned.components || learned._isNew) return {}
    const exists = catalogInventoryRows.some((target) =>
      target.STYLE === learned.STYLE
      && target.COLOR === learned.COLOR
      && sameSize(target.SIZE, source.size)
    )
    return exists ? { style: learned.STYLE, color: learned.COLOR } : {}
  }

  const confirmCatalogMapping = async (row) => {
    try {
      const selections = (row.sourceComponents || []).map((_, index) =>
        catalogSelectionFor(row, index)
      )
      const result = applyProductCatalogMapping(
        catalogParsed.rows,
        row.skuId,
        selections,
        catalogInventoryRows,
      )
      const nextAliases = { ...catalogAliases }
      row.sourceComponents.forEach((source, index) => {
        nextAliases[aliasKey(source.style, source.color)] = {
          STYLE: selections[index].style,
          COLOR: selections[index].color,
          _confirmed: true,
        }
      })
      const aliasRes = await fetch(`${BASE}/auto-deduct?action=save-aliases`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({ aliases: nextAliases }),
      })
      const aliasData = await aliasRes.json().catch(() => ({}))
      if (!aliasRes.ok) throw new Error(aliasData.error || 'Could not save this confirmed mapping')
      const ready = result.rows.filter((item) => item.status === 'ready').length
      const review = result.rows.length - ready
      setCatalogAliases(nextAliases)
      setCatalogParsed({ rows: result.rows, ready, review })
      toast.success(
        `${result.updatedSkuIds.length} SKU size variant(s) completed`,
        'Product Mapping Saved in Preview',
      )
    } catch (error) {
      toast.error(error.message, 'Complete Product Mapping')
    }
  }

  const uploadCatalog = async () => {
    if (!catalogParsed?.rows?.length || !storeName.trim() || catalogUploading) return
    setCatalogUploading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=catalog-import`, {
        method: 'POST',
        headers: headers(getToken, true),
        body: JSON.stringify({
          storeName: storeName.trim(),
          sourceFile: catalogFile?.name || '',
          rows: catalogParsed.rows,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not upload product catalog')
      toast.success(
        `${data.ready_rows} ready · ${data.review_rows} need mapping review`,
        `${data.store_name} Product Catalog Updated`,
      )
      setCatalogFile(null)
      setCatalogParsed(null)
      await loadStores()
    } catch (error) {
      toast.error(error.message, 'Product Upload Failed')
    } finally {
      setCatalogUploading(false)
    }
  }

  const loadOrderStats = useCallback(async () => {
    if (!isAdmin || demoMode) return
    const res = await fetch(`${BASE}/returns?action=order-stats`, { headers: headers(getToken) })
    const data = await res.json().catch(() => ({}))
    if (res.ok) setOrderStats(data.stores || [])
  }, [demoMode, getToken, isAdmin])

  const parseOrderFile = async (nextFile) => {
    setOrderFile(nextFile)
    setOrderParsed(null)
    if (!nextFile) return
    if (!storeName.trim()) {
      toast.error('Enter the store name before reading its order history', 'Store Required')
      return
    }
    try {
      const bytes = await nextFile.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const sourceHash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(bytes, { type: 'array' })
      const sheetName = workbook.SheetNames.find((name) => name.trim().toUpperCase() === 'TEMU-STYLES')
        || workbook.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false, defval: '' })
      const result = parseOrderHistoryRows(rows)
      setOrderParsed({ ...result, sourceHash })
      if (result.conflicts.length) {
        toast.warning(
          `${result.conflicts.length} shared SKU货号 mappings will remain separate by platform SKU ID`,
          'SKU IDs Kept Separate',
        )
      } else if (result.skippedRows.length) {
        toast.warning(
          `${result.skippedRows.length} incomplete rows will be skipped`,
          'Incomplete Order Rows',
        )
      }
    } catch (error) {
      toast.error(error.message, 'Could Not Read Order File')
    }
  }

  const uploadOrders = async () => {
    if (!orderParsed?.orders?.length || !storeName.trim() || orderUploading) return
    setOrderUploading(true)
    try {
      const batches = []
      for (let index = 0; index < orderParsed.orders.length; index += 500) {
        batches.push(orderParsed.orders.slice(index, index + 500))
      }
      const totals = {
        newOrders: 0,
        existingOrders: 0,
        newItems: 0,
        existingItems: 0,
        conflicts: [],
      }
      for (let index = 0; index < batches.length; index += 1) {
        const res = await fetch(`${BASE}/returns?action=orders-import`, {
          method: 'POST',
          headers: headers(getToken, true),
          body: JSON.stringify({
            storeName: storeName.trim(),
            sourceFile: orderFile?.name || '',
            sourceHash: orderParsed.sourceHash,
            batchIndex: index,
            orders: batches[index],
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Could not upload order batch ${index + 1}`)
        totals.newOrders += Number(data.new_orders || 0)
        totals.existingOrders += Number(data.existing_orders || 0)
        totals.newItems += Number(data.new_items || 0)
        totals.existingItems += Number(data.existing_items || 0)
        totals.conflicts.push(...(data.conflicts || []))
      }
      if (totals.conflicts.length) {
        toast.warning(
          `${totals.conflicts.length} existing order items were different and were not overwritten`,
          'Order Conflicts Protected',
        )
      } else {
        toast.success(
          `${totals.newOrders.toLocaleString()} new · ${totals.existingOrders.toLocaleString()} already known`,
          `${storeName.trim()} Orders Imported`,
        )
      }
      setOrderFile(null)
      setOrderParsed(null)
      await Promise.all([loadOrderStats(), loadStores()])
    } catch (error) {
      toast.error(error.message, 'Order Upload Failed')
    } finally {
      setOrderUploading(false)
    }
  }

  const loadAnalytics = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    try {
      const res = await fetch(`${BASE}/returns?action=analytics&days=${analyticsDays}`, {
        headers: headers(getToken),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load return analytics')
      setAnalytics(data)
    } catch (error) {
      toast.error(error.message, 'Analytics Failed')
    } finally {
      setLoading(false)
    }
  }, [analyticsDays, getToken, isAdmin, toast])

  useEffect(() => {
    if (tab === 'analytics') loadAnalytics()
    if (tab === 'orders') loadOrderStats()
  }, [loadAnalytics, loadOrderStats, tab])

  const tabs = [
    { id: 'receive', label: 'Scan & Receive', shortLabel: 'Scan', icon: ScanLine },
    ...(isAdmin ? [
      { id: 'upload', label: 'Upload Manifest', shortLabel: 'Returns', icon: Upload },
      { id: 'catalog', label: 'Product Catalogs', shortLabel: 'Products', icon: Database },
      { id: 'orders', label: 'Order History', shortLabel: 'Orders', icon: ClipboardList },
      { id: 'analytics', label: 'Return Analytics', shortLabel: 'Stats', icon: BarChart3 },
    ] : []),
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Returns / Devoluciones</h2>
          <p className="mt-1 text-sm text-slate-500">
            Scan and check every item / Escanee y revise cada artículo
          </p>
        </div>
        <div className="flex w-full gap-1 rounded-xl border border-slate-200 bg-white p-1 sm:w-auto">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              onClick={() => setTab(item.id)}
              className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-[10px] font-medium sm:flex-none sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${
                tab === item.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <item.icon className="h-4 w-4" />
              <span className="sm:hidden">{item.shortLabel}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'receive' && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              lookup()
            }}
            className="card p-4 sm:p-5"
          >
            <label className="text-sm font-semibold text-slate-800" htmlFor="return-tracking">
              Scan return or find order / Escanear devolución o buscar pedido
            </label>
            <div className="mt-2 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={scannerRef}
                  id="return-tracking"
                  value={tracking}
                  onChange={(event) => setTracking(event.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="Tracking or order / Rastreo o pedido"
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-3 text-base outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <button type="submit" disabled={loading || !tracking.trim()} className="btn-primary h-12 px-4">
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="hidden sm:inline">Find / Buscar</span>
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Scanner or phone works here / Use escáner o teléfono aquí.
            </p>
          </form>

          {orderChoices.length > 0 && (
            <div className="card p-4 sm:p-5">
              <p className="text-sm font-semibold text-slate-800">
                This order number exists in more than one store. Choose the store:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {orderChoices.map((store) => (
                  <button
                    key={store}
                    type="button"
                    onClick={() => lookup(tracking, store)}
                    className="btn-secondary min-h-11 text-sm"
                  >
                    {store}
                  </button>
                ))}
              </div>
            </div>
          )}

          {orderOnly && (
            <div className="card p-4 sm:p-5">
              <OrderDetails order={orderOnly} />
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This finds the original order only. Scan or upload the return Tracking before receiving inventory.
              </div>
            </div>
          )}

          {pkg && (
            <div className="card overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <PackageOpen className="h-5 w-5 text-blue-600" />
                    <h3 className="font-semibold text-slate-900">{pkg.tracking_number}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(pkg.status)}`}>
                      {statusLabel(pkg.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Expected {expectedUnits} units · {pkg.items.length} SKU lines
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                    {pkg.store_name && <span className="rounded-md bg-slate-100 px-2 py-1">Store: {pkg.store_name}</span>}
                    {pkg.carrier && <span className="rounded-md bg-slate-100 px-2 py-1">Carrier: {pkg.carrier}</span>}
                    {(pkg.order_numbers || []).map((order) => (
                      <span key={order} className="rounded-md bg-slate-100 px-2 py-1">PO: {order}</span>
                    ))}
                  </div>
                  {(pkg.return_reasons?.length > 0 || pkg.buyer_remarks?.length > 0) && (
                    <div className="mt-2 space-y-1 text-xs text-slate-500">
                      {pkg.return_reasons?.length > 0 && <p><strong>Reason:</strong> {pkg.return_reasons.join(' · ')}</p>}
                      {pkg.buyer_remarks?.length > 0 && <p><strong>Buyer note:</strong> {pkg.buyer_remarks.join(' · ')}</p>}
                    </div>
                  )}
                </div>
                {pkg.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => setCounts(Object.fromEntries(
                      pkg.items.map((item) => [
                        item.id,
                        {
                          good: Number(item.expected_qty),
                          damaged: 0,
                          notOurs: 0,
                        },
                      ]),
                    ))}
                    className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 sm:w-auto"
                  >
                    <CheckCircle2 className="h-5 w-5" /> All Good / Todo bien
                  </button>
                )}
              </div>

              {pkg.related_orders?.length > 0 && (
                <div className="space-y-3 border-b border-slate-200 bg-white px-4 py-4 sm:px-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Original order contents
                  </p>
                  {pkg.related_orders.map((order) => (
                    <OrderDetails key={`${order.store_key}-${order.order_key}`} order={order} compact />
                  ))}
                </div>
              )}

              <div className="divide-y divide-slate-100">
                {pkg.items.map((item) => {
                  const expected = Number(item.expected_qty)
                  const good = Number(counts[item.id]?.good || 0)
                  const damaged = Number(counts[item.id]?.damaged || 0)
                  const notOurs = Number(counts[item.id]?.notOurs || 0)
                  const selected = good + damaged + notOurs
                  const setWholeOutcome = (outcome) => setCounts((current) => ({
                    ...current,
                    [item.id]: {
                      good: outcome === 'good' ? expected : 0,
                      damaged: outcome === 'damaged' ? expected : 0,
                      notOurs: outcome === 'notOurs' ? expected : 0,
                    },
                  }))
                  const setOutcomeCount = (outcome, value) => setCounts((current) => ({
                    ...current,
                    [item.id]: {
                      good: Number(current[item.id]?.good || 0),
                      damaged: Number(current[item.id]?.damaged || 0),
                      notOurs: Number(current[item.id]?.notOurs || 0),
                      [outcome]: value,
                    },
                  }))
                  return (
                    <div key={item.id} className="flex flex-col gap-4 px-4 py-5 sm:px-5">
                      <div className="min-w-0">
                        <p className="break-words text-base font-bold text-slate-900">
                          {item.style} / {item.color} / {item.size}
                        </p>
                        {(item.sku_id || item.sku_code) && (
                          <p className="mt-1 truncate text-xs text-slate-400">
                            SKU ID {item.sku_id || '—'} · {item.sku_code || '—'}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-slate-500">
                          Expected / Esperado: <strong>{item.expected_qty}</strong>
                          {pkg.status !== 'pending' && (
                            <>
                              {' '}· Good / Bueno: <strong>{item.restock_qty ?? 0}</strong>
                              {' '}· Damaged / Dañado: <strong>{Math.max(Number(item.actual_qty || 0) - Number(item.restock_qty || 0), 0)}</strong>
                              {' '}· Not ours / No es nuestro: <strong>{item.not_ours_qty ?? 0}</strong>
                            </>
                          )}
                        </p>
                      </div>
                      {pkg.status === 'pending' && (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <button type="button" onClick={() => setWholeOutcome('good')}
                              className={`min-h-20 rounded-xl border-2 px-2 py-3 text-center font-bold ${
                                good === expected ? 'border-emerald-700 bg-emerald-600 text-white ring-2 ring-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              }`}>
                              <CheckCircle2 className="mx-auto mb-1 h-7 w-7" />
                              <span className="block text-sm">GOOD</span>
                              <span className="block text-xs">BUENO</span>
                            </button>
                            <button type="button" onClick={() => setWholeOutcome('damaged')}
                              className={`min-h-20 rounded-xl border-2 px-2 py-3 text-center font-bold ${
                                damaged === expected ? 'border-amber-700 bg-amber-500 text-white ring-2 ring-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'
                              }`}>
                              <AlertTriangle className="mx-auto mb-1 h-7 w-7" />
                              <span className="block text-sm">DAMAGED</span>
                              <span className="block text-xs">DAÑADO</span>
                            </button>
                            <button type="button" onClick={() => setWholeOutcome('notOurs')}
                              className={`min-h-20 rounded-xl border-2 px-1 py-3 text-center font-bold ${
                                notOurs === expected ? 'border-red-800 bg-red-600 text-white ring-2 ring-red-200' : 'border-red-200 bg-red-50 text-red-800'
                              }`}>
                              <XCircle className="mx-auto mb-1 h-7 w-7" />
                              <span className="block text-sm">NOT OURS</span>
                              <span className="block text-xs">NO NUESTRO</span>
                            </button>
                          </div>
                          {expected > 1 && (
                            <div className="grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">
                              {[
                                ['good', 'Good / Bueno', good, expected - damaged - notOurs],
                                ['damaged', 'Damaged / Dañado', damaged, expected - good - notOurs],
                                ['notOurs', 'Not ours / No nuestro', notOurs, expected - good - damaged],
                              ].map(([key, label, value, max]) => (
                                <div key={key} className="flex items-center justify-between gap-2 sm:flex-col sm:items-start">
                                  <p className="text-xs font-bold text-slate-600">{label}</p>
                                  <CountControl
                                    label={label}
                                    value={value}
                                    max={max}
                                    onChange={(next) => setOutcomeCount(key, next)}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                          <p className={`text-xs font-semibold ${selected === expected ? 'text-emerald-700' : 'text-red-700'}`}>
                            {selected === expected
                              ? '✓ Complete / Completo'
                              : `${expected - selected} not selected / sin seleccionar`}
                          </p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              {pkg.status === 'pending' && (
                <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                  <div className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                    discrepancy
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  }`}>
                    {discrepancy
                      ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                    <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
                      <span className="font-semibold text-emerald-700">✅ Good / Bueno: {restockUnits}</span>
                      <span className="font-semibold text-amber-700">⚠️ Damaged / Dañado: {damagedUnits}</span>
                      <span className="font-semibold text-red-700">❌ Not ours / No nuestro: {notOursUnits}</span>
                      <span className="font-semibold text-slate-600">Unselected / Pendiente: {expectedUnits - categorizedUnits}</span>
                    </div>
                  </div>
                  <textarea
                    value={remark}
                    onChange={(event) => setRemark(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="Note / Nota (optional / opcional)"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={counted}
                      onChange={(event) => setCounted(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    I opened and checked every item. / Abrí y revisé cada artículo.
                  </label>
                  <button
                    type="button"
                    onClick={confirmPackage}
                    disabled={!counted || loading || categorizedUnits !== expectedUnits}
                    className={`mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-5 text-base font-bold text-white disabled:opacity-40 sm:w-auto sm:min-w-64 ${
                      notOursUnits > 0 && actualUnits === 0 ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
                    {notOursUnits > 0 && actualUnits === 0
                      ? '❌ Flag Not Ours / Marcar no nuestro'
                      : `✅ Confirm / Confirmar · ${restockUnits} to inventory`}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
              <h3 className="text-sm font-semibold text-slate-800">Recent return packages</h3>
              <button type="button" onClick={loadRecent} className="text-slate-400 hover:text-slate-700">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            {!recent.length ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">No return packages uploaded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recent.slice(0, 20).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      setTracking(item.tracking_number)
                      lookup(item.tracking_number)
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-700">{item.tracking_number}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {item.store_name ? `${item.store_name} · ` : ''}
                        {item.actual_units || 0} received · {item.restock_units || 0} restocked / {item.expected_units} expected
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'upload' && isAdmin && (
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-blue-50 p-2 text-blue-600">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Upload daily return manifest</h3>
              <p className="mt-1 text-sm text-slate-500">
                Select the store, then upload Tracking Number, SKU ID, PO, reason, buyer note, and carrier.
              </p>
            </div>
          </div>
          <label className="mt-5 block text-sm font-semibold text-slate-700">
            Store
            <input
              list="return-store-options"
              value={storeName}
              onChange={(event) => {
                setStoreName(event.target.value)
                setParsed(null)
              }}
              placeholder="Enter or choose store name"
              className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 sm:max-w-sm"
            />
            <datalist id="return-store-options">
              {stores.map((store) => <option key={store.store_key} value={store.store_name} />)}
            </datalist>
          </label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => parseFile(event.target.files?.[0] || null)}
            className="mt-5 block w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
          />

          {parsed && (
            <div className="mt-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xl font-bold text-slate-900">{parsed.stats.packageCount}</p>
                  <p className="text-xs text-slate-500">Packages ready</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xl font-bold text-slate-900">{parsed.stats.expectedUnits}</p>
                  <p className="text-xs text-slate-500">Expected units</p>
                </div>
                <div className={`rounded-xl p-3 ${parsed.stats.reviewPackages ? 'bg-amber-50' : 'bg-emerald-50'}`}>
                  <p className={`text-xl font-bold ${parsed.stats.reviewPackages ? 'text-amber-800' : 'text-emerald-700'}`}>
                    {parsed.stats.reviewPackages}
                  </p>
                  <p className="text-xs text-slate-500">Packages needing review</p>
                </div>
                <div className="rounded-xl bg-blue-50 p-3">
                  <p className="text-xl font-bold text-blue-800">
                    {Number(parsed.stats.waitingForTracking || 0)}
                  </p>
                  <p className="text-xs text-slate-500">Waiting for Tracking</p>
                </div>
              </div>

              {(parsed.pendingOrderMatches || []).map((match) => (
                <div key={match.tracking} className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 sm:p-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-indigo-900">
                        Choose returned SKUs for {match.trackingNumber}
                      </p>
                      <p className="mt-1 text-xs text-indigo-700">
                        The return file had no SKU ID. Set the quantity only for products included in this return.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    {match.candidateOrders.map((order) => (
                      <div key={order.orderKey} className="rounded-xl bg-white p-3">
                        <p className="text-xs font-semibold text-slate-500">
                          Original order {order.orderKey} · {order.candidates.length} SKU(s)
                        </p>
                        <div className="mt-2 divide-y divide-slate-100">
                          {order.candidates.map((candidate) => (
                            <div
                              key={candidate.candidateKey}
                              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <p className="break-words text-sm font-semibold text-slate-800">
                                  {candidate.skuCode || candidate.skuId || 'Unknown SKU'}
                                </p>
                                {candidate.attributes && (
                                  <p className="mt-0.5 text-xs text-slate-500">{candidate.attributes}</p>
                                )}
                                <p className="mt-1 text-[11px] text-slate-400">
                                  SKU ID {candidate.skuId || '—'} · Ordered {candidate.maxQuantity}
                                </p>
                                {candidate.status !== 'ready' && (
                                  <p className="mt-1 text-xs font-medium text-amber-700">
                                    Product mapping required: {candidate.issue}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center justify-between gap-3 sm:justify-end">
                                <span className="text-xs font-medium text-slate-500">Return qty</span>
                                <CountControl
                                  label={`Return quantity for ${candidate.skuCode || candidate.skuId}`}
                                  value={Number(orderCandidateQuantities[candidate.candidateKey] || 0)}
                                  max={Number.isSafeInteger(candidate.maxQuantity) ? candidate.maxQuantity : 0}
                                  disabled={candidate.status !== 'ready'}
                                  onChange={(value) => setOrderCandidateQuantities((current) => ({
                                    ...current,
                                    [candidate.candidateKey]: value,
                                  }))}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        const next = applyReturnOrderMatch(
                          parsed,
                          match.tracking,
                          orderCandidateQuantities,
                        )
                        setParsed(next)
                        toast.success(
                          `${next.packages.find((pkg) => pkg.tracking === match.tracking)?.expectedUnits || 0} expected units selected`,
                          'Order SKUs Confirmed',
                        )
                      } catch (error) {
                        toast.error(error.message, 'Choose Return SKUs')
                      }
                    }}
                    className="btn-primary mt-3 w-full justify-center py-3 sm:w-auto"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Confirm Selected SKUs
                  </button>
                </div>
              ))}

              {(parsed.waitingForTracking || []).length > 0 && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <p className="text-sm font-semibold text-blue-800">Waiting for Tracking</p>
                  <p className="mt-1 text-xs text-blue-700">
                    These rows are not errors. They will be skipped today and can be uploaded again after Tracking is updated.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-blue-800">
                    {parsed.waitingForTracking.slice(0, 10).map((row) => (
                      <li key={`${row.excelRow}-${row.orderNumber}`}>
                        Excel row {row.excelRow}: {row.skuId || 'Missing SKU'}
                        {row.orderNumber ? ` · PO ${row.orderNumber}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {parsed.needsReview.some((row) => row.parse_issue !== 'order_has_multiple_skus') && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-semibold text-amber-800">Review required for these packages</p>
                  <p className="mt-1 text-xs text-amber-700">
                    These packages will be skipped. Ready packages can still upload:
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-amber-800">
                    {parsed.needsReview
                      .filter((row) => row.parse_issue !== 'order_has_multiple_skus')
                      .slice(0, 10)
                      .map((row, index) => (
                      <li key={`${row.tracking}-${index}`}>
                        {row.tracking || `Excel row ${row.excelRow}`}: {row.skuId || row.raw_style || 'Missing SKU'} ({row.parse_issue})
                        {row.orderNumber ? ` · PO ${row.orderNumber}` : ''}
                      </li>
                      ))}
                  </ul>
                </div>
              )}

              {Number(parsed.stats.recoveredPackages || 0) > 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                  {parsed.stats.recoveredPackages} package(s) had missing SKU IDs and were completed from this store’s order history.
                  The original order quantities will be shown to the worker for physical verification.
                </div>
              )}

              <button
                type="button"
                onClick={uploadManifest}
                disabled={uploading || !parsed.packages.length || !storeName.trim()}
                className="btn-primary w-full justify-center py-3 disabled:opacity-50 sm:w-auto"
              >
                {uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload Return Manifest
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'catalog' && isAdmin && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-violet-50 p-2 text-violet-600">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Store product catalog</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Upload SKU ID and SKU货号 for one store. Existing SKU IDs update; new products are added immediately.
                </p>
              </div>
            </div>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              Store
              <input
                list="catalog-store-options"
                value={storeName}
                onChange={(event) => {
                  setStoreName(event.target.value)
                  setCatalogParsed(null)
                }}
                placeholder="Enter or choose store name"
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 sm:max-w-sm"
              />
              <datalist id="catalog-store-options">
                {stores.map((store) => <option key={store.store_key} value={store.store_name} />)}
              </datalist>
            </label>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => parseCatalogFile(event.target.files?.[0] || null)}
              className="mt-5 block w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-violet-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
            />
            {catalogParsed && (
              <div className="mt-5 space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ['File Rows', catalogParsed.rows.length],
                    ['Ready', catalogParsed.ready],
                    ['Need Review', catalogParsed.review],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xl font-bold text-slate-900">{value}</p>
                      <p className="text-xs text-slate-500">{label}</p>
                    </div>
                  ))}
                </div>
                {catalogParsed.review > 0 && (
                  <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3 sm:p-4">
                    <div>
                      <p className="text-sm font-semibold text-amber-900">
                        Complete unresolved SKUs before uploading
                      </p>
                      <p className="mt-1 text-xs text-amber-700">
                        Choose the exact inventory style and color for each source component.
                        A confirmed color combination automatically carries to its other available sizes.
                      </p>
                    </div>
                    {catalogParsed.rows.filter((row) => row.status !== 'ready').map((row) => (
                      <details key={row.skuId} className="overflow-hidden rounded-xl border border-amber-200 bg-white">
                        <summary className="cursor-pointer px-3 py-3">
                          <span className="block text-sm font-semibold text-slate-800">
                            {row.skuCode}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">
                            SKU ID {row.skuId} · {row.issue}
                          </span>
                        </summary>
                        <div className="space-y-3 border-t border-slate-100 p-3">
                          {!row.sourceComponents?.length ? (
                            <p className="text-xs text-amber-700">
                              This SKU could not be split into components. Check and correct its SKU货号 in the source file.
                            </p>
                          ) : (
                            row.sourceComponents.map((source, index) => {
                              const selectionKey = `${row.skuId}:${index}`
                              const selection = catalogSelectionFor(row, index)
                              const styleOptions = [...new Set(
                                catalogInventoryRows
                                  .filter((target) => sameSize(target.SIZE, source.size))
                                  .map((target) => target.STYLE),
                              )].sort()
                              const colorOptions = [...new Set(
                                catalogInventoryRows
                                  .filter((target) =>
                                    sameSize(target.SIZE, source.size)
                                    && target.STYLE === selection.style
                                  )
                                  .map((target) => target.COLOR),
                              )].sort()
                              return (
                                <div
                                  key={selectionKey}
                                  className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                                >
                                  <p className="text-xs font-semibold text-slate-700">
                                    Source: {source.style} / {source.color} / {source.size}
                                  </p>
                                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                    <label className="text-xs font-medium text-slate-500">
                                      Inventory style
                                      <select
                                        value={selection.style || ''}
                                        onChange={(event) => setCatalogSelections((current) => ({
                                          ...current,
                                          [selectionKey]: { style: event.target.value, color: '' },
                                        }))}
                                        className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700"
                                      >
                                        <option value="">Choose style</option>
                                        {styleOptions.map((style) => (
                                          <option key={style} value={style}>{style}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label className="text-xs font-medium text-slate-500">
                                      Inventory color
                                      <select
                                        value={selection.color || ''}
                                        disabled={!selection.style}
                                        onChange={(event) => setCatalogSelections((current) => ({
                                          ...current,
                                          [selectionKey]: {
                                            style: selection.style,
                                            color: event.target.value,
                                          },
                                        }))}
                                        className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 disabled:bg-slate-100"
                                      >
                                        <option value="">Choose color</option>
                                        {colorOptions.map((color) => (
                                          <option key={color} value={color}>{color}</option>
                                        ))}
                                      </select>
                                    </label>
                                  </div>
                                </div>
                              )
                            })
                          )}
                          <button
                            type="button"
                            disabled={!row.sourceComponents?.length}
                            onClick={() => confirmCatalogMapping(row)}
                            className="btn-primary w-full justify-center py-3 disabled:opacity-50 sm:w-auto"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Confirm This SKU Combination
                          </button>
                        </div>
                      </details>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={uploadCatalog}
                  disabled={catalogUploading || !storeName.trim()}
                  className="btn-primary w-full justify-center py-3 disabled:opacity-50 sm:w-auto"
                >
                  {catalogUploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Update {storeName.trim() || 'Store'} Catalog
                </button>
              </div>
            )}
          </div>

          {stores.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {stores.map((store) => (
                <div key={store.store_key} className="card p-4">
                  <p className="font-semibold text-slate-800">{store.store_name}</p>
                  <p className="mt-1 text-sm text-slate-500">
                    {Number(store.ready_count || 0).toLocaleString()} ready / {Number(store.product_count || 0).toLocaleString()} products
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'orders' && isAdmin && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <ClipboardList className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Historical order data</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Choose one store, then upload its TEMU CSV or daily order workbook. Buyer names, phones, emails, and addresses are discarded before upload.
                </p>
              </div>
            </div>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              Store
              <input
                list="order-store-options"
                value={storeName}
                onChange={(event) => {
                  setStoreName(event.target.value)
                  setOrderParsed(null)
                }}
                placeholder="House, Garden, Medley…"
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 sm:max-w-sm"
              />
              <datalist id="order-store-options">
                {stores.map((store) => <option key={store.store_key} value={store.store_name} />)}
              </datalist>
            </label>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => parseOrderFile(event.target.files?.[0] || null)}
              className="mt-5 block w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
            />

            {orderParsed && (
              <div className="mt-5 space-y-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    ['Orders', orderParsed.stats.orderCount],
                    ['SKU Lines', orderParsed.stats.itemCount],
                    ['Units', orderParsed.stats.unitCount],
                    ['Conflicts', orderParsed.stats.conflicts],
                  ].map(([label, value]) => (
                    <div key={label} className={`rounded-xl p-3 ${
                      label === 'Conflicts' && Number(value) > 0 ? 'bg-red-50' : 'bg-slate-50'
                    }`}>
                      <p className="text-xl font-bold text-slate-900">{Number(value).toLocaleString()}</p>
                      <p className="text-xs text-slate-500">{label}</p>
                    </div>
                  ))}
                </div>
                {(orderParsed.stats.earliestOrder || orderParsed.stats.latestOrder) && (
                  <p className="text-xs text-slate-500">
                    File range:{' '}
                    {orderParsed.stats.earliestOrder
                      ? new Date(orderParsed.stats.earliestOrder).toLocaleDateString()
                      : 'Unknown'}
                    {' '}–{' '}
                    {orderParsed.stats.latestOrder
                      ? new Date(orderParsed.stats.latestOrder).toLocaleDateString()
                      : 'Unknown'}
                  </p>
                )}
                {orderParsed.skippedRows.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    {orderParsed.skippedRows.length} incomplete rows will be skipped. No buyer PII is retained.
                  </div>
                )}
                {orderParsed.conflicts.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <p className="text-sm font-semibold text-amber-800">
                      These rows share a SKU货号 but have different platform SKU IDs. They will remain separate.
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-amber-700">
                      {orderParsed.conflicts.slice(0, 10).map((item, index) => (
                        <li key={`${item.orderNumber}-${index}`}>
                          {item.orderNumber} · {item.skuCode} · {item.existingSkuId} / {item.incomingSkuId}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  onClick={uploadOrders}
                  disabled={orderUploading || !storeName.trim()}
                  className="btn-primary w-full justify-center py-3 disabled:opacity-50 sm:w-auto"
                >
                  {orderUploading
                    ? <RefreshCw className="h-4 w-4 animate-spin" />
                    : <Upload className="h-4 w-4" />}
                  Import {orderParsed.stats.orderCount.toLocaleString()} {storeName.trim() || 'Store'} Orders
                </button>
              </div>
            )}
          </div>

          {orderStats.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {orderStats.map((store) => (
                <div key={store.store_key} className="card p-4">
                  <p className="font-semibold text-slate-800">{store.store_name}</p>
                  <p className="mt-1 text-sm text-slate-500">
                    {Number(store.order_count || 0).toLocaleString()} orders ·{' '}
                    {Number(store.unit_count || 0).toLocaleString()} units
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {store.earliest_order
                      ? new Date(store.earliest_order).toLocaleDateString()
                      : 'No dated orders'}
                    {' '}–{' '}
                    {store.latest_order
                      ? new Date(store.latest_order).toLocaleDateString()
                      : 'Now'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'analytics' && isAdmin && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <select
              value={analyticsDays}
              onChange={(event) => setAnalyticsDays(Number(event.target.value))}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </select>
            <button type="button" onClick={loadAnalytics} className="btn-secondary text-sm">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {analytics && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {[
                  ['Received Packages', analytics.summary.received_packages],
                  ['Discrepancy Packages', analytics.summary.discrepancy_packages],
                  ['Not Ours / Flagged', analytics.summary.flagged_packages],
                  ['Actual Returned Units', analytics.summary.returned_units],
                  ['Restocked Units', analytics.summary.restocked_units],
                  ['Sold Units', analytics.summary.sold_units],
                  ['Total Return Rate', analytics.summary.total_return_rate == null
                    ? '—'
                    : `${Number(analytics.summary.total_return_rate).toFixed(2)}%`],
                ].map(([label, value]) => (
                  <div key={label} className="card p-4">
                    <p className="text-2xl font-bold text-slate-900">
                      {typeof value === 'number' ? value.toLocaleString() : value}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{label}</p>
                  </div>
                ))}
              </div>
              <div className="card overflow-hidden">
                <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
                  <h3 className="text-sm font-semibold text-slate-800">Returns by store</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Store counts are shown separately; the total return rate above combines every store.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Store</th>
                        <th className="px-4 py-3 text-right">Packages</th>
                        <th className="px-4 py-3 text-right">Discrepancies</th>
                        <th className="px-4 py-3 text-right">Not Ours</th>
                        <th className="px-4 py-3 text-right">Returned</th>
                        <th className="px-4 py-3 text-right">Restocked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(analytics.stores || []).map((store) => (
                        <tr key={store.store_name}>
                          <td className="px-4 py-3 font-medium text-slate-800">{store.store_name}</td>
                          <td className="px-4 py-3 text-right">{store.received_packages}</td>
                          <td className="px-4 py-3 text-right">{store.discrepancy_packages}</td>
                          <td className="px-4 py-3 text-right font-semibold text-red-700">{store.flagged_packages}</td>
                          <td className="px-4 py-3 text-right font-semibold text-blue-700">{store.returned_units}</td>
                          <td className="px-4 py-3 text-right font-semibold text-emerald-700">{store.restocked_units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card overflow-hidden">
                <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
                  <h3 className="text-sm font-semibold text-slate-800">Return rate by SKU</h3>
                  <p className="mt-1 text-xs text-slate-400">Actual received units ÷ sold units in the selected period</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Style</th>
                        <th className="px-4 py-3">Color</th>
                        <th className="px-4 py-3">Size</th>
                        <th className="px-4 py-3 text-right">Sold</th>
                        <th className="px-4 py-3 text-right">Returned</th>
                        <th className="px-4 py-3 text-right">Return Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(analytics.rows || []).map((row, index) => (
                        <tr key={`${row.style}-${row.color}-${row.size}-${index}`}>
                          <td className="px-4 py-3 font-medium text-slate-800">{row.style}</td>
                          <td className="px-4 py-3 text-slate-600">{row.color}</td>
                          <td className="px-4 py-3 text-slate-600">{row.size}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{row.sold_qty}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-blue-700">{row.returned_qty}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold">
                            {row.return_rate == null ? '—' : `${Number(row.return_rate).toFixed(2)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
