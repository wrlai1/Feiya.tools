/**
 * Auto Deduct matching engine — runs entirely in the browser.
 *
 * Template format: STYLE, COLOR, SIZE
 * Sales format:    style, color, size, QTY
 *
 * Color names in sales CSVs are abbreviated/informal, so we use
 * normalized substring scoring to find the best template match.
 */

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Semantic color aliases: maps informal/abbreviated sales color names to the
 * canonical color names used in the template.  Keys are already normalized
 * (lowercase, alphanumeric only) so the lookup happens after basic cleaning.
 */
const COLOR_ALIASES = {
  melon:       'canyonrose',
  rich:        'orchidhush',
  pinkyarrow:  'fuschia',
  pinkarrow:   'fuschia',
}

/** Stable color identity used by exact matches and learned mappings. */
export function normalizeColor(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Looser color key used only to rank review candidates, never to auto-apply. */
function normalizeFuzzyColor(s) {
  const base = String(s)
    .toLowerCase()
    .replace(/#\s*\d+/g, '')     // remove numeric codes: #2, #1827, #32, "# 51"
    .replace(/[^a-z\s]/g, ' ')  // non-alpha → space
    .replace(/\b[a-z]\b/g, '')  // remove single-letter words (l, m, w, g…)
    .replace(/\s+/g, '')         // collapse all spaces
    .trim()
  return COLOR_ALIASES[base] ?? base
}

/**
 * Normalize a style string for bucket-key matching only (NOT for output).
 * Lowercases and strips everything except alphanumeric so that:
 *   LT366 === Lt366, M017-MISSY === M017Missy, 95401 CAPRI === 95401 Capri
 */
export function normalizeStyle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')  // keep only alphanumeric
}

/**
 * Conservative style identity used before any automatic deduction.
 * Case and spacing are presentation differences; punctuation remains meaningful.
 */
export function normalizeStyleIdentity(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * Normalize a size string.
 * Also maps plus-size variants: 1XL → 1X, 2XL → 2X, 3XL → 3X
 * so sales and template entries match regardless of which convention is used.
 */
export function normalizeSize(s) {
  return String(s)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^([123])XL$/, '$1X')   // 1XL→1X, 2XL→2X, 3XL→3X
}

export function countSkippedUnits(rows) {
  return (rows || []).reduce((sum, row) => {
    const qty = Number(row?.qty || 0)
    const packCount = Math.max(1, parseInt(row?.packCount || row?.pack_count, 10) || 1)
    return sum + qty * packCount
  }, 0)
}

export function calculateResolvedSourceUnits(baseSourceUnits, resolvedItems = []) {
  return (resolvedItems || []).reduce((total, item) => {
    const source = item?._source
    if (!item?._isCombo || !source) return total
    const componentPackCount = (item.components || []).reduce((sum, component) =>
      sum + Math.max(1, parseInt(component?.multiplier, 10) || 1), 0)
    const confirmedPackCount = componentPackCount
      || Math.max(1, parseInt(source.packCount, 10) || 1)
    const originalPackCount = Math.max(1, parseInt(source.originalPackCount, 10) || confirmedPackCount)
    return total + (Number(item.QTY) || 0) * (confirmedPackCount - originalPackCount)
  }, Number(baseSourceUnits) || 0)
}

const M022_MISSY_SIZES = new Set(['S', 'M', 'L', 'XL'])
const M022_PETITE_SIZES = new Set(['PS', 'PM', 'PL', 'PXL'])
const M022_PLUS_SIZES = new Set(['1X', '2X', '3X'])
const KNOWN_INVENTORY_STYLE_ROUTES = new Map([
  ['0015', '5010015'],
  ['0071', '5020071'],
])

export function m022InventoryStyle(style, normalizedSize) {
  if (normalizeStyleIdentity(style) !== 'm022') return ''
  if (M022_MISSY_SIZES.has(normalizedSize)) return 'M022 Missy'
  if (M022_PETITE_SIZES.has(normalizedSize)) return 'M022 Petite'
  if (M022_PLUS_SIZES.has(normalizedSize)) return 'M022 PLUS'
  return null
}

export function routedInventoryStyle(style, normalizedSize) {
  const m022Style = m022InventoryStyle(style, normalizedSize)
  if (m022Style !== '') return m022Style
  return KNOWN_INVENTORY_STYLE_ROUTES.get(normalizeStyleIdentity(style)) || ''
}

// ── Fuzzy helpers ─────────────────────────────────────────────────────────────

/**
 * Longest Common Subsequence length — O(m·n), fast enough for color tokens (~10 chars).
 */
function lcsLength(a, b) {
  const m = a.length, n = b.length
  if (!m || !n) return 0
  const prev = new Array(m + 1).fill(0)
  const curr = new Array(m + 1).fill(0)
  for (let j = 1; j <= n; j++) {
    curr[0] = 0
    for (let i = 1; i <= m; i++) {
      curr[i] = a[i - 1] === b[j - 1] ? prev[i - 1] + 1 : Math.max(curr[i - 1], prev[i])
    }
    for (let i = 0; i <= m; i++) { prev[i] = curr[i]; curr[i] = 0 }
  }
  return prev[m]
}

/**
 * Split a raw color string into meaningful word tokens (2+ chars).
 * Strips numeric codes first so "dark denim#2" → ["dark","denim"],
 * "med denim" → ["med","denim"], "BLACK TR & mill" → ["black","tr","mill"].
 */
function colorTokens(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2) // keep 2+ char tokens (catches "tr", "nv" etc.)
}

// ── Color scoring ─────────────────────────────────────────────────────────────

/** A match is only accepted (auto-filled) when its color score reaches this. */
export const MATCH_THRESHOLD = 1

/**
 * Pattern / print qualifier words. When a SINGLE-token sales color (e.g. "black")
 * would subset-match a template color that ALSO carries one of these (e.g. "black
 * floral"), the print is a distinct product — so we send it to the resolver for the
 * user to confirm instead of silently merging it.
 */
const PATTERN_WORDS = new Set([
  'floral', 'plaid', 'paisley', 'print', 'stripe', 'striped', 'check', 'checked',
  'gingham', 'ginhgam', 'camo', 'snake', 'snakeskin', 'houndstooth', 'hounstooth',
  'texture', 'textured', 'leopard', 'cheetah', 'zebra', 'python', 'tiger', 'tortoise',
  'flower', 'flw', 'animal', 'geo', 'geometric', 'glen',
])

/**
 * Score how well a sales color matches a template color (0–1).
 * Only scores ≥ MATCH_THRESHOLD are accepted; everything else goes to the resolver.
 *
 * Tiers:
 *   1. Exact normalized match                                   → 1.0
 *   2. Token containment — every sales word is in the template  → 0.92
 *      ("black" ⊆ "BLACK TR & mill", "light denim" ⊆ "knit denim light denim").
 *      Blocked when the template has a print/pattern word the
 *      sales color doesn't claim ("black" vs "black floral")     → 0.60 (resolver)
 *   3. Prefix abbreviation ("dazz" → "dazzling blue")           → 0.90
 *   4. Whole-string typo near-miss (fuchsia/fuschia)            → 0.90
 *   5. Proportional substring                                   → < threshold
 */
function colorScore(templateColor, salesColor) {
  const exactTemplate = normalizeColor(templateColor)
  const exactSales = normalizeColor(salesColor)
  const tc = normalizeFuzzyColor(templateColor)
  const sc = normalizeFuzzyColor(salesColor)
  if (!tc || !sc) return 0
  if (exactTemplate && exactTemplate === exactSales) return 1.0

  // "near" = same word or a spelling typo (similar length) — NOT subsequence
  // containment, else short words like "blue" match anything holding b-l-u-e
  // ("deepblue" → "blue"). Length must be within 2 and LCS ratio ≥ 0.85.
  const near = (a, b) => a === b ||
    (Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= 2 &&
     lcsLength(a, b) / Math.min(a.length, b.length) >= 0.85)

  // Token containment — every sales word matches a template word (exact or near).
  // Pattern guard, all token counts: when the sales color claims NO pattern word but
  // the template carries one ("black mill" vs "black floral mill"), the print is a
  // different product → defer to the resolver. When the sales color itself names a
  // pattern ("grey plaid", "leopard"), template-side pattern words are not
  // disqualifying — generic qualifiers like "Ponte Print" would wrongly demote the
  // correct candidate and hand the win to a worse one.
  const stks = colorTokens(salesColor)
  const ttks = colorTokens(templateColor)
  if (stks.length && ttks.length) {
    const matched = stks.filter(s => ttks.some(t => near(s, t)))
    if (matched.length === stks.length) {
      const salesHasPattern = stks.some(t => PATTERN_WORDS.has(t))
      const extra = ttks.filter(t => !stks.some(s => near(s, t)))
      if (!salesHasPattern && extra.some(t => PATTERN_WORDS.has(t))) return 0.6  // → resolver
      return 0.92
    }
  }

  // Prefix abbreviation: "dazz" → "dazzlingblue", "bachelorbutt" → "bachelorbutton"
  if (sc.length >= 4 && tc.startsWith(sc)) return 0.9

  // Proportional substring (partials; usually below threshold)
  if (tc.includes(sc)) return sc.length / tc.length
  if (sc.includes(tc)) return tc.length / sc.length

  // Whole-string typo near-miss (fuchsia/fuschia, peacock/peapock)
  const minLen = Math.min(tc.length, sc.length)
  if (minLen >= 4 && lcsLength(tc, sc) / minLen >= 0.85) return 0.9
  return 0
}

// ── CSV parser ────────────────────────────────────────────────────────────────

/** Parse CSV text → array of plain objects keyed by header row */
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []

  // Tokenise one line, handling quoted fields that may contain commas
  function tokenize(line) {
    const fields = []
    let cur = '', inQ = false
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue }
      if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = '' }
      else cur += ch
    }
    fields.push(cur.trim())
    return fields
  }

  const header = tokenize(lines[0]).map(h => h.replace(/^"|"$/g, '').trim())

  return lines.slice(1).map(line => {
    const fields = tokenize(line)
    const obj = {}
    header.forEach((h, i) => { obj[h] = (fields[i] ?? '').replace(/^"|"$/g, '').trim() })
    return obj
  }).filter(r => Object.values(r).some(v => v !== ''))
}

// ── Core fill algorithm ───────────────────────────────────────────────────────

/** Build the lookup key for a learned alias: style + sales-color + optional size. */
export function aliasKey(style, salesColor, size = '') {
  const base = `${normalizeStyleIdentity(style)}::${normalizeColor(salesColor)}`
  const normSize = normalizeSize(size)
  return normSize ? `${base}::${normSize}` : base
}

function asConfirmedAlias(value, keepSize = false) {
  if (!value || value._isNew) return null
  if (typeof value === 'string') return { COLOR: value, _confirmed: true }
  if (Array.isArray(value.components) && value.components.length) {
    return {
      ...value,
      components: value.components.map((component) => ({
        STYLE: component.STYLE,
        COLOR: component.COLOR,
        SIZE: keepSize ? component.SIZE : undefined,
        multiplier: Math.max(1, parseInt(component.multiplier, 10) || 1),
      })),
      _confirmed: true,
    }
  }
  return { ...value, SIZE: keepSize ? value.SIZE : undefined, _confirmed: true }
}

function inferConfirmedStyleColorAlias(aliases, baseKey) {
  const targets = Object.entries(aliases)
    .filter(([key]) => key.startsWith(`${baseKey}::`))
    .map(([, value]) => asConfirmedAlias(value))
    .filter(Boolean)
  if (!targets.length) return null

  const fingerprints = new Set(targets.map((target) => {
    if (Array.isArray(target.components)) {
      const components = target.components
        .map((component) => [
          String(component.STYLE || ''),
          String(component.COLOR || ''),
          Math.max(1, parseInt(component.multiplier, 10) || 1),
        ].join('\u0000'))
        .sort()
      return `combo\u0000${components.join('\u0001')}`
    }
    return `single\u0000${String(target.STYLE || '')}\u0000${String(target.COLOR || '')}`
  }))
  return fingerprints.size === 1 ? targets[0] : null
}

/**
 * Match sales rows against the template and accumulate quantities.
 *
 * @param {Array}  templateRows  - parsed template CSV rows {STYLE, COLOR, SIZE}
 * @param {Array}  salesRows     - parsed sales CSV rows {style, color, size, QTY}
 * @param {Object} aliases       - human-confirmed overrides. A style+color rule
 *                                 reuses the current source size only when that
 *                                 exact target size exists in inventory.
 * @returns {{ filledRows, unmatchedRows, stats }}
 */
export function fillTemplate(templateRows, salesRows, aliases = {}) {
  // Build output entries in EXACT template row order. Buckets (keyed by normalized
  // style||size) hold REFERENCES to the same entry objects, so quantities accumulate
  // in place without disturbing order. Keys are normalized so LT366===Lt366, 1XL===1X,
  // M017-MISSY===M017Missy, etc.
  const entries = []
  const buckets = new Map()

  templateRows.forEach(r => {
    const style    = String(r.STYLE || r.style || '').trim()
    const size     = String(r.SIZE  || r.size  || '').trim()
    const color    = String(r.COLOR || r.color || '').trim()
    const normKey  = `${normalizeStyle(style)}||${normalizeSize(size)}`

    // Keep ORIGINAL style/color/size for output — must match what's stored in the DB
    const entry = { style, color, size, qty: 0 }
    entries.push(entry)
    if (!buckets.has(normKey)) buckets.set(normKey, [])
    buckets.get(normKey).push(entry)
  })

  let srcTotal    = 0
  let filledTotal = 0
  const unmatchedRows = []
  const matchLog      = []   // previously confirmed aliases used in this run

  salesRows.forEach(row => {
    const style    = String(row.style || row.STYLE || '').trim()
    const color    = String(row.color || row.COLOR || '').trim()
    const rawSize  = String(row.size  || row.SIZE  || '').trim()
    const rawQty   = row.QTY ?? row.qty ?? 0
    const qty      = Number(rawQty)

    if (!Number.isSafeInteger(qty) || qty < 0) {
      throw new Error(`Invalid quantity "${rawQty}" for ${style || 'unknown style'}. Use a whole number of units.`)
    }
    if (!qty) return
    const packCount = Math.max(1, parseInt(row.pack_count || row.packCount, 10) || 1)
    let parseIssue = String(row.parse_issue || row.parseIssue || '')
    if (!style) {
      srcTotal += qty * packCount
      unmatchedRows.push({ style, color, size: normalizeSize(rawSize), qty, packCount, parseIssue: parseIssue || 'missing_style' })
      return
    }
    // Consolidated rows already contain warehouse sizes. Petite conversion must
    // happen exactly once in consolidateRows, never again during matching.
    const normSize  = normalizeSize(rawSize)
    const routedStyle = routedInventoryStyle(style, normSize)
    if (routedStyle === null) {
      parseIssue = [...new Set([...parseIssue.split(';'), 'm022_size_unknown'].filter(Boolean))].join(';')
    }
    const matchStyle = routedStyle || style
    const normStyle = normalizeStyle(matchStyle)
    const key       = `${normStyle}||${normSize}`
    let candidates = buckets.get(key) || []
    const baseAliasKey = aliasKey(style, color)
    const savedSizeAlias = aliases[aliasKey(style, color, normSize)]
    const savedGeneralAlias = aliases[baseAliasKey]
    let aliasTarget = asConfirmedAlias(savedSizeAlias, true)
      || savedSizeAlias
      || asConfirmedAlias(savedGeneralAlias)
      || savedGeneralAlias
      || inferConfirmedStyleColorAlias(aliases, baseAliasKey)
    if (normalizeStyleIdentity(style) === 'm022' && routedStyle && aliasTarget?._confirmed && !Array.isArray(aliasTarget.components)) {
      aliasTarget = { ...aliasTarget, STYLE: routedStyle }
    }

    const confirmedStyleColorRule = aliasTarget?._confirmed === true
    const confirmedComboRule = confirmedStyleColorRule && Array.isArray(aliasTarget?.components)
    const effectivePackCount = confirmedComboRule
      ? aliasTarget.components.reduce((sum, component) =>
          sum + Math.max(1, parseInt(component.multiplier, 10) || 1), 0)
      : packCount
    srcTotal += qty * effectivePackCount

    // Unconfirmed legacy combos require review. A cross-style mapping can only
    // auto-apply when it came from a human-confirmed style+color rule.
    const aliasNeedsReview = (Array.isArray(aliasTarget?.components) && !confirmedComboRule)
      || (
        aliasTarget?.STYLE
        && normalizeStyleIdentity(aliasTarget.STYLE) !== normalizeStyleIdentity(style)
        && !confirmedStyleColorRule
    )
    if (aliasNeedsReview) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount: effectivePackCount, parseIssue: parseIssue || 'confirmed_mapping_requires_review' })
      return
    }

    // ── Learned alias ──────────────────────────────────────────────────────────
    // A confirmed style+color rule reuses the current source size. Target style,
    // color, and size still have to exist exactly in the current inventory.
    const target = typeof aliasTarget === 'string' ? { COLOR: aliasTarget } : aliasTarget
    const applyAliasTarget = (pool = []) => {
      const matchTarget = (wanted, items) => {
        const wantStyle = String(wanted.STYLE || '').trim()
        const wantColor = String(wanted.COLOR || '').trim()
        const wantSize = normalizeSize(wanted.SIZE || normSize)
        const matches = items.filter(c => {
          const styleOk = !wantStyle || normalizeStyleIdentity(c.style) === normalizeStyleIdentity(wantStyle)
          const colorOk = !wantColor || normalizeColor(c.color) === normalizeColor(wantColor)
          const sizeOk = !wantSize || normalizeSize(c.size) === wantSize
          return styleOk && colorOk && sizeOk
        })
        return matches.length === 1 ? matches[0] : null
      }

      if (confirmedComboRule) {
        const matches = target.components.map((component) =>
          matchTarget({
            STYLE: component.STYLE,
            COLOR: component.COLOR,
            SIZE: component.SIZE || normSize,
          }, entries)
        )
        if (matches.some((match) => !match)) return false

        for (const [index, matched] of matches.entries()) {
          const multiplier = Math.max(1, parseInt(target.components[index].multiplier, 10) || 1)
          const componentQty = qty * multiplier
          matched.qty += componentQty
          filledTotal += componentQty
          matchLog.push({
            style,
            salesColor: color,
            size: normSize,
            qty: componentQty,
            targetStyle: matched.style,
            targetColor: matched.color,
            targetSize: matched.size,
            via: 'confirmed combo',
          })
        }
        return true
      }

      let matched = matchTarget({
        STYLE: target.STYLE,
        COLOR: target.COLOR,
        SIZE: target.SIZE || normSize,
      }, pool)
      if (!matched && confirmedStyleColorRule && target.STYLE) {
        matched = matchTarget({
          STYLE: target.STYLE,
          COLOR: target.COLOR,
          SIZE: target.SIZE || normSize,
        }, entries)
      }
      if (matched) {
        matched.qty += qty
        filledTotal += qty
        matchLog.push({
          style,
          salesColor: color,
          size: normSize,
          qty,
          targetStyle: matched.style,
          targetColor: matched.color,
          targetSize: matched.size,
          via: 'confirmed',
        })
        return true
      }
      return false
    }

    // A confirmed combo resolves only the known set/combo uncertainty. Other
    // parsing warnings still require a fresh human decision.
    const comboResolvedIssue = confirmedComboRule
      && parseIssue
        .split(';')
        .filter(Boolean)
        .every((issue) => ['set_components_unknown', 'cross_style_combo', 'ambiguous_color_separator'].includes(issue))
    if (parseIssue && !comboResolvedIssue) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount: effectivePackCount, parseIssue })
      return
    }

    const hadLooseStyleCandidates = candidates.length > 0
    candidates = candidates.filter((candidate) =>
      normalizeStyleIdentity(candidate.style) === normalizeStyleIdentity(matchStyle)
    )

    if (!candidates?.length && target) {
      if (applyAliasTarget([])) return
      unmatchedRows.push({
        style,
        color,
        size: normSize,
        qty,
        packCount: effectivePackCount,
        parseIssue: target._isNew ? 'confirmed_new_target_missing' : 'confirmed_mapping_size_missing',
      })
      return
    }

    if (!candidates?.length) {
      unmatchedRows.push({
        style,
        color,
        size: normSize,
        qty,
        packCount: effectivePackCount,
        parseIssue: hadLooseStyleCandidates ? 'style_identity_mismatch' : parseIssue,
      })
      return
    }

    if (!aliasTarget && new Set(candidates.map((candidate) => candidate.style)).size > 1) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount: effectivePackCount, parseIssue: 'ambiguous_inventory_style' })
      return
    }

    if (aliasTarget) {
      if (applyAliasTarget(candidates)) return
      unmatchedRows.push({
        style,
        color,
        size: normSize,
        qty,
        packCount: effectivePackCount,
        parseIssue: target?._isNew ? 'confirmed_new_target_missing' : 'confirmed_mapping_size_missing',
      })
      return
    }

    // Fail closed if destructive cleanup would make two differently named
    // inventory colors share one exact identity.
    const exactIdentity = normalizeColor(color)
    const exactTargets = new Map(
      candidates
        .filter((candidate) => normalizeColor(candidate.color) === exactIdentity)
        .map((candidate) => [
          `${candidate.style}\u0000${candidate.color}\u0000${candidate.size}`,
          candidate,
        ]),
    )
    if (exactTargets.size > 1) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount, parseIssue: 'ambiguous_inventory_color' })
      return
    }

    // Score every candidate, keeping the best score per DISTINCT color (a color's
    // token-set signature, order-independent — so "faux suede black" and "black faux
    // suede" count as the same color, but "grey white" and "winter white" do not).
    const bySig = new Map()  // signature → { score, idx }
    candidates.forEach((c, i) => {
      const s   = colorScore(c.color, color)
      const sig = colorTokens(c.color).slice().sort().join('|')
      const cur = bySig.get(sig)
      if (!cur || s > cur.score) bySig.set(sig, { score: s, idx: i })
    })

    const ranked = [...bySig.values()].sort((a, b) => b.score - a.score)
    const passing = ranked.filter(x => x.score >= MATCH_THRESHOLD)

    // Decide:
    //   • nothing clears the bar                       → review (unmatched)
    //   • exactly one distinct color qualifies         → fill it
    //   • several qualify, but a UNIQUE exact (1.0)     → that exact match wins
    //   • several distinct colors tie below exact      → AMBIGUOUS → review, never guess
    let chosen = -1
    if (passing.length === 1) chosen = passing[0].idx

    if (chosen >= 0) {
      const matched = candidates[chosen]
      matched.qty += qty
      filledTotal += qty
      const chosenScore = passing.find(p => p.idx === chosen)?.score ?? 0
      matchLog.push({
        style,
        salesColor: color,
        size: normSize,
        qty,
        targetStyle: matched.style,
        targetColor: matched.color,
        targetSize: matched.size,
        via: chosenScore >= 0.999 ? 'exact' : `fuzzy ${chosenScore.toFixed(2)}`,
      })
    } else {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount, parseIssue })
    }
  })

  // Output in EXACT template row order. entries[] preserves it; iterating buckets
  // would regroup by style+size and scramble the order.
  const filledRows = entries.map(e => ({ STYLE: e.style, COLOR: e.color, SIZE: e.size, QTY: e.qty }))

  const appendTotal = unmatchedRows.reduce((s, r) => s + r.qty * (r.packCount || 1), 0)

  return {
    filledRows,
    unmatchedRows,
    matchLog,
    stats: {
      src_total:        srcTotal,
      filled_total:     filledTotal,
      append_total:     appendTotal,
      reconciled_total: filledTotal + appendTotal,
      has_unknown_unit_counts: unmatchedRows.some(r =>
        (/set_components_unknown/.test(r.parseIssue || '') && (r.packCount || 1) === 1) ||
        /cross_style_combo/.test(r.parseIssue || '')
      ),
    },
  }
}

// ── Excel export ──────────────────────────────────────────────────────────────

/** Generate and trigger download of a filled-inventory Excel file */
export async function generateExcel(filledRows, unmatchedRows = [], baseName = 'output') {
  const XLSX = await import('xlsx')

  const wb = XLSX.utils.book_new()

  // Sheet 1 — filled template in original template row order (preserves bucket insertion order)
  const ws1 = XLSX.utils.json_to_sheet(filledRows, { header: ['STYLE', 'COLOR', 'SIZE', 'QTY'] })
  XLSX.utils.book_append_sheet(wb, ws1, 'Filled Template')

  // Sheet 2 — unmatched sales rows (for review)
  if (unmatchedRows.length) {
    const ws2 = XLSX.utils.json_to_sheet(unmatchedRows, { header: ['style', 'color', 'size', 'qty'] })
    XLSX.utils.book_append_sheet(wb, ws2, 'Unmatched Sales')
  }

  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob  = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = `Detail_Inventory_filled_${baseName.replace(/\.csv$/i, '')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
