import 'dotenv/config'
import { neon } from '@neondatabase/serverless'
import { migrateReturnsSchema } from '../lib/returnsSchema.js'

const version = 'returns-analytics-performance-v1'
if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '')) {
  throw new Error('A valid DATABASE_URL is required for the returns migration.')
}
const sql = neon(process.env.DATABASE_URL)
await sql`CREATE TABLE IF NOT EXISTS feiya_schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`
const [existing] = await sql`SELECT version FROM feiya_schema_migrations WHERE version = ${version}`
if (!existing) {
  // Execute schema setup once at deployment, never while a user waits for a page.
  // A transaction prevents a partial migration; the lock serializes deployments.
  const statements = []
  const collect = (strings, ...values) => { statements.push(sql(strings, ...values)) }
  await migrateReturnsSchema(collect)
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(724510, 1)`,
    ...statements,
    sql`INSERT INTO feiya_schema_migrations (version) VALUES (${version}) ON CONFLICT DO NOTHING`,
  ])
  console.log('Returns database migration completed.')
} else {
  console.log('Returns database schema is up to date.')
}
