import React from 'react'
import { useLocation } from 'react-router-dom'
import { Menu, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, User } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import ActionCenter from './ActionCenter.jsx'

const PAGE_TITLES = {
  '/':             'Dashboard',
  '/inventory':    'Inventory Check',
  '/notes':        'Low Inventory Notes',
  '/stock':        'Stock Management',
  '/auto-deduct':  'Auto Deduct',
  '/auto-deduct/history': 'Auto Deduct History',
  '/returns':       'Returns Receiving',
  '/analytics':    'Analytics',
  '/new-products': 'New Product Tracker',
  '/auto-generate':'Auto Generate',
  '/users':        'User Management',
  '/timeclock':    'Time Clock',
  '/time-report':  'Time Report',
  '/attendance':   'Factory Attendance',
}

const PAGE_DESCRIPTIONS = {
  '/': 'Your daily operations at a glance',
  '/inventory': 'Review and validate inventory data',
  '/notes': 'Keep low-stock actions organized',
  '/stock': 'Manage available stock and adjustments',
  '/auto-deduct': 'Run and review inventory deductions',
  '/auto-deduct/history': 'Review previous deduction runs',
  '/returns': 'Scan, verify, and restock physical returns',
  '/analytics': 'Explore sales, traffic, and product performance',
  '/new-products': 'Monitor each new style through its first 14 days',
  '/users': 'Manage team access and permissions',
  '/timeclock': 'Clock in, clock out, and review today',
  '/time-report': 'Review team attendance and hours',
  '/attendance': 'Import factory punches and prepare payroll summaries',
}

export default function Header({ onMenuClick, onSidebarToggle, sidebarCollapsed, sectionTheme }) {
  const { user } = useAuth()
  const location = useLocation()
  const title    = PAGE_TITLES[location.pathname] || 'Feiya ERP'
  const description = PAGE_DESCRIPTIONS[location.pathname] || 'Feiya operations workspace'
  const isAdmin  = user?.role === 'admin'
  const initials = user?.username?.[0]?.toUpperCase() ?? 'F'

  return (
    <header className={`min-h-[72px] border-b px-4 backdrop-blur-xl transition-colors duration-300 sm:px-6 lg:px-8 flex items-center gap-3 flex-shrink-0 z-20 ${sectionTheme.header} ${sectionTheme.border}`}>
      <button onClick={onMenuClick} aria-label="Open navigation"
        className="lg:hidden p-2 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors">
        <Menu className="w-5 h-5" />
      </button>
      <button onClick={onSidebarToggle} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="hidden lg:inline-flex p-2 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-800 transition-colors">
        {sidebarCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`hidden h-1.5 w-1.5 flex-shrink-0 rounded-full sm:inline-flex ${sectionTheme.dot}`} />
          <span className={`hidden text-[10px] font-semibold uppercase tracking-[0.1em] sm:inline-flex ${sectionTheme.labelColor}`}>
            {sectionTheme.label}
          </span>
          <span className="hidden h-3 w-px bg-slate-300 sm:inline-flex" />
          <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-slate-950">{title}</h1>
        </div>
        <p className="hidden truncate text-xs text-slate-400 sm:block">{description}</p>
      </div>

      {/* User badge */}
      <div className="flex shrink-0 items-center gap-2">
        <ActionCenter />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('feiya:open-command-palette'))}
          aria-label="Open quick navigation"
          className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-xl border border-slate-200/80 bg-white/70 text-xs text-slate-500 transition hover:border-slate-300 hover:bg-white hover:text-slate-800 md:w-auto md:px-3"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.8} />
          <span className="hidden xl:inline">Quick navigation</span>
          <kbd className="hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-sans text-[10px] text-slate-400 md:inline">⌘K</kbd>
        </button>
        <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200/80 bg-slate-50/80">
          {isAdmin
            ? <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
            : <User className="w-3.5 h-3.5 text-slate-400" />
          }
          <span className="text-xs font-medium text-slate-600">{user?.username || 'Workspace'}</span>
        </div>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold ${isAdmin ? 'bg-[#0071e3]' : 'bg-slate-400'}`}>
          {initials}
        </div>
      </div>
    </header>
  )
}
