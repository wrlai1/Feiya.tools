import { consolidateRows } from './consolidateEngine.js'
import { fillTemplate } from './autoDeductEngine.js'

const TRACKING_ALIASES = [
  'Tracking', 'Tracking Number', 'Tracking No', 'Return Tracking',
  '退货运单号', '运单号', '物流单号',
]

function findKey(row, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return Object.keys(row).find((key) => wanted.has(key.trim().toLowerCase()))
}

export function normalizeTracking(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase()
}

export function parseReturnManifestRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Return file is empty')
  const trackingKey = findKey(rows[0], TRACKING_ALIASES)
  if (!trackingKey) throw new Error('Could not find a Tracking/运单号 column')

  const groups = new Map()
  rows.forEach((row, index) => {
    const trackingNumber = String(row[trackingKey] || '').trim()
    const tracking = normalizeTracking(trackingNumber)
    if (!tracking) throw new Error(`Row ${index + 2} is missing a tracking number`)
    const group = groups.get(tracking) || { tracking, trackingNumber, rows: [] }
    group.rows.push(row)
    groups.set(tracking, group)
  })

  const packages = []
  const needsReview = []
  for (const group of groups.values()) {
    const result = consolidateRows(group.rows)
    if (result.needsReview.length) {
      needsReview.push(...result.needsReview.map((row) => ({
        tracking: group.trackingNumber,
        ...row,
      })))
    }
    const items = result.consolidated
      .filter((row) => row.QTY > 0)
      .map((row) => ({
        style: row.style,
        color: row.color,
        size: row.size,
        expectedQty: row.QTY,
        packCount: row.pack_count || 1,
        parseIssue: row.parse_issue || '',
      }))
    if (!items.length) throw new Error(`Tracking ${group.trackingNumber} has no return units`)
    packages.push({
      tracking: group.tracking,
      trackingNumber: group.trackingNumber,
      items,
      expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    })
  }

  return {
    packages,
    needsReview,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking)).size,
    },
  }
}

export function resolveReturnManifestPackages(parsed, templateRows, aliases = {}) {
  const packages = []
  const needsReview = []
  for (const pkg of parsed.packages || []) {
    const result = fillTemplate(
      templateRows,
      pkg.items.map((item) => ({
        style: item.style,
        color: item.color,
        size: item.size,
        QTY: item.expectedQty,
        pack_count: item.packCount,
        parse_issue: item.parseIssue,
      })),
      aliases,
    )
    if (result.unmatchedRows.length) {
      needsReview.push(...result.unmatchedRows.map((row) => ({
        tracking: pkg.trackingNumber,
        raw_style: `${row.style} / ${row.color} / ${row.size}`,
        ...row,
        parse_issue: row.parseIssue || 'inventory_target_missing',
      })))
      continue
    }
    const items = result.filledRows
      .filter((row) => Number(row.QTY) > 0)
      .map((row) => ({
        style: row.STYLE,
        color: row.COLOR,
        size: row.SIZE,
        expectedQty: Number(row.QTY),
      }))
    packages.push({
      ...pkg,
      items,
      expectedUnits: items.reduce((sum, item) => sum + item.expectedQty, 0),
    })
  }
  return {
    packages,
    needsReview,
    stats: {
      packageCount: packages.length,
      expectedUnits: packages.reduce((sum, pkg) => sum + pkg.expectedUnits, 0),
      reviewPackages: new Set(needsReview.map((row) => row.tracking)).size,
    },
  }
}
