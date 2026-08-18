import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarDays, CheckCircle2, Clock3, Download,
  FileText, History, RefreshCw, Save, Search, Settings, Upload, Users,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { formatMinutes, payrollRangeForDate } from '../utils/factoryAttendance.js'

const BASE = '/api/attendance'

function guatemalaDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

async function apiFetch(path, options, getToken) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json', ...options?.headers },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Not set'
  return `Q${Number(value).toFixed(2)}`
}

function payrollCode(value) {
  return `WSL${String(value).padStart(3, '0')}`
}

function timeOnly(value) {
  return value ? String(value).slice(11, 16) : '—'
}

function Flag({ type }) {
  const labels = {
    needs_review: ['Needs review', 'bg-red-100 text-red-700'],
    late: ['Late', 'bg-amber-100 text-amber-700'],
    early: ['Early', 'bg-orange-100 text-orange-700'],
    below_standard: ['Under hours', 'bg-violet-100 text-violet-700'],
  }
  const [label, color] = labels[type] || [type, 'bg-slate-100 text-slate-600']
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${color}`}>{label}</span>
}

function SummaryCard({ label, value, helper, icon: Icon, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600', green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600',
  }
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-800">{value}</p>
          {helper && <p className="mt-1 text-xs text-slate-500">{helper}</p>}
        </div>
        <span className={`rounded-xl p-2.5 ${colors[color]}`}><Icon className="h-5 w-5" /></span>
      </div>
    </div>
  )
}

function ReviewPanel({ day, onClose, onSave, saving }) {
  const [hours, setHours] = useState(day.workedMinutes == null ? '' : (day.workedMinutes / 60).toFixed(2))
  const [note, setNote] = useState(day.reviewNote || '')
  const [late, setLate] = useState(day.possibleLate)
  const [early, setEarly] = useState(day.punchCount > 1 && day.possibleEarly)
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-slate-800">Confirm {day.name} · {day.workDate}</p>
          <p className="mt-1 text-xs text-slate-600">Raw punches: {day.punches.map(timeOnly).join(' · ')}</p>
        </div>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800">Cancel</button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr_auto]">
        <label className="text-xs font-medium text-slate-600">
          Confirmed hours
          <input type="number" min="0" max="24" step="0.01" value={hours} onChange={(event) => setHours(event.target.value)} className="input-base mt-1 w-full" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Reason / note
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Required for audit trail" className="input-base mt-1 w-full" />
        </label>
        <button disabled={saving || hours === '' || !note.trim()} onClick={() => onSave(Number(hours) * 60, note, { late, early })} className="btn-primary self-end disabled:opacity-50">
          <CheckCircle2 className="h-4 w-4" /> Confirm
        </button>
      </div>
      <div className="mt-3 flex gap-5 text-sm text-slate-700">
        <label className="flex items-center gap-2"><input type="checkbox" checked={late} onChange={(event) => setLate(event.target.checked)} /> Mark late</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={early} onChange={(event) => setEarly(event.target.checked)} /> Mark early</label>
      </div>
    </div>
  )
}

function EmployeeRateRow({ employee, settings, effectiveFrom, onSaved, getToken }) {
  const toast = useToast()
  const [rate, setRate] = useState(employee.dailyPayment ?? '')
  const [saving, setSaving] = useState(false)
  const bonus = Number(rate) === Number(settings.fulltimeDailyRate)

  const save = async () => {
    setSaving(true)
    try {
      await apiFetch('?action=employee', {
        method: 'PATCH',
        body: JSON.stringify({ employeeCode: employee.employeeCode, dailyPayment: Number(rate), effectiveFrom }),
      }, getToken)
      toast.success(`Saved payroll rate for ${employee.name}`)
      onSaved()
    } catch (error) { toast.error(error.message) }
    finally { setSaving(false) }
  }

  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 text-xs font-mono text-slate-500">{employee.employeeCode}</td>
      <td className="px-3 py-2 text-sm text-slate-700">{employee.name}</td>
      <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} className="input-base w-28 py-1.5 text-sm" /></td>
      <td className="px-3 py-2 text-center"><input type="checkbox" checked={bonus} readOnly disabled title={`Automatic when daily payment is Q${Number(settings.fulltimeDailyRate).toFixed(2)}`} /></td>
      <td className="px-3 py-2 text-right"><button onClick={save} disabled={saving || rate === ''} className="text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button></td>
    </tr>
  )
}

export default function FactoryAttendance() {
  const { user, getToken } = useAuth()
  const toast = useToast()
  const today = useMemo(guatemalaDate, [])
  const initialRange = useMemo(() => payrollRangeForDate(today), [today])
  const fileRef = useRef(null)
  const [from, setFrom] = useState(initialRange.start)
  const [to, setTo] = useState(today < initialRange.end ? today : initialRange.end)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [tab, setTab] = useState('summary')
  const [query, setQuery] = useState('')
  const [reviewDay, setReviewDay] = useState(null)
  const [savingReview, setSavingReview] = useState(false)
  const [settingsForm, setSettingsForm] = useState(null)
  const [savingSettings, setSavingSettings] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await apiFetch(`?action=dashboard&from=${from}&to=${to}`, {}, getToken)
      setData(next)
      setSettingsForm(next.settings)
    } catch (error) { toast.error(error.message) }
    finally { setLoading(false) }
  }, [from, getToken, to, toast])

  useEffect(() => { load() }, [load])

  const upload = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.txt')) return toast.error('Please select a TXT attendance file')
    setUploading(true)
    try {
      const result = await apiFetch('?action=import', {
        method: 'POST', body: JSON.stringify({ fileName: file.name, content: await file.text() }),
      }, getToken)
      toast.success(`Imported ${result.inserted} punches${result.duplicates ? `; skipped ${result.duplicates} duplicates` : ''}`)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setUploading(false) }
  }

  const saveReview = async (adjustedMinutes, note, flags) => {
    setSavingReview(true)
    try {
      await apiFetch('?action=review', {
        method: 'PATCH',
        body: JSON.stringify({ employeeCode: reviewDay.employeeCode, workDate: reviewDay.workDate, adjustedMinutes, note, ...flags }),
      }, getToken)
      toast.success('Attendance day confirmed')
      setReviewDay(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingReview(false) }
  }

  const saveSettings = async () => {
    setSavingSettings(true)
    try {
      await apiFetch('?action=settings', { method: 'PATCH', body: JSON.stringify(settingsForm) }, getToken)
      toast.success('Attendance settings saved')
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingSettings(false) }
  }

  const filteredSummary = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (data?.summary || []).filter((row) => !search || `${row.employeeCode} ${row.name} ${row.department}`.toLowerCase().includes(search))
  }, [data?.summary, query])
  const filteredDays = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (data?.days || []).filter((row) => !search || `${row.employeeCode} ${row.name} ${row.workDate}`.toLowerCase().includes(search))
  }, [data?.days, query])

  const exportWorkbook = () => {
    const workbook = XLSX.utils.book_new()
    const summaryRows = (data?.summary || []).map((row) => ({
      Code: payrollCode(row.employeeCode), 'Employee ID': row.employeeCode, Name: row.name, Department: row.department,
      'Work Days': row.workdays, 'Total Hours': Number((row.totalMinutes / 60).toFixed(2)),
      'Overtime Hours': Number((row.overtimeMinutes / 60).toFixed(2)),
      'Shortfall Hours': Number((row.shortfallMinutes / 60).toFixed(2)),
      Late: row.lateDays, Early: row.earlyDays, 'Needs Review': row.reviewDays,
      'Daily Payment': row.dailyPayment, 'Basic Salary': row.basicSalary,
      'Hours Adjustment': Number(row.hoursAdjustment.toFixed(2)), Bonus: row.bonus,
      'Attendance Pay': row.estimatedPay == null ? null : Number(row.estimatedPay.toFixed(2)),
    }))
    const dailyRows = (data?.days || []).map((day) => ({
      Date: day.workDate, Code: payrollCode(day.employeeCode), 'Employee ID': day.employeeCode, Name: day.name, Department: day.department,
      'First Punch': timeOnly(day.firstPunch), 'Last Punch': timeOnly(day.lastPunch), Punches: day.punchCount,
      'Worked Hours': day.workedMinutes == null ? null : Number((day.workedMinutes / 60).toFixed(2)),
      'Work Day': day.workday ? 'Yes' : 'No', Flags: day.flags.join(', '), Note: day.reviewNote,
    }))
    const rawRows = (data?.punches || []).map((punch) => ({
      Code: payrollCode(punch.employeeCode), 'Employee ID': punch.employeeCode, Name: punch.name, Department: punch.department,
      Timestamp: punch.punchedAt, Device: punch.deviceId, 'Import ID': punch.importId,
    }))
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Payroll Summary')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(dailyRows), 'Daily Attendance')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rawRows), 'Raw Punches')
    XLSX.writeFile(workbook, `factory-attendance-${from}-to-${to}.xlsx`)
  }

  const totalMinutes = (data?.summary || []).reduce((sum, row) => sum + row.totalMinutes, 0)
  const workdays = (data?.summary || []).reduce((sum, row) => sum + row.workdays, 0)
  const pending = (data?.days || []).filter((day) => day.needsReview).length
  const tabs = [
    ['summary', 'Payroll Summary'], ['daily', 'Daily Review'], ['imports', 'Import History'],
    ...(user?.role === 'admin' ? [['settings', 'Settings & Rates']] : []),
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Factory Attendance</h2>
          <p className="mt-1 text-sm text-slate-500">Guatemala time · Payroll periods: 6–20 and 21–5</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-500">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="input-base mt-1 block" /></label>
          <label className="text-xs font-medium text-slate-500">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="input-base mt-1 block" /></label>
          <button onClick={() => { setFrom(initialRange.start); setTo(today < initialRange.end ? today : initialRange.end) }} className="btn-secondary"><CalendarDays className="h-4 w-4" /> Current payroll</button>
          <button onClick={load} disabled={loading} className="btn-secondary"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          <button onClick={exportWorkbook} disabled={!data} className="btn-primary"><Download className="h-4 w-4" /> Export Excel</button>
        </div>
      </div>

      <div className="card flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-50 p-3 text-blue-600"><Upload className="h-5 w-5" /></span>
          <div><p className="font-semibold text-slate-800">Upload daily attendance TXT</p><p className="text-xs text-slate-500">Duplicate files and duplicate punches are automatically skipped.</p></div>
        </div>
        <input ref={fileRef} type="file" accept=".txt,text/plain" onChange={upload} className="hidden" />
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-primary justify-center disabled:opacity-50">
          <FileText className="h-4 w-4" /> {uploading ? 'Importing…' : 'Choose TXT'}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Employees" value={data?.summary?.length || 0} helper="With punches in range" icon={Users} />
        <SummaryCard label="Confirmed workdays" value={workdays} helper="At least one confirmed in/out set" icon={CheckCircle2} color="green" />
        <SummaryCard label="Total worked" value={formatMinutes(totalMinutes)} helper={`${from} through ${to}`} icon={Clock3} color="amber" />
        <SummaryCard label="Needs review" value={pending} helper="Punch count was not four" icon={AlertTriangle} color={pending ? 'red' : 'green'} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {tabs.map(([value, label]) => <button key={value} onClick={() => setTab(value)} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}
        </div>
        {(tab === 'summary' || tab === 'daily') && <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search employee" className="input-base pl-9" /></div>}
      </div>

      {loading && <div className="card flex items-center justify-center py-16 text-slate-500"><RefreshCw className="mr-3 h-5 w-5 animate-spin text-blue-500" /> Loading attendance…</div>}

      {!loading && tab === 'summary' && (
        <div className="card overflow-x-auto">
          <table className="min-w-[1180px] w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            {['ID / Employee', 'Days', 'Total', 'Overtime', 'Shortfall', 'Late', 'Early', 'Review', 'Daily pay', 'Basic salary', 'Hours ±', 'Bonus', 'Attendance pay'].map((label) => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}
          </tr></thead><tbody className="divide-y divide-slate-100">{filteredSummary.map((row) => <tr key={row.employeeCode} className="hover:bg-slate-50">
            <td className="px-3 py-3"><p className="font-medium text-slate-800">{row.name}</p><p className="text-xs text-slate-400">{payrollCode(row.employeeCode)} · {row.department || 'No department'}</p></td>
            <td className="px-3 py-3">{row.workdays}</td><td className="px-3 py-3 font-semibold">{formatMinutes(row.totalMinutes)}</td>
            <td className="px-3 py-3 text-emerald-600">{formatMinutes(row.overtimeMinutes)}</td><td className="px-3 py-3 text-red-600">{formatMinutes(row.shortfallMinutes)}</td>
            <td className="px-3 py-3">{row.lateDays}</td><td className="px-3 py-3">{row.earlyDays}</td><td className="px-3 py-3">{row.reviewDays}</td>
            <td className="px-3 py-3">{money(row.dailyPayment)}</td><td className="px-3 py-3">{money(row.basicSalary)}</td>
            <td className={`px-3 py-3 font-medium ${row.hoursAdjustment < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(row.hoursAdjustment)}</td>
            <td className="px-3 py-3">{money(row.bonus)}</td><td className="px-3 py-3 font-bold text-slate-800">{money(row.estimatedPay)}</td>
          </tr>)}</tbody></table>
        </div>
      )}

      {!loading && tab === 'daily' && <div className="space-y-3">
        {reviewDay && <ReviewPanel day={reviewDay} onClose={() => setReviewDay(null)} onSave={saveReview} saving={savingReview} />}
        <div className="card overflow-x-auto"><table className="min-w-[950px] w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          {['Date', 'Employee', 'Punches', 'First', 'Last', 'Worked', 'Flags', 'Action'].map((label) => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}
        </tr></thead><tbody className="divide-y divide-slate-100">{filteredDays.map((day) => <tr key={`${day.employeeCode}-${day.workDate}`} className="hover:bg-slate-50">
          <td className="px-3 py-3 font-medium">{day.workDate}</td><td className="px-3 py-3"><p className="font-medium text-slate-800">{day.name}</p><p className="text-xs text-slate-400">{day.employeeCode}</p></td>
          <td className="px-3 py-3">{day.punchCount}<p className="text-xs text-slate-400">{day.punches.map(timeOnly).join(' · ')}</p></td><td className="px-3 py-3">{timeOnly(day.firstPunch)}</td><td className="px-3 py-3">{timeOnly(day.lastPunch)}</td>
          <td className="px-3 py-3 font-semibold">{formatMinutes(day.workedMinutes)}</td><td className="px-3 py-3"><div className="flex flex-wrap gap-1">{day.flags.length ? day.flags.map((flag) => <Flag key={flag} type={flag} />) : <span className="text-xs text-emerald-600">OK</span>}</div></td>
          <td className="px-3 py-3">{day.needsReview && <button onClick={() => setReviewDay(day)} className="text-xs font-semibold text-blue-600 hover:text-blue-800">Review</button>}</td>
        </tr>)}</tbody></table></div>
      </div>}

      {!loading && tab === 'imports' && <div className="card overflow-hidden"><div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Recent uploads</h3></div><div className="divide-y divide-slate-100">{(data?.imports || []).map((item) => <div key={item.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium text-slate-800">{item.file_name}</p><p className="text-xs text-slate-400">Uploaded by {item.uploaded_by} · {new Date(item.uploaded_at).toLocaleString()}</p></div><p className="text-xs text-slate-500">{item.inserted_count} inserted · {item.record_count - item.inserted_count} duplicates</p></div>)}</div></div>}

      {!loading && tab === 'settings' && user?.role === 'admin' && settingsForm && <div className="space-y-5">
        <div className="card p-5"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-slate-800">Schedule and payroll rules</h3><p className="text-xs text-slate-500">Times are interpreted in America/Guatemala.</p></div><button onClick={saveSettings} disabled={savingSettings} className="btn-primary"><Save className="h-4 w-4" /> {savingSettings ? 'Saving…' : 'Save settings'}</button></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[
            ['weekdayStart', 'Weekday start', 'time', 1], ['weekdayEnd', 'Weekday end', 'time', 1], ['weekdayStandardMinutes', 'Weekday standard minutes', 'number', 1],
            ['saturdayStart', 'Saturday start', 'time', 1], ['saturdayEnd', 'Saturday end', 'time', 1], ['saturdayStandardMinutes', 'Saturday standard minutes', 'number', 1],
            ['payrollStandardMinutes', 'Payroll standard minutes', 'number', 1], ['hourlyAdjustmentRate', 'Hourly adjustment (Q)', 'number', '0.01'],
            ['fulltimeDailyRate', 'Full-time daily rate (Q)', 'number', '0.01'], ['fulltimeBonus', 'Full-time bonus (Q)', 'number', '0.01'],
          ].map(([key, label, type, step]) => <label key={key} className="text-xs font-medium text-slate-600">{label}<input type={type} step={step} value={settingsForm[key]} onChange={(event) => setSettingsForm((current) => ({ ...current, [key]: event.target.value }))} className="input-base mt-1 w-full" /></label>)}</div>
        </div>
        <div className="card overflow-hidden"><div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Employee daily payments</h3><p className="text-xs text-slate-500">Changes take effect from {from}; historical rates remain attached to earlier payrolls.</p></div><div className="max-h-[520px] overflow-auto"><table className="w-full"><thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Daily payment</th><th className="px-3 py-2 text-center">Q125 bonus</th><th /></tr></thead><tbody>{(data?.employees || []).map((employee) => <EmployeeRateRow key={`${employee.employeeCode}-${employee.dailyPayment}-${employee.bonusEligible}`} employee={employee} settings={data.settings} effectiveFrom={from} onSaved={load} getToken={getToken} />)}</tbody></table></div></div>
      </div>}
    </div>
  )
}
