import { normalizeColor, normalizeSize, normalizeStyleIdentity } from './autoDeductEngine.js'

const sourceColorKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const REUSABLE_REVIEW_ISSUES = new Set([
  'style_identity_mismatch',
  'ambiguous_inventory_style',
  'ambiguous_inventory_color',
  'confirmed_mapping_size_missing',
])

function canReuseAcrossSizes(issue) {
  return !issue || REUSABLE_REVIEW_ISSUES.has(issue)
}

function canReuseComboAcrossSizes(issue) {
  return !issue || String(issue)
    .split(';')
    .filter(Boolean)
    .every((item) => ['set_components_unknown', 'cross_style_combo'].includes(item))
}

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
  if (!source || source.packCount > 1) return []

  const sourceStyle = normalizeStyleIdentity(source.style)
  const sourceColor = sourceColorKey(source.color)
  const sourceSize = normalizeSize(source.size)
  const targetStyle = normalizeStyleIdentity(targetEntry.STYLE)
  const targetColor = normalizeColor(targetEntry.COLOR)
  if (normalizeSize(targetEntry.SIZE) !== sourceSize) return []
  const canReuseSiblingSizes = canReuseAcrossSizes(source.parseIssue)
    && canReuseAcrossSizes(source.sourceIssue)

  return unmatchedRows.flatMap((row, index) => {
    if (
      index === sourceIndex
      || resolved[index]
      || row.packCount > 1
    ) return []
    if (normalizeStyleIdentity(row.style) !== sourceStyle || sourceColorKey(row.color) !== sourceColor) return []

    const targetSize = normalizeSize(row.size)
    if (targetSize === sourceSize) return [{ index, entry: targetEntry }]
    if (
      !canReuseSiblingSizes
      || row.parseIssue !== source.parseIssue
      || row.sourceIssue !== source.sourceIssue
      || !canReuseAcrossSizes(row.parseIssue)
      || !canReuseAcrossSizes(row.sourceIssue)
    ) return []
    const entry = templateRows.find((candidate) =>
      normalizeStyleIdentity(candidate.STYLE) === targetStyle &&
      normalizeColor(candidate.COLOR) === targetColor &&
      normalizeSize(candidate.SIZE) === targetSize
    )
    return entry ? [{ index, entry }] : []
  })
}

/** Reuse a confirmed set/combo across sibling source sizes only when every
 * component has one exact style+color target for the sibling size. */
export function findAdditionalComboSizeMappings({
  unmatchedRows,
  templateRows,
  resolved,
  sourceIndex,
  components,
}) {
  const source = unmatchedRows[sourceIndex]
  if (
    !source
    || !components?.length
    || !canReuseComboAcrossSizes(source.parseIssue)
    || !canReuseComboAcrossSizes(source.sourceIssue)
  ) return []

  const sourceSize = normalizeSize(source.size)
  if (!sourceSize || components.some((component) => normalizeSize(component.SIZE) !== sourceSize)) return []

  const sourceStyle = normalizeStyleIdentity(source.style)
  const sourceColor = sourceColorKey(source.color)

  return unmatchedRows.flatMap((row, index) => {
    if (
      index === sourceIndex
      || resolved[index]
      || row.parseIssue !== source.parseIssue
      || row.sourceIssue !== source.sourceIssue
      || !canReuseComboAcrossSizes(row.parseIssue)
      || !canReuseComboAcrossSizes(row.sourceIssue)
      || normalizeStyleIdentity(row.style) !== sourceStyle
      || sourceColorKey(row.color) !== sourceColor
    ) return []

    const targetSize = normalizeSize(row.size)
    if (!targetSize) return []
    const mappedComponents = components.map((component) => {
      const matches = templateRows.filter((candidate) =>
        String(candidate.STYLE || '').trim() === String(component.STYLE || '').trim()
        && String(candidate.COLOR || '').trim() === String(component.COLOR || '').trim()
        && normalizeSize(candidate.SIZE) === targetSize
      )
      if (matches.length !== 1) return null
      return {
        ...matches[0],
        multiplier: Math.max(1, parseInt(component.multiplier, 10) || 1),
      }
    })
    return mappedComponents.some((component) => !component)
      ? []
      : [{ index, components: mappedComponents }]
  })
}
