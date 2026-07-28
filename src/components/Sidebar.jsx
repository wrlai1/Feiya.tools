import React, { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Package, Truck, MessageSquare,
  Boxes, Minus, X, Users, LogOut, KeyRound, ShieldCheck, User, Clock,
  ClipboardList, BarChart3, Rocket,
  ScanLine,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import ChangePasswordModal from './ChangePasswordModal.jsx'
import { SECTION_THEMES } from '../utils/sectionTheme.js'

const ADMIN_GROUPS = [
  {
    label: 'Overview',
    theme: 'overview',
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'Operations',
    theme: 'operations',
    items: [
      { label: 'Inventory Check', to: '/inventory', icon: Package },
      { label: 'Tracking', to: '/tracking', icon: Truck },
      { label: 'Low Inventory Notes', to: '/notes', icon: MessageSquare },
      { label: 'Stock Management', to: '/stock', icon: Boxes },
      { label: 'Auto Deduct', to: '/auto-deduct', icon: Minus, end: true },
      { label: 'Returns Receiving', to: '/returns', icon: ScanLine },
    ],
  },
  {
    label: 'Insights',
    theme: 'insights',
    items: [
      { label: 'Analytics', to: '/analytics', icon: BarChart3 },
      { label: 'New Product Tracker', to: '/new-products', icon: Rocket },
    ],
  },
  {
    label: 'Team',
    theme: 'team',
    items: [
      { label: 'Time Clock', to: '/timeclock', icon: Clock },
      { label: 'User Management', to: '/users', icon: Users },
      { label: 'Time Report', to: '/time-report', icon: ClipboardList },
    ],
  },
]

const USER_GROUPS = [
  {
    label: 'Operations',
    theme: 'operations',
    items: [
      { label: 'Tracking', to: '/tracking', icon: Truck },
      { label: 'Returns Receiving', to: '/returns', icon: ScanLine },
      { label: 'Low Inventory Notes', to: '/notes', icon: MessageSquare },
    ],
  },
  {
    label: 'Team',
    theme: 'team',
    items: [{ label: 'Time Clock', to: '/timeclock', icon: Clock }],
  },
]

function itemMatchesPath(item, pathname) {
  if (item.to === '/') return pathname === '/'
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

function NavItem({ item, onClick, collapsed, theme }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick} title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive ? theme.itemActive : `text-slate-600 ${theme.itemHover}`
        }`
      }
    >
      <item.icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.8} />
      <span className={`flex-1 whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
    </NavLink>
  )
}

function SectionLabel({ label, collapsed, theme }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 pt-3">
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${theme.dot}`} />
      <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${theme.labelColor} ${collapsed ? 'lg:hidden' : ''}`}>{label}</p>
    </div>
  )
}

export default function Sidebar({ open, collapsed, onClose }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [showChangePw, setShowChangePw] = useState(false)
  const isAdmin = user?.role === 'admin'
  const groups = isAdmin ? ADMIN_GROUPS : USER_GROUPS

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[2px] lg:hidden" onClick={onClose} />}

      <aside className={`
        fixed top-0 left-0 z-40 flex h-full w-72 flex-col border-r border-slate-200/80 bg-[#fcfcfd]
        sidebar-transition lg:static lg:z-auto
        ${collapsed ? 'lg:w-20' : 'lg:w-72'}
        ${open ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0
      `}>
        {/* Logo */}
        <div className="flex min-h-[72px] items-center gap-3 border-b border-slate-200/70 px-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[#0071e3]">
            <span className="text-lg font-semibold text-white">F</span>
          </div>
          <div className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
            <p className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-slate-950">Feiya ERP</p>
            <p className="mt-0.5 text-[11px] text-slate-400">Operations Workspace</p>
          </div>
          <button onClick={onClose} aria-label="Close navigation"
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {groups.map((group) => {
            const theme = SECTION_THEMES[group.theme]
            const activeGroup = group.items.some((item) => itemMatchesPath(item, location.pathname))
            return (
              <div key={group.label} className={`relative mb-1 rounded-xl px-1 pb-1 transition-colors duration-300 ${
                activeGroup
                  ? `${theme.sidebarActive} lg:-mr-3 lg:rounded-r-none lg:pr-4`
                  : theme.sidebar
              }`}>
                {activeGroup && (
                  <span aria-hidden="true" className={`absolute bottom-3 right-0 top-3 hidden w-[3px] rounded-l-full lg:block ${theme.connector}`} />
                )}
                <SectionLabel label={group.label} collapsed={collapsed} theme={theme} />
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <NavItem key={item.to} item={item} onClick={onClose} collapsed={collapsed} theme={theme} />
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        {/* User footer */}
        <div className="space-y-1 border-t border-slate-200/70 px-3 py-3">
          {/* User info */}
          <div className="flex items-center gap-2.5 rounded-xl px-3 py-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white flex-shrink-0 ${isAdmin ? 'bg-[#0071e3]' : 'bg-slate-400'}`}>
              {user?.username?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className={`flex-1 min-w-0 ${collapsed ? 'lg:hidden' : ''}`}>
              <p className="truncate text-sm font-medium text-slate-800">{user?.username || 'Workspace'}</p>
              <div className="flex items-center gap-1">
                {isAdmin
                  ? <><ShieldCheck className="w-3 h-3 text-[#0071e3]" /><span className="text-[#0071e3] text-xs">Admin</span></>
                  : <><User className="w-3 h-3 text-slate-400" /><span className="text-slate-400 text-xs">User</span></>
                }
              </div>
            </div>
          </div>

          {/* Change password */}
          <button onClick={() => setShowChangePw(true)}
            title={collapsed ? 'Change Password' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors">
            <KeyRound className="w-4 h-4 flex-shrink-0" />
            <span className={collapsed ? 'lg:hidden' : ''}>Change Password</span>
          </button>

          {/* Logout */}
          <button onClick={logout}
            title={collapsed ? 'Sign Out' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors">
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <span className={collapsed ? 'lg:hidden' : ''}>Sign Out</span>
          </button>
        </div>
      </aside>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </>
  )
}
