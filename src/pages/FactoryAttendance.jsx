import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarDays, CheckCircle2, Clock3, Download,
  FileText, RefreshCw, RotateCcw, Save, Search, Settings, Upload, Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { formatMinutes, payrollRangeForDate, payrollRangesBetween } from '../utils/factoryAttendance.js'

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

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' })
}

const EXCEL_COLORS = {
  header: 'FF1E3A5F', red: 'FFFFC7CE', yellow: 'FFFFEB9C', blue: 'FFDDEBF7', white: 'FFFFFFFF',
}

function downloadBuffer(buffer, fileName) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function styleWorksheet(sheet, headerRow, rowColor) {
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: EXCEL_COLORS.white } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_COLORS.header } }
  })
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }]
  sheet.autoFilter = { from: headerRow.getCell(1).address, to: headerRow.getCell(headerRow.cellCount).address }
  sheet.eachRow((row) => {
    if (row.number <= headerRow.number) return
    const color = rowColor?.(row.values)
    if (color) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } } })
  })
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
  const [summarySort, setSummarySort] = useState('name-asc')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [dailySort, setDailySort] = useState('date-desc')
  const [dailyFlag, setDailyFlag] = useState('all')
  const [importSort, setImportSort] = useState('newest')
  const [duplicateReport, setDuplicateReport] = useState(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [showManagement, setShowManagement] = useState(false)
  const [lastUpload, setLastUpload] = useState(null)
  const [exporting, setExporting] = useState(false)

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
      setDuplicateReport(result.duplicates ? result : null)
      const reportFrom = payrollRangeForDate(result.dateFrom).start
      const reportTo = result.dateTo
      setFrom(reportFrom)
      setTo(reportTo)
      if (result.exactFileDuplicate) toast.error('This exact file was already uploaded. No punches were added.')
      else toast.success(`Imported ${result.inserted} punches${result.duplicates ? `; skipped ${result.duplicates} duplicates` : ''}`)
      await load(reportFrom, reportTo)
      setLastUpload({ ...result, reportFrom, reportTo })
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
    const rows = (data?.summary || []).filter((row) => (
      (!search || `${row.employeeCode} ${row.name} ${row.department}`.toLowerCase().includes(search))
      && (departmentFilter === 'all' || row.department === departmentFilter)
    ))
    return [...rows].sort((a, b) => {
      if (summarySort === 'name-desc') return compareText(b.name, a.name)
      if (summarySort === 'hours-desc') return b.totalMinutes - a.totalMinutes
      if (summarySort === 'hours-asc') return a.totalMinutes - b.totalMinutes
      if (summarySort === 'days-desc') return b.workdays - a.workdays
      if (summarySort === 'pay-desc') return Number(b.estimatedPay ?? -1) - Number(a.estimatedPay ?? -1)
      if (summarySort === 'review-desc') return b.reviewDays - a.reviewDays
      return compareText(a.name, b.name)
    })
  }, [data?.summary, departmentFilter, query, summarySort])
  const filteredDays = useMemo(() => {
    const search = query.trim().toLowerCase()
    const rows = (data?.days || []).filter((row) => (
      (!search || `${row.employeeCode} ${row.name} ${row.department} ${row.workDate}`.toLowerCase().includes(search))
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
  const sortedEmployees = useMemo(() => [...(data?.employees || [])].sort((a, b) => compareText(a.name, b.name)), [data?.employees])
  const departments = useMemo(() => [...new Set((data?.summary || []).map((row) => row.department).filter(Boolean))].sort(compareText), [data?.summary])

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

  const exportWorkbook = async () => {
    if (!data) return
    setExporting(true)
    try {
      const { default: ExcelJS } = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Feiya Factory Attendance'
      const periods = payrollRangesBetween(from, to)
      for (const period of periods) {
        const periodData = await apiFetch(`?action=dashboard&from=${period.start}&to=${period.end}`, {}, getToken)
        const sheet = workbook.addWorksheet(`Summary ${period.payrollStart.slice(5)}-${period.payrollEnd.slice(5)}`.slice(0, 31))
        if (period.provisional) {
          const notice = sheet.addRow([`PROVISIONAL — payroll period ends ${period.payrollEnd}`])
          sheet.mergeCells(notice.number, 1, notice.number, 16)
          notice.getCell(1).font = { bold: true, color: { argb: 'FF9C5700' } }
          notice.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_COLORS.yellow } }
        }
        const header = sheet.addRow(['Code', 'Employee ID', 'Name', 'Department', 'Work Days', 'Total Hours', 'Overtime Hours', 'Shortfall Hours', 'Late', 'Early', 'Needs Review', 'Daily Payment', 'Basic Salary', 'Hours Adjustment', 'Bonus', 'Attendance Pay'])
        for (const row of periodData.summary) sheet.addRow([
          payrollCode(row.employeeCode), row.employeeCode, row.name, row.department, row.workdays,
          Number((row.totalMinutes / 60).toFixed(2)), Number((row.overtimeMinutes / 60).toFixed(2)),
          Number((row.shortfallMinutes / 60).toFixed(2)), row.lateDays, row.earlyDays, row.reviewDays,
          row.dailyPayment, row.basicSalary, Number(row.hoursAdjustment.toFixed(2)), row.bonus,
          row.estimatedPay == null ? null : Number(row.estimatedPay.toFixed(2)),
        ])
        sheet.columns = [12, 12, 24, 18, 11, 12, 14, 14, 8, 8, 14, 14, 14, 16, 12, 16].map((width) => ({ width }))
        styleWorksheet(sheet, header, (values) => Number(values[11]) > 0 || values[12] == null ? EXCEL_COLORS.red : null)
      }

      const dailySheet = workbook.addWorksheet('Daily Attendance')
      const dailyHeader = dailySheet.addRow(['Date', 'Code', 'Employee ID', 'Name', 'Department', 'First Punch', 'Last Punch', 'Punches', 'Worked Hours', 'Status', 'Flags', 'Note', 'Reviewed By', 'Reviewed At'])
      for (const day of data.days) dailySheet.addRow([
        day.workDate, payrollCode(day.employeeCode), day.employeeCode, day.name, day.department,
        timeOnly(day.firstPunch), timeOnly(day.lastPunch), day.punchCount,
        day.workedMinutes == null ? null : Number((day.workedMinutes / 60).toFixed(2)),
        day.manuallyConfirmed ? 'Manually Confirmed' : day.needsReview ? 'Needs Review' : 'Automatic',
        day.flags.join(', '), day.reviewNote, day.reviewedBy, day.reviewedAt ? new Date(day.reviewedAt).toLocaleString() : '',
      ])
      dailySheet.columns = [12, 12, 12, 24, 18, 12, 12, 10, 14, 20, 24, 28, 18, 22].map((width) => ({ width }))
      styleWorksheet(dailySheet, dailyHeader, (values) => {
        if (values[10] === 'Needs Review') return EXCEL_COLORS.red
        if (values[10] === 'Manually Confirmed') return EXCEL_COLORS.blue
        if (values[11]) return EXCEL_COLORS.yellow
        return null
      })

      const exceptionSheet = workbook.addWorksheet('Exceptions')
      const exceptionHeader = exceptionSheet.addRow(['Date', 'Code', 'Employee', 'Punches', 'Worked Hours', 'Status', 'Flags', 'Reason / Note'])
      for (const day of data.days.filter((item) => item.flags.length || item.manuallyConfirmed)) exceptionSheet.addRow([
        day.workDate, payrollCode(day.employeeCode), day.name, day.punchCount,
        day.workedMinutes == null ? null : Number((day.workedMinutes / 60).toFixed(2)),
        day.manuallyConfirmed ? 'Manually Confirmed' : day.needsReview ? 'Needs Review' : 'Warning',
        day.flags.join(', '), day.reviewNote,
      ])
      exceptionSheet.columns = [12, 12, 26, 10, 14, 20, 26, 32].map((width) => ({ width }))
      styleWorksheet(exceptionSheet, exceptionHeader, (values) => values[6] === 'Needs Review' ? EXCEL_COLORS.red : values[6] === 'Manually Confirmed' ? EXCEL_COLORS.blue : EXCEL_COLORS.yellow)

      const importSheet = workbook.addWorksheet('Import Report')
      const importHeader = importSheet.addRow(['File', 'Date From', 'Date To', 'Records', 'Inserted', 'Duplicates', 'Status'])
      const relevantImports = (data.imports || []).filter((item) => !item.reverted_at && item.date_to >= from && item.date_from <= to)
      for (const item of relevantImports) importSheet.addRow([item.file_name, item.date_from, item.date_to, item.record_count, item.inserted_count, item.record_count - item.inserted_count, 'Active'])
      importSheet.addRow([])
      const duplicateHeader = importSheet.addRow(['Duplicate Employee ID', 'Employee', 'Timestamp', 'Reason'])
      for (const item of relevantImports.flatMap((entry) => entry.duplicate_details || [])) importSheet.addRow([item.employeeCode, item.name, item.punchedAt?.replace('T', ' '), item.reason === 'repeated_in_file' ? 'Repeated inside file' : 'Already uploaded'])
      importSheet.columns = [30, 16, 22, 14, 14, 14, 18].map((width) => ({ width }))
      styleWorksheet(importSheet, importHeader)
      duplicateHeader.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_COLORS.yellow } } })

      downloadBuffer(await workbook.xlsx.writeBuffer(), `factory-attendance-${from}-to-${to}.xlsx`)
      toast.success('Excel downloaded')
    } catch (error) { toast.error(error.message) }
    finally { setExporting(false) }
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
        {!showManagement ? (
          <button onClick={() => setShowManagement(true)} className="btn-secondary"><Settings className="h-4 w-4" /> Attendance Management</button>
        ) : <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-500">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="input-base mt-1 block" /></label>
          <label className="text-xs font-medium text-slate-500">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="input-base mt-1 block" /></label>
          <button onClick={() => { setFrom(initialRange.start); setTo(today < initialRange.end ? today : initialRange.end) }} className="btn-secondary"><CalendarDays className="h-4 w-4" /> Current payroll</button>
          <button onClick={load} disabled={loading} className="btn-secondary"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          <button onClick={() => setShowManagement(false)} className="btn-secondary">Simple Upload</button>
          <button onClick={exportWorkbook} disabled={!data || exporting} className="btn-primary"><Download className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Download Excel'}</button>
        </div>}
      </div>

      <div className="card flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-50 p-3 text-blue-600"><Upload className="h-5 w-5" /></span>
          <div><p className="font-semibold text-slate-800">Upload attendance TXT</p><p className="text-xs text-slate-500">Daily or multi-day files are supported. Duplicate punches are skipped and listed below.</p></div>
        </div>
        <input ref={fileRef} type="file" accept=".txt,text/plain" onChange={upload} className="hidden" />
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-primary justify-center disabled:opacity-50">
          <FileText className="h-4 w-4" /> {uploading ? 'Importing…' : 'Choose TXT'}
        </button>
      </div>

      {duplicateReport && <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <summary className="cursor-pointer font-semibold text-amber-900">{duplicateReport.duplicates} duplicate punch{duplicateReport.duplicates === 1 ? '' : 'es'} skipped · View details</summary>
        <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-amber-900">{duplicateReport.duplicates} duplicate punch{duplicateReport.duplicates === 1 ? '' : 'es'} found</p><p className="text-xs text-amber-700">Nothing below was added twice. Check the employee and exact timestamp.</p></div><button onClick={() => setDuplicateReport(null)} className="text-xs font-medium text-amber-700">Dismiss</button></div>
        <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-amber-200 bg-white"><table className="w-full text-xs"><thead className="sticky top-0 bg-amber-50 text-left text-amber-800"><tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Timestamp</th><th className="px-3 py-2">Reason</th></tr></thead><tbody className="divide-y divide-amber-100">{(duplicateReport.duplicateDetails || []).map((item, index) => <tr key={`${item.employeeCode}-${item.punchedAt}-${item.deviceId}-${index}`}><td className="px-3 py-2">{item.name || `ID ${item.employeeCode}`}</td><td className="px-3 py-2 font-mono">{item.punchedAt.replace('T', ' ')}</td><td className="px-3 py-2">{item.reason === 'repeated_in_file' ? 'Repeated inside this file' : 'Already uploaded earlier'}</td></tr>)}</tbody></table></div>
      </details>}

      {lastUpload && !showManagement && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><p className="text-lg font-bold text-emerald-900">Attendance is ready</p><p className="mt-1 text-sm text-emerald-800">{lastUpload.reportFrom}—{lastUpload.reportTo} · {data?.summary?.length || 0} employees · {lastUpload.inserted} new punches · {lastUpload.duplicates} duplicates · {pending} need review</p><p className="mt-1 text-xs text-emerald-700">The Excel will include payroll summaries, daily attendance, color-coded exceptions, and the import report.</p></div><div className="flex flex-wrap gap-2"><button onClick={exportWorkbook} disabled={exporting || loading} className="btn-primary disabled:opacity-50"><Download className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Download Excel'}</button>{pending > 0 && <button onClick={() => { setShowManagement(true); setTab('daily'); setDailyFlag('needs_review') }} className="btn-secondary text-red-600"><AlertTriangle className="h-4 w-4" /> Review exceptions</button>}</div></div>
      </div>}

      {showManagement && <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Employees" value={data?.summary?.length || 0} helper="With punches in range" icon={Users} />
        <SummaryCard label="Confirmed workdays" value={workdays} helper="At least one confirmed in/out set" icon={CheckCircle2} color="green" />
        <SummaryCard label="Total worked" value={formatMinutes(totalMinutes)} helper={`${from} through ${to}`} icon={Clock3} color="amber" />
        <SummaryCard label="Needs review" value={pending} helper="Weekdays need 4 punches; Saturday needs 2 or 4" icon={AlertTriangle} color={pending ? 'red' : 'green'} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {tabs.map(([value, label]) => <button key={value} onClick={() => setTab(value)} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}
        </div>
        <div className="flex flex-wrap gap-2">
          {(tab === 'summary' || tab === 'daily') && <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search employee" className="input-base pl-9" /></div>}
          {tab === 'summary' && <><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)} className="input-base"><option value="all">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select><select value={summarySort} onChange={(event) => setSummarySort(event.target.value)} className="input-base"><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="hours-desc">Hours high–low</option><option value="hours-asc">Hours low–high</option><option value="days-desc">Days high–low</option><option value="pay-desc">Pay high–low</option><option value="review-desc">Reviews high–low</option></select></>}
          {tab === 'daily' && <><select value={dailyFlag} onChange={(event) => setDailyFlag(event.target.value)} className="input-base"><option value="all">All statuses</option><option value="needs_review">Needs review</option><option value="late">Late</option><option value="early">Early</option><option value="below_standard">Under hours</option></select><select value={dailySort} onChange={(event) => setDailySort(event.target.value)} className="input-base"><option value="date-desc">Date newest</option><option value="date-asc">Date oldest</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="hours-desc">Hours high–low</option><option value="punches-desc">Punches high–low</option></select></>}
          {tab === 'imports' && <select value={importSort} onChange={(event) => setImportSort(event.target.value)} className="input-base"><option value="newest">Newest version</option><option value="oldest">Oldest version</option><option value="duplicates-desc">Duplicates high–low</option></select>}
        </div>
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

      {!loading && tab === 'imports' && <div className="card overflow-hidden"><div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Version history</h3><p className="text-xs text-slate-500">Only the latest active upload can be rolled back, preserving a complete audit trail.</p></div><div className="divide-y divide-slate-100">{sortedImports.map((item) => <div key={item.id} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${item.reverted_at ? 'bg-slate-50 opacity-70' : ''}`}><div><p className="text-sm font-medium text-slate-800">{item.file_name} <span className="ml-1 text-xs font-normal text-slate-400">Version #{item.id}</span></p><p className="text-xs text-slate-400">{item.date_from || 'Unknown date'}—{item.date_to || 'Unknown date'} · {new Date(item.uploaded_at).toLocaleString()}</p>{item.reverted_at && <p className="text-xs text-red-600">Rolled back by {item.reverted_by} · {new Date(item.reverted_at).toLocaleString()}</p>}</div><div className="flex items-center gap-3"><p className="text-xs text-slate-500">{item.inserted_count} inserted · {item.record_count - item.inserted_count} duplicates</p>{!item.reverted_at && Number(item.id) === Number(latestActiveImportId) && <button onClick={() => rollbackImport(item)} disabled={rollingBack} className="btn-secondary px-3 py-1.5 text-xs text-red-600 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" /> Restore previous</button>}</div></div>)}</div></div>}

      {!loading && tab === 'settings' && user?.role === 'admin' && settingsForm && <div className="space-y-5">
        <div className="card p-5"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-slate-800">Schedule and payroll rules</h3><p className="text-xs text-slate-500">Times are interpreted in America/Guatemala.</p></div><button onClick={saveSettings} disabled={savingSettings} className="btn-primary"><Save className="h-4 w-4" /> {savingSettings ? 'Saving…' : 'Save settings'}</button></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[
            ['weekdayStart', 'Weekday start', 'time', 1], ['weekdayEnd', 'Weekday end', 'time', 1], ['weekdayStandardMinutes', 'Weekday standard minutes', 'number', 1],
            ['saturdayStart', 'Saturday start', 'time', 1], ['saturdayEnd', 'Saturday end', 'time', 1], ['saturdayStandardMinutes', 'Saturday standard minutes', 'number', 1],
            ['payrollStandardMinutes', 'Payroll standard minutes', 'number', 1], ['hourlyAdjustmentRate', 'Hourly adjustment (Q)', 'number', '0.01'],
            ['fulltimeDailyRate', 'Full-time daily rate (Q)', 'number', '0.01'], ['fulltimeBonus', 'Full-time bonus (Q)', 'number', '0.01'],
          ].map(([key, label, type, step]) => <label key={key} className="text-xs font-medium text-slate-600">{label}<input type={type} step={step} value={settingsForm[key]} onChange={(event) => setSettingsForm((current) => ({ ...current, [key]: event.target.value }))} className="input-base mt-1 w-full" /></label>)}</div>
        </div>
        <div className="card overflow-hidden"><div className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-800">Employee daily payments</h3><p className="text-xs text-slate-500">Admin only. Changes take effect from {from}; historical rates remain attached to earlier payrolls.</p></div><div className="max-h-[520px] overflow-auto"><table className="w-full"><thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Daily payment</th><th className="px-3 py-2 text-center">Q125 bonus</th><th /></tr></thead><tbody>{sortedEmployees.map((employee) => <EmployeeRateRow key={`${employee.employeeCode}-${employee.dailyPayment}-${employee.bonusEligible}`} employee={employee} settings={data.settings} effectiveFrom={from} onSaved={load} getToken={getToken} />)}</tbody></table></div></div>
      </div>}
      </>}
    </div>
  )
}
