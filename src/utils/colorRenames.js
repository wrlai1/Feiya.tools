import { colorAliasKey } from './colorNames.js'
import { styleNameKey } from './styleNames.js'
export const MAX_COLOR_RENAMES = 200
const invalid = message => Object.assign(new Error(message), { status: 400 })
export function normalizeColorRenames(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_COLOR_RENAMES) throw invalid('Enter 1–200 color name changes')
  const sources = new Set(), destinations = new Set()
  return changes.map((row, index) => {
    const style = typeof row?.style === 'string' ? row.style.trim() : ''
    const oldColor = typeof row?.oldColor === 'string' ? row.oldColor.trim() : ''
    const newColor = typeof row?.newColor === 'string' ? row.newColor.trim() : ''
    if (!style || !oldColor || !newColor || newColor.length > 100 || oldColor === newColor) throw invalid(`Row ${index + 1}: enter Style, old color and a different new color (1–100 characters)`)
    const source = colorAliasKey(style, oldColor), target = colorAliasKey(style, newColor)
    if (sources.has(source)) throw invalid(`Color ${style} / ${oldColor} appears more than once`)
    if (destinations.has(target)) throw invalid(`More than one color would become ${style} / ${newColor}`)
    sources.add(source); destinations.add(target)
    return { style, oldColor, newColor }
  })
}
export function parseColorRenamePaste(text) {
  const rows = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const values = line.split('\t')
    if (values.length !== 3) throw invalid(`Pasted row ${index + 1}: copy three columns, Style, Old Color and New Color`)
    return { style: values[0].trim(), oldColor: values[1].trim(), newColor: values[2].trim() }
  })
  if (rows.length && /^(style|款式|款号)$/i.test(rows[0].style) && /^(old color|原颜色|旧颜色)$/i.test(rows[0].oldColor)) rows.shift()
  if (!rows.length || rows.length > MAX_COLOR_RENAMES) throw invalid('Paste 1–200 color rows')
  const changes = rows.filter(row => row.newColor && row.newColor !== row.oldColor)
  if (changes.length) normalizeColorRenames(changes)
  return rows
}
