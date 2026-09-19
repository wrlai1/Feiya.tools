# Return analytics performance

Vercel runs `npm run migrate:returns && npm run build`. `DATABASE_URL` must be
available in the deployment environment. The versioned migration creates the
returns schema, reporting indexes, and cache once, inside a transaction. A failed
migration fails the build before that deployment can serve traffic. Existing
deployments remain compatible. Local API setup also requires `npm run migrate:returns`.

Normal returns requests no longer run schema DDL or historical inventory
backfills. Analytics runs four independent read queries concurrently. Completed
reports are cached in PostgreSQL for 60 seconds, shared across serverless
instances, and duplicate requests within an instance share an in-flight result.
The Refresh button sends `refresh=1` to recompute both periods. Reports can be up
to 60 seconds old after an order, return, catalog mapping, or rollback changes;
use Refresh when immediate reconciliation is needed. The cache contains only
the aggregate report and is read after admin authentication. Responses use
`Cache-Control: private, no-store`.

The API accepts `days=30`, `90`, `365`, or `all`; legacy `3650` and `36500` map to
all history. `generatedAt` records the calculation start; `cached` indicates
whether the report was reused. `Server-Timing: analytics` reports the time spent
loading/calculating it, excluding authentication.

Run `node --test tests/returnAnalyticsPerformance.test.js` for embedded PostgreSQL
tests of the real schema, queries, return caps, rollback exclusion, and cache.
With a valid database connection, `node scripts/diagnose-return-analytics.mjs 30`
(or `all`) prints read-only query plans and timings without customer rows or
credentials. Profiling executes the queries and can take time on large datasets.

Routes are loaded on demand so login and ordinary inventory pages don't download
analytics charts and spreadsheet-processing libraries upfront. Search/filtering
still uses the complete report in the browser; the visible tables render 100 rows
initially. Server-side pagination and daily rollups are not introduced here.
