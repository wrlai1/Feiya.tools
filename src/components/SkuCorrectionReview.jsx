import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
export default function SkuCorrectionReview({ onApplied }) {
  const { getToken } = useAuth()
  const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function request(action,body) {
    const response=await fetch(`/api/inventory-balance?action=${action}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${getToken()}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    const data=await response.json();if(!response.ok) throw new Error(data.error||'Could not load SKU review');return data
  }
  async function run(work) {setBusy(true);setError('');try{await work()}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <div className="card p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-3">
      <button disabled={busy} className="btn-secondary text-sm" onClick={()=>run(async()=>setPreview(await request('sku-correction')))}>查看已确认 SKU 纠偏</button>
      <button disabled={busy} className="btn-secondary text-sm" onClick={()=>run(async()=>{
        const data={items:[]};for(let page=1;;page++){const batch=await request(`sku-audit&page=${page}`);data.items.push(...batch.items);if(!batch.more)break}const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='saved_sku_audit.json';a.click();URL.revokeObjectURL(url)
      })}>下载历史 SKU 核对数据</button>
    </div>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    {preview&&<div className="space-y-3">
      <p className="text-sm font-semibold">{preview.reference}</p>
      {preview.applied?<p role="status" className="text-green-700">已完成纠偏，原扣库和补回明细已保留，不会重复执行。</p>:<>
        <p className="text-xs text-slate-500">只纠正已核对的四条订单：Black 补回 4 件，Navy 扣除 4 件。以当前库存为基础，历史 OUT 同步改为 SKU 对应颜色。其他库存与退货记录保持原样。</p>
      </>}
        <table className="w-full text-sm"><thead><tr>{['Style','Color','Size','纠偏前','变动','纠偏后'].map(x=><th key={x} className="text-left p-2">{x}</th>)}</tr></thead><tbody>{(preview.applied?preview.record.stock_changes:preview.stockChanges).map(row=><tr key={row.id}>{[row.style,row.color,row.size,row.quantity,row.delta>0?`+${row.delta}`:row.delta,row.after].map((x,i)=><td key={i} className="p-2">{x}</td>)}</tr>)}</tbody></table>
      {!preview.applied&&<button disabled={busy} className="btn-primary text-sm" onClick={()=>run(async()=>{
          await request('sku-correction',{version:preview.version});setPreview(await request('sku-correction'));await onApplied()
        })}>{busy?'处理中…':'确认执行四条订单纠偏'}</button>}
      <details><summary className="text-sm cursor-pointer">SKU 订单依据</summary>{preview.evidence.map(row=><p key={row.order_number} className="text-xs py-1">{row.order_number} · {row.sku_code} · {row.quantity}</p>)}</details>
    </div>}
  </div>
}
