import React from 'react'
import { useLocation } from 'react-router-dom'
import { Menu, Bell } from 'lucide-react'

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/inventory': 'Inventory Check',
  '/tracking': 'Tracking',
  '/notes': 'Low Inventory Notes',
  '/stock': 'Stock Management',
  '/auto-deduct': 'Auto Deduct',
  '/auto-generate': 'Auto Generate',
}

export default function Header({ onMenuClick }) {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] || 'Feiya ERP'

  const initials = 'FT' // Feiya Team

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center px-4 gap-4 flex-shrink-0 z-20">
      {/* Mobile hamburger */}
      <button
        onClick={onMenuClick}
        className="lg:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Page title */}
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-semibold text-slate-800 truncate">{title}</h1>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2">
        <button
          className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-blue-600 rounded-full" />
        </button>

        <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-semibold shadow-sm cursor-pointer hover:bg-blue-700 transition-colors">
          {initials}
        </div>
      </div>
    </header>
  )
}
