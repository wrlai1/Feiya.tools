import test from 'node:test'
import assert from 'node:assert/strict'
import {
  categorizeReturnReason,
  enrichProductSkuReasonAnalytics,
  summarizeReturnReasonEvents,
} from '../src/utils/returnAnalytics.js'

test('categorizes common sizing reasons from Chinese return data', () => {
  assert.equal(categorizeReturnReason(['太大/太长'], ['腰部和腿部尺寸过大']), 'too_big_long')
  assert.equal(categorizeReturnReason(['太小/太短'], ['裤腿太短']), 'too_small_short')
})

test('uses buyer detail when the stated reason is generic', () => {
  assert.equal(categorizeReturnReason(['不合适'], ['The waist is too large']), 'too_big_long')
})

test('does not force conflicting stated reasons into one category', () => {
  assert.equal(categorizeReturnReason(['Too large', 'Too small'], []), 'mixed')
})

test('summarizes quantities and shares without multiplying reason events', () => {
  const summary = summarizeReturnReasonEvents([
    { returned_qty: 3, return_reasons: ['Too large'], buyer_remarks: ['Waist is loose'] },
    { returned_qty: 1, return_reasons: ['Damaged'], buyer_remarks: ['Broken zipper'] },
  ])
  assert.deepEqual(summary.map(({ category, quantity, share }) => ({ category, quantity, share })), [
    { category: 'too_big_long', quantity: 3, share: 75 },
    { category: 'quality_damage', quantity: 1, share: 25 },
  ])
})

test('reports reason coverage separately from unassigned multi-SKU history', () => {
  const [row] = enrichProductSkuReasonAnalytics([{
    sku_id: '49366961164',
    returned_qty: 5,
    reason_attributed_qty: 3,
    reason_events: [{ returned_qty: 3, return_reasons: ['太大/太长'], buyer_remarks: [] }],
  }])
  assert.equal(row.reason_coverage_pct, 60)
  assert.equal(row.reason_unattributed_qty, 2)
  assert.equal(row.reason_breakdown[0].quantity, 3)
  assert.equal('reason_events' in row, false)
})

test('uses exact line quantities when one package contains several SKU reasons', () => {
  const summary = summarizeReturnReasonEvents([{
    returned_qty: 3,
    reason_details: [
      { quantity: 2, return_reason: '太大/太长', buyer_remark: '腰围太大' },
      { quantity: 1, return_reason: '太小/太短', buyer_remark: '裤腿太短' },
    ],
  }])
  assert.deepEqual(summary.map(({ category, quantity, share }) => ({ category, quantity, share })), [
    { category: 'too_big_long', quantity: 2, share: 66.67 },
    { category: 'too_small_short', quantity: 1, share: 33.33 },
  ])
})
