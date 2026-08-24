import test from 'node:test'
import assert from 'node:assert/strict'
import { consolidateRows } from '../src/utils/consolidateEngine.js'
import { aliasKey, fillTemplate, reviewAliasKey } from '../src/utils/autoDeductEngine.js'
import { findAdditionalSizeMappings } from '../src/utils/autoDeductRules.js'

test('TEMU quantity-only summary rows are not parsed as nameless products', () => {
  const result = consolidateRows([
    { SKU货号: 'M022BlackL', 商品属性: 'Black / L', 应履约件数: '1' },
    { SKU货号: '', 商品属性: '', 应履约件数: '394' },
  ])

  assert.equal(result.stats.origRows, 1)
  assert.equal(result.stats.origTotal, 1)
  assert.equal(result.needsReview.some((row) => !row.raw_style), false)
})

test('one confirmed link applies to identical style color size rows from different combos', () => {
  const unmatchedRows = [
    { style: 'M022', color: 'black', size: '2X', packCount: 1, parseIssue: 'sku_attribute_size_conflict', sourceIssue: 'sku_attribute_size_conflict' },
    { style: 'M022', color: 'black', size: '2XL', packCount: 1, parseIssue: 'sku_attribute_color_conflict', sourceIssue: 'sku_attribute_color_conflict' },
  ]
  const target = { STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '2X' }

  assert.deepEqual(findAdditionalSizeMappings({
    unmatchedRows,
    templateRows: [target],
    resolved: [null, null],
    sourceIndex: 0,
    targetEntry: target,
  }), [{ index: 1, entry: target }])
})

test('a dimension-level confirmation resolves future source signatures', () => {
  const template = [{ STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '2X' }]
  const source = {
    style: 'M022', color: 'black', size: '2X', QTY: 3,
    parse_issue: 'sku_attribute_size_conflict',
    source_signature: '["different combo","black / xxl"]',
  }
  const aliases = {
    [aliasKey('M022', 'black', '2X')]: {
      STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '2X',
      _confirmed: true, _confirmedDimensions: true,
    },
  }

  const result = fillTemplate(template, [source], aliases)
  assert.equal(result.unmatchedRows.length, 0)
  assert.equal(result.filledRows[0].QTY, 3)
})

test('compatible legacy review confirmations are reused by dimension', () => {
  const template = [{ STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '2X' }]
  const aliases = {
    [reviewAliasKey('M022', 'black', '2X', 'old combo', 'sku_attribute_size_conflict')]: {
      STYLE: 'M022 PLUS', COLOR: 'BLACK', SIZE: '2X',
      _confirmed: true,
    },
  }
  const result = fillTemplate(template, [{
    style: 'M022', color: 'black', size: '2X', QTY: 1,
    parse_issue: 'sku_attribute_color_conflict', source_signature: 'new combo',
  }], aliases)

  assert.equal(result.unmatchedRows.length, 0)
  assert.equal(result.filledRows[0].QTY, 1)
})

test('a missing-style source shows its raw SKU and reuses a confirmed dimension mapping', () => {
  const source = consolidateRows([{
    SKU: 'GreenTealXS',
    'Product Attribute': 'Green Teal / XS',
    Quantity: 1,
  }]).consolidated[0]
  const first = fillTemplate([
    { STYLE: '0015', COLOR: 'GREEN TEAL', SIZE: 'XS' },
  ], [source], {})

  assert.equal(first.unmatchedRows[0].rawStyle, 'GreenTealXS')

  const remembered = fillTemplate([
    { STYLE: '0015', COLOR: 'GREEN TEAL', SIZE: 'XS' },
  ], [source], {
    [aliasKey('', source.color, source.size)]: {
      STYLE: '0015',
      COLOR: 'GREEN TEAL',
      SIZE: 'XS',
      _confirmed: true,
      _confirmedDimensions: true,
    },
  })

  assert.deepEqual(
    remembered.filledRows.filter((row) => row.QTY),
    [{ STYLE: '0015', COLOR: 'GREEN TEAL', SIZE: 'XS', QTY: 1 }],
  )
  assert.equal(remembered.unmatchedRows.length, 0)
})
