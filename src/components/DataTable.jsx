import React, { useState, useMemo } from 'react'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

export default function DataTable({
  data = [],
  columns = [],
  pageSize = 50,
  rowClassName,
  emptyMessage = 'No data to display',
}) {
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(0)

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
    setPage(0)
  }

  const sorted = useMemo(() => {
    if (!sortKey) return data
    return [...data].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const isNum = typeof av === 'number' && typeof bv === 'number'
      let cmp = isNum ? av - bv : String(av || '').localeCompare(String(bv || ''))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  const totalPages = Math.ceil(sorted.length / pageSize)
  const paginated = sorted.slice(page * pageSize, (page + 1) * pageSize)

  const SortIcon = ({ colKey }) => {
    if (sortKey !== colKey)
      return (
        <ChevronUp className="w-3.5 h-3.5 opacity-0 group-hover:opacity-40" />
      )
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-blue-500" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-blue-500" />
    )
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        <p className="text-sm">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap group ${
                    col.sortable !== false ? 'cursor-pointer hover:text-slate-700 select-none' : ''
                  } ${col.className || ''}`}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {col.sortable !== false && <SortIcon colKey={col.key} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginated.map((row, idx) => (
              <tr
                key={idx}
                className={`group hover:bg-slate-50 transition-colors ${
                  rowClassName ? rowClassName(row) : ''
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 text-slate-700 ${col.cellClassName || ''}`}
                  >
                    {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of{' '}
            {sorted.length} rows
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i)
              .filter((i) => i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 1)
              .reduce((acc, i, idx, arr) => {
                if (idx > 0 && arr[idx - 1] !== i - 1) acc.push('...')
                acc.push(i)
                return acc
              }, [])
              .map((item, idx) =>
                item === '...' ? (
                  <span key={`dots-${idx}`} className="px-2">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    onClick={() => setPage(item)}
                    className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                      page === item
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-slate-100 text-slate-600'
                    }`}
                  >
                    {item + 1}
                  </button>
                )
              )}
            <button
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
