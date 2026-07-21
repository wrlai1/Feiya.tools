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

/** Normalize a color string for fuzzy comparison */
export function normalizeColor(s) {
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

/** TEMU petite labels are one step larger than the warehouse labels. */
export function normalizeSalesSize(s) {
  const normalized = normalizeSize(s)
  return ({ PS: 'PS', PM: 'PS', PL: 'PM', PXL: 'PL' })[normalized] || normalized
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
    .replace(/#\s*\d+/g, ' ')    // remove numeric codes
    .replace(/[^a-z\s]/g, ' ')  // non-alpha → space
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
  const exact = (value) => String(value)
    .toLowerCase()
    .replace(/#\s*\d+/g, '')
    .replace(/[^a-z]/g, '')
  const exactTemplate = exact(templateColor)
  const exactSales = exact(salesColor)
  const tc = normalizeColor(templateColor)
  const sc = normalizeColor(salesColor)
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
  const base = `${normalizeStyle(style)}::${normalizeColor(salesColor)}`
  const normSize = normalizeSalesSize(size)
  return normSize ? `${base}::${normSize}` : base
}

/**
 * Match sales rows against the template and accumulate quantities.
 *
 * @param {Array}  templateRows  - parsed template CSV rows {STYLE, COLOR, SIZE}
 * @param {Array}  salesRows     - parsed sales CSV rows {style, color, size, QTY}
 * @param {Object} aliases       - learned style-scoped overrides, keyed by aliasKey():
 *                                 { "<normStyle>::<normSalesColor>": "<template COLOR>" }.
 *                                 A hit forces the row to that template color, skipping
 *                                 fuzzy scoring entirely. Style-scoped on purpose — "mid"
 *                                 means MID DENIM for one style, MEDIUM for another.
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
    const qty      = parseInt(row.QTY || row.qty || 0, 10) || 0

    if (!qty) return
    const packCount = Math.max(1, parseInt(row.pack_count || row.packCount, 10) || 1)
    const parseIssue = String(row.parse_issue || row.parseIssue || '')
    if (!style) {
      srcTotal += qty * packCount
      unmatchedRows.push({ style, color, size: normalizeSalesSize(rawSize), qty, packCount, parseIssue: parseIssue || 'missing_style' })
      return
    }
    const normStyle = normalizeStyle(style)
    const normSize  = normalizeSalesSize(rawSize)
    const key       = `${normStyle}||${normSize}`
    let candidates = buckets.get(key) || []
    const aliasTarget = aliases[aliasKey(style, color, normSize)] || aliases[aliasKey(style, color)]
    const aliasComponentCount = Array.isArray(aliasTarget?.components)
      ? aliasTarget.components.reduce((sum, component) => sum + Math.max(1, parseInt(component.multiplier, 10) || 1), 0)
      : 0
    srcTotal += qty * (aliasComponentCount || packCount)

    // ── Learned alias — a previous human "Link" or "Combo" wins outright ────────
    // If the user has taught us what this (style, color) means, fill that template
    // color directly and skip fuzzy scoring. Combo aliases split one source row into
    // multiple template rows, each receiving the source quantity.
    const target = typeof aliasTarget === 'string' ? { COLOR: aliasTarget } : aliasTarget
    const applyAliasTarget = (pool = []) => {
      const matchTarget = (wanted, items) => {
        const wantStyle = normalizeStyle(wanted.STYLE || '')
        const wantColor = normalizeColor(wanted.COLOR || '')
        const wantSize = normalizeSize(wanted.SIZE || normSize)
        return items.find(c => {
          const styleOk = !wantStyle || normalizeStyle(c.style) === wantStyle
          const colorOk = !wantColor || normalizeColor(c.color) === wantColor
          const sizeOk = !wantSize || normalizeSize(c.size) === wantSize
          return styleOk && colorOk && sizeOk
        })
      }

      if (Array.isArray(target?.components) && target.components.length) {
        const matches = target.components.map(component => matchTarget(component, entries))
        if (matches.some(match => !match)) return false
        for (const [i, matched] of matches.entries()) {
          const multiplier = Math.max(1, parseInt(target.components[i].multiplier, 10) || 1)
          matched.qty += qty * multiplier
        }
        filledTotal += qty * target.components.reduce((sum, component) => sum + Math.max(1, parseInt(component.multiplier, 10) || 1), 0)
        matchLog.push({
          style,
          salesColor: color,
          size: normSize,
          qty,
          matchedTo: target.components.map(c => `${c.STYLE}/${c.COLOR}/${c.SIZE}`).join(' + '),
          via: 'alias combo',
        })
        return true
      }

      const wantStyle = normalizeStyle(target.STYLE || '')
      const wantColor = normalizeColor(target.COLOR || '')
      const wantSize = normalizeSize(target.SIZE || normSize)
      const matchIn = (items) => matchTarget({ STYLE: wantStyle, COLOR: wantColor, SIZE: wantSize }, items)
      const matched = matchIn(pool) || (wantStyle ? matchIn(entries) : null)
      if (matched) {
        matched.qty += qty
        filledTotal += qty
        matchLog.push({ style, salesColor: color, size: normSize, qty, matchedTo: matched.color, via: 'alias' })
        return true
      }
      if (target._isNew && target.STYLE && target.COLOR) {
        entries.push({ style: target.STYLE, color: target.COLOR, size: target.SIZE || normSize, qty })
        filledTotal += qty
        matchLog.push({ style, salesColor: color, size: normSize, qty, matchedTo: target.COLOR, via: 'alias new' })
        return true
      }
      return false
    }

    if (!candidates?.length && target) {
      if (applyAliasTarget([])) return
    }

    if (parseIssue && !aliasTarget) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount, parseIssue })
      return
    }

    if (!candidates?.length) {
      unmatchedRows.push({ style, color, size: normSize, qty, packCount, parseIssue })
      return
    }

    if (aliasTarget) {
      if (applyAliasTarget(candidates)) return
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
      candidates[chosen].qty += qty
      filledTotal += qty
      const chosenScore = passing.find(p => p.idx === chosen)?.score ?? 0
      if (chosenScore < 0.999) {
        matchLog.push({ style, salesColor: color, size: normSize, qty, matchedTo: candidates[chosen].color, via: `fuzzy ${chosenScore.toFixed(2)}` })
      }
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
