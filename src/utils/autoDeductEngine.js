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

// ── Color scoring ─────────────────────────────────────────────────────────────

// MATCH_THRESHOLD: minimum colorScore to accept a match.
// Anything below this goes to the Unmatched Sales sheet.
// 0.9 means only exact normalized matches and very-near-miss spelling variants
// (LCS ratio ≥ 0.85 on normalized strings) are accepted.
// The old token-level fuzzy fallback (max 0.45) is intentionally removed —
// it was causing false positives where wrong colors got sales quantities.
const MATCH_THRESHOLD = 0.9

/**
 * Score how well a sales color matches a template color (0 or 0.9–1.0).
 *
 * Tiers (in order):
 *   1. Exact normalized string match              → 1.0
 *   2. One normalized string contains the other  → proportional (0–1)
 *      Only passes MATCH_THRESHOLD when coverage ≥ 90%.
 *   3. Normalized-string LCS near-miss            → 0.9
 *      Catches spelling variants: fuchsia/fuschia, med denim/medium denim.
 *      Requires LCS / min(len) ≥ 0.85 on the fully-normalized strings.
 *   4. Everything else                            → 0 (→ unmatched)
 *
 * If you need a new color alias (e.g. a sales abbreviation that never
 * matches), add it to COLOR_ALIASES at the top of this file.
 */
function colorScore(templateColor, salesColor) {
  const tc = normalizeColor(templateColor)
  const sc = normalizeColor(salesColor)
  if (!tc || !sc) return 0

  if (tc === sc) return 1.0                           // exact
  if (tc.includes(sc)) return sc.length / tc.length  // template ⊃ sales
  if (sc.includes(tc)) return tc.length / sc.length  // sales ⊃ template

  // Normalized-string LCS — catches fuchsia/fuschia, med denim/medium denim, etc.
  // Returns exactly 0.9 so it clears MATCH_THRESHOLD without over-confidence.
  const minNorm = Math.min(tc.length, sc.length)
  if (minNorm >= 4) {
    const normRatio = lcsLength(tc, sc) / minNorm
    if (normRatio >= 0.85) return 0.9
  }

  return 0  // no match confident enough → will go to Unmatched Sales
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

/**
 * Match sales rows against the template and accumulate quantities.
 *
 * @param {Array}  templateRows  - parsed template CSV rows {STYLE, COLOR, SIZE}
 * @param {Array}  salesRows     - parsed sales CSV rows {style, color, size, QTY}
 * @returns {{ filledRows, unmatchedRows, stats }}
 */
export function fillTemplate(templateRows, salesRows) {
  // Build per-(normalizedStyle, normalizedSize) buckets.
  // Keys are normalized so that LT366===Lt366, 1XL===1X, M017-MISSY===M017Missy, etc.
  // Bucket entries keep the ORIGINAL template values for output.
  const buckets = new Map()

  // entries[] preserves the exact template row order — this drives the Excel output order.
  // buckets[] holds references to the same objects so qty accumulates in-place.
  const entries = []

  templateRows.forEach(r => {
    const style    = String(r.STYLE || r.style || '').trim()
    const size     = String(r.SIZE  || r.size  || '').trim()
    const color    = String(r.COLOR || r.color || '').trim()
    if (!style || !color || !size) return
    const normKey  = `${normalizeStyle(style)}||${normalizeSize(size)}`
    const entry    = { style, color, size, qty: 0 }
    entries.push(entry)
    if (!buckets.has(normKey)) buckets.set(normKey, [])
    buckets.get(normKey).push(entry)
  })

  let srcTotal    = 0
  let filledTotal = 0
  const unmatchedRows = []

  salesRows.forEach(row => {
    const style    = String(row.style || row.STYLE || '').trim()
    const color    = String(row.color || row.COLOR || '').trim()
    const rawSize  = String(row.size  || row.SIZE  || '').trim()
    const qty      = parseInt(row.QTY || row.qty || 0, 10) || 0

    if (!style || !qty) return
    srcTotal += qty

    const normStyle = normalizeStyle(style)
    const normSize  = normalizeSize(rawSize)
    const key       = `${normStyle}||${normSize}`
    let candidates = buckets.get(key) || []

    // ── Style-prefix fallback — only when NO exact bucket match ─────────────
    // Sales CSVs use a shorter style code that is a prefix of the full template
    // style name. Size disambiguates which variant to route to:
    //   "M022" + S/M/L/XL → "M022 Missy"   (bstyle m022missy startsWith m022)
    //   "M022" + 1X/2X/3X → "M022 PLUS"    (bstyle m022plus  startsWith m022)
    //   "M022" + PS/PM/PL  → "M022 Petite"  (bstyle m022petite startsWith m022)
    //   "M017" + S/M/L/XL → "M017-MISSY"   (bstyle m017missy startsWith m017)
    //   "80423" + any      → "80423W"       (bstyle 80423w    startsWith 80423)
    //
    // Guard: sales style must be ≥ 4 chars to avoid single/two-char false matches.
    if (!candidates.length) {
      const prefixCandidates = []
      for (const [bkey, bucket] of buckets.entries()) {
        const sep    = bkey.lastIndexOf('||')
        const bstyle = bkey.slice(0, sep)
        const bsize  = bkey.slice(sep + 2)
        if (bsize !== normSize || bstyle === normStyle) continue
        if (normStyle.length < 4) continue
        if (bstyle.startsWith(normStyle)) {
          prefixCandidates.push(...bucket)
        }
      }
      if (prefixCandidates.length) candidates = prefixCandidates
    }

    if (!candidates?.length) {
      unmatchedRows.push({ style, color, size: normSize, qty })
      return
    }

    // Find the template row whose color best matches the sales color
    let bestScore = 0
    let bestIdx   = -1
    candidates.forEach((c, i) => {
      const s = colorScore(c.color, color)
      if (s > bestScore) { bestScore = s; bestIdx = i }
    })

    if (bestIdx >= 0 && bestScore >= MATCH_THRESHOLD) {
      candidates[bestIdx].qty += qty
      filledTotal += qty
    } else {
      unmatchedRows.push({ style, color, size: normSize, qty })
    }
  })

  // Output in exact template order by iterating entries[], not buckets.
  // Iterating buckets would group by (style+size), scrambling color-first templates.
  const filledRows = entries.map(e => ({ STYLE: e.style, COLOR: e.color, SIZE: e.size, QTY: e.qty }))

  const appendTotal = unmatchedRows.reduce((s, r) => s + r.qty, 0)

  return {
    filledRows,
    unmatchedRows,
    stats: {
      src_total:        srcTotal,
      filled_total:     filledTotal,
      append_total:     appendTotal,
      reconciled_total: filledTotal + appendTotal,
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
