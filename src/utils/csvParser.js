/**
 * Parse CSV text into an array of objects using the first row as headers.
 * Handles quoted fields (RFC 4180 compliant).
 */
export function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  if (lines.length === 0) return []

  // Parse a single CSV line respecting quotes
  function parseLine(line) {
    const fields = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }

    fields.push(current)
    return fields
  }

  // First non-empty line is the header
  const headerLine = lines.find((l) => l.trim() !== '')
  if (!headerLine) return []

  const headers = parseLine(headerLine).map((h) => h.trim())
  const headerLineIndex = lines.indexOf(headerLine)

  const rows = []
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const fields = parseLine(line)
    const obj = {}
    headers.forEach((h, idx) => {
      obj[h] = (fields[idx] || '').trim()
    })
    rows.push(obj)
  }

  return rows
}

export function normalizeTrackingRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const findKey = (row, candidates) => {
    const entries = Object.keys(row).map((key) => ({
      key,
      normalized: key.trim().toLowerCase().replace(/[^a-z0-9]/g, ''),
    }))
    const wanted = candidates.map((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, ''))
    return entries.find((entry) => wanted.includes(entry.normalized))?.key
      || entries.find((entry) => wanted.some((candidate) => entry.normalized.includes(candidate)))?.key
      || ''
  }

  const trackingKey = findKey(rows[0], ['Tracking', 'Tracking#', 'TrackingNo'])
  const skuKey = findKey(rows[0], ['SKU', 'Item', 'Product'])
  const qtyKey = findKey(rows[0], ['Quantity', 'Qty', 'Count'])
  const sizeKey = findKey(rows[0], ['Actual Size On TEMU', 'Actual Size', 'Size'])
  if (!trackingKey || !skuKey || !qtyKey) {
    throw new Error('Tracking file requires Tracking, SKU, and Quantity columns')
  }

  return rows.map((row, index) => {
    const tracking = String(row[trackingKey] || '').trim()
    const sku = String(row[skuKey] || '').trim()
    const rawQuantity = row[qtyKey]
    const quantity = Number(rawQuantity)
    if (!tracking || !sku) {
      throw new Error(`CSV row ${index + 2} requires both Tracking and SKU`)
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`CSV row ${index + 2} Quantity must be a positive whole number`)
    }
    return {
      tracking,
      sku,
      quantity,
      actualSize: String(row[sizeKey] || '').trim(),
      _raw: row,
    }
  })
}

/**
 * Parse tracking CSV file
 * Expected columns: Tracking, SKU, Quantity, Actual Size On TEMU
 */
export async function parseTrackingCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      try {
        const text = e.target.result
        const rows = parseCSV(text)

        if (rows.length === 0) {
          resolve([])
          return
        }

        resolve(normalizeTrackingRows(rows))
      } catch (err) {
        reject(new Error(`Failed to parse CSV file: ${err.message}`))
      }
    }

    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
