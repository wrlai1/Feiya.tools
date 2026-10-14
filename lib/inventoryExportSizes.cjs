const letters = new Map(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'PS', 'PM', 'PL', 'PXL'].map((value, index) => [value, index]))
function compareExportSizes(a, b) {
  const rank = (value) => {
    const size = String(value || '').trim().toUpperCase()
    if (letters.has(size)) return [0, letters.get(size), size]
    const plus = size.match(/^(\d+)X(?:L)?$/)
    if (plus) return [1, Number(plus[1]), size]
    if (/^\d+$/.test(size)) return [2, Number(size), size]
    return [3, 0, size]
  }
  const left = rank(a), right = rank(b)
  return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2], undefined, { numeric: true })
}
module.exports = { compareExportSizes }
