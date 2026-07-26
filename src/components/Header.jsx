import React from 'react'
import { useLocation } from 'react-router-dom'
import { Menu, ShieldCheck, User } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

const PAGE_TITLES = {
  '/':             'Dashboard',
  '/inventory':    'Inventory Check',
  '/tracking':     'Tracking',
  '/notes':        'Low Inventory Notes',
  '/stock':        'Stock Management',
  '/auto-deduct':  'Auto Deduct',
  '/auto-deduct/history': 'Auto Deduct History',
  '/analytics':    'Analytics',
  '/new-products': 'New Product Tracker',
  '/auto-generate':'Auto Generate',
  '/users':        'User Management',
  '/timeclock':    'Time Clock',
  '/time-report':  'Time Report',
}

export default function Header({ onMenuClick }) {
  const { user } = useAuth()
  const location = useLocation()
  const title    = PAGE_TITLES[location.pathname] || 'Feiya ERP'
  const isAdmin  = user?.role === 'admin'
  const initials = user?.username?.[0]?.toUpperCase() ?? 'F'

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center px-4 gap-4 flex-shrink-0 z-20">
      <button onClick={onMenuClick}
        className="lg:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors">
        <Menu className="w-5 h-5" />
      </button>

      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-semibold text-slate-800 truncate">{title}</h1>
      </div>

      {/* User badge */}
      <div className="flex items-center gap-2">
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50">
          {isAdmin
            ? <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
            : <User className="w-3.5 h-3.5 text-slate-400" />
          }
          <span className="text-xs font-medium text-slate-600">{user?.username}</span>
        </div>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-sm ${isAdmin ? 'bg-blue-600' : 'bg-slate-400'}`}>
          {initials}
        </div>
      </div>
    </header>
  )
}
