import { replenishmentSkuKey } from './replenishmentPlan.js'

const DAY_MS = 86400000

function normalizedPart(value) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function dayKey(value) {
  const text = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function dayNumber(value) {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / DAY_MS
}

function dateKey(value) {
  if (typeof value === 'string' && dayKey(value)) return dayKey(value)
  const date = new Date(value ?? Date.now())
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateFromNumber(value) {
  return new Date(value * DAY_MS).toISOString().slice(0, 10)
}

function positiveQuantity(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

const SIZE_RANK = new Map([
  ['XXS', 10], ['XS', 20], ['S', 30], ['M', 40], ['L', 50], ['XL', 60], ['XXL', 70],
  ['PS', 110], ['PM', 120], ['PL', 130], ['PXL', 140],
  ['1X', 210], ['1XL', 210], ['2X', 220], ['2XL', 220], ['3X', 230], ['3XL', 230],
  ['4X', 240], ['4XL', 240], ['5X', 250], ['5XL', 250],
])

export function compareInventorySizes(a, b) {
  const left = String(a ?? '').trim().toUpperCase()
  const right = String(b ?? '').trim().toUpperCase()
  const rankDifference = (SIZE_RANK.get(left) ?? 1000) - (SIZE_RANK.get(right) ?? 1000)
  return rankDifference || compareText(left, right)
}

function summarizeSales(salesByDay, endDayNumber, windowDays = 28) {
  let latestDaySales = 0
  let last7Sales = 0
  let previous7Sales = 0
  let last28Sales = 0
  let earliestDayNumber = null

  for (const [day, quantity] of salesByDay) {
    const number = dayNumber(day)
    earliestDayNumber = earliestDayNumber == null ? number : Math.min(earliestDayNumber, number)
    if (number === endDayNumber) latestDaySales += quantity
    if (number >= endDayNumber - 6 && number <= endDayNumber) last7Sales += quantity
    if (number >= endDayNumber - 13 && number <= endDayNumber - 7) previous7Sales += quantity
    if (number >= endDayNumber - (windowDays - 1) && number <= endDayNumber) last28Sales += quantity
  }

  const historyDays = earliestDayNumber == null
    ? 0
    : Math.max(1, Math.min(windowDays, endDayNumber - earliestDayNumber + 1))
  const dailyAverage = historyDays ? last28Sales / historyDays : 0
  const trend = previous7Sales > 0
    ? (last7Sales - previous7Sales) / previous7Sales
    : last7Sales > 0 ? null : 0

  return {
    latestDaySales,
    last7Sales,
    previous7Sales,
    last28Sales,
    historyDays,
    dailyAverage,
    trend,
  }
}

function addSale(target, day, quantity) {
  target.set(day, (target.get(day) || 0) + quantity)
}

function makeSku(row, order) {
  return {
    key: replenishmentSkuKey(row),
    style: String(row.Style ?? row.style ?? '').trim(),
    color: String(row.Color ?? row.color ?? '').trim(),
    size: String(row.Size ?? row.size ?? '').trim(),
    onHand: 0,
    order,
    salesByDay: new Map(),
  }
}

export function buildDailyStyleReport({
  inventoryRows = [],
  movements = [],
  style = '',
  today,
} = {}) {
  const selectedStyle = String(style ?? '').trim()
  const selectedStyleKey = normalizedPart(selectedStyle)
  if (!selectedStyleKey) return null

  const allSalesDays = []
  for (const movement of movements || []) {
    if (movement?.txn_type !== 'sales' || !positiveQuantity(movement.qty)) continue
    const movementDay = dayKey(movement.day)
    if (movementDay) allSalesDays.push(movementDay)
  }
  const dataThroughDay = allSalesDays.sort().at(-1) || dateKey(today)
  const endDayNumber = dayNumber(dataThroughDay)

  const skuByKey = new Map()
  let order = 0
  for (const inventoryRow of inventoryRows || []) {
    if (normalizedPart(inventoryRow.Style ?? inventoryRow.style) !== selectedStyleKey) continue
    const key = replenishmentSkuKey(inventoryRow)
    const sku = skuByKey.get(key) || makeSku(inventoryRow, order++)
    sku.onHand += Number(inventoryRow.Quantity ?? inventoryRow.quantity) || 0
    skuByKey.set(key, sku)
  }

  const sourceMovements = []
  for (const movement of movements || []) {
    if (normalizedPart(movement.style ?? movement.Style) !== selectedStyleKey) continue
    const movementDay = dayKey(movement.day)
    const quantity = positiveQuantity(movement.qty)
    if (!movementDay || !quantity) continue
    sourceMovements.push({
      day: movementDay,
      type: String(movement.txn_type || ''),
      style: String(movement.style ?? movement.Style ?? '').trim(),
      color: String(movement.color ?? movement.Color ?? '').trim(),
      size: String(movement.size ?? movement.Size ?? '').trim(),
      quantity,
    })
    if (movement.txn_type !== 'sales') continue
    const key = replenishmentSkuKey(movement)
    const sku = skuByKey.get(key) || makeSku(movement, order++)
    addSale(sku.salesByDay, movementDay, quantity)
    skuByKey.set(key, sku)
  }

  const sizes = [...new Set([...skuByKey.values()].map((sku) => sku.size).filter(Boolean))]
    .sort(compareInventorySizes)
  const colorByKey = new Map()
  const styleSalesByDay = new Map()

  const sizeRows = [...skuByKey.values()]
    .map((sku) => {
      const sales = summarizeSales(sku.salesByDay, endDayNumber)
      for (const [day, quantity] of sku.salesByDay) addSale(styleSalesByDay, day, quantity)
      const daysLeft = sales.dailyAverage > 0
        ? Math.max(0, sku.onHand) / sales.dailyAverage
        : null
      const colorKey = normalizedPart(sku.color)
      const color = colorByKey.get(colorKey) || {
        color: sku.color,
        order: sku.order,
        inventoryBySize: Object.fromEntries(sizes.map((size) => [size, 0])),
        latestSalesBySize: Object.fromEntries(sizes.map((size) => [size, 0])),
        salesByDay: new Map(),
      }
      color.order = Math.min(color.order, sku.order)
      color.inventoryBySize[sku.size] = (color.inventoryBySize[sku.size] || 0) + sku.onHand
      color.latestSalesBySize[sku.size] = (color.latestSalesBySize[sku.size] || 0) + sales.latestDaySales
      for (const [day, quantity] of sku.salesByDay) addSale(color.salesByDay, day, quantity)
      colorByKey.set(colorKey, color)
      return {
        ...sku,
        ...sales,
        daysLeft,
      }
    })
    .sort((a, b) => a.order - b.order || compareInventorySizes(a.size, b.size))

  const colorRows = [...colorByKey.values()]
    .map((color) => {
      const sales = summarizeSales(color.salesByDay, endDayNumber)
      const onHand = Object.values(color.inventoryBySize).reduce((sum, value) => sum + value, 0)
      return {
        ...color,
        ...sales,
        onHand,
        daysLeft: sales.dailyAverage > 0 ? Math.max(0, onHand) / sales.dailyAverage : null,
      }
    })
    .sort((a, b) => a.order - b.order || compareText(a.color, b.color))

  const totals = summarizeSales(styleSalesByDay, endDayNumber)
  const currentInventory = sizeRows.reduce((sum, row) => sum + row.onHand, 0)
  const daysLeft = totals.dailyAverage > 0
    ? Math.max(0, currentInventory) / totals.dailyAverage
    : null

  const dailyRows = Array.from({ length: 28 }, (_, index) => {
    const number = endDayNumber - 27 + index
    const day = dateFromNumber(number)
    const bySize = Object.fromEntries(sizes.map((size) => [size, 0]))
    for (const row of sizeRows) {
      bySize[row.size] = (bySize[row.size] || 0) + (row.salesByDay.get(day) || 0)
    }
    return {
      day,
      bySize,
      total: Object.values(bySize).reduce((sum, value) => sum + value, 0),
    }
  })

  const weeklyRows = Array.from({ length: 4 }, (_, index) => {
    const end = endDayNumber - index * 7
    const start = end - 6
    const bySize = Object.fromEntries(sizes.map((size) => [size, 0]))
    for (const row of dailyRows) {
      const number = dayNumber(row.day)
      if (number < start || number > end) continue
      for (const size of sizes) bySize[size] += row.bySize[size] || 0
    }
    return {
      label: index === 0 ? 'Last 7 Days' : index === 1 ? 'Previous 7 Days' : `${index + 1} Weeks Ago`,
      startDay: dateFromNumber(start),
      endDay: dateFromNumber(end),
      bySize,
      total: Object.values(bySize).reduce((sum, value) => sum + value, 0),
    }
  })

  return {
    style: selectedStyle,
    generatedDay: dateKey(today),
    dataThroughDay,
    sizes,
    colorRows,
    sizeRows,
    dailyRows,
    weeklyRows,
    sourceInventoryRows: sizeRows.map((row) => ({
      style: row.style,
      color: row.color,
      size: row.size,
      quantity: row.onHand,
    })),
    sourceMovements: sourceMovements.sort((a, b) => compareText(a.day, b.day)),
    totals: {
      ...totals,
      currentInventory,
      daysLeft,
    },
  }
}

function rounded(value, digits = 0) {
  if (!Number.isFinite(value)) return ''
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function displayDays(value) {
  return Number.isFinite(value) ? Math.round(value) : 'No recent sales'
}

export function buildDailyStyleWorkbookData(report) {
  if (!report) return null
  const { sizes } = report
  const inventoryStart = 1
  const inventoryTotal = inventoryStart + sizes.length
  const latestStart = inventoryTotal + 1
  const latestTotal = latestStart + sizes.length
  const comparisonStart = latestTotal + 1
  const tableLastColumn = comparisonStart + 4
  const lastColumn = Math.max(tableLastColumn, 11)
  const mainWidths = Array(lastColumn + 1).fill(12)
  mainWidths[0] = 26
  for (const column of [2, 4, 6, 8, 10]) {
    if (column <= lastColumn) mainWidths[column] = 18
  }
  ;[14, 16, 14, 14, 18].forEach((width, index) => {
    mainWidths[comparisonStart + index] = width
  })

  const mainRows = [
    [`${report.style} Daily Inventory & Sales Report`],
    ['Generated', report.generatedDay, 'Sales data through', report.dataThroughDay,
      'Current inventory already includes applied Auto Deduct sales; sales history is not deducted again.'],
    [],
    ['Current Inventory', report.totals.currentInventory, 'Latest Day Sales', report.totals.latestDaySales,
      'Last 7 Days', report.totals.last7Sales, 'Previous 7 Days', report.totals.previous7Sales,
      '28D Avg / Day', rounded(report.totals.dailyAverage, 2), 'Est. Days Left', displayDays(report.totals.daysLeft)],
    [],
    [
      'Color',
      'Current Inventory', ...Array(sizes.length).fill(''),
      `Latest Sales Day (${report.dataThroughDay})`, ...Array(sizes.length).fill(''),
      'Sales Comparison', '', '', '', '',
    ],
    [
      'Color',
      ...sizes, 'Total',
      ...sizes, 'Total',
      'Last 7 Days', 'Previous 7 Days', 'Last 28 Days', '28D Avg / Day', 'Est. Days Left',
    ],
    ...report.colorRows.map((row) => [
      row.color,
      ...sizes.map((size) => row.inventoryBySize[size] || 0), row.onHand,
      ...sizes.map((size) => row.latestSalesBySize[size] || 0), row.latestDaySales,
      row.last7Sales, row.previous7Sales, row.last28Sales,
      rounded(row.dailyAverage, 2), displayDays(row.daysLeft),
    ]),
    [
      'TOTAL',
      ...sizes.map((size) => report.sizeRows
        .filter((row) => row.size === size)
        .reduce((sum, row) => sum + row.onHand, 0)),
      report.totals.currentInventory,
      ...sizes.map((size) => report.sizeRows
        .filter((row) => row.size === size)
        .reduce((sum, row) => sum + row.latestDaySales, 0)),
      report.totals.latestDaySales,
      report.totals.last7Sales,
      report.totals.previous7Sales,
      report.totals.last28Sales,
      rounded(report.totals.dailyAverage, 2),
      displayDays(report.totals.daysLeft),
    ],
  ]

  const mainHeaderRow = 6
  const mainDataStartRow = 7
  const mainDataEndRow = mainDataStartRow + report.colorRows.length
  const sizeDetailRows = [
    [`${report.style} Size Detail`],
    ['Color', 'Size', 'Current Inventory', `Sales ${report.dataThroughDay}`, 'Last 7 Days',
      'Previous 7 Days', 'Last 28 Days', '28D Avg / Day', 'Est. Days Left', 'History Days'],
    ...report.sizeRows.map((row) => [
      row.color,
      row.size,
      row.onHand,
      row.latestDaySales,
      row.last7Sales,
      row.previous7Sales,
      row.last28Sales,
      rounded(row.dailyAverage, 2),
      displayDays(row.daysLeft),
      row.historyDays,
    ]),
  ]

  const salesTrendRows = [
    [`${report.style} Weekly and Daily Sales`],
    [],
    ['Weekly comparison', 'Start', 'End', ...sizes, 'Total'],
    ...report.weeklyRows.map((row) => [
      row.label, row.startDay, row.endDay, ...sizes.map((size) => row.bySize[size] || 0), row.total,
    ]),
    [],
    ['Daily sales', ...sizes, 'Total'],
    ...report.dailyRows.map((row) => [
      row.day, ...sizes.map((size) => row.bySize[size] || 0), row.total,
    ]),
  ]

  const sourceRows = [
    ['Current Inventory Source'],
    ['Style', 'Color', 'Size', 'Quantity'],
    ...report.sourceInventoryRows.map((row) => [row.style, row.color, row.size, row.quantity]),
    [],
    ['Applied Movement Source'],
    ['Order Date', 'Type', 'Style', 'Color', 'Size', 'Quantity'],
    ...report.sourceMovements.map((row) => [
      row.day, row.type, row.style, row.color, row.size, row.quantity,
    ]),
  ]

  return {
    sheets: [
      {
        name: 'Daily Inventory',
        rows: mainRows,
        merges: [
          { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
          { s: { r: 1, c: 4 }, e: { r: 1, c: lastColumn } },
          { s: { r: 5, c: inventoryStart }, e: { r: 5, c: inventoryTotal } },
          { s: { r: 5, c: latestStart }, e: { r: 5, c: latestTotal } },
          { s: { r: 5, c: comparisonStart }, e: { r: 5, c: tableLastColumn } },
        ],
        widths: mainWidths,
        headerRows: [0, 5, 6],
        totalRows: [mainDataEndRow],
        numberRows: {
          start: mainDataStartRow,
          end: mainDataEndRow,
          startColumn: 1,
          endColumn: tableLastColumn,
          decimalColumns: [tableLastColumn - 1],
        },
        autoFilter: { s: { r: mainHeaderRow, c: 0 }, e: { r: mainDataEndRow, c: tableLastColumn } },
      },
      {
        name: 'Size Detail',
        rows: sizeDetailRows,
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }],
        widths: [22, 10, 16, 16, 13, 16, 14, 14, 16, 13],
        headerRows: [0, 1],
        autoFilter: { s: { r: 1, c: 0 }, e: { r: Math.max(1, sizeDetailRows.length - 1), c: 9 } },
      },
      {
        name: 'Sales Trend',
        rows: salesTrendRows,
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(5, sizes.length + 1) } }],
        widths: [22, 13, 13, ...Array(sizes.length).fill(11), 12],
        headerRows: [0, 2, report.weeklyRows.length + 4],
      },
      {
        name: 'Data Source',
        rows: sourceRows,
        widths: [18, 16, 22, 22, 12, 12],
        headerRows: [0, 1, report.sourceInventoryRows.length + 3, report.sourceInventoryRows.length + 4],
      },
    ],
  }
}

function styleSheetCells(sheet, config, XLSX) {
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const titleStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 14 },
    fill: { fgColor: { rgb: '1E3A8A' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  }
  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '2563EB' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: { bottom: { style: 'thin', color: { rgb: 'CBD5E1' } } },
  }
  const totalStyle = {
    font: { bold: true },
    fill: { fgColor: { rgb: 'DBEAFE' } },
    border: { top: { style: 'medium', color: { rgb: '2563EB' } } },
  }

  for (const rowIndex of config.headerRows || []) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })]
      if (cell) cell.s = rowIndex === 0 ? titleStyle : headerStyle
    }
  }
  for (const rowIndex of config.totalRows || []) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })]
      if (cell) cell.s = totalStyle
    }
  }
  if (config.numberRows) {
    const decimalColumns = new Set(config.numberRows.decimalColumns || [])
    for (let row = config.numberRows.start; row <= config.numberRows.end; row += 1) {
      for (let column = config.numberRows.startColumn; column <= config.numberRows.endColumn; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
        if (cell?.t === 'n') cell.z = decimalColumns.has(column) ? '#,##0.00' : '#,##0'
      }
    }
  }
}

export function createDailyStyleWorkbook(XLSX, report) {
  const data = buildDailyStyleWorkbookData(report)
  if (!data) throw new Error('A style report is required')
  const workbook = XLSX.utils.book_new()
  for (const config of data.sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(config.rows)
    sheet['!merges'] = config.merges || []
    sheet['!cols'] = (config.widths || []).map((wch) => ({ wch }))
    if (config.autoFilter) sheet['!autofilter'] = { ref: XLSX.utils.encode_range(config.autoFilter) }
    styleSheetCells(sheet, config, XLSX)
    XLSX.utils.book_append_sheet(workbook, sheet, config.name)
  }
  return workbook
}

export function dailyStyleReportFileName(report) {
  const style = String(report?.style || 'style').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return `daily_inventory_${style || 'style'}_${report?.generatedDay || dateKey()}.xlsx`
}
