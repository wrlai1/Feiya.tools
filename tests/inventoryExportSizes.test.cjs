const test = require('node:test')
const assert = require('node:assert/strict')
const { compareExportSizes } = require('../lib/inventoryExportSizes.cjs')
test('exported file sorts letter, plus and numeric sizes naturally without renaming them', () => {
  const sizes = ['16','XL','3XL','M','10','XS','2XL','6','L','14','1XL','S','8','12']
  assert.deepEqual(sizes.sort(compareExportSizes), ['XS','S','M','L','XL','1XL','2XL','3XL','6','8','10','12','14','16'])
  assert.deepEqual(['3X','1X','2X'].sort(compareExportSizes), ['1X','2X','3X'])
})
