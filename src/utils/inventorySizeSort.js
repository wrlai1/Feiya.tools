const LETTER_SIZES = new Map([
  ['XXS', 0],
  ['XS', 1],
  ['S', 2],
  ['M', 3],
  ['L', 4],
  ['XL', 5],
  ['XXL', 6],
  ['XXXL', 7],
])

function sizeSortKey(value) {
  const size = String(value || '').trim().toUpperCase().replace(/\s+/g, '')
  if (LETTER_SIZES.has(size)) return [0, LETTER_SIZES.get(size), size]
  if (/^\d+$/.test(size)) return [1, Number(size), size]

  const shortPlus = size.match(/^(\d+)X$/)
  if (shortPlus) return [2, Number(shortPlus[1]), size]

  const longPlus = size.match(/^(\d+)XL$/)
  if (longPlus) return [3, Number(longPlus[1]), size]

  return [4, 0, size]
}

export function compareInventorySizes(left, right) {
  const leftKey = sizeSortKey(left)
  const rightKey = sizeSortKey(right)
  return leftKey[0] - rightKey[0]
    || leftKey[1] - rightKey[1]
    || leftKey[2].localeCompare(rightKey[2], undefined, { numeric: true })
}
