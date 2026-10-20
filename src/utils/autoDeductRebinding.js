import { normalizeColor, normalizeSize, normalizeStyleIdentity } from './autoDeductEngine.js'

export function sameAliasValue(left, right) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

export function aliasesForSource(aliases, baseKey) {
  return Object.fromEntries(Object.entries(aliases).filter(([key]) => key === baseKey || key.startsWith(`${baseKey}::`)))
}

export function savedRebindingGroups(aliases) {
  const groups = new Map()
  for (const [key, value] of Object.entries(aliases)) {
    const [sourceStyle, sourceColor] = key.split('::')
    if (!sourceStyle || !sourceColor || !value || Array.isArray(value.components)) continue
    const targetStyle = typeof value === 'string' ? sourceStyle : value.STYLE || sourceStyle
    const targetColor = typeof value === 'string' ? value : value.COLOR
    if (!targetColor) continue
    const baseKey = `${sourceStyle}::${sourceColor}`
    const id = JSON.stringify([baseKey, normalizeStyleIdentity(targetStyle), normalizeColor(targetColor)])
    if (!groups.has(id)) groups.set(id, { id, baseKey, sourceStyle, sourceColor, targetStyle, targetColor, keys: [] })
    groups.get(id).keys.push(key)
  }
  return [...groups.values()].sort((a, b) => a.sourceStyle.localeCompare(b.sourceStyle) || a.sourceColor.localeCompare(b.sourceColor))
}

export function buildRebindingPlan(aliases, inventory, groupId, targetStyle, targetColor) {
  const group = savedRebindingGroups(aliases).find((item) => item.id === groupId)
  if (!group) throw new Error('原匹配已变化，请重新加载后选择')
  const targets = inventory.filter((row) => row.STYLE === targetStyle && row.COLOR === targetColor)
  if (!targets.length) throw new Error('请选择当前库存中存在的款式和颜色')
  // The matching engine uses normalized identities; require one physical target
  // for each size, including aliases that differ only by spelling/case.
  for (const target of targets) {
    const matches = inventory.filter((row) => normalizeStyleIdentity(row.STYLE) === normalizeStyleIdentity(targetStyle)
      && normalizeColor(row.COLOR) === normalizeColor(targetColor) && normalizeSize(row.SIZE) === normalizeSize(target.SIZE))
    if (matches.length !== 1) throw new Error(`目标库存尺码 ${target.SIZE} 存在重复匹配，请先核对库存 SKU`)
  }
  const upserts = {}
  const rows = group.keys.map((key) => {
    const original = aliases[key]
    const value = typeof original === 'string' ? {} : original
    const sourceSize = key.split('::')[2]
    const size = value.SIZE || sourceSize || ''
    const target = size ? targets.find((row) => normalizeSize(row.SIZE) === normalizeSize(size)) : null
    if (size && !target) throw new Error(`目标颜色缺少尺码 ${size}，不能重新绑定`)
    upserts[key] = { ...value, STYLE: targetStyle, COLOR: targetColor, _isNew: false, _confirmed: true,
      ...(value.SIZE ? { SIZE: target.SIZE } : {}) }
    return { key, size: size || '按出货尺码', oldStyle: group.targetStyle, oldColor: group.targetColor, targetStyle, targetColor }
  })
  if (normalizeStyleIdentity(group.targetStyle) === normalizeStyleIdentity(targetStyle)
    && normalizeColor(group.targetColor) === normalizeColor(targetColor)) throw new Error('请选择不同的目标款式或颜色')
  return { group, rows, upserts, expected: aliasesForSource(aliases, group.baseKey) }
}
