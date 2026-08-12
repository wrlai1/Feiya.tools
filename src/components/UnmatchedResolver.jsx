import React, { useEffect, useState, useMemo } from 'react'
import { Search, Plus, SkipForward, CheckCircle, X, Link2, ChevronDown, RotateCcw } from 'lucide-react'
import { findAdditionalComboSizeMappings, findAdditionalSizeMappings } from '../utils/autoDeductRules.js'
import { resolutionSourceContext } from '../utils/autoDeductMovements.js'

const REVIEW_REASONS = {
  style_identity_mismatch: 'The style punctuation differs from inventory, so it was not matched automatically.',
  ambiguous_inventory_style: 'More than one inventory style could match this source style.',
  ambiguous_inventory_color: 'More than one inventory color has the same cleaned identity.',
  confirmed_mapping_requires_review: 'This saved mapping changes style or uses a combo and must be confirmed again.',
  confirmed_mapping_size_missing: 'The previously confirmed target does not contain this exact size.',
  confirmed_new_target_missing: 'This previously created inventory target no longer exists. Choose an existing target or confirm Create new entry again.',
  m022_size_unknown: 'M022 must use S–XL for Missy or 1X–3X for Plus.',
  sku_attribute_size_conflict: 'The SKU size and Product Attribute size disagree. Confirm whether this is Missy, Plus, or Petite.',
  sku_attribute_color_conflict: 'The SKU color combination and Product Attribute color combination disagree.',
  ambiguous_color_separator: 'This SKU uses "/" instead of the confirmed "&" color format. The system cannot know whether this is one color name or multiple physical pieces. Confirm the units per sold SKU and choose the exact inventory item(s).',
}

function DeferredSearchInput({ value, onCommit, onFocus }) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return undefined
    const timer = window.setTimeout(() => onCommit(draft), 180)
    return () => window.clearTimeout(timer)
  }, [draft, value, onCommit])

  return (
    <div className="relative">
      <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
      <input
        type="text"
        placeholder="Search template (style, color, size)…"
        value={draft}
        onFocus={onFocus}
        onChange={(event) => setDraft(event.target.value)}
        className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

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
  const [packCounts,      setPackCounts]      = useState(() => unmatchedRows.map(row => row.packCount > 1 ? row.packCount : ''))
  const [activeSearch,    setActiveSearch]    = useState(null)
  const [ruleBatches,     setRuleBatches]     = useState([])

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

  function confirmLink(i, entry) {
    const additional = findAdditionalSizeMappings({
      unmatchedRows,
      templateRows: normTemplate,
      resolved,
      sourceIndex: i,
      targetEntry: entry,
    })
    const batchId = `${Date.now()}-${i}`
    const next = [...resolved]
    next[i] = { type: 'link', entry, batchId, isBatchSource: additional.length > 0 }
    for (const match of additional) {
      next[match.index] = { type: 'link', entry: match.entry, batchId, autoApplied: true }
    }
    setResolved(next)
    setCreateForms(prev => { const forms = [...prev]; forms[i] = null; return forms })
    if (additional.length) {
      setRuleBatches(prev => [...prev, {
        id: batchId,
        sourceIndex: i,
        memberIndexes: additional.map(match => match.index),
        expanded: false,
      }])
    }
  }

  function undoBatch(batchId, includeSource = false) {
    const batch = ruleBatches.find(item => item.id === batchId)
    if (!batch) return
    setResolved(prev => {
      const next = [...prev]
      for (const index of batch.memberIndexes) next[index] = null
      if (includeSource) next[batch.sourceIndex] = null
      else if (next[batch.sourceIndex]) next[batch.sourceIndex] = { ...next[batch.sourceIndex], batchId: undefined, isBatchSource: false }
      return next
    })
    setRuleBatches(prev => prev.filter(item => item.id !== batchId))
  }

  function editBatchMember(batchId, index) {
    setResolved(prev => { const next = [...prev]; next[index] = null; return next })
    setRuleBatches(prev => prev.flatMap(batch => {
      if (batch.id !== batchId) return [batch]
      const memberIndexes = batch.memberIndexes.filter(member => member !== index)
      return memberIndexes.length ? [{ ...batch, memberIndexes }] : []
    }))
    setActiveSearch(index)
  }

  function toggleBatch(batchId) {
    setRuleBatches(prev => prev.map(batch => batch.id === batchId ? { ...batch, expanded: !batch.expanded } : batch))
  }

  function unresolve(i) {
    const batch = ruleBatches.find(item => item.sourceIndex === i || item.memberIndexes.includes(i))
    if (batch) {
      if (batch.sourceIndex === i) undoBatch(batch.id, true)
      else editBatchMember(batch.id, i)
      return
    }
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

  function isSetReview(row) {
    return row.packCount > 1 || /set_components_unknown|cross_style_combo|ambiguous_color_separator/.test(row.parseIssue || '')
  }

  function expectedPackCount(i, row) {
    if (!isSetReview(row)) return null
    const value = parseInt(packCounts[i], 10)
    return value > 0 ? value : null
  }

  function comboMultiplierTotal(i) {
    return (comboSelections[i] || []).reduce((sum, component) => sum + Math.max(1, parseInt(component.multiplier, 10) || 1), 0)
  }

  function confirmCombo(i, row) {
    const components = comboSelections[i] || []
    if (!components.length) return
    const expected = expectedPackCount(i, row)
    if (isSetReview(row) && (!expected || comboMultiplierTotal(i) !== expected)) return
    const additional = findAdditionalComboSizeMappings({
      unmatchedRows,
      templateRows: normTemplate,
      resolved,
      sourceIndex: i,
      components,
    })
    const next = [...resolved]
    next[i] = { type: 'combo', entry: { components } }
    for (const match of additional) {
      next[match.index] = { type: 'combo', entry: { components: match.components }, autoApplied: true }
    }
    setResolved(next)
    setCreateForms(prev => { const forms = [...prev]; forms[i] = null; return forms })
  }

  function handleApply() {
    const items   = []
    const skipped = []   // original sales rows the user chose NOT to resolve —
                         // callers must keep these visible (Unmatched sheet), never drop them
    for (const [i, row] of unmatchedRows.entries()) {
      const r = resolved[i]
      if (!r || r.type === 'skip') {
        skipped.push({ style: row.style, color: row.color, size: row.size, qty: row.qty, packCount: row.packCount, parseIssue: row.parseIssue })
        continue
      }
      if (r.type === 'combo') {
        const confirmedPackCount = r.entry.components.reduce((sum, component) =>
          sum + Math.max(1, parseInt(component.multiplier, 10) || 1), 0)
        items.push({
          components: r.entry.components,
          QTY: row.qty,
          _isCombo: true,
          _source: resolutionSourceContext(row, {
            packCount: confirmedPackCount,
            originalPackCount: row.packCount,
          }),
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
        _source: resolutionSourceContext(row),
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
          const matches  = activeSearch === i && !r && !isCreate ? getMatches(i, row) : []
          const comboComponents = comboSelections[i] || []
          const setReview = isSetReview(row)
          const expected = expectedPackCount(i, row)
          const comboTotal = comboMultiplierTotal(i)
          const sourceBatch = ruleBatches.find(batch => batch.sourceIndex === i)

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
                  {row.packCount > 1 ? `${row.qty} order(s) × ${row.packCount} units` : `QTY ${row.qty}`}
                </span>
              </div>

              {row.parseIssue && !r && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {REVIEW_REASONS[row.parseIssue] || `Source needs review: ${row.parseIssue.replaceAll('_', ' ')}`}
                </div>
              )}

              {setReview && !r && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>Physical pieces are not confirmed. Enter units per sold SKU, then build the exact inventory target(s):</span>
                    <input
                      type="number"
                      min="1"
                      value={packCounts[i]}
                      onChange={(e) => setPackCounts(prev => { const next = [...prev]; next[i] = e.target.value; return next })}
                      className="w-16 rounded border border-amber-200 bg-white px-2 py-1 text-center"
                      placeholder="?"
                    />
                  </div>
                </div>
              )}

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
                          onClick={() => confirmCombo(i, row)}
                          disabled={setReview && (!expected || comboTotal !== expected)}
                          className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Confirm combo{setReview && expected ? ` (${comboTotal}/${expected})` : ''}
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

                  <DeferredSearchInput
                    value={searches[i]}
                    onCommit={(value) => setSearch(i, value)}
                    onFocus={() => setActiveSearch(i)}
                  />

                  {/* Template matches */}
                  {matches.length > 0 && (
                    <div className="border border-slate-100 rounded-lg overflow-hidden max-h-44 overflow-y-auto divide-y divide-slate-50">
                      {matches.map((t, j) => (
                        <div key={j} className="flex items-center">
                          <button
                            onClick={() => { if (!setReview) confirmLink(i, t) }}
                            disabled={setReview}
                            className="flex-1 text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-3 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
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

                  {activeSearch === i && matches.length === 0 && searches[i] && (
                    <p className="text-xs text-slate-400 px-1">No matches — try a different search or create a new entry.</p>
                  )}

                  <div className="flex gap-2 pt-1">
                    {!setReview && (
                      <button
                        onClick={() => openCreate(i, row)}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600"
                      >
                        <Plus className="w-3 h-3" />
                        Create new entry
                      </button>
                    )}
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
              {sourceBatch && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  <div className="flex items-center gap-3 flex-wrap">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-medium">
                      Applied this rule to {sourceBatch.memberIndexes.length} additional size{sourceBatch.memberIndexes.length === 1 ? '' : 's'}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => toggleBatch(sourceBatch.id)} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                        Review <ChevronDown className={`w-3.5 h-3.5 transition-transform ${sourceBatch.expanded ? 'rotate-180' : ''}`} />
                      </button>
                      <button onClick={() => undoBatch(sourceBatch.id)} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                        <RotateCcw className="w-3.5 h-3.5" /> Undo
                      </button>
                    </div>
                  </div>
                  {sourceBatch.expanded && (
                    <div className="mt-3 divide-y divide-emerald-100 rounded-lg border border-emerald-100 bg-white/80 px-3">
                      {sourceBatch.memberIndexes.map(index => {
                        const sibling = unmatchedRows[index]
                        const target = resolved[index]?.entry
                        if (!sibling || !target) return null
                        return (
                          <div key={index} className="flex items-center gap-2 py-2 text-xs">
                            <span className="font-mono font-semibold text-slate-700">{sibling.style}</span>
                            <span className="text-slate-500">{sibling.color} / {sibling.size}</span>
                            <span className="text-slate-300">→</span>
                            <span className="min-w-0 flex-1 truncate text-emerald-700">{target.STYLE} / {target.COLOR} / {target.SIZE}</span>
                            <button onClick={() => editBatchMember(sourceBatch.id, index)} className="font-semibold text-blue-600 hover:text-blue-700">Edit</button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
