import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aliasKey,
  fillTemplate,
} from '../src/utils/autoDeductEngine.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'
import { findAdditionalComboSizeMappings, findAdditionalSizeMappings } from '../src/utils/autoDeductRules.js'

test('petite sales sizes are shifted exactly once', () => {
  const salesRows = consolidateRows([
    { Style: '0066PinkYarrowPL', Quantity: 1 },
  ]).consolidated
  const templateRows = ['PS', 'PM', 'PL', 'PXL'].map((SIZE) => ({
    STYLE: '6020066',
    COLOR: 'Pink Yarrow',
    SIZE,
  }))

  assert.equal(salesRows[0].size, 'PM')
  const result = fillTemplate(templateRows, salesRows)
  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: '6020066', COLOR: 'Pink Yarrow', SIZE: 'PM', QTY: 1 }],
  )
})

test('explicit ampersand color combinations split for any style', () => {
  const withAttribute = consolidateRows([
    {
      SKU: 'A100Black&Denim&WhiteM',
      'Product Attribute': 'Black&Denim&White / M',
      Quantity: 2,
    },
  ])
  const fromSkuOnly = consolidateRows([
    { SKU: 'B200Navy&KhakiL', Quantity: 1 },
  ])

  assert.deepEqual(
    withAttribute.consolidated.map(({ style, color, size, QTY }) => ({ style, color, size, QTY })),
    [
      { style: 'A100', color: 'black', size: 'M', QTY: 2 },
      { style: 'A100', color: 'denim', size: 'M', QTY: 2 },
      { style: 'A100', color: 'white', size: 'M', QTY: 2 },
    ],
  )
  assert.deepEqual(
    fromSkuOnly.consolidated.map(({ style, color, size, QTY }) => ({ style, color, size, QTY })),
    [
      { style: 'B200', color: 'khaki', size: 'L', QTY: 1 },
      { style: 'B200', color: 'navy', size: 'L', QTY: 1 },
    ],
  )
})

test('non-ampersand color combinations require confirmation', () => {
  const result = consolidateRows([
    { SKU: 'A100Black+WhiteS', Quantity: 2 },
    { SKU: '53058setM', Quantity: 1 },
  ])

  assert.equal(result.consolidated.length, 2)
  const plusCombo = result.consolidated.find((row) => row.style === 'A100')
  const namedSet = result.consolidated.find((row) => row.style === '53058')
  assert.equal(plusCombo.parse_issue, 'set_components_unknown')
  assert.equal(plusCombo.pack_count, 2)
  assert.equal(namedSet.parse_issue, 'set_components_unknown')
  assert.equal(result.needsReview.length, 2)
})

test('M022 routes missy and plus sizes before inventory matching', () => {
  const salesRows = consolidateRows([
    {
      SKU: 'M022Black&DenimS',
      'Product Attribute': 'Black&Denim / S',
      Quantity: 1,
    },
    {
      SKU: 'M022Black&Denim1XL',
      'Product Attribute': 'Black&Denim / 1XL',
      Quantity: 2,
    },
  ]).consolidated
  const result = fillTemplate([
    { STYLE: 'M022 Missy', COLOR: 'BLACK', SIZE: 'S' },
    { STYLE: 'M022 Missy', COLOR: 'DENIM', SIZE: 'S' },
    { STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '1X' },
    { STYLE: 'M022 PLUS', COLOR: 'DENIM', SIZE: '1X' },
  ], salesRows)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [
      { STYLE: 'M022 Missy', COLOR: 'BLACK', SIZE: 'S', QTY: 1 },
      { STYLE: 'M022 Missy', COLOR: 'DENIM', SIZE: 'S', QTY: 1 },
      { STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '1X', QTY: 2 },
      { STYLE: 'M022 PLUS', COLOR: 'DENIM', SIZE: '1X', QTY: 2 },
    ],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('M022 unknown sizes require confirmation', () => {
  const result = fillTemplate([
    { STYLE: 'M022', COLOR: 'BLACK', SIZE: 'XXL' },
  ], [
    { style: 'M022', color: 'black', size: 'XXL', QTY: 1 },
  ])

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'm022_size_unknown')
})

test('existing M022 color confirmations remain valid across missy and plus', () => {
  const aliases = {
    [aliasKey('M022', 'melon')]: {
      STYLE: 'M022 Missy',
      COLOR: 'CANYON ROSE',
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'M022 Missy', COLOR: 'CANYON ROSE', SIZE: 'M' },
    { STYLE: 'M022 PLUS', COLOR: 'CANYON ROSE', SIZE: '2X' },
  ], [
    { style: 'M022', color: 'melon', size: 'M', QTY: 1 },
    { style: 'M022', color: 'melon', size: '2XL', QTY: 2 },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [
      { STYLE: 'M022 Missy', COLOR: 'CANYON ROSE', SIZE: 'M', QTY: 1 },
      { STYLE: 'M022 PLUS', COLOR: 'CANYON ROSE', SIZE: '2X', QTY: 2 },
    ],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('numeric color codes remain distinct inventory identities', () => {
  const templateRows = [
    { STYLE: '5010149', COLOR: 'Ponte Print 32#', SIZE: 'S' },
    { STYLE: '5010149', COLOR: 'Ponte Print 36#', SIZE: 'S' },
  ]
  const result = fillTemplate(templateRows, [
    { style: '5010149', color: 'Ponte Print 36#', size: 'S', QTY: 1 },
  ])

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: '5010149', COLOR: 'Ponte Print 36#', SIZE: 'S', QTY: 1 }],
  )
})

test('future normalized color collisions fail closed for manual review', () => {
  const result = fillTemplate([
    { STYLE: 'A100', COLOR: 'Blue-1', SIZE: 'S' },
    { STYLE: 'A100', COLOR: 'Blue 1', SIZE: 'S' },
  ], [
    { style: 'A100', color: 'Blue1', size: 'S', QTY: 1 },
  ])

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'ambiguous_inventory_color')
})

test('punctuation differences in style never auto-match', () => {
  const result = fillTemplate([
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  ], [
    { style: 'A-100', color: 'BLACK', size: 'S', QTY: 1 },
  ])

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'style_identity_mismatch')
})

test('learned mapping keys keep meaningful style punctuation distinct', () => {
  assert.notEqual(
    aliasKey('A-100', 'Black', 'S'),
    aliasKey('A100', 'Black', 'S'),
  )
  assert.equal(
    aliasKey('95401 CAPRI', 'Black', 'S'),
    aliasKey('95401capri', 'Black', 'S'),
  )
})

test('learned colors do not collide through semantic aliases', () => {
  const templateRows = [
    { STYLE: '5020070', COLOR: 'FUSCHIA', SIZE: 'S' },
    { STYLE: '5020070', COLOR: 'Pink Yarrow', SIZE: 'S' },
  ]
  const aliases = {
    [aliasKey('5020070', 'Pink Yarrow', 'S')]: {
      STYLE: '5020070',
      COLOR: 'Pink Yarrow',
      SIZE: 'S',
    },
  }

  const pink = fillTemplate(templateRows, [
    { style: '5020070', color: 'Pink Yarrow', size: 'S', QTY: 1 },
  ], aliases)
  const fuschia = fillTemplate(templateRows, [
    { style: '5020070', color: 'FUSCHIA', size: 'S', QTY: 1 },
  ], aliases)

  assert.equal(pink.filledRows.find((row) => row.QTY)?.COLOR, 'Pink Yarrow')
  assert.equal(fuschia.filledRows.find((row) => row.QTY)?.COLOR, 'FUSCHIA')
})

test('existing human-confirmed cross-style mappings remain trusted', () => {
  const aliases = {
    [aliasKey('STYLE-A', 'black', 'S')]: {
      STYLE: 'STYLE-B',
      COLOR: 'BLACK',
      SIZE: 'S',
    },
  }
  const result = fillTemplate(
    [{ STYLE: 'STYLE-B', COLOR: 'BLACK', SIZE: 'S' }],
    [{ style: 'STYLE-A', color: 'black', size: 'S', QTY: 2 }],
    aliases,
  )

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: 'STYLE-B', COLOR: 'BLACK', SIZE: 'S', QTY: 2 }],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('existing confirmed size mappings safely extend to other available sizes', () => {
  const templateRows = [
    { STYLE: '50073', COLOR: 'DARK DENIM', SIZE: 'S' },
    { STYLE: '50073', COLOR: 'DARK DENIM', SIZE: 'M' },
  ]
  const aliases = {
    [aliasKey('50073', 'dark', 'S')]: {
      STYLE: '50073',
      COLOR: 'DARK DENIM',
      SIZE: 'S',
    },
  }
  const result = fillTemplate(templateRows, [
    { style: '50073', color: 'dark', size: 'M', QTY: 1 },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: '50073', COLOR: 'DARK DENIM', SIZE: 'M', QTY: 1 }],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('human-confirmed cross-style color rule reuses exact target sizes', () => {
  const aliases = {
    [aliasKey('SOURCE-1', 'Black')]: {
      STYLE: 'TARGET-9',
      COLOR: 'JET BLACK',
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: 'S' },
    { STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: 'M' },
  ], [
    { style: 'SOURCE-1', color: 'Black', size: 'M', QTY: 2 },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: 'M', QTY: 2 }],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('confirmed style and color rule supports the equivalent 1X and 1XL labels', () => {
  const aliases = {
    [aliasKey('SOURCE-1', 'Black')]: {
      STYLE: 'TARGET-9',
      COLOR: 'JET BLACK',
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: '1XL' },
  ], [
    { style: 'SOURCE-1', color: 'Black', size: '1X', QTY: 1 },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: '1XL', QTY: 1 }],
  )
})

test('confirmed style and color rule stops when target size does not exist', () => {
  const aliases = {
    [aliasKey('SOURCE-1', 'Black')]: {
      STYLE: 'TARGET-9',
      COLOR: 'JET BLACK',
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'TARGET-9', COLOR: 'JET BLACK', SIZE: 'S' },
  ], [
    { style: 'SOURCE-1', color: 'Black', size: 'M', QTY: 2 },
  ], aliases)

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'confirmed_mapping_size_missing')
})

test('existing confirmed combo mappings extend to corresponding target sizes', () => {
  const aliases = {
    [aliasKey('62300', 'set', 'S')]: {
      components: [
        { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
        { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'S' },
      ],
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
    { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'M' },
  ], [
    { style: '62300', color: 'set', size: 'M', QTY: 2, parse_issue: 'set_components_unknown' },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M', QTY: 2 },
      { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'M', QTY: 2 },
    ],
  )
  assert.equal(result.unmatchedRows.length, 0)
  assert.equal(result.stats.src_total, 4)
  assert.equal(result.stats.reconciled_total, 4)
})

test('confirmed combo stops the entire set when one target size is missing', () => {
  const aliases = {
    [aliasKey('62300', 'set')]: {
      components: [
        { STYLE: 'A100', COLOR: 'BLACK', multiplier: 1 },
        { STYLE: 'B200', COLOR: 'NAVY', multiplier: 1 },
      ],
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
    { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'S' },
  ], [
    { style: '62300', color: 'set', size: 'M', QTY: 1, parse_issue: 'set_components_unknown' },
  ], aliases)

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'confirmed_mapping_size_missing')
  assert.equal(result.stats.src_total, 2)
  assert.equal(result.stats.reconciled_total, 2)
})

test('learned mapping cannot bypass a source parsing warning', () => {
  const templateRows = [
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  ]
  const aliases = {
    [aliasKey('A100', 'Black', 'S')]: {
      STYLE: 'A100',
      COLOR: 'BLACK',
      SIZE: 'S',
    },
  }
  const result = fillTemplate(templateRows, [
    {
      style: 'A100',
      color: 'Black',
      size: 'S',
      QTY: 2,
      parse_issue: 'ambiguous_style',
    },
  ], aliases)

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows.length, 1)
  assert.equal(result.unmatchedRows[0].parseIssue, 'ambiguous_style')
})

test('invalid source quantities stop the run instead of being partially parsed', () => {
  assert.throws(
    () => fillTemplate(
      [{ STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' }],
      [{ style: 'A100', color: 'BLACK', size: 'S', QTY: '2 boxes' }],
    ),
    /Invalid quantity/,
  )
  assert.throws(
    () => consolidateRows([{ SKU: 'A100BlackS', Quantity: 'one' }]),
    /数量无效/,
  )
})

test('a confirmed style and color safely carries to sibling sizes during review', () => {
  const mappings = findAdditionalSizeMappings({
    unmatchedRows: [
      { style: 'A-100', color: 'Black', size: 'S', packCount: 1, parseIssue: 'style_identity_mismatch' },
      { style: 'A-100', color: 'Black', size: 'M', packCount: 1, parseIssue: 'style_identity_mismatch' },
      { style: 'A-100', color: 'Navy', size: 'M', packCount: 1, parseIssue: 'style_identity_mismatch' },
    ],
    templateRows: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
      { STYLE: 'A100', COLOR: 'NAVY', SIZE: 'M' },
    ],
    resolved: [null, null, null],
    sourceIndex: 0,
    targetEntry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  })

  assert.deepEqual(mappings, [{
    index: 1,
    entry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
  }])
})

test('a confirmed combo selection carries all components to sibling sizes', () => {
  const mappings = findAdditionalComboSizeMappings({
    unmatchedRows: [
      { style: '62300', color: 'set', size: 'S', packCount: 2, parseIssue: 'set_components_unknown' },
      { style: '62300', color: 'set', size: 'M', packCount: 2, parseIssue: 'set_components_unknown' },
    ],
    templateRows: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
      { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'S' },
      { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'M' },
    ],
    resolved: [null, null],
    sourceIndex: 0,
    components: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S', multiplier: 1 },
      { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'S', multiplier: 1 },
    ],
  })

  assert.deepEqual(mappings, [{
    index: 1,
    components: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M', multiplier: 1 },
      { STYLE: 'B200', COLOR: 'NAVY', SIZE: 'M', multiplier: 1 },
    ],
  }])
})
