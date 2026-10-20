import React, { useEffect, useMemo, useState } from 'react'
import { X, RefreshCw } from 'lucide-react'
import { fetchAliases } from '../utils/autoDeductAliases.js'
import { buildRebindingPlan, savedRebindingGroups, sameAliasValue } from '../utils/autoDeductRebinding.js'

export default function AutoDeductRebinding({ getToken, onClose, onSaved, onSaveError }) {
  const [aliases, setAliases] = useState({})
  const [inventory, setInventory] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [groupId, setGroupId] = useState('')
  const [style, setStyle] = useState('')
  const [color, setColor] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const headers = () => ({ Authorization: `Bearer ${getToken()}` })
  const load = async () => {
    setLoading(true); setError(''); setGroupId(''); setStyle(''); setColor(''); setReviewed(false)
    try {
      const [saved, response] = await Promise.all([
        fetchAliases(fetch, '/api/auto-deduct?action=aliases', headers()),
        fetch('/api/inventory-balance?action=list', { headers: headers() }),
      ])
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '库存加载失败')
      setAliases(saved)
      setInventory((data.rows || []).map((row) => ({ STYLE: row.Style, COLOR: row.Color, SIZE: row.Size })))
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  const groups = useMemo(() => savedRebindingGroups(aliases), [aliases])
  const filtered = groups.filter((group) => [group.sourceStyle, group.sourceColor, group.targetStyle, group.targetColor]
    .some((value) => value.toLowerCase().includes(search.trim().toLowerCase())))
  const styles = [...new Set(inventory.map((row) => row.STYLE))].sort((a, b) => a.localeCompare(b))
  const colors = [...new Set(inventory.filter((row) => row.STYLE === style).map((row) => row.COLOR))].sort((a, b) => a.localeCompare(b))
  let plan, planError = ''
  if (groupId && style && color) {
    try { plan = buildRebindingPlan(aliases, inventory, groupId, style, color) }
    catch (err) { planError = err.message }
  }
  const save = async () => {
    if (!plan || !reviewed || saving) return
    setSaving(true); setError('')
    try {
      const response = await fetch('/api/auto-deduct?action=rebind-aliases', {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, targetStyle: style, targetColor: color, expected: plan.expected }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '重新绑定失败')
      const verified = await fetchAliases(fetch, '/api/auto-deduct?action=aliases', headers())
      for (const [key, value] of Object.entries(plan.upserts)) {
        if (!sameAliasValue(verified[key], value)) {
          throw new Error('匹配保存后核对失败，请重新加载后再使用 Auto Deduct')
        }
      }
      onSaved(verified, data.count)
    } catch (err) { setError(err.message); setReviewed(false); onSaveError(err.message) }
    finally { setSaving(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label="Auto Deduct 重新绑定" className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">重新绑定已保存匹配</h3>
        <button aria-label="关闭重新绑定" disabled={saving} onClick={onClose} className="p-2 text-slate-500"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-sm text-slate-600">选择出货款式和颜色，将同一原目标的已保存匹配一起改到新库存目标。尺码沿用原规则；保存后需重新运行 Auto-Fill 核对。已确认扣库存的记录保留，保存匹配不会增减库存。</p>
      {loading ? <p className="text-sm text-slate-500">正在加载匹配和当前库存…</p> : <>
        <input aria-label="搜索已保存匹配" value={search} disabled={saving} onChange={(event) => { setSearch(event.target.value); setGroupId(''); setReviewed(false) }} placeholder="搜索款式或颜色，例如 5020090" className="input-base" />
        <label className="block text-sm font-medium">原匹配
          <select aria-label="原匹配" value={groupId} disabled={saving} onChange={(event) => { setGroupId(event.target.value); setReviewed(false) }} className="input-base mt-1">
            <option value="">请选择（{filtered.length} 组）</option>
            {filtered.map((group) => <option key={group.id} value={group.id}>{group.sourceStyle} / {group.sourceColor} → {group.targetStyle} / {group.targetColor}（{group.keys.length} 条）</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">新库存款式
            <select aria-label="新库存款式" disabled={saving} value={style} onChange={(event) => { setStyle(event.target.value); setColor(''); setReviewed(false) }} className="input-base mt-1">
              <option value="">请选择</option>{styles.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium">新库存颜色
            <select aria-label="新库存颜色" disabled={saving || !style} value={color} onChange={(event) => { setColor(event.target.value); setReviewed(false) }} className="input-base mt-1">
              <option value="">请选择</option>{colors.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>
        {plan && <>
          <p className="text-sm text-blue-800">将更新 {plan.rows.length} 条匹配；新目标现有尺码：{inventory.filter((row) => row.STYLE === style && row.COLOR === color).map((row) => row.SIZE).join(' / ')}</p>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">尺码规则</th><th className="p-2 text-left">原库存目标</th><th className="p-2 text-left">新库存目标</th></tr></thead><tbody>
            {plan.rows.map((row) => <tr key={row.key} className="border-t"><td className="p-2">{row.size}</td><td className="p-2">{row.oldStyle} / {row.oldColor}</td><td className="p-2">{row.targetStyle} / {row.targetColor}</td></tr>)}
          </tbody></table></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={saving} onChange={(event) => setReviewed(event.target.checked)} />我已核对以上新库存目标</label>
        </>}
      </>}
      {(error || planError) && <p role="alert" className="text-sm text-red-700">{error || planError}</p>}
      <div className="flex justify-end gap-2">
        <button disabled={saving} onClick={load} className="btn-secondary text-sm"><RefreshCw className="w-4 h-4" />重新加载</button>
        <button disabled={saving || loading || !plan || !reviewed} onClick={save} className="btn-primary text-sm disabled:opacity-50">{saving ? '保存并核对中…' : '保存重新绑定'}</button>
      </div>
    </section>
  </div>
}
