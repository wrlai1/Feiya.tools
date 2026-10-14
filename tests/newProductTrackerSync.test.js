import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { ensureNewProductTrackerTables, syncNewProductTrackersQueries, deleteNewProductTrackerQueries } from '../lib/newProductTrackerSync.js'

test('new SPUs sync by calendar age without inventing daily data or ROAS', async () => {
  const db = new PGlite()
  const tag = (strings, ...params) => {
    const text = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '')
    return { then(resolve, reject) { return db.query(text, params).then(resolve, reject) } }
  }
  const sync = async (store = null) => {
    for (const query of syncNewProductTrackersQueries(tag, 'admin', store, '2026-10-11')) await query
  }
  const day = (store, date, rows, user = 'admin') => db.query(
    `INSERT INTO analytics_store_days(username,store,day,rows) VALUES($1,$2,$3,$4)
     ON CONFLICT(username,store,day) DO UPDATE SET rows=EXCLUDED.rows`,
    [user, store, date, JSON.stringify(rows.map(spu => ({ spu })))],
  )
  const trackers = async () => (await db.query(
    "SELECT store,spu,launch_date::text AS launch FROM new_product_trackers WHERE username='admin' ORDER BY store,spu",
  )).rows
  try {
    await db.exec(`CREATE TABLE analytics_store_days(username text,store text,day date,rows jsonb,PRIMARY KEY(username,store,day));
      CREATE TABLE analytics_store_periods(username text,store text,period_start date,period_end date,rows jsonb);
      CREATE TABLE analytics_store_products(username text,store text,spu text,data jsonb);`)
    await ensureNewProductTrackerTables(tag)
    await day('JR', '2026-10-09', [' New ', 'new'])
    await day('JR', '2026-09-29', ['Day13'])
    await day('JR', '2026-09-28', ['Day14'])
    await day('JR', '2026-09-27', ['Day15'])
    await day('JR', '2026-09-26', ['Day16'])
    await day('JR', '2026-08-01', ['Old'])
    await day('JR', '2026-10-11', ['Old', 'Day13', 'Day14', 'Day15', 'Day16', '', 'Future'])
    await day('JR', '2026-10-12', ['Tomorrow'])
    await day('Other', '2026-10-10', ['new'])
    await day('JR', '2026-10-11', ['private'], 'someone-else')
    await db.query(`INSERT INTO analytics_store_periods VALUES('admin','JR','2026-08-01','2026-08-14',$1)`, [JSON.stringify([{ spu: 'PeriodOld' }])])
    await day('JR', '2026-10-10', ['PeriodOld', 'Manual'])
    await db.exec("INSERT INTO new_product_trackers(username,store,spu,launch_date) VALUES('admin','JR','manual','2026-10-01')")
    await sync()
    assert.deepEqual(await trackers(), [
      { store: 'JR', spu: 'Day13', launch: '2026-09-29' },
      { store: 'JR', spu: 'Future', launch: '2026-10-11' },
      { store: 'JR', spu: 'New', launch: '2026-10-09' },
      { store: 'JR', spu: 'manual', launch: '2026-10-01' },
      { store: 'Other', spu: 'new', launch: '2026-10-10' },
    ])
    assert.equal((await db.query('SELECT count(*)::int AS n FROM new_product_roas_events')).rows[0].n, 0)
    const first = await trackers()
    await sync(); assert.deepEqual(await trackers(), first)
    // Missing Oct 10 does not change the launch date or restart the 14-day cycle.
    await day('JR', '2026-10-11', ['New', 'Old'])
    await sync('JR')
    assert.equal((await trackers()).find(row => row.spu === 'New').launch, '2026-10-09')
    // Backfills correct only automatically detected launches; manual launches remain user-owned.
    await day('JR', '2026-10-07', ['New', 'Manual'])
    await sync('JR')
    assert.equal((await trackers()).find(row => row.spu === 'New').launch, '2026-10-07')
    assert.equal((await trackers()).find(row => row.spu === 'manual').launch, '2026-10-01')
    // Overwriting/deleting old uploads must not let an old SPU re-enter as a new product.
    await db.exec("DELETE FROM analytics_store_days WHERE day='2026-08-01'")
    await sync('JR')
    assert.ok(!(await trackers()).some(row => row.spu === 'Old'))
    await day('Other', '2026-10-11', ['OnlyOther'])
    await sync('JR')
    assert.ok(!(await trackers()).some(row => row.spu === 'OnlyOther'))
    const [{ id }] = (await db.query("SELECT id FROM new_product_trackers WHERE spu='New'")).rows
    for (const query of deleteNewProductTrackerQueries(tag, 'admin', id)) await query
    await sync()
    assert.ok(!(await trackers()).some(row => row.spu === 'New'))
  } finally { await db.close() }
})
