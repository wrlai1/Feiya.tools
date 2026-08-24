import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Users, Download, RefreshCw, ChevronDown, ChevronUp,
  Edit2, Trash2, AlertCircle, Calendar, RotateCcw, Check, X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  calcHours, calcHoursInRange, formatHours, filterToday, filterThisWeek,
  groupByUser, isMissedPunch, getStatus, toLocalDateTimeInput,
  STATUS_LABEL, PUNCH_LABEL,
} from '../utils/timeCalc.js'

const BASE = '/api'

function authHeaders(token, json = false) {
  const h = { Authorization: `Bearer ${token}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

/* ── Status badge ─────────────────────────────────────────────────────── */
function StatusBadge({ status }) {
  const cls = {
    clocked_in:  'bg-green-100 text-green-700',
    on_break:    'bg-yellow-100 text-yellow-700',
    clocked_out: 'bg-slate-100 text-slate-500',
    not_started: 'bg-slate-100 text-slate-400',
  }
  const dot = {
    clocked_in: 'bg-green-500 animate-pulse',
    on_break:   'bg-yellow-500 animate-pulse',
    clocked_out:'bg-slate-300',
    not_started:'bg-slate-300',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cls[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

/* ── Inline edit for a single punch ──────────────────────────────────── */
function PunchRow({ punch, token, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(toLocalDateTimeInput(punch.punched_at))
  const [note, setNote]       = useState(punch.note ?? '')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState(null)

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`${BASE}/timeclock?id=${punch.id}`, {
        method: 'PATCH',
        headers: authHeaders(token, true),
        body: JSON.stringify({ punched_at: new Date(val).toISOString(), note }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onUpdated(data)
      setEditing(false)
    } catch (e) { setErr(e.message) }
    finally     { setSaving(false) }
  }

  const del = async () => {
    if (!window.confirm('Delete this punch?')) return
    const res = await fetch(`${BASE}/timeclock?id=${punch.id}`, {
      method: 'DELETE', headers: authHeaders(token),
    })
    if (res.ok) onDeleted(punch.id)
  }

  const time = new Date(punch.punched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = new Date(punch.punched_at).toLocaleDateString([], { month: 'short', day: 'numeric' })

  return (
    <li className="group flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 rounded-lg transition-colors">
      <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
        punch.type === 'clock_in'    ? 'bg-green-500' :
        punch.type === 'clock_out'   ? 'bg-red-400'   :
        punch.type === 'break_start' ? 'bg-yellow-400' : 'bg-blue-400'
      }`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-700">{PUNCH_LABEL[punch.type]}</span>
          {punch.edited_by && <span className="text-xs text-slate-400 italic">edited</span>}
        </div>
        {editing ? (
          <div className="mt-1.5 space-y-1.5">
            <input type="datetime-local" value={val} onChange={e => setVal(e.target.value)}
              className="block w-full text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <input type="text" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
              className="block w-full text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            {err && <p className="text-xs text-red-600">{err}</p>}
            <div className="flex gap-2">
              <button onClick={save} disabled={saving}
                className="flex items-center gap-1 text-xs bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700 disabled:opacity-50">
                <Check className="w-3 h-3" /> Save
              </button>
              <button onClick={() => { setEditing(false); setErr(null) }}
                className="flex items-center gap-1 text-xs border border-slate-300 text-slate-600 px-2.5 py-1 rounded hover:bg-slate-50">
                <X className="w-3 h-3" /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">{date} · {time}</p>
        )}
      </div>
      {!editing && (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => setEditing(true)}
            className="p-1 text-slate-400 hover:text-blue-600 rounded transition-colors">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={del}
            className="p-1 text-slate-400 hover:text-red-500 rounded transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </li>
  )
}

/* ── Per-user accordion card ─────────────────────────────────────────── */
function UserCard({ username, punches: initial, token, onPunchesChange }) {
  const [open, setOpen]     = useState(false)
  const [punches, setPunches] = useState(initial)

  useEffect(() => { setPunches(initial) }, [initial])

  const status  = getStatus(punches)
  const missed  = isMissedPunch(punches)
  const total   = formatHours(calcHours(punches))
  const today   = formatHours(calcHours(filterToday(punches)))
  const week    = formatHours(calcHours(filterThisWeek(punches)))

  const handleUpdated = (updated) => {
    const next = punches.map(p => p.id === updated.id ? updated : p)
    setPunches(next)
    onPunchesChange(username, next)
  }
  const handleDeleted = (id) => {
    const next = punches.filter(p => p.id !== id)
    setPunches(next)
    onPunchesChange(username, next)
  }

  return (
    <div className={`bg-white rounded-xl border shadow-sm ${missed ? 'border-red-200' : 'border-slate-200'}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-4 px-5 py-4 text-left"
      >
        {/* Avatar */}
        <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
          {username[0].toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{username}</span>
            <StatusBadge status={status} />
            {missed && (
              <span className="inline-flex items-center gap-1 text-xs text-red-600 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Missed punch?
              </span>
            )}
          </div>
          <div className="flex gap-4 mt-1 text-xs text-slate-500">
            <span>Today <strong className="text-slate-700">{today}</strong></span>
            <span>Week <strong className="text-slate-700">{week}</strong></span>
            <span>Period <strong className="text-slate-700">{total}</strong></span>
          </div>
        </div>

        {open ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
               : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-2 py-2">
          {punches.length === 0 ? (
            <p className="text-center text-slate-400 text-sm py-4">No punches this period</p>
          ) : (
            <ul className="space-y-0.5">
              {[...punches].reverse().map(p => (
                <PunchRow key={p.id} punch={p} token={token}
                  onUpdated={handleUpdated} onDeleted={handleDeleted} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Reset period modal ──────────────────────────────────────────────── */
function ResetModal({ token, onDone, onClose }) {
  const [label, setLabel]     = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr]         = useState(null)

  const submit = async () => {
    if (!window.confirm('Start a new pay period? All current hours will be archived and totals will reset.')) return
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`${BASE}/timeclock?action=reset`, {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({ label }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e) { setErr(e.message) }
    finally     { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <RotateCcw className="w-5 h-5 text-orange-600" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-800">Reset Pay Period</h2>
            <p className="text-xs text-slate-500">All current hours will be archived</p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Period Label (optional)</label>
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. March 2026"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-3 pt-1">
          <button onClick={submit} disabled={loading}
            className="flex-1 bg-orange-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-orange-700 disabled:opacity-50 transition-colors">
            {loading ? 'Resetting…' : 'Reset Period'}
          </button>
          <button onClick={onClose}
            className="flex-1 border border-slate-300 text-slate-700 rounded-lg py-2 text-sm font-medium hover:bg-slate-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Export helpers ──────────────────────────────────────────────────── */
function exportCSV(punches, contextPunches, from, to) {
  const headers = ['Username', 'Type', 'Punched At', 'Note', 'Edited By', 'Original Time']
  const rows = punches.map(p => [
    p.username,
    PUNCH_LABEL[p.type] ?? p.type,
    new Date(p.punched_at).toLocaleString(),
    p.note ?? '',
    p.edited_by ?? '',
    p.original_at ? new Date(p.original_at).toLocaleString() : '',
  ])

  // Build summary rows per user
  const calculationPunches = [...(contextPunches || []), ...punches]
  const byUser = groupByUser(calculationPunches)
  const rangeStartMs = new Date(from).getTime()
  const rangeEndMs = new Date(to).getTime()
  const summaryRows = Object.entries(byUser).map(([u, ps]) => ({
    username: u,
    hours: calcHoursInRange(ps, rangeStartMs, rangeEndMs),
  }))

  let csv = 'PUNCH LOG EXPORT\n'
  csv += `Period: ${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}\n\n`
  csv += headers.join(',') + '\n'
  rows.forEach(r => { csv += r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n' })
  csv += '\nSUMMARY\nUsername,Total Hours\n'
  summaryRows.forEach(r => { csv += `"${r.username}",${r.hours.toFixed(2)}\n` })

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `feiya-timeclock-${new Date(from).toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* ── Main page ────────────────────────────────────────────────────────── */
export default function AdminTimeReport() {
  const { getToken } = useAuth()
  const [userMap, setUserMap]     = useState({})  // { username: [punches] }
  const [periodStart, setPeriodStart] = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [showReset, setShowReset] = useState(false)

  // Export date range
  const [exportFrom, setExportFrom] = useState('')
  const [exportTo,   setExportTo]   = useState('')
  const [exporting,  setExporting]  = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(`${BASE}/timeclock?action=all`, {
        headers: authHeaders(getToken()),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setUserMap(groupByUser(data.punches || []))
      setPeriodStart(data.periodStart)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  const handlePunchesChange = (username, next) => {
    setUserMap(prev => ({ ...prev, [username]: next }))
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const from = exportFrom ? new Date(`${exportFrom}T00:00:00`).toISOString() : periodStart
      const to   = exportTo ? new Date(`${exportTo}T23:59:59.999`).toISOString() : new Date().toISOString()
      const params = new URLSearchParams({ action: 'export', from, to })
      const res  = await fetch(`${BASE}/timeclock?${params}`, {
        headers: authHeaders(getToken()),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      exportCSV(data.punches || [], data.contextPunches || [], data.from, data.to)
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  const allPunches = Object.values(userMap).flat()
  const totalHours = Object.values(userMap).reduce((sum, ps) => sum + calcHours(ps), 0)
  const userCount  = Object.keys(userMap).length

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Time Report</h1>
            {periodStart && (
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Period since {new Date(periodStart).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button onClick={() => setShowReset(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700">
            <RotateCcw className="w-4 h-4" /> Reset Period
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Employees</p>
          <p className="text-2xl font-bold text-slate-800">{userCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Total Hours</p>
          <p className="text-2xl font-bold text-slate-800">{formatHours(totalHours)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Total Punches</p>
          <p className="text-2xl font-bold text-slate-800">{allPunches.length}</p>
        </div>
      </div>

      {/* Export */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <Download className="w-4 h-4 text-slate-400" /> Export to CSV
        </h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1">From</label>
            <input type="date" value={exportFrom} onChange={e => setExportFrom(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">To</label>
            <input type="date" value={exportTo} onChange={e => setExportTo(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={handleExport} disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            <Download className="w-4 h-4" />
            {exporting ? 'Exporting…' : 'Download CSV'}
          </button>
          <p className="text-xs text-slate-400 self-center">Leave blank to export current period</p>
        </div>
      </div>

      {/* Per-user cards */}
      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="animate-spin w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      ) : Object.keys(userMap).length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">No time data for this period</div>
      ) : (
        <div className="space-y-3">
          {Object.entries(userMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([username, punches]) => (
              <UserCard
                key={username}
                username={username}
                punches={punches}
                token={getToken()}
                onPunchesChange={handlePunchesChange}
              />
            ))}
        </div>
      )}

      {showReset && (
        <ResetModal
          token={getToken()}
          onDone={() => { setShowReset(false); load() }}
          onClose={() => setShowReset(false)}
        />
      )}
    </div>
  )
}
