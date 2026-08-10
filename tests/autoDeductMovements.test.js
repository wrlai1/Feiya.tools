import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyManualTargetEdits,
  buildBusinessMovementRows,
  resolutionSourceContext,
} from '../src/utils/autoDeductMovements.js'

test('manual and batch-matched resolutions retain their source business day', () => {
  const source = resolutionSourceContext({
    style: '5010015',
    color: 'Black',
    size: 'M',
    businessDay: '2026-08-03',
  })

  assert.equal(source.businessDay, '2026-08-03')
})

test('every movement row uses the one validated filename business day', () => {
  const rows = buildBusinessMovementRows([
    { targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'S', qty: 2, businessDay: '2026-08-03' },
    { targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'M', qty: 3, businessDay: '' },
    { targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'S', qty: 1, businessDay: '2026-08-04' },
  ], '2026-08-03')

  assert.deepEqual(rows, [
    { STYLE: '5010015', COLOR: 'BLACK', SIZE: 'S', QTY: 3, businessDay: '2026-08-03' },
    { STYLE: '5010015', COLOR: 'BLACK', SIZE: 'M', QTY: 3, businessDay: '2026-08-03' },
  ])
})

test('movement construction fails closed without a valid filename business day', () => {
  assert.deepEqual(buildBusinessMovementRows([
    { targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'S', qty: 2 },
  ], '2026-02-30'), [])
})

test('manual intervention changes only the target and preserves quantity', () => {
  const adjusted = applyManualTargetEdits([
    { STYLE: '5010015', COLOR: 'BLACK', SIZE: 'S', QTY: 4 },
    { STYLE: '5010015', COLOR: 'NAVY', SIZE: 'S', QTY: 0 },
  ], [
    {
      sourceStyle: '5010015', sourceColor: 'Black', sourceSize: 'S',
      targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'S',
      qty: 4, businessDay: '2026-08-03', via: 'exact',
    },
  ], {
    0: { STYLE: '5010015', COLOR: 'NAVY', SIZE: 'S' },
  })

  assert.deepEqual(adjusted.filledRows, [
    { STYLE: '5010015', COLOR: 'BLACK', SIZE: 'S', QTY: 0 },
    { STYLE: '5010015', COLOR: 'NAVY', SIZE: 'S', QTY: 4 },
  ])
  assert.deepEqual(adjusted.previewRows[0], {
    sourceStyle: '5010015', sourceColor: 'Black', sourceSize: 'S',
    targetStyle: '5010015', targetColor: 'NAVY', targetSize: 'S',
    qty: 4, businessDay: '2026-08-03', via: 'manual intervention',
  })
  assert.equal(
    adjusted.filledRows.reduce((sum, row) => sum + row.QTY, 0),
    4,
  )
  assert.deepEqual(buildBusinessMovementRows(adjusted.previewRows, '2026-08-03'), [
    { STYLE: '5010015', COLOR: 'NAVY', SIZE: 'S', QTY: 4, businessDay: '2026-08-03' },
  ])
})

test('manual intervention rejects a target outside the current inventory preview', () => {
  assert.throws(
    () => applyManualTargetEdits([
      { STYLE: '5010015', COLOR: 'BLACK', SIZE: 'S', QTY: 4 },
    ], [
      {
        targetStyle: '5010015', targetColor: 'BLACK', targetSize: 'S',
        qty: 4, businessDay: '2026-08-03',
      },
    ], {
      0: { STYLE: 'NOT-IN-INVENTORY', COLOR: 'BLACK', SIZE: 'S' },
    }),
    /does not match the current inventory preview/,
  )
})
