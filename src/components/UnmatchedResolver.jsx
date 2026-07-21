import React, { useState, useMemo } from 'react'
import { Search, Plus, SkipForward, CheckCircle, X, Link2 } from 'lucide-react'

/**
 * Interactive panel for resolving unmatched sales rows.
 *
 * For each row the auto-matcher couldn't place, the user can:
 *   Link   — pick an existing template entry to assign the QTY to
 *   Combo  — pick multiple existing template entries with a quantity multiplier
 *   Create — manually specify STYLE / COLOR / SIZE (new row appended to output)
 *   Skip   — discard the row
 *
 * onDone(resolvedItems) is called when the user clicks "Apply".
 * resolvedItems: Array of { STYLE, COLOR, SIZE, QTY, _isNew? } or
 *                { components: [{STYLE,COLOR,SIZE}], QTY, _isCombo: true }
 */
export default function UnmatchedResolver({ unmatchedRows, templateRows, onDone }) {
  // resolved[i] = { type: 'link'|'combo'|'create'|'skip', entry } | null
  const [resolved,        setResolved]        = useState(() => Array(unmatchedRows.length).fill(null))
  const [searches,        setSearches]        = useState(() => Array(unmatchedRows.length).fill(''))
  const [createForms,     setCreateForms]     = useState(() => Array(unmatchedRows.length).fill(null))
  const [comboSelections, setComboSelections] = useState(() => Array(unmatchedRows.length).fill(null).map(() => []))

  const pending   = resolved.filter(r => !r).length
  const linked    = resolved.filter(r => r?.type === 'link').length
  const comboed   = resolved.filter(r => r?.type === 'combo').length
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

  function componentKey(entry) {
    return [entry.STYLE, entry.COLOR, entry.SIZE].map(v => String(v || '').trim().toLowerCase()).join('||')
  }

  function addComboComponent(i, entry) {
    setComboSelections(prev => {
      const next = [...prev]
      const current = next[i] || []
      if (current.some(item => componentKey(item) === componentKey(entry))) return next
      next[i] = [...current, { ...entry, multiplier: 1 }]
      return next
    })
  }

  function updateComboMultiplier(i, entry, value) {
    setComboSelections(prev => {
      const next = [...prev]
      next[i] = (next[i] || []).map(item => componentKey(item) === componentKey(entry)
        ? { ...item, multiplier: Math.max(1, parseInt(value, 10) || 1) }
        : item)
      return next
    })
  }

  function removeComboComponent(i, entry) {
    setComboSelections(prev => {
      const next = [...prev]
      next[i] = (next[i] || []).filter(item => componentKey(item) !== componentKey(entry))
      return next
    })
  }

  function confirmCombo(i) {
    const components = comboSelections[i] || []
    if (!components.length) return
    resolve(i, 'combo', { components })
  }

  function handleApply() {
    const items   = []
    const skipped = []   // original sales rows the user chose NOT to resolve —
                         // callers must keep these visible (Unmatched sheet), never drop them
    for (const [i, row] of unmatchedRows.entries()) {
      const r = resolved[i]
      if (!r || r.type === 'skip') {
        skipped.push({ style: row.style, color: row.color, size: row.size, qty: row.qty })
        continue
      }
      if (r.type === 'combo') {
        items.push({
          components: r.entry.components,
          QTY: row.qty,
          _isCombo: true,
          _source: { style: row.style, color: row.color, size: row.size },
          _learnAlias: true,
        })
        continue
      }
      items.push({
        STYLE:  r.entry.STYLE,
        COLOR:  r.entry.COLOR,
        SIZE:   r.entry.SIZE,
        QTY:    row.qty,
        _isNew: r.type === 'create',
        _source: { style: row.style, color: row.color, size: row.size },
        _learnAlias: r.type === 'link' || r.type === 'create',
      })
    }
    onDone(items, skipped)
  }

  function compactText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  }

  function looseText(value) {
    return String(value || '').toLowerCase().trim()
  }

  function lcsRatio(a, b) {
    if (!a || !b) return 0
    const prev = new Array(a.length + 1).fill(0)
    const curr = new Array(a.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      curr[0] = 0
      for (let i = 1; i <= a.length; i++) {
        curr[i] = a[i - 1] === b[j - 1] ? prev[i - 1] + 1 : Math.max(curr[i - 1], prev[i])
      }
      for (let i = 0; i <= a.length; i++) { prev[i] = curr[i]; curr[i] = 0 }
    }
    return prev[a.length] / Math.min(a.length, b.length)
  }

  function styleSearchScore(style, query) {
    if (!query) return 0
    const styleN = compactText(style)
    if (!styleN) return 0
    if (styleN === query) return 1000
    if (styleN.startsWith(query)) return 900
    if (styleN.includes(query)) return 800
    if (query.length >= 4 && styleN.length >= 4) {
      const ratio = lcsRatio(styleN, query)
      if (ratio >= 0.78) return Math.round(600 + ratio * 100)
    }
    return 0
  }

  function styleSearchTerms(query, compactQuery) {
    const terms = [compactQuery]
    for (const part of query.split(/\s+/)) {
      const compact = compactText(part)
      if (compact.length >= 3) terms.push(compact)
    }
    if (/set/.test(compactQuery)) {
      const beforeSet = compactQuery.replace(/set.*$/, '')
      if (beforeSet.length >= 3) terms.push(beforeSet)
    }
    return [...new Set(terms.filter(Boolean))]
  }

  function textSearchScore(value, query, compactQuery) {
    if (!query && !compactQuery) return 0
    const loose = looseText(value)
    const compact = compactText(value)
    if (query && loose === query) return 500
    if (compactQuery && compact === compactQuery) return 500
    if (query && loose.includes(query)) return 350
    if (compactQuery && compact.includes(compactQuery)) return 350
    if (compactQuery?.length >= 4 && compact.length >= 4) {
      const ratio = lcsRatio(compact, compactQuery)
      if (ratio >= 0.82) return Math.round(220 + ratio * 80)
    }
    return 0
  }

  function sourceColorScore(templateColor, sourceColor) {
    const template = compactText(templateColor)
    const source = compactText(sourceColor)
    if (!template || !source) return 0
    if (template === source) return 300
    if (template.includes(source) || source.includes(template)) return 220
    const ratio = lcsRatio(template, source)
    return ratio >= 0.78 ? Math.round(120 + ratio * 80) : 0
  }

  // Filter template entries for the search box
  function getMatches(i, row) {
    const q = looseText(searches[i])
    const nq = compactText(q)
    const ns = compactText(row.style)
    // Start with candidates that share the same normalized style prefix (≥4 chars)
    let pool = normTemplate
    if (!q && ns.length >= 4) {
      const stylePre = pool.filter(t =>
        compactText(t.STYLE).startsWith(ns) ||
        compactText(t.STYLE).startsWith(ns.slice(0, 4))
      )
      if (stylePre.length) pool = stylePre
      return pool
        .map(t => ({ ...t, _score: sourceColorScore(t.COLOR, row.color) + textSearchScore(t.SIZE, looseText(row.size), compactText(row.size)) }))
        .sort((a, b) => b._score - a._score || a.STYLE.localeCompare(b.STYLE) || a.COLOR.localeCompare(b.COLOR))
        .slice(0, 30)
        .map(({ _score, ...t }) => t)
    }
    if (q) {
      const styleTerms = styleSearchTerms(q, nq)
      const rankedByStyle = normTemplate
        .map(t => ({
          ...t,
          _styleScore: Math.max(...styleTerms.map(term => styleSearchScore(t.STYLE, term))),
          _colorScore: sourceColorScore(t.COLOR, row.color),
          _sizeScore: textSearchScore(t.SIZE, looseText(row.size), compactText(row.size)),
        }))
        .filter(t => t._styleScore > 0)
        .sort((a, b) =>
          b._styleScore - a._styleScore ||
          b._colorScore - a._colorScore ||
          b._sizeScore - a._sizeScore ||
          a.STYLE.localeCompare(b.STYLE) ||
          a.COLOR.localeCompare(b.COLOR)
        )

      if (rankedByStyle.length) {
        return rankedByStyle.slice(0, 30).map(({ _styleScore, _colorScore, _sizeScore, ...t }) => t)
      }

      pool = normTemplate
        .map(t => ({
          ...t,
          _colorQueryScore: textSearchScore(t.COLOR, q, nq),
          _sizeQueryScore: textSearchScore(t.SIZE, q, nq),
          _sourceColorScore: sourceColorScore(t.COLOR, row.color),
        }))
        .filter(t => t._colorQueryScore > 0 || t._sizeQueryScore > 0)
        .sort((a, b) =>
          b._colorQueryScore - a._colorQueryScore ||
          b._sizeQueryScore - a._sizeQueryScore ||
          b._sourceColorScore - a._sourceColorScore ||
          a.STYLE.localeCompare(b.STYLE) ||
          a.COLOR.localeCompare(b.COLOR)
        )
      return pool.slice(0, 30).map(({ _colorQueryScore, _sizeQueryScore, _sourceColorScore, ...t }) => t)
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
              ? `${pending} remaining · ${linked} linked · ${comboed} combo · ${created} created · ${skipped} skipped`
              : `All resolved — ${linked} linked, ${comboed} combo, ${created} new, ${skipped} skipped`}
          </p>
        </div>
        <button
          onClick={handleApply}
          disabled={pending > 0}
          className="btn-primary text-sm px-5 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CheckCircle className="w-4 h-4" />
          Apply {linked + comboed + created} Resolutions
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
          const comboComponents = comboSelections[i] || []

          return (
            <div
              key={i}
              className={`card p-4 space-y-3 transition-colors ${
                r?.type === 'link'   ? 'border-blue-200 bg-blue-50/40' :
                r?.type === 'combo'  ? 'border-indigo-200 bg-indigo-50/40' :
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
                  ) : r.type === 'combo' ? (
                    <>
                      <Link2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                      <span className="font-medium text-indigo-700">Combo set</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-slate-600 truncate">
                        {r.entry.components.map(c => `${c.STYLE}/${c.COLOR}/${c.SIZE} ×${c.multiplier || 1}`).join(' + ')}
                      </span>
                    </>
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
                  {comboComponents.length > 0 && (
                    <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-xs font-medium text-indigo-700">Combo components</p>
                        <button
                          onClick={() => confirmCombo(i)}
                          className="btn-primary text-xs px-3 py-1.5"
                        >
                          Confirm combo
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {comboComponents.map(component => (
                          <div key={componentKey(component)} className="flex items-center gap-2 rounded-md bg-white px-2 py-1 text-xs">
                            <span className="font-mono text-slate-700">{component.STYLE}</span>
                            <span className="text-slate-400">/</span>
                            <span className="text-slate-600 truncate">{component.COLOR}</span>
                            <span className="text-slate-400">/</span>
                            <span className="text-slate-600">{component.SIZE}</span>
                            <label className="ml-auto flex items-center gap-1 text-slate-500">
                              ×
                              <input
                                type="number"
                                min="1"
                                value={component.multiplier || 1}
                                onChange={(e) => updateComboMultiplier(i, component, e.target.value)}
                                className="w-14 rounded border border-indigo-100 px-1.5 py-1 text-center"
                              />
                            </label>
                            <button
                              onClick={() => removeComboComponent(i, component)}
                              className="text-slate-300 hover:text-red-500"
                              title="Remove component"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

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
                        <div key={j} className="flex items-center">
                          <button
                            onClick={() => resolve(i, 'link', t)}
                            className="flex-1 text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-3 min-w-0"
                          >
                            <span className="font-mono font-medium text-slate-700 shrink-0 w-20 truncate">{t.STYLE}</span>
                            <span className="text-slate-500 flex-1 truncate">{t.COLOR}</span>
                            <span className="text-slate-400 shrink-0">{t.SIZE}</span>
                          </button>
                          <button
                            onClick={() => addComboComponent(i, t)}
                            className="mr-2 shrink-0 rounded-md border border-indigo-100 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
                            title="Add this row to a combo set"
                          >
                            Set +
                          </button>
                        </div>
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
