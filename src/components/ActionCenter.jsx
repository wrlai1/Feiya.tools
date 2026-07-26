import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  Database,
  Loader2,
  PackageSearch,
  RefreshCw,
  UploadCloud,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { fetchNewProductTrackers, fetchStores } from '../utils/api.js'
import { formatISODate } from '../utils/salesSummary.js'

const DAY_MS = 86400000
const CYCLE_DAYS = 14

const TONES = {
  urgent: {
    icon: 'bg-rose-50 text-rose-600',
    badge: 'bg-rose-50 text-rose-700',
  },
  warning: {
    icon: 'bg-amber-50 text-amber-600',
    badge: 'bg-amber-50 text-amber-700',
  },
  info: {
    icon: 'bg-blue-50 text-blue-600',
    badge: 'bg-blue-50 text-blue-700',
  },
  success: {
    icon: 'bg-emerald-50 text-emerald-600',
    badge: 'bg-emerald-50 text-emerald-700',
  },
}

function isoDay(value) {
  return String(value || '').slice(0, 10)
}

function todayISO() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysBetween(from, to) {
  if (!from || !to) return 0
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  return Math.round((end - start) / DAY_MS)
}

function previewNames(values, limit = 3) {
  const names = values.filter(Boolean)
  if (!names.length) return ''
  const visible = names.slice(0, limit).join(', ')
  return names.length > limit ? `${visible} +${names.length - limit}` : visible
}

function trackerCycle(tracker) {
  const launchDate = isoDay(tracker.launchDate)
  const elapsed = daysBetween(launchDate, todayISO())
  if (!launchDate || elapsed < 0) return { phase: 'future', day: 0, remaining: CYCLE_DAYS }
  const day = elapsed + 1
  if (day > CYCLE_DAYS) return { phase: 'ended', day: CYCLE_DAYS, remaining: 0 }
  return { phase: 'active', day, remaining: CYCLE_DAYS - day }
}

function buildCenterItems(stores, trackers, availability) {
  const actions = []
  const statuses = []
  const normalizedStores = stores.map((store) => ({
    ...store,
    lastDay: isoDay(store.last_day || store.lastDay),
  }))
  const latestStoreDay = normalizedStores
    .map((store) => store.lastDay)
    .filter(Boolean)
    .sort()
    .at(-1) || ''

  if (availability.stores && !normalizedStores.length) {
    actions.push({
      id: 'stores-empty',
      tone: 'urgent',
      icon: Database,
      badge: 'Required',
      title: 'Set up Analytics stores',
      detail: 'No Analytics stores are available yet, so sales coverage cannot be checked.',
      to: '/analytics#analytics-stores',
      cta: 'Open Stores',
    })
  } else if (availability.stores) {
    const storesWithoutData = normalizedStores.filter((store) => !store.lastDay)
    const storesBehindLatest = normalizedStores.filter(
      (store) => store.lastDay && latestStoreDay && store.lastDay < latestStoreDay,
    )
    const storesNeedingUpload = [...storesWithoutData, ...storesBehindLatest]

    if (storesNeedingUpload.length) {
      actions.push({
        id: 'store-coverage',
        tone: 'urgent',
        icon: UploadCloud,
        badge: `${storesNeedingUpload.length} store${storesNeedingUpload.length === 1 ? '' : 's'}`,
        title: 'Complete the latest store uploads',
        detail: latestStoreDay
          ? `${previewNames(storesNeedingUpload.map((store) => store.name))} ${
              storesNeedingUpload.length === 1 ? 'is' : 'are'
            } not updated through ${formatISODate(latestStoreDay)}.`
          : `${previewNames(storesNeedingUpload.map((store) => store.name))} ${
              storesNeedingUpload.length === 1 ? 'has' : 'have'
            } no uploaded sales date.`,
        to: '/analytics#analytics-uploads',
        cta: 'Review Uploads',
      })
    } else if (latestStoreDay) {
      statuses.push({
        id: 'store-coverage-ready',
        tone: 'success',
        icon: CheckCircle2,
        title: 'Store coverage is complete',
        detail: `All ${normalizedStores.length} stores have data through ${formatISODate(latestStoreDay)}.`,
      })
    }

    if (latestStoreDay) {
      const calendarLag = Math.max(daysBetween(latestStoreDay, todayISO()), 0)
      if (calendarLag > 0) {
        actions.push({
          id: 'sales-freshness',
          tone: 'warning',
          icon: CalendarClock,
          badge: `${calendarLag}d`,
          title: 'Review sales data freshness',
          detail: `The latest uploaded store date is ${formatISODate(latestStoreDay)}, ${calendarLag} calendar ${
            calendarLag === 1 ? 'day' : 'days'
          } before today.`,
          to: '/analytics#analytics-uploads',
          cta: 'Open Uploads',
        })
      }

      const storesOnLatestDay = normalizedStores.filter(
        (store) => store.lastDay === latestStoreDay,
      ).length
      statuses.push({
        id: 'sales-status',
        tone: 'info',
        icon: Database,
        title: 'Latest uploaded sales date',
        detail: `${formatISODate(latestStoreDay)} · ${storesOnLatestDay}/${normalizedStores.length} stores reach this date.`,
      })
    }
  }

  const trackerStates = trackers.map((tracker) => ({
    tracker,
    cycle: trackerCycle(tracker),
  }))
  const ended = trackerStates.filter((item) => item.cycle.phase === 'ended')
  const closingSoon = trackerStates.filter(
    (item) => item.cycle.phase === 'active' && item.cycle.day >= 10,
  )
  const active = trackerStates.filter((item) => item.cycle.phase === 'active')

  if (availability.trackers && ended.length) {
    actions.push({
      id: 'trackers-ended',
      tone: 'warning',
      icon: PackageSearch,
      badge: `${ended.length} ended`,
      title: 'Review completed launch cycles',
      detail: `${previewNames(ended.map(({ tracker }) => tracker.spu))} ${
        ended.length === 1 ? 'has' : 'have'
      } passed the 14-day tracking window.`,
      to: '/new-products',
      cta: 'Review Trackers',
    })
  }

  if (availability.trackers && closingSoon.length) {
    const closest = [...closingSoon].sort((a, b) => a.cycle.remaining - b.cycle.remaining)[0]
    actions.push({
      id: 'trackers-closing',
      tone: 'warning',
      icon: CalendarClock,
      badge: `${closingSoon.length} due soon`,
      title: 'Launch reviews are approaching',
      detail: `${previewNames(closingSoon.map(({ tracker }) => tracker.spu))} ${
        closingSoon.length === 1 ? 'is' : 'are'
      } on day 10 or later. The nearest cycle has ${closest.cycle.remaining} ${
        closest.cycle.remaining === 1 ? 'day' : 'days'
      } remaining.`,
      to: '/new-products',
      cta: 'Open New Products',
    })
  } else if (availability.trackers && active.length) {
    statuses.push({
      id: 'trackers-active',
      tone: 'info',
      icon: PackageSearch,
      title: `${active.length} active launch ${active.length === 1 ? 'cycle' : 'cycles'}`,
      detail: 'No active tracker has reached day 10 yet.',
    })
  }

  if (availability.trackers && !trackers.length) {
    statuses.push({
      id: 'trackers-empty',
      tone: 'info',
      icon: PackageSearch,
      title: 'No active launch trackers',
      detail: 'There are no SPUs in a 14-day launch tracking window.',
    })
  }

  const priority = { urgent: 0, warning: 1, info: 2 }
  actions.sort((a, b) => priority[a.tone] - priority[b.tone])
  return { actions, statuses }
}

function CenterItem({ item, onOpen }) {
  const Icon = item.icon
  const tone = TONES[item.tone] || TONES.info

  return (
    <button
      type="button"
      onClick={() => onOpen(item.to)}
      className="group flex w-full items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-3.5 text-left transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <span className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${tone.icon}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-900">{item.title}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone.badge}`}>
            {item.badge}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">{item.detail}</span>
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-600">
          {item.cta}
          <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  )
}

function StatusItem({ item }) {
  const Icon = item.icon
  const tone = TONES[item.tone] || TONES.info

  return (
    <div className="flex items-start gap-3 rounded-2xl bg-slate-50 p-3.5">
      <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${tone.icon}`}>
        <Icon className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{item.title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{item.detail}</span>
      </span>
    </div>
  )
}

export default function ActionCenter() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const previousFocusRef = useRef(null)
  const loadedAdminRef = useRef('')
  const requestSequenceRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stores, setStores] = useState([])
  const [trackers, setTrackers] = useState([])
  const [availability, setAvailability] = useState({ stores: false, trackers: false })
  const [errors, setErrors] = useState([])

  const loadData = useCallback(async () => {
    if (!isAdmin) return
    const requestId = ++requestSequenceRef.current
    setLoading(true)
    setErrors([])

    const nextErrors = []
    const [storeResult, trackerResult] = await Promise.allSettled([
      fetchStores(),
      fetchNewProductTrackers(),
    ])

    const nextStores = storeResult.status === 'fulfilled' ? storeResult.value?.stores || [] : []
    const nextTrackers = trackerResult.status === 'fulfilled'
      ? trackerResult.value?.trackers || []
      : []

    if (storeResult.status === 'rejected') {
      nextErrors.push(`Analytics stores: ${storeResult.reason?.message || 'Could not load data.'}`)
    }
    if (trackerResult.status === 'rejected') {
      nextErrors.push(`New products: ${trackerResult.reason?.message || 'Could not load data.'}`)
    }

    if (requestId !== requestSequenceRef.current) return
    setStores(nextStores)
    setTrackers(nextTrackers)
    setAvailability({
      stores: storeResult.status === 'fulfilled',
      trackers: trackerResult.status === 'fulfilled',
    })
    setErrors(nextErrors)
    setHasLoaded(true)
    setLoading(false)
  }, [isAdmin])

  useEffect(() => {
    const adminIdentity = isAdmin ? String(user?.username || 'admin') : ''
    if (!adminIdentity) {
      if (!loadedAdminRef.current) return
      loadedAdminRef.current = ''
      requestSequenceRef.current += 1
      setOpen(false)
      setHasLoaded(false)
      setLoading(false)
      setStores([])
      setTrackers([])
      setAvailability({ stores: false, trackers: false })
      setErrors([])
      return
    }
    if (loadedAdminRef.current === adminIdentity) return

    if (loadedAdminRef.current) {
      setHasLoaded(false)
      setStores([])
      setTrackers([])
      setAvailability({ stores: false, trackers: false })
      setErrors([])
    }
    loadedAdminRef.current = adminIdentity
    loadData()
  }, [isAdmin, loadData, user?.username])

  useEffect(() => {
    if (!open) return undefined

    previousFocusRef.current = document.activeElement
    const frame = requestAnimationFrame(() => closeRef.current?.focus())
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(panelRef.current?.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus()
    }
  }, [open])

  const { actions, statuses } = useMemo(
    () => buildCenterItems(stores, trackers, availability),
    [availability, stores, trackers],
  )

  const openDestination = (path) => {
    setOpen(false)
    navigate(path)
  }

  if (!isAdmin) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={hasLoaded && actions.length
          ? `Open Action Center, ${actions.length} items to review`
          : 'Open Action Center'}
        aria-expanded={open}
        aria-controls="action-center-panel"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/80 bg-white/70 text-slate-500 transition hover:border-slate-300 hover:bg-white hover:text-slate-800"
      >
        <Bell className="h-4 w-4" strokeWidth={1.8} />
        {hasLoaded && actions.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-rose-500 px-1 text-[9px] font-bold leading-none text-white">
            {actions.length > 9 ? '9+' : actions.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[110] bg-slate-950/25 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <aside
            ref={panelRef}
            id="action-center-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="action-center-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-hidden border-l border-white/80 bg-white shadow-[-24px_0_70px_rgba(15,23,42,0.16)]"
          >
            <header className="flex flex-shrink-0 items-center gap-3 border-b border-slate-200/80 px-4 py-4 sm:px-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                <Bell className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <h2 id="action-center-title" className="text-base font-semibold text-slate-950">
                  Action Center
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {loading
                    ? 'Checking your workspace…'
                    : `${actions.length} ${actions.length === 1 ? 'item' : 'items'} to review`}
                </p>
              </span>
              <button
                type="button"
                onClick={loadData}
                disabled={loading}
                aria-label="Refresh Action Center"
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close Action Center"
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5">
              {loading && !hasLoaded ? (
                <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
                  <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
                  <p className="mt-4 text-sm font-medium text-slate-700">Checking current data</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Reading Analytics and new product status.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {errors.length > 0 && (
                    <div
                      role="status"
                      className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900"
                    >
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">
                            {errors.length === 2 ? 'Action Center could not load' : 'Some data is unavailable'}
                          </p>
                          <ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-800">
                            {errors.map((error) => <li key={error}>{error}</li>)}
                          </ul>
                          <button
                            type="button"
                            onClick={loadData}
                            disabled={loading}
                            className="mt-2 text-xs font-semibold underline underline-offset-2"
                          >
                            Try again
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {actions.length > 0 && (
                    <section aria-labelledby="action-center-review-title">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3
                          id="action-center-review-title"
                          className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400"
                        >
                          To Review
                        </h3>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-500">
                          {actions.length}
                        </span>
                      </div>
                      <div className="space-y-2.5">
                        {actions.map((item) => (
                          <CenterItem key={item.id} item={item} onOpen={openDestination} />
                        ))}
                      </div>
                    </section>
                  )}

                  {!actions.length && !errors.length && hasLoaded && (
                    <div className="rounded-3xl border border-emerald-100 bg-emerald-50/70 px-6 py-8 text-center">
                      <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
                      <p className="mt-3 text-sm font-semibold text-emerald-900">You’re caught up</p>
                      <p className="mt-1 text-xs leading-5 text-emerald-700">
                        No current data coverage or launch-cycle items need review.
                      </p>
                    </div>
                  )}

                  {statuses.length > 0 && (
                    <section aria-labelledby="action-center-status-title">
                      <h3
                        id="action-center-status-title"
                        className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-slate-400"
                      >
                        Current Status
                      </h3>
                      <div className="space-y-2">
                        {statuses.map((item) => <StatusItem key={item.id} item={item} />)}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>

            <footer className="flex-shrink-0 border-t border-slate-200/80 bg-slate-50/80 px-5 py-3 text-[11px] leading-5 text-slate-400">
              Status is read from existing Analytics and New Product data. No changes are made here.
            </footer>
          </aside>
        </div>
      )}
    </>
  )
}
