import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aliasKey,
  fillTemplate,
} from '../src/utils/autoDeductEngine.js'
import { consolidateRows } from '../src/utils/consolidateEngine.js'

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

test('cross-style learned mappings always return to manual review', () => {
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

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows[0].parseIssue, 'confirmed_mapping_requires_review')
})

test('learned mappings apply only to the confirmed size', () => {
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

  assert.equal(result.filledRows.reduce((sum, row) => sum + row.QTY, 0), 0)
  assert.equal(result.unmatchedRows.length, 1)
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
