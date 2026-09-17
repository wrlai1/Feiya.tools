const COMBINED_ORDER_STORE_KEY = 'all stores'

export async function computeReturnAnalytics(sql, days) {
  const from = days === 'all' ? '0001-01-01T00:00:00.000Z'
    : new Date(Date.now() - days * 86400000).toISOString()
  const summaryQuery = sql`
    SELECT
      COUNT(*)::int AS received_packages,
      COUNT(*) FILTER (WHERE status = 'discrepancy')::int AS discrepancy_packages,
      (SELECT COUNT(*)::int FROM return_packages
       WHERE flagged_not_ours = true AND confirmed_at >= ${from}) AS flagged_packages,
      COALESCE(SUM(expected_units), 0)::int AS expected_units,
      COALESCE(SUM(actual_units), 0)::int AS returned_units,
      COALESCE(SUM(restock_units), 0)::int AS restocked_units
    FROM return_packages
    WHERE status IN ('received', 'discrepancy')
      AND confirmed_at >= ${from}
  `
  const salesSummaryQuery = sql`
    SELECT COALESCE(SUM(rows.qty), 0)::int AS sold_units
    FROM inventory_txn_rows rows
    WHERE rows.txn_type = 'sales'
      AND (rows.business_day >= ${from}::date
        OR (rows.business_day IS NULL AND rows.applied_at >= ${from}::date::timestamptz))
      AND NOT EXISTS (
        SELECT 1
        FROM inventory_transactions transactions
        WHERE transactions.rolled_back_at IS NOT NULL
          AND transactions.id = rows.transaction_id
      )
      AND (rows.transaction_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM inventory_transactions transactions
        WHERE transactions.rolled_back_at IS NOT NULL
          AND transactions.transaction_type = rows.txn_type
          AND transactions.source_file IS NOT DISTINCT FROM rows.source_file
          AND transactions.applied_by IS NOT DISTINCT FROM rows.applied_by
          AND transactions.applied_at BETWEEN rows.applied_at - INTERVAL '30 seconds'
            AND rows.applied_at + INTERVAL '30 seconds'
      ))
  `
  const productSummaryQuery = sql`
    WITH sku_return_groups AS (
      SELECT
        items.package_id,
        items.sku_id,
        BOOL_AND(items.source_qty IS NOT NULL AND items.source_qty > 0) AS has_source_qty,
        LEAST(
          MAX(COALESCE(items.source_qty, 0)),
          MIN(FLOOR(
            COALESCE(items.actual_qty, 0)::numeric
            * COALESCE(items.source_qty, 0)
            / NULLIF(items.expected_qty, 0)
          ))
        )::int AS returned_product_units
      FROM return_package_items items
      JOIN return_packages packages ON packages.id = items.package_id
      WHERE packages.status IN ('received', 'discrepancy')
        AND packages.confirmed_at >= ${from}
        AND NULLIF(BTRIM(items.sku_id), '') IS NOT NULL
      GROUP BY items.package_id, items.sku_id
    )
    SELECT
      COALESCE(SUM(returned_product_units) FILTER (WHERE has_source_qty), 0)::int
        AS returned_product_units,
      COUNT(sku_return_groups.package_id)::int AS return_product_groups,
      COUNT(sku_return_groups.package_id) FILTER (WHERE has_source_qty)::int
        AS covered_return_product_groups
    FROM sku_return_groups
  `
  const breakdownQuery = sql`
    WITH package_returns AS (
      SELECT
        COALESCE(NULLIF(store_key, ''), 'unassigned') AS store_key,
        MIN(COALESCE(NULLIF(store_name, ''), 'Unassigned')) AS store_name,
        COUNT(*) FILTER (WHERE status IN ('received', 'discrepancy'))::int AS received_packages,
        COUNT(*) FILTER (WHERE status = 'discrepancy')::int AS discrepancy_packages,
        COUNT(*) FILTER (WHERE flagged_not_ours = true)::int AS flagged_packages,
        COALESCE(SUM(expected_units) FILTER (WHERE status IN ('received', 'discrepancy')), 0)::int
          AS expected_units,
        COALESCE(SUM(actual_units), 0)::int AS returned_units,
        COALESCE(SUM(restock_units), 0)::int AS restocked_units
      FROM return_packages
      WHERE status IN ('received', 'discrepancy', 'rejected')
        AND confirmed_at >= ${from}
      GROUP BY COALESCE(NULLIF(store_key, ''), 'unassigned')
    ),
    order_item_candidates AS (
      SELECT
        orders.id AS order_id,
        items.id AS item_id,
        orders.order_key,
        orders.store_key AS order_store_key,
        orders.store_name AS order_store_name,
        orders.inventory_status,
        orders.updated_at AS order_updated_at,
        items.item_key,
        items.sku_id,
        items.sku_code,
        items.product_name,
        items.quantity,
        LOWER(BTRIM(items.item_key)) AS logical_item_key
      FROM return_orders orders
      JOIN return_order_items items ON items.order_id = orders.id
      WHERE orders.order_created_at >= ${from}::date::timestamptz
    ),
    order_item_scope AS (
      SELECT
        candidates.*,
        BOOL_OR(order_store_key = ${COMBINED_ORDER_STORE_KEY}) OVER (
          PARTITION BY order_key
        ) AS has_combined_order,
        BOOL_OR(
          order_store_key = ${COMBINED_ORDER_STORE_KEY}
          AND inventory_status = 'pending'
        ) OVER (PARTITION BY order_key) AS has_pending_combined_order,
        BOOL_OR(
          order_store_key = ${COMBINED_ORDER_STORE_KEY}
          AND inventory_status = 'applied'
        ) OVER (PARTITION BY order_key) AS has_applied_combined_order
      FROM order_item_candidates candidates
    ),
    order_item_sku_metadata AS (
      SELECT
        order_key,
        logical_item_key,
        CASE
          WHEN COUNT(DISTINCT NULLIF(BTRIM(sku_id), '')) = 1
            THEN MIN(NULLIF(BTRIM(sku_id), ''))
          ELSE NULL
        END AS unique_sku_id
      FROM order_item_candidates
      GROUP BY order_key, logical_item_key
    ),
    ranked_order_items AS (
      SELECT
        scoped.*,
        metadata.unique_sku_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            order_key,
            logical_item_key,
            CASE WHEN has_combined_order THEN 0 ELSE order_id END
          ORDER BY
            CASE
              WHEN order_store_key = ${COMBINED_ORDER_STORE_KEY}
               AND inventory_status = 'applied' THEN 0
              WHEN order_store_key <> ${COMBINED_ORDER_STORE_KEY}
               AND inventory_status = 'applied' THEN 1
              WHEN order_store_key = ${COMBINED_ORDER_STORE_KEY}
               AND inventory_status = 'pending' THEN 2
              ELSE 3
            END,
            CASE WHEN NULLIF(BTRIM(sku_id), '') IS NOT NULL THEN 0 ELSE 1 END,
            order_updated_at DESC NULLS LAST,
            order_id DESC,
            item_id DESC
        ) AS canonical_rank
      FROM order_item_scope scoped
      JOIN order_item_sku_metadata metadata USING (order_key, logical_item_key)
    ),
    canonical_order_items AS (
      SELECT
        ranked.*,
        COALESCE(
          NULLIF(BTRIM(ranked.sku_id), ''),
          CASE
            WHEN LOWER(BTRIM(ranked.item_key)) LIKE 'sku:%'
              THEN NULLIF(BTRIM(SUBSTRING(ranked.item_key FROM 5)), '')
          END,
          CASE WHEN ranked.has_combined_order THEN ranked.unique_sku_id END
        ) AS resolved_sku_id,
        CASE
          WHEN ranked.has_applied_combined_order THEN true
          WHEN ranked.has_pending_combined_order THEN false
          ELSE ranked.inventory_status = 'applied'
        END AS inventory_reconciled
      FROM ranked_order_items ranked
      WHERE canonical_rank = 1
    ),
    catalog_counts AS (
      SELECT sku_id, COUNT(*)::int AS match_count
      FROM return_product_catalog
      GROUP BY sku_id
    ),
    unique_catalog AS (
      SELECT
        catalog.*,
        catalog.status = 'ready'
          AND CASE
            WHEN jsonb_typeof(catalog.components) = 'array'
              THEN jsonb_array_length(catalog.components) > 0
            ELSE false
          END
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(catalog.components) = 'array' THEN catalog.components
                ELSE '[]'::jsonb
              END
            ) component(value)
            WHERE NULLIF(BTRIM(component.value->>'style'), '') IS NULL
               OR NULLIF(BTRIM(component.value->>'color'), '') IS NULL
               OR NULLIF(BTRIM(component.value->>'size'), '') IS NULL
               OR COALESCE(component.value->>'qty', '') !~ '^[1-9][0-9]{0,3}$'
      ) AS physical_mapping_ready
      FROM return_product_catalog catalog
      JOIN catalog_counts counts USING (sku_id)
      WHERE counts.match_count = 1
    ),
    sku_identity_catalog AS (
      SELECT
        LOWER(BTRIM(sku_code)) AS sku_code_key,
        MIN(sku_id) AS sku_id
      FROM return_product_catalog
      WHERE NULLIF(BTRIM(sku_code), '') IS NOT NULL
        AND NULLIF(BTRIM(sku_id), '') IS NOT NULL
      GROUP BY LOWER(BTRIM(sku_code))
      HAVING COUNT(DISTINCT sku_id) = 1
    ),
    sales_items AS (
      SELECT
        items.order_key,
        COALESCE(identity.sku_id, items.resolved_sku_id) AS sku_id,
        COALESCE(
          NULLIF(BTRIM(catalog.sku_code), ''),
          NULLIF(BTRIM(items.sku_code), '')
        ) AS sku_code,
        NULLIF(BTRIM(items.product_name), '') AS product_name,
        items.quantity,
        items.inventory_reconciled,
        CASE
          WHEN items.order_store_key <> ${COMBINED_ORDER_STORE_KEY}
           AND NULLIF(BTRIM(items.order_store_key), '') IS NOT NULL
            THEN items.order_store_key
          WHEN catalog.id IS NOT NULL THEN catalog.store_key
          ELSE 'unassigned'
        END AS store_key,
        CASE
          WHEN items.order_store_key <> ${COMBINED_ORDER_STORE_KEY}
           AND NULLIF(BTRIM(items.order_store_key), '') IS NOT NULL
            THEN items.order_store_name
          WHEN catalog.id IS NOT NULL THEN catalog.store_name
          ELSE 'Unassigned'
        END AS store_name,
        catalog.components,
        COALESCE(catalog.physical_mapping_ready, false)
          AND (
            items.order_store_key = ${COMBINED_ORDER_STORE_KEY}
            OR catalog.store_key = items.order_store_key
          ) AS physical_mapping_ready
      FROM canonical_order_items items
      LEFT JOIN sku_identity_catalog identity
        ON identity.sku_code_key = LOWER(BTRIM(items.sku_code))
      LEFT JOIN unique_catalog catalog
        ON catalog.sku_id = COALESCE(identity.sku_id, items.resolved_sku_id)
    ),
    physical_sales AS (
      SELECT
        items.store_key,
        MIN(items.store_name) AS store_name,
        COALESCE(SUM(items.quantity * component.qty), 0)::int AS sold_units
      FROM sales_items items
      CROSS JOIN LATERAL jsonb_to_recordset(
        CASE WHEN items.physical_mapping_ready THEN items.components ELSE '[]'::jsonb END
      ) AS component(style TEXT, color TEXT, size TEXT, qty INTEGER)
      GROUP BY items.store_key
    ),
    physical_sku_sales AS (
      SELECT
        items.store_key,
        MIN(items.store_name) AS store_name,
        LOWER(BTRIM(component.style)) AS style_key,
        LOWER(BTRIM(component.color)) AS color_key,
        CASE UPPER(BTRIM(component.size))
          WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
          ELSE UPPER(BTRIM(component.size))
        END AS size_key,
        MIN(component.style) AS style,
        MIN(component.color) AS color,
        MIN(component.size) AS size,
        COALESCE(SUM(items.quantity * component.qty), 0)::int AS sold_qty
      FROM sales_items items
      CROSS JOIN LATERAL jsonb_to_recordset(
        CASE WHEN items.physical_mapping_ready THEN items.components ELSE '[]'::jsonb END
      ) AS component(style TEXT, color TEXT, size TEXT, qty INTEGER)
      GROUP BY 1, 3, 4, 5
    ),
    product_sales AS (
      SELECT
        store_key,
        MIN(store_name) AS store_name,
        COALESCE(SUM(quantity), 0)::int AS sold_product_units,
        COALESCE(SUM(quantity) FILTER (WHERE physical_mapping_ready), 0)::int
          AS covered_product_units,
        COALESCE(SUM(quantity) FILTER (WHERE NOT physical_mapping_ready), 0)::int
          AS uncovered_product_units,
        COALESCE(SUM(quantity) FILTER (WHERE NOT inventory_reconciled), 0)::int
          AS unreconciled_product_units
      FROM sales_items
      GROUP BY store_key
    ),
    sku_product_sales AS (
      SELECT
        store_key,
        MIN(store_name) AS store_name,
        sku_id,
        MIN(sku_code) AS sku_code,
        MIN(product_name) AS product_name,
        COALESCE(SUM(quantity), 0)::int AS sold_product_units
      FROM sales_items
      WHERE NULLIF(BTRIM(sku_id), '') IS NOT NULL
      GROUP BY store_key, sku_id
    ),
    order_sku_sales AS (
      SELECT
        order_key,
        sku_id,
        COALESCE(SUM(quantity), 0)::int AS sold_product_units
      FROM sales_items
      WHERE NULLIF(BTRIM(sku_id), '') IS NOT NULL
      GROUP BY order_key, sku_id
    ),
    raw_sku_product_returns AS (
      SELECT
        COALESCE(NULLIF(packages.store_key, ''), 'unassigned') AS store_key,
        MIN(COALESCE(NULLIF(packages.store_name, ''), 'Unassigned')) AS store_name,
        items.package_id,
        items.sku_id,
        CASE
          WHEN jsonb_typeof(packages.order_numbers) = 'array'
           AND jsonb_array_length(packages.order_numbers) = 1
            THEN NULLIF(BTRIM(packages.order_numbers->>0), '')
          ELSE NULL
        END AS order_key,
        MIN(NULLIF(BTRIM(items.sku_code), '')) AS sku_code,
        BOOL_AND(items.source_qty IS NOT NULL AND items.source_qty > 0) AS has_source_qty,
        LEAST(
          MAX(COALESCE(items.source_qty, 0)),
          MIN(FLOOR(
            COALESCE(items.actual_qty, 0)::numeric
            * COALESCE(items.source_qty, 0)
            / NULLIF(items.expected_qty, 0)
          ))
        )::int AS returned_product_units
      FROM return_package_items items
      JOIN return_packages packages ON packages.id = items.package_id
      WHERE packages.status IN ('received', 'discrepancy')
        AND packages.confirmed_at >= ${from}
        AND NULLIF(BTRIM(items.sku_id), '') IS NOT NULL
      GROUP BY
        COALESCE(NULLIF(packages.store_key, ''), 'unassigned'),
        items.package_id,
        items.sku_id,
        CASE
          WHEN jsonb_typeof(packages.order_numbers) = 'array'
           AND jsonb_array_length(packages.order_numbers) = 1
            THEN NULLIF(BTRIM(packages.order_numbers->>0), '')
          ELSE NULL
        END
    ),
    sku_product_returns AS (
      SELECT
        returns.store_key,
        MIN(returns.store_name) AS store_name,
        returns.sku_id,
        MIN(returns.sku_code) AS sku_code,
        BOOL_AND(returns.has_source_qty) AS has_source_qty,
        CASE
          WHEN returns.order_key IS NOT NULL
           AND MAX(sales.sold_product_units) > 0
            THEN LEAST(
              COALESCE(SUM(returns.returned_product_units), 0),
              MAX(sales.sold_product_units)
            )::int
          ELSE COALESCE(SUM(returns.returned_product_units), 0)::int
        END AS returned_product_units
      FROM raw_sku_product_returns returns
      LEFT JOIN order_sku_sales sales
        ON sales.order_key = returns.order_key
       AND sales.sku_id = returns.sku_id
      GROUP BY
        returns.store_key,
        returns.sku_id,
        COALESCE(returns.order_key, 'package:' || returns.package_id::text),
        returns.order_key
    ),
    product_returns AS (
      SELECT
        store_key,
        MIN(store_name) AS store_name,
        COALESCE(SUM(returned_product_units) FILTER (WHERE has_source_qty), 0)::int
          AS returned_product_units
      FROM sku_product_returns
      GROUP BY store_key
    ),
    sku_product_return_totals AS (
      SELECT
        store_key,
        MIN(store_name) AS store_name,
        sku_id,
        MIN(sku_code) AS sku_code,
        COALESCE(SUM(returned_product_units) FILTER (WHERE has_source_qty), 0)::int
          AS returned_product_units,
        BOOL_AND(has_source_qty) AS return_coverage_complete
      FROM sku_product_returns
      GROUP BY store_key, sku_id
    ),
    store_keys AS (
      SELECT store_key FROM package_returns
      UNION SELECT store_key FROM physical_sales
      UNION SELECT store_key FROM product_sales
      UNION SELECT store_key FROM product_returns
    ),
    store_output AS (
      SELECT
        keys.store_key,
        COALESCE(packages.store_name, physical.store_name, sold_products.store_name,
                 returned_products.store_name, 'Unassigned') AS store_name,
        COALESCE(packages.received_packages, 0)::int AS received_packages,
        COALESCE(packages.discrepancy_packages, 0)::int AS discrepancy_packages,
        COALESCE(packages.flagged_packages, 0)::int AS flagged_packages,
        COALESCE(packages.expected_units, 0)::int AS expected_units,
        COALESCE(packages.returned_units, 0)::int AS returned_units,
        COALESCE(packages.restocked_units, 0)::int AS restocked_units,
        COALESCE(physical.sold_units, 0)::int AS sold_units,
        COALESCE(sold_products.sold_product_units, 0)::int AS sold_product_units,
        COALESCE(sold_products.covered_product_units, 0)::int
          AS covered_sales_product_units,
        COALESCE(sold_products.uncovered_product_units, 0)::int
          AS uncovered_sales_product_units,
        COALESCE(sold_products.unreconciled_product_units, 0)::int
          AS unreconciled_sales_product_units,
        LEAST(
          COALESCE(returned_products.returned_product_units, 0),
          COALESCE(sold_products.sold_product_units, 0)
        )::int
          AS returned_product_units,
        CASE
          WHEN COALESCE(sold_products.uncovered_product_units, 0) > 0 THEN NULL
          WHEN COALESCE(physical.sold_units, 0) > 0
          THEN ROUND(
            LEAST(COALESCE(packages.returned_units, 0), physical.sold_units)::numeric
            * 100 / physical.sold_units,
            2
          )
          ELSE NULL
        END AS physical_return_rate,
        CASE WHEN COALESCE(sold_products.sold_product_units, 0) > 0
          THEN ROUND(
            LEAST(
              COALESCE(returned_products.returned_product_units, 0),
              sold_products.sold_product_units
            )::numeric
            * 100 / sold_products.sold_product_units,
            2
          )
          ELSE NULL
        END AS product_return_rate
      FROM store_keys keys
      LEFT JOIN package_returns packages USING (store_key)
      LEFT JOIN physical_sales physical USING (store_key)
      LEFT JOIN product_sales sold_products USING (store_key)
      LEFT JOIN product_returns returned_products USING (store_key)
    ),
    sku_product_keys AS (
      SELECT store_key, sku_id FROM sku_product_sales
      UNION
      SELECT store_key, sku_id FROM sku_product_return_totals
    ),
    sku_catalog_display AS (
      SELECT
        store_key,
        sku_id,
        MIN(sku_code) AS sku_code,
        CASE
          WHEN COUNT(DISTINCT components::text) = 1
          THEN (ARRAY_AGG(components ORDER BY store_key))[1]
          ELSE '[]'::jsonb
        END AS components
      FROM return_product_catalog
      GROUP BY store_key, sku_id
    ),
    sku_product_output AS (
      SELECT
        keys.store_key,
        COALESCE(sales.store_name, returned.store_name, 'Unassigned') AS store_name,
        keys.sku_id,
        COALESCE(sales.sku_code, returned.sku_code, catalog.sku_code) AS sku_code,
        sales.product_name,
        CASE
          WHEN jsonb_typeof(catalog.components) = 'array' THEN catalog.components
          ELSE '[]'::jsonb
        END AS components,
        COALESCE(sales.sold_product_units, 0)::int AS sold_product_units,
        LEAST(
          COALESCE(returned.returned_product_units, 0),
          COALESCE(sales.sold_product_units, 0)
        )::int AS returned_product_units,
        COALESCE(returned.return_coverage_complete, true) AS return_coverage_complete,
        CASE
          WHEN COALESCE(returned.return_coverage_complete, true) = false THEN NULL
          WHEN COALESCE(sales.sold_product_units, 0) > 0
          THEN ROUND(
            LEAST(
              COALESCE(returned.returned_product_units, 0),
              sales.sold_product_units
            )::numeric
            * 100 / sales.sold_product_units,
            2
          )
          ELSE NULL
        END AS return_rate
      FROM sku_product_keys keys
      LEFT JOIN sku_product_sales sales USING (store_key, sku_id)
      LEFT JOIN sku_product_return_totals returned USING (store_key, sku_id)
      LEFT JOIN sku_catalog_display catalog USING (store_key, sku_id)
      WHERE COALESCE(sales.sold_product_units, 0) > 0
         OR COALESCE(returned.returned_product_units, 0) > 0
         OR COALESCE(returned.return_coverage_complete, true) = false
    ),
    physical_sku_returns AS (
      SELECT
        COALESCE(NULLIF(packages.store_key, ''), 'unassigned') AS store_key,
        MIN(COALESCE(NULLIF(packages.store_name, ''), 'Unassigned')) AS store_name,
        LOWER(BTRIM(items.style)) AS style_key,
        LOWER(BTRIM(items.color)) AS color_key,
        CASE UPPER(BTRIM(items.size))
          WHEN '1XL' THEN '1X' WHEN '2XL' THEN '2X' WHEN '3XL' THEN '3X'
          ELSE UPPER(BTRIM(items.size))
        END AS size_key,
        MIN(items.style) AS style,
        MIN(items.color) AS color,
        MIN(items.size) AS size,
        COALESCE(SUM(items.actual_qty), 0)::int AS returned_qty,
        COALESCE(SUM(items.restock_qty), 0)::int AS restocked_qty
      FROM return_package_items items
      JOIN return_packages packages ON packages.id = items.package_id
      WHERE packages.status IN ('received', 'discrepancy')
        AND packages.confirmed_at >= ${from}
      GROUP BY 1, 3, 4, 5
    ),
    physical_sku_keys AS (
      SELECT store_key, style_key, color_key, size_key FROM physical_sku_sales
      UNION
      SELECT store_key, style_key, color_key, size_key FROM physical_sku_returns
    ),
    physical_sku_output AS (
      SELECT
        keys.store_key,
        COALESCE(sales.store_name, returned.store_name, 'Unassigned') AS store_name,
        COALESCE(sales.style, returned.style) AS style,
        COALESCE(sales.color, returned.color) AS color,
        COALESCE(sales.size, returned.size) AS size,
        COALESCE(sales.sold_qty, 0)::int AS sold_qty,
        LEAST(
          COALESCE(returned.returned_qty, 0),
          COALESCE(sales.sold_qty, 0)
        )::int AS returned_qty,
        COALESCE(returned.restocked_qty, 0)::int AS restocked_qty,
        NOT EXISTS (
          SELECT 1 FROM product_sales WHERE uncovered_product_units > 0
        ) AS coverage_complete,
        NOT EXISTS (
          SELECT 1 FROM product_sales WHERE unreconciled_product_units > 0
        ) AS inventory_reconciliation_complete,
        'canonical_orders_catalog'::text AS sales_source,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM product_sales WHERE uncovered_product_units > 0
          ) THEN NULL
          WHEN COALESCE(sales.sold_qty, 0) > 0
          THEN ROUND(
            LEAST(COALESCE(returned.returned_qty, 0), sales.sold_qty)::numeric
            * 100 / sales.sold_qty,
            2
          )
          ELSE NULL
        END AS return_rate
      FROM physical_sku_keys keys
      LEFT JOIN physical_sku_sales sales USING (store_key, style_key, color_key, size_key)
      LEFT JOIN physical_sku_returns returned USING (store_key, style_key, color_key, size_key)
      WHERE COALESCE(sales.sold_qty, 0) > 0
         OR COALESCE(returned.returned_qty, 0) > 0
    )
    SELECT
      COALESCE((
        SELECT jsonb_agg(to_jsonb(store_output)
          ORDER BY returned_units DESC, store_name)
        FROM store_output
      ), '[]'::jsonb) AS stores,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(sku_product_output)
          ORDER BY return_rate DESC NULLS LAST, returned_product_units DESC,
            store_name, sku_id)
        FROM (
          SELECT * FROM sku_product_output
          ORDER BY return_rate DESC NULLS LAST, returned_product_units DESC,
            store_name, sku_id
        ) sku_product_output
      ), '[]'::jsonb) AS sku_rows,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(physical_sku_output)
          ORDER BY returned_qty DESC, style, color, size)
        FROM (
          SELECT * FROM physical_sku_output
          ORDER BY returned_qty DESC, style, color, size
        ) physical_sku_output
      ), '[]'::jsonb) AS rows
  `
  const [[summary], [salesSummary], [productSummary], [analyticsBreakdown]] = await Promise.all([
    summaryQuery, salesSummaryQuery, productSummaryQuery, breakdownQuery,
  ])
  summary.inventory_physical_units = Number(salesSummary?.sold_units || 0)
  summary.returned_product_units = Number(productSummary?.returned_product_units || 0)
  summary.return_product_groups = Number(productSummary?.return_product_groups || 0)
  summary.covered_return_product_groups = Number(productSummary?.covered_return_product_groups || 0)
  const stores = Array.isArray(analyticsBreakdown?.stores)
    ? analyticsBreakdown.stores
    : []
  const rows = Array.isArray(analyticsBreakdown?.rows)
    ? analyticsBreakdown.rows
    : []
  const skuRows = Array.isArray(analyticsBreakdown?.sku_rows)
    ? analyticsBreakdown.sku_rows
    : []
  const salesCoverage = stores.reduce((totals, store) => ({
    product_units: totals.product_units + Number(store.sold_product_units || 0),
    covered_product_units:
      totals.covered_product_units + Number(store.covered_sales_product_units || 0),
    uncovered_product_units:
      totals.uncovered_product_units + Number(store.uncovered_sales_product_units || 0),
    unreconciled_product_units:
      totals.unreconciled_product_units
      + Number(store.unreconciled_sales_product_units || 0),
    unassigned_product_units: totals.unassigned_product_units
      + (store.store_key === 'unassigned' ? Number(store.sold_product_units || 0) : 0),
    mapped_physical_units: totals.mapped_physical_units + Number(store.sold_units || 0),
  }), {
    product_units: 0,
    covered_product_units: 0,
    uncovered_product_units: 0,
    unreconciled_product_units: 0,
    unassigned_product_units: 0,
    mapped_physical_units: 0,
  })
  summary.sales_catalog_coverage = {
    ...salesCoverage,
    inventory_physical_units: summary.inventory_physical_units,
    complete: salesCoverage.uncovered_product_units === 0
      && salesCoverage.unassigned_product_units === 0,
    inventory_reconciliation_complete:
      salesCoverage.unreconciled_product_units === 0,
    unresolved: stores
      .filter((store) => Number(store.uncovered_sales_product_units || 0) > 0)
      .map((store) => ({
        store_key: store.store_key,
        store_name: store.store_name,
        product_units: Number(store.uncovered_sales_product_units || 0),
      })),
  }
  summary.sold_units = salesCoverage.mapped_physical_units
  summary.total_return_rate = summary.sales_catalog_coverage.complete
    && summary.sold_units > 0
    ? Math.min(Number(summary.returned_units || 0), summary.sold_units)
      * 100 / summary.sold_units
    : null
  summary.physical_sales_source = 'canonical_orders_catalog'
  summary.inventory_reconciliation_delta = summary.sold_units
    - summary.inventory_physical_units
  summary.sold_product_units = salesCoverage.product_units
  summary.returned_product_units = Math.min(
    Number(summary.returned_product_units || 0),
    summary.sold_product_units,
  )
  summary.product_return_rate = summary.sold_product_units > 0
    ? summary.returned_product_units * 100 / summary.sold_product_units
    : null
  return { days, summary, stores, skuRows, rows }
}
