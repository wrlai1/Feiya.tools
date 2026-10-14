function aliasesFromPayload(data) {
  const aliases = data?.aliases
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error('Server returned an invalid saved-match list')
  }
  return aliases
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    throw new Error('Server returned an unexpected response')
  }
}

export async function fetchAliases(fetchImpl, url, headers) {
  let res
  try {
    res = await fetchImpl(url, { headers })
  } catch {
    throw new Error('Could not load saved Inventory Target matches')
  }
  const data = await readJson(res)
  if (!res.ok) throw new Error(data.error || 'Could not load saved Inventory Target matches')
  return aliasesFromPayload(data)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    )
  }
  return value
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

export async function patchAliasesAndVerify(fetchImpl, urls, headers, changes) {
  let res
  try {
    res = await fetchImpl(urls.patch, {
      method: 'POST',
      headers,
      body: JSON.stringify(changes),
    })
  } catch {
    throw new Error('Could not save Inventory Target matches')
  }
  const data = await readJson(res)
  if (!res.ok) throw new Error(data.error || 'Could not save Inventory Target matches')

  const verified = await fetchAliases(fetchImpl, urls.read, headers)
  for (const [key, value] of Object.entries(changes.upserts || {})) {
    if (!sameJson(verified[key], value)) {
      throw new Error('Saved-match verification failed; reload matches before running Auto Deduct')
    }
  }
  for (const key of changes.deleteKeys || []) {
    if (!Object.hasOwn(changes.upserts || {}, key) && Object.hasOwn(verified, key)) {
      throw new Error('Saved-match verification failed; reload matches before running Auto Deduct')
    }
  }
  return verified
}
