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

/** Normalize a size string */
export function normalizeSize(s) {
  return String(s).trim().toUpperCase().replace(/\s+/g, '')
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
  // Build per-(STYLE, SIZE) buckets so we only compare colors within the same style+size
  // Each bucket entry tracks accumulated qty
  const buckets = new Map()

  templateRows.forEach(r => {
    const style = String(r.STYLE || r.style || '').trim()
    const size  = normalizeSize(String(r.SIZE || r.size || ''))
    const color = String(r.COLOR || r.color || '').trim()
    const key   = `${style}||${size}`

    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ style, color, size, qty: 0 })
  })

  let srcTotal    = 0
  let filledTotal = 0
  const unmatchedRows = []

  salesRows.forEach(row => {
    const style = String(row.style || row.STYLE || '').trim()
    const color = String(row.color || row.COLOR || '').trim()
    const size  = normalizeSize(String(row.size || row.SIZE || ''))
    const qty   = parseInt(row.QTY || row.qty || 0, 10) || 0

    if (!style || !qty) return
    srcTotal += qty

    const key        = `${style}||${size}`
    const candidates = buckets.get(key)

    if (!candidates?.length) {
      unmatchedRows.push({ style, color, size, qty })
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
      unmatchedRows.push({ style, color, size, qty })
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
