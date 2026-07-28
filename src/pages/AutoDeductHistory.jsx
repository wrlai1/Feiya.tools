import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle, History, Minus, RefreshCw, RotateCcw, TrendingUp } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export default function AutoDeductHistory() {
  const { getToken } = useAuth()
  const toast = useToast()
  const [transactions, setTransactions] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState(null)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const headers = { Authorization: `Bearer ${getToken()}` }
      const [transactionsRes, snapshotsRes] = await Promise.all([
        fetch('/api/inventory-balance?action=transactions', { headers }),
        fetch('/api/inventory-balance?action=history', { headers }),
      ])
      const [transactionsData, snapshotsData] = await Promise.all([
        transactionsRes.json().catch(() => ({})),
        snapshotsRes.json().catch(() => ({})),
      ])
      if (!transactionsRes.ok) throw new Error(transactionsData.error || 'Could not load transaction history')
      if (!snapshotsRes.ok) throw new Error(snapshotsData.error || 'Could not load rollback points')
      setTransactions(transactionsData.transactions || [])
      setSnapshots((snapshotsData.snapshots || []).filter((snapshot) =>
        ['sales', 'return', 'pre_restore'].includes(snapshot.label)
      ))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { loadHistory() }, [loadHistory])

  const handleRollback = async (snapshot) => {
    const action = snapshot.label === 'sales'
      ? 'the deduction'
      : snapshot.label === 'return'
        ? 'the add-back'
        : 'the previous rollback'
    const confirmed = window.confirm(
      `Restore saved inventory quantities from ${formatDate(snapshot.created_at || snapshot.timestamp)}?\n\n` +
      `This restores quantities from before ${action}${snapshot.source_name ? ` for ${snapshot.source_name}` : ''}.\n` +
      `Styles, colors, and sizes added after that point will be kept.\n\n` +
      `The current balance will be saved as a new backup first.`
    )
    if (!confirmed) return

    setRestoring(snapshot.id)
    setError('')
    try {
      const res = await fetch(`/api/inventory-balance?action=restore&id=${snapshot.id}&mode=quantities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not restore inventory')
      toast.success(
        `${Number(data.total_units || 0).toLocaleString()} units across ${Number(data.total_rows || 0).toLocaleString()} SKU rows restored`,
        'Rollback Complete'
      )
      await loadHistory()
    } catch (err) {
      setError(err.message)
      toast.error(err.message, 'Rollback Failed')
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Auto Deduct History</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Review completed updates and restore inventory to a saved point
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/auto-deduct" className="btn-secondary text-sm">
            <ArrowLeft className="w-4 h-4" />
            Back to Auto Deduct
          </Link>
          <button onClick={loadHistory} disabled={loading} className="btn-secondary text-sm">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-blue-600" />
            <h3 className="font-semibold text-slate-800">Rollback Auto Deduct</h3>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Rollback restores saved quantities but keeps styles, colors, and sizes added later. Quantity changes made after that point to the saved SKUs will be reverted. Your current balance is backed up automatically first.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4 animate-spin" /> Loading rollback points…
          </div>
        ) : snapshots.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            No Auto Deduct rollback points are available yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {snapshots.map((snapshot) => {
              const isSale = snapshot.label === 'sales'
              const isBackup = snapshot.label === 'pre_restore'
              return (
                <div key={snapshot.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        isBackup
                          ? 'bg-purple-100 text-purple-700'
                          : isSale
                            ? 'bg-orange-100 text-orange-700'
                            : 'bg-green-100 text-green-700'
                      }`}>
                        {isBackup ? 'Before rollback' : isSale ? 'Before deduction' : 'Before add-back'}
                      </span>
                      <span className="text-sm font-medium text-slate-700">
                        {formatDate(snapshot.created_at || snapshot.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500" title={snapshot.source_name || ''}>
                      {snapshot.source_name || 'No source file'} · {Number(snapshot.total_units || 0).toLocaleString()} units · {Number(snapshot.total_rows || 0).toLocaleString()} SKU rows
                    </p>
                  </div>
                  <button
                    onClick={() => handleRollback(snapshot)}
                    disabled={restoring !== null}
                    className="btn-secondary w-full justify-center text-sm text-blue-700 sm:w-auto"
                  >
                    {restoring === snapshot.id
                      ? <RefreshCw className="h-4 w-4 animate-spin" />
                      : <RotateCcw className="h-4 w-4" />}
                    {restoring === snapshot.id ? 'Restoring…' : 'Rollback'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

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
                          <CheckCircle className="w-3.5 h-3.5" /> Applied
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
