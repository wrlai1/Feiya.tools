import * as XLSX from 'xlsx'

/**
 * Parse the main inventory Excel file (主库存表.xlsx)
 * Header row is at index 3 (row 4 in Excel, 0-indexed as 3)
 * Expected columns: Style#, Color, Size Break, Quantity, Location
 */
export async function parseInventoryExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array' })

        // Use the first sheet
        const sheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[sheetName]

        // Parse with header row at index 3 (0-based)
        const rawRows = XLSX.utils.sheet_to_json(worksheet, {
          range: 3,
          defval: '',
          raw: false,
        })

        // Normalize column names (case-insensitive matching)
        const normalized = rawRows.map((row) => {
          const keys = Object.keys(row)
          const findKey = (candidates) =>
            keys.find((k) =>
              candidates.some((c) => k.toLowerCase().includes(c.toLowerCase()))
            ) || ''

          const styleKey = findKey(['Style#', 'Style #', 'Style', 'SKU', 'Item'])
          const colorKey = findKey(['Color', 'Colour'])
          const sizeKey = findKey(['Size Break', 'Size', 'Break'])
          const qtyKey = findKey(['Quantity', 'Qty', 'QTY', 'Count', 'Amount'])
          const locKey = findKey(['Location', 'Loc', 'Warehouse', 'Place'])

          const qty = parseFloat(row[qtyKey]) || 0

          return {
            style: row[styleKey] || '',
            color: row[colorKey] || '',
            sizeBreak: row[sizeKey] || '',
            quantity: qty,
            location: row[locKey] || '',
            _raw: row,
          }
        })

        // Filter out completely empty rows
        const filtered = normalized.filter(
          (r) => r.style || r.color || r.sizeBreak || r.quantity
        )

        resolve(filtered)
      } catch (err) {
        reject(new Error(`Failed to parse Excel file: ${err.message}`))
      }
    }

    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Convert inventory data array to CSV string
 */
export function inventoryToCSV(data) {
  if (!data || data.length === 0) return ''

  const headers = ['Style#', 'Color', 'Size Break', 'Quantity', 'Location']
  const rows = data.map((r) =>
    [r.style, r.color, r.sizeBreak, r.quantity, r.location]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  )

  return [headers.join(','), ...rows].join('\n')
}

/**
 * Trigger CSV download in the browser
 */
export function downloadCSV(csvString, filename = 'inventory.csv') {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
