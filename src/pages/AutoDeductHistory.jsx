import React, { useCallback, useEffect, useState } from 'react'
import { CheckCircle, History, Minus, RefreshCw, TrendingUp } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export default function AutoDeductHistory() {
  const { getToken } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/inventory-balance?action=transactions', {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load history')
      setTransactions(data.transactions || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { loadHistory() }, [loadHistory])

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Auto Deduct History</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Only successfully completed inventory updates appear here
          </p>
        </div>
        <button onClick={loadHistory} disabled={loading} className="btn-secondary text-sm">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-sm text-slate-500">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading history…
          </div>
        ) : transactions.length === 0 ? (
          <div className="py-16 text-center">
            <History className="w-9 h-9 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-600">No successful updates yet</p>
            <p className="text-xs text-slate-400 mt-1">Apply a sale or return in Auto Deduct to create the first record.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">File</th>
                  <th className="px-4 py-3 font-medium text-right">SKU Rows</th>
                  <th className="px-4 py-3 font-medium text-right">Units</th>
                  <th className="px-4 py-3 font-medium">Applied By</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((item) => {
                  const isSale = item.transaction_type === 'sales'
                  const ActionIcon = isSale ? Minus : TrendingUp
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDate(item.applied_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 font-medium ${isSale ? 'text-orange-600' : 'text-green-600'}`}>
                          <ActionIcon className="w-4 h-4" />
                          {isSale ? 'Deduct' : 'Add Back'}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-xs truncate text-slate-700" title={item.source_file || ''}>
                        {item.source_file || '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{item.row_count ?? '—'}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${isSale ? 'text-orange-600' : 'text-green-600'}`}>
                        {isSale ? '−' : '+'}{Number(item.applied_units || 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{item.applied_by || '—'}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium">
                          <CheckCircle className="w-3.5 h-3.5" /> Successful
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
