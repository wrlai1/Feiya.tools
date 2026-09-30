import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Archive, CalendarDays, CheckCircle2, Download, Pencil,
  FileText, RefreshCw, RotateCcw, Save, Search, Settings, Trash2, Upload, Users, X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { attendancePunchLabel, formatMinutes, parseAttendanceFiles, payrollRangeForDate, payrollRangesBetween, standardMinutesForSchedule } from '../utils/factoryAttendance.js'
import { buildAttendanceWorkbook } from '../utils/factoryAttendanceExcel.js'

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

function payrollCode(value) {
  return `WSL${String(value).padStart(3, '0')}`
}

function timeOnly(value) {
  return value ? String(value).slice(11, 16) : '—'
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' })
}

function downloadBuffer(buffer, fileName) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function Flag({ type }) {
  const labels = {
    needs_review: ['Needs review', 'bg-red-100 text-red-700'],
    late: ['Late', 'bg-amber-100 text-amber-700'],
    early: ['Early', 'bg-orange-100 text-orange-700'],
    below_standard: ['Under hours', 'bg-violet-100 text-violet-700'],
    in_progress: ['In progress', 'bg-blue-100 text-blue-700'],
    missing_lunch: ['Missing lunch punches', 'bg-red-100 text-red-700'],
    possible_early_work: ['Possible early work', 'bg-purple-100 text-purple-700'],
    possible_overtime: ['Possible overtime', 'bg-purple-100 text-purple-700'],
    manually_adjusted: ['Manually adjusted', 'bg-blue-100 text-blue-700'],
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
  const [late, setLate] = useState(Boolean(day.manuallyConfirmed ? day.late : day.possibleLate))
  const [early, setEarly] = useState(Boolean(day.manuallyConfirmed ? day.early : day.punchCount > 1 && day.possibleEarly))
  const [punches, setPunches] = useState(day.punches.map((punch) => String(punch).slice(11, 19)).join(', '))
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-slate-800">Edit {day.name} · {day.workDate}</p>
          <div className="mt-2 flex flex-wrap gap-2">{day.punches.map((punch, index) => <span key={punch} className="rounded-lg bg-white px-2 py-1 text-xs text-slate-600"><span className="font-semibold">{attendancePunchLabel(day, index)}:</span> {timeOnly(punch)}</span>)}</div>
        </div>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800">Cancel</button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
          Punch times
          <input value={punches} onChange={(event) => setPunches(event.target.value)} placeholder="06:55:00, 12:00:00, 13:00:00, 17:05:00" className="input-base mt-1 w-full font-mono" />
          <span className="mt-1 block font-normal text-slate-500">Separate times with commas. Original punches remain in the audit history.</span>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Total hours override
          <input type="number" min="0" max="24" step="0.01" value={hours} onChange={(event) => setHours(event.target.value)} className="input-base mt-1 w-full" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Reason / note (required)
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Required for audit trail" className="input-base mt-1 w-full" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-5 text-sm text-slate-700">
        <label className="flex items-center gap-2"><input type="checkbox" checked={late} onChange={(event) => setLate(event.target.checked)} /> Mark late</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={early} onChange={(event) => setEarly(event.target.checked)} /> Mark early</label>
        <button disabled={saving || hours === '' || !note.trim()} onClick={() => onSave({
          adjustedMinutes: Number(hours) * 60,
          note,
          late,
          early,
          punches: punches.split(',').map((value) => value.trim()).filter(Boolean),
        })} className="btn-primary ml-auto disabled:opacity-50">
          <CheckCircle2 className="h-4 w-4" /> Save changes
        </button>
      </div>
    </div>
  )
}

function EmployeeEditModal({ employee, onClose, onSave, onAttendance, onAddAttendance, saving }) {
  const [name, setName] = useState(employee.name || '')
  const [department, setDepartment] = useState(employee.department || '')
  const [reason, setReason] = useState('')
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !saving && onClose()}>
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold text-slate-800">Edit employee</h3><p className="text-xs text-slate-500">{payrollCode(employee.employeeCode)} · Active since {employee.activeFrom || 'first recorded punch'}</p></div><button onClick={onClose} disabled={saving} className="text-slate-400"><X className="h-4 w-4" /></button></div>
      <div className="mt-4 space-y-3">
        <label className="block text-xs font-medium text-slate-600">Name<input value={name} onChange={(event) => setName(event.target.value)} className="input-base mt-1 w-full" /></label>
        <label className="block text-xs font-medium text-slate-600">Department<input value={department} onChange={(event) => setDepartment(event.target.value)} className="input-base mt-1 w-full" /></label>
        <label className="block text-xs font-medium text-slate-600">Reason for change<input value={reason} onChange={(event) => setReason(event.target.value)} className="input-base mt-1 w-full" placeholder="Required for audit trail" /></label>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><button onClick={onAttendance} disabled={saving} className="btn-secondary justify-center"><CalendarDays className="h-4 w-4" /> View attendance days</button><button onClick={onAddAttendance} disabled={saving} className="btn-secondary justify-center"><Pencil className="h-4 w-4" /> Add missing day</button></div>
      <div className="mt-5 flex justify-end gap-2"><button onClick={onClose} disabled={saving} className="btn-secondary">Cancel</button><button onClick={() => onSave({ name, department, reason })} disabled={saving || !name.trim() || !reason.trim()} className="btn-primary disabled:opacity-40"><Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save profile'}</button></div>
    </div>
  </div>
}

function ArchiveEmployeeModal({ employee, today, onClose, onArchive, saving }) {
  const [activeTo, setActiveTo] = useState(today)
  const [confirmation, setConfirmation] = useState('')
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !saving && onClose()}>
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <h3 className="font-semibold text-slate-800">Archive {employee.name}?</h3>
      <p className="mt-1 text-sm text-slate-500">Past punches and reports remain available. Employee ID {employee.employeeCode} can be assigned again after this final work date.</p>
      <label className="mt-4 block text-xs font-medium text-slate-600">Final work date<input type="date" value={activeTo} onChange={(event) => setActiveTo(event.target.value)} className="input-base mt-1 w-full" /></label>
      <label className="mt-3 block text-xs font-medium text-slate-600">Type delete to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="input-base mt-1 w-full" autoComplete="off" /></label>
      <div className="mt-5 flex justify-end gap-2"><button onClick={onClose} disabled={saving} className="btn-secondary">Cancel</button><button onClick={() => onArchive({ activeTo, confirmation })} disabled={saving || confirmation.toLowerCase() !== 'delete'} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"><Archive className="h-4 w-4" /> {saving ? 'Archiving…' : 'Archive employee'}</button></div>
    </div>
  </div>
}

export default function FactoryAttendance() {
  const { user, getToken } = useAuth()
  const isAdmin = user?.role === 'admin'
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
  const [editEmployee, setEditEmployee] = useState(null)
  const [archiveEmployee, setArchiveEmployee] = useState(null)
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [savingReview, setSavingReview] = useState(false)
  const [settingsForm, setSettingsForm] = useState(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [summarySort, setSummarySort] = useState('name-asc')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [dailySort, setDailySort] = useState('date-desc')
  const [dailyFlag, setDailyFlag] = useState('all')
  const [importSort, setImportSort] = useState('newest')
  const [duplicateReport, setDuplicateReport] = useState(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [showManagement, setShowManagement] = useState(false)
  const [lastUpload, setLastUpload] = useState(null)
  const [pendingUpload, setPendingUpload] = useState(null)
  const [exporting, setExporting] = useState('')
  const [showClearPanel, setShowClearPanel] = useState(false)
  const [clearOptions, setClearOptions] = useState(null)
  const [clearScope, setClearScope] = useState('dates')
  const [clearDates, setClearDates] = useState([])
  const [clearingData, setClearingData] = useState(false)
  const [restoringClear, setRestoringClear] = useState(false)

  const load = useCallback(async (rangeFrom = from, rangeTo = to) => {
    setLoading(true)
    try {
      const next = await apiFetch(`?action=dashboard&from=${rangeFrom}&to=${rangeTo}`, {}, getToken)
      setData(next)
      setSettingsForm(next.settings)
      return next
    } catch (error) { toast.error(error.message) }
    finally { setLoading(false) }
  }, [from, getToken, to])

  useEffect(() => { load() }, [from, to])

  const prepareUpload = async (event) => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    if (files.length > 3) return toast.error('Please select no more than three attendance TXT files')
    if (files.some((file) => !file.name.toLowerCase().endsWith('.txt'))) return toast.error('Please select TXT attendance files only')
    setUploading(true)
    try {
      const payloadFiles = await Promise.all(files.map(async (file) => ({ fileName: file.name, content: await file.text() })))
      const dates = [...new Set(parseAttendanceFiles(payloadFiles).map((record) => record.punchedAt.slice(0, 10)))].sort()
      setPendingUpload({
        files: payloadFiles,
        dateSchedules: dates.map((workDate) => ({
          workDate,
          endTime: new Date(`${workDate}T00:00:00Z`).getUTCDay() === 6 ? '12:00' : '17:00',
        })),
      })
      setDuplicateReport(null)
      setLastUpload(null)
    } catch (error) { toast.error(error.message) }
    finally { setUploading(false) }
  }

  const upload = async () => {
    if (!pendingUpload) return
    setUploading(true)
    try {
      const result = await apiFetch('?action=import', {
        method: 'POST', body: JSON.stringify(pendingUpload),
      }, getToken)
      setDuplicateReport(result.duplicates ? result : null)
      const reportFrom = result.dateFrom
      const reportTo = result.dateTo
      setFrom(reportFrom)
      setTo(reportTo)
      if (result.exactFileDuplicate) toast.error('This exact file was already uploaded. No punches were added.')
      else toast.success(`Imported ${result.inserted} punches${result.duplicates ? `; skipped ${result.duplicates} duplicates` : ''}`)
      await load(reportFrom, reportTo)
      setLastUpload({ ...result, reportFrom, reportTo })
      setPendingUpload(null)
    } catch (error) { toast.error(error.message) }
    finally { setUploading(false) }
  }

  const saveReview = async ({ adjustedMinutes, note, late, early, punches }) => {
    setSavingReview(true)
    try {
      const originalPunches = reviewDay.punches.map((punch) => String(punch).slice(11, 19))
      if (JSON.stringify(originalPunches) !== JSON.stringify(punches)) {
        await apiFetch('?action=punches', {
          method: 'PATCH',
          body: JSON.stringify({ employeeCode: reviewDay.employeeCode, workDate: reviewDay.workDate, punches, reason: note }),
        }, getToken)
      }
      await apiFetch('?action=review', {
        method: 'PATCH',
        body: JSON.stringify({ employeeCode: reviewDay.employeeCode, workDate: reviewDay.workDate, adjustedMinutes, note, late, early }),
      }, getToken)
      toast.success('Attendance changes saved')
      setReviewDay(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingReview(false) }
  }

  const saveEmployeeDetails = async (changes) => {
    setSavingEmployee(true)
    try {
      await apiFetch('?action=employee-details', {
        method: 'PATCH', body: JSON.stringify({ employeeCode: editEmployee.employeeCode, ...changes }),
      }, getToken)
      toast.success('Employee details updated')
      setEditEmployee(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingEmployee(false) }
  }

  const archiveSelectedEmployee = async ({ activeTo, confirmation }) => {
    setSavingEmployee(true)
    try {
      await apiFetch('?action=archive-employee', {
        method: 'POST', body: JSON.stringify({ employeeCode: archiveEmployee.employeeCode, activeTo, confirmation }),
      }, getToken)
      toast.success('Employee archived; historical attendance was preserved')
      setArchiveEmployee(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingEmployee(false) }
  }

  const reinstateEmployee = async (employee) => {
    const activeFrom = window.prompt(`Return date for ${employee.name}`, today)
    if (!activeFrom) return
    setSavingEmployee(true)
    try {
      await apiFetch('?action=reinstate-employee', {
        method: 'POST', body: JSON.stringify({ historyId: employee.id, activeFrom }),
      }, getToken)
      toast.success(`${employee.name} reinstated`)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setSavingEmployee(false) }
  }

  const addAttendanceDay = (employee) => {
    const workDate = window.prompt(`Work date for ${employee.name}`, today)
    if (!workDate) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return toast.error('Use a valid date in YYYY-MM-DD format')
    setEditEmployee(null)
    setTab('daily')
    setQuery(String(employee.employeeCode))
    setReviewDay({
      employeeCode: employee.employeeCode,
      name: employee.name,
      department: employee.department,
      workDate,
      punches: [],
      punchCount: 0,
      workedMinutes: 0,
      possibleLate: false,
      possibleEarly: false,
      reviewNote: '',
    })
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
    const rows = (data?.summary || []).filter((row) => (
      (!search || `${row.employeeCode} ${payrollCode(row.employeeCode)} ${row.name} ${row.department}`.toLowerCase().includes(search))
      && (departmentFilter === 'all' || row.department === departmentFilter)
    ))
    return [...rows].sort((a, b) => {
      if (summarySort === 'name-desc') return compareText(b.name, a.name)
      if (summarySort === 'hours-desc') return b.totalMinutes - a.totalMinutes
      if (summarySort === 'hours-asc') return a.totalMinutes - b.totalMinutes
      if (summarySort === 'days-desc') return b.workdays - a.workdays
      if (summarySort === 'review-desc') return b.reviewDays - a.reviewDays
      return compareText(a.name, b.name)
    })
  }, [data?.summary, departmentFilter, query, summarySort])
  const filteredDays = useMemo(() => {
    const search = query.trim().toLowerCase()
    const rows = (data?.days || []).filter((row) => (
      (!search || `${row.employeeCode} ${payrollCode(row.employeeCode)} ${row.name} ${row.department} ${row.workDate}`.toLowerCase().includes(search))
      && (dailyFlag === 'all' || row.flags.includes(dailyFlag))
    ))
    return [...rows].sort((a, b) => {
      if (dailySort === 'date-asc') return compareText(a.workDate, b.workDate)
      if (dailySort === 'name-asc') return compareText(a.name, b.name)
      if (dailySort === 'name-desc') return compareText(b.name, a.name)
      if (dailySort === 'hours-desc') return Number(b.workedMinutes ?? -1) - Number(a.workedMinutes ?? -1)
      if (dailySort === 'punches-desc') return b.punchCount - a.punchCount
      return compareText(b.workDate, a.workDate)
    })
  }, [dailyFlag, dailySort, data?.days, query])
  const filteredArchived = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (data?.archivedEmployees || []).filter((row) => (
      !search || `${row.employeeCode} ${payrollCode(row.employeeCode)} ${row.name} ${row.department}`.toLowerCase().includes(search)
    ))
  }, [data?.archivedEmployees, query])

  const sortedImports = useMemo(() => [...(data?.imports || [])].sort((a, b) => (
    importSort === 'oldest'
      ? new Date(a.uploaded_at) - new Date(b.uploaded_at)
      : importSort === 'duplicates-desc'
        ? (b.record_count - b.inserted_count) - (a.record_count - a.inserted_count)
        : new Date(b.uploaded_at) - new Date(a.uploaded_at)
  )), [data?.imports, importSort])
  const latestActiveImportId = useMemo(() => sortedImports
    .filter((item) => !item.reverted_at)
    .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at))[0]?.id, [sortedImports])
  const departments = useMemo(() => [...new Set((data?.summary || []).map((row) => row.department).filter(Boolean))].sort(compareText), [data?.summary])
  const payrollOptions = useMemo(() => {
    const current = { start: initialRange.start, end: today < initialRange.end ? today : initialRange.end }
    const ranges = new Map()
    for (const item of data?.imports || []) {
      if (!item.date_from || !item.date_to) continue
      for (const uploadedRange of payrollRangesBetween(item.date_from, item.date_to)) {
        const range = { start: uploadedRange.payrollStart, end: uploadedRange.payrollEnd }
        const key = `${range.start}|${range.end}`
        if (range.start !== initialRange.start || range.end !== initialRange.end) ranges.set(key, range)
      }
    }
    return [
      { value: 'current', label: `Current payroll · ${current.start}—${current.end}`, ...current },
      ...[...ranges.entries()]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([value, range]) => ({ value, label: `${range.start}—${range.end}`, ...range })),
    ]
  }, [data?.imports, initialRange.end, initialRange.start, today])
  const selectedPayroll = payrollOptions.find((option) => option.start === from && option.end === to)?.value || 'custom'
  const latestActiveClearId = useMemo(() => (data?.clearEvents || []).find((event) => !event.restored_at)?.id, [data?.clearEvents])

  const rollbackImport = async (item) => {
    if (!window.confirm(`Return attendance data to the version before “${item.file_name}”?`)) return
    setRollingBack(true)
    try {
      const result = await apiFetch('?action=rollback-import', {
        method: 'PATCH', body: JSON.stringify({ importId: Number(item.id) }),
      }, getToken)
      toast.success(`Restored previous version; removed ${result.removedPunches} punches from calculations`)
      setDuplicateReport(null)
      setLastUpload(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setRollingBack(false) }
  }

  const openClearPanel = async () => {
    setShowClearPanel(true)
    setClearOptions(null)
    setClearScope('dates')
    setClearDates([])
    try {
      setClearOptions(await apiFetch('?action=clear-options', {}, getToken))
    } catch (error) {
      toast.error(error.message)
      setShowClearPanel(false)
    }
  }

  const clearAttendanceData = async () => {
    const selected = clearScope === 'all' ? [] : clearDates
    if (clearScope !== 'all' && !selected.length) return
    const selectedPunches = clearScope === 'all'
      ? Number(clearOptions?.punchCount || 0)
      : (clearOptions?.dates || [])
        .filter((item) => selected.includes(item.workDate))
        .reduce((sum, item) => sum + item.punchCount, 0)
    const description = clearScope === 'all'
      ? `all ${selectedPunches} active attendance punches`
      : `${selectedPunches} punches from ${selected.length} selected date${selected.length === 1 ? '' : 's'}`
    if (!window.confirm(`Clear ${description}? This creates a restorable cleanup version.`)) return
    setClearingData(true)
    try {
      const result = await apiFetch('?action=clear-data', {
        method: 'POST',
        body: JSON.stringify({ scope: clearScope, dates: selected }),
      }, getToken)
      toast.success(`Cleared ${result.removedPunches} punches for ${result.affectedEmployees} employees`)
      setShowClearPanel(false)
      setLastUpload(null)
      setDuplicateReport(null)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setClearingData(false) }
  }

  const restoreClear = async (event) => {
    if (!window.confirm('Restore the attendance data removed by this cleanup?')) return
    setRestoringClear(true)
    try {
      const result = await apiFetch('?action=restore-clear', {
        method: 'PATCH', body: JSON.stringify({ clearEventId: Number(event.id) }),
      }, getToken)
      toast.success(`Restored ${result.restoredPunches} attendance punches`)
      await load()
    } catch (error) { toast.error(error.message) }
    finally { setRestoringClear(false) }
  }

  const exportAttendanceReport = async () => {
    if (!data) return
    setExporting('attendance')
    try {
      const { default: ExcelJS } = await import('exceljs')
      const reportFrom = lastUpload?.dateFrom || from
      const reportTo = lastUpload?.reportTo || to
      const reportData = await apiFetch(`?action=dashboard&from=${reportFrom}&to=${reportTo}`, {}, getToken)
      const selectedDates = lastUpload?.dateSchedules?.map((schedule) => schedule.workDate)
      const reportDays = selectedDates?.length
        ? reportData.days.filter((day) => selectedDates.includes(day.workDate))
        : reportData.days
      const exportDates = selectedDates?.length
        ? selectedDates
        : [...new Set(reportDays.map((day) => day.workDate))]
      const workbook = buildAttendanceWorkbook(ExcelJS, {
        days: reportDays,
        employees: reportData.employees,
        exportDates,
        from: reportFrom,
        to: reportTo,
      })
      downloadBuffer(await workbook.xlsx.writeBuffer(), `attendance-${reportFrom}-to-${reportTo}.xlsx`)
      toast.success('Attendance Excel downloaded')
    } catch (error) { toast.error(error.message) }
    finally { setExporting('') }
  }

  const pending = (data?.days || []).filter((day) => day.needsReview).length
  const tabs = [
    ['summary', 'Attendance Summary'], ['daily', 'Daily Review'], ['imports', 'Import History'], ['archived', 'Archived Employees'],
    ...(user?.role === 'admin' ? [['settings', 'Settings']] : []),
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Factory Attendance</h2>
          <p className="mt-1 text-sm text-slate-500">Guatemala time · Payroll periods: 6–20 and 21–5</p>
        </div>
        {!showManagement ? (
          isAdmin ?
          <button onClick={() => setShowManagement(true)} className="btn-secondary"><Settings className="h-4 w-4" /> Attendance Management</button>
          : null
        ) : <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-500">Payroll period<select value={selectedPayroll} onChange={(event) => {
            const option = payrollOptions.find((item) => item.value === event.target.value)
            if (option) { setFrom(option.start); setTo(option.end) }
          }} className="input-base mt-1 block min-w-64"><option value="custom">Custom range</option>{payrollOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="text-xs font-medium text-slate-500">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="input-base mt-1 block" /></label>
          <label className="text-xs font-medium text-slate-500">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="input-base mt-1 block" /></label>
          <button onClick={() => { setFrom(initialRange.start); setTo(today < initialRange.end ? today : initialRange.end) }} className="btn-secondary"><CalendarDays className="h-4 w-4" /> Current payroll</button>
          <button onClick={load} disabled={loading} className="btn-secondary"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          <button onClick={openClearPanel} disabled={loading || clearingData} className="btn-secondary text-red-600 disabled:opacity-50"><Trash2 className="h-4 w-4" /> Clear data</button>
          <button onClick={() => setShowManagement(false)} className="btn-secondary">Simple Upload</button>
          <button onClick={exportAttendanceReport} disabled={!data || exporting} className="btn-primary"><Download className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Download Attendance Excel'}</button>
        </div>}
      </div>

      {editEmployee && <EmployeeEditModal employee={editEmployee} onClose={() => setEditEmployee(null)} onSave={saveEmployeeDetails} onAttendance={() => { setQuery(String(editEmployee.employeeCode)); setTab('daily'); setEditEmployee(null) }} onAddAttendance={() => addAttendanceDay(editEmployee)} saving={savingEmployee} />}
      {archiveEmployee && <ArchiveEmployeeModal employee={archiveEmployee} today={today} onClose={() => setArchiveEmployee(null)} onArchive={archiveSelectedEmployee} saving={savingEmployee} />}

      {showClearPanel && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !clearingData && setShowClearPanel(false)}>
        <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div><h3 className="font-semibold text-slate-800">Clear attendance data</h3><p className="mt-1 text-xs text-slate-500">Employees, rates, and settings are kept. Only punches and their daily reviews are cleared.</p></div>
            <button onClick={() => setShowClearPanel(false)} disabled={clearingData} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-4 p-5">
            {!clearOptions ? <div className="flex items-center justify-center py-10 text-sm text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading attendance dates…</div> : <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={`cursor-pointer rounded-xl border-2 p-3 ${clearScope === 'dates' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><input type="radio" name="clearScope" checked={clearScope === 'dates'} onChange={() => setClearScope('dates')} className="mr-2" /><span className="text-sm font-semibold text-slate-800">Selected dates</span><span className="mt-1 block text-xs text-slate-500">Choose one or several workdays.</span></label>
                <label className={`cursor-pointer rounded-xl border-2 p-3 ${clearScope === 'all' ? 'border-red-500 bg-red-50' : 'border-slate-200'}`}><input type="radio" name="clearScope" checked={clearScope === 'all'} onChange={() => setClearScope('all')} className="mr-2" /><span className="text-sm font-semibold text-slate-800">All history</span><span className="mt-1 block text-xs text-slate-500">Clear all {clearOptions.punchCount} active punches.</span></label>
              </div>
              {clearScope === 'dates' && <div className="rounded-xl border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2"><span className="text-xs font-semibold text-slate-600">Available dates</span><div className="flex gap-3"><button type="button" onClick={() => setClearDates((clearOptions.dates || []).map((item) => item.workDate))} className="text-xs font-medium text-blue-600">Select all</button><button type="button" onClick={() => setClearDates([])} className="text-xs font-medium text-slate-500">Clear selection</button></div></div>
                <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto">{(clearOptions.dates || []).map((item) => <label key={item.workDate} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50"><span className="flex items-center gap-3"><input type="checkbox" checked={clearDates.includes(item.workDate)} onChange={(event) => setClearDates((current) => event.target.checked ? [...current, item.workDate] : current.filter((date) => date !== item.workDate))} /><span className="text-sm font-medium text-slate-700">{item.workDate}</span></span><span className="text-xs text-slate-400">{item.employeeCount} employees · {item.punchCount} punches</span></label>)}{!clearOptions.dates?.length && <p className="px-3 py-8 text-center text-sm text-slate-400">No active attendance data</p>}</div>
              </div>}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">A cleanup version is saved in Import History. It can be restored until another attendance file is uploaded.</div>
              <div className="flex gap-3"><button type="button" onClick={() => setShowClearPanel(false)} disabled={clearingData} className="btn-secondary flex-1 justify-center">Cancel</button><button type="button" onClick={clearAttendanceData} disabled={clearingData || !clearOptions.punchCount || (clearScope === 'dates' && !clearDates.length)} className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"><Trash2 className="h-4 w-4" /> {clearingData ? 'Clearing…' : clearScope === 'all' ? 'Clear all data' : 'Clear selected dates'}</button></div>
            </>}
          </div>
        </div>
      </div>}

      <div className="card flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-50 p-3 text-blue-600"><Upload className="h-5 w-5" /></span>
          <div><p className="font-semibold text-slate-800">Upload attendance TXT files</p><p className="text-xs text-slate-500">Select files from one, two, or all three machines. Punches are merged by employee and time.</p></div>
        </div>
        <input ref={fileRef} type="file" accept=".txt,text/plain" multiple onChange={prepareUpload} className="hidden" />
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-primary justify-center disabled:opacity-50">
          <FileText className="h-4 w-4" /> {uploading ? 'Reading…' : pendingUpload ? 'Change TXT Files' : 'Choose TXT Files'}
        </button>
      </div>

      {pendingUpload && <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="font-bold text-blue-900">Choose the scheduled end time for each date</p><p className="mt-1 text-xs text-blue-700">Weekdays default to 17:00. Saturday keeps the 12:00 half-day default. Remove any date you do not want to import. Each kept day is finalized 30 minutes after its selected end time.</p><p className="mt-2 text-xs text-blue-600">{pendingUpload.files.map((file) => file.fileName).join(' · ')}</p></div>
          <div className="flex flex-wrap gap-2"><button onClick={() => setPendingUpload(null)} disabled={uploading} className="btn-secondary disabled:opacity-50">Cancel</button><button onClick={upload} disabled={uploading || pendingUpload.dateSchedules.length === 0 || pendingUpload.dateSchedules.some((schedule) => Number(standardMinutesForSchedule(schedule.workDate, schedule.endTime)) <= 0)} className="btn-primary disabled:opacity-50"><Upload className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Confirm Upload'}</button></div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{pendingUpload.dateSchedules.map((schedule) => {
          const standardMinutes = standardMinutesForSchedule(schedule.workDate, schedule.endTime)
          return <div key={schedule.workDate} className="rounded-xl border border-blue-200 bg-white p-3 text-xs font-medium text-slate-600"><div className="flex items-center justify-between gap-3"><span>{schedule.workDate}</span><button type="button" onClick={() => setPendingUpload((current) => ({ ...current, dateSchedules: current.dateSchedules.filter((item) => item.workDate !== schedule.workDate) }))} disabled={uploading} className="rounded px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label={`Remove ${schedule.workDate}`}>×</button></div><label className="mt-2 block"><span className="flex items-center justify-between gap-3"><span>Scheduled end</span><span className="font-normal text-blue-600">{standardMinutes > 0 ? formatMinutes(standardMinutes) : 'Choose a later time'}</span></span><input type="time" min="08:01" value={schedule.endTime} onChange={(event) => setPendingUpload((current) => ({ ...current, dateSchedules: current.dateSchedules.map((item) => item.workDate === schedule.workDate ? { ...item, endTime: event.target.value } : item) }))} className="input-base mt-1 w-full" /></label></div>
        })}{pendingUpload.dateSchedules.length === 0 && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">Keep at least one date to continue.</div>}</div>
      </div>}

      {duplicateReport && <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <summary className="cursor-pointer font-semibold text-amber-900">{duplicateReport.duplicates} duplicate punch{duplicateReport.duplicates === 1 ? '' : 'es'} skipped · View details</summary>
        <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-amber-900">{duplicateReport.duplicates} duplicate punch{duplicateReport.duplicates === 1 ? '' : 'es'} found</p><p className="text-xs text-amber-700">Nothing below was added twice. Check the employee and exact timestamp.</p></div><button onClick={() => setDuplicateReport(null)} className="text-xs font-medium text-amber-700">Dismiss</button></div>
        <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-amber-200 bg-white"><table className="w-full text-xs"><thead className="sticky top-0 bg-amber-50 text-left text-amber-800"><tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Timestamp</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Reason</th></tr></thead><tbody className="divide-y divide-amber-100">{(duplicateReport.duplicateDetails || []).map((item, index) => <tr key={`${item.employeeCode}-${item.punchedAt}-${item.deviceId}-${index}`}><td className="px-3 py-2">{item.name || `ID ${item.employeeCode}`}</td><td className="px-3 py-2 font-mono">{item.punchedAt.replace('T', ' ')}</td><td className="px-3 py-2">{item.sourceFile || '—'}</td><td className="px-3 py-2">{item.reason === 'repeated_in_file' ? 'Repeated inside this batch' : 'Already uploaded earlier'}</td></tr>)}</tbody></table></div>
      </details>}

      {lastUpload && !showManagement && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><p className="text-lg font-bold text-emerald-900">Attendance is ready</p><p className="mt-1 text-sm text-emerald-800">{lastUpload.reportFrom}—{lastUpload.reportTo} · {lastUpload.sourceFiles?.length || 1} machine file(s) · {data?.summary?.length || 0} employees · {lastUpload.inserted} new punches · {lastUpload.duplicates} duplicates · {pending} need review</p><p className="mt-1 text-xs text-emerald-700">Download the simple hours-and-days Excel. Incomplete punch days are marked red for review.</p></div><div className="flex flex-wrap gap-2"><button onClick={exportAttendanceReport} disabled={exporting || loading || rollingBack} className="btn-primary disabled:opacity-50"><Download className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Download Attendance Excel'}</button>{isAdmin && pending > 0 && <button onClick={() => { setShowManagement(true); setTab('daily'); setDailyFlag('needs_review') }} className="btn-secondary text-red-600"><AlertTriangle className="h-4 w-4" /> Review exceptions</button>}{isAdmin && !lastUpload.exactFileDuplicate && <button onClick={() => rollbackImport({ id: lastUpload.importId, file_name: lastUpload.sourceFiles?.join(', ') || 'this upload' })} disabled={rollingBack || exporting || loading} className="btn-secondary text-red-600 disabled:opacity-50"><RotateCcw className={`h-4 w-4 ${rollingBack ? 'animate-spin' : ''}`} /> {rollingBack ? 'Removing…' : 'Undo this upload'}</button>}</div></div>
      </div>}

      {isAdmin && showManagement && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard label="Employees" value={data?.summary?.length || 0} helper="Registered attendance employees" icon={Users} />
        <SummaryCard label="Needs review" value={pending} helper="Weekdays need 4 punches; Saturday needs 2 or 4" icon={AlertTriangle} color={pending ? 'red' : 'green'} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {tabs.map(([value, label]) => <button key={value} onClick={() => setTab(value)} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}
        </div>
        <div className="flex flex-wrap gap-2">
          {(tab === 'summary' || tab === 'daily' || tab === 'archived') && <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or employee ID" className="input-base pl-9" /></div>}
          {tab === 'summary' && <><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)} className="input-base"><option value="all">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select><select value={summarySort} onChange={(event) => setSummarySort(event.target.value)} className="input-base"><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="hours-desc">Hours high–low</option><option value="hours-asc">Hours low–high</option><option value="days-desc">Days high–low</option><option value="review-desc">Reviews high–low</option></select></>}
          {tab === 'daily' && <><select value={dailyFlag} onChange={(event) => setDailyFlag(event.target.value)} className="input-base"><option value="all">All statuses</option><option value="in_progress">In progress</option><option value="needs_review">Needs review</option><option value="manually_adjusted">Manually adjusted</option><option value="missing_lunch">Missing lunch punches</option><option value="possible_overtime">Possible overtime</option><option value="possible_early_work">Possible early work</option><option value="late">Late</option><option value="early">Early</option><option value="below_standard">Under hours</option></select><select value={dailySort} onChange={(event) => setDailySort(event.target.value)} className="input-base"><option value="date-desc">Date newest</option><option value="date-asc">Date oldest</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="hours-desc">Hours high–low</option><option value="punches-desc">Punches high–low</option></select></>}
          {tab === 'imports' && <select value={importSort} onChange={(event) => setImportSort(event.target.value)} className="input-base"><option value="newest">Newest version</option><option value="oldest">Oldest version</option><option value="duplicates-desc">Duplicates high–low</option></select>}
        </div>
      </div>

      {loading && <div className="card flex items-center justify-center py-16 text-slate-500"><RefreshCw className="mr-3 h-5 w-5 animate-spin text-blue-500" /> Loading attendance…</div>}

      {!loading && tab === 'summary' && (
        <div className="card overflow-x-auto">
          <table className="min-w-[900px] w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            {['ID / Employee', 'Attendance Days', 'Confirmed Days', 'Total Hours', 'Late', 'Early', 'Needs Review', 'Actions'].map((label) => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}
          </tr></thead><tbody className="divide-y divide-slate-100">{filteredSummary.map((row) => <tr key={row.employeeCode} className="hover:bg-slate-50">
            <td className="px-3 py-3"><p className="font-medium text-slate-800">{row.name}</p><p className="text-xs text-slate-400">{payrollCode(row.employeeCode)} · {row.department || 'No department'}</p></td>
            <td className="px-3 py-3">{row.attendanceDays}</td><td className="px-3 py-3">{row.workdays}</td><td className="px-3 py-3 font-semibold">{formatMinutes(row.totalMinutes)}</td>
            <td className="px-3 py-3">{row.lateDays}</td><td className="px-3 py-3">{row.earlyDays}</td><td className="px-3 py-3">{row.reviewDays}</td>
            <td className="px-3 py-3">{(() => { const employee = data.employees.find((item) => item.employeeCode === row.employeeCode) || row; return employee.active === false ? <span className="text-xs text-slate-400">Archived record</span> : <div className="flex gap-2"><button onClick={() => setEditEmployee(employee)} className="text-xs font-semibold text-blue-600"><Pencil className="mr-1 inline h-3.5 w-3.5" />Edit</button><button onClick={() => setArchiveEmployee(employee)} className="text-xs font-semibold text-red-600"><Archive className="mr-1 inline h-3.5 w-3.5" />Archive</button></div> })()}</td>
          </tr>)}</tbody></table>
        </div>
      )}

      {!loading && tab === 'daily' && <div className="space-y-3">
        {reviewDay && <ReviewPanel day={reviewDay} onClose={() => setReviewDay(null)} onSave={saveReview} saving={savingReview} />}
        <div className="card overflow-x-auto"><table className="min-w-[950px] w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          {['Date', 'Employee', 'Punches', 'First', 'Last', 'Worked', 'Flags', 'Action'].map((label) => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}
        </tr></thead><tbody className="divide-y divide-slate-100">{filteredDays.map((day) => <tr key={`${day.employeeCode}-${day.workDate}`} className="hover:bg-slate-50">
          <td className="px-3 py-3 font-medium">{day.workDate}<p className="text-xs font-normal text-slate-400">Ends {day.scheduledEnd || '—'}</p></td><td className="px-3 py-3"><p className="font-medium text-slate-800">{day.name}</p><p className="text-xs text-slate-400">{day.employeeCode}</p></td>
          <td className="px-3 py-3">{day.punchCount}<p className="text-xs text-slate-400">{day.punches.map(timeOnly).join(' · ')}</p></td><td className="px-3 py-3">{timeOnly(day.firstPunch)}</td><td className="px-3 py-3">{timeOnly(day.lastPunch)}</td>
          <td className="px-3 py-3 font-semibold">{formatMinutes(day.workedMinutes)}</td><td className="px-3 py-3"><div className="flex flex-wrap gap-1">{day.flags.length ? day.flags.map((flag) => <Flag key={flag} type={flag} />) : <span className="text-xs text-emerald-600">OK</span>}</div></td>
          <td className="px-3 py-3"><button onClick={() => setReviewDay(day)} className="text-xs font-semibold text-blue-600 hover:text-blue-800"><Pencil className="mr-1 inline h-3.5 w-3.5" />{day.needsReview ? 'Review / Edit' : 'Edit'}</button></td>
        </tr>)}</tbody></table></div>
      </div>}

      {!loading && tab === 'archived' && <div className="card overflow-x-auto">
        <div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Archived employees</h3><p className="text-xs text-slate-500">Historical punches remain attached to the employee and employment dates. Reinstate is available only while the employee ID is not active.</p></div>
        <table className="min-w-[850px] w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">{['ID / Employee', 'Department', 'Employment period', 'Archived by', 'Status', 'Action'].map((label) => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{filteredArchived.map((employee) => <tr key={employee.id} className="hover:bg-slate-50"><td className="px-3 py-3"><p className="font-medium text-slate-800">{employee.name}</p><p className="text-xs text-slate-400">{payrollCode(employee.employeeCode)}</p></td><td className="px-3 py-3">{employee.department || '—'}</td><td className="px-3 py-3">{employee.activeFrom || 'Unknown'}—{employee.activeTo}</td><td className="px-3 py-3">{employee.archivedBy}<p className="text-xs text-slate-400">{new Date(employee.archivedAt).toLocaleString()}</p></td><td className="px-3 py-3">{employee.reinstatedAt ? <span className="text-xs font-semibold text-emerald-600">Reinstated {new Date(employee.reinstatedAt).toLocaleDateString()}</span> : <span className="text-xs font-semibold text-slate-500">Archived</span>}</td><td className="px-3 py-3">{!employee.reinstatedAt && <button onClick={() => reinstateEmployee(employee)} disabled={savingEmployee} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" /> Reinstate</button>}</td></tr>)}{!filteredArchived.length && <tr><td colSpan="6" className="px-4 py-12 text-center text-sm text-slate-400">No archived employees match this search.</td></tr>}</tbody>
        </table>
      </div>}

      {!loading && tab === 'imports' && <div className="space-y-4">
        {!!data?.clearEvents?.length && <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Cleanup history</h3><p className="text-xs text-slate-500">Cleared punches stay in the audit trail and the latest cleanup can be restored before another upload.</p></div>
          <div className="divide-y divide-slate-100">{data.clearEvents.map((event) => <div key={event.id} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${event.restored_at ? 'bg-slate-50 opacity-70' : ''}`}>
            <div><p className="text-sm font-medium text-slate-800">{event.scope === 'all' ? 'All attendance history' : `${event.dates?.length || 0} selected date${event.dates?.length === 1 ? '' : 's'}`} <span className="ml-1 text-xs font-normal text-slate-400">Cleanup #{event.id}</span></p><p className="text-xs text-slate-400">{event.scope === 'all' ? 'All dates' : (event.dates || []).join(' · ')} · {new Date(event.cleared_at).toLocaleString()}</p><p className="text-xs text-slate-500">{event.punch_count} punches · {event.employee_count} employees · cleared by {event.cleared_by}</p>{event.restored_at && <p className="text-xs text-emerald-600">Restored by {event.restored_by} · {new Date(event.restored_at).toLocaleString()}</p>}</div>
            {!event.restored_at && Number(event.id) === Number(latestActiveClearId) && <button onClick={() => restoreClear(event)} disabled={restoringClear} className="btn-secondary self-start px-3 py-1.5 text-xs text-blue-600 disabled:opacity-50 sm:self-auto"><RotateCcw className={`h-3.5 w-3.5 ${restoringClear ? 'animate-spin' : ''}`} /> Restore cleanup</button>}
          </div>)}</div>
        </div>}
        <div className="card overflow-hidden"><div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Upload history</h3><p className="text-xs text-slate-500">Only the latest active upload can be rolled back, preserving a complete audit trail.</p></div><div className="divide-y divide-slate-100">{sortedImports.map((item) => <div key={item.id} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${item.reverted_at ? 'bg-slate-50 opacity-70' : ''}`}><div><p className="text-sm font-medium text-slate-800">{item.file_name} <span className="ml-1 text-xs font-normal text-slate-400">Version #{item.id}</span></p><p className="text-xs text-slate-400">{item.date_from || 'Unknown date'}—{item.date_to || 'Unknown date'} · {new Date(item.uploaded_at).toLocaleString()}</p>{item.date_schedules?.length > 0 && <p className="mt-1 text-xs text-blue-600">Scheduled ends: {item.date_schedules.map((schedule) => `${schedule.workDate} ${schedule.endTime}`).join(' · ')}</p>}{item.reverted_at && <p className="text-xs text-red-600">Rolled back by {item.reverted_by} · {new Date(item.reverted_at).toLocaleString()}</p>}</div><div className="flex items-center gap-3"><p className="text-xs text-slate-500">{item.inserted_count} inserted · {item.record_count - item.inserted_count} duplicates</p>{!item.reverted_at && Number(item.id) === Number(latestActiveImportId) && <button onClick={() => rollbackImport(item)} disabled={rollingBack} className="btn-secondary px-3 py-1.5 text-xs text-red-600 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" /> Restore previous</button>}</div></div>)}</div></div>
      </div>}

      {!loading && tab === 'settings' && user?.role === 'admin' && settingsForm && <div className="space-y-5">
        <div className="card p-5"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-slate-800">Attendance schedule</h3><p className="text-xs text-slate-500">Times are interpreted in America/Guatemala.</p></div><button onClick={saveSettings} disabled={savingSettings} className="btn-primary"><Save className="h-4 w-4" /> {savingSettings ? 'Saving…' : 'Save settings'}</button></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[
            ['weekdayStart', 'Weekday start', 'time', 1], ['weekdayEnd', 'Weekday end', 'time', 1], ['weekdayStandardMinutes', 'Weekday standard minutes', 'number', 1],
            ['saturdayStart', 'Saturday start', 'time', 1], ['saturdayEnd', 'Saturday end', 'time', 1], ['saturdayStandardMinutes', 'Saturday standard minutes', 'number', 1],
          ].map(([key, label, type, step]) => <label key={key} className="text-xs font-medium text-slate-600">{label}<input type={type} step={step} value={settingsForm[key]} onChange={(event) => setSettingsForm((current) => ({ ...current, [key]: event.target.value }))} className="input-base mt-1 w-full" /></label>)}</div>
        </div>
      </div>}
      </>}
    </div>
  )
}
