import React, { useState, useEffect, useMemo } from 'react'
import { TrendingUp, RefreshCw, Search, Download } from 'lucide-react'
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
const SORT_OPTIONS = [
  ['sales-desc', '销量：高到低'],
  ['sales-asc', '销量：低到高'],
  ['returns-desc', '退货：高到低'],
  ['returns-asc', '退货：低到高'],
  ['returnRate-desc', '退货率：高到低'],
  ['perDay-desc', '日均净销：高到低'],
  ['qty-desc', '库存：高到低'],
  ['qty-asc', '库存：低到高'],
  ['daysLeft-asc', '可售天数：少到多'],
  ['daysLeft-desc', '可售天数：多到少'],
  ['name-asc', '名称：A → Z'],
  ['name-desc', '名称：Z → A'],
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
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState('sales-desc')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
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
      if (m.txn_type !== 'sales' && m.txn_type !== 'return') continue
      const day = String(m.day).slice(0, 10)
      if (day < cutoff) continue
      activeDays.add(day)
      const k = keyFor(level, m)
      const a = agg.get(k) || {
        sales: 0,
        returns: 0,
        style: m.style,
        color: m.color,
        size: m.size,
      }
      if (m.txn_type === 'sales') a.sales += m.qty
      else if (m.txn_type === 'return') a.returns += m.qty
      agg.set(k, a)
    }
    return [...agg.entries()].map(([k, a]) => {
      const net = a.sales - a.returns
      const perDay = net / windowDays
      const qty = stock.get(k) ?? null
      return {
        key: k,
        style: a.style,
        color: a.color,
        size: a.size,
        sales: a.sales,
        returns: a.returns,
        returnRate: a.sales ? a.returns / a.sales : null,
        perDay,
        qty,
        daysLeft: qty == null ? null : perDay > 0 ? qty / perDay : Infinity,
        activeDays: activeDays.size,
      }
    })
  }, [movements, inventory, windowDays, level])

  const visibleRows = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const filtered = terms.length
      ? ranked.filter((row) => {
          const value = row.key.toLocaleLowerCase()
          return terms.every((term) => value.includes(term))
        })
      : ranked
    const [field, direction] = sortBy.split('-')
    const multiplier = direction === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (field === 'name') {
        return multiplier * a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' })
      }
      const aValue = a[field]
      const bValue = b[field]
      if (aValue == null && bValue == null) return a.key.localeCompare(b.key, undefined, { numeric: true })
      if (aValue == null) return 1
      if (bValue == null) return -1
      if (aValue === bValue) return a.key.localeCompare(b.key, undefined, { numeric: true })
      return multiplier * (aValue - bValue)
    })
  }, [ranked, query, sortBy])

  const totals = useMemo(() => {
    const sales = visibleRows.reduce((s, r) => s + r.sales, 0)
    const returns = visibleRows.reduce((s, r) => s + r.returns, 0)
    return { sales, returns, rate: sales ? returns / sales : null }
  }, [visibleRows])

  const exportResults = async () => {
    if (!visibleRows.length) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const levelLabel = LEVELS.find(([key]) => key === level)?.[1] || level
      const sortLabel = SORT_OPTIONS.find(([key]) => key === sortBy)?.[1] || sortBy
      const headers = [
        '排名',
        '款式',
        ...(level !== 'style' ? ['颜色'] : []),
        ...(level === 'size' ? ['尺码'] : []),
        '销量',
        '退货',
        '净销量',
        '退货率',
        '日均净销',
        '当前库存',
        '可售天数',
      ]
      const rows = visibleRows.map((row, index) => [
        index + 1,
        row.style,
        ...(level !== 'style' ? [row.color] : []),
        ...(level === 'size' ? [row.size] : []),
        row.sales,
        row.returns,
        row.sales - row.returns,
        row.returnRate == null ? '' : `${(row.returnRate * 100).toFixed(1)}%`,
        Number(row.perDay.toFixed(1)),
        row.qty ?? '',
        row.daysLeft == null ? '' : !Number.isFinite(row.daysLeft) ? '滞销' : row.daysLeft > 999 ? '999+' : Math.round(row.daysLeft),
      ])
      const sheet = XLSX.utils.aoa_to_sheet([
        ['库存动销搜索结果'],
        ['时间窗口', `近 ${windowDays} 天`],
        ['统计粒度', levelLabel],
        ['搜索条件', query.trim() || '全部'],
        ['排序方式', sortLabel],
        ['结果数量', visibleRows.length],
        [],
        headers,
        ...rows,
      ])
      sheet['!cols'] = headers.map((header) => ({
        wch: Math.max(10, header.length * 2 + 2),
      }))
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, '库存动销')
      const date = new Date()
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
      const searchSuffix = query.trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30)
      XLSX.writeFile(
        workbook,
        `库存动销_近${windowDays}天_${levelLabel}${searchSuffix ? `_${searchSuffix}` : ''}_${date.toISOString().slice(0, 10)}.xlsx`,
      )
    } catch (err) {
      setError(`导出失败：${err.message}`)
    } finally {
      setExporting(false)
    }
  }

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
          <div className="flex flex-col sm:flex-row gap-2">
            <label className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索款式、颜色或尺码…"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              aria-label="库存动销排序"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {SORT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <button
              onClick={exportResults}
              disabled={!visibleRows.length || exporting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              {exporting ? '导出中…' : '导出 Excel'}
            </button>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
            <span>窗口销量 <b className="text-slate-800">{totals.sales.toLocaleString()}</b></span>
            <span>退货 <b className="text-slate-800">{totals.returns.toLocaleString()}</b></span>
            <span>整体退货率 <b className="text-slate-800">{totals.rate == null ? '—' : (totals.rate * 100).toFixed(1) + '%'}</b></span>
            {query.trim() && <span className="text-blue-600 text-xs self-center">找到 {visibleRows.length} 项</span>}
            {ranked[0]?.activeDays < windowDays && (
              <span className="text-amber-600 text-xs self-center">⚠ 窗口内只有 {ranked[0].activeDays} 天有流水，销速可能偏低</span>
            )}
          </div>

          {visibleRows.length ? <div className="overflow-x-auto">
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
                {visibleRows.slice(0, 50).map((r, i) => (
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
            {visibleRows.length > 50 && <p className="text-xs text-slate-400 mt-2">只显示前 50 行（共 {visibleRows.length}）</p>}
          </div> : (
            <p className="text-sm text-slate-400 py-6 text-center">没有找到匹配的款式、颜色或尺码。</p>
          )}

        </>
      )}
    </section>
  )
}
