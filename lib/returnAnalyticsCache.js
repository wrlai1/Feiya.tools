import { computeReturnAnalytics } from './returnAnalytics.js'

export const ANALYTICS_CACHE_SECONDS = 60
const pending = new Map()

// Persist completed snapshots so new serverless instances can reuse them.
// A manual refresh bypasses the 60-second cache; authentication stays in the API.
export async function readReturnAnalytics(sql, days, { refresh = false, compute = computeReturnAnalytics } = {}) {
  const key = String(days)
  if (pending.has(key)) return pending.get(key)
  const request = (async () => {
    if (!refresh) {
      const [cached] = await sql`
        SELECT result, generated_at FROM return_analytics_cache
        WHERE period = ${key} AND generated_at > NOW() - INTERVAL '60 seconds'
      `
      if (cached) return { ...cached.result, generatedAt: cached.generated_at, cached: true }
    }
    // Timestamp the start: concurrent instances must not replace newer snapshots.
    const generatedAt = new Date().toISOString()
    const result = await compute(sql, days)
    await sql`
      INSERT INTO return_analytics_cache (period, result, generated_at)
      VALUES (${key}, ${JSON.stringify(result)}::jsonb, ${generatedAt}::timestamptz)
      ON CONFLICT (period) DO UPDATE
      SET result = EXCLUDED.result, generated_at = EXCLUDED.generated_at
      WHERE return_analytics_cache.generated_at <= EXCLUDED.generated_at
    `
    return { ...result, generatedAt, cached: false }
  })()
  pending.set(key, request)
  try {
    return await request
  } finally {
    if (pending.get(key) === request) pending.delete(key)
  }
}

export async function respondWithReturnAnalytics(sql, req, res) {
  const rawDays = String(req.query.days || '30')
  const days = ['all', '36500', '3650'].includes(rawDays) ? 'all' : Number(rawDays)
  if (days !== 'all' && ![30, 90, 365].includes(days)) {
    return res.status(400).json({ error: 'Choose 30, 90, 365 days, or all.' })
  }
  const start = performance.now()
  const result = await readReturnAnalytics(sql, days, { refresh: req.query.refresh === '1' })
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Server-Timing', `analytics;dur=${(performance.now() - start).toFixed(1)}`)
  return res.json(result)
}
