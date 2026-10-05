import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateWarehouseAlerts, DEFAULT_SETTINGS, normalizeOrders, normalizeSales, normalizeSettings, skuKey, orderKey } from '../src/utils/warehouseAlerts.js'
import { applyWarehouseChange } from '../lib/warehouseAlertsApi.js'
const now = '2026-10-02T16:00:00Z'
const order = (extra = {}) => ({ order_id: '1', store_id: 'A', platform: 'TEMU', order_date: '2026-10-01T16:00:00Z', paid_time: '', ship_deadline: '2026-10-02T22:00:00Z', carrier: 'UPS', style: '50199', color: 'Black', size: 'L', qty: 10, order_status: 'paid', shipment_status: 'unshipped', ...extra })
const stock = { style: '50199', color: 'Black', size: 'L', quantity: 400 }
const calc = extra => calculateWarehouseAlerts({ now, ...extra })
test('carrier, deadline and age produce expected priority and red same-day UPS risk', () => {
  const report = calc({ orders: [order()] })
  assert.equal(report.orders[0].priority_score, 330)
  assert.equal(report.rows[0].risk, 'RED')
  assert.equal(report.summary.due_today, 1)
})
test('multi-SKU orders count once for shipping and capacity, but sum units per SKU', () => {
  const report = calc({ orders: [order(), order({ size: 'XL', qty: 4 })] })
  assert.equal(report.summary.UPS, 1)
  assert.equal(report.capacity.urgent_remaining, 1)
  assert.equal(report.orders[0].qty, 14)
  assert.equal(report.rows.length, 2)
})
test('order identity separates stores and platforms', () => {
  assert.equal(calc({ orders: [order(), order({ store_id: 'B' }), order({ platform: 'Other' })] }).orders.length, 3)
})
test('shipped, canceled and refunded orders are excluded; tracking alone does not mean shipped', () => {
  const report = calc({ orders: [order({ tracking_number: 'label-created' }), order({ order_id: '2', shipment_status: 'shipped' }), order({ order_id: '3', order_status: 'cancelled' }), order({ order_id: '4', order_status: 'refunded' })] })
  assert.equal(report.orders.length, 1)
})
test('USPS buffer escalates at one and two days; overdue USPS always red', () => {
  const baseline = order({ carrier: 'USPS', ship_deadline: '2026-10-10T22:00:00Z' })
  const one = calc({ orders: [baseline] }).orders[0]
  const old = calc({ orders: [{ ...baseline, order_date: '2026-09-30T15:00:00Z' }] }).orders[0]
  assert.equal(one.priority_score, 80)
  assert.equal(old.priority_score, 260)
  assert.equal(calc({ orders: [order({ carrier: 'USPS', ship_deadline: '2026-10-01T20:00:00Z' })] }).rows[0].risk, 'RED')
})
test('deadline risk uses New York business day around UTC midnight', () => {
  const report = calc({ now: '2026-10-03T00:00:00Z', orders: [order({ ship_deadline: '2026-10-03T02:00:00Z' })] })
  assert.equal(report.business_day, '2026-10-02')
  assert.equal(report.summary.due_today, 1)
})
test('forecast includes completed days, spike buffer, backlog and Ready Qty', () => {
  const validSales = normalizeSales(Array.from({ length: 7 }, (_, i) => ({ ...stock, date: new Date(Date.parse('2026-10-01T00:00:00Z') - i * 86400000).toISOString().slice(0, 10), sold_qty: 10 })).concat({ ...stock, date: '2026-10-02', sold_qty: 35 }))
  const row = calc({ orders: [order()], inventory: [stock], sales: validSales, overrides: { [`sku:${skuKey(stock)}`]: { ready_qty: 8 } } }).rows[0]
  assert.equal(row.avg_3d, 10); assert.equal(row.avg_7d, 10)
  assert.equal(row.forecast_qty, 42); assert.equal(row.sales_spike, true)
  assert.equal(row.prep_needed, 44); assert.equal(row.shortage, 0)
})
test('physical shortage compares total target with total physical, ready is not double counted', () => {
  const row = calc({ inventory: [{ ...stock, quantity: 25 }], orders: [order({ qty: 40 })], overrides: { [`sku:${skuKey(stock)}`]: { ready_qty: 20 } } }).rows[0]
  assert.equal(row.prep_needed, 20); assert.equal(row.shortage, 15)
})
test('manual prep target obeys cap and forecasts can be explicitly zero', () => {
  const row = calc({ inventory: [stock], orders: [order()], overrides: { [`sku:${skuKey(stock)}`]: { forecast_qty: 5, prep_target: 200 } } }).rows[0]
  assert.equal(row.target_ready_qty, 20)
  assert.equal(calc({ inventory: [stock], overrides: { [`sku:${skuKey(stock)}`]: { forecast_qty: 0 } } }).rows[0].forecast_qty, 0)
})
test('weekend prep targets 2.5 days, capped by physical and reduced by ready', () => {
  const sales = [{ ...stock, date: '2026-10-01', sold_qty: 70 }]
  const row = calc({ inventory: [{ ...stock, quantity: 20 }], sales, overrides: { [`sku:${skuKey(stock)}`]: { ready_qty: 8 } } }).rows[0]
  assert.equal(row.weekly_target, 20); assert.equal(row.weekly_prep, 12)
})
test('missing inventory and Ready Qty above fallen physical inventory are flagged', () => {
  const row = calc({ orders: [order()], overrides: { [`sku:${skuKey(stock)}`]: { ready_qty: 8 } } }).rows[0]
  assert.equal(row.inventory_known, false); assert.equal(row.ready_invalid, true)
})
test('absence triggers critical capacity and no available workers has no completion estimate', () => {
  const report = calc({ orders: [order()], settings: { ...DEFAULT_SETTINGS, employee_absent: 3 } })
  assert.equal(report.capacity.critical, true); assert.equal(report.capacity.shortfall, 1); assert.equal(report.capacity.completion_hours, null)
})
test('priority override and carrier override support reset to automatic', () => {
  const key = `order:${orderKey(order())}`
  assert.equal(calc({ orders: [order()], overrides: { [key]: { priority: 0 } } }).orders[0].priority_score, 0)
  assert.equal(calc({ orders: [order()], overrides: { [key]: { priority: null, carrier_urgency: 0 } } }).orders[0].priority_score, 230)
})
test('import rejects missing fields, duplicate SKU, ambiguous timestamps, invalid sales dates and quantities', () => {
  assert.equal(normalizeOrders([order()]).length, 1)
  assert.throws(() => normalizeOrders([order(), order()]), /Duplicate/)
  assert.throws(() => normalizeOrders([order({ ship_deadline: '2026-10-02 18:00' })]), /timezone/)
  assert.throws(() => normalizeOrders([order(), order({ size: 'XL', carrier: 'USPS' })]), /Conflicting/)
  assert.throws(() => normalizeOrders([order({ qty: -1 })]), /whole/)
  assert.throws(() => normalizeSales([{ ...stock, date: '2026-02-30', sold_qty: 3 }]), /Invalid/)
  assert.throws(() => normalizeSettings({ ...DEFAULT_SETTINGS, employee_absent: 4 }), /Absent/)
})
test('audit is server-authored and requires reason, preserving old and new values', () => {
  const state = { overrides: {}, audit: [], settings: DEFAULT_SETTINGS }
  const next = applyWarehouseChange(state, { action: 'override', target: `sku:${skuKey(stock)}`, field: 'ready_qty', value: 8, reason: 'Counted rack', changed_by: 'spoof' }, { username: 'admin' }, new Date(now))
  assert.deepEqual(next.audit[0], { action: 'override', target: `sku:${skuKey(stock)}`, field: 'ready_qty', changed_by: 'admin', changed_at: new Date(now).toISOString(), old_value: null, new_value: 8, reason: 'Counted rack' })
  assert.equal(state.audit.length, 0)
  assert.throws(() => applyWarehouseChange(state, { action: 'settings', settings: DEFAULT_SETTINGS }, { username: 'admin' }), /reason/)
  assert.throws(() => applyWarehouseChange(state, { action: 'override', target: 'sku:x', field: 'priority', value: 1, reason: 'test' }, { username: 'admin' }), /Invalid field/)
})

test('invalid Ready Qty cannot conceal outstanding prep after physical inventory falls', () => {
  const row = calc({ inventory: [{ ...stock, quantity: 5 }], orders: [order({ qty: 20 })], overrides: { [`sku:${skuKey(stock)}`]: { ready_qty: 40 } } }).rows[0]
  assert.equal(row.ready_qty, 40)
  assert.equal(row.usable_ready_qty, 5)
  assert.equal(row.prep_needed, 15)
  assert.equal(row.shortage, 15)
  assert.equal(row.ready_invalid, true)
})
test('forecast does not round an exact seven-piece forecast up to eight', () => {
  const sales = [{ ...stock, date: '2026-10-01', sold_qty: 7 }, { ...stock, date: '2026-09-28', sold_qty: 91 }]
  assert.equal(calc({ sales }).rows[0].forecast_qty, 7)
})
test('fractional remaining hours affect capacity and zero hours do not imply available capacity', () => {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, hours_remaining: 2.5 })
  assert.equal(calc({ settings }).capacity.estimated, 262)
  assert.equal(calc({ orders: [order()], settings: { ...settings, hours_remaining: 0 } }).capacity.critical, true)
})
test('empty confirmed order snapshot clears backlog; numeric booleans and whitespace are rejected', () => {
  const state = { orders: [order()], audit: [] }
  const next = applyWarehouseChange(state, { action: 'orders', rows: [], reason: 'All shipped' }, { username: 'admin' })
  assert.deepEqual(next.orders, [])
  assert.equal(next.audit[0].old_value.count, 1)
  for (const qty of [true, false, '  ', [], {}]) assert.throws(() => normalizeOrders([order({ qty })]))
  assert.throws(() => normalizeSettings({ ...DEFAULT_SETTINGS, hours_remaining: true }))
})
test('same instant in different timestamp offsets is consistent; invalid calendars and time order fail', () => {
  assert.equal(normalizeOrders([order(), order({ size: 'XL', order_date: '2026-10-01T12:00:00-04:00' })]).length, 2)
  assert.throws(() => normalizeOrders([order({ ship_deadline: '2026-10-01T15:59:59Z' })]), /precede/)
  assert.throws(() => normalizeOrders([order({ order_date: '2026-02-30T12:00:00Z' })]), /calendar/)
  assert.throws(() => normalizeOrders([order({ ship_deadline: '2026-10-02T24:00:00Z' })]), /timestamp/)
})
test('duplicate daily sales are rejected and restoring ERP source is audited', () => {
  const row = { ...stock, date: '2026-10-01', sold_qty: 5 }
  assert.throws(() => normalizeSales([row, { ...row, color: 'BLACK' }]), /Duplicate/)
  const next = applyWarehouseChange({ sales: [row], audit: [] }, { action: 'sales_reset', reason: 'Use current ERP transactions' }, { username: 'admin' })
  assert.equal(next.sales, null)
  assert.equal(next.audit[0].old_value.count, 1)
  assert.deepEqual(next.audit[0].new_value, { source: 'ERP' })
})
test('sales outside the forecast window do not create phantom SKU prep rows', () => {
  const rows = calc({ sales: [{ ...stock, date: '2026-09-01', sold_qty: 100 }, { ...stock, date: '2026-10-03', sold_qty: 100 }] }).rows
  assert.deepEqual(rows, [])
})
