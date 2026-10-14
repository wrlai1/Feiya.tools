import exportSizes from '../../lib/inventoryExportSizes.cjs'
import React, { useMemo, useState } from 'react'
import { X, Download, Upload, RefreshCw } from 'lucide-react'

const key = (style, color, size) => [style, color, String(size || '').trim().toUpperCase().replace(/^([1-5])XL$/, '$1X')].map((v) => String(v || '').trim().toUpperCase()).join('|')
const sortRows = (a, b) => a.style.localeCompare(b.style, undefined, { numeric: true }) || a.color.localeCompare(b.color, undefined, { numeric: true }) || exportSizes.compareExportSizes(a.size, b.size)

export default function InventoryReceipt({ inventory, getToken, onClose, onDone }) {
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
      const known = new Map(inventory.map((r) => [key(r.Style, r.Color, r.Size), r]))
      const seen = new Set(), additions = []
      for (const [index, row] of source.entries()) {
        const value = row['Received Quantity']
        if (value === '' || value == null || String(value).trim() === '') continue
        const quantity = Number(value)
        if (!['string', 'number'].includes(typeof value) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647) throw new Error(`Row ${index + 2}: 入库数量必须是非负整数`)
        if (!quantity) continue
        const sku = key(row.Style, row.Color, row.Size)
        const current = known.get(sku)
        const chosen = selected.find(s => s.toUpperCase() === String(row.Style || '').trim().toUpperCase())
        const color = String(row.Color || '').trim(), size = String(row.Size || '').trim().toUpperCase()
        if (!chosen || !color || !size) throw new Error(`Row ${index + 2}: 请填完整的所选款式、颜色、尺码`)
        if (!current && !inventory.some(r => r.Style === chosen && key(chosen, '', r.Size) === key(chosen, '', size))) throw new Error(`Row ${index + 2}: 尺码不属于所选款式，请核对模板`)
        if (!current && inventory.some(r => r.Style === chosen && r.Color.trim().toUpperCase() === color.toUpperCase())) throw new Error(`Row ${index + 2}: 已有颜色下的尺码组合不存在，请核对模板`)
        if (seen.has(sku)) throw new Error(`Row ${index + 2}: 颜色和尺码重复`)
        seen.add(sku)
        additions.push({ id: current?.id ?? null, style: current?.Style || chosen, color: current?.Color || color, size: current?.Size || size, quantity, current: current ? current.RawQuantity ?? current.Quantity : 0, isNew: !current })
      }
      if (!additions.length) throw new Error('请在 Received Quantity 栏填写本次入库数量')
      setRows(additions.sort(sortRows))
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
    <p className="mb-4 text-sm text-slate-600">选择款式下载模板，填写本次入库件数后上传。数量会加到现有库存，空白和 0 不入库。</p>
    <p className="mb-2 text-sm">已选 {selected.length} 个款式；新颜色可复制对应款式的行到模板末尾，修改颜色、填写数量；尺码沿用该款式现有尺码。</p>
    <input aria-label="搜索入库款式" placeholder="搜索款式" value={search} onChange={e => setSearch(e.target.value)} className="mb-2 w-full rounded-lg border p-2" />
    <div className="mb-3 grid max-h-40 grid-cols-2 gap-2 overflow-auto rounded-lg border p-3">{styles.filter(s => s.toLowerCase().includes(search.toLowerCase())).map(s => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(s)} onChange={e => { setSelected(e.target.checked ? [...selected, s] : selected.filter(v => v !== s)); setRows([]); setError('') }} />{s}</label>)}</div>
    <label className="block text-sm">入库单号<input aria-label="入库单号" disabled={busy} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="例如采购单号或本次到货编号；每批货使用不同编号" className="mb-4 mt-1 w-full rounded-lg border p-2" /></label>
    <div className="flex gap-3"><button disabled={busy || !selected.length} onClick={download} className="btn-secondary"><Download className="h-4 w-4" />下载款式模板</button><label className="btn-secondary cursor-pointer"><Upload className="h-4 w-4" />上传已填模板<input aria-label="上传进货模板" className="sr-only" disabled={busy} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} /></label></div>
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    {!!rows.length && <><p className="my-4 font-semibold">{rows.length} 个 SKU，共入库 {rows.reduce((s, r) => s + r.quantity, 0)} 件</p><p className="mb-2 text-xs text-slate-500">预计库存供核对；确认时按系统最新库存累加。</p><table className="w-full text-sm"><thead><tr>{['款式', '颜色', '尺码', '当前库存', '本次入库', '预计库存'].map((h) => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{rows.map((r) => <tr key={key(r.style, r.color, r.size)} className="border-t"><td className="p-2">{r.style}</td><td className="p-2">{r.color}{r.isNew && <span className="ml-2 text-xs text-emerald-700">新颜色</span>}</td><td>{r.size}</td><td>{r.current}</td><td>{r.quantity}</td><td>{Number(r.current) + r.quantity}</td></tr>)}</tbody></table><button disabled={busy || !reference.trim()} onClick={confirm} className="btn-primary mt-5">{busy && <RefreshCw className="h-4 w-4 animate-spin" />}确认批量入库</button></>}
  </div></div>
}
