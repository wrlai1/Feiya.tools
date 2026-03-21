import React from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Package,
  Truck,
  MessageSquare,
  Boxes,
  Minus,
  Sparkles,
  X,
} from 'lucide-react'

const NAV_ITEMS = [
  { label: 'Dashboard',          to: '/',            icon: LayoutDashboard, end: true },
  { label: 'Inventory Check',    to: '/inventory',   icon: Package },
  { label: 'Tracking',           to: '/tracking',    icon: Truck },
  { label: 'Low Inventory Notes',to: '/notes',       icon: MessageSquare },
  { label: 'Stock Management',   to: '/stock',       icon: Boxes },
  { label: 'Auto Deduct',        to: '/auto-deduct', icon: Minus },
]

const COMING_SOON_ITEMS = [
  { label: 'Auto Generate', to: '/auto-generate', icon: Sparkles },
]

function NavItem({ item, onClick }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 ${
          isActive
            ? 'bg-blue-600 text-white shadow-sm'
            : 'text-slate-400 hover:bg-slate-700 hover:text-white'
        }`
      }
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{item.label}</span>
    </NavLink>
  )
}

function ComingSoonItem({ item, onClick }) {
  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 ${
          isActive
            ? 'bg-blue-600 text-white shadow-sm'
            : 'text-slate-500 hover:bg-slate-700 hover:text-slate-300'
        }`
      }
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      <span className="flex-1">{item.label}</span>
      <span className="text-xs bg-slate-600 text-slate-300 px-1.5 py-0.5 rounded font-normal">
        Soon
      </span>
    </NavLink>
  )
}

export default function Sidebar({ open, onClose }) {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-full w-60 bg-[#0f172a] flex flex-col z-40
          sidebar-transition
          ${open ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:static lg:z-auto
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700/50">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg">
            <span className="text-white font-bold text-lg leading-none">F</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base leading-tight">Feiya ERP</p>
            <p className="text-slate-400 text-xs">Warehouse Management</p>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-slate-400 hover:text-white transition-colors p-1 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.to} item={item} onClick={onClose} />
          ))}

          {/* Separator */}
          <div className="pt-3 pb-1">
            <div className="border-t border-slate-700/60" />
            <p className="text-slate-500 text-xs font-medium uppercase tracking-wider px-3 pt-3 pb-1">
              Coming Soon
            </p>
          </div>

          {COMING_SOON_ITEMS.map((item) => (
            <ComingSoonItem key={item.to} item={item} onClick={onClose} />
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-4 border-t border-slate-700/50">
          <p className="text-slate-500 text-xs text-center">
            © 2025 Feiya · All rights reserved
          </p>
        </div>
      </aside>
    </>
  )
}
