/**
 * fix-template-order.mjs
 *
 * Reads SalesTEMPLATE.csv and writes the row order into the database so the
 * Auto Deduct Excel download comes out in the exact same sequence.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/fix-template-order.mjs
 *   DATABASE_URL="postgresql://..." node scripts/fix-template-order.mjs /path/to/SalesTEMPLATE.csv
 *
 * Get your DATABASE_URL from Neon dashboard → your project → Connection string.
 */

import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL       = process.env.DATABASE_URL
const TEMPLATE_ARG = process.argv[2]
const TEMPLATE_PATH = TEMPLATE_ARG
  ? resolve(TEMPLATE_ARG)
  : '/Users/weirenlai/Downloads/SalesTEMPLATE.csv'

if (!DB_URL || DB_URL.includes('PASTE_YOUR')) {
  console.error('\n❌  DATABASE_URL is not set.\n')
  console.error('Run it like this:')
  console.error('  DATABASE_URL="postgresql://user:pass@host/db" node scripts/fix-template-order.mjs\n')
  process.exit(1)
}

// ── CSV parser (same logic as autoDeductEngine.js) ────────────────────────────

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []

  function tokenize(line) {
    const fields = []
    let cur = '', inQ = false
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue }
      if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = '' }
      else cur += ch
    }
    fields.push(cur.trim())
    return fields
  }

  const header = tokenize(lines[0]).map(h => h.replace(/^"|"$/g, '').trim())
  return lines.slice(1)
    .map(line => {
      const fields = tokenize(line)
      const obj = {}
      header.forEach((h, i) => { obj[h] = (fields[i] ?? '').replace(/^"|"$/g, '').trim() })
      return obj
    })
    .filter(r => Object.values(r).some(v => v !== ''))
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🔧  fix-template-order.mjs')
console.log('────────────────────────────────────────')

// Read template CSV
let csvText
try {
  csvText = readFileSync(TEMPLATE_PATH, 'utf8')
} catch {
  console.error(`\n❌  Cannot read file: ${TEMPLATE_PATH}`)
  console.error('Pass the path as the first argument:')
  console.error('  node scripts/fix-template-order.mjs /path/to/SalesTEMPLATE.csv\n')
  process.exit(1)
}

const rows = parseCSV(csvText)
  .map(r => ({
    style: String(r.STYLE || r.Style || r.style || '').trim(),
    color: String(r.COLOR || r.Color || r.color || '').trim(),
    size:  String(r.SIZE  || r.Size  || r.size  || '').trim(),
  }))
  .filter(r => r.style && r.color && r.size)

console.log(`📄  Template: ${rows.length} rows  (${TEMPLATE_PATH})`)

const sql = neon(DB_URL)

// 1. Ensure app_settings table exists
await sql`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT 'null'::jsonb
  )
`

// 2. Save ordered template to app_settings
//    Auto Deduct reads from here — this guarantees output order forever.
await sql`
  INSERT INTO app_settings (key, value)
  VALUES ('template', ${JSON.stringify(rows)}::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
`
console.log(`✅  Template order saved to app_settings`)

// 3. Update sort_order in inventory_balance
//    Run 50 updates concurrently to keep it fast (~100 roundtrips for 4677 rows).
const CONCURRENCY = 50
let updated = 0, notFound = 0

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const batch = rows.slice(i, i + CONCURRENCY)
  const results = await Promise.all(
    batch.map((r, j) =>
      sql`
        UPDATE inventory_balance
        SET    sort_order = ${i + j}
        WHERE  style = ${r.style}
          AND  color = ${r.color}
          AND  size  = ${r.size}
        RETURNING id
      `
    )
  )
  for (const res of results) {
    if (res.length) updated++
    else notFound++
  }
  process.stdout.write(`\r  sort_order: ${Math.min(i + CONCURRENCY, rows.length)} / ${rows.length}`)
}

console.log(`\n✅  sort_order updated for ${updated} inventory rows`)
if (notFound > 0) {
  console.log(`⚠️   ${notFound} template rows not found in inventory (new SKUs — add them via Stock Management)`)
}

console.log('\n🎉  Done! Your next Excel download will match the template order exactly.\n')
