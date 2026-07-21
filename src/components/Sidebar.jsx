import React, { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Package, Truck, MessageSquare,
  Boxes, Minus, Sparkles, X, Users, LogOut, KeyRound, ShieldCheck, User, Clock, ClipboardList, BarChart3, History,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import ChangePasswordModal from './ChangePasswordModal.jsx'

const ADMIN_NAV = [
  { label: 'Dashboard',           to: '/',            icon: LayoutDashboard, end: true },
  { label: 'Inventory Check',     to: '/inventory',   icon: Package },
  { label: 'Tracking',            to: '/tracking',    icon: Truck },
  { label: 'Low Inventory Notes', to: '/notes',       icon: MessageSquare },
  { label: 'Stock Management',    to: '/stock',       icon: Boxes },
  { label: 'Auto Deduct',         to: '/auto-deduct', icon: Minus, end: true },
  { label: 'History',             to: '/auto-deduct/history', icon: History },
  { label: 'Analytics',           to: '/analytics',   icon: BarChart3 },
  { label: 'Time Clock',          to: '/timeclock',   icon: Clock },
]

const USER_NAV = [
  { label: 'Tracking',            to: '/tracking',    icon: Truck },
  { label: 'Low Inventory Notes', to: '/notes',       icon: MessageSquare },
  { label: 'Time Clock',          to: '/timeclock',   icon: Clock },
]

const ADMIN_TOOLS = [
  { label: 'User Management', to: '/users',       icon: Users },
  { label: 'Time Report',     to: '/time-report', icon: ClipboardList },
]

const COMING_SOON = [
  { label: 'Auto Generate', to: '/auto-generate', icon: Sparkles },
]

function NavItem({ item, onClick }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-700 hover:text-white'
        }`
      }
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{item.label}</span>
    </NavLink>
  )
}

function ComingSoonItem({ item }) {
  return (
    <NavLink to={item.to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-700 hover:text-slate-300'
        }`
      }
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{item.label}</span>
      <span className="text-xs bg-slate-600 text-slate-300 px-1.5 py-0.5 rounded">Soon</span>
    </NavLink>
  )
}

function SectionLabel({ label }) {
  return (
    <div className="pt-3 pb-1">
      <div className="border-t border-slate-700/60" />
      <p className="text-slate-500 text-xs font-medium uppercase tracking-wider px-3 pt-3 pb-1">{label}</p>
    </div>
  )
}

export default function Sidebar({ open, onClose }) {
  const { user, logout } = useAuth()
  const [showChangePw, setShowChangePw] = useState(false)
  const isAdmin = user?.role === 'admin'
  const navItems = isAdmin ? ADMIN_NAV : USER_NAV

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={onClose} />}

      <aside className={`
        fixed top-0 left-0 h-full w-60 bg-[#0f172a] flex flex-col z-40
        sidebar-transition
        ${open ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:z-auto
      `}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700/50">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg">
            <span className="text-white font-bold text-lg">F</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base leading-tight">Feiya ERP</p>
            <p className="text-slate-400 text-xs">Warehouse Management</p>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-white p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-1">
          {navItems.map(item => <NavItem key={item.to} item={item} onClick={onClose} />)}

          {/* Admin-only tools */}
          {isAdmin && (
            <>
              <SectionLabel label="Admin" />
              {ADMIN_TOOLS.map(item => <NavItem key={item.to} item={item} onClick={onClose} />)}
              <SectionLabel label="Coming Soon" />
              {COMING_SOON.map(item => <ComingSoonItem key={item.to} item={item} />)}
            </>
          )}
        </nav>

        {/* User footer */}
        <div className="px-3 py-3 border-t border-slate-700/50 space-y-1">
          {/* User info */}
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-800/60">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 ${isAdmin ? 'bg-blue-600' : 'bg-slate-500'}`}>
              {user?.username?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{user?.username}</p>
              <div className="flex items-center gap-1">
                {isAdmin
                  ? <><ShieldCheck className="w-3 h-3 text-blue-400" /><span className="text-blue-400 text-xs">Admin</span></>
                  : <><User className="w-3 h-3 text-slate-400" /><span className="text-slate-400 text-xs">User</span></>
                }
              </div>
            </div>
          </div>

          {/* Change password */}
          <button onClick={() => setShowChangePw(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-slate-700 hover:text-white transition-colors">
            <KeyRound className="w-4 h-4 flex-shrink-0" />
            Change Password
          </button>

          {/* Logout */}
          <button onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-red-900/40 hover:text-red-400 transition-colors">
            <LogOut className="w-4 h-4 flex-shrink-0" />
            Sign Out
          </button>
        </div>
      </aside>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </>
  )
}
