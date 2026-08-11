import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aliasKey,
  calculateResolvedSourceUnits,
  countSkippedUnits,
  fillTemplate,
  reviewAliasKey,
} from '../src/utils/autoDeductEngine.js'
import {
  collectReturnSkuMappingCandidates,
  manualReturnSkuMappingRows,
  returnReviewMappingLoadMode,
  summarizeReturnInspection,
} from '../src/utils/returnInspection.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'
import { findAdditionalComboSizeMappings, findAdditionalSizeMappings } from '../src/utils/autoDeductRules.js'
import {
  applyProductCatalogMapping,
  applyReturnOrderMatch,
  chooseReturnManifestSheetName,
  expandConfirmedProductSku,
  getHistoricalOrderSkuIds,
  getHistoricalOrderSkuCodes,
  getReturnManifestOrderNumbers,
  getReturnManifestSkuIds,
  mergeAnalyticsReturnStores,
  parseProductCatalogRows,
  parseReturnManifestRows,
  parseSkuReturnManifestRows,
  resolveStyleSearchValue,
  resolveProductCatalogRows,
  resolveReturnManifestPackages,
  suggestProductCatalogSelections,
} from '../src/utils/returnImportEngine.js'
import inventoryTargetResolution from '../lib/inventoryTargetResolution.cjs'
import returnPackageSafety from '../lib/returnPackageSafety.cjs'

const { resolveInventoryTargets } = inventoryTargetResolution
const {
  buildReturnItemsForOrderSelection,
  findReturnSkuMappingTarget,
  mergeInventoryComponents,
  mergeReturnPackageItems,
  normalizeManualReturnDraft,
  normalizeManualReturnPackageItems,
} = returnPackageSafety

test('manual return drafts preserve the typed tracking and require one validated store', () => {
  assert.deepEqual(normalizeManualReturnDraft({
    trackingNumber: ' 1z manual 123 ',
    storeName: 'House',
    storeKey: 'house',
    username: 'worker1',
  }), {
    tracking_number: '1z manual 123',
    tracking_key: '1ZMANUAL123',
    store_name: 'House',
    store_key: 'house',
    source_file: 'Manual tracking entry',
    status: 'pending',
    expected_units: 0,
    uploaded_by: 'worker1',
    review_reason: 'manual_tracking_no_order',
    requires_item_resolution: true,
    review_data: {
      unresolvedSkus: [],
      blockingIssues: ['manual_tracking_no_order'],
      workerInspection: null,
    },
  })
  assert.throws(
    () => normalizeManualReturnDraft({ trackingNumber: '', storeName: 'House', storeKey: 'house' }),
    /tracking/i,
  )
  assert.throws(
    () => normalizeManualReturnDraft({ trackingNumber: 'MANUAL-1', storeName: '', storeKey: '' }),
    /store/i,
  )
  assert.throws(
    () => normalizeManualReturnDraft({
      trackingNumber: 'MANUAL-1', storeName: 'All Stores', storeKey: 'all stores',
    }),
    /store/i,
  )
})

test('searchable style matching canonicalizes an exact typed style without guessing partial text', () => {
  const options = ['5010015', 'A-100', 'M022']
  assert.equal(resolveStyleSearchValue(options, '  a-100  '), 'A-100')
  assert.equal(resolveStyleSearchValue(options, '501'), '501')
  assert.equal(resolveStyleSearchValue(options, 'unknown'), 'unknown')
})

test('an order item without a SKU ID can use a validated per-package inventory mapping', () => {
  const orderItem = {
    id: 91,
    sku_id: '',
    sku_code: '5020066SkivvyPinkXL',
    quantity: 1,
    catalog_status: null,
    catalog_components: [],
  }

  assert.deepEqual(buildReturnItemsForOrderSelection(orderItem, 1, [{
    style: '5020066', color: 'SKIVVY PINK', size: 'XL', qty: 1,
  }]), [{
    sku_id: '',
    sku_code: '5020066SkivvyPinkXL',
    style: '5020066',
    color: 'SKIVVY PINK',
    size: 'XL',
    expected_qty: 1,
    source_qty: 1,
  }])
  assert.throws(
    () => buildReturnItemsForOrderSelection(orderItem, 1, []),
    /inventory mapping/i,
  )
})

test('a ready order-item catalog mapping cannot be silently overridden per package', () => {
  const orderItem = {
    sku_id: 'READY-SKU',
    sku_code: 'READY-CODE',
    quantity: 2,
    catalog_status: 'ready',
    catalog_components: [{ style: 'A100', color: 'BLACK', size: 'M', qty: 1 }],
  }
  assert.deepEqual(buildReturnItemsForOrderSelection(orderItem, 2, []), [{
    sku_id: 'READY-SKU',
    sku_code: 'READY-CODE',
    style: 'A100',
    color: 'BLACK',
    size: 'M',
    expected_qty: 2,
    source_qty: 2,
  }])
  assert.throws(
    () => buildReturnItemsForOrderSelection(orderItem, 1, [
      { style: 'B200', color: 'NAVY', size: 'M', qty: 1 },
    ]),
    /already has a catalog mapping/i,
  )
})

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

test('an unmapped PO product becomes an Admin mapping choice before quantity selection', () => {
  const candidates = collectReturnSkuMappingCandidates([], [{
    sku_id: '49366961164',
    sku_code: 'ER100SetM',
    quantity: 2,
    catalog_status: null,
  }, {
    sku_id: 'READY-SKU',
    sku_code: 'READY-M',
    quantity: 1,
    catalog_status: 'ready',
  }])

  assert.deepEqual(candidates, [{
    skuId: '49366961164',
    skuCode: 'ER100SetM',
    returnQuantity: 2,
    reviewIssue: 'product_catalog_mapping_required',
  }])
})

test('manifest SKU review takes precedence over a duplicate PO mapping candidate', () => {
  const candidates = collectReturnSkuMappingCandidates([{
    skuId: '49366961164',
    skuCode: 'ER100SetM',
    quantity: 1,
    issue: 'inventory_target_missing',
  }], [{
    sku_id: '49366961164',
    sku_code: 'OLD-CODE',
    quantity: 2,
    catalog_status: null,
  }])

  assert.deepEqual(candidates, [{
    skuId: '49366961164',
    skuCode: 'ER100SetM',
    returnQuantity: 1,
    reviewIssue: 'inventory_target_missing',
  }])
})

test('mixed missing-ID and SKU mapping review loads SKU controls instead of an empty panel', () => {
  assert.equal(returnReviewMappingLoadMode({
    skuMappingCandidateCount: 1,
    requiresOrderItemManualMappings: true,
  }), 'sku')
  assert.equal(returnReviewMappingLoadMode({
    skuMappingCandidateCount: 0,
    requiresOrderItemManualMappings: true,
  }), 'inventory')
  assert.equal(returnReviewMappingLoadMode({}), 'none')
})

test('failed automatic SKU parsing always leaves a manual mapping row', () => {
  assert.deepEqual(manualReturnSkuMappingRows([{
    skuId: '90311037913',
    skuCode: '0090surf+denim+pearl XL',
    returnQuantity: 1,
    reviewIssue: 'sku_not_in_claimed_order',
  }]), [{
    skuId: '90311037913',
    skuCode: '0090surf+denim+pearl XL',
    returnQuantity: 1,
    reviewIssue: 'sku_not_in_claimed_order',
    status: 'review',
    issue: 'sku_not_in_claimed_order',
    components: [],
    sourceComponents: [],
  }])
})

test('Admin item resolution preserves already identified return items', () => {
  const items = mergeReturnPackageItems([
    {
      sku_id: 'KNOWN-SKU',
      sku_code: 'A100BlackM',
      style: 'A100',
      color: 'Black',
      size: 'M',
      expected_qty: 1,
      source_qty: 1,
    },
  ], [{
    sku_id: 'RECOVERED-SKU',
    sku_code: 'B200NavyL',
    style: 'B200',
    color: 'Navy',
    size: 'L',
    expected_qty: 2,
    source_qty: 2,
  }])

  assert.deepEqual(items.map((item) => item.sku_id), ['KNOWN-SKU', 'RECOVERED-SKU'])
  assert.equal(items.reduce((sum, item) => sum + item.expected_qty, 0), 3)
})

test('return item merging keeps product-unit coverage only when every source quantity is known', () => {
  const covered = mergeReturnPackageItems([{
    sku_id: 'SET-1',
    sku_code: 'SET1M',
    style: 'SET1',
    color: 'Black',
    size: 'M',
    expected_qty: 1,
    source_qty: 1,
  }], [{
    sku_id: 'SET-1',
    sku_code: 'SET1M',
    style: 'SET1',
    color: 'Black',
    size: 'M',
    expected_qty: 2,
    source_qty: 2,
  }])
  assert.equal(covered[0].expected_qty, 3)
  assert.equal(covered[0].source_qty, 3)

  const legacyMixed = mergeReturnPackageItems(covered, [{
    sku_id: 'SET-1',
    sku_code: 'SET1M',
    style: 'SET1',
    color: 'Black',
    size: 'M',
    expected_qty: 1,
    source_qty: null,
  }])
  assert.equal(legacyMixed[0].expected_qty, 4)
  assert.equal(legacyMixed[0].source_qty, null)
})

test('admin return combinations keep multiple inventory targets and merge duplicate selections', () => {
  const components = mergeInventoryComponents([
    { style: '62300SET', color: 'BLACK', size: '1X', qty: 1 },
    { style: '62300SET', color: 'DENIM', size: '1X', qty: 1 },
    { style: '62300SET', color: 'black', size: '1XL', qty: 2 },
  ])

  assert.deepEqual(components, [
    { style: '62300SET', color: 'BLACK', size: '1X', qty: 3 },
    { style: '62300SET', color: 'DENIM', size: '1X', qty: 1 },
  ])
})

test('Admin missing-PO selections become audited return items and merge duplicate targets', () => {
  const items = normalizeManualReturnPackageItems([
    { style: 'A100', color: 'BLACK', size: 'S', qty: 1 },
    { style: 'A100', color: 'black', size: 'S', qty: 2 },
    { style: 'B200', color: 'NAVY', size: 'M', qty: 1 },
  ])

  assert.deepEqual(items, [
    {
      sku_id: '',
      sku_code: 'Admin manual selection (PO not found)',
      style: 'A100',
      color: 'BLACK',
      size: 'S',
      expected_qty: 3,
      source_qty: 3,
    },
    {
      sku_id: '',
      sku_code: 'Admin manual selection (PO not found)',
      style: 'B200',
      color: 'NAVY',
      size: 'M',
      expected_qty: 1,
      source_qty: 1,
    },
  ])
})

test('Admin missing-PO selections reject incomplete or unsafe inventory quantities', () => {
  assert.throws(
    () => normalizeManualReturnPackageItems([
      { style: 'A100', color: '', size: 'S', qty: 1 },
    ]),
    /Invalid inventory component/,
  )
  assert.throws(
    () => normalizeManualReturnPackageItems([
      { style: 'A100', color: 'BLACK', size: 'S', qty: 1.5 },
    ]),
    /Invalid inventory component/,
  )
})

test('Admin can map an unmapped PO SKU without treating its ordered quantity as returned', () => {
  const target = findReturnSkuMappingTarget([], [{
    items: [{
      sku_id: '49366961164',
      sku_code: 'ER100SetM',
      quantity: 2,
      catalog_status: null,
    }],
  }], '49366961164')

  assert.deepEqual(target, {
    kind: 'unmapped_order_sku',
    skuCode: 'ER100SetM',
    quantity: null,
    unresolvedSku: null,
  })
})

test('Admin cannot remap a PO SKU that already has a ready catalog mapping', () => {
  const target = findReturnSkuMappingTarget([], [{
    items: [{
      sku_id: '49366961164',
      sku_code: 'ER100SetM',
      quantity: 2,
      catalog_status: 'ready',
    }],
  }], '49366961164')

  assert.equal(target, null)
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
  assert.equal(result.unmatchedRows[0].sourceIssue, undefined)
})

test('remembered new mapping reuses the unique normalized inventory target', () => {
  const aliases = {
    [aliasKey('95536', 'blackwhiteflw', 'S')]: {
      STYLE: '95536',
      COLOR: 'blackwhiteflw',
      SIZE: 'S',
      _isNew: true,
      _confirmed: true,
    },
  }
  const result = fillTemplate([
    { STYLE: '95536', COLOR: 'Black White FLW', SIZE: 'S' },
  ], [
    { style: '95536', color: 'blackwhiteflw', size: 'S', QTY: 2 },
  ], aliases)

  assert.deepEqual(
    result.filledRows.filter((row) => row.QTY),
    [{ STYLE: '95536', COLOR: 'Black White FLW', SIZE: 'S', QTY: 2 }],
  )
  assert.equal(result.unmatchedRows.length, 0)
})

test('remembered new mapping requires review when its inventory target no longer exists', () => {
  const aliases = {
    [aliasKey('95536', 'blackwhiteflw', 'S')]: {
      STYLE: '95536',
      COLOR: 'blackwhiteflw',
      SIZE: 'S',
      _isNew: true,
      _confirmed: true,
    },
  }
  const result = fillTemplate([], [
    { style: '95536', color: 'blackwhiteflw', size: 'S', QTY: 2 },
  ], aliases)

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'confirmed_new_target_missing')
  assert.equal(result.stats.reconciled_total, 2)
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

test('an exact reviewed source conflict is remembered without weakening other rows', () => {
  const firstSource = consolidateRows([{
    SKU: 'A100BlackS',
    'Product Attribute': 'Black / M',
    Quantity: 2,
  }]).consolidated[0]
  assert.equal(firstSource.parse_issue, 'sku_attribute_size_conflict')
  assert.ok(firstSource.source_signature)

  const aliases = {
    [reviewAliasKey(
      firstSource.style,
      firstSource.color,
      firstSource.size,
      firstSource.source_signature,
      firstSource.parse_issue,
    )]: {
      STYLE: 'A100',
      COLOR: 'BLACK',
      SIZE: 'S',
      _confirmed: true,
      _sourceSignature: firstSource.source_signature,
      _confirmedIssues: firstSource.parse_issue,
    },
  }
  const remembered = fillTemplate([
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  ], [firstSource], aliases)

  assert.deepEqual(
    remembered.filledRows.filter((row) => row.QTY),
    [{ STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S', QTY: 2 }],
  )
  assert.equal(remembered.unmatchedRows.length, 0)

  const changedSource = consolidateRows([{
    SKU: 'A100BlackS',
    'Product Attribute': 'Black / L',
    Quantity: 2,
  }]).consolidated[0]
  const blocked = fillTemplate([
    { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  ], [changedSource], aliases)

  assert.equal(blocked.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(blocked.unmatchedRows[0].parseIssue, 'sku_attribute_size_conflict')

  const missingTarget = fillTemplate([], [firstSource], aliases)
  assert.equal(missingTarget.unmatchedRows[0].parseIssue, 'confirmed_mapping_size_missing')
  assert.equal(missingTarget.unmatchedRows[0].sourceIssue, 'sku_attribute_size_conflict')
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

test('sales movements retain order business days after consolidation and matching', () => {
  const sales = consolidateRows([
    { SKU: 'A100BlackS', Quantity: 2, '订单创建时间': '2026-08-03 10:00:00' },
    { SKU: 'A100BlackS', Quantity: 3, '订单创建时间': '2026-08-04T23:30:00-04:00' },
  ]).consolidated
  assert.deepEqual(sales.map((row) => [row.QTY, row.business_day]), [
    [2, '2026-08-03'],
    [3, '2026-08-04'],
  ])

  const result = fillTemplate([
    { STYLE: 'A100', COLOR: 'black', SIZE: 'S' },
  ], sales)
  assert.equal(result.filledRows[0].QTY, 5)
  assert.deepEqual(result.matchLog.map((row) => [row.qty, row.businessDay]), [
    [2, '2026-08-03'],
    [3, '2026-08-04'],
  ])
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

test('manual create remains eligible to insert when no inventory target exists', () => {
  const result = resolveInventoryTargets([
    { style: '95536', color: 'blackwhiteflw', size: 'S', qty: 2, allowCreate: true },
  ], [
    { target_index: 0, match_count: 0 },
  ])

  assert.deepEqual(result.rows, [
    { style: '95536', color: 'blackwhiteflw', size: 'S', qty: 2, allowCreate: true },
  ])
  assert.equal(result.missing.length, 0)
  assert.equal(result.ambiguous.length, 0)
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
  }], [{
    order_number: 'PO-1',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [{ sku_id: '57081504942', quantity: 1 }],
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

test('catalog lookup includes SKU IDs recovered from uploaded PO history', () => {
  assert.deepEqual(getHistoricalOrderSkuIds([
    {
      order_number: 'PO-211-08941757031032991',
      items: [
        { sku_id: 'RECOVERED-SKU' },
        { sku_id: 'RECOVERED-SKU' },
        { sku_id: '' },
      ],
    },
    { order_number: 'PO-OTHER', items: [{ skuId: 'SECOND-SKU' }] },
  ]), ['RECOVERED-SKU', 'SECOND-SKU'])
})

test('catalog lookup includes exact SKU codes recovered from uploaded PO history', () => {
  assert.deepEqual(getHistoricalOrderSkuCodes([
    {
      order_number: 'PO-1',
      items: [
        { sku_code: 'A100BlackS' },
        { sku_code: 'A100BlackS' },
        { skuCode: 'B200NavyM' },
      ],
    },
  ]), ['A100BlackS', 'B200NavyM'])
})

test('one tracking containing SKUs from different stores requires an explicit store choice', () => {
  const rows = [
    { 'SKU ID': 'GARDEN-SKU', '运单号 Tracking Number': 'TRACK-MIXED' },
    { 'SKU ID': 'HOUSE-SKU', '运单号 Tracking Number': 'TRACK-MIXED' },
  ]
  const catalog = [
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
  ]
  const result = parseSkuReturnManifestRows(rows, catalog)

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.pendingUploadDecisions.length, 1)
  assert.equal(result.pendingUploadDecisions[0].issue, 'store_unresolved')

  const resolved = parseSkuReturnManifestRows(rows, catalog, [], {
    storeByTracking: {
      'TRACK-MIXED': { key: 'house', name: 'House' },
    },
  })

  assert.equal(resolved.pendingUploadDecisions.length, 0)
  assert.equal(resolved.packages.length, 0)
  assert.equal(resolved.reviewPackages.length, 1)
  assert.equal(resolved.reviewPackages[0].storeKey, 'house')
  assert.ok(
    resolved.reviewPackages[0].reviewData.blockingIssues.includes(
      'sku_id_not_in_selected_store_catalog',
    ),
  )
})

test('a SKU ID found in more than one store is never assigned automatically', () => {
  const rows = [
    { 'SKU ID': 'DUPLICATE-SKU', '运单号 Tracking Number': 'TRACK-AMBIGUOUS' },
  ]
  const catalog = [
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
  ]
  const result = parseSkuReturnManifestRows(rows, catalog)

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.pendingUploadDecisions.length, 1)
  assert.equal(result.pendingUploadDecisions[0].tracking, 'TRACK-AMBIGUOUS')
  assert.equal(result.pendingUploadDecisions[0].issue, 'store_unresolved')
  assert.deepEqual(result.pendingUploadDecisions[0].reviewIssues, ['sku_id_store_ambiguous'])
  assert.deepEqual(result.pendingUploadDecisions[0].catalogStores, ['Garden', 'House'])

  const resolved = parseSkuReturnManifestRows(rows, catalog, [], {
    storeByTracking: {
      'TRACK-AMBIGUOUS': { key: 'house', name: 'House' },
    },
  })

  assert.equal(resolved.pendingUploadDecisions.length, 0)
  assert.equal(resolved.reviewPackages.length, 0)
  assert.equal(resolved.packages.length, 1)
  assert.equal(resolved.packages[0].storeKey, 'house')
})

test('a new return tracking never overrides the uploaded original PO', () => {
  const rows = [{
    '订单号 PO': 'PO-WRONG',
    'SKU ID': 'SKU-A',
    '运单号 Tracking Number': 'track-correct',
  }]
  const catalog = [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-A',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }]
  const orders = [{
    order_number: 'PO-WRONG',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-A', quantity: 1, outbound_trackings: ['TRACK-WRONG'] }],
  }, {
    order_number: 'PO-CORRECT',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-A', quantity: 1, outbound_trackings: [' TRACK-CORRECT '] }],
  }]

  const result = parseSkuReturnManifestRows(rows, catalog, orders)

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.deepEqual(result.packages[0].orders, ['PO-WRONG'])
})

test('a manifest SKU outside the claimed PO is sent to Admin Review', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-CLAIMED',
    'SKU ID': 'SKU-RETURNED',
    '运单号 Tracking Number': 'RETURN-PO-SKU-MISMATCH',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-RETURNED',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-CLAIMED',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-ORDERED', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 1)
  assert.deepEqual(
    result.reviewPackages[0].reviewData.blockingIssues,
    ['sku_not_in_claimed_order'],
  )
})

test('a current All Stores PO prevents a stale Store snapshot from rejecting its SKU', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-DUPLICATE-D01',
    'SKU ID': 'SKU-CURRENT',
    '运单号 Tracking Number': 'RETURN-DUPLICATE',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-CURRENT',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-DUPLICATE',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-STALE', quantity: 1 }],
  }, {
    order_number: 'PO-DUPLICATE',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [{ sku_id: 'SKU-CURRENT', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].storeKey, 'house')
  assert.equal(result.packages[0].items[0].skuId, 'SKU-CURRENT')
})

test('an exact SKU code accepts a current catalog SKU when PO history kept an old SKU ID', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-OLD-ID-D01',
    'SKU ID': 'SKU-CURRENT',
    '运单号 Tracking Number': 'RETURN-OLD-ID',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-CURRENT',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-OLD-ID',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-OLD', sku_code: ' A100 BlackS ', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].items[0].skuId, 'SKU-CURRENT')
})

test('an exact SKU code recovers Store and current SKU from ambiguous PO histories', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-MULTI-STORE-D01',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-MULTI-STORE',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-CURRENT',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-MULTI-STORE',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-OLD', sku_code: 'A100BlackS', quantity: 1 }],
  }, {
    order_number: 'PO-MULTI-STORE',
    store_name: 'Garden',
    store_key: 'garden',
    items: [{ sku_id: 'SKU-OTHER', sku_code: 'OTHERBlackS', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].storeKey, 'house')
  assert.equal(result.packages[0].items[0].skuId, 'SKU-CURRENT')
})

test('an exact SKU code uses the newest mapping when one Store retained an older SKU ID', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-SAME-CODE-D01',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-SAME-CODE',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-OLDER',
    sku_code: 'A100BlackS',
    updated_at: '2026-08-01T00:00:00.000Z',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }, {
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-NEWEST',
    sku_code: 'A100BlackS',
    updated_at: '2026-08-10T00:00:00.000Z',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-SAME-CODE',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [{ sku_id: 'SKU-NOT-IN-CATALOG', sku_code: 'A100BlackS', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].storeKey, 'house')
  assert.equal(result.packages[0].items[0].skuId, 'SKU-NEWEST')
})

test('a different SKU code cannot bypass a claimed PO SKU mismatch', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-DIFFERENT-CODE',
    'SKU ID': 'SKU-CURRENT',
    '运单号 Tracking Number': 'RETURN-DIFFERENT-CODE',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-CURRENT',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-DIFFERENT-CODE',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-OLD', sku_code: 'B200NavyM', quantity: 1 }],
  }])

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 1)
  assert.deepEqual(result.reviewPackages[0].reviewData.blockingIssues, [
    'sku_not_in_claimed_order',
  ])
})

test('a blank manifest SKU recovers from current All Stores instead of a stale Store snapshot', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-RECOVER-CURRENT-D01',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-RECOVER-CURRENT',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-CURRENT',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-RECOVER-CURRENT',
    store_name: 'House',
    store_key: 'house',
    items: [],
  }, {
    order_number: 'PO-RECOVER-CURRENT',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [{ sku_id: 'SKU-CURRENT', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].storeKey, 'house')
  assert.equal(result.packages[0].items[0].skuId, 'SKU-CURRENT')
  assert.deepEqual(result.packages[0].recoveredFromOrders, ['PO-RECOVER-CURRENT'])
})

test('a catalog Store match cannot bypass missing claimed PO history', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-NOT-UPLOADED',
    'SKU ID': 'SKU-KNOWN',
    '运单号 Tracking Number': 'RETURN-MISSING-PO',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-KNOWN',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [])

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 1)
  assert.deepEqual(
    result.reviewPackages[0].reviewData.blockingIssues,
    ['order_history_missing'],
  )
})

test('a worker may explicitly skip a tracking blocked during manifest upload', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-WRONG',
    'SKU ID': 'SKU-A',
    '运单号 Tracking Number': 'track-skip',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-A',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [{
    order_number: 'PO-WRONG',
    store_name: 'House',
    store_key: 'house',
    items: [{ sku_id: 'SKU-A', quantity: 1, outbound_trackings: ['TRACK-OTHER'] }],
  }], {
    skippedTrackings: [' TRACK-SKIP '],
  })

  assert.equal(result.packages.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.deepEqual(result.skippedTrackings, ['TRACK-SKIP'])
  assert.equal(result.stats.skippedPackages, 1)
})

test('a suffixed PO loads original order contents even when return and outbound tracking differ', () => {
  const rows = [{
    '订单号 PO': 'PO-211-21604060406393228-D01',
    'SKU ID': '',
    '运单号 Tracking Number': '1Z0JA1729096605959',
  }]
  const catalog = [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'SKU-A',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }]
  const orders = [{
    order_number: 'PO-211-21604060406393228',
    store_name: 'House',
    store_key: 'house',
    items: [{
      sku_id: 'SKU-A',
      sku_code: 'A100BlackS',
      attributes: 'Black / S',
      quantity: 1,
      outbound_trackings: ['1Z-ORIGINAL-OUTBOUND'],
    }],
  }]

  const result = parseSkuReturnManifestRows(rows, catalog, orders)

  assert.equal(result.pendingUploadDecisions.length, 0)
  assert.equal(result.reviewPackages.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].recoveredFromOrders[0], 'PO-211-21604060406393228')
  assert.equal(result.packages[0].items[0].skuId, 'SKU-A')
  assert.equal(result.packages[0].items[0].style, 'A100')
})

test('an All Stores PO explains when its recovered SKU has no Store catalog entry', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-211-08941757031032991-D01',
    'SKU ID': '',
    '运单号 Tracking Number': '1Z0JA1729087848544',
  }], [], [{
    order_number: 'PO-211-08941757031032991',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [{ sku_id: 'RECOVERED-SKU', quantity: 1 }],
  }])

  assert.equal(result.pendingUploadDecisions.length, 1)
  assert.deepEqual(result.pendingUploadDecisions[0].skuIds, ['RECOVERED-SKU'])
  assert.deepEqual(
    result.pendingUploadDecisions[0].reviewIssues,
    ['sku_id_not_in_store_catalog'],
  )
  assert.equal(result.pendingUploadDecisions[0].orderHistoryFound, true)
  assert.equal(result.pendingUploadDecisions[0].allStoresHistory, true)
})

test('an unresolved return store requires an explicit existing-store choice', () => {
  const rows = [{
    '订单号 PO': 'PO-NOT-UPLOADED',
    'SKU ID': 'SKU-NOT-IN-CATALOG',
    '运单号 Tracking Number': 'RETURN-STORE-CHOICE',
  }]
  const blocked = parseSkuReturnManifestRows(rows, [], [])

  assert.equal(blocked.packages.length, 0)
  assert.equal(blocked.reviewPackages.length, 0)
  assert.equal(blocked.pendingUploadDecisions[0].issue, 'store_unresolved')

  const resolved = parseSkuReturnManifestRows(rows, [], [], {
    storeByTracking: {
      'RETURN-STORE-CHOICE': { key: 'house', name: 'House' },
    },
  })

  assert.equal(resolved.pendingUploadDecisions.length, 0)
  assert.equal(resolved.packages.length, 0)
  assert.equal(resolved.reviewPackages.length, 1)
  assert.equal(resolved.reviewPackages[0].storeKey, 'house')
  assert.equal(resolved.reviewPackages[0].storeName, 'House')
  assert.equal(resolved.needsReview[0].parse_issue, 'sku_id_not_in_store_catalog')
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
  ], [{
    order_number: 'PO-MULTI',
    store_name: 'All Stores',
    store_key: 'all stores',
    items: [
      { sku_id: 'SKU-A', quantity: 1 },
      { sku_id: 'SKU-B', quantity: 1 },
    ],
  }])

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
  assert.equal(result.needsReview.length, 0)
  assert.equal(result.pendingUploadDecisions.length, 1)
  assert.equal(result.pendingUploadDecisions[0].tracking, 'REVIEW-1')
  assert.equal(result.pendingUploadDecisions[0].issue, 'store_unresolved')
  assert.equal(result.waitingForTracking.length, 1)
  assert.equal(result.waitingForTracking[0].parse_issue, 'tracking_pending')
  assert.equal(result.stats.waitingForTracking, 1)
})

test('a blank manifest tracking can be filled with a validated Store without losing its row', () => {
  const result = parseSkuReturnManifestRows([{
    'SKU ID': 'KNOWN',
    '运单号 Tracking Number': '',
  }], [{
    store_name: 'House',
    store_key: 'house',
    sku_id: 'KNOWN',
    sku_code: 'A100BlackS',
    status: 'ready',
    components: [{ style: 'A100', color: 'Black', size: 'S', qty: 1 }],
  }], [], {
    trackingByExcelRow: { 2: ' 1z-manual-row ' },
    storeByTracking: {
      '1Z-MANUAL-ROW': { key: 'house', name: 'House' },
    },
  })

  assert.equal(result.waitingForTracking.length, 0)
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].tracking, '1Z-MANUAL-ROW')
  assert.equal(result.packages[0].storeKey, 'house')
  assert.equal(result.packages[0].items[0].skuId, 'KNOWN')
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
    { skuId: 'SKU-A', skuCode: 'A100BlackM', style: 'A100', color: 'Black', size: 'M', expectedQty: 1, sourceQty: 1 },
    { skuId: 'SKU-B', skuCode: 'B200NavyL', style: 'B200', color: 'Navy', size: 'L', expectedQty: 2, sourceQty: 2 },
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
  const rows = [{
    '订单号 PO': 'PO-NOT-UPLOADED',
    'SKU ID': '',
    '运单号 Tracking Number': 'RETURN-REVIEW-1',
  }]

  const unresolved = parseSkuReturnManifestRows(rows, [], [])

  assert.equal(unresolved.packages.length, 0)
  assert.equal(unresolved.reviewPackages.length, 0)
  assert.equal(unresolved.pendingUploadDecisions.length, 1)
  assert.equal(unresolved.pendingUploadDecisions[0].issue, 'store_unresolved')

  const result = parseSkuReturnManifestRows(rows, [], [], {
    storeByTracking: {
      'RETURN-REVIEW-1': { key: 'house', name: 'House' },
    },
  })

  assert.equal(result.packages.length, 0)
  assert.equal(result.needsReview[0].orderNumber, 'PO-NOT-UPLOADED')
  assert.equal(result.needsReview[0].parse_issue, 'order_history_missing')
  assert.equal(result.reviewPackages.length, 1)
  assert.equal(result.reviewPackages[0].requiresItemResolution, true)
  assert.ok(
    result.reviewPackages[0].reviewData.blockingIssues.includes('order_history_missing'),
  )
})

test('a confirmed style and color safely carries to sibling sizes during review', () => {
  const mappings = findAdditionalSizeMappings({
    unmatchedRows: [
      { style: 'A-100', color: 'Black', size: 'S', packCount: 1, parseIssue: 'style_identity_mismatch' },
      { style: 'A-100', color: 'Black', size: 'M', packCount: 1, parseIssue: 'style_identity_mismatch' },
      { style: 'A-100', color: 'Black', size: 'L', packCount: 1, parseIssue: 'style_identity_mismatch' },
      { style: 'A-100', color: 'Navy', size: 'M', packCount: 1, parseIssue: 'style_identity_mismatch' },
    ],
    templateRows: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'L' },
      { STYLE: 'A100', COLOR: 'NAVY', SIZE: 'M' },
    ],
    resolved: [null, null, null, null],
    sourceIndex: 0,
    targetEntry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  })

  assert.deepEqual(mappings, [
    {
      index: 1,
      entry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
    },
    {
      index: 2,
      entry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'L' },
    },
  ])
})

test('a source-data conflict is never propagated to sibling sizes through a generated review reason', () => {
  const mappings = findAdditionalSizeMappings({
    unmatchedRows: [
      {
        style: 'A100', color: 'Black', size: 'S', packCount: 1,
        parseIssue: 'confirmed_mapping_size_missing',
        sourceIssue: 'sku_attribute_size_conflict',
      },
      {
        style: 'A100', color: 'Black', size: 'M', packCount: 1,
        parseIssue: 'confirmed_mapping_size_missing',
        sourceIssue: 'sku_attribute_size_conflict',
      },
    ],
    templateRows: [
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
      { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'M' },
    ],
    resolved: [null, null],
    sourceIndex: 0,
    targetEntry: { STYLE: 'A100', COLOR: 'BLACK', SIZE: 'S' },
  })

  assert.deepEqual(mappings, [])
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
