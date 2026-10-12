import React, { useEffect, useId, useState } from 'react'
import { Search } from 'lucide-react'

export default function InventoryStyleSearch({ value, options, onChange, disabled, label = 'Inventory style' }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  useEffect(() => setQuery(value || ''), [value])
  const matches = options.filter((option) => String(option).toLowerCase().includes(query.trim().toLowerCase()))
  const choose = (style) => { onChange(style); setQuery(style); setOpen(false); setActive(0) }
  return (
    <div className="relative min-w-0" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(value || '') }
    }}>
      <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
      <input role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        value={query} disabled={disabled} placeholder="Search style / 搜索款号"
        onFocus={() => { setQuery(''); setOpen(true); setActive(0) }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); setQuery(value || '') }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true)
            setActive((index) => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
          }
          if (event.key === 'Enter' && open) { event.preventDefault(); if (matches[active]) choose(matches[active]) }
        }} className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white pl-9 pr-2 text-sm disabled:bg-slate-100" />
      {open && !disabled && <div id={listId} role="listbox" aria-label={label} className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
        {matches.map((style, index) => <button key={style} id={`${listId}-${index}`} type="button" role="option" aria-selected={style === value}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(style)}
          className={`block min-h-11 w-full break-words px-3 py-2 text-left text-sm hover:bg-blue-50 ${index === active ? 'bg-blue-50' : ''}`}>{style}</button>)}
        {!matches.length && <p className="px-3 py-3 text-sm text-slate-500">No matching styles</p>}
      </div>}
    </div>
  )
}
