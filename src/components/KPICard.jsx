import React from 'react'

export default function KPICard({ title, value, subtitle, icon: Icon, color = 'blue' }) {
  const colorMap = {
    blue: {
      bg: 'bg-blue-100',
      icon: 'text-blue-600',
      badge: 'text-blue-600 bg-blue-50',
    },
    teal: {
      bg: 'bg-teal-100',
      icon: 'text-teal-600',
      badge: 'text-teal-600 bg-teal-50',
    },
    orange: {
      bg: 'bg-orange-100',
      icon: 'text-orange-600',
      badge: 'text-orange-600 bg-orange-50',
    },
    green: {
      bg: 'bg-green-100',
      icon: 'text-green-600',
      badge: 'text-green-600 bg-green-50',
    },
    red: {
      bg: 'bg-red-100',
      icon: 'text-red-600',
      badge: 'text-red-600 bg-red-50',
    },
    purple: {
      bg: 'bg-purple-100',
      icon: 'text-purple-600',
      badge: 'text-purple-600 bg-purple-50',
    },
  }

  const colors = colorMap[color] || colorMap.blue

  return (
    <div className="card p-5 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-500 truncate">{title}</p>
          <p className="mt-1.5 text-3xl font-bold text-slate-800">
            {value !== undefined && value !== null ? value.toLocaleString() : '—'}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className={`w-11 h-11 rounded-xl ${colors.bg} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`w-5 h-5 ${colors.icon}`} />
          </div>
        )}
      </div>
    </div>
  )
}
