import { validBusinessDay } from './fileBusinessDay.js'

export function resolutionSourceContext(row, extra = {}) {
  return {
    style: row.style,
    color: row.color,
    size: row.size,
    businessDay: String(row.businessDay || '').trim(),
    sourceSignature: row.sourceSignature,
    sourceIssue: row.sourceIssue,
    parseIssue: row.parseIssue,
    ...extra,
  }
}

export function buildBusinessMovementRows(items, sourceBusinessDay) {
  const businessDay = validBusinessDay(sourceBusinessDay)
  if (!businessDay) return []

  const groups = new Map()
  for (const item of items || []) {
    const qty = Number(item.qty || 0)
    if (!Number.isSafeInteger(qty) || qty <= 0) continue
    const key = [item.targetStyle, item.targetColor, item.targetSize].join('\u241f')
    const current = groups.get(key) || {
      STYLE: item.targetStyle,
      COLOR: item.targetColor,
      SIZE: item.targetSize,
      QTY: 0,
      businessDay,
    }
    current.QTY += qty
    groups.set(key, current)
  }
  return [...groups.values()]
}

function inventoryKey(style, color, size) {
  return [style, color, size].map((value) => String(value || '').trim()).join('\u241f')
}

export function applyManualTargetEdits(filledRows, previewRows, edits = {}) {
  const rows = (filledRows || []).map((row) => ({ ...row }))
  const preview = (previewRows || []).map((row) => ({ ...row }))
  const rowIndex = new Map(rows.map((row, index) => [
    inventoryKey(row.STYLE, row.COLOR, row.SIZE),
    index,
  ]))

  for (const [rawIndex, target] of Object.entries(edits || {})) {
    const index = Number(rawIndex)
    const item = preview[index]
    const qty = Number(item?.qty)
    if (
      !item
      || !Number.isSafeInteger(qty)
      || qty <= 0
      || !String(target?.STYLE || '').trim()
      || !String(target?.COLOR || '').trim()
      || !String(target?.SIZE || '').trim()
    ) {
      throw new Error('Manual target edit no longer matches the current deduction preview')
    }

    const sourceKey = inventoryKey(item.targetStyle, item.targetColor, item.targetSize)
    const targetKey = inventoryKey(target?.STYLE, target?.COLOR, target?.SIZE)
    if (!targetKey || sourceKey === targetKey) continue
    const sourceIndex = rowIndex.get(sourceKey)
    const targetIndex = rowIndex.get(targetKey)
    if (sourceIndex == null || targetIndex == null || Number(rows[sourceIndex].QTY || 0) < qty) {
      throw new Error('Manual target edit does not match the current inventory preview')
    }

    rows[sourceIndex].QTY = Number(rows[sourceIndex].QTY || 0) - qty
    rows[targetIndex].QTY = Number(rows[targetIndex].QTY || 0) + qty
    preview[index] = {
      ...item,
      targetStyle: rows[targetIndex].STYLE,
      targetColor: rows[targetIndex].COLOR,
      targetSize: rows[targetIndex].SIZE,
      via: 'manual intervention',
    }
  }

  return { filledRows: rows, previewRows: preview }
}
