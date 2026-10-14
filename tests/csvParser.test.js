import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrackingRows } from '../src/utils/csvParser.js'
import { parseInventoryNumber } from '../src/utils/excelParser.js'

test('tracking imports require complete identities and strict positive quantities', () => {
  assert.deepEqual(normalizeTrackingRows([{
    Tracking: ' 1Z123 ',
    SKU: ' SKU-1 ',
    Quantity: '2',
    'Actual Size On TEMU': 'M',
  }]).map(({ _raw, ...row }) => row), [{
    tracking: '1Z123',
    sku: 'SKU-1',
    quantity: 2,
    actualSize: 'M',
  }])

  assert.throws(() => normalizeTrackingRows([{
    Tracking: '1Z123', SKU: 'SKU-1', Quantity: '2 boxes',
  }]), /positive whole number/)
  assert.throws(() => normalizeTrackingRows([{
    Tracking: '', SKU: 'SKU-1', Quantity: 2,
  }]), /both Tracking and SKU/)
})

test('weekly inventory imports reject partial, decimal, and negative counts', () => {
  assert.equal(parseInventoryNumber('1,250', 'Quantity'), 1250)
  assert.throws(() => parseInventoryNumber('12 boxes', 'Quantity'), /whole numbers/)
  assert.throws(() => parseInventoryNumber('1.5', 'Quantity'), /whole numbers/)
  assert.throws(() => parseInventoryNumber('-1', 'Quantity'), /whole numbers/)
})
