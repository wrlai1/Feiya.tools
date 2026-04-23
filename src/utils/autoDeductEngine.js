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

/** Normalize a color string for fuzzy comparison */
export function normalizeColor(s) {
  return String(s)
    .toLowerCase()
    .replace(/#\w+/g, '')        // remove color codes: #2, #1827, #0298
    .replace(/[^a-z\s]/g, ' ')  // non-alpha → space
    .replace(/\b[a-z]\b/g, '')  // remove single-letter words (l, m, w, g…)
    .replace(/\s+/g, '')         // collapse all spaces
    .trim()
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

// ── Color scoring ─────────────────────────────────────────────────────────────

/**
 * Score how well a sales color matches a template color (0–1).
 * 1.0 = exact, >0 = substring match, 0 = no match.
 * Prefers the match where more of the sales color is "explained."
 */
function colorScore(templateColor, salesColor) {
  const tc = normalizeColor(templateColor)
  const sc = normalizeColor(salesColor)
  if (!tc || !sc) return 0

  if (tc === sc) return 1.0                           // exact
  if (tc.includes(sc)) return sc.length / tc.length  // template contains sales (e.g. "blacktrmill" ⊃ "black")
  if (sc.includes(tc)) return tc.length / sc.length  // sales contains template
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
    let   candidates = buckets.get(key)

    // ── Style-prefix fallback ─────────────────────────────────────────────────
    // Handles cases where sales omits a suffix the template includes, e.g.:
    //   sales "80423" → template "80423W"  (or vice-versa)
    if (!candidates?.length) {
      for (const [bkey, bucket] of buckets.entries()) {
        const sep    = bkey.lastIndexOf('||')
        const bstyle = bkey.slice(0, sep)
        const bsize  = bkey.slice(sep + 2)
        if (bsize === normSize && bstyle !== normStyle &&
            (bstyle.startsWith(normStyle) || normStyle.startsWith(bstyle))) {
          candidates = bucket
          break
        }
      }
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
