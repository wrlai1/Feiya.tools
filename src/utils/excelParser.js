import * as XLSX from 'xlsx'

const STANDARD_FIELDS = [
  'rack', 'style', 'color', 'box', 'qty', 'fabric', 'label',
  'sizes', 'ratio', 'company', 'remark', 'customer',
]

const text = (value) => {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).trim()
}

export const parseInventoryNumber = (value, context = '') => {
  if (value === '' || value == null) return 0
  const parsed = Number(String(value).replace(/,/g, ''))
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${context ? `${context}: ` : ''}Boxes and Quantity must be whole numbers of 0 or more`)
  }
  return parsed
}

const summaryNumber = (value) => {
  try { return parseInventoryNumber(value) } catch { return 0 }
}

const headerKey = (value) => text(value).toLowerCase().replace(/[\s.#_-]+/g, '')

function findHeader(rows, required) {
  return rows.findIndex((row) => {
    const keys = row.map(headerKey)
    return required.every((name) => keys.includes(name))
  })
}

function standardRows(sheetName, rows) {
  let headerIndex = findHeader(rows, ['rack', 'style'])
  let start = headerIndex + 1
  let columns

  if (headerIndex >= 0) {
    const headers = rows[headerIndex].map(headerKey)
    const find = (...names) => headers.findIndex((key) => names.includes(key))
    const sizeIndex = find('sizebreakdown', 'sizebreak', 'sizes')
    columns = {
      rack: find('rack', 'rackno', 'location'),
      style: find('style', 'styleno'),
      color: find('color', 'colour'),
      box: find('box', 'boxes'),
      qty: find('qty', 'quantity', 'pcs'),
      fabric: find('fabric', 'fabricno'),
      label: find('label'),
      sizes: sizeIndex,
      ratio: sizeIndex >= 0 ? sizeIndex + 1 : -1,
      company: find('company'),
      remark: find('remark', 'remarks'),
      customer: find('customer'),
    }
  } else {
    // Sheet1 is an intentionally headerless holding sheet in the weekly workbook.
    headerIndex = -1
    start = 0
    columns = Object.fromEntries(STANDARD_FIELDS.map((field, index) => [field, index]))
  }

  const parsed = rows.slice(start).map((row, offset) => {
    const get = (field) => columns[field] >= 0 ? row[columns[field]] : ''
    return {
      id: `${sheetName}-${start + offset + 1}`,
      sheet: sheetName,
      rowNumber: start + offset + 1,
      kind: 'inventory',
      rack: text(get('rack')),
      style: text(get('style')),
      color: text(get('color')),
      box: parseInventoryNumber(get('box'), `${sheetName} row ${start + offset + 1}, Boxes`),
      qty: parseInventoryNumber(get('qty'), `${sheetName} row ${start + offset + 1}, Quantity`),
      fabric: text(get('fabric')),
      label: text(get('label')),
      sizes: text(get('sizes')),
      ratio: text(get('ratio')),
      company: text(get('company')),
      remark: text(get('remark')),
      customer: text(get('customer')),
    }
  }).filter((row) => row.style || row.color || row.box || row.qty || row.fabric || row.remark || row.customer)

  // Location Final has an authoritative totals row above its headers.
  if (headerIndex > 0 && parsed.length) {
    const summary = rows.slice(0, headerIndex).reverse().find((row) => summaryNumber(row[columns.box]) || summaryNumber(row[columns.qty]))
    if (summary) {
      parsed[0].sheetBoxTotal = summaryNumber(summary[columns.box])
      parsed[0].sheetQtyTotal = summaryNumber(summary[columns.qty])
    }
  }
  return parsed
}

function pendingRows(sheetName, rows) {
  const headerIndex = findHeader(rows, ['po', 'style'])
  if (headerIndex < 0) return []
  const headers = rows[headerIndex].map(headerKey)
  const find = (...names) => headers.findIndex((key) => names.includes(key))
  const columns = {
    po: find('po', 'pono'), style: find('style', 'styleno'), pallet: find('pallet'),
    box: find('box', 'boxes'), qty: find('pcs', 'qty', 'quantity'),
    startDate: find('startdate'), cancelDate: find('canceldate'), customer: find('customer'),
    remark: find('remark', 'remarks'),
  }

  return rows.slice(headerIndex + 1).map((row, offset) => {
    const get = (field) => columns[field] >= 0 ? row[columns[field]] : ''
    const known = new Set(Object.values(columns).filter((index) => index >= 0))
    const extras = row
      .map((value, index) => ({ index, value: text(value) }))
      .filter(({ index, value }) => value && !known.has(index))
      .map(({ value }) => value)
    return {
      id: `${sheetName}-${headerIndex + offset + 2}`,
      sheet: sheetName,
      rowNumber: headerIndex + offset + 2,
      kind: 'pending',
      po: text(get('po')),
      style: text(get('style')),
      pallet: text(get('pallet')),
      box: parseInventoryNumber(get('box'), `${sheetName} row ${headerIndex + offset + 2}, Boxes`),
      qty: parseInventoryNumber(get('qty'), `${sheetName} row ${headerIndex + offset + 2}, Quantity`),
      startDate: text(get('startDate')),
      cancelDate: text(get('cancelDate')),
      customer: text(get('customer')),
      remark: text(get('remark')),
      notes: extras.join(' · '),
    }
  }).filter((row) => row.po || row.style || row.box || row.qty || row.remark)
}

export function parseInventoryWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const rows = []

  workbook.SheetNames.forEach((sheetName) => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
      raw: true,
    })
    const parsed = headerKey(sheetName) === 'pendingshipment'
      ? pendingRows(sheetName, matrix)
      : standardRows(sheetName, matrix)
    rows.push(...parsed)
  })

  if (!rows.some((row) => headerKey(row.sheet) === 'locationfinal')) {
    throw new Error('Location Final was not found. Please upload the weekly master inventory workbook.')
  }
  return rows
}

export async function parseInventoryExcel(file) {
  try {
    return parseInventoryWorkbook(await file.arrayBuffer())
  } catch (error) {
    if (error.message?.includes('Location Final')) throw error
    throw new Error(`Unable to read the Excel file: ${error.message}`)
  }
}

export function inventoryToCSV(data) {
  if (!data?.length) return ''
  const fields = ['sheet', 'rack', 'po', 'style', 'color', 'box', 'qty', 'fabric', 'label', 'sizes', 'ratio', 'company', 'remark', 'customer', 'pallet', 'startDate', 'cancelDate', 'notes']
  const rows = data.map((row) => fields.map((field) => `"${String(row[field] ?? '').replace(/"/g, '""')}"`).join(','))
  return [fields.join(','), ...rows].join('\n')
}

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
