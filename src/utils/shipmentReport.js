import { compareInventorySizes } from './inventorySizeSort.js'
export function buildShipmentReport(style, from, to, movements) {
  const dates = []
  for (let day = from; day <= to;) {
    dates.push(day)
    const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
    day = next.toISOString().slice(0,10)
  }
  const grouped = new Map()
  for (const item of movements) {
    const day = String(item.day || '').slice(0,10)
    if (item.txn_type !== 'sales' || String(item.style).trim().toUpperCase() !== style.trim().toUpperCase() || day < from || day > to) continue
    const qty = Number(item.qty)
    if (!Number.isSafeInteger(qty) || qty <= 0) continue
    const key = JSON.stringify([item.color, item.size])
    if (!grouped.has(key)) grouped.set(key,{color:item.color,size:item.size,byDay:{},total:0})
    const row = grouped.get(key)
    row.byDay[day] = (row.byDay[day] || 0) + qty; row.total += qty
  }
  const rows = [...grouped.values()].sort((a,b)=>String(a.color).localeCompare(String(b.color)) || compareInventorySizes(a.size,b.size))
  const dailyTotals = dates.map(day=>rows.reduce((sum,row)=>sum+(row.byDay[day]||0),0))
  return {style,from,to,dates,rows,dailyTotals,total:rows.reduce((sum,row)=>sum+row.total,0)}
}
export function shipmentReportSheet(report) {
  return [
    [`${report.style} 实际出货记录`, report.from, report.to],
    ['按出货业务日期；已撤回记录不计入。0 表示没有匹配记录，不代表当天数据已上传。'],
    ['Color','Size',...report.dates,'Total'],
    ...report.rows.map(row=>[row.color,row.size,...report.dates.map(day=>row.byDay[day]||0),row.total]),
    ['TOTAL','',...report.dailyTotals,report.total],
  ]
}
