import 'dotenv/config'
import { neon } from '@neondatabase/serverless'
import { computeReturnAnalytics } from '../lib/returnAnalytics.js'

// Read-only profiling. Never print credentials or customer/order records.
if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '')) {
  throw new Error('A valid DATABASE_URL is required for read-only profiling.')
}
const db = neon(process.env.DATABASE_URL)
const days = process.argv[2] === 'all' ? 'all' : Number(process.argv[2] || 30)
const queries = []
await computeReturnAnalytics((strings, ...values) => {
  queries.push({ text: strings.reduce((text, part, index) => text + (index ? '$' + index : '') + part, ''), values })
  return [{}]
}, days)
console.log(await db`SELECT relname, n_live_tup FROM pg_stat_user_tables
  WHERE relname IN ('return_orders', 'return_order_items', 'return_packages',
    'return_package_items', 'return_product_catalog', 'inventory_txn_rows', 'inventory_transactions')`)
for (const [index, query] of queries.entries()) {
  const started = performance.now()
  const result = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.text, query.values)
  const plan = result[0]['QUERY PLAN'][0]
  console.log(JSON.stringify({ query: index + 1, days, elapsedMs: Math.round(performance.now() - started), plan }))
}
