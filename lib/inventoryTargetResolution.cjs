function inventoryIdentity(row) {
  return [row.style, row.color, row.size]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('\u0000')
}

function resolveInventoryTargets(applyRows, resolutionRows) {
  const byIndex = new Map(
    resolutionRows.map((row) => [Number(row.target_index), row]),
  )
  const missing = []
  const ambiguous = []
  const resolved = applyRows.map((row, index) => {
    const match = byIndex.get(index)
    const matchCount = Number(match?.match_count || 0)
    if (matchCount > 1) {
      ambiguous.push(row)
      return row
    }
    if (matchCount === 0) {
      if (!row.allowCreate) missing.push(row)
      return row
    }
    return {
      ...row,
      style: match.matched_style,
      color: match.matched_color,
      size: match.matched_size,
      allowCreate: false,
    }
  })

  const merged = new Map()
  for (const row of resolved) {
    const key = inventoryIdentity(row)
    const current = merged.get(key)
    if (current) {
      current.qty += row.qty
      current.allowCreate = current.allowCreate && row.allowCreate
    } else {
      merged.set(key, { ...row })
    }
  }

  return { rows: [...merged.values()], missing, ambiguous }
}

module.exports = { inventoryIdentity, resolveInventoryTargets }
