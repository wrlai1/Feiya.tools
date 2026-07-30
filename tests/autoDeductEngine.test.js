import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aliasKey,
  calculateResolvedSourceUnits,
  countSkippedUnits,
  fillTemplate,
} from '../src/utils/autoDeductEngine.js'
import { summarizeReturnInspection } from '../src/utils/returnInspection.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'
import { findAdditionalComboSizeMappings, findAdditionalSizeMappings } from '../src/utils/autoDeductRules.js'
import {
  applyProductCatalogMapping,
  applyReturnOrderMatch,
  chooseReturnManifestSheetName,
  expandConfirmedProductSku,
  getReturnManifestOrderNumbers,
  getReturnManifestSkuIds,
  mergeAnalyticsReturnStores,
  parseProductCatalogRows,
  parseReturnManifestRows,
  parseSkuReturnManifestRows,
  resolveProductCatalogRows,
  resolveReturnManifestPackages,
  suggestProductCatalogSelections,
} from '../src/utils/returnImportEngine.js'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'

const { resolveInventoryTargets } = inventoryTargetResolution

test('returns store choices use Analytics as the canonical store list', () => {
  const stores = mergeAnalyticsReturnStores([
    { name: 'Garden', days: 30, first_day: '2026-07-01', last_day: '2026-07-30' },
    { name: 'House', days: 12 },
  ], [
    {
      store_key: 'garden',
      store_name: 'GARDEN',
      product_count: 25,
      ready_count: 24,
      order_count: 900,
    },
    {
      store_key: 'legacy store',
      store_name: 'Legacy Store',
      product_count: 10,
      ready_count: 10,
      order_count: 100,
    },
  ])

  assert.deepEqual(stores.map((store) => store.store_name), ['Garden', 'House'])
  assert.deepEqual(stores[0], {
    store_key: 'garden',
    store_name: 'Garden',
    product_count: 25,
    ready_count: 24,
    order_count: 900,
    analytics_days: 30,
    analytics_first_day: '2026-07-01',
    analytics_last_day: '2026-07-30',
  })
  assert.equal(stores[1].product_count, 0)
  assert.equal(stores[1].order_count, 0)
})

test('return inspection separates inventory, return-rate, and not-ours outcomes', () => {
  const normal = summarizeReturnInspection([
    { expectedQty: 1, goodQty: 1, damagedQty: 0, notOursQty: 0 },
  ])
  assert.deepEqual(
    { status: normal.status, actual: normal.actualUnits, restock: normal.restockUnits },
    { status: 'received', actual: 1, restock: 1 },
  )

  const damaged = summarizeReturnInspection([
    { expectedQty: 1, goodQty: 0, damagedQty: 1, notOursQty: 0 },
  ])
  assert.deepEqual(
    { status: damaged.status, actual: damaged.actualUnits, restock: damaged.restockUnits },
    { status: 'discrepancy', actual: 1, restock: 0 },
  )

  const swapped = summarizeReturnInspection([
    { expectedQty: 1, goodQty: 0, damagedQty: 0, notOursQty: 1 },
  ])
  assert.deepEqual(
    { status: swapped.status, actual: swapped.actualUnits, restock: swapped.restockUnits, notOurs: swapped.notOursUnits },
    { status: 'rejected', actual: 0, restock: 0, notOurs: 1 },
  )
})

test('return inspection supports mixed set outcomes and rejects over-counting', () => {
  const mixed = summarizeReturnInspection([
    { expectedQty: 4, goodQty: 2, damagedQty: 1, notOursQty: 1 },
  ])
  assert.deepEqual(
    {
      status: mixed.status,
      actual: mixed.actualUnits,
      restock: mixed.restockUnits,
      damaged: mixed.damagedUnits,
      notOurs: mixed.notOursUnits,
    },
    { status: 'discrepancy', actual: 3, restock: 2, damaged: 1, notOurs: 1 },
  )
  assert.throws(
    () => summarizeReturnInspection([
      { expectedQty: 1, goodQty: 1, damagedQty: 1, notOursQty: 0 },
    ]),
    /cannot exceed/,
  )
})

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

test('known 0015 and 0071 source styles route to their inventory styles', () => {
  const salesRows = consolidateRows([
    { SKU: '0015DustyBlueM', 'Product Attribute': 'Dusty Blue / M', Quantity: 2 },
    { SKU: '0071BlackL', 'Product Attribute': 'Black / L', Quantity: 1 },
  ]).consolidated

  assert.deepEqual(salesRows.map((row) => row.style), ['0015', '0071'])
  const result = fillTemplate([
    { STYLE: '5010015', COLOR: 'Dusty Blue', SIZE: 'M' },
    { STYLE: '5020071', COLOR: 'Black', SIZE: 'L' },
  ], salesRows)
  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [
      { STYLE: '5010015', COLOR: 'Dusty Blue', SIZE: 'M', QTY: 2 },
      { STYLE: '5020071', COLOR: 'Black', SIZE: 'L', QTY: 1 },
    ],
  )
})

test('known style routing keeps previously confirmed source color links valid', () => {
  const result = fillTemplate([
    { STYLE: '5010015', COLOR: 'DUSTY BLUE', SIZE: 'M' },
  ], [
    { style: '0015', color: 'dusty', size: 'M', QTY: 3 },
  ], {
    [aliasKey('0015', 'dusty')]: {
      STYLE: '5010015',
      COLOR: 'DUSTY BLUE',
      _confirmed: true,
    },
  })

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: '5010015', COLOR: 'DUSTY BLUE', SIZE: 'M', QTY: 3 }],
  )
})

test('SKU and product-attribute size or ampersand color conflicts require review', () => {
  const result = consolidateRows([
    { SKU: '73086mid1XL', 'Product Attribute': '孔雀蓝 / XL', Quantity: 2 },
    { SKU: 'M022Black&WhiteM', 'Product Attribute': 'Black&Khaki / M', Quantity: 1 },
  ])

  assert.equal(result.needsReview.length, 3)
  assert.ok(result.needsReview.some((row) => row.parse_issue === 'sku_attribute_size_conflict'))
  assert.ok(result.needsReview.every((row) =>
    /sku_attribute_size_conflict|sku_attribute_color_conflict/.test(row.parse_issue)
  ))
})

test('skipped review rows count every physical component', () => {
  assert.equal(countSkippedUnits([
    { qty: 2, packCount: 4 },
    { qty: 3, packCount: 1 },
  ]), 11)
})

test('confirmed unknown sets update the protected physical-unit source total', () => {
  assert.equal(calculateResolvedSourceUnits(10, [{
    QTY: 2,
    _isCombo: true,
    _source: { originalPackCount: 1, packCount: 4 },
  }]), 16)
  assert.equal(calculateResolvedSourceUnits(10, [{
    QTY: 2,
    _isCombo: true,
    _source: { originalPackCount: 3, packCount: 3 },
  }]), 10)
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

test('M022 routes missy, petite, and plus sizes before inventory matching', () => {
  const salesRows = consolidateRows([
    {
      SKU: 'M022Black&DenimS',
      'Product Attribute': 'Black&Denim / S',
      Quantity: 1,
    },
    {
      SKU: 'M022DenimPM',
      'Product Attribute': 'Denim / petite S',
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
    { STYLE: 'M022 Petite', COLOR: 'DENIM', SIZE: 'PS' },
    { STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '1X' },
    { STYLE: 'M022 PLUS', COLOR: 'DENIM', SIZE: '1X' },
  ], salesRows)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [
      { STYLE: 'M022 Missy', COLOR: 'BLACK', SIZE: 'S', QTY: 1 },
      { STYLE: 'M022 Missy', COLOR: 'DENIM', SIZE: 'S', QTY: 1 },
      { STYLE: 'M022 Petite', COLOR: 'DENIM', SIZE: 'PS', QTY: 1 },
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

test('apply resolves inventory capitalization without changing SKU identity', () => {
  const result = resolveInventoryTargets([
    { style: '543924', color: 'brown', size: 'L', qty: 2, allowCreate: false },
  ], [
    {
      target_index: 0,
      match_count: 1,
      matched_style: '543924',
      matched_color: 'Brown',
      matched_size: 'L',
    },
  ])

  assert.deepEqual(result.rows, [
    { style: '543924', color: 'Brown', size: 'L', qty: 2, allowCreate: false },
  ])
  assert.equal(result.missing.length, 0)
  assert.equal(result.ambiguous.length, 0)
})

test('apply fails closed when capitalization resolves to multiple inventory rows', () => {
  const result = resolveInventoryTargets([
    { style: '543924', color: 'brown', size: 'L', qty: 1, allowCreate: false },
  ], [
    { target_index: 0, match_count: 2 },
  ])

  assert.equal(result.ambiguous.length, 1)
})

test('manual create reuses an existing capitalization match and merges quantities', () => {
  const result = resolveInventoryTargets([
    { style: '543924', color: 'brown', size: 'L', qty: 1, allowCreate: true },
    { style: '543924', color: 'Brown', size: 'L', qty: 2, allowCreate: false },
  ], [
    {
      target_index: 0,
      match_count: 1,
      matched_style: '543924',
      matched_color: 'Brown',
      matched_size: 'L',
    },
    {
      target_index: 1,
      match_count: 1,
      matched_style: '543924',
      matched_color: 'Brown',
      matched_size: 'L',
    },
  ])

  assert.deepEqual(result.rows, [
    { style: '543924', color: 'Brown', size: 'L', qty: 3, allowCreate: false },
  ])
})

test('return manifests group tracking numbers and expand ampersand sets', () => {
  const result = parseReturnManifestRows([
    {
      运单号: ' 1z-return-01 ',
      SKU货号: 'M022Black&Denim&Khaki&WhiteM',
      商品属性: 'Black&Denim&Khaki&White / M',
      应履约件数: 1,
    },
    {
      运单号: '1Z-RETURN-01',
      SKU货号: 'M022WhiteM',
      商品属性: 'White / M',
      应履约件数: 1,
    },
  ])

  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].tracking, '1Z-RETURN-01')
  assert.equal(result.packages[0].expectedUnits, 5)
  const resolved = resolveReturnManifestPackages(result, [
    { STYLE: 'M022 Missy', COLOR: 'BLACK', SIZE: 'M' },
    { STYLE: 'M022 Missy', COLOR: 'DENIM', SIZE: 'M' },
    { STYLE: 'M022 Missy', COLOR: 'KHAKI', SIZE: 'M' },
    { STYLE: 'M022 Missy', COLOR: 'WHITE', SIZE: 'M' },
  ])
  assert.deepEqual(resolved.packages[0].items, [
    { style: 'M022 Missy', color: 'BLACK', size: 'M', expectedQty: 1 },
    { style: 'M022 Missy', color: 'DENIM', size: 'M', expectedQty: 1 },
    { style: 'M022 Missy', color: 'KHAKI', size: 'M', expectedQty: 1 },
    { style: 'M022 Missy', color: 'WHITE', size: 'M', expectedQty: 2 },
  ])
})

test('return manifests stop unknown non-ampersand sets for review', () => {
  const result = parseReturnManifestRows([
    { Tracking: 'RETURN-2', SKU: '53058setM', Quantity: 1 },
  ])

  assert.equal(result.packages.length, 1)
  assert.equal(result.stats.reviewPackages, 1)
  assert.equal(result.needsReview[0].parse_issue, 'set_components_unknown')
  const resolved = resolveReturnManifestPackages(result, [])
  assert.equal(resolved.packages.length, 0)
  assert.equal(resolved.stats.reviewPackages, 1)
})

test('return manifests reuse a human-confirmed combo and its corresponding size', () => {
  const parsed = parseReturnManifestRows([
    { Tracking: 'RETURN-3', SKU: '62300setM', Quantity: 1 },
  ])
  const aliases = {
    [aliasKey('62300', 'set', 'S')]: {
      components: [
        { STYLE: '62300SET', COLOR: 'BLACK', SIZE: 'S' },
        { STYLE: '62300SET', COLOR: 'DENIM', SIZE: 'S' },
        { STYLE: '62300SET', COLOR: 'KHAKI', SIZE: 'S' },
        { STYLE: '62300SET', COLOR: 'WHITE', SIZE: 'S' },
      ],
      _confirmed: true,
    },
  }
  const resolved = resolveReturnManifestPackages(parsed, [
    { STYLE: '62300SET', COLOR: 'BLACK', SIZE: 'M' },
    { STYLE: '62300SET', COLOR: 'DENIM', SIZE: 'M' },
    { STYLE: '62300SET', COLOR: 'KHAKI', SIZE: 'M' },
    { STYLE: '62300SET', COLOR: 'WHITE', SIZE: 'M' },
  ], aliases)

  assert.equal(resolved.needsReview.length, 0)
  assert.equal(resolved.packages[0].expectedUnits, 4)
  assert.deepEqual(resolved.packages[0].items, [
    { style: '62300SET', color: 'BLACK', size: 'M', expectedQty: 1 },
    { style: '62300SET', color: 'DENIM', size: 'M', expectedQty: 1 },
    { style: '62300SET', color: 'KHAKI', size: 'M', expectedQty: 1 },
    { style: '62300SET', color: 'WHITE', size: 'M', expectedQty: 1 },
  ])
})

test('return manifests require tracking on every row', () => {
  assert.throws(
    () => parseReturnManifestRows([
      { Tracking: '', SKU: 'A100BlackS', Quantity: 1 },
    ]),
    /missing a tracking number/,
  )
})

test('confirmed shorthand product SKUs expand into their physical pieces', () => {
  assert.equal(
    expandConfirmedProductSku('0015DenimDustyWhiteXL'),
    '0015Denim&Dusty Blue&WhiteXL',
  )
  assert.equal(
    expandConfirmedProductSku('0015WhtKhakiBkL'),
    '0015White&Khaki&BlackL',
  )
  assert.equal(expandConfirmedProductSku('0066Nile3XL'), '0066Nile3XL')
})

test('store product catalogs preserve SKU IDs and resolve physical components', () => {
  const catalog = parseProductCatalogRows([
    { 'SKU ID': 57081504942, SKU货号: '0015DenimDustyWhiteXL' },
  ])
  const resolved = resolveProductCatalogRows(catalog, [
    { STYLE: '5010015', COLOR: 'Denim', SIZE: 'XL' },
    { STYLE: '5010015', COLOR: 'Dusty Blue', SIZE: 'XL' },
    { STYLE: '5010015', COLOR: 'White', SIZE: 'XL' },
  ])

  assert.equal(resolved[0].skuId, '57081504942')
  assert.equal(resolved[0].status, 'ready')
  assert.deepEqual(resolved[0].components, [
    { style: '5010015', color: 'Denim', size: 'XL', qty: 1 },
    { style: '5010015', color: 'Dusty Blue', size: 'XL', qty: 1 },
    { style: '5010015', color: 'White', size: 'XL', qty: 1 },
  ])
})

test('manual product mapping carries the same confirmed colors to sibling sizes', () => {
  const catalogRows = [
    {
      skuId: 'SKU-S',
      skuCode: 'M017Navy&KhakiS',
      status: 'review',
      issue: 'inventory_target_missing',
      components: [],
      sourceComponents: [
        { style: 'M017', color: 'navy', size: 'S', qty: 1 },
        { style: 'M017', color: 'khaki', size: 'S', qty: 1 },
      ],
    },
    {
      skuId: 'SKU-M',
      skuCode: 'M017Navy&KhakiM',
      status: 'review',
      issue: 'inventory_target_missing',
      components: [],
      sourceComponents: [
        { style: 'M017', color: 'navy', size: 'M', qty: 1 },
        { style: 'M017', color: 'khaki', size: 'M', qty: 1 },
      ],
    },
    {
      skuId: 'SKU-X',
      skuCode: 'XM017Navy&KhakiXL',
      status: 'review',
      issue: 'inventory_target_missing',
      components: [],
      sourceComponents: [
        { style: 'XM017', color: 'navy', size: 'XL', qty: 1 },
        { style: 'XM017', color: 'khaki', size: 'XL', qty: 1 },
      ],
    },
  ]
  const inventoryRows = ['S', 'M', 'XL'].flatMap((size) => [
    { STYLE: 'M017-MISSY', COLOR: 'DEEP BLUE #3455 slub', SIZE: size },
    { STYLE: 'M017-MISSY', COLOR: 'KHAKI #3455 slub', SIZE: size },
  ])

  const result = applyProductCatalogMapping(catalogRows, 'SKU-S', [
    { style: 'M017-MISSY', color: 'DEEP BLUE #3455 slub' },
    { style: 'M017-MISSY', color: 'KHAKI #3455 slub' },
  ], inventoryRows)

  assert.deepEqual(result.updatedSkuIds, ['SKU-S', 'SKU-M'])
  assert.equal(result.rows[0].status, 'ready')
  assert.equal(result.rows[1].status, 'ready')
  assert.equal(result.rows[2].status, 'review')
  assert.deepEqual(result.rows[1].components, [
    { style: 'M017-MISSY', color: 'DEEP BLUE #3455 slub', size: 'M', qty: 1 },
    { style: 'M017-MISSY', color: 'KHAKI #3455 slub', size: 'M', qty: 1 },
  ])
})

test('unresolved product combos retain their source components for upload-time review', () => {
  const [row] = resolveProductCatalogRows([
    { skuId: 'M017-S', skuCode: 'M017Navy&Fuchsia&Khaki&WhiteS' },
  ], [])

  assert.equal(row.status, 'review')
  assert.equal(row.issue, 'inventory_target_missing')
  assert.deepEqual(
    row.sourceComponents.map((component) => component.color).sort(),
    ['fuchsia', 'khaki', 'navy', 'white'],
  )
})

test('unresolved product review reuses Auto Deduct matches component by component', () => {
  const inventoryRows = [
    { STYLE: 'M017-MISSY', COLOR: 'KHAKI #3455 slub', SIZE: 'S' },
    { STYLE: 'M017-MISSY', COLOR: 'DEEP BLUE #3455 slub', SIZE: 'S' },
  ]
  const aliases = {
    [aliasKey('M017', 'navy')]: {
      STYLE: 'M017-MISSY',
      COLOR: 'DEEP BLUE #3455 slub',
      _confirmed: true,
    },
  }

  const selections = suggestProductCatalogSelections([
    { style: 'M017-MISSY', color: 'KHAKI #3455 slub', size: 'S' },
    { style: 'M017', color: 'navy', size: 'S' },
    { style: 'M017', color: 'silver', size: 'S' },
  ], inventoryRows, aliases)

  assert.deepEqual(
    selections.map(({ matchedBy, ...selection }) => selection),
    [
      { style: 'M017-MISSY', color: 'KHAKI #3455 slub' },
      { style: 'M017-MISSY', color: 'DEEP BLUE #3455 slub' },
      {},
    ],
  )
  assert.equal(selections[1].matchedBy, 'confirmed')
})

test('SKU return manifests group tracking and retain store-facing return details', () => {
  const result = parseSkuReturnManifestRows([
    {
      '订单号 PO': 'PO-1',
      'SKU ID': 57081504942,
      退货原因: '太大',
      买家备注: '需要小一码',
      '运单号 Tracking Number': ' 1z-store-return ',
      物流商: 'UPS',
    },
  ], [{
    sku_id: '57081504942',
    sku_code: '0015DenimDustyWhiteXL',
    status: 'ready',
    components: [
      { style: '0015', color: 'Denim', size: 'XL', qty: 1 },
      { style: '0015', color: 'Dusty Blue', size: 'XL', qty: 1 },
      { style: '0015', color: 'White', size: 'XL', qty: 1 },
    ],
  }])

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.packages[0].tracking, '1Z-STORE-RETURN')
  assert.equal(result.packages[0].expectedUnits, 3)
  assert.deepEqual(result.packages[0].orders, ['PO-1'])
  assert.deepEqual(result.packages[0].reasons, ['太大'])
  assert.deepEqual(result.packages[0].buyerRemarks, ['需要小一码'])
  assert.equal(result.packages[0].carrier, 'UPS')
})

test('one combined return manifest assigns each tracking to its SKU catalog store', () => {
  const rows = [
    { 'SKU ID': 'GARDEN-SKU', '运单号 Tracking Number': 'TRACK-GARDEN' },
    { 'SKU ID': 'HOUSE-SKU', '运单号 Tracking Number': 'TRACK-HOUSE' },
  ]
  const result = parseSkuReturnManifestRows(rows, [
    {
      store_name: 'Garden',
      store_key: 'garden',
      sku_id: 'GARDEN-SKU',
      sku_code: 'A100BlackS',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
    },
    {
      store_name: 'House',
      store_key: 'house',
      sku_id: 'HOUSE-SKU',
      sku_code: 'B200NavyM',
      status: 'ready',
      components: [{ style: 'B200', color: 'Navy', size: 'M', qty: 1 }],
    },
  ])

  assert.deepEqual(getReturnManifestSkuIds(rows), ['GARDEN-SKU', 'HOUSE-SKU'])
  assert.equal(result.needsReview.length, 0)
  assert.equal(result.stats.storeCount, 2)
  assert.deepEqual(
    result.packages.map((pkg) => [pkg.tracking, pkg.storeName, pkg.storeKey]),
    [
      ['TRACK-GARDEN', 'Garden', 'garden'],
      ['TRACK-HOUSE', 'House', 'house'],
    ],
  )
})

test('one tracking containing SKUs from different stores fails closed for review', () => {
  const result = parseSkuReturnManifestRows([
    { 'SKU ID': 'GARDEN-SKU', '运单号 Tracking Number': 'TRACK-MIXED' },
    { 'SKU ID': 'HOUSE-SKU', '运单号 Tracking Number': 'TRACK-MIXED' },
  ], [
    {
      store_name: 'Garden',
      store_key: 'garden',
      sku_id: 'GARDEN-SKU',
      sku_code: 'A100BlackS',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
    },
    {
      store_name: 'House',
      store_key: 'house',
      sku_id: 'HOUSE-SKU',
      sku_code: 'B200NavyM',
      status: 'ready',
      components: [{ style: 'B200', color: 'Navy', size: 'M', qty: 1 }],
    },
  ])

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 1)
  assert.equal(result.reviewPackages[0].storeName, 'Unresolved')
  assert.ok(result.needsReview.some((row) => row.parse_issue === 'tracking_cross_store'))
})

test('a SKU ID found in more than one store is never assigned automatically', () => {
  const result = parseSkuReturnManifestRows([
    { 'SKU ID': 'DUPLICATE-SKU', '运单号 Tracking Number': 'TRACK-AMBIGUOUS' },
  ], [
    {
      store_name: 'Garden',
      store_key: 'garden',
      sku_id: 'DUPLICATE-SKU',
      sku_code: 'A100BlackS',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
    },
    {
      store_name: 'House',
      store_key: 'house',
      sku_id: 'DUPLICATE-SKU',
      sku_code: 'A100BlackS',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
    },
  ])

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages[0].storeName, 'Unresolved')
  assert.equal(result.needsReview[0].parse_issue, 'sku_id_store_ambiguous')
})

test('daily house-return workbooks prefer the flat detail sheet', () => {
  assert.equal(
    chooseReturnManifestSheetName(['退货汇总', '退货明细汇总']),
    '退货明细汇总',
  )
  assert.equal(
    chooseReturnManifestSheetName(['TEMU-STYLES', 'Other']),
    'TEMU-STYLES',
  )
})

test('SKU return manifests split multiple SKU IDs from one spreadsheet cell', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-MULTI',
    'SKU ID': 'SKU-A\nSKU-B',
    '运单号 Tracking Number': 'RETURN-MULTI',
  }], [
    {
      sku_id: 'SKU-A',
      sku_code: 'A100BlackS',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
    },
    {
      sku_id: 'SKU-B',
      sku_code: 'B200NavyM',
      status: 'ready',
      components: [{ style: 'B200', color: 'Navy', size: 'M', qty: 1 }],
    },
  ])

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].expectedUnits, 2)
  assert.deepEqual(
    result.packages[0].items.map((item) => item.skuId),
    ['SKU-A', 'SKU-B'],
  )
})

test('SKU return manifests isolate missing catalog data without blocking ready packages', () => {
  const result = parseSkuReturnManifestRows([
    { 'SKU ID': 'KNOWN', '运单号 Tracking Number': 'READY-1' },
    { 'SKU ID': '', '运单号 Tracking Number': 'REVIEW-1' },
    { 'SKU ID': 'KNOWN', '运单号 Tracking Number': '' },
  ], [{
    sku_id: 'KNOWN',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }])

  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].tracking, 'READY-1')
  assert.equal(result.needsReview.length, 1)
  assert.equal(result.needsReview[0].parse_issue, 'sku_id_missing')
  assert.equal(result.waitingForTracking.length, 1)
  assert.equal(result.waitingForTracking[0].parse_issue, 'tracking_pending')
  assert.equal(result.stats.waitingForTracking, 1)
})

test('unresolved return SKU mappings retain the SKU code and quantity for Admin Review', () => {
  const result = parseSkuReturnManifestRows([
    {
      'SKU ID': 'SKU-REVIEW',
      '运单号 Tracking Number': 'RETURN-REVIEW-MAP',
      Quantity: '2',
    },
    {
      'SKU ID': 'SKU-REVIEW',
      '运单号 Tracking Number': 'RETURN-REVIEW-MAP',
      Quantity: '1',
    },
  ], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-REVIEW',
    sku_code: 'A-100DustyBlueM',
    status: 'review',
    issue: 'inventory_target_missing',
    components: [],
  }])

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 1)
  assert.deepEqual(result.reviewPackages[0].reviewData, {
    unresolvedSkus: [{
      skuId: 'SKU-REVIEW',
      skuCode: 'A-100DustyBlueM',
      quantity: 3,
      issue: 'inventory_target_missing',
    }],
    blockingIssues: [],
  })
  assert.equal(result.reviewPackages[0].storeName, 'House')
})

test('a remembered return SKU mapping is reused without another Admin Review', () => {
  const result = parseSkuReturnManifestRows([{
    'SKU ID': 'SKU-REMEMBERED',
    '运单号 Tracking Number': 'RETURN-REMEMBERED',
    Quantity: '2',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-REMEMBERED',
    sku_code: 'SET-UNKNOWN',
    status: 'ready',
    components: [
      { style: 'A100', color: 'Black', size: 'M', qty: 1 },
      { style: 'B200', color: 'Navy', size: 'M', qty: 2 },
    ],
  }])

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages[0].expectedUnits, 6)
  assert.deepEqual(result.packages[0].items.map((item) => item.expectedQty), [2, 4])
})

test('missing return SKU IDs show every original SKU and require a selection for multi-SKU orders', () => {
  const rows = [
    {
      '订单号 PO': ' PO-RECOVER-1 ',
      'SKU ID': '',
      '运单号 Tracking Number': 'RETURN-RECOVER-1',
    },
    {
      '订单号 PO': 'PO-RECOVER-1-D01',
      'SKU ID': '',
      '运单号 Tracking Number': 'RETURN-RECOVER-1',
    },
  ]
  const parsed = parseSkuReturnManifestRows(rows, [
    {
      sku_id: 'SKU-A',
      sku_code: 'A100BlackM',
      status: 'ready',
      components: [{ style: 'A100', color: 'Black', size: 'M', qty: 1 }],
    },
    {
      sku_id: 'SKU-B',
      sku_code: 'B200NavyL',
      status: 'ready',
      components: [{ style: 'B200', color: 'Navy', size: 'L', qty: 1 }],
    },
  ], [{
    order_number: 'PO-RECOVER-1',
    items: [
      { sku_id: 'SKU-A', quantity: 1 },
      { sku_id: 'SKU-B', quantity: 2 },
    ],
  }])

  assert.deepEqual(getReturnManifestOrderNumbers(rows), ['PO-RECOVER-1', 'PO-RECOVER-1-D01'])
  assert.equal(parsed.packages.length, 0)
  assert.equal(parsed.reviewPackages.length, 1)
  assert.equal(parsed.reviewPackages[0].requiresItemResolution, true)
  assert.equal(parsed.pendingOrderMatches.length, 1)
  assert.equal(parsed.pendingOrderMatches[0].candidateOrders[0].candidates.length, 2)
  assert.equal(parsed.needsReview[0].parse_issue, 'order_has_multiple_skus')

  const candidates = parsed.pendingOrderMatches[0].candidateOrders[0].candidates
  const result = applyReturnOrderMatch(parsed, 'RETURN-RECOVER-1', {
    [candidates[0].candidateKey]: 1,
    [candidates[1].candidateKey]: 2,
  })

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.pendingOrderMatches.length, 0)
  assert.equal(result.stats.recoveredPackages, 1)
  assert.equal(result.packages[0].expectedUnits, 3)
  assert.deepEqual(result.packages[0].items, [
    { skuId: 'SKU-A', skuCode: 'A100BlackM', style: 'A100', color: 'Black', size: 'M', expectedQty: 1 },
    { skuId: 'SKU-B', skuCode: 'B200NavyL', style: 'B200', color: 'Navy', size: 'L', expectedQty: 2 },
  ])
})

test('a single-SKU order safely fills a missing return SKU without a selection', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-SINGLE-D02',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-SINGLE',
  }], [{
    sku_id: 'SKU-ONLY',
    sku_code: 'A100BlackM',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'M', qty: 1 }],
  }], [{
    order_number: 'PO-SINGLE',
    items: [{ sku_id: 'SKU-ONLY', quantity: 1 }],
  }])

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.pendingOrderMatches.length, 0)
  assert.equal(result.stats.recoveredPackages, 1)
  assert.equal(result.packages[0].items[0].skuId, 'SKU-ONLY')
})

test('missing return SKU stays in review when its order history is unavailable', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-NOT-UPLOADED',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-REVIEW-1',
  }], [], [])

  assert.equal(result.packages.length, 0)
  assert.equal(result.needsReview[0].orderNumber, 'PO-NOT-UPLOADED')
  assert.equal(result.needsReview[0].parse_issue, 'order_history_missing')
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
