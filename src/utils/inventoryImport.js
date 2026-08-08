function inventoryQuantity(value, rowNumber) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`Row ${rowNumber}: Quantity is required`)
  const normalized = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text
  const quantity = Number(normalized)
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error(`Row ${rowNumber}: Quantity must be a whole number of 0 or more`)
  }
  return quantity
}

export function inventoryImportKey(row) {
  const style = String(row.Style ?? row.style ?? row.STYLE ?? '').trim().toLocaleLowerCase()
    .replace(/\s+/g, ' ')
  const color = String(row.Color ?? row.color ?? row.COLOR ?? '').trim().toLocaleLowerCase()
    .replace(/\s+/g, ' ')
  const size = String(row.Size ?? row.size ?? row.SIZE ?? '').trim().toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^([123])XL$/, '$1X')
  return `${style}\u241f${color}\u241f${size}`
}

export function normalizeInventoryImportRows(inputRows) {
  if (!Array.isArray(inputRows) || !inputRows.length) throw new Error('The inventory file is empty')
  const rows = []
  const seen = new Map()

  for (const [index, raw] of inputRows.entries()) {
    const rowNumber = index + 2
    const Style = String(raw.Style ?? raw.style ?? raw.STYLE ?? '').trim()
    const Color = String(raw.Color ?? raw.color ?? raw.COLOR ?? '').trim()
    const Size = String(raw.Size ?? raw.size ?? raw.SIZE ?? '').trim()
    if (!Style || !Color || !Size) {
      throw new Error(`Row ${rowNumber}: Style, Color, and Size are all required`)
    }
    const Quantity = inventoryQuantity(
      raw.Quantity ?? raw.quantity ?? raw.QUANTITY,
      rowNumber,
    )
    const key = inventoryImportKey({ Style, Color, Size })
    if (seen.has(key)) {
      throw new Error(`Rows ${seen.get(key)} and ${rowNumber} contain the same inventory SKU`)
    }
    seen.set(key, rowNumber)
    rows.push({ Style, Color, Size, Quantity, SortOrder: index })
  }

  return {
    rows,
    totalUnits: rows.reduce((sum, row) => sum + row.Quantity, 0),
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

export function inventoryRowsToCsv(rows) {
  const header = ['Style', 'Color', 'Size', 'Quantity'].map(csvCell).join(',')
  const body = (rows || []).map((row) => [
    row.Style ?? row.style,
    row.Color ?? row.color,
    row.Size ?? row.size,
    row.Quantity ?? row.quantity,
  ].map(csvCell).join(','))
  return `\uFEFF${[header, ...body].join('\r\n')}`
}
