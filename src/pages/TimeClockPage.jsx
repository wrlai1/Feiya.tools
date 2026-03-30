import React, { useState, useEffect, useCallback } from 'react'
import { Clock, Coffee, LogIn, LogOut, RefreshCw, AlertTriangle } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  getStatus, calcHours, formatHours, filterToday, filterThisWeek,
  isMissedPunch, STATUS_LABEL, PUNCH_LABEL,
} from '../utils/timeCalc.js'

const BASE = '/api'

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function StatusBadge({ status }) {
  const colors = {
    clocked_in:  'bg-green-100 text-green-700 border border-green-200',
    on_break:    'bg-yellow-100 text-yellow-700 border border-yellow-200',
    clocked_out: 'bg-slate-100 text-slate-500 border border-slate-200',
    not_started: 'bg-slate-100 text-slate-400 border border-slate-200',
  }
  const dots = {
    clocked_in:  'bg-green-500 animate-pulse',
    on_break:    'bg-yellow-500 animate-pulse',
    clocked_out: 'bg-slate-400',
    not_started: 'bg-slate-300',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${colors[status]}`}>
      <span className={`w-2 h-2 rounded-full ${dots[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function PunchButton({ icon: Icon, label, onClick, disabled, variant = 'default' }) {
  const variants = {
    default:  'bg-blue-600 hover:bg-blue-700 text-white',
    green:    'bg-green-600 hover:bg-green-700 text-white',
    red:      'bg-red-600 hover:bg-red-700 text-white',
    yellow:   'bg-yellow-500 hover:bg-yellow-600 text-white',
    outline:  'border border-slate-300 text-slate-700 hover:bg-slate-50',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${variants[variant]}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}

function LiveClock({ punches }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const hours = calcHours(punches)
  return (
    <div className="text-4xl font-mono font-bold text-slate-800 tabular-nums">
      {formatHours(hours)}
    </div>
  )
}

export default function TimeClockPage() {
  const { getToken } = useAuth()
  const [punches, setPunches]       = useState([])
  const [periodStart, setPeriodStart] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${BASE}/timeclock?action=my`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setPunches(data.punches || [])
      setPeriodStart(data.periodStart)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  const punch = async (type) => {
    setActionLoading(true); setError(null)
    try {
      const res = await fetch(`${BASE}/timeclock?action=punch`, {
        method: 'POST',
        headers: authHeaders(getToken()),
        body: JSON.stringify({ type }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Action failed')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  const status     = getStatus(punches)
  const todayPunches = filterToday(punches)
  const weekPunches  = filterThisWeek(punches)
  const missed       = isMissedPunch(punches)

  const canClockIn    = status === 'not_started' || status === 'clocked_out'
  const canClockOut   = status === 'clocked_in'
  const canBreakStart = status === 'clocked_in'
  const canBreakEnd   = status === 'on_break'

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <svg className="animate-spin w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    </div>
  )

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">

      {/* Missed punch warning */}
      {missed && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <p className="text-sm font-medium">You've been clocked in for over 12 hours. Did you forget to clock out?</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      {/* Status card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-slate-400" />
            <span className="text-sm font-medium text-slate-500">Current Status</span>
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="text-center mb-6">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Today's Hours</p>
          <LiveClock punches={todayPunches} />
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3 justify-center">
          {canClockIn && (
            <PunchButton icon={LogIn} label="Clock In" variant="green"
              disabled={actionLoading} onClick={() => punch('clock_in')} />
          )}
          {canClockOut && (
            <PunchButton icon={LogOut} label="Clock Out" variant="red"
              disabled={actionLoading} onClick={() => punch('clock_out')} />
          )}
          {canBreakStart && (
            <PunchButton icon={Coffee} label="Start Break" variant="yellow"
              disabled={actionLoading} onClick={() => punch('break_start')} />
          )}
          {canBreakEnd && (
            <PunchButton icon={Coffee} label="End Break" variant="default"
              disabled={actionLoading} onClick={() => punch('break_end')} />
          )}
          <PunchButton icon={RefreshCw} label="Refresh" variant="outline"
            disabled={actionLoading || loading} onClick={load} />
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">This Week</p>
          <p className="text-2xl font-bold text-slate-800">{formatHours(calcHours(weekPunches))}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">This Period</p>
          <p className="text-2xl font-bold text-slate-800">{formatHours(calcHours(punches))}</p>
        </div>
      </div>

      {/* Recent punches */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">Punch History (Today)</h2>
        </div>
        {todayPunches.length === 0 ? (
          <p className="text-slate-400 text-sm text-center py-8">No punches today</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {[...todayPunches].reverse().map(p => (
              <li key={p.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    p.type === 'clock_in'    ? 'bg-green-500' :
                    p.type === 'clock_out'   ? 'bg-red-400'   :
                    p.type === 'break_start' ? 'bg-yellow-400' : 'bg-blue-400'
                  }`} />
                  <span className="text-sm font-medium text-slate-700">{PUNCH_LABEL[p.type]}</span>
                  {p.edited_by && <span className="text-xs text-slate-400 italic">(edited)</span>}
                </div>
                <span className="text-sm text-slate-500 tabular-nums">
                  {new Date(p.punched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {periodStart && (
        <p className="text-xs text-center text-slate-400">
          Pay period started {new Date(periodStart).toLocaleDateString()}
        </p>
      )}
    </div>
  )
}
