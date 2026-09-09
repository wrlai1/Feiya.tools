import React from 'react'

export default function KPICard({ title, value, subtitle, icon: Icon, color = 'blue' }) {
  const colorMap = {
    blue: {
      bg: 'bg-blue-50',
      icon: 'text-[#0071e3]',
    },
    teal: {
      bg: 'bg-emerald-50',
      icon: 'text-emerald-600',
    },
    orange: {
      bg: 'bg-amber-50',
      icon: 'text-amber-600',
    },
    green: {
      bg: 'bg-green-50',
      icon: 'text-green-600',
    },
    red: {
      bg: 'bg-red-50',
      icon: 'text-red-600',
    },
    purple: {
      bg: 'bg-purple-50',
      icon: 'text-purple-600',
    },
  }

  const colors = colorMap[color] || colorMap.blue

  return (
    <div className="card p-5 transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="truncate text-xs font-medium text-slate-500">{title}</p>
          <p className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">
            {value !== undefined && value !== null ? value.toLocaleString() : '—'}
          </p>
          {subtitle && (
            <p className="mt-1.5 text-xs text-slate-400">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className={`w-10 h-10 rounded-full ${colors.bg} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`w-[18px] h-[18px] ${colors.icon}`} strokeWidth={1.8} />
          </div>
        )}
      </div>
    </div>
  )
}
