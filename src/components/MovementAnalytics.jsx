import React, { useState, useEffect, useMemo } from 'react'
import { TrendingUp, RefreshCw } from 'lucide-react'
import { fetchMovements, fetchInventoryBalance } from '../utils/api.js'

/**
 * 动销分析 — 从 Auto Deduct 的库存流水（inventory_txn_rows）计算：
 *   · 畅销排名（款 / 款+色 / 款+色+码 三个粒度）
 *   · 净销速（销售−退货 ÷ 窗口天数）、退货率
 *   · 还能卖多久 = 当前库存 ÷ 日均净销速
 * 数据和库存出自同一笔账（apply 即记录），所以数字永远和库存对得上。
 */

const WINDOWS = [7, 14, 30]
const LEVELS = [
  ['style', '按款'],
  ['color', '款+颜色'],
  ['size', '款+颜色+尺码'],
]

function keyFor(level, r) {
  if (level === 'style') return r.style
  if (level === 'color') return `${r.style} / ${r.color}`
  return `${r.style} / ${r.color} / ${r.size}`
}

function fmtDays(v) {
  if (v == null) return '—'
  if (!Number.isFinite(v)) return '∞ 滞销'
  if (v > 999) return '999+ 天'
  return `${Math.round(v)} 天`
}

export default function MovementAnalytics() {
  const [movements, setMovements] = useState(null)   // null = 未加载
  const [inventory, setInventory] = useState([])
  const [windowDays, setWindowDays] = useState(7)
  const [level, setLevel] = useState('style')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [mv, inv] = await Promise.all([fetchMovements(30), fetchInventoryBalance()])
      setMovements(mv.rows || [])
      setInventory(inv.rows || [])
    } catch (err) {
      setError(err.message); setMovements([])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const ranked = useMemo(() => {
    if (!movements) return []
    const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10)
    // 库存按当前粒度聚合
    const stock = new Map()
    for (const r of inventory) {
      const k = keyFor(level, { style: r.Style ?? r.style, color: r.Color ?? r.color, size: r.Size ?? r.size })
      stock.set(k, (stock.get(k) || 0) + (Number(r.Quantity ?? r.quantity) || 0))
    }
    // 流水按粒度聚合
    const agg = new Map()
    const activeDays = new Set()
    for (const m of movements) {
      const day = String(m.day).slice(0, 10)
      if (day < cutoff) continue
      activeDays.add(day)
      const k = keyFor(level, m)
      const a = agg.get(k) || { sales: 0, returns: 0 }
      if (m.txn_type === 'sales') a.sales += m.qty
      else a.returns += m.qty
      agg.set(k, a)
    }
    return [...agg.entries()].map(([k, a]) => {
      const net = a.sales - a.returns
      const perDay = net / windowDays
      const qty = stock.get(k) ?? null
      return {
        key: k,
        sales: a.sales,
        returns: a.returns,
        returnRate: a.sales ? a.returns / a.sales : null,
        perDay,
        qty,
        daysLeft: qty == null ? null : perDay > 0 ? qty / perDay : Infinity,
        activeDays: activeDays.size,
      }
    }).sort((x, y) => y.sales - x.sales)
  }, [movements, inventory, windowDays, level])

  const totals = useMemo(() => {
    const sales = ranked.reduce((s, r) => s + r.sales, 0)
    const returns = ranked.reduce((s, r) => s + r.returns, 0)
    return { sales, returns, rate: sales ? returns / sales : null }
  }, [ranked])

  return (
    <section className="card p-5 space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" /> 库存动销
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            数据来自 Auto Deduct 的进出流水 —— 销量 = 扣减，退货 = 加回，与库存同源。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {WINDOWS.map((d) => (
            <button key={d} onClick={() => setWindowDays(d)}
              className={`text-xs px-3 py-1.5 rounded-lg border ${windowDays === d ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              近 {d} 天
            </button>
          ))}
          <span className="w-px h-5 bg-slate-200" />
          {LEVELS.map(([k, label]) => (
            <button key={k} onClick={() => setLevel(k)}
              className={`text-xs px-3 py-1.5 rounded-lg border ${level === k ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
          <button onClick={load} disabled={loading} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {movements && !movements.length && !loading && (
        <p className="text-sm text-slate-400 py-6 text-center">
          还没有流水数据 —— 在 Auto Deduct 里 Apply 一次销售/退货后，这里就会开始积累。
        </p>
      )}

      {ranked.length > 0 && (
        <>
          <div className="flex gap-6 text-sm text-slate-600">
            <span>窗口销量 <b className="text-slate-800">{totals.sales.toLocaleString()}</b></span>
            <span>退货 <b className="text-slate-800">{totals.returns.toLocaleString()}</b></span>
            <span>整体退货率 <b className="text-slate-800">{totals.rate == null ? '—' : (totals.rate * 100).toFixed(1) + '%'}</b></span>
            {ranked[0]?.activeDays < windowDays && (
              <span className="text-amber-600 text-xs self-center">⚠ 窗口内只有 {ranked[0].activeDays} 天有流水，销速可能偏低</span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">{LEVELS.find(([k]) => k === level)?.[1]}</th>
                  <th className="py-2 pr-3 text-right">销量</th>
                  <th className="py-2 pr-3 text-right">退货</th>
                  <th className="py-2 pr-3 text-right">退货率</th>
                  <th className="py-2 pr-3 text-right">日均净销</th>
                  <th className="py-2 pr-3 text-right">当前库存</th>
                  <th className="py-2 text-right">还能卖</th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 50).map((r, i) => (
                  <tr key={r.key} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="py-1.5 pr-3 text-slate-400">{i + 1}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-700">{r.key}</td>
                    <td className="py-1.5 pr-3 text-right font-medium">{r.sales.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-500">{r.returns || 0}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-500">{r.returnRate == null ? '—' : (r.returnRate * 100).toFixed(1) + '%'}</td>
                    <td className="py-1.5 pr-3 text-right">{r.perDay.toFixed(1)}</td>
                    <td className="py-1.5 pr-3 text-right">{r.qty == null ? '—' : r.qty.toLocaleString()}</td>
                    <td className={`py-1.5 text-right font-medium ${r.daysLeft != null && r.daysLeft < 14 ? 'text-red-600' : 'text-slate-700'}`}>
                      {fmtDays(r.daysLeft)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ranked.length > 50 && <p className="text-xs text-slate-400 mt-2">只显示前 50 行（共 {ranked.length}）</p>}
          </div>
        </>
      )}
    </section>
  )
}
