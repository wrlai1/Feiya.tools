const norm = (value) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
const styleKey = (style) => norm(style).replace(/[-_]/g, '')
const skuKey = (row) => [styleKey(row.style), String(row.color ?? '').trim().toUpperCase(), norm(row.size).replace(/^([1-5])XL$/, '$1X')].join('\u241f')
function dateDays(from, to) {
  const days = []
  for (let day = from; day && day <= to; day = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) days.push(day)
  return days
}
function normalizeMinimumRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('Upload 1–10000 Minimum rows')
  const seen = new Set()
  return rows.map((raw) => {
    const row = { style: String(raw.style ?? '').trim(), color: String(raw.color ?? '').trim(), size: String(raw.size ?? '').trim() }
    const value = raw.minimum ?? raw['minimum quantity']
    if (!row.style || !row.color || !row.size || !['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 2147483647) throw new Error('Each row needs style, color, size and a minimum quantity from 0 to 2147483647')
    row.minimum = Math.ceil(Number(value))
    row.key = skuKey(row)
    if (seen.has(row.key)) throw new Error(`Duplicate SKU: ${row.style} / ${row.color} / ${row.size}`)
    seen.add(row.key)
    return row
  })
}

function shipmentFileDay(filename, appliedDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedDay)) throw new Error('Shipment upload date is unavailable')
  const name = String(filename || '').split(/[\\/]/).at(-1).replace(/\.(xlsx?|csv|zip)$/i, '')
  const valid = (year, month, day) => {
    const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value ? value : null
  }
  const full = [...name.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})[-_.]?([01]\d)[-_.]?([0-3]\d)(?!\d)/g)]
  const candidates = full.length ? full.map((m) => valid(m[1], m[2], m[3])) : [...name.matchAll(/(?:^|[^0-9])([01]\d)([0-3]\d)(?!\d)/g)].map((m) => {
    let year = Number(appliedDay.slice(0, 4))
    if (appliedDay.slice(5, 7) === '01' && m[1] === '12') year--
    return valid(year, m[1], m[2])
  })
  const days = [...new Set(candidates.filter(Boolean))]
  if (days.length > 1) throw new Error(`Multiple shipment dates in filename: ${name}`)
  return days[0] || appliedDay
}

function buildLedger({ inventory = [], history = [], overrides = [], styles = [], source = { cutoff: '', rows: [], notes: [] }, reportDate }) {
  const validDate = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day
  if (!validDate(reportDate)) throw new Error('A valid report date is required')
  const selected = new Set(styles.map(styleKey))
  const included = (row) => !selected.size || selected.has(styleKey(row.style))
  const entries = new Map()
  for (const row of source.rows.filter(included)) {
    const key = skuKey(row)
    if (entries.has(key)) throw new Error(`Duplicate starting SKU: ${row.style} / ${row.color} / ${row.size}`)
    entries.set(key, { ...row, in: { ...row.in }, out: { ...row.out }, returns: {}, adjustments: {}, quantity: null, minimum: null })
  }
  for (const row of inventory.filter(included)) {
    if (!row.style || !row.color || !row.size || !Number.isSafeInteger(Number(row.quantity))) throw new Error('Inventory contains an invalid SKU or quantity')
    // Style spelling may differ by spaces/hyphens in the old export.
    const key = skuKey(row)
    const alias = [...entries.keys()].find((candidate) => {
      const item = entries.get(candidate)
      return styleKey(item.style) === styleKey(row.style) && skuKey({ ...item, style: row.style }) === key
    })
    const existing = entries.get(alias || key)
    if (existing?.quantity != null) {
      // Case/plus-size aliases refer to the same reporting SKU. Sum their
      // existing stock; this never merges or changes physical inventory rows.
      existing.quantity += Number(row.quantity)
      continue
    }
    if (alias && alias !== key) entries.delete(alias)
    entries.set(key, { ...(existing || { in: {}, out: {}, returns: {}, adjustments: {} }), ...row, quantity: Number(row.quantity), baselineBalance: existing?.balance ?? null, seeded: Boolean(existing) })
  }
  const coverage = { sales: '', returns: '', in: '' }
  const add = (map, date, value) => { map[date] = Number(map[date] || 0) + value }
  for (const row of history.filter(included)) {
    const day = String(row.day).slice(0, 10)
    if (!validDate(day) || !Number.isSafeInteger(Number(row.qty)) || !['sales', 'return', 'in', 'adjustment', 'substitution', 'substitution_undo'].includes(row.txn_type)
      || (['sales', 'return', 'in'].includes(row.txn_type) && Number(row.qty) < 0)) throw new Error(`Invalid inventory movement: ${row.style} / ${row.color} / ${row.size}`)
    if (day > reportDate) continue
    const key = skuKey(row)
    if (!entries.has(key)) entries.set(key, { ...row, in: {}, out: {}, returns: {}, adjustments: {}, quantity: null, minimum: null })
    const item = entries.get(key)
    const type = row.txn_type
    if (type === 'sales') coverage.sales = day > coverage.sales ? day : coverage.sales
    if (type === 'return') coverage.returns = day > coverage.returns ? day : coverage.returns
    if (type === 'return' || type === 'in') coverage.in = day > coverage.in ? day : coverage.in
    // Starting export already includes movements through its cutoff. A later
    // confirmation with an earlier business date is a new movement, not a replay.
    const appliedDay = String(row.applied_day || day).slice(0, 10)
    const seeded = source.rows.some((seed) => styleKey(seed.style) === styleKey(row.style) && skuKey({ ...seed, style: row.style }) === key)
    const qty = Number(row.qty)
    if (seeded && day <= source.cutoff && appliedDay <= source.cutoff) {
      // Existing confirmed returns are already inside the baseline IN; expose
      // their actual dates without adding them to inventory a second time.
      if (type === 'return') add(item.returns, day, qty)
      continue
    }
    if (type === 'sales') add(item.out, day, qty)
    else if (type === 'return' || type === 'in') {
      add(item.in, day, qty)
      if (type === 'return') add(item.returns, day, qty)
    } else {
      add(item.adjustments, day, qty)
      if (qty > 0) {
        add(item.in, day, qty)
        coverage.in = day > coverage.in ? day : coverage.in
      }
    }
  }
  const salesDay = coverage.sales > source.cutoff ? coverage.sales : source.cutoff
  const calculationDay = salesDay || reportDate
  const start21 = new Date(Date.parse(`${calculationDay}T12:00:00Z`) - 20 * 86400000).toISOString().slice(0, 10)
  const manual = new Map(overrides.map((row) => [row.sku_key || row.key || skuKey(row), Number(row.minimum)]))
  const rows = [...entries.values()].map((row) => {
    const sales21 = Object.entries(row.out).reduce((sum, [date, qty]) => sum + (date >= start21 && date <= calculationDay ? Number(qty) : 0), 0)
    const override = manual.get(skuKey(row))
    // average × the same 21 days simplifies to the total; avoid floating-point
    // noise turning a whole-piece total into one unnecessary extra piece.
    const minimum = override ?? Math.ceil(sales21)
    const quantity = row.quantity
    return { ...row, sales21, minimum, minimumMode: override == null ? 'Auto' : 'Manual', replenishment: quantity == null ? null : Math.max(0, minimum - quantity) }
  })
  return { rows, cutoff: source.cutoff, salesDay, calculationDay, reportDate, returnDay: coverage.returns, inDay: coverage.in, notes: source.notes || [] }
}

function addLedgerSheets(workbook, ledger, safeSheetName, usedNames) {
  const groups = new Map()
  for (const row of ledger.rows) {
    const style = row.style
    if (!groups.has(style)) groups.set(style, [])
    groups.get(style).push(row)
  }
  for (const [style, rows] of groups) {
    const sheet = workbook.addWorksheet(safeSheetName(style, usedNames), { views: [{ state: 'frozen', xSplit: 2, ySplit: 5 }] })
    const datesFor = (kind, cutoff) => {
      const dates = rows.flatMap((row) => Object.keys(row[kind]))
      return dates.length ? dateDays(dates.sort()[0], cutoff || dates.sort().at(-1)) : []
    }
    const lastIn = [ledger.cutoff, ledger.inDay].sort().at(-1)
    const inDates = datesFor('in', lastIn)
    const outDates = datesFor('out', ledger.salesDay)
    const columns = [{ title: 'Color', key: 'color' }, { title: 'Size', key: 'size' }]
    for (const [title, key, dates] of [['IN', 'in', inDates], ['OUT', 'out', outDates]]) {
      for (const day of dates) columns.push({ title, key, day })
      columns.push({ title: `${title} Total`, key, total: true })
    }
    columns.push({ title: 'Return Rate', key: 'returnRate' })
    columns.push({ title: 'Balance', key: 'quantity' }, { title: 'Minimum', key: 'minimum' }, { title: 'Replenishment', key: 'replenishment' }, { title: 'Minimum Mode', key: 'minimumMode' })
    if (columns.length > 16384) throw new Error('Ledger exceeds Excel column limit; archive required before export')
    const last = sheet.getColumn(columns.length).letter
    const titleEnd = sheet.getColumn(Math.min(16, columns.length)).letter
    sheet.mergeCells(`A1:${titleEnd}1`)
    sheet.getCell('A1').value = `${style} · Daily Inventory Ledger`
    sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }
    sheet.getRow(1).height = 28
    sheet.mergeCells(`A2:${titleEnd}2`)
    sheet.getCell('A2').value = `${ledger.cutoff ? `Starting export through ${ledger.cutoff} · ` : ''}OUT through ${ledger.salesDay || 'No confirmed shipments'} · Returns through ${ledger.returnDay || 'No confirmed returns'} · Balance: system stock as of ${ledger.reportDate}`
    sheet.mergeCells(`A3:${titleEnd}3`)
    sheet.getCell('A3').value = 'IN includes receipts, positive stock additions and confirmed restocked returns. Return Rate = all-history confirmed restocked returns / all-history OUT; receipts are excluded. No shipments = N/A. This is a period ratio, not an order-cohort rate. Balance is current system stock, not IN Total minus OUT Total. Minimum: last 21 calendar days shipments; missing days = 0. Blank dates = no confirmed record. Dates older than the latest 7 calendar days are collapsed; expand with +.'
    sheet.getCell('A3').alignment = { wrapText: true }
    sheet.getRow(3).height = 48
    columns.forEach((column, index) => {
      const cell = sheet.getCell(5, index + 1)
      cell.value = column.day ? new Date(`${column.day}T12:00:00Z`) : column.total ? 'Total' : column.title
      if (column.day) cell.numFmt = 'yyyy-mm-dd'
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column.key === 'in' || column.key === 'returns' ? 'FF0F766E' : 'FF1E3A8A' } }
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { wrapText: true, horizontal: 'center' }
      sheet.getColumn(index + 1).width = index === 0 ? 28 : column.day ? 14 : 18
    })
    sheet.properties.outlineProperties = { summaryRight: true }
    sheet.properties.outlineLevelCol = 1
    for (const key of ['in', 'out']) {
      const dates = columns.filter((column) => column.key === key && column.day).map((column) => column.day)
      if (!dates.length) continue
      const recentStart = new Date(Date.parse(`${dates.at(-1)}T12:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10)
      columns.forEach((column, index) => {
        if (column.key === key && column.day && column.day < recentStart) {
          sheet.getColumn(index + 1).outlineLevel = 1
          sheet.getColumn(index + 1).hidden = true
        }
      })
    }
    let groupStart = 0
    while (groupStart < columns.length) {
      const column = columns[groupStart]
      let groupEnd = groupStart
      while (groupEnd + 1 < columns.length && columns[groupEnd + 1].key === column.key) groupEnd++
      // Long date histories must leave the section label visible at the left
      // edge, rather than centering it dozens of columns off screen.
      for (let index = groupStart; index <= groupEnd; index++) {
        sheet.getCell(4, index + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ['in', 'returns'].includes(column.key) ? 'FF0F766E' : 'FF1E3A8A' } }
      }
      if (groupStart === groupEnd && !column.total) sheet.mergeCells(4, groupStart + 1, 5, groupStart + 1)
      const cell = sheet.getCell(4, groupStart + 1)
      cell.value = column.day || column.total ? column.title.replace(/ Total$/, '') : column.title
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ['in', 'returns'].includes(column.key) ? 'FF0F766E' : 'FF1E3A8A' } }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      groupStart = groupEnd + 1
    }
    sheet.getRow(4).height = 32
    sheet.getRow(5).height = 24
    rows.sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size, undefined, { numeric: true }))
    rows.forEach((item, index) => {
      const rowNumber = index + 6
      columns.forEach((column, columnIndex) => {
        const cell = sheet.getCell(rowNumber, columnIndex + 1)
        if (column.day) cell.value = item[column.key][column.day] ?? null
        else if (column.total) {
          const start = columns.findIndex((col) => col.key === column.key && col.day)
          const total = Object.values(item[column.key]).reduce((sum, value) => sum + Number(value), 0)
          cell.value = start < 0 ? 0 : { formula: `SUM(${sheet.getColumn(start + 1).letter}${rowNumber}:${sheet.getColumn(columnIndex).letter}${rowNumber})`, result: total }
        } else if (column.key === 'returnRate') {
          const shipped = Object.values(item.out).reduce((sum, value) => sum + Number(value), 0)
          const returned = Object.values(item.returns).reduce((sum, value) => sum + Number(value), 0)
          const outTotal = sheet.getColumn(columns.findIndex((col) => col.key === 'out' && col.total) + 1).letter
          cell.value = { formula: `IF(${outTotal}${rowNumber}=0,"N/A",${returned}/${outTotal}${rowNumber})`, result: shipped > 0 ? returned / shipped : 'N/A' }
        } else if (column.key === 'minimum' && item.minimumMode === 'Auto') {
          const start21 = new Date(Date.parse(`${ledger.calculationDay}T12:00:00Z`) - 20 * 86400000).toISOString().slice(0, 10)
          const salesColumns = columns.map((col, i) => col.key === 'out' && col.day >= start21 && col.day <= ledger.salesDay ? i + 1 : null).filter(Boolean)
          cell.value = salesColumns.length ? {
            formula: `ROUNDUP(SUM(${sheet.getColumn(salesColumns[0]).letter}${rowNumber}:${sheet.getColumn(salesColumns.at(-1)).letter}${rowNumber}),0)`, result: item.minimum,
          } : 0
        } else if (column.key === 'replenishment' && item.quantity != null) {
          const balance = sheet.getColumn(columns.findIndex((col) => col.key === 'quantity') + 1).letter
          const minimum = sheet.getColumn(columns.findIndex((col) => col.key === 'minimum') + 1).letter
          cell.value = { formula: `MAX(0,${minimum}${rowNumber}-${balance}${rowNumber})`, result: item.replenishment }
        } else cell.value = item[column.key] ?? 'Unavailable'
        if (columnIndex > 1) cell.numFmt = column.key === 'returnRate' ? '0.0%' : '#,##0'
        cell.alignment = { vertical: 'middle', horizontal: column.key === 'minimumMode' ? 'center' : typeof cell.value === 'number' || cell.value?.formula ? 'right' : 'left' }
      })
      sheet.getRow(rowNumber).height = 20
    })
    const balanceLetter = sheet.getColumn(columns.findIndex((column) => column.key === 'quantity') + 1).letter
    const minimumLetter = sheet.getColumn(columns.findIndex((column) => column.key === 'minimum') + 1).letter
    sheet.addConditionalFormatting({ ref: `${balanceLetter}6:${balanceLetter}${rows.length + 5}`, rules: [{
      type: 'expression', formulae: [`AND(ISNUMBER(${balanceLetter}6),${balanceLetter}6<${minimumLetter}6)`],
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF4CCCC' } }, font: { color: { argb: 'FF991B1B' } } },
    }] })
    sheet.autoFilter = { from: 'A5', to: `${last}${rows.length + 5}` }
    sheet.pageSetup = { orientation: 'landscape', fitToPage: false, printTitlesRow: '1:5', printTitlesColumn: 'A:B' }
  }

}

module.exports = { shipmentFileDay, skuKey, styleKey, buildLedger, addLedgerSheets, normalizeMinimumRows }
