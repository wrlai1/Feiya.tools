export async function ensureNewProductTrackerTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS new_product_trackers (
      id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, store TEXT NOT NULL,
      spu TEXT NOT NULL, product_name TEXT, launch_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE new_product_trackers ADD COLUMN IF NOT EXISTS auto_detected BOOLEAN NOT NULL DEFAULT FALSE`
  await sql`
    CREATE TABLE IF NOT EXISTS new_product_roas_events (
      id BIGSERIAL PRIMARY KEY,
      tracker_id BIGINT NOT NULL REFERENCES new_product_trackers(id) ON DELETE CASCADE,
      username TEXT NOT NULL, effective_date DATE NOT NULL, roas NUMERIC NOT NULL,
      note TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (tracker_id, effective_date)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS new_product_trackers_user_idx ON new_product_trackers (username, created_at DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS new_product_first_seen (
      username TEXT NOT NULL, store_key TEXT NOT NULL, spu_key TEXT NOT NULL,
      first_day DATE NOT NULL, PRIMARY KEY (username, store_key, spu_key)
    )
  `
  await sql`ALTER TABLE new_product_first_seen ADD COLUMN IF NOT EXISTS auto_suppressed BOOLEAN NOT NULL DEFAULT FALSE`
}

// Call after saving analytics, in the same transaction and under the tracker lock.
export function syncNewProductTrackersQueries(sql, username, store = null, asOf = null) {
  return [
    sql`
      WITH observations AS (
        SELECT LOWER(BTRIM(days.store)) AS store_key,
               LOWER(BTRIM(item->>'spu')) AS spu_key, days.day AS first_day
        FROM analytics_store_days days
        CROSS JOIN LATERAL jsonb_array_elements(days.rows) item
        WHERE days.username = ${username}
          AND (${store}::text IS NULL OR LOWER(days.store) = LOWER(${store}::text))
          AND NULLIF(BTRIM(item->>'spu'), '') IS NOT NULL
        UNION ALL
        SELECT LOWER(BTRIM(periods.store)), LOWER(BTRIM(item->>'spu')), periods.period_start
        FROM analytics_store_periods periods
        CROSS JOIN LATERAL jsonb_array_elements(periods.rows) item
        WHERE periods.username = ${username}
          AND (${store}::text IS NULL OR LOWER(periods.store) = LOWER(${store}::text))
          AND NULLIF(BTRIM(item->>'spu'), '') IS NOT NULL
      )
      INSERT INTO new_product_first_seen (username, store_key, spu_key, first_day)
      SELECT ${username}, store_key, spu_key, MIN(first_day)
      FROM observations GROUP BY store_key, spu_key
      ON CONFLICT (username, store_key, spu_key)
      DO UPDATE SET first_day = LEAST(new_product_first_seen.first_day, EXCLUDED.first_day)
    `,
    sql`
      UPDATE new_product_trackers tracker
      SET launch_date = seen.first_day, updated_at = NOW()
      FROM new_product_first_seen seen
      WHERE tracker.username = ${username} AND tracker.auto_detected
        AND seen.username = tracker.username
        AND seen.store_key = LOWER(BTRIM(tracker.store))
        AND seen.spu_key = LOWER(BTRIM(tracker.spu))
        AND seen.first_day < tracker.launch_date
    `,
    sql`
      WITH clock AS (
        SELECT COALESCE(${asOf}::date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date) AS today
      ), recent AS (
        SELECT LOWER(BTRIM(days.store)) AS store_key,
               LOWER(BTRIM(item->>'spu')) AS spu_key,
               MIN(days.store) AS store, MIN(BTRIM(item->>'spu')) AS spu,
               MIN(NULLIF(BTRIM(item->>'productName'), '')) AS product_name,
               MIN(days.day) AS first_day
        FROM analytics_store_days days CROSS JOIN clock
        CROSS JOIN LATERAL jsonb_array_elements(days.rows) item
        WHERE days.username = ${username}
          AND (${store}::text IS NULL OR LOWER(days.store) = LOWER(${store}::text))
          AND days.day BETWEEN clock.today - 15 AND clock.today
          AND NULLIF(BTRIM(item->>'spu'), '') IS NOT NULL
        GROUP BY LOWER(BTRIM(days.store)), LOWER(BTRIM(item->>'spu'))
      )
      INSERT INTO new_product_trackers (username, store, spu, product_name, launch_date, auto_detected)
      SELECT ${username}, recent.store, recent.spu,
             COALESCE((
               SELECT COALESCE(NULLIF(BTRIM(data->>'newProductName'), ''),
                               NULLIF(BTRIM(data->>'productName'), ''))
               FROM analytics_store_products product
               WHERE product.username = ${username}
                 AND LOWER(BTRIM(product.store)) = recent.store_key
                 AND LOWER(BTRIM(product.spu)) = recent.spu_key
               LIMIT 1
             ), recent.product_name), seen.first_day, TRUE
      FROM recent JOIN new_product_first_seen seen
        ON seen.username = ${username} AND seen.store_key = recent.store_key AND seen.spu_key = recent.spu_key
      CROSS JOIN clock
      WHERE seen.first_day = recent.first_day
        AND NOT seen.auto_suppressed
        AND clock.today - seen.first_day BETWEEN 0 AND 12
        AND NOT EXISTS (
          SELECT 1 FROM new_product_trackers tracker
          WHERE tracker.username = ${username}
            AND LOWER(BTRIM(tracker.store)) = recent.store_key
            AND LOWER(BTRIM(tracker.spu)) = recent.spu_key
        )
      RETURNING id, store, spu, launch_date
    `,
  ]
}

export function deleteNewProductTrackerQueries(sql, username, id) {
  return [
    sql`SELECT pg_advisory_xact_lock(hashtext('new-product-tracker-write'))`,
    sql`
      INSERT INTO new_product_first_seen (username, store_key, spu_key, first_day, auto_suppressed)
      SELECT username, LOWER(BTRIM(store)), LOWER(BTRIM(spu)), launch_date, TRUE
      FROM new_product_trackers WHERE id = ${id} AND username = ${username}
      ON CONFLICT (username, store_key, spu_key)
      DO UPDATE SET auto_suppressed = TRUE
    `,
    sql`DELETE FROM new_product_trackers WHERE id = ${id} AND username = ${username} RETURNING id`,
  ]
}
