// inventoryFillApi.js
// Client for the Feiya Inventory Flask API.
//
// Set VITE_INVENTORY_API_URL in your environment to point to the deployed
// Railway server (e.g. https://feiya-inventory.up.railway.app).
// Falls back to localhost:8502 for local development.

const PY_BASE = (import.meta.env.VITE_INVENTORY_API_URL || 'http://localhost:8502')
  .replace(/\/$/, '') // strip trailing slash

async function pyRequest(path, options = {}) {
  let res
  try {
    res = await fetch(`${PY_BASE}${path}`, options)
  } catch {
    throw new Error('Cannot reach the inventory server. Check that it is running.')
  }
  const json = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

// ── Config ────────────────────────────────────────────────────────────────────

export function getConfig() {
  return pyRequest('/config')
}

export function saveConfig(template_csv) {
  return pyRequest('/config', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ template_csv }),
  })
}

// ── Fill ──────────────────────────────────────────────────────────────────────

export function fillInventory(sourceFile) {
  const form = new FormData()
  form.append('source', sourceFile)
  return pyRequest('/fill', { method: 'POST', body: form })
}

// ── Balance ───────────────────────────────────────────────────────────────────

export function getBalance() {
  return pyRequest('/balance')
}

export function initBalance(file) {
  const form = new FormData()
  form.append('file', file)
  return pyRequest('/balance/init', { method: 'POST', body: form })
}

export function applyToBalance(filledRows, txnType, sourceName = '') {
  return pyRequest('/balance/apply', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      filled_rows:  filledRows,
      txn_type:     txnType,
      source_name:  sourceName,
    }),
  })
}

export function resetBalance() {
  return pyRequest('/balance/reset', { method: 'POST' })
}

export function getTransactions() {
  return pyRequest('/balance/transactions')
}

export function getHistory() {
  return pyRequest('/balance/history')
}

export function restoreSnapshot(snapshotId) {
  return pyRequest(`/balance/restore/${snapshotId}`, { method: 'POST' })
}

export function uploadTemplate(file) {
  const form = new FormData()
  form.append('file', file)
  return pyRequest('/template/upload', { method: 'POST', body: form })
}

export function editQuantity(style_n, size_n, color_n, newQuantity) {
  return pyRequest('/balance/edit', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ style_n, size_n, color_n, new_quantity: newQuantity }),
  })
}

export function previewAddRows(file) {
  const form = new FormData()
  form.append('file', file)
  return pyRequest('/balance/preview-add', { method: 'POST', body: form })
}

export function confirmAddRows(rows) {
  return pyRequest('/balance/confirm-add', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ rows }),
  })
}

export function previewRemoveRows(file) {
  const form = new FormData()
  form.append('file', file)
  return pyRequest('/balance/preview-remove', { method: 'POST', body: form })
}

export function confirmRemoveRows(keys) {
  return pyRequest('/balance/confirm-remove', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ keys }),
  })
}
