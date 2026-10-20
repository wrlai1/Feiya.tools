import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { renameDocumentSql } from '../lib/renameDocumentSql.js'
import { canonicalizeColorNames, colorAliasKey } from '../src/utils/colorNames.js'
import { canonicalizeStyleNames } from '../src/utils/styleNames.js'

test('database document renames match the application rules without transporting history', async () => {
  const db = new PGlite()
  try {
    for (const query of renameDocumentSql) await db.exec(query)
    const styleAliases = { A: 'A-NEW', B: 'B-NEW' }
    const colorAliases = { [colorAliasKey('A','Black')]: '#21 Black', [colorAliasKey('B','White')]: 'Ivory' }
    const cases = [
      null, 'A', [null, 3, 'A'],
      { style: 'A', color: 'Black', quantity: -2, notes: 'A / Black', sku: 'A', styleName: 'B' },
      { Style: 'A', Color: 'BLACK', rows: [{ color_n: 'Black', quantity: 9 }, { style: 'B', color: 'Black' }] },
      { styleNumber: 'A', children: [{ originalColor: 'Black', substituteColor: 'White' }] },
      { style: 'A', targetStyle: 'B', targetColor: 'White', original_color: 'Black' },
      { style: 'A', key: '["a","black","s"]', target: 'sku:["a","black","s"]' },
      { 'sku:["a","black","s"]': { target: 'sku:["b","white","m"]', quantity: 1 } },
      { styles: ['A','A-NEW','B'], selectedStyles: ['B','A','B'], STYLE: 'A' },
      { style: null, Style: 'A', color: 'Black', nested: { style_number: 'B', color: 'White' } },
      JSON.parse('{"__proto__":{"style":"A","color":"Black"},"款号":"A","color":"Black"}'),
    ]
    for (const colorMode of [false,true]) for (const value of cases) {
      const aliases = colorMode ? colorAliases : styleAliases
      const expected = colorMode ? canonicalizeColorNames(value,aliases) : canonicalizeStyleNames(value,aliases)
      const result = await db.query('SELECT pg_temp.inventory_rename_document($1::jsonb,$2::jsonb,$3::boolean) AS value', [JSON.stringify(value),JSON.stringify(aliases),colorMode])
      assert.deepEqual(result.rows[0].value, expected, JSON.stringify({colorMode,value}))
    }
    for (const colorMode of [false,true]) {
      const aliases = colorMode ? colorAliases : styleAliases
      const destination = colorMode ? 'sku:["a","#21 black","s"]' : 'sku:["a-new","black","s"]'
      await assert.rejects(db.query('SELECT pg_temp.inventory_rename_document($1::jsonb,$2::jsonb,$3::boolean)', [JSON.stringify({ 'sku:["a","black","s"]': 1, [destination]: 2 }),JSON.stringify(aliases),colorMode]), /conflict/)
    }
  } finally { await db.close() }
})
