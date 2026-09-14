import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateReplenishmentPlan,
  replenishmentSkuKey,
} from '../src/utils/replenishmentPlan.js'

const inventory = [
  { Style: '5010015', Color: 'DUSTY BLUE', Size: 'M', Quantity: 100 },
  { Style: '5010015', Color: 'BLACK', Size: 'L', Quantity: 0 },
  { Style: '5010015', Color: 'WHITE', Size: 'S', Quantity: 80 },
]

test('replenishment uses net inventory flow without deducting applied orders twice', () => {
  const sku = inventory[0]
  const movements = [
    ...Array.from({ length: 7 }, (_, index) => ({
      txn_type: 'sales',
      style: sku.Style,
      color: sku.Color,
      size: sku.Size,
      qty: index === 0 ? 6 : 4,
      day: `2026-07-${String(23 + index).padStart(2, '0')}`,
    })),
    {
      txn_type: 'return',
      style: sku.Style,
      color: sku.Color,
      size: sku.Size,
      qty: 2,
      day: '2026-07-29',
    },
  ]
  const key = replenishmentSkuKey(sku)
  const result = calculateReplenishmentPlan({
    inventoryRows: inventory,
    movements,
    incomingByKey: { [key]: 10 },
    windowDays: 7,
    leadDays: 14,
    safetyDays: 7,
    targetDays: 30,
    today: '2026-07-29',
  })
  const dusty = result.rows.find((row) => row.key === key)

  assert.equal(dusty.sales, 30)
  assert.equal(dusty.returns, 2)
  assert.equal(dusty.dailyNetSales, 4)
  assert.equal(dusty.daysLeft, 25)
  assert.equal(dusty.inventoryPosition, 110)
  assert.equal(dusty.recommendedQty, 0)
  assert.equal(dusty.onHand, 100)
  assert.equal(result.meta.confidence, 'high')
})

test('replenishment subtracts confirmed incoming and orders up to the target cover', () => {
  const sku = inventory[1]
  const key = replenishmentSkuKey(sku)
  const movements = Array.from({ length: 7 }, (_, index) => ({
    txn_type: 'sales',
    style: sku.Style,
    color: sku.Color,
    size: sku.Size,
    qty: 5,
    day: `2026-07-${String(23 + index).padStart(2, '0')}`,
  }))
  const result = calculateReplenishmentPlan({
    inventoryRows: inventory,
    movements,
    incomingByKey: { [key]: 20 },
    windowDays: 7,
    leadDays: 14,
    safetyDays: 7,
    targetDays: 30,
    today: '2026-07-29',
  })
  const black = result.rows.find((row) => row.key === key)

  assert.equal(black.status, 'urgent')
  assert.equal(black.reorderPoint, 105)
  assert.equal(black.targetStock, 150)
  assert.equal(black.recommendedQty, 130)
})

test('all inventory SKUs stay visible and incomplete history is flagged', () => {
  const result = calculateReplenishmentPlan({
    inventoryRows: inventory,
    movements: [{
      txn_type: 'sales',
      style: '5010015',
      color: 'DUSTY BLUE',
      size: 'M',
      qty: 3,
      day: '2026-07-29',
    }],
    windowDays: 30,
    today: '2026-07-29',
  })
  const white = result.rows.find((row) => row.color === 'WHITE')

  assert.equal(result.rows.length, 3)
  assert.equal(result.meta.confidence, 'low')
  assert.equal(white.sales, 0)
  assert.equal(white.recommendedQty, 0)
  assert.equal(white.daysLeft, Infinity)
})

test('equivalent plus-size labels share one replenishment identity', () => {
  assert.equal(
    replenishmentSkuKey({ Style: 'M022 PLUS', Color: 'Black', Size: '1XL' }),
    replenishmentSkuKey({ style: 'm022 plus', color: 'BLACK', size: '1X' }),
  )
})

test('a new SKU uses its own sales history instead of an older SKU window', () => {
  const inventoryRows = [
    { Style: 'OLD', Color: 'BLACK', Size: 'M', Quantity: 100 },
    { Style: 'NEW', Color: 'WHITE', Size: 'M', Quantity: 100 },
  ]
  const movements = [
    {
      txn_type: 'sales',
      style: 'OLD',
      color: 'BLACK',
      size: 'M',
      qty: 1,
      day: '2026-07-01',
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      txn_type: 'sales',
      style: 'NEW',
      color: 'WHITE',
      size: 'M',
      qty: 10,
      day: `2026-07-${26 + index}`,
    })),
  ]

  const result = calculateReplenishmentPlan({
    inventoryRows,
    movements,
    windowDays: 30,
    today: '2026-07-30',
  })
  const oldSku = result.rows.find((row) => row.style === 'OLD')
  const newSku = result.rows.find((row) => row.style === 'NEW')

  assert.equal(result.meta.historySpanDays, 30)
  assert.equal(oldSku.historySpanDays, 30)
  assert.equal(newSku.historySpanDays, 5)
  assert.equal(newSku.activeDayCount, 5)
  assert.equal(newSku.confidence, 'low')
  assert.equal(newSku.dailyNetSales, 10)
  assert.equal(newSku.daysLeft, 10)
})
