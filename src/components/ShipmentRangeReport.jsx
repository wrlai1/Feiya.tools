import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { buildShipmentReport, shipmentReportSheet } from '../utils/shipmentReport.js'
import dateRange from '../../lib/shipmentDateRange.cjs'
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
export default function ShipmentRangeReport({ inventoryRows = [] }) {
  const { getToken } = useAuth()
  const [style,setStyle] = useState('5010015'), [from,setFrom] = useState(today), [to,setTo] = useState(today)
  const [report,setReport] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const styles = useMemo(()=>[...new Set(inventoryRows.map(row=>String(row.Style ?? row.style ?? '').trim()).filter(Boolean))].sort(),[inventoryRows])
  async function load(event) {
    event.preventDefault();setError('');setReport(null)
    try {
      dateRange.shipmentDateRange(from,to)
      if (!style.trim()) throw Error('请选择或输入款号')
      setBusy(true)
      const response = await fetch('/api/inventory-balance?' + new URLSearchParams({action:'movements',from,to,style:style.trim(),txnType:'sales'}),{headers:{Authorization:`Bearer ${getToken()}`}})
      const data = await response.json()
      if (!response.ok) throw Error(data.error || '查询失败')
      setReport(buildShipmentReport(style.trim(),from,to,data.rows || []))
    } catch(error) { setError(error.message) } finally { setBusy(false) }
  }
  async function download() {
    if (!report) return
    setBusy(true);setError('')
    try {
      const module = await import('exceljs'), ExcelJS = module.default || module
      const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Shipments')
      shipmentReportSheet(report).forEach(row=>sheet.addRow(row))
      const columns = report.dates.length+3
      sheet.mergeCells(1,1,1,columns);sheet.getCell('A1').value=`${report.style} 实际出货记录 · ${report.from} — ${report.to}`
      sheet.mergeCells(2,1,2,columns);sheet.getCell('A2').alignment={wrapText:true};sheet.getRow(2).height=32
      sheet.getRow(1).font={bold:true,size:16};sheet.getRow(3).font={bold:true,color:{argb:'FFFFFFFF'}}
      sheet.getRow(3).eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}}})
      sheet.getColumn(1).width=24;sheet.getColumn(2).width=12
      for(let col=3;col<=columns;col++){sheet.getColumn(col).width=14;sheet.getColumn(col).numFmt='#,##0'}
      sheet.getRow(sheet.rowCount).font={bold:true}
      sheet.views=[{state:'frozen',xSplit:2,ySplit:3}]
      const bytes=await workbook.xlsx.writeBuffer(), url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}))
      const link=document.createElement('a');link.href=url;link.download=`shipments_${report.style.replace(/[\\/:*?"<>|]/g,'_')}_${report.from}_${report.to}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
    } catch(error){setError(error.message)}finally{setBusy(false)}
  }
  return <section className="card p-5 space-y-4">
    <h2 className="font-semibold">出货记录报表</h2>
    <p className="text-sm text-slate-500">选择款号与起止日期，按颜色、尺码查看每天出货条数及区间合计。</p>
    <form onSubmit={load} className="flex flex-wrap items-end gap-3">
      <label className="text-sm">款号<input list="shipment-report-styles" className="input-base block" value={style} onChange={event=>{setStyle(event.target.value);setReport(null)}} disabled={busy} required /><datalist id="shipment-report-styles">{styles.map(style=><option key={style} value={style}/>)}</datalist></label>
      <label className="text-sm">开始日期<input type="date" className="input-base block" value={from} onChange={event=>{setFrom(event.target.value);setReport(null)}} disabled={busy} required /></label>
      <label className="text-sm">结束日期<input type="date" className="input-base block" value={to} onChange={event=>{setTo(event.target.value);setReport(null)}} disabled={busy} required /></label>
      <button className="btn-primary" disabled={busy}>{busy?'处理中…':'查询出货'}</button>
      <button type="button" className="btn-secondary" onClick={download} disabled={busy || !report || !report.rows.length}>导出 Excel</button>
    </form>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {report && <><p className="text-sm">{report.style} · {report.from} — {report.to} · 合计 {report.total.toLocaleString()} 条</p>
      <p className="text-xs text-slate-500">按出货业务日期统计，排除已撤回记录。0 表示没有匹配出货记录，不代表当天数据已上传。</p>
      {!report.rows.length ? <p>所选款号在此期间没有有效出货记录。</p> : <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead><tr>{['颜色','尺码',...report.dates,'合计'].map(label=><th className="p-2 whitespace-nowrap" key={label}>{label}</th>)}</tr></thead><tbody>
        {report.rows.map(row=><tr className="border-t" key={JSON.stringify([row.color,row.size])}><td className="p-2">{row.color}</td><td className="p-2">{row.size}</td>{report.dates.map(day=><td className="p-2 text-right" key={day}>{row.byDay[day]||0}</td>)}<td className="p-2 font-semibold text-right">{row.total}</td></tr>)}
        <tr className="border-t font-semibold"><td className="p-2" colSpan={2}>TOTAL</td>{report.dailyTotals.map((qty,index)=><td className="p-2 text-right" key={report.dates[index]}>{qty}</td>)}<td className="p-2 text-right">{report.total}</td></tr>
      </tbody></table></div>}</>}
  </section>
}
