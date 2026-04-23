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

/**
 * Split a raw color string into meaningful tokens (2+ chars) for fuzzy matching.
 * Works on the original string BEFORE space-collapsing so "med denim" → ["med","denim"],
 * and handles short abbreviations like "bk" (black) or "nvy" (navy).
 */
function colorTokens(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/#\s*\d+/g, '')     // remove numeric codes
    .replace(/[^a-z\s]/g, ' ')  // non-alpha → space
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2) // keep 2+ char tokens (catches "bk", "nv" etc.)
}

// ── Color scoring ─────────────────────────────────────────────────────────────

/**
 * Score how well a sales color matches a template color (0–1).
 *
 * Priority order:
 *   1. Exact normalized string match              → 1.0
 *   2. One normalized string contains the other  → proportional score
 *   3. Token-level LCS fuzzy fallback             → ≤ 0.45
 *      (handles typos: fuchsia/fuschia, peapock/peacock, demim/denim,
 *       and abbreviations: "med denim" → "medium denim")
 */
function colorScore(templateColor, salesColor) {
  const tc = normalizeColor(templateColor)
  const sc = normalizeColor(salesColor)
  if (!tc || !sc) return 0

  if (tc === sc) return 1.0                           // exact
  if (tc.includes(sc)) return sc.length / tc.length  // template ⊃ sales
  if (sc.includes(tc)) return tc.length / sc.length  // sales ⊃ template

  // ── Normalized-string LCS (catches fuchsia/fuschia, alias near-misses) ────
  // Compare the fully-normalized (and alias-resolved) strings directly.
  // Threshold 0.85 avoids false positives between short color words (wine/vine, etc.)
  const minNorm = Math.min(tc.length, sc.length)
  if (minNorm >= 4) {
    const normRatio = lcsLength(tc, sc) / minNorm
    if (normRatio >= 0.85) return normRatio * 0.9   // near-match on normalized form
  }

  // ── Token-level fuzzy fallback ────────────────────────────────────────────
  // Split original strings into words, then compare word-pairs with LCS ratio.
  // A sales token matches a template token if LCS / min(lengths) ≥ 0.80.
  const ttks = colorTokens(templateColor)
  const stks = colorTokens(salesColor)
  if (!ttks.length || !stks.length) return 0

  let matched = 0
  for (const st of stks) {
    for (const tt of ttks) {
      const minLen = Math.min(st.length, tt.length)
      if (minLen < 2) continue
      // Short tokens (≤3 chars) are abbreviations — use a more lenient threshold
      const threshold = minLen <= 3 ? 0.65 : 0.80
      if (lcsLength(st, tt) / minLen >= threshold) { matched++; break }
    }
  }

  // Require at least half the sales tokens to find a fuzzy match
  return (matched > 0 && matched / stks.length >= 0.5)
    ? (matched / stks.length) * 0.45
    : 0
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

  templateRows.forEach(r => {
    const style    = String(r.STYLE || r.style || '').trim()
    const size     = String(r.SIZE  || r.size  || '').trim()
    const color    = String(r.COLOR || r.color || '').trim()
    const normKey  = `${normalizeStyle(style)}||${normalizeSize(size)}`

    if (!buckets.has(normKey)) buckets.set(normKey, [])
    // Keep ORIGINAL style/color/size for output — must match what's stored in the DB
    buckets.get(normKey).push({ style, color, size, qty: 0 })
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

    // ── Style-prefix / suffix / extension fallback ────────────────────────────
    // Handles size-based style routing:
    //   "M022" + L   → "M022 Missy"   (normalizes to m022missy, startsWith m022)
    //   "M022" + 1X  → "M022 PLUS"    (normalizes to m022plus,  startsWith m022)
    //   "M017" + L   → "M017-MISSY"   (normalizes to m017missy, startsWith m017)
    //   "5010130" + L → "CK101/5010130" (normalizes to ck1015010130, endsWith 5010130)
    //   "80423"  + 1X → "80423W"      (normalizes to 80423w,    startsWith 80423)
    const prefixCandidates = []
    for (const [bkey, bucket] of buckets.entries()) {
      const sep    = bkey.lastIndexOf('||')
      const bstyle = bkey.slice(0, sep)
      const bsize  = bkey.slice(sep + 2)
      if (bsize === normSize && bstyle !== normStyle &&
          (bstyle.startsWith(normStyle) || normStyle.startsWith(bstyle) || bstyle.endsWith(normStyle))) {
        prefixCandidates.push(...bucket)
      }
    }
    // Prefer prefix candidates if any have a color match (more specific style wins).
    // Fall back to exact bucket if prefix candidates have no color match at all.
    if (prefixCandidates.length > 0) {
      const hasMatch = prefixCandidates.some(c => colorScore(c.color, color) > 0)
      if (hasMatch || !candidates.length) candidates = prefixCandidates
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

    if (bestIdx >= 0 && bestScore > 0) {
      candidates[bestIdx].qty += qty
      filledTotal += qty
    } else {
      unmatchedRows.push({ style, color, size: normSize, qty })
    }
  })

  // Flatten buckets back into output rows
  const filledRows = []
  for (const bucket of buckets.values()) {
    for (const entry of bucket) {
      filledRows.push({ STYLE: entry.style, COLOR: entry.color, SIZE: entry.size, QTY: entry.qty })
    }
  }

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

  // Sheet 1 — filled template (all rows, sorted by STYLE)
  const sorted = [...filledRows].sort((a, b) =>
    String(a.STYLE).localeCompare(String(b.STYLE), undefined, { numeric: true })
  )
  const ws1 = XLSX.utils.json_to_sheet(sorted, { header: ['STYLE', 'COLOR', 'SIZE', 'QTY'] })
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
