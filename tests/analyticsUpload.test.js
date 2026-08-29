import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { chunkAnalyticsDays, groupPerformanceReportsByDay, performanceDateRangeFromFileName } from '../src/utils/analyticsUpload.js'

test('performance file names recognize common daily date formats', () => {
  assert.deepEqual(performanceDateRangeFromFileName('report_2026-08-01.xlsx', '2026-08-29'), {
    start: '2026-08-01', end: '2026-08-01', detected: true,
  })
  assert.deepEqual(performanceDateRangeFromFileName('report_20260802.xlsx', '2026-08-29').end, '2026-08-02')
  assert.deepEqual(performanceDateRangeFromFileName('report_08-03-2026.xlsx', '2026-08-29').end, '2026-08-03')
  assert.equal(performanceDateRangeFromFileName('report.xlsx', '2026-08-29').detected, false)
})

test('performance file names use the final two date occurrences', () => {
  assert.deepEqual(
    performanceDateRangeFromFileName(
      '商品推广_商品数据详情2026-08-30 04_22_2026-07-31-2026-07-31.xlsx',
      '2026-08-29',
    ),
    { start: '2026-07-31', end: '2026-07-31', detected: true },
  )
  assert.deepEqual(
    performanceDateRangeFromFileName(
      '商品推广_商品数据详情2026-08-30 04_22_2026-07-30-2026-07-31.xlsx',
      '2026-08-29',
    ),
    { start: '2026-07-30', end: '2026-07-31', detected: true },
  )
})

test('multiple performance files are grouped and ordered by their own day', () => {
  const days = groupPerformanceReportsByDay([
    { start: '2026-08-02', end: '2026-08-02', fileName: 'b.xlsx', rows: [{ spu: 'B' }] },
    { start: '2026-08-01', end: '2026-08-01', fileName: 'a.xlsx', rows: [{ spu: 'A' }] },
    { start: '2026-08-02', end: '2026-08-02', fileName: 'b-2.xlsx', rows: [{ spu: 'C' }] },
  ])
  assert.deepEqual(days.map((day) => day.day), ['2026-08-01', '2026-08-02'])
  assert.equal(days[1].rows.length, 2)
  assert.equal(days[1].fileName, 'b.xlsx, b-2.xlsx')
})

test('large multi-day uploads are split without separating a single day', () => {
  const days = [
    { day: '2026-08-01', rows: [{ value: 'a'.repeat(30) }] },
    { day: '2026-08-02', rows: [{ value: 'b'.repeat(30) }] },
    { day: '2026-08-03', rows: [{ value: 'c'.repeat(30) }] },
  ]
  const chunks = chunkAnalyticsDays(days, 100)
  assert.deepEqual(chunks.flat().map((day) => day.day), days.map((day) => day.day))
  assert.equal(chunks.every((chunk) => chunk.length > 0), true)
})

test('analytics batch uploads send each daily file in one request', async () => {
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage
  let request
  globalThis.localStorage = { getItem: () => null }
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) }
  }
  try {
    const { saveStoreDays } = await import('../src/utils/api.js')
    await saveStoreDays('Garden', [{ day: '2026-08-01', fileName: 'a.xlsx', rows: [{ spu: 'A' }] }])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  }
  assert.equal(request.url, '/api/analytics-store?action=save-days')
  assert.deepEqual(JSON.parse(request.options.body), {
    store: 'Garden', days: [{ day: '2026-08-01', fileName: 'a.xlsx', rows: [{ spu: 'A' }] }],
  })
})

test('analytics JSON event parameters have explicit PostgreSQL types', async () => {
  const source = await readFile(new URL('../api/analytics-store.js', import.meta.url), 'utf8')
  assert.match(source, /'store', \$\{name\}::text,[\s\S]*'fileName', \$\{fileName \|\| null\}::text,[\s\S]*'count', \$\{normalizedProducts\.length\}::int/)
})
