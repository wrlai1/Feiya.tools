import { styleNameKey } from './styleNames.js'

export const MAX_STYLE_RENAMES = 200
const reportKey = value => styleNameKey(value).replace(/[\s_-]/g, '')
const invalid = message => Object.assign(new Error(message), { status: 400 })

export function normalizeStyleRenames(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_STYLE_RENAMES) {
    throw invalid(`Enter 1–${MAX_STYLE_RENAMES} style name changes`)
  }
  const sources = new Set(), destinations = new Set()
  return changes.map((change, index) => {
    const oldStyle = typeof change?.oldStyle === 'string' ? change.oldStyle.trim() : ''
    const newStyle = typeof change?.newStyle === 'string' ? change.newStyle.trim() : ''
    if (!oldStyle || !newStyle || newStyle.length > 100 || oldStyle === newStyle) {
      throw invalid(`Row ${index + 1}: enter an existing style and a different new name (1–100 characters)`)
    }
    if (sources.has(styleNameKey(oldStyle))) throw invalid(`Style ${oldStyle} appears more than once`)
    if (destinations.has(reportKey(newStyle))) throw invalid(`More than one style would use the new name ${newStyle}`)
    sources.add(styleNameKey(oldStyle))
    destinations.add(reportKey(newStyle))
    return { oldStyle, newStyle }
  })
}

export function parseStyleRenamePaste(text) {
  const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(line => line.trim())
  const pairs = lines.map((line, index) => {
    const values = line.split('\t')
    if (values.length !== 2) throw invalid(`Pasted row ${index + 1}: copy two columns, Old Style and New Style`)
    return { oldStyle: values[0].trim(), newStyle: values[1].trim() }
  })
  if (pairs.length && /^(old style|old name|旧名称|原名称|旧款号)$/i.test(pairs[0].oldStyle)
    && /^(new style|new name|新名称|新款号)$/i.test(pairs[0].newStyle)) pairs.shift()
  if (!pairs.length || pairs.length > MAX_STYLE_RENAMES) throw invalid(`Paste 1–${MAX_STYLE_RENAMES} style rows`)
  const changes = pairs.filter(row => row.newStyle && row.newStyle !== row.oldStyle)
  if (changes.length) normalizeStyleRenames(changes)
  return pairs
}
