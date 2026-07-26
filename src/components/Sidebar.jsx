import React, { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Package, Truck, MessageSquare,
  Boxes, Minus, Sparkles, X, Users, LogOut, KeyRound, ShieldCheck, User, Clock,
  ClipboardList, BarChart3, Rocket,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import ChangePasswordModal from './ChangePasswordModal.jsx'

const ADMIN_GROUPS = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Inventory Check', to: '/inventory', icon: Package },
      { label: 'Tracking', to: '/tracking', icon: Truck },
      { label: 'Low Inventory Notes', to: '/notes', icon: MessageSquare },
      { label: 'Stock Management', to: '/stock', icon: Boxes },
      { label: 'Auto Deduct', to: '/auto-deduct', icon: Minus, end: true },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Analytics', to: '/analytics', icon: BarChart3 },
      { label: 'New Product Tracker', to: '/new-products', icon: Rocket },
    ],
  },
  {
    label: 'Team',
    items: [
      { label: 'Time Clock', to: '/timeclock', icon: Clock },
      { label: 'User Management', to: '/users', icon: Users },
      { label: 'Time Report', to: '/time-report', icon: ClipboardList },
    ],
  },
]

const USER_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { label: 'Tracking', to: '/tracking', icon: Truck },
      { label: 'Low Inventory Notes', to: '/notes', icon: MessageSquare },
      { label: 'Time Clock', to: '/timeclock', icon: Clock },
    ],
  },
]

const COMING_SOON = [
  { label: 'Auto Generate', to: '/auto-generate', icon: Sparkles },
]

function NavItem({ item, onClick, collapsed }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick} title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive ? 'bg-blue-50 text-[#0071e3]' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
        }`
      }
    >
      <item.icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.8} />
      <span className={`flex-1 whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
    </NavLink>
  )
}

function ComingSoonItem({ item, collapsed }) {
  return (
    <NavLink to={item.to} title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive ? 'bg-blue-50 text-[#0071e3]' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
        }`
      }
    >
      <item.icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.8} />
      <span className={`flex-1 whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
      <span className={`rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-400 ${collapsed ? 'lg:hidden' : ''}`}>Soon</span>
    </NavLink>
  )
}

function SectionLabel({ label, collapsed }) {
  return (
    <div className="px-3 pb-1 pt-4">
      <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 ${collapsed ? 'lg:hidden' : ''}`}>{label}</p>
      {collapsed && <div className="hidden h-px bg-slate-200 lg:block" />}
    </div>
  )
}

export default function Sidebar({ open, collapsed, onClose }) {
  const { user, logout } = useAuth()
  const [showChangePw, setShowChangePw] = useState(false)
  const isAdmin = user?.role === 'admin'
  const groups = isAdmin ? ADMIN_GROUPS : USER_GROUPS

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[2px] lg:hidden" onClick={onClose} />}

      <aside className={`
        fixed top-0 left-0 z-40 flex h-full w-72 flex-col border-r border-slate-200/70 bg-white
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
          {groups.map((group) => (
            <div key={group.label}>
              <SectionLabel label={group.label} collapsed={collapsed} />
              <div className="space-y-1">
                {group.items.map((item) => <NavItem key={item.to} item={item} onClick={onClose} collapsed={collapsed} />)}
              </div>
            </div>
          ))}
          {isAdmin && (
            <div>
              <SectionLabel label="Coming Soon" collapsed={collapsed} />
              {COMING_SOON.map((item) => <ComingSoonItem key={item.to} item={item} collapsed={collapsed} />)}
            </div>
          )}
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
