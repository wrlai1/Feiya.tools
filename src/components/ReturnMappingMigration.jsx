import React, { useEffect, useState } from 'react'
import { X, RefreshCw } from 'lucide-react'

export default function ReturnMappingMigration({ storeName, getToken, onClose, onDone }) {
  const [allStores, setAllStores] = useState(false)
  const [fromStyle, setFromStyle] = useState('')
  const [toStyle, setToStyle] = useState('')
  const [sources, setSources] = useState([])
  const [targets, setTargets] = useState([])
  const [plan, setPlan] = useState(null)
  const [ids, setIds] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = async (action, body) => {
    const response = await fetch(`/api/returns?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '匹配迁移失败')
    return data
  }
  useEffect(() => {
    let active = true
    setBusy(true); setPlan(null); setIds([]); setError('')
    request('catalog-migrate-preview', { storeName, allStores }).then(data => { if (active) { setSources(data.sourceStyles); setTargets(data.targetStyles) } }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [storeName, allStores])
  const preview = async () => {
    setBusy(true); setError(''); setPlan(null)
    try {
      const data = await request('catalog-migrate-preview', { storeName, allStores, fromStyle, toStyle })
      setPlan(data); setIds(data.rows.filter(r => !r.issues.length).map(r => r.id))
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true); setError('')
    try {
      await request('catalog-migrate-apply', { storeName, allStores, fromStyle, toStyle, ids, token: plan.token })
      await onDone(plan.rows.filter(row => ids.includes(row.id))); onClose()
    } catch (e) { setError(e.message); setPlan(null); setIds([]) }
    finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div role="dialog" aria-label="批量更换退货匹配" className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-6 shadow-xl">
    <div className="mb-3 flex items-center justify-between"><h3 className="text-lg font-semibold">批量更换退货匹配</h3><button aria-label="关闭匹配迁移" disabled={busy} onClick={onClose}><X /></button></div>
    <p className="mb-4 text-sm text-slate-600">更换库存款式，保留对应颜色、尺码和件数。同步已选 SKU 的未确认包裹；已入库退货和库存数量保留。</p>
    <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={allStores} disabled={busy} onChange={e => setAllStores(e.target.checked)} />所有店铺（默认仅 {storeName}）</label>
    <div className="grid gap-3 sm:grid-cols-2"><label>原匹配款式<select aria-label="原匹配款式" disabled={busy} className="mt-1 w-full rounded-lg border p-2" value={fromStyle} onChange={e => { setFromStyle(e.target.value); setPlan(null); setIds([]) }}><option value="">请选择旧款式</option>{sources.map(s => <option key={s}>{s}</option>)}</select></label><label>新库存款式<select aria-label="新库存款式" disabled={busy} className="mt-1 w-full rounded-lg border p-2" value={toStyle} onChange={e => { setToStyle(e.target.value); setPlan(null); setIds([]) }}><option value="">请选择新款式</option>{targets.map(s => <option key={s}>{s}</option>)}</select></label></div>
    <button disabled={busy || !fromStyle || !toStyle || fromStyle === toStyle} onClick={preview} className="btn-secondary my-4">{busy && <RefreshCw className="h-4 w-4 animate-spin" />}预览相关 SKU</button>
    {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
    {plan && <><p className="mb-3 text-sm">找到 {plan.rows.length} 条匹配，已选 {ids.length} 条；未确认包裹项目 {plan.rows.filter(r => ids.includes(r.id)).reduce((n, r) => n + r.pending.length, 0)} 条。</p>{!plan.rows.length && <p className="text-sm text-slate-500">没有指向该旧款式的已保存匹配。</p>}<div className="space-y-3">{plan.rows.map(row => <label key={row.id} className="flex gap-3 rounded-lg border p-3"><input type="checkbox" disabled={busy || !!row.issues.length} checked={ids.includes(row.id)} onChange={e => setIds(e.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} /><div className="text-sm"><p className="font-semibold">{row.store} · {row.skuCode || row.sku}</p><p className="text-xs text-slate-500">SKU ID: {row.sku}</p>{row.changes.map((c, i) => <p key={i}>{c.old.style} → {c.next.style} · {c.next.color} / {c.next.size} · {c.next.qty} 件</p>)}{row.issues.map(issue => <p key={issue} className="text-red-700">{issue}</p>)}</div></label>)}</div><button disabled={busy || !ids.length} onClick={confirm} className="btn-primary mt-4">确认迁移 {ids.length} 条匹配及未确认包裹</button></>}
  </div></div>
}
