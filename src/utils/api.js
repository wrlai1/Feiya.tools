const BASE = '/api'
const TOKEN_KEY = 'feiya_token'

function authHeaders(extra = {}) {
  const token = localStorage.getItem(TOKEN_KEY)
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function request(url, options = {}) {
  let res
  try {
    res = await fetch(url, { ...options, headers: authHeaders(options.headers) })
  } catch {
    throw new Error('Cannot reach the server. Make sure the API is running.')
  }
  if (!res.ok) {
    const ct = res.headers.get('content-type') || ''
    const msg = ct.includes('application/json')
      ? (await res.json().catch(() => ({}))).error
      : await res.text().catch(() => res.statusText)
    throw new Error(msg || `HTTP ${res.status}`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error('Server returned an unexpected response. Please try again.')
  }
}

// ─── Inventory ────────────────────────────────────────────────────────────────

export function fetchInventory() {
  return request(`${BASE}/app-data?type=inventory`)
}

export function saveInventory(data, fileName = null) {
  return request(`${BASE}/app-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'inventory', data, fileName, updatedAt: new Date().toISOString() }),
  })
}

export function clearInventory() {
  return request(`${BASE}/app-data?type=inventory`, { method: 'DELETE' })
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export function fetchTracking() {
  return request(`${BASE}/app-data?type=tracking`)
}

export function saveTracking(data, fileName = null) {
  return request(`${BASE}/app-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tracking', data, fileName, updatedAt: new Date().toISOString() }),
  })
}

export function clearTracking() {
  return request(`${BASE}/app-data?type=tracking`, { method: 'DELETE' })
}

// ─── Chat Messages ────────────────────────────────────────────────────────────

export function fetchMessages() {
  return request(`${BASE}/chat-messages`)
}

export function sendMessage(name, text) {
  return request(`${BASE}/chat-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text }),
  })
}

export function editMessage(id, text) {
  return request(`${BASE}/chat-messages?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export function deleteMessage(id) {
  return request(`${BASE}/chat-messages?id=${id}`, { method: 'DELETE' })
}

export function clearMessages() {
  return request(`${BASE}/chat-messages`, { method: 'DELETE' })
}

// ─── Custom Metrics (Analytics) ─────────────────────────────────────────────────

export function fetchCustomMetrics() {
  return request(`${BASE}/custom-metrics`)
}

export function saveCustomMetric(metric) {
  return request(`${BASE}/custom-metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metric),
  })
}

export function deleteCustomMetric(id) {
  return request(`${BASE}/custom-metrics?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── Analytics Stores (per-store daily data) ────────────────────────────────────

export function fetchStores() {
  return request(`${BASE}/analytics-store?action=stores`)
}

export function createStore(name) {
  return request(`${BASE}/analytics-store?action=create-store`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function deleteStore(name) {
  return request(`${BASE}/analytics-store?action=delete-store&name=${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export function saveStoreDay(store, day, fileName, rows) {
  return request(`${BASE}/analytics-store?action=save-day`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, day, fileName, rows }),
  })
}

export function fetchStoreRange(store, from, to) {
  return request(`${BASE}/analytics-store?action=range&store=${encodeURIComponent(store)}&from=${from}&to=${to}`)
}

export function deleteStoreDay(store, day) {
  return request(`${BASE}/analytics-store?action=delete-day&store=${encodeURIComponent(store)}&day=${day}`, { method: 'DELETE' })
}

export function fetchStoreProducts(store) {
  return request(`${BASE}/analytics-store?action=products&store=${encodeURIComponent(store)}`)
}

export function saveStoreProducts(store, products, fileName = null) {
  return request(`${BASE}/analytics-store?action=save-products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, products, fileName }),
  })
}
