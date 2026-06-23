import React, { useState, useMemo } from 'react'
import { Search, Plus, SkipForward, CheckCircle, X, Link2 } from 'lucide-react'

/**
 * Interactive panel for resolving unmatched sales rows.
 *
 * For each row the auto-matcher couldn't place, the user can:
 *   Link   — pick an existing template entry to assign the QTY to
 *   Create — manually specify STYLE / COLOR / SIZE (new row appended to output)
 *   Skip   — discard the row
 *
 * onDone(resolvedItems) is called when the user clicks "Apply".
 * resolvedItems: Array of { STYLE, COLOR, SIZE, QTY, _isNew? }
 */
export default function UnmatchedResolver({ unmatchedRows, templateRows, onDone }) {
  // resolved[i] = { type: 'link'|'create'|'skip', entry: {STYLE,COLOR,SIZE} } | null
  const [resolved,    setResolved]    = useState(() => Array(unmatchedRows.length).fill(null))
  const [searches,    setSearches]    = useState(() => Array(unmatchedRows.length).fill(''))
  const [createForms, setCreateForms] = useState(() => Array(unmatchedRows.length).fill(null))

  const pending   = resolved.filter(r => !r).length
  const linked    = resolved.filter(r => r?.type === 'link').length
  const created   = resolved.filter(r => r?.type === 'create').length
  const skipped   = resolved.filter(r => r?.type === 'skip').length

  // Pre-normalise template rows once
  const normTemplate = useMemo(() => templateRows.map(r => ({
    STYLE: String(r.STYLE || r.Style || r.style || '').trim(),
    COLOR: String(r.COLOR || r.Color || r.color || '').trim(),
    SIZE:  String(r.SIZE  || r.Size  || r.size  || '').trim(),
  })), [templateRows])

  function resolve(i, type, entry) {
    setResolved(prev => { const n = [...prev]; n[i] = { type, entry }; return n })
    setCreateForms(prev => { const n = [...prev]; n[i] = null; return n })
  }

  function unresolve(i) {
    setResolved(prev => { const n = [...prev]; n[i] = null; return n })
  }

  function setSearch(i, v) {
    setSearches(prev => { const n = [...prev]; n[i] = v; return n })
  }

  function openCreate(i, row) {
    setCreateForms(prev => {
      const n = [...prev]
      n[i] = { STYLE: row.style || '', COLOR: row.color || '', SIZE: row.size || '' }
      return n
    })
  }

  function closeCreate(i) {
    setCreateForms(prev => { const n = [...prev]; n[i] = null; return n })
  }

  function updateCreate(i, field, value) {
    setCreateForms(prev => {
      const n = [...prev]
      n[i] = { ...n[i], [field]: value }
      return n
    })
  }

  function confirmCreate(i) {
    const form = createForms[i]
    if (!form?.STYLE || !form?.COLOR || !form?.SIZE) return
    resolve(i, 'create', { STYLE: form.STYLE, COLOR: form.COLOR, SIZE: form.SIZE })
  }

  function handleApply() {
    const items = []
    for (const [i, row] of unmatchedRows.entries()) {
      const r = resolved[i]
      if (!r || r.type === 'skip') continue
      items.push({
        STYLE:  r.entry.STYLE,
        COLOR:  r.entry.COLOR,
        SIZE:   r.entry.SIZE,
        QTY:    row.qty,
        _isNew: r.type === 'create',
      })
    }
    onDone(items)
  }

  // Filter template entries for the search box
  function getMatches(i, row) {
    const q    = searches[i].toLowerCase().trim()
    const ns   = (row.style || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    // Start with candidates that share the same normalized style prefix (≥4 chars)
    let pool = normTemplate
    if (ns.length >= 4) {
      const stylePre = pool.filter(t =>
        t.STYLE.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(ns) ||
        t.STYLE.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(ns.slice(0, 4))
      )
      if (stylePre.length) pool = stylePre
    }
    if (q) {
      pool = pool.filter(t =>
        t.STYLE.toLowerCase().includes(q) ||
        t.COLOR.toLowerCase().includes(q) ||
        t.SIZE.toLowerCase().includes(q)
      )
    }
    return pool.slice(0, 30)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-slate-800">Review Unmatched Rows</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {pending > 0
              ? `${pending} remaining · ${linked} linked · ${created} created · ${skipped} skipped`
              : `All resolved — ${linked} linked, ${created} new, ${skipped} skipped`}
          </p>
        </div>
        <button
          onClick={handleApply}
          disabled={pending > 0}
          className="btn-primary text-sm px-5 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CheckCircle className="w-4 h-4" />
          Apply {linked + created} Resolutions
        </button>
      </div>

      {pending > 0 && (
        <p className="text-xs text-amber-600 px-1">
          Resolve or skip all rows before applying.
        </p>
      )}

      {/* Row cards */}
      <div className="space-y-3">
        {unmatchedRows.map((row, i) => {
          const r        = resolved[i]
          const isCreate = !!createForms[i]
          const form     = createForms[i]
          const matches  = getMatches(i, row)

          return (
            <div
              key={i}
              className={`card p-4 space-y-3 transition-colors ${
                r?.type === 'link'   ? 'border-blue-200 bg-blue-50/40' :
                r?.type === 'create' ? 'border-green-200 bg-green-50/40' :
                r?.type === 'skip'   ? 'border-slate-100 bg-slate-50 opacity-60' :
                'border-slate-200'
              }`}
            >
              {/* Sales row info */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                  {row.style}
                </span>
                <span className="text-sm text-slate-600">{row.color}</span>
                <span className="text-slate-300">·</span>
                <span className="text-sm text-slate-600">{row.size}</span>
                <span className="ml-auto bg-orange-100 text-orange-700 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
                  QTY {row.qty}
                </span>
              </div>

              {/* Resolved state */}
              {r ? (
                <div className="flex items-center gap-2 text-sm">
                  {r.type === 'skip' ? (
                    <span className="text-slate-400 italic">Skipped</span>
                  ) : (
                    <>
                      {r.type === 'link'
                        ? <Link2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                        : <Plus  className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                      <span className="font-mono text-slate-700">{r.entry.STYLE}</span>
                      <span className="text-slate-400">/</span>
                      <span className="text-slate-600 truncate">{r.entry.COLOR}</span>
                      <span className="text-slate-400">/</span>
                      <span className="text-slate-600">{r.entry.SIZE}</span>
                      {r.type === 'create' && (
                        <span className="ml-1 text-xs text-green-600 font-medium">(new entry)</span>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => unresolve(i)}
                    className="ml-auto text-slate-300 hover:text-slate-500"
                    title="Undo"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : isCreate ? (
                /* Create form */
                <div className="space-y-2">
                  <p className="text-xs text-slate-500 font-medium">New inventory entry — edit if needed:</p>
                  <div className="grid grid-cols-3 gap-2">
                    {['STYLE', 'COLOR', 'SIZE'].map(field => (
                      <div key={field}>
                        <label className="block text-xs text-slate-400 mb-0.5">{field}</label>
                        <input
                          type="text"
                          value={form[field]}
                          onChange={e => updateCreate(i, field, e.target.value)}
                          className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => confirmCreate(i)}
                      disabled={!form.STYLE || !form.COLOR || !form.SIZE}
                      className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => closeCreate(i)}
                      className="btn-secondary text-xs px-3 py-1.5"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* Link search + action buttons */
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search template (style, color, size)…"
                      value={searches[i]}
                      onChange={e => setSearch(i, e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Template matches */}
                  {matches.length > 0 && (
                    <div className="border border-slate-100 rounded-lg overflow-hidden max-h-44 overflow-y-auto divide-y divide-slate-50">
                      {matches.map((t, j) => (
                        <button
                          key={j}
                          onClick={() => resolve(i, 'link', t)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-3"
                        >
                          <span className="font-mono font-medium text-slate-700 shrink-0 w-20 truncate">{t.STYLE}</span>
                          <span className="text-slate-500 flex-1 truncate">{t.COLOR}</span>
                          <span className="text-slate-400 shrink-0">{t.SIZE}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {matches.length === 0 && searches[i] && (
                    <p className="text-xs text-slate-400 px-1">No matches — try a different search or create a new entry.</p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => openCreate(i, row)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600"
                    >
                      <Plus className="w-3 h-3" />
                      Create new entry
                    </button>
                    <button
                      onClick={() => resolve(i, 'skip', null)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 text-slate-400 hover:text-slate-600"
                    >
                      <SkipForward className="w-3 h-3" />
                      Skip
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
