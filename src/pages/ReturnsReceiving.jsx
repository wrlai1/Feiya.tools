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
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import {
  applyReturnOrderMatch,
  getReturnManifestOrderNumbers,
  parseProductCatalogRows,
  parseReturnManifestRows,
  parseSkuReturnManifestRows,
  resolveProductCatalogRows,
  resolveReturnManifestPackages,
} from '../utils/returnImportEngine.js'
import { parseOrderHistoryRows } from '../utils/orderImportEngine.js'

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
  return 'bg-blue-100 text-blue-700'
}

function statusLabel(status) {
  if (status === 'received') return 'Received'
  if (status === 'discrepancy') return 'Discrepancy'
  return 'Pending'
}

function CountControl({ value, onChange, disabled, max = 9999, label = 'Actual quantity' }) {
  const [error, setError] = useState('')

  const setValue = (next) => {
    const number = Number(next)
    if (!Number.isSafeInteger(number) || number < 0 || number > max) {
      setError(`Whole numbers only (0–${max})`)
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
        { actual: 0, restock: 0 },
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
        { actual: 0, restock: 0 },
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
            ? { actual: 0, restock: 0 }
            : {
                actual: Number(item.actual_qty || 0),
                restock: Number(item.restock_qty || 0),
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
  const actualUnits = useMemo(
    () => Object.values(counts).reduce((sum, value) => sum + (Number(value.actual) || 0), 0),
    [counts],
  )
  const restockUnits = useMemo(
    () => Object.values(counts).reduce((sum, value) => sum + (Number(value.restock) || 0), 0),
    [counts],
  )
  const discrepancy = Boolean(pkg?.items?.some((item) =>
    Number(counts[item.id]?.actual || 0) !== Number(item.expected_qty)
    || Number(counts[item.id]?.restock || 0) !== Number(counts[item.id]?.actual || 0)
  ))

  const confirmPackage = async () => {
    if (!pkg || pkg.status !== 'pending' || !counted || loading) return
    if (discrepancy) {
      const proceed = window.confirm(
        `Expected ${expectedUnits}, received ${actualUnits}, and ${restockUnits} are resellable.\n\n` +
        'Only resellable units will be added to inventory. Save this package as a discrepancy?'
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
            actualQty: Number(counts[item.id]?.actual || 0),
            restockQty: Number(counts[item.id]?.restock || 0),
          })),
          remark,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not receive return package')
      toast.success(
        `${Number(data.added_units || 0).toLocaleString()} resellable units added to inventory`,
        data.status === 'discrepancy' ? 'Discrepancy Recorded' : 'Return Received',
      )
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
      const resolved = resolveProductCatalogRows(
        catalogRows,
        (inventoryData.rows || []).map((row) => ({
          STYLE: row.Style,
          COLOR: row.Color,
          SIZE: row.Size,
        })),
        aliasesData.aliases || {},
      )
      setCatalogParsed({
        rows: resolved,
        ready: resolved.filter((row) => row.status === 'ready').length,
        review: resolved.filter((row) => row.status !== 'ready').length,
      })
    } catch (error) {
      toast.error(error.message, 'Could Not Read Product File')
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
          <h2 className="text-xl font-bold text-slate-900">Returns Receiving</h2>
          <p className="mt-1 text-sm text-slate-500">
            Scan, count, compare, and restock only what is physically returned
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
              Scan return package or find an order
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
                  placeholder="Scan tracking or enter order number"
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-3 text-base outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <button type="submit" disabled={loading || !tracking.trim()} className="btn-primary h-12 px-4">
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="hidden sm:inline">Find</span>
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              USB and Bluetooth scanners work as keyboard input. An exact order number can also show the original SKUs.
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
                          actual: Number(item.expected_qty),
                          restock: Number(item.expected_qty),
                        },
                      ]),
                    ))}
                    className="btn-secondary w-full justify-center text-sm sm:w-auto"
                  >
                    <CheckCircle2 className="h-4 w-4" /> All present & resellable
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
                  const actual = Number(counts[item.id]?.actual || 0)
                  const restock = Number(counts[item.id]?.restock || 0)
                  const differs = actual !== Number(item.expected_qty)
                  const notResellable = actual !== restock
                  return (
                    <div key={item.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">
                          {item.style} / {item.color} / {item.size}
                        </p>
                        {(item.sku_id || item.sku_code) && (
                          <p className="mt-1 truncate text-xs text-slate-400">
                            SKU ID {item.sku_id || '—'} · {item.sku_code || '—'}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-slate-500">
                          Expected: <strong>{item.expected_qty}</strong>
                          {pkg.status !== 'pending' && (
                            <>
                              {' '}· Received: <strong>{item.actual_qty ?? 0}</strong>
                              {' '}· Restocked: <strong>{item.restock_qty ?? 0}</strong>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:items-end">
                        {pkg.status === 'pending' && (
                          <span className={`text-xs font-semibold ${differs || notResellable ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {differs
                              ? `Difference ${actual - Number(item.expected_qty)}`
                              : notResellable
                                ? `${actual - restock} not resellable`
                                : 'Matches'}
                          </span>
                        )}
                        <div className="flex flex-wrap items-start justify-between gap-3 sm:justify-end">
                          <div>
                            <p className="mb-1 text-[11px] font-medium text-slate-500">Physically received</p>
                            <CountControl
                              label="Physically received quantity"
                              value={actual}
                              disabled={pkg.status !== 'pending'}
                              onChange={(value) => setCounts((current) => ({
                                ...current,
                                [item.id]: {
                                  actual: value,
                                  restock: Math.min(Number(current[item.id]?.restock || 0), value),
                                },
                              }))}
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-[11px] font-medium text-slate-500">Resellable</p>
                            <CountControl
                              label="Resellable quantity"
                              value={restock}
                              max={actual}
                              disabled={pkg.status !== 'pending'}
                              onChange={(value) => setCounts((current) => ({
                                ...current,
                                [item.id]: {
                                  actual: Number(current[item.id]?.actual || 0),
                                  restock: value,
                                },
                              }))}
                            />
                          </div>
                        </div>
                      </div>
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
                    <span>
                      Received <strong>{actualUnits}</strong> of <strong>{expectedUnits}</strong> expected;
                      {' '}<strong>{restockUnits}</strong> are resellable.
                      {discrepancy && ' Only resellable units will be added to inventory.'}
                    </span>
                  </div>
                  <textarea
                    value={remark}
                    onChange={(event) => setRemark(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="Optional note: missing item, wrong item, damaged item…"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={counted}
                      onChange={(event) => setCounted(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    I opened this package and physically counted every listed item.
                  </label>
                  <button
                    type="button"
                    onClick={confirmPackage}
                    disabled={!counted || loading}
                    className="btn-primary mt-4 w-full justify-center py-3 text-sm disabled:opacity-50 sm:w-auto sm:min-w-52"
                  >
                    {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
                    Add {restockUnits} Resellable Units to Inventory
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
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <p className="text-sm font-semibold text-amber-800">
                      Unresolved SKUs will be saved for review but cannot receive inventory yet.
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-amber-700">
                      {catalogParsed.rows.filter((row) => row.status !== 'ready').slice(0, 10).map((row) => (
                        <li key={row.skuId}>{row.skuId}: {row.skuCode} ({row.issue})</li>
                      ))}
                    </ul>
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
                  <table className="w-full min-w-[620px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Store</th>
                        <th className="px-4 py-3 text-right">Packages</th>
                        <th className="px-4 py-3 text-right">Discrepancies</th>
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
