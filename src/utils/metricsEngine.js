/**
 * METRICS ENGINE — framework-agnostic, zero dependencies.
 *
 * THE CORE RULE
 * A metric for a group of rows (one day, one store, one product style — any
 * grouping) is computed as:
 *
 *       sum(numerator across the group) / sum(denominator across the group)
 *
 * — never as an average of each row's own ratio. Averaging pre-computed rates
 * is wrong once you group rows together. Every function below sums first and
 * divides exactly once, at the end, so the same metric stays correct however
 * you slice it.
 *
 * DATA SHAPE
 *   Row = { <columnName>: number, ... }   // uploaded columns, flat
 *   CustomMetric = {
 *     id: string,          // stable unique key, e.g. "custom:order-rate-l8x2"
 *     label: string,       // display name
 *     numerator: string,   // a column name
 *     denominator: string, // a column name
 *     type: "percent" | "number" | "ratio" | "currency"
 *   }
 *
 * In this app every uploaded column lives as a top-level field on the row
 * (see buildRows in MetricsAnalytics.jsx), so `row.extra` isn't used — but
 * rawFieldValue still checks it so the engine stays drop-in compatible.
 */

// Read one field off one row — named field first, then the passthrough bag.
export function rawFieldValue(row, key) {
  if (typeof row[key] === 'number') return row[key]
  if (typeof row.extra?.[key] === 'number') return row.extra[key]
  return null
}

// Sum one field across a group. Returns null (not 0) if the field never
// appeared, so callers can tell "no data" from "genuinely zero".
export function sumField(rows, key) {
  let total = 0
  let any = false
  for (const row of rows) {
    const v = rawFieldValue(row, key)
    if (typeof v === 'number') { total += v; any = true }
  }
  return any ? total : null
}

// Fields that are THEMSELVES a rate must be recomputed from their underlying
// counts, never summed. This app ingests arbitrary uploads with no known rate
// columns, so the map is intentionally empty — add an entry only if your upload
// carries a pre-computed rate column whose component columns are also present:
//   { ctr: ['clicks', 'exposure'] }
export const RATE_FIELD_RECIPES = {}

// Resolve any plain field — a rate field via its recipe, anything else via a sum.
export function aggregateStandardField(rows, key) {
  const recipe = RATE_FIELD_RECIPES[key]
  if (recipe) {
    const [numKey, denKey] = recipe
    const num = sumField(rows, numKey)
    const den = sumField(rows, denKey)
    return den ? num / den : null
  }
  return sumField(rows, key)
}

// A user-defined ratio is just a recipe the user typed in.
export function customMetricValue(rows, metric) {
  const num = sumField(rows, metric.numerator)
  const den = sumField(rows, metric.denominator)
  if (num == null || !den) return null
  return num / den
}

// THE ONE FUNCTION THE CHARTS CALL. Give it a group of rows and a metric key —
// a column name or a saved custom-metric id — and it figures out which applies.
export function metricValue(rows, key, customMetrics = []) {
  const cm = customMetrics.find((c) => c.id === key)
  if (cm) return customMetricValue(rows, cm)
  return aggregateStandardField(rows, key)
}

// Display metadata (label + type) for a metric key, custom or standard.
export function metricOptions(key, standardFieldDefs, customMetrics = []) {
  const cm = customMetrics.find((c) => c.id === key)
  if (cm) return { key, label: cm.label, type: cm.type }
  return standardFieldDefs.find((f) => f.key === key) || { key, label: key, type: 'number' }
}

// Formatting — must agree with the `type` values used in field defs / CustomMetric.type.
export function formatMetric(value, type) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (type === 'percent') return (value * 100).toFixed(1) + '%'
  if (type === 'currency') return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (type === 'ratio') return value.toFixed(2) + 'x'
  return Math.round(value).toLocaleString('en-US')
}

// Slug helper for generating a custom metric's id from its label.
export function slugify(str) {
  return (
    String(str).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'metric'
  )
}
