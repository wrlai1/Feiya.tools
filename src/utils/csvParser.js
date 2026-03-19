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

        // Normalize column names
        const sampleKeys = Object.keys(rows[0])

        const findKey = (row, candidates) =>
          Object.keys(row).find((k) =>
            candidates.some((c) => k.toLowerCase().includes(c.toLowerCase()))
          ) || ''

        const trackingKey = findKey(rows[0], ['Tracking', 'Track', 'Tracking#', 'TrackingNo'])
        const skuKey = findKey(rows[0], ['SKU', 'Sku', 'Item', 'Product'])
        const qtyKey = findKey(rows[0], ['Quantity', 'Qty', 'QTY', 'Count'])
        const sizeKey = findKey(rows[0], ['Actual Size', 'Size', 'TEMU', 'Actual'])

        const normalized = rows.map((row) => ({
          tracking: row[trackingKey] || '',
          sku: row[skuKey] || '',
          quantity: parseInt(row[qtyKey], 10) || 0,
          actualSize: row[sizeKey] || '',
          _raw: row,
        }))

        resolve(normalized.filter((r) => r.tracking || r.sku))
      } catch (err) {
        reject(new Error(`Failed to parse CSV file: ${err.message}`))
      }
    }

    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
