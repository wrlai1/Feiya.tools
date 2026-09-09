import test from 'node:test'
import assert from 'node:assert/strict'

import { patchAliasesQuery } from '../api/auto-deduct.js'

function captureSql(strings, ...values) {
  return { text: strings.join('?').replace(/\s+/g, ' ').trim(), values }
}

test('alias patch SQL uses supported JSONB functions and explicit parameter types', () => {
  const query = patchAliasesQuery(
    captureSql,
    '{"M022::white":{"STYLE":"M022","COLOR":"white"}}',
    '["old-key"]',
    'admin',
  )

  assert.doesNotMatch(query.text, /jsonb_object_length/)
  assert.match(query.text, /WITH saved_aliases AS/)
  assert.match(query.text, /jsonb_object_keys/)
  assert.equal((query.text.match(/\?::jsonb/g) || []).length, 3)
  assert.equal((query.text.match(/\?::text/g) || []).length, 2)
  assert.deepEqual(query.values, [
    '{"M022::white":{"STYLE":"M022","COLOR":"white"}}',
    'admin',
    '["old-key"]',
    '{"M022::white":{"STYLE":"M022","COLOR":"white"}}',
    'admin',
  ])
})
