import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle, RefreshCw, Undo2, X } from 'lucide-react'
import { useToast } from '../hooks/useToast.js'

const BASE = '/api'

async function request(url, getToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({ error: response.statusText }))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function localTimestamp(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export default function OversoldManagement({ getToken, onInventoryChanged }) {
  const [data, setData] = useState({ oversold: [], history: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [undoing, setUndoing] = useState(null)
  const [selected, setSelected] = useState(null)
  const [substituteId, setSubstituteId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [orderNumber, setOrderNumber] = useState('')
  const [reason, setReason] = useState('')
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await request(`${BASE}/inventory-balance?action=oversold`, getToken)
      setData({ oversold: next.oversold || [], history: next.history || [] })
    } catch (error) {
      toast.error(error.message, 'Could Not Load Oversold Inventory')
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  const chosenCandidate = useMemo(() => selected?.candidates?.find(
    (candidate) => Number(candidate.id) === Number(substituteId),
  ) || null, [selected, substituteId])

  const openResolve = (row) => {
    const first = row.candidates?.[0]
    setSelected(row)
    setSubstituteId(first ? String(first.id) : '')
    setQuantity(first ? String(Math.min(Number(row.shortage), Number(first.quantity))) : '1')
    setOrderNumber('')
    setReason('')
  }

  const parsedQuantity = Number(quantity)
  const canSave = selected && chosenCandidate
    && Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0
    && parsedQuantity <= Number(selected.shortage)
    && parsedQuantity <= Number(chosenCandidate.quantity)

  const saveSubstitution = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await request(`${BASE}/inventory-balance?action=resolve-oversold`, getToken, {
        method: 'POST',
        body: JSON.stringify({
          originalId: selected.id,
          substituteId: chosenCandidate.id,
          quantity: parsedQuantity,
          orderNumber,
          reason,
        }),
      })
      toast.success(
        `${selected.color} → ${chosenCandidate.color}: ${parsedQuantity} unit${parsedQuantity === 1 ? '' : 's'}`,
        'Substitution Saved',
      )
      setSelected(null)
      await Promise.all([load(), onInventoryChanged?.()])
    } catch (error) {
      toast.error(error.message, 'Substitution Failed')
    } finally {
      setSaving(false)
    }
  }

  const undoSubstitution = async (row) => {
    if (!window.confirm(`Undo ${row.quantity} unit(s): ${row.original_color} → ${row.substitute_color}?`)) return
    setUndoing(row.id)
    try {
      await request(`${BASE}/inventory-balance?action=undo-substitution`, getToken, {
        method: 'POST',
        body: JSON.stringify({ id: row.id }),
      })
      toast.success('The substitution was reversed.', 'Substitution Undone')
      await Promise.all([load(), onInventoryChanged?.()])
    } catch (error) {
      toast.error(error.message, 'Undo Failed')
    } finally {
      setUndoing(null)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" /> Loading oversold inventory…</div>
  }

  return (
    <div className="space-y-5">
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl space-y-5 rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-slate-900">Resolve Oversold Color / 处理超卖</h3>
                <p className="mt-1 text-sm text-slate-500">{selected.style} · {selected.color} · {selected.size} · shortage {selected.shortage}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>

            {!selected.candidates?.length ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                No other color with the same Style and Size currently has stock.
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-500">Substitute Color</label>
                    <select value={substituteId} onChange={(event) => {
                      const nextId = event.target.value
                      const candidate = selected.candidates.find((item) => Number(item.id) === Number(nextId))
                      setSubstituteId(nextId)
                      setQuantity(String(Math.min(Number(selected.shortage), Number(candidate?.quantity || 1))))
                    }} className="input-base w-full bg-white">
                      {selected.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.color} · {candidate.quantity} available</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-500">Substitute Quantity</label>
                    <input type="number" min="1" max={Math.min(Number(selected.shortage), Number(chosenCandidate?.quantity || 0))} step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="input-base w-full" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-500">PO / Order Number (optional)</label>
                    <input value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} maxLength={120} className="input-base w-full" placeholder="PO-…" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-500">Reason / Remark (optional)</label>
                    <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} className="input-base w-full" placeholder="Customer approved replacement" />
                  </div>
                </div>

                {chosenCandidate && Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0 && (
                  <div className="grid gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                    <div>
                      <p className="text-xs font-semibold uppercase text-blue-500">Oversold color</p>
                      <p className="mt-1 font-semibold text-blue-950">{selected.color} · {selected.size}</p>
                      <p className="text-sm text-blue-700">shortage {selected.shortage} → {Math.max(0, Number(selected.shortage) - parsedQuantity)}</p>
                    </div>
                    <ArrowRight className="hidden h-5 w-5 text-blue-400 sm:block" />
                    <div>
                      <p className="text-xs font-semibold uppercase text-blue-500">Actual substitute</p>
                      <p className="mt-1 font-semibold text-blue-950">{chosenCandidate.color} · {selected.size}</p>
                      <p className="text-sm text-blue-700">stock {chosenCandidate.quantity} → {Number(chosenCandidate.quantity) - parsedQuantity}</p>
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setSelected(null)} disabled={saving} className="btn-secondary">Cancel</button>
                  <button type="button" onClick={saveSubstitution} disabled={!canSave || saving} className="btn-primary disabled:opacity-50">
                    {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                    Confirm Substitution
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold text-amber-900">{data.oversold.length} oversold SKU{data.oversold.length === 1 ? '' : 's'} need attention</p>
            <p className="mt-1 text-sm text-amber-700">Customer demand stays on the original color. Confirming a substitution restores that shortage and deducts the color actually shipped.</p>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div><h3 className="font-semibold text-slate-900">Open Oversold Inventory</h3><p className="mt-1 text-xs text-slate-500">Only colors with the same Style and Size are suggested.</p></div>
          <button type="button" onClick={load} className="btn-secondary text-sm"><RefreshCw className="h-4 w-4" /> Refresh</button>
        </div>
        {!data.oversold.length ? (
          <div className="py-14 text-center"><CheckCircle className="mx-auto h-8 w-8 text-emerald-500" /><p className="mt-2 font-medium text-slate-700">No unresolved oversold inventory</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Style', 'Oversold Color', 'Size', 'Shortage', 'Available Replacements', 'Action'].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.oversold.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-semibold text-slate-800">{row.style}</td>
                    <td className="px-4 py-3 text-slate-700">{row.color}</td>
                    <td className="px-4 py-3">{row.size}</td>
                    <td className="px-4 py-3 font-bold text-red-600">{row.shortage}</td>
                    <td className="px-4 py-3 text-slate-600">{row.candidates?.length ? row.candidates.map((item) => `${item.color} (${item.quantity})`).join(' · ') : 'No matching stock'}</td>
                    <td className="px-4 py-3"><button type="button" onClick={() => openResolve(row)} className="btn-primary whitespace-nowrap text-xs">Resolve</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-4"><h3 className="font-semibold text-slate-900">Substitution History</h3><p className="mt-1 text-xs text-slate-500">The latest 100 confirmed color substitutions.</p></div>
        {!data.history.length ? <p className="px-5 py-10 text-center text-sm text-slate-400">No substitutions recorded yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Date', 'Style / Size', 'Substitution', 'Qty', 'PO / Remark', 'User', 'Status'].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.history.map((row) => (
                  <tr key={row.id} className={row.undone_at ? 'bg-slate-50 text-slate-400' : ''}>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{localTimestamp(row.created_at)}</td>
                    <td className="px-4 py-3 font-medium">{row.style} · {row.size}</td>
                    <td className="px-4 py-3">{row.original_color} <ArrowRight className="mx-1 inline h-3.5 w-3.5" /> {row.substitute_color}</td>
                    <td className="px-4 py-3 font-semibold">{row.quantity}</td>
                    <td className="px-4 py-3"><p>{row.order_number || '—'}</p>{row.reason && <p className="mt-0.5 text-xs text-slate-400">{row.reason}</p>}</td>
                    <td className="px-4 py-3">{row.created_by}</td>
                    <td className="px-4 py-3">{row.undone_at ? <span className="text-xs">Undone by {row.undone_by}</span> : <button type="button" onClick={() => undoSubstitution(row)} disabled={undoing === row.id} className="btn-secondary whitespace-nowrap text-xs">{undoing === row.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Undo</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
