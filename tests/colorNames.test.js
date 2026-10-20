import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeColorNames, colorAliasKey, rekeyColorAliases } from '../src/utils/colorNames.js'
import { normalizeColorRenames, parseColorRenamePaste } from '../src/utils/colorRenames.js'
import { fillTemplate } from '../src/utils/autoDeductEngine.js'
import { parseInventoryReceiptRows } from '../src/utils/inventoryReceiptUpload.js'

const aliases = { [colorAliasKey('A','BLACK')]: 'MIDNIGHT' }
test('colors rename only within their style, including nested mappings and warehouse keys', () => {
  const source = { rows: [{ Style: 'A', Color: 'BLACK', Quantity: -2 }, { style: 'B', color: 'BLACK' }],
    targetLine: { style: 'B', targetStyle: 'A', color: 'BLACK', targetColor: 'BLACK' },
    mapping: { STYLE: 'A', COLOR: 'BLACK', sku_code: 'A-BLACK-S' },
    substitution: { style: 'A', original_color: 'BLACK', substitute_color: 'WHITE' },
    overrides: { 'sku:["a","black","s"]': { ready_qty: 2 }, 'sku:["b","black","s"]': { ready_qty: 3 } } }
  const result = canonicalizeColorNames(source, aliases)
  assert.equal(result.rows[0].Color, 'MIDNIGHT')
  assert.equal(result.rows[0].Quantity, -2)
  assert.equal(result.rows[1].color, 'BLACK')
  assert.equal(result.targetLine.targetColor, 'MIDNIGHT')
  assert.equal(result.targetLine.color, 'BLACK')
  assert.equal(result.mapping.COLOR, 'MIDNIGHT')
  assert.equal(result.mapping.sku_code, 'A-BLACK-S')
  assert.equal(result.substitution.original_color, 'MIDNIGHT')
  assert.equal(result.substitution.substitute_color, 'WHITE')
  assert.equal(result.overrides['sku:["a","midnight","s"]'].ready_qty, 2)
  assert.equal(result.overrides['sku:["b","black","s"]'].ready_qty, 3)
  assert.equal(source.rows[0].Color, 'BLACK')
  assert.throws(() => canonicalizeColorNames({ overrides: { 'sku:["a","black","s"]': 1, 'sku:["a","midnight","s"]': 2 } }, aliases), /conflict/)
  assert.deepEqual(rekeyColorAliases(aliases, { A: 'NEW-A' }), { [colorAliasKey('NEW-A','BLACK')]: 'MIDNIGHT' })
})
test('color batches allow the same destination in different styles and reject merges within one style', () => {
  assert.equal(normalizeColorRenames([{ style: 'A', oldColor: 'BLACK', newColor: 'NIGHT' }, { style: 'B', oldColor: 'BLACK', newColor: 'NIGHT' }]).length, 2)
  assert.throws(() => normalizeColorRenames([{ style: 'A', oldColor: 'BLACK', newColor: 'NIGHT' }, { style: 'a', oldColor: 'WHITE', newColor: 'night' }]), /More than one/)
  assert.throws(() => normalizeColorRenames([{ style: 'A', oldColor: 'BLACK', newColor: 'NIGHT' }, { style: 'a', oldColor: 'black', newColor: 'DARK' }]), /more than once/)
  for (const rows of [[], [{}], [null], [{ style: '', oldColor: 'BLACK', newColor: 'NIGHT' }], [{ style: 'A', oldColor: 'BLACK', newColor: 'BLACK' }]]) assert.throws(() => normalizeColorRenames(rows))
  assert.deepEqual(parseColorRenamePaste('Style\t原颜色\t新颜色\r\nA\tBLACK\tMIDNIGHT\r\nB\tWHITE\t'), [{ style: 'A', oldColor: 'BLACK', newColor: 'MIDNIGHT' }, { style: 'B', oldColor: 'WHITE', newColor: '' }])
})
test('old source names, color casing, saved matches and receipt files still resolve after a color rename', () => {
  const template = [{ STYLE: 'A', COLOR: 'MIDNIGHT', SIZE: 'S' }, { STYLE: 'B', COLOR: 'BLACK', SIZE: 'S' }]
  for (const color of ['BLACK',' black ']) {
    const result = fillTemplate(template, [{ style: 'A', color, size: 'S', QTY: 2 }, { style: 'B', color: 'BLACK', size: 'S', QTY: 3 }], {}, {}, aliases)
    assert.equal(result.unmatchedRows.length, 0)
    assert.equal(result.filledRows[0].COLOR, 'MIDNIGHT')
    assert.equal(result.filledRows[0].QTY, 2)
    assert.equal(result.filledRows[1].QTY, 3)
  }
  const saved = fillTemplate(template, [{ style: 'A', color: 'SOURCE', size: 'S', QTY: 4 }], { 'a::source': { STYLE: 'A', COLOR: 'BLACK', _confirmed: true } }, {}, aliases)
  assert.equal(saved.filledRows[0].QTY, 4)
  const receipt = parseInventoryReceiptRows([{ Style: 'A', Color: 'BLACK', Size: 'S', 'Received Quantity': 5 }], [{ id: 1, Style: 'A', Color: 'MIDNIGHT', Size: 'S', Quantity: 7 }], {}, aliases)
  assert.equal(receipt[0].color, 'MIDNIGHT')
  assert.equal(receipt[0].quantity, 5)
})
