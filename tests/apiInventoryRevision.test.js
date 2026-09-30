import test from 'node:test'
import assert from 'node:assert/strict'

test('inventory uploads send the current non-negative revision to app-data', async () => {
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage
  let request

  globalThis.localStorage = { getItem: () => null }
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, revision: 8 }),
    }
  }

  try {
    const { saveInventory } = await import('../src/utils/api.js')
    await saveInventory([{ id: 'row-1' }], 'inventory.xlsx', 7)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  }

  assert.equal(request.url, '/api/app-data')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), {
    type: 'inventory',
    data: [{ id: 'row-1' }],
    fileName: 'inventory.xlsx',
    expectedRevision: 7,
  })
})
