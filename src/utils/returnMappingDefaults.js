export function updateReturnMappingTarget(targets, index, changes) {
  return targets.map((target, rowIndex) => {
    if (rowIndex === index) return { ...target, ...changes }
    if (changes.style && !target.style) return { ...target, style: changes.style, color: '', size: '' }
    return target
  })
}

export function newReturnMappingTarget(targets) {
  return { style: targets.find((target) => target.style)?.style || '', color: '', size: '', qty: 1 }
}
