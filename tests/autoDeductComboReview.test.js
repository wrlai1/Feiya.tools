import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateResolvedSourceUnits } from '../src/utils/autoDeductEngine.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'

test('nonstandard slash color combinations require physical-unit review', () => {
  const result = consolidateRows([
    { SKU: '50283fuchsia/sunXL', 'Product Attribute': '黄色 / XL', Quantity: 1 },
    { SKU: '50283red/greenXL', 'Product Attribute': '红色 / XL', Quantity: 1 },
  ])

  assert.equal(result.stats.newTotal, 2)
  assert.equal(result.stats.hasUnknownUnitCounts, true)
  assert.deepEqual(result.consolidated.map((row) => [row.style, row.color, row.size, row.parse_issue]), [
    ['50283', 'fuchsia/sun', 'XL', 'ambiguous_color_separator'],
    ['50283', 'red/green', 'XL', 'ambiguous_color_separator'],
  ])
})

test('confirmed combo components reconcile the 784 to 786 case', () => {
  const resolved = ['fuchsia/sun', 'red/green'].map((color) => ({
    QTY: 1,
    _isCombo: true,
    components: [
      { STYLE: '50283', COLOR: `${color} A`, SIZE: 'XL', multiplier: 1 },
      { STYLE: '50283', COLOR: `${color} B`, SIZE: 'XL', multiplier: 1 },
    ],
    _source: { originalPackCount: 1 },
  }))

  assert.equal(calculateResolvedSourceUnits(784, resolved), 786)
})
