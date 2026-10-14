import { aliasesForSource, buildRebindingPlan } from '../src/utils/autoDeductRebinding.js'

export function rebindAliasesQuery(sql, baseKey, expected, upserts, username) {
  return sql`
    UPDATE app_data SET value = value || jsonb_build_object(
      'aliases', COALESCE(value->'aliases', '{}'::jsonb) || ${JSON.stringify(upserts)}::jsonb,
      'updatedAt', NOW(), 'updatedBy', ${username}::text
    ), updated_at = NOW()
    WHERE key = 'autodeduct_aliases' AND (
      SELECT COALESCE(jsonb_object_agg(alias_key, alias_value), '{}'::jsonb)
      FROM jsonb_each(COALESCE(value->'aliases', '{}'::jsonb)) AS saved(alias_key, alias_value)
      WHERE alias_key = ${baseKey}::text OR LEFT(alias_key, LENGTH(${baseKey}::text) + 2) = ${baseKey}::text || '::'
    ) = ${JSON.stringify(expected)}::jsonb
    RETURNING value->'aliases' AS aliases
  `
}

export async function rebindSavedAliases(sql, body, username) {
  const { groupId, targetStyle, targetColor, expected } = body || {}
  if (typeof groupId !== 'string' || typeof targetStyle !== 'string' || typeof targetColor !== 'string'
    || !expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return { status: 400, error: '请选择原匹配和新的库存目标' }
  }
  const [[stored], inventory] = await sql.transaction([
    sql`SELECT value->'aliases' AS aliases FROM app_data WHERE key = 'autodeduct_aliases'`,
    sql`SELECT style AS "STYLE", color AS "COLOR", size AS "SIZE" FROM inventory_balance`,
  ], { isolationLevel: 'RepeatableRead', readOnly: true })
  let plan
  try { plan = buildRebindingPlan(stored?.aliases || {}, inventory, groupId, targetStyle, targetColor) }
  catch (error) { return { status: 400, error: error.message } }
  // SQL equality is the authoritative concurrency check; preserve other source
  // rules by merging into the current document rather than replacing it.
  if (Object.keys(expected).length !== Object.keys(aliasesForSource(stored.aliases, plan.group.baseKey)).length) {
    return { status: 409, error: '原匹配已变化，请重新加载后核对' }
  }
  const [saved] = await rebindAliasesQuery(sql, plan.group.baseKey, expected, plan.upserts, username)
  return saved ? { status: 200, aliases: saved.aliases, count: plan.rows.length }
    : { status: 409, error: '原匹配已变化，请重新加载后核对' }
}
