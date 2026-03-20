const BASE = '/.netlify/functions'

async function request(url, options = {}) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText)
    throw new Error(msg || `HTTP ${res.status}`)
  }
  return res.json()
}

// ─── Inventory ────────────────────────────────────────────────────────────────

export function fetchInventory() {
  return request(`${BASE}/app-data?type=inventory`)
}

export function saveInventory(data, fileName = null) {
  return request(`${BASE}/app-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'inventory',
      data,
      fileName,
      updatedAt: new Date().toISOString(),
    }),
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
    body: JSON.stringify({
      type: 'tracking',
      data,
      fileName,
      updatedAt: new Date().toISOString(),
    }),
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
