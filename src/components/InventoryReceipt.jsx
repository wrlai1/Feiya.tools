import { parseInventoryReceiptRows, receiptSkuKey as key, sortReceiptRows as sortRows } from '../utils/inventoryReceiptUpload.js'
import React, { useMemo, useState } from 'react'
import { X, Download, Upload, RefreshCw } from 'lucide-react'

export default function InventoryReceipt({ inventory, styleAliases = {}, colorAliases = {}, getToken, onClose, onDone }) {
  const styles = useMemo(() => [...new Set(inventory.map((r) => r.Style))].sort(), [inventory])
  const [selected, setSelected] = useState([])
  const [search, setSearch] = useState('')
  const [reference, setReference] = useState('')
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const download = async () => {
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.utils.book_new()
      const items = inventory.filter((r) => selected.includes(r.Style)).map(r => ({ style: r.Style, color: r.Color, size: r.Size })).sort(sortRows).map(r => ({ Style: r.style, Color: r.color, Size: r.size, 'Received Quantity': '' }))
      const sheet = XLSX.utils.json_to_sheet(items)
      sheet['!cols'] = [{ wch: 22 }, { wch: 35 }, { wch: 12 }, { wch: 22 }]
      XLSX.utils.book_append_sheet(workbook, sheet, 'Goods Receipt')
      XLSX.writeFile(workbook, `goods_receipt_${selected.length}_styles.xlsx`)
    } catch (e) { setError(e.message) }
  }
  const upload = async (file) => {
    if (!file) return
    setBusy(true); setError(''); setRows([])
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const source = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })
      const additions = parseInventoryReceiptRows(source, inventory, styleAliases, colorAliases)
      setRows(additions)
      setSelected([...new Set(additions.map(row => row.style))])
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/inventory-balance?action=receive', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ reference, rows }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '入库失败')
      await onDone(); onClose()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div role="dialog" aria-label="批量进货入库" className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6 shadow-xl">
    <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-semibold">批量进货入库 / Goods Receipt</h3><button aria-label="关闭入库窗口" disabled={busy} onClick={onClose}><X /></button></div>
    <p className="mb-4 text-sm text-slate-600">选择款式下载模板，填写本次入库件数后上传。上传会自动识别文件中的款式，无需重新勾选。数量加到现有库存，空白和 0 不入库。</p>
    <p className="mb-2 text-sm">已选 {selected.length} 个款式；新颜色可复制对应款式的行到模板末尾，修改颜色、填写数量；尺码沿用该款式现有尺码。</p>
    <input aria-label="搜索入库款式" placeholder="搜索款式" value={search} onChange={e => setSearch(e.target.value)} className="mb-2 w-full rounded-lg border p-2" />
    <div className="mb-3 grid max-h-40 grid-cols-2 gap-2 overflow-auto rounded-lg border p-3">{styles.filter(s => s.toLowerCase().includes(search.toLowerCase())).map(s => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(s)} onChange={e => { setSelected(e.target.checked ? [...selected, s] : selected.filter(v => v !== s)); setRows([]); setError('') }} />{s}</label>)}</div>
    <label className="block text-sm">入库单号<input aria-label="入库单号" disabled={busy} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="例如采购单号或本次到货编号；每批货使用不同编号" className="mb-4 mt-1 w-full rounded-lg border p-2" /></label>
    <div className="flex gap-3"><button disabled={busy || !selected.length} onClick={download} className="btn-secondary"><Download className="h-4 w-4" />下载款式模板</button><label className="btn-secondary cursor-pointer"><Upload className="h-4 w-4" />上传已填模板<input aria-label="上传进货模板" className="sr-only" disabled={busy} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} /></label></div>
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    {!!rows.length && <><p className="my-4 font-semibold">{rows.length} 个 SKU，共入库 {rows.reduce((s, r) => s + r.quantity, 0)} 件</p><p className="mb-2 text-xs text-slate-500">预计库存供核对；确认时按系统最新库存累加。</p><table className="w-full text-sm"><thead><tr>{['款式', '颜色', '尺码', '当前库存', '本次入库', '预计库存'].map((h) => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{rows.map((r) => <tr key={key(r.style, r.color, r.size)} className="border-t"><td className="p-2">{r.style}</td><td className="p-2">{r.color}{r.isNew && <span className="ml-2 text-xs text-emerald-700">新颜色</span>}</td><td>{r.size}</td><td>{r.current}</td><td>{r.quantity}</td><td>{Number(r.current) + r.quantity}</td></tr>)}</tbody></table><button disabled={busy || !reference.trim()} onClick={confirm} className="btn-primary mt-5">{busy && <RefreshCw className="h-4 w-4 animate-spin" />}确认批量入库</button></>}
  </div></div>
}
