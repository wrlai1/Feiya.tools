import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchAliases,
  patchAliasesAndVerify,
} from '../src/utils/autoDeductAliases.js'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

test('alias loading rejects an API error instead of silently using an empty map', async () => {
  await assert.rejects(
    fetchAliases(async () => jsonResponse(401, { error: 'Not authenticated' }), '/aliases', {}),
    /Not authenticated/,
  )
})

test('alias patch is accepted only after the saved snapshot is read back', async () => {
  const saved = {
    'a100::black': { STYLE: 'A100', COLOR: 'BLACK', _confirmed: true },
  }
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' })
    if (options.method === 'POST') return jsonResponse(200, { ok: true })
    return jsonResponse(200, { aliases: saved })
  }

  const verified = await patchAliasesAndVerify(fetchImpl, { patch: '/aliases', read: '/aliases' }, {}, {
    upserts: saved,
    deleteKeys: ['old-key'],
  })

  assert.deepEqual(verified, saved)
  assert.deepEqual(calls, [
    { url: '/aliases', method: 'POST' },
    { url: '/aliases', method: 'GET' },
  ])
})

test('alias patch fails closed when read-back does not contain the requested change', async () => {
  const fetchImpl = async (_url, options = {}) => options.method === 'POST'
    ? jsonResponse(200, { ok: true })
    : jsonResponse(200, { aliases: {} })

  await assert.rejects(
    patchAliasesAndVerify(fetchImpl, { patch: '/aliases', read: '/aliases' }, {}, {
      upserts: {
        'a100::black': { STYLE: 'A100', COLOR: 'BLACK', _confirmed: true },
      },
      deleteKeys: [],
    }),
    /verification failed/i,
  )
})
