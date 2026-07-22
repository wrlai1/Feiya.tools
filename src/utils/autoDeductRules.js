import { normalizeColor, normalizeSize, normalizeStyle } from './autoDeductEngine.js'

const sourceColorKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Find unresolved sibling rows that can safely reuse a confirmed link.
 * The source style/color must be identical after basic cleanup, only the size may
 * differ, and the destination inventory must contain that exact target size.
 */
export function findAdditionalSizeMappings({
  unmatchedRows,
  templateRows,
  resolved,
  sourceIndex,
  targetEntry,
}) {
  const source = unmatchedRows[sourceIndex]
  if (!source || source.packCount > 1 || source.parseIssue) return []

  const sourceStyle = normalizeStyle(source.style)
  const sourceColor = sourceColorKey(source.color)
  const targetStyle = normalizeStyle(targetEntry.STYLE)
  const targetColor = normalizeColor(targetEntry.COLOR)
  if (normalizeSize(targetEntry.SIZE) !== normalizeSize(source.size)) return []

  return unmatchedRows.flatMap((row, index) => {
    if (index === sourceIndex || resolved[index] || row.packCount > 1 || row.parseIssue) return []
    if (normalizeStyle(row.style) !== sourceStyle || sourceColorKey(row.color) !== sourceColor) return []

    const targetSize = normalizeSize(row.size)
    const entry = templateRows.find((candidate) =>
      normalizeStyle(candidate.STYLE) === targetStyle &&
      normalizeColor(candidate.COLOR) === targetColor &&
      normalizeSize(candidate.SIZE) === targetSize
    )
    return entry ? [{ index, entry }] : []
  })
}
