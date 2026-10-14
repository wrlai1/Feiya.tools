import { normalizeOrders, normalizeSales } from './warehouseAlerts.js'

const REQUIRED = {
  orders: ['order_id', 'store_id', 'platform', 'order_date', 'ship_deadline', 'carrier', 'style', 'color', 'size', 'qty', 'order_status', 'shipment_status'],
  sales: ['date', 'style', 'color', 'size', 'sold_qty'],
}

// Strict RFC-style records: quoted commas/newlines and escaped quotes are supported.
// Reject malformed rows instead of silently shifting quantities into another column.
export function parseWarehouseCsv(source, kind) {
  if (!REQUIRED[kind]) throw new Error('Unsupported import type')
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const records = []
  let record = [], field = '', quoted = false, closed = false
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === undefined) throw new Error('CSV contains an unclosed quote')
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closed = true }
      } else field += ch
    } else if (ch === ',' || ch === '\n' || ch === undefined) {
      record.push(field.trim()); field = ''; closed = false
      if (ch !== ',') {
        if (record.some(value => value !== '')) records.push(record)
        record = []
      }
    } else if (ch === '"') {
      if (field !== '' || closed) throw new Error('Unexpected quote in CSV')
      quoted = true
    } else {
      if (closed) throw new Error('Unexpected characters after CSV quote')
      field += ch
    }
  }
  const headers = records.shift() || []
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique and non-empty')
  const missing = REQUIRED[kind].filter(field => !headers.includes(field))
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}`)
  const rows = records.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${values.length} columns; expected ${headers.length}`)
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]))
  })
  return kind === 'orders' ? normalizeOrders(rows) : normalizeSales(rows)
}

export function warehouseCsv(rows) {
  const fields = Object.keys(rows[0] || {})
  const quote = value => {
    const text = String(value ?? '')
    // Prevent spreadsheet formulas in identifiers/locations supplied by imports.
    const safe = typeof value === 'string' && /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }
  return [fields.map(quote).join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n')
}
