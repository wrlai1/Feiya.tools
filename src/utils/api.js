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

export function saveInventory(data, fileName = null, expectedRevision = 0) {
  return request(`${BASE}/app-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'inventory', data, fileName, expectedRevision }),
  })
}

export function clearInventory(expectedRevision = 0) {
  return request(`${BASE}/app-data?type=inventory&expectedRevision=${expectedRevision}`, { method: 'DELETE' })
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export function fetchTracking() {
  return request(`${BASE}/app-data?type=tracking`)
}

export function saveTracking(data, fileName = null, expectedRevision = 0) {
  return request(`${BASE}/app-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tracking', data, fileName, expectedRevision }),
  })
}

export function clearTracking(expectedRevision = 0) {
  return request(`${BASE}/app-data?type=tracking&expectedRevision=${expectedRevision}`, { method: 'DELETE' })
}

// ─── Chat Messages ────────────────────────────────────────────────────────────

export function fetchMessages() {
  return request(`${BASE}/chat-messages`)
}

export function sendMessage(text) {
  return request(`${BASE}/chat-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
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

export function saveStoreDays(store, days, replaceOverlaps = false) {
  return request(`${BASE}/analytics-store?action=save-days`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, days, replaceOverlaps }),
  })
}

export function fetchStoreRange(store, from, to) {
  return request(`${BASE}/analytics-store?action=range&store=${encodeURIComponent(store)}&from=${from}&to=${to}`)
}

export function fetchDailyLogs(store, from, to) {
  return request(`${BASE}/analytics-store?action=daily-logs&store=${encodeURIComponent(store)}&from=${from}&to=${to}`)
}

export function saveDailyLog(store, day, note, details = {}) {
  return request(`${BASE}/analytics-store?action=save-daily-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, day, note, ...details }),
  })
}

export function deleteStoreDay(store, day) {
  return request(`${BASE}/analytics-store?action=delete-day&store=${encodeURIComponent(store)}&day=${day}`, { method: 'DELETE' })
}

export function deleteStoreRange(store, from, to) {
  return request(`${BASE}/analytics-store?action=delete-range&store=${encodeURIComponent(store)}&from=${from}&to=${to}`, { method: 'DELETE' })
}

export function fetchAnalyticsEvents(store = '', limit = 50) {
  return request(`${BASE}/analytics-store?action=events&store=${encodeURIComponent(store || '')}&limit=${limit}`)
}

export function restoreAnalyticsEvent(eventId) {
  return request(`${BASE}/analytics-store?action=restore-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  })
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

export function fetchAnalyticsSettings(store = '') {
  return request(`${BASE}/analytics-store?action=settings&store=${encodeURIComponent(store || '')}`)
}

export function saveAnalyticsSettings(store, settings) {
  return request(`${BASE}/analytics-store?action=save-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, settings }),
  })
}

// ─── 新品 14 天追踪 ────────────────────────────────────────────────────────────

export function fetchNewProductTrackers() {
  return request(`${BASE}/new-product-tracker?action=list`)
}

export function createNewProductTracker(data) {
  return request(`${BASE}/new-product-tracker?action=create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function saveNewProductRoas(trackerId, effectiveDate, roas, note = '') {
  return request(`${BASE}/new-product-tracker?action=save-roas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackerId, effectiveDate, roas, note }),
  })
}

export function deleteNewProductTracker(id) {
  return request(`${BASE}/new-product-tracker?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── 动销（inventory movements）─────────────────────────────────────────────────

export function fetchMovements(days = 30) {
  return request(`${BASE}/inventory-balance?action=movements&days=${days}`)
}

export function fetchInventoryBalance() {
  return request(`${BASE}/inventory-balance?action=list`)
}
