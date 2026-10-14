import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, PackageCheck } from 'lucide-react'
import { fetchWarehouseAlerts, fetchWarehouseSnapshot, saveWarehouseAlertChange } from '../utils/api.js'
import { parseWarehouseCsv, warehouseCsv } from '../utils/warehouseCsv.js'

const button = 'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50'
const input = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm'
const colors = { RED: 'bg-red-100 text-red-700', ORANGE: 'bg-orange-100 text-orange-700', YELLOW: 'bg-amber-100 text-amber-800', GREEN: 'bg-emerald-100 text-emerald-700' }
function download(name, rows) {
  const csv = warehouseCsv(rows)
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}
function prepCsvRows(rows) {
  const fields = ['style', 'color', 'size', 'risk', 'UPS', 'GOFO', 'USPS', 'OTHER', 'today_sales', 'avg_3d', 'avg_7d', 'forecast_qty', 'inventory_known', 'physical_inventory', 'ready_qty', 'usable_ready_qty', 'ready_invalid', 'target_ready_qty', 'prep_needed', 'shortage', 'alert_level', 'warehouse_location']
  return rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])))
}
function weeklyCsvRows(rows) {
  const fields = ['style', 'color', 'size', 'avg_7d', 'physical_inventory', 'ready_qty', 'usable_ready_qty', 'ready_invalid', 'weekly_target', 'weekly_prep', 'warehouse_location']
  return rows.filter(row => row.weekly_target > 0).map(row => Object.fromEntries(fields.map(field => [field, row[field]])))
}
function Table({ headers, children, empty }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{headers.map(h => <th key={h} className="whitespace-nowrap px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{children}</tbody></table>{empty && <p className="p-6 text-center text-sm text-slate-400">暂无数据</p>}</div>
}
const cell = 'whitespace-nowrap px-4 py-3'
function Panel({ title, subtitle, action, children }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="flex items-center justify-between gap-3 border-b border-slate-100 p-5"><div><h2 className="font-semibold text-slate-900">{title}</h2>{subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}</div>{action}</div>{children}</section>
}
export default function WarehouseAlerts() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState(null), [value, setValue] = useState(''), [reason, setReason] = useState('')
  const [settings, setSettings] = useState(null), [search, setSearch] = useState('')
  const [orderPage, setOrderPage] = useState(0)
  const requestVersion = useRef(0), saving = useRef(false)
  const load = useCallback(async () => {
    if (saving.current) return
    const version = ++requestVersion.current
    try {
      const result = await fetchWarehouseAlerts()
      if (version === requestVersion.current) { setData(result); setError('') }
    } catch (e) { if (version === requestVersion.current) setError(e.message) }
  }, [])
  useEffect(() => { load(); const timer = setInterval(load, 15 * 60 * 1000); return () => { clearInterval(timer); requestVersion.current++ } }, [load])
  async function save(change) {
    if (saving.current) return
    saving.current = true; requestVersion.current++; setBusy(true)
    try { const result = await saveWarehouseAlertChange(change, editor.revision); setData(result); setEditor(null); setError('') }
    catch (e) { setError(e.message) }
    finally { saving.current = false; setBusy(false) }
  }
  async function importFile(kind, file) {
    if (!file || !data) return
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('CSV 文件不能超过 4 MB')
      const rows = parseWarehouseCsv(await file.text(), kind)
      setEditor({ action: kind, rows, revision: data.revision, title: `导入 ${rows.length} 行${kind === 'orders' ? '订单' : '销量'}快照`, description: rows.length === 0 ? '此文件只有表头。确认后将清空本模块的订单快照，表示当前没有待发订单。' : '确认后替换该模块的完整快照。订单文件必须包含所有未发订单；销量文件需覆盖最近 7 个完整自然日和今天。' })
      setReason(`导入 ${file.name}`)
    } catch (e) { setError(e.message) }
  }
  function edit(target, field, current, title) {
    setEditor({ action: 'override', target, field, title, revision: data.revision }); setValue(current ?? ''); setReason('')
  }
  const report = data?.report, summary = report?.summary, capacity = report?.capacity
  const orderPageCount = Math.max(1, Math.ceil((report?.orders.length || 0) / 200))
  const visibleOrderPage = Math.min(orderPage, orderPageCount - 1)
  const rows = (report?.rows || []).filter(row => `${row.style} ${row.color} ${row.size}`.toLowerCase().includes(search.toLowerCase()))
  const weekly = rows.filter(row => row.weekly_target > 0)
  const exportPrep = () => download(`tomorrow-prep-${report.business_day}.csv`, prepCsvRows(rows))
  return <div className="mx-auto max-w-[1600px] space-y-6 p-4 sm:p-6 lg:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><PackageCheck className="h-6 w-6 text-emerald-700"/><h1 className="text-2xl font-semibold text-slate-900">订单预警与仓库备货</h1></div><p className="mt-2 text-sm text-slate-500">UPS / GOFO 优先 · 今天准备明天 · Ready-to-Pick Inventory</p></div><button className={button} onClick={load} disabled={busy}><RefreshCw className="h-4 w-4"/>刷新</button></div>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    {!data && <p className="text-sm text-slate-500">{error ? '无法加载预警数据，请刷新重试。' : '正在读取仓库数据…'}</p>}
    {data && <>
      <div className="flex flex-wrap items-center gap-2">
        {['orders', 'sales'].map(kind => <React.Fragment key={kind}><label className={`${button} cursor-pointer`}><input aria-label={`导入${kind === 'orders' ? '订单' : '销量'} CSV`} type="file" accept=".csv" className="sr-only" disabled={busy} onChange={e => { importFile(kind, e.target.files?.[0]); e.target.value = '' }}/>导入{kind === 'orders' ? '订单' : '销量'} CSV</label><button className={button} onClick={() => download(`${kind}-template.csv`, kind === 'orders' ? [{ order_id: 'EXAMPLE-001', store_id: 'Store A', platform: 'TEMU', order_date: '2026-10-02T09:00:00-04:00', paid_time: '', ship_deadline: '2026-10-03T18:00:00-04:00', carrier: 'UPS', style: '50199', color: 'Black', size: 'L', qty: 1, order_status: 'paid', shipment_status: 'unshipped', tracking_number: '' }] : [{ date: '2026-10-01', style: '50199', color: 'Black', size: 'L', sold_qty: 10 }])}><Download className="h-4 w-4"/>{kind === 'orders' ? '订单' : '销量'}模板</button></React.Fragment>)}
        <button className={button} onClick={() => { setSettings(data.state.settings); setEditor({ action: 'settings', revision: data.revision, title: '仓库产能与备货配置' }); setReason('') }}>产能 / 配置</button>
        {data.state.sales !== null && <button className={button} onClick={() => { setEditor({ action: 'sales_reset', revision: data.revision, title: '恢复 ERP 销量来源', description: '改用 ERP 已应用且未回滚的销售交易，替换当前导入的销量快照。' }); setReason('') }}>恢复 ERP 销量</button>}
      </div>
      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800"><p>实物库存来自 Stock Management，包含已分好的 Ready Qty。销量来源：{data.sales_source}。</p><p className="mt-1">订单快照：{data.state.orders_updated_at ? new Date(data.state.orders_updated_at).toLocaleString() : '尚未导入，当前订单风险不完整'} · 计算时间：{new Date(report.generated_at).toLocaleString()} · 业务日：{report.business_day}（纽约）</p><p className="mt-1">Ready Qty 为人工盘点值，发货后需更新；系统不会自动扣减。销量缺失日期按 0 计算，请保证数据完整。</p></div>
      <Panel title="TODAY SHIPPING RISK · 今日发货风险" subtitle="按订单计数；同一订单多个款式只计算一次">
        <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-6">{[['UPS 待发', summary.UPS], ['GOFO 待发', summary.GOFO], ['USPS 待发', summary.USPS], ['OTHER 待发', summary.OTHER], ['已超时', summary.overdue], ['今日到期', summary.due_today]].map(([label, count]) => <div key={label}><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{count}</p></div>)}</div>
        <div className={`m-5 mt-0 rounded-xl p-4 text-sm ${capacity.critical ? 'bg-red-50 text-red-800' : capacity.shortfall ? 'bg-orange-50 text-orange-800' : 'bg-slate-50 text-slate-700'}`}><p className="font-semibold">{capacity.critical ? 'CRITICAL SHIPPING CAPACITY ALERT' : capacity.shortfall ? 'WAREHOUSE CAPACITY RISK' : '仓库产能概览'}</p><p className="mt-1">在岗 {capacity.employees} 人 · 剩余产能 {capacity.estimated} 单 · 优先待发 {capacity.priority_remaining} 单 · 缺口 {capacity.shortfall} 单</p><p className="mt-1">预计完成全部待发：{capacity.completion_hours === null ? '无可用产能' : `${Math.ceil(capacity.completion_hours * 60)} 分钟`} · 最老 USPS：{summary.oldest_usps_age.toFixed(1)} 天</p>{capacity.critical && <p className="mt-2 font-medium">建议暂停 USPS、分货及仓库整理，集中处理 UPS / GOFO。</p>}</div>
      </Panel>
      <input className={`${input} max-w-sm`} placeholder="搜索 Style / Color / Size" aria-label="搜索款式" value={search} onChange={e => setSearch(e.target.value)}/>
      <Panel title="URGENT STYLES · 款式风险" subtitle="数量单位：件；红色包含所有物流的超时订单">
        <Table headers={['Style / Color / Size', 'UPS', 'GOFO', 'USPS', 'OTHER', 'Ready Qty', 'Risk']} empty={!rows.some(row => row.unshipped_qty > 0)}>{rows.filter(row => row.unshipped_qty > 0).map(row => <tr key={row.key}><td className={cell}>{row.style} / {row.color} / {row.size}</td>{['UPS', 'GOFO', 'USPS', 'OTHER', 'ready_qty'].map(field => <td key={field} className={cell}>{row[field]}</td>)}<td className={cell}><span className={`rounded-full px-2 py-1 text-xs font-medium ${colors[row.risk]}`}>{row.risk}</span></td></tr>)}</Table>
      </Panel>
      <Panel title="TOMORROW PREP · 明日备货" subtitle="过去 3 / 7 个完整日平均，20% 安全系数；包含全部当前未发需求" action={<button className={button} onClick={exportPrep} disabled={!rows.length}><Download className="h-4 w-4"/>导出清单</button>}>
        <Table headers={['款式', '紧急 / 缓冲 / 其他', '今日销量', '3日 / 7日均', '预测', '实物', 'Ready Qty', 'Prep Needed', '短缺', '级别', '库位 / 目标']} empty={!rows.length}>{rows.map(row => <tr key={row.key} className={row.shortage ? 'bg-red-50/40' : ''}><td className={cell}>{row.style} / {row.color} / {row.size}{row.sales_spike && <span className="ml-2 text-xs text-orange-600">销量突增</span>}</td><td className={cell}>{row.urgent_demand} / {row.buffered_demand} / {row.OTHER}</td><td className={cell}>{row.today_sales}</td><td className={cell}>{row.avg_3d.toFixed(1)} / {row.avg_7d.toFixed(1)}</td><td className={cell}><button className="text-blue-600 underline" onClick={() => edit(`sku:${row.key}`, 'forecast_qty', row.forecast_qty, '调整明日预测')}>{row.forecast_qty}</button></td><td className={cell}>{row.inventory_known ? row.physical_inventory : '未知'}</td><td className={cell}><button className="text-blue-600 underline" onClick={() => edit(`sku:${row.key}`, 'ready_qty', row.ready_qty, '更新 Ready Qty')}>{row.ready_qty}</button>{row.ready_invalid && <span className="ml-1 text-red-600" title={`Ready Qty 超过当前实物，请重新盘点。计算仅抵扣 ${row.usable_ready_qty} 件。`}>⚠</span>}</td><td className={`${cell} font-semibold`}>PREP {row.prep_needed} PCS</td><td className={`${cell} text-red-700`}>{row.shortage ? `SHORT ${row.shortage} PCS` : '—'}</td><td className={cell}>{row.alert_level}</td><td className={cell}><button className="text-blue-600 underline" onClick={() => edit(`sku:${row.key}`, 'warehouse_location', row.warehouse_location, '调整库位')}>{row.warehouse_location || '设置库位'}</button><button className="ml-3 text-blue-600 underline" onClick={() => edit(`sku:${row.key}`, 'prep_target', row.target_ready_qty, '调整 Ready 目标（受 Prep Cap 限制）')}>目标 {row.target_ready_qty}</button></td></tr>)}</Table>
      </Panel>
      <Panel title="WEEKLY PREP · 周末高频款" subtitle={`7日均 ≥ ${data.state.settings.weekly_threshold} 件；目标为 2.5 天销量，最多不超过实物库存`} action={<button className={button} disabled={!weekly.length} onClick={() => download(`weekly-prep-${report.business_day}.csv`, weeklyCsvRows(weekly))}>导出周末清单</button>}>
        <Table headers={['款式', '7日均', '实物', 'Ready Qty', '周末目标', '建议分货']} empty={!weekly.length}>{weekly.map(row => <tr key={row.key}><td className={cell}>{row.style} / {row.color} / {row.size}</td>{['avg_7d', 'physical_inventory', 'ready_qty', 'weekly_target', 'weekly_prep'].map(field => <td className={cell} key={field}>{field === 'avg_7d' ? row[field].toFixed(1) : row[field]}</td>)}</tr>)}</Table>
      </Panel>
      <Panel title="订单处理队列" subtitle={`按 Priority Score 降序 · ${report.orders.length} 单`}>
        <Table headers={['订单 / 店铺', 'Carrier', '件数', '截止时间', '年龄（天）', 'Priority', '物流权重']} empty={!report.orders.length}>{report.orders.slice(visibleOrderPage * 200, (visibleOrderPage + 1) * 200).map(row => <tr key={row.key}><td className={cell}>{row.order_id} / {row.store_id}</td><td className={cell}>{row.carrier}</td><td className={cell}>{row.qty}</td><td className={`${cell} ${row.overdue ? 'text-red-600' : ''}`}>{new Date(row.ship_deadline).toLocaleString()}</td><td className={cell}>{row.age.toFixed(1)}</td><td className={cell}><button className="text-blue-600 underline" onClick={() => edit(`order:${row.key}`, 'priority', row.priority_score, '调整订单 Priority')}>{row.priority_score}</button></td><td className={cell}><button className="text-blue-600 underline" onClick={() => edit(`order:${row.key}`, 'carrier_urgency', data.state.overrides[`order:${row.key}`]?.carrier_urgency ?? ({ UPS: 100, GOFO: 100, USPS: 50, OTHER: 40 }[row.carrier]), '调整物流权重')}>调整</button></td></tr>)}</Table>{report.orders.length > 200 && <div className="flex items-center justify-end gap-3 p-4 text-sm"><button className={button} disabled={visibleOrderPage === 0} onClick={() => setOrderPage(visibleOrderPage - 1)}>上一页</button><span>第 {visibleOrderPage + 1} / {orderPageCount} 页</span><button className={button} disabled={visibleOrderPage + 1 >= orderPageCount} onClick={() => setOrderPage(visibleOrderPage + 1)}>下一页</button></div>}
      </Panel>
      <Panel title="自动生成记录与人工调整"><div className="space-y-2 p-5 text-sm text-slate-600">{data.snapshots.length ? data.snapshots.map(item => <p key={item.key}><button className="text-blue-600 underline" onClick={async () => { try { const snapshot = await fetchWarehouseSnapshot(item.key); download(`${item.key.replace(':', '-')}.csv`, item.key.startsWith('weekly:') ? weeklyCsvRows(snapshot.rows) : prepCsvRows(snapshot.rows)) } catch (e) { setError(e.message) } }}>{item.key}</button> · {new Date(item.updated_at).toLocaleString()}</p>) : <p>暂无定时生成记录。部署并配置 CRON_SECRET 后，每 15 分钟计算，纽约时间 18:00 后生成每日清单，周五生成周末清单。</p>}<details><summary className="cursor-pointer py-2 font-medium">调整记录（最近 30 条）</summary>{data.state.audit.slice(-30).reverse().map((entry, i) => <div key={i} className="border-t border-slate-100 py-3"><p>{entry.changed_by} · {new Date(entry.changed_at).toLocaleString()} · {entry.action} {entry.field}</p><p className="break-all text-xs">{entry.target} · {JSON.stringify(entry.old_value)} → {JSON.stringify(entry.new_value)}</p><p>{entry.reason}</p></div>)}</details></div></Panel>
    </>}
    {editor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form role="dialog" aria-modal="true" aria-label={editor.title} className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl bg-white p-6" onSubmit={e => { e.preventDefault(); save(editor.action === 'override' ? { ...editor, value: editor.field === 'warehouse_location' ? value : value === '' ? null : Number(value), reason } : editor.action === 'settings' ? { action: 'settings', settings, reason } : { action: editor.action, rows: editor.rows, reason }) }}><h2 className="text-lg font-semibold">{editor.title}</h2>{editor.description && <p className="text-sm text-slate-600">{editor.description}</p>}
      {editor.action === 'override' && <label className="block text-sm">新值{editor.field !== 'ready_qty' && editor.field !== 'warehouse_location' && <span className="ml-1 text-xs text-slate-500">（留空恢复自动计算）</span>}<input autoFocus className={`${input} mt-2`} required={editor.field === 'ready_qty'} type={editor.field === 'warehouse_location' ? 'text' : 'number'} min="0" step="1" value={value} onChange={e => setValue(e.target.value)}/></label>}
      {editor.action === 'settings' && Object.entries({ employee_count: '总人数', employee_absent: '缺勤人数', orders_per_hour: '每人每小时订单数', hours_remaining: '剩余工作小时', weekly_threshold: '周末高频阈值（件/天）', max_prep_days: '最大提前备货天数' }).map(([field, label]) => <label key={field} className="block text-sm">{label}<input className={`${input} mt-1`} type="number" min={field === 'max_prep_days' ? 1 : 0} step={field === 'hours_remaining' ? 'any' : '1'} required value={settings[field]} onChange={e => setSettings({ ...settings, [field]: Number(e.target.value) })}/></label>)}
      <label className="block text-sm">修改原因<textarea className={`${input} mt-2`} required maxLength={500} value={reason} onChange={e => setReason(e.target.value)}/></label>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>取消</button><button className={`${button} text-blue-700`} disabled={busy}>{busy ? '保存中…' : '确认保存'}</button></div>
    </form></div>}
  </div>
}
