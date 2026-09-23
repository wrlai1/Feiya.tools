export async function migrateReturnsSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_balance (
      id SERIAL PRIMARY KEY,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(style, color, size)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      source_file TEXT,
      source_hash TEXT,
      applied_units INTEGER DEFAULT 0,
      row_count INTEGER,
      applied_by TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      rollback_snapshot_id INTEGER,
      rolled_back_at TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_file TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_units INTEGER DEFAULT 0`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_by TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ DEFAULT NOW()`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_hash TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS row_count INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rollback_snapshot_id INTEGER`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ`
  await sql`ALTER TABLE inventory_balance ADD COLUMN IF NOT EXISTS sort_order INTEGER`
  await sql`DROP INDEX IF EXISTS inventory_transactions_source_hash_uq`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_active_source_hash_uq
    ON inventory_transactions (transaction_type, source_hash)
    WHERE source_hash IS NOT NULL AND source_hash <> '' AND rolled_back_at IS NULL
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_txn_rows (
      id BIGSERIAL PRIMARY KEY,
      txn_type TEXT NOT NULL,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      qty INTEGER NOT NULL,
      source_file TEXT,
      applied_by TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS transaction_id INTEGER`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS business_day DATE`
  await sql`
    UPDATE inventory_txn_rows
    SET business_day = applied_at::date
    WHERE business_day IS NULL
  `
  await sql`
    UPDATE inventory_txn_rows rows
    SET transaction_id = (
      SELECT transactions.id
      FROM inventory_transactions transactions
      WHERE transactions.transaction_type = rows.txn_type
        AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
        AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
        AND ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))) <= 30
      ORDER BY
        ABS(EXTRACT(EPOCH FROM (transactions.applied_at - rows.applied_at))),
        transactions.id DESC
      LIMIT 1
    )
    WHERE rows.transaction_id IS NULL
  `
  await sql`
    CREATE INDEX IF NOT EXISTS inventory_txn_rows_transaction_id_idx
    ON inventory_txn_rows (transaction_id)
  `
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id SERIAL PRIMARY KEY,
      label TEXT,
      source_name TEXT,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_rows INTEGER DEFAULT 0,
      total_units INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_packages (
      id BIGSERIAL PRIMARY KEY,
      tracking_number TEXT NOT NULL,
      tracking_key TEXT UNIQUE NOT NULL,
      source_file TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expected_units INTEGER NOT NULL DEFAULT 0,
      actual_units INTEGER NOT NULL DEFAULT 0,
      remark TEXT,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_by TEXT,
      confirmed_at TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS order_numbers JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS return_reasons JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS buyer_remarks JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS carrier TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS restock_units INTEGER NOT NULL DEFAULT 0`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS flagged_not_ours BOOLEAN NOT NULL DEFAULT false`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS review_reason TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS requires_item_resolution BOOLEAN NOT NULL DEFAULT false`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS review_data JSONB NOT NULL DEFAULT '{}'::jsonb`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS escalated_by TEXT`
  await sql`ALTER TABLE return_packages ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ`
  await sql`
    CREATE TABLE IF NOT EXISTS return_package_items (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT NOT NULL REFERENCES return_packages(id) ON DELETE CASCADE,
      style TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      expected_qty INTEGER NOT NULL,
      actual_qty INTEGER,
      UNIQUE(package_id, style, color, size)
    )
  `
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS sku_id TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS sku_code TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS restock_qty INTEGER`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS not_ours_qty INTEGER`
  await sql`ALTER TABLE return_package_items ADD COLUMN IF NOT EXISTS source_qty INTEGER`
  await sql`ALTER TABLE return_package_items DROP CONSTRAINT IF EXISTS return_package_items_package_id_style_color_size_key`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS return_package_items_source_sku_uq
    ON return_package_items (package_id, sku_id, style, color, size)
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_product_catalog (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      sku_code TEXT NOT NULL,
      components JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'review',
      issue TEXT,
      source_file TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_key, sku_id)
    )
  `
  await sql`ALTER TABLE return_product_catalog ADD COLUMN IF NOT EXISTS mapping_source TEXT NOT NULL DEFAULT 'catalog'`
  await sql`ALTER TABLE return_product_catalog ADD COLUMN IF NOT EXISTS mapping_version INTEGER NOT NULL DEFAULT 1`
  await sql`ALTER TABLE return_product_catalog ADD COLUMN IF NOT EXISTS mapping_confirmed_by TEXT`
  await sql`ALTER TABLE return_product_catalog ADD COLUMN IF NOT EXISTS mapping_confirmed_at TIMESTAMPTZ`
  await sql`
    UPDATE return_product_catalog
    SET mapping_source = 'admin',
        mapping_confirmed_by = COALESCE(mapping_confirmed_by, updated_by),
        mapping_confirmed_at = COALESCE(mapping_confirmed_at, updated_at)
    WHERE source_file = 'Admin Review'
      AND mapping_source <> 'admin'
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_product_catalog_history (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      old_mapping JSONB,
      new_mapping JSONB NOT NULL,
      change_source TEXT NOT NULL,
      tracking_number TEXT,
      changed_by TEXT,
      changed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_orders (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      order_number TEXT NOT NULL,
      order_key TEXT NOT NULL,
      site TEXT,
      status TEXT,
      order_created_at TIMESTAMPTZ,
      order_confirmed_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      source_file TEXT,
      source_hash TEXT,
      imported_by TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_key, order_key)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES return_orders(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      sku_id TEXT NOT NULL DEFAULT '',
      skc_id TEXT NOT NULL DEFAULT '',
      spu_id TEXT NOT NULL DEFAULT '',
      sku_code TEXT NOT NULL,
      product_name TEXT,
      attributes TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      outbound_trackings JSONB NOT NULL DEFAULT '[]'::jsonb,
      package_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      carriers JSONB NOT NULL DEFAULT '[]'::jsonb,
      warehouses JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_file TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(order_id, item_key)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS return_order_imports (
      id BIGSERIAL PRIMARY KEY,
      store_name TEXT NOT NULL,
      store_key TEXT NOT NULL,
      source_file TEXT,
      source_hash TEXT,
      batch_index INTEGER,
      order_count INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      imported_by TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE return_orders ADD COLUMN IF NOT EXISTS inventory_status TEXT NOT NULL DEFAULT 'applied'`
  await sql`ALTER TABLE return_order_imports ADD COLUMN IF NOT EXISTS inventory_status TEXT NOT NULL DEFAULT 'applied'`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS store_name TEXT`
  await sql`ALTER TABLE inventory_txn_rows ADD COLUMN IF NOT EXISTS store_key TEXT`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_status_idx ON return_packages (status, uploaded_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_confirmed_idx ON return_packages (confirmed_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_packages_store_idx ON return_packages (store_key, uploaded_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_orders_number_idx ON return_orders (order_key)`
  await sql`CREATE INDEX IF NOT EXISTS return_orders_store_created_idx ON return_orders (store_key, order_created_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS return_order_items_sku_id_idx ON return_order_items (sku_id)`
  await sql`CREATE INDEX IF NOT EXISTS return_orders_created_idx ON return_orders (order_created_at)`
  await sql`CREATE INDEX IF NOT EXISTS inventory_txn_rows_sales_day_idx
    ON inventory_txn_rows (business_day) WHERE txn_type = 'sales'`
  await sql`CREATE INDEX IF NOT EXISTS inventory_transactions_rollback_lookup_idx
    ON inventory_transactions (transaction_type, applied_at) WHERE rolled_back_at IS NOT NULL`
  await sql`CREATE TABLE IF NOT EXISTS return_analytics_cache (
    period TEXT PRIMARY KEY,
    result JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL
  )`
}
