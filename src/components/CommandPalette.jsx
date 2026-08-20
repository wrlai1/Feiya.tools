import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Boxes,
  ClipboardList,
  CalendarCheck,
  Clock,
  Command,
  LayoutDashboard,
  MessageSquare,
  Minus,
  Package,
  Rocket,
  Search,
  ScanLine,
  Truck,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import userPermissions from '../utils/userPermissions.js'

const { INVENTORY_CHECK_VIEW, userHasPermission } = userPermissions

const ROUTES = [
  { label: 'Dashboard', path: '/', icon: LayoutDashboard, adminOnly: true },
  { label: 'Inventory Check', path: '/inventory', icon: Package, permission: INVENTORY_CHECK_VIEW },
  { label: 'Tracking', path: '/tracking', icon: Truck },
  { label: 'Low Inventory Notes', path: '/notes', icon: MessageSquare },
  { label: 'Stock Management', path: '/stock', icon: Boxes, adminOnly: true },
  { label: 'Auto Deduct', path: '/auto-deduct', icon: Minus, adminOnly: true },
  { label: 'Returns Receiving', path: '/returns', icon: ScanLine },
  { label: 'Analytics', path: '/analytics', icon: BarChart3, adminOnly: true },
  { label: 'New Product Tracker', path: '/new-products', icon: Rocket, adminOnly: true },
  { label: 'Time Clock', path: '/timeclock', icon: Clock },
  { label: 'User Management', path: '/users', icon: Users, adminOnly: true },
  { label: 'Time Report', path: '/time-report', icon: ClipboardList, adminOnly: true },
  { label: 'Factory Attendance', path: '/attendance', icon: CalendarCheck, attendance: true },
]

export default function CommandPalette() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const inputRef = useRef(null)
  const closeButtonRef = useRef(null)
  const previousFocusRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const availableRoutes = useMemo(
    () => ROUTES.filter((route) => {
      if (user?.role === 'admin') return true
      if (user?.attendanceAccess) return route.attendance
      return !route.adminOnly
        && !route.attendance
        && (!route.permission || userHasPermission(user, route.permission))
    }),
    [user],
  )

  const filteredRoutes = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    if (!search) return availableRoutes
    return availableRoutes.filter((route) =>
      `${route.label} ${route.path}`.toLocaleLowerCase().includes(search),
    )
  }, [availableRoutes, query])

  const goToRoute = (route) => {
    if (!route) return
    setOpen(false)
    navigate(route.path)
  }

  useEffect(() => {
    if (!open) return undefined

    previousFocusRef.current = document.activeElement
    setQuery('')
    setSelectedIndex(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus()
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const openPalette = () => setOpen(true)
    window.addEventListener('feiya:open-command-palette', openPalette)
    return () => window.removeEventListener('feiya:open-command-palette', openPalette)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const shortcutPressed =
        (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k'

      if (shortcutPressed) {
        event.preventDefault()
        if (!event.repeat) setOpen((current) => !current)
        return
      }

      if (!open) return

      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }

      if (event.key === 'Tab') {
        const movingBackward = event.shiftKey
        const atFirstControl = document.activeElement === inputRef.current
        const atLastControl = document.activeElement === closeButtonRef.current

        if ((movingBackward && atFirstControl) || (!movingBackward && atLastControl)) {
          event.preventDefault()
          ;(movingBackward ? closeButtonRef.current : inputRef.current)?.focus()
        }
        return
      }

      if (event.target !== inputRef.current) return
      if (!filteredRoutes.length || event.isComposing) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => (current + 1) % filteredRoutes.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) =>
          (current - 1 + filteredRoutes.length) % filteredRoutes.length,
        )
      } else if (event.key === 'Enter') {
        event.preventDefault()
        goToRoute(filteredRoutes[selectedIndex])
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filteredRoutes, open, selectedIndex])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-950/25 px-4 pt-[12vh] backdrop-blur-[3px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        className="w-full max-w-xl overflow-hidden rounded-3xl border border-white/80 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.2)]"
      >
        <h2 id="command-palette-title" className="sr-only">Quick navigation</h2>

        <div className="flex items-center gap-3 border-b border-slate-200/80 px-5">
          <Search className="h-5 w-5 flex-shrink-0 text-slate-400" strokeWidth={1.8} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            role="combobox"
            aria-label="Search pages"
            aria-controls="command-palette-results"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={
              filteredRoutes.length ? `command-palette-option-${selectedIndex}` : undefined
            }
            autoComplete="off"
            spellCheck="false"
            placeholder="Search pages..."
            className="h-16 min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close quick navigation"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="sr-only" aria-live="polite">
          {filteredRoutes.length} {filteredRoutes.length === 1 ? 'page' : 'pages'} found
        </p>

        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Available pages"
          className="max-h-[min(430px,60vh)] overflow-y-auto p-2"
        >
          {filteredRoutes.length ? (
            filteredRoutes.map((route, index) => {
              const Icon = route.icon
              const selected = index === selectedIndex
              const current = location.pathname === route.path

              return (
                <button
                  id={`command-palette-option-${index}`}
                  key={route.path}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseMove={() => setSelectedIndex(index)}
                  onClick={() => goToRoute(route)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${
                    selected ? 'bg-slate-100' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border ${
                    selected
                      ? 'border-slate-200 bg-white text-[#0071e3] shadow-sm'
                      : 'border-slate-200/80 bg-slate-50 text-slate-500'
                  }`}>
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {route.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">
                      {route.path === '/' ? 'Workspace overview' : route.path}
                    </span>
                  </span>
                  {current && (
                    <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                      Current
                    </span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
              <Search className="mb-3 h-7 w-7 text-slate-300" strokeWidth={1.6} />
              <p className="text-sm font-medium text-slate-700">No pages found</p>
              <p className="mt-1 text-xs text-slate-400">Try a different page name.</p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200/80 bg-slate-50/70 px-5 py-3 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Command className="h-3.5 w-3.5" />
            Quick navigation
          </span>
          <span className="flex items-center gap-3">
            <span>↑↓ Select</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </span>
        </footer>
      </section>
    </div>
  )
}
